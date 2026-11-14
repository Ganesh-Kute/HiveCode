// The relay's memory of signed revocation lists (POST /__hive/revocations), one set per private room.
//
// WHY. A revoke used to live in a file the relay wrote beside itself (hive-room-revoked.json). The
// hosted relay has no disk that survives a deploy, so a revoked invite worked again after the next
// one. A signed list (hive-revocations.js) is checked against the room id alone, like an invite, so
// the relay can take it from ANYONE: the host that signed it, a member's client that cached it, a
// file, a store it does not trust. This module is where the relay keeps what it was handed.
//
// THREE PLACES A LIST CAN COME BACK FROM after a restart, in the order they are tried:
//   1. files    beside the room snapshots, one per room, when the relay has a disk (HIVE_PERSIST_DIR).
//               Read once at boot.
//   2. `store`  an optional outside store, { get(room) -> [jws], put(room, [jws]) }, for a relay with no
//               disk. Read the first time a room is touched in a boot (ready()), before anyone is let in.
//               It is not trusted: every list it returns is verified like any other.
//   3. peers    every updated client presents its cached lists before it connects (sync.js).
// With neither a disk nor a store the relay says so (`durable: false`) and depends on 3 alone.
//
// LISTS MERGE, NEVER REPLACE (hive-revocations.js mergeLists): nothing presented here can take a
// revocation away, so the endpoint needs no token and no rate of trust -- only bounds on size.
//
// THE BOUNDS. Anyone can make a private room (it is a key pair), so anyone can hand this relay a
// validly signed list for a room nobody will ever use. Without a bound that is memory, and disk,
// for the asking. So:
//   maxRooms      rooms whose lists are kept. A NEW room past it is refused (`refused: 'rooms'`).
//   maxBytes      all lists together. Past it a room may still hold up to `reserveBytes` -- a few
//                 hundred revoked invites -- and anything larger is refused (`refused: 'bytes'`).
//   so the ceiling is maxBytes + maxRooms * reserveBytes, whatever is sent.
// A ROOM ALREADY HELD CAN ALWAYS ADD A REVOKE (inside its reserve): filling the relay can stop it
// taking on rooms it has never heard of, it cannot stop a host it already knows from cutting
// someone off. Nothing is ever pushed out to make room: an eviction would be a forgotten revoke.
// A room gives its place back by itself when the last invite it revoked has expired.
// What comes from the relay's own file or store was inside the bounds when it was written, and is
// taken back whole: refusing it would be forgetting a revoke.

import fs from 'fs'
import path from 'path'
import { mergeLists, MAX_LISTS } from './hive-revocations.js'
import { isSecuredRoom } from './token.js'

const FOLDER = 'revocations'
// A room id is a FILE NAME here (<persist>/revocations/<room>.json), and anyone can sign a list for an id
// of their own making: "hs_<fp>_x/../../victim" is a private room's id to isSecuredRoom, with a
// fingerprint from the signer's own key. So only plain ids are ever kept, and never turned into a path
// otherwise (14 Nov 2026: that string wrote and deleted outside this folder).
const SAFE_ROOM = /^hs_[A-Za-z0-9_-]{1,200}$/
export const isSafeRoomId = (room) => typeof room === 'string' && SAFE_ROOM.test(room) && isSecuredRoom(room)
export const MAX_ROOMS = 1000
export const MAX_BYTES = 64 * 1048576
export const RESERVE_BYTES = 16 * 1024
const nowSec = () => Math.floor(Date.now() / 1000)
const sizeOf = (lists) => lists.reduce((n, l) => n + l.length, 0)
/** When the last entry of a merge expires (Infinity when one never does). */
const lastExp = (m) => { let x = 0; for (const exp of m.revoked.values()) { if (exp === null) return Infinity; if (exp > x) x = exp } return x }

/**
 * @param {object} o
 * @param {string|null} [o.dir]    the relay's persist dir; lists go in <dir>/revocations/<room>.json. Or null
 * @param {{get: (room: string) => Promise<string[]>, put: (room: string, lists: string[]) => Promise<void>}|null} [o.store]
 * @param {() => number} [o.now]   seconds
 * @param {number} [o.maxRooms] @param {number} [o.maxBytes] @param {number} [o.reserveBytes]
 */
