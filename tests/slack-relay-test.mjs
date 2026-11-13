// Issue #22, part A: the relay's Slack side (hive-slack-relay.js), with real Yjs docs, a real HTTP
// server and a fake Slack Web API. No bridge process anywhere.
//   S1  no HIVE_SLACK_KEY: every route answers Q660 (503)
//   S2  prepare gives a random id (not the room id) and an events URL; a bad room is refused
//   S3  Slack's url_verification is answered for a prepared id before connect, nothing else is
//   S4  connect checks the token (Q662) and channel membership (Q664), then says it in both places
//   S5  the store on disk holds no token or secret in clear, and the room never sees them
//   S6  a signed message reaches the room chat as slack:<handle>; a bad or stale signature is 401
//   S7  the reply is sent before the room write (Slack's 3 s deadline)
//   S8  Slack's retry of the same event_id, the bot's own messages and edits are not delivered
//   S9  a room line goes to Slack; a Slack-sourced line is not echoed back; the room id is scrubbed
//   S10 a doc closed and reopened (everyone left) is watched again, without resending old lines
//   S11 stop / resume from Slack pause and resume the room's AIs
//   S12 disconnect (by id or by room) needs the signing secret; after it nothing flows
//   S13 a relay restart reads the store back and keeps forwarding
//   S14 a changed HIVE_SLACK_KEY (unreadable store) is a dead connection said in the room, never a crash
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { makeSlackRelay, verifySlackSignature, controlIntent } from '../hive-slack-relay.js'

const require = createRequire(import.meta.url)
const Y = require('yjs')
let pass = 0, failed = 0
const T = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ok   ${name}`) } else { failed++; console.log(`  FAIL ${name}${extra ? ` -- ${extra}` : ''}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- the relay's docs: a Map plus getYDoc, with an awareness stub ----------------------------------
const docs = new Map()
const awareness = new Map() // room -> [{user}]
const getDoc = (room) => {
  let d = docs.get(room)
  if (!d) { d = new Y.Doc(); d.awareness = { getStates: () => new Map((awareness.get(room) || []).map((s, i) => [i, s])) }; docs.set(room, d) }
  return d
}
const chatOf = (room) => getDoc(room).getArray('chat').toArray()

// ---- a fake Slack ---------------------------------------------------------------------------------
const BOT = 'xoxb-1111-2222-abcdefabcdefabcdef', SECRET = 'signing-secret-0123456789abcdef'
const posted = [], everPosted = []
let slackDelay = 0
const fakeFetch = async (url, opts) => {
  const method = url.split('/').pop()
  const p = Object.fromEntries(new URLSearchParams(opts.body))
  const auth = opts.headers.authorization
  if (slackDelay) await sleep(slackDelay)
  const reply = (j) => ({ status: 200, json: async () => j })
  if (auth !== `Bearer ${BOT}`) return reply({ ok: false, error: 'invalid_auth' })
  if (method === 'auth.test') return reply({ ok: true, team: 'Demo', user_id: 'UBOT' })
  if (method === 'conversations.info') return reply(p.channel === 'C0NOTIN' ? { ok: true, channel: { name: 'other', is_member: false } } : { ok: true, channel: { name: 'hive-code', is_member: true } })
  if (method === 'users.info') return reply({ ok: true, user: { name: p.user === 'U1' ? 'ganesh' : 'someone' } })
  if (method === 'chat.postMessage') { posted.push(p); everPosted.push(p); return reply({ ok: true, ts: String(Date.now()) }) }
  return reply({ ok: false, error: 'unknown_method' })
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-relay-'))
const logs = []
let relay
let handleImpl
const server = http.createServer((req, res) => handleImpl(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const start = (key = 'test-key-xyz') => { if (relay) relay.stop(); relay = makeSlackRelay({ getDoc, docs, dir, key, fetchImpl: fakeFetch, api: 'https://fake.slack/api', log: (m) => logs.push(m), tickMs: 50 }); handleImpl = (q, s) => relay.handle(q, s) }
const call = async (p, body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const t0 = Date.now()
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })
  const text = await res.text()
  let j = null; try { j = JSON.parse(text) } catch { }
  return { status: res.status, j, ms: Date.now() - t0 }
}
const signed = (payload, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) => {
  const raw = JSON.stringify(payload)
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')
  return { raw, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig } }
}
const msg = (event_id, ev) => ({ type: 'event_callback', event_id, event: { type: 'message', channel: 'C0HIVE', user: 'U1', text: 'hello room', ts: '1.1', ...ev } })
const until = async (f, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(20) } return false }

