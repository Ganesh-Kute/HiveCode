// Shared pure logic, used by the sync clients and the agents — and unit-tested
// in test.js. Keeping these here (instead of copy-pasted) means a fix in one
// place fixes everywhere, and the tests exercise the REAL code.

// Minimal text diff: replace only the changed middle, preserving the common
// prefix/suffix. Applied to a Y.Text so edits stay small (good for CRDT churn).
export function applyDiff(ytext, next) {
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

// Optimistic concurrency: is a write based on `expected` still safe to apply?
// Returns the new version on success, or { stale, current } if the region moved.
export function safeBump(versions, region, expected) {
  const current = versions.get(region)
  if (current !== expected) return { stale: true, current }
  versions.set(region, (current ?? 0) + 1)
  return { ok: true, version: (current ?? 0) + 1 }
}

// Lock helpers (pessimistic concurrency). A lock is "alive" only if unexpired.
export function lockHeldByOther(locks, file, me, now) {
  const l = locks.get(file)
  return l && l.owner !== me && l.exp > now ? l : null
}

// Deadlock-safe multi-file ordering: always acquire in a stable sorted order so
// two agents can never form a circular wait (A holds 1 wants 2, B holds 2 wants 1).
export function lockOrder(files) {
  return [...files].sort()
}

// Richer negotiation: when a lock holder gets a request, decide how to respond.
// Returns one of:
//   grant   — no conflict, hand over (after finishing)
//   counter — we both touch the same thing; propose taking turns
//   deny    — the request is destructive while I'm still mid-edit; refuse for now
// `holder` = { intent, done }, `request` = { from, summary }.
export function negotiate(holder, request) {
  const h = (holder.intent || '').toLowerCase()
  const r = (request.summary || '').toLowerCase()
  if (/\b(delete|drop|remove|rewrite|overwrite)\b/.test(r) && !holder.done) {
    return { decision: 'deny', reason: 'that change is destructive and I am still mid-edit' }
  }
  const overlap = sharedWord(h, r)
  if (overlap && !holder.done) {
    return { decision: 'counter', reason: `we both touch "${overlap}"`, counter: 'let me finish, then it is yours' }
  }
  return { decision: 'grant', reason: 'no conflict' }
}

// Smallest shared "significant" word (len > 3) between two intent strings.
function sharedWord(a, b) {
  const words = (s) => new Set(s.split(/[^a-z0-9]+/i).filter((w) => w.length > 3))
  const wb = words(b)
  for (const w of words(a)) if (wb.has(w)) return w
  return null
}

// --- Patch-apply-or-rework (for two writers in the SAME file) ---
// 3-way line merge: given the `base` an agent read, the `mine` it produced, and
// the `current` on the board now, decide what to write.
//   - current unchanged  -> take mine
//   - I changed nothing  -> take current
//   - changes on disjoint lines -> merge both (no rework)
//   - changes overlap the same lines -> { conflict } -> agent must re-do on current
export function mergeEdit(base, mine, current) {
  if (current === base) return { ok: true, text: mine }
  if (mine === base) return { ok: true, text: current }
  if (mine === current) return { ok: true, text: mine }
  const b = base.split('\n')
  const mr = changedRange(b, mine.split('\n'))
  const tr = changedRange(b, current.split('\n'))
  if (mr.endBase <= tr.startBase || tr.endBase <= mr.startBase) {
    const out = b.slice()
    for (const e of [mr, tr].sort((x, y) => y.startBase - x.startBase)) {
      out.splice(e.startBase, e.endBase - e.startBase, ...e.newLines)
    }
    return { ok: true, text: out.join('\n') }
  }
  return { conflict: true } // same lines changed two ways -> re-reason on `current`
}

// Which base line-range an edit replaced, and the replacement lines.
function changedRange(base, other) {
  let p = 0
  while (p < base.length && p < other.length && base[p] === other[p]) p++
  let s = 0
  while (s < base.length - p && s < other.length - p && base[base.length - 1 - s] === other[other.length - 1 - s]) s++
  return { startBase: p, endBase: base.length - s, newLines: other.slice(p, other.length - s) }
}
