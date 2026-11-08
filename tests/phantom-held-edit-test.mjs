// tests/phantom-held-edit-test.mjs — Regression test for phantom held-edit notices on claimed files
//
// Root cause:
// In server.js, `isSyncWrite(data)` previously checked only `t === 1 || t === 2` (syncStep2 or update)
// without inspecting the Yjs update payload against the relay's current Y.Doc.
// Because y-websocket's client handshake ALWAYS replies to the server's syncStep1 with a syncStep2
// (carrying `[0, 0]` on first open, or already-known structs on reconnect), opening or reconnecting
// to a claimed file queued a no-op write and broadcast a phantom notice:
//   "⏸ @PeerB: your edit to f.js is held: @PeerA holds it."
//
// This test spawns the real server.js with `HIVE_ENFORCE_CLAIMS=queue` and verifies:
//   1. First open of a claimed file (empty syncStep2 `[0, 0]`) -> 0 held notices.
//   2. Reconnect / re-sent already-known structs (`Y.diffUpdate(u, sv)` is `[0, 0]`) -> 0 held notices.
//   3. Real insert (including a full-state update carrying old + new structs) while claimed -> HELD,
//      then replayed when the claim is released.
//   4. Real delete-only update (0 new structs, non-empty delete set) while claimed -> HELD,
//      then replayed when the claim is released.

import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import { WebsocketProvider } from 'y-websocket'
import { fileRoom } from '../token.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function startRelay(env = {}) {
  const p = await freePort()
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(p),
      HIVE_PERSIST_DIR: 'off',
      HIVE_ENFORCE_CLAIMS: 'queue',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Relay start timeout')), 6000)
    proc.stdout.on('data', (d) => {
      if (/listening on/.test(d)) {
        clearTimeout(timeout)
        resolve()
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Relay exited early with code ${code}`))
    })
  })
  return {
    proc,
    port: p,
    wsUrl: `ws://127.0.0.1:${p}`,
    kill: () => { try { proc.kill('SIGKILL') } catch {} },
  }
}

function waitForSync(prov, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    if (prov.synced) return resolve()
    const timer = setTimeout(() => reject(new Error('Provider sync timeout')), timeoutMs)
    const onSync = (isSynced) => {
      if (isSynced) {
        clearTimeout(timer)
        prov.off('sync', onSync)
        resolve()
      }
    }
    prov.on('sync', onSync)
  })
}

async function waitUntil(pred, timeoutMs = 4000, stepMs = 30) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return true
    await sleep(stepMs)
  }
  return false
}

function buildSyncFrame(syncType, updateBytes) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0) // messageSync
  encoding.writeVarUint(enc, syncType) // 1 = syncStep2, 2 = update
  encoding.writeVarUint8Array(enc, updateBytes)
  return encoding.toUint8Array(enc)
}

const relay = await startRelay()
const BASE_ROOM = 'room-phantom-test'
const FILE_ROOM = fileRoom(BASE_ROOM, 'f.js')

