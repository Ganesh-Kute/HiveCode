// icr-merge — Intent-aware Code Replication: a 3-way merge that understands
// code structure and author intent, built for the age of AI-authored code.
//
// Two tiers, one call:
//   1. STRUCTURAL + INTENT (icr.js): parses both sides, merges by declaration,
//      preserves formatting, auto-applies renames across call sites, refuses any
//      result that would not parse, and reports meaning-level conflicts a line
//      merge cannot see (two authors changing the same function; a deleted
//      declaration that is still referenced).
//   2. LINE FALLBACK (merge3.js): git-style diff3 with conflict markers — the
//      floor is never worse than what git gives you, and no edit is ever lost.
//
// merge(base, ours, theirs, { filename }) picks the tier automatically.

import { structuralMerge, supports, languageFor } from './icr.js'
import { merge3 } from './merge3.js'

export { structuralMerge, registerLanguage, languageFor, supports, parses } from './icr.js'
export { merge3, hasConflictMarkers, changedRange } from './merge3.js'

// Turn ICR's machine conflict keys into a human sentence.
export function describeConflicts(conflicts) {
  return (conflicts || []).map((c) => {
    if (c.startsWith('ref:')) return `'${c.slice(4)}' was removed or renamed but is still used`
    if (c.startsWith('fn:')) return `both sides changed function ${c.slice(3)}`
    if (c.startsWith('class:')) return `both sides changed class ${c.slice(6)}`
    if (c.startsWith('var:')) return `both sides changed ${c.slice(4)}`
    return `both sides changed ${c}`
  }).join('; ')
}

// The one-call API. Returns:
//   {
//     text,               // the merged content — ALWAYS present, never null
//     clean,              // true = no conflict markers in text
//     method,             // 'structural' | 'rename' | 'lines'
//     renames?,           // ['oldName->newName', ...] when method === 'rename'
//     provenance?,        // [{ unit, author }] per surviving declaration (structural only)
//     semantic?,          // ICR conflict keys (e.g. ['fn:login']) when ICR saw a
//                         //   meaning-level conflict and the line tier took over
//     warning?,           // human sentence for `semantic`
//     resolvable?,        // machine-resolvable conflict units [{ key, kind, base, ours,
//                         //   theirs, oursIntent, theirsIntent, filename }] — feed to
//                         //   resolveMerge() for intent-aware autonomous resolution
//   }
// opts: { filename }  — picks the language provider by extension (required for
//                       structural tier; omit → line merge only)
//        { authors }   — { a, b, base } real names for provenance attribution
//        { intents }   — { ours, theirs } why each side changed the code; carried into
//                        `resolvable` so a judge agent can reconcile by intent, not text
export function merge(base, ours, theirs, opts = {}) {
  const filename = opts.filename || ''
  if (filename && supports(filename)) {
    let r = null
    try { r = structuralMerge(base, ours, theirs, { filename, authors: opts.authors }) }
    catch { r = null } // the engine must never take down the caller — fall to lines
    if (r && r.status === 'auto') {
      return {
        text: r.text, clean: true,
        method: r.renames && r.renames.length ? 'rename' : 'structural',
        renames: r.renames, provenance: r.provenance,
      }
    }
    if (r && r.status === 'semantic-conflict') {
      // ICR saw a meaning-level problem (both sides changed the same declaration in a way
      // that can't be reconciled, or a declaration was removed/renamed but is still used).
      // This is NEVER clean — even when the line tier merges without textual overlap (the
      // classic deleted-but-referenced case line-merges "cleanly" but is broken). Report
      // clean:false so no consumer ships it silently; `text` keeps both edits (line tier),
      // `semantic`/`warning` say exactly what's wrong. This is the failure git and every
      // line/CRDT merge — and even tree-sitter structural mergers — ship without noticing.
      const lm = merge3(base, ours, theirs)
      const intents = opts.intents || {}
      // A machine-resolvable conflict: each entry carries the three exact versions of ONE
      // conflicting declaration plus each side's INTENT (why it changed). This is what makes
      // autonomous, intent-aware resolution possible — see resolveMerge().
      const resolvable = (r.resolvable || []).map((u) => ({
        key: u.key, kind: 'both-changed',
        base: u.base, ours: u.ours, theirs: u.theirs,
        oursIntent: intents.ours != null ? intents.ours : null,
        theirsIntent: intents.theirs != null ? intents.theirs : null,
        filename,
      }))
      return {
        text: lm.text, clean: false, method: 'lines',
        semantic: r.conflicts, warning: describeConflicts(r.conflicts),
        resolvable,
      }
    }
    // status 'fallback' (unparseable input / merge would not parse) → lines
  }
  const lm = merge3(base, ours, theirs)
  return { text: lm.text, clean: !lm.conflict, method: 'lines' }
}

