// tests/same-line-intent-unit-test.mjs -- the pure functions behind the same-line race fix (P0-F).
//
//   node tests/same-line-intent-unit-test.mjs
//
// docs/rules-rewrite/p0f-design.md. Each save records its INTENT (the line hunks it changed, from the
// text it was made from). From two or more intents made from the same text, every peer decides alone
// and identically: do they clash, and if so, what the file should say. These rows pin those decisions.
//
// The C rows hold the rule to what really happens. Two real Y.Docs share a base; each side's save goes
// through the real applyDiff, exactly as reconcile publishes it; the two updates are exchanged. The
// union is what every folder would hold. "No clash" is only safe if that union is the clean merge of
// both edits, with no line that neither side wrote.
//
//   IH  intentHunks / applyIntent: an intent reproduces its save exactly
//   HC  hunksClash, the named edges: same line, adjacent lines, inside a span, the same point
//   C   hunksClash against the real CRDT: every "no clash" pair merges cleanly
//   CR  clashRegion: the clash is framed by the same untouched lines in every version
//   CF  clashFinal: one block, every version once, the same bytes on every peer
//   CU  clashUnion: every peer rebuilds the real union from the intents alone
//   CO  clashOnlyRegion: the resolution may replace the union, never a later edit
//   K   KNOWN, not a failure: intents made from different texts are not compared

import * as Y from 'yjs'
import { applyDiff } from '../core.js'
import * as SYNC from '../sync.js'
const { intentHunks, applyIntent, hunksClash, clashRegion, clashFinal, clashOnlyRegion } = SYNC

let pass = 0, fail = 0
const T = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) } }
const KNOWN = (name, detail) => console.log(`  KNOWN ${name}  -- ${detail}`)
const sec = (s) => console.log(`\n# ${s}`)
const J = (x) => JSON.stringify(x)
const lines = (...l) => l.join('\n') + '\n'

// What every folder holds after two saves from `base` cross on the wire (Yjs client ids ca, cb).
function union(base, a, b, ca = 1, cb = 2) {
  const d1 = new Y.Doc(); d1.clientID = ca
  const d2 = new Y.Doc(); d2.clientID = cb
  d1.getText('t').insert(0, base); Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1))
  applyDiff(d1.getText('t'), a); applyDiff(d2.getText('t'), b)
  const u1 = Y.encodeStateAsUpdate(d1), u2 = Y.encodeStateAsUpdate(d2)
  Y.applyUpdate(d1, u2); Y.applyUpdate(d2, u1)
  return d1.getText('t').toString()
}
// A union is clean when it holds no line neither side wrote and drops no line either side added.
function clean(base, a, b, u) {
  const bl = base.split('\n'), al = a.split('\n'), blb = b.split('\n'), ul = u.split('\n')
  const known = new Set([...bl, ...al, ...blb])
  if (ul.some((l) => !known.has(l))) return false
  return [...al, ...blb].filter((l) => !bl.includes(l)).every((l) => ul.includes(l))
}
let seed = Number(process.env.SEED) || 20261109
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const pick = (a) => a[Math.floor(rnd() * a.length)]
const NEW = ['alpha()', 'beta = 2', 'gamma.x', 'return 0', '', 'const v']
const oneEdit = (bl) => {
  const x = bl.slice(), at = Math.floor(rnd() * x.length), op = pick(['set', 'del', 'ins'])
  const v = `${pick(NEW)}_${Math.floor(rnd() * 99)}`
  if (op === 'set') x[at] = v; else if (op === 'del') x.splice(at, 1); else x.splice(at, 0, v)
  return x
}
const codeBase = (n) => Array.from({ length: n }, (_, i) => (rnd() < 0.25 ? '' : `const v${i} = ${i * 7}`))

const B7 = lines('l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6')
const edit = (base, at, v) => { const x = base.split('\n'); if (v === null) x.splice(at, 1); else x[at] = v; return x.join('\n') }
const insertAt = (base, at, v) => { const x = base.split('\n'); x.splice(at, 0, v); return x.join('\n') }
const H = (base, next) => intentHunks(base, next)

