// OVERLAPPING EDITS NEVER LOSE WORK SILENTLY, and the clean handover that still conflicts.
//
// OPEN (1 Nov 2026): K2 below records that a clean handover onto the same line still shows
// conflict markers. Four rounds of fixes that decided it from the texts each silently deleted work
// in a case antigravity-3 then built, because "B replaced A's change" and "B wrote from an older
// copy" can be the same four texts. Until the agent declares the version it edited, the markers
// stay; this test holds the floor: nobody's change disappears without a marker.
//
// (original header follows)
// A CLEAN HANDOVER MUST NOT CONFLICT.
//
//   node tests/handover-conflict-test.mjs
//
// MEASURED 30 Oct 2026 (stage.mjs, 3/3, and again 1 Nov inside held-rejoin-test): A claims a
// file, changes a line, releases. B has A's version on disk, claims, and changes THAT line.
// Conflict markers land in both folders and the room posts MERGE CONFLICT, for a sequence where
// nobody edited at the same time.
//
// Why: a local write merges against the author's FORK POINT (forkBases), which advances only on
// local authorship. A's change reached B's disk but not B's fork, so B replacing it read as B
// working from a stale copy.
//
//   K1  (control) B really had A's edit on disk before it claimed
//   K2  OPEN: markers still appear; nothing is lost: both A's and B's line are in both folders
//   S1  CONTROL: a genuinely stale write is still caught. B edits a line WITHOUT having A's
//       newer change in mind (B's write drops A's line) -> A's line is not silently deleted.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = 1339
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

process.env.HIVE_PROVENANCE = 'on'
// HANDOVER_GATE=off runs it as the extension and folder.js do: no capture (antigravity-3, 1 Nov).
process.env.HIVE_FORK_GATE = process.env.HANDOVER_GATE || 'on'
console.log(`(fork gate ${process.env.HIVE_FORK_GATE})`)

const relay = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HIVE_ENFORCE_CLAIMS: 'queue', HIVE_PERSIST_DIR: '' },
})
relay.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('relay did not start')), 20000)
  relay.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); res() } })
})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-handover-'))
const room = 'handover-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`
const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const fA = path.join(dA, 'checkout.js'), fB = path.join(dB, 'checkout.js')
const join = (dir, name) => startSync({ relay: wsUrl, room, dir, name, kind: 'ai', log: () => {} })
const markers = (s) => (s || '').includes('<<<<<<<')

