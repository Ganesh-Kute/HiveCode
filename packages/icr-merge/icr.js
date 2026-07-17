// ICR — Intent-aware Code Replication (v1 proof-of-concept).
//
// The first real step from Hivecode-the-tool toward a FOUNDATIONAL primitive:
// merge code by STRUCTURE and INTENT, not characters, with a hard guarantee — never
// emit code more broken than its inputs.
//
// Why this matters: CRDTs (Yjs) merge characters. They will happily fuse two edits
// into syntactically-valid garbage, because they have no idea what code MEANS. ICR
// parses the code, merges at the level of declarations (functions / classes / vars),
// descends INTO a declaration both sides touched (so disjoint edits inside one function
// still merge), detects when two authors changed the SAME thing (a real conflict), and
// validates that the merged result still parses — falling back safely if it wouldn't.
//
// On top of structure it adds an INTENT layer:
//   • RENAME DETECTION — a declaration gone from base whose identical-bodied twin appears
//     under a new name is recognized as a rename; stale call sites are rewritten so the
//     other agent's fresh calls keep working. Nothing else does this.
//   • DANGLING REFERENCE — a declaration removed/renamed but still referenced is flagged
//     as a semantic conflict even though the code parses. CRDTs/git/plain merge miss it.
//
// LANGUAGE-AGNOSTIC BY DESIGN: this file is the engine. Everything that knows about a
// specific language (how to parse, what a declaration is, how to find references) lives
// behind a provider (see lang-js.js). Adding Python/Go/Rust = writing another provider
// and registerLanguage()-ing it; the merge logic below never changes. JavaScript via
// `acorn` is simply the first provider. The production path swaps in tree-sitter
// providers for every language behind this same interface.

import { javascript } from './lang-js.js'
import { braceLanguages } from './lang-brace.js'
import { python } from './lang-python.js'
import { ruby } from './lang-ruby.js'
import { json } from './lang-json.js'
import { yaml } from './lang-yaml.js'
import { toml } from './lang-toml.js'

// --- language registry ----------------------------------------------------------
// JavaScript (acorn, full intent layer) first; then structural providers for the
// C-family (TypeScript, Go, Rust, Java, C/C++, C#, Swift, Kotlin, …), Python, and
// Ruby; data languages: JSON merges as parsed DATA (real parser, value-wise 3-way,
// perfect guarantee), YAML/TOML merge by keyed structure (sections/keys).
// These cover disjoint extensions, so order only matters on clashes (none today).
const LANGUAGES = [javascript, ...braceLanguages, python, ruby, json, yaml, toml]

// Register an additional language provider. Must expose the provider contract:
// { id, exts:[...], parses, units, declaredNames, usedIdentifiers, declBody,
//   renameRefs, fnParts }. Newest wins on extension clashes.
export function registerLanguage(provider) { LANGUAGES.unshift(provider) }

// The live provider list (the actual registered objects, not copies) — used by the
// optional tree-sitter oracle to upgrade providers' parse checks in place.
export function registeredLanguages() { return LANGUAGES }

function extname(p) { const m = /\.[^.\/\\]+$/.exec(p || ''); return m ? m[0].toLowerCase() : '' }

// The provider for a filename, or null if no registered language claims its extension.
export function languageFor(filename) {
  const e = extname(filename)
  return LANGUAGES.find((l) => l.exts.includes(e)) || null
}

// Can ICR merge this file structurally? (Callers gate on this before trying.)
export function supports(filename) { return languageFor(filename) != null }

// --- generic merge primitives (language-independent: operate on {key,text}) -----
const mapOf = (us) => new Map(us.map((u) => [u.key, u.text]))
function dedupeOrder(keys) { const seen = new Set(), out = []; for (const k of keys) if (!seen.has(k)) { seen.add(k); out.push(k) } return out }

// For a given unit, choose which version survives: whoever CHANGED it wins; if neither
// changed it, keep the base.
function pick(k, B, A, Bb) {
  const base = B.has(k) ? B.get(k) : null
  const a = A.has(k) ? A.get(k) : null
  const b = Bb.has(k) ? Bb.get(k) : null
  if (a != null && a !== base) return a
  if (b != null && b !== base) return b
  return base != null ? base : (a != null ? a : b)
}

