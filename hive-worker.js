// A real Hive worker: connects to the live relay, runs the coordination protocol against
// a real Yjs Y.Map shared with the other workers, and records every interval during which
// it BELIEVED it owned a region. The parent test checks no two workers ever owned the same
// region at the same time — over real network + real CRDT concurrency.
//
//   node hive-worker.js <relay> <room> <selfId> <regions> <iters>

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
// HiveSocket, not raw ws: behind an explicit proxy it tunnels (CONNECT), where the proxy refuses the
// upgrade it long-polls, loopback stays direct, HIVE_PROXY=off restores the old direct dial.
import { HiveSocket } from './hive-transport.js'
import { makeCoordinator } from './hive-coord.js'

const [, , RELAY, ROOM, self, REGIONS, ITERS] = process.argv
const R = +REGIONS
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (n) => Math.floor(Math.random() * n)
const SYNC_WAIT = 130 // let the CRDT converge after a claim (real network window)
const WORK = 60       // how long an owner "edits" before releasing

const doc = new Y.Doc()
const claims = doc.getMap('claims')
const prov = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: HiveSocket })
await new Promise((res) => prov.on('sync', (s) => s && res()))

const coord = makeCoordinator(claims, self, { ttl: 1500 })
const intervals = []

for (let i = 0; i < +ITERS; i++) {
  // SENSE + FLOW: want a random region; if it's another's, flow to the first open one.
  let cand = null
  const want = 'r' + rand(R)
  if (coord.free(want)) cand = want
  else for (let r = 0; r < R; r++) { const k = 'r' + r; if (coord.free(k)) { cand = k; break } }
  if (!cand) { await sleep(20); continue } // whole codebase busy this instant → wait

  // CLAIM, then let the network converge, then VERIFY (collision-detect over the CRDT).
  coord.claim(cand, 'edit')
  await sleep(SYNC_WAIT)
  const c = claims.get(cand)
  if (c && c.by === self) {
    // I own it after sync → work, record the ownership window, then RELEASE.
    const t0 = Date.now()
    await sleep(WORK)
    const t1 = Date.now()
    intervals.push({ region: cand, by: self, t0, t1 })
    coord.release(cand)
  }
  await sleep(10)
}

await sleep(300) // let final releases propagate
process.stdout.write('INTERVALS ' + JSON.stringify(intervals) + '\n')
prov.destroy()
process.exit(0)
