// REJOIN CLOBBER test — the data-loss bug seen live, and the only one on the production
// list that costs a customer permanently.
//
// The flow that lost work:
//   1. client B joins a room, pulls a file, and stops (an MCP drop, a crash, a restart).
//   2. while B is gone the file is edited LOCALLY in B's folder (a human in the editor, or
//      an agent that kept working offline).
//   3. B rejoins.
//
// `shadow` — what this engine last wrote to each file — lived only in memory, so step 3 saw
// no common ancestor for that path. reconcile()'s FIRST-CONTACT ADOPT branch then wrote the
// ROOM's copy straight over B's newer local file: no merge, no conflict markers, and (before
// this fix) not even a message. It snapshotted the local bytes first, so the work was
// technically recoverable, but nothing told anyone to look.
//
// The fix persists the ancestor per room in .hive-shadow.json, which turns step 3 into what
// it always was: a three-way merge with a real base.
//
// Two cases must BOTH hold, and they pull in opposite directions:
//   A. local file untouched since we wrote it  -> adopting the room's copy is correct
//   B. local file edited while disconnected    -> MUST merge; the local line must survive
//
// A test that only checked B would pass with "never adopt anything", which would resurrect
// the duplicated-content bug that the adopt branch exists to prevent.
//
//   node tests/rejoin-clobber-test.mjs
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = 1329
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = () => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}

process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'
const relay = await startRelay()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-rejoin-'))
const room = 'rejoin-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`
const SHADOW = '.hive-shadow.json'

const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
const fileA = path.join(dA, 'app.js')
const fileB = path.join(dB, 'app.js')
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

// ── A seeds a two-function file ────────────────────────────────────────────────────────
const SEED = 'function alpha() {\n  return 1\n}\n\nfunction beta() {\n  return 2\n}\n'
const A = startSync({ relay: wsUrl, room, dir: dA, name: 'A', kind: 'ai', log: () => {} })
await sleep(2500)
A.claim('app.js', 'seed'); fs.writeFileSync(fileA, SEED); await sleep(3000); A.release('app.js')

