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
//   }
// opts: { filename }  — picks the language provider by extension (required for
//                       structural tier; omit → line merge only)
//        { authors }   — { a, b, base } real names for provenance attribution
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
      // ICR saw a meaning-level problem. The line tier produces the bytes (both
      // versions preserved), and we surface WHAT was semantically wrong so the
      // caller never ships it silently.
      const lm = merge3(base, ours, theirs)
      return {
        text: lm.text, clean: !lm.conflict, method: 'lines',
        semantic: r.conflicts, warning: describeConflicts(r.conflicts),
      }
    }
    // status 'fallback' (unparseable input / merge would not parse) → lines
  }
  const lm = merge3(base, ours, theirs)
  return { text: lm.text, clean: !lm.conflict, method: 'lines' }
}