try {
  // ── Peer A joins base room + file room, seeds "hello", and claims f.js ──
  // disableBc: true ensures all sync travels through the relay WebSocket (not in-process BroadcastChannel)
  const baseDocA = new Y.Doc()
  const provBaseA = new WebsocketProvider(relay.wsUrl, BASE_ROOM, baseDocA, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { name: 'PeerA', kind: 'ai' },
  })
  await waitForSync(provBaseA)

  const docFileA = new Y.Doc()
  const provFileA = new WebsocketProvider(relay.wsUrl, FILE_ROOM, docFileA, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { name: 'PeerA', kind: 'ai' },
  })
  await waitForSync(provFileA)

  docFileA.getText('content').insert(0, 'hello')
  const claims = baseDocA.getMap('claims')
  const claimFile = (why) => {
    claims.set('f.js', { by: 'PeerA', why, at: Date.now(), ttl: 60000 })
  }
  const resetClaim = async (why) => {
    claims.delete('f.js')
    await sleep(100)
    claimFile(why)
    await sleep(100)
  }

  claimFile('testing phantom held edit')
  await sleep(120)

  const chat = baseDocA.getArray('chat')
  const heldMessagesSince = (startIdx) =>
    chat.toArray().slice(startIdx).filter((m) => m && typeof m.text === 'string' && m.text.includes('your edit to f.js is held'))

  // =========================================================================
  sec('1. First open of a claimed file (empty syncStep2 [0, 0] handshake)')
  // =========================================================================
  const idx1 = chat.length
  const docFileB = new Y.Doc()
  const provFileB = new WebsocketProvider(relay.wsUrl, FILE_ROOM, docFileB, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { name: 'PeerB', kind: 'ai' },
  })
  await waitForSync(provFileB)
  await waitUntil(() => docFileB.getText('content').toString() === 'hello')
  await sleep(200)

  const held1 = heldMessagesSince(idx1)
  T('PeerB synced claimed file f.js content ("hello")', docFileB.getText('content').toString() === 'hello')
  T('First open of claimed f.js produces 0 phantom held-edit notices', held1.length === 0, `got ${held1.length}: ${JSON.stringify(held1.map((m) => m.text))}`)

  // =========================================================================
  sec('2. Reconnect & re-sent already-known structs on a claimed file')
  // =========================================================================
  provFileB.destroy()
  await resetClaim('re-claimed before PeerB reconnect')

  const idx2a = chat.length
  // PeerB reconnects with docFileB that ALREADY has the "hello" structs
  const provFileB2 = new WebsocketProvider(relay.wsUrl, FILE_ROOM, docFileB, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { name: 'PeerB', kind: 'ai' },
  })
  await waitForSync(provFileB2)
  await sleep(180)

  const held2a = heldMessagesSince(idx2a)
  T('Reconnecting PeerB with already-known structs produces 0 held notices', held2a.length === 0, `got ${held2a.length}: ${JSON.stringify(held2a.map((m) => m.text))}`)

  // Reset claim so conn._wq is empty even on unpatched server.js before testing explicit knownUpdate frames
  await resetClaim('re-claimed before explicit knownUpdate frames')
  const idx2b = chat.length
  const knownUpdate = Y.encodeStateAsUpdate(docFileB)
  T('Known state update is non-empty (> 2 bytes)', knownUpdate.length > 2, `len=${knownUpdate.length}`)
  provFileB2.ws.send(buildSyncFrame(1, knownUpdate))
  provFileB2.ws.send(buildSyncFrame(2, knownUpdate))
  await sleep(200)

  const held2b = heldMessagesSince(idx2b)
  T('Explicit syncStep2 + update with already-known structs produces 0 held notices', held2b.length === 0, `got ${held2b.length}: ${JSON.stringify(held2b.map((m) => m.text))}`)

  // Case 2c: Claimed file whose doc has historical deletions (Y.diffUpdate leaves the delete set intact!)
  provFileB2.destroy()
  claims.delete('f.js')
  await sleep(100)
  // Seed historical deletion on PeerA while unclaimed: "hello" -> "hello temp" -> delete " temp" -> "hello"
  docFileA.getText('content').insert(5, ' temp')
  docFileA.getText('content').delete(5, 5)

  // Sync PeerB with the doc containing historical deletions while unclaimed, then disconnect
  const provFileB_delSync = new WebsocketProvider(relay.wsUrl, FILE_ROOM, docFileB, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { name: 'PeerB', kind: 'ai' },
  })
  await waitForSync(provFileB_delSync)
  await waitUntil(() => docFileB.getText('content').toString() === 'hello')
  await sleep(100)
  provFileB_delSync.destroy()

  // Now PeerA claims f.js (which has historical deletions in its store) and PeerB reconnects
  await resetClaim('re-claimed on doc with historical deletions')
  const idx2c = chat.length
  const provFileB3 = new WebsocketProvider(relay.wsUrl, FILE_ROOM, docFileB, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
    params: { name: 'PeerB', kind: 'ai' },
  })
  await waitForSync(provFileB3)
  await sleep(180)

  const held2c = heldMessagesSince(idx2c)
  T('Reconnecting PeerB on a claimed file with historical deletions produces 0 held notices', held2c.length === 0, `got ${held2c.length}: ${JSON.stringify(held2c.map((m) => m.text))}`)

  await resetClaim('re-claimed before explicit update with historical delete set')
  const idx2d = chat.length
  const knownUpdateWithDeletes = Y.encodeStateAsUpdate(docFileB, Y.encodeStateVector(docFileA))
  provFileB3.ws.send(buildSyncFrame(1, knownUpdateWithDeletes))
  provFileB3.ws.send(buildSyncFrame(2, knownUpdateWithDeletes))
  await sleep(200)

  const held2d = heldMessagesSince(idx2d)
  T('Explicit syncStep2 + update with already-applied delete set produces 0 held notices', held2d.length === 0, `got ${held2d.length}: ${JSON.stringify(held2d.map((m) => m.text))}`)

  // =========================================================================
  sec('3. Real write carrying old + new structs while claimed is HELD then replayed')
  // =========================================================================
  await resetClaim('re-claimed before real mixed write')
  const idx3 = chat.length
  // Mutate docFileB locally and also send full state update (contains old "hello" + new " world" structs)
  docFileB.getText('content').insert(5, ' world')
  const mixedUpdate = Y.encodeStateAsUpdate(docFileB)
  provFileB3.ws.send(buildSyncFrame(2, mixedUpdate))

  const gotHeld3 = await waitUntil(() => heldMessagesSince(idx3).length > 0, 2000)
  const held3 = heldMessagesSince(idx3)
  T('Real write by PeerB while PeerA holds claim triggers held notice', gotHeld3 && held3.length === 1, `got ${held3.length}`)
  T('PeerA still sees "hello" while claim is active (write is held)', docFileA.getText('content').toString() === 'hello', `got ${JSON.stringify(docFileA.getText('content').toString())}`)

  // Release PeerA's claim -> held write must flush and land on PeerA
  claims.delete('f.js')
  const landed3 = await waitUntil(() => docFileA.getText('content').toString() === 'hello world', 3000)
  T('Releasing claim replays PeerB held write ("hello world") to PeerA', landed3, `got ${JSON.stringify(docFileA.getText('content').toString())}`)

  // =========================================================================
  sec('4. Real delete-only write (0 new structs, non-empty delete set) while claimed is HELD')
  // =========================================================================
  claimFile('claimed before delete-only update')
  await sleep(120)

  const idx4 = chat.length
  // Delete " world" on PeerB -> produces a delete-only Yjs update (0 structs, 1 delete client)
  docFileB.getText('content').delete(5, 6)
  const gotHeld4 = await waitUntil(() => heldMessagesSince(idx4).length > 0, 2000)
  const held4 = heldMessagesSince(idx4)
  T('Delete-only write by PeerB while PeerA holds claim triggers held notice', gotHeld4 && held4.length === 1, `got ${held4.length}`)
  T('PeerA still sees "hello world" while claim is active (delete is held)', docFileA.getText('content').toString() === 'hello world', `got ${JSON.stringify(docFileA.getText('content').toString())}`)

  // Release claim -> held delete flushes and PeerA sees "hello"
  claims.delete('f.js')
  const landed4 = await waitUntil(() => docFileA.getText('content').toString() === 'hello', 3000)
  T('Releasing claim replays PeerB held delete ("hello") to PeerA', landed4, `got ${JSON.stringify(docFileA.getText('content').toString())}`)

  provFileB3.destroy()
  provFileA.destroy()
  provBaseA.destroy()
} finally {
  relay.kill()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
