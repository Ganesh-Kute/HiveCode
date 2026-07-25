// Proves the ICR↔Hivecode bridge in AUTO-MERGE mode: for supported files, a clean ICR
// merge ('auto') supplies the merged bytes (format-preserving, convergent — see
// icr-converge-test.js); merge3 covers conflicts, fallbacks, and other languages; and
// ICR's intent layer surfaces problems the line merge can't see as an `icrWarning`.
//
//   node icr-merge-test.js

import { icrMerge3 } from './icr-merge.js'
import { merge3 } from './core.js'
import { parses } from './icr.js'

let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

console.log('# JS: a rename + a new caller of the old name → ICR auto-fixes the call site')
{
  const base = `function login() { return 1 }

function page() { return login() }
`
  const mine = `function signIn() { return 1 }

function page() { return signIn() }
` // renamed login -> signIn
  const theirs = `function login() { return 1 }

function page() { return login() }

function checkout() { return login() }
` // added a caller of the OLD name
  const r = icrMerge3(base, mine, theirs, 'src/auth.js')
  assert('no conflict', r.conflict === false)
  assert('tagged as a rename merge', r.icr === 'rename')
  assert('the new caller was auto-rewritten to the new name', /checkout\(\) \{ return signIn\(\) \}/.test(r.text))
  assert('no reference to the old name remains', !/login/.test(r.text))
  assert('result is valid code', parses(r.text))
}

console.log('\n# JS: same-line clash in one function → line-merge bytes + a clash warning')
{
  const base = `function foo() { return 1 }
`
  const mine = `function foo() { return 2 }
`
  const theirs = `function foo() { return 3 }
`
  const r = icrMerge3(base, mine, theirs, 'a.js')
  const lm = merge3(base, mine, theirs)
  assert('keeps the safe line-merge bytes', r.text === lm.text)
  assert('attaches a clash warning', !!r.icrWarning && /foo/.test(r.icrWarning))
}

console.log('\n# JS: disjoint edits to different functions → clean auto-merge, both kept')
{
  const base = `function a() { return 1 }

function b() { return 2 }
`
  const mine = `function a() { return 100 }

function b() { return 2 }
`
  const theirs = `function a() { return 1 }

function b() { return 200 }
`
  const r = icrMerge3(base, mine, theirs, 'lib.js')
  assert('no conflict', r.conflict === false)
  assert('kept both edits', /return 100/.test(r.text) && /return 200/.test(r.text))
  assert('result is valid code', parses(r.text))
  assert('no warning (clean, disjoint)', !r.icrWarning)
}

console.log('\n# JS: object both-add (line-merge would conflict) → ICR auto-unions cleanly')
{
  const base = `const o = {
  a: 1
}
`
  const mine = `const o = {
  a: 1,
  b: 2
}
`
  const theirs = `const o = {
  a: 1,
  c: 3
}
`
  const lm = merge3(base, mine, theirs)
  assert('a plain line-merge would conflict here', lm.conflict || /<<<<<<</.test(lm.text))
  const r = icrMerge3(base, mine, theirs, 'o.js')
  assert('ICR resolves with no markers', r.conflict === false && !/<<<<<<</.test(r.text))
  assert('tagged structural', r.icr === 'structural')
  assert('kept both keys, valid', /b: 2/.test(r.text) && /c: 3/.test(r.text) && parses(r.text))
}

console.log('\n# JS: a dangling reference → safe line-merge bytes + a warning (not shipped silently)')
{
  const base = `function helper() { return 1 }

function page() { return helper() }
`
  const mine = `function helper() { return 1 }

function page() { return helper() }

function extra() { return helper() }
`
  const theirs = `function page() { return helper() }
` // deleted helper, but page still calls it
  const r = icrMerge3(base, mine, theirs, 'm.js')
  assert('a warning is attached', !!r.icrWarning)
  assert('warning names the dangling reference', /helper/.test(r.icrWarning || '') && /still used/.test(r.icrWarning || ''))
  assert('text preserved (work not lost)', typeof r.text === 'string' && r.text.length > 0)
}

console.log('\n# Non-JS file: ICR never engages, behaves exactly like merge3')
{
  const base = 'a\nb\nc\n', mine = 'a\nB\nc\n', theirs = 'a\nb\nC\n'
  const r = icrMerge3(base, mine, theirs, 'notes.md')
  const lm = merge3(base, mine, theirs)
  assert('identical to merge3 on a .md file', r.text === lm.text && r.conflict === lm.conflict)
}

console.log('\n# Unparseable JS: ICR bails to merge3 (never throws, never regresses)')
{
  const base = 'function f(){return 1}\n'
  const mine = 'function f(){return 1' // broken
  const theirs = 'function f(){return 1}\nfunction g(){return 2}\n'
  const r = icrMerge3(base, mine, theirs, 'broken.js')
  const lm = merge3(base, mine, theirs)
  assert('matches merge3 fallback', r.text === lm.text && r.conflict === lm.conflict)
}

console.log(`\n=== ${failed === 0 ? 'ALL ICR-MERGE CHECKS PASSED' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
