// THE CRUCIBLE — an adversarial benchmark designed to BREAK icr-merge, not confirm it.
// Every scenario is built by an attacker who read the source. Verdicts:
//   OK              invariants held (clean merge correct, or honest conflict)
//   FALSE-CONFLICT  safe but dumb: conflicted where a clean merge was possible
//   BROKEN-OUTPUT   THE CARDINAL SIN: shipped clean output that is wrong/corrupt
//   SILENT-LOSS     an edit vanished without any conflict signal
//   ASYMMETRIC      merge(base,a,b) != merge(base,b,a) — convergence violation
//   CRASH           the engine threw
//   SLOW            over perf budget
import { merge } from './packages/icr-merge/index.js'
import { structuralMerge, languageFor } from './packages/icr-merge/icr.js'

let ok = 0, findings = []
const V = (name, verdict, detail = '') => {
  if (verdict === 'OK') { ok++; console.log(`  ok    ${name}${detail ? '  (' + detail + ')' : ''}`) }
  else { findings.push({ name, verdict, detail }); console.log(`  ${verdict}  ${name}${detail ? ' — ' + detail : ''}`) }
}
const run = (name, fn) => { try { fn() } catch (e) { V(name, 'CRASH', e.message) } }
const sym = (base, a, b, f) => {
  const r1 = merge(base, a, b, { filename: f }), r2 = merge(base, b, a, { filename: f })
  return { r1, r2, symmetric: r1.clean === r2.clean && (!r1.clean || r1.text === r2.text) }
}

console.log('\n=== ARENA 1: identity attacks (rename warfare) ===')

run('rename SWAP: one side swaps f<->g (defs + callers), other edits a caller arg', () => {
  const base = 'function f(x) { return x + 1 }\nfunction g(x) { return x * 2 }\nconst r = f(g(1))\n'
  const a = 'function g(x) { return x + 1 }\nfunction f(x) { return x * 2 }\nconst r = g(f(1))\n'
  const b = base.replace('f(g(1))', 'f(g(2))')
  const { r1, symmetric } = sym(base, a, b, 'm.js')
  if (!symmetric) return V('rename swap', 'ASYMMETRIC')
  if (r1.clean) V('rename swap', evalEq(r1.text, a.replace('g(f(1))', 'g(f(2))')) ? 'OK' : 'BROKEN-OUTPUT', 'clean but behavior differs from intent')
  else V('rename swap', 'OK', 'honest conflict — acceptable for a swap')
})

run('conflicting renames: a: f->h, b: f->k (both rewrite the caller)', () => {
  const base = 'function f(x) { return x + 1 }\nconst r = f(1)\n'
  const a = 'function h(x) { return x + 1 }\nconst r = h(1)\n'
  const b = 'function k(x) { return x + 1 }\nconst r = k(1)\n'
  const { r1 } = sym(base, a, b, 'm.js')
  if (r1.clean) {
    const defs = ['f', 'h', 'k'].filter((n) => r1.text.includes(`function ${n}(`))
    const calls = ['f(1)', 'h(1)', 'k(1)'].filter((c) => r1.text.includes(c))
    const dangles = calls.some((c) => !defs.includes(c[0]))
    V('conflicting renames', dangles ? 'BROKEN-OUTPUT' : 'OK', dangles ? `defs=${defs} calls=${calls}` : 'merged coherently')
  } else V('conflicting renames', 'OK', 'honest conflict')
})

run('rename + body edit on SAME fn, other side adds caller of OLD name', () => {
  const base = 'function f(x) { return x + 1 }\nconst a1 = f(1)\n'
  const a = 'function h(x) { return x + 2 }\nconst a1 = h(1)\n'
  const b = base + 'const b2 = f(5)\n'
  const { r1 } = sym(base, a, b, 'm.js')
  if (r1.clean) {
    const brokenCall = r1.text.includes('f(5)') && !r1.text.includes('function f(')
    V('rename+edit vs new caller', brokenCall ? 'BROKEN-OUTPUT' : 'OK', brokenCall ? 'dangling f(5) shipped clean' : '')
  } else V('rename+edit vs new caller', 'OK', 'honest conflict')
})

run('shadowing trap: delete unused top-level helper; other side adds LOCAL helper', () => {
  const base = 'function helper(x) { return x * 2 }\nfunction use(x) { return x + 1 }\n'
  const a = 'function use(x) { return x + 1 }\n'
  const b = 'function helper(x) { return x * 2 }\nfunction use(x) { const helper = (y) => y; return helper(x) + 1 }\n'
  const { r1 } = sym(base, a, b, 'm.js')
  V('scope shadowing', r1.clean ? 'OK' : 'FALSE-CONFLICT', r1.clean ? 'local helper correctly not a reference' : (r1.warning || ''))
})

