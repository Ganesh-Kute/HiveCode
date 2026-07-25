// substrate-test.js — adversarial proof of the substrate's three invariants.
//
// Not a demo. Each block ATTACKS one invariant and asserts the medium holds:
//   I1  forge / tamper / impersonate / unsign  -> every such change is REFUSED
//   I2  apply the same changes in different orders -> byte-identical final state
//   I3  a breaking or clobbering change -> REFUSED, and the state never regresses
//   +   verifyChain audits real history and catches any post-hoc mutation
//
// Deterministic: a seeded PRNG and a monotonic virtual clock, so a failure reproduces.
// Run: node substrate-test.js

import assert from 'assert'
import {
  genIdentity, authorChange, publish, emptyState,
  verifyProvenance, verifyChain, contentHash,
} from './substrate.js'
import { parses, languageFor } from './icr.js'

// seeded PRNG (mulberry32) — reproducible "randomness"
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

let clock = 1_000
const now = () => ++clock // monotonic virtual clock; the substrate never reads a real one

let pass = 0
const ok = (name) => { pass++; console.log('  ✓', name) }

// a JS file with N independent top-level functions f0..f{N-1}
function baseFile(n) {
  let s = ''
  for (let i = 0; i < n; i++) s += `function f${i}(x) {\n  return x + ${i}\n}\n\n`
  return s
}
// an edit to ONE function's body (disjoint from other functions -> clean merge)
function editFn(src, i, k) { return src.replace(new RegExp(`return x \\+ ${i}\\b`), `return x + ${i} + ${k}`) }

const Alice = genIdentity('Alice')
const Bob = genIdentity('Bob')
const Mallory = genIdentity('Mallory')

// ---------------------------------------------------------------------------
console.log('\nI1 — PROVENANCE: forged / tampered / impersonated changes are refused')
// ---------------------------------------------------------------------------
{
  const base = baseFile(3)
  let st = publish(emptyState(), authorChange({ identity: Alice, filename: 'a.js', base: '', text: base, intent: 'seed', at: now() })).state
  assert.equal(st.text, base); ok('valid genesis change accepted')

  const good = authorChange({ identity: Bob, filename: 'a.js', base, text: editFn(base, 1, 10), intent: 'edit f1', at: now() })
  assert.equal(verifyProvenance(good).ok, true); ok('honest change verifies')

  // TAMPER: swap the body after signing
  const tampered = { ...good, text: editFn(base, 1, 999) }
  assert.equal(verifyProvenance(tampered).ok, false)
  assert.equal(publish(st, tampered).accepted, false); ok('tampered body refused (hash mismatch)')

  // FORGE: keep Bob's signature but claim a different intent
  const forged = { ...good, prov: { ...good.prov, intent: 'malicious' } }
  assert.equal(publish(st, forged).accepted, false); ok('altered intent refused (signature break)')

  // IMPERSONATE: Mallory signs but stamps Alice's author id
  const imp = authorChange({ identity: { ...Mallory, id: Alice.id }, filename: 'a.js', base, text: editFn(base, 2, 7), intent: 'sneak', at: now() })
  assert.equal(publish(st, imp).accepted, false); ok('impersonation refused (id != key fingerprint)')

  // UNSIGNED: strip provenance entirely
  assert.equal(publish(st, { filename: 'a.js', base, text: editFn(base, 0, 1) }).accepted, false); ok('unsigned change refused')

  // the medium never moved during any attack
  assert.equal(st.text, base); ok('state unchanged after all I1 attacks')
}

// ---------------------------------------------------------------------------
console.log('\nI2 — CONVERGENCE: same changes, any order, identical final state')
// ---------------------------------------------------------------------------
{
  const N = 8, base = baseFile(N)
  const seed = publish(emptyState(), authorChange({ identity: Alice, filename: 'c.js', base: '', text: base, intent: 'seed', at: now() })).state

  // one disjoint change per function, each authored against the SAME seed state
  const changes = []
  for (let i = 0; i < N; i++) {
    const who = i % 2 ? Bob : Alice
    changes.push(authorChange({ identity: who, filename: 'c.js', base, text: editFn(base, i, 100 + i), intent: `edit f${i}`, at: now() }))
  }

  const applyIn = (order) => {
    let st = seed
    for (const idx of order) { const r = publish(st, changes[idx]); assert.equal(r.accepted, true, `change ${idx} should apply`); st = r.state }
    return st.hash
  }

  const forward = applyIn([...Array(N).keys()])
  const reverse = applyIn([...Array(N).keys()].reverse())
  assert.equal(forward, reverse); ok('forward order == reverse order (identical hash)')

  // 20 random permutations all converge to the same hash
  const R = rng(42)
  for (let t = 0; t < 20; t++) {
    const order = [...Array(N).keys()]
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1));[order[i], order[j]] = [order[j], order[i]] }
    assert.equal(applyIn(order), forward, 'permutation diverged')
  }
  ok('20 random permutations all converge to one state')
}

