// In a room that checks tokens, an invite never carries the inviter's own token.
//
//   node tests/secured-invite-test.mjs
//
// The README's "Give an outside agent one folder" flow mints a maintainer token for the host and a
// token scoped to one folder for the outside agent. hive_join then printed the host's invite link
// WITH THE HOST'S TOKEN in it, labelled as the thing to hand to others (3 Oct 2026): an agent that
// shares its invite link, as agents do, gave the scoped outsider the host's maintainer token --
// every path, every role -- and revoking it would lock out the host too. A token is the person.
//
//   I1  the invite link hive_join prints carries no token
//   I2  nothing it says to forward to someone else carries the joiner's token; the one line that does
//       is marked as the joiner's own
//   I3  it says that each person needs a token of their own, and how to mint one
//   I4  hive_say refuses a message carrying a token, and the room never gets it
//   I5  a message without one still goes

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { sign } from '../token.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync } = await import('../sync.js')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const SECRET = crypto.randomBytes(32).toString('hex')
const room = 'proj-' + crypto.randomBytes(6).toString('hex')
const now = Math.floor(Date.now() / 1000)
const mint = (name, role, extra = {}) => sign({ iss: 'hivecode', sub: name, name, kind: 'ai', scopes: [{ room, role, ...extra }], iat: now, exp: now + 3600, jti: 'jti-' + crypto.randomBytes(6).toString('hex') }, { secret: SECRET })
const HOST = mint('Alice', 'maintainer')
const WATCH = mint('Watcher', 'reader')

const PORT = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '25', HIVE_ENFORCE_CLAIMS: '', HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET }, stdio: 'ignore',
})
const healthy = () => new Promise((res) => { const q = http.get(`http://127.0.0.1:${PORT}/health`, (r) => { r.resume(); res(r.statusCode === 200) }); q.on('error', () => res(false)) })
for (let i = 0; i < 60 && !(await healthy()); i++) await sleep(250)
const RELAY = `ws://127.0.0.1:${PORT}`
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-secured-invite-'))
const kids = []
let W = null
process.on('exit', () => {
  for (const k of kids) { try { k.kill() } catch { } }
  try { W && W.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})

// Somebody who can read the room, to see what reached it.
W = startSync({ relay: RELAY, room, dir: path.join(TMP, 'watch'), name: 'Watcher', kind: 'ai', token: WATCH, syncFiles: false, log: () => { } })
await until(() => { try { return W.connection().connected } catch { return false } }, 20000, 250)
const chat = () => W.doc.getArray('chat').toArray().map((m) => String(m.text || ''))

// The host's agent, through its MCP server, joining with the host's own token.
const agent = (() => {
  const cwd = path.join(TMP, 'alice-mcp'); fs.mkdirSync(cwd, { recursive: true })
  const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], { cwd, env: { ...process.env, HIVE_HOME: path.join(TMP, 'home'), HIVE_TOKEN: '' } })
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
await agent.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } })
agent.notify('notifications/initialized')
const banner = await agent.call('hive_join', { link: `${RELAY}|${room}`, token: HOST, dir: path.join(TMP, 'alice'), name: 'Alice' })
T('I0 setup: the host\'s agent joined the room that checks tokens', /room: /.test(banner) && !/NOT JOINED/.test(banner), banner.slice(0, 200))

const lines = banner.split('\n')
const invite = lines.find((l) => /^invite link:/.test(l)) || ''
T('I1 the invite link it prints carries no token', !!invite && !invite.includes(HOST), invite.slice(0, 120))
const carrying = lines.filter((l) => l.includes(HOST))
T('I2 nothing meant for someone else carries the host\'s token; a line that does is marked as the host\'s own',
  carrying.every((l) => /YOUR token/.test(l)), carrying.map((l) => l.slice(0, 80)).join(' | '))
T('I3 it says each person needs a token of their own, and how to mint one', /token of their own|own token/i.test(banner) && /hivecode-token/.test(banner), lines.filter((l) => /token/i.test(l)).join(' / ').slice(0, 300))

const said = await agent.call('hive_say', { text: `@all join with ${HOST}` })
await sleep(1500)
T('I4 hive_say refuses a message carrying a token, and the room never gets it', /NOT SENT/.test(said) && !said.includes(HOST) && !chat().some((t) => t.includes(HOST)), said.slice(0, 200))
const plain = await agent.call('hive_say', { text: '@Watcher ask me for a token of your own' })
T('I5 a message without one still goes', /sent to @Watcher/.test(plain) && await until(() => chat().some((t) => /token of your own/.test(t)), 5000), plain.slice(0, 160))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
