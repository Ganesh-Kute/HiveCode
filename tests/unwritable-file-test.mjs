// A room write that cannot land on this disk is said, retried, and never turned into a revert.
//
//   node tests/unwritable-file-test.mjs
//
// Measured 3 Oct 2026: Alice edits gen.js while Bob's copy is read-only (a Perforce checkout, a
// generated file, a handle another program holds). Bob's write threw EPERM inside the Yjs
// observer, y-websocket printed it to stderr, Bob's copy stayed at the old version while the room
// moved on, his status read all green, and nothing tried again. A first fix that retried through
// reconcile made it worse: the base had already been moved to the new text, so Bob's stale copy
// read as an edit, and merging it REVERTED Alice's change for everyone.
//
//   U1  Alice's change stands in the room while Bob's copy is read-only
//   U2  Bob's status names the file and why; the room is told once that his copy is behind
//   U3  other files still reach Bob
//   U4  once the file is writable, Bob gets the room's version, and the notice clears
//   U5  an edit Bob made to his stale copy is merged with Alice's change, not dropped and not
//       pushed back over it
//   U6  a stale copy nobody touches catches up on its own once it is writable: making a file
//       writable does not change its contents or its mtime, so nothing else would notice
//   M   an agent whose copy is behind is told so by its own tools (hive_wait, hive_status): the room
//       line about it goes out in that agent's name, and an agent is never handed its own lines

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import http from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync } = await import('../sync.js')

