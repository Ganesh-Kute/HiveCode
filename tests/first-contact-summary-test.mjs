// tests/first-contact-summary-test.mjs -- a teammate joins with their own checkout, and the room
// hears about it ONCE, in plain words.
//
// The onboarding audit (2 Oct 2026). HIV-P9 keeps both copies of a file whose content the room has
// never seen, and adopts the room's copy of one it has. A file that differs only in line endings
// is the same file: each disk keeps its own endings (8 Nov 2026). Both outcomes are right. But each file was announced on its own line, in engine words
// ("UNPROVEN", "Resolve deliberately"), so a teammate a few commits behind filled the chat with one
// line per file. A Windows checkout makes it worse: git writes CRLF there and the room holds LF, so
// nearly every text file "differs" in line endings alone.
//
// This asserts the OUTCOMES (unchanged: bytes on both sides) and the ANNOUNCEMENT (one message,
// naming the files that kept their own version, saying how to make yours the room's).
//
//   node tests/first-contact-summary-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = 22000 + (process.pid % 9000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${!c && extra ? `\n         ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-summary-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', () => {})
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'fcs-' + crypto.randomBytes(5).toString('hex')
const dirA = path.join(tmp, 'a'), dirB = path.join(tmp, 'b')
fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })

// The room (A): three files B has a different version of, two B has with CRLF line endings, one
// B has byte for byte.
const ROOM = {
  'k1.js': 'export const k1 = "room"\n',
  'k2.js': 'export const k2 = "room"\n',
  'k3.js': 'export const k3 = "room"\n',
  'e1.js': 'export const e1 = 1\nexport const e1b = 2\n',
  'e2.js': 'export const e2 = 1\nexport const e2b = 2\n',
  'same.js': 'export const same = 1\n',
}
const LOCAL = {
  'k1.js': 'export const k1 = "mine"\n',
  'k2.js': 'export const k2 = "mine"\n',
  'k3.js': 'export const k3 = "mine"\n',
  'e1.js': ROOM['e1.js'].replace(/\n/g, '\r\n'),
  'e2.js': ROOM['e2.js'].replace(/\n/g, '\r\n'),
  'same.js': ROOM['same.js'],
}
for (const [f, t] of Object.entries(ROOM)) fs.writeFileSync(path.join(dirA, f), t)

let A, B, C
try {
  A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirA, name: 'A', kind: 'ai', log: () => {} })
  await sleep(2500)
  for (const [f, t] of Object.entries(LOCAL)) fs.writeFileSync(path.join(dirB, f), t)
  B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirB, name: 'B', kind: 'ai', log: () => {} })
  await sleep(8000) // the summary waits for 3 s of quiet

  const rd = (d, f) => fs.readFileSync(path.join(d, f), 'utf8')
  console.log('# outcomes (unchanged by this fix)')
  T('the files with content the room never saw keep B\'s version on B\'s disk', ['k1.js', 'k2.js', 'k3.js'].every((f) => rd(dirB, f) === LOCAL[f]))
  T('...and the room side keeps its own', Object.keys(ROOM).every((f) => rd(dirA, f) === ROOM[f]))
  // Line endings are not content (8 Nov 2026, eol-mixed-peers-test E1): each disk keeps its own.
  T('the files that differed only in line endings keep B\'s endings on B\'s disk, and the room\'s on A\'s', ['e1.js', 'e2.js'].every((f) => rd(dirB, f) === LOCAL[f] && rd(dirA, f) === ROOM[f]))

  console.log('# the announcement')
  const fromB = () => (A.doc.getArray('chat').toArray() || []).filter((m) => m && m.by === 'B').map((m) => String(m.text || ''))
  const about = fromB().filter((t) => /\b(k[123]|e[12])\.js\b/.test(t))
  T('ONE message tells the room about B\'s first contact, not one per file', about.length === 1, about.map((t) => t.slice(0, 90)).join('\n         '))
  const msg = about[0] || ''
  T('...it names each file that kept B\'s version, and says the room\'s copy was NOT adopted', ['k1.js', 'k2.js', 'k3.js'].every((f) => msg.includes(f)) && /NOT adopted/.test(msg), msg)
  T('...it says nothing about the files that differed only in line endings', !/line endings|e1\.js|e2\.js/.test(msg), msg)
  T('...it says how to make B\'s version the room\'s', /claim it and hive_edit it with the full file/.test(msg), msg)
  T('...and it uses no engine words', !/UNPROVEN|DIVERGED|Resolve deliberately/.test(msg), msg)
  T('a file B had byte for byte is not mentioned', !fromB().some((t) => /same\.js/.test(t)))
  T('...and nothing tells anyone to delete a file (a deletion syncs, and removes it for everyone)', !/\b(rm|delete) (it|the file|your copy)\b/i.test(msg) && /Don't delete a local copy/.test(msg), msg)

  // Antigravity1's attack (a): a join whose files differ ONLY in line endings is a non-event.
  console.log('# a join that differs only in line endings says nothing')
  const dirC = path.join(tmp, 'c')
  fs.mkdirSync(dirC, { recursive: true })
  for (const f of ['e1.js', 'e2.js', 'same.js']) fs.writeFileSync(path.join(dirC, f), ROOM[f].replace(/\n/g, '\r\n'))
  C = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirC, name: 'C', kind: 'ai', log: () => {} })
  await sleep(8000)
  T('...its files keep their own endings, and the room\'s copy is unchanged', ['e1.js', 'e2.js', 'same.js'].every((f) => rd(dirC, f) === ROOM[f].replace(/\n/g, '\r\n') && rd(dirA, f) === ROOM[f]))
  const fromC = (A.doc.getArray('chat').toArray() || []).filter((m) => m && m.by === 'C').map((m) => String(m.text || ''))
  T('...and C posts no chat line about them', !fromC.some((t) => /e1\.js|e2\.js|same\.js|line endings|differ from the room/.test(t)), fromC.join(' | ').slice(0, 300))
} catch (e) {
  T('the test ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { A && A.stop() } catch { }
  try { B && B.stop() } catch { }
  try { C && C.stop() } catch { }
  relay.kill()
}

console.log(`\n=== FIRST CONTACT SUMMARY: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
