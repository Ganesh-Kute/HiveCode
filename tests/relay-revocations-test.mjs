// relay-revocations.js on its own: the relay's memory of signed revocation lists.
// tests/private-room-relay-test.mjs drives it through a real relay; this file is for what a relay
// test cannot reach cheaply: the bounds, the per-room files, and the outside-store slot that
// server.js leaves empty today (so wiring a store later cannot quietly break "fail closed").
//
//   B1  a relay keeps lists for a bounded number of rooms: a NEW room past the bound is refused,
//       a room it already holds can always add (a revoke for a known room is never refused)
//   B2  a room whose every entry has expired gives its place back
//   B3  all lists together are bounded in size; past it a room keeps a small reserve, so a known
//       host can still revoke, and a large addition is refused and changes nothing
//   F1  with a disk: one small file per room, written on change, read (and verified) at boot
//   F2  a file that is junk, or holds another room's list, is ignored
//   O1  an outside store is read once per boot before anyone is let in; what it returns is verified
//   O2  a store that cannot be read: ready() rejects (the caller refuses the join), and works on retry
//   O3  a store that refuses a write: commit() rejects, memory still holds the revoke
//   O4  what the store returns is taken whole, past the bounds: refusing it would forget a revoke
//   P   a room id is a file name here, so one that is not letters, digits, _ and - is refused and
//       never turned into a path (found 14 Nov: 'hs_<fp>_x/../../victim' wrote and deleted outside the folder)
//
//   node tests/relay-revocations-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-relay-rev-t-'))
process.env.HIVE_KEYS_DIR = path.join(tmp, 'keys')
const { newPersonalRoom } = await import('../hive-room-key.js')
const { signList } = await import('../hive-revocations.js')
const { makeRelayRevocations } = await import('../relay-revocations.js')
const { roomFingerprint } = await import('../token.js')

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra && !c ? `   ${String(extra).slice(0, 300)}` : ''}`); c ? pass++ : fail++ }
const NOW = 1_800_000_000
const room = () => newPersonalRoom()
const list = (k, seq, jtis, exp = NOW + 3600) => signList(k, { seq, revoked: jtis.map((jti) => ({ jti, exp })), iat: NOW })

try {
  console.log('\n# B bounds')
  const [A, B, C] = [room(), room(), room()]
  let clock = NOW
  const r = makeRelayRevocations({ maxRooms: 2, now: () => clock })
  const a1 = r.present(A.room, [list(A, 1, ['a1'])])
  const b1 = r.present(B.room, [list(B, 1, ['b1'], NOW + 60)])
  T('B1a two rooms are kept', !a1.refused && !b1.refused && r.isRevoked(A.room, 'a1') && r.isRevoked(B.room, 'b1'), JSON.stringify([a1.refused, b1.refused]))
  const c1 = r.present(C.room, [list(C, 1, ['c1'])])
  T('B1b a third, new room is refused, and nothing of it is kept', c1.refused === 'rooms' && !r.isRevoked(C.room, 'c1') && r.listsOf(C.room).length === 0, JSON.stringify(c1.refused))
  const a2 = r.present(A.room, [list(A, 2, ['a1', 'a2'])])
  T('B1c a room already held still adds a revoke at the bound', !a2.refused && a2.added.join() === 'a2' && r.isRevoked(A.room, 'a2'), JSON.stringify([a2.refused, a2.added]))
  const cJunk = r.present(C.room, ['aaa.bbb.ccc'])
  T('B1d presenting nothing valid for a new room is not a refusal (nothing to keep)', !cJunk.refused, JSON.stringify(cJunk.refused))
  clock = NOW + 120                                        // B's only entry has expired
  const c2 = r.present(C.room, [list(C, 1, ['c1'])])
  T('B2 a room whose entries all expired gives its place back', !c2.refused && r.isRevoked(C.room, 'c1') && r.listsOf(B.room).length === 0, JSON.stringify(c2.refused))

  // All lists together are bounded too. Past that bound a room still has a small reserve, so a host
  // the relay already knows can keep revoking; only a large addition is refused.
  const [D, E] = [room(), room()]
  const one = list(A, 1, ['a1']).length                    // about 1.1 KB: the key and the signature
  const small = makeRelayRevocations({ maxBytes: one * 2 + 300, reserveBytes: one + 600, now: () => NOW })
  const many = (k, seq, n) => list(k, seq, Array.from({ length: n }, (_, i) => `jti-${i}-xxxxxxxxxxxxxxxx`))
  const ok = small.present(A.room, [list(A, 1, ['a1'])])
  const big = small.present(A.room, [many(A, 2, 200)])
  T('B3a a normal list fits', !ok.refused && small.isRevoked(A.room, 'a1'))
  T('B3b a list that would take the relay past its size is refused and changes nothing', big.refused === 'bytes' && big.added.length === 0 && !small.isRevoked(A.room, 'jti-0-xxxxxxxxxxxxxxxx') && small.isRevoked(A.room, 'a1') && small.listsOf(A.room).length === 1, JSON.stringify([big.refused, small.listsOf(A.room).length]))
  const dd = small.present(D.room, [list(D, 1, ['d1'])])
  const e1 = small.present(E.room, [list(E, 1, ['e1'])])   // past the size now, inside the reserve
  T('B3c past the size, a room with a few revokes is still taken', !dd.refused && !e1.refused && small.isRevoked(E.room, 'e1') && small.size().bytes > small.size().maxBytes, JSON.stringify([dd.refused, e1.refused, small.size()]))
  const a2b = small.present(A.room, [list(A, 2, ['a1', 'a2'])])
  T('B3d and a room already held still adds a revoke', !a2b.refused && small.isRevoked(A.room, 'a2'), JSON.stringify(a2b.refused))
  const e2 = small.present(E.room, [many(E, 2, 60)])
  T('B3e while a large addition is refused; what the room had still stands', e2.refused === 'bytes' && small.isRevoked(E.room, 'e1') && !small.isRevoked(E.room, 'jti-1-xxxxxxxxxxxxxxxx'), JSON.stringify(e2.refused))
  T('B3f size() counts what is held', small.size().rooms === 3 && small.size().bytes === [A, D, E].reduce((n, k) => n + small.listsOf(k.room).reduce((m, l) => m + l.length, 0), 0), JSON.stringify(small.size()))

  console.log('\n# F with a disk')
  const dir = path.join(tmp, 'disk')
  const d1 = makeRelayRevocations({ dir, now: () => NOW })
  d1.present(A.room, [list(A, 1, ['a1'])])
  d1.present(B.room, [list(B, 1, ['b1'])])
  const files = fs.readdirSync(path.join(dir, 'revocations')).sort()
  T('F1a one file per room', files.length === 2 && files.includes(`${A.room}.json`) && files.includes(`${B.room}.json`), files.join(','))
  const before = fs.statSync(path.join(dir, 'revocations', `${B.room}.json`)).mtimeMs
  d1.present(A.room, [list(A, 2, ['a1', 'a2'])])
  T('F1b a change to one room does not rewrite another room\'s file', fs.statSync(path.join(dir, 'revocations', `${B.room}.json`)).mtimeMs === before)
  const d2 = makeRelayRevocations({ dir, now: () => NOW })
  T('F1c a new boot reads them back', d2.isRevoked(A.room, 'a2') && d2.isRevoked(B.room, 'b1') && d2.durable === true)
  fs.writeFileSync(path.join(dir, 'revocations', `${C.room}.json`), JSON.stringify({ v: 1, lists: [list(A, 9, ['zz'])] }))   // A's list in C's file
  fs.writeFileSync(path.join(dir, 'revocations', 'not-a-room.json'), '{{{{')
  const d3 = makeRelayRevocations({ dir, now: () => NOW })
  T('F2 junk and another room\'s list in a file are ignored', !d3.isRevoked(C.room, 'zz') && d3.listsOf(C.room).length === 0 && d3.isRevoked(A.room, 'a2'))
  T('F3 no disk and no store: not durable', makeRelayRevocations({}).durable === false)

  console.log('\n# O an outside store')
  let down = false, puts = [], gets = 0
  const kept = new Map([[A.room, [list(A, 3, ['a1', 'a3']), 'junk', list(B, 1, ['b-in-a'])]]])
  const store = {
    get: async (rm) => { gets++; if (down) throw new Error('store down'); return kept.get(rm) || [] },
    put: async (rm, lists) => { if (down) throw new Error('store down'); puts.push([rm, lists.length]); kept.set(rm, lists) },
  }
  const o = makeRelayRevocations({ store, now: () => NOW })
  T('O1a durable with a store', o.durable === true)
  const added = await o.ready(A.room)
  T('O1b ready() loads the room\'s lists, verified: junk and another room\'s list are dropped', added.sort().join() === 'a1,a3' && o.isRevoked(A.room, 'a3') && !o.isRevoked(A.room, 'b-in-a') && o.listsOf(A.room).length === 1, JSON.stringify(added))
  await o.ready(A.room)
  T('O1c once per boot, not once per join', gets === 1, `gets=${gets}`)
  down = true
  let threw = false
  try { await o.ready(B.room) } catch { threw = true }
  T('O2a a store that cannot be read: ready() rejects', threw)
  down = false
  const again = await o.ready(B.room).then(() => true, () => false)
  T('O2b and the next call tries again and works', again && gets === 3, `gets=${gets}`)
  o.present(B.room, [list(B, 1, ['b1'])])
  await o.commit(B.room)
  T('O3a commit() puts the room\'s lists in the store', puts.length === 1 && puts[0][0] === B.room && puts[0][1] === 1, JSON.stringify(puts))
  down = true
  o.present(B.room, [list(B, 2, ['b1', 'b2'])])
  const refused = await o.commit(B.room).then(() => false, () => true)
  T('O3b a store that refuses the write: commit() rejects, and memory still holds the revoke', refused && o.isRevoked(B.room, 'b2'))

  console.log('\n# O4 a store answer past the bounds is taken whole')
  const tiny = makeRelayRevocations({ maxRooms: 1, maxBytes: 10, reserveBytes: 10, now: () => NOW, store: { get: async (rm) => (rm === A.room ? [list(A, 1, ['s1'])] : rm === B.room ? [list(B, 1, ['s2'])] : []), put: async () => { } } })
  await tiny.ready(A.room); await tiny.ready(B.room)
  T('O4 two rooms and more bytes than the bounds allow, from the store, are all kept', tiny.isRevoked(A.room, 's1') && tiny.isRevoked(B.room, 's2') && tiny.size().rooms === 2, JSON.stringify(tiny.size()))

  console.log('\n# P a room id is not a path')
  const K = room()
  const fp = roomFingerprint(K.room)                       // base64url: it may itself hold an underscore
  const pdir = path.join(tmp, 'pp', 'persist')
  fs.mkdirSync(pdir, { recursive: true })
  fs.writeFileSync(path.join(pdir, 'victim.json'), '{"precious":true}')
  const pr = makeRelayRevocations({ dir: pdir, now: () => NOW })
  const evil = [`hs_${fp}_x/../../ESCAPED`, `hs_${fp}_x/../../victim`, `hs_${fp}_..\\..\\x`, `hs_${fp}_x%2F..%2Fy`, `hs_${fp}_x\0y`, `hs_${fp}_${'a'.repeat(300)}`]
  for (const id of evil) {
    const out = pr.present(id, [signList({ ...K, room: id }, { seq: 1, revoked: [{ jti: 'e', exp: NOW + 3600 }], iat: NOW })])
    T(`P1 refused, nothing kept: ${JSON.stringify(id).slice(0, 44)}`, out.refused === 'room' && !pr.isRevoked(id, 'e') && pr.listsOf(id).length === 0 && !out.changed, JSON.stringify(out.refused))
  }
  const under = []; (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, f.name); f.isDirectory() ? walk(q) : under.push(path.relative(path.join(tmp, 'pp'), q)) } })(path.join(tmp, 'pp'))
  T('P2 nothing was written anywhere (not outside the folder, not inside it)', under.length === 1 && under[0] === path.join('persist', 'victim.json'), under.join(','))
  T('P3 an existing file beside the folder is untouched', fs.readFileSync(path.join(pdir, 'victim.json'), 'utf8') === '{"precious":true}')
  // and a good room still works, and its expiry deletes only its own file
  const okp = pr.present(K.room, [signList(K, { seq: 1, revoked: [{ jti: 'g', exp: NOW + 60 }], iat: NOW })])
  T('P4 a proper room is still taken and written under revocations/', !okp.refused && fs.existsSync(path.join(pdir, 'revocations', `${K.room}.json`)))
  const dotted = `hs_${fp}_a.b`                                             // validly signed, but not a plain id: a file for it is not read
  fs.writeFileSync(path.join(pdir, 'revocations', `${dotted}.json`), JSON.stringify({ v: 1, lists: [signList({ ...K, room: dotted }, { seq: 1, revoked: [{ jti: 'dd', exp: NOW + 60 }], iat: NOW })] }))
  const pr2 = makeRelayRevocations({ dir: pdir, now: () => NOW })
  T('P5 a new boot reads the proper room and ignores a file whose id is not a plain one', pr2.isRevoked(K.room, 'g') && !pr2.isRevoked(dotted, 'dd') && pr2.size().rooms === 1, JSON.stringify(pr2.size()))
} catch (e) {
  T('no exception', false, e && e.stack)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
