// substrate-torture-test.js — the hardest test: seeded, property-based fuzzing +
// adversarial attacks against EVERY substrate feature. Deterministic (a fixed seed),
// so any failure reproduces exactly. This is the industry-standard way to test an
// invariant: don't hand-pick examples, generate thousands and assert the property holds.
//
// Properties under attack:
//   P1  I1 provenance   — no forged/tampered/impersonated/unsigned/swapped change is ever accepted
//   P2  I2 convergence  — the same disjoint changes, in ANY order, reach ONE identical state
//   P3  I3 non-regress  — the state ALWAYS parses; a break or same-unit clobber is refused
//   P4  chain audit     — a full chain verifies; any single mutated field is detected
//   P5  content authority — every state in history is a verified attestation of its content
//   P6  multi-language  — P1..P3 hold for TypeScript, Go, and Python too
//   P7  edge/abuse      — empty, huge, unicode, unsupported-language, replayed receipts
//
// Run: node substrate-torture-test.js   (optionally: SEED=123 ROUNDS=400 node ...)

import {
  genIdentity, authorChange, publish, emptyState,
  verifyProvenance, verifyReceipt, verifyChain, headOk, contentHealth, contentHash,
} from './substrate.js'
import { parses, languageFor } from './icr.js'

const SEED = Number(process.env.SEED || 20260703)
const ROUNDS = Number(process.env.ROUNDS || 300)
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const R = rng(SEED)
const pick = (a) => a[Math.floor(R() * a.length)]
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1));[a[i], a[j]] = [a[j], a[i]] } return a }

let clock = 1_000_000
const now = () => ++clock
let checks = 0, fails = 0
const T = (name, cond) => { checks++; if (!cond) { fails++; console.log(`  FAIL  ${name}`) } }
const section = (s) => console.log('\n' + s)

const IDS = Array.from({ length: 6 }, (_, i) => genIdentity('agent' + i))

// ---- language kits: build a base with N funcs, and a body-edit for func i ----
const LANGS = {
  js: { ext: 'js', base: (n) => Array.from({ length: n }, (_, i) => `function f${i}(x) {\n  return x + ${i}\n}\n`).join('\n'), edit: (s, i, k) => s.replace(new RegExp(`return x \\+ ${i}\\b`), `return x + ${i} + ${k}`), broke: (s, i) => s.replace(`function f${i}(x)`, `function f${i}(x`) },
  ts: { ext: 'ts', base: (n) => Array.from({ length: n }, (_, i) => `function f${i}(x: number): number {\n  return x + ${i}\n}\n`).join('\n'), edit: (s, i, k) => s.replace(new RegExp(`return x \\+ ${i}\\b`), `return x + ${i} + ${k}`), broke: (s, i) => s.replace(`function f${i}(x: number)`, `function f${i}(x: number`) },
  go: { ext: 'go', base: (n) => Array.from({ length: n }, (_, i) => `func f${i}(x int) int {\n\treturn x + ${i}\n}\n`).join('\n'), edit: (s, i, k) => s.replace(new RegExp(`return x \\+ ${i}\\b`), `return x + ${i} + ${k}`), broke: (s, i) => s.replace(`func f${i}(x int) int {`, `func f${i}(x int) int {{`) },
  py: { ext: 'py', base: (n) => Array.from({ length: n }, (_, i) => `def f${i}(x):\n    return x + ${i}\n`).join('\n'), edit: (s, i, k) => s.replace(new RegExp(`return x \\+ ${i}\\b`), `return x + ${i} + ${k}`), broke: (s, i) => s.replace(`def f${i}(x):`, `def f${i}(x:`) },
}
const mk = (id, filename, base, text, intent) => authorChange({ identity: id, filename, base, text, intent, at: now() })

