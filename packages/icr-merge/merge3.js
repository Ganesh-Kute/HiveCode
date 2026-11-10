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

// ── A REAL DIFF3 (27 Sep 2026) ─────────────────────────────────────────────────────────────────
// changedRange() is the span from a side's FIRST changed line to its LAST. That is the right
// answer to "how much changed" (summarizeChange) and the wrong one for a merge: two one-line edits
// 500 lines apart are one 500-line change to it, so the other side touching anything in between
// turned the whole span into a single conflict. Measured on a real cherry-pick of sync.js (a
// 5-line conflict to git's diff3): one conflict block of 2,140 lines. The same copy is merge3.js's
// "git-style" floor in icr-merge and extension.js's, and tests/diff3-test.mjs pins all three.
//
// lineHunks: Myers' O(ND) diff on what lies between the common prefix and suffix, each separate
// edit as its own hunk [baseStart, baseEnd, sideStart, sideEnd). Past `maxD` edits it returns null
// and merge3 keeps the one-range merge, which is coarse but never loses a line.
function lineHunks(a, b, maxD = 1000) {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const n = a.length - p - s, m = b.length - p - s
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0) return [[p, p + n, p, p + m]]
  const max = Math.min(n + m, maxD)
  const off = max + 1
  const v = new Int32Array(2 * max + 3) // v[k + off]: furthest x reached on diagonal k
  const trace = []                       // v's window [-d, d] as it stood before step d
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[p + x] === b[p + y]) { x++; y++ }
      v[off + k] = x
      if (x >= n && y >= m) { found = d; break }
    }
  }
  if (found < 0) return null
  // Walk back from (n, m): each step d undoes one insertion or deletion, then its snake.
  const steps = [] // [x0, y0, x1, y1], one edit each, collected last-first
  let x = n, y = m
  for (let d = found; d > 0; d--) {
    const w = trace[d], at = (k) => w[k + d]
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1)) // true: came by an insertion from b
    const pk = down ? k + 1 : k - 1
    const px = at(pk), py = px - pk
    steps.push(down ? [px, py, px, py + 1] : [px, py, px + 1, py])
    x = px; y = py
  }
  steps.reverse()
  const hunks = []
  for (const [x0, y0, x1, y1] of steps) {
    const last = hunks[hunks.length - 1]
    if (last && last[1] === p + x0 && last[3] === p + y0) { last[1] = p + x1; last[3] = p + y1 }
    else hunks.push([p + x0, p + x1, p + y0, p + y1])
  }
  return hunks
}

// One side's version of base lines [rs, re) with its hunks inside that range applied.
function sideOfRegion(b, rs, re, hunks, src) {
  const out = []
  let cur = rs
  for (const [bs, be, os, oe] of hunks) {
    for (let i = cur; i < bs; i++) out.push(b[i])
    for (let i = os; i < oe; i++) out.push(src[i])
    cur = be
  }
  for (let i = cur; i < re; i++) out.push(b[i])
  return out
}

// Where else a hunk could sit and mean the same edit: a pure insertion or deletion inside a run of
// identical lines ("}" "}" "}") can slide along it, and which position the diff chose is an
// accident of the algorithm. Two sides' edits count as touching if they COULD touch, so a merge
// that hinges on that accident conflicts instead of guessing (git reaches the same answer by
// sliding every hunk to one canonical end first). Returns [lo, hi] in base lines.
function slideSpan(b, [bs, be, os, oe], src) {
  let lo = bs, hi = be
  if (os === oe && be > bs) {                 // pure deletion of b[bs, be)
    let s = bs, e = be
    while (s > 0 && b[s - 1] === b[e - 1]) { s--; e-- }
    lo = s
    s = bs; e = be
    while (e < b.length && b[s] === b[e]) { s++; e++ }
    hi = e
  } else if (bs === be && oe > os) {          // pure insertion at bs of src[os, oe)
    const n = oe - os
    let k = bs, r = 0 // r: how far the inserted block has rotated
    while (k > 0 && b[k - 1] === src[os + ((n - 1 - r) % n + n) % n]) { k--; r++ }
    lo = k
    k = bs; r = 0
    while (k < b.length && b[k] === src[os + (r % n)]) { k++; r++ }
    hi = k
  }
  return [lo, hi]
}