// SIMILARITY RE-PAIRING (the matcher): a unit that "disappeared" on one side while a
// near-identical unit "appeared" on the SAME side is the same unit rewritten — e.g.
// `app.use(...)` becoming `app1.use(...)` when a variable is renamed changes the unit's
// content-derived key, and key matching alone would call that a delete + an add. Ground-
// truth replay of real repos showed this is the #1 source of false delete-vs-edit
// conflicts. Pair them back so the engine sees ONE unit changed on that side and the
// normal same-key tiers (inner merge → token splice) get their shot.
// Safety: same key KIND only (call: with call:, fn: with fn:), a high similarity bar,
// and the best match must be UNIQUE (with margin) and MUTUAL — any ambiguity means no
// pairing. Side-local and deterministic, so merge(a,b) === merge(b,a) is preserved.
const keyKind = (k) => k.slice(0, k.indexOf(':') + 1)
function shingleSet(t) {
  const s = t.replace(/\s+/g, ' ').trim()
  const out = new Set()
  for (let i = 0; i + 4 <= s.length; i++) out.add(s.slice(i, i + 4))
  return out
}
function shingleSim(sa, sb) {
  if (!sa.size || !sb.size) return 0
  let inter = 0
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa]
  for (const g of small) if (big.has(g)) inter++
  return (2 * inter) / (sa.size + sb.size)
}
const SIM_FLOOR = 0.75, SIM_MARGIN = 0.04
function repairSide(baseU, sideU, otherKeys) {
  const baseKeys = new Set(baseU.map((u) => u.key))
  const sideKeys = new Set(sideU.map((u) => u.key))
  const deleted = baseU.filter((u) => !sideKeys.has(u.key))
  // An added key that ALSO appears on the other side is a genuine concurrent addition
  // (both sides wrote it) — pairing it away would fabricate a duplicate and silently
  // absorb a same-key add/add clash the engine must surface. Never pair those.
  const added = sideU.filter((u) => !baseKeys.has(u.key) && !otherKeys.has(u.key))
  if (!deleted.length || !added.length || deleted.length * added.length > 900) return sideU
  const shD = deleted.map((u) => shingleSet(u.text)), shA = added.map((u) => shingleSet(u.text))
  const bestFor = (sh, kind, pool, shPool) => {
    let best = -1, bestS = 0, second = 0
    for (let j = 0; j < pool.length; j++) {
      if (keyKind(pool[j].key) !== kind) continue
      const s = shingleSim(sh, shPool[j])
      if (s > bestS) { second = bestS; bestS = s; best = j } else if (s > second) second = s
    }
    return { best, bestS, second }
  }
  const rekey = new Map(), claimed = new Set()
  for (let i = 0; i < deleted.length; i++) {
    const kind = keyKind(deleted[i].key)
    const f = bestFor(shD[i], kind, added, shA)
    // Short units are mostly boilerplate (`def f(): return N`), so shingle similarity
    // runs hot on them — demand near-identity before calling two short units "the same".
    const floor = Math.min(shD[i].size, f.best >= 0 ? shA[f.best].size : Infinity) < 24 ? 0.9 : SIM_FLOOR
    if (f.best < 0 || f.bestS < floor || f.bestS - f.second < SIM_MARGIN) continue
    const back = bestFor(shA[f.best], keyKind(added[f.best].key), deleted, shD)
    if (back.best !== i || back.bestS - back.second < SIM_MARGIN) continue
    if (claimed.has(added[f.best].key)) continue
    claimed.add(added[f.best].key)
    rekey.set(added[f.best].key, deleted[i].key)
  }
  if (!rekey.size) return sideU
  return sideU.map((u) => (rekey.has(u.key) ? { ...u, key: rekey.get(u.key) } : u))
}

