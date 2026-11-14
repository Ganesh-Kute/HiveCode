// B3 red-first test suite: private-room (hs_...) Slack sender guard in hive-slack-relay.js.
// Covers guest/bot/deleted/stranger/external-workspace blocking, fail-closed users.info
// on hs_ rooms, open-room backwards compatibility, connect() teamId persistence, and
// the 5-minute r.users TTL cache.
//
//   node tests/b3-slack-private-guard-test.mjs

import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { makeSlackRelay } from '../hive-slack-relay.js'
import { makeSecuredRoomId } from '../token.js'

const require = createRequire(import.meta.url)
const Y = require('yjs')

let pass = 0, failed = 0
const T = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` -- ${String(extra).slice(0, 300)}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 2500) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return true } catch {}
    await sleep(20)
  }
  return false
}

const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const PK = publicKey.export({ type: 'spki', format: 'pem' })
const HS_ROOM = makeSecuredRoomId(PK, 'b3guard01')
const HS_OAUTH_ROOM = makeSecuredRoomId(PK, 'b3oauth02')
const OPEN_ROOM = 'room-OpenGuardTestRoom1234'
const HOST_TOK = 'host-tok-b3'

const BOT_T1 = 'xoxb-1111-3333-guardtesttoken12345'
const SECRET = 'signing-secret-b3-0123456789abcdef'
const CLIENT_ID = 'client-b3-1'
const CLIENT_SECRET = 'client-secret-b3-1'
const APP_SECRET = 'app-secret-b3-0123456789abcdef'

let fakeNow = Date.parse('2026-11-14T10:00:00Z')
let usersMode = 'normal'   // 'normal' | 'error' | 'throw' | 'demote_member'
const usersCalls = []
const userProfiles = {
  U_MEMBER: { id: 'U_MEMBER', name: 'alice', team_id: 'T1' },
  U_RESTR: { id: 'U_RESTR', name: 'guest1', team_id: 'T1', is_restricted: true },
  U_ULTRA: { id: 'U_ULTRA', name: 'guest2', team_id: 'T1', is_ultra_restricted: true },
  U_STRANGE: { id: 'U_STRANGE', name: 'stranger', team_id: 'T1', is_stranger: true },
  U_BOTUSER: { id: 'U_BOTUSER', name: 'helperbot', team_id: 'T1', is_bot: true },
  U_DELETED: { id: 'U_DELETED', name: 'exuser', team_id: 'T1', deleted: true },
  U_EXT: { id: 'U_EXT', name: 'outsider', team_id: 'T2_EXT' },
  U_OPEN_GUEST: { id: 'U_OPEN_GUEST', name: 'openguest', team_id: 'T1', is_restricted: true },
  U_OPEN_FAIL: { id: 'U_OPEN_FAIL', name: 'ignored' },
}

const docs = new Map()
const awareness = new Map()
const getDoc = (room) => {
  let d = docs.get(room)
  if (!d) {
    d = new Y.Doc()
    d.awareness = { getStates: () => new Map((awareness.get(room) || []).map((u, i) => [i, { user: u }])) }
    docs.set(room, d)
  }
  return d
}
const chatOf = (room) => getDoc(room).getArray('chat').toArray()
const controlsOf = (room) => getDoc(room).getMap('controls')

const fakeFetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop()
  const p = Object.fromEntries(new URLSearchParams(opts.body || ''))
  if (method === 'oauth.v2.access') {
    return {
      status: 200,
      json: async () => ({
        ok: true,
        access_token: BOT_T1,
        bot_user_id: 'UBOT',
        team: { id: 'T1', name: 'Acme' },
        incoming_webhook: { channel_id: 'C0OAUTH', channel: 'priv-oauth', url: 'https://hooks.slack.com/services/X/Y/Z' },
      }),
    }
  }
  if (method === 'auth.test') return { status: 200, json: async () => ({ ok: true, team: 'Acme', team_id: 'T1', user_id: 'UBOT' }) }
  if (method === 'conversations.info') return { status: 200, json: async () => ({ ok: true, channel: { name: 'priv-sec', is_member: true, is_private: false } }) }
  if (method === 'chat.postMessage') return { status: 200, json: async () => ({ ok: true, ts: '1.1' }) }
  if (method === 'users.info') {
    usersCalls.push(p.user)
    if (usersMode === 'throw' || p.user === 'U_THROW') throw new Error('network down')
    if (usersMode === 'error' || p.user === 'U_ERR' || p.user === 'U_OPEN_FAIL') {
      return { status: 200, json: async () => ({ ok: false, error: 'ratelimited' }) }
    }
    const base = userProfiles[p.user]
    if (!base) return { status: 200, json: async () => ({ ok: false, error: 'user_not_found' }) }
    const u = { ...base }
    if (usersMode === 'demote_member' && p.user === 'U_MEMBER') u.is_restricted = true
    return { status: 200, json: async () => ({ ok: true, user: u }) }
  }
  return { status: 200, json: async () => ({ ok: false, error: 'unknown' }) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-guard-'))
let relay, handleImpl
const server = http.createServer((req, res) => handleImpl(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const startRelay = () => {
  if (relay) relay.stop()
  relay = makeSlackRelay({
    getDoc,
    docs,
    access: async (_room, tok) => (tok === HOST_TOK ? { ok: true, role: 'admin', name: 'Host' } : { ok: false }),
    dir,
    key: 'b3-encryption-key-secret-012345',
    fetchImpl: fakeFetch,
    api: 'https://fake.slack/api',
    now: () => fakeNow,
    tickMs: 50,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    appSecret: APP_SECRET,
  })
  handleImpl = (q, s) => relay.handle(q, s)
}

const post = async (p, body, headers = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw })
  let j = null
  try { j = await res.json() } catch {}
  return { status: res.status, j }
}
const signedHeaders = (raw, secret = SECRET) => {
  const ts = String(Math.floor(fakeNow / 1000))
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex')
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }
}
const sendManifestEvent = async (id, eventObj, { team_id = 'T1', event_id } = {}) => {
  const raw = JSON.stringify({
    type: 'event_callback',
    team_id,
    event_id: event_id || `Ev_${crypto.randomBytes(6).toString('hex')}`,
    event: { type: 'message', channel: 'C0PRIV', ts: '1.1', ...eventObj },
  })
  return await post(`/slack/events/${id}`, raw, signedHeaders(raw, SECRET))
}
const sendSharedEvent = async (eventObj, { team_id = 'T1', event_id } = {}) => {
  const raw = JSON.stringify({
    type: 'event_callback',
    team_id,
    event_id: event_id || `Ev_${crypto.randomBytes(6).toString('hex')}`,
    event: { type: 'message', channel: 'C0OAUTH', ts: '1.1', ...eventObj },
  })
  return await post('/slack/events', raw, signedHeaders(raw, APP_SECRET))
}

try {
  startRelay()

  // ---- Setup 1: private hs_ room via --manifest connect() ----
  const pPriv = await post('/slack/prepare', { room: HS_ROOM, token: HOST_TOK })
  const privId = pPriv.j && pPriv.j.id
  const cPriv = await post('/slack/connect', { id: privId, botToken: BOT_T1, signingSecret: SECRET, channel: 'C0PRIV' })
  T('setup private hs_ room via manifest connect succeeds', pPriv.status === 200 && cPriv.status === 200, JSON.stringify(cPriv))

  // ---- Setup 2: open room-... via --manifest connect() ----
  const pOpen = await post('/slack/prepare', { room: OPEN_ROOM })
  const openId = pOpen.j && pOpen.j.id
  const cOpen = await post('/slack/connect', { id: openId, botToken: BOT_T1, signingSecret: SECRET, channel: 'C0PRIV' })
  T('setup open room-... via manifest connect succeeds', pOpen.status === 200 && cOpen.status === 200, JSON.stringify(cOpen))

  // ---- B3.1 Open room compatibility ----
  await sendManifestEvent(openId, { user: 'U_OPEN_GUEST', text: 'guest in open room' })
  await sendManifestEvent(openId, { user: 'U_OPEN_FAIL', text: 'lookup failed in open room' })
  T('B3.1a open room still allows guest message',
    await until(() => chatOf(OPEN_ROOM).some((m) => m.text === 'guest in open room' && m.by === 'slack:openguest')))
  T('B3.1b open room still allows user-id fallback on users.info error',
    await until(() => chatOf(OPEN_ROOM).some((m) => m.text === 'lookup failed in open room' && m.by === 'slack:U_OPEN_FAIL')))

  // ---- B3.2 Private room allows full member ----
  await sendManifestEvent(privId, { user: 'U_MEMBER', text: 'hello from full member' })
  T('B3.2 private hs_ room allows full workspace member',
    await until(() => chatOf(HS_ROOM).some((m) => m.text === 'hello from full member' && m.by === 'slack:alice')),
    JSON.stringify(chatOf(HS_ROOM)))

  // ---- B3.3 Private room blocks guest, ultra_restricted, stranger, is_bot, deleted ----
  awareness.set(HS_ROOM, [{ name: 'AgentOne', kind: 'ai' }])
  await sendManifestEvent(privId, { user: 'U_RESTR', text: 'restricted guest msg' })
  await sendManifestEvent(privId, { user: 'U_ULTRA', text: 'ultra guest msg' })
  await sendManifestEvent(privId, { user: 'U_STRANGE', text: 'stranger msg' })
  await sendManifestEvent(privId, { user: 'U_BOTUSER', text: 'stop all' })
  await sendManifestEvent(privId, { user: 'U_DELETED', text: 'stop AgentOne' })
  await sleep(120)
  const privTexts = chatOf(HS_ROOM).map((m) => m.text)
  T('B3.3a single-channel guest (is_restricted) is blocked in hs_ room', !privTexts.includes('restricted guest msg'), JSON.stringify(privTexts))
  T('B3.3b multi-channel guest (is_ultra_restricted) is blocked in hs_ room', !privTexts.includes('ultra guest msg'), JSON.stringify(privTexts))
  T('B3.3c Slack Connect stranger (is_stranger) is blocked in hs_ room', !privTexts.includes('stranger msg'), JSON.stringify(privTexts))
  T('B3.3d Slack user is_bot:true is blocked in hs_ room', !privTexts.includes('stop all') && !controlsOf(HS_ROOM).get('AgentOne'), JSON.stringify(privTexts))
  T('B3.3e deleted Slack account (deleted:true) is blocked from control + chat in hs_ room', !privTexts.includes('stop AgentOne') && !controlsOf(HS_ROOM).get('AgentOne'), JSON.stringify(privTexts))

  // ---- B3.4 External workspace blocking (connect() teamId + ev.team + restart) ----
  await sendManifestEvent(privId, { user: 'U_EXT', text: 'external u.team_id msg' })
  await sendManifestEvent(privId, { user: 'U_MEMBER', team: 'T2_EXT', text: 'external ev.team msg' })
  await sleep(120)
  T('B3.4a external user team_id !== c.teamId is blocked after connect()', !chatOf(HS_ROOM).some((m) => m.text === 'external u.team_id msg'))
  T('B3.4b external ev.team !== c.teamId is blocked after connect()', !chatOf(HS_ROOM).some((m) => m.text === 'external ev.team msg'))

  // Restart relay from disk and verify c.teamId was persisted from connect()
  startRelay()
  await sendManifestEvent(privId, { user: 'U_EXT', text: 'external after restart' })
  await sleep(120)
  T('B3.4c persisted connect() record retains teamId across relay restart', !chatOf(HS_ROOM).some((m) => m.text === 'external after restart'))

  // One-link OAuth room external workspace check (ev.team !== payload.team_id)
  const pOAuth = await post('/slack/prepare', { room: HS_OAUTH_ROOM, token: HOST_TOK })
  const oauthId = pOAuth.j && pOAuth.j.id
  await fetch(`${base}/slack/oauth/callback?state=${encodeURIComponent(oauthId)}&code=good-code`)
  await sendSharedEvent({ user: 'U_MEMBER', text: 'oauth full member ok' })
  await sendSharedEvent({ user: 'U_MEMBER', team: 'T2_EXT', text: 'oauth external ev.team blocked' })
  await sendSharedEvent({ user: 'U_RESTR', text: 'oauth guest blocked' })
  await sleep(120)
  T('B3.4d one-link hs_ room allows member and blocks external ev.team and guest',
    chatOf(HS_OAUTH_ROOM).some((m) => m.text === 'oauth full member ok')
    && !chatOf(HS_OAUTH_ROOM).some((m) => /oauth external|oauth guest/.test(m.text)),
    JSON.stringify(chatOf(HS_OAUTH_ROOM)))

  // ---- B3.5 Fail closed on users.info error/throw without poisoning cache ----
  await sendManifestEvent(privId, { user: 'U_ERR', text: 'fail closed api error' })
  await sendManifestEvent(privId, { user: 'U_THROW', text: 'fail closed network throw' })
  await sleep(120)
  T('B3.5a users.info API failure fails closed in hs_ room', !chatOf(HS_ROOM).some((m) => m.text === 'fail closed api error'))
  T('B3.5b users.info thrown error fails closed in hs_ room', !chatOf(HS_ROOM).some((m) => m.text === 'fail closed network throw'))

  usersMode = 'error'
  await sendManifestEvent(privId, { user: 'U_RECOVER', text: 'during outage' })
  userProfiles.U_RECOVER = { id: 'U_RECOVER', name: 'bob', team_id: 'T1' }
  await sleep(80)
  usersMode = 'normal'
  await sendManifestEvent(privId, { user: 'U_RECOVER', text: 'after outage recovered' })
  T('B3.5c transient users.info failure is not cached: subsequent recovery succeeds',
    !chatOf(HS_ROOM).some((m) => m.text === 'during outage')
    && await until(() => chatOf(HS_ROOM).some((m) => m.text === 'after outage recovered' && m.by === 'slack:bob')))

  // ---- B3.6 5-minute TTL cache + demotion enforcement ----
  usersCalls.length = 0
  userProfiles.U_TTL = { id: 'U_TTL', name: 'carol', team_id: 'T1' }
  await sendManifestEvent(privId, { user: 'U_TTL', text: 'ttl first call' })
  await until(() => chatOf(HS_ROOM).some((m) => m.text === 'ttl first call'))
  const callsAfterFirst = usersCalls.filter((u) => u === 'U_TTL').length
  fakeNow += 4 * 60 * 1000
  await sendManifestEvent(privId, { user: 'U_TTL', text: 'ttl within 5m' })
  await until(() => chatOf(HS_ROOM).some((m) => m.text === 'ttl within 5m'))
  const callsWithinTtl = usersCalls.filter((u) => u === 'U_TTL').length
  T('B3.6a r.users caches full member within 5m TTL (single users.info lookup)',
    callsAfterFirst === 1 && callsWithinTtl === 1,
    `callsAfterFirst=${callsAfterFirst}, callsWithinTtl=${callsWithinTtl}`)

  fakeNow += 2 * 60 * 1000 // total +6m (>5m)
  userProfiles.U_TTL.is_restricted = true
  await sendManifestEvent(privId, { user: 'U_TTL', text: 'ttl after demotion' })
  await sleep(120)
  const callsAfterExpiry = usersCalls.filter((u) => u === 'U_TTL').length
  T('B3.6b r.users TTL expires after 5m and re-checks users.info, blocking newly demoted guest',
    callsAfterExpiry === 2 && !chatOf(HS_ROOM).some((m) => m.text === 'ttl after demotion'),
    `callsAfterExpiry=${callsAfterExpiry}`)
} finally {
  try { relay && relay.stop() } catch {}
  try { server.close() } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass}/${pass + failed} passed`)
process.exit(failed ? 1 : 0)
