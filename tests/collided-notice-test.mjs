// An agent is told when a room file cannot be in its folder because only its case differs.
//
//   node tests/collided-notice-test.mjs
//
// A Linux teammate can put Case.js and case.js in one room. A Windows or Mac disk holds one of them,
// so the other is not in that folder (sync.js checkCaseCollision). The room was told, but in the
// name of the agent whose folder it is, and an agent is never handed its own lines: the one
// participant missing a file was the one nobody told (3 Oct 2026).
//
//   C1  hive_wait tells the agent which file is not in its folder, and which file of its own it is not
//   C2  ...once: the next call does not say it again
//   C3  hive_status lists it while it lasts
//
// On a case-sensitive disk nothing collides, so there is nothing to tell: the test says so and passes.

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import http from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { fileRoom } from '../token.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-collided-notice-'))
const probe = path.join(TMP, 'CaseProbe')
fs.writeFileSync(probe, '')
const insensitive = fs.existsSync(path.join(TMP, 'caseprobe'))
fs.rmSync(probe)
if (!insensitive) {
  console.log('  skipped: this disk is case-sensitive, so Case.js and case.js never collide here')
  console.log('\n=== 0 passed, 0 failed ===')
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
  process.exit(0)
}

const PORT = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '25', HIVE_ENFORCE_CLAIMS: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' }, stdio: 'ignore',
})
const healthy = () => new Promise((res) => { const q = http.get(`http://127.0.0.1:${PORT}/health`, (r) => { r.resume(); res(r.statusCode === 200) }); q.on('error', () => res(false)) })
for (let i = 0; i < 60 && !(await healthy()); i++) await sleep(250)
const RELAY = `ws://127.0.0.1:${PORT}`
const room = 'col-' + Math.random().toString(36).slice(2, 8)
const kids = []
const providers = []
process.on('exit', () => {
  for (const k of kids) { try { k.kill() } catch { } }
  for (const p of providers) { try { p.destroy() } catch { } }
  try { relay.kill() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})

// A teammate on a case-sensitive disk: both names, each with its own content.
const open = (name) => { const d = new Y.Doc(); const p = new WebsocketProvider(RELAY, name, d, { WebSocketPolyfill: WebSocket, disableBc: true }); providers.push(p); return { d, p } }
const base = open(room), upper = open(fileRoom(room, 'Case.js')), lower = open(fileRoom(room, 'case.js'))
await until(() => base.p.wsconnected && upper.p.wsconnected && lower.p.wsconnected, 10000)
upper.d.getText('content').insert(0, 'export const UPPER = 1\n')
lower.d.getText('content').insert(0, 'export const lower = 2\n')
await sleep(500)
base.d.transact(() => { base.d.getMap('manifest').set('Case.js', 1); base.d.getMap('manifest').set('case.js', 1) })

// The agent, on this case-insensitive disk, through its MCP server.
const cara = (() => {
  const cwd = path.join(TMP, 'cara-mcp'); fs.mkdirSync(cwd, { recursive: true })
  const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], { cwd, env: { ...process.env, HIVE_HOME: path.join(TMP, 'home') } })
  kids.push(p)
  let buf = '', nextId = 1
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} })
    const c = r && r.result && r.result.content
    return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : JSON.stringify(r)
  }
  return { rpc, call, notify: (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') }
})()
await cara.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } })
cara.notify('notifications/initialized')
const C_DIR = path.join(TMP, 'cara')
const joined = await cara.call('hive_join', { link: `${RELAY}|${room}`, dir: C_DIR, name: 'Cara' })
const userFiles = () => { try { return fs.readdirSync(C_DIR).filter((f) => /^case\.js$/i.test(f)) } catch { return [] } }
await until(() => userFiles().length === 1, 20000)
await sleep(4000) // past the room notice's debounce, so the collision is settled

const PAIR = /(case\.js|Case\.js) \(your folder has (Case\.js|case\.js)\)/
const waited = await cara.call('hive_wait', { timeoutSeconds: 1 })
T('C1 hive_wait tells Cara which room file is not in its folder, and which of its own it is not', /NOT in your folder/.test(waited) && PAIR.test(waited), `${joined.slice(0, 80)} ... ${waited.slice(-300)}`)
const checked = await cara.call('hive_check', {})
T('C2 ...once: the next call does not say it again', !/NOT in your folder/.test(checked), checked.slice(-200))
const st = await cara.call('hive_status', {})
T('C3 hive_status lists it while it lasts', /"collided"/.test(st) && PAIR.test(st), st.slice(-300))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
