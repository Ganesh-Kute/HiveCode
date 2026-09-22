// BOUNDED WORKING SET (HIV-18) — one client must not be able to exhaust the relay.
//
// Hivecode opens one WebSocket per FILE. A relay allows 512 connections in total by default
// and a normal project has more files than that, so before this a single client tried to
// open a socket for every file in the room at once. Measured 18 Sep 2026: 889 files, 38,011
// Q430 refusals in one evening, three agents locked out of their own room — and because a
// file-doc that never syncs reads as EMPTY, 186 files per folder were written to 0 bytes.
//
// Two things had to change, and only one of them is LRU:
//   - the INITIAL SWEEP is capped. This is where the budget actually blows, and eviction
//     cannot help there: during a burst every file was touched a second ago, so nothing is
//     eligible to evict. The only thing that works is to not open them all.
//   - the steady state evicts least-recently-used docs above the cap.
//
// THE TRADE IS ASSERTED HERE, NOT HIDDEN. A file outside the working set does not arrive
// until something touches it. That is a real behaviour change. It is strictly better than
// what it replaces, which was not receiving those files EITHER and additionally believing
// they were empty — but a test that quietly skipped it would be hiding the cost.
//
//   node tests/open-file-cap-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

// pid-derived: this suite may run as a room gate alongside another agent's.
const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-opencap-'))
const wsUrl = `ws://localhost:${PORT}`
const room = 'cap-' + crypto.randomBytes(6).toString('hex')
const conns = async () => (await (await fetch(`http://localhost:${PORT}/health`)).json()).connections
const N = 30
const body = (i) => `export const n${i} = ${i}\n`

// ── the publisher: 30 files, generous cap ──────────────────────────────────────────────
const dA = path.join(tmp, 'a'); fs.mkdirSync(dA, { recursive: true })
for (let i = 0; i < N; i++) fs.writeFileSync(path.join(dA, `f${String(i).padStart(2, '0')}.js`), body(i))
delete process.env.HIVE_MAX_OPEN_FILES
const A = startSync({ relay: wsUrl, room, dir: dA, name: 'A', kind: 'ai', log: () => {} })
await sleep(12000)

const stA = A.status()
console.log(`\n  publisher: files=${stA.files} synced=${stA.filesSynced} cap=${stA.openCap}`)
T('setup: the publisher put all 30 files in the room', stA.filesSynced >= N)
T('A1 the default cap is generous enough that an ordinary project is untouched', stA.openCap >= N)

// ── a joiner with a SMALL cap ──────────────────────────────────────────────────────────
process.env.HIVE_MAX_OPEN_FILES = '8'
process.env.HIVE_EVICT_GRACE_MS = '1000'
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB, { recursive: true })
const before = await conns()
const logsB = []
const B = startSync({ relay: wsUrl, room, dir: dB, name: 'B', kind: 'ai', log: (m) => logsB.push(String(m)) })
await sleep(12000)
const cost = (await conns()) - before
const stB = B.status()

console.log(`  capped joiner: cost ${cost} connections, holds ${stB.files} file docs (cap ${stB.openCap})\n`)

T('B1 the cap is respected — it does not open a socket per file', stB.files <= 8)
T('B2 so joining costs far fewer connections than there are files', cost < N)
T('B3 and the cap is what did it, not an accident', stB.openCap === 8)
T('B4 the client SAYS the working set is bounded, so an operator can see it',
  logsB.some((l) => /holding 8 open|HIVE_MAX_OPEN_FILES/.test(l)))

// ── the files it DID take must be correct — a bounded set is useless if it is wrong ────
const arrived = fs.readdirSync(dB).filter((f) => /^f\d\d\.js$/.test(f))
const allCorrect = arrived.every((f) => {
  const i = Number(f.slice(1, 3))
  return fs.readFileSync(path.join(dB, f), 'utf8') === body(i)
})
T('C1 every file inside the working set has exactly the right bytes', arrived.length > 0 && allCorrect)
T('C2 none of them was written as an empty file', arrived.every((f) => fs.statSync(path.join(dB, f)).size > 0))

// ── THE TRADE, asserted rather than hidden ─────────────────────────────────────────────
T('C3 files outside the working set did NOT arrive — this is the documented cost', arrived.length <= 8)

// ── and with a generous cap the same joiner gets everything, proving the cap is the cause ─
delete process.env.HIVE_MAX_OPEN_FILES
delete process.env.HIVE_EVICT_GRACE_MS
const dC = path.join(tmp, 'c'); fs.mkdirSync(dC, { recursive: true })
const C = startSync({ relay: wsUrl, room, dir: dC, name: 'C', kind: 'ai', log: () => {} })
await sleep(14000)
const arrivedC = fs.readdirSync(dC).filter((f) => /^f\d\d\.js$/.test(f))
T('D1 an uncapped joiner still receives every file (no regression)', arrivedC.length === N)
T('D2 with the right content', arrivedC.every((f) => fs.readFileSync(path.join(dC, f), 'utf8') === body(Number(f.slice(1, 3)))))

try { A.stop() } catch { }
try { B.stop() } catch { }
try { C.stop() } catch { }
relay.kill()
console.log(`\n=== OPEN-FILE CAP: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