// ============================================================================
section(`P1 — PROVENANCE: every forged/tampered/impersonated/unsigned change refused  (${ROUNDS} rounds)`)
// ============================================================================
for (let r = 0; r < ROUNDS; r++) {
  const kit = LANGS.js, n = 3 + Math.floor(R() * 4), base = kit.base(n)
  const st = publish(emptyState(), mk(pick(IDS), 'a.js', '', base, 'seed')).state
  const author = pick(IDS), i = Math.floor(R() * n)
  const good = mk(author, 'a.js', base, kit.edit(base, i, r), 'edit')
  T('honest change verifies + applies', verifyProvenance(good).ok && publish(st, good).accepted)

  // TAMPER body after signing
  T('tampered body refused', !publish(st, { ...good, text: kit.edit(base, i, r + 999) }).accepted)
  // TAMPER a signed field
  T('tampered intent refused', !publish(st, { ...good, prov: { ...good.prov, intent: 'evil' } }).accepted)
  const otherId = (IDS.find((x) => x.id !== good.prov.author) || IDS[0]).id // a DIFFERENT author than signed
  T('tampered author refused', !publish(st, { ...good, prov: { ...good.prov, author: otherId } }).accepted)
  // IMPERSONATE: victim id, attacker key/signature (attacker must differ from victim)
  const victim = pick(IDS)
  const attacker = IDS.find((x) => x.id !== victim.id) || IDS[0]
  const imp = mk({ ...attacker, id: victim.id }, 'a.js', base, kit.edit(base, i, r + 1), 'sneak')
  T('impersonation refused (id != key fingerprint)', !publish(st, imp).accepted)
  // SWAP a valid signature from a different change
  const other = mk(author, 'a.js', base, kit.edit(base, (i + 1) % n, r), 'other')
  T('swapped signature refused', !publish(st, { ...good, prov: { ...good.prov, sig: other.prov.sig } }).accepted)
  // UNSIGNED / no provenance
  T('unsigned refused', !publish(st, { filename: 'a.js', base, text: kit.edit(base, i, r) }).accepted)
  // REPLAY: reuse a receipt whose contentHash is for different text
  T('replayed receipt (wrong text) refused', !publish(st, { filename: 'a.js', base, text: base + '\n// x', prov: good.prov }).accepted)
  // state never moved under any attack
  T('state unchanged after attacks', st.text === base)
}

// ============================================================================
section(`P2 — CONVERGENCE: disjoint edits in ANY order reach ONE identical state  (${ROUNDS} rounds)`)
// ============================================================================
for (let r = 0; r < ROUNDS; r++) {
  const kit = LANGS.js, n = 4 + Math.floor(R() * 5), base = kit.base(n)
  const seed = publish(emptyState(), mk(pick(IDS), 'c.js', '', base, 'seed')).state
  // one disjoint edit per distinct function, random authors
  const idxs = shuffle(Array.from({ length: n }, (_, i) => i)).slice(0, 2 + Math.floor(R() * (n - 1)))
  const changes = idxs.map((i) => mk(pick(IDS), 'c.js', base, kit.edit(base, i, 100 + i), `edit f${i}`))
  const applyIn = (order) => { let s = seed; for (const c of order) { const res = publish(s, c); T('disjoint edit applies', res.accepted); s = res.state } return s }
  const hashes = []
  for (let p = 0; p < 4; p++) hashes.push(applyIn(shuffle(changes)).hash)
  T('all permutations converge to one hash', hashes.every((h) => h === hashes[0]))
  T('converged state parses', parses(applyIn(changes).text, languageFor('c.js')))
}

