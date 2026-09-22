// FUSION GUARD (HIV-26) — a merge must never produce something NEITHER author wrote.
//
// Reproduced live on 18 Sep 2026. Three peers wrote the same file within about a second of
// each other and the character-CRDT UNIONED the versions instead of converging:
//
//   sync.js                        144,144 B / 2,288 lines  ->  291,750 B / 4,678 lines
//   tests/open-file-cap-test.mjs     6,051 B                ->   18,153 B
//
// `const MAX_OPEN` and `function evictIfOverCap` each appeared three times, and the splice
// landed mid-token: `evicted// Newly opened counts as used`. There were NO conflict markers.
// Every peer converged on the corruption, so agreement proved nothing. The only thing that
// caught it was a parse failure at the handoff gate — after it had reached every folder.
//
// The guard is tested as a PURE FUNCTION on crafted inputs rather than by racing two writers,
// because forcing a real fusion depends on two writes landing inside the sync window. A guard
// this load-bearing should not be covered only by a test that is inherently flaky.
//
// The false-positive direction matters just as much: a guard that fires on ordinary merges
// would be turned off within a day, so the legitimate cases are asserted too, including a
// large disjoint merge that is genuinely long.
//
//   node tests/fusion-guard-test.mjs

import { fusionReason } from '../sync.js'
import { supports, languageFor } from '../icr.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const js = supports('x.js') ? languageFor('x.js') : null

// ── A. the shape that actually happened ────────────────────────────────────────────────
const MINE = 'export function alpha() {\n  return 1\n}\n'
const THEIRS = 'export function alpha() {\n  return 2\n}\n'

// spliced mid-token, exactly as the real corruption was
const SPLICED = 'export function alpha() {\n  return 1\n}// export function alpha() {\n  return 2\n}\n'
T('A1 a merge that breaks a file both sides could parse is refused',
  /does not parse/.test(fusionReason(SPLICED, MINE, THEIRS, js)))

// THE REAL SHAPE: two NEAR-IDENTICAL versions of one file unioned. This is what happened —
// the same file written three times in a second, so the output carries its own lines twice.
// It parses perfectly well; only duplication gives it away.
const V1 = Array.from({ length: 60 }, (_, i) => `export const setting${i} = ${i} // configuration value`).join('\n') + '\n'
const V2 = V1.replace('setting7 = 7', 'setting7 = 700')
// With a parser in hand the PARSE check fires first and that is correct — a union of two
// versions redeclares every const, which is a SyntaxError. Either way it is refused; what
// matters is that it never lands.
T('A2 a union of two near-identical versions is refused', fusionReason(V1 + V2, V1, V2, js) !== '')

// The duplication signal itself, isolated by passing no parser. This is the half that
// catches a fusion which happens to still parse — the case a parse check cannot see.
T('A3 duplication alone is enough to refuse it, with no parser involved',
  /duplicated, not merged/.test(fusionReason(V1 + V2, V1, V2, null)))
T('A3b the reason quotes how many lines repeated, so it can be checked',
  /\d+ of \d+ distinctive lines/.test(fusionReason(V1 + V2, V1, V2, null)))

// tripled, which is literally what sync.js became — MAX_OPEN appeared three times
T('A4 a triple fusion is caught too', /duplicated/.test(fusionReason(V1 + V2 + V1, V1, V2, null)))

// ── B. it must NOT fire on ordinary merges ─────────────────────────────────────────────
const BASE = 'export function a() { return 1 }\nexport function b() { return 2 }\n'
const A_EDIT = 'export function a() { return 10 }\nexport function b() { return 2 }\n'
const MERGED = 'export function a() { return 10 }\nexport function b() { return 20 }\n'
T('B1 an ordinary two-sided merge is allowed', fusionReason(MERGED, A_EDIT, BASE, js) === '')

// THE FALSE-POSITIVE CASE THAT KILLED THE FIRST DESIGN. Two authors each add 200 disjoint
// lines. The merged result is legitimately about as long as both inputs combined — which is
// why the original length-based test refused it. Nothing repeats, so it is a good merge.
const BIG_A = Array.from({ length: 200 }, (_, i) => `export const a${i} = ${i} // first author's work`).join('\n') + '\n'
const BIG_B = Array.from({ length: 200 }, (_, i) => `export const b${i} = ${i} // second author's work`).join('\n') + '\n'
const SHARED = 'export const shared = 1 // present on both sides already\n'
T('B2 two big DISJOINT additions are allowed, however long the result',
  fusionReason(BIG_A + SHARED + BIG_B, BIG_A + SHARED, SHARED + BIG_B, js) === '')
T('B2b even when the result is longer than both inputs put together',
  (BIG_A + SHARED + BIG_B).length > (BIG_A + SHARED).length &&
  fusionReason(BIG_A + SHARED + BIG_B, BIG_A + SHARED, SHARED + BIG_B, js) === '')

T('B3 identical sides are not a fusion', fusionReason(MINE + MINE, MINE, MINE, js) === '')
T('B4 a merge that only grows a little is allowed',
  fusionReason(MINE + 'export const extra = 1\n', MINE, THEIRS, js) === '')
T('B5 empty inputs are not a fusion (nothing to compare)',
  fusionReason(MINE, '', THEIRS, js) === '' && fusionReason(MINE, MINE, '', js) === '')
T('B6 a missing merged text is not a fusion', fusionReason('', MINE, THEIRS, js) === '')

// ── C. unparseable input must not be mistaken for a broken merge ────────────────────────
// If a side was ALREADY broken, the merge did not break it, and blaming the merge would
// make every merge on a half-written file look like corruption.
const BROKEN = 'export function alpha() {\n  return 1\n'
T('C1 a merge is not blamed when one side was already unparseable',
  fusionReason(BROKEN + 'x', BROKEN, THEIRS, js) === '')

// ── D. prose and other file types with no parser are covered too ───────────────────────
const DOC_A = Array.from({ length: 40 }, (_, i) => `This is paragraph number ${i} of the shared document.`).join('\n') + '\n'
const DOC_B = DOC_A.replace('number 5 of', 'number five of')
T('D1 duplication is caught without a parser, so markdown and prose are covered too',
  /duplicated/.test(fusionReason(DOC_A + DOC_B, DOC_A, DOC_B, null)))
T('D2 and an ordinary prose merge is still allowed',
  fusionReason(DOC_A + 'One genuinely new closing paragraph, written by nobody else.\n', DOC_A, DOC_B, null) === '')

console.log(`\n=== FUSION GUARD: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