export function makeRelayRevocations({ dir = null, store = null, now = nowSec, log = () => { }, maxRooms = MAX_ROOMS, maxBytes = MAX_BYTES, reserveBytes = RESERVE_BYTES } = {}) {
  const rooms = new Map()            // room -> { lists, revoked: Map(jti -> exp|null), seq, bytes, until }
  const loaded = new Map()           // room -> Promise, the store read of this boot
  const folder = dir ? path.join(dir, FOLDER) : null
  const fileOf = (room) => path.join(folder, `${room}.json`)   // a private room's id is letters, digits, _ and -
  let total = 0

  const keep = (room, m) => {
    const had = rooms.get(room)
    const rec = { ...m, bytes: sizeOf(m.lists), until: lastExp(m) }
    total += rec.bytes - (had ? had.bytes : 0)
    rooms.set(room, rec)
  }
  const drop = (room) => {
    const had = rooms.get(room)
    if (!had) return
    total -= had.bytes
    rooms.delete(room)
    if (folder) { try { fs.rmSync(fileOf(room), { force: true }) } catch { } }
  }
  /** Rooms whose every revoked invite has expired hold nothing: their place is free. */
  const sweep = () => { const t = now(); for (const [room, m] of rooms) if (m.until <= t) drop(room) }

  // One small file per room, so a change to one room writes that room and nothing else.
  const saveFile = (room) => {
    if (!folder) return
    try {
      fs.mkdirSync(folder, { recursive: true })
      const tmp = fileOf(room) + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, lists: rooms.get(room).lists }), { mode: 0o600 })
      fs.renameSync(tmp, fileOf(room))
    } catch (e) { log(`[relay] could not save the revocation lists: ${e.code || e.message}`) }
  }
  if (folder) {
    let names = []
    try { names = fs.readdirSync(folder) } catch { /* none yet */ }
    for (const f of names) {
      const room = f.endsWith('.json') ? f.slice(0, -5) : ''
      if (!isSafeRoomId(room)) continue
      try {
        const j = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'))
        const m = mergeLists(room, Array.isArray(j && j.lists) ? j.lists : [], now())   // verified again: the file is not trusted either
        if (m.lists.length) keep(room, m)
      } catch { /* not ours */ }
    }
  }

  /** Merge what was handed in. -> { merged, added: [jti], changed, refused }
   *  `added` is who is revoked now and was not. `refused` is 'room' (not an id this relay keeps), or
   *  'rooms' or 'bytes' when the bounds said no: nothing was changed then, and what the room had (if anything) still stands.
   *  `own` is for what this relay kept itself (its store): no bounds. */
  function present(room, lists, { own = false } = {}) {
    if (!isSafeRoomId(room)) return { merged: { lists: [], revoked: new Map(), seq: -1 }, added: [], changed: false, refused: 'room' }   // not a name this relay keeps
    const had = rooms.get(room) || { lists: [], revoked: new Map(), seq: -1, bytes: 0 }
    const merged = mergeLists(room, had.lists, Array.isArray(lists) ? lists.slice(0, MAX_LISTS) : [], now())
    const added = [...merged.revoked.keys()].filter((jti) => !had.revoked.has(jti))
    const changed = added.length > 0 || merged.lists.length !== had.lists.length || merged.lists.some((l, i) => l !== had.lists[i])
    if (!merged.lists.length) {                      // nothing valid, or every entry has expired: nothing to keep
      drop(room)
      return { merged, added, changed, refused: null }
    }
    if (changed && !own) {
      const bytes = sizeOf(merged.lists)
      let refused = null
      if (!rooms.has(room) && rooms.size >= maxRooms) { sweep(); if (rooms.size >= maxRooms) refused = 'rooms' }
      if (!refused && bytes > Math.max(had.bytes, reserveBytes) && total - had.bytes + bytes > maxBytes) { sweep(); if (total - had.bytes + bytes > maxBytes) refused = 'bytes' }
      if (refused) return { merged: had, added: [], changed: false, refused }
    }
    if (changed || !rooms.has(room)) { keep(room, merged); saveFile(room) }
    return { merged, added, changed, refused: null }
  }

  return {
    durable: Boolean(folder || store),
    present: (room, lists) => present(room, lists),
    /** What is held now, for the operator: { rooms, bytes, maxRooms, maxBytes }. */
    size: () => ({ rooms: rooms.size, bytes: total, maxRooms, maxBytes }),
    isRevoked: (room, jti) => { const m = rooms.get(room); return !!(m && jti && m.revoked.has(jti)) },
    listsOf: (room) => { const m = rooms.get(room); return m ? m.lists : [] },
    seqOf: (room) => { const m = rooms.get(room); return m ? m.seq : -1 },
    /** Before anyone is let into a private room in this boot: read the outside store once. Rejects when
     *  the store cannot be read, and the caller must then refuse (fail closed) and let the client retry;
     *  the next call tries again. With no store it is already done. Returns who became revoked. */
    ready(room) {
      if (!store || !isSafeRoomId(room)) return Promise.resolve([])
      let p = loaded.get(room)
      if (!p) {
        p = Promise.resolve().then(() => store.get(room)).then((lists) => present(room, lists, { own: true }).added)
        loaded.set(room, p)
        p.catch(() => loaded.delete(room))
      }
      return p
    },
    /** After a change: put it where a restart cannot lose it. Rejects when the store refuses. */
    commit(room) {
      if (!store) return Promise.resolve()
      return Promise.resolve().then(() => store.put(room, (rooms.get(room) || { lists: [] }).lists))
    },
  }
}
