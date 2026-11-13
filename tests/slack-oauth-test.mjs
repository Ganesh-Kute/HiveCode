// One-click Slack (relay side), from the contract Opus-Cloud posted in the room: a shared Slack app, installed
// by each workspace through Slack OAuth. Real Yjs docs, a real HTTP server around relay.handle, a fake Slack
// (authorize page is only checked as a redirect; oauth.v2.access and the Web API are faked). No bridge process.
//   O1  one-click is off unless the key and all three app settings are set: no installUrl, install page Q669
//   O2  prepare gives an installUrl on this relay, never carrying the room id
//   O3  GET /slack/install/<id> redirects to Slack's authorize page with the right query, no secret in it
//   O4  full install into a public channel: the bot joins, both sides are told once, status says connected
//   O5  no token, client secret, app secret or webhook url is in a page, the log, the room or the store
//   O6  a state used once changes nothing the second time; unknown and expired states change nothing
//   O7  a private channel finishes after the invite: waiting, then member_joined_channel from the bot
//   O8  a direct message is refused (Q671) and stores nothing; the same link can be used again
//   O9  a channel already connected to another room is refused (Q670), the first room is untouched
//   O10 the user cancels, or Slack refuses the code: Q672, nothing stored
//   O11 events: url_verification, signature, routing by workspace + channel, unknown channel dropped (200)
//   O12 two workspaces on one relay never see each other, even with the same channel id
//   O13 the bot removed from the channel turns that connection off, said once; the channel can be connected again
//   O14 app_uninstalled and tokens_revoked turn off every connection of that workspace only
//   O15 a send Slack refuses for a dead token or channel removes the connection, said once
//   O16 manifest connections keep working next to one-click ones; a restart keeps both
//   O17 status of an unknown id is 404 Q661
//
// The relay's options are named here once (ONE_CLICK); if the relay names them differently, change that object.
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { makeSlackRelay } from '../hive-slack-relay.js'

const require = createRequire(import.meta.url)
const Y = require('yjs')
let pass = 0, failed = 0
const T = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ok   ${name}`) } else { failed++; console.log(`  FAIL ${name}${extra ? ` -- ${String(extra).slice(0, 400)}` : ''}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await f()) return true } catch { } await sleep(20) } return false }

// ---- the relay's docs ---------------------------------------------------------------------------
const docs = new Map()
const presence = new Map()      // room -> [{name, kind}], what the room's awareness says
const getDoc = (room) => {
  let d = docs.get(room)
  if (!d) { d = new Y.Doc(); d.awareness = { getStates: () => new Map((presence.get(room) || []).map((u, i) => [i, { user: u }])) }; docs.set(room, d) }
  return d
}
const chatOf = (room) => getDoc(room).getArray('chat').toArray()
const said = (room, re) => chatOf(room).filter((m) => re.test(String(m.text || ''))).length