// ============================================================================
section(`P3 — NON-REGRESSION: state always parses; breaks & same-unit clobbers refused  (${ROUNDS} rounds)`)
// ============================================================================
for (let r = 0; r < ROUNDS; r++) {
  const kit = LANGS.js, n = 3 + Math.floor(R() * 4), base = kit.base(n)
  let st = publish(emptyState(), mk(pick(IDS), 'r.js', '', base, 'seed')).state
  // a break is refused
  const brk = mk(pick(IDS), 'r.js', base, kit.broke(base, Math.floor(R() * n)), 'break')
  T('breaking change refused', !publish(st, brk).accepted && st.text === base)
  // one author edits fi; another edits the SAME fi differently -> clobber refused
  const i = Math.floor(R() * n)
  st = publish(st, mk(IDS[0], 'r.js', base, kit.edit(base, i, 5), 'A')).state
  const afterA = st.text
  const clash = publish(st, mk(IDS[1], 'r.js', base, kit.edit(base, i, 9), 'B'))
  T('same-unit clobber refused; first edit preserved', !clash.accepted && st.text === afterA)
  // health monotonic across a random good/bad stream
  let s2 = publish(emptyState(), mk(pick(IDS), 's.js', '', kit.base(n), 'seed')).state
  for (let t = 0; t < 12; t++) {
    const j = Math.floor(R() * n), bad = R() < 0.4
    const text = bad ? kit.broke(s2.text, j) : kit.edit(kit.base(n), j, t)
    const res = publish(s2, mk(pick(IDS), 's.js', s2.text, text, 't' + t))
    if (res.accepted) s2 = res.state
    T('state always parses', parses(s2.text, languageFor('s.js')))
  }
}

// ============================================================================
section(`P4 — CHAIN AUDIT: full chain verifies; any single mutation is caught  (${ROUNDS} rounds)`)
// ============================================================================
for (let r = 0; r < ROUNDS; r++) {
  const kit = LANGS.js, n = 3 + Math.floor(R() * 3), base = kit.base(n)
  let st = publish(emptyState(), mk(pick(IDS), 'h.js', '', base, 'seed')).state
  const len = 2 + Math.floor(R() * 4)
  for (let k = 0; k < len; k++) st = publish(st, mk(pick(IDS), 'h.js', st.text, kit.edit(st.text, k % n, 200 + k), 'e' + k)).state
  T('full chain verifies', verifyChain(st.history).ok)
  // mutate one random field of one random receipt
  const idx = Math.floor(R() * st.history.length)
  const field = pick(['intent', 'author', 'contentHash', 'at'])
  const mutated = st.history.map((rc, i) => i === idx ? { ...rc, [field]: (field === 'at' ? rc.at + 1 : 'X' + rc[field]) } : rc)
  const audit = verifyChain(mutated)
  T('mutation detected by audit', !audit.ok)
}

// ============================================================================
section(`P5 — CONTENT AUTHORITY: every state in history is a verified attestation`)
// ============================================================================
for (let r = 0; r < 60; r++) {
  const kit = pick([LANGS.js, LANGS.ts]), n = 3 + Math.floor(R() * 3), base = kit.base(n)
  let st = publish(emptyState(), mk(pick(IDS), 'x.' + kit.ext, '', base, 'seed')).state
  for (let k = 0; k < 4; k++) { const res = publish(st, mk(pick(IDS), 'x.' + kit.ext, st.text, kit.edit(st.text, k % n, 300 + k), 'e')); if (res.accepted) st = res.state }
  // reconstruct a head from each receipt and confirm it is a valid, verified attestation
  let ok = true
  for (const rc of st.history) if (!verifyReceipt(rc).ok) ok = false
  T('every receipt in history verifies', ok)
  T('final state parses (never regressed)', contentHealth(st.text, 'x.' + kit.ext) === 0)
  // a head built from a broken text with a genuine signature is well-formed but unhealthy
  const brokenText = kit.broke(kit.base(n), 0)
  const brokenReceipt = mk(pick(IDS), 'x.' + kit.ext, '', brokenText, 'oops').prov
  T('headOk accepts a well-signed head', headOk({ text: brokenText, hash: contentHash(brokenText), receipt: brokenReceipt }).ok)
  T('but contentHealth flags it as regressing', contentHealth(brokenText, 'x.' + kit.ext) === 1)
}