sec('IH intentHunks / applyIntent')
{
  let bad = null, n = 0
  for (let t = 0; t < 600; t++) {
    const bl = codeBase(3 + Math.floor(rnd() * 9)), base = bl.join('\n') + '\n'
    let nl = oneEdit(bl); if (rnd() < 0.5) nl = oneEdit(nl)
    const next = nl.join('\n') + (rnd() < 0.8 ? '\n' : '')
    const h = intentHunks(base, next); n++
    if (!h || applyIntent(base, h) !== next) { bad = { base, next, h }; break }
  }
  T('IH1 applyIntent(base, intentHunks(base, next)) === next, 600 random saves', !bad, bad && J(bad))
  T('IH2 no change -> no hunks', J(intentHunks(B7, B7)) === '[]')
  const h = intentHunks(B7, edit(B7, 2, 'X'))
  T('IH3 one changed line -> one hunk [2,3,["X"]]', J(h) === J([[2, 3, ['X']]]), J(h))
  T('IH4 a deleted line -> [3,4,[]]', J(intentHunks(B7, edit(B7, 3, null))) === J([[3, 4, []]]))
  T('IH5 an inserted line -> [2,2,["N"]]', J(intentHunks(B7, insertAt(B7, 2, 'N'))) === J([[2, 2, ['N']]]))
  const big = Array.from({ length: 2500 }, (_, i) => `x${i}`).join('\n')
  T('IH6 more than 2000 new lines -> null (no detection, as before)', intentHunks('a\n', big) === null)
  const crlf = 'a\r\nb\r\nc\r\n'
  const hc = intentHunks(crlf, 'a\r\nB\r\nc\r\n')
  T('IH7 CRLF: the line keeps its \\r, and applyIntent rebuilds the bytes', J(hc) === J([[1, 2, ['B\r']]]) && applyIntent(crlf, hc) === 'a\r\nB\r\nc\r\n', J(hc))
}

sec('HC hunksClash: the named edges')
{
  const mon = H(lines('plan', 'ship friday', 'owner'), lines('plan', 'ship monday', 'owner'))
  const tue = H(lines('plan', 'ship friday', 'owner'), lines('plan', 'ship tuesday', 'owner'))
  T('HC1 the same line, changed by both -> clash', hunksClash(mon, tue) === true)
  T('HC2 ...and it is symmetric', hunksClash(tue, mon) === true)
  T('HC3 adjacent lines, both replaced (bigproject W1) -> no clash', hunksClash([[2, 3, ['A']]], [[3, 4, ['B']]]) === false)
  T('HC4 a line inserted strictly inside a span the other replaced -> clash', hunksClash([[3, 3, ['N']]], [[2, 5, ['R']]]) === true && hunksClash([[2, 5, ['R']]], [[3, 3, ['N']]]) === true)
  {
    // Either answer is safe (the CRDT keeps each inserted line whole); a clash must then resolve to both lines, no markers.
    const b5 = lines('a', 'b', 'c', 'd'), n5 = new Map([[1, [[2, 2, ['N']]]], [2, [[2, 2, ['M']]]]])
    const f5 = clashFinal(b5, n5)
    T('HC5 two insertions at the same point -> no clash, or a resolution keeping both lines with no markers', hunksClash(n5.get(1), n5.get(2)) === false || f5 === lines('a', 'b', 'N', 'M', 'c', 'd'), J(f5))
  }
  T('HC6 far apart, one line each -> no clash', hunksClash([[1, 2, ['A']]], [[5, 6, ['B']]]) === false)
  T('HC7 spans that overlap by one line -> clash', hunksClash([[1, 4, ['A']]], [[3, 6, ['B']]]) === true)
  T('HC8 empty intents never clash', hunksClash([], [[1, 2, ['A']]]) === false)
}

