// Self-certifying secured rooms: the room id embeds a fingerprint of the owner's
// public key. The relay enforces folder-scope with ZERO server state and ZERO
// configured secret — even in its default OPEN mode. This is what lets the hosted
// free-tier relay enforce access with nothing but the extension driving it.
//
//   node hive-secure-test.js
//
// Proves: scoped agent gets only its subtree; a token signed by a DIFFERENT key
// is rejected (fingerprint mismatch); a tokenless connect is rejected; and the
// owner can REVOKE an agent live via POST /__hive/revoke.

import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { startSync } from './sync.js'
import { sign, makeSecuredRoomId, fileRoom } from './token.js'

const PORT = 1274
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }

// owner keypair (would live in the editor's secure storage). Room id is derived
// from the public key, so the room itself certifies who may mint tokens for it.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
const ROOM = makeSecuredRoomId(pubPem, crypto.randomBytes(6).toString('hex'))

const mint = (scopes, name, jti) => sign({ iss: 'hivecode', sub: name, name, kind: 'ai', pk: pubPem, scopes, iat: now(), exp: now() + 3600, jti }, { privateKey })
const ownerTok = mint([{ room: ROOM, role: 'maintainer' }], 'Owner', 'jti-owner')
const agentTok = mint([{ room: ROOM, role: 'agent', paths: ['frontend/**'] }], 'FrontBot', 'jti-agent')

const OWNER = path.resolve('.secure-test/owner'), AGENT = path.resolve('.secure-test/agent')
fs.rmSync(path.resolve('.secure-test'), { recursive: true, force: true })
fs.mkdirSync(path.join(OWNER, 'frontend'), { recursive: true })
fs.mkdirSync(path.join(OWNER, 'backend'), { recursive: true })
fs.mkdirSync(AGENT, { recursive: true })
fs.writeFileSync(path.join(OWNER, 'frontend', 'app.js'), 'export const ui = "hello"')
fs.writeFileSync(path.join(OWNER, 'backend', 'secrets.js'), 'export const DB_PASSWORD = "hunter2"')

// DEFAULT (open) relay — no HIVE_AUTH_MODE, no secret. Secured rooms still enforce.
const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

function syncs(room, token, ms = 2500) {
  const d = new Y.Doc()
  const p = new WebsocketProvider(RELAY, room, d, { WebSocketPolyfill: WebSocket, disableBc: true, params: token ? { token } : undefined })
  return new Promise((res) => { let done = false; const fin = (v) => { if (!done) { done = true; try { p.destroy() } catch {} ; res(v) } }; p.on('sync', (s) => s && fin(true)); setTimeout(() => fin(false), ms) })
}

console.log('# A secured room enforces even on an OPEN relay (no configured secret)')
assert('owner token admitted to the room', await syncs(ROOM, ownerTok))
assert('a tokenless connect is REJECTED', !(await syncs(ROOM, '')))
// a token signed by a DIFFERENT key (attacker brings their own keypair)
const { publicKey: pub2, privateKey: priv2 } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const forged = sign({ iss: 'x', sub: 'attacker', name: 'attacker', kind: 'ai', pk: pub2.export({ type: 'spki', format: 'pem' }), scopes: [{ room: ROOM, role: 'admin' }], iat: now(), exp: now() + 3600, jti: 'jti-forged' }, { privateKey: priv2 })
assert('a token signed by a different key is REJECTED (fingerprint mismatch)', !(await syncs(ROOM, forged)))

console.log('\n# Folder scope is enforced for the agent')
const owner = startSync({ relay: RELAY, room: ROOM, dir: OWNER, name: 'Owner', kind: 'human', token: ownerTok, log: () => {} })
await sleep(2500)
const agent = startSync({ relay: RELAY, room: ROOM, dir: AGENT, name: 'FrontBot', kind: 'ai', token: agentTok, log: () => {} })
await sleep(3500)
assert('agent GOT frontend/app.js (in scope)', (read(AGENT, 'frontend/app.js') || '').includes('hello'))
assert('agent did NOT get backend/secrets.js (out of scope)', read(AGENT, 'backend/secrets.js') === null)
assert('relay admits the in-scope file-room', await syncs(fileRoom(ROOM, 'frontend/app.js'), agentTok))
assert('relay REJECTS the out-of-scope file-room', !(await syncs(fileRoom(ROOM, 'backend/secrets.js'), agentTok)))

console.log('\n# The owner can REVOKE the agent live')
const r = await fetch(`http://localhost:${PORT}/__hive/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: ROOM, token: ownerTok, jti: 'jti-agent' }) })
assert('revoke accepted (owner authorized)', r.ok)
assert('revoked agent can no longer connect', !(await syncs(fileRoom(ROOM, 'frontend/app.js'), agentTok)))
// a non-owner can't revoke (attacker token rejected)
const r2 = await fetch(`http://localhost:${PORT}/__hive/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: ROOM, token: forged, jti: 'jti-owner' }) })
assert('a non-owner revoke is rejected', !r2.ok)
assert('owner still connects after the failed revoke attempt', await syncs(ROOM, ownerTok))

console.log(`\n=== ${failed === 0 ? 'ALL SECURE-ROOM CHECKS PASSED' : failed + ' FAILED'} ===`)
owner.stop(); agent.stop(); relay.kill()
fs.rmSync(path.resolve('.secure-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
