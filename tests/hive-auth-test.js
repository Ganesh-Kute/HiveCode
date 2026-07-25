// Proves Phase-1 RBAC: a relay in auth-required mode admits ONLY connections
// carrying a valid, unexpired, unrevoked token whose scope authorizes the room.
// Everything else is rejected at the WS upgrade (no socket, no CRDT bytes).
// Also: the hive-token CLI mints a working token, and open mode is unchanged.
//
//   node hive-auth-test.js

import { spawn } from 'child_process'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { sign } from './token.js'

const SECRET = 'test-secret-123'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const now = () => Math.floor(Date.now() / 1000)

const mint = (over = {}) => sign({
  iss: 'test', sub: 'p1', name: 'Agent1', kind: 'ai',
  scopes: [{ room: 'secure-room', role: 'agent' }],
  iat: now(), exp: now() + 3600, jti: 'jti-ok', ...over,
}, { secret: SECRET })

// Does a client SYNC (i.e. was it admitted) within `ms`? A rejected connection
// never opens, so it never syncs.
function syncs(port, room, token, ms = 3000) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://localhost:${port}`, room, doc, { WebSocketPolyfill: WebSocket, params: token ? { token } : undefined })
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; try { provider.destroy() } catch {} ; resolve(v) } }
    provider.on('sync', (s) => s && finish(true))
    setTimeout(() => finish(false), ms)
  })
}

function startRelay(port, env) {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } })
  p.stderr.on('data', () => {})
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}

// ============ auth-required relay ============
const PORT = 1251
const relay = await startRelay(PORT, { HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_REVOKED_JTIS: 'jti-bad' })

console.log('# A valid token for the room is admitted')
assert('valid token -> synced', await syncs(PORT, 'secure-room', mint()))

console.log('\n# Everything else is rejected at the upgrade (never syncs)')
assert('no token -> rejected', !(await syncs(PORT, 'secure-room', '')))
assert('garbage token -> rejected', !(await syncs(PORT, 'secure-room', 'not.a.jwt')))
assert('tampered signature -> rejected', !(await syncs(PORT, 'secure-room', mint().slice(0, -3) + 'xyz')))
assert('expired token -> rejected', !(await syncs(PORT, 'secure-room', mint({ exp: now() - 10 }))))
assert('revoked jti -> rejected', !(await syncs(PORT, 'secure-room', mint({ jti: 'jti-bad' }))))
assert('token for a DIFFERENT room -> rejected', !(await syncs(PORT, 'other-room', mint())))

console.log('\n# Wildcard scope works; two authed clients in one room actually talk')
const wild = mint({ name: 'Boss', scopes: [{ room: '*', role: 'maintainer' }] })
assert('wildcard "*" scope admits any room', await syncs(PORT, 'anything-123', wild))

const docA = new Y.Doc(), docB = new Y.Doc()
const pA = new WebsocketProvider(`ws://localhost:${PORT}`, 'secure-room', docA, { WebSocketPolyfill: WebSocket, params: { token: mint() } })
const pB = new WebsocketProvider(`ws://localhost:${PORT}`, 'secure-room', docB, { WebSocketPolyfill: WebSocket, params: { token: mint({ jti: 'jti-ok2' }) } })
await sleep(1500)
docA.getMap('m').set('hello', 'from A')
await sleep(1200)
assert('authed client A change reached authed client B', docB.getMap('m').get('hello') === 'from A')
pA.destroy(); pB.destroy()

console.log('\n# The hive-token CLI mints a token the relay accepts')
const cliTok = await new Promise((resolve) => {
  const p = spawn(process.execPath, ['hive-token.js', '--name', 'CliBot', '--room', 'secure-room', '--role', 'agent', '--ttl', '1h'], { env: { ...process.env, HIVE_JWT_SECRET: SECRET } })
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', () => {})
  p.on('close', () => resolve(out.trim()))
})
assert('CLI emitted a 3-part JWT', cliTok.split('.').length === 3)
assert('CLI-minted token is admitted by the relay', await syncs(PORT, 'secure-room', cliTok))

relay.kill()

// ============ fail-closed + open mode ============
console.log('\n# auth-required with NO keys configured fails closed (rejects all)')
const PORT2 = 1252
const relay2 = await startRelay(PORT2, { HIVE_AUTH_MODE: 'required' }) // no secret
assert('no-keys required mode -> even a token is rejected', !(await syncs(PORT2, 'secure-room', mint())))
relay2.kill()

console.log('\n# open mode (default) is unchanged: tokenless still works')
const PORT3 = 1253
const relay3 = await startRelay(PORT3, {})
assert('open mode -> tokenless client syncs', await syncs(PORT3, 'any-room', ''))
relay3.kill()

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