// Core 3-way merge over a KEYED list of units (works at file level AND, recursively,
// inside a single declaration). Returns { conflicts:[...], parts:[...text] }.
// When both sides change the SAME key into different things, it first tries to descend
// INTO that unit (finer granularity) — only a clash it can't resolve becomes a conflict.
function mergeKeyed(lang, baseU, aU, bU, mopts = {}) {
  const aKeys = new Set(aU.map((u) => u.key)), bKeys = new Set(bU.map((u) => u.key))
  aU = repairSide(baseU, aU, bKeys)
  bU = repairSide(baseU, bU, aKeys)
  const B = mapOf(baseU), A = mapOf(aU), Bb = mapOf(bU)
  const keys = dedupeOrder([...baseU.map((u) => u.key), ...aU.map((u) => u.key), ...bU.map((u) => u.key)])

  const conflicts = [], conflictUnits = [], resolved = new Map()
  for (const k of keys) {
    const bs = B.has(k) ? B.get(k) : null
    const as_ = A.has(k) ? A.get(k) : null
    const bbs = Bb.has(k) ? Bb.get(k) : null
    const changedA = as_ !== bs, changedB = bbs !== bs
    if (changedA && changedB && as_ !== bbs) {
      // Both touched the same unit, differently. Try finer-grained inner merge first.
      if (bs != null && as_ != null && bbs != null) {
        const inner = tryInnerMerge(lang, bs, as_, bbs, mopts)
        if (inner != null) { resolved.set(k, inner); continue }
      }
      conflicts.push(k)
      // Carry the three exact versions of the conflicting unit, so a conflict is a
      // MACHINE-RESOLVABLE object (base/ours/theirs of just this declaration) — not a wall
      // of text markers. This is what an intent-aware resolver (a judge agent) reconciles.
      conflictUnits.push({ key: k, base: bs, ours: as_, theirs: bbs })
    }
  }
  if (conflicts.length) return { conflicts, conflictUnits, parts: [] }

  // No unresolved clashes → decide which keys survive, honoring one-sided deletions.
  const survives = new Set()
  for (const k of keys) {
    const inBase = B.has(k), inA = A.has(k), inB2 = Bb.has(k)
    if (inBase && (!inA || !inB2)) {
      const deletedByA = !inA, deletedByB = !inB2
      const otherUnchangedFromBase =
        (deletedByA && (!inB2 || Bb.get(k) === B.get(k))) ||
        (deletedByB && (!inA || A.get(k) === B.get(k)))
      if (otherUnchangedFromBase) continue // accept the deletion
    }
    survives.add(k)
  }

  // CONVERGENCE + TOPOLOGY: new units are inserted where their author put them — anchored
  // to the base unit that immediately preceded them on the side that added them — while
  // staying SYMMETRIC: merge(a,b) must equal merge(b,a) byte-for-byte or two live peers
  // never settle. Symmetry rules: (1) a unit added by BOTH sides at different anchors gets
  // the anchor earlier in base order (side-independent); (2) when both sides insert runs at
  // the SAME anchor, each side's run keeps its own internal order, and the two runs are
  // ordered by comparing their joined keys (content, not side).
  const baseOrder = dedupeOrder(baseU.map((u) => u.key))
  const baseSet = new Set(baseOrder)
  const basePos = new Map(baseOrder.map((k, i) => [k, i]))

  const anchorsFor = (units) => { // newKey -> base key it followed (null = top of file)
    const m = new Map()
    let lastBase = null
    for (const u of units) {
      if (baseSet.has(u.key)) lastBase = u.key
      else if (survives.has(u.key) && !m.has(u.key)) m.set(u.key, lastBase)
    }
    return m
  }
  const aAnch = anchorsFor(aU), bAnch = anchorsFor(bU)
  const anchorOf = (k) => {
    const inA2 = aAnch.has(k), inB3 = bAnch.has(k)
    if (inA2 && inB3) {
      const x = aAnch.get(k), y = bAnch.get(k)
      if (x === y) return x
      const px = x == null ? -1 : basePos.get(x), py = y == null ? -1 : basePos.get(y)
      return px <= py ? x : y
    }
    return inA2 ? aAnch.get(k) : bAnch.get(k)
  }
  const runsA = new Map(), runsB = new Map() // anchor -> that side's new keys, in its order
  for (const k of aAnch.keys()) { const an = anchorOf(k); if (!runsA.has(an)) runsA.set(an, []); runsA.get(an).push(k) }
  for (const k of bAnch.keys()) { const an = anchorOf(k); if (!runsB.has(an)) runsB.set(an, []); runsB.get(an).push(k) }
  const newAt = (anchor) => {
    const ra = runsA.get(anchor) || [], rb = runsB.get(anchor) || []
    const [first, second] = ra.join('') <= rb.join('') ? [ra, rb] : [rb, ra]
    const firstSet = new Set(first)
    return [...first, ...second.filter((k) => !firstSet.has(k))]
  }

  const final = []
  final.push(...newAt(null))
  for (const k of baseOrder) {
    if (survives.has(k)) final.push(k)
    final.push(...newAt(k))
  }

  // Assemble, recording PROVENANCE per surviving unit: who authored the version we kept
  // ('a' / 'b' changed it, 'both' if we merged inside it, 'base' if unchanged).
  const parts = [], provenance = [], order = [], textByKey = new Map()
  for (const k of final) {
    let text, from
    if (resolved.has(k)) { text = resolved.get(k); from = 'both' }
    else {
      text = pick(k, B, A, Bb)
      const bs = B.has(k) ? B.get(k) : null, as_ = A.has(k) ? A.get(k) : null, bbs = Bb.has(k) ? Bb.get(k) : null
      from = (as_ != null && as_ !== bs) ? 'a' : (bbs != null && bbs !== bs) ? 'b' : 'base'
    }
    if (text != null) { parts.push(text); provenance.push({ key: k, from }); order.push(k); textByKey.set(k, text) }
  }
  return { conflicts: [], parts, provenance, order, textByKey }
}

