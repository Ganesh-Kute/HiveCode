// RBAC Phase 4 (enforcement): a 'reader' role can SEE everything in its scope but
// cannot mutate shared state — the relay drops its write messages. Reads still flow.
//
//   node hive-readonly-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startSync } from './sync.js'
import { sign } from './token.js'

const PORT = 1255
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'ro-room'
const SECRET = 'ro-secret'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const now = () => Math.floor(Date.now() / 1000)
const W = path.resolve('.ro-test/writer')
const R = path.resolve('.ro-test/reader')
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
const mint = (role) => sign({ iss: 't', sub: role, name: role, kind: 'human', scopes: [{ room: ROOM, role }], iat: now(), exp: now() + 3600, jti: 'j-' + role }, { secret: SECRET })

fs.rmSync(path.resolve('.ro-test'), { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true }); fs.mkdirSync(R, { recursive: true })
fs.writeFileSync(path.join(W, 'doc.txt'), 'line 1 from writer')

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET } })
relay.stderr.on('data', () => {})
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const writer = startSync({ relay: RELAY, room: ROOM, dir: W, name: 'Writer', kind: 'human', token: mint('maintainer'), log: () => {} })
const reader = startSync({ relay: RELAY, room: ROOM, dir: R, name: 'Reader', kind: 'human', token: mint('reader'), log: () => {} })
await sleep(3000)

console.log('# Reads flow: the reader receives the writer\'s file')
assert('reader received doc.txt', (read(R, 'doc.txt') || '').includes('line 1 from writer'))

console.log('\n# A reader CANNOT mutate shared state: its edit must not reach the writer')
fs.writeFileSync(path.join(R, 'doc.txt'), 'HACKED by reader')
await sleep(3000)
assert('writer copy is UNCHANGED (reader write was dropped)', read(W, 'doc.txt') === 'line 1 from writer')

console.log('\n# A reader cannot ADD files to shared state either')
fs.writeFileSync(path.join(R, 'sneaky.txt'), 'should not propagate')
await sleep(3000)
assert('writer never received the reader-created file', read(W, 'sneaky.txt') === null)

console.log('\n# Reads still flow the other way: writer\'s new edit reaches the reader')
fs.writeFileSync(path.join(W, 'doc.txt'), 'line 1 from writer\nline 2 from writer')
await sleep(3000)
assert('reader receives the writer\'s update', (read(R, 'doc.txt') || '').includes('line 2 from writer'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
writer.stop(); reader.stop(); relay.kill()
fs.rmSync(path.resolve('.ro-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