// diff3 over line arrays: hunks from the two sides that overlap OR TOUCH form one region (touching
// changes conflict, as in git: two edits with no unchanged line between them are one decision). A
// region only one side changed takes that side; both sides making the same change takes it once;
// anything else is a conflict of THAT region only. Null when either diff is past the work bound.
//
// SIDE BY SIDE (sideBySide, the sync merge only; #17, 10 Nov 2026). Two edits that only TOUCH
// are applied side by side when both replace lines one for one (the same number of lines out as
// in). It is P0-F's footprint rule, and what the character CRDT does with the same two edits made at
// the same moment, so a save that lands a moment late no longer gets markers the on-time one did not
// (bigproject W1: README.md, five agents on adjacent lines). Overlap, an insertion or deletion at the
// edge, and a change of line count still conflict. git-clash and plain merge3 keep git's rule.
function diff3Lines(b, mine, theirs, sideBySide = false) {
  const hm = lineHunks(b, mine), ht = lineHunks(b, theirs)
  if (!hm || !ht) return null
  const sm = hm.map((h) => slideSpan(b, h, mine)), st = ht.map((h) => slideSpan(b, h, theirs))
  const oneForOne = (h) => h[1] - h[0] === h[3] - h[2] // lineHunks has no empty hunk, so this is a real replacement
  // Does a hunk starting at `s` join a region reaching `reach`? Overlap always; touching, unless both
  // the hunk and every hunk ending at `reach` are one-for-one replacements (side by side).
  const joins = (s, h, reach, edgeRep) => s < reach || (s === reach && !(sideBySide && edgeRep && oneForOne(h)))
  const out = []
  let conflict = false, pos = 0, i = 0, j = 0
  while (i < hm.length || j < ht.length) {
    const fromMine = j >= ht.length || (i < hm.length && hm[i][0] <= ht[j][0])
    const first = fromMine ? hm[i] : ht[j]
    let reach = fromMine ? sm[i++][1] : st[j++][1] // how far this region's edits could extend
    let edgeRep = oneForOne(first)                  // every hunk ending at `reach` is one-for-one
    const rm = fromMine ? [first] : [], rt = fromMine ? [] : [first]
    const rs = first[0]
    let re = first[1]
    const take = (h, span) => {
      re = Math.max(re, h[1])
      if (span[1] > reach) { reach = span[1]; edgeRep = oneForOne(h) } else if (span[1] === reach) edgeRep = edgeRep && oneForOne(h)
    }
    for (;;) {
      if (i < hm.length && joins(sm[i][0], hm[i], reach, edgeRep)) { take(hm[i], sm[i]); rm.push(hm[i++]); continue }
      if (j < ht.length && joins(st[j][0], ht[j], reach, edgeRep)) { take(ht[j], st[j]); rt.push(ht[j++]); continue }
      break
    }
    for (let x = pos; x < rs; x++) out.push(b[x])
    if (!rt.length) out.push(...sideOfRegion(b, rs, re, rm, mine))
    else if (!rm.length) out.push(...sideOfRegion(b, rs, re, rt, theirs))
    else {
      const vm = sideOfRegion(b, rs, re, rm, mine), vt = sideOfRegion(b, rs, re, rt, theirs)
      if (vm.length === vt.length && vm.every((l, k) => l === vt[k])) out.push(...vm)
      else { conflict = true; out.push('<<<<<<< local (yours)', ...vm, '=======', ...vt, '>>>>>>> incoming (theirs)') }
    }
    pos = re
  }
  for (let x = pos; x < b.length; x++) out.push(b[x])
  return { lines: out, conflict }
}

//   merge3(base, mine, theirs) -> { text, conflict }
export function merge3(base, mine, theirs) {
  const norm = (s) => (s || '').replace(/\r\n/g, '\n')
  const nm = norm(mine), nt = norm(theirs), nb = norm(base)
  if (nm === nt) return { text: nt, conflict: false }
  if (nb === nt) return { text: nm, conflict: false }  // only I changed
  if (nb === nm) return { text: nt, conflict: false }  // only they changed
  const b = nb.split('\n')
  const d3 = diff3Lines(b, nm.split('\n'), nt.split('\n'))
  if (d3) return { text: d3.lines.join('\n'), conflict: d3.conflict }
  // Past diff3's work bound (two sides that share almost nothing): one range per side.
  const mr = changedRange(b, nm.split('\n'))
  const tr = changedRange(b, nt.split('\n'))
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
  if (mineBlock.length === theirsBlock.length && mineBlock.every((l, k) => l === theirsBlock[k])) {
    const out = [...b.slice(0, start), ...theirsBlock, ...b.slice(end)]
    return { text: out.join('\n'), conflict: false }
  }
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
