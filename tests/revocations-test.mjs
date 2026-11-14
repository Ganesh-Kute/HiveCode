// SIGNED REVOCATION LISTS: a revoke that needs no disk on the relay.
//
//   node tests/revocations-test.mjs
//
// Until now a revoke lived in one file on the relay (./hive-room-revoked.json). The hosted relay's
// disk is wiped on every deploy, so a revoked invite worked again after one. A list signed with the
// room's key is self-certifying exactly like an invite: the relay, and every member's client, can
// check it against the room id alone, so anyone may carry it back to a relay that has forgotten.
//
// A revocation never un-happens (inviting the person again mints a new id), so lists are MERGED,
// never replaced: no old list and no list from a copied key can take a revocation away.
//
//   V1  a list signed with the room's key verifies, and says what was signed
//   V2  a list for another room, from another key, tampered with, or HS256 is refused
//   V3  an invite is never a list, and a list is never an invite
//   V4  a malformed or oversized list is refused, never thrown on
//   M1  merging nothing gives nothing
//   M2  the host's newer list covers its older one: one list is kept
//   M3  two lists from a copied key that each revoke someone else are both kept (the union)
//   M4  an old list presented after a newer one removes nothing
//   M5  an entry is dropped once the invite it revokes has expired; a list of only such entries goes
//   M6  junk among the input is ignored; the same list twice counts once
//   M7  merging the result again changes nothing
//   M8  an invite with no expiry stays revoked for good
//   C1  the client cache keeps the lists outside every room folder, private to the user
//   C2  a missing or broken cache file reads as no lists
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { sign, scopeForRoom, verify, makeSecuredRoomId } from '../token.js'

let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-revocations-'))
const HOME = path.join(TMP, 'a', 'b') // two levels down, so a path that escapes still lands inside TMP
process.env.HIVE_KEYS_DIR = path.join(HOME, 'keys')
const R = await import('../hive-revocations.js').catch((e) => ({ missing: e.message }))
const C = await import('../hive-revocations-cache.js').catch((e) => ({ missing: e.message }))
const has = (m, ...names) => names.every((n) => typeof m[n] === 'function')
const safe = (f, dflt) => { try { return f() } catch (e) { return dflt === undefined ? { threw: e.message } : dflt } }

const keypair = () => {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKey = kp.publicKey.export({ type: 'spki', format: 'pem' })
  return { publicKey, privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), room: makeSecuredRoomId(publicKey, crypto.randomBytes(6).toString('hex')) }
}
const host = keypair(), other = keypair()
const NOW = 1_800_000_000
const LATER = NOW + 86400, PAST = NOW - 10
const e = (jti, exp = LATER) => ({ jti, exp })
const signL = (k, seq, revoked) => safe(() => R.signList(k, { seq, revoked }), '')
// What signList refuses to make: a list signed by hand, as someone without the room's key would.
const rawList = (k, room, seq, revoked) => sign({ typ: 'hive-revocations', room, pk: k.publicKey, seq, iat: NOW, revoked }, { privateKey: k.privateKey })
const merged = (...a) => safe(() => R.mergeLists(host.room, ...a, NOW), { lists: [], revoked: new Map(), seq: -1, threw: true })
const jtis = (m) => [...(m.revoked ? m.revoked.keys() : [])].sort().join(',')

console.log('# the module')
T('hive-revocations.js exports signList, verifyList, mergeLists, isRevoked', has(R, 'signList', 'verifyList', 'mergeLists', 'isRevoked'), R.missing || '')
T('hive-revocations-cache.js exports loadLists, saveLists', has(C, 'loadLists', 'saveLists'), C.missing || '')

console.log('\n# V1  a signed list verifies')
const l1 = signL(host, 1, [e('jti-a')])
{
  const v = safe(() => R.verifyList(l1, host.room, NOW), {})
  T('V1 verifies against the room id alone', v.ok === true, JSON.stringify(v).slice(0, 120))
  T('V1 says room, seq and who is revoked', !!v.list && v.list.room === host.room && v.list.seq === 1 && v.list.revoked.length === 1 && v.list.revoked[0].jti === 'jti-a' && v.list.revoked[0].exp === LATER)
  T('V1 is a three-part RS256 token carrying the room key', typeof l1 === 'string' && l1.split('.').length === 3 && verify(l1, { publicKey: host.publicKey, alg: 'RS256' }, NOW).ok === true)
}

