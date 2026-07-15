// JSON language provider for ICR — the one provider where the guarantee is PERFECT,
// because JSON.parse IS the real parser (no heuristics anywhere).
//
// JSON is the most-merged file type in a repository (package.json, tsconfig, lockfile
// fragments, CI configs), and the classic line-merge failure is two sides editing
// nearby keys — git conflicts or, worse, fuses into invalid JSON. ICR merges JSON as
// DATA: value-wise 3-way merge, keyed by object path, so:
//   • different keys edited on each side        -> clean merge, both kept
//   • the SAME path changed differently         -> semantic conflict naming the path
//     (surfaced as a machine-resolvable unit, so an agent judge can reconcile it)
//   • one side deletes a key the other changed  -> conflict (delete vs change)
//   • arrays: one-sided changes merge; both-sided changes merge when the edited
//     regions are DISJOINT (prefix/suffix diff — appends, prepends, middle inserts);
//     overlapping array edits are an honest conflict
// Output is serialized with the file's own indentation style (detected from the base)
// and preserves the trailing-newline convention, so diffs stay minimal.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y)

// Detect the base file's indent unit ('  ', '    ', '\t', …). Defaults to two spaces.
function detectIndent(src) {
  const m = /\n([ \t]+)\S/.exec(src)
  return m ? m[1] : '  '
}

// 3-way merge of two ARRAYS against base, by disjoint-region splice (the same
// prefix/suffix discipline the engine's token merge uses, on JSON-equal elements).
// Returns the merged array, or null for an overlapping (real) conflict.
function mergeArray(base, a, b) {
  const K = (arr) => arr.map((x) => JSON.stringify(x))
  const diffRange = (B, O) => {
    if (B.length === O.length && B.every((x, i) => x === O[i])) return null
    let p = 0
    const maxp = Math.min(B.length, O.length)
    while (p < maxp && B[p] === O[p]) p++
    let s = 0
    while (s < B.length - p && s < O.length - p && B[B.length - 1 - s] === O[O.length - 1 - s]) s++
    return { bStart: p, bEnd: B.length - s, oStart: p, oEnd: O.length - s }
  }
  const KB = K(base), ra = diffRange(KB, K(a)), rb = diffRange(KB, K(b))
  if (!ra) return b
  if (!rb) return a
  if (ra.bStart < rb.bEnd && rb.bStart < ra.bEnd) return null // overlapping regions
  if (ra.bStart === rb.bStart) return null                    // ambiguous same-point edits
  const edits = [
    { s: ra.bStart, e: ra.bEnd, ins: a.slice(ra.oStart, ra.oEnd) },
    { s: rb.bStart, e: rb.bEnd, ins: b.slice(rb.oStart, rb.oEnd) },
  ].sort((x, y) => y.s - x.s)
  let out = base.slice()
  for (const ed of edits) out.splice(ed.s, ed.e - ed.s, ...ed.ins)
  return out
}

// Value-wise 3-way merge. Fills `conflicts` (path strings) and `resolvable`
// ({key, base, ours, theirs} with pretty-printed values) on same-path clashes;
// the merged value keeps BASE at conflicted paths (the engine refuses the whole
// merge when conflicts exist, so nothing partial ever ships).
function mergeVal(base, a, b, path, conflicts, resolvable) {
  if (eq(a, b)) return a
  if (eq(a, base)) return b
  if (eq(b, base)) return a
  if (isObj(base) && isObj(a) && isObj(b)) {
    const out = {}
    const keys = [...new Set([...Object.keys(base), ...Object.keys(a), ...Object.keys(b)])]
    for (const k of keys) {
      const p = path ? path + '.' + k : k
      const inB = k in base, inA = k in a, inBb = k in b
      if (inB && !inA && !inBb) continue                                     // deleted on both sides
      if (inB && !inA) {                                                     // ours deleted it
        if (eq(b[k], base[k])) continue                                      // theirs untouched -> deletion wins
        conflicts.push(p); resolvable.push(resUnit(p, base[k], undefined, b[k])); continue
      }
      if (inB && !inBb) {                                                    // theirs deleted it
        if (eq(a[k], base[k])) continue
        conflicts.push(p); resolvable.push(resUnit(p, base[k], a[k], undefined)); continue
      }
      if (!inB && inA && inBb) {                                             // both added
        if (eq(a[k], b[k])) { out[k] = a[k]; continue }
        if (isObj(a[k]) && isObj(b[k])) { out[k] = mergeVal({}, a[k], b[k], p, conflicts, resolvable); continue }
        conflicts.push(p); resolvable.push(resUnit(p, undefined, a[k], b[k])); continue
      }
      if (!inB) { out[k] = inA ? a[k] : b[k]; continue }                     // one side added
      out[k] = mergeVal(base[k], a[k], b[k], p, conflicts, resolvable)       // present everywhere
    }
    return out
  }
  if (Array.isArray(base) && Array.isArray(a) && Array.isArray(b)) {
    const m = mergeArray(base, a, b)
    if (m) return m
    conflicts.push(path || '(root)'); resolvable.push(resUnit(path || '(root)', base, a, b))
    return base
  }
  conflicts.push(path || '(root)')                                            // scalar/shape clash
  resolvable.push(resUnit(path || '(root)', base, a, b))
  return base
}

const show = (v) => (v === undefined ? '(deleted)' : JSON.stringify(v, null, 2))
const resUnit = (p, base, ours, theirs) => ({ key: 'json:' + p, base: show(base), ours: show(ours), theirs: show(theirs) })

export const json = {
  id: 'json',
  exts: ['.json'],
  parses: (src) => { try { JSON.parse(String(src == null ? '' : src)); return true } catch { return false } },
  // The engine's whole-document tier: merge the file as parsed data.
  mergeWhole: (base, a, b) => {
    let B, A, Bb
    try { B = JSON.parse(base); A = JSON.parse(a); Bb = JSON.parse(b) } catch { return null }
    const conflicts = [], resolvable = []
    const merged = mergeVal(B, A, Bb, '', conflicts, resolvable)
    if (conflicts.length) return { conflicts, resolvable }
    const nl = /\n$/.test(base) || /\n$/.test(a) ? '\n' : ''
    return { text: JSON.stringify(merged, null, detectIndent(base)) + nl }
  },
  // Minimal unit view (whole document) so generic engine paths stay well-defined;
  // real merging happens in mergeWhole above.
  units: (src) => [{ key: 'doc', text: String(src), start: 0, end: String(src).length }],
  declaredNames: () => new Set(),
}
