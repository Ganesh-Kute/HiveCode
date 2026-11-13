// Who is on this relay right now, for its operator (GET /presence, X-Hive-Admin only).
//
// The relay's socket count is not a head count: one client holds a socket per file, or one mux socket
// for hundreds of files, and one person may run an editor, an agent and a listener at once. What the
// relay does know per identity is `workspacePeers` in server.js: base room -> name -> {kind,
// declaredKind, open, socks}, joined on the first socket and left on the last. This module turns that, plus
// each room's presence states for the client's own description, into the answer to "how many agents
// and how many people are connected now".
//
// A ROOM ID IS ITS PASSWORD, so none is ever returned. Rooms are named by a short one-way hash the
// operator can compute for ids they already hold (presenceTag below), and by nothing else.
//
// KINDS. On an open relay `kind` is only what the client SAID ('declared'); the relay verifies a kind
// only from a signed token ('verified'). Both are reported and labelled, as census() does in the log.

import crypto from 'crypto'

export const presenceTag = (room) => 'r-' + crypto.createHash('sha256').update(String(room)).digest('hex').slice(0, 10)

const kindOf = (v) => v.declaredKind || (v.kind === 'ai' || v.kind === 'human' ? v.kind : null)

/**
 * @param {object} o
 * @param {Map<string, Map<string, {kind, declaredKind, socks}>>} o.peers   workspacePeers
 * @param {(room: string) => Iterable<object>|null} [o.statesOf]            presence states of a base room
 * @param {{connections?: number, channels?: number}} [o.stats]
 */
export function presenceReport({ peers, statesOf = () => null, stats = {}, now = Date.now() }) {
  const people = new Map()      // name -> row
  const roomList = []
  let seats = 0
  for (const [room, names] of peers) {
    if (!names || names.size === 0) continue
    const described = new Map()  // name -> [user states] from the room's presence
    let states = null
    try { states = statesOf(room) } catch { states = null }
    for (const st of states || []) {
      const u = st && st.user
      if (!u || typeof u.name !== 'string') continue
      if (!described.has(u.name)) described.set(u.name, [])
      described.get(u.name).push(u)
    }
    const r = { room: presenceTag(room), agents: 0, humans: 0, unknown: 0, sockets: 0 }
    for (const [name, v] of names) {
      seats++
      const k = kindOf(v)
      if (k === 'ai') r.agents++
      else if (k === 'human') r.humans++
      else r.unknown++
      r.sockets += v.socks || 0
      let p = people.get(name)
      if (!p) {
        p = { name, declared: k, verified: !v.open && (v.kind === 'ai' || v.kind === 'human') ? v.kind : null, rooms: 0, sockets: 0, apps: new Set(), versions: new Set(), listener: false, passive: false, silent: true }
        people.set(name, p)
      }
      if (!p.declared && k) p.declared = k
      p.rooms++
      p.sockets += v.socks || 0
      for (const u of described.get(name) || []) {
        p.silent = false
        if (u.app) p.apps.add(String(u.app).slice(0, 48))
        if (u.hv) p.versions.add(String(u.hv).slice(0, 24))
        if (u.listener) p.listener = true
        if (u.passive) p.passive = true
      }
    }
    roomList.push(r)
  }
  const rows = [...people.values()].map((p) => ({ ...p, apps: [...p.apps], versions: [...p.versions] }))
    .sort((a, b) => b.sockets - a.sockets || a.name.localeCompare(b.name))
  roomList.sort((a, b) => (b.agents + b.humans + b.unknown) - (a.agents + a.humans + a.unknown) || b.sockets - a.sockets)
  return {
    ok: true,
    at: new Date(now).toISOString(),
    note: 'live identities per room. A name is counted once however many rooms or sockets it holds; kinds are what clients declared unless "verified" is set. Rooms are hashes, never ids.',
    agents: rows.filter((p) => p.declared === 'ai').length,
    humans: rows.filter((p) => p.declared === 'human').length,
    unknown: rows.filter((p) => !p.declared).length,
    rooms: roomList.length,
    seats,
    sockets: stats.connections ?? null,
    channels: stats.channels ?? null,
    people: rows,
    roomList,
  }
}

/** Constant-time check of the X-Hive-Admin header. '' when the relay has no secret: always refused. */
export function adminOk(want, got) {
  if (!want || typeof got !== 'string' || !got) return false
  const a = crypto.createHash('sha256').update(want).digest()
  const b = crypto.createHash('sha256').update(got).digest()
  return crypto.timingSafeEqual(a, b)
}