sec('C hunksClash against the real CRDT (two Y.Docs, the real applyDiff)')
{
  // C1: one save changes two places; the other changes a line between them. applyDiff sends ONE span,
  // first change to last, so the union rewrites everything between them with the first save's copy.
  const a = edit(edit(B7, 1, 'A1'), 5, 'A5'), b = edit(B7, 3, 'B3')
  const u = union(B7, a, b)
  const ha = H(B7, a), hb = H(B7, b)
  T('C1 a save with two hunks around the other edit: clash, or the union is clean', hunksClash(ha, hb) || clean(B7, a, b, u), `hunks ${J(ha)} vs ${J(hb)}; union ${J(u)}`)
  // C2: a deleted line beside a replaced one, in code whose lines share a prefix: the deletion slides
  // along "const v" into its neighbour.
  const cb = lines('const v0 = 0', 'const v1 = 7', 'const v2 = 14', 'const v3 = 21', 'const v4 = 28', 'const v5 = 35')
  const a2 = edit(cb, 3, null), b2 = edit(cb, 4, 'alpha()')
  const u2 = union(cb, a2, b2)
  T('C2 a deletion touching a replaced line: clash, or the union is clean', hunksClash(H(cb, a2), H(cb, b2)) || clean(cb, a2, b2, u2), `union ${J(u2)}`)
  // C3: an insertion at the start of a span the other replaced.
  const a3 = insertAt(cb, 3, 'beta = 2'), b3 = edit(cb, 3, '_90')
  const u3 = union(cb, a3, b3)
  T('C3 an insertion at the start of a replaced line: clash, or the union is clean', hunksClash(H(cb, a3), H(cb, b3)) || clean(cb, a3, b3, u3), `union ${J(u3)}`)
  // C4: the W1 shape must stay a non-clash, and the CRDT really does merge it.
  const a4 = edit(cb, 2, 'A2'), b4 = edit(cb, 3, 'B3')
  T('C4 adjacent replacements: no clash, and the union is the clean merge', !hunksClash(H(cb, a4), H(cb, b4)) && union(cb, a4, b4) === edit(edit(cb, 2, 'A2'), 3, 'B3'))
  // C5: the property, over random pairs. Each counter-example names the pair.
  let n = 0, bad = 0, ex = null, rr = 0, rrClash = 0
  for (let t = 0; t < 8000; t++) {
    const bl = codeBase(4 + Math.floor(rnd() * 8)), base = bl.join('\n') + '\n'
    let al = oneEdit(bl); if (rnd() < 0.5) al = oneEdit(al)
    let bb = oneEdit(bl); if (rnd() < 0.3) bb = oneEdit(bb)
    const sa = al.join('\n') + '\n', sb = bb.join('\n') + '\n'
    if (sa === base || sb === base || sa === sb) continue
    const ha = H(base, sa), hb = H(base, sb)
    if (!ha || !hb) continue
    const isRep = (h) => h.length === 1 && h[0][1] > h[0][0] && h[0][1] - h[0][0] === h[0][2].length
    if (isRep(ha) && isRep(hb) && (ha[0][1] === hb[0][0] || hb[0][1] === ha[0][0])) { rr++; if (hunksClash(ha, hb)) rrClash++ }
    if (hunksClash(ha, hb)) continue
    n++
    if (!clean(base, sa, sb, union(base, sa, sb, 1, 2)) || !clean(base, sa, sb, union(base, sa, sb, 2, 1))) { bad++; if (!ex) ex = { ha, hb, union: union(base, sa, sb) } }
  }
  T(`C5 every "no clash" pair merges cleanly in the real CRDT (${n} pairs)`, bad === 0, `${bad} fused or lost an edit; first: ${J(ex)}`)
  T(`C6 ...while adjacent same-size replacements stay a non-clash (${rr} pairs)`, rr > 0 && rrClash === 0, `${rrClash} called a clash`)
  // C7/C8: every clash the rule finds must be resolvable. The resolution has to be allowed to replace the
  // real union (or resolveClash gives up and the fused text lands), and must hold no line nobody wrote.
  let nc = 0, refused = 0, exR = null, dirty = 0, exD = null
  for (let t = 0; t < 4000; t++) {
    const bl = codeBase(4 + Math.floor(rnd() * 8)), base = bl.join('\n') + '\n'
    let al = oneEdit(bl); if (rnd() < 0.5) al = oneEdit(al)
    let bb = oneEdit(bl); if (rnd() < 0.3) bb = oneEdit(bb)
    const sa = al.join('\n') + '\n', sb = bb.join('\n') + '\n'
    if (sa === base || sb === base || sa === sb) continue
    const ha = H(base, sa), hb = H(base, sb)
    if (!ha || !hb || !hunksClash(ha, hb)) continue
    nc++
    const m = new Map([[1, ha], [2, hb]])
    const fin = clashFinal(base, m), u = union(base, sa, sb, 1, 2)
    if (!clashOnlyRegion(base, m, fin, u)) { refused++; if (!exR) exR = { ha, hb, fin, u } }
    const marked = /^<<<<<<< /m.test(fin)
    const known = new Set([...bl, ...al, ...bb, ''])
    if (!marked && (fin.split('\n').some((l) => !known.has(l)) || ![...al, ...bb].filter((l) => !bl.includes(l)).every((l) => fin.split('\n').includes(l)))) { dirty++; if (!exD) exD = { ha, hb, fin } }
  }
  T(`C7 every clash found can be resolved: the resolution may replace the real union (${nc} clashes)`, nc > 0 && refused === 0, `${refused} refused; first: ${J(exR)}`)
  T('C8 ...and a resolution without markers is the clean merge: no line nobody wrote, no added line lost', dirty === 0, `${dirty}; first: ${J(exD)}`)
}

