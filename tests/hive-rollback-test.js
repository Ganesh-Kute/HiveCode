// Proves ROLLBACK end-to-end against the live engine:
//   - every edit captures a RESTORE POINT (content lives in the file's own doc;
//     metadata in the shared timeline) attributed to its author
//   - restore() returns a file to a saved point, propagates to everyone, and is
//     itself reversible (the pre-restore state is snapshotted first)
//   - restoreFileTo(ts) rolls a file back to a moment in time
//   - revertAuthor() rolls back everything one author did (the "undo that agent")
//   - undoLast() undoes a client's own last edit (Level-0)
//
//   node hive-rollback-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startSync } from './sync.js'

const PORT = 1249
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'rollback-test'
const A = '.rbtmp/a', B = '.rbtmp/b'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

try { fs.rmSync('.rbtmp', { recursive: true, force: true }) } catch {}
fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true })
const writeA = (rel, s) => fs.writeFileSync(path.join(A, rel), s)
const readA = (rel) => { try { return fs.readFileSync(path.join(A, rel), 'utf8') } catch { return null } }
const readB = (rel) => { try { return fs.readFileSync(path.join(B, rel), 'utf8') } catch { return null } }

// fully-different multi-line versions => each edit is a "rewrite" (force-captured,
// bypassing the auto-throttle) so the test is deterministic.
const ver = (tag) => Array.from({ length: 5 }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n'

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const opts = { relay: RELAY, room: ROOM, log: () => {} }
const a = startSync({ ...opts, dir: A, name: 'Ann', kind: 'human' })
const b = startSync({ ...opts, dir: B, name: 'Bob', kind: 'ai' })
await sleep(1500)

console.log('# Ann creates app.js, then edits it twice (each a rewrite)')
writeA('app.js', ver('V1')); await sleep(1300)
writeA('app.js', ver('V2')); await sleep(1300)
writeA('app.js', ver('V3')); await sleep(1300)
const hist = a.listHistory({ file: 'app.js' })
assert('restore points were captured for app.js', hist.length >= 2)
assert('there is a baseline (creation) point', hist.some((e) => e.kind === 'base'))
assert('points are attributed to Ann', hist.every((e) => e.by === 'Ann'))
assert('Bob also sees the timeline (shared metadata)', b.listHistory({ file: 'app.js' }).length === hist.length)

console.log('\n# Restore app.js to its baseline (V1) — and it propagates to Bob')
const baseId = hist.find((e) => e.kind === 'base').id
const r1 = a.restore(baseId)
await sleep(1300)
assert('restore reported ok', r1.ok === true)
assert("Ann's app.js is back to V1", readA('app.js') === ver('V1'))
assert("Bob's copy followed the restore", readB('app.js') === ver('V1'))

console.log('\n# Restore is reversible — the pre-restore state (V3) was snapshotted')
const afterRestore = a.listHistory({ file: 'app.js' })
const restorePt = afterRestore.find((e) => e.kind === 'restore')
assert('a reversible restore-point exists', !!restorePt)
a.restore(restorePt.id); await sleep(1300)
assert('app.js rolled forward again to V3', readA('app.js') === ver('V3'))

console.log('\n# restoreFileTo(ts): roll cfg.js back to a moment in time')
writeA('cfg.js', ver('C1')); await sleep(1300)
const tMid = Date.now()
await sleep(50)
writeA('cfg.js', ver('C2')); await sleep(1300)
writeA('cfg.js', ver('C3')); await sleep(1300)
const rT = a.restoreFileTo('cfg.js', tMid)
await sleep(1300)
assert('restoreFileTo reported ok', rT.ok === true)
assert('cfg.js is back to its state at tMid (C1)', readA('cfg.js') === ver('C1'))

console.log('\n# revertAuthor: undo everything Bob did to svc.js')
fs.writeFileSync(path.join(B, 'svc.js'), ver('S1')); await sleep(1300)
fs.writeFileSync(path.join(B, 'svc.js'), ver('S2')); await sleep(1300)
fs.writeFileSync(path.join(B, 'svc.js'), ver('S3')); await sleep(1300)
assert('Ann received Bob\'s svc.js (S3)', readA('svc.js') === ver('S3'))
const rev = a.revertAuthor('Bob')
await sleep(1300)
assert('revertAuthor reported success', rev.ok === true && rev.reverted >= 1)
assert('svc.js rolled back to before Bob touched it (S1 baseline)', readA('svc.js') === ver('S1'))
assert('the revert propagated to Bob too', readB('svc.js') === ver('S1'))

console.log('\n# undoLast: Ann undoes her own last edit')
writeA('u.js', ver('U1')); await sleep(1300)
writeA('u.js', ver('U2')); await sleep(1300)
const u = a.undoLast()
await sleep(800)
assert('undoLast reported ok', u.ok === true)
assert('u.js reverted to U1', readA('u.js') === ver('U1'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
a.stop(); b.stop(); relay.kill()
try { fs.rmSync('.rbtmp', { recursive: true, force: true }) } catch {}
process.exit(failed === 0 ? 0 : 1)
