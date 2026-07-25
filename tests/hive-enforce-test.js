// LIVE proof of relay-side claim/DCO WRITE ENFORCEMENT over the real relay.
// Starts the actual server.js with HIVE_ENFORCE_CLAIMS=block and shows that:
//   1. an agent's write to a file CLAIMED by someone else is dropped (never reaches peers),
//   2. the claim OWNER's own write propagates,
//   3. a DCO-LOCKED agent's write is dropped,
//   4. once unlocked, its write propagates.
// Enforcement needs a known identity, so the relay runs in auth-required mode.
//
//   node hive-enforce-test.js

import { spawn } from 'child_process'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { sign, fileRoom } from './token.js'

const PORT = 1259
const SECRET = 'enforce-secret'
const BASE = 'proj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

let jti = 0
const mint = (name, over = {}) => sign({
  iss: 'test', sub: name, name, kind: 'ai',
  scopes: [{ room: BASE, role: 'agent', paths: ['**'] }],
  iat: now(), exp: now() + 3600, jti: 'j' + (++jti), ...over,
}, { secret: SECRET })

function connect(room, token) {
  const doc = new Y.Doc()
  // disableBc: force ALL sync through the relay (no same-process BroadcastChannel
  // shortcut), matching real clients (sync.js) — otherwise peers in one test process
  // would bypass the relay's write-gate.
  const provider = new WebsocketProvider(`ws://localhost:${PORT}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token } })
  return { doc, provider }
}
function startRelay(env) {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_ENFORCE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}
const PORT_Q = PORT + 1
function connectQ(room, token) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://localhost:${PORT_Q}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token } })
  return { doc, provider }
}
function startRelayQ(env) {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT_Q), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_ENFORCE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}

const relay = await startRelay({ HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'block' })
console.log(`relay up on :${PORT} (auth-required, HIVE_ENFORCE_CLAIMS=block)\n`)

// AgentA joins the BASE room and takes a claim on shared.txt.
const aBase = connect(BASE, mint('AgentA'))
await sleep(1200)
aBase.doc.getMap('claims').set('shared.txt', { by: 'AgentA', intent: 'edit', at: Date.now(), ttl: 300000 })
await sleep(1400) // let the relay's base doc receive the claim

// A human observer watches the file room (reads are never gated).
const FR = fileRoom(BASE, 'shared.txt')
const watch = connect(FR, mint('Watcher', { kind: 'human' }))
await sleep(1000)

console.log('# 1. A non-owner (AgentB) writes a file AgentA holds -> BLOCKED')
const b = connect(FR, mint('AgentB'))
await sleep(1000)
b.doc.getText('content').insert(0, 'B-WAS-HERE')
await sleep(1600)
console.log(`    [watch content = ${JSON.stringify(watch.doc.getText('content').toString())}]  [b local = ${JSON.stringify(b.doc.getText('content').toString())}]`)
assert('AgentB write to A-claimed file did NOT propagate', watch.doc.getText('content').toString() === '')

console.log('\n# 2. The claim OWNER (AgentA) writes the same file -> ALLOWED')
const aFile = connect(FR, mint('AgentA'))
await sleep(1000)
aFile.doc.getText('content').insert(0, 'A-OWNS-IT')
await sleep(1600)
assert('AgentA (owner) write propagated to the watcher', watch.doc.getText('content').toString().includes('A-OWNS-IT'))

console.log('\n# 3. A DCO-LOCKED agent writes an unclaimed file -> BLOCKED')
aBase.doc.getMap('swarm_state').set('AgentB_status', 'LOCKED')
await sleep(1200)
const FR2 = fileRoom(BASE, 'free.txt')
const watch2 = connect(FR2, mint('Watcher2', { kind: 'human' }))
const bLocked = connect(FR2, mint('AgentB'))
await sleep(1000)
bLocked.doc.getText('content').insert(0, 'LOCKED-WRITE')
await sleep(1600)
assert('DCO-locked AgentB write did NOT propagate', watch2.doc.getText('content').toString() === '')

console.log('\n# 4. After unlock, the same agent writes -> ALLOWED')
aBase.doc.getMap('swarm_state').set('AgentB_status', 'ACTIVE')
await sleep(1200)
const bFree = connect(FR2, mint('AgentB')) // fresh client for a clean CRDT write
await sleep(1000)
bFree.doc.getText('content').insert(0, 'UNLOCKED-WRITE')
await sleep(1600)
assert('after unlock, AgentB write propagated', watch2.doc.getText('content').toString().includes('UNLOCKED-WRITE'))

for (const c of [aBase, watch, b, aFile, watch2, bLocked, bFree]) { try { c.provider.destroy() } catch {} }
relay.kill()

// ============ queue mode: zero-loss (held, then replayed on release) ============
const relayQ = await startRelayQ({ HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'queue' })
console.log(`\nrelay up on :${PORT_Q} (HIVE_ENFORCE_CLAIMS=queue)\n`)

const qA = connectQ(BASE, mint('AgentA'))
await sleep(1200)
qA.doc.getMap('claims').set('doc.txt', { by: 'AgentA', intent: 'edit', at: Date.now(), ttl: 300000 })
await sleep(1400)
const QFR = fileRoom(BASE, 'doc.txt')
const qWatch = connectQ(QFR, mint('Watcher', { kind: 'human' }))
const qB = connectQ(QFR, mint('AgentB'))
await sleep(1000)

console.log('# 5. queue mode: AgentB write to A-claimed file is HELD (not lost)')
qB.doc.getText('content').insert(0, 'QUEUED-EDIT')
await sleep(1600)
assert('held: watcher has not received it yet', qWatch.doc.getText('content').toString() === '')

console.log('\n# 6. queue mode: on claim RELEASE, the held write REPLAYS (zero-loss)')
qA.doc.getMap('claims').delete('doc.txt')
await sleep(1800)
assert('replayed: watcher now has the previously-blocked edit', qWatch.doc.getText('content').toString().includes('QUEUED-EDIT'))

for (const c of [qA, qWatch, qB]) { try { c.provider.destroy() } catch {} }
relayQ.kill()

console.log(`\n=== ${failed === 0 ? 'RELAY WRITE-ENFORCEMENT WORKS (block + queue, claim + DCO, over the real relay)' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
