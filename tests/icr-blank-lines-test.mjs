// THE STRUCTURAL MERGE MUST NOT REARRANGE BLANK LINES (#19, 10 Nov 2026).
// A one-line top-level statement (`x = 0` in Python, `X = 0` in Ruby, a `- item` or plain line in
// YAML) is a unit keyed by its own text, so an edit is a delete plus a new unit. spliceUnits wrote a
// new unit as `val + '\n'`, but these languages' units already end with their newline: every edited
// line came back followed by a blank line no author wrote, and a deleted line's blank lines were left
// where it had been (`import os\nA = 1\n\n\n\ndef f()`). Whitespace only, but on every concurrent
// edit of two top-level lines in .py, .rb and .yaml files, and it reaches disk as a clean merge.
//   B1 a new unit that ends with a newline gets no second one (structural merge)
//   B2 the sync merge gives exactly both sides' edits, blank lines where the authors left them
//   B3 guards: a JS function both sides add still lands, and a structural rename still wins
//   node tests/icr-blank-lines-test.mjs
import { structuralMerge } from '../icr.js'
import { icrMerge3 } from '../icr-merge.js'
import { merge3 } from '../core.js'

let pass = 0, fail = 0
const T = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c || !d ? '' : '  -- ' + d}`); c ? pass++ : fail++ }
// base, the line mine changes, the line theirs changes
const CASES = {
  'a.py': ['x = 0\ny = 0\nz = 0\n', 0, 1],
  'b.py': ['import os\n\nA = 0\n\ndef f():\n    return A\n\nB = 0\n', 2, 7],
  'a.rb': ['X = 0\nY = 0\nZ = 0\n', 0, 1],
  'list.yaml': ['- a0\n- b0\n- c0\n', 0, 1],
  'plain.yaml': ['a: 0\nplain0\nb: 0\n', 0, 1],
}
const sides = ([B, i, j]) => {
  const L = B.split('\n'), M = [...L], TH = [...L]
  M[i] = M[i].replace('0', '1'); TH[j] = TH[j].replace('0', '2')
  return { B, M: M.join('\n'), TH: TH.join('\n'), want: L.map((l, k) => (k === i ? M[i] : k === j ? TH[j] : l)).join('\n') }
}

console.log('# B1 no second newline after a new unit')
for (const f of ['a.py', 'a.rb', 'list.yaml']) {
  const { B, M, TH, want } = sides(CASES[f])
  const r = structuralMerge(B, M, TH, { filename: f })
  T(`B1 ${f}: the structural merge is exactly both edits`, r.status === 'auto' && r.text === want, JSON.stringify(r))
}

console.log('# B2 the sync merge keeps the authors\' blank lines')
for (const f of Object.keys(CASES)) {
  const { B, M, TH, want } = sides(CASES[f])
  const r = icrMerge3(B, M, TH, f)
  T(`B2 ${f}`, !r.conflict && r.text === want, JSON.stringify(r.text))
}

console.log('# B3 guards')
{
  const B = 'const a = 1\n\nfunction f() { return a }\n'
  const r = icrMerge3(B, B + '\nfunction g() { return 2 }\n', 'function h() { return 3 }\n\n' + B, 'a.js')
  T('B3 functions both sides add still land', !r.conflict && r.text.includes('function g()') && r.text.includes('function h()'), JSON.stringify(r))
  // A rename on one side and a new call on the other: only the structural merge updates the call.
  // The line merge is clean here (the new function is far from the renamed lines) but keeps a stale
  // `load()` call: the layout guard must not take it.
  const R = 'function load() { return 1 }\n\nfunction a() { return load() }\n\nconst k = 1\n\nconst m = 2\n'
  const mine = R.replace(/\bload\b/g, 'fetchAll')
  const theirs = R + '\nfunction b() { return load() + 1 }\n'
  const r2 = icrMerge3(R, mine, theirs, 'r.js')
  const lm = merge3(R, mine, theirs, { sideBySide: true })
  T('B3 precondition: the line merge alone is clean and keeps the stale call', !lm.conflict && /return load\(\)/.test(lm.text), JSON.stringify(lm))
  T('B3 a structural rename still wins over a clean line merge', r2.icr === 'rename' && !/\bload\(/.test(r2.text), JSON.stringify(r2))
}

console.log(`\n=== ICR BLANK LINES: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
