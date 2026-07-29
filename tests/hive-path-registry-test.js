// LIVE proof of RELAY-SIDE PATH REGISTRY enforcement over the real relay.
//
// The client-side gate in hive-mcp.js is only as strong as the weakest client in the room. On
// 2026-07-29 that stopped being hypothetical: FIVE copies of hive-mcp.js were found on one machine,
// four of them six weeks old with no gate in them at all. An old build, an `npx` install, or any
// client that simply does not implement the check bypasses every flag. The relay is the only
// participant no client controls, so it is the only place these can be guarantees.
//
// This test writes DIRECTLY to the file room with a plain yjs client — no hive-mcp.js in the path at
// all. That is deliberate: it is exactly what an unpatched or hostile client looks like. If the write
// still lands, relay enforcement does not exist.
//
// Proves:
//   1. a write to a DELETED_UNWRITABLE path is dropped, even for an UNLOCKED agent holding no claim
//   2. a normal path still propagates (the gate is not simply blocking everything)
//   3. CORRUPT / DIVERGED / SUPERSEDED all block
//   4. an UNRECOGNISED value fails CLOSED, not open
//   5. in QUEUE mode a permanent block is DROPPED, not replayed later — the assertion that matters
//      most, because replaying it on flush would land the exact damage the flag exists to prevent
//
//   node tests/hive-path-registry-test.js

import { spawn } from 'child_process'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { sign, fileRoom } from '../token.js'

const PORT = 1281
const PORT_Q = 1282
const SECRET = 'path-registry-secret'
const BASE = 'proj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

let jti = 0
const mint = (name) => sign({
  iss: 'test', sub: name, name, kind: 'ai',
  scopes: [{ room: BASE, role: 'agent', paths: ['**'] }],
  iat: now(), exp: now() + 3600, jti: 'j' + (++jti),
}, { secret: SECRET })

function connect(port, room, token) {
  const doc = new Y.Doc()
  // disableBc: force ALL sync through the relay, so peers in one process cannot bypass the gate.
  const provider = new WebsocketProvider(`ws://localhost:${port}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token } })
  return { doc, provider }
}
function startRelay(port, env) {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_ENFORCE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}

const relay = await startRelay(PORT, { HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'block' })
console.log(`relay up on :${PORT} (auth-required, HIVE_ENFORCE_CLAIMS=block)\n`)

// The PM sets the registry in the BASE room's swarm_state. Base-room writes are never gated.
const pm = connect(PORT, BASE, mint('PM'))
await sleep(700)
const state = pm.doc.getMap('swarm_state')
state.set('path:doomed.txt', 'DELETED_UNWRITABLE')
state.set('path:rotten.txt', 'CORRUPT')
state.set('path:split.txt', 'DIVERGED')
state.set('path:oldapi.txt', 'SUPERSEDED')
state.set('path:mystery.txt', 'SOMETHING_THIS_BUILD_HAS_NEVER_HEARD_OF')
state.set('path:fine.txt', 'LIVE')
await sleep(900)

/**
 * A fully entitled agent — unlocked, holding no conflicting claim — writes straight to a file room
 * with a plain yjs client. Returns whether an independent watcher ever saw it.
 */
async function tryWrite(port, file, marker) {
  const room = fileRoom(BASE, file)
  const watcher = connect(port, room, mint('Watcher'))
  await sleep(600)
  const writer = connect(port, room, mint('Writer'))
  await sleep(600)
  writer.doc.getText('content').insert(0, marker)
  await sleep(1400)
  const seen = watcher.doc.getText('content').toString()
  writer.provider.destroy(); watcher.provider.destroy()
  return seen.includes(marker)
}

console.log('# 1. control — an unrestricted path must still propagate')
assert('LIVE path: write reached the watcher', await tryWrite(PORT, 'fine.txt', 'HELLO-FINE'))

console.log('\n# 2. DELETED_UNWRITABLE — dropped even though the writer is unlocked and unclaimed')
assert('write did NOT reach the watcher', !(await tryWrite(PORT, 'doomed.txt', 'HELLO-DOOMED')))

console.log('\n# 3. the other restricted values')
assert('CORRUPT blocks', !(await tryWrite(PORT, 'rotten.txt', 'HELLO-ROTTEN')))
assert('DIVERGED blocks', !(await tryWrite(PORT, 'split.txt', 'HELLO-SPLIT')))
assert('SUPERSEDED blocks (read it, do not write it)', !(await tryWrite(PORT, 'oldapi.txt', 'HELLO-OLD')))

console.log('\n# 4. an UNRECOGNISED value must fail CLOSED')
assert('unknown flag blocks rather than being ignored', !(await tryWrite(PORT, 'mystery.txt', 'HELLO-MYSTERY')))

relay.kill()
await sleep(400)

// ---------------------------------------------------------------------------------------------
// The assertion that matters most. Queueing exists so a legitimate write that arrived early is not
// lost — a DCO lock or a claim clears, and the held write replays. A restricted PATH is different in
// kind: the write is not early, it is wrong. If it were queued, then the moment anyone set the flag
// back to LIVE the queue would flush and land exactly the damage the flag existed to prevent.
// ---------------------------------------------------------------------------------------------
const relayQ = await startRelay(PORT_Q, { HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'queue' })
console.log(`\nrelay up on :${PORT_Q} (HIVE_ENFORCE_CLAIMS=queue)\n`)

const pmQ = connect(PORT_Q, BASE, mint('PMQ'))
await sleep(700)
pmQ.doc.getMap('swarm_state').set('path:trap.txt', 'DELETED_UNWRITABLE')
await sleep(900)

console.log('# 5. queue mode: a PERMANENT block is dropped, not held for replay')
const room = fileRoom(BASE, 'trap.txt')
const watcher = connect(PORT_Q, room, mint('WatcherQ'))
await sleep(600)
const writer = connect(PORT_Q, room, mint('WriterQ'))
await sleep(600)
writer.doc.getText('content').insert(0, 'HELLO-TRAP')
await sleep(1200)
assert('blocked while the flag stands', !watcher.doc.getText('content').toString().includes('HELLO-TRAP'))

// Now lift the flag. A QUEUED write would replay here. A DROPPED one is gone for good.
pmQ.doc.getMap('swarm_state').set('path:trap.txt', 'LIVE')
await sleep(2000)
assert('and STILL absent after the flag is lifted — it was dropped, never queued',
  !watcher.doc.getText('content').toString().includes('HELLO-TRAP'))

console.log(`\n=== ${failed ? `${failed} FAILED` : 'RELAY-SIDE PATH REGISTRY ENFORCEMENT WORKS'} ===`)
for (const c of [pm, pmQ, watcher, writer]) { try { c.provider.destroy() } catch { } }
try { relayQ.kill() } catch { }
await sleep(300)
process.exit(failed ? 1 : 0)
