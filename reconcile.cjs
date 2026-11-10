// reconcile.cjs — Single source of truth for the 3-way reconcile & merge engine.
//
// CommonJS on purpose: sync.js is ESM and the VS Code extension is CJS.
// A .cjs file is the one shape both can load synchronously without duplication.
//
// Acceptance criteria (HIV-8), re-checked 21 Sep 2026 -- FOUR OF FIVE MET:
//   1. MET      one module exports reconcile() and its dependencies (11 exports).
//   2. MET      core.js re-exports from here and sync.js imports core.js. One copy.
//   3. NOT MET  extension/extension.js does NOT require this file. It requires
//               ./icr.cjs (the ICR bundle) and keeps its OWN reconcile() at
//               extension/extension.js:1166. The second copy is still there.
//   4. MET      node tests/test.js -- 95 passed, 0 failed.
//   5. MET      node tests/conflict-test.mjs -- ALL 4 PASS.
//
// Criterion 3 read "No second copy anywhere" while a second copy existed, in a file
// that ships in package.json files[]. A comment asserting an invariant it does not
// hold is worse than no comment: the next reader trusts it and stops looking. Corrected
// to what is true rather than deleted, because the gap is the useful part.
//
// WHAT ACTUALLY GUARDS THE DRIFT, since it is not this file:
//   tests/extension-parity-test.mjs                  the ICR bundle vs the engine, 24/24
//   tests/extension-reconcile-characterisation-test.mjs   pins the extension's own copy
// Those two measure that the copies AGREE. They do not make it one copy, and closing
// criterion 3 for real means the extension loading this module.

const fs = require('fs')
const path = require('path')

// Minimal text diff: replace only the changed middle, preserving the common
// prefix/suffix. Applied to a Y.Text so edits stay small (good for CRDT churn).
function applyDiff(ytext, next) {
  const cur = ytext.toString()
  if (cur === next) return false
  let p = 0
  while (p < cur.length && p < next.length && cur[p] === next[p]) p++
  let s = 0
  while (s < cur.length - p && s < next.length - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++
  if (cur.length - p - s > 0) ytext.delete(p, cur.length - p - s)
  const ins = next.slice(p, next.length - s)
  if (ins) ytext.insert(p, ins)
  return true
}

// Detect REAL git-style conflict markers in a file. Line-anchored on purpose.
function hasConflictMarkers(text) {
  return /^<<<<<<< /m.test(text || '') && /^>>>>>>> /m.test(text || '')
}

// Strip and de-nest conflict markers to prevent exponential 2^N code ballooning
// Strip conflict markers, keeping the 'local' side (before the first =======), the 'theirs' side (after
// it), or 'all': every version in the block, in order, each distinct one once. A separator may carry a
// label ("======= Bob"): the 3-version blocks of a same-line race do.
function stripConflictMarkers(text, prefer = 'local') {
  if (!text || !hasConflictMarkers(text)) return text || ''
  const lines = text.split('\n')
  const out = []
  let inConflict = false
  let sections = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^<<<<<<< /.test(line)) {
      inConflict = true
      sections = [[]]
      continue
    }
    if (/^=======( |$)/.test(line) && inConflict) {
      sections.push([])
      continue
    }
    if (/^>>>>>>> /.test(line) && inConflict) {
      inConflict = false
      if (prefer === 'all') {
        const seen = new Set()
        for (const sec of sections) { const k = sec.join('\n'); if (seen.has(k)) continue; seen.add(k); out.push(...sec) }
      } else if (prefer === 'theirs') out.push(...sections.slice(1).flat())
      else out.push(...sections[0])
      continue
    }
    if (inConflict) sections[sections.length - 1].push(line)
    else out.push(line)
  }
  return out.join('\n')
}