// ---- a fake Slack ---------------------------------------------------------------------------------
const CLIENT_ID = '1234567890.0987654321', CLIENT_SECRET = 'client-secret-aaaaaaaaaaaaaaaaaaaa', APP_SECRET = 'app-signing-secret-bbbbbbbbbbbb'
const WEBHOOK = 'https://hooks.slack.com/services/T0AAA/B0BBB/webhooksecretpartzzzzzzzz'
const AUTHORIZE = 'https://fake.slack/oauth/v2/authorize'
const WORKSPACES = {
  T1: { name: 'Alpha', token: 'xoxb-1111-aaaa-aaaaaaaaaaaaaaaaaaaaaaaa', bot: 'UBOT1' },
  T2: { name: 'Beta', token: 'xoxb-2222-bbbb-bbbbbbbbbbbbbbbbbbbbbbbb', bot: 'UBOT2' },
}
const slackChannels = new Map()   // `${team}:${channel}` -> { name, priv, members:Set }
const grants = new Map()          // oauth code -> { team, channel }
const apiCalls = []               // { method, team, p }
const posts = []                  // { team, channel, text }
const addChannel = (team, id, name, { priv = false, bot = true } = {}) => slackChannels.set(`${team}:${id}`, { name, priv, members: new Set(bot ? [WORKSPACES[team].bot] : []) })
const teamOfToken = (t) => Object.keys(WORKSPACES).find((k) => WORKSPACES[k].token === t && !WORKSPACES[k].revoked) || ''
const fakeFetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop()
  const ct = String((opts.headers && (opts.headers['content-type'] || opts.headers['Content-Type'])) || '')
  const p = /json/.test(ct) ? JSON.parse(opts.body || '{}') : Object.fromEntries(new URLSearchParams(opts.body || ''))
  const authz = String((opts.headers && (opts.headers.authorization || opts.headers.Authorization)) || '').replace(/^Bearer /, '')
  const team = teamOfToken(authz)
  apiCalls.push({ method, team, p })
  const reply = (j) => ({ status: 200, json: async () => j, text: async () => JSON.stringify(j) })
  if (method === 'oauth.v2.access') {
    const g = grants.get(p.code)
    if (p.client_id !== CLIENT_ID || p.client_secret !== CLIENT_SECRET) return reply({ ok: false, error: 'invalid_client_id' })
    if (!g) return reply({ ok: false, error: 'invalid_code' })
    grants.delete(p.code)
    const ws = WORKSPACES[g.team], ch = slackChannels.get(`${g.team}:${g.channel}`)
    return reply({ ok: true, access_token: ws.token, bot_user_id: ws.bot, team: { id: g.team, name: ws.name }, incoming_webhook: { channel_id: g.channel, channel: ch ? ch.name : 'dm', url: WEBHOOK } })
  }
  if (!team) return reply({ ok: false, error: WORKSPACES.T1.revoked || WORKSPACES.T2.revoked ? 'token_revoked' : 'invalid_auth' })
  const ch = slackChannels.get(`${team}:${p.channel}`)
  if (method === 'auth.test') return reply({ ok: true, team: WORKSPACES[team].name, team_id: team, user_id: WORKSPACES[team].bot })
  if (method === 'users.info') return reply({ ok: true, user: { name: p.user === 'U1' ? 'ganesh' : 'someone' } })
  if (method === 'conversations.info') {
    if (!ch || (ch.priv && !ch.members.has(WORKSPACES[team].bot))) return reply({ ok: false, error: 'channel_not_found' })
    return reply({ ok: true, channel: { name: ch.name, is_member: ch.members.has(WORKSPACES[team].bot), is_private: ch.priv } })
  }
  if (method === 'conversations.join') {
    if (!ch || ch.priv) return reply({ ok: false, error: 'method_not_supported_for_channel_type' })
    ch.members.add(WORKSPACES[team].bot)
    return reply({ ok: true, channel: { name: ch.name } })
  }
  if (method === 'chat.postMessage') {
    if (!ch) return reply({ ok: false, error: 'channel_not_found' })
    if (!ch.members.has(WORKSPACES[team].bot)) return reply({ ok: false, error: 'not_in_channel' })
    posts.push({ team, channel: p.channel, text: p.text })
    return reply({ ok: true, ts: String(Date.now()) })
  }
  return reply({ ok: false, error: 'unknown_method' })
}