console.log('\n# V2  what is refused')
{
  const no = (name, jws, room = host.room) => { const v = safe(() => R.verifyList(jws, room, NOW), { threw: true }); T(name, v.ok === false && !v.threw, JSON.stringify(v).slice(0, 100)) }
  const sister = makeSecuredRoomId(host.publicKey, 'ffffffffffff')
  no('V2 a list for another room of the same host', rawList(host, sister, 1, [e('jti-a')]))
  T('V2 (that list is good for its own room)', safe(() => R.verifyList(rawList(host, sister, 1, [e('jti-a')]), sister, NOW), {}).ok === true)
  no('V2 a list signed by a different key, naming this room', rawList(other, host.room, 9, [e('jti-a')]))
  T('V2 signList will not sign for a room the key does not belong to', signL({ ...other, room: host.room }, 9, [e('jti-a')]) === '')
  no('V2 a list checked against a room that is not a private room', l1, 'room-plain-123456')
  const parts = String(l1).split('.')
  const forged = safe(() => [parts[0], Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()), revoked: [] })).toString('base64url'), parts[2]].join('.'), '')
  no('V2 a list whose contents were changed after signing', forged)
  no('V2 an HS256 token shaped like a list', sign({ typ: 'hive-revocations', room: host.room, pk: host.publicKey, seq: 1, iat: NOW, revoked: [e('jti-a')] }, { secret: 'x' }))
  no('V2 nothing at all', '')
  no('V2 not a token', 'hello')
}

console.log('\n# V3  invites and lists do not stand in for each other')
{
  const invite = sign({ iss: 'hivecode', sub: 'Guest', name: 'Guest', kind: 'ai', pk: host.publicKey, scopes: [{ room: host.room, role: 'maintainer' }], iat: NOW, exp: LATER, jti: 'jti-g' }, { privateKey: host.privateKey })
  const v = safe(() => R.verifyList(invite, host.room, NOW), { threw: true })
  T('V3 an invite, even a maintainer one, is not a list', v.ok === false && !v.threw)
  const asInvite = verify(l1, { publicKey: host.publicKey, alg: 'RS256' }, NOW)
  T('V3 a list grants no room: it has no scope', asInvite.ok === true && scopeForRoom(asInvite.payload, host.room) === null)
}

console.log('\n# V4  malformed lists')
{
  const raw = (payload) => sign(payload, { privateKey: host.privateKey })
  const base = { typ: 'hive-revocations', room: host.room, pk: host.publicKey, seq: 1, iat: NOW }
  const no = (name, jws) => { const v = safe(() => R.verifyList(jws, host.room, NOW), { threw: true }); T(name, v.ok === false && !v.threw, JSON.stringify(v).slice(0, 100)) }
  no('V4 revoked is not an array', raw({ ...base, revoked: 'jti-a' }))
  no('V4 an entry without a jti', raw({ ...base, revoked: [{ exp: LATER }] }))
  no('V4 an entry whose exp is a string', raw({ ...base, revoked: [{ jti: 'jti-a', exp: 'never' }] }))
  no('V4 seq is not a whole number', raw({ ...base, seq: 1.5, revoked: [] }))
  no('V4 seq is negative', raw({ ...base, seq: -1, revoked: [] }))
  no('V4 more entries than MAX_ENTRIES', raw({ ...base, revoked: Array.from({ length: (R.MAX_ENTRIES || 2000) + 1 }, (_, i) => e('jti-' + i)) }))
  T('V4 an empty list is a valid list', safe(() => R.verifyList(signL(host, 0, []), host.room, NOW), {}).ok === true)
  T('V4 signList refuses an entry it could not verify later', R.signList && signL(host, 1, [{ jti: '' }]) === '' && signL(host, 1.5, []) === '' && signL(host, 1, 'jti-a') === '')
}

