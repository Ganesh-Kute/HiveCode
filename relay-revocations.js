// The relay's memory of signed revocation lists (POST /__hive/revocations), one set per private room.
//
// WHY. A revoke used to live in a file the relay wrote beside itself (hive-room-revoked.json). The
// hosted relay has no disk that survives a deploy, so a revoked invite worked again after the next
// one. A signed list (hive-revocations.js) is checked against the room id alone, like an invite, so
// the relay can take it from ANYONE: the host that signed it, a member's client that cached it, a
// file, a store it does not trust. This module is where the relay keeps what it was handed.
//
// THREE PLACES A LIST CAN COME BACK FROM after a restart, in the order they are tried:
//   1. `file`   beside the room snapshots, when the relay has a disk (HIVE_PERSIST_DIR). Read once at boot.
//   2. `store`  an optional outside store, { get(room) -> [jws], put(room, [jws]) }, for a relay with no
//               disk. Read the first time a room is touched in a boot (ready()), before anyone is let in.
//               It is not trusted: every list it returns is verified like any other.
//   3. peers    every updated client presents its cached lists before it connects (sync.js).
// With neither a file nor a store the relay says so (`durable: false`) and depends on 3 alone.
//
// LISTS MERGE, NEVER REPLACE (hive-revocations.js mergeLists): nothing presented here can take a
// revocation away, so the endpoint needs no token and no rate of trust -- only bounds on size.

import fs from 'fs'
import path from 'path'
import { mergeLists, MAX_LISTS } from './hive-revocations.js'
import { isSecuredRoom } from './token.js'

const FILE = 'revocations.json'
const nowSec = () => Math.floor(Date.now() / 1000)

/**
 * @param {object} o
 * @param {string|null} [o.dir]    folder for the file (the relay's persist dir), or null
 * @param {{get: (room: string) => Promise<string[]>, put: (room: string, lists: string[]) => Promise<void>}|null} [o.store]
 * @param {() => number} [o.now]   seconds
 */
export function makeRelayRevocations({ dir = null, store = null, now = nowSec, log = () => { } } = {}) {
  const rooms = new Map()            // room -> { lists, revoked: Map(jti -> exp|null), seq }
  const loaded = new Map()           // room -> Promise, the store read of this boot
  const filePath = dir ? path.join(dir, FILE) : null

  if (filePath) {
    try {
      const j = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      for (const [room, lists] of Object.entries((j && j.rooms) || {})) {
        if (!isSecuredRoom(room) || !Array.isArray(lists)) continue
        const m = mergeLists(room, lists, now())      // verified again: the file is not trusted either
        if (m.lists.length) rooms.set(room, m)
      }
    } catch { /* none yet */ }
  }
  const saveFile = () => {
    if (!filePath) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, rooms: Object.fromEntries([...rooms].map(([r, m]) => [r, m.lists])) }), { mode: 0o600 })
      fs.renameSync(tmp, filePath)
    } catch (e) { log(`[relay] could not save the revocation lists: ${e.code || e.message}`) }
  }

  /** Merge what was handed in. -> { merged, added: [jti] }, `added` being who is revoked now and was not. */
  function present(room, lists) {
    const had = rooms.get(room) || { lists: [], revoked: new Map(), seq: -1 }
    const merged = mergeLists(room, had.lists, Array.isArray(lists) ? lists.slice(0, MAX_LISTS) : [], now())
    const added = [...merged.revoked.keys()].filter((jti) => !had.revoked.has(jti))
    const changed = added.length > 0 || merged.lists.length !== had.lists.length || merged.lists.some((l, i) => l !== had.lists[i])
    if (merged.lists.length) rooms.set(room, merged)
    else rooms.delete(room)                          // every entry has expired: nothing left to keep
    if (changed) saveFile()
    return { merged, added, changed }
  }

  return {
    durable: Boolean(filePath || store),
    present,
    isRevoked: (room, jti) => { const m = rooms.get(room); return !!(m && jti && m.revoked.has(jti)) },
    listsOf: (room) => { const m = rooms.get(room); return m ? m.lists : [] },
    seqOf: (room) => { const m = rooms.get(room); return m ? m.seq : -1 },
    /** Before anyone is let into a private room in this boot: read the outside store once. Rejects when
     *  the store cannot be read, and the caller must then refuse (fail closed) and let the client retry;
     *  the next call tries again. With no store it is already done. Returns who became revoked. */
    ready(room) {
      if (!store || !isSecuredRoom(room)) return Promise.resolve([])
      let p = loaded.get(room)
      if (!p) {
        p = Promise.resolve().then(() => store.get(room)).then((lists) => present(room, lists).added)
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