// FINER GRANULARITY: both sides edited the same function OR class. If the signature
// matches and they edited DIFFERENT inner units (statements / class members), merge those
// recursively rather than declaring the whole declaration a conflict. Returns merged
// text, or null meaning "couldn't safely merge inside — treat as a real conflict."
function tryInnerMerge(lang, baseText, aText, bText, mopts = {}) {
  // Language-specific same-key merges first (e.g. unioning import specifiers).
  if (lang.mergeUnit) {
    const t = lang.mergeUnit(baseText, aText, bText)
    if (t != null && lang.parses(t)) return t
  }
  // Structural inner merge (declaration → statements, class → members): format-preserving
  // and well-tested, so it goes first. Returns null when it can't safely resolve.
  const structural = tryStructuralInner(lang, baseText, aText, bText, mopts)
  if (structural != null) return structural
  // Unit-level oracle: providers with a fragment validator (parsesUnit) get every finer-
  // grained result checked HERE, so an invalid inner merge becomes an honest per-unit
  // conflict (judge-resolvable) instead of poisoning the whole file into fallback.
  // Providers without one (JS: a bare `return …` fragment is valid only in context) keep
  // deferring to the whole-file gate, as before.
  const unitOk = lang.parsesUnit ? (t) => t != null && lang.parsesUnit(t) : (t) => t != null
  // LINE-LEVEL diff3: whole lines as atoms, so indentation travels with its line — the
  // safe multi-hunk tier, and the workhorse for "both sides edited different lines of the
  // same declaration" (the most common same-unit case in real repos).
  const lm = lineMerge3(baseText, aText, bText, mopts)
  if (unitOk(lm)) return lm
  // FINEST GRANULARITY: a single line/statement both sides edited — token-level 3-way, so
  // two edits INSIDE one line (`foo(1, 2)` → one side edits each argument) merge the way a
  // tree-sitter merge does, instead of conflicting on the whole statement. For providers
  // without parsesUnit, validity is enforced where the result lands (whole-file re-parse).
  const tm = tokenMerge(lang, baseText, aText, bText, mopts)
  if (tm != null && lang.parsesUnit && !lang.parsesUnit(tm)) return null
  return tm
}

function tryStructuralInner(lang, baseText, aText, bText, mopts = {}) {
  if (!lang.splitUnit) return null
  const pb = lang.splitUnit(baseText), pa = lang.splitUnit(aText), pbb = lang.splitUnit(bText)
  if (!pb || !pa || !pbb) return null
  if (pa.sig.trim() !== pbb.sig.trim()) return null
  const m = mergeKeyed(lang, pb.units, pa.units, pbb.units, mopts)
  if (m.conflicts.length) return null
  // FORMAT-PRESERVING inner assembly: when the provider exposes the body text + byte-ranged
  // units (spliceable), rebuild the body by splicing merged units back into the BASE body,
  // so everything BETWEEN statements — comments, blank lines, indentation — survives verbatim.
  // (Join-based reassembly with a fixed separator silently drops inner comments and reflows
  // whitespace; found in the wild merging ICR's own source, and the C-family class-brace glue.)
  // Objects and any non-spliceable provider fall back to the separator join.
  let text
  const spliceable = pb.spliceable && typeof pb.body === 'string' && pb.units.every((u) => typeof u.start === 'number' && typeof u.end === 'number')
  if (spliceable) {
    // COMMENT-EDIT PRESERVATION: gaps (comments/blank lines between statements) come from
    // the splice BASIS. Splicing from base loses a side's comment-only edit. So: if exactly
    // ONE side changed only gaps (its units are byte-identical to base's), splice into THAT
    // side's body — its comment edit survives and the other side's code edits land on top.
    // If BOTH sides changed only gaps, refuse (null) so the unit surfaces as a conflict
    // instead of silently dropping either side's comment.
    const sameUnits = (u1, u2) => u1.length === u2.length && u1.every((u, i) => u.key === u2[i].key && u.text === u2[i].text)
    const aGapOnly = pa.body !== pb.body && sameUnits(pa.units, pb.units)
    const bGapOnly = pbb.body !== pb.body && sameUnits(pbb.units, pb.units)
    if (aGapOnly && bGapOnly) return null
    const [basisBody, basisUnits] = aGapOnly ? [pa.body, pa.units] : bGapOnly ? [pbb.body, pbb.units] : [pb.body, pb.units]
    const body = spliceUnits(basisBody, basisUnits, m.order, m.textByKey, { trimLeadingBlank: false })
    text = pa.sig + pa.open + body + pa.close
  } else {
    text = pa.sig + pa.open + m.parts.join(pa.join) + pa.close
  }
  const valid = lang.parsesUnit || lang.parses // accept class-member fragments when supported
  return valid(text) ? text : null
}

// TOKEN-LEVEL 3-way merge of one unit. base/a/b are the unit texts, both differing from base
// (the caller only asks when both sides changed the same unit). Diff each side against base at
// TOKEN granularity — one changed span via common prefix + common suffix — map each span to a
// base CHARACTER range, and, if the two base spans are DISJOINT, splice both sides' replacement
// text into base. Everything OUTSIDE the two edits comes from base verbatim (whitespace,
// comments); inside, each side's exact bytes. Overlapping or ambiguously-adjacent edits → null
// (a real conflict). Symmetric by construction: the result is base with two position-disjoint
// substring replacements, independent of which side is a or b — so live peers converge.
function tokenDiffRange(base, other) {
  const n = base.length, m = other.length
  let eq = n === m
  if (eq) { for (let i = 0; i < n; i++) if (base[i] !== other[i]) { eq = false; break } }
  if (eq) return null
  let p = 0
  const maxp = Math.min(n, m)
  while (p < maxp && base[p] === other[p]) p++
  let s = 0
  while (s < n - p && s < m - p && base[n - 1 - s] === other[m - 1 - s]) s++
  return { bStart: p, bEnd: n - s, oStart: p, oEnd: m - s }
}

