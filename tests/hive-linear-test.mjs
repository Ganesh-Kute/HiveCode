// hive-linear end to end: Linear issues become real room tasks, exactly once.
//
//   node tests/hive-linear-test.mjs
//
// Linear is faked -- a local MCP server that speaks the same Streamable HTTP, answers SSE (which
// is what a hosted server actually does and what a naive client gets wrong), and records every
// call. What is REAL is the relay, the CRDT, the agents and the task board.
//
// The claim that matters is not "we can read Linear". It is that polling a ticket system, over
// and over, from a bridge that may restart, produces each piece of work ONCE. A duplicate ticket
// on the board means two agents doing the same job overnight and finding out in the morning.

import fs from 'fs'
import os from 'os'
import http from 'http'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { mcpClient, makeBridge, pickIssues, taskTextOf, chooseAssignee, unwrap, statusOf, idOf } from '../hive-linear.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1287, LINEAR_PORT = 1288
const ROOM = 'linear-test-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- pure: the filter and the mapping ------------------------------------------------------
console.log('\n# what becomes work')
{
  // THE REAL SHAPE, copied from a live mcp.linear.app response: `id` is the human identifier,
  // `uuid` is the database id, and the status is a flat string with a separate statusType. The
  // first version of this fixture invented `identifier` and `state.name`, so the suite went green
  // against code that matched nothing in a real workspace.
  const issues = [
    { id: 'ENG-1', uuid: 'u-1', title: 'fix the parser', labels: [{ name: 'hivecode' }], status: 'Todo', statusType: 'unstarted' },
    { id: 'ENG-2', uuid: 'u-2', title: 'redesign the logo', labels: [{ name: 'design' }], status: 'Todo', statusType: 'unstarted' },
    { id: 'ENG-3', uuid: 'u-3', title: 'already shipped', labels: [{ name: 'hivecode' }], status: 'Done', statusType: 'completed' },
    { id: 'ENG-4', uuid: 'u-4', title: 'in flight', labels: [{ name: 'hivecode' }], status: 'In Progress', statusType: 'started' },
  ]
  T('status is read from the flat field the server actually sends', statusOf(issues[0]) === 'Todo')
  T('the stable key is the uuid, not the human identifier', idOf(issues[0]) === 'u-1')
  // A team that renames "Todo" to "Up Next" must not silently get zero work.
  T('a renamed column still matches on status TYPE',
    pickIssues([{ id: 'X-1', uuid: 'u-x', labels: [{ name: 'hivecode' }], status: 'Up Next', statusType: 'unstarted' }]).length === 1)
  T('the old nested shape still works if Linear ever sends it',
    pickIssues([{ id: 'Y-1', uuid: 'u-y', labels: [{ name: 'hivecode' }], state: { name: 'Todo' } }], { states: ['Todo'] }).length === 1)
  const picked = pickIssues(issues)
  T('only labelled issues are taken', !picked.some((i) => i.identifier === 'ENG-2'))
  T('a finished issue is not re-opened as work', !picked.some((i) => i.identifier === 'ENG-3'))
  T('Todo and In Progress both qualify', picked.length === 2, picked.map((i) => i.identifier).join(','))
  T('a malformed issue is dropped, not crashed on', pickIssues([null, {}, { id: 'x' }]).length === 0)

  T('the ticket id leads the task text', /^ENG-1:/.test(taskTextOf(issues[0])))
  T('a long description is trimmed, not pasted whole',
    taskTextOf({ id: 'E', title: 't', description: 'x'.repeat(900) }).length < 260)

  // Spread, so one agent does not silently take the whole backlog.
  const counts = { A: 3, B: 0 }
  T('work goes to the least loaded agent',
    chooseAssignee({ id: '1' }, { agents: ['A', 'B'], openCount: (n) => counts[n] }) === 'B')
  T('an explicit identity map wins over load',
    chooseAssignee({ assignee: { email: 'g@x.com' } }, { agents: ['A', 'B'], identity: { 'g@x.com': 'A' }, openCount: (n) => counts[n] }) === 'A')
  T('with nobody in the room it assigns to nobody', chooseAssignee({ id: '1' }, { agents: [] }) === null)

  T('a prose answer does not become a fake issue list', unwrap({ content: [{ type: 'text', text: 'sorry, no' }] }) === null)
}

// ---- end to end ----------------------------------------------------------------------------
console.log('\n# fake Linear -> real room')
let relay = null, linearSrv = null
const clients = []
const calls = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-linear-t-'))

// The fake speaks SSE and demands its session id back, exactly like a hosted server.
let ISSUES = [
  { id: 'ENG-1', uuid: 'u-i1', title: 'fix the parser', labels: [{ name: 'hivecode' }], status: 'Todo', statusType: 'unstarted' },
  { id: 'ENG-2', uuid: 'u-i2', title: 'ship the docs', labels: [{ name: 'hivecode' }], status: 'Todo', statusType: 'unstarted' },
  { id: 'ENG-3', uuid: 'u-i3', title: 'not ours', labels: [{ name: 'design' }], status: 'Todo', statusType: 'unstarted' },
]
let badSession = false
linearSrv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const msg = JSON.parse(body || '{}')
    calls.push({ method: msg.method, name: (msg.params || {}).name, args: (msg.params || {}).arguments, session: req.headers['mcp-session-id'] })
    let result = {}
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'linear-fake' } }
    else if (msg.method === 'tools/list') result = { tools: [{ name: 'list_issues' }, { name: 'create_comment' }] }
    else if ((msg.params || {}).name === 'list_issues') {
      if (!req.headers['mcp-session-id']) badSession = true
      result = { content: [{ type: 'text', text: JSON.stringify({ issues: ISSUES }) }] }
    } else if ((msg.params || {}).name === 'create_comment') result = { content: [{ type: 'text', text: '{"ok":true}' }] }
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess-123' })
    res.end(`event: message\ndata: ${payload}\n\n`)
  })
})
await new Promise((r) => linearSrv.listen(LINEAR_PORT, '127.0.0.1', r))

