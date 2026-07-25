// RBAC Phase 5 (per-file write scope): ONE agent can EDIT some folders but only
// VIEW others. A scope with paths=[backend,frontend] + writePaths=[backend] means:
// the agent sees both (reads flow), edits backend (writes propagate), but its edits
// to frontend are dropped by the relay (it connects to those file-rooms as reader).
//
//   node hive-writescope-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startSync } from './sync.js'
import { sign } from './token.js'

const PORT = 1256
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'ws-room'
const SECRET = 'ws-secret'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const now = () => Math.floor(Date.now() / 1000)
const O = path.resolve('.ws-test/owner')   // maintainer (full access)
const A = path.resolve('.ws-test/agent')   // mixed: edit backend, view frontend
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s) }

const owner = sign({ iss: 't', sub: 'owner', name: 'Owner', kind: 'human', scopes: [{ room: ROOM, role: 'maintainer' }], iat: now(), exp: now() + 3600, jti: 'j-owner' }, { secret: SECRET })
const agent = sign({ iss: 't', sub: 'agent', name: 'Agent', kind: 'ai', scopes: [{ room: ROOM, role: 'agent', paths: ['backend/**', 'frontend/**'], writePaths: ['backend/**'] }], iat: now(), exp: now() + 3600, jti: 'j-agent' }, { secret: SECRET })

fs.rmSync(path.resolve('.ws-test'), { recursive: true, force: true })
fs.mkdirSync(O, { recursive: true }); fs.mkdirSync(A, { recursive: true })
write(O, 'backend/api.js', 'export const api = 1 // by owner')
write(O, 'frontend/app.js', 'export const app = 1 // by owner')

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_PERSIST_DIR: 'off' } })
relay.stderr.on('data', () => {})
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const oS = startSync({ relay: RELAY, room: ROOM, dir: O, name: 'Owner', kind: 'human', token: owner, log: () => {} })
const aS = startSync({ relay: RELAY, room: ROOM, dir: A, name: 'Agent', kind: 'ai', token: agent, log: () => {} })
await sleep(3500)

console.log('# Visibility: the agent SEES both folders (read flows for both)')
assert('agent received backend/api.js', (read(A, 'backend/api.js') || '').includes('by owner'))
assert('agent received frontend/app.js (view-only, but visible)', (read(A, 'frontend/app.js') || '').includes('by owner'))

console.log('\n# Write where allowed: agent edits backend -> owner sees it')
write(A, 'backend/api.js', 'export const api = 2 // edited by agent')
await sleep(3000)
assert('owner received the agent\'s backend edit', (read(O, 'backend/api.js') || '').includes('edited by agent'))

console.log('\n# Read-only where not: agent edits frontend -> DROPPED, owner unchanged')
write(A, 'frontend/app.js', 'HACKED by agent')
await sleep(3000)
assert('owner frontend UNCHANGED (agent write dropped)', read(O, 'frontend/app.js') === 'export const app = 1 // by owner')

console.log('\n# Agent cannot ADD a file in the view-only folder either')
write(A, 'frontend/sneak.js', 'should not propagate')
await sleep(3000)
assert('owner never received agent-created frontend file', read(O, 'frontend/sneak.js') === null)

console.log('\n# Reads still flow into the view-only folder: owner edits frontend -> agent sees it')
write(O, 'frontend/app.js', 'export const app = 2 // owner update')
await sleep(3000)
assert('agent receives owner\'s frontend update (read flows)', (read(A, 'frontend/app.js') || '').includes('owner update'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
oS.stop(); aS.stop(); relay.kill()
fs.rmSync(path.resolve('.ws-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
