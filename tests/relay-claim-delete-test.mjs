// tests/relay-claim-delete-test.mjs
// Relay-Side Claim Delete Backstop:
// In queue/block mode, the relay observes manifest deletions on the base doc.
// If a client deletes a manifest key for a file held by someone else,
// the relay refuses the deletion, performs a compensating write to restore the
// manifest key, audits the blocked deletion, and announces to the room.
//
// Invariants tested:
//   A. In open auth mode, another client (Alice) directly deleting Bob's held file
//      via manifest.delete is refused and compensated by the relay.
//   B. In open auth mode, the claim holder (Bob) deleting their own held file
//      via manifest.delete is permitted.
//   C. A rogue client deleting a claim and the manifest key in a single transaction
//      is caught (evaluated against pre-transaction claim state) and compensated.
//   D. An expired claim allows deletion of the manifest key.
//   E. When HIVE_ENFORCE_CLAIMS=off, the backstop remains inert and deletions pass.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeoutMs = 8000, stepMs = 150) => {
  const d = Date.now() + timeoutMs
  while (Date.now() < d) {
    try { const res = await fn(); if (res) return res } catch {}
    await sleep(stepMs)
  }
  return false
}

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ` (${extra})` : ''}`); c ? pass++ : fail++ }

const startRelay = (port, env = {}) => new Promise((res, rej) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  p.on('error', rej)
})

const PORT1 = Number(process.env.HIVE_TEST_PORT) || (24000 + (process.pid % 8000))
console.log(`# Starting relay with HIVE_ENFORCE_CLAIMS=queue on port ${PORT1}...`)
const relay1 = await startRelay(PORT1, { HIVE_ENFORCE_CLAIMS: 'queue' })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-relay-claim-'))
const aliceDir = path.join(tmp, 'alice')
const bobDir = path.join(tmp, 'bob')
fs.mkdirSync(aliceDir, { recursive: true })
fs.mkdirSync(bobDir, { recursive: true })

const ROOM = 'claim-backstop-' + crypto.randomBytes(4).toString('hex')
const RELAY1 = `ws://localhost:${PORT1}`

fs.writeFileSync(path.join(bobDir, 'held.js'), 'export const h = 1\n')
fs.writeFileSync(path.join(bobDir, 'own.js'), 'export const o = 1\n')
fs.writeFileSync(path.join(bobDir, 'atomic.js'), 'export const a = 1\n')
fs.writeFileSync(path.join(bobDir, 'expired.js'), 'export const e = 1\n')

const bob = startSync({ relay: RELAY1, room: ROOM, dir: bobDir, name: 'Bob', kind: 'ai', log: () => {} })
const alice = startSync({ relay: RELAY1, room: ROOM, dir: aliceDir, name: 'Alice', kind: 'ai', log: () => {} })

await until(() => alice.doc.getMap('manifest').has('held.js') && alice.doc.getMap('manifest').has('expired.js'), 8000)

console.log('\n# A. Other client directly deletes held file in open mode')
bob.claim('held.js', 'Bob refactoring')
await until(() => {
  const c = alice.doc.getMap('claims').get('held.js')
  return c && c.by === 'Bob'
}, 4000)

// Bob writes a local unpushed edit to held.js
const BOB_EDIT = 'export const h = 1\n// Bob unpushed local work\n'
fs.writeFileSync(path.join(bobDir, 'held.js'), BOB_EDIT)

const chatBeforeA = alice.doc.getArray('chat').length

// Poll Bob's disk every 20ms during the rogue delete & restoration
let bobFileVanished = false
let bobEditLost = false
const poller = setInterval(() => {
  const p = path.join(bobDir, 'held.js')
  if (!fs.existsSync(p)) {
    bobFileVanished = true
  } else {
    try {
      const content = fs.readFileSync(p, 'utf8')
      if (!content.includes('Bob unpushed local work')) {
        bobEditLost = true
      }
    } catch {}
  }
}, 20)

// Alice directly deletes manifest key (bypassing settleLocalDeletes)
alice.doc.getMap('manifest').delete('held.js')

// The relay should catch this and restore held.js
const aRestored = await until(() => alice.doc.getMap('manifest').has('held.js'), 6000)
await sleep(800)
clearInterval(poller)

T('A1 Alice direct manifest.delete of held.js is compensated/restored by relay', aRestored)

const chatAfterA = alice.doc.getArray('chat').toArray().slice(chatBeforeA)
const noticeA = chatAfterA.find((m) => m && m.text && m.text.includes('deleted held.js') && m.text.includes('held by Bob'))
T('A2 Room is told via notice that delete was refused and file is back', !!noticeA, noticeA ? noticeA.text : 'no notice found')

