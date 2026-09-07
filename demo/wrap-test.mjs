// The wrap the demo video depends on. The GAP line only appears in roughly one run in
// three, so it cannot be verified by re-recording and hoping — it gets tested here.
//
//   node demo/wrap-test.mjs
import { wrap, COLS } from './wrap.mjs'

let pass = 0, fail = 0
const T = (n, c) => { console.log('  ' + (c ? 'ok  ' : 'FAIL') + ' ' + n); c ? pass++ : fail++ }

// The real string, verbatim from scorecard.mjs check 5b.
const GAP = '        only ["Ada"] attributed. Blake\'s edit IS in the text but its attestation was not ' +
  'retained through the concurrent merge. NON-DETERMINISTIC: passes when the second write rebases ' +
  'cleanly, gaps when it truly merges. Fix = attest the merge result against both parents, or ' +
  'attribute per region.'

const w = wrap(GAP)
T('the GAP line wraps into more than one row', w.length > 1)
T('every row fits the canvas', w.every((l) => l.length <= COLS))
T('nothing is lost — every word survives',
  w.join(' ').split(/\s+/).filter(Boolean).join(' ') === GAP.split(/\s+/).filter(Boolean).join(' '))
T('the phrase that was cut off in take 1 is now present',
  w.some((l) => l.includes('NON-DETERMINISTIC')))
T('the fix sentence survives to the end', w.some((l) => l.includes('attribute per region')))
T('continuation rows keep the detail indent', w.slice(1).every((l) => l.startsWith('          ')))

// Short lines are returned untouched, including empties (blank rows are skipped by the renderer).
T('a short line is returned unchanged', wrap('  PASS  [1] fine').join('|') === '  PASS  [1] fine')
T('an empty line survives as one empty row', wrap('').length === 1 && wrap('')[0] === '')
T('a line exactly at the limit is not wrapped', wrap('x'.repeat(COLS)).length === 1)
T('a line one over the limit wraps', wrap('x'.repeat(COLS + 1)).length === 2)

// One unbreakable token longer than the canvas must still be cut, not dropped or left long.
const long = wrap('a'.repeat(COLS * 2 + 5))
T('an unbreakable token is hard-cut, never left overlong', long.every((l) => l.length <= COLS))
T('...and is not silently discarded', long.join('').includes('a'.repeat(COLS)))

// The separator bar and the summary rows must pass through intact.
T('the 72-char separator bar is untouched', wrap('='.repeat(72)).length === 1)

console.log('\n=== WRAP: ' + (fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)) + ' ===')
process.exit(fail === 0 ? 0 : 1)
