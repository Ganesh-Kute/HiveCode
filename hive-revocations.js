// SIGNED REVOCATION LISTS (14 Nov 2026): a revoke the relay cannot forget.
//
// A private room (an "hs_<fp>_<rand>" id) lets in only tokens signed with the host's key, and the
// relay checks that against the room id alone, storing nothing. Taking an invite BACK was different:
// the relay wrote the revoked id to a file of its own. The hosted relay's disk is wiped on every
// deploy, so one deploy later the revoked invite worked again.
//
// A revocation list is signed with the same key as the invites, so it is self-certifying in the same
// way. The relay can trust one from anybody, which means anybody can hand it back: the host, any
// member's client that cached it, a store the relay does not trust. Nothing here reads a file or the
// network; hive-revocations-cache.js is the client's cache, and the relay keeps its own.
//
// LISTS ARE MERGED, NEVER REPLACED. Being revoked does not un-happen: inviting the person again
// mints a new id. So the state is the UNION of every valid list seen, and no old list, and no list
// from a copy of the key, can take a revocation away. A list is signed as a whole, so the union is
// kept as a set of lists: one that revokes nobody another kept list does not also revoke is dropped.
// The host always signs everyone it has revoked, so that set is normally one list; `seq` only says
// which of two caches is older.
//
// AN ENTRY LASTS AS LONG AS THE INVITE IT REVOKES. `exp` is that invite's own expiry: after it the
// relay refuses the invite for being expired, and the entry is dropped. An invite with no expiry
// (exp: null) stays revoked for good.
//
//   payload  { typ: 'hive-revocations', room, pk, seq, iat, revoked: [{ jti, exp }] }   RS256
import { sign, verify, decodeUnsafe, keyFingerprint, roomFingerprint } from './token.js'

export const REVOCATIONS_TYP = 'hive-revocations'
/** How many lists a caller should send or accept in one request. mergeLists itself never drops a
 *  list that revokes someone no other list does, whatever this says: only the key holder can make a
 *  valid list, so the count is the host's own doing, and losing a revocation is the one thing this
 *  file must not do. */
export const MAX_LISTS = 8
export const MAX_ENTRIES = 2000
const MAX_JWS = 512 * 1024 // 2,000 entries are about 100 KB; anything far past that is not a list
const MAX_JTI = 128
const nowSec = () => Math.floor(Date.now() / 1000)

const okEntry = (e) => !!e && typeof e === 'object' && typeof e.jti === 'string' && e.jti.length > 0 && e.jti.length <= MAX_JTI
  && (e.exp === null || e.exp === undefined || (typeof e.exp === 'number' && Number.isFinite(e.exp)))
const okSeq = (n) => Number.isInteger(n) && n >= 0
const live = (e, now) => e.exp === null || e.exp > now

/** Sign everyone this room's key holder has revoked. `key` is the room's key record
 *  ({ room, publicKey, privateKey }, as hive-room-key.js keeps it). Throws on input it could not
 *  verify afterwards, so a bad list is never sent. */
export function signList(key, { seq, revoked, iat = nowSec() }) {
  if (!key || !key.privateKey || !key.publicKey || keyFingerprint(key.publicKey) !== roomFingerprint(key.room)) throw new Error('signList: this key does not belong to that room')
  if (!okSeq(seq)) throw new Error('signList: seq must be a whole number, 0 or more')
  if (!Array.isArray(revoked) || revoked.length > MAX_ENTRIES || !revoked.every(okEntry)) throw new Error(`signList: revoked must be at most ${MAX_ENTRIES} entries of { jti, exp }`)
  const entries = revoked.map((e) => ({ jti: e.jti, exp: e.exp === undefined ? null : e.exp }))
  return sign({ typ: REVOCATIONS_TYP, room: key.room, pk: key.publicKey, seq, iat, revoked: entries }, { privateKey: key.privateKey })
}

/** Is this a revocation list for `room`, signed by that room's key? Never throws.
 *  -> { ok: true, list: { room, seq, iat, revoked: [{ jti, exp }] } } | { ok: false, error } */