sec('CR clashRegion')
{
  const base = lines('a', 'b', 'c', 'd', 'e', 'f', 'g')
  const m = new Map([[7, H(base, edit(edit(base, 3, 'D1'), 0, 'A1'))], [3, H(base, edit(edit(base, 3, 'D2'), 6, 'G2'))]])
  const r = clashRegion(base, m)
  T('CR1 the region is exactly the line both changed', r && r.rs === 3 && r.re === 4, r && J([r.rs, r.re]))
  T('CR2 before it, each author\'s other change is applied once', r && J(r.pre) === J(['A1', 'b', 'c']), r && J(r.pre))
  T('CR3 after it too', r && J(r.post) === J(['e', 'f', 'G2', '']), r && J(r.post))
  T('CR4 one side per author, in client order', r && J([...r.sides.keys()]) === J([3, 7]) && J(r.sides.get(3)) === J(['D2']) && J(r.sides.get(7)) === J(['D1']), r && J([...r.sides]))
  T('CR5 nothing clashes -> null', clashRegion(base, new Map([[1, H(base, edit(base, 1, 'X'))], [2, H(base, edit(base, 5, 'Y'))]])) === null)
}

sec('CF clashFinal')
{
  const base = lines('plan', 'ship friday', 'owner: team')
  const mon = H(base, edit(base, 1, 'ship monday')), tue = H(base, edit(base, 1, 'ship tuesday')), wed = H(base, edit(base, 1, 'ship wednesday'))
  const names = new Map([[1, 'Alice'], [2, 'Bob'], [3, 'Cara']])
  const f2 = clashFinal(base, new Map([[1, mon], [2, tue]]), names)
  T('CF1 two different changes -> one block, both versions, named', f2 === lines('plan', '<<<<<<< Alice', 'ship monday', '=======', 'ship tuesday', '>>>>>>> Bob', 'owner: team'), J(f2))
  T('CF2 nothing fused in it', !/montues|tuesmon/.test(f2))
  const same = clashFinal(base, new Map([[1, mon], [2, mon]]), names)
  T('CF3 the same change twice -> that change once, no markers (never "monmonday")', same === edit(base, 1, 'ship monday'), J(same))
  const f3 = clashFinal(base, new Map([[1, mon], [2, tue], [3, wed]]), names)
  const blocks = (f3.match(/^<<<<<<< /gm) || []).length
  T('CF4 three changes -> ONE block holding all three, none lost', blocks === 1 && ['ship monday', 'ship tuesday', 'ship wednesday'].every((l) => f3.split('\n').includes(l)), J(f3))
  T('CF5 ...and it does not nest', !/^<<<<<<< [\s\S]*^<<<<<<< /m.test(f3))
  const f3b = clashFinal(base, new Map([[3, wed], [1, mon], [2, tue]]), names)
  T('CF6 byte-identical whatever order a peer learned the intents in', f3 === f3b)
  const f3c = clashFinal(base, new Map([[3, wed], [2, mon], [1, tue]]), new Map([[1, 'Bob'], [2, 'Alice'], [3, 'Cara']]))
  T('CF7 versions are ordered by client id, not by name or arrival', f3c.indexOf('ship tuesday') < f3c.indexOf('ship monday') && f3c.indexOf('ship monday') < f3c.indexOf('ship wednesday'), J(f3c))
  const two = clashFinal(base, new Map([[1, mon], [2, mon], [3, tue]]), names)
  T('CF8 two of three made the same change -> two versions, the shared one once', (two.match(/ship monday/g) || []).length === 1 && two.includes('ship tuesday'), J(two))
  const crlf = 'plan\r\nship friday\r\nowner\r\n'
  const fc = clashFinal(crlf, new Map([[1, H(crlf, 'plan\r\nship monday\r\nowner\r\n')], [2, H(crlf, 'plan\r\nship tuesday\r\nowner\r\n')]]), names)
  T('CF9 CRLF: the lines around the block keep their line endings', fc.startsWith('plan\r\n') && fc.endsWith('owner\r\n'), J(fc))
  T('CF10 a name cannot break the block: newlines in it are flattened', !clashFinal(base, new Map([[1, mon], [2, tue]]), new Map([[1, 'Al\nice'], [2, 'Bob']])).includes('Al\nice'))
  // With no region, every intent is applied. Their line numbers all count from the base, so a line added
  // above must not shift the next intent.
  const bb = lines('a', 'b', 'c', 'd', 'e')
  const up = H(bb, insertAt(bb, 0, 'TOP')), down = H(bb, edit(bb, 3, 'D'))
  const nr = clashFinal(bb, new Map([[1, up], [2, down]]), names)
  T('CF11 no clash: both intents applied from the base (line numbers do not drift)', nr === lines('TOP', 'a', 'b', 'c', 'D', 'e'), J(nr))
}

