// BLIND RECREATE (HIV-P14b): an agent writes a file it could not see, and the room already had it.
//
//   node tests/blind-recreate-test.mjs
//
// THE DEFECT, MEASURED AND TRACED.
// Hivecode opens one WebSocket per file, so the client keeps a bounded working set -- the most
// recently used HIVE_MAX_OPEN_FILES stay connected and the rest are fetched on demand.
// tests/open-file-cap-test.mjs documents that trade honestly: "a file outside the working set
// does not arrive until something touches it."
//
// What that header does not cover is that FOR AN AGENT, NOTHING EVER TOUCHES IT. An agent decides
// what exists by listing its directory. A file it cannot see is a file it believes does not
// exist, so it writes one. Measured 21 Sep 2026: agent B, holding 8 of a room's 41 files, wrote
// mod039.js. reconcile() traced through the running product showed:
//
//   mod039.js origin=remote synced=true docLen=22 diskLen=39 hasBase=false
//             inManifest=true preexisting=false   -> BRANCH=no-base-block
//
// `preexisting` records our DISK, so it reads false and the path is classified a CREATION RACE.
// The empty-base merge then unions two whole files into agent A's copy:
//
//   export const v39 = 39
//   export const v39 = "FROM SCRATCH BY B"
//
// Two const declarations of the same name -- invalid code, in another agent's folder. The union
// is right for two authors adding DIFFERENT blocks to a file they both just created; it is wrong
// for two independent whole-file creations of the same module.
//
// WHY THIS SUITE EXISTS AND NOT JUST THE FIX. The first version of the guard WORKED and was
// deleted anyway, because the probe checking it looked for the refusal in the client's `log`
// callback while the refusal is announced through `say()` into the room chat. A working fix,
// removed on the strength of reading the wrong side of a boundary -- the same class as
// learnings/testing-the-consumer-instead-of-the-derivation.md, committed hours earlier.
//
// So every assertion here reads a channel the product actually writes: BYTES ON DISK, and the
// room's chat array. Section D is the one that would have caught the mistake: it asserts the
// announcement is in `chat`, and separately that it is NOT what `log` carries.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (23000 + (process.pid % 17000))
const N_FILES = 40
const MAX_OPEN = 8
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// Small enough that the room is far larger than the working set, which is the precondition for
// the whole defect. Honoured by the live client, not passed in by this file.
process.env.HIVE_MAX_OPEN_FILES = String(MAX_OPEN)
process.env.HIVE_EVICT_GRACE_MS = '1200'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-recreate-'))
const room = 'recreate-' + crypto.randomBytes(5).toString('hex')
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

// An ORDINARY .gitignore. The night room only works because of a hand-written 88-entry
// allow-list; nobody evaluating this will write one, so the defect must be reproduced without it.
const dirA = path.join(tmp, 'a'); fs.mkdirSync(dirA, { recursive: true })
fs.writeFileSync(path.join(dirA, '.gitignore'), 'node_modules/\n')
const body = (i) => `export const v${i} = ${i}\n`
for (let i = 0; i < N_FILES; i++) fs.writeFileSync(path.join(dirA, `mod${String(i).padStart(3, '0')}.js`), body(i))
const dirB = path.join(tmp, 'b'); fs.mkdirSync(dirB, { recursive: true })

