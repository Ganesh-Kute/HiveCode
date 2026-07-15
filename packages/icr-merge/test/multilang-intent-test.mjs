// Intent layer for the HEURISTIC providers (Python + brace family): the same
// guarantees the JS provider has — dangling-reference blocking, rename detection
// with call-site rewriting, token-level inner merge — now hold beyond JS.
// Also: Python's parses() understands INDENTATION, so a merge that would land a
// statement in the wrong block is refused (balance alone used to pass it).
import { structuralMerge, languageFor } from '../icr.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

// ---------- Python ----------
console.log('# Python: indentation-aware parses()')
const py = languageFor('x.py')
T('valid module parses', py.parses('def f(x):\n    return x\n\nclass A:\n    def m(self):\n        pass\n'))
T('indent without opener REFUSED', !py.parses('x = 1\n    y = 2\n'))
T('dedent to unknown level REFUSED', !py.parses('def f():\n        a = 1\n      b = 2\n'))
T('":" with no block REFUSED', !py.parses('def f():\nx = 1\n'))
T('trailing ":" at EOF REFUSED', !py.parses('def f():'))
T('bracket continuation ok', py.parses('x = [\n    1,\n  2,\n]\n'))
T('multi-line string ok', py.parses('s = """\n  not code:\n"""\nx = 1\n'))
T('else/elif chains ok', py.parses('if a:\n    x = 1\nelif b:\n    x = 2\nelse:\n    x = 3\n'))

console.log('# Python: dangling reference blocked')
const pyBase = 'def helper(x):\n    return x * 2\n\ndef main(x):\n    return helper(x) + 1\n'
const pyDel = 'def main(x):\n    return helper(x) + 1\n'                       // deleted helper, still called
const pyOther = pyBase.replace('+ 1', '+ 2')
const rPyDangle = structuralMerge(pyBase, pyDel, pyOther, { filename: 'x.py' })
T('deleting a still-called def is a semantic conflict', rPyDangle.status === 'semantic-conflict' && rPyDangle.conflicts.some((c) => c.includes('helper')))

console.log('# Python: rename detected, call sites rewritten')
const pyRen = pyBase.replace(/helper/, 'doubler').replace('def doubler', 'def doubler') // rename decl only (call site stale)
const pyRenamed = 'def doubler(x):\n    return x * 2\n\ndef main(x):\n    return helper(x) + 1\n'
const rPyRen = structuralMerge(pyBase, pyRenamed, pyBase.replace('+ 1', '+ 3'), { filename: 'x.py' })
T('rename merges clean', rPyRen.status === 'auto')
T('stale call site rewritten to new name', rPyRen.status === 'auto' && rPyRen.text.includes('doubler(x) + 3') && !rPyRen.text.includes('helper('))

console.log('# Python: token-level inner merge (two edits in ONE statement)')
const pyT = 'def cfg():\n    return connect("localhost", 8080, retries=3)\n'
const pyTa = pyT.replace('"localhost"', '"db.internal"')
const pyTb = pyT.replace('retries=3', 'retries=5')
const rPyTok = structuralMerge(pyT, pyTa, pyTb, { filename: 'x.py' })
T('same-line disjoint token edits merge', rPyTok.status === 'auto' && rPyTok.text.includes('"db.internal"') && rPyTok.text.includes('retries=5'))

// ---------- Brace family (Java as representative) ----------
console.log('# Java: dangling reference blocked')
const jBase = 'class App {\n  int helper(int x) { return x * 2; }\n  int main(int x) { return helper(x) + 1; }\n}\n'
const jDel = 'class App {\n  int main(int x) { return helper(x) + 1; }\n}\n'
const jOther = jBase.replace('+ 1', '+ 2')
// top-level: class App is one unit; deletion happens INSIDE — test at top-level decl scale instead
const jBase2 = 'int helper(int x) { return x * 2; }\nint main(int x) { return helper(x) + 1; }\n'
const jDel2 = 'int main(int x) { return helper(x) + 1; }\n'
const jOther2 = jBase2.replace('+ 1', '+ 2')
const rJDangle = structuralMerge(jBase2, jDel2, jOther2, { filename: 'App.java' })
T('deleting a still-called method is a semantic conflict', rJDangle.status === 'semantic-conflict' && rJDangle.conflicts.some((c) => c.includes('helper')))

console.log('# Java: rename detected, call sites rewritten')
const jRenamed = 'int doubler(int x) { return x * 2; }\nint main(int x) { return helper(x) + 1; }\n'
const rJRen = structuralMerge(jBase2, jRenamed, jBase2.replace('+ 1', '+ 3'), { filename: 'App.java' })
T('rename merges clean', rJRen.status === 'auto')
T('stale call site rewritten', rJRen.status === 'auto' && rJRen.text.includes('doubler(x) + 3') && !rJRen.text.includes('helper('))

console.log('# Java: property access is NOT a reference (no false dangling)')
const jProp = 'int helper(int x) { return x * 2; }\nint use(Obj o) { return o.helper(1); }\n'
const jPropDel = 'int use(Obj o) { return o.helper(1); }\n'
const rJProp = structuralMerge(jProp, jPropDel, jProp.replace('o.helper(1)', 'o.helper(2)'), { filename: 'App.java' })
T('deleting helper while only o.helper() remains merges clean', rJProp.status === 'auto')

console.log('# Go: token-level inner merge in one statement')
const gT = 'func cfg() {\n\tconnect("localhost", 8080, 3)\n}\n'
const gTa = gT.replace('"localhost"', '"db.internal"')
const gTb = gT.replace(', 3)', ', 5)')
const rGTok = structuralMerge(gT, gTa, gTb, { filename: 'main.go' })
T('same-line disjoint token edits merge', rGTok.status === 'auto' && rGTok.text.includes('"db.internal"') && rGTok.text.includes(', 5)'))

console.log(`\n=== MULTILANG-INTENT: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
