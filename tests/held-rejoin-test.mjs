// A HELD EDIT MUST SURVIVE ITS WRITER RECONNECTING.
//
//   node tests/held-rejoin-test.mjs
//
// MEASURED 26 Oct 2026 (antigravity-2): on a relay with HIVE_ENFORCE_CLAIMS=queue, the hosted
// relay's mode, A writes a file B is holding. The relay holds the write. A's connection drops,
// and the relay discards the hold. A rejoins with the same folder, and the rejoin writes the
// room's OLD copy over A's file. The edit is gone from the room AND from A's disk, and nothing
// says so.
//
// Why: capturing a local edit advances the file's ancestor (.hive-shadow.json) to the edited
// bytes before the relay has accepted them. On rejoin, disk === ancestor reads as "untouched
// locally", so the room's copy is adopted over it.
//
//   H1  (control) the write really was held: B never received it
//   H2  after A rejoins, A's edit is still on A's disk
//   H3  ...and still there after several sync passes (not just until the next scan)
//   H4  A is told, in the room, that its edit never reached the room
//   H5  B's copy is untouched: the claim B holds still means something
//   C1  CONTROL: an edit that DID reach the room, then the room moved on, and A rejoins with
//       an untouched copy -> A takes the room's newer copy. Without this, "never adopt" passes.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = 1337
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// As agents run it: hive-mcp.js turns both on by default.
process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'

const relay = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HIVE_ENFORCE_CLAIMS: 'queue', HIVE_PERSIST_DIR: '' },
})
relay.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('relay did not start')), 20000)
  relay.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); res() } })
})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-heldrejoin-'))
const room = 'heldrejoin-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`
const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const fA = path.join(dA, 'f.js'), fB = path.join(dB, 'f.js')
const join = (dir, name) => startSync({ relay: wsUrl, room, dir, name, kind: 'ai', log: () => {} })
const chatOf = (c) => c.doc.getArray('chat').toArray().map((m) => `${m && m.by}: ${m && m.text}`)