// Check the settlement invariants:
// (a) held.js never vanished on Bob's disk
T('A3 held.js never vanishes on Bob disk during compensating restore', !bobFileVanished)

// (b) no .hive-deleted copy on Bob or Alice
const bobHasDeletedCopy = fs.existsSync(path.join(bobDir, '.hive-deleted'))
const aliceHasDeletedCopy = fs.existsSync(path.join(aliceDir, '.hive-deleted'))
T('A4 no .hive-deleted copy created on Bob disk', !bobHasDeletedCopy)
T('A5 no .hive-deleted copy created on Alice disk', !aliceHasDeletedCopy)

// (c) Bob's unpushed edit is still in the working file
const bobCurrentContent = fs.readFileSync(path.join(bobDir, 'held.js'), 'utf8')
T('A6 Bob unpushed edit is still intact in the working file', bobCurrentContent === BOB_EDIT && !bobEditLost)

console.log('\n# B. Holder deletes their own held file in open mode')
bob.claim('own.js', 'Bob working on own')
await until(() => {
  const c = alice.doc.getMap('claims').get('own.js')
  return c && c.by === 'Bob'
}, 4000)

// Bob directly deletes own file
bob.doc.getMap('manifest').delete('own.js')
await sleep(1500)
const bGone = !bob.doc.getMap('manifest').has('own.js') && !alice.doc.getMap('manifest').has('own.js')
T('B1 Bob (holder) deleting own.js is permitted by relay', bGone)

console.log('\n# C. Claim + delete in single transaction')
bob.claim('atomic.js', 'Bob atomic')
await until(() => {
  const c = alice.doc.getMap('claims').get('atomic.js')
  return c && c.by === 'Bob'
}, 4000)

// Alice clears Bob's claim AND deletes manifest in a single transaction
alice.doc.transact(() => {
  alice.doc.getMap('claims').delete('atomic.js')
  alice.doc.getMap('manifest').delete('atomic.js')
})

// Relay must judge against pre-transaction claim state and restore atomic.js
const cRestored = await until(() => alice.doc.getMap('manifest').has('atomic.js'), 6000)
T('C1 Atomic claim-clear + delete-manifest is caught and restored', cRestored)

console.log('\n# D. Expired claim allows delete')
// Put an already-expired claim on expired.js directly
bob.doc.getMap('claims').set('expired.js', { by: 'Bob', at: Date.now() - 100000, ttl: 1000 })
await sleep(500)
alice.doc.getMap('manifest').delete('expired.js')
await sleep(1500)
const dGone = !alice.doc.getMap('manifest').has('expired.js')
T('D1 Deleting file with expired claim is permitted', dGone)

// Clean up first relay test
try { alice.stop() } catch {}
try { bob.stop() } catch {}
try { relay1.kill() } catch {}

console.log('\n# E. Relay with HIVE_ENFORCE_CLAIMS=off stays inert')
const PORT2 = PORT1 + 1
const relay2 = await startRelay(PORT2, { HIVE_ENFORCE_CLAIMS: 'off' })
const ROOM2 = 'claim-backstop-off-' + crypto.randomBytes(4).toString('hex')
const RELAY2 = `ws://localhost:${PORT2}`

const aliceDir2 = path.join(tmp, 'alice2')
const bobDir2 = path.join(tmp, 'bob2')
fs.mkdirSync(aliceDir2, { recursive: true })
fs.mkdirSync(bobDir2, { recursive: true })
fs.writeFileSync(path.join(bobDir2, 'unprotected.js'), 'export const u = 1\n')

const bob2 = startSync({ relay: RELAY2, room: ROOM2, dir: bobDir2, name: 'Bob', kind: 'ai', log: () => {} })
const alice2 = startSync({ relay: RELAY2, room: ROOM2, dir: aliceDir2, name: 'Alice', kind: 'ai', log: () => {} })

await until(() => alice2.doc.getMap('manifest').has('unprotected.js'), 8000)
bob2.claim('unprotected.js', 'Bob refactoring')
await until(() => {
  const c = alice2.doc.getMap('claims').get('unprotected.js')
  return c && c.by === 'Bob'
}, 4000)

// Alice deletes unprotected.js
alice2.doc.getMap('manifest').delete('unprotected.js')
await sleep(1500)
const eGone = !alice2.doc.getMap('manifest').has('unprotected.js')
T('E1 In enforce=off mode, deletion is NOT restored (stays inert)', eGone)

try { alice2.stop() } catch {}
try { bob2.stop() } catch {}
try { relay2.kill() } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`)
process.exit(fail > 0 ? 1 : 0)