sec('CU clashUnion')
if (typeof SYNC.clashUnion !== 'function') T('CU0 sync.js exports clashUnion(base, intents)', false, 'missing')
else {
  // The real union of saves made on top of a base that a messy history built, by many clients in pieces.
  function realUnion(base, sides, hist) {
    const h = new Y.Doc(); h.clientID = 500
    for (const step of hist) { const d = new Y.Doc(); d.clientID = step.id; Y.applyUpdate(d, Y.encodeStateAsUpdate(h)); applyDiff(d.getText('t'), step.text); Y.applyUpdate(h, Y.encodeStateAsUpdate(d)) }
    applyDiff(h.getText('t'), base)
    const docs = [...sides].map(([id, s]) => { const d = new Y.Doc(); d.clientID = id; Y.applyUpdate(d, Y.encodeStateAsUpdate(h)); applyDiff(d.getText('t'), s); return d })
    for (const d of docs) for (const e of docs) if (d !== e) Y.applyUpdate(d, Y.encodeStateAsUpdate(e))
    return docs[0].getText('t').toString()
  }
  let n = 0, diff = 0, ex = null
  for (let k = 0; k < 1500; k++) {
    const bl = codeBase(4 + Math.floor(rnd() * 8)), base = bl.join('\n') + '\n'
    const hist = []; let x = bl.slice(); for (let i = 0; i < 3; i++) { x = oneEdit(x); hist.unshift({ id: 600 + i, text: x.join('\n') + '\n' }) }
    const sides = new Map(), intents = new Map()
    for (let i = 0; i < (rnd() < 0.7 ? 2 : 3); i++) { let s = oneEdit(bl); if (rnd() < 0.4) s = oneEdit(s); const id = 1000 + Math.floor(rnd() * 90000) * 10 + i; const t = s.join('\n') + '\n'; sides.set(id, t); intents.set(id, H(base, t)) }
    if ([...intents.values()].some((h) => !h)) continue
    n++
    const p = SYNC.clashUnion(base, intents), r = realUnion(base, sides, hist)
    if (p !== r) { diff++; if (!ex) ex = { base, p, r } }
  }
  T(`CU1 the rebuilt union equals the real one, whatever history built the base (${n} races, 2 and 3 saves)`, diff === 0, `${diff}; first ${J(ex)}`)
}