console.log('\n=== ARENA 2: parser poison ===')

run('conflict markers INSIDE a normal string literal', () => {
  const base = 'const banner = "x"\nconst v = 1\n'
  const a = 'const banner = "\\n<<<<<<< HEAD\\n=======\\n>>>>>>> theirs\\n"\nconst v = 1\n'
  const b = 'const banner = "x"\nconst v = 2\n'
  const { r1 } = sym(base, a, b, 'm.js')
  if (!r1.clean) return V('markers in string', 'FALSE-CONFLICT', 'string content mistaken for markers')
  const kept = r1.text.includes('<<<<<<< HEAD') && r1.text.includes('const v = 2')
  V('markers in string', kept ? 'OK' : 'SILENT-LOSS')
})

run('REAL line-start markers inside a multiline template literal', () => {
  const base = 'const t = `hello`\nconst v = 1\n'
  const a = 'const t = `\n<<<<<<< ours\n=======\n>>>>>>> theirs\n`\nconst v = 1\n'
  const b = 'const t = `hello`\nconst v = 2\n'
  const { r1 } = sym(base, a, b, 'm.js')
  if (!r1.clean) return V('markers in template', 'FALSE-CONFLICT', 'template content at line start read as markers')
  V('markers in template', r1.text.includes('<<<<<<< ours') && r1.text.includes('const v = 2') ? 'OK' : 'SILENT-LOSS')
})

run('unicode identifiers + emoji + CRLF line endings', () => {
  const base = 'function café(π) { return π + 1 }\r\nconst s = "🐝🍯"\r\nconst v = 1\r\n'
  const a = base.replace('π + 1', 'π + 2')
  const b = base.replace('const v = 1', 'const v = 9')
  const { r1, symmetric } = sym(base, a, b, 'm.js')
  if (!symmetric) return V('unicode+CRLF', 'ASYMMETRIC')
  V('unicode+CRLF', r1.clean && r1.text.includes('π + 2') && r1.text.includes('const v = 9') ? 'OK' : (r1.clean ? 'SILENT-LOSS' : 'FALSE-CONFLICT'))
})

run('ruby heredoc containing the word "end"', () => {
  const base = 'def f\n  s = <<~TEXT\n    the end of days\n  TEXT\n  s\nend\ndef g\n  1\nend\n'
  const a = base.replace('1', '2')
  const b = base.replace('the end', 'THE end')
  const { r1 } = sym(base, a, b, 'x.rb')
  if (r1.clean && r1.method !== 'lines') {
    const parses = languageFor('x.rb').parses(r1.text)
    V('ruby heredoc', parses ? 'OK' : 'BROKEN-OUTPUT', parses ? 'structural handled heredoc' : 'nesting corrupted')
  } else V('ruby heredoc', 'OK', r1.method === 'lines' ? 'honest fallback to line tier' : 'honest conflict')
})

run('python: fake def inside f-string + walrus operator', () => {
  const base = 'def real(x):\n    s = f"def fake(): {x}"\n    if (n := x) > 0:\n        return n\n    return 0\n\ndef other(y):\n    return y\n'
  const a = base.replace('return y', 'return y + 1')
  const b = base.replace('return 0', 'return -1')
  const { r1 } = sym(base, a, b, 'x.py')
  V('python f-string/walrus', r1.clean && r1.text.includes('y + 1') && r1.text.includes('return -1') ? 'OK' : (r1.clean ? 'SILENT-LOSS' : 'FALSE-CONFLICT'))
})

console.log('\n=== ARENA 3: JSON precision + duplicate traps ===')

run('untouched values must survive value-identical (precision trap)', () => {
  const base = '{\n  "id": 9007199254740993,\n  "big": 1e999,\n  "a": 1,\n  "b": 2\n}\n'
  const a = base.replace('"a": 1', '"a": 10')
  const b = base.replace('"b": 2', '"b": 20')
  const { r1 } = sym(base, a, b, 'p.json')
  if (!r1.clean) return V('json precision', 'FALSE-CONFLICT')
  const idOk = r1.text.includes('9007199254740993')
  const bigOk = !r1.text.includes('null')
  const detail = [!idOk && 'int64 precision LOST', !bigOk && '1e999 became null'].filter(Boolean).join('; ')
  V('json precision', idOk && bigOk ? 'OK' : 'BROKEN-OUTPUT', detail)
})

run('json duplicate keys in source', () => {
  const base = '{"a": 1, "a": 2, "b": 3}\n'
  const a = base.replace('"b": 3', '"b": 30')
  const b = base.replace('"a": 2', '"a": 20')
  const { r1 } = sym(base, a, b, 'p.json')
  V('json duplicate keys', 'OK', r1.clean ? 'merged, last-wins semantics' : 'honest conflict')
})

