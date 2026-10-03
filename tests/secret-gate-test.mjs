// A credential inside a file is held on that machine, not sent to the room.
//
//   node tests/secret-gate-test.mjs
//
// Measured 3 Oct 2026: a file whose content held an API key went to the relay and to every
// participant's disk like any other. ALWAYS_IGNORE kept .env and *.pem at home by NAME, but an agent
// that pasted a key into config.js "to try something" shared it with the whole room, and hive_edit
// told that agent its change was "syncing to every peer".
//
//   S1  a new file holding a key is not shared: no peer gets it, and the room never has the key
//   S2  the holder's status names the file, the kind and the line -- and nothing it lists or says
//       contains the key itself
//   S3  a file the room never had is not announced there (nobody waits on it); one it has is, once
//   S4  an edit that adds a key to a shared file is held: the peer keeps the previous version...
//   S5  ...a teammate's edit to that file meanwhile reaches the room, and the room still never has the key
//   S6  once the key is read from the environment instead, the file flows again, both edits kept,
//       and the notice clears
//   S7  a key that is already in the room holds nothing back
//   S8  placeholders and documentation examples are not keys
//   S9  files that are credentials by name stay home (.envrc, .git-credentials, .netrc)
//   M   hive_edit says plainly that a file with a key was NOT shared, and does not say it twice;
//       hive_say and hive_assign refuse to put a key in the room's chat or tasks

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
// Keys are made here, at run time, so this file holds none for a scanner to find.
const rand = (n, a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') => Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join('')
const OPENAI = 'sk-proj-' + rand(40) + 'T3BlbkFJ' + rand(40)
const GITHUB = 'gh' + 'p_' + rand(36)
const OLDKEY = 'gh' + 'p_' + rand(36)

const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '25', HIVE_ENFORCE_CLAIMS: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' }, stdio: 'ignore',
})
for (let i = 0; i < 60 && !(await healthy(`http://127.0.0.1:${PORT}/health`)); i++) await sleep(250)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-secret-gate-'))
const A_DIR = path.join(TMP, 'alice'), B_DIR = path.join(TMP, 'bob'), C_DIR = path.join(TMP, 'carol'), M_DIR = path.join(TMP, 'cara')
for (const d of [A_DIR, B_DIR, C_DIR]) fs.mkdirSync(d)
const room = 'sec-' + Math.random().toString(36).slice(2, 8)
const RELAY = `ws://127.0.0.1:${PORT}`
const A = startSync({ relay: RELAY, room, dir: A_DIR, name: 'Alice', kind: 'ai', log: () => { } })
const B = startSync({ relay: RELAY, room, dir: B_DIR, name: 'Bob', kind: 'ai', log: () => { } })
const kids = []
let C = null
process.on('exit', () => {
  for (const k of kids) { try { k.kill() } catch { } }
  try { A.stop(); B.stop(); C && C.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})
await until(() => { try { return A.status().connected && B.status().connected } catch { return false } }, 20000, 250)
const read = (d, r) => { try { return fs.readFileSync(path.join(d, r), 'utf8') } catch { return '' } }
const exists = (d, r) => fs.existsSync(path.join(d, r))
const chat = () => A.doc.getArray('chat').toArray().map((m) => String(m.text || ''))
// Everything the room holds, as Alice's client sees it: every file body and every chat line.
const roomHas = (needle) => [...A.doc.getMap('manifest').keys()].some((k) => (A._fileText(k) || '').includes(needle)) || chat().some((t) => t.includes(needle))
// ...and whether it EVER held a key: a key that reached the room and was edited out again still leaked.
const watched = [OPENAI, GITHUB], everInRoom = new Set()
const watcher = setInterval(() => { for (const k of watched) if (!everInRoom.has(k) && roomHas(k)) everInRoom.add(k) }, 50)
process.on('exit', () => clearInterval(watcher))

console.log('\na new file holding a key')
fs.writeFileSync(path.join(B_DIR, 'config.js'), `export const client = makeClient({\n  apiKey: '${OPENAI}',\n})\n`)
fs.writeFileSync(path.join(B_DIR, 'other.js'), 'export const other = 1\n')
await until(() => read(A_DIR, 'other.js') !== '', 15000) // a file without a key still flows
await sleep(3000)
T('S1 a new file holding a key is not shared: Alice never gets it, and the room never has the key',
  !exists(A_DIR, 'config.js') && !roomHas(OPENAI), JSON.stringify({ alice: exists(A_DIR, 'config.js'), inRoom: roomHas(OPENAI) }))
const held = (B.status().withheld || []).find((w) => w.path === 'config.js')
T('S2 Bob\'s status names the file, the kind and the line...', !!held && held.kind === 'OpenAI API key' && held.line === 2, JSON.stringify(B.status().withheld || null))
T('S2b ...and nothing Bob\'s client lists or says contains the key', !JSON.stringify(B.status()).includes(OPENAI) && !chat().some((t) => t.includes(OPENAI)))
T('S3 a file the room never had is not announced there: nobody is waiting on it (Bob\'s agent is told instead)', !chat().some((t) => /config\.js/.test(t)), JSON.stringify(chat().slice(-3)))

console.log('\nan edit that adds a key to a file the room already has')
const V1 = 'export function send(msg) {\n  return post(msg)\n}\n\nexport const retries = 1\n'
fs.writeFileSync(path.join(A_DIR, 'notify.js'), V1)
await until(() => read(B_DIR, 'notify.js') === V1, 15000)
const B_KEYED = V1.replace('  return post(msg)\n', `  return post(msg, { token: '${GITHUB}' })\n`)
fs.writeFileSync(path.join(B_DIR, 'notify.js'), B_KEYED)
await sleep(3000)
T('S4 the edit is held: Alice keeps the previous version', read(A_DIR, 'notify.js') === V1 && !roomHas(GITHUB), JSON.stringify(read(A_DIR, 'notify.js')))
T('S4b ...and the room, which has that file, is told once why Bob\'s change is not arriving', chat().filter((t) => /notify\.js: Bob's change stays on Bob's machine/.test(t)).length === 1, JSON.stringify(chat().slice(-3)))
fs.writeFileSync(path.join(A_DIR, 'notify.js'), V1.replace('retries = 1', 'retries = 3'))
await sleep(3000)
T('S5 Alice\'s edit to it meanwhile reaches the room, and the room still never has the key',
  (A._fileText('notify.js') || '').includes('retries = 3') && !roomHas(GITHUB), JSON.stringify(A._fileText('notify.js')))
fs.writeFileSync(path.join(B_DIR, 'notify.js'), V1.replace('  return post(msg)\n', '  return post(msg, { token: process.env.NOTIFY_TOKEN })\n'))
T('S6 once the key is read from the environment, Bob\'s change flows and both edits are kept',
  await until(() => { const t = read(A_DIR, 'notify.js'); return t.includes('process.env.NOTIFY_TOKEN') && t.includes('retries = 3') }, 20000), JSON.stringify(read(A_DIR, 'notify.js')))
T('S6b ...and the notice clears, and the room hears it once', await until(() => !(B.status().withheld || []).some((w) => w.path === 'notify.js'), 10000) &&
  chat().filter((t) => /notify\.js from Bob is shared again/.test(t)).length === 1, JSON.stringify({ withheld: B.status().withheld || null, last: chat().slice(-2) }))
T('S6c neither key reached the room at any moment', !everInRoom.has(GITHUB) && !everInRoom.has(OPENAI), JSON.stringify({ github: everInRoom.has(GITHUB), openai: everInRoom.has(OPENAI) }))

console.log('\na key that is already in the room')
process.env.HIVE_SHARE_SECRETS = '1' // Carol opted out; the room has her key from here on
C = startSync({ relay: RELAY, room, dir: C_DIR, name: 'Carol', kind: 'ai', log: () => { } })
delete process.env.HIVE_SHARE_SECRETS
await until(() => { try { return C.status().connected } catch { return false } }, 20000, 250)
const LEGACY = `export const legacyToken = '${OLDKEY}'\nexport const mode = 'a'\n`
fs.writeFileSync(path.join(C_DIR, 'legacy.js'), LEGACY)
await until(() => read(B_DIR, 'legacy.js') === LEGACY, 20000)
fs.writeFileSync(path.join(B_DIR, 'legacy.js'), LEGACY.replace("mode = 'a'", "mode = 'b'"))
T('S7 a key already in the room holds nothing back: Bob\'s edit to that file reaches Alice',
  await until(() => read(A_DIR, 'legacy.js').includes("mode = 'b'"), 15000), JSON.stringify(read(A_DIR, 'legacy.js')))

console.log('\nwhat is not a key, and what is a credential by name')
const DOCS = "// Stripe: sk_live_XXXXXXXXXXXXXXXXXXXXXXXX\n// AWS example: AKIAIOSFODNN7EXAMPLE\nexport const npmrc = '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'\n"
fs.writeFileSync(path.join(B_DIR, 'docs.js'), DOCS)
T('S8 placeholders and documentation examples are shared like any other file', await until(() => read(A_DIR, 'docs.js') === DOCS, 15000))
for (const f of ['.envrc', '.git-credentials', '.netrc']) fs.writeFileSync(path.join(B_DIR, f), 'export X=1\n')
fs.writeFileSync(path.join(B_DIR, 'after.js'), 'export const after = 1\n')
await until(() => read(A_DIR, 'after.js') !== '', 15000)
await sleep(1500)
T('S9 files that are credentials by name stay home', !exists(A_DIR, '.envrc') && !exists(A_DIR, '.git-credentials') && !exists(A_DIR, '.netrc'))

console.log('\nhive_edit tells the agent the truth')
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
const joined = await cara.call('hive_join', { link: `${RELAY}|${room}`, dir: M_DIR, name: 'Cara' })
T('M0 setup: Cara joined through its MCP server', await until(() => exists(M_DIR, 'other.js'), 20000), joined.slice(0, 160))
const KEY2 = 'sk-proj-' + rand(40) + 'T3BlbkFJ' + rand(40)
const edited = await cara.call('hive_edit', { file: 'llm.js', content: `export const key = '${KEY2}'\n`, intent: 'try the model' })
T('M1 hive_edit says the file was NOT shared, and why', /NOT shared/.test(edited) && /OpenAI API key/.test(edited) && !/syncing to every peer/.test(edited), edited.slice(0, 220))
T('M1b ...without repeating the key', !edited.includes(KEY2))
await sleep(2500)
T('M2 the file never reaches anyone', !exists(A_DIR, 'llm.js') && !roomHas(KEY2))
const after = await cara.call('hive_check', {})
T('M3 the next call does not say it a second time', !/llm\.js: an OpenAI API key/.test(after), after.slice(-200))
const KEY3 = 'gh' + 'p_' + rand(36)
watched.push(KEY2, KEY3)
const said = await cara.call('hive_say', { text: `@Alice here is the deploy token: ${KEY3}` })
await sleep(1500)
T('M4 hive_say refuses a message holding a key, and the room never gets it', /NOT SENT/.test(said) && !said.includes(KEY3) && !everInRoom.has(KEY3), said.slice(0, 200))
const assigned = await cara.call('hive_assign', { to: 'Alice', text: `rotate ${KEY3} on the server` })
await sleep(1500)
T('M5 hive_assign refuses a task holding a key, and the room never gets it', /NOT ASSIGNED/.test(assigned) && !assigned.includes(KEY3) && !everInRoom.has(KEY3), assigned.slice(0, 200))
const plain = await cara.call('hive_say', { text: '@Alice the deploy token is DEPLOY_TOKEN in .env' })
T('M6 a message that only says where a key is kept is sent as usual', /sent to @Alice/.test(plain), plain.slice(0, 160))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
