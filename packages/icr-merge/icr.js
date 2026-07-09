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

// --- language registry ----------------------------------------------------------
// JavaScript (acorn, full intent layer) first; then structural providers for the
// C-family (TypeScript, Go, Rust, Java, C/C++, C#, Swift, Kotlin, …) and Python.
// These cover disjoint extensions, so order only matters on clashes (none today).
const LANGUAGES = [javascript, ...braceLanguages, python]

// Register an additional language provider. Must expose the provider contract:
// { id, exts:[...], parses, units, declaredNames, usedIdentifiers, declBody,
//   renameRefs, fnParts }. Newest wins on extension clashes.
export function registerLanguage(provider) { LANGUAGES.unshift(provider) }

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

// Core 3-way merge over a KEYED list of units (works at file level AND, recursively,
// inside a single declaration). Returns { conflicts:[...], parts:[...text] }.
// When both sides change the SAME key into different things, it first tries to descend
// INTO that unit (finer granularity) — only a clash it can't resolve becomes a conflict.
function mergeKeyed(lang, baseU, aU, bU) {
  const B = mapOf(baseU), A = mapOf(aU), Bb = mapOf(bU)
  const keys = dedupeOrder([...baseU.map((u) => u.key), ...aU.map((u) => u.key), ...bU.map((u) => u.key)])

  const conflicts = [], resolved = new Map()
  for (const k of keys) {
    const bs = B.has(k) ? B.get(k) : null
    const as_ = A.has(k) ? A.get(k) : null
    const bbs = Bb.has(k) ? Bb.get(k) : null
    const changedA = as_ !== bs, changedB = bbs !== bs
    if (changedA && changedB && as_ !== bbs) {
      // Both touched the same unit, differently. Try finer-grained inner merge first.
      if (bs != null && as_ != null && bbs != null) {
        const inner = tryInnerMerge(lang, bs, as_, bbs)
        if (inner != null) { resolved.set(k, inner); continue }
      }
      conflicts.push(k)
    }
  }
  if (conflicts.length) return { conflicts, parts: [] }

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

  // CONVERGENCE: the output order must be IDENTICAL no matter which side is `a` vs `b`,
  // or two peers compute different text and never settle (then re-merging the divergence
  // corrupts the file). So: surviving base units keep their base order; units added by a
  // side are appended in a canonical (sorted) order — deterministic and symmetric.
  const baseOrder = dedupeOrder(baseU.map((u) => u.key))
  const baseSet = new Set(baseOrder)
  const final = []
  for (const k of baseOrder) if (survives.has(k)) final.push(k)
  for (const k of [...survives].filter((k) => !baseSet.has(k)).sort()) final.push(k)

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
function tryInnerMerge(lang, baseText, aText, bText) {
  // Language-specific same-key merges first (e.g. unioning import specifiers).
  if (lang.mergeUnit) {
    const t = lang.mergeUnit(baseText, aText, bText)
    if (t != null && lang.parses(t)) return t
  }
  if (!lang.splitUnit) return null
  const pb = lang.splitUnit(baseText), pa = lang.splitUnit(aText), pbb = lang.splitUnit(bText)
  if (!pb || !pa || !pbb) return null
  if (pa.sig.trim() !== pbb.sig.trim()) return null // signature itself changed → real conflict
  const m = mergeKeyed(lang, pb.units, pa.units, pbb.units)
  if (m.conflicts.length) return null
  const text = pa.sig + pa.open + m.parts.join(pa.join) + pa.close
  const valid = lang.parsesUnit || lang.parses // accept class-member fragments when supported
  return valid(text) ? text : null
}

// FORMAT-PRESERVING assembly: rebuild the merged file by splicing the merged units back
// into the BASE text at their original byte ranges. Unchanged units — and all the
// whitespace/comments BETWEEN units — survive verbatim; only changed units carry the
// editing side's bytes, and genuinely new units are appended. This is what stops ICR from
// reformatting code it merges. Deterministic and symmetric, so peers converge.
function spliceUnits(baseText, baseUnits, order, textByKey) {
  const baseKeySet = new Set(baseUnits.map((u) => u.key))
  const surviving = new Set(order.filter((k) => baseKeySet.has(k)))
  const emitted = new Set()
  let out = '', pos = 0
  for (const u of baseUnits) {
    out += baseText.slice(pos, u.start) // gap before this unit (comments/blank lines), verbatim
    if (surviving.has(u.key) && !emitted.has(u.key)) { out += textByKey.get(u.key); emitted.add(u.key) }
    pos = u.end
  }
  const added = order.filter((k) => !baseKeySet.has(k))
  if (added.length) {
    const head = out.replace(/\s*$/, '')
    out = (head ? head + '\n\n' : '') + added.map((k) => textByKey.get(k)).join('\n\n') + '\n'
  } else {
    out += baseText.slice(pos) // trailing whitespace (final newline) verbatim
  }
  return out.replace(/^\n+/, '') // drop orphan leading blank lines left by a deleted first unit
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
  else {
    const baseUnits = lang.units(base)
    const merge = mergeKeyed(lang, baseUnits, lang.units(a), lang.units(b))
    if (merge.conflicts.length) return { status: 'semantic-conflict', text: null, conflicts: merge.conflicts }
    // Prefer the format-preserving splice (units carry byte ranges); fall back to a plain
    // join for languages whose units don't expose ranges.
    const canSplice = baseUnits.every((u) => typeof u.start === 'number')
    text = canSplice ? spliceUnits(base, baseUnits, merge.order, merge.textByKey) : merge.parts.join('\n\n') + '\n'
    provenance = merge.provenance
  }

  // THE GUARANTEE: the merged result must parse, or we refuse it.
  if (!lang.parses(text)) return { status: 'fallback', text: null, conflicts: [], reason: 'merge would not parse' }

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