// ---- the relay, behind a real HTTP server ---------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-oauth-'))
const logs = []
let clock = Date.now()
let relay, handleImpl
const server = http.createServer((req, res) => handleImpl(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const ONE_CLICK = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, appSecret: APP_SECRET, authorizeUrl: AUTHORIZE }
const start = (opts = {}, key = 'test-key-xyz') => {
  if (relay) relay.stop()
  relay = makeSlackRelay({ getDoc, docs, dir, key, fetchImpl: fakeFetch, api: 'https://fake.slack/api', publicUrl: base, now: () => clock, log: (m) => logs.push(m), tickMs: 50, ...ONE_CLICK, ...opts })
  handleImpl = (q, s) => relay.handle(q, s)
}
const post = async (p, body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })
  const text = await res.text(); let j = null; try { j = JSON.parse(text) } catch { }
  return { status: res.status, j, text }
}
const get = async (p, opts = {}) => { const res = await fetch(base + p, { redirect: 'manual', ...opts }); const text = await res.text(); return { status: res.status, text, location: res.headers.get('location') || '' } }
const signed = (payload, secret = APP_SECRET, ts = Math.floor(clock / 1000)) => {
  const raw = JSON.stringify(payload)
  return { raw, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex') } }
}
const event = (team, ev, id = `Ev${Math.random().toString(36).slice(2, 10)}`) => ({ type: 'event_callback', event_id: id, team_id: team, event: ev })
const sendEvent = async (payload, secret) => { const s = signed(payload, secret); return post('/slack/events', s.raw, s.headers) }
const message = (team, channel, text, user = 'U1') => event(team, { type: 'message', channel, user, text, ts: `${Date.now()}.${Math.floor(Math.random() * 1e5)}` })
// prepare a room, get its id and install URL
const prepare = async (room) => { const r = await post('/slack/prepare', { room }); return { id: r.j && r.j.id, installUrl: r.j && r.j.installUrl, r } }
// what Slack does after the user approves: redirect to the callback with a code and the state
const approve = async (id, team, channel, code = `code-${Math.random().toString(36).slice(2, 10)}`) => { grants.set(code, { team, channel }); return get(`/slack/oauth/callback?code=${code}&state=${id}`) }
const everything = () => [logs.join('\n'), JSON.stringify([...docs.values()].map((d) => d.toJSON())), fs.existsSync(path.join(dir, 'slack-relay.json')) ? fs.readFileSync(path.join(dir, 'slack-relay.json'), 'utf8') : ''].join('\n')
const count = (m) => apiCalls.filter((c) => c.method === m).length
const status = async (id) => (await post('/slack/status', { id }))

const R1 = 'room-OneClickRoomAAA', R2 = 'room-OneClickRoomBBB', R3 = 'room-OneClickRoomCCC', R4 = 'room-OneClickRoomDDD'
try {
  addChannel('T1', 'C0PUB', 'general', { bot: false })   // public, the bot is not in it yet: the relay must join it itself
  addChannel('T1', 'C0FRESH', 'fresh')
  addChannel('T1', 'G0PRIV', 'secret', { priv: true, bot: false })
  addChannel('T1', 'C0OTHER', 'random')
  addChannel('T2', 'C0PUB', 'general')       // the same channel id in another workspace
  addChannel('T2', 'C0TWO', 'ops', { bot: false })

  // O1 -----------------------------------------------------------------------------------------------
  for (const [what, opts] of [['no client id', { clientId: '' }], ['no client secret', { clientSecret: '' }], ['no app signing secret', { appSecret: '' }]]) {
    start(opts)
    const p = await prepare(R1)
    T(`O1 ${what}: prepare still works, with no installUrl`, p.r.status === 200 && p.id && !p.installUrl, JSON.stringify(p.r.j))
    const page = await get(`/slack/install/${p.id}`)
    T(`O1 ${what}: the install page says Q669`, page.status === 503 && /Q669/.test(page.text), `${page.status} ${page.text.slice(0, 120)}`)
  }
  start({}, '')
  T('O1 no HIVE_SLACK_KEY at all: every route is Q660', (await post('/slack/prepare', { room: R1 })).status === 503)
  // a fresh relay and store for the rest
  fs.rmSync(path.join(dir, 'slack-relay.json'), { force: true })
  start()

  // O2 / O3 ------------------------------------------------------------------------------------------
  const a = await prepare(R1)
  T('O2 prepare gives an installUrl <origin>/slack/install/<id>, and still the events url', a.r.status === 200 && a.installUrl === `${base}/slack/install/${a.id}` && /\/slack\/events\//.test(a.r.j.eventsUrl), JSON.stringify(a.r.j))
  T('O2 neither carries the room id', !JSON.stringify(a.r.j).includes(R1))
  const redirect = await get(`/slack/install/${a.id}`)
  const loc = redirect.location ? new URL(redirect.location) : null
  T('O3 the install page redirects to the authorize page', redirect.status === 302 && loc && `${loc.origin}${loc.pathname}` === AUTHORIZE, `${redirect.status} ${redirect.location}`)
  const scopes = loc ? (loc.searchParams.get('scope') || '').split(',') : []
  T('O3 client_id, redirect_uri and state (the id) are in it', loc && loc.searchParams.get('client_id') === CLIENT_ID && loc.searchParams.get('redirect_uri') === `${base}/slack/oauth/callback` && loc.searchParams.get('state') === a.id)
  T('O3 the bot scopes include chat:write, history, users:read, channels:join and incoming-webhook', ['chat:write', 'channels:history', 'groups:history', 'users:read', 'channels:join', 'incoming-webhook'].every((s) => scopes.includes(s)), scopes.join(','))
  T('O3 no secret and no room id in that URL', loc && ![CLIENT_SECRET, APP_SECRET, R1].some((x) => redirect.location.includes(x)))
  T('O3 an unknown install id is a 404 page (Q661), no redirect', (await get('/slack/install/AAAAAAAAAAAAAAAAAAAAAA')).status === 404)

  // O4 full install to a public channel --------------------------------------------------------------
  presence.set(R1, [{ name: 'Opus-Cloud', kind: 'ai' }, { name: 'Ganesh', kind: 'human' }])
  const cb = await approve(a.id, 'T1', 'C0PUB')
  T('O4 the callback answers a page: Slack is connected to #general', cb.status === 200 && /connected to #general/i.test(cb.text), `${cb.status} ${cb.text.slice(0, 200)}`)
  T('O4 the bot joined the public channel itself, once', count('conversations.join') === 1 && slackChannels.get('T1:C0PUB').members.has('UBOT1'))
  await relay.idle()
  T('O4 "Slack is connected to this room (#general)." said once in the room', said(R1, /Slack is connected to this room \(#general\)/) === 1)
  T('O4 ...and once in the channel, with the workspace token', posts.filter((x) => /Slack is connected/.test(x.text) && x.team === 'T1' && x.channel === 'C0PUB').length === 1, JSON.stringify(posts))
  const st = await status(a.id)
  T('O4 /slack/status {id}: connected, channel name, no secrets', st.status === 200 && st.j.ok && st.j.connected === true && st.j.channel === 'general' && !JSON.stringify(st.j).includes('xoxb'), JSON.stringify(st.j))

  const chanLine = (posts.find((x) => /Slack is connected/.test(x.text) && x.channel === 'C0PUB' && x.team === 'T1') || {}).text || ''
  T('O4 the line posted in the CHANNEL names who is in the room and how to disconnect (so channel members can see what they were bridged to)', /In the room now: .*Opus-Cloud/.test(chanLine) && /Ganesh/.test(chanLine) && /remove this bot/i.test(chanLine), chanLine)
  T('O4 the room-side line stays short: no member list in the room', !chatOf(R1).some((m) => /In the room now/.test(m.text || '')))

  // O5 -----------------------------------------------------------------------------------------------
  const all = everything() + cb.text + redirect.text + JSON.stringify(st.j)
  T('O5 no bot token, client secret, app secret or webhook url anywhere: pages, log, room, store', ![WORKSPACES.T1.token, CLIENT_SECRET, APP_SECRET, WEBHOOK, 'webhooksecretpart'].some((x) => all.includes(x)))
  T('O5 the store is sealed and holds no room id in a URL, page or Slack call', fs.readFileSync(path.join(dir, 'slack-relay.json'), 'utf8').includes('"sealed"') && !apiCalls.some((c) => JSON.stringify(c.p).includes(R1)) && !posts.some((x) => x.text.includes(R1)))
  T('O5 the client secret only went to oauth.v2.access', apiCalls.filter((c) => JSON.stringify(c.p).includes(CLIENT_SECRET)).every((c) => c.method === 'oauth.v2.access'))

  // O6 -----------------------------------------------------------------------------------------------
  const oauthBefore = count('oauth.v2.access'), linesBefore = chatOf(R1).length, postsBefore = posts.length
  const again = await approve(a.id, 'T1', 'C0PUB')
  await relay.idle()
  T('O6 the same state a second time changes nothing (no second token exchange, room line or post)', again.status < 500 && count('oauth.v2.access') === oauthBefore && chatOf(R1).length === linesBefore && posts.length === postsBefore, `${again.status} ${count('oauth.v2.access') - oauthBefore}`)
  const unk = await approve('AAAAAAAAAAAAAAAAAAAAAA', 'T1', 'C0PUB')
  T('O6 an unknown state is refused and Slack is never asked for a token', unk.status === 404 && count('oauth.v2.access') === oauthBefore, `${unk.status}`)
  const e1 = await prepare(R4)
  clock += 25 * 3600 * 1000
  const exp = await approve(e1.id, 'T1', 'C0OTHER')
  T('O6 an expired state is refused and changes nothing', exp.status >= 400 && exp.status < 500 && count('oauth.v2.access') === oauthBefore && !(await status(e1.id)).j?.connected, `${exp.status}`)

  // O7 private channel after the invite --------------------------------------------------------------
  const b = await prepare(R2)
  const wait = await approve(b.id, 'T1', 'G0PRIV')
  T('O7 a private channel the bot is not in: 200 page that says to type /invite @Hivecode there', wait.status === 200 && /\/invite @Hivecode/.test(wait.text), `${wait.status} ${wait.text.slice(0, 200)}`)
  await relay.idle()
  const sw = await status(b.id)
  T('O7 status is not connected and says pending: invite', sw.j && sw.j.connected === false && sw.j.pending === 'invite', JSON.stringify(sw.j))
  T('O7 nothing is said in the room yet', said(R2, /Slack is connected/) === 0)
  slackChannels.get('T1:G0PRIV').members.add('UBOT1')
  const joined = await sendEvent(event('T1', { type: 'member_joined_channel', channel: 'G0PRIV', user: 'UBOT1' }))
  T('O7 the bot joining the channel is answered 200', joined.status === 200)
  T('O7 ...and finishes the connection: room told once, status connected', await until(async () => said(R2, /Slack is connected to this room \(#secret\)/) === 1 && (await status(b.id)).j.connected === true))
  await sendEvent(event('T1', { type: 'member_joined_channel', channel: 'G0PRIV', user: 'UBOT1' }))
  await relay.idle()
  T('O7 a second join event does not say it again', said(R2, /Slack is connected/) === 1)
  addChannel('T1', 'G0PRIV2', 'secret2', { priv: true, bot: false })
  const waiting = await prepare(R3)
  await approve(waiting.id, 'T1', 'G0PRIV2')
  await sendEvent(event('T1', { type: 'member_joined_channel', channel: 'G0PRIV2', user: 'UPERSON' }))
  await relay.idle()
  T('O7 a person (not the bot) joining the channel does not finish anything', (await status(waiting.id)).j.connected === false && said(R3, /Slack is connected/) === 0)

  // O7b modern private channels have C... ids: conversations.info says channel_not_found until the bot is in
  addChannel('T1', 'C0PRIVC', 'secretc', { priv: true, bot: false })
  const pc = await prepare('room-OneClickRoomPC1')
  const pcw = await approve(pc.id, 'T1', 'C0PRIVC')
  T('O7b a private channel with a C... id the bot is not in waits for the invite, never joins it', pcw.status === 200 && /\/invite @Hivecode/.test(pcw.text) && (await status(pc.id)).j.pending === 'invite' && !slackChannels.get('T1:C0PRIVC').members.has('UBOT1'), `${pcw.status} ${pcw.text.slice(0, 160)}`)
  slackChannels.get('T1:C0PRIVC').members.add('UBOT1')
  await sendEvent(event('T1', { type: 'member_joined_channel', channel: 'C0PRIVC', user: 'UBOT1' }))
  T('O7b ...and the invite finishes it', await until(async () => (await status(pc.id)).j.connected === true))

  // O8 direct message --------------------------------------------------------------------------------
  const d = await prepare('room-OneClickRoomDM1')
  slackChannels.set('T1:D0DM', { name: 'dm', priv: true, members: new Set(['UBOT1']) })
  const dm = await approve(d.id, 'T1', 'D0DM')
  T('O8 a direct message is refused with Q671 (4xx page), stores nothing', dm.status >= 400 && dm.status < 500 && /Q671/.test(dm.text) && (await status(d.id)).j.connected === false, `${dm.status} ${dm.text.slice(0, 160)}`)
  const retry = await approve(d.id, 'T1', 'C0OTHER')
  T('O8 the same link works again afterwards, with a real channel', retry.status === 200 && /connected to #random/i.test(retry.text), `${retry.status} ${retry.text.slice(0, 160)}`)

  // O9 channel taken ---------------------------------------------------------------------------------
  const t1 = await prepare('room-OneClickRoomTak')
  const taken = await approve(t1.id, 'T1', 'C0PUB')
  T('O9 a channel already connected to another room is refused with Q670', taken.status >= 400 && taken.status < 500 && /Q670/.test(taken.text), `${taken.status} ${taken.text.slice(0, 160)}`)
  await relay.idle()
  T('O9 the first room is untouched: still connected, nothing said in the new one', (await status(a.id)).j.connected === true && said('room-OneClickRoomTak', /Slack is connected/) === 0)

  // O9b two rooms waiting for the invite on the same private channel: when the bot comes in, only one gets it
  addChannel('T1', 'G0TWICE', 'twice', { priv: true, bot: false })
  const tw1 = await prepare('room-OneClickRoomTW1'), tw2 = await prepare('room-OneClickRoomTW2')
  await approve(tw1.id, 'T1', 'G0TWICE'); await approve(tw2.id, 'T1', 'G0TWICE')
  slackChannels.get('T1:G0TWICE').members.add('UBOT1')
  await sendEvent(event('T1', { type: 'member_joined_channel', channel: 'G0TWICE', user: 'UBOT1' }))
  await sleep(150); await relay.idle()
  const twiceConnected = [tw1.id, tw2.id].filter((x) => x).length && (await Promise.all([status(tw1.id), status(tw2.id)])).filter((x) => x.j && x.j.connected).length
  T('O9b the later room is told once that it was not connected (Q670), and its status says why', said('room-OneClickRoomTW2', /was not connected to this room: Q670/) === 1 && (await status(tw2.id)).j.connected === false && /already connected/.test((await status(tw2.id)).j.ended || ''), JSON.stringify([said('room-OneClickRoomTW2', /Q670/), await status(tw2.id)]))
  T('O9b two rooms waiting on the same channel: exactly one is connected when the bot comes in (never both: everything would be said twice, in two rooms)', twiceConnected === 1, `connected: ${twiceConnected}`)

  // O9c two approvals of the same public channel at the same moment: Slack calls are awaited in between,
  // so a check made only before them lets both through
  addChannel('T1', 'C0RACE', 'race', { bot: false })
  const rc1 = await prepare('room-OneClickRoomRC1'), rc2 = await prepare('room-OneClickRoomRC2')
  const both = await Promise.all([approve(rc1.id, 'T1', 'C0RACE'), approve(rc2.id, 'T1', 'C0RACE')])
  await relay.idle()
  const racers = await Promise.all([status(rc1.id), status(rc2.id)])
  T('O9c two approvals of the same public channel at the same moment: exactly one is connected, the other refused (Q670)', racers.filter((x) => x.j.connected).length === 1 && both.filter((x) => x.status === 200).length === 1 && both.some((x) => /Q670/.test(x.text)), JSON.stringify([both.map((x) => x.status), racers.map((x) => x.j)]))

  // O10 cancel / bad code ----------------------------------------------------------------------------
  const c1 = await prepare('room-OneClickRoomCan')
  const cancel = await get(`/slack/oauth/callback?error=access_denied&state=${c1.id}`)
  T('O10 the user cancelling is Q672, 4xx, nothing stored', cancel.status >= 400 && cancel.status < 500 && /Q672/.test(cancel.text) && (await status(c1.id)).j.connected === false, `${cancel.status} ${cancel.text.slice(0, 160)}`)
  const bad = await get(`/slack/oauth/callback?code=not-a-real-code&state=${c1.id}`)
  T('O10 a code Slack refuses is Q672 too, and the state is still usable', bad.status >= 400 && bad.status < 500 && /Q672/.test(bad.text))
  const good = await approve(c1.id, 'T1', 'C0FRESH')
  T('O10 ...so the same link then finishes', good.status === 200)

  // O11 events ---------------------------------------------------------------------------------------
  const vr = await sendEvent({ type: 'url_verification', challenge: 'chal-xyz' })
  T('O11 url_verification on /slack/events is answered when signed with the app secret', vr.status === 200 && (vr.j ? vr.j.challenge === 'chal-xyz' : /chal-xyz/.test(vr.text)), `${vr.status} ${vr.text}`)
  const forged = signed(message('T1', 'C0PUB', 'forged line'), 'wrong-secret'), stale = signed(message('T1', 'C0PUB', 'stale line'), APP_SECRET, Math.floor(clock / 1000) - 3600)
  T('O11 a bad signature and a stale timestamp are 401', (await post('/slack/events', forged.raw, forged.headers)).status === 401 && (await post('/slack/events', stale.raw, stale.headers)).status === 401)
  const ok1 = await sendEvent(message('T1', 'C0PUB', 'hello from alpha'))
  T('O11 a message in a connected channel reaches its room as slack:<handle>, answered 200', ok1.status === 200 && await until(() => chatOf(R1).some((m) => m.text === 'hello from alpha' && /^slack:ganesh$/.test(m.by || m.name || ''))), JSON.stringify(chatOf(R1).slice(-2)))
  const lost = await sendEvent(message('T1', 'C0NOROOM', 'nobody home'))
  T('O11 a channel with no connection is answered 200 and dropped', lost.status === 200 && !JSON.stringify([...docs.values()].map((x) => x.toJSON())).includes('nobody home'))
  const lostTeam = await sendEvent(message('T9', 'C0PUB', 'unknown workspace'))
  T('O11 a workspace with no connection is answered 200 and dropped', lostTeam.status === 200 && !JSON.stringify([...docs.values()].map((x) => x.toJSON())).includes('unknown workspace'))
  T('O11 the app secret does not open a manifest connection url (/slack/events/<id> is checked against that connection)', (await (async () => { const s = signed(message('T1', 'C0PUB', 'sneaky')); return post(`/slack/events/${a.id}`, s.raw, s.headers) })()).status === 401)

  // a one-link connection has no signing secret of its own: a signature made with an empty or guessed key
  // must not open its /slack/events/<id> url
  const emptyKey = (() => { const raw = JSON.stringify(message('T1', 'C0PUB', 'empty key line')), ts = Math.floor(clock / 1000); return { raw, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': 'v0=' + crypto.createHmac('sha256', '').update(`v0:${ts}:${raw}`).digest('hex') } } })()
  const ek = await post(`/slack/events/${a.id}`, emptyKey.raw, emptyKey.headers)
  T('O11 an empty-key signature on a one-link connection\'s own events url is refused', ek.status === 401 && !JSON.stringify([...docs.values()].map((x) => x.toJSON())).includes('empty key line'), `${ek.status}`)

  // O12 two workspaces -------------------------------------------------------------------------------
  const w2 = await prepare('room-OneClickRoomW2')
  const ok2 = await approve(w2.id, 'T2', 'C0PUB')
  T('O12 a second workspace connects its own channel with the same channel id', ok2.status === 200 && /connected to #general/i.test(ok2.text), `${ok2.status} ${ok2.text.slice(0, 120)}`)
  await sendEvent(message('T2', 'C0PUB', 'hello from beta'))
  await sendEvent(message('T1', 'C0PUB', 'second from alpha'))
  await relay.idle()
  T('O12 each message lands in its own workspace\'s room only', await until(() => chatOf('room-OneClickRoomW2').some((m) => m.text === 'hello from beta') && chatOf(R1).some((m) => m.text === 'second from alpha')) && !chatOf(R1).some((m) => m.text === 'hello from beta') && !chatOf('room-OneClickRoomW2').some((m) => m.text === 'second from alpha'))
  getDoc('room-OneClickRoomW2').getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:00:00', text: 'reply for beta' }])
  getDoc(R1).getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:00:01', text: 'reply for alpha' }])
  T('O12 a room line goes out with its own workspace\'s token only', await until(() => posts.some((x) => x.team === 'T2' && /reply for beta/.test(x.text)) && posts.some((x) => x.team === 'T1' && /reply for alpha/.test(x.text))) && !posts.some((x) => x.team === 'T1' && /reply for beta/.test(x.text)) && !posts.some((x) => x.team === 'T2' && /reply for alpha/.test(x.text)))

  // O13 bot removed from the channel -----------------------------------------------------------------
  const before13 = posts.length
  await sendEvent(event('T2', { type: 'member_left_channel', channel: 'C0PUB', user: 'UBOT2' }))
  await relay.idle()
  T('O13 the bot leaving turns that connection off, said once in the room', await until(() => said('room-OneClickRoomW2', /Slack (was )?disconnected|no longer connected|removed/i) === 1), JSON.stringify(chatOf('room-OneClickRoomW2').slice(-2)))
  await sendEvent(message('T2', 'C0PUB', 'after removal'))
  getDoc('room-OneClickRoomW2').getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:00:02', text: 'nobody listens' }])
  await sleep(200); await relay.idle()
  T('O13 afterwards nothing flows either way, and the other workspace is untouched', !chatOf('room-OneClickRoomW2').some((m) => m.text === 'after removal') && !posts.some((x) => /nobody listens/.test(x.text)) && (await status(a.id)).j.connected === true)
  const ended = await status(w2.id)
  T('O13 status of the ended connection is connected:false with a reason in ended (not 404)', ended.status === 200 && ended.j.connected === false && typeof ended.j.ended === 'string' && ended.j.ended.length > 0, JSON.stringify(ended))
  slackChannels.get('T2:C0PUB').members.add('UBOT2')
  const relink = await approve(w2.id, 'T2', 'C0PUB')
  T('O13 the SAME link connects the room again afterwards (no stale claim on the channel)', relink.status === 200 && /connected to #general/i.test(relink.text), `${relink.status} ${relink.text.slice(0, 160)}`)
  for (const ev of ['channel_left', 'group_left']) {
    const x = await prepare(`room-OneClickRoom${ev.slice(0, 4)}`)
    const chId = ev === 'group_left' ? 'G0LEFT' : 'C0LEFT'
    addChannel('T2', chId, ev === 'group_left' ? 'privleft' : 'left', { priv: ev === 'group_left', bot: true })
    await approve(x.id, 'T2', chId)
    await sendEvent(event('T2', { type: ev, channel: chId }))
    T(`O13 ${ev} removes that connection too`, await until(async () => (await status(x.id)).j.connected === false))
  }

  // O14 app uninstalled / tokens revoked -------------------------------------------------------------
  const u1 = await prepare('room-OneClickRoomU1'), u2 = await prepare('room-OneClickRoomU2')
  addChannel('T2', 'C0U1', 'u-one'); addChannel('T2', 'C0U2', 'u-two')
  await approve(u1.id, 'T2', 'C0U1'); await approve(u2.id, 'T2', 'C0U2')
  await relay.idle()
  await sendEvent(event('T2', { type: 'app_uninstalled' }))
  T('O14 app_uninstalled removes every connection of that workspace, each room told once', await until(async () => (await status(u1.id)).j.connected === false && (await status(u2.id)).j.connected === false) && said('room-OneClickRoomU1', /Slack (was )?disconnected|no longer connected|removed|uninstalled/i) === 1 && said('room-OneClickRoomU2', /Slack (was )?disconnected|no longer connected|removed|uninstalled/i) === 1)
  T('O14 the other workspace is untouched', (await status(a.id)).j.connected === true)
  WORKSPACES.T2.revoked = false
  const r1 = await prepare('room-OneClickRoomV1')
  await approve(r1.id, 'T2', 'C0U1')
  await sendEvent(event('T2', { type: 'tokens_revoked', tokens: { bot: [WORKSPACES.T2.bot] } }))
  T('O14 tokens_revoked does the same', await until(async () => (await status(r1.id)).j.connected === false))
  const endedBefore = await status(u1.id)
  const again1 = await prepare('room-OneClickRoomU1')
  const endedAfter = await status(u1.id)
  T('O14 a removed connection says why in ended; running slack connect again (prepare) gives the same id with ended cleared, still not connected (a new attempt, or the CLI would stop at once)', typeof endedBefore.j.ended === 'string' && endedBefore.j.ended && again1.id === u1.id && endedAfter.j.connected === false && !endedAfter.j.ended, JSON.stringify([endedBefore.j, again1.id === u1.id, endedAfter.j]))
  const revokedRoom = `room-OneClickRoomV1`
  T('O14 a removal said again by a repeated event is not repeated in the room', (await sendEvent(event('T2', { type: 'app_uninstalled' })), await relay.idle(), said(revokedRoom, /Slack (was )?disconnected|no longer connected|removed|uninstalled/i) <= 1))

  // O15 a send Slack refuses -------------------------------------------------------------------------
  const k = await prepare('room-OneClickRoomK1')
  addChannel('T1', 'C0KICK', 'kicked')
  await approve(k.id, 'T1', 'C0KICK')
  await relay.idle()
  slackChannels.get('T1:C0KICK').members.delete('UBOT1')     // removed with no event sent to us
  getDoc('room-OneClickRoomK1').getArray('chat').push([{ by: 'Opus-Cloud', kind: 'ai', at: '10:00:03', text: 'do you hear me' }])
  T('O15 chat.postMessage answering not_in_channel removes the connection, said once in the room', await until(async () => (await status(k.id)).j.connected === false) && said('room-OneClickRoomK1', /Slack (was )?disconnected|no longer connected|removed/i) === 1, JSON.stringify(chatOf('room-OneClickRoomK1').slice(-2)))

  // O16 manifest connections and restart -------------------------------------------------------------
  const MAN_BOT = WORKSPACES.T1.token, MAN_SECRET = 'manifest-signing-secret-cccccccc'
  const m = await post('/slack/prepare', { room: 'room-ManifestRoomOne' })
  const mc = await post('/slack/connect', { id: m.j.id, botToken: MAN_BOT, signingSecret: MAN_SECRET, channel: 'C0OTHER' })
  T('O16 a manifest connection (id + token + signing secret) still connects', mc.status === 200 && mc.j.ok, JSON.stringify(mc.j))
  const ms = signed(message('T1', 'C0OTHER', 'manifest hello'), MAN_SECRET)
  const mr = await post(`/slack/events/${m.j.id}`, ms.raw, ms.headers)
  T('O16 ...and its own events url delivers with its own signing secret', mr.status === 200 && await until(() => chatOf('room-ManifestRoomOne').some((x) => x.text === 'manifest hello')))
  start()
  relay.attachAll()
  await sendEvent(message('T1', 'C0PUB', 'after restart'))
  const ms2 = signed(message('T1', 'C0OTHER', 'manifest after restart'), MAN_SECRET)
  await post(`/slack/events/${m.j.id}`, ms2.raw, ms2.headers)
  T('O16 after a relay restart one-click and manifest connections both still deliver', await until(() => chatOf(R1).some((x) => x.text === 'after restart') && chatOf('room-ManifestRoomOne').some((x) => x.text === 'manifest after restart')))

  // O18 what a removal leaves, and who may end or take over a one-link connection ---------------------
  const storeNow = () => JSON.parse(fs.readFileSync(path.join(dir, 'slack-relay.json'), 'utf8')).conns
  const gone = storeNow()[u1.id]
  T('O18 after a removal the stored entry has no sealed token, no channel, no workspace (only the unfinished id and why it ended)', !!gone && !gone.sealed && !gone.channel && !gone.teamId && !gone.botUserId && !gone.channelName && gone.connected === false, JSON.stringify(gone))
  addChannel('T1', 'C0DISC', 'disc')
  const dc = await prepare('room-OneClickRoomDC1')
  await approve(dc.id, 'T1', 'C0DISC')
  await relay.idle()
  const before = JSON.stringify(storeNow()[dc.id])
  const takeover = await post('/slack/connect', { id: dc.id, botToken: WORKSPACES.T1.token, signingSecret: 'my-own-secret', channel: 'C0OTHER' })
  T('O18 /slack/connect on a finished one-link connection is refused (Q663) and changes nothing: a manifest app cannot take it over', takeover.status === 401 && takeover.j && takeover.j.code === 'Q663' && JSON.stringify(storeNow()[dc.id]) === before && (await status(dc.id)).j.channel === 'disc', JSON.stringify(takeover.j))
  const takeover2 = await post('/slack/connect', { id: dc.id, botToken: WORKSPACES.T1.token, signingSecret: '', channel: 'C0OTHER' })
  T('O18 ...and so is an empty signing secret (the one a one-link connection "has"): Q663, unchanged', [400, 401].includes(takeover2.status) && takeover2.j && takeover2.j.code === 'Q663' && JSON.stringify(storeNow()[dc.id]) === before, JSON.stringify(takeover2.j))
  const noSecret = await post('/slack/disconnect', { room: 'room-OneClickRoomDC1', signingSecret: '' })
  const madeUp = await post('/slack/disconnect', { room: 'room-OneClickRoomDC1', signingSecret: 'a-made-up-secret' })
  T('O18 /slack/disconnect with the room alone (empty or made-up secret) is refused (Q663): everyone in the room knows the room id', noSecret.status === 401 && noSecret.j.code === 'Q663' && madeUp.status === 401 && madeUp.j.code === 'Q663' && (await status(dc.id)).j.connected === true, JSON.stringify([noSecret.j, madeUp.j]))
  const byId = await post('/slack/disconnect', { id: dc.id })
  await relay.idle()
  T('O18 /slack/disconnect with the id alone ends it, the room told once', byId.status === 200 && byId.j.ok && said('room-OneClickRoomDC1', /was disconnected from this room/) === 1 && (await status(dc.id)).j.connected !== true, JSON.stringify(byId.j))

  // O17 ----------------------------------------------------------------------------------------------
  const unknownStatus = await post('/slack/status', { id: 'AAAAAAAAAAAAAAAAAAAAAA' })
  T('O17 status of an unknown id is 404 Q661', unknownStatus.status === 404 && unknownStatus.j && unknownStatus.j.code === 'Q661', JSON.stringify(unknownStatus.j))
  T('O17 nothing ever logged holds a secret', ![WORKSPACES.T1.token, WORKSPACES.T2.token, CLIENT_SECRET, APP_SECRET, WEBHOOK].some((x) => logs.join('\n').includes(x)))
} catch (e) {
  T(`the test ran to the end (${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e})`, false)
} finally {
  if (relay) try { relay.stop() } catch { }
  server.close()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
  console.log(`\n=== SLACK ONE-CLICK (relay): ${pass} passed, ${failed} failed ===`)
  process.exit(failed ? 1 : 0)
}
