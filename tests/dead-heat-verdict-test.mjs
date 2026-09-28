// HIV-P17 dead-heat VERDICT, as a pure function: no relay, no timing, no random client ids.
//
//   node tests/dead-heat-verdict-test.mjs
//
// dead-heat-forced-test.mjs proves the two-client path end to end, but it cannot choose Yjs client ids,
// so it can never pin WHICH pair of creators gets compared. This suite can. The defect it guards:
// with three creators the union is what lands, and two of them can each merge cleanly with the winner
// while fusing with each other. Checking only the first pair, or only each creator against the winner,
// lets that union through silently.
import { deadHeatVerdict } from '../sync.js'

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const fn = (name, body) => `export function ${name}() {\n  return ${body}\n}\n`
const v = (entries, file = 'service.js') => deadHeatVerdict(new Map(entries), file)

const ALPHA = fn('alpha', 1), ALPHA2 = fn('alpha', 99), BETA = fn('beta', 2), GAMMA = fn('gamma', 3)

console.log('# two creators')
T('disjoint functions land (the union is kept)', v([[1, ALPHA], [2, BETA]]).why === '')
T('one function written twice is refused', v([[1, ALPHA], [2, ALPHA2]]).why !== '', v([[1, ALPHA], [2, ALPHA2]]).why)

console.log('# three creators')
{
  const r = v([[1, ALPHA], [2, BETA], [3, ALPHA2]])
  T('the clash is with the WINNER, behind a clean first pair: refused', r.why !== '', r.why || 'landed')
}
{
  const r = v([[1, GAMMA], [2, ALPHA], [3, ALPHA2]])
  T('the clash is between two NON-winners, each clean against the winner: refused', r.why !== '', r.why || 'landed')
}
T('three disjoint creators land', v([[1, ALPHA], [2, BETA], [3, GAMMA]]).why === '')

console.log('# the winner')
{
  const r = v([[907, BETA], [12, ALPHA2], [455, ALPHA]])
  T('the lowest client id wins, whatever the insertion order', r.winner === 12 && r.winnerText === ALPHA2, `winner=${r.winner}`)
}

console.log('# scope')
T('a file with no language is never refused', v([[1, '# Notes\nA\n'], [2, '# Notes\nB\n']], 'notes.md').why === '')

console.log(`\n=== DEAD-HEAT VERDICT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
