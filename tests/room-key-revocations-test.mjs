// THE HOST'S SIDE OF A REVOKE, AND WHERE AN INVITE IS KEPT.
//
//   node tests/room-key-revocations-test.mjs
//
// 1. `revoke <name>` used to tell the relay "forget this id", and the relay wrote it to its own
//    disk. The hosted relay loses that disk on every deploy. Now the host SIGNS the list of everyone
//    it has revoked (hive-revocations.js) and hands that to the relay, which can get it back from
//    any member after a restart. The relay here is a stand-in that records what it is sent.
// 2. An invite (the token) was written to <room folder>/.hive.json, the host's maintainer token
//    included. A room folder is very often a git repository, and nothing kept that file out of a
//    commit. Tokens now live in ~/.hivecode/tokens, and one function finds the right one.
//
//   K1  revoke sends the relay a list signed with the room's key, naming the invite and its expiry
//   K2  the next revoke signs everyone revoked so far, as one list with a higher seq
//   K3  a relay that cannot be reached: nothing is reported as revoked, the invite is still listed,
//       and the signed list is kept so the next try (and the host's next join) carries it
//   K4  a relay too old for lists is told the old way, and the host is told it will not last
//   K5  hostLists gives the host's client what to present; a machine that hosts nothing gives its cache
//   K6  lists the relay answers with (a second key holder's) are cached
//   K7  an entry is left out once the invite it revoked has expired
//   K8  nothing printed by revoke holds a token
//   T1  resolveRoomToken: explicit, then the link, then $HIVE_TOKEN, then the saved one, then an old
//       .hive.json, then the host's own
//   T2  a saved token is in ~/.hivecode/tokens, private to the user, never in the room folder
//   T3  an old .hive.json token is found, copied to the store, and removed from the file on a join
//   T4  in a private room a token made for another room is passed over
//   T5  with no name, the one token saved for the room is used
//   T6  two participants on one machine keep separate invites
//   T7  the host with no token gets one from the key; one that ran out is renewed
//   T8  a room name that is not a safe file name cannot write outside the store
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { sign, decodeUnsafe, verify } from '../token.js'

let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-roomkey-'))
const HOME = path.join(TMP, 'a', 'b')
process.env.HIVE_KEYS_DIR = path.join(HOME, 'keys')
delete process.env.HIVE_TOKEN
const K = await import('../hive-room-key.js')
const R = await import('../hive-revocations.js')
const C = await import('../hive-revocations-cache.js')
const fn = (name) => (typeof K[name] === 'function' ? K[name] : () => { throw new Error(`hive-room-key.js does not export ${name}`) })
const safe = async (f, dflt) => { try { return await f() } catch (e) { return dflt === undefined ? { threw: e.message } : dflt } }
const nowSec = () => Math.floor(Date.now() / 1000)
const keyRec = (room) => JSON.parse(fs.readFileSync(path.join(process.env.HIVE_KEYS_DIR, `${room}.json`), 'utf8'))

// ---- a stand-in relay: records every request, answers as told ---------------------------------
const seen = []
let mode = 'lists' // 'lists' = new relay | 'old', 'old404' = no /__hive/revocations | 'refuses' = says no | 'full' = knows lists, will hold no more (503 Q677) | 'down' = 500 on everything
let extraLists = []
let durable = false // what the relay says of itself: does it keep lists across a restart
const server = http.createServer((req, res) => {
  let b = ''
  req.on('data', (d) => { b += d })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(b || '{}') } catch { /* recorded as empty */ }
    seen.push({ url: req.url, body })
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (mode === 'down') return send(500, { error: 'down' })
    if (req.url === '/__hive/revocations') {
      if (mode === 'old404') return send(404, { error: 'not found' })
      // what the relay at 0.14.14 really answers to a route it does not have
      if (mode === 'old') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('hivecode relay is up. Connect a client to ws://<this-host>/<room>') }
      if (mode === 'refuses') return send(400, { ok: false, error: 'bad list' })
      if (mode === 'full') return send(503, { ok: false, error: 'Q677 the relay holds as many revocation lists as it will; this one was not taken and the invite still works here.', full: 'rooms' })
      return send(200, { ok: true, dropped: 1, durable, lists: [...(body.lists || []), ...extraLists] })
    }
    if (req.url === '/__hive/revoke') return send(200, { ok: true, dropped: 2 })
    send(404, {})
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const RELAY = `ws://127.0.0.1:${server.address().port}`

