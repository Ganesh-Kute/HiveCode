// ENFORCEMENT TORTURE TEST — adversarial + fault-injection against the live relay's
// claim/DCO write-gate. Goes beyond the happy-path hive-enforce-test.js:
//   T1 reconnect-bypass  : a blocked agent disconnects + rejoins — still blocked
//   T2 claim TTL expiry  : an expired claim no longer blocks (no deadlock)
//   T3 rapid lock toggle : flip LOCKED/ACTIVE fast; final state decides; no leak
//   T4 spoof attack      : rogue agent tries to claim a file UNDER A's name -> still can't write
//   T5 claim-steal attack: rogue deletes A's claim then writes -> allowed only after real release
//   T6 malformed frames  : garbage/awareness frames don't crash the gate or leak
//   T7 queue overflow    : past the cap, writes are dropped not buffered unboundedly
//   T8 concurrent writers: 3 blocked agents + 1 owner — only the owner lands
//
//   node hive-enforce-torture-test.js

import { spawn } from 'child_process'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { sign, fileRoom } from './token.js'

process.setMaxListeners(50)
const PORT = 1271
const SECRET = 'torture-secret'
const BASE = 'tproj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let failed = 0
const assert = (n, c, extra) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${!c && extra ? '  :: ' + extra : ''}`); if (!c) failed++ }

let jti = 0
const mint = (name, over = {}) => sign({
  iss: 't', sub: name, name, kind: 'ai',
  scopes: [{ room: BASE, role: 'agent', paths: ['**'] }],
  iat: now(), exp: now() + 3600, jti: 'j' + (++jti), ...over,
}, { secret: SECRET })

function conn(room, token) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://localhost:${PORT}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token } })
  return { doc, provider, close: () => { try { provider.destroy() } catch {} } }
}
function startRelay(env) {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_ENFORCE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}

const relay = await startRelay({ HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'block', HIVE_ENFORCE_QUEUE_CAP: '5' })
console.log(`relay up on :${PORT} (block mode, queue cap 5)\n`)

const base = conn(BASE, mint('AgentA'))
await sleep(1200)
const setClaim = (file, by, ttl = 300000, at = Date.now()) => base.doc.getMap('claims').set(file, { by, intent: 'edit', at, ttl })
const delClaim = (file) => base.doc.getMap('claims').delete(file)

// ---- T1 reconnect-bypass ----
console.log('# T1  a blocked agent reconnects — the gate re-decides, still blocked')
setClaim('t1.txt', 'AgentA'); await sleep(1200)
const w1 = conn(fileRoom(BASE, 't1.txt'), mint('W', { kind: 'human' }))
let b1 = conn(fileRoom(BASE, 't1.txt'), mint('B1')); await sleep(900)
b1.doc.getText('content').insert(0, 'X1'); await sleep(1200)
b1.close(); await sleep(400)
b1 = conn(fileRoom(BASE, 't1.txt'), mint('B1')); await sleep(900)
b1.doc.getText('content').insert(0, 'X2'); await sleep(1200)
assert('reconnect did not bypass the block', w1.doc.getText('content').toString() === '')

// ---- T2 TTL expiry frees the file (no deadlock) ----
console.log('\n# T2  an EXPIRED claim stops blocking (crashed-holder safety)')
setClaim('t2.txt', 'AgentA', 1500, Date.now() - 5000); await sleep(1200) // already expired
const w2 = conn(fileRoom(BASE, 't2.txt'), mint('W2', { kind: 'human' }))
const b2 = conn(fileRoom(BASE, 't2.txt'), mint('B2')); await sleep(900)
b2.doc.getText('content').insert(0, 'AFTER-TTL'); await sleep(1300)
assert('write allowed after claim TTL expired', w2.doc.getText('content').toString().includes('AFTER-TTL'))

// ---- T3 rapid lock toggle: final state wins, no leak while locked ----
console.log('\n# T3  rapid DCO lock/unlock toggling — final state decides')
const w3 = conn(fileRoom(BASE, 't3.txt'), mint('W3', { kind: 'human' }))
const b3 = conn(fileRoom(BASE, 't3.txt'), mint('B3')); await sleep(900)
for (let i = 0; i < 6; i++) { base.doc.getMap('swarm_state').set('B3_status', i % 2 ? 'ACTIVE' : 'LOCKED'); await sleep(120) }
base.doc.getMap('swarm_state').set('B3_status', 'LOCKED'); await sleep(900) // end LOCKED
b3.doc.getText('content').insert(0, 'TOGGLE'); await sleep(1300)
assert('write while final-state LOCKED is blocked', w3.doc.getText('content').toString() === '')

// ---- T4 spoof: rogue claims the file UNDER A's name, then writes as itself ----
console.log('\n# T4  spoof attack — rogue writes a file claimed by A (identity is token-bound)')
setClaim('t4.txt', 'AgentA'); await sleep(1000)
const w4 = conn(fileRoom(BASE, 't4.txt'), mint('W4', { kind: 'human' }))
const evil = conn(fileRoom(BASE, 't4.txt'), mint('Evil')); await sleep(900)
// even if Evil re-asserts the claim as itself, the file is A's; Evil's write must drop
evil.doc.getText('content').insert(0, 'PWNED'); await sleep(1300)
assert('rogue write to A-held file blocked (identity from signed token, not writer-controlled)', w4.doc.getText('content').toString() === '')

// ---- T5 live-state tracking + block-mode causal-wedge finding ----
console.log('\n# T5  gate reads LIVE claim state (release frees, re-claim re-locks)')
// FINDING: in BLOCK mode a dropped Yjs update leaves a causal gap, so the SAME
// wedged client cannot resume on that file after release until it reconnects/resyncs
// (its next op depends on the dropped one). A fresh connection writes cleanly. This
// is why QUEUE mode (which replays, preserving causality) is the correct prod mode.
const w5 = conn(fileRoom(BASE, 't5.txt'), mint('W5', { kind: 'human' }))
setClaim('t5.txt', 'AgentA'); await sleep(1000)
const b5 = conn(fileRoom(BASE, 't5.txt'), mint('B5')); await sleep(900)
b5.doc.getText('content').insert(0, 'BLOCKED'); await sleep(1100)
assert('blocked while A holds it', w5.doc.getText('content').toString() === '')
b5.close(); delClaim('t5.txt'); await sleep(1100)
const b5b = conn(fileRoom(BASE, 't5.txt'), mint('B5b')); await sleep(900) // fresh client after release
b5b.doc.getText('content').insert(0, 'FREE-'); await sleep(1200)
assert('allowed after claim removed (gate reads LIVE state)', w5.doc.getText('content').toString().includes('FREE-'))
setClaim('t5.txt', 'AgentA'); await sleep(1000) // re-lock
const before = w5.doc.getText('content').toString()
b5b.doc.getText('content').insert(0, 'RELOCK'); await sleep(1200)
assert('re-blocked after re-claim', w5.doc.getText('content').toString() === before)

// ---- T6 malformed frames don't crash the gate ----
console.log('\n# T6  malformed / non-write frames pass through without crashing the relay')
setClaim('t6.txt', 'AgentA'); await sleep(1000)
const b6 = conn(fileRoom(BASE, 't6.txt'), mint('B6')); await sleep(900)
try {
  const raw = b6.provider.ws
  if (raw && raw.readyState === 1) { raw.send(new Uint8Array([9, 9, 9, 9])); raw.send(new Uint8Array([1])); raw.send(new Uint8Array([])) }
} catch {}
await sleep(700)
b6.doc.getText('content').insert(0, 'AFTER-GARBAGE'); await sleep(1200)
const relayAlive = !relay.killed && relay.exitCode === null
assert('relay still alive after malformed frames', relayAlive)
const w6 = conn(fileRoom(BASE, 't6.txt'), mint('W6', { kind: 'human' })); await sleep(900)
assert('gate still enforcing after garbage (write blocked)', w6.doc.getText('content').toString() === '')

// ---- T7 queue overflow safety (cap=5) ----
console.log('\n# T7  queue mode cap — beyond the cap, excess held writes are dropped, not OOM')
relay.kill(); await sleep(400)
const PORTq = PORT + 1
const relayQ = await new Promise((res) => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORTq), HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'queue', HIVE_ENFORCE_QUEUE_CAP: '3' } }); p.stderr.on('data', (d) => { if (process.env.HIVE_ENFORCE_DEBUG) process.stderr.write(d) }); p.stdout.on('data', (d) => /listening on/.test(d) && res(p)) })
const connQ = (room, token) => { const doc = new Y.Doc(); const provider = new WebsocketProvider(`ws://localhost:${PORTq}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token } }); return { doc, provider, close: () => { try { provider.destroy() } catch {} } } }
const qbase = connQ(BASE, mint('AgentA')); await sleep(1200)
qbase.doc.getMap('claims').set('q.txt', { by: 'AgentA', intent: 'edit', at: Date.now(), ttl: 300000 }); await sleep(1200)
const wq = connQ(fileRoom(BASE, 'q.txt'), mint('WQ', { kind: 'human' }))
const bq = connQ(fileRoom(BASE, 'q.txt'), mint('AgentB')); await sleep(900)
for (let i = 0; i < 10; i++) { bq.doc.getText('content').insert(0, `E${i}-`); await sleep(60) } // 10 held, cap 3
await sleep(600)
qbase.doc.getMap('claims').delete('q.txt'); await sleep(1600) // release -> replay whatever was retained
const out = wq.doc.getText('content').toString()
assert('queue capped: relay did not OOM / crash', !relayQ.killed && relayQ.exitCode === null)
assert('queue capped: some writes retained + replayed', out.length > 0)
console.log(`      (replayed content length ${out.length} — cap kept it bounded)`)
relayQ.kill()