function tokenMerge(lang, baseText, aText, bText, mopts = {}) {
  if (!lang.tokenize) return null
  const B = lang.tokenize(baseText), A = lang.tokenize(aText), Bb = lang.tokenize(bText)
  if (!B || !A || !Bb) return null
  const ra = tokenDiffRange(B.map((t) => t.k), A.map((t) => t.k))
  const rb = tokenDiffRange(B.map((t) => t.k), Bb.map((t) => t.k))
  if (!ra && !rb) return null // both sides changed only whitespace/comments → can't rank them
  // REFORMAT vs CONTENT: one side changed only whitespace/comments (token stream identical
  // to base), the other changed tokens. Apply the content side's token edit ONTO the
  // reformatting side's text — its token stream matches base's, so token indices map its
  // own byte ranges exactly. Both intents survive: the reformat/comment edit AND the code
  // change. (Ground-truth replay: this was a top false-conflict source on real repos.)
  // Symmetric because the roles are decided by CONTENT (which side has the token diff).
  if (!ra || !rb) {
    const [wsToks, wsText, r, toks, text] = !ra ? [A, aText, rb, Bb, bText] : [Bb, bText, ra, A, aText]
    const cStart = r.bStart < wsToks.length ? wsToks[r.bStart].start : wsText.length
    const cEnd = r.bEnd > r.bStart ? wsToks[r.bEnd - 1].end : cStart
    const ins = r.oEnd > r.oStart ? text.slice(toks[r.oStart].start, toks[r.oEnd - 1].end) : ''
    return wsText.slice(0, cStart) + ins + wsText.slice(cEnd)
  }
  const charRange = (r) => {
    const cStart = r.bStart < B.length ? B[r.bStart].start : baseText.length
    const cEnd = r.bEnd > r.bStart ? B[r.bEnd - 1].end : cStart
    return [cStart, cEnd]
  }
  const repl = (toks, text, r) => (r.oEnd > r.oStart ? text.slice(toks[r.oStart].start, toks[r.oEnd - 1].end) : '')
  const [aS, aE] = charRange(ra), [bS, bE] = charRange(rb)
  // Single contiguous spans that don't collide: splice both (the cheap common case).
  if (!(aS < bE && bS < aE) && aS !== bS) {
    const edits = [{ s: aS, e: aE, t: repl(A, aText, ra) }, { s: bS, e: bE, t: repl(Bb, bText, rb) }].sort((x, y) => y.s - x.s)
    let out = baseText
    for (const ed of edits) out = out.slice(0, ed.s) + ed.t + out.slice(ed.e)
    return out
  }
  // The prefix/suffix spans collide — but each is the BOUNDING BOX of that side's edits,
  // and boxes overlap whenever a side edited in two places (a wrapper rewrite touches both
  // ends, so its box swallows the whole unit). Re-diff each side at REAL multi-hunk
  // granularity (Myers) and do token-level diff3: disjoint hunks interleave, identical
  // hunks dedupe, truly overlapping hunks are the only conflict. Ground-truth replay:
  // "one side rewrote the wrapper, the other edited inside" is a real-repo staple.
  return tokenMerge3(baseText, aText, bText, B, A, Bb, mopts)
}

// Myers O(ND) diff on token-key arrays → edit hunks {bs,be,os,oe} (base/other token ranges).
function tokenHunks(bk, ok, maxD) {
  const N = bk.length, M = ok.length
  const MAX = Math.min(N + M, maxD)
  const V = new Map([[1, 0]])
  const trace = []
  let D = -1
  outer: for (let d = 0; d <= MAX; d++) {
    trace.push(new Map(V))
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (V.get(k - 1) ?? 0) < (V.get(k + 1) ?? 0))) ? (V.get(k + 1) ?? 0) : (V.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < N && y < M && bk[x] === ok[y]) { x++; y++ }
      V.set(k, x)
      if (x >= N && y >= M) { D = d; break outer }
    }
  }
  if (D < 0) return null // too different for the budget → caller falls back
  // backtrack into hunks
  const ops = [] // 1 = del base token, 2 = ins other token, stored back-to-front
  let x = N, y = M
  for (let d = D; d > 0; d--) {
    const Vp = trace[d]
    const k = x - y
    const down = k === -d || (k !== d && (Vp.get(k - 1) ?? 0) < (Vp.get(k + 1) ?? 0))
    const pk = down ? k + 1 : k - 1
    const px = Vp.get(pk) ?? 0
    const py = px - pk
    while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) { x--; y-- } // snake
    if (down) { y--; ops.push([2, x, y]) } else { x--; ops.push([1, x, y]) }
  }
  ops.reverse()
  const hunks = []
  for (const [op, bx, oy] of ops) {
    const last = hunks[hunks.length - 1]
    if (op === 1) {
      if (last && last.be === bx && last.oe === oy) last.be = bx + 1
      else hunks.push({ bs: bx, be: bx + 1, os: oy, oe: oy })
    } else {
      if (last && last.be === bx && last.oe === oy) last.oe = oy + 1
      else hunks.push({ bs: bx, be: bx, os: oy, oe: oy + 1 })
    }
  }
  return hunks
}