const V1 = 'export function price(x) {\n  return x\n}\n'
const EDIT = 'export function price(x) {\n  return x * 1.18 // A: add tax\n}\n'
let A, B
try {
  A = join(dA, 'A'); B = join(dB, 'B')
  await sleep(2500)
  A.claim('f.js', 'seed'); fs.writeFileSync(fA, V1); await sleep(3000); A.release('f.js')
  await sleep(1500)
  T('(setup) B has the seeded file', read(fB) === V1)

  console.log('\n# A writes a file B holds, then A\'s connection drops')
  B.claim('f.js', 'holding'); await sleep(1500)
  fs.writeFileSync(fA, EDIT)
  await sleep(4000)
  T('H1 (control) the write was held: B never received it', read(fB) === V1, JSON.stringify(read(fB)))
  A.stop(); await sleep(1500)

  console.log('\n# A rejoins with the same folder')
  A = join(dA, 'A')
  await sleep(5000)
  T('H2 A\'s edit is still on A\'s disk after the rejoin', (read(fA) || '').includes('A: add tax'), JSON.stringify(read(fA)))
  await sleep(7000)
  T('H3 ...and still there after several sync passes', (read(fA) || '').includes('A: add tax'), JSON.stringify(read(fA)))
  const told = chatOf(B).filter((t) => /f\.js/.test(t) && /never reached|NOT applied|not applied|held/i.test(t))
  T('H4 the room is told A\'s edit never reached it', told.length >= 1, told[0] || chatOf(B).slice(-4).join(' | '))
  T('H5 B\'s copy is untouched while B holds the file', read(fB) === V1, JSON.stringify(read(fB)))
  B.release('f.js'); await sleep(4000)
  T('H6 when B releases, A\'s edit reaches B: it was re-sent, not just kept', (read(fB) || '').includes('A: add tax'), JSON.stringify(read(fB)))
  T('H7 and nobody\'s copy has conflict markers', !(read(fA) || '').includes('<<<<<<<') && !(read(fB) || '').includes('<<<<<<<'))
  A.stop(); await sleep(1000)

  console.log('\n# CONTROL: the edit reached the room, the room moved on, A rejoins untouched')
  // Reset both sides to one agreed copy first.
  const settled = read(fB)
  A = join(dA, 'A'); await sleep(4000)
  A.stop(); await sleep(800)
  fs.writeFileSync(fA, read(fB)) // A's disk = the room's copy = what A's engine last agreed to
  A = join(dA, 'A'); await sleep(4000)
  A.claim('f.js', 'reaches the room'); fs.writeFileSync(fA, 'export function price(x) {\n  return x + 1 // C\n}\n'); await sleep(3000); A.release('f.js')
  await sleep(1500)
  T('(control setup) A\'s edit reached B', (read(fB) || '').includes('// C'), JSON.stringify(read(fB)))
  A.stop(); await sleep(1500)
  // A line of its own, not the line A changed: a same-line handover is a different bug, with
  // its own test (handover-conflict-test). This control is only about the rejoin adopt.
  const MOVED = read(fB) + 'export const VAT = 0.18 // room moved on\n'
  B.claim('f.js', 'move on'); fs.writeFileSync(fB, MOVED); await sleep(3000); B.release('f.js')
  A = join(dA, 'A'); await sleep(5000)
  T('C1 untouched local -> A took the room\'s newer copy, exactly', read(fA) === MOVED, JSON.stringify(read(fA)))
  void settled

  console.log('\n# TWO edits while held, then the drop (antigravity-3, 1 Nov)')
  // The second capture's base is the first edit, which the room never had. Merging against it on
  // rejoin reads the first edit as the room deleting it.
  const gA = path.join(dA, 'g.js'), gB = path.join(dB, 'g.js')
  const G0 = Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
  A.claim('g.js', 'seed'); fs.writeFileSync(gA, G0); await sleep(3000); A.release('g.js')
  await sleep(2000)
  B.claim('g.js', 'holding'); await sleep(1500)
  const G1 = G0.replace('export const v0 = 0', 'export const v0 = 100 // A first')
  fs.writeFileSync(gA, G1); await sleep(3000)
  const G2 = G1.replace('export const v9 = 9', 'export const v9 = 900 // A second')
  fs.writeFileSync(gA, G2); await sleep(3500)
  T('(control) both edits were held: B still has the seed', read(gB) === G0, JSON.stringify(read(gB)))
  A.stop(); await sleep(2500) // past the ancestor save's debounce
  A = join(dA, 'A'); await sleep(5000)
  T('H8 both held edits are still on A\'s disk after the rejoin', (read(gA) || '').includes('A first') && (read(gA) || '').includes('A second'), JSON.stringify(read(gA)))
  B.release('g.js'); await sleep(4000)
  T('H9 ...and both reach B when B releases', (read(gB) || '').includes('A first') && (read(gB) || '').includes('A second'), JSON.stringify(read(gB)))

  console.log('\n# No base history saved (a crash right after the edit): kept, frozen, sent on the next save')
  const kA = path.join(dA, 'k.js'), kB = path.join(dB, 'k.js')
  const K0 = 'export const step = 0\n'
  const KA = 'export const step = 1 // A: kept\n'
  A.claim('k.js', 'seed'); fs.writeFileSync(kA, K0); await sleep(3000); A.release('k.js')
  await sleep(2000)
  B.claim('k.js', 'holding'); await sleep(1500)
  fs.writeFileSync(kA, KA); await sleep(3500)
  A.stop(); await sleep(2500)
  // The crash: the base history for k.js never reached disk.
  const shp = path.join(dA, '.hive-shadow.json')
  const sh = JSON.parse(fs.readFileSync(shp, 'utf8')); if (sh.from) delete sh.from['k.js']; fs.writeFileSync(shp, JSON.stringify(sh))
  A = join(dA, 'A'); await sleep(5000)
  T('H10 with no base history, A\'s edit is kept on disk', read(kA) === KA, JSON.stringify(read(kA)))
  T('H11 ...and the room is told how to send it', chatOf(B).some((t) => /k\.js/.test(t) && /saves it again/.test(t)))
  fs.writeFileSync(kB, 'export const step = 2 // B\n'); await sleep(3500) // B still holds it: this lands in the room
  T('H12 a room change while A\'s copy is kept does not overwrite it', read(kA) === KA, JSON.stringify(read(kA)))
  B.release('k.js'); await sleep(1500)
  A.claim('k.js', 'send the kept edit'); fs.writeFileSync(kA, KA); await sleep(4500)
  T('H13 saving again sends it: B has A\'s copy', read(kB) === KA, JSON.stringify(read(kB)))
  A.release('k.js')
} catch (e) {
  console.log('  FAIL (threw) ' + (e && e.stack || e)); fail++
} finally {
  for (const c of [A, B]) { try { c && c.stop() } catch { } }
  relay.kill()
  console.log(`\n=== HELD EDIT SURVIVES REJOIN: ${pass} passed, ${fail} failed ===`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