sec('CF+ clashFinal when the clash is only the CRDT\'s')
{
  // The rule calls these a clash because the character CRDT would mangle them; the authors did not
  // change the same line, so the resolution is their clean merge, with no markers.
  const a = edit(edit(B7, 1, 'A1'), 5, 'A5'), b = edit(B7, 3, 'B3')
  const f = clashFinal(B7, new Map([[1, H(B7, a)], [2, H(B7, b)]]))
  T('CF12 two places around the other\'s line -> the clean merge of both, no markers', f === edit(edit(edit(B7, 1, 'A1'), 5, 'A5'), 3, 'B3'), J(f))
  const cb = lines('const v0 = 0', 'const v1 = 7', 'const v2 = 14', 'const v3 = 21', 'const v4 = 28', 'const v5 = 35')
  const f2 = clashFinal(cb, new Map([[1, H(cb, edit(cb, 3, null))], [2, H(cb, edit(cb, 4, 'alpha()'))]]))
  T('CF13 a deletion beside a changed line -> both applied, no markers', f2 === lines('const v0 = 0', 'const v1 = 7', 'const v2 = 14', 'alpha()', 'const v5 = 35'), J(f2))
  // Alice's footprint spans the line Bob and Cara both changed, but Alice left that line as it was: the
  // block holds Bob's and Cara's versions only, never Alice's unchanged copy as a third "version".
  const c3 = clashFinal(B7, new Map([[1, H(B7, edit(edit(B7, 1, 'A1'), 5, 'A5'))], [2, H(B7, edit(B7, 3, 'B3'))], [3, H(B7, edit(B7, 3, 'C3'))]]), new Map([[1, 'Alice'], [2, 'Bob'], [3, 'Cara']]))
  T('CF14 an author who left the clash line unchanged is not a version in the block', /^<<<<<<< Bob$/m.test(c3) && /^>>>>>>> Cara$/m.test(c3) && !c3.split('\n').slice(c3.split('\n').indexOf('<<<<<<< Bob')).includes('l3') && c3.startsWith('l0\nA1\n') && c3.includes('\nA5\n'), J(c3))
}

sec('CF++ clashFinal is the same on every peer, and loses nothing')
{
  // Two authors who do not clash insert at the same point, around a clash elsewhere: the order must not
  // depend on which save a peer heard first.
  const base = lines('top', 'a', 'ship friday', 'b', 'end')
  const A = H(base, edit(base, 2, 'ship monday')), B = H(base, edit(base, 2, 'ship tuesday'))
  const C = H(base, insertAt(base, 0, 'C line')), D = H(base, insertAt(base, 0, 'D line'))
  const f1 = clashFinal(base, new Map([[1, A], [2, B], [3, C], [4, D]])), f2 = clashFinal(base, new Map([[4, D], [3, C], [2, B], [1, A]]))
  T('CF15 non-clashing insertions at one point: byte-identical whatever the arrival order', f1 === f2, J([f1, f2]))
  T('CF16 ...the lower client\'s line first', f1.indexOf('C line') >= 0 && f1.indexOf('C line') < f1.indexOf('D line'), J(f1))
  // An insertion at the line where the other author's replaced span starts: both survive.
  const b2 = lines('l0', 'l1', 'l2', 'l3')
  const f3 = clashFinal(b2, new Map([[1, [[1, 1, ['NEW']]]], [2, [[1, 2, ['R1']]]]]))
  T('CF17 an insertion where the other\'s span starts is kept, and so is the span', f3.split('\n').includes('NEW') && f3.split('\n').includes('R1') && !f3.split('\n').includes('l1'), J(f3))
  T('CF18 an empty region adds no blank line', !/\n\n/.test(clashFinal(lines('a', 'b', 'c'), new Map([[1, [[1, 1, ['N']]]], [2, [[1, 1, ['M']]]]]))))
}