// diff3 over two hunk lists: identical hunks dedupe; disjoint hunks both apply; overlap
// → conflict (null). Two INSERTIONS at the same base point are ambiguous (order
// unknowable) → conflict. `ak`/`bbk` are each side's atom arrays (token keys or lines),
// used to compare replacement content for the dedupe check. Returns [{h, side}] in base
// order, or null. Symmetric: ordering decisions are content/position-based, never
// side-identity-based, so merge(a,b) === merge(b,a) is preserved by construction.
function diff3Interleave(ha, hb, ak, bbk, opts = {}) {
  const sameHunk = (x, y) => x.bs === y.bs && x.be === y.be && (x.oe - x.os) === (y.oe - y.os) &&
    ak.slice(x.os, x.oe).every((k, i) => k === bbk[y.os + i])
  const edits = []
  let i = 0, j = 0
  while (i < ha.length || j < hb.length) {
    const x = ha[i], y = hb[j]
    if (x && y) {
      const overlap = x.bs < y.be && y.bs < x.be
      const samePointInsert = x.bs === y.bs && x.be === x.bs && y.be === y.bs
      if (overlap || samePointInsert) {
        if (sameHunk(x, y)) { edits.push({ h: x, side: 'a' }); i++; j++; continue }
        // UNION MODE (opt-in, for independent-intent merges — the multi-agent case where
        // the medium KNOWS the two edits serve different tasks): two pure INSERTIONS at
        // the same base point both survive, in content order (side-independent, so peers
        // converge). Everything else (true overlaps, edit-vs-edit) still conflicts, and
        // the parse gates downstream still refuse any union that breaks the code.
        if (samePointInsert && opts.unionInserts) {
          const ka = ak.slice(x.os, x.oe).join('\n'), kb = bbk.slice(y.os, y.oe).join('\n')
          const [first, second] = ka <= kb ? [{ h: x, side: 'a' }, { h: y, side: 'b' }] : [{ h: y, side: 'b' }, { h: x, side: 'a' }]
          edits.push(first, second); i++; j++; continue
        }
        return null
      }
      if (x.bs < y.bs || (x.bs === y.bs && x.be <= y.bs && x.be < y.be)) { edits.push({ h: x, side: 'a' }); i++ }
      else { edits.push({ h: y, side: 'b' }); j++ }
    } else if (x) { edits.push({ h: x, side: 'a' }); i++ }
    else { edits.push({ h: y, side: 'b' }); j++ }
  }
  return edits
}

const TOKEN3_MAX_TOKENS = 20000, TOKEN3_MAX_D = 4000
function tokenMerge3(baseText, aText, bText, B, A, Bb, mopts = {}) {
  if (B.length > TOKEN3_MAX_TOKENS || A.length > TOKEN3_MAX_TOKENS || Bb.length > TOKEN3_MAX_TOKENS) return null
  const bk = B.map((t) => t.k)
  const ha = tokenHunks(bk, A.map((t) => t.k), TOKEN3_MAX_D)
  const hb = tokenHunks(bk, Bb.map((t) => t.k), TOKEN3_MAX_D)
  if (!ha || !hb) return null
  const edits = diff3Interleave(ha, hb, A.map((t) => t.k), Bb.map((t) => t.k), mopts)
  if (!edits) return null
  // splice back-to-front, mapping token hunks to base char ranges; replacement bytes come
  // from the editing side's exact text between its tokens. A guard space prevents two word
  // tokens fusing at a splice boundary (parse validation downstream still has final say).
  const wordish = (c) => c && /[A-Za-z0-9_$]/.test(c)
  let out = baseText
  for (let e = edits.length - 1; e >= 0; e--) {
    const { h, side } = edits[e]
    const [toks, text] = side === 'a' ? [A, aText] : [Bb, bText]
    const cS = h.bs < B.length ? B[h.bs].start : baseText.length
    const cE = h.be > h.bs ? B[h.be - 1].end : cS
    let ins = h.oe > h.os ? text.slice(toks[h.os].start, toks[h.oe - 1].end) : ''
    if (ins && wordish(out[cS - 1]) && wordish(ins[0])) ins = ' ' + ins
    if (ins && wordish(out[cE]) && wordish(ins[ins.length - 1])) ins = ins + ' '
    out = out.slice(0, cS) + ins + out.slice(cE)
  }
  return out
}

