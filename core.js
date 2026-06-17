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