sec('CO clashOnlyRegion')
{
  const base = lines('plan', 'ship friday', 'owner: team', 'notes')
  const a = edit(base, 1, 'ship monday'), b = edit(base, 1, 'ship tuesday')
  const m = new Map([[1, H(base, a)], [2, H(base, b)]])
  const final = clashFinal(base, m)
  const fused = union(base, a, b)
  T('CO0 setup: the real union of the two saves is fused', /montues|tuesmon/.test(fused), J(fused))
  T('CO1 the resolution may replace the real fused union', clashOnlyRegion(base, m, final, fused) === true)
  T('CO2 final === current -> true', clashOnlyRegion(base, m, final, final) === true)
  T('CO3 someone changed a line above the region since -> refuse', clashOnlyRegion(base, m, final, fused.replace('plan', 'plan v2')) === false)
  T('CO4 ...or below it -> refuse', clashOnlyRegion(base, m, final, fused.replace('notes', 'notes!')) === false)
  T('CO5 ...or added a line at the end -> refuse', clashOnlyRegion(base, m, final, fused + 'more\n') === false)
  T('CO6 no clash among the intents -> refuse', clashOnlyRegion(base, new Map([[1, H(base, edit(base, 0, 'X'))], [2, H(base, edit(base, 3, 'Y'))]]), final, fused) === false)
  T('CO8 someone changed the clash line itself since -> refuse (their edit would be overwritten)', clashOnlyRegion(base, m, final, fused.replace(/ship [a-z]+/, 'ship SOON')) === false)
  {
    // A and B clash on line 1; C, from the same text at the same moment, changed the last line.
    const c3 = edit(base, 3, 'notes by C')
    const all = new Map([[1, H(base, a)], [2, H(base, b)], [3, H(base, c3)]])
    const d = [new Y.Doc(), new Y.Doc(), new Y.Doc()]; d.forEach((x, i) => { x.clientID = i + 1 })
    d[0].getText('t').insert(0, base); for (const x of d.slice(1)) Y.applyUpdate(x, Y.encodeStateAsUpdate(d[0]))
    applyDiff(d[0].getText('t'), a); applyDiff(d[1].getText('t'), b); applyDiff(d[2].getText('t'), c3)
    for (const x of d.slice(1)) Y.applyUpdate(d[0], Y.encodeStateAsUpdate(x))
    const fin = clashFinal(base, all)
    T('CO9 a third save from the same text, elsewhere in the file, is kept by the resolution', fin.includes('notes by C') && /^<<<<<<< /m.test(fin), J(fin))
    T('CO10 ...and the resolution may replace the three-way union', clashOnlyRegion(base, all, fin, d[0].getText('t').toString()) === true)
  }
  // Three saves, the real three-way union.
  const c = edit(base, 1, 'ship wednesday')
  const d1 = new Y.Doc(); d1.clientID = 1; d1.getText('t').insert(0, base)
  const d2 = new Y.Doc(); d2.clientID = 2; Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1))
  const d3 = new Y.Doc(); d3.clientID = 3; Y.applyUpdate(d3, Y.encodeStateAsUpdate(d1))
  applyDiff(d1.getText('t'), a); applyDiff(d2.getText('t'), b); applyDiff(d3.getText('t'), c)
  for (const x of [d2, d3]) Y.applyUpdate(d1, Y.encodeStateAsUpdate(x))
  const m3 = new Map([[1, H(base, a)], [2, H(base, b)], [3, H(base, c)]])
  T('CO7 three saves: the resolution may replace their real union', clashOnlyRegion(base, m3, clashFinal(base, m3), d1.getText('t').toString()) === true, J(d1.getText('t').toString()))
}

sec('K known, not detected (design: "an old client", "bases differ")')
{
  // A has seen nothing; B's save was made from a text that already held C's earlier edit elsewhere.
  const base = lines('a', 'ship friday', 'c')
  const b0 = edit(base, 2, 'C!')
  KNOWN('K1 two saves of one line from DIFFERENT texts are not compared', `bases ${base === b0 ? 'equal' : 'differ'}; the fix only groups intents by the hash of the text they came from`)
}

console.log(`\n=== SAME-LINE INTENT UNIT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