console.log('\n# M  merging')
{
  const m0 = merged([])
  T('M1 merging nothing: no lists, nobody revoked', !m0.threw && m0.lists.length === 0 && m0.revoked.size === 0)

  const older = signL(host, 1, [e('jti-a')]), newer = signL(host, 2, [e('jti-a'), e('jti-b')])
  const m2 = merged([older], [newer])
  T('M2 the newer list covers the older: one list kept', m2.lists.length === 1 && m2.lists[0] === newer, `kept ${m2.lists.length}`)
  T('M2 both people are revoked, and seq is the newest', jtis(m2) === 'jti-a,jti-b' && m2.seq === 2)

  const forkA = signL(host, 3, [e('jti-a'), e('jti-b'), e('jti-c')]), forkB = signL(host, 3, [e('jti-a'), e('jti-b'), e('jti-d')])
  const m3 = merged([forkA, forkB])
  T('M3 two lists that each revoke someone else are both kept', m3.lists.length === 2 && jtis(m3) === 'jti-a,jti-b,jti-c,jti-d', `kept ${m3.lists.length}: ${jtis(m3)}`)

  const m4 = merged([newer], [older])
  T('M4 an old list presented after a newer one removes nothing', jtis(m4) === 'jti-a,jti-b' && m4.lists.length === 1 && m4.lists[0] === newer)
  const m4b = merged(merged([forkA]).lists, [older])
  T('M4 nor does it after a round trip through a merge', jtis(m4b) === 'jti-a,jti-b,jti-c')
  T('M4 the old list alone still revokes who it names (a stale holder cannot present "nobody")', jtis(merged([older])) === 'jti-a')

  const mixed = signL(host, 4, [e('jti-gone', PAST), e('jti-live')]), allGone = signL(host, 5, [e('jti-gone', PAST)])
  const m5 = merged([mixed, allGone])
  T('M5 an entry for an invite that has expired is dropped', jtis(m5) === 'jti-live')
  T('M5 a list with only such entries is not kept, but its seq is still the newest seen', m5.lists.length === 1 && m5.lists[0] === mixed && m5.seq === 5, `kept ${m5.lists.length}, seq ${m5.seq}`)

  const m6 = merged([newer, 'junk', '', null, 42, rawList(other, host.room, 99, [e('jti-evil')]), newer])
  T('M6 junk, and a list from another key, are ignored; a duplicate counts once', !m6.threw && m6.lists.length === 1 && jtis(m6) === 'jti-a,jti-b' && m6.seq === 2, `kept ${m6.lists.length}: ${jtis(m6)} seq ${m6.seq}`)

  const again = merged(m3.lists)
  T('M7 merging the result again changes nothing', again.lists.length === m3.lists.length && again.lists.every((x, i) => x === m3.lists[i]) && jtis(again) === jtis(m3))
  T('M7 the order of the input does not change the result', merged([forkB, forkA]).lists.join('|') === m3.lists.join('|'))

  const forever = signL(host, 6, [{ jti: 'jti-noexp', exp: null }])
  const m8 = safe(() => R.mergeLists(host.room, [forever], NOW + 400 * 86400), { revoked: new Map() })
  T('M8 an invite with no expiry stays revoked', jtis(m8) === 'jti-noexp')

  T('I1 isRevoked says who is in and who is out', safe(() => R.isRevoked(m2, 'jti-a') === true && R.isRevoked(m2, 'jti-zzz') === false && R.isRevoked(m2, '') === false && R.isRevoked(null, 'jti-a') === false, false))
}

console.log('\n# C  the client cache')
{
  const file = path.join(HOME, 'revocations', `${host.room}.json`)
  const lists = [signL(host, 2, [e('jti-a'), e('jti-b')])]
  T('C2 no file yet: no lists', safe(() => C.loadLists(host.room), null) && safe(() => C.loadLists(host.room), [1]).length === 0)
  safe(() => C.saveLists(host.room, lists))
  T('C1 saved beside the keys folder, not in any room folder', fs.existsSync(file), file)
  T('C1 read back as saved', safe(() => C.loadLists(host.room), []).join('|') === lists.join('|'))
  if (process.platform !== 'win32') T('C1 readable by the user only', fs.existsSync(file) && (fs.statSync(file).mode & 0o077) === 0)
  T('C1 no temporary file is left behind', fs.existsSync(path.dirname(file)) && fs.readdirSync(path.dirname(file)).every((f) => f.endsWith('.json')))
  if (fs.existsSync(file)) fs.writeFileSync(file, '{ not json')
  T('C2 a broken file reads as no lists, without throwing', Array.isArray(safe(() => C.loadLists(host.room), null)) && safe(() => C.loadLists(host.room), [1]).length === 0)
  safe(() => C.saveLists('../../escape', lists))
  T('C1 a name that is not a private room id writes nothing', !fs.existsSync(path.join(TMP, 'a', 'escape.json')) && !fs.existsSync(path.join(HOME, 'escape.json')) && Array.isArray(safe(() => C.loadLists('../../escape'), null)))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
