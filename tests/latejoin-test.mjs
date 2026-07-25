// LATE-JOINER provenance test — the exact Hermes flow the swarm exposed:
// client A seeds a file; client B joins AFTERWARDS (pulls it), then patches one line.
// B's patch MUST produce a verified ledger receipt. (All prior suites had every client
// present from genesis, which masked this path.)
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from './sync.js'
import { verifyReceipt } from './substrate.js'

const PORT = 1321
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = () => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_PROVENANCE: 'strict' } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }

process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'
const relay = await startRelay()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-late-'))
const room = 'late-' + crypto.randomBytes(6).toString('hex')
const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)

// A seeds
const A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dA, name: 'A', kind: 'ai', log: () => {} })
await sleep(3000)
A.claim('m.js', 'seed'); fs.writeFileSync(path.join(dA, 'm.js'), 'function foo() { return 10 }\n\nfunction bar() { return 20 }\n'); await sleep(3500); A.release('m.js')

// B joins LATE, pulls, then patches ONE line (the Hermes flow)
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
const B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
await sleep(4000)
T('B pulled the file', fs.existsSync(path.join(dB, 'm.js')))
B.claim('m.js', 'patch bar')
fs.writeFileSync(path.join(dB, 'm.js'), fs.readFileSync(path.join(dB, 'm.js'), 'utf8').replace('return 20', 'return 22'))
await sleep(5000)
B.release('m.js')

const ledger = A.provenanceOf('m.js')
const authors = ledger.filter((r) => verifyReceipt(r).ok).map((r) => r.name)
console.log('  ledger:', ledger.length, 'receipts; verified authors:', JSON.stringify(authors))
T("B's late-join patch produced a VERIFIED receipt", authors.includes('B'))
T('edit converged to A', fs.readFileSync(path.join(dA, 'm.js'), 'utf8').includes('return 22'))

for (const c of [A, B]) { try { c.stop() } catch {} }
relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\n=== LATE-JOIN: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