try {
  relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  relay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })

  const mk = (name, kind) => startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: fs.mkdtempSync(path.join(tmp, name)),
    name, kind, syncFiles: false, log: () => {},
  })
  const board = mk('Linear', 'human'); clients.push(board)
  const A = mk('AgentA', 'ai'); clients.push(A)
  const B = mk('AgentB', 'ai'); clients.push(B)
  await sleep(2500)

  const linear = mcpClient({ url: `http://127.0.0.1:${LINEAR_PORT}/mcp`, token: 'lin_test' })
  const info = await linear.init()
  T('the client can talk to an SSE-only MCP server', info.serverInfo.name === 'linear-fake')
  T('it kept the session id the server handed back', linear.sessionId() === 'sess-123')

  const bridge = makeBridge({ hive: board, linear, room: ROOM, assignAs: 'Linear' })
  const first = await bridge.pull()
  await sleep(1200)
  T('only the labelled issues became work', first.created.length === 2, JSON.stringify(first.created.map((c) => c.issue)))
  T('the unlabelled one was left in Linear', !first.created.some((c) => c.issue === 'ENG-3'))
  T('later calls carried the session id', !badSession)

  const taskList = () => [...board.doc.getMap('tasks').values()]
  T('the tasks are on the real board', taskList().length === 2, taskList().map((t) => t.text).join(' | '))
  T('the ticket id travels with the task', taskList().every((t) => /^ENG-\d/.test(t.text)))
  T('the work was split, not dumped on one agent',
    new Set(taskList().map((t) => t.to)).size === 2, taskList().map((t) => `${t.to}`).join(','))
  T('AgentA can see its own task from its own client',
    A.myTasks().length === 1, JSON.stringify(A.myTasks().map((t) => t.text)))

  // THE ONE THAT MATTERS: poll again, and again, with a NEW bridge object in between.
  const second = await bridge.pull()
  const fresh = makeBridge({ hive: board, linear, room: ROOM, assignAs: 'Linear' })   // as if the process restarted
  const third = await fresh.pull()
  await sleep(1200)
  T('a second poll creates nothing', second.created.length === 0)
  T('a RESTARTED bridge creates nothing either', third.created.length === 0, JSON.stringify(third.created))
  T('the board still holds exactly two tasks', taskList().length === 2, `${taskList().length}`)

  // A new ticket appears in Linear while everything is running.
  ISSUES = ISSUES.concat([{ id: 'ENG-9', uuid: 'u-i4', title: 'new overnight ticket', labels: [{ name: 'hivecode' }], status: 'Todo', statusType: 'unstarted' }])
  const fourth = await bridge.pull()
  await sleep(1200)
  T('a newly filed ticket is picked up', fourth.created.length === 1 && fourth.created[0].issue === 'ENG-9')
  T('and the old ones were still not duplicated', taskList().length === 3)

  // Write-back: finishing in the room comments on the ticket. It must NOT close it.
  const mine = A.myTasks()[0]
  bridge.watch()
  A.complete(mine.id, 'gate passed')
  await sleep(1500)
  const comment = calls.filter((c) => c.name === 'create_comment').pop()
  T('finishing the work comments on the ticket', !!comment, `${calls.filter((c) => c.name === 'create_comment').length} comment(s)`)
  T('the comment names the agent that did it', comment && /AgentA|AgentB/.test(comment.args.body), comment && comment.args.body)
  T('the ticket was NOT closed by us', !calls.some((c) => /update_issue|close/.test(String(c.name))))

  // A silent zero is this integration's worst failure: a misspelled label and a genuinely empty
  // backlog look identical. The pull must say WHICH, and name what it actually saw.
  const nolabel = makeBridge({ hive: board, linear, room: ROOM, label: 'typo-label', assignAs: 'Linear' })
  const empty = await nolabel.pull()
  T('a zero result explains itself', empty.created.length === 0 && /none matched/.test(empty.why || ''), empty.why)
  T('and it names the labels that DO exist', /hivecode/.test(empty.why || ''), empty.why)
  // Caught by reading the output, not by an assertion: hive.room does not exist, so this posted
  // "in room `undefined`" onto a real ticket. Nothing we write into somebody else's system may
  // contain the word undefined.
  T('the comment names the real room', comment && comment.args.body.includes(ROOM), comment && comment.args.body)
  T('nothing undefined was posted to the ticket', comment && !/undefined/.test(comment.args.body))
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  try { relay && relay.kill() } catch { /* already gone */ }
  await new Promise((r) => linearSrv.close(r))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
