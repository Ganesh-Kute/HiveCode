// The optional tree-sitter validation oracle: after initTreeSitter(), heuristic
// providers' parses() is heuristic AND a real grammar parse — so balanced-but-garbage
// text that the balance check accepted is now refused, while valid code and all
// heuristic strictness (Python indent rules) are unchanged.
import { languageFor } from '../icr.js'
import { structuralMerge } from '../icr.js'
import { initTreeSitter } from '../treesitter.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

// balanced-but-garbage per language: passes a delimiter-balance check, is not valid code
const GARBAGE = {
  'App.java': 'int f() { return 1; }\nclass ;;; broken not java @@\n',
  'main.go': 'func f() int { return 1 }\nfunc ,,, nope\n',
  'x.rb': 'def f\n  1\nend\ndef !!! bad\nend\n',
  'a.py': 'def f():\n    return 1\ndef (:\n    pass\n',
}
const GOOD = {
  'App.java': 'class A {\n  int f() { return 1; }\n}\n',
  'main.go': 'package m\n\nfunc f() int {\n\treturn 1\n}\n',
  'x.rb': 'def f(x)\n  x + 1\nend\n',
  'a.py': 'def f(x):\n    return x + 1\n',
}

console.log('# before init: balance check accepts the garbage (the known weakness)')
const before = {}
for (const [f, src] of Object.entries(GARBAGE)) before[f] = languageFor(f).parses(src)
T('java garbage passed balance check pre-init (weakness confirmed)', before['App.java'] === true)

const { upgraded } = await initTreeSitter()
console.log('# upgraded providers:', upgraded.join(', '))
T('a broad set of providers upgraded', upgraded.length >= 10)

console.log('# after init: garbage refused, good code still accepted')
for (const [f, src] of Object.entries(GARBAGE)) T(`${f}: balanced garbage now REFUSED`, !languageFor(f).parses(src))
for (const [f, src] of Object.entries(GOOD)) T(`${f}: valid code still parses`, languageFor(f).parses(src))

console.log('# heuristic strictness retained (composed, not replaced)')
T('python mis-indent still refused (our check is stricter than the grammar)', !languageFor('a.py').parses('def f():\n        a = 1\n      b = 2\n'))

console.log('# merges still work end-to-end with the oracle active')
const jb = 'class A {\n  int f() { return 1; }\n  int g() { return 2; }\n}\n'
const r = structuralMerge(jb, jb.replace('return 1', 'return 10'), jb.replace('return 2', 'return 20'), { filename: 'App.java' })
T('java structural merge still clean', r.status === 'auto' && r.text.includes('return 10') && r.text.includes('return 20'))
T('merged output passes the REAL parser', languageFor('App.java').parses(r.text))

console.log('# idempotent init')
const again = await initTreeSitter()
T('second init returns the same result, no double-wrap', again.upgraded.length === upgraded.length)

console.log(`\n=== TREESITTER-ORACLE: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