let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const healthy = (u) => new Promise((res) => { const q = http.get(u, (r) => { r.resume(); res(r.statusCode === 200) }); q.on('error', () => res(false)); q.setTimeout(800, () => { q.destroy(); res(false) }) })
async function until(pred, ms, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '25', HIVE_ENFORCE_CLAIMS: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' }, stdio: 'ignore',
})
for (let i = 0; i < 60 && !(await healthy(`http://127.0.0.1:${PORT}/health`)); i++) await sleep(250)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-unwritable-'))
const A_DIR = path.join(TMP, 'alice'), B_DIR = path.join(TMP, 'bob')
fs.mkdirSync(A_DIR); fs.mkdirSync(B_DIR)
const room = 'unw-' + Math.random().toString(36).slice(2, 8)
const A = startSync({ relay: `ws://127.0.0.1:${PORT}`, room, dir: A_DIR, name: 'Alice', kind: 'ai', log: () => { } })
const B = startSync({ relay: `ws://127.0.0.1:${PORT}`, room, dir: B_DIR, name: 'Bob', kind: 'ai', log: () => { } })
const genB = path.join(B_DIR, 'gen.js'), leftB = path.join(B_DIR, 'left.js')
const C_DIR = path.join(TMP, 'cara'), mC = path.join(C_DIR, 'm.js')
const kids = []
process.on('exit', () => {
  for (const k of kids) { try { k.kill() } catch { } }
  try { fs.chmodSync(genB, 0o666) } catch { }
  try { fs.chmodSync(leftB, 0o666) } catch { }
  try { fs.chmodSync(mC, 0o666) } catch { }
  try { A.stop(); B.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})
await until(() => { try { return A.status().connected && B.status().connected } catch { return false } }, 20000, 250)
const read = (d, r) => { try { return fs.readFileSync(path.join(d, r), 'utf8') } catch { return '' } }

const V1 = 'export function total(a, b) {\n  return a + b\n}\n\nexport const version = 1\n'
const V2 = 'export function total(a, b) {\n  return a + b\n}\n\nexport const version = 2 // Alice\n'
fs.writeFileSync(path.join(A_DIR, 'gen.js'), V1)
fs.writeFileSync(path.join(A_DIR, 'other.js'), 'export const o = 1\n')
fs.writeFileSync(path.join(A_DIR, 'left.js'), 'export const left = 1\n')
await until(() => read(B_DIR, 'gen.js') === V1 && read(B_DIR, 'other.js') !== '' && read(B_DIR, 'left.js') !== '', 20000)

fs.chmodSync(genB, 0o444) // read-only on Bob's disk
fs.chmodSync(leftB, 0o444)
fs.writeFileSync(path.join(A_DIR, 'gen.js'), V2)
fs.writeFileSync(path.join(A_DIR, 'left.js'), 'export const left = 2\n')
await sleep(5000)
const lines = () => B.doc.getArray('chat').toArray().map((m) => String(m.text || ''))

console.log('\nwhile Bob\'s copy is read-only')
T('U1 Alice\'s change stands: the room and Alice keep it while Bob cannot write it', B._fileText('gen.js') === V2 && read(A_DIR, 'gen.js') === V2,
  JSON.stringify({ room: B._fileText('gen.js'), alice: read(A_DIR, 'gen.js') }))
const unw = (B.status().unwritable || []).find((u) => u.path === 'gen.js')
T('U2a Bob\'s status names the file and why', !!unw && /^E[A-Z]+/.test(unw.code), JSON.stringify(B.status().unwritable || null))
T('U2b the room is told once that Bob\'s copy is behind', lines().filter((t) => /gen\.js could not be written on Bob's disk/.test(t)).length === 1, JSON.stringify(lines().slice(-3)))
fs.writeFileSync(path.join(A_DIR, 'other.js'), 'export const o = 2\n')
T('U3 other files still reach Bob', await until(() => read(B_DIR, 'other.js') === 'export const o = 2\n', 10000))

console.log('\nonce Bob can write it again, after adding a line of his own')
fs.chmodSync(genB, 0o666)
fs.appendFileSync(genB, '\nexport const note = "Bob"\n')
// Both edits, and nothing of the stale copy. (Where the merge puts Alice's trailing comment is the
// merge engine's business, not this test's.)
const bothEdits = (t) => t.includes('version = 2') && t.includes('// Alice') && t.includes('note = "Bob"') && !t.includes('version = 1')
const merged = () => bothEdits(read(B_DIR, 'gen.js'))
T('U4/U5 Bob ends up with Alice\'s change AND his own line', await until(merged, 30000), JSON.stringify(read(B_DIR, 'gen.js')))
T('U5b ...and so does the room: neither edit was dropped or reverted', await until(() => bothEdits(B._fileText('gen.js')), 15000), JSON.stringify(B._fileText('gen.js')))
T('U4b the notice clears', await until(() => !(B.status().unwritable || []).some((u) => u.path === 'gen.js'), 15000), JSON.stringify(B.status().unwritable || null))

console.log('\nonce a stale copy nobody touches is writable again')
fs.chmodSync(leftB, 0o666) // no edit: contents and mtime are unchanged
T('U6 it catches up on its own: nothing waits for an edit to notice it is behind', await until(() => read(B_DIR, 'left.js') === 'export const left = 2\n', 30000), JSON.stringify(read(B_DIR, 'left.js')))
T('U6b ...and the room hears that Bob\'s copy is current again', await until(() => lines().some((t) => /left\.js is current on Bob's disk again/.test(t)), 10000), JSON.stringify(lines().slice(-3)))

console.log('\nan agent whose copy is behind is told by the tools it is already calling')
const cara = (() => {
  const cwd = path.join(TMP, 'cara-mcp'); fs.mkdirSync(cwd, { recursive: true }) // its own session file
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
const joined = await cara.call('hive_join', { link: `ws://127.0.0.1:${PORT}|${room}`, dir: C_DIR, name: 'Cara' })
fs.writeFileSync(path.join(A_DIR, 'm.js'), 'export const m = 1\n')
T('M0 setup: Cara joined through its MCP server and has m.js', await until(() => read(C_DIR, 'm.js') === 'export const m = 1\n', 20000), joined.slice(0, 160))
fs.chmodSync(mC, 0o444)
fs.writeFileSync(path.join(A_DIR, 'm.js'), 'export const m = 2\n')
await sleep(4000)
const waited = await cara.call('hive_wait', { timeoutSeconds: 1 })
T('M1 hive_wait tells Cara its m.js is older than the room\'s', /could not be written/.test(waited) && /m\.js \(E[A-Z]+\)/.test(waited), waited.slice(-300))
const checked = await cara.call('hive_check', {})
T('M2 ...once: the next call does not say it again', !/m\.js \(E[A-Z]+\)/.test(checked), checked.slice(-300))
const statusOf = () => cara.call('hive_status', {})
const st1 = await statusOf()
T('M3 hive_status lists it while it lasts', /"unwritable"[\s\S]*m\.js \(E[A-Z]+\)/.test(st1), st1.slice(-300))
fs.chmodSync(mC, 0o666)
T('M4 ...and stops listing it once Cara\'s copy has the room\'s version',
  await until(async () => read(C_DIR, 'm.js') === 'export const m = 2\n' && !/"unwritable"/.test(await statusOf()), 30000, 1000), read(C_DIR, 'm.js'))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
