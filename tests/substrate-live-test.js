// LIVE proof that the convergent substrate's provenance (I1) works end-to-end in the
// REAL product path: two startSync() clients, over the REAL relay, with
// HIVE_PROVENANCE on, editing one shared file. Afterward every landed state carries a
// signed, verifiable receipt attributed to the author who produced it — and a forged
// receipt is caught.
//
//   node substrate-live-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startSync } from './sync.js'
import { verifyReceipt } from './substrate.js'

const PORT = 1273
const ROOM = 'subproj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

function startRelay() {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-sub-'))
const dirA = path.join(tmp, 'a'), dirB = path.join(tmp, 'b')
fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })

process.env.HIVE_PROVENANCE = 'on' // both in-process clients pick this up at startSync()
const relay = await startRelay()
console.log(`relay up on :${PORT}; provenance ON\n`)

const A = startSync({ relay: `ws://localhost:${PORT}`, room: ROOM, dir: dirA, name: 'Alice', kind: 'ai', log: () => {} })
const B = startSync({ relay: `ws://localhost:${PORT}`, room: ROOM, dir: dirB, name: 'Bob', kind: 'ai', log: () => {} })
await sleep(1500)

console.log('# Alice creates app.js (genesis) and claims it')
A.claim('app.js', 'scaffold')
fs.writeFileSync(path.join(dirA, 'app.js'), 'function login(u) {\n  return u\n}\n\nfunction logout() {\n  return true\n}\n')
await sleep(2500) // create -> publish -> B pulls

assert('Bob received app.js from the room', fs.existsSync(path.join(dirB, 'app.js')))

console.log('\n# Alice edits login(), Bob edits logout() (disjoint -> clean ICR merge)')
A.claim('app.js', 'harden login')
fs.writeFileSync(path.join(dirA, 'app.js'), 'function login(u) {\n  return u && u.length > 0\n}\n\nfunction logout() {\n  return true\n}\n')
await sleep(2000)
B.claim('app.js', 'audit logout')
const bNow = fs.readFileSync(path.join(dirB, 'app.js'), 'utf8')
fs.writeFileSync(path.join(dirB, 'app.js'), bNow.replace('return true', 'return { ok: true }'))
await sleep(3000) // let both edits merge + provenance sync both ways

console.log('\n# Audit the shared provenance ledger for app.js')
const auditA = A.verifyProvenanceOf('app.js')
const auditB = B.verifyProvenanceOf('app.js')
console.log('    Alice sees:', JSON.stringify(auditA))
console.log('    Bob sees:  ', JSON.stringify(auditB))

assert('ledger has receipts', auditA.count > 0)
assert('every receipt on Alice’s view verifies', auditA.ok && auditA.verified === auditA.count)
assert('every receipt on Bob’s view verifies', auditB.ok && auditB.verified === auditB.count)

const idA = A.identity(), idB = B.identity()
assert('Alice and Bob have distinct verified identities', idA && idB && idA.id !== idB.id)
assert('changes are attributed to BOTH authors', auditA.authors.includes(idA.id) && auditA.authors.includes(idB.id))

console.log('\n# A forged receipt (tampered intent) is rejected by the auditor')
const receipts = A.provenanceOf('app.js')
const forged = { ...receipts[0], intent: 'rewritten-after-the-fact' }
assert('honest receipt verifies', verifyReceipt(receipts[0]).ok)
assert('forged receipt is caught', verifyReceipt(forged).ok === false)

try { A.stop(); B.stop() } catch {}
relay.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n=== ${failed === 0 ? 'SUBSTRATE PROVENANCE WORKS LIVE (signed, verified, attributed, forgery-proof — over the real relay)' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
