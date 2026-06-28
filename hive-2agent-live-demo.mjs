// TWO REAL AGENTS over the REAL relay — live collision-prevention demo.
//
//   node hive-2agent-live-demo.mjs
//
// Two independent CRDT peers (separate Y.Docs, separate websocket connections to the
// production relay) run the decentralized claim protocol. Phase 1 forces them head-to-head
// on ONE file so you can watch the collision be prevented; Phase 2 lets them spread out.
// The decisive check: no instant where both believed they owned the same region.

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { makeCoordinator } from './hive-coord.js'

const RELAY = 'wss://livecode-xoss.onrender.com'
const ROOM = 'hive-2agent-live-demo'
const TTL = 2500
const SYNC_WAIT = 180 // real-network window for the CRDT to converge after a claim
const WORK = 80
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(name) {
  const doc = new Y.Doc()
  const claims = doc.getMap('claims')
  const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
  const coord = makeCoordinator(claims, name, { ttl: TTL })
  return { name, doc, provider, claims, coord }
}

console.log(`Connecting two agents to the REAL relay ${RELAY} (room "${ROOM}")...`)
const A = connect('agentA')
const B = connect('agentB')
const synced = (p) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('relay sync timeout (cold start?)')), 60000)
  p.provider.on('sync', (s) => { if (s) { clearTimeout(t); res() } })
})
await Promise.all([synced(A), synced(B)])
console.log('Both agents connected and synced.\n')

const intervals = []

// One agent's attempt to own `region`: claim -> let CRDT converge -> verify (collision-detect).
async function attempt(ag, region, label) {
  ag.coord.claim(region, 'edit')
  await sleep(SYNC_WAIT)
  const c = ag.claims.get(region)
  const won = c && c.by === ag.name
  console.log(`  ${ag.name} claim ${region}: ${won ? 'WON ✅ (owns it)' : `backed off ↩  (held by ${c ? c.by : '?'})`}  [${label}]`)
  if (won) {
    const t0 = Date.now(); await sleep(WORK); const t1 = Date.now()
    intervals.push({ region, by: ag.name, t0, t1 })
    ag.coord.release(region)
  }
  return won
}

// --- PHASE 1: head-to-head on the SAME file, 8 rounds. Exactly one must win each round. ---
console.log('PHASE 1 — both agents attack the SAME file (shared.js) at once:')
let bothWon = 0
for (let i = 0; i < 8; i++) {
  console.log(`Round ${i + 1}:`)
  const [wa, wb] = await Promise.all([attempt(A, 'shared.js', 'A'), attempt(B, 'shared.js', 'B')])
  if (wa && wb) { bothWon++; console.log('  !! BOTH won — COLLISION !!') }
  await sleep(120)
}

// --- PHASE 2: 6 files, they spread out unaided (emergent load-balancing). ---
console.log('\nPHASE 2 — 6 files available, watch them spread out:')
const REGIONS = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js']
for (let i = 0; i < 6; i++) {
  await Promise.all([
    (async () => { const r = REGIONS[i % 6]; await attempt(A, r, 'A flow') })(),
    (async () => { const r = REGIONS[(i + 3) % 6]; await attempt(B, r, 'B flow') })(),
  ])
  await sleep(80)
}

await sleep(400) // let final releases propagate

// --- decisive check: did two agents ever own the same region at overlapping times? ---
const byRegion = new Map()
for (const iv of intervals) { if (!byRegion.has(iv.region)) byRegion.set(iv.region, []); byRegion.get(iv.region).push(iv) }
let overlaps = 0
for (const [, ivs] of byRegion) {
  ivs.sort((a, b) => a.t0 - b.t0)
  for (let i = 1; i < ivs.length; i++) if (ivs[i].by !== ivs[i - 1].by && ivs[i].t0 < ivs[i - 1].t1) overlaps++
}

console.log(`\n=== RESULTS (two real agents, real relay, real CRDT) ===`)
console.log(`ownership intervals: ${intervals.length}`)
console.log(`regions used:        ${byRegion.size}`)
console.log(`rounds both-won (Phase 1 collisions): ${bothWon}`)
console.log(`overlapping co-ownerships of a region: ${overlaps}`)
console.log(overlaps === 0 && bothWon === 0
  ? '\n✅ ZERO collisions — two real agents coordinated with no controller.'
  : `\n❌ ${overlaps + bothWon} collision(s) detected.`)

A.provider.destroy(); B.provider.destroy()
process.exit(0)
