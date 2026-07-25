// DURABLE REVOCATION: when the owner revokes an agent, that revocation must
// survive a relay RESTART — not just the current session. The relay persists the
// per-room revoked jtis to disk and reloads them on boot.
//
//   node hive-durable-revoke-test.js

import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { sign, makeSecuredRoomId, fileRoom } from './token.js'

const PORT = 1294
const RELAY = `ws://localhost:${PORT}`
const STORE = path.resolve('.revoke-test/revoked.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

fs.rmSync(path.resolve('.revoke-test'), { recursive: true, force: true })
fs.mkdirSync(path.resolve('.revoke-test'), { recursive: true })

const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const keys = { publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const ROOM = makeSecuredRoomId(keys.publicKey, crypto.randomBytes(6).toString('hex'))
const ownerTok = sign({ iss: 'h', sub: 'Owner', name: 'Owner', kind: 'human', pk: keys.publicKey, scopes: [{ room: ROOM, role: 'maintainer' }], iat: now(), exp: now() + 3600, jti: 'jti-owner' }, { privateKey: keys.privateKey })
const agentTok = sign({ iss: 'h', sub: 'Bot', name: 'Bot', kind: 'ai', pk: keys.publicKey, scopes: [{ room: ROOM, role: 'agent' }], iat: now(), exp: now() + 3600, jti: 'jti-agent' }, { privateKey: keys.privateKey })

const spawnRelay = () => spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_ROOM_REVOKED_FILE: STORE } })
const waitListen = (r) => new Promise((res) => r.stdout.on('data', (d) => /listening on/.test(d) && res()))
function syncs(room, token, ms = 2500) {
  const d = new Y.Doc()
  const p = new WebsocketProvider(RELAY, room, d, { WebSocketPolyfill: WebSocket, disableBc: true, params: token ? { token } : undefined })
  return new Promise((res) => { let done = false; const fin = (v) => { if (!done) { done = true; try { p.destroy() } catch {} ; res(v) } }; p.on('sync', (s) => s && fin(true)); setTimeout(() => fin(false), ms) })
}

let relay = spawnRelay()
await waitListen(relay)
console.log('# Before revocation the agent connects')
assert('agent admitted before revoke', await syncs(ROOM, agentTok))

console.log('\n# Owner revokes the agent')
const r = await fetch(`http://localhost:${PORT}/__hive/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: ROOM, token: ownerTok, jti: 'jti-agent' }) })
assert('revoke accepted', r.ok)
assert('revoked agent blocked (same session)', !(await syncs(ROOM, agentTok)))
assert('revocation persisted to disk', fs.existsSync(STORE) && JSON.stringify(JSON.parse(fs.readFileSync(STORE, 'utf8'))).includes('jti-agent'))

console.log('\n# RESTART the relay — revocation must survive')
relay.kill(); await sleep(800)
relay = spawnRelay(); await waitListen(relay)
assert('revoked agent STILL blocked after relay restart', !(await syncs(ROOM, agentTok)))
assert('owner still connects after restart', await syncs(ROOM, ownerTok))

console.log(`\n=== ${failed === 0 ? 'DURABLE REVOCATION WORKS' : failed + ' FAILED'} ===`)
relay.kill()
fs.rmSync(path.resolve('.revoke-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
