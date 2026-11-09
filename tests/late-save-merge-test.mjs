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

console.log(`\n=== LATE SAVE MERGE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
