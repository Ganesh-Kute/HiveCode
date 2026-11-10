// hive-seen.js -- which chat messages has this reader seen? Answered by IDENTITY, never by position.
//
// THE DEFECT THIS EXISTS FOR (9 Nov 2026, found live in room-6UlP…; reproduced by Opus-Cloud and
// Claude-cloud on real Yjs at d5b6f56, urgent mail missed in 15 of 40 trials). Every "how far have I
// read" marker in Hivecode was a COUNT or an ARRAY POSITION: the mailbox behind hive_wait/hive_check
// and the [!] gate, the room read cursors behind hive_delivered, hive-await's cursor file, the stop
// hook's watermark, hive-notify, the room watcher, the Slack bridge. But a Y.Array is not append-only.
// A peer that pushed while its update was still in flight (offline, a stuck long-poll outbox, a crash
// and rejoin) carries its own clock, and Yjs orders concurrent inserts by (clientID, clock), not by
// arrival -- so the late message integrates BEHIND messages everyone already read. A position reader
// never looks there again: it re-delivers a shifted old message and silently drops the new one.
// antigravity-VM's "@Opus-Cloud … env variables" was stamped 10:22, reached the relay at 11:05 and
// landed at #818, behind 13 messages the whole room had read. Nobody's reader delivered it.
//
// THE IDENTITY. Every element of a Y.Array has a global id {client, clock}: the client that inserted
// it and that client's clock at the insert. It never changes, wherever the element ends up.
//
// "SEEN" IS A FRONTIER: per client, the HIGHEST clock this reader has seen. An id is seen iff
// frontier[client] >= clock. A late element from a client carries a clock above that client's
// frontier, so it is unseen wherever Yjs places it. A frontier is exact because one client's inserts
// into one array integrate in clock order: Yjs never surfaces clock k+1 of a client before clock k.
//
// NOT A STATE VECTOR. Yjs's own state vector (Y.encodeStateVector) stores the NEXT clock it expects,
// highest + 1. This stores the highest SEEN. Building one from the other is off by one and drops
// exactly one message per client, silently -- so nothing here reads or writes a Yjs state vector, and
// tests/mail-identity-test.mjs pins the difference. (Claude-cloud's review, attack 2.)
//
// PRUNED. Every MCP restart is a new Y.Doc clientID, so a long-lived room accumulates writers. A
// frontier is pruned to clients that still have an undeleted element in the array. That only ever
// costs a re-read, never a skip: a later element from a pruned client is unseen and is delivered.
//
// THE ONE INTERNAL. `itemsOf` walks the array's item list (`yarr._start`, `item.right`) because Yjs
// has no public API that pairs a value with its id. yjs is pinned in package.json, and the test
// asserts `itemsOf(a)` yields exactly `a.toArray()` in order, so a yjs change that breaks the walk
// fails CI instead of silently mis-reading mail.

/** Is this a Y.Array (or anything with Yjs item structure), as opposed to a plain JS array? */
export function isYArray(x) {
  return !!x && !Array.isArray(x) && typeof x.toArray === 'function' && '_start' in x
}

/**
 * The array's elements in order, each with its Yjs id: [{ id: { client, clock }, value }].
 * Deleted elements are skipped, as toArray() skips them. Element k of an item carries clock + k.
 */
export function itemsOf(yarr) {
  const out = []
  if (!isYArray(yarr)) return out
  for (let it = yarr._start; it; it = it.right) {
    if (it.deleted || !it.countable) continue
    const vals = it.content.getContent()
    for (let k = 0; k < vals.length; k++) out.push({ id: { client: it.id.client, clock: it.id.clock + k }, value: vals[k] })
  }
  return out
}

/** The clients that still have an undeleted element in the array. */
export function liveClients(yarr) {
  const s = new Set()
  for (const { id } of itemsOf(yarr)) s.add(id.client)
  return s
}

/** id as a short string, "client:clock" -- what HIVE_CHAT.md carries for readers without Yjs. */
export const idKey = (id) => `${id.client}:${id.clock}`
export function parseIdKey(s) {
  const m = /^(\d+):(\d+)$/.exec(String(s || '').trim())
  return m ? { client: Number(m[1]), clock: Number(m[2]) } : null
}

/** Does a serialized frontier ({ "client": clock }) cover this id? Absent or malformed covers nothing. */
export function covers(json, id) {
  if (!json || typeof json !== 'object' || !id) return false
  const v = json[String(id.client)]
  return Number.isFinite(Number(v)) && Number(v) >= id.clock
}

/**
 * A mutable frontier. `version` counts real advances, so a publisher can tell "nothing new" from
 * "something new" without comparing two objects.
 */
export function makeFrontier(json = null) {
  const m = new Map()
  let version = 0
  const add = (id) => {
    if (!id || !Number.isFinite(id.clock)) return false
    const cur = m.has(id.client) ? m.get(id.client) : -1
    if (id.clock <= cur) return false
    m.set(id.client, id.clock); version++
    return true
  }
  const merge = (other) => {
    if (!other || typeof other !== 'object') return false
    let changed = false
    for (const [c, v] of Object.entries(other)) {
      const client = Number(c), clock = Number(v)
      if (Number.isFinite(client) && Number.isFinite(clock) && add({ client, clock })) changed = true
    }
    return changed
  }
  if (json) merge(json)
  return {
    has: (id) => !!id && m.has(id.client) && m.get(id.client) >= id.clock,
    add,
    merge,
    get version() { return version },
    get size() { return m.size },
    /** Serialize. With `prune` (a Y.Array), keep only clients that still have an element in it. */
    toJSON({ prune = null } = {}) {
      const keep = prune ? liveClients(prune) : null
      const o = {}
      for (const [c, v] of m) if (!keep || keep.has(c)) o[String(c)] = v
      return o
    },
  }
}

/** The frontier that covers the array's first n elements -- the one-time migration from a count. */
export function frontierOfPrefix(yarr, n) {
  const f = makeFrontier()
  const items = itemsOf(yarr)
  for (let i = 0; i < Math.min(Math.max(0, Number(n) || 0), items.length); i++) f.add(items[i].id)
  return f
}

/**
 * How many leading elements a frontier covers without a gap. Published beside the frontier as `at`,
 * so a peer on an older build -- which only knows counts -- is never told more than was really read.
 * It can go DOWN when a late element integrates inside the prefix, and that is the honest answer.
 */
export function coveredPrefix(yarr, json) {
  let n = 0
  for (const { id } of itemsOf(yarr)) { if (!covers(json, id)) break; n++ }
  return n
}