// Key-shaped strings for the scrub tests, built at run time: written out whole, this file would be
// a file with a key in it, and Hivecode rightly keeps such a file out of the room.
const FAKE_GH = ['ghp', 'Zq8vKz2LmN4pR7sT1wXyQ9bC3dF6gH0jKa7W'].join('_')
const FAKE_SLACK = ['xoxb', '482910374651', '7302948571620', 'Hq8vKz2LmN4pR7sT1wXy'].join('-')
const ROOM = 'room-SlackTestRoom123'
try {
  // S1
  start('')
  const s1 = await call('/slack/prepare', { room: ROOM })
  T('S1 no HIVE_SLACK_KEY: 503 Q660', s1.status === 503 && s1.j && s1.j.code === 'Q660', JSON.stringify(s1))

  // S2
  start()
  const bad = await call('/slack/prepare', { room: 'not a room|x' })
  T('S2a a bad room id is refused', bad.status === 400 && bad.j.code === 'Q661')
  const pr = await call('/slack/prepare', { room: ROOM })
  const id = pr.j && pr.j.id
  T('S2b prepare returns a random id and the events URL', pr.status === 200 && /^[A-Za-z0-9_-]{20,}$/.test(id) && pr.j.eventsUrl.endsWith(`/slack/events/${id}`), JSON.stringify(pr.j))
  T('S2c the events URL does not carry the room id', !pr.j.eventsUrl.includes(ROOM))
  const pr2 = await call('/slack/prepare', { room: ROOM })
  T('S2d preparing the same room again, before connect, gives the same id (the app made from the first manifest still works)', pr2.j && pr2.j.id === id && pr2.j.eventsUrl === pr.j.eventsUrl)
  const prOther = await call('/slack/prepare', { room: 'room-AnotherRoom99' })
  T('S2e another room gets its own id', prOther.j && prOther.j.id && prOther.j.id !== id)

  // S3
  const v = await call(`/slack/events/${id}`, { type: 'url_verification', challenge: 'chal-123' })
  T('S3a url_verification answered before connect', v.status === 200 && v.j && v.j.challenge === 'chal-123')
  const early = await call(`/slack/events/${id}`, msg('Ev0', {}))
  T('S3b an event before connect is not delivered', early.status === 409 && !chatOf(ROOM).some((m) => m.text === 'hello room'))
  const unknown = await call('/slack/events/AAAAAAAAAAAAAAAAAAAAAA', { type: 'url_verification', challenge: 'x' })
  T('S3c an unknown id is 404', unknown.status === 404)

  // S4
  const badTok = await call('/slack/connect', { id, botToken: 'xoxb-wrong-token-000', signingSecret: SECRET, channel: 'C0HIVE' })
  T('S4a a token Slack refuses is Q662', badTok.status === 400 && badTok.j.code === 'Q662' && /invalid_auth/.test(badTok.j.why))
  const notIn = await call('/slack/connect', { id, botToken: BOT, signingSecret: SECRET, channel: 'C0NOTIN' })
  T('S4b a channel the bot is not in is Q664', notIn.status === 400 && notIn.j.code === 'Q664' && /invite/.test(notIn.j.why))
  awareness.set(ROOM, [{ user: { name: 'Opus-Cloud', kind: 'ai' } }, { user: { name: 'Claude-cloud', kind: 'ai' } }, { user: { name: 'Ganesh', kind: 'human' } }])
  getDoc(ROOM).getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:00:00', text: 'old line from before connect' }])
  const con = await call('/slack/connect', { id, botToken: BOT, signingSecret: SECRET, channel: 'C0HIVE' })
  T('S4c connect succeeds', con.status === 200 && con.j.ok && con.j.channel === 'hive-code' && con.j.team === 'Demo', JSON.stringify(con.j))
  await relay.idle()
  T('S4d "Slack is connected" said in the room', chatOf(ROOM).some((m) => /Slack is connected to this room \(#hive-code\)/.test(m.text)))
  T('S4e ...and posted once in the channel', posted.filter((p) => /Slack is connected/.test(p.text)).length === 1 && posted.every((p) => p.channel === 'C0HIVE'), JSON.stringify(posted))
  T('S4f the room history before connect is not sent to Slack', !posted.some((p) => /old line/.test(p.text)))

  // S5
  const store = fs.readFileSync(path.join(dir, 'slack-relay.json'), 'utf8')
  T('S5a the store holds no token or secret in clear', !store.includes(BOT) && !store.includes(SECRET) && store.includes('"sealed"'))
  const roomText = JSON.stringify(getDoc(ROOM).toJSON())
  T('S5b the room never holds the token or secret', !roomText.includes(BOT) && !roomText.includes(SECRET))
  T('S5c nothing logged holds them', !logs.join('\n').includes(BOT) && !logs.join('\n').includes(SECRET))

  // S6
  const e1 = signed(msg('Ev1', { text: 'hello room' }))
  const r1 = await call(`/slack/events/${id}`, e1.raw, e1.headers)
  T('S6a a signed event is accepted', r1.status === 200)
  T('S6b ...and lands in the room as slack:<handle>', await until(() => chatOf(ROOM).some((m) => m.by === 'slack:ganesh' && m.text === 'hello room' && m.src === 'slack' && /^\d\d:\d\d:\d\d$/.test(m.at))))
  const forged = signed(msg('Ev2', { text: 'forged' }), { secret: 'not-the-secret' })
  const r2 = await call(`/slack/events/${id}`, forged.raw, forged.headers)
  const stale = signed(msg('Ev3', { text: 'stale' }), { ts: Math.floor(Date.now() / 1000) - 600 })
  const r3 = await call(`/slack/events/${id}`, stale.raw, stale.headers)
  const r3b = await call(`/slack/events/${id}`, msg('Ev3b', { text: 'unsigned' }))
  await sleep(100)
  T('S6c a wrong, stale or missing signature is 401 Q663 and not delivered', [r2, r3, r3b].every((r) => r.status === 401 && r.j.code === 'Q663') && !chatOf(ROOM).some((m) => /forged|stale|unsigned/.test(m.text)))
  T('S6d verifySlackSignature itself refuses a changed body', !verifySlackSignature({ signingSecret: SECRET, timestamp: e1.headers['x-slack-request-timestamp'], signature: e1.headers['x-slack-signature'], rawBody: e1.raw + ' ' }))

  // S7
  slackDelay = 1500 // users.info is slow; the HTTP answer must not wait for it
  const e4 = signed(msg('Ev4', { user: 'U2', text: 'slow lookup' }))
  const r4 = await call(`/slack/events/${id}`, e4.raw, e4.headers)
  T('S7a answered before the room write', r4.status === 200 && r4.ms < 500 && !chatOf(ROOM).some((m) => m.text === 'slow lookup'), `${r4.ms} ms`)
  T('S7b ...which follows', await until(() => chatOf(ROOM).some((m) => m.text === 'slow lookup' && m.by === 'slack:someone'), 4000))
  slackDelay = 0

  // S8
  const before = chatOf(ROOM).length
  const again = signed(msg('Ev1', { text: 'hello room' }))
  await call(`/slack/events/${id}`, again.raw, { ...again.headers, 'x-slack-retry-num': '1' })
  const botOwn = signed(msg('Ev5', { user: 'UBOT', text: 'from the bot' }))
  await call(`/slack/events/${id}`, botOwn.raw, botOwn.headers)
  const botId = signed(msg('Ev6', { bot_id: 'B1', text: 'bot_id message' }))
  await call(`/slack/events/${id}`, botId.raw, botId.headers)
  const edit = signed(msg('Ev7', { subtype: 'message_changed', text: 'an edit' }))
  await call(`/slack/events/${id}`, edit.raw, edit.headers)
  const other = signed(msg('Ev8', { channel: 'C0OTHER', text: 'other channel' }))
  await call(`/slack/events/${id}`, other.raw, other.headers)
  const bcast = signed(msg('Ev9', { subtype: 'thread_broadcast', text: 'also to channel' }))
  await call(`/slack/events/${id}`, bcast.raw, bcast.headers)
  await until(() => chatOf(ROOM).some((m) => m.text === 'also to channel'))
  const added = chatOf(ROOM).slice(before).map((m) => m.text)
  T('S8 retries, the bot, edits and other channels are dropped; a broadcast reply is kept', added.length === 1 && added[0] === 'also to channel', JSON.stringify(added))

  // S9
  await relay.idle()
  posted.length = 0
  getDoc(ROOM).getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:01:00', text: `PR is open; the room is wss://relay|${ROOM}, another is room-OtherRoom777 (wss://x.example|room-ThirdRoom888) ${FAKE_GH} and the key ${FAKE_SLACK}` }])
  await until(() => posted.length > 0); await relay.idle()
  T('S9a a room line is posted to Slack', posted.length === 1 && /^\*Opus-Cloud\*: PR is open/.test(posted[0].text), JSON.stringify(posted))
  T('S9b ...with every room link, room id and key removed', posted[0] && !/room-[A-Za-z]/.test(posted[0].text) && !/wss?:\/\//.test(posted[0].text) && !posted[0].text.includes("Hq8vKz2LmN4pR7sT1wXy") && !posted[0].text.includes('Zq8vKz2LmN4pR7sT') && posted[0].text.includes('[room link removed]'), posted[0] && posted[0].text)
  T('S9c Slack-sourced lines were never echoed back', everPosted.length > 0 && !everPosted.some((p) => /hello room|also to channel|slow lookup/.test(p.text)))

  // S10
  // Everyone left: y-websocket destroys the doc, and the next join loads it back from the snapshot.
  const old = docs.get(ROOM)
  docs.delete(ROOM)
  await sleep(150)
  const keep = new Y.Doc()
  Y.applyUpdate(keep, Y.encodeStateAsUpdate(old)) // what the persistence layer does on reload
  keep.awareness = old.awareness
  posted.length = 0
  docs.set(ROOM, keep)
  await sleep(150); await relay.idle()
  T('S10a reopening does not resend lines already sent (the frontier lives in the doc)', posted.length === 0, JSON.stringify(posted))
  keep.getArray('chat').push([{ by: 'Claude-cloud', kind: 'ai', at: '10:02:00', text: 'after reopen' }])
  await until(() => posted.some((p) => /after reopen/.test(p.text))); await relay.idle()
  T('S10b the reopened doc is watched again', posted.length === 1 && /after reopen/.test(posted[0].text), JSON.stringify(posted))

  // S11
  const stop = signed(msg('Ev10', { text: 'stop' }))
  await call(`/slack/events/${id}`, stop.raw, stop.headers)
  await until(() => getDoc(ROOM).getMap('controls').get('Opus-Cloud'))
  const ctl = getDoc(ROOM).getMap('controls')
  T('S11a "stop" pauses every AI in the room', ctl.get('Opus-Cloud') && ctl.get('Opus-Cloud').state === 'paused' && ctl.get('Claude-cloud').state === 'paused' && !ctl.get('Ganesh'))
  T('S11b ...and says so in the room', chatOf(ROOM).some((m) => /slack:ganesh ⏸ paused Opus-Cloud, Claude-cloud/.test(m.text)))
  const res1 = signed(msg('Ev11', { text: 'resume claude-cloud' }))
  await call(`/slack/events/${id}`, res1.raw, res1.headers)
  await until(() => ctl.get('Claude-cloud').state === 'running')
  T('S11c "resume <name>" resumes that one agent', ctl.get('Claude-cloud').state === 'running' && ctl.get('Opus-Cloud').state === 'paused')
  T('S11d controlIntent leaves ordinary sentences alone', controlIntent('stop doing that please') === null && controlIntent('hello') === null && controlIntent('stop all').state === 'paused')

  // S13 (before disconnect): a restart reads the store back
  start()
  posted.length = 0
  const keep2 = docs.get(ROOM)
  keep2.getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:03:00', text: 'after restart' }])
  await until(() => posted.some((p) => /after restart/.test(p.text))); await relay.idle()
  T('S13a after a restart the room still reaches Slack', posted.some((p) => /after restart/.test(p.text)))
  T('S13b ...and lines sent before the restart are not sent again', !posted.some((p) => /after reopen|PR is open/.test(p.text)), JSON.stringify(posted))
  const e12 = signed(msg('Ev12', { text: 'after restart from slack' }))
  await call(`/slack/events/${id}`, e12.raw, e12.headers)
  T('S13c ...and Slack still reaches the room', await until(() => chatOf(ROOM).some((m) => m.text === 'after restart from slack')))

  // S12
  const longChal = await call(`/slack/events/${(await call('/slack/prepare', { room: 'room-other' })).j.id}`, { type: 'url_verification', challenge: 'x'.repeat(300) })
  T('S12f before connect, an over-long challenge is not echoed', longChal.status === 409)
  const byRoomBad = await call('/slack/disconnect', { room: ROOM, signingSecret: 'wrong' })
  const byRoomNone = await call('/slack/disconnect', { room: 'room-nothing-here', signingSecret: SECRET })
  T('S12g disconnect by room: wrong secret 401, unknown room 404', byRoomBad.status === 401 && byRoomBad.j.code === 'Q663' && byRoomNone.status === 404 && byRoomNone.j.code === 'Q661')
  const dBad = await call('/slack/disconnect', { id, signingSecret: 'wrong' })
  T('S12a disconnect with the wrong secret is 401 Q663', dBad.status === 401 && dBad.j.code === 'Q663')
  const dOk = await call('/slack/disconnect', { room: ROOM, signingSecret: SECRET }) // the CLI on another computer
  T('S12b disconnect with the secret works', dOk.status === 200 && dOk.j.ok)
  T('S12c ...and is said in the room', chatOf(ROOM).some((m) => /was disconnected from this room/.test(m.text)))
  posted.length = 0
  docs.get(ROOM).getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:04:00', text: 'after disconnect' }])
  const e13 = signed(msg('Ev13', { text: 'after disconnect from slack' }))
  const r13 = await call(`/slack/events/${id}`, e13.raw, e13.headers)
  await sleep(200); await relay.idle()
  T('S12d after disconnect nothing flows either way', posted.length === 0 && r13.status === 404 && !chatOf(ROOM).some((m) => m.text === 'after disconnect from slack'))
  T('S12e the store forgets the connection', !fs.readFileSync(path.join(dir, 'slack-relay.json'), 'utf8').includes(id))

  // S14: the relay's key changed (or the store is damaged). Before the fix the next chat line threw
  // inside the chat observer, an unhandled rejection that killed the relay for every room.
  let unhandled = null
  process.on('unhandledRejection', (e) => { unhandled = e })
  const RROOM = 'room-RotateRoom1'
  const rp = await call('/slack/prepare', { room: RROOM })
  const rc = await call('/slack/connect', { id: rp.j.id, botToken: BOT, signingSecret: SECRET, channel: 'C0HIVE' })
  T('S14a a second room connects', rc.status === 200 && rc.j.ok)
  start('a-different-key')                      // restart with another HIVE_SLACK_KEY
  posted.length = 0
  docs.get(RROOM).getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:05:00', text: 'line after the key changed' }])
  await sleep(300); await relay.idle()
  docs.get(RROOM).getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:05:01', text: 'and another' }])
  await sleep(200); await relay.idle()
  T('S14b a chat line after the key changed does not crash the relay', unhandled === null, unhandled && unhandled.message)
  T('S14c ...nothing is sent with secrets it cannot read', posted.length === 0)
  T('S14d ...and the room is told once to run slack connect again', chatOf(RROOM).filter((m) => /can no longer read its stored token/.test(m.text)).length === 1)
  const re1 = signed(msg('Ev20', { text: 'after rotation' }))
  const rr1 = await call(`/slack/events/${rp.j.id}`, re1.raw, re1.headers)
  T('S14e a Slack event for it is refused (401), not a 500', rr1.status === 401 && rr1.j.code === 'Q663')
  const rd = await call('/slack/disconnect', { room: RROOM, signingSecret: 'anything' })
  T('S14f the dead connection can be removed', rd.status === 200 && rd.j.ok && !fs.readFileSync(path.join(dir, 'slack-relay.json'), 'utf8').includes(rp.j.id))
  const rp2 = await call('/slack/prepare', { room: RROOM })
  const rc2 = await call('/slack/connect', { id: rp2.j.id, botToken: BOT, signingSecret: SECRET, channel: 'C0HIVE' })
  posted.length = 0
  docs.get(RROOM).getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:06:00', text: 'connected again' }])
  await until(() => posted.some((p) => /connected again/.test(p.text))); await relay.idle()
  T('S14g slack connect again works under the new key', rc2.status === 200 && posted.some((p) => /connected again/.test(p.text)))
} catch (e) {
  failed++; console.log('  FAIL threw:', e && e.stack)
} finally {
  if (relay) relay.stop()
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log(`\n=== ${pass} passed, ${failed} failed ===`)
process.exit(failed ? 1 : 0)