// Which base line-range an edit replaced, and the replacement lines.
function changedRange(base, other) {
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

// Best-effort "what was defined here" across common languages — for the board.
function symbolsIn(text) {
  const names = new Set()
  const add = (re) => { let m; while ((m = re.exec(text)) && names.size < 8) names.add(m[1]) }
  add(/\bfunction\s+(\w+)/g)
  add(/\bclass\s+(\w+)/g)
  add(/\bdef\s+(\w+)/g)
  add(/\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g)
  return [...names].slice(0, 8)
}

// Classify a change as a small PATCH vs wholesale REWRITE.
function summarizeChange(base, next) {
  const b = (base || '').split('\n')
  const n = (next || '').split('\n')
  if (!base) return { isRewrite: false, changedLines: n.length, totalLines: n.length, symbols: symbolsIn(next || '') }
  const r = changedRange(b, n)
  const churn = Math.max(r.endBase - r.startBase, r.newLines.length)
  const total = Math.max(b.length, n.length)
  const isRewrite = total > 0 && churn >= 4 && churn / total >= 0.5
  return { isRewrite, changedLines: churn, totalLines: total, symbols: symbolsIn(r.newLines.join('\n')) }
}

// A LATE SAVE AGAINST A CONFLICT BLOCK (P0-F-9, 10 Nov 2026). The author edited a clean copy; the
// room's copy now holds one or more blocks. Every version the room holds is a whole file: block j
// read as section j (a block with fewer sections repeats its last). The late save is merged into
// EACH of them, a merge that conflicts giving both its sides, and the distinct results are written
// as ONE block per region where they differ. A block is never flattened into its sections side by
// side: that came out clean with lines no author wrote (`a = 1 / b = 1 / a = 2 / b = 2`, P0-F p0f),
// and 0.14.4's one-side strip silently dropped every other version. Null: the caller's old path
// (a section holding markers of its own, or a diff past its work bound).
function blockVersions(text) {
  const lines = text.split('\n'), segs = [] // a segment: a plain line (string) or a block {head, foot, secs}
  let blk = null
  for (const line of lines) {
    if (/^<<<<<<< /.test(line)) { if (blk) return null; blk = { head: line, secs: [[]] }; continue }
    if (blk && /^=======( |$)/.test(line)) { blk.secs.push([]); continue }
    if (blk && /^>>>>>>> /.test(line)) { blk.foot = line; segs.push(blk); blk = null; continue }
    if (blk) blk.secs[blk.secs.length - 1].push(line)
    else segs.push(line)
  }
  if (blk) return null // an unclosed block: not ours to read
  const blocks = segs.filter((s) => typeof s !== 'string')
  const k = Math.max(...blocks.map((b) => b.secs.length))
  const versions = []
  for (let j = 0; j < k; j++) versions.push(segs.flatMap((s) => (typeof s === 'string' ? [s] : s.secs[Math.min(j, s.secs.length - 1)])).join('\n'))
  return { versions, blocks }
}
function mergeLateSave(base, mine, theirs, opts) {
  const bv = blockVersions(theirs)
  if (!bv) return null
  const variants = [], lates = []
  const add = (t, to = variants) => { if (!variants.some((v) => v.text === t.text) && !lates.some((v) => v.text === t.text)) to.push(t) }
  for (const T of bv.versions) {
    if (hasConflictMarkers(T)) return null
    const r = merge3(base, mine, T, opts)
    if (!r.conflict) { add({ text: r.text, mine: false }); continue }
    // The room's versions first, in the block's order, so its header and footer still name its sections;
    // the late save's versions join after all of them.
    add({ text: stripConflictMarkers(r.text, 'theirs'), mine: false })
    add({ text: stripConflictMarkers(r.text, 'local'), mine: true }, lates)
  }
  variants.push(...lates.filter((l) => !variants.some((v) => v.text === l.text)))
  if (variants.length === 1) return { text: variants[0].text, conflict: false }
  // Regions, in the first version's lines, where any other version differs.
  const anchor = variants[0].text.split('\n')
  const hunksOf = variants.map((v, i) => (i === 0 ? [] : lineHunks(anchor, v.text.split('\n'))))
  if (hunksOf.some((h) => h === null)) return null
  const spans = hunksOf.flat().map((h) => [h[0], h[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const regions = []
  for (const [s, e] of spans) {
    const last = regions[regions.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else regions.push([s, e])
  }
  const heads = bv.blocks.map((b) => b.head), feet = bv.blocks.map((b) => b.foot.replace(/^>>>>>>> /, '').replace(/ \(\d+ versions\)$/, ''))
  const out = []
  let pos = 0
  regions.forEach(([rs, re], ri) => {
    for (let x = pos; x < rs; x++) out.push(anchor[x])
    const secs = []
    variants.forEach((v, vi) => {
      const src = v.text.split('\n')
      const sec = sideOfRegion(anchor, rs, re, hunksOf[vi].filter((h) => h[0] >= rs && h[1] <= re), src)
      if (!secs.some((x) => x.join('\n') === sec.join('\n'))) secs.push(sec)
    })
    if (secs.length === 1) out.push(...secs[0])
    else {
      const who = feet[Math.min(ri, feet.length - 1)]
      const lateName = String(opts.lateName || 'local (yours)').replace(/[\r\n]/g, ' ')
      const late = variants.some((v) => v.mine) && !who.split(', ').includes(lateName) ? `, ${lateName}` : ''
      out.push(heads[Math.min(ri, heads.length - 1)], ...secs[0], ...secs.slice(1).flatMap((x) => ['=======', ...x]), `>>>>>>> ${who}${late} (${secs.length} versions)`)
    }
    pos = re
  })
  for (let x = pos; x < anchor.length; x++) out.push(anchor[x])
  return { text: out.join('\n'), conflict: true }
}

// 3-way merge for the sync layer (disk <-> shared doc)
function merge3(base, mine, theirs, opts = {}) {
  const norm = (s) => (s || '').replace(/\r\n/g, '\n')
  const nm0 = norm(mine), nt0 = norm(theirs), nb0 = norm(base)
  if (nm0 === nt0) return { text: nt0, conflict: false }
  if (nb0 === nt0) return { text: nm0, conflict: false }
  if (nb0 === nm0) return { text: nt0, conflict: false }

  const cleanBase = hasConflictMarkers(base) ? stripConflictMarkers(base, 'local') : (base || '')
  const cleanMine = hasConflictMarkers(mine) ? stripConflictMarkers(mine, 'local') : (mine || '')
  // A LATE SAVE: the author edited a clean copy and the room's copy now holds a conflict block. Keep
  // EVERY version in the block: keeping one side dropped the other authors' work (P0-F,
  // late-save-merge-test). Only then: when the base or the author's copy holds the block too, all three
  // are stripped alike, as before, or the extra versions read as new lines every round and pile up
  // (merge-balloon-test).
  const lateSave = !hasConflictMarkers(base) && !hasConflictMarkers(mine)
  if (lateSave && hasConflictMarkers(theirs)) {
    const r = mergeLateSave(norm(base), norm(mine), norm(theirs), opts)
    if (r) return r
  }
  const cleanTheirs = hasConflictMarkers(theirs) ? stripConflictMarkers(theirs, lateSave ? 'all' : 'theirs') : (theirs || '')

  const nm = norm(cleanMine), nt = norm(cleanTheirs), nb = norm(cleanBase)
  if (nm === nt) return { text: nt, conflict: false }
  if (nb === nt) return { text: nm, conflict: false }
  if (nb === nm) return { text: nt, conflict: false }

  const b = nb.split('\n')
  const d3 = diff3Lines(b, nm.split('\n'), nt.split('\n'), !!opts.sideBySide)
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

function describeConflicts(cs) {
  return (cs || []).map((c) =>
    c.startsWith('ref:') ? `'${c.slice(4)}' was removed or renamed but is still used`
      : c.startsWith('fn:') ? `both sides changed function ${c.slice(3)}`
        : c.startsWith('class:') ? `both sides changed class ${c.slice(6)}`
          : `both sides changed ${c.replace(/^\w+:/, '')}`).join('; ')
}

function icrMerge3(base, mine, theirs, relPath, icrlib) {
  const lm = merge3(base, mine, theirs)
  if (!icrlib || !icrlib.supports || !icrlib.supports(relPath)) return lm
  let r
  try { r = icrlib.structuralMerge(base, mine, theirs, { filename: relPath }) } catch (e) { return lm }
  if (r.status === 'auto') {
    const renamed = r.renames && r.renames.length
    return { text: r.text, conflict: false, icr: renamed ? 'rename' : 'structural', icrWarning: renamed ? `auto-applied rename ${r.renames.join(', ')}` : undefined }
  }
  if (r.status === 'semantic-conflict') return Object.assign({}, lm, { icrWarning: describeConflicts(r.conflicts) })
  return lm
}

// createReconciler: binds to a session's maps, state, and callbacks, returning
// a reconcile(relPath, origin = 'local') function.
function createReconciler(ctx) {
  const {
    root,
    name = 'anon',
    SKIP = new Set(['HIVE_BOARD.md', 'HIVE_CHAT.md', 'HIVE_TASKS.md', 'HIVE_RULES.md', 'HIVE_MEMBERS.md', 'HIVE_FOR_AGENTS.md', '.hive.json']),
    isIgnored = () => false,
    canOpen = () => true,
    canWrite = () => true,
    readText = (full) => {
      try {
        const buf = fs.readFileSync(full)
        if (buf.length > 1_000_000 || buf.includes(0)) return null
        return buf.toString('utf8')
      } catch { return null }
    },
    writeToDisk,
    openFile,
    touchFile,
    fileDocs,
    manifest,
    bases,
    forkBases,
    known,
    mtimes,
    conflicted = new Set(),
    icrWarned = new Map(),
    snappedBase = new Set(),
    preexisting = new Set(),
    priorShadow,
    shadow,
    say = () => {},
    log = () => {},
    markEditing = () => {},
    noteCoEditing = () => {},
    noteIfRewrite = () => {},
    captureSnapshot = () => {},
    lastLocalEdit,
    // Fork-gate & provenance
    FORK_GATE = false,
    captureLocal,
    forkRecord,
    forkBlock,
    detectFork,
    renderConflict,
    adoptResolved,
    stampProvenance,
    attestHead,
    fusionReason,
    supports,
    languageFor,
    icrlib
  } = ctx

  return function reconcile(relPath, origin = 'local') {
    if (SKIP.has(relPath) || isIgnored(relPath)) return
    if (!canOpen(relPath)) return
    const full = path.join(root, relPath)
    const exists = fs.existsSync(full)
    const disk = exists ? readText(full) : null
    if (exists && disk === null) return

    if (origin === 'local' && !canWrite(relPath)) {
      const fe2 = fileDocs.get(relPath)
      if (fe2 && fe2.synced) {
        const dt = fe2.text.toString()
        if (dt && dt !== disk) writeToDisk(relPath, dt)
      }
      return
    }

    let fe = fileDocs.get(relPath)
    if (!fe) { if (disk === null) return; openFile(relPath); return }
    if (!fe.synced) return
    if (touchFile) touchFile(relPath)

    if (FORK_GATE && captureLocal) captureLocal(relPath)

    if (FORK_GATE && fe.conflict && forkRecord) {
      const rec = forkRecord(fe)
      if (rec) {
        const block = forkBlock(fe, rec)
        if (origin === 'local') {
          if (disk === block) return
          const fork0 = forkBases.get(relPath)
          const sawMarkers = fork0 === block || hasConflictMarkers(fork0 || '')
          if (sawMarkers && disk !== null && !hasConflictMarkers(disk)) {
            fe.doc.transact(() => {
              applyDiff(fe.text, disk)
              for (const v of rec.versions) fe.forkmark.set(v.hash, 1)
              for (const key of [...fe.conflict.keys()]) fe.conflict.delete(key)
            })
            if (stampProvenance) stampProvenance(relPath, block || '', disk)
            conflicted.delete(relPath)
            known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk)
            try { say(`✓ conflict in ${relPath} resolved by ${name}.`) } catch { }
            return
          }
          if (!sawMarkers && disk !== null && disk !== fork0) {
            if (detectFork) detectFork(relPath)
            return
          }
          if (renderConflict) renderConflict(relPath)
          return
        }
        if (renderConflict) renderConflict(relPath)
        return
      }
      if (disk !== null && hasConflictMarkers(disk) && !hasConflictMarkers(fe.text.toString())) {
        if (adoptResolved) { adoptResolved(relPath); return }
      }
    }

    const docText = fe.text.toString()
    const noHistory = !bases.has(relPath) && !(priorShadow && priorShadow.has(relPath))
    if (docText === '' && (!manifest.has(relPath) || (disk && noHistory))) {
      if (disk === null) return
      fe.doc.transact(() => applyDiff(fe.text, disk))
      if (stampProvenance) stampProvenance(relPath, '', disk)
      manifest.set(relPath, 1)
      known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk)
      if (shadow) shadow.set(relPath, disk)
      try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
      captureSnapshot(relPath, disk, name, { force: true, kind: 'base', label: 'created' })
      snappedBase.add(relPath)
      return
    }

    const yt = fe.text
    if (disk === null) {
      writeToDisk(relPath, docText)
      bases.set(relPath, docText); forkBases.set(relPath, docText)
      return
    }

    if (disk === docText) {
      if (origin === 'local' && !known.has(relPath) && disk) markEditing(relPath)
      known.add(relPath); bases.set(relPath, disk)
      if (shadow) shadow.set(relPath, disk)
      if (!forkBases.has(relPath) || origin === 'local') forkBases.set(relPath, disk)
      if (!snappedBase.has(relPath) && disk) {
        captureSnapshot(relPath, disk, name, { force: true, kind: 'base', label: 'baseline' })
        snappedBase.add(relPath)
      }
      return
    }

    // FIRST-CONTACT ADOPT
    if (!bases.has(relPath) && docText !== '' && disk !== docText) {
      if (!preexisting.has(relPath)) {
        const nl = (s) => (s === '' || s.endsWith('\n') ? s : s + '\n')
        const r0 = icrMerge3('', nl(disk), nl(docText), relPath, icrlib)
        if (r0.text !== docText) fe.doc.transact(() => applyDiff(yt, r0.text))
        if (r0.text !== disk) writeToDisk(relPath, r0.text)
        if (r0.conflict) conflicted.add(relPath)
        bases.set(relPath, r0.text); forkBases.set(relPath, r0.text)
        if (shadow) shadow.set(relPath, r0.text)
        if (!manifest.has(relPath)) manifest.set(relPath, 1)
        try { say(`⚠ ${relPath} was created by two participants at once — both versions were merged${r0.conflict ? ', and CONFLICT markers need resolving' : ''}.`) } catch { }
        return
      }
      const anc = priorShadow ? priorShadow.get(relPath) : undefined
      if (anc !== undefined && disk !== null) {
        if (disk === anc) {
          writeToDisk(relPath, docText)
          bases.set(relPath, docText); forkBases.set(relPath, docText)
          if (!snappedBase.has(relPath)) {
            captureSnapshot(relPath, docText, name, { force: true, kind: 'base', label: 'room copy adopted on rejoin (local was unchanged)' })
            snappedBase.add(relPath)
          }
          return
        }
        captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy before rejoin merge' })
        const rj = icrMerge3(anc, disk, docText, relPath, icrlib)
        if (rj.text !== docText) fe.doc.transact(() => applyDiff(yt, rj.text))
        if (rj.text !== disk) writeToDisk(relPath, rj.text)
        if (rj.conflict) conflicted.add(relPath)
        bases.set(relPath, rj.text); forkBases.set(relPath, rj.text)
        if (shadow) shadow.set(relPath, rj.text)
        if (!manifest.has(relPath)) manifest.set(relPath, 1)
        try { say(`⚠ ${relPath} changed locally while ${name} was disconnected — the local edit and the room copy were merged${rj.conflict ? ', and CONFLICT markers need resolving' : ''}. Pre-merge local copy is in the file's history.`) } catch { }
        return
      }
      captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy at join (room copy adopted)' })
      writeToDisk(relPath, docText)
      bases.set(relPath, docText); forkBases.set(relPath, docText)
      if (!snappedBase.has(relPath)) {
        captureSnapshot(relPath, docText, name, { force: true, kind: 'base', label: 'adopted from room at join' })
        snappedBase.add(relPath)
      }
      try { say(`↓ ${relPath} already existed in this room — ${name} adopted the room's copy. The local version before joining is saved in the file's history.`) } catch { }
      return
    }

    const base = bases.has(relPath) ? bases.get(relPath) : disk
    const fork = forkBases.has(relPath) ? forkBases.get(relPath) : base
    if (origin === 'local') { noteCoEditing(relPath); markEditing(relPath) }

    let res, reAdded = false
    if (origin === 'local' && hasConflictMarkers(docText) && !hasConflictMarkers(disk)) {
      res = { text: disk, conflict: false }
    } else if (origin === 'local') {
      noteIfRewrite(relPath, fork, disk)
      const sc = summarizeChange(fork, disk)
      const isCleanRewrite = sc.isRewrite && supports && supports(relPath) && languageFor && languageFor(relPath).parses(disk)
      const theirsNew = changedRange(fork.split('\n'), docText.split('\n')).newLines.filter((l) => l.length)
      const mineLines = new Set(disk.split('\n'))
      const integrated = theirsNew.every((l) => mineLines.has(l))
      if (integrated || (isCleanRewrite && !hasConflictMarkers(docText))) {
        res = { text: disk, conflict: false }
      } else {
        res = icrMerge3(fork, disk, docText, relPath, icrlib)
        reAdded = !res.conflict && res.text !== disk
      }
    } else {
      res = icrMerge3(base, disk, docText, relPath, icrlib)
    }

    if (res && !res.conflict && fusionReason) {
      const why = fusionReason(res.text, disk, docText, (supports && supports(relPath)) ? languageFor(relPath) : null)
      if (why) {
        conflicted.add(relPath)
        if (icrWarned.get(relPath) !== why) {
          icrWarned.set(relPath, why)
          log(`[${name}] !! REFUSED a fused merge of ${relPath}: ${why}`)
          try {
            say(`[!] @all ${relPath}: a merge was REFUSED because it fused rather than merged — ${why}. Nothing was written: the room's copy and ${name}'s local copy are both intact and unchanged. Someone must reconcile them deliberately; a plain file write will merge against the other version again, hive_edit replaces it outright.`)
          } catch { }
        }
        return
      }
    }

    if (origin === 'local' && res.text !== docText) {
      const sc = summarizeChange(docText, res.text)
      captureSnapshot(relPath, docText, name, { force: sc.isRewrite, churn: `${sc.changedLines}/${sc.totalLines} lines` })
      if (typeof lastLocalEdit === 'function') lastLocalEdit(relPath)
    }
    fe.doc.transact(() => applyDiff(yt, res.text))
    if (origin === 'local') {
      if (FORK_GATE) { if (res.text !== docText && attestHead) attestHead(relPath, res.text, docText) }
      else if (res.text !== docText && stampProvenance) stampProvenance(relPath, docText, res.text)
    }
    if (res.text !== disk) writeToDisk(relPath, res.text)
    known.add(relPath); bases.set(relPath, res.text)
    if (origin === 'local') forkBases.set(relPath, res.text)
    else if (!forkBases.get(relPath)) forkBases.set(relPath, res.text)

    const hasMarkers = res.conflict || hasConflictMarkers(res.text)
    if (hasMarkers && !conflicted.has(relPath)) {
      conflicted.add(relPath)
      log(`[${name}] ⚠ merge conflict in ${relPath} — kept BOTH versions with <<<<<<< markers`)
      try { say(`⚠ MERGE CONFLICT in ${relPath} — it has <<<<<<< markers. Whoever owns it: resolve before continuing.`) } catch { }
    } else if (!hasMarkers && conflicted.has(relPath)) {
      conflicted.delete(relPath)
      try { say(`✓ conflict in ${relPath} resolved.`) } catch { }
    } else if (reAdded) {
      log(`[${name}] protected ${relPath}: your edit was based on an older version — re-added changes that arrived since (nobody's work lost)`)
      try { say(`↺ ${relPath}: ${name}'s edit was based on an older copy — kept the changes that landed in between (nothing lost).`) } catch { }
    } else if (!hasMarkers && res.icr === 'rename') {
      log(`[${name}] ICR merged ${relPath} (detected a rename and updated the call sites)`)
    } else if (!hasMarkers && res.icr === 'structural') {
      log(`[${name}] ICR merged ${relPath} structurally (both edits kept, syntax guaranteed)`)
    } else if (!hasMarkers) {
      log(`[${name}] merged ${relPath} (both edits kept)`)
    }

    if (res.icrWarning && icrWarned.get(relPath) !== res.icrWarning) {
      icrWarned.set(relPath, res.icrWarning)
      log(`[${name}] ⚠ ICR flag in ${relPath} — ${res.icrWarning}`)
      try { say(`⚠ ICR flag in ${relPath}: ${res.icrWarning}. It merged, but review — this is a break a plain merge can't see.`) } catch { }
    } else if (!res.icrWarning && icrWarned.has(relPath)) {
      icrWarned.delete(relPath)
    }

    if (detectFork) detectFork(relPath)
  }
}

// reconcile direct call
function reconcile(ctx, relPath, origin = 'local') {
  return createReconciler(ctx)(relPath, origin)
}

module.exports = {
  reconcile,
  createReconciler,
  applyDiff,
  hasConflictMarkers,
  stripConflictMarkers,
  changedRange,
  symbolsIn,
  summarizeChange,
  merge3,
  lineHunks,
  diff3Lines,
  blockVersions,
  describeConflicts,
  icrMerge3
}
