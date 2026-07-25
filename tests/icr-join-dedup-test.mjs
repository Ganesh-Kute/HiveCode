// Proves the JOIN-DEDUP fix: a client that joins a room while its LOCAL folder already
// holds a DIFFERENT copy of a file must ADOPT the room's copy (not union the two into
// duplicated content), and must keep its local copy as a restore point.
//
//   node icr-join-dedup-test.mjs
//
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { startSync } from './sync.js'

const PORT = 1251
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'join-dedup-test'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = path.join(os.tmpdir(), 'hive-join-dedup-' + Date.now().toString(36))
const fA = path.join(tmp, 'A'), fB = path.join(tmp, 'B')
fs.mkdirSync(fA, { recursive: true }); fs.mkdirSync(fB, { recursive: true })

const CANON = `function add(a, b) {\n  return a + b\n}\n\nmodule.exports = { add }\n`
const STALE = `function add(a, b) {\n  return a - b  // STALE LOCAL VERSION\n}\n\nfunction extraLocalThing() {\n  return 'B only'\n}\n\nmodule.exports = { add, extraLocalThing }\n`
fs.writeFileSync(path.join(fA, 'shared.js'), CANON)
fs.writeFileSync(path.join(fB, 'shared.js'), STALE) // B's pre-existing, divergent local copy

// --- relay ---
const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d.toString()) && res()))

// --- A publishes the canonical copy to the room ---
const A = startSync({ relay: RELAY, room: ROOM, dir: fA, name: 'A', kind: 'ai', log: () => {} })
await new Promise((res) => A.provider.on('sync', (s) => s && res()))
await sleep(900)

// --- B joins with a DIFFERENT local copy of shared.js ---
const B = startSync({ relay: RELAY, room: ROOM, dir: fB, name: 'B', kind: 'ai', log: () => {} })
await new Promise((res) => B.provider.on('sync', (s) => s && res()))
await sleep(1400) // let B reconcile

const bDisk = fs.readFileSync(path.join(fB, 'shared.js'), 'utf8')
const aDisk = fs.readFileSync(path.join(fA, 'shared.js'), 'utf8')

let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

console.log(`B's shared.js after join (${bDisk.length} bytes):\n--- \n${bDisk}---\n`)

assert('B adopted the room copy (equals A canonical)', bDisk === CANON)
assert('NO union: stale "a - b" line is gone', !bDisk.includes('a - b'))
assert('NO union: B-only function is gone', !bDisk.includes('extraLocalThing'))
assert('NO duplication: exactly one module.exports', bDisk.split('module.exports').length === 2)
assert('B size is sane (not multiplied)', bDisk.length <= CANON.length + 8)
assert('A copy untouched', aDisk === CANON)

const hist = B.listHistory({ file: 'shared.js' })
const kept = hist.some((h) => h.label && /local copy at join/.test(h.label))
assert('B preserved its local copy as a restore point', kept)

console.log(`\n=== ${failed === 0 ? 'JOIN-DEDUP FIX WORKS — room copy adopted, no union, local saved' : failed + ' CHECK(S) FAILED'} ===`)
A.stop(); B.stop(); relay.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
process.exit(failed === 0 ? 0 : 1)
