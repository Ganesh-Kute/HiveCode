// Mail is handed over once, whichever door the agent reads it through.
//
//   node tests/listener-mail-once-test.mjs
//
// An agent on Claude Code or Antigravity reads its mail two ways: hivecode-await, a background
// process whose exit wakes it, and the MCP tools (hive_check, hive_wait). Until 3 Oct 2026 each
// kept a cursor of its own. Measured in a real session that day: 19 messages the listener had
// already delivered came back on the next MCP call as "URGENT MAIL ... Handle before continuing",
// and an agent that obeys that notice redoes instructions it already carried out.
//
//   L  the listener delivers a mention and moves the room's read cursor (what a sender's receipt reads)
//   M  the MCP side does not raise that mail again: no MAIL NOTICE, nothing from hive_check
//   N  mail still flows: a new mention after that IS handed over by hive_check
//   R  mail already read through hive_check does not wake a fresh listener a second time,
//      and that listener still wakes for the next one

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync, parseLink } = await import('../sync.js')
const RC = await import('../hive-receipts.js')

let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sec = (s) => console.log(`\n${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mail-once-'))
const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' },
})
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const kids = [relay]
let boss = null
process.on('exit', () => {
  for (const k of kids) { try { k.kill() } catch { } }
  try { boss && boss.stop() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})

// The agent's MCP server, in a folder of its own so its session file cannot meet anyone else's.
function mcp(label) {
  const cwd = path.join(TMP, `${label}-mcp`)
  fs.mkdirSync(cwd, { recursive: true })
  const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], { cwd, env: { ...process.env, HIVE_RELAY: `ws://127.0.0.1:${PORT}`, HIVE_HOME: path.join(TMP, 'home') } })
  kids.push(p)
  let buf = ''
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} })
    const c = r && r.result && r.result.content
    return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : JSON.stringify(r)
  }
  return { rpc, notify, call }
}

// One listener, as an agent's shell would start it. Resolves {exited, out} after `ms` or on exit.
const AWAIT_TEMP = path.join(TMP, 'await-temp')
function listen(link, name) {
  const child = spawn(process.execPath, [path.join(ROOT, 'hive-await.js'), link, name, '5'], { cwd: ROOT, env: { ...process.env, TEMP: AWAIT_TEMP, TMPDIR: AWAIT_TEMP } })
  kids.push(child)
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  let exited = false
  child.on('exit', () => { exited = true })
  return {
    ready: () => until(() => /listening in/.test(err), 20000),
    exited: () => exited,
    parsed: () => { try { return JSON.parse(out.trim().split('\n').pop()) } catch { return null } },
    kill: () => { try { child.kill() } catch { } },
  }
}

const ag = mcp('Ag')
await ag.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } })
ag.notify('notifications/initialized')
const joined = await ag.call('hive_join', { dir: path.join(TMP, 'ag-folder'), name: 'Ag' })
const link = (/invite link: (\S+)/.exec(joined) || [])[1]
T('setup: the agent joined through its MCP server', !!link, joined.slice(0, 120))
const { relay: R, room } = parseLink(link)
boss = startSync({ relay: R, room, dir: path.join(TMP, 'boss'), name: 'Boss', kind: 'human', syncFiles: false, log: () => { } })
await until(() => { try { return boss.connection().connected } catch { return false } }, 20000, 200)
const chat = boss.doc.getArray('chat')
const indexOf = (needle) => chat.toArray().findIndex((m) => String(m.text || '').includes(needle))

// ------------------------------------------------------------------ L
sec('L  the listener delivers a mention and moves the room cursor')
const L = listen(link, 'Ag')
T('L0 setup: the listener is up', await L.ready())
boss.say('@Ag please rebuild the search index (job-one)')
await until(() => L.exited(), 15000)
T('L1 the listener woke the agent with that message', L.exited() && /job-one/.test(JSON.stringify(L.parsed() || {})), JSON.stringify(L.parsed()))
const at1 = indexOf('job-one')
const cursorAt = () => { const c = RC.cursorOf(boss.doc.getMap('cursors'), 'Ag'); return (c && Number(c.at)) || 0 }
T('L2 ...and the room now records Ag as having read past it (what the sender\'s receipt reads)',
  await until(() => cursorAt() > at1, 5000), `cursor=${cursorAt()} message at ${at1}`)

// ------------------------------------------------------------------ M
sec('M  the MCP side does not raise it again')
await sleep(500)
// hive_say first: its reply carries the MAIL NOTICE, and a hive_check would consume the mail first.
const said = await ag.call('hive_say', { text: 'on it' })
T('M1 the next tool reply does not announce the delivered message as unread mail',
  !/(UNREAD|URGENT) MAIL/.test(said), (said.match(/--- MAIL NOTICE[\s\S]{0,160}/) || [''])[0])
const check1 = await ag.call('hive_check', {})
T('M2 hive_check does not hand it over a second time', !/job-one/.test(check1), check1.slice(0, 160))

// ------------------------------------------------------------------ N
sec('N  mail still flows through the MCP')
boss.say('@Ag then rotate the logs (job-two)')
await sleep(1200)
const check2 = await ag.call('hive_check', {})
T('N1 a new mention IS handed over by hive_check', /job-two/.test(check2), check2.slice(0, 160))

// ------------------------------------------------------------------ R
sec('R  mail read through the MCP does not wake a fresh listener')
const L2 = listen(link, 'Ag')
T('R0 setup: the second listener is up', await L2.ready())
await sleep(4000)
T('R1 it does not wake the agent again for job-two, already read through hive_check',
  !L2.exited(), JSON.stringify(L2.parsed()))
boss.say('@Ag last one (job-three)')
await until(() => L2.exited(), 15000)
T('R2 ...and it still wakes for the next message', L2.exited() && /job-three/.test(JSON.stringify(L2.parsed() || {})), JSON.stringify(L2.parsed()))
L2.kill()

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
