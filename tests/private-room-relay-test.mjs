// A private room (hs_...) on the relay: the promise is "only the people I invited, and out means out".
// The websocket, mux and long-poll joins already pass through authorize(); this file is about the
// doors that did not, and about leaving. A real relay (server.js), a room minted the way
// hive-room-key.js mints one, and a fake Slack Web API.
//
//   A1 Slack obeys the guest list
//     S1  no invite: /slack/prepare on a private room is refused (it used to answer 200 + an install link)
//     S2  a writer, a reader, another room's host, an expired and a revoked invite are all refused
//     S3  the host's token is accepted; a normal room needs no token, as before
//     S4  the host connects a channel; the room is told who connected it and who can now read
//     S5  the host can list the room's Slack connections; a guest cannot
//     S6  the host can end a connection with only {room, token}; a guest cannot
//     S7  a private-room record with no host mark (made before this check existed) is not served
//     S8  a Slack relay nobody wired to the relay's gate refuses a private room (fail closed)
//   A2 a revoke the relay cannot forget (signed lists, hive-revocations.js)
//     V1  a signed list revokes: the open socket is closed, the invite is refused
//     V2  the relay answers with the lists it holds, so a member that presents nothing learns them
//     V3  a restart with no disk forgets; ANYONE handing the same list back restores it (no token needed)
//     V4  a list signed with another room's key, a list for a normal room, junk: nothing changes
//     V5  an older list presented after a newer one takes nothing away
//     V6  a connected member receives the lists through the room (map hive_revocations)
//     V7  with a disk, the relay remembers by itself across a restart
//     V8  too many lists in one request is refused
//   A3 expiry is enforced on an open connection
//     E1  a websocket whose invite ran out is closed by the relay (4401 "token expired")
//     E2  a mux socket whose invite ran out is closed too
//     E3  an invite with time left, and a normal room's socket, are left alone
//
//   node tests/private-room-relay-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'
import { MUX_PREFIX } from '../hive-mux-proto.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1381, SLACK_PORT = 1382
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-private-t-'))
process.env.HIVE_KEYS_DIR = path.join(tmp, 'keys')
const { newPersonalRoom, saveRoomKey, loadRoomKey, mintRoomToken } = await import('../hive-room-key.js')
const { signList, mergeLists } = await import('../hive-revocations.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100) } return null }

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra && !c ? `   ${String(extra).slice(0, 300)}` : ''}`); c ? pass++ : fail++ }

// ---- a fake Slack Web API: enough for /slack/connect (auth.test, conversations.info, chat.postMessage)
const posts = []
const slack = http.createServer((req, res) => {
  let b = ''
  req.on('data', (d) => { b += d })
  req.on('end', () => {
    const method = req.url.split('/').pop()
    let p = {}
    try { p = /json/.test(req.headers['content-type'] || '') ? JSON.parse(b || '{}') : Object.fromEntries(new URLSearchParams(b)) } catch { }
    const out = method === 'auth.test' ? { ok: true, team: 'Alpha', team_id: 'T1', user_id: 'UBOT' }
      : method === 'conversations.info' ? { ok: true, channel: { id: p.channel, name: 'founders', is_member: true } }
        : method === 'chat.postMessage' ? (posts.push(p), { ok: true, ts: String(Date.now() / 1000) })
          : { ok: true }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out))
  })
})
await new Promise((r) => slack.listen(SLACK_PORT, '127.0.0.1', r))

// ---- the relay
const relays = []
function boot(port, env = {}) {
  const r = spawn(process.execPath, ['server.js'], { cwd: tmp, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off', HIVE_SLACK_KEY: 'k'.repeat(40), HIVE_SLACK_API: `http://127.0.0.1:${SLACK_PORT}`, HIVE_EXPIRY_SWEEP_MS: '300', HIVE_ROOM_REVOKED_FILE: path.join(tmp, `revoked-${port}.json`), ...env }, })
  relays.push(r)
  r.stderr.on('data', () => { })
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    r.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res(r) } })
  })
}
// server.js is started from a temp cwd so nothing is written into the repository
fs.writeFileSync(path.join(tmp, 'server.js'), `import ${JSON.stringify(path.join(ROOT, 'server.js'))}\n`)

