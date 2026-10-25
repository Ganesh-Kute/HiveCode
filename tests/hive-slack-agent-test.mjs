// hive-agent end to end: the Slack stop button really stops agents in a real room.
//
//   node tests/hive-slack-agent-test.mjs
//
// The claim under test is the product claim, not a rendering detail: a human who is not at
// their desk presses one button in Slack and every agent in the room stops picking up work.
// That spans a relay, a CRDT, the control map and the gate hive_wait reads -- so the only
// assertion that counts is `AgentA.isPaused()` going true on AGENT A'S OWN CLIENT, which is a
// different process's replica than the one the button wrote to.
//
// Slack itself is faked. Its HTTP is not the risky part and hive-slack-test already covers it.

import fs from 'fs'
import os from 'os'
import http from 'http'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { makeAgent, planChunks, route, snapshot, taskState, taskTitle, stopAll } from '../hive-slack-agent.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1283, SLACK_PORT = 1284
const ROOM = 'agent-test-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- pure: the state join and the router --------------------------------------------------
console.log('\n# state mapping + routing')
{
  T('an accepted task is in progress', taskState({ status: 'accepted' }, false) === 'in_progress')
  T('a denied task is terminal, not pending', taskState({ status: 'denied' }, false) === 'error')
  T('done maps to completed', taskState({ status: 'done' }, false) === 'completed')
  // The panel must never show a spinner next to an agent somebody has halted.
  T('a PAUSED agent stops showing in progress', taskState({ status: 'accepted' }, true) === 'pending')
  T('and the title says why, so it is not confused with approval', /paused/.test(taskTitle({ to: 'A', text: 'x', status: 'accepted' }, true)))
  T('an unknown status degrades to pending, not to a crash', taskState({ status: 'weird' }, false) === 'pending')

  T('"stop" alone means everything', route('stop').intent === 'stop-all')
  T('"stop AgentB" targets one', route('stop AgentB').intent === 'stop' && route('stop AgentB').who === 'agentb')
  T('"stop all" is not read as an agent named all', route('stop all').intent === 'stop-all')
  T('resume is distinct from stop', route('resume all').intent === 'resume-all')
  T('a question is a status read', route('what is running?').intent === 'status')
  T('anything else is handed on, not guessed at', route('rewrite the parser').intent === 'ask')

  const snap = { people: [{ name: 'A', paused: true }, { name: 'B', paused: false }], open: 1, waiting: 1,
    pausedOf: (w) => w === 'A', tasks: [{ id: 't1', to: 'A', text: 'alpha', status: 'accepted', at: 1 }, { id: 't2', to: 'B', text: 'beta', status: 'pending', at: 2 }] }
  const chunks = planChunks(snap)
  T('the frame leads with a live count', /1\/2 running/.test(chunks[0].markdown_text), chunks[0].markdown_text)
  T('one task card per task', chunks.filter((c) => c.type === 'task_update').length === 2)
  T('the paused agent card is not in progress', chunks[1].task.status === 'pending')
}

// ---- end to end ---------------------------------------------------------------------------
console.log('\n# end to end: Slack stop button -> real agents paused')
let relay = null
const clients = []
const calls = []
let tsSeq = 3000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-agent-t-'))
const slack = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    calls.push({ method: req.url.split('/').pop(), ...JSON.parse(body || '{}') })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ts: String(tsSeq++) }))
  })
})
await new Promise((r) => slack.listen(SLACK_PORT, '127.0.0.1', r))
const post = async (m) => {
  const r = await fetch(`http://127.0.0.1:${SLACK_PORT}/api/${m.method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m),
  })
  return r.json()
}

try {
  const { WebSocketServer } = await import('ws')
  const { setupWSConnection } = await import('../vendor/y-websocket/utils.cjs')
  relay = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
  const wss = new WebSocketServer({ server: relay })
  wss.on('connection', (ws, req) => {
    const docName = (req.url || '/').slice(1).split('?')[0]
    setupWSConnection(ws, req, { docName })
  })
  await new Promise((r) => relay.listen(PORT, '127.0.0.1', r))

  const mk = (name, kind) => startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: fs.mkdtempSync(path.join(tmp, name)),
    name, kind, syncFiles: false, log: () => {},
  })
  const panel = mk('Hivecode', 'human'); clients.push(panel)   // the Slack side
  const A = mk('AgentA', 'ai'); clients.push(A)
  const B = mk('AgentB', 'ai'); clients.push(B)
  await sleep(2500)

  T('the panel can see both agents', snapshot(panel).people.filter((p) => p.kind === 'ai').length === 2,
    snapshot(panel).people.map((p) => `${p.name}:${p.kind}`).join(' '))

  const agent = makeAgent({
    hive: panel, channel: 'D-TEST', token: 'xoxb-test', post,
    setStatus: (b) => post({ method: 'agents.sessions.setStatus', ...b }),
  })

  // A real task, assigned by a real client, so the plan is built from the CRDT and not a fixture.
  panel.assign('AgentA', 'refactor the parser')
  await sleep(1500)
  await agent.onPrompt({ text: 'status', thread_ts: '1.1', user: 'ganesh' })
  const started = calls.find((c) => c.method === 'chat.startStream')
  T('the panel streams rather than posting a wall of text', !!started)
  T('it asks Slack for the plan layout', started && started.task_display_mode === 'plan')
  const appended = calls.find((c) => c.method === 'chat.appendStream')
  T('the real task reached the panel', !!appended && appended.chunks.some((c) => /refactor the parser/.test(c.task && c.task.title)),
    appended ? JSON.stringify(appended.chunks[0] && appended.chunks[0].task) : 'no append')
  T('the loading state was cleared, not left spinning for an hour',
    calls.filter((c) => c.method === 'agents.sessions.setStatus').some((c) => c.status === 'active'))

  // THE ONE THAT MATTERS. Press the native stop button.
  T('nobody is paused before the button', A.isPaused() === false && B.isPaused() === false)
  const stopped = await agent.onSessionStopped({ thread_ts: '1.1', user: 'ganesh' })
  await sleep(1500)
  T('the button reports which agents it stopped', stopped.length === 2, stopped.join(','))
  T('AgentA is paused ON ITS OWN CLIENT', A.isPaused() === true)
  T('AgentB is paused ON ITS OWN CLIENT', B.isPaused() === true)

  // Typed control, and the panel must tell the truth afterwards.
  await agent.onPrompt({ text: 'resume AgentA', thread_ts: '1.1', user: 'ganesh' })
  await sleep(1500)
  T('one agent resumed', A.isPaused() === false)
  T('the other stayed stopped', B.isPaused() === true)
  const frame = calls.filter((c) => c.method === 'chat.startStream').pop()
  T('the panel now reports 2/3 running, not 3/3', /2\/3 running/.test(frame.chunks[0].markdown_text),
    frame.chunks[0].markdown_text)

  // A panel that reports a stop it did not perform is worse than one that refuses.
  const ghost = await agent.onPrompt({ text: 'stop Nobody', thread_ts: '1.1', user: 'ganesh' })
  T('stopping someone who is not here is refused, not faked', ghost.ok === false)
  T('and no phantom control entry was written', !panel.doc.getMap('controls').get('nobody'))

  // A human is never paused: the control map is read by hive_wait, which only agents call.
  const ctl = panel.doc.getMap('controls')
  T('the human was not paused', !ctl.get('Hivecode') || ctl.get('Hivecode').state !== 'paused')
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  if (relay) await new Promise((r) => relay.close(r))
  await new Promise((r) => slack.close(r))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
