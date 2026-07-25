// RELAY ROBUSTNESS (security-audit follow-up): a scoped participant connecting to
// a crafted file-room (e.g. "<room>␁./x") used to throw inside pathAllowed and the
// uncaught exception crashed the whole relay. The relay must REJECT it and stay up.
//
//   node hive-relay-robust-test.js

import { spawn } from 'child_process'
import crypto from 'crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { sign, makeSecuredRoomId, fileRoom } from './token.js'

const PORT = 1314
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keys = { publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const ROOM = makeSecuredRoomId(keys.publicKey, crypto.randomBytes(6).toString('hex'))
const tok = sign({ iss: 'h', sub: 'Bot', name: 'Bot', kind: 'ai', pk: keys.publicKey, scopes: [{ room: ROOM, role: 'agent', paths: ['frontend/**'] }], iat: now(), exp: now() + 3600, jti: 'jti-a' }, { privateKey: keys.privateKey })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
let relayExited = false
relay.on('exit', () => { relayExited = true })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

function syncs(room, token, ms = 2500) {
  const d = new Y.Doc()
  const p = new WebsocketProvider(RELAY, room, d, { WebSocketPolyfill: WebSocket, disableBc: true, params: token ? { token } : undefined })
  return new Promise((res) => { let done = false; const fin = (v) => { if (!done) { done = true; try { p.destroy() } catch {} ; res(v) } }; p.on('sync', (s) => s && fin(true)); setTimeout(() => fin(false), ms) })
}

console.log('# A crafted "./"-prefixed file-room must be REJECTED, not crash the relay')
const crafted = await syncs(fileRoom(ROOM, './frontend/app.js'), tok) // normalizes -> in scope, must NOT throw
assert('crafted "./" file-room handled without crashing', relayExited === false)
const crafted2 = await syncs(fileRoom(ROOM, './backend/secret'), tok) // out of scope after normalize
assert('crafted "./" out-of-scope rejected', crafted2 === false)
assert('relay still alive after crafted connections', relayExited === false)

console.log('\n# The relay is still serving normal traffic afterward')
assert('in-scope file-room still admitted', await syncs(fileRoom(ROOM, 'frontend/app.js'), tok))
assert('out-of-scope still rejected', !(await syncs(fileRoom(ROOM, 'backend/secret'), tok)))
assert('relay process never exited', relayExited === false)

console.log(`\n=== ${failed === 0 ? 'RELAY STAYS UP UNDER CRAFTED INPUT' : failed + ' FAILED'} ===`)
relay.kill()
process.exit(failed === 0 ? 0 : 1)
