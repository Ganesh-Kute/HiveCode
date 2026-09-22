// HIV-P17: SILENT COLLISION DETECTION on genesis-publish creation race.
//
//   node tests/genesis-collision-test.mjs
//
// THE DEFECT, MEASURED.
// When two participants create the same file at the same time (a creation race), the
// empty-base merge unions them. If both sides are whole-file rewrites of the same module
// — e.g. two `export default function main()` declarations — the union produces code that
// doesn't parse, but nobody was told. The existing fusionReason() check runs only on the
// NORMAL merge path, not on the creation-race path at the no-base-block branch.
//
// HIV-P17 adds the same fusionReason() check to the creation-race path. When the merged
// result breaks code that both inputs could parse, the merge is REFUSED: nothing is written,
// both copies stay intact, and the room is told loudly via say().
//
// WHAT THIS SUITE MEASURES:
//   Section A: Two disjoint functions in a creation race — MUST still union (no false positive)
//   Section B: Two conflicting whole-module rewrites — MUST be refused (the fix)
//   Section C: Non-code files (Markdown) — MUST stay silent (no language support = no check)

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (24000 + (process.pid % 17000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-p17-'))
const room = 'p17-' + crypto.randomBytes(5).toString('hex')
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

// Both clients start with EMPTY directories — everything is a genuine creation race.
const dirA = path.join(tmp, 'a'); fs.mkdirSync(dirA, { recursive: true })
fs.writeFileSync(path.join(dirA, '.gitignore'), 'node_modules/\n')
const dirB = path.join(tmp, 'b'); fs.mkdirSync(dirB, { recursive: true })
fs.writeFileSync(path.join(dirB, '.gitignore'), 'node_modules/\n')

let A, B
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirA, name: 'A', kind: 'ai', log: () => {} })
  await sleep(4000)
  B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirB, name: 'B', kind: 'ai', log: () => {} })
  await sleep(4000)

  // ─── A. Disjoint functions: creation race MUST still union (no false positive) ──────────
  console.log('\n# A. disjoint creation race is untouched (anti-vacuity)')
  const DISJOINT = 'helpers.js'
  // Two completely different, non-overlapping functions — merging these is correct.
  fs.writeFileSync(path.join(dirA, DISJOINT), 'export function alpha() {\n  return 1\n}\n')
  fs.writeFileSync(path.join(dirB, DISJOINT), 'export function beta() {\n  return 2\n}\n')
  await sleep(14000)

  const dA = fs.readFileSync(path.join(dirA, DISJOINT), 'utf8')
  const dB = fs.readFileSync(path.join(dirB, DISJOINT), 'utf8')
  T('A1 a disjoint race keeps BOTH authors\' work', /alpha/.test(dA) && /beta/.test(dA),
    JSON.stringify(dA).slice(0, 120))
  T('A2 both agents converge', dA === dB)
  // The fusionReason check should NOT fire here — disjoint functions parse fine merged.
  const chatA = (A.doc.getArray('chat').toArray() || [])
    .map((m) => String((m && m.text) || '')).filter((t) => t.includes(DISJOINT))
  T('A3 no REFUSED announcement for a clean disjoint merge',
    !chatA.some((t) => /REFUSED/.test(t)),
    chatA.map((t) => t.slice(0, 80)).join(' || '))

  // ─── B. Conflicting whole-module rewrites: MUST be refused ──────────────────────────────
  console.log('\n# B. conflicting whole-module creation race is REFUSED (the fix)')
  const CONFLICT = 'config.js'
  // Both authors write a complete module with the SAME default export — merging produces
  // two `export default`, which does not parse. This is the case HIV-P17 catches.
  fs.writeFileSync(path.join(dirA, CONFLICT),
    'export default function main() {\n  console.log("version A")\n  return { author: "A", port: 3000 }\n}\n')
  fs.writeFileSync(path.join(dirB, CONFLICT),
    'export default function main() {\n  console.log("version B")\n  return { author: "B", port: 4000 }\n}\n')
  await sleep(14000)

  const chatB = (A.doc.getArray('chat').toArray() || [])
    .map((m) => String((m && m.text) || '')).filter((t) => t.includes(CONFLICT))
  T('B1 a REFUSED announcement was posted for the conflicting merge',
    chatB.some((t) => /REFUSED/.test(t)),
    chatB.map((t) => t.slice(0, 100)).join(' || '))
  T('B2 the announcement mentions fusion, not just conflict markers',
    chatB.some((t) => /fused rather than merged/.test(t)),
    chatB.map((t) => t.slice(0, 100)).join(' || '))

  // ─── C. Non-code files: MUST stay silent ────────────────────────────────────────────────
  console.log('\n# C. non-code (Markdown) creation race is silent (no language = no check)')
  const MDFILE = 'notes.md'
  fs.writeFileSync(path.join(dirA, MDFILE), '# Plan A\n\n- Step one from A\n- Step two from A\n')
  fs.writeFileSync(path.join(dirB, MDFILE), '# Plan B\n\n- Step one from B\n- Step two from B\n')
  await sleep(14000)

  const chatC = (A.doc.getArray('chat').toArray() || [])
    .map((m) => String((m && m.text) || '')).filter((t) => t.includes(MDFILE))
  T('C1 no REFUSED announcement for a Markdown file',
    !chatC.some((t) => /REFUSED/.test(t)),
    chatC.map((t) => t.slice(0, 80)).join(' || '))
  // Markdown has no parser support, so fusionReason gets null for lang and skips the parse check.
  // The duplication heuristic may or may not fire, but it should not produce a REFUSED for short files.

} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { A && A.stop() } catch { }
  try { B && B.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== HIV-P17 GENESIS COLLISION: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
