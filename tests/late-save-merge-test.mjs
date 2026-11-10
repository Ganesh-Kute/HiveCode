// LATE SAVE AGAINST A CONFLICT BLOCK (P0-F, Antigravity-Cloud's 15 s latency run, 9 Nov 2026).
// Alice, Bob and Dave saved one line at the same moment and the room holds their marker block. Carol saved
// the same line from the same base, but her save arrived 15 s late, after the race window, so it merges
// against the block like any other edit. merge3 stripped the block to ONE side first ('theirs'); with
// the 3-version block's "======= Dave" separators it found no 'theirs' side at all, and every folder
// ended with "ship wednesday" against "plan / owner: team": monday, tuesday and thursday gone. 0.14.3
// lost a side too: a late save against an ordinary 2-way block kept only the block's lower half.
//   L1 a late save against a 2-way block keeps all three versions
//   L2 ...against a 3-version block keeps all four
//   L3 the block's own lines are never repeated (no balloon)
//   L4 a block the late save already resolved is still taken as the resolution
//   L5 clashFinal's blocks are ones the stripper reads: 'all' gives every version back
//   L6 a block whose sections are several lines is never flattened (P0-F-9, 10 Nov 2026): gluing its
//      sections into one text let the next merge come out CLEAN with lines no author wrote
//      (`slot3 = 0 / slot4 = 104 / slot3 = 103 / slot4 = 0`, five agents on adjacent lines)
//   L7 the late save's own edit outside the block lands, and the block stays a block
//   L8 property fuzz: no markers => every version merged the same way; every version's lines survive;
//      every version, merged with the late save, is one pick of the result's sections
//   node tests/late-save-merge-test.mjs
import { merge3, stripConflictMarkers } from '../core.js'
import { intentHunks, clashFinal } from '../sync.js'