// INTENT-AWARE AUTONOMOUS RESOLUTION — the thing no other merge tool can do, because every
// other one merges dead text with no author present. Here the authors are live agents that
// know WHY they changed the code. When merge() reports a semantic conflict (both sides changed
// the same declaration), we hand each conflicting unit — base/ours/theirs + each side's intent
// — to a pluggable `judge` (an LLM/agent call the caller supplies) and ask for a reconciled
// version. Then the crucial part: the judge's answer is fed back through the FULL engine, so a
// hallucinated or broken reconciliation cannot ship — it is re-validated for parse-correctness
// and dangling references exactly like any merge, and rejected (safe conflict returned) if it
// fails. AI resolves the conflict; ICR guarantees the result is still valid code.
//
//   opts: { filename, intents: { ours, theirs }, judge }
//   judge(unit) -> Promise<string|null>   // unit: { key, kind, base, ours, theirs,
//                                          //         oursIntent, theirsIntent, filename }
//                                          // return reconciled unit text, or null to decline
//   returns the merge() shape, plus:
//     resolved: boolean          // true = a conflict was reconciled AND re-validated clean
//     method: 'resolved'         // when resolved
//     resolutions: [{ key, reconciled }]
export async function resolveMerge(base, ours, theirs, opts = {}) {
  const r = merge(base, ours, theirs, opts)
  if (r.clean) return { ...r, resolved: false }
  const units = r.resolvable
  if (!units || !units.length || typeof opts.judge !== 'function') return { ...r, resolved: false }

  // Reconcile each conflicting unit, then rewrite BOTH sides to the reconciled text so they
  // agree — turning the conflict into an ordinary (clean) merge that the engine re-validates.
  // Code languages splice by exact unit text; a DATA language (JSON) exposes applyResolution
  // (set the reconciled VALUE at the conflicted path) because its unit "text" is a rendering
  // of a parsed value and may not appear verbatim in the document.
  const lang0 = opts.filename ? languageFor(opts.filename) : null
  let ours2 = ours, theirs2 = theirs
  const resolutions = []
  for (const u of units) {
    let reconciled
    try { reconciled = await opts.judge(u) } catch { reconciled = null }
    if (typeof reconciled !== 'string') return { ...r, resolved: false } // judge declined → safe conflict
    if (lang0 && typeof lang0.applyResolution === 'function') {
      const o2 = lang0.applyResolution(ours2, u, reconciled)
      const t2 = lang0.applyResolution(theirs2, u, reconciled)
      if (typeof o2 !== 'string' || typeof t2 !== 'string') return { ...r, resolved: false }
      ours2 = o2; theirs2 = t2
    } else {
      if (!ours2.includes(u.ours) || !theirs2.includes(u.theirs)) return { ...r, resolved: false }
      ours2 = ours2.replace(u.ours, reconciled)
      theirs2 = theirs2.replace(u.theirs, reconciled)
    }
    resolutions.push({ key: u.key, reconciled })
  }

  // Re-merge with the reconciled units, then re-validate. A bad reconciliation must never
  // ship: it either re-conflicts, or — because we wrote the SAME text to both sides, the line
  // tier would happily return that agreed text even if it's broken — we explicitly re-PARSE
  // the result with the structural provider. Only a clean AND parseable result is accepted;
  // anything else falls back to the original safe conflict. This is the guarantee that makes
  // AI-resolved merges trustworthy: the judge proposes, ICR verifies.
  const r2 = merge(base, ours2, theirs2, opts)
  const lang = opts.filename ? languageFor(opts.filename) : null
  const valid = !lang || lang.parses(r2.text)
  if (r2.clean && valid) return { ...r2, method: 'resolved', resolved: true, resolutions }
  return { ...r, resolved: false }
}
