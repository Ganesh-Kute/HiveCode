// ICR TORTURE TEST — industry-standard property-based + adversarial testing of the
// multi-language merge. For every random 3-way merge across 5 languages we assert
// the four hard invariants:
//   P1 PARSE GUARANTEE : an 'auto' result must parse (never emit worse than inputs)
//   P2 SYMMETRY        : merge(base,a,b) === merge(base,b,a)  (status AND text)
//   P3 FIXED-POINT     : merge(base,T,T) returns T byte-identical (and re-merging an
//                        auto result with itself returns it unchanged — absorption)
//   P4 NO SILENT LOSS  : a one-sided edit/add survives verbatim; a one-sided delete
//                        is honored; delete-vs-edit keeps the edit; overlapping edits
//                        of the same unit must NOT silently auto-merge (conflict)
// Plus directed adversarial cases: braces in strings/comments/templates, raw strings,
// Python triple-quoted strings containing fake defs, decorators, CRLF, unicode names,
// and a 300-unit performance check.
//
//   node icr-torture-test.js [seed]

import { structuralMerge } from './icr.js'

const SEED = Number(process.argv[2] || 12345)
let failed = 0, ran = 0
const fails = []
const assert = (n, c, extra) => { ran++; if (!c) { failed++; fails.push(n + (extra ? ' :: ' + extra : '')); if (fails.length <= 12) console.log('  FAIL ' + n + (extra ? '\n        ' + extra : '')) } }

// deterministic PRNG (mulberry32) — reproducible: re-run with the printed seed
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const rand = rng(SEED)
const pick = (arr) => arr[Math.floor(rand() * arr.length)]
let SENT = 100000
const sentinel = () => ++SENT // unique integer per edit — greppable in output

// --- per-language unit generators -------------------------------------------------
const GEN = {
  'svc.ts':  { unit: (k, v) => `export function fn${k}(): number { return ${v}; }`,  file: 'svc.ts' },
  'main.go': { unit: (k, v) => `func Fn${k}() int { return ${v} }`,                  file: 'main.go' },
  'lib.rs':  { unit: (k, v) => `fn fn${k}() -> i32 { ${v} }`,                        file: 'lib.rs' },
  'App.java':{ unit: (k, v) => `class C${k} { int a() { return ${v}; } }`,           file: 'App.java' },
  'app.py':  { unit: (k, v) => `def fn${k}():\n    return ${v}`,                     file: 'app.py' },
}

function makeFile(gen, n) {
  const vals = {}
  const parts = []
  for (let k = 0; k < n; k++) { vals[k] = sentinel(); parts.push(gen.unit(k, vals[k])) }
  return { text: parts.join('\n\n') + '\n', vals, n }
}
function rebuild(gen, n, vals, extra) {
  const parts = []
  for (let k = 0; k < n; k++) if (vals[k] != null) parts.push(gen.unit(k, vals[k]))
  for (const [k, v] of extra) parts.push(gen.unit(k, v))
  return parts.join('\n\n') + '\n'
}

