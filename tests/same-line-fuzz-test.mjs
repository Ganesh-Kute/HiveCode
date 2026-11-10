// SAME-LINE RACE FUZZ (P0-F). Both halves of the clash rule, against the real Yjs CRDT and applyDiff.
//   F1 (Opus-Cloud): when hunksClash says NO clash, the character CRDT's union of the two saves holds
//      every line either side added and no line neither wrote. The per-hunk rule failed 8,439 of 49,748.
//   F2: adjacent same-size replacements (bigproject W1's shape) are never called a clash.
//   F3 (Claude-cloud): when it says CLASH, clashFinal loses no added line, invents no line (marker lines
//      aside), and gives every peer the same text. Applying an insertion before a span at the same line
//      lost an added line in 6-14% of clashes.
//   node tests/same-line-fuzz-test.mjs        SEEDS=23,7,101 to vary
import * as Y from 'yjs'
import { applyDiff } from '../core.js'
import { intentHunks, hunksClash, clashFinal } from '../sync.js'

let pass = 0, fail = 0
const T = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c || !d ? '' : '  -- ' + d}`); c ? pass++ : fail++ }
const SEEDS = (process.env.SEEDS || '23,7,101').split(',').map(Number)
function rng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 }
const NEW = ['alpha()', 'beta = 2', 'gamma.x', 'return 0', '', 'const v']
const isMarker = (l) => /^(<<<<<<<|=======|>>>>>>>)( |$)/.test(l)
function union(base, a, b) {
  const d1 = new Y.Doc(); d1.clientID = 1; const d2 = new Y.Doc(); d2.clientID = 2
  d1.getText('t').insert(0, base); Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1))
  applyDiff(d1.getText('t'), a); applyDiff(d2.getText('t'), b)
  const u1 = Y.encodeStateAsUpdate(d1), u2 = Y.encodeStateAsUpdate(d2)
  Y.applyUpdate(d1, u2); Y.applyUpdate(d2, u1); return d1.getText('t').toString()
}
for (const seed of SEEDS) {
  const rnd = rng(seed), pick = (a) => a[Math.floor(rnd() * a.length)]
  const one = (bl) => { const x = bl.slice(), at = Math.floor(rnd() * x.length), op = pick(['set', 'del', 'ins']); if (op === 'set') x[at] = pick(NEW) + '_' + Math.floor(rnd() * 99); else if (op === 'del') x.splice(at, 1); else x.splice(at, 0, pick(NEW) + '_' + Math.floor(rnd() * 99)); return x }
  let noClash = 0, damaged = 0, w1 = 0, w1Clash = 0, groups = 0, lost = 0, invented = 0, differ = 0, ex = ''
  for (let t = 0; t < 20000; t++) {
    const bl = Array.from({ length: 4 + Math.floor(rnd() * 8) }, (_, i) => rnd() < 0.3 ? '' : `const v${i} = ${i * 7}`)
    const base = bl.join('\n') + '\n'
    const k = rnd() < 0.25 ? 3 : 2
    const sides = []
    for (let s = 0; s < k; s++) { let x = one(bl); if (rnd() < 0.4) x = one(x); sides.push(x) }
    const texts = sides.map((x) => x.join('\n') + '\n')
    if (texts.some((x) => x === base) || texts[0] === texts[1]) continue
    const hs = texts.map((x) => intentHunks(base, x))
    if (hs.some((h) => !h)) continue
    const known = new Set([...bl, ...sides.flat(), ''])
    // F1, F2: pairs
    if (!hunksClash(hs[0], hs[1])) {
      noClash++
      const u = union(base, texts[0], texts[1]).split('\n')
      const bad = u.some((l) => !known.has(l)) || [...sides[0], ...sides[1]].filter((l) => !bl.includes(l)).some((l) => !u.includes(l))
      if (bad) { damaged++; if (!ex) ex = JSON.stringify({ base, a: texts[0], b: texts[1], u: u.join('\n') }) }
    }
    const rep = (h) => h.length === 1 && h[0][1] - h[0][0] === h[0][2].length && h[0][2].length > 0
    if (rep(hs[0]) && rep(hs[1]) && (hs[0][0][1] === hs[1][0][0] || hs[1][0][1] === hs[0][0][0])) { w1++; if (hunksClash(hs[0], hs[1])) w1Clash++ }
    // F3: groups where every member clashes with the first
    if (hs.slice(1).every((h) => hunksClash(hs[0], h))) {
      groups++
      const ids = [11, 7, 23].slice(0, k)
      const g = new Map(ids.map((id, i) => [id, hs[i]]))
      const f = clashFinal(base, g), f2 = clashFinal(base, new Map([...g].reverse()))
      if (f !== f2) differ++
      const fl = f.split('\n')
      if (fl.some((l) => !isMarker(l) && !known.has(l))) invented++
      if (sides.some((x) => x.some((l) => !bl.includes(l) && !fl.includes(l)))) lost++
    }
  }
  console.log(`# seed ${seed}: ${noClash} no-clash pairs, ${w1} W1-shape pairs, ${groups} clash groups`)
  T(`seed ${seed} F1 no "no clash" pair is damaged by the CRDT`, damaged === 0, `${damaged}; ${ex}`)
  T(`seed ${seed} F2 the W1 shape is never a clash`, w1 > 0 && w1Clash === 0, `${w1Clash} of ${w1}`)
  T(`seed ${seed} F3 clashFinal loses no added line`, groups > 0 && lost === 0, `${lost}`)
  T(`seed ${seed} F3 clashFinal invents no line`, invented === 0, `${invented}`)
  T(`seed ${seed} F3 every peer computes the same text`, differ === 0, `${differ}`)
}
console.log(`\n=== SAME-LINE FUZZ: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
