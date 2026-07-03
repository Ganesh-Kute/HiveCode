// LIVE proof of RELAY-SIDE provenance enforcement (invariant I1 made "can't").
// A client injects a valid receipt AND a forged one into a file's ledger. In
// HIVE_PROVENANCE=strict the relay REMOVES the forged receipt from the shared ledger
// (forged provenance cannot persist); in HIVE_PROVENANCE=audit it is left in place
// (logged only). Run over the real relay.
//
//   node substrate-enforce-test.js

import { spawn } from 'child_process'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { fileRoom } from './token.js'
import { genIdentity, authorChange, verifyReceipt } from './substrate.js'

const BASE = 'provproj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

function startRelay(port, mode) {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), HIVE_PROVENANCE: mode } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}
function connect(port, room) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://localhost:${port}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
  return { doc, provider }
}

// A valid receipt + a forged twin (same signature, mutated intent -> signature breaks).
const id = genIdentity('Attacker')
const good = authorChange({ identity: id, filename: 'app.js', base: '', text: 'const ok = 1\n', intent: 'legit', at: Date.now() }).prov
const forged = { ...good, intent: 'rewritten-after-signing' }
console.assert(verifyReceipt(good).ok && !verifyReceipt(forged).ok, 'test setup: good verifies, forged does not')

async function run(mode, port) {
  const relay = await startRelay(port, mode)
  console.log(`\n# HIVE_PROVENANCE=${mode} (relay :${port})`)
  const c = connect(port, fileRoom(BASE, 'app.js'))
  await sleep(1200)
  const ledger = c.doc.getArray('ledger')
  ledger.push([good, forged]) // one honest, one forged
  await sleep(2500)            // let the relay guard run + sync the result back
  const remaining = ledger.toArray()
  const forgedGone = !remaining.some((r) => r.intent === 'rewritten-after-signing')
  const goodKept = remaining.some((r) => r.intent === 'legit' && verifyReceipt(r).ok)

  if (mode === 'strict') {
    assert('forged receipt REMOVED by the relay', forgedGone)
    assert('honest receipt kept', goodKept)
    assert('ledger holds only verifiable receipts', remaining.every((r) => verifyReceipt(r).ok))
  } else {
    assert('audit mode: honest receipt present', goodKept)
    assert('audit mode: forged receipt left in place (logged, not removed)', !forgedGone)
  }
  try { c.provider.destroy() } catch {}
  relay.kill()
  await sleep(300)
}

await run('strict', 1281)
await run('audit', 1282)

console.log(`\n=== ${failed === 0 ? 'RELAY PROVENANCE ENFORCEMENT WORKS (strict removes forged, audit logs) ===' : failed + ' FAILED ==='}`)
process.exit(failed === 0 ? 0 : 1)