const V1 = 'export function total(subtotal) {\n  return subtotal\n}\n'
const A_V = 'export function total(subtotal) {\n  return subtotal * 1.18 // A: tax\n}\n'
const B_V = 'export function total(subtotal) {\n  return Math.round(subtotal * 1.18) // B: round\n}\n'
let A, B
try {
  A = join(dA, 'A'); B = join(dB, 'B')
  await sleep(2500)
  A.claim('checkout.js', 'seed'); fs.writeFileSync(fA, V1); await sleep(3000); A.release('checkout.js')
  await sleep(1500)

  console.log('\n# A edits the line and hands over')
  A.claim('checkout.js', 'adding tax'); fs.writeFileSync(fA, A_V); await sleep(3000); A.release('checkout.js')
  await sleep(2000)
  T('K1 (control) B has A\'s edit on disk before claiming', read(fB) === A_V, JSON.stringify(read(fB)))

  console.log('\n# B claims and changes the same line')
  const got = B.claim('checkout.js', 'rounding')
  fs.writeFileSync(fB, B_V)
  await sleep(4000)
  T('(setup) B got the claim', got === true)
  // OPEN: K3 (no markers, B's line only) is the goal and is not met; see the header.
  T('K2 nothing is lost: A\'s and B\'s line are both in both folders', [read(fA), read(fB)].every((t) => (t || '').includes('A: tax') && (t || '').includes('B: round')), JSON.stringify(read(fA)))
  B.release('checkout.js'); await sleep(1500)

  console.log('\n# CONTROL: a stale write is still caught')
  // B writes from a copy it took BEFORE A's next change, with no claim (so nothing reset its
  // fork). A's change must survive: re-added (disjoint) or a conflict, never silently dropped.
  const staleB = read(fB)
  A.claim('checkout.js', 'add a helper'); fs.writeFileSync(fA, read(fA) + 'export const VAT = 0.18 // A: helper\n'); await sleep(3000); A.release('checkout.js')
  await sleep(2000)
  fs.writeFileSync(fB, staleB.replace('// B: round', '// B: round, again'))
  await sleep(4000)
  T('S1 the stale write did not silently delete A\'s helper', (read(fA) || '').includes('A: helper') && (read(fB) || '').includes('A: helper'), JSON.stringify(read(fA)))

  console.log('\n# CONTROL 2: a stale write WITH a claim (antigravity-3, 1 Nov)')
  // B read the file, A then added a function and released, B claims and writes from its old copy.
  // The claim must not license deleting A's function.
  const aA = path.join(dA, 'api.js'), aB = path.join(dB, 'api.js')
  const P1 = 'export function foo() {\n  return 1\n}\n'
  A.claim('api.js', 'seed'); fs.writeFileSync(aA, P1); await sleep(3000); A.release('api.js')
  await sleep(2000)
  const staleRead = read(aB) // what B's agent read
  A.claim('api.js', 'add bar'); fs.writeFileSync(aA, P1 + '\nexport function bar() {\n  return 2 // A: bar\n}\n'); await sleep(3000); A.release('api.js')
  await sleep(2000)
  T('(control setup) B has A\'s bar on disk before claiming', (read(aB) || '').includes('A: bar'))
  B.claim('api.js', 'change foo')
  fs.writeFileSync(aB, staleRead.replace('return 1', 'return 11 // B: foo'))
  await sleep(4000)
  T('S2 the claimed stale write kept A\'s bar, in both folders', (read(aA) || '').includes('A: bar') && (read(aB) || '').includes('A: bar'), JSON.stringify(read(aB)))
  T('S3 ...and B\'s change landed too, without markers', (read(aA) || '').includes('B: foo') && !markers(read(aA)) && !markers(read(aB)), JSON.stringify(read(aA)))
  B.release('api.js')
  await sleep(1500)

  console.log('\n# CONTROL 3: an overlap AND a separate addition in one change (antigravity-3, 1 Nov)')
  // B's write overlaps A's change to total() and also lacks A's new refund(). B takes the overlap;
  // refund() must survive, because nothing B did touched it.
  const cA = path.join(dA, 'calc.js'), cB = path.join(dB, 'calc.js')
  const C1 = 'export function total(subtotal) {\n  return subtotal\n}\n'
  A.claim('calc.js', 'seed'); fs.writeFileSync(cA, C1); await sleep(3000); A.release('calc.js')
  await sleep(2000)
  const staleC = read(cB)
  A.claim('calc.js', 'tax and refund')
  fs.writeFileSync(cA, C1.replace('return subtotal', 'return subtotal * 1.18 // A: tax') + '\nexport function refund(amount) {\n  return -amount // A: refund\n}\n')
  await sleep(3000); A.release('calc.js')
  await sleep(2000)
  B.claim('calc.js', 'fee')
  fs.writeFileSync(cB, staleC.replace('return subtotal', 'return subtotal + 5 // B: fee'))
  await sleep(4000)
  const both = (s) => (read(cA) || '').includes(s) && (read(cB) || '').includes(s)
  // In a file this small diff3 puts the overlap and refund() in ONE block, so there is no safe way to
  // give B the overlap without dropping refund(): the markers stay, which loses nothing.
  T('S4 A\'s separate refund() survived in both folders', both('A: refund'), JSON.stringify(read(cA)))
  T('S5 ...and B\'s change is there too: nothing anyone wrote was dropped', both('B: fee'), JSON.stringify(read(cB)))
  B.release('calc.js')
  await sleep(1500)

  // antigravity-3, round 3: the line-count rule passed a stale write that was LONG enough, and a
  // guard whose lines already existed elsewhere in the file counted as nothing new. Both deleted
  // A's work without markers. Stale writes carry nothing only A's version had.
  const stale = async (file, F, AV, edit, keep, label) => {
    const fA2 = path.join(dA, file), fB2 = path.join(dB, file)
    A.claim(file, 'seed'); fs.writeFileSync(fA2, F); await sleep(3000); A.release(file)
    await sleep(2000)
    const old = read(fB2)
    A.claim(file, 'change'); fs.writeFileSync(fA2, AV); await sleep(3000); A.release(file)
    await sleep(2000)
    B.claim(file, 'stale edit'); fs.writeFileSync(fB2, edit(old)); await sleep(4000)
    T(label, [read(fA2), read(fB2)].every((t) => (t || '').includes(keep)), JSON.stringify(read(fB2)))
    B.release(file); await sleep(1500)
  }
  const AUTH = 'export function parseToken(tok) {\n  if (!tok) {\n    return null\n  }\n  return tok.split(".")\n}\n\nexport function charge(tok, amt) {\n  return amt\n}\n'
  await stale('auth.js', AUTH,
    AUTH.replace('export function charge(tok, amt) {\n  return amt\n}', 'export function charge(tok, amt) {\n  if (!tok) {\n    return null\n  }\n  return amt * 1.18 // A: tax\n}'),
    (old) => old.replace('  return amt\n', '  return amt + 5 // B: fee\n'),
    'A: tax', 'S6 a stale write never deletes A\'s change silently, even when A\'s lines exist elsewhere in the file')
  const C2 = 'export function total(subtotal) {\n  return subtotal\n}\n'
  await stale('calc2.js', C2,
    C2.replace('return subtotal', 'return subtotal * 1.18 // A: tax') + '\nexport function refund(amount) {\n  return -amount // A: refund\n}\n',
    (old) => old.replace('  return subtotal\n', '  if (subtotal <= 0) return 0\n  const fee = 5\n  return subtotal + fee // B: fee\n'),
    'A: refund', 'S7 ...nor when the stale write is longer than A\'s change')
} catch (e) {
  console.log('  FAIL (threw) ' + (e && e.stack || e)); fail++
} finally {
  for (const c of [A, B]) { try { c && c.stop() } catch { } }
  relay.kill()
  console.log(`\n=== OVERLAPS NEVER LOSE WORK SILENTLY (clean-handover markers: OPEN): ${pass} passed, ${fail} failed ===`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