let pass = 0, fail = 0
const T = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c || !d ? '' : '  -- ' + d}`); c ? pass++ : fail++ }
const F = 'plan\nship friday\nowner: team\n'
const save = (day) => F.replace('friday', day)
const has = (t, ...days) => days.every((d) => t.includes(`ship ${d}`))

// The blocks the room really holds: clashFinal's, from the saves' intents.
const block = (pairs) => clashFinal(F, new Map(pairs.map(([id, day]) => [id, intentHunks(F, save(day))])), new Map(pairs.map(([id, day]) => [id, day])))
const two = block([[1, 'monday'], [2, 'tuesday']])
const three = block([[1, 'monday'], [2, 'tuesday'], [3, 'thursday']])

console.log('# L1 a late save against a 2-way block')
{
  const r = merge3(F, save('wednesday'), two)
  T('L1 all three versions survive', has(r.text, 'monday', 'tuesday', 'wednesday'), JSON.stringify(r.text))
  T('L1 ...as a conflict', r.conflict, JSON.stringify(r))
}
console.log('# L2 a late save against a 3-version block')
{
  const r = merge3(F, save('wednesday'), three)
  T('L2 all four versions survive', has(r.text, 'monday', 'tuesday', 'thursday', 'wednesday'), JSON.stringify(r.text))
  T('L2 ...outside the conflict, the file is intact', r.text.startsWith('plan\n') && r.text.includes('owner: team'), JSON.stringify(r.text))
}
console.log('# L3 no balloon')
{
  const r = merge3(F, save('wednesday'), three)
  const n = (d) => r.text.split('\n').filter((l) => l === `ship ${d}`).length
  T('L3 every version appears exactly once', ['monday', 'tuesday', 'thursday', 'wednesday'].every((d) => n(d) === 1), JSON.stringify(r.text))
}
console.log('# L4 a resolution still wins')
{
  // The late author saw the block and replaced it: a clean edit from the block is the decision.
  const r = merge3(three, save('sunday'), three)
  T('L4 the resolution is taken whole', r.text === save('sunday') && !r.conflict, JSON.stringify(r))
}
console.log('# L5 the stripper reads clashFinal blocks')
{
  T('L5 the 3-version block uses separators the stripper knows', three.split('\n').filter((l) => /^=======/.test(l)).every((l) => l === '======='), JSON.stringify(three))
  const kept = stripConflictMarkers(three, 'all')
  T("L5 stripping with 'all', as merge3 does, keeps every version", has(kept, 'monday', 'tuesday', 'thursday'), JSON.stringify(kept))
  T("L5 'theirs' still means the sections after the first", stripConflictMarkers(two, 'theirs') === 'plan\nship tuesday\nowner: team\n', JSON.stringify(stripConflictMarkers(two, 'theirs')))
}

console.log('# L6 multi-line sections are never flattened')
{
  const B = '# notes\nslot0 = 0\nslot1 = 0\nslot2 = 0\nslot3 = 0\nslot4 = 0\nend\n'
  const set = (t, i, v) => t.replace(`slot${i} = 0`, `slot${i} = ${v}`)
  let acc = B, fused = null
  for (const i of [3, 0, 4, 1, 2]) {
    const r = merge3(B, set(B, i, 100 + i), acc)
    acc = r.text
    if (!r.conflict && !/^<<<<<<< /m.test(acc) && acc.split('\n').filter((l) => /^slot\d/.test(l)).length !== 5) fused = acc
  }
  T('L6 no step comes out clean with extra slot lines', fused === null, JSON.stringify(fused))
  T('L6 every agent\'s edit survives the fold', [0, 1, 2, 3, 4].every((i) => acc.includes(`slot${i} = ${100 + i}\n`)), JSON.stringify(acc))
  T('L6 ...and the result is marked as a conflict', /^<<<<<<< /m.test(acc), JSON.stringify(acc))
}
console.log('# L7 the late save lands around a multi-line block')
{
  const blk = ['<<<<<<< Alice', 'a = 1', 'b = 1', '=======', 'a = 2', 'b = 2', '>>>>>>> Alice, Bob']
  const base = 'top\na = 0\nb = 0\nmid\nend\n'
  const theirs = ['top', ...blk, 'mid', 'end', ''].join('\n')
  const r = merge3(base, base.replace('end', 'END'), theirs)
  T('L7 the late edit outside the block lands', r.text.includes('\nEND\n'), JSON.stringify(r.text))
  T('L7 the block is still a block, its sections whole', r.conflict && /<<<<<<< [^\n]*\na = 1\nb = 1\n=======\na = 2\nb = 2\n>>>>>>> /.test(r.text), JSON.stringify(r.text))
  const r2 = merge3(base, base.replace('a = 0', 'a = 9'), theirs)
  T('L7 a late edit inside the block joins it as one more version', r2.conflict && ['a = 9\nb = 0', 'a = 1\nb = 1', 'a = 2\nb = 2'].every((v) => r2.text.includes(v)), JSON.stringify(r2.text))
}
console.log('# L8 property fuzz')
{
  let seed = 9001
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const int = (n) => Math.floor(rnd() * n)
  let uid = 0
  const edit = (lines, lo, hi) => { // one random edit inside [lo, hi)
    const out = lines.slice(), at = lo + int(Math.max(1, hi - lo)), op = rnd()
    if (op < 0.5 && at < out.length) out[at] = 'x' + uid++
    else if (op < 0.8) out.splice(at, 0, 'n' + uid++)
    else if (out.length > 2 && at < out.length) out.splice(at, 1)
    return out
  }
  // Every text you can get by picking one section of each block in the result.
  const picks = (text) => {
    let outs = [[]], blk = null
    for (const line of text.split('\n')) {
      if (/^<<<<<<< /.test(line)) { blk = [[]]; continue }
      if (blk && /^=======( |$)/.test(line)) { blk.push([]); continue }
      if (blk && /^>>>>>>> /.test(line)) { outs = outs.flatMap((o) => blk.map((sec) => [...o, ...sec])); blk = null; if (outs.length > 4096) return null; continue }
      if (blk) blk[blk.length - 1].push(line)
      else outs.forEach((o) => o.push(line))
    }
    return new Set(outs.map((o) => o.join('\n')))
  }
  const sides = (r) => (r.conflict ? [stripConflictMarkers(r.text, 'local'), stripConflictMarkers(r.text, 'theirs')] : [r.text])
  const repeatsSection = (text) => {
    let blk = null
    for (const line of text.split('\n')) {
      if (/^<<<<<<< /.test(line)) { blk = [[]]; continue }
      if (blk && /^=======( |$)/.test(line)) { blk.push([]); continue }
      if (blk && /^>>>>>>> /.test(line)) { if (new Set(blk.map((x) => x.join('\n'))).size < blk.length) return true; blk = null; continue }
      if (blk) blk[blk.length - 1].push(line)
    }
    return false
  }
  let bad = { a: 0, b: 0, c: 0, d: 0 }, ex = []
  const CASES = 1500
  for (let c = 0; c < CASES; c++) {
    uid = 0
    const n = 6 + int(12), base = Array.from({ length: n }, (_, i) => 'L' + i)
    const s = 1 + int(n - 3), e = Math.min(n - 1, s + 1 + int(3))
    const k = 2 + int(3)
    const secs = []
    for (let j = 0; j < k; j++) { let v = base.slice(s, e); for (let q = 0, m = 1 + int(2); q < m; q++) v = edit(v, 0, v.length + 1); secs.push(v.length ? v : ['empty' + j]) }
    if (new Set(secs.map((x) => x.join('\n'))).size < 2) continue
    let pre = base.slice(0, s), post = base.slice(e)
    if (rnd() < 0.5) pre = edit(pre, 0, pre.length) // the room's own edit outside the block
    const Tj = (j) => [...pre, ...secs[j], ...post].join('\n') + '\n'
    const theirs = [...pre, '<<<<<<< A', ...secs[0], ...secs.slice(1).flatMap((x) => ['=======', ...x]), '>>>>>>> A, B', ...post].join('\n') + '\n'
    const mine = edit(base, 0, n).join('\n') + '\n'
    const B = base.join('\n') + '\n'
    if (mine === B) continue
    const r = merge3(B, mine, theirs)
    const marked = /^<<<<<<< /m.test(r.text)
    if (!marked) {
      const each = secs.map((_, j) => merge3(B, mine, Tj(j)))
      if (!each.every((x) => !x.conflict && x.text === r.text)) { bad.a++; if (ex.length < 2) ex.push(['a', B, mine, theirs, r.text]) }
    }
    const can = picks(r.text)
    const want = secs.flatMap((_, j) => sides(merge3(B, mine, Tj(j))))
    if (!can || !want.every((w) => can.has(w))) { bad.c++; if (ex.length < 3) ex.push(['c', B, mine, theirs, r.text]) }
    if (repeatsSection(r.text)) bad.d++
    const outLines = new Set(r.text.split('\n'))
    const need = [...mine.split('\n'), ...secs.flat(), ...pre].filter((l) => /^[xn]\d/.test(l))
    if (!need.every((l) => outLines.has(l))) { bad.b++; if (ex.length < 2) ex.push(['b', B, mine, theirs, r.text]) }
  }
  T('L8a no markers only when every version merges to that same text', bad.a === 0, `${bad.a} of ${CASES}  ` + JSON.stringify(ex.find((x) => x[0] === 'a') || ''))
  T('L8b every line any version wrote survives', bad.b === 0, `${bad.b} of ${CASES}  ` + JSON.stringify(ex.find((x) => x[0] === 'b') || ''))
  T('L8c every version, merged with the late save, is one pick of sections: nothing fused', bad.c === 0, `${bad.c} of ${CASES}  ` + JSON.stringify(ex.find((x) => x[0] === 'c') || ''))
  T('L8d no block holds the same section twice', bad.d === 0, `${bad.d} of ${CASES}`)
}

console.log(`\n=== LATE SAVE MERGE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
