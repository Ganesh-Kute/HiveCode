// Property/fuzz test for ICR's CENTRAL guarantee:
//   for any three inputs, structuralMerge never throws, and whenever it returns
//   status 'auto' the merged text PARSES. This is the contract everything else rests on.
//
//   node icr-fuzz-test.js
//
// Generates random base files, two independent random edits, merges them, and checks the
// invariant â€” thousands of times. On any violation it prints the exact triple that broke it.

import { structuralMerge, parses } from '../icr.js'

const ITER = 4000
let failed = 0, autos = 0, conflicts = 0, fallbacks = 0

const rand = (n) => Math.floor(Math.random() * n)
const choice = (a) => a[rand(a.length)]
const names = ['foo', 'bar', 'baz', 'qux', 'helper', 'run', 'calc', 'util', 'init', 'load']
const cap = (s) => s[0].toUpperCase() + s.slice(1)

// Build a single valid top-level declaration. Names drawn from a small pool so edits
// collide often (exercising the conflict / finer-granularity / rename paths).
function genDecl(i) {
  const nm = choice(names) + (rand(3) === 0 ? '' : i) // sometimes reuse a bare name
  switch (rand(5)) {
    case 0: return `function ${nm}() {\n  const x = ${rand(50)}\n  return x + ${rand(50)}\n}`
    case 1: return `const ${nm} = ${rand(100)}`
    case 2: return `class ${cap(nm)} {\n  a() { return ${rand(50)} }\n  b() { return ${rand(50)} }\n}`
    case 3: return `const ${nm} = {\n  p: ${rand(50)},\n  q: ${rand(50)}\n}`
    default: return `import { ${choice(names)} } from '${choice(names)}'`
  }
}

function genFile() {
  const n = 1 + rand(5)
  const decls = []
  for (let i = 0; i < n; i++) decls.push(genDecl(i))
  return decls
}

// Make an independent edit of a decl array: keep / mutate (bump a number) / drop each,
// then maybe append a new decl. Always stays syntactically valid by construction.
function edit(decls) {
  const out = []
  decls.forEach((d, i) => {
    const r = rand(10)
    if (r < 5) out.push(d)                                   // keep
    else if (r < 8) out.push(d.replace(/\d+/, String(rand(100)))) // mutate a literal
    // else drop
  })
  if (rand(2) === 0) out.push(genDecl(100 + rand(50)))       // sometimes add
  if (!out.length) out.push(decls[0] || genDecl(0))          // never fully empty
  return out
}

const join = (decls) => decls.join('\n\n') + '\n'

for (let t = 0; t < ITER; t++) {
  const baseD = genFile()
  const base = join(baseD)
  if (!parses(base)) continue // skip rare invalid generations
  const a = join(edit(baseD))
  const b = join(edit(baseD))

  let r
  try {
    r = structuralMerge(base, a, b)
  } catch (e) {
    failed++
    console.log('THREW:', e.message, '\n--base--\n' + base + '\n--a--\n' + a + '\n--b--\n' + b)
    continue
  }
  if (r.status === 'auto') {
    autos++
    if (!parses(r.text)) {
      failed++
      console.log('AUTO BUT BROKEN:\n--base--\n' + base + '\n--a--\n' + a + '\n--b--\n' + b + '\n--merged--\n' + r.text)
    }
  } else if (r.status === 'semantic-conflict') conflicts++
  else fallbacks++

  // CONVERGENCE PROPERTY: the merge must be symmetric in its two edits â€” swapping a/b
  // must yield identical text and status. Otherwise two live peers never settle.
  let r2
  try { r2 = structuralMerge(base, b, a) } catch { r2 = null }
  if (!r2 || r2.status !== r.status || (r.text || null) !== (r2.text || null)) {
    failed++
    console.log('NOT SYMMETRIC:\n--base--\n' + base + '\n--a--\n' + a + '\n--b--\n' + b +
      '\n--merge(a,b)--\n' + (r.text || r.status) + '\n--merge(b,a)--\n' + ((r2 && r2.text) || (r2 && r2.status)))
  }
}

console.log(`\nran ${ITER} merges â†’ auto ${autos}, semantic-conflict ${conflicts}, fallback ${fallbacks}`)
console.log(`=== ${failed === 0 ? 'GUARANTEE HELD ACROSS ALL CASES' : failed + ' VIOLATIONS'} ===`)
process.exit(failed === 0 ? 0 : 1)
