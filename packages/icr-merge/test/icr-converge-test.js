// Convergence test for ICR's format-preserving merge â€” the property that decides whether
// auto-merge is safe to run in the LIVE multi-peer relay.
//
//   node icr-converge-test.js
//
// Two peers editing one file must reach the SAME bytes and STAY there (a fixed point).
// The earlier product bug was exactly a convergence failure: peers computed different
// forms and oscillated. We check: symmetry, fixed-point, absorption, and a multi-round
// random simulation â€” plus the specific routes scenario that broke before.

import { structuralMerge } from '../icr.js'

let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const M = (base, a, b) => structuralMerge(base, a, b, { filename: 'x.js' })
const auto = (base, a, b) => { const r = M(base, a, b); return r.status === 'auto' ? r.text : null }

console.log('# Fixed point: once both peers agree on T, re-merging returns T unchanged')
{
  const T = `function a() { return 1 }\n\nfunction b() { return 2 }\n`
  for (const base of [T, `function a() { return 0 }\n`, `function c() { return 9 }\n`]) {
    assert('M(base, T, T) === T', auto(base, T, T) === T)
  }
}

console.log('\n# Symmetry: swapping the two edits yields identical bytes')
{
  const base = `function a() { return 1 }\n\nfunction b() { return 2 }\n`
  const x = `function a() { return 10 }\n\nfunction b() { return 2 }\n`
  const y = `function a() { return 1 }\n\nfunction b() { return 20 }\n`
  assert('M(base,x,y) === M(base,y,x)', auto(base, x, y) === auto(base, y, x))
}

console.log('\n# Two peers, concurrent edits â†’ converge to one text and stay there')
{
  // Both peers fork from base, edit different functions, then run the reconcile loop.
  let base = `function a() { return 1 }\n\nfunction b() { return 2 }\n\nfunction c() { return 3 }\n`
  let A = `function a() { return 100 }\n\nfunction b() { return 2 }\n\nfunction c() { return 3 }\n`
  let B = `function a() { return 1 }\n\nfunction b() { return 200 }\n\nfunction c() { return 3 }\n`
  let rounds = 0
  while (A !== B && rounds < 8) {
    const A2 = auto(base, A, B), B2 = auto(base, B, A)
    if (A2 === null || B2 === null) break
    base = A2 // base advances to the agreed merge
    A = A2; B = B2
    rounds++
  }
  assert('peers converged', A === B && A !== null)
  assert('converged fast (<= 2 rounds)', rounds <= 2)
  assert('both edits survived', /return 100/.test(A) && /return 200/.test(A))
  assert('re-merge is stable (fixed point reached)', auto(A, A, A) === A)
}

console.log('\n# The routes scenario that broke the live test before â€” now converges cleanly')
{
  const B0 = `const routes = {\n}\n\nmodule.exports = routes\n`
  const A1 = `const routes = {\n  '/login': (req, res) => res.end('in'),\n}\n\nmodule.exports = routes\n`
  const B1 = `const routes = {\n  '/signup': (req, res) => res.end('up'),\n}\n\nmodule.exports = routes\n`
  // Both peers merge the concurrent route additions.
  const Ta = auto(B0, A1, B1), Tb = auto(B0, B1, A1)
  assert('both peers compute the same merge', Ta !== null && Ta === Tb)
  assert('both routes present', /\/login/.test(Ta) && /\/signup/.test(Ta))
  assert('module.exports appears exactly once (no duplication)', (Ta.match(/module\.exports/g) || []).length === 1)
  assert('the object literal is intact (closing brace present)', /\}\s*\n*\s*module\.exports/.test(Ta))
  assert('result parses', M(B0, A1, B1).status === 'auto')
  // A third edit builds on the merged result and still converges.
  const W = Ta.replace("module.exports = routes", "const extra = 1\nmodule.exports = routes")
  const T2 = auto(Ta, W, Ta)
  assert('third edit absorbed (one-sided), no churn', T2 === W)
}

console.log('\n# Random multi-round simulation: many concurrent-edit pairs all converge')
{
  const rand = (n) => Math.floor(Math.random() * n)
  const names = ['a', 'b', 'c', 'd', 'e']
  const mkFile = () => names.slice(0, 2 + rand(3)).map((n) => `function ${n}() { return ${rand(20)} }`).join('\n\n') + '\n'
  const edit = (src) => rand(2) ? src.replace(/return \d+/, 'return ' + rand(99)) : src + `\nfunction z${rand(50)}() { return 1 }\n`
  let diverged = 0, converged = 0
  for (let t = 0; t < 1500; t++) {
    let base = mkFile()
    let A = edit(base), B = edit(base)
    let rounds = 0, ok = true
    while (A !== B && rounds < 8) {
      const A2 = auto(base, A, B), B2 = auto(base, B, A)
      if (A2 === null || B2 === null) { ok = false; break } // conflict/fallback â†’ line-merge territory
      base = A2; A = A2; B = B2; rounds++
    }
    if (!ok) continue
    if (A === B) converged++; else { diverged++; if (diverged <= 3) console.log('  DIVERGED:\n' + JSON.stringify({ A, B })) }
  }
  assert(`all auto-merge pairs converged (converged=${converged}, diverged=${diverged})`, diverged === 0)
}

console.log(`\n=== ${failed === 0 ? 'CONVERGENCE HELD' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