// ---- a hosted private room with three guests ---------------------------------------------------
const fresh = K.newPersonalRoom()
K.saveRoomKey(fresh, { relay: RELAY, host: 'Host' })
const ROOM = fresh.room
const inv = (name, days = 7) => K.makeInvite({ room: ROOM, relay: RELAY, name, days })
const A = inv('Alice'), B = inv('Bob'), Cc = inv('Carol')
const lastPost = (url) => [...seen].reverse().find((s) => s.url === url)

console.log('# I1  what an invite with a path limit says')
{
  const lim = K.makeInvite({ room: ROOM, relay: RELAY, name: 'Limited', paths: ['docs'] })
  T('I1 a --paths invite says what the limit does not cover', lim.ok && /still sees the name of every file/.test(lim.text) && /shared record/.test(lim.text))
  T('I1 an invite without a path limit does not say it', !/still sees the name of every file/.test(A.text))
}

console.log('\n# K1  revoke sends a signed list')
{
  seen.length = 0
  const r = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Alice' }), {})
  const post = lastPost('/__hive/revocations')
  T('K1 revoke succeeds', r.ok === true, JSON.stringify(r).slice(0, 160))
  T('K1 the relay was sent { room, lists } at /__hive/revocations', !!post && post.body.room === ROOM && Array.isArray(post.body.lists) && post.body.lists.length === 1, JSON.stringify(seen.map((s) => s.url)))
  const v = post ? R.verifyList(post.body.lists[0], ROOM) : {}
  T('K1 the list is signed with the room key', v.ok === true, JSON.stringify(v).slice(0, 100))
  const pa = decodeUnsafe(A.link.split('|')[2])
  T('K1 it names the invite and that invite\'s own expiry', !!v.list && v.list.revoked.length === 1 && v.list.revoked[0].jti === A.jti && v.list.revoked[0].exp === pa.exp)
  T('K1 no token went to the relay for it (a list needs none)', !!post && !('token' in post.body) && !seen.some((s) => s.url === '/__hive/revoke'))
  T('K1 the host is told who keeps it across a relay restart: here the members, since this relay said it does not', /does not keep it across a restart/.test(r.text || '') && /every member/.test(r.text || ''), r.text)
  T('K8 the text holds no token', !/eyJ[A-Za-z0-9_-]{10,}\./.test(r.text || ''))
  const rec = keyRec(ROOM)
  T('K1 the key file marks the invite revoked and keeps seq, entries and the list', rec.invites.find((i) => i.name === 'Alice').revokedAt > 0 && rec.seq === 1 && Array.isArray(rec.revoked) && rec.revoked.length === 1 && rec.list === (post && post.body.lists[0]))
}

console.log('\n# K2  the next revoke signs everyone so far')
{
  const r = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Bob' }), {})
  const post = lastPost('/__hive/revocations')
  const v = post ? R.verifyList(post.body.lists[post.body.lists.length - 1], ROOM) : {}
  const all = post ? R.mergeLists(ROOM, post.body.lists) : { lists: [], revoked: new Map() }
  T('K2 seq went up', r.ok === true && !!v.list && v.list.seq === 2)
  T('K2 the text still says the relay closed a connection', /closed 1 connection/.test(r.text || ''), r.text)
  T('K2 both are revoked, and it takes one list to say so', all.revoked.has(A.jti) && all.revoked.has(B.jti) && all.lists.length === 1, `lists ${all.lists.length}`)
}

