// merge3.js — the line-level 3-way fallback tier (git-style).
// Extracted from Hivecode's core.js. Zero dependencies. Where ICR's structural
// merge declines (unparseable input, unsupported language, semantic conflict),
// this is the floor: disjoint edits merge cleanly; overlapping edits are wrapped
// in conflict markers so BOTH versions survive and a human/AI resolves.

// Which base line-range an edit replaced, and the replacement lines.
export function changedRange(base, other) {
  let p = 0
  while (p < base.length && p < other.length && base[p] === other[p]) p++
  let s = 0
  while (s < base.length - p && s < other.length - p && base[base.length - 1 - s] === other[other.length - 1 - s]) s++
  return { startBase: p, endBase: base.length - s, newLines: other.slice(p, other.length - s) }
}

//   merge3(base, mine, theirs) -> { text, conflict }
export function merge3(base, mine, theirs) {
  if (mine === theirs) return { text: mine, conflict: false }
  if (base === theirs) return { text: mine, conflict: false }  // only I changed
  if (base === mine) return { text: theirs, conflict: false }  // only they changed
  const b = base.split('\n')
  const mr = changedRange(b, mine.split('\n'))
  const tr = changedRange(b, theirs.split('\n'))
  if (mr.endBase <= tr.startBase || tr.endBase <= mr.startBase) {
    const out = b.slice()
    for (const e of [mr, tr].sort((x, y) => y.startBase - x.startBase)) {
      out.splice(e.startBase, e.endBase - e.startBase, ...e.newLines)
    }
    return { text: out.join('\n'), conflict: false }
  }
  // Overlap: reconstruct each side's lines over the union region [start,end).
  const start = Math.min(mr.startBase, tr.startBase)
  const end = Math.max(mr.endBase, tr.endBase)
  const mineBlock = [...b.slice(start, mr.startBase), ...mr.newLines, ...b.slice(mr.endBase, end)]
  const theirsBlock = [...b.slice(start, tr.startBase), ...tr.newLines, ...b.slice(tr.endBase, end)]
  const out = [
    ...b.slice(0, start),
    '<<<<<<< local (yours)',
    ...mineBlock,
    '=======',
    ...theirsBlock,
    '>>>>>>> incoming (theirs)',
    ...b.slice(end),
  ]
  return { text: out.join('\n'), conflict: true }
}

// Detect REAL git-style conflict markers. Line-anchored on purpose: requires an
// opening `<<<<<<< ` AND a closing `>>>>>>> ` each at the start of a line — a
// naive includes() false-positives on files that merely MENTION the markers.
export function hasConflictMarkers(text) {
  return /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text)
}