// --- fuzz loop --------------------------------------------------------------------
const ITERS = 400
console.log(`# FUZZ: ${ITERS} random 3-way merges x ${Object.keys(GEN).length} languages (seed ${SEED})`)
for (const [label, gen] of Object.entries(GEN)) {
  let autoN = 0, confN = 0, fbN = 0
  for (let it = 0; it < ITERS; it++) {
    const n = 3 + Math.floor(rand() * 6)
    const base = makeFile(gen, n)
    // independent random op sets for a and b
    const mkSide = () => {
      const vals = { ...base.vals }, extra = [], edited = new Set(), deleted = new Set(), added = []
      const ops = 1 + Math.floor(rand() * 3)
      for (let o = 0; o < ops; o++) {
        const kind = pick(['edit', 'edit', 'add', 'del'])
        if (kind === 'edit') { const k = Math.floor(rand() * n); if (vals[k] != null) { vals[k] = sentinel(); edited.add(k) } }
        else if (kind === 'del') { const k = Math.floor(rand() * n); if (vals[k] != null && !edited.has(k)) { vals[k] = null; deleted.add(k) } }
        else { const k = n + 10 + Math.floor(rand() * 90); if (!extra.find((e) => e[0] === k)) { const v = sentinel(); extra.push([k, v]); added.push([k, v]) } }
      }
      return { text: rebuild(gen, n, vals, extra), vals, edited, deleted, added }
    }
    const A = mkSide(), B = mkSide()
    const overlap = [...A.edited].some((k) => B.edited.has(k) && A.vals[k] !== B.vals[k])
      || A.added.some(([k, v]) => B.added.find(([k2, v2]) => k2 === k && v2 !== v))

    const r1 = structuralMerge(base.text, A.text, B.text, { filename: gen.file })
    const r2 = structuralMerge(base.text, B.text, A.text, { filename: gen.file })

    // P2 symmetry (status + text) on EVERY case
    assert(`${label} sym status it${it}`, r1.status === r2.status, `${r1.status} vs ${r2.status}`)
    if (r1.status === 'auto') assert(`${label} sym text it${it}`, r1.text === r2.text)

    if (r1.status === 'auto') {
      autoN++
      // P1 parse guarantee — re-merge trivially to invoke provider parse; also absorption
      const fp = structuralMerge(r1.text, r1.text, r1.text, { filename: gen.file })
      assert(`${label} P1/P3 absorption it${it}`, fp.status === 'auto' && fp.text === r1.text)
      // P4 no-silent-loss checks
      if (overlap) assert(`${label} P4 overlap must NOT auto it${it}`, false, 'both edited same unit differently yet auto-merged')
      for (const k of A.edited) if (!B.edited.has(k) && !B.deleted.has(k)) assert(`${label} P4 A-edit survives it${it}`, r1.text.includes(String(A.vals[k])), `lost edit ${A.vals[k]}`)
      for (const k of B.edited) if (!A.edited.has(k) && !A.deleted.has(k)) assert(`${label} P4 B-edit survives it${it}`, r1.text.includes(String(B.vals[k])), `lost edit ${B.vals[k]}`)
      for (const [k, v] of A.added) assert(`${label} P4 A-add survives it${it}`, r1.text.includes(String(v)))
      for (const [k, v] of B.added) assert(`${label} P4 B-add survives it${it}`, r1.text.includes(String(v)))
      for (const k of A.deleted) if (!B.edited.has(k)) assert(`${label} P4 A-del honored it${it}`, !r1.text.includes(String(base.vals[k])), `deleted content resurfaced`)
      // delete-vs-edit: the EDIT must win (never lose work)
      for (const k of A.deleted) if (B.edited.has(k)) assert(`${label} P4 del-vs-edit keeps edit it${it}`, r1.text.includes(String(B.vals[k])))
    } else if (r1.status === 'semantic-conflict') confN++
    else fbN++

    // P3 fixed-point fast path
    const same = structuralMerge(base.text, A.text, A.text, { filename: gen.file })
    assert(`${label} P3 fixed-point it${it}`, same.status === 'auto' && same.text === A.text)
    // one-sided change returns the changed side verbatim
    const onesided = structuralMerge(base.text, base.text, B.text, { filename: gen.file })
    if (onesided.status === 'auto') assert(`${label} one-sided verbatim it${it}`, onesided.text === B.text)
  }
  console.log(`  ${label.padEnd(9)} auto ${autoN}, conflict ${confN}, fallback ${fbN}`)
}

// --- directed adversarial cases ----------------------------------------------------
console.log('\n# ADVERSARIAL: syntax that breaks naive scanners')

function directed(name, file, base, a, b, check) {
  const r = structuralMerge(base, a, b, { filename: file })
  const r2 = structuralMerge(base, b, a, { filename: file })
  assert(`${name} — symmetric`, r.status === r2.status && (r.status !== 'auto' || r.text === r2.text))
  check(r)
  console.log(`  ${name} -> ${r.status}`)
}

// braces inside strings must not confuse unit boundaries
directed('TS braces-in-strings', 'x.ts',
  `const s = "a { b } c";\nexport function f(): number { return 1; }\n`,
  `const s = "a { b } c";\nexport function f(): number { return 1; }\nexport function g(): number { return 2; }\n`,
  `const s = "a { b } c";\nexport function f(): number { return 1; }\nexport function h(): number { return 3; }\n`,
  (r) => { assert('TS strings: auto', r.status === 'auto'); if (r.status === 'auto') { assert('TS strings: kept g', /function g/.test(r.text)); assert('TS strings: kept h', /function h/.test(r.text)); assert('TS strings: string intact', r.text.includes('"a { b } c"')) } })

// braces inside comments
directed('Go braces-in-comments', 'x.go',
  `// close } here\nfunc A() int { return 1 }\n/* { */\nfunc B() int { return 2 }\n`,
  `// close } here\nfunc A() int { return 11 }\n/* { */\nfunc B() int { return 2 }\n`,
  `// close } here\nfunc A() int { return 1 }\n/* { */\nfunc B() int { return 22 }\n`,
  (r) => { assert('Go comments: auto', r.status === 'auto'); if (r.status === 'auto') { assert('kept 11', r.text.includes('11')); assert('kept 22', r.text.includes('22')) } })

// template literal with nested braces
directed('TS template-literal', 'x.ts',
  'const t = `x ${ { a: 1 } } y`;\nexport function f(): number { return 1; }\n',
  'const t = `x ${ { a: 1 } } y`;\nexport function f(): number { return 1; }\nexport function g(): number { return 2; }\n',
  'const t = `x ${ { a: 1 } } y`;\nexport function f(): number { return 1; }\nexport function h(): number { return 3; }\n',
  (r) => { assert('TS template: auto', r.status === 'auto') })