// ---------------------------------------------------------------------------
console.log('\nI3 — NON-REGRESSION: breaking / clobbering changes are refused, health never drops')
// ---------------------------------------------------------------------------
{
  const base = baseFile(3)
  let st = publish(emptyState(), authorChange({ identity: Alice, filename: 'r.js', base: '', text: base, intent: 'seed', at: now() })).state

  // a change whose result does not parse -> refused, state held
  const broken = authorChange({ identity: Bob, filename: 'r.js', base, text: base + '\nfunction oops( {', intent: 'break it', at: now() })
  const rb = publish(st, broken)
  assert.equal(rb.accepted, false); assert.match(rb.reason, /non-regression/); assert.equal(st.text, base)
  ok('unparseable change refused; state unchanged')

  // Alice lands a real edit to f1
  st = publish(st, authorChange({ identity: Alice, filename: 'r.js', base, text: editFn(base, 1, 5), intent: 'A edits f1', at: now() })).state
  const afterA = st.text
  // Bob edits the SAME function f1 differently, still against the old base -> would clobber A
  const clash = authorChange({ identity: Bob, filename: 'r.js', base, text: editFn(base, 1, 9), intent: 'B edits f1', at: now() })
  const rc = publish(st, clash)
  assert.equal(rc.accepted, false); assert.match(rc.reason, /semantic conflict/); assert.equal(st.text, afterA)
  ok('conflicting edit to a held unit refused; A’s edit preserved')

  // health monotonicity across a random stream of good + bad changes
  const R = rng(7), N = 6, b2 = baseFile(N)
  let s2 = publish(emptyState(), authorChange({ identity: Alice, filename: 's.js', base: '', text: b2, intent: 'seed', at: now() })).state
  let landed = 0
  for (let t = 0; t < 60; t++) {
    const i = Math.floor(R() * N)
    const makeBad = R() < 0.4
    const text = makeBad ? b2.replace(`function f${i}`, `function f${i}(`) : editFn(b2, i, t)
    const ch = authorChange({ identity: t % 2 ? Bob : Alice, filename: 's.js', base: s2.text, text, intent: `t${t}`, at: now() })
    const r = publish(s2, ch)
    if (r.accepted) { landed++; s2 = r.state }
    // INVARIANT: whatever the medium currently holds always parses
    assert.equal(parses(s2.text, languageFor('s.js')), true, `state must always parse (t=${t})`)
  }
  ok(`health held across 60 mixed changes (${landed} landed, rest refused, never regressed)`)
}

// ---------------------------------------------------------------------------
console.log('\nAUDIT — verifyChain proves the whole history, and catches mutation')
// ---------------------------------------------------------------------------
{
  const N = 5, base = baseFile(N)
  let st = publish(emptyState(), authorChange({ identity: Alice, filename: 'h.js', base: '', text: base, intent: 'seed', at: now() })).state
  for (let i = 0; i < N; i++) {
    const who = i % 2 ? Bob : Alice
    const r = publish(st, authorChange({ identity: who, filename: 'h.js', base: st.text, text: editFn(st.text, i, 200 + i), intent: `edit f${i}`, at: now() }))
    st = r.state
  }
  const audit = verifyChain(st.history)
  assert.equal(audit.ok, true); assert.equal(audit.length, N + 1)
  ok(`full ${audit.length}-commit chain verifies end-to-end`)

  // tamper with a past receipt's intent -> audit must catch it
  const mutated = st.history.map((r, i) => i === 2 ? { ...r, intent: 'rewritten history' } : r)
  const bad = verifyChain(mutated)
  assert.equal(bad.ok, false); assert.equal(bad.broken, 2)
  ok('post-hoc history mutation detected (broken at index 2)')

  // every commit is attributable to a real author id
  const authors = new Set(st.history.map((r) => r.author))
  assert.deepEqual([...authors].sort(), [Alice.id, Bob.id].sort())
  ok('every state in history attributed to a verified author')
}

console.log(`\n✓ all ${pass} substrate invariant checks passed\n`)