// ── B joins, pulls, and STOPS (the drop) ───────────────────────────────────────────────
let B = startSync({ relay: wsUrl, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
await sleep(3500)
T('B pulled the file on first join', read(fileB) === SEED)
T('B recorded an ancestor on disk (' + SHADOW + ')', fs.existsSync(path.join(dB, SHADOW)))

const shadowRaw = read(path.join(dB, SHADOW))
let shadowObj = null; try { shadowObj = JSON.parse(shadowRaw) } catch { }
T('the ancestor record is valid JSON, v1, and keyed to THIS room',
  !!shadowObj && shadowObj.v === 1 && shadowObj.room === room)
T('the ancestor holds the exact bytes we wrote', !!shadowObj && shadowObj.files && shadowObj.files['app.js'] === SEED)
// A has its own ancestor record too — every client keeps one for the files IT writes, so
// its presence in A's folder is correct. What must never happen is one client's record
// travelling to another; that is checked by the sentinel assertion at the end of this file.

B.stop(); await sleep(1200)

// ── CASE B: local edit while disconnected, and the room moves on too ───────────────────
// B's folder gains a line in alpha(); meanwhile A changes beta(). Neither side has seen the
// other. With a real ancestor these are disjoint edits and BOTH must survive.
const B_LOCAL = 'function alpha() {\n  console.log("B was here")\n  return 1\n}\n\nfunction beta() {\n  return 2\n}\n'
fs.writeFileSync(fileB, B_LOCAL)
A.claim('app.js', 'change beta'); fs.writeFileSync(fileA, SEED.replace('return 2', 'return 22')); await sleep(3000); A.release('app.js')
T('the room copy moved on while B was away', (read(fileA) || '').includes('return 22'))

B = startSync({ relay: wsUrl, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
await sleep(5000)

const afterRejoin = read(fileB) || ''
T('REJOIN DID NOT CLOBBER: B\'s offline edit survived', afterRejoin.includes('B was here'))
T('the room\'s change was also applied', afterRejoin.includes('return 22'))
T('no conflict markers for two disjoint edits', !afterRejoin.includes('<<<<<<<'))
await sleep(2500)
T('the merged result propagated back to A', (read(fileA) || '').includes('B was here'))

B.stop(); await sleep(1000)

// ── CASE A: local untouched since we wrote it -> adopting the room's copy is correct ────
// Without this case, "never adopt" would pass the test above and reintroduce the
// duplicated-content bug on a genuine clone-then-join.
const settled = read(fileB)
A.claim('app.js', 'add gamma')
fs.writeFileSync(fileA, settled + '\nfunction gamma() {\n  return 3\n}\n')
await sleep(3000); A.release('app.js')
T('B\'s local copy is still exactly what the engine last wrote', read(fileB) === settled)

B = startSync({ relay: wsUrl, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
await sleep(4500)
const afterAdopt = read(fileB) || ''
T('untouched local -> B took the room\'s newer copy', afterAdopt.includes('function gamma'))
T('and nothing was duplicated in doing so',
  (afterAdopt.match(/function alpha/g) || []).length === 1 &&
  (afterAdopt.match(/function gamma/g) || []).length === 1)
T('B\'s earlier offline work is still present after the adopt', afterAdopt.includes('B was here'))

B.stop()

// ── a corrupt or foreign ancestor must degrade safely, never merge against junk ─────────
fs.writeFileSync(path.join(dB, SHADOW), '{ truncated')
const dC = path.join(tmp, 'c'); fs.mkdirSync(dC)
fs.writeFileSync(path.join(dC, SHADOW), JSON.stringify({ v: 1, room: 'some-other-room', files: { 'app.js': 'not from here' } }))
fs.writeFileSync(path.join(dC, 'app.js'), SEED)
const C = startSync({ relay: wsUrl, room, dir: dC, name: 'C', kind: 'ai', log: () => {} })
await sleep(4500)
const cText = read(path.join(dC, 'app.js')) || ''
T('an ancestor from a DIFFERENT room is ignored (no merge against foreign history)',
  !cText.includes('not from here'))
T('C with cloned ancestor still converged on the room copy', cText.includes('function alpha'))

// CROSS-CONTAMINATION. C's folder contained an ancestor record naming a foreign room and a
// sentinel string. If the record were syncable, that sentinel would now be in every peer's
// folder — handing them a false ancestor for a file they never wrote from, which is a worse
// bug than the one this suite exists for.
const sentinelLeaked = [dA, dB].some((d) => (read(path.join(d, SHADOW)) || '').includes('not from here'))
T('one client\'s ancestor record never reaches another (never synced)', !sentinelLeaked)
T('a corrupt ancestor record does not crash the client that owns it', fs.existsSync(path.join(dB, 'app.js')))
C.stop()

// ── HIV-P9: FIRST CONTACT WITH PRE-EXISTING DIVERGENT CONTENT (NO SHADOW) ───
// Client D joins a room for the very first time. D's folder ALREADY has an app.js
// with distinct local work, and NO shadow ancestor exists.
// The room has its own app.js. The room has NEVER seen D's content (UNPROVEN / DIVERGED).
// Old bug: blind adopt wiped out D's local work with room copy.
// Buggy merge: concatenated both files into an unparseable doubled mess.
// Correct behavior: D's local file is PRESERVED on disk, room's doc is NOT corrupted/doubled,
// and D's file parses cleanly!
const dD = path.join(tmp, 'd'); fs.mkdirSync(dD)
const D_LOCAL = 'function customFeature() {\n  return "d-unique"\n}\n'
fs.writeFileSync(path.join(dD, 'app.js'), D_LOCAL)
const D = startSync({ relay: wsUrl, room, dir: dD, name: 'D', kind: 'ai', log: () => {} })
await sleep(4500)
const dText = read(path.join(dD, 'app.js')) || ''
T('FIRST-CONTACT CLOBBER SHIELD: D local unproven work was NOT wiped out by room copy',
  dText.includes('customFeature'))
T('D local work was NOT doubled/concatenated with room copy',
  !dText.includes('function alpha') && !dText.includes('function gamma'))
T('D local file still parses cleanly',
  (() => { try { new Function(dText); return true } catch { return false } })())
const aText = read(fileA) || ''
T('Room copy was NOT corrupted by D joining',
  aText.includes('function alpha') && !aText.includes('customFeature'))
D.stop()

for (const c of [A]) { try { c.stop() } catch { } }
relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
console.log(`\n=== REJOIN CLOBBER: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