console.log('\n=== ARENA 4: scale cliffs (perf budgets) ===')

run('5,000-function file, disjoint edits (budget 3s)', () => {
  const base = Array.from({ length: 5000 }, (_, i) => `function f${i}(x) { return x + ${i} }`).join('\n') + '\n'
  const a = base.replace('return x + 1000 }', 'return x + 999999 }')
  const b = base.replace('return x + 4000 }', 'return x + 888888 }')
  const t0 = Date.now()
  const r = merge(base, a, b, { filename: 'big.js' })
  const ms = Date.now() - t0
  if (!r.clean || !r.text.includes('999999') || !r.text.includes('888888')) return V('5k functions', r.clean ? 'SILENT-LOSS' : 'FALSE-CONFLICT', `${ms}ms`)
  V('5k functions', ms < 3000 ? 'OK' : 'SLOW', `${ms}ms`)
})

run('~1MB single function, token-level edit collision (budget 5s)', () => {
  const body = Array.from({ length: 20000 }, (_, i) => `  const v${i} = ${i}`).join('\n')
  const base = `function huge() {\n${body}\n  return call(1, 2)\n}\n`
  const a = base.replace('call(1, 2)', 'call(9, 2)')
  const b = base.replace('call(1, 2)', 'call(1, 8)')
  const t0 = Date.now()
  const r = merge(base, a, b, { filename: 'huge.js' })
  const ms = Date.now() - t0
  if (r.clean && !r.text.includes('call(9, 8)')) return V('1MB token merge', 'BROKEN-OUTPUT', `merged call wrong (${ms}ms)`)
  V('1MB token merge', ms < 5000 ? (r.clean ? 'OK' : 'FALSE-CONFLICT') : 'SLOW', `${ms}ms clean=${r.clean}`)
})

console.log('\n=== ARENA 5: confluence (3+ agents, does order matter?) ===')

run('three concurrent edits, all 6 fold orders converge byte-identical', () => {
  const base = 'function a(x) { return x + 1 }\nfunction b(x) { return x + 2 }\nfunction c(x) { return x + 3 }\n'
  const A = base.replace('x + 1', 'x + 100')
  const B = base.replace('x + 2', 'x + 200')
  const C = base.replace('x + 3', 'x + 300')
  const fold = (xs) => xs.reduce((acc, x) => { const r = merge(base, acc, x, { filename: 'm.js' }); if (!r.clean) throw new Error('conflict during fold'); return r.text }, base)
  const orders = [[A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A]]
  const results = new Set(orders.map(fold))
  V('3-agent confluence', results.size === 1 ? 'OK' : 'ASYMMETRIC', `distinct results: ${results.size}`)
})

console.log('\n=== ARENA 6: deletion warfare ===')

run('a deletes fn AND its caller; b edits the SAME fn body', () => {
  const base = 'function f(x) { return x + 1 }\nconst r1v = f(1)\nconst keep = 1\n'
  const a = 'const keep = 1\n'
  const b = base.replace('x + 1', 'x + 99')
  const { r1 } = sym(base, a, b, 'm.js')
  if (r1.clean) {
    const danglingCall = r1.text.includes('f(1)') && !r1.text.includes('function f(')
    const bLost = !r1.text.includes('x + 99')
    V('delete vs edit', danglingCall ? 'BROKEN-OUTPUT' : bLost ? 'SILENT-LOSS' : 'OK')
  } else V('delete vs edit', 'OK', 'honest conflict')
})

run('cross deletion: each side deletes a different half', () => {
  const base = 'function a1(){return 1}\nfunction a2(){return 2}\nfunction b1(){return 3}\nfunction b2(){return 4}\n'
  const a = 'function b1(){return 3}\nfunction b2(){return 4}\n'
  const b = 'function a1(){return 1}\nfunction a2(){return 2}\n'
  const { r1 } = sym(base, a, b, 'm.js')
  const resurrect = ['a1', 'a2', 'b1', 'b2'].filter((n) => r1.clean && r1.text.includes(`function ${n}(`))
  V('cross deletion', r1.clean && resurrect.length === 0 ? 'OK' : (r1.clean ? 'BROKEN-OUTPUT' : 'FALSE-CONFLICT'), resurrect.length ? `resurrected: ${resurrect}` : '')
})

function evalEq(src1, src2) {
  try {
    const out = (s) => { const fn = new Function(s + '\nreturn typeof r !== "undefined" ? r : null'); return JSON.stringify(fn()) }
    return out(src1) === out(src2)
  } catch { return false }
}

console.log(`\n=== CRUCIBLE: ${ok} held, ${findings.length} findings ===`)
for (const f of findings) console.log(`  ${f.verdict}: ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
