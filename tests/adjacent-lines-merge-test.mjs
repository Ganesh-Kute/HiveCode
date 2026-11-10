// EDITS ON ADJACENT LINES, ANY FILE TYPE (#17, the W1 false conflict, 10 Nov 2026).
// Five agents each change their own line of a 5-line list in one burst. With the fork gate off, the
// saves that land after a neighbour's edit go through the sync merge. For .js and .py the structural
// merge applies both edits. For README.md, .txt, .json and other non-code files the line merge used
// git's rule: two edits with no unchanged line between them are one decision, so they conflict.
// bigproject W1 in default mode put `slot0`/`slot1` in a marker block on README.md in 2 of 3 runs.
// The same two edits made at the same moment merge cleanly in the character CRDT, and P0-F's footprint
// rule calls them no clash. So the sync merge takes the same rule: two same-size replacements that
// only touch are applied side by side. Every other touching case still conflicts, and plain
// merge3 (git-clash, diff3-test) keeps git's rule.
//   A1 adjacent one-line replacements merge cleanly in non-code files
//   A2 ...multi-line same-size replacements too, and five agents in a row
//   A3 guards: the same line, an insertion at the boundary, a line-count change, a deletion
//   A4 plain merge3 keeps git's rule
//   A5 the fork gate's "is this a real fork" check uses the sync rule
//   A7 a late save next to a conflict block lands beside it; the block keeps only its own versions
//   A6 fuzz against plain merge3 (git's rule, pinned to git by diff3-test): never stricter; the same
//      text whenever both are clean; where only the sync rule is clean, its text is the base with
//      both sides' edits applied and every pair it let through is two touching one-for-one replacements
//   node tests/adjacent-lines-merge-test.mjs
import { merge3 } from '../core.js'
import { icrMerge3 } from '../icr-merge.js'
import fs from 'fs'
import { lineHunks } from '../core.js'