export function verifyList(jws, room, now = nowSec()) {
  try {
    const fp = roomFingerprint(room)
    if (!fp) return { ok: false, error: 'not a private room' }
    if (typeof jws !== 'string' || !jws || jws.length > MAX_JWS) return { ok: false, error: 'not a revocation list' }
    const pre = decodeUnsafe(jws)
    if (!pre || typeof pre !== 'object' || pre.typ !== REVOCATIONS_TYP) return { ok: false, error: 'not a revocation list' }
    if (!pre.pk || keyFingerprint(pre.pk) !== fp) return { ok: false, error: 'list key does not match this room' }
    const res = verify(jws, { publicKey: pre.pk, alg: 'RS256' }, now)
    if (!res.ok) return { ok: false, error: res.error }
    const p = res.payload
    if (p.typ !== REVOCATIONS_TYP) return { ok: false, error: 'not a revocation list' }
    if (p.room !== room) return { ok: false, error: 'list is for another room' }
    if (!okSeq(p.seq)) return { ok: false, error: 'bad seq' }
    if (!Array.isArray(p.revoked) || p.revoked.length > MAX_ENTRIES || !p.revoked.every(okEntry)) return { ok: false, error: 'bad entries' }
    return { ok: true, list: { room, seq: p.seq, iat: typeof p.iat === 'number' ? p.iat : 0, revoked: p.revoked.map((e) => ({ jti: e.jti, exp: e.exp === undefined ? null : e.exp })) } }
  } catch (e) { return { ok: false, error: `unreadable list (${e.message})` } }
}

/** The union of every valid list given. Arguments after `room` are arrays of signed lists; a
 *  trailing number is the clock, for tests and for a relay that has one.
 *  -> { lists, revoked, seq }
 *     lists    the fewest of the given lists that still revoke everyone, newest first: what to
 *              store, cache and present. The same input in any order gives the same lists.
 *     revoked  Map(jti -> exp | null) of everyone revoked whose invite has not expired
 *     seq      the highest seq among the valid lists, kept or not (-1 when there were none)
 *  Anything that is not a valid list for this room is ignored. Never throws. */
export function mergeLists(room, ...rest) {
  const now = typeof rest[rest.length - 1] === 'number' ? rest.pop() : nowSec()
  const seen = new Map() // jws -> verified list
  for (const arr of rest) {
    if (!Array.isArray(arr)) continue
    for (const jws of arr) {
      if (typeof jws !== 'string' || seen.has(jws)) continue
      const v = verifyList(jws, room, now)
      if (v.ok) seen.set(jws, v.list)
    }
  }
  let seq = -1
  const cands = []
  for (const [jws, list] of seen) {
    if (list.seq > seq) seq = list.seq
    const alive = list.revoked.filter((e) => live(e, now))
    if (alive.length) cands.push({ jws, list, alive })
  }
  // Newest first, then the one that revokes more, then by the text itself: a total order, so two
  // parties holding the same lists keep the same ones.
  cands.sort((a, b) => b.list.seq - a.list.seq || b.alive.length - a.alive.length || b.list.iat - a.list.iat || (a.jws < b.jws ? -1 : a.jws > b.jws ? 1 : 0))
  const revoked = new Map()
  const lists = []
  for (const c of cands) {
    let adds = false
    for (const e of c.alive) {
      if (!revoked.has(e.jti)) { adds = true; revoked.set(e.jti, e.exp) } else {
        const had = revoked.get(e.jti) // two lists disagreeing on an expiry: the later one, so the entry is never dropped early
        if (had !== null && (e.exp === null || e.exp > had)) revoked.set(e.jti, e.exp)
      }
    }
    if (adds) lists.push(c.jws)
  }
  return { lists, revoked, seq }
}

/** Is this invite id revoked, by a result of mergeLists? */
export function isRevoked(merged, jti) {
  return !!(merged && merged.revoked && typeof jti === 'string' && jti && merged.revoked.has(jti))
}