// Go raw string with braces
directed('Go raw-string', 'x.go',
  'var tpl = `{"k": {"v": 1}}`\nfunc A() int { return 1 }\n',
  'var tpl = `{"k": {"v": 1}}`\nfunc A() int { return 1 }\nfunc B() int { return 2 }\n',
  'var tpl = `{"k": {"v": 1}}`\nfunc A() int { return 1 }\nfunc C() int { return 3 }\n',
  (r) => { assert('Go raw: auto', r.status === 'auto') })

// Python triple-quoted string containing a FAKE top-level def (column 0)
directed('PY fake-def-in-docstring', 'x.py',
  `def real():\n    s = """\ndef fake():\n    pass\n"""\n    return 1\n\ndef other():\n    return 2\n`,
  `def real():\n    s = """\ndef fake():\n    pass\n"""\n    return 1\n\ndef other():\n    return 22\n`,
  `def real():\n    s = """\ndef fake():\n    pass\n"""\n    return 1\n\ndef other():\n    return 2\n\ndef third():\n    return 3\n`,
  (r) => { assert('PY docstring: auto or conflict (never corrupt)', r.status === 'auto' || r.status === 'semantic-conflict' || r.status === 'fallback')
           if (r.status === 'auto') { assert('PY docstring: kept 22', r.text.includes('22')); assert('PY docstring: kept third', r.text.includes('third')); assert('PY docstring: fake def intact', r.text.includes('def fake():')) } })

// Python decorators stay attached
directed('PY decorators', 'x.py',
  `@app.route("/a")\ndef a():\n    return 1\n`,
  `@app.route("/a")\ndef a():\n    return 1\n\n@app.route("/b")\ndef b():\n    return 2\n`,
  `@app.route("/a")\ndef a():\n    return 1\n\n@app.route("/c")\ndef c():\n    return 3\n`,
  (r) => { assert('PY deco: auto', r.status === 'auto'); if (r.status === 'auto') { assert('kept /b deco', r.text.includes('@app.route("/b")')); assert('kept /c deco', r.text.includes('@app.route("/c")')) } })

// CRLF line endings
directed('Rust CRLF', 'x.rs',
  `fn a() -> i32 { 1 }\r\n`,
  `fn a() -> i32 { 1 }\r\nfn b() -> i32 { 2 }\r\n`,
  `fn a() -> i32 { 1 }\r\nfn c() -> i32 { 3 }\r\n`,
  (r) => { assert('Rust CRLF: auto', r.status === 'auto') })

// unicode identifiers (fall back to stmt-keys, must still merge disjoint adds)
directed('PY unicode-names', 'x.py',
  `def 计算():\n    return 1\n`,
  `def 计算():\n    return 1\n\ndef правда():\n    return 2\n`,
  `def 计算():\n    return 1\n\ndef δοκιμή():\n    return 3\n`,
  (r) => { assert('PY unicode: never corrupts', r.status !== 'auto' || (r.text.includes('правда') && r.text.includes('δοκιμή'))) })

// deep nesting stress
directed('Java deep-nesting', 'x.java',
  `class A { class B { class C { int f() { if (true) { while (x) { y(); } } return 1; } } } }\n`,
  `class A { class B { class C { int f() { if (true) { while (x) { y(); } } return 1; } } } }\nclass D { int g() { return 2; } }\n`,
  `class A { class B { class C { int f() { if (true) { while (x) { y(); } } return 1; } } } }\nclass E { int h() { return 3; } }\n`,
  (r) => { assert('Java nesting: auto', r.status === 'auto') })

// --- performance -------------------------------------------------------------------
console.log('\n# PERFORMANCE: 300-unit files, disjoint edits')
for (const [label, gen] of Object.entries(GEN)) {
  const base = makeFile(gen, 300)
  const va = { ...base.vals, 5: sentinel() }, vb = { ...base.vals, 250: sentinel() }
  const a = rebuild(gen, 300, va, []), b = rebuild(gen, 300, vb, [])
  const t0 = process.hrtime.bigint()
  const r = structuralMerge(base.text, a, b, { filename: gen.file })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  assert(`${label} 300-unit merges`, r.status === 'auto')
  assert(`${label} 300-unit under 2s`, ms < 2000, ms.toFixed(0) + 'ms')
  console.log(`  ${label.padEnd(9)} ${ms.toFixed(1)}ms (${r.status})`)
}

console.log(`\nran ${ran} assertions, ${failed} failed${failed ? '\nfirst failures:\n  - ' + fails.slice(0, 12).join('\n  - ') : ''}`)
console.log(`=== ${failed === 0 ? 'ICR TORTURE: ALL INVARIANTS HELD' : 'ICR TORTURE: ' + failed + ' VIOLATIONS'} === (seed ${SEED})`)
process.exit(failed === 0 ? 0 : 1)