const TARGET = 'mod039.js'
const B_DRAFT = 'export const v39 = "FROM SCRATCH BY B"\n'
const logB = []
let A, B
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirA, name: 'A', kind: 'ai', log: () => {} })
  await sleep(8000)
  B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirB, name: 'B', kind: 'ai', log: (m) => logB.push(String(m)) })
  await sleep(14000)

  // ─── A. the precondition: B genuinely cannot see the file ──────────────────────────────────
  console.log('\n# A. the precondition')
  const st = B.status()
  T('A1 B holds far fewer files than the room has', st.filesHeld < st.roomFiles,
    `${st.filesHeld} of ${st.roomFiles}`)
  T('A2 and reports the shortfall rather than a full house', st.filesMissing > 0, `missing ${st.filesMissing}`)
  T(`A3 ${TARGET} is NOT on B's disk — so B's agent would conclude it does not exist`,
    !fs.existsSync(path.join(dirB, TARGET)))
  T('A4 while the room demonstrably has it', B.doc.getMap('manifest').has(TARGET))

  // ─── B. the write, and what it must NOT do to the other agent's file ──────────────────────
  console.log('\n# B. B writes the file from scratch')
  fs.writeFileSync(path.join(dirB, TARGET), B_DRAFT)
  await sleep(12000)

  const aText = fs.readFileSync(path.join(dirA, TARGET), 'utf8')
  const decls = (aText.match(/const v39/g) || []).length
  T('B1 A\'S FILE STILL HAS EXACTLY ONE DECLARATION — no union of two whole files',
    decls === 1, `${decls} declarations: ${JSON.stringify(aText).slice(0, 90)}`)
  T('B2 and it is A\'s original content, byte for byte', aText === body(39),
    JSON.stringify(aText).slice(0, 90))
  T('B3 no conflict markers were written into A\'s file', !/<<<<<<</.test(aText))

  // ─── C. B is not left holding its own draft as if it were the file ────────────────────────
  console.log('\n# C. what B ends up with')
  const bText = fs.readFileSync(path.join(dirB, TARGET), 'utf8')
  T('C1 B now holds the ROOM\'s copy, which is the real file', bText === body(39),
    JSON.stringify(bText).slice(0, 90))
  // Adopting the room's copy is only acceptable if the agent's own work is recoverable. A
  // refusal that silently discards what the agent wrote trades one data loss for another.
  //
  // AND THE CHANNEL AGAIN. The first version of this assertion looked for a `.hive-snapshots`
  // directory and reported "no snapshots at all" — restore points are not files. They live in
  // the file doc's `snap` Y.Map with an index in the base doc's `history`, and listHistory() is
  // the product surface for them. Same mistake as D3, found twice in one suite.
  const hist = B.listHistory({ file: TARGET })
  const entry = hist.find((h) => /already existed in the room/i.test(String(h.label || '')))
  T('C2 B\'S DRAFT WAS PRESERVED as a restore point, not silently discarded', !!entry,
    entry ? `label: ${String(entry.label).slice(0, 70)}` : `${hist.length} restore point(s) for ${TARGET}, none from the refusal`)
  T('C3 and it is attributed to B, so the timeline says who wrote the draft',
    !!(entry && String(entry.by) === 'B'), entry ? `by=${entry.by}` : '')

  // ─── D. THE ASSERTION THAT WOULD HAVE SAVED THE FIRST FIX ─────────────────────────────────
  console.log('\n# D. the announcement is on the channel the product writes')
  const chat = (A.doc ? A.doc.getArray('chat').toArray() : []).map((m) => String((m && m.text) || ''))
  const announced = chat.filter((t) => /ALREADY EXISTED IN THE ROOM/.test(t))
  T('D1 the refusal is announced in the ROOM CHAT, where say() puts it', announced.length > 0,
    announced.length ? announced[0].slice(0, 120) : `${chat.length} chat messages, none of them this`)
  T('D2 the message tells the reader the CAUSE, not just that something happened',
    announced.some((t) => /bounded working set/.test(t) && /read or claim the path/.test(t)))
  // The first version of this guard worked and was deleted because a probe looked for the
  // announcement in the log callback. Pinning that it is NOT there keeps the next reader from
  // repeating it.
  T('D3 and it is NOT in the log callback — that is the boundary the first probe got wrong',
    !logB.some((l) => /ALREADY EXISTED IN THE ROOM/.test(l)),
    `${logB.length} log lines`)

  // ─── E. anti-vacuity: a genuine creation race must still union ────────────────────────────
  console.log('\n# E. a real creation race is untouched')
  // Neither side had this path at join, so it is not in roomAtJoin for either client. Both
  // create it at once. The empty-base union is CORRECT here and must still happen -- a guard
  // that swallowed this case would be trading one silent loss for another.
  const RACE = 'raced.js'
  fs.writeFileSync(path.join(dirA, RACE), 'export function alpha() { return 1 }\n')
  fs.writeFileSync(path.join(dirB, RACE), 'export function beta() { return 2 }\n')
  await sleep(14000)
  const rA = fs.readFileSync(path.join(dirA, RACE), 'utf8')
  const rB = fs.readFileSync(path.join(dirB, RACE), 'utf8')
  T('E1 a genuine race still keeps BOTH authors\' work', /alpha/.test(rA) && /beta/.test(rA),
    JSON.stringify(rA).slice(0, 110))
  T('E2 and both agents converge on the same bytes', rA === rB)
  // THE PROPERTY THE GUARD OWES THIS CASE: stay out of it. A guard that adopted the room's copy
  // here would discard one author's whole file, which is the loss it exists to prevent.
  const raceChat = (A.doc.getArray('chat').toArray() || [])
    .map((m) => String((m && m.text) || '')).filter((t) => t.includes(RACE))
  T('E3 the blind-recreate guard did NOT claim this path — a real race is not a recreate',
    !raceChat.some((t) => /ALREADY EXISTED IN THE ROOM/.test(t)),
    raceChat.map((t) => t.slice(0, 80)).join(' || '))
  // MEASURED, and the reason E3 does not assert an announcement. A truly simultaneous creation
  // takes BRANCH=genesis-publish on BOTH sides: neither client has the path in its manifest yet,
  // so each publishes its own draft and each ends up with a base. The union then arrives through
  // the ordinary 3-way merge, which announces nothing -- correctly, since that is every normal
  // edit. sync.js:1690's "created by two participants at once" fires only when one side is
  // SLOWER: it writes its draft after the room's copy has already reached its file doc.
  //
  // So a dead-heat race is silent. Both authors hold a file containing a stranger's code and
  // neither was told. Benign for two disjoint functions, and the same corruption P14b exists to
  // stop when it is two whole-file rewrites of one module. Open as HIV-P17, recorded in README
  // "Known limits"; NOT asserted as correct here, because pinning it would endorse it.
  T('E4 whichever path it took, neither author silently lost their work',
    /alpha/.test(rB) && /beta/.test(rB), JSON.stringify(rB).slice(0, 110))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { A && A.stop() } catch { }
  try { B && B.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== HIV-P14b BLIND RECREATE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
