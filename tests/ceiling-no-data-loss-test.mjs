// A FULL RELAY MUST NOT COST YOU YOUR FILES.
//
//   node tests/ceiling-no-data-loss-test.mjs
//
// 18 Sep 2026: a relay answered 38,011 connections with Q430 and the same evening ended with
// **186 files written to 0 bytes** in three folders. The cause is a two-step that neither step
// sees on its own:
//
//   1. Hivecode opens one WebSocket PER FILE. 889 files against a 512 cap means most are refused.
//   2. A file-doc whose socket was refused is a Y.Doc that never received an update, and
//      `getText('content')` on it returns `''` -- indistinguishable from a file the room knows
//      to be empty.
//
// Step 2 then looks exactly like "the room says this file is empty", and the engine writes that
// to disk. Everything succeeds. Nothing throws. The folder is destroyed.
//
// WHAT WAS ALREADY COVERED, AND WHAT WAS NOT. tests/refused-visible-test.mjs proves the refusal
// is REPORTED -- status() names the files, the client says so once, no false alarm on a healthy
// relay. tests/join-empty-doc-test.mjs proves a path in the manifest with no content behind it
// does not zero the disk. Neither one asserts the thing that actually happened: that a file whose
// SOCKET WAS REFUSED keeps its bytes. refused-visible-test.mjs even cites "186 files written to
// 0 bytes" in its header, as motivation, and then never checks it.
//
// That is this file. Section B is the whole point:
//
//        after joining a relay that is full, every file on disk is byte-identical.
//
// Section C is the half that turns one folder's loss into everyone's: the emptiness must not be
// PUBLISHED. A refused file read as empty and pushed to the room would hand the same nothing to
// every peer, and they would all agree on it.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const startRelay = (port, env) => new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const PORT_FULL = 20000 + ((process.pid + 41) % 20000)
const PORT_OK = PORT_FULL + 1
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-ceiling-'))

// Real content, of obviously different sizes, so a truncation is as visible as a zeroing.
const FILES = {
  'a.js': 'export const a = 1\n',
  'b.js': 'export function b() {\n  return "this is b and it has real content"\n}\n',
  'c.js': '// c\n'.repeat(40),
  'd.js': 'export const d = { deep: { nested: true } }\n',
  'e.js': 'export const e = "e"\n',
  'f.js': ('export const f = [\n' + '  1,\n'.repeat(60) + ']\n'),
}
const BEFORE = {}