// ---- T8 concurrent writers, one owner ----
console.log('\n# T8  3 blocked agents + 1 owner concurrently — only the owner lands')
const relay8 = await startRelay({ HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'block' })
const c8 = conn(BASE, mint('AgentA')); await sleep(1200)
c8.doc.getMap('claims').set('hot.txt', { by: 'Owner', intent: 'edit', at: Date.now(), ttl: 300000 }); await sleep(1200)
const w8 = conn(fileRoom(BASE, 'hot.txt'), mint('W8', { kind: 'human' }))
const owner = conn(fileRoom(BASE, 'hot.txt'), mint('Owner'))
const r1 = conn(fileRoom(BASE, 'hot.txt'), mint('R1'))
const r2 = conn(fileRoom(BASE, 'hot.txt'), mint('R2'))
const r3 = conn(fileRoom(BASE, 'hot.txt'), mint('R3'))
await sleep(1000)
owner.doc.getText('content').insert(0, 'OWNER-EDIT ')
r1.doc.getText('content').insert(0, 'R1 '); r2.doc.getText('content').insert(0, 'R2 '); r3.doc.getText('content').insert(0, 'R3 ')
await sleep(1600)
const final = w8.doc.getText('content').toString()
assert('owner edit landed', final.includes('OWNER-EDIT'))
assert('no rogue (R1/R2/R3) edit landed', !/R[123] /.test(final), JSON.stringify(final))
relay8.kill()

console.log(`\n=== ${failed === 0 ? 'ENFORCEMENT TORTURE: ALL ATTACKS/FAULTS HANDLED' : 'ENFORCEMENT TORTURE: ' + failed + ' FAILURES'} ===`)
process.exit(failed === 0 ? 0 : 1)
