// JSON (data-wise merge, perfect guarantee) + Ruby (end-block structural + intent layer).
import { structuralMerge, languageFor } from '../icr.js'
import { merge } from '../index.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

// ---------- JSON ----------
console.log('# JSON: different keys merge; output valid + style-preserving')
const jb = '{\n  "name": "app",\n  "version": "1.0.0",\n  "dependencies": {\n    "express": "^4.0.0"\n  }\n}\n'
const ja = jb.replace('"version": "1.0.0"', '"version": "1.1.0"')
const jbb = jb.replace('"express": "^4.0.0"', '"express": "^4.0.0",\n    "ws": "^8.0.0"')
const r1 = merge(jb, ja, jbb, { filename: 'package.json' })
T('clean merge', r1.clean === true)
T('both edits present', r1.text.includes('"1.1.0"') && r1.text.includes('"ws"'))
T('output is valid JSON', (() => { try { JSON.parse(r1.text); return true } catch { return false } })())
T('indent style preserved (2 spaces)', /\n  "name"/.test(r1.text))

console.log('# JSON: same path changed differently -> conflict naming the path')
const jc1 = jb.replace('"1.0.0"', '"2.0.0"')
const jc2 = jb.replace('"1.0.0"', '"3.0.0"')
const r2 = structuralMerge(jb, jc1, jc2, { filename: 'package.json' })
T('semantic conflict', r2.status === 'semantic-conflict')
T('conflict names the path', r2.conflicts.includes('version'))
T('machine-resolvable unit carried', Array.isArray(r2.resolvable) && r2.resolvable[0].key === 'json:version')

console.log('# JSON: delete vs change -> conflict; delete vs untouched -> deletion wins')
const jDel = '{\n  "name": "app",\n  "version": "1.0.0"\n}\n'                    // deleted dependencies
const jChg = jb.replace('"^4.0.0"', '"^5.0.0"')
T('delete vs change conflicts', structuralMerge(jb, jDel, jChg, { filename: 'p.json' }).status === 'semantic-conflict')
T('delete vs untouched merges (deletion wins)', (() => { const r = structuralMerge(jb, jDel, jb.replace('"app"', '"app2"'), { filename: 'p.json' }); return r.status === 'auto' && !r.text.includes('dependencies') && r.text.includes('app2') })())

console.log('# JSON: arrays — disjoint edits merge, overlapping conflict')
const ab = '{\n  "files": ["a.js", "b.js", "c.js"]\n}\n'
const aa = ab.replace('"a.js", ', '"a0.js", "a.js", ')                            // prepend
const abb = ab.replace('"c.js"', '"c.js", "d.js"')                                // append
const r3 = structuralMerge(ab, aa, abb, { filename: 'p.json' })
T('disjoint array edits merge', r3.status === 'auto' && r3.text.includes('a0.js') && r3.text.includes('d.js'))
const ao1 = ab.replace('"b.js"', '"b1.js"'), ao2 = ab.replace('"b.js"', '"b2.js"')
T('same-element array edits conflict', structuralMerge(ab, ao1, ao2, { filename: 'p.json' }).status === 'semantic-conflict')

// ---------- Ruby ----------
console.log('# Ruby: structure')
const py = languageFor('x.rb')
const rb = 'def helper(x)\n  x * 2\nend\n\ndef main(x)\n  helper(x) + 1\nend\n'
T('valid file parses', py.parses(rb))
T('unbalanced end REFUSED', !py.parses('def f\n  1\n'))
T('extra end REFUSED', !py.parses('def f\n  1\nend\nend\n'))
T('units keyed by def name', py.units(rb).map((u) => u.key).join(',') === 'def:helper,def:main')
T('one-line body + modifier-if do not confuse nesting', py.parses('def f(x)\n  return 1 if x > 0\n  2\nend\n'))
T('while..do counts once', py.parses('def f\n  while true do\n    break\n  end\nend\n'))
T('endless def opens nothing', py.parses('def f(x) = x * 2\n'))

console.log('# Ruby: different defs merge; same def conflicts')
const rbA = rb.replace('x * 2', 'x * 3')
const rbB = rb.replace('+ 1', '+ 2')
const rr1 = structuralMerge(rb, rbA, rbB, { filename: 'x.rb' })
T('different defs merge clean', rr1.status === 'auto' && rr1.text.includes('x * 3') && rr1.text.includes('+ 2'))
const rr2 = structuralMerge(rb, rb.replace('x * 2', 'x * 5'), rb.replace('x * 2', 'x * 7'), { filename: 'x.rb' })
T('same def edited two ways conflicts', rr2.status === 'semantic-conflict')

console.log('# Ruby: intent layer')
const rbDel = 'def main(x)\n  helper(x) + 1\nend\n'
T('deleting a still-called def is a semantic conflict', (() => { const r = structuralMerge(rb, rbDel, rb.replace('+ 1', '+ 9'), { filename: 'x.rb' }); return r.status === 'semantic-conflict' && r.conflicts.some((c) => c.includes('helper')) })())
const rbRen = rb.replace('def helper', 'def doubler')
const rr3 = structuralMerge(rb, rbRen, rb.replace('+ 1', '+ 3'), { filename: 'x.rb' })
T('rename detected + call site rewritten', rr3.status === 'auto' && rr3.text.includes('doubler(x) + 3') && !rr3.text.includes('helper('))
const rbT = 'def cfg\n  connect("localhost", 8080, 3)\nend\n'
const rr4 = structuralMerge(rbT, rbT.replace('"localhost"', '"db.internal"'), rbT.replace(', 3)', ', 5)'), { filename: 'x.rb' })
T('token-level merge inside one statement', rr4.status === 'auto' && rr4.text.includes('db.internal') && rr4.text.includes(', 5)'))

console.log('# Ruby: class descent (different methods of one class merge)')
const rcls = 'class Calc\n  def add(a, b)\n    a + b\n  end\n\n  def mul(a, b)\n    a * b\n  end\nend\n'
const rc1 = rcls.replace('a + b', 'a + b + 0')
const rc2 = rcls.replace('a * b', 'a * b * 1')
const rr5 = structuralMerge(rcls, rc1, rc2, { filename: 'x.rb' })
T('different methods of one class merge', rr5.status === 'auto' && rr5.text.includes('a + b + 0') && rr5.text.includes('a * b * 1'))

console.log(`\n=== JSON-RUBY: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
