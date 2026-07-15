// Randomized metamorphic fuzz for the NON-JS providers (python, java, go, ruby, json):
// for every trial the engine must hold the same invariants the JS provider is held to —
//   FIXED POINT   M(base, T, T) === T
//   SYMMETRY      M(base, a, b) equals M(base, b, a) (status; and text when auto)
//   GUARANTEE     an 'auto' result parses (per the provider's own oracle)
//   NO-LOSS       disjoint-unit edits merge with BOTH sides' unique markers present
//   HONESTY       same-unit value clashes are conflicts, not silent winners
import { structuralMerge, languageFor } from '../icr.js'

let pass = 0, fail = 0, checked = 0
const T = (n, c) => { if (!c) { console.log(`  FAIL ${n}`); fail++ } else pass++ }

// deterministic PRNG
function mulberry32(seed) { return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

const GEN = {
  'x.py': { unit: (i, v) => `def f${i}(x):\n    return x + ${v}\n`, join: '\n' },
  'App.java': { unit: (i, v) => `int f${i}(int x) { return x + ${v}; }\n`, join: '\n' },
  'main.go': { unit: (i, v) => `func f${i}(x int) int {\n\treturn x + ${v}\n}\n`, join: '\n' },
  'x.rb': { unit: (i, v) => `def f${i}(x)\n  x + ${v}\nend\n`, join: '\n' },
}

for (const [filename, g] of Object.entries(GEN)) {
  const lang = languageFor(filename)
  const rnd = mulberry32(424242)
  for (let t = 0; t < 60; t++) {
    const k = 3 + Math.floor(rnd() * 3)
    const vals = Array.from({ length: k }, () => 100 + Math.floor(rnd() * 900))
    const base = vals.map((v, i) => g.unit(i, v)).join(g.join)
    // each side changes ONE unit's value to a unique marker (or adds a new unit)
    const mkEdit = (marker) => {
      if (rnd() < 0.25) return { add: true, text: g.unit(k + Math.floor(rnd() * 50) + 1, marker), marker }
      const u = Math.floor(rnd() * k)
      return { unit: u, text: base.replace(`+ ${vals[u]}`, `+ ${marker}`), marker }
    }
    const eA = mkEdit(111111 + t), eB = mkEdit(222222 + t)
    const a = eA.add ? base + g.join + eA.text : eA.text
    const b = eB.add ? base + g.join + eB.text : eB.text

    const fp = structuralMerge(base, a, a, { filename })
    T(`${lang.id} t${t} fixed point`, fp.status === 'auto' && fp.text === a)

    const r1 = structuralMerge(base, a, b, { filename })
    const r2 = structuralMerge(base, b, a, { filename })
    T(`${lang.id} t${t} symmetric status`, r1.status === r2.status)
    if (r1.status === 'auto') {
      T(`${lang.id} t${t} symmetric text`, r1.text === r2.text)
      T(`${lang.id} t${t} guarantee (parses)`, lang.parses(r1.text))
    }
    const sameUnit = !eA.add && !eB.add && eA.unit === eB.unit
    if (sameUnit) {
      T(`${lang.id} t${t} same-unit clash is HONEST (conflict, no silent winner)`, r1.status !== 'auto' || (r1.text.includes(`${eA.marker}`) && r1.text.includes(`${eB.marker}`)))
    } else {
      T(`${lang.id} t${t} no-loss (both markers present)`, r1.status === 'auto' && r1.text.includes(`${eA.marker}`) && r1.text.includes(`${eB.marker}`))
    }
    checked++
  }
}

// JSON: disjoint leaf edits merge (valid output); same-leaf edits conflict
{
  const rnd = mulberry32(777)
  for (let t = 0; t < 60; t++) {
    const obj = {}
    const K = 4
    for (let i = 0; i < K; i++) obj['k' + i] = { a: 100 + Math.floor(rnd() * 900), b: 100 + Math.floor(rnd() * 900) }
    const base = JSON.stringify(obj, null, 2) + '\n'
    const pick = () => ['k' + Math.floor(rnd() * K), rnd() < 0.5 ? 'a' : 'b']
    const [ka, fa] = pick(), [kb, fb] = pick()
    const oa = JSON.parse(base); oa[ka][fa] = 111111 + t
    const ob = JSON.parse(base); ob[kb][fb] = 222222 + t
    const a = JSON.stringify(oa, null, 2) + '\n', b = JSON.stringify(ob, null, 2) + '\n'
    const r1 = structuralMerge(base, a, b, { filename: 'p.json' })
    const r2 = structuralMerge(base, b, a, { filename: 'p.json' })
    T(`json t${t} symmetric status`, r1.status === r2.status)
    if (ka === kb && fa === fb) {
      T(`json t${t} same-path clash conflicts`, r1.status === 'semantic-conflict' && r1.conflicts.includes(`${ka}.${fa}`))
    } else {
      const ok = r1.status === 'auto' && r1.text === r2.text && (() => { try { const m = JSON.parse(r1.text); return m[ka][fa] === 111111 + t && m[kb][fb] === 222222 + t } catch { return false } })()
      T(`json t${t} disjoint paths merge, valid, both values`, ok)
    }
    checked++
  }
}

console.log(`\n=== MULTILANG-FUZZ: ${fail === 0 ? `ALL PASS (${pass} assertions across ${checked} trials)` : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
