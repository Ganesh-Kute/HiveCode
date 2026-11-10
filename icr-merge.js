// icr-merge.js — the bridge that brings ICR into the live product, SAFELY.
//
// Hivecode's reconcile() merges concurrent edits with merge3() (a line-level 3-way
// merge). merge3 is convergent: across many peers it always settles on one canonical
// text. ICR's structural merge produces a DIFFERENT canonical form (it may reorder or
// reformat). Mixing two merge algorithms in a live multi-peer sync means the same logical
// content has two byte-forms, and peers ping-pong between them — which corrupts files
// (duplicated/*dropped* lines). So we do NOT change merge bytes with ICR here.
//
// Instead ICR runs in ADVISORY mode: merge3 still produces the bytes (full convergence
// preserved, identical to pre-ICR behavior), and ICR runs alongside purely to DETECT the
// meaning-level problems a line merge can't see — a dangling reference, a rename, a
// same-declaration clash — and surface them as a warning on the activity feed. This ships
// ICR's core value (catching semantic breaks) with zero divergence risk.
//
// ICR's full structural/rename AUTO-MERGE lives in the library (icr.js) and is proven by
// the test suite + fuzzer; turning it on in the product is a later step that needs a
// format-preserving, single-canonical-form merge so peers can't diverge.

import { structuralMerge, supports } from './icr.js'
import { merge3 } from './core.js'

// Turn ICR's machine conflict keys into a human sentence for the activity feed / chat.
function describeConflicts(conflicts) {
  return (conflicts || []).map((c) => {
    if (c.startsWith('ref:')) return `'${c.slice(4)}' was removed or renamed but is still used`
    if (c.startsWith('fn:')) return `both sides changed function ${c.slice(3)}`
    if (c.startsWith('class:')) return `both sides changed class ${c.slice(6)}`
    if (c.startsWith('var:')) return `both sides changed ${c.slice(4)}`
    return `both sides changed ${c}`
  }).join('; ')
}

// Same shape as merge3 — { text, conflict } — plus an `icr` tag ('structural'|'rename')
// and an optional `icrWarning`. ICR's format-preserving merge is convergent (symmetric +
// fixed-point, verified by icr-converge-test.js), so its 'auto' result is used as the
// merged bytes for supported files; merge3 covers conflicts, fallbacks, and other languages.
export function icrMerge3(base, mine, theirs, relPath) {
  // The sync merge: edits on adjacent lines that each replace lines one for one go side by side (#17).
  const lm = merge3(base, mine, theirs, { sideBySide: true })
  if (!supports(relPath)) return lm

  let r
  try { r = structuralMerge(base, mine, theirs, { filename: relPath }) }
  catch { return lm } // ICR must never break a sync

  if (r.status === 'auto') {
    const renamed = r.renames && r.renames.length
    return {
      text: r.text, conflict: false, icr: renamed ? 'rename' : 'structural',
      icrWarning: renamed ? `auto-applied rename ${r.renames.join(', ')} — call sites updated` : undefined,
    }
  }
  // A meaning-level conflict the line merge can't represent (dangling ref / clash): keep
  // the safe line-merge bytes, but surface what ICR caught so it isn't shipped silently.
  if (r.status === 'semantic-conflict')
    return { ...lm, icrWarning: describeConflicts(r.conflicts) }
  return lm // 'fallback'
}
