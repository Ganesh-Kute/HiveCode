// LIVE proof of the Hive coordination layer over the REAL relay + a REAL Yjs Y.Map.
//
//   node hive-coord-live-test.js
//
// Spins up the actual relay and N separate worker PROCESSES (real concurrency, real
// network, real CRDT last-writer races). Each worker runs the decentralized protocol and
// reports the time intervals it believed it owned each region. The decisive check: NO two
// workers ever owned the same region at the same time. If that holds over real
// infrastructure — with no central controller anywhere — the primitive is real.

import { spawn } from 'child_process'

const PORT = 1247
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'hive-coord-test'
const WORKERS = 4
const REGIONS = 8
const ITERS = 30

let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

// --- relay ---
const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d.toString()) && res()))
console.log(`relay up on :${PORT}\n`)

// --- workers ---
function runWorker(id) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['hive-worker.js', RELAY, ROOM, 'agent' + id, String(REGIONS), String(ITERS)])
    let buf = ''
    p.stdout.on('data', (d) => { buf += d.toString() })
    p.stderr.on('data', (d) => process.stdout.write(`   [agent${id}] ${d}`))
    p.on('exit', () => {
      const m = buf.match(/INTERVALS (.*)/)
      res(m ? JSON.parse(m[1]) : [])
    })
  })
}

console.log(`# ${WORKERS} real worker processes, ${REGIONS} regions, ${ITERS} iters each — over the live relay\n`)
const results = await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker(i)))
const all = results.flat()

// --- the decisive check: did two workers ever own the same region at the same time? ---
const byRegion = new Map()
for (const iv of all) { if (!byRegion.has(iv.region)) byRegion.set(iv.region, []); byRegion.get(iv.region).push(iv) }
let overlaps = 0
for (const [, ivs] of byRegion) {
  ivs.sort((a, b) => a.t0 - b.t0)
  for (let i = 1; i < ivs.length; i++) {
    if (ivs[i].by !== ivs[i - 1].by && ivs[i].t0 < ivs[i - 1].t1) overlaps++ // different owners, times overlap
  }
}

const regionsUsed = byRegion.size
const workersThatWorked = new Set(all.map((iv) => iv.by)).size

console.log(`\n# Results: ${all.length} ownership intervals, ${regionsUsed}/${REGIONS} regions used, ${workersThatWorked}/${WORKERS} workers active`)
console.log(`  overlapping co-ownerships of the same region: ${overlaps}`)

console.log('')
assert('real work happened (workers actually acquired & edited regions)', all.length > WORKERS)
assert('coordination spread work across the codebase', regionsUsed >= Math.min(REGIONS, WORKERS))
assert('all workers got to work (nobody starved out)', workersThatWorked === WORKERS)
assert('ZERO collisions over real relay + real CRDT — no two agents owned a region at once', overlaps === 0)

console.log(`\n=== ${failed === 0 ? 'LIVE HIVE COORDINATION WORKS (real relay, real CRDT, no controller)' : failed + ' FAILED'} ===`)
relay.kill()
process.exit(failed === 0 ? 0 : 1)