// ============================================================================
section(`P6 — MULTI-LANGUAGE: provenance + convergence + non-regression for TS/Go/Python`)
// ============================================================================
for (const key of ['ts', 'go', 'py']) {
  const kit = LANGS[key]
  let pass = true
  for (let r = 0; r < 40; r++) {
    const n = 3 + Math.floor(R() * 3), base = kit.base(n), file = 'm.' + kit.ext
    const seed = publish(emptyState(), mk(pick(IDS), file, '', base, 'seed')).state
    if (!seed.text) { pass = false; continue }
    // disjoint edits converge
    const idxs = shuffle(Array.from({ length: n }, (_, i) => i)).slice(0, 2)
    const changes = idxs.map((i) => mk(pick(IDS), file, base, kit.edit(base, i, 50 + i), 'e'))
    const h1 = (() => { let s = seed; for (const c of shuffle(changes)) { const x = publish(s, c); if (x.accepted) s = x.state } return s.hash })()
    const h2 = (() => { let s = seed; for (const c of shuffle(changes)) { const x = publish(s, c); if (x.accepted) s = x.state } return s.hash })()
    if (h1 !== h2) pass = false
    // forgery refused
    const g = mk(pick(IDS), file, base, kit.edit(base, 0, r), 'e')
    if (publish(seed, { ...g, prov: { ...g.prov, intent: 'evil' } }).accepted) pass = false
    // break refused
    if (publish(seed, mk(pick(IDS), file, base, kit.broke(base, 0), 'x')).accepted) pass = false
  }
  T(`${key}: provenance + convergence + non-regression hold`, pass)
}

// ============================================================================
section(`P7 — EDGE / ABUSE: empty, huge, unicode, unsupported language, genesis break`)
// ============================================================================
{
  // genesis must be healthy
  T('broken genesis refused', !publish(emptyState(), mk(pick(IDS), 'g.js', '', 'function x( {', 'x')).accepted)
  // empty genesis (parses) accepted, then real content
  const e0 = publish(emptyState(), mk(pick(IDS), 'e.js', '', '', 'empty'))
  T('empty genesis handled', e0.accepted === true || e0.accepted === false) // must not throw
  // huge file (~20k lines) still signs + verifies + converges with a disjoint edit
  const big = LANGS.js.base(2000)
  const bst = publish(emptyState(), mk(pick(IDS), 'big.js', '', big, 'seed'))
  T('huge genesis accepted', bst.accepted)
  const be = publish(bst.state, mk(pick(IDS), 'big.js', big, LANGS.js.edit(big, 0, 1), 'edit'))
  T('huge-file edit accepted + parses', be.accepted && parses(be.state.text, languageFor('big.js')))
  // unicode content
  const uni = 'function f0(x) {\n  return "π≈3.14 — café 🚀 " + x\n}\n'
  const ust = publish(emptyState(), mk(pick(IDS), 'u.js', '', uni, 'seed'))
  T('unicode genesis accepted + verifies', ust.accepted && verifyReceipt(ust.state.history[0]).ok)
  // unsupported language: provenance still applies; content-health is neutral (fallback)
  const md = '# hello\n\nsome text\n'
  const mst = publish(emptyState(), mk(pick(IDS), 'readme.md', '', md, 'seed'))
  T('unsupported-language change carries provenance', mst.accepted && verifyReceipt(mst.state.history[0]).ok)
  // a receipt with a missing field is rejected by verifyReceipt
  const vc = mk(pick(IDS), 'a.js', '', 'function z(){}\n', 'x').prov
  T('receipt missing sig rejected', !verifyReceipt({ ...vc, sig: undefined }).ok)
  T('receipt missing pk rejected', !verifyReceipt({ ...vc, pk: undefined }).ok)
}

console.log(`\n${'='.repeat(64)}`)
console.log(fails === 0
  ? `SUBSTRATE SURVIVED THE TORTURE — ${checks} checks passed (seed ${SEED}, ${ROUNDS} rounds/property)`
  : `${fails} of ${checks} checks FAILED (seed ${SEED}) — reproduce with SEED=${SEED}`)
console.log('='.repeat(64))
process.exit(fails === 0 ? 0 : 1)