const post = async (p, body, port = PORT) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let j = null
  try { j = await r.json() } catch { }
  return { status: r.status, body: j || {} }
}
const sockets = []
const open = (room, token, port = PORT) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(room)}${token ? `?token=${token}` : ''}`)
  sockets.push(ws)
  const st = { ws, open: false, status: 0, closed: null }
  ws.once('open', () => { st.open = true; res(st) })
  ws.once('unexpected-response', (_q, r) => { st.status = r.statusCode; res(st) })
  ws.once('error', () => res(st))
  ws.on('close', (code, reason) => { st.closed = { code, reason: String(reason || '') } })
})

// ---- two private rooms and their people
const mk = (host) => { const k = newPersonalRoom(); saveRoomKey(k, { relay: `ws://127.0.0.1:${PORT}`, host }); return loadRoomKey(k.room) }
const A = mk('Host'), B = mk('OtherHost')
const tok = (rec, name, o = {}) => mintRoomToken(rec, { name, ...o })
const host = tok(A, 'Host', { kind: 'human', role: 'maintainer' })
const writer = tok(A, 'Writer', { role: 'writer' })
const reader = tok(A, 'Reader', { role: 'reader' })
const otherHost = tok(B, 'OtherHost', { kind: 'human', role: 'maintainer' })
const expired = tok(A, 'Late', { role: 'maintainer', ttlSec: -5 })
const gone = tok(A, 'Gone', { role: 'maintainer' })
const NORMAL = 'room-private-test-' + process.pid