function seed(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.gitignore'), ['/*', '!/.gitignore', ...Object.keys(FILES).map((f) => '!/' + f), ''].join('\n'))
  for (const [f, c] of Object.entries(FILES)) fs.writeFileSync(path.join(dir, f), c)
}

let full, okRelay, hive, hive2, hive3
try {
  // THE RELAY IS FULL. Cap 2: the base room takes one connection, one file takes the other, and
  // every remaining file is refused -- the 18 Sep shape, in miniature.
  full = await startRelay(PORT_FULL, { HIVE_MAX_CONNS_TOTAL: '2' })
  const room = 'ceil-' + crypto.randomBytes(5).toString('hex')
  const dir = path.join(tmp, 'agent')
  seed(dir)
  for (const f of Object.keys(FILES)) BEFORE[f] = fs.readFileSync(path.join(dir, f), 'utf8')

  console.log('\n# A. the relay refuses most of the folder')
  hive = startSync({ relay: `ws://localhost:${PORT_FULL}`, room, dir, name: 'A', kind: 'ai', log: () => { } })
  await sleep(9000)

  const st = hive.status()
  console.log(`  status: files=${st.files} synced=${st.filesSynced} notSyncing=${st.notSyncing}`)
  T('A1 most of the folder could not connect', st.notSyncing >= 2, `${st.notSyncing} refused of ${st.files}`)
  T('A2 and the refused files are named, not just counted', (st.notSyncingFiles || []).length > 0)

  // ── B. THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────────────
  console.log('\n# B. EVERY FILE ON DISK IS UNTOUCHED')
  let zeroed = [], changed = []
  for (const f of Object.keys(FILES)) {
    const now = fs.readFileSync(path.join(dir, f), 'utf8')
    if (now.length === 0 && BEFORE[f].length > 0) zeroed.push(f)
    else if (now !== BEFORE[f]) changed.push(`${f} (${BEFORE[f].length} -> ${now.length})`)
  }
  T('B1 NOT ONE FILE WAS ZEROED — this is the 186-file incident, asserted',
    zeroed.length === 0, zeroed.join(', '))
  T('B2 and none was altered at all, so nothing was truncated either',
    changed.length === 0, changed.join(', '))
  T('B3 the biggest file kept every byte',
    fs.readFileSync(path.join(dir, 'f.js'), 'utf8').length === FILES['f.js'].length,
    `${fs.readFileSync(path.join(dir, 'f.js'), 'utf8').length}/${FILES['f.js'].length}`)

  // ── C. NOTHING EMPTY WAS PUBLISHED ─────────────────────────────────────────
  console.log('\n# C. the emptiness stayed local')
  // One folder losing its files is a bad evening; the emptiness reaching the ROOM is how every
  // peer agrees on it, and that is what turned 186 files into 186 files in THREE folders.
  //
  // An earlier version of this section started a second agent on the full relay and asserted
  // "no file arrived empty". It passed with ZERO files arriving -- a vacuous pass, which is the
  // same defect this suite is about wearing a test's clothes. A single total cap means the first
  // agent holds every connection, so a second one on that relay can never be a real check.
  // The honest claim about the full relay is the one below; the propagation claim moves to D,
  // where two agents genuinely exchange content.
  const refused = st.notSyncingFiles || []
  T('C1 a refused file never synced, so its emptiness could not have been published',
    refused.every((r) => { const e = hive.status(); return e.notSyncingFiles.includes(r) }) && st.filesSynced < st.files,
    `${st.filesSynced} synced of ${st.files}`)
  T('C2 and the client is not pretending otherwise — it reports the shortfall rather than a clean sync',
    st.notSyncing > 0 && st.filesSynced !== st.files)

  // ── D. WITH CAPACITY: REAL CONTENT PROPAGATES, AND NOTHING ARRIVES EMPTY ───
  console.log('\n# D. two agents on a relay with room')
  // This is also what stops section B being satisfied by a client that simply never works: the
  // refusal has to be the CAUSE of "nothing was written", not the behaviour.
  okRelay = await startRelay(PORT_OK, { HIVE_MAX_CONNS_TOTAL: '64' })
  const room2 = 'ceil-ok-' + crypto.randomBytes(5).toString('hex')
  const dir3 = path.join(tmp, 'agent3')
  seed(dir3)
  hive3 = startSync({ relay: `ws://localhost:${PORT_OK}`, room: room2, dir: dir3, name: 'C', kind: 'ai', log: () => { } })
  await sleep(7000)

  const st3 = hive3.status()
  T('D1 with capacity, nothing is refused', st3.notSyncing === 0, `${st3.notSyncing} refused`)
  T('D2 every file synced', st3.filesSynced >= Object.keys(FILES).length, `${st3.filesSynced}/${st3.files}`)
  T('D3 and the content is still intact, so section B was not measuring a client that does nothing',
    Object.keys(FILES).every((f) => fs.readFileSync(path.join(dir3, f), 'utf8') === FILES[f]))

  // A real peer, on a relay with room, so the propagation claim is not vacuous.
  const dir4 = path.join(tmp, 'agent4')
  fs.mkdirSync(dir4, { recursive: true })
  fs.writeFileSync(path.join(dir4, '.gitignore'), ['/*', '!/.gitignore', ...Object.keys(FILES).map((f) => '!/' + f), ''].join('\n'))
  hive2 = startSync({ relay: `ws://localhost:${PORT_OK}`, room: room2, dir: dir4, name: 'D', kind: 'ai', log: () => { } })
  await sleep(8000)

  const born = Object.keys(FILES).filter((f) => fs.existsSync(path.join(dir4, f)))
  const bornEmpty = born.filter((f) => fs.readFileSync(path.join(dir4, f), 'utf8').length === 0)
  T('D4 the peer actually received files, so D5 is not vacuous',
    born.length === Object.keys(FILES).length, `${born.length}/${Object.keys(FILES).length} arrived`)
  T('D5 NOT ONE ARRIVED EMPTY', bornEmpty.length === 0, bornEmpty.join(', '))
  T('D6 and every one is byte-identical to the original',
    born.every((f) => fs.readFileSync(path.join(dir4, f), 'utf8') === FILES[f]),
    born.filter((f) => fs.readFileSync(path.join(dir4, f), 'utf8') !== FILES[f]).join(', '))
} catch (e) {
  T('the suite ran without throwing', false, String((e && e.stack) || e))
} finally {
  for (const h of [hive, hive2, hive3]) { try { h && h.stop() } catch { } }
  for (const r of [full, okRelay]) { try { r && r.kill() } catch { } }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== CEILING / NO DATA LOSS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