// LINE-LEVEL 3-way merge of one unit: the same Myers + diff3 interleave with WHOLE LINES
// as atoms. Every replacement carries complete lines verbatim — indentation can never be
// stranded or doubled, which is what makes it the safe multi-hunk tier for indentation
// languages (the ConGra corpus showed token-splice arithmetic mangling Python indent when
// hunks straddle newline tokens: `conn = None` landing at column 0, a doubled 16-space
// indent). Token-level still runs after this for same-line micro-edits; this tier catches
// the far more common "both sides edited different LINES of the same unit" cleanly.
function splitLinesKeepEnds(text) {
  const out = []
  let i = 0
  while (i < text.length) { let e = text.indexOf('\n', i); e = e < 0 ? text.length : e + 1; out.push(text.slice(i, e)); i = e }
  return out
}
function lineMerge3(baseText, aText, bText, mopts = {}) {
  const L = splitLinesKeepEnds(baseText), La = splitLinesKeepEnds(aText), Lb = splitLinesKeepEnds(bText)
  if (L.length > TOKEN3_MAX_TOKENS) return null
  const ha = tokenHunks(L, La, TOKEN3_MAX_D)
  const hb = tokenHunks(L, Lb, TOKEN3_MAX_D)
  if (!ha || !hb) return null
  const edits = diff3Interleave(ha, hb, La, Lb, mopts)
  if (!edits) return null
  const out = L.slice()
  for (let e = edits.length - 1; e >= 0; e--) {
    const { h, side } = edits[e]
    const src = side === 'a' ? La : Lb
    out.splice(h.bs, h.be - h.bs, ...src.slice(h.os, h.oe))
  }
  return out.join('')
}

// FORMAT-PRESERVING assembly: rebuild the merged file by splicing the merged units back
// into the BASE text at their original byte ranges. Unchanged units — and all the
// whitespace/comments BETWEEN units — survive verbatim; only changed units carry the
// editing side's bytes, and genuinely new units are appended. This is what stops ICR from
// reformatting code it merges. Deterministic and symmetric, so peers converge.
function spliceUnits(baseText, baseUnits, order, textByKey, opts = {}) {
  const baseKeySet = new Set(baseUnits.map((u) => u.key))
  const baseByKey = new Map(baseUnits.map((u) => [u.key, u]))
  const orderSet = new Set(order)
  const deleted = baseUnits.filter((u) => !orderSet.has(u.key))
  let out = '', pos = 0

  function emitGap(from, to) {
    let cursor = from
    for (const d of deleted) {
      if (d.start >= cursor && d.end <= to) {
        out += baseText.slice(cursor, d.start)
        cursor = d.end
      }
    }
    out += baseText.slice(cursor, to)
  }

  for (const k of order) {
    if (baseKeySet.has(k)) {
      const u = baseByKey.get(k)
      if (u.start >= pos) {
        emitGap(pos, u.start)
        pos = u.end
      }
      out += textByKey.get(k)
    } else {
      // New unit: insert it exactly where the merge order dictated
      out += (out.endsWith('\n') ? '' : '\n') + textByKey.get(k) + '\n'
    }
  }
  if (pos < baseText.length) {
    emitGap(pos, baseText.length)
  }
  // Top-level: drop orphan leading blank lines a deleted first decl leaves behind. Inner
  // splice (trimLeadingBlank:false): keep the body's own leading `\n  ` so indentation holds.
  return opts.trimLeadingBlank === false ? out : out.replace(/^\n+/, '')
}

// --- public API -----------------------------------------------------------------

// Does this source parse under the given (or default JS) language?
export function parses(src, lang = javascript) { return lang.parses(src) }