console.log('\n# K3  the relay cannot be reached')
{
  mode = 'down'
  const r = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Carol' }), {})
  const rec = keyRec(ROOM)
  T('K3 not reported as revoked', r.ok === false, JSON.stringify(r).slice(0, 160))
  T('K3 the invite is still listed as live, so revoke can be run again', !rec.invites.find((i) => i.name === 'Carol').revokedAt)
  T('K3 the signed list is kept: the host\'s next join carries it', R.mergeLists(ROOM, await safe(() => fn('hostLists')(ROOM), [])).revoked.has(Cc.jti))
  mode = 'lists'
  const again = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Carol' }), {})
  T('K3 the second try goes through', again.ok === true && keyRec(ROOM).invites.find((i) => i.name === 'Carol').revokedAt > 0, JSON.stringify(again).slice(0, 160))
  T('K3 a relay that says it keeps lists is reported as such, and only then', /this relay keeps it across a restart/.test(await (async () => { durable = true; K.makeInvite({ room: ROOM, relay: RELAY, name: 'Cody', days: 7 }); const x = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Cody' }), {}); durable = false; return x.text || '' })()))
  const nobody = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Carol' }), {})
  T('K3 a third says there is nothing live to revoke', nobody.ok === false && /No live invite/.test(nobody.text || ''))
}

console.log('\n# K4  a relay too old for lists')
{
  const D = inv('Dave')
  mode = 'old'; seen.length = 0
  const r = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Dave' }), {})
  const legacy = lastPost('/__hive/revoke')
  T('K4 falls back to the old endpoint, with a host token and the id', r.ok === true && !!legacy && legacy.body.jti === D.jti && legacy.body.room === ROOM && typeof legacy.body.token === 'string', JSON.stringify(r).slice(0, 200))
  T('K4 that token is a maintainer token signed by the room key', !!legacy && verify(legacy.body.token, { publicKey: fresh.publicKey, alg: 'RS256' }).ok && decodeUnsafe(legacy.body.token).scopes[0].role === 'maintainer')
  T('K4 the host is told this relay forgets it on a restart', /forget|older|update/i.test(r.text || '') && /restart/i.test(r.text || ''), r.text)
  T('K4 the list was still signed and kept for a relay that can take it', R.mergeLists(ROOM, await safe(() => fn('hostLists')(ROOM), [])).revoked.has(D.jti))
  T('K8 the text holds no token', !/eyJ[A-Za-z0-9_-]{10,}\./.test(r.text || ''))
  const D2 = inv('Dora')
  mode = 'old404'; seen.length = 0
  const r2 = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Dora' }), {})
  T('K4 the same for an old relay that answers 404', r2.ok === true && !!lastPost('/__hive/revoke') && lastPost('/__hive/revoke').body.jti === D2.jti && /restart/i.test(r2.text || ''))
  inv('Dan')
  mode = 'refuses'; seen.length = 0
  const r3 = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Dan' }), {})
  T('K4 a relay that knows lists and says no is not asked the old way, and nothing is reported revoked', r3.ok === false && !lastPost('/__hive/revoke') && !keyRec(ROOM).invites.find((i) => i.name === 'Dan').revokedAt, JSON.stringify(r3).slice(0, 160))
  inv('Dina')
  mode = 'full'; seen.length = 0
  const r4 = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Dina' }), {})
  const lg = lastPost('/__hive/revoke')
  T('K4b a relay that is full of lists (Q677) is told the old, authenticated way: the revoke is in force now', r4.ok === true && !!lg && lg.body.room === ROOM && typeof lg.body.token === 'string' && keyRec(ROOM).invites.find((i) => i.name === 'Dina').revokedAt > 0, JSON.stringify(r4).slice(0, 200))
  T('K4b and the host is told why, and that it does not last a restart', /Q677|as many/i.test(r4.text || '') && /restart/i.test(r4.text || '') && !/older than signed/i.test(r4.text || ''), r4.text)
  T('K4b the signed list is still kept for when the relay can take it', R.mergeLists(ROOM, await safe(() => fn('hostLists')(ROOM), [])).revoked.size >= 1)
  T('K8 the text holds no token', !/eyJ[A-Za-z0-9_-]{10,}\./.test(r4.text || ''))
  mode = 'lists'
}

console.log('\n# K5 K6  what the host presents, and what is cached')
{
  const lists = await safe(() => fn('hostLists')(ROOM), [])
  const m = R.mergeLists(ROOM, lists)
  T('K5 hostLists: one list, everyone revoked so far', lists.length === 1 && [A, B, Cc].every((x) => m.revoked.has(x.jti)), `lists ${lists.length}`)
  // a second machine holding a copy of the key revoked someone this one never invited
  const forkList = R.signList({ room: ROOM, publicKey: fresh.publicKey, privateKey: fresh.privateKey }, { seq: 1, revoked: [{ jti: 'jti-from-the-other-machine', exp: nowSec() + 3600 }] })
  extraLists = [forkList]
  const E = inv('Erin')
  await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Erin' }), {})
  extraLists = []
  const cached = R.mergeLists(ROOM, C.loadLists(ROOM))
  T('K6 the relay\'s answer is cached: the other machine\'s revocation is now here too', cached.revoked.has('jti-from-the-other-machine') && cached.revoked.has(E.jti), `cached ${cached.revoked.size}`)
  T('K5 and hostLists presents both', R.mergeLists(ROOM, await safe(() => fn('hostLists')(ROOM), [])).revoked.has('jti-from-the-other-machine'))
  const strangerRoom = K.newPersonalRoom().room // a private room this machine does not host
  T('K5 a room this machine does not host: its cache, here nothing', (await safe(() => fn('hostLists')(strangerRoom), null) || []).length === 0)
  T('K5 an open room has no lists', (await safe(() => fn('hostLists')('room-open-123456'), null) || [1]).length === 0)
}

console.log('\n# K7  an expired invite leaves the list')
{
  const rec = keyRec(ROOM)
  rec.revoked = [...(rec.revoked || []), { jti: 'jti-long-gone', exp: nowSec() - 5 }]
  fs.writeFileSync(path.join(process.env.HIVE_KEYS_DIR, `${ROOM}.json`), JSON.stringify(rec))
  inv('Frank')
  await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Frank' }), {})
  const after = keyRec(ROOM)
  const v = R.verifyList(after.list, ROOM)
  after.revoked = after.revoked || []
  T('K7 the newly signed list leaves it out, and so does the key file', v.ok === true && !v.list.revoked.some((e) => e.jti === 'jti-long-gone') && !after.revoked.some((e) => e.jti === 'jti-long-gone') && v.list.revoked.some((e) => e.jti === A.jti))
}

console.log('\n# K7b  revoking an invite that has already expired')
{
  const rec = keyRec(ROOM)
  rec.invites.push({ jti: 'jti-already-expired', name: 'Greg', kind: 'ai', role: 'writer', paths: null, writePaths: null, exp: nowSec() - 60, at: Date.now() - 86400000 })
  fs.writeFileSync(path.join(process.env.HIVE_KEYS_DIR, `${ROOM}.json`), JSON.stringify(rec))
  const r = await safe(() => K.revokeInvite({ room: ROOM, relay: RELAY, name: 'Greg' }), {})
  const after = keyRec(ROOM)
  const v = R.verifyList(after.list, ROOM)
  T('K7b it is marked revoked, and the list does not carry an entry nobody needs', r.ok === true && after.invites.find((i) => i.name === 'Greg').revokedAt > 0 && v.ok === true && !v.list.revoked.some((e) => e.jti === 'jti-already-expired'))
}

// ---- tokens ---------------------------------------------------------------------------------------
const resolve = (o) => safe(() => fn('resolveRoomToken')(o), '')
const save = (o) => safe(() => fn('saveRoomToken')(o), false)
const tokDir = path.join(HOME, 'tokens')
const mint = (name, extra = {}) => K.mintRoomToken(keyRec(ROOM), { name, role: 'writer', ...extra }).token
const DIR = path.join(TMP, 'project'); fs.mkdirSync(DIR, { recursive: true })
const nameOf = (t) => (decodeUnsafe(t) || {}).name
const jtiOf = (t) => (decodeUnsafe(t) || {}).jti

console.log('\n# T2  where a saved token goes')
{
  const t = mint('Gina')
  const ok = await save({ room: ROOM, name: 'Gina', token: t })
  const files = fs.existsSync(tokDir) ? fs.readdirSync(tokDir, { recursive: true }).map(String).filter((f) => f.endsWith('.json')) : []
  T('T2 saved under ~/.hivecode/tokens', ok !== false && files.length === 1, `files: ${files.join(',')}`)
  T('T2 nothing was written in the room folder', fs.readdirSync(DIR).length === 0)
  if (process.platform !== 'win32' && files.length) T('T2 readable by the user only', (fs.statSync(path.join(tokDir, files[0])).mode & 0o077) === 0)
  T('T2 the file name does not contain the participant name or the token', files.length === 1 && !/Gina/.test(files[0]))
  T('T1 found again by room and name', jtiOf(await resolve({ room: ROOM, name: 'Gina', dir: DIR })) === jtiOf(t))
}

console.log('\n# T1  the order')
{
  const saved = await resolve({ room: ROOM, name: 'Gina', dir: DIR })
  const viaEnv = mint('Gina'), viaLink = mint('Gina'), viaArg = mint('Gina')
  process.env.HIVE_TOKEN = viaEnv
  T('T1 $HIVE_TOKEN comes before the saved one', jtiOf(await resolve({ room: ROOM, name: 'Gina', dir: DIR })) === jtiOf(viaEnv))
  T('T1 the link comes before $HIVE_TOKEN', jtiOf(await resolve({ room: ROOM, name: 'Gina', dir: DIR, link: `${RELAY}|${ROOM}|${viaLink}` })) === jtiOf(viaLink))
  T('T1 an explicit token comes first', jtiOf(await resolve({ room: ROOM, name: 'Gina', dir: DIR, link: `${RELAY}|${ROOM}|${viaLink}`, explicit: viaArg })) === jtiOf(viaArg))
  delete process.env.HIVE_TOKEN
  T('T1 with none of those, the saved one', jtiOf(await resolve({ room: ROOM, name: 'Gina', dir: DIR })) === jtiOf(saved) && !!saved)
  T('T1 a link without a token is not a token', jtiOf(await resolve({ room: ROOM, name: 'Gina', dir: DIR, link: `${RELAY}|${ROOM}` })) === jtiOf(saved))
}

console.log('\n# T3  an old .hive.json')
{
  const old = mint('Hank')
  const cfg = path.join(DIR, '.hive.json')
  fs.writeFileSync(cfg, JSON.stringify({ relay: RELAY, room: ROOM, token: old, pinnedRelay: 'wss://pinned.example' }, null, 2))
  T('T3 its token is found', jtiOf(await resolve({ room: ROOM, name: 'Hank', dir: DIR })) === jtiOf(old))
  T('T3 a tool that only reads leaves the file as it was', JSON.parse(fs.readFileSync(cfg, 'utf8')).token === old)
  fs.rmSync(cfg) // the copy made on that first read is what answers now
  T('T3 and it was copied to the store on that read', jtiOf(await resolve({ room: ROOM, name: 'Hank', dir: DIR })) === jtiOf(old))
  const older = mint('Ivy')
  fs.writeFileSync(cfg, JSON.stringify({ relay: RELAY, room: ROOM, token: older, pinnedRelay: 'wss://pinned.example' }, null, 2))
  T('T3 a join (migrate) gets the token', jtiOf(await resolve({ room: ROOM, name: 'Ivy', dir: DIR, migrate: true })) === jtiOf(older))
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'))
  T('T3 and takes it out of the file, keeping the rest', !('token' in after) && after.room === ROOM && after.relay === RELAY && after.pinnedRelay === 'wss://pinned.example', JSON.stringify(after))
  fs.writeFileSync(cfg, JSON.stringify({ relay: RELAY, room: 'room-some-other-room', token: mint('Jo') }))
  T('T3 a .hive.json for another room is not this room\'s token', (await resolve({ room: ROOM, name: 'Jo', dir: DIR })) === '')
  fs.rmSync(cfg)
}

console.log('\n# T4 T5 T6')
{
  const otherRoom = K.newPersonalRoom()
  K.saveRoomKey(otherRoom, { relay: RELAY, host: 'Elsewhere' })
  process.env.HIVE_TOKEN = K.mintRoomToken(keyRec(otherRoom.room), { name: 'Gina' }).token
  T('T4 a token made for another private room is passed over', nameOf(await resolve({ room: ROOM, name: 'Gina', dir: DIR })) === 'Gina' && decodeUnsafe(await resolve({ room: ROOM, name: 'Gina', dir: DIR })).scopes[0].room === ROOM)
  delete process.env.HIVE_TOKEN

  const solo = K.newPersonalRoom() // hosted on some other machine: this one only holds an invite to it
  const guestTok = K.mintRoomToken(solo, { name: 'OnlyGuest' }).token
  await save({ room: solo.room, name: 'OnlyGuest', token: guestTok })
  T('T5 no name: the one token saved for the room', jtiOf(await resolve({ room: solo.room, dir: DIR })) === jtiOf(guestTok))
  const later = K.mintRoomToken(solo, { name: 'SecondGuest' }).token
  await new Promise((r) => setTimeout(r, 15))
  await save({ room: solo.room, name: 'SecondGuest', token: later })
  T('T5 no name, two saved: the one saved last', jtiOf(await resolve({ room: solo.room, dir: DIR })) === jtiOf(later))
  const hp = decodeUnsafe(await resolve({ room: ROOM, dir: DIR })) || {}
  T('T5 no name on the machine that hosts the room: the host\'s own token, not a guest\'s saved here', hp.name === 'Host' && !!hp.scopes && hp.scopes[0].role === 'maintainer')

  const kay = mint('Kay'), lee = mint('Lee')
  await save({ room: ROOM, name: 'Kay', token: kay }); await save({ room: ROOM, name: 'Lee', token: lee })
  T('T6 two participants keep separate invites', jtiOf(await resolve({ room: ROOM, name: 'Kay', dir: DIR })) === jtiOf(kay) && jtiOf(await resolve({ room: ROOM, name: 'Lee', dir: DIR })) === jtiOf(lee))
  T('T6 a name with nothing saved gets nothing (not somebody else\'s)', (await resolve({ room: ROOM, name: 'Nobody', dir: DIR })) === '')
}

console.log('\n# T7  the host')
{
  const t = await resolve({ room: ROOM, name: 'Host', dir: DIR })
  const p = decodeUnsafe(t) || {}
  T('T7 the host with no token saved gets a maintainer token from the key', p.name === 'Host' && p.scopes && p.scopes[0].role === 'maintainer' && verify(t, { publicKey: fresh.publicKey, alg: 'RS256' }).ok)
  const stale = sign({ iss: 'hivecode', sub: 'Host', name: 'Host', kind: 'ai', pk: fresh.publicKey, scopes: [{ room: ROOM, role: 'maintainer' }], iat: nowSec() - 100, exp: nowSec() + 60, jti: 'jti-stale' }, { privateKey: fresh.privateKey })
  await save({ room: ROOM, name: 'Host', token: stale })
  T('T7 a host token about to run out is renewed, not handed back', jtiOf(await resolve({ room: ROOM, name: 'Host', dir: DIR })) !== 'jti-stale')
  T('T7 an explicit token is used as given, even for the host', jtiOf(await resolve({ room: ROOM, name: 'Host', dir: DIR, explicit: stale })) === 'jti-stale')
}

console.log('\n# T8  an unsafe room name')
{
  const evil = '../../../escape/room'
  await save({ room: evil, name: 'X', token: 'aaa.bbb.ccc' })
  const outside = [path.join(TMP, 'escape'), path.join(TMP, 'a', 'escape'), path.join(HOME, 'escape')].some((p) => fs.existsSync(p))
  T('T8 nothing is written outside the store', !outside)
  T('T8 and the token is still found for that room', (await resolve({ room: evil, name: 'X', dir: DIR })) === 'aaa.bbb.ccc')
}

server.close()
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
