// Regression: a conflicted file re-merged repeatedly must CONVERGE, not double.
// This is the 104 -> 70,881 bug.
import { merge3, hasConflictMarkers } from '../core.js'

const base = Array.from({length: 20}, (_, i) => `function f${i}() { return ${i} }`).join('\n')
const mine   = base.replace('return 5', 'return 555')
const theirs = base.replace('return 5', 'return 999')   // SAME line, two ways -> real conflict

// round 1: a genuine conflict, markers written into the shared doc
let a = merge3(base, mine, theirs)
console.log(`round 1: ${a.text.split('\n').length} lines, conflict=${a.conflict}, markers=${hasConflictMarkers(a.text)}`)

// now the corrupted text IS the document. Both sides keep syncing it, as really happens.
let doc = a.text, disk = a.text, prev = base
const sizes = []
for (let i = 2; i <= 8; i++) {
  const r = merge3(prev, disk + '\n// edit ' + i, doc)
  prev = doc; doc = r.text; disk = r.text
  sizes.push(r.text.split('\n').length)
}
console.log('rounds 2-8 line counts:', sizes.join(' -> '))
const grew = sizes[sizes.length - 1] / sizes[0]
console.log(`growth over 7 rounds: ${grew.toFixed(2)}x`)
const occurrences = (doc.match(/function f5\(/g) || []).length
console.log(`function f5 appears ${occurrences}x (1 or 2 = fine, 7+ = the bug)`)
console.log(grew < 2 && occurrences <= 2 ? '\nPASS — converges, no exponential duplication' : '\nFAIL — still ballooning')
process.exit(grew < 2 && occurrences <= 2 ? 0 : 1)