// 3-way STRUCTURAL + INTENT merge of `a` and `b` against common ancestor `base`.
// opts: { lang } a provider, or { filename } to pick one by extension (defaults to JS).
// Returns { status, text, conflicts, renames? }:
//   'auto'              — clean merge; `text` is valid, parseable code.
//   'semantic-conflict' — same declaration changed both sides, or a dangling reference;
//                         `conflicts` names them (e.g. ['fn:login'] or ['ref:helper']).
//   'fallback'          — couldn't merge safely (unparseable input, or the merge wouldn't
//                         parse, or unsupported language); caller keeps both. Never broken.
export function structuralMerge(base, a, b, opts = {}) {
  const lang = opts.lang || (opts.filename ? languageFor(opts.filename) : javascript) || javascript

  if (!lang.parses(base) || !lang.parses(a) || !lang.parses(b))
    return { status: 'fallback', text: null, conflicts: [], reason: 'unparseable input' }

  // FIXED-POINT fast path: once two peers agree on a text T, re-merging must return T
  // unchanged. This is what makes the live sync settle. Both agree ⇒ nothing to check.
  if (a === b) return { status: 'auto', text: a, conflicts: [], renames: [], provenance: [] }

  const authors = opts.authors || {}
  const attribute = (prov) => (prov || []).map((p) => ({ unit: p.key, author: authors[p.from] || p.from }))

  // Determine the structurally-merged text + provenance. A one-sided change takes that
  // side verbatim (format perfectly preserved); otherwise do the keyed 3-way merge and
  // splice it back into base. Either way the INTENT layer below still runs, so a deletion
  // that leaves a dangling reference is caught even when only one side changed.
  let text, provenance
  if (a === base) { text = b; provenance = [] }
  else if (b === base) { text = a; provenance = [] }
  else if (lang.mergeWhole) {
    // WHOLE-DOCUMENT MERGE: a provider that understands the entire document as DATA
    // (e.g. JSON) merges it directly — real-parser accuracy, value-wise 3-way semantics,
    // conflicts named by path. Returns { text } on success, { conflicts, resolvable? } on
    // a same-value clash, or null when it can't (engine falls back safely).
    const w = lang.mergeWhole(base, a, b)
    if (!w) return { status: 'fallback', text: null, conflicts: [], reason: 'whole-document merge failed' }
    if (w.conflicts && w.conflicts.length) return { status: 'semantic-conflict', text: null, conflicts: w.conflicts, resolvable: w.resolvable || [] }
    text = w.text; provenance = w.provenance || []
  }
  else {
    const baseUnits = lang.units(base)
    const merge = mergeKeyed(lang, baseUnits, lang.units(a), lang.units(b), { unionInserts: !!opts.unionInserts })
    if (merge.conflicts.length) return { status: 'semantic-conflict', text: null, conflicts: merge.conflicts, resolvable: merge.conflictUnits }
    // Prefer the format-preserving splice (units carry byte ranges); fall back to a plain
    // join for languages whose units don't expose ranges.
    const canSplice = baseUnits.every((u) => typeof u.start === 'number')
    text = canSplice ? spliceUnits(base, baseUnits, merge.order, merge.textByKey) : merge.parts.join('\n\n') + '\n'
    provenance = merge.provenance
  }

  // THE GUARANTEE: the merged result must parse, or we refuse it.
  // THE GUARANTEE stands: a merge that would not parse is REFUSED — text stays null so no
  // caller can ever mistake broken output for a merge. (Debugging wants the bytes? That is
  // what `debugText` is for; it is deliberately not `text`.)
  if (!lang.parses(text)) return { status: 'fallback', text: null, debugText: text, conflicts: [], reason: 'merge would not parse' }

  // RENAME DETECTION (intent): a declaration gone from base whose identical-bodied twin
  // appears under a new name is a rename — rewrite stale call sites to the new name.
  let merged = text
  const baseNames = lang.declaredNames(base)
  let mergedNames = lang.declaredNames(merged)
  let removed = [...baseNames].filter((n) => !mergedNames.has(n))
  const renames = []
  const rename = lang.renameFreeRefs || lang.renameRefs // prefer scope-aware rewriting
  
  if (removed.length && lang.declBody && rename) {
    const added = [...mergedNames].filter((n) => !baseNames.has(n))
    const claimed = new Set()
    for (const oldName of removed) {
      const oldBody = lang.declBody(base, oldName)
      if (oldBody == null) continue
      const match = added.find((n) => !claimed.has(n) && lang.declBody(merged, n) === oldBody)
      if (match) { renames.push([oldName, match]); claimed.add(match) }
    }
    let rewritten = merged
    // Rewrite only references that resolve to the renamed binding (scope-aware) — a local
    // variable that merely shares the old name is left untouched.
    for (const [oldName, newName] of renames) rewritten = rename(rewritten, oldName, newName)
    // only accept the rewrite if it still parses — never trade a parse error for intent.
    if (renames.length && lang.parses(rewritten)) { merged = rewritten; mergedNames = lang.declaredNames(merged) }
  }

  // DANGLING REFERENCE (intent): a declaration removed (and NOT explained by a rename)
  // but still referenced is a semantic conflict even though the code parses cleanly.
  // Uses the SCOPE-AWARE reference set when the language provides one (so a local binding
  // that merely shares the deleted name is correctly NOT treated as a reference to it),
  // falling back to the approximate identifier set otherwise.
  removed = [...baseNames].filter((n) => !mergedNames.has(n))
  const refs = lang.referencedFreeNames ? lang.referencedFreeNames(merged)
    : lang.usedIdentifiers ? lang.usedIdentifiers(merged) : null
  if (process.env.ICR_DEBUG_MERGED) console.error('--- ICR merged intermediate ---\n' + merged + '\n--- refs: ' + [...(refs || [])].join(',') + ' ---')
  if (removed.length && refs) {
    const dangling = removed.filter((n) => refs.has(n))
    if (dangling.length)
      return { status: 'semantic-conflict', text: null, conflicts: dangling.map((n) => 'ref:' + n), reason: 'dangling reference: a declaration was removed/renamed but is still used' }
  }
  // PROVENANCE: attribute each surviving unit to the author whose version we kept. With
  // opts.authors = { a, b, base } the labels are real names; otherwise they're 'a'/'b'/etc.
  return {
    status: 'auto', text: merged, conflicts: [],
    renames: renames.map(([o, n]) => o + '->' + n),
    provenance: attribute(provenance),
  }
}

// Internal handles for diagnostic harnesses (not part of the public API).
export const _internals = { tokenMerge, tokenMerge3, tokenHunks, tryInnerMerge, lineMerge3 }