try {
  await boot(PORT)
  const rv = await post('/__hive/revoke', { room: A.room, token: host.token, jti: gone.jti })
  if (!rv.body.ok) throw new Error('setup: revoke failed ' + JSON.stringify(rv.body))

  console.log('\n# A1 Slack obeys the guest list')
  const none = await post('/slack/prepare', { room: A.room })
  T('S1a no invite: prepare on a private room is refused', none.status === 401 && none.body.ok === false, `${none.status} ${JSON.stringify(none.body)}`)
  T('S1b and says why, by code (Q674)', /Q674/.test(none.body.why || none.body.code || ''), JSON.stringify(none.body))
  T('S1c no id and no install link is handed out', !none.body.id && !none.body.installUrl && !none.body.eventsUrl, JSON.stringify(none.body))
  for (const [label, t, code] of [['a writer', writer.token, 'Q675'], ['a reader', reader.token, 'Q675'], ["another room's host", otherHost.token, 'Q674'], ['an expired invite', expired.token, 'Q674'], ['a revoked invite', gone.token, 'Q674'], ['a made-up token', 'aaa.bbb.ccc', 'Q674']]) {
    const r = await post('/slack/prepare', { room: A.room, token: t })
    T(`S2 ${label} is refused (${code})`, r.status >= 400 && r.body.ok === false && !r.body.id && new RegExp(code).test(r.body.why || ''), `${r.status} ${JSON.stringify(r.body)}`)
  }
  const ok = await post('/slack/prepare', { room: A.room, token: host.token })
  T('S3a the host is accepted', ok.status === 200 && ok.body.ok === true && !!ok.body.id, `${ok.status} ${JSON.stringify(ok.body)}`)
  const again = await post('/slack/prepare', { room: A.room })
  T('S3b the host\'s unfinished id is not handed to a caller with no invite', again.status === 401 && !again.body.id, `${again.status} ${JSON.stringify(again.body)}`)
  const normal = await post('/slack/prepare', { room: NORMAL })
  T('S3c a normal room needs no token, as before', normal.status === 200 && normal.body.ok === true && !!normal.body.id, `${normal.status} ${JSON.stringify(normal.body)}`)

  // the host watches the room's chat over a real connection
  const { startSync } = await import('../sync.js')
  const hostClient = startSync({ relay: `ws://127.0.0.1:${PORT}`, room: A.room, dir: fs.mkdtempSync(path.join(tmp, 'host-')), name: 'Host', kind: 'human', token: host.token, syncFiles: false, log: () => { } })
  const chat = () => hostClient.doc.getArray('chat').toArray().map((m) => String(m.text || ''))
  await until(() => hostClient.provider && hostClient.provider.synced)

  const con = await post('/slack/connect', { id: ok.body.id, botToken: 'xoxb-1-aaaaaaaaaaaaaaaaaaaaaaaa', signingSecret: 'sign-secret-1', channel: 'C0123456789' })
  T('S4a the host connects a channel', con.status === 200 && con.body.ok === true, `${con.status} ${JSON.stringify(con.body)}`)
  const told = await until(() => chat().find((t) => /Slack is connected/.test(t)))
  T('S4b the room is told who connected it', !!told && /Host/.test(told), told || chat().join(' | '))
  T('S4c and that everyone in that channel can read this room\'s chat', !!told && /everyone in/i.test(told) && /#founders/.test(told), told || '')

  const list = await post('/slack/list', { room: A.room, token: host.token })
  T('S5a the host can list the room\'s Slack connections', list.status === 200 && Array.isArray(list.body.connections) && list.body.connections.length === 1 && list.body.connections[0].channel === 'founders', `${list.status} ${JSON.stringify(list.body)}`)
  T('S5b the list names who connected it, and holds no token or secret', list.status === 200 && list.body.connections[0].by === 'Host' && !/xoxb|sign-secret/.test(JSON.stringify(list.body)), JSON.stringify(list.body))
  for (const [label, t] of [['a writer', writer.token], ['nobody', '']]) {
    const r = await post('/slack/list', { room: A.room, token: t })
    T(`S5c ${label} cannot list them`, r.status >= 400 && !r.body.connections, `${r.status} ${JSON.stringify(r.body)}`)
  }
  const guestEnd = await post('/slack/disconnect', { room: A.room, token: writer.token })
  T('S6a a guest cannot end the connection', guestEnd.status >= 400 && guestEnd.body.ok === false, `${guestEnd.status} ${JSON.stringify(guestEnd.body)}`)
  const still = await post('/slack/list', { room: A.room, token: host.token })
  T('S6b it is still there', still.status === 200 && still.body.connections.length === 1, JSON.stringify(still.body))
  const end = await post('/slack/disconnect', { room: A.room, token: host.token })
  T('S6c the host ends it with only the room and their token', end.status === 200 && end.body.ok === true, `${end.status} ${JSON.stringify(end.body)}`)
  const after = await post('/slack/list', { room: A.room, token: host.token })
  T('S6d and it is gone', after.status === 200 && after.body.connections.length === 0, JSON.stringify(after.body))
  T('S6e the room is told', !!(await until(() => chat().find((t) => /was disconnected/.test(t)))), chat().join(' | '))
  hostClient.stop()

  // S7: a store written before this check existed, on a relay with a disk
  const dir = path.join(tmp, 'store')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'slack-relay.json'), JSON.stringify({ v: 1, conns: {
    oldprivate0000001: { room: A.room, at: Date.now(), connected: false },
    oldnormal00000001: { room: NORMAL, at: Date.now(), connected: false },
  } }))
  await boot(PORT + 2, { HIVE_PERSIST_DIR: dir })
  const stOld = await post('/slack/status', { id: 'oldprivate0000001' }, PORT + 2)
  T('S7a an unmarked private-room record from an older relay is not served', stOld.status === 404, `${stOld.status} ${JSON.stringify(stOld.body)}`)
  const stNorm = await post('/slack/status', { id: 'oldnormal00000001' }, PORT + 2)
  T('S7b a normal room\'s record is kept', stNorm.status === 200 && stNorm.body.ok === true, `${stNorm.status} ${JSON.stringify(stNorm.body)}`)

  // S8: hive-slack-relay.js used without an `access` callback (an embedder, an old server.js)
  {
    const { makeSlackRelay } = await import('../hive-slack-relay.js')
    const bare = makeSlackRelay({ getDoc: () => null, docs: new Map(), key: 'k'.repeat(40) })
    const srv = http.createServer((q, r) => bare.handle(q, r))
    await new Promise((r) => srv.listen(PORT + 8, '127.0.0.1', r))
    const priv = await post('/slack/prepare', { room: A.room, token: host.token }, PORT + 8)
    T('S8a with no gate wired in, a private room is refused even for its host', priv.status === 401 && /Q674/.test(priv.body.why || '') && !priv.body.id, `${priv.status} ${JSON.stringify(priv.body)}`)
    const norm = await post('/slack/prepare', { room: NORMAL }, PORT + 8)
    T('S8b and a normal room still works there', norm.status === 200 && !!norm.body.id, `${norm.status} ${JSON.stringify(norm.body)}`)
    bare.stop(); srv.close()
  }

  console.log('\n# A2 a revoke the relay cannot forget')
  const P2 = PORT + 4
  const bootP2 = async (env = {}) => { const r = await boot(P2, env); return r }
  let relay2 = await bootP2()
  const guest = tok(A, 'Guest', { role: 'writer' }), guest2 = tok(A, 'Guest2', { role: 'writer' }), keeper = tok(A, 'Keeper', { role: 'writer' })
  const L1 = signList(A, { seq: 1, revoked: [{ jti: guest.jti, exp: guest.exp }] })
  const L2 = signList(A, { seq: 2, revoked: [{ jti: guest.jti, exp: guest.exp }, { jti: guest2.jti, exp: guest2.exp }] })
  const g = await open(A.room, guest.token, P2)
  const k = await open(A.room, keeper.token, P2)
  T('V0 guest and keeper are in', g.open && k.open, `${g.open} ${k.open}`)
  const p1 = await post('/__hive/revocations', { room: A.room, lists: [L1] }, P2)
  T('V1a a signed list is accepted', p1.status === 200 && p1.body.ok === true, `${p1.status} ${JSON.stringify(p1.body).slice(0, 200)}`)
  T('V1b the revoked guest\'s open socket is closed (4401 "token revoked")', !!(await until(() => g.closed)) && g.closed.code === 4401 && /revoked/.test(g.closed.reason), JSON.stringify(g.closed))
  T('V1c the keeper is untouched', k.ws.readyState === WebSocket.OPEN, JSON.stringify(k.closed))
  const g1 = await open(A.room, guest.token, P2)
  T('V1d the revoked invite is refused', !g1.open && g1.status === 401, `${g1.open} ${g1.status}`)
  const p0 = await post('/__hive/revocations', { room: A.room, lists: [] }, P2)
  T('V2 the relay hands back the lists it holds', p0.status === 200 && Array.isArray(p0.body.lists) && p0.body.lists.length === 1 && p0.body.lists[0] === L1, JSON.stringify(p0.body).slice(0, 200))

  relay2.kill(); await sleep(400); relay2 = await bootP2()     // a redeploy: nothing on disk
  const g2 = await open(A.room, guest.token, P2)
  T('V3a after a restart with no disk the relay has forgotten (this is the hole)', g2.open, `${g2.open} ${g2.status}`)
  const handed = await post('/__hive/revocations', { room: A.room, lists: [L1] }, P2)    // no token: any member's client, anyone
  T('V3b the same list handed back by anyone is accepted', handed.status === 200 && handed.body.ok === true, `${handed.status} ${JSON.stringify(handed.body).slice(0, 160)}`)
  T('V3e the answer counts what it closed, and says this relay will forget on a restart', handed.body.dropped === 1 && handed.body.durable === false, JSON.stringify({ d: handed.body.dropped, durable: handed.body.durable }))
  T('V3c and the revoked socket that slipped in is closed before the answer is read', !!g2.closed || !!(await until(() => g2.closed, 1500)), 'still open')
  T('V3d and refused again', (await open(A.room, guest.token, P2)).status === 401)

  const k2 = await open(A.room, keeper.token, P2)   // the keeper again, on the restarted relay
  const forged = signList(B, { seq: 9, revoked: [{ jti: keeper.jti, exp: keeper.exp }] })   // B's key, valid for B's room only
  for (const [label, body] of [['a list signed with another room\'s key', { room: A.room, lists: [forged] }], ['junk', { room: A.room, lists: ['aaa.bbb.ccc', 42, null] }], ['an invite passed off as a list', { room: A.room, lists: [host.token] }]]) {
    const r = await post('/__hive/revocations', body, P2)
    T(`V4 ${label}: nothing changes`, r.status === 200 && r.body.lists.length === 1 && r.body.lists[0] === L1 && r.body.dropped === 0 && k2.ws.readyState === WebSocket.OPEN, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`)
  }
  const nr = await post('/__hive/revocations', { room: NORMAL, lists: [L1] }, P2)
  T('V4 a normal room has no revocation lists (400)', nr.status === 400, `${nr.status}`)

  const g2b = await open(A.room, guest2.token, P2)
  const p2 = await post('/__hive/revocations', { room: A.room, lists: [L2] }, P2)
  T('V5a a newer list revokes one more', p2.status === 200 && !!(await until(() => g2b.closed)), JSON.stringify(p2.body).slice(0, 120))
  const old = await post('/__hive/revocations', { room: A.room, lists: [L1] }, P2)
  T('V5b the older list presented afterwards takes nothing away', old.status === 200 && mergeLists(A.room, old.body.lists).revoked.has(guest2.jti) && (await open(A.room, guest2.token, P2)).status === 401, JSON.stringify(old.body).slice(0, 120))

  const member = startSync({ relay: `ws://127.0.0.1:${P2}`, room: A.room, dir: fs.mkdtempSync(path.join(tmp, 'member-')), name: 'Keeper', kind: 'ai', token: keeper.token, syncFiles: false, log: () => { } })
  const inDoc = await until(() => { const v = member.doc.getMap('hive_revocations').get('lists'); return Array.isArray(v) && v.length ? v : null })
  T('V6 a connected member receives the lists through the room', !!inDoc && mergeLists(A.room, inDoc).revoked.has(guest2.jti), JSON.stringify(inDoc).slice(0, 80))
  member.stop()

  const many = await post('/__hive/revocations', { room: A.room, lists: Array.from({ length: 9 }, () => L1) }, P2)
  T('V8 more lists than one request may carry is refused (400)', many.status === 400, `${many.status}`)
  relay2.kill()

  const disk = path.join(tmp, 'disk')
  fs.mkdirSync(disk)
  let relay3 = await boot(PORT + 6, { HIVE_PERSIST_DIR: disk })
  const kept = await post('/__hive/revocations', { room: A.room, lists: [L1] }, PORT + 6)
  T('V7a a relay with a disk says the revoke will hold', kept.body.ok === true && kept.body.durable === true, JSON.stringify(kept.body).slice(0, 120))
  relay3.kill(); await sleep(400); relay3 = await boot(PORT + 6, { HIVE_PERSIST_DIR: disk })
  T('V7b and it remembers by itself across a restart', (await open(A.room, guest.token, PORT + 6)).status === 401)
  relay3.kill()

  console.log('\n# A3 expiry is enforced on an open connection')
  const short = tok(A, 'Short', { role: 'writer', ttlSec: 2 })
  const long = tok(A, 'Long', { role: 'writer' })
  const s1 = await open(A.room, short.token)
  const s2 = await open(MUX_PREFIX + A.room, tok(A, 'ShortMux', { role: 'writer', ttlSec: 2 }).token)
  const s3 = await open(A.room, long.token)
  const s4 = await open(NORMAL, '')
  T('E0 all four connect', s1.open && s2.open && s3.open && s4.open, JSON.stringify([s1.open, s2.open, s3.open, s4.open, s2.status]))
  await until(() => s1.closed && s2.closed, 6000)
  T('E1a the websocket is closed once its invite has run out', !!s1.closed, 'still open 6 s after a 2 s invite')
  T('E1b with 4401 "token expired"', !!s1.closed && s1.closed.code === 4401 && /expired/.test(s1.closed.reason), JSON.stringify(s1.closed))
  T('E2 the mux socket is closed too', !!s2.closed && s2.closed.code === 4401, JSON.stringify(s2.closed))
  T('E3a an invite with time left stays connected', s3.ws.readyState === WebSocket.OPEN && !s3.closed, JSON.stringify(s3.closed))
  T('E3b a normal room\'s socket stays connected', s4.ws.readyState === WebSocket.OPEN && !s4.closed, JSON.stringify(s4.closed))
  const back = await open(A.room, short.token)
  T('E4 and it cannot come back', !back.open && back.status === 401, `${back.open} ${back.status}`)
} catch (e) {
  T('no exception', false, e && e.stack)
} finally {
  for (const s of sockets) { try { s.terminate() } catch { } }
  for (const r of relays) { try { r.kill() } catch { } }
  slack.close()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