let pass = 0, fail = 0
const T = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c || !d ? '' : '  -- ' + d}`); c ? pass++ : fail++ }
const B = '# notes\nslot0 = 0\nslot1 = 0\nslot2 = 0\nslot3 = 0\nslot4 = 0\nend\n'
const set = (t, i, v) => t.replace(`slot${i} = 0`, `slot${i} = ${v}`)
const SIDE = { sideBySide: true }

console.log('# A1 adjacent one-line replacements, non-code files')
for (const f of ['README.md', 'notes.txt', 'config.json', 'NOTES']) {
  const r = icrMerge3(B, set(B, 0, 100), set(B, 1, 101), f)
  T(`A1 ${f}: both edits, no conflict`, !r.conflict && r.text === set(set(B, 0, 100), 1, 101), JSON.stringify(r))
}
{
  const r = icrMerge3(B, set(B, 1, 101), set(B, 0, 100), 'README.md')
  T('A1 the same in the other order', !r.conflict && r.text === set(set(B, 0, 100), 1, 101), JSON.stringify(r))
}

console.log('# A2 multi-line same-size replacements, five in a row')
{
  const mine = B.replace('slot0 = 0\nslot1 = 0', 'slot0 = 7\nslot1 = 8')
  const theirs = B.replace('slot2 = 0\nslot3 = 0', 'slot2 = 9\nslot3 = 10')
  const r = merge3(B, mine, theirs, SIDE)
  T('A2 two 2-line blocks side by side', !r.conflict && r.text === B.replace('slot0 = 0\nslot1 = 0\nslot2 = 0\nslot3 = 0', 'slot0 = 7\nslot1 = 8\nslot2 = 9\nslot3 = 10'), JSON.stringify(r))
  // Folding five agents in, one at a time, the way the room gets them.
  let acc = B
  for (const i of [3, 0, 4, 1, 2]) acc = merge3(B, set(B, i, 100 + i), acc, SIDE).text
  T('A2 five agents, each its own line: all five, no markers', !/<<<<<<<|>>>>>>>/.test(acc) && [0, 1, 2, 3, 4].every((i) => acc.includes(`slot${i} = ${100 + i}\n`)), JSON.stringify(acc))
  // Mine alternates with theirs: 0,2,4 vs 1,3.
  const r2 = merge3(B, set(set(set(B, 0, 1), 2, 1), 4, 1), set(set(B, 1, 2), 3, 2), SIDE)
  T('A2 interleaved lines from two sides', !r2.conflict && r2.text === set(set(set(set(set(B, 0, 1), 2, 1), 4, 1), 1, 2), 3, 2), JSON.stringify(r2))
}

console.log('# A3 guards: what still conflicts')
{
  let r = merge3(B, set(B, 1, 'MINE'), set(B, 1, 'THEIRS'), SIDE)
  T('A3 the same line changed two ways', r.conflict, JSON.stringify(r))
  r = merge3(B, set(B, 0, 100), B.replace('slot1 = 0', 'new line\nslot1 = 0'), SIDE)
  T('A3 a replacement and an insertion at its edge', r.conflict, JSON.stringify(r))
  r = merge3(B, set(B, 0, 100), B.replace('slot1 = 0', 'slot1 = a\nslot1b = b'), SIDE)
  T('A3 a replacement next to one that changes the line count', r.conflict, JSON.stringify(r))
  r = merge3(B, set(B, 0, 100), B.replace('slot1 = 0\n', ''), SIDE)
  T('A3 a replacement next to a deletion', r.conflict, JSON.stringify(r))
  r = merge3(B, B.replace('slot0 = 0\nslot1 = 0', 'slot0 = 1\nslot1 = 1'), B.replace('slot1 = 0\nslot2 = 0', 'slot1 = 2\nslot2 = 2'), SIDE)
  T('A3 overlapping replacements', r.conflict, JSON.stringify(r))
  r = merge3(B, set(B, 1, 101), set(B, 1, 101), SIDE)
  T('A3 the same edit on both sides lands once', !r.conflict && r.text === set(B, 1, 101), JSON.stringify(r))
}

console.log('# A4 plain merge3 keeps git\'s rule')
{
  const r = merge3(B, set(B, 0, 100), set(B, 1, 101))
  T('A4 touching edits conflict without the option', r.conflict, JSON.stringify(r))
  const J = B.replace('# notes', '// notes').replace(/^slot(\d) = 0$/gm, 'let slot$1 = 0')
  const r2 = icrMerge3(J, J.replace('slot0 = 0', 'slot0 = 100'), J.replace('slot1 = 0', 'slot1 = 101'), 'a.js')
  T('A4 the structural merge of code files is unchanged', !r2.conflict && r2.icr === 'structural', JSON.stringify(r2))
}

console.log('# A5 the fork gate\'s real-fork check')
{
  // forkRecord asks merge3 whether two versions really conflict, for every file type. Read the call.
  const src = fs.readFileSync(new URL('../sync.js', import.meta.url), 'utf8')
  const call = src.split('\n').find((l) => /const m = merge3\(base, arr\[i\]\.text, arr\[j\]\.text/.test(l)) || ''
  T('A5 the real-fork check passes the sync rule', /sideBySide:\s*true/.test(call), call.trim())
}

console.log('# A7 a late save beside a block')
{
  const theirs = B.replace('slot1 = 0\n', '<<<<<<< Alice\nslot1 = 1\n=======\nslot1 = 2\n>>>>>>> Alice, Bob (2 versions)\n')
  const r = icrMerge3(B, set(B, 0, 100), theirs, 'README.md')
  T('A7 the late edit lands beside the block', r.text.startsWith('# notes\nslot0 = 100\n<<<<<<< Alice\nslot1 = 1\n=======\nslot1 = 2\n>>>>>>> '), JSON.stringify(r.text))
  T('A7 ...and the block still holds two versions', /\(2 versions\)/.test(r.text) && (r.text.match(/^=======/gm) || []).length === 1, JSON.stringify(r.text))
}
console.log('# A6 fuzz against git\'s rule')
{
  let seed = 4242
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const int = (n) => Math.floor(rnd() * n)
  const VOCAB = ['a', 'b', 'c', '}', '{', '', 'x = 1', 'end'] // repeated lines: where alignment is ambiguous
  let uid = 0
  const edit = (lines) => {
    const out = lines.slice()
    for (let e = 0, k = 1 + int(3); e < k; e++) {
      const at = int(out.length + 1), op = rnd()
      if (op < 0.55 && out.length) out[Math.min(at, out.length - 1)] = 'r' + uid++
      else if (op < 0.65 && out.length > 1) { const q = Math.min(at, out.length - 2); out[q] = 'r' + uid++; out[q + 1] = 'r' + uid++ }
      else if (op < 0.82) out.splice(at, 0, 'n' + uid++)
      else if (out.length > 1) out.splice(Math.min(at, out.length - 1), 1)
    }
    return out
  }
  let stricter = 0, differs = 0, wrongText = 0, notRep = 0, onlySide = 0, CASES = 4000
  for (let c = 0; c < CASES; c++) {
    uid = 0
    const base = Array.from({ length: 6 + int(20) }, () => VOCAB[int(VOCAB.length)])
    const B = base.join('\n') + '\n', M = edit(base).join('\n') + '\n', TH = edit(base).join('\n') + '\n'
    const g = merge3(B, M, TH), sb = merge3(B, M, TH, SIDE)
    if (sb.conflict && !g.conflict) stricter++
    if (!sb.conflict && !g.conflict && sb.text !== g.text) differs++
    if (!sb.conflict && g.conflict) {
      onlySide++
      const b = B.split('\n'), m = M.split('\n'), t = TH.split('\n')
      const hm = lineHunks(b, m), ht = lineHunks(b, t)
      // Every pair from the two sides that is not apart is two touching one-for-one replacements.
      const rep = (h) => h[1] > h[0] && h[1] - h[0] === h[3] - h[2]
      for (const x of hm) for (const y of ht) if (!(x[1] < y[0] || y[1] < x[0]) && !(rep(x) && rep(y) && (x[1] === y[0] || y[1] === x[0]))) notRep++
      const overlap = hm.some((x) => ht.some((y) => Math.max(x[0], y[0]) < Math.min(x[1], y[1])))
      if (overlap) wrongText++
      else {
        const out = b.slice()
        for (const [h, src] of [...hm.map((h) => [h, m]), ...ht.map((h) => [h, t])].sort((x, y) => y[0][0] - x[0][0])) out.splice(h[0], h[1] - h[0], ...src.slice(h[2], h[3]))
        if (out.join('\n') !== sb.text) wrongText++
      }
    }
  }
  console.log(`  (${onlySide} of ${CASES} merge only under the sync rule)`)
  T('A6 never conflicts where git\'s rule merges', stricter === 0, `${stricter}`)
  T('A6 the same text whenever both merge', differs === 0, `${differs}`)
  T('A6 a merge only the sync rule makes is the base with both sides\' edits', onlySide > 50 && wrongText === 0, `${wrongText} of ${onlySide}`)
  T('A6 ...and only for touching one-for-one replacements', notRep === 0, `${notRep}`)
}

console.log(`\n=== ADJACENT LINES MERGE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
