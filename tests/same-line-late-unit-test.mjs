// P0-F-12 unit rows: lateOverBlock and the repair it leads to. (The live rows: same-line-very-late-test.)
//   node tests/same-line-late-unit-test.mjs
import { lateOverBlock } from '../sync.js'
import { merge3 } from '../core.js'

let pass = 0, fail = 0
const T = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c || !d ? '' : '  -- ' + d}`); c ? pass++ : fail++ }
const F = 'plan\nship friday\nowner: team\nnotes\n', C = F.replace('friday', 'wednesday')
const X = 'plan\n<<<<<<< Bob\nship tuesday\n=======\nship thursday\n=======\nship monday\n>>>>>>> Dave, Alice (3 versions)\nowner: team\nnotes\n'

T('LO1 the reported text: the stray insert before the opener is taken out', lateOverBlock(F, C, X.replace('<<<<<<< Bob', 'wednes<<<<<<< Bob')) === X)
T('LO2 ...or at the end of the closing line', lateOverBlock(F, C, X.replace('(3 versions)\n', '(3 versions)wednes\n')) === X)
{
  const r = merge3(F, C, X, { lateName: 'Carol' })
  T('LO3 the repair: one block, the three versions in their order, then Carol\'s', r.conflict && r.text === X.replace('ship monday\n>>>>>>> Dave, Alice (3 versions)', 'ship monday\n=======\nship wednesday\n>>>>>>> Dave, Alice, Carol (4 versions)'), JSON.stringify(r.text))
}
// The on-time race that already holds Carol's version: her insert sits inside her own line.
const withCarol = X.replace('ship monday\n', 'ship monday\n=======\nship wednesday\n').replace('(3 versions)', '(4 versions)')
T('LO4 an on-time block that holds the save is never "repaired"', lateOverBlock(F, C, withCarol) === null)
T('LO5 text with no markers: null', lateOverBlock(F, C, F.replace('friday', 'thursday')) === null)
T('LO6 the late text itself: null', lateOverBlock(F, C, C) === null)
T('LO7 a block on ANOTHER line: null', lateOverBlock(F, C, 'wednes<<<<<<< Bob\nplan\n=======\nplan B\n>>>>>>> Al\nship friday\nowner: team\nnotes\n') === null)
T('LO8 a stray that is not the save\'s insert: null', lateOverBlock(F, C, X.replace('<<<<<<< Bob', 'zz<<<<<<< Bob')) === null)
T('LO9 the insert inside a version\'s line, not at an edge of the block, is someone\'s text: null', lateOverBlock(F, C, X.replace('ship monday', 'ship wednesmonday')) === null)

console.log(`\n=== SAME-LINE LATE UNIT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
