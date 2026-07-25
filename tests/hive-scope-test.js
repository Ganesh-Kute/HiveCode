// THE HEADLINE GUARANTEE (RBAC Phase 2+3): a scoped agent receives ONLY the files
// its token's path globs allow — the rest of the codebase never reaches its disk,
// and the relay rejects any attempt to connect to an out-of-scope file's room.
//
//   node hive-scope-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { startSync } from './sync.js'
import { sign, fileRoom } from './token.js'

const PORT = 1254
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'repo-acme'
const SECRET = 'scope-secret'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const now = () => Math.floor(Date.now() / 1000)
const OWNER = path.resolve('.scope-test/owner')
const AGENT = path.resolve('.scope-test/agent')
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }

const mint = (scopes) => sign({ iss: 't', sub: 's', name: 'n', kind: 'ai', scopes, iat: now(), exp: now() + 3600, jti: 'j' + Math.random() }, { secret: SECRET })

fs.rmSync(path.resolve('.scope-test'), { recursive: true, force: true })
fs.mkdirSync(path.join(OWNER, 'frontend'), { recursive: true })
fs.mkdirSync(path.join(OWNER, 'backend'), { recursive: true })
fs.mkdirSync(AGENT, { recursive: true })
fs.writeFileSync(path.join(OWNER, 'frontend', 'app.js'), 'export const ui = "hello"')
fs.writeFileSync(path.join(OWNER, 'backend', 'secrets.js'), 'export const DB_PASSWORD = "hunter2"')
fs.writeFileSync(path.join(OWNER, 'README.md'), '# Acme')

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

// The OWNER has full access (wildcard paths) and publishes the whole repo.
const ownerTok = mint([{ room: ROOM, role: 'maintainer' }]) // no paths = whole repo
const owner = startSync({ relay: RELAY, room: ROOM, dir: OWNER, name: 'Owner', kind: 'human', token: ownerTok, log: () => {} })
await sleep(2500)

// The AGENT is scoped to frontend/** ONLY.
const agentTok = mint([{ room: ROOM, role: 'agent', paths: ['frontend/**'] }])
const agent = startSync({ relay: RELAY, room: ROOM, dir: AGENT, name: 'FrontBot', kind: 'ai', token: agentTok, log: () => {} })
await sleep(3500)

console.log('# The scoped agent receives ONLY its granted subtree')
assert('agent GOT frontend/app.js (in scope)', (read(AGENT, 'frontend/app.js') || '').includes('hello'))
assert('agent did NOT get backend/secrets.js (out of scope)', read(AGENT, 'backend/secrets.js') === null)
assert('agent did NOT get README.md (out of scope)', read(AGENT, 'README.md') === null)
assert('the secret never touched the agent disk', read(AGENT, 'backend/secrets.js') === null)

console.log('\n# The relay itself rejects a direct connect to an out-of-scope file-room')
function syncs(room, token, ms = 2500) {
  const d = new Y.Doc()
  const p = new WebsocketProvider(RELAY, room, d, { WebSocketPolyfill: WebSocket, params: { token } })
  return new Promise((res) => { let done = false; const fin = (v) => { if (!done) { done = true; try { p.destroy() } catch {} ; res(v) } }; p.on('sync', (s) => s && fin(true)); setTimeout(() => fin(false), ms) })
}
assert('relay admits the in-scope file-room', await syncs(fileRoom(ROOM, 'frontend/app.js'), agentTok))
assert('relay REJECTS the out-of-scope file-room', !(await syncs(fileRoom(ROOM, 'backend/secrets.js'), agentTok)))

console.log('\n# In-scope edits still flow both ways for the scoped agent')
fs.writeFileSync(path.join(AGENT, 'frontend', 'app.js'), 'export const ui = "edited by agent"')
await sleep(3000)
assert('agent edit to in-scope file reached the owner', (read(OWNER, 'frontend/app.js') || '').includes('edited by agent'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
owner.stop(); agent.stop(); relay.kill()
fs.rmSync(path.resolve('.scope-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
