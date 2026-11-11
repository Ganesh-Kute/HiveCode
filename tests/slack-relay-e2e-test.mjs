// tests/slack-relay-e2e-test.mjs -- End-to-end integration tests for relay Slack integration (issue #22).
// Tests server.js + hive-slack-relay.js + sync.js + fake Slack Web API:
//   - /slack/prepare: creates random id, does not leak room id, idempotent for same room
//   - pre-connect /slack/events/<id>: url_verification echoes challenge without signature
//   - /slack/connect: verifies auth.test & channel membership, stores encrypted credentials
//   - inbound Slack -> room: signature verification, 3s deadline (<500ms), dedupe, slack:<user> attribution
//   - inbound control commands: stop/resume updates room controls
//   - outbound room -> Slack: forwards non-Slack chat, scrubs secrets and room id, no echo loop
//   - /slack/disconnect: requires signing secret, supports disconnect by id and by room
import http from 'http'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)

let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const raw = typeof body === 'string' ? body : JSON.stringify(body)
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
        ...headers,
      },
    }, (res) => {
      let b = ''
      res.on('data', (d) => { b += d })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(b) } catch { }
        resolve({ status: res.statusCode, headers: res.headers, raw: b, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
    req.write(raw)
    req.end()
  })
}

function signSlack(signingSecret, bodyStr, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = 'v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${bodyStr}`).digest('hex')
  return {
    'x-slack-request-timestamp': String(timestamp),
    'x-slack-signature': sig,
  }
}

// -------------------------------------------------------------------------------------------------
// Mock Slack Web API Server
// -------------------------------------------------------------------------------------------------
let mockSlackCalls = []
let mockSlackChannels = {
  C123: { id: 'C123', name: 'general', is_member: true },
  C_NOTMEMBER: { id: 'C_NOTMEMBER', name: 'private-dev', is_member: false },
}
let mockSlackRejectAuth = false

const slackServer = http.createServer(async (req, res) => {
  let b = ''
  req.on('data', (d) => { b += d })
  await new Promise((r) => req.on('end', r))

  const params = new URLSearchParams(b)
  const method = req.url.replace(/^\//, '').split('?')[0]
  mockSlackCalls.push({ method, params: Object.fromEntries(params.entries()), auth: req.headers.authorization })

  res.writeHead(200, { 'content-type': 'application/json' })

  if (method === 'auth.test') {
    if (mockSlackRejectAuth) return res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }))
    return res.end(JSON.stringify({ ok: true, user: 'hivebot', user_id: 'U_BOT123', team: 'AcmeTeam', team_id: 'T1' }))
  }

  if (method === 'conversations.info') {
    const chId = params.get('channel')
    const ch = mockSlackChannels[chId]
    if (!ch) return res.end(JSON.stringify({ ok: false, error: 'channel_not_found' }))
    return res.end(JSON.stringify({ ok: true, channel: ch }))
  }

  if (method === 'users.info') {
    const uId = params.get('user') || 'U_USER1'
    return res.end(JSON.stringify({ ok: true, user: { id: uId, name: 'ganesh', profile: { display_name: 'Ganesh K' } } }))
  }

  if (method === 'chat.postMessage') {
    return res.end(JSON.stringify({ ok: true, ts: '1700000000.000100', channel: params.get('channel') }))
  }

  res.end(JSON.stringify({ ok: true }))
})

const SLACK_PORT = await freePort()
await new Promise((resolve) => slackServer.listen(SLACK_PORT, '127.0.0.1', resolve))
const SLACK_API = `http://127.0.0.1:${SLACK_PORT}`

// -------------------------------------------------------------------------------------------------
// Relay Setup
// -------------------------------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-relay-e2e-'))
const DATA_DIR = path.join(TMP, 'relay-data')
const CLIENT_DIR = path.join(TMP, 'client')
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(CLIENT_DIR, { recursive: true })

const RELAY_PORT = await freePort()
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`
const RELAY_WS = `ws://127.0.0.1:${RELAY_PORT}`
const SLACK_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

let relayProc = null
const cleanup = () => {
  try { if (relayProc) relayProc.kill() } catch { }
  try { slackServer.close() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}
process.on('exit', cleanup)

relayProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(RELAY_PORT),
    HIVE_PERSIST_DIR: DATA_DIR,
    HIVE_SLACK_KEY: SLACK_KEY,
    HIVE_SLACK_API: SLACK_API,
    HIVE_ROOM_MODE: '0',
    HIVE_SEATS: '25',
    HIVE_PRIVATE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
relayProc.stderr.on('data', () => { })
relayProc.stdout.resume()

// Wait for relay to become healthy
let up = false
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`${RELAY_URL}/health`)
    const j = await res.json()
    if (j.ok) { up = true; break }
  } catch { }
  await sleep(100)
}

if (!up) {
  console.error('Relay failed to start')
  process.exit(1)
}

console.log('\n=== SLACK RELAY E2E TESTS ===\n')

try {
  const ROOM1 = 'room-E2ETEST-1'
  const SIGNING_SECRET = 'my-test-signing-secret-999'
  const BOT_TOKEN = 'xoxb-mock-bot-token-111'

  // E1: prepare endpoint requires valid room
  let r = await postJSON(`${RELAY_URL}/slack/prepare`, { room: '' })
  T('E1 /slack/prepare rejects missing room with Q661', r.status === 400 && r.json.code === 'Q661')

  // E2: prepare generates id and eventsUrl without leaking room id
  r = await postJSON(`${RELAY_URL}/slack/prepare`, { room: ROOM1 })
  T('E2 /slack/prepare succeeds with id and eventsUrl', r.status === 200 && r.json.ok === true && typeof r.json.id === 'string')
  const connId = r.json.id
  const eventsUrl = r.json.eventsUrl
  T('E2b eventsUrl contains connection id and does NOT contain room id', eventsUrl.includes(connId) && !eventsUrl.includes(ROOM1))

  // E3: prepare is idempotent for same room while unconnected
  r = await postJSON(`${RELAY_URL}/slack/prepare`, { room: ROOM1 })
  T('E3 /slack/prepare returns same id for same unconnected room', r.status === 200 && r.json.id === connId)

  // E4: pre-connect url_verification challenge echoes back without signature
  r = await postJSON(`${RELAY_URL}/slack/events/${connId}`, { type: 'url_verification', challenge: 'challenge-str-123' })
  T('E4 pre-connect url_verification echoes challenge with HTTP 200', r.status === 200 && r.json.challenge === 'challenge-str-123')

  // E5: pre-connect event callback is rejected with 409
  r = await postJSON(`${RELAY_URL}/slack/events/${connId}`, { type: 'event_callback', event: { type: 'message' } })
  T('E5 pre-connect event callback rejected with 409 Q661', r.status === 409 && r.json.code === 'Q661')

  // E6: connect fails when bot token is invalid (auth.test fails)
  mockSlackRejectAuth = true
  r = await postJSON(`${RELAY_URL}/slack/connect`, { id: connId, botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, channel: 'C123' })
  T('E6 connect fails with Q662 when auth.test fails', r.status === 400 && r.json.code === 'Q662')
  mockSlackRejectAuth = false

  // E7: connect fails with Q664 when bot is not member of channel
  r = await postJSON(`${RELAY_URL}/slack/connect`, { id: connId, botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, channel: 'C_NOTMEMBER' })
  T('E7 connect fails with Q664 when bot is not in channel', r.status === 400 && r.json.code === 'Q664')

  // E8: connect succeeds with valid credentials and announces in Slack and room
  mockSlackCalls = []
  r = await postJSON(`${RELAY_URL}/slack/connect`, { id: connId, botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, channel: 'C123' })
  T('E8 connect succeeds with HTTP 200', r.status === 200 && r.json.ok === true && r.json.channel === 'general')

  // Wait for initial announcement post to Slack
  await sleep(300)
  const initialPost = mockSlackCalls.find((c) => c.method === 'chat.postMessage')
  T('E8b relay posted connection announcement to Slack', !!initialPost && initialPost.params.text.includes('Slack is connected to this room'))
  T('E8c postMessage carries stored bot token in Authorization header', initialPost && initialPost.auth === `Bearer ${BOT_TOKEN}`)

  // Connect human sync client and AI agent sync client to room to observe chat and controls
  const clientDir1 = path.join(CLIENT_DIR, 'c1')
  const clientDir2 = path.join(CLIENT_DIR, 'c2')
  fs.mkdirSync(clientDir1, { recursive: true })
  fs.mkdirSync(clientDir2, { recursive: true })
  const syncClient = startSync({
    relay: RELAY_WS,
    room: ROOM1,
    dir: clientDir1,
    name: 'Alice',
    kind: 'human',
    log: () => { },
  })
  const syncAgent = startSync({
    relay: RELAY_WS,
    room: ROOM1,
    dir: clientDir2,
    name: 'AgentA',
    kind: 'ai',
    owner: 'Alice',
    log: () => { },
  })

  // Wait for both sync clients to connect
  let clientsConnected = false
  for (let i = 0; i < 40; i++) {
    try { if (syncClient.status().connected && syncAgent.status().connected) { clientsConnected = true; break } } catch { }
    await sleep(100)
  }
  T('E9 both sync clients (human + AI agent) connected to room', clientsConnected)

  // Verify room chat contains connection announcement
  const chatArray = syncClient.doc.getArray('chat')
  const hasAnnounce = chatArray.toArray().some((m) => m && m.text && m.text.includes('Slack is connected to this room'))
  T('E9b room chat contains connection announcement', hasAnnounce)

  // E10: inbound Slack message delivery (and no echo back)
  mockSlackCalls = []
  const inboundEvt1 = {
    type: 'event_callback',
    event_id: 'Evt_1001',
    event: {
      type: 'message',
      channel: 'C123',
      user: 'U_USER1',
      text: 'Hello from Slack!',
    },
  }
  const body1 = JSON.stringify(inboundEvt1)
  const sigHeaders1 = signSlack(SIGNING_SECRET, body1)

  const tStart = Date.now()
  r = await postJSON(`${RELAY_URL}/slack/events/${connId}`, body1, sigHeaders1)
  const tElapsed = Date.now() - tStart
  T('E10 inbound event answered with 200 well within 3s deadline (<500ms)', r.status === 200 && r.json.ok === true && tElapsed < 500)

  // Wait for delivery to room chat
  let delivered = false
  for (let i = 0; i < 30; i++) {
    const msgs = chatArray.toArray()
    if (msgs.some((m) => m && m.text === 'Hello from Slack!' && m.by === 'slack:ganesh' && m.src === 'slack')) {
      delivered = true
      break
    }
    await sleep(100)
  }
  T('E10b inbound message delivered to room chat as slack:ganesh', delivered)
  await sleep(300)
  const echoed1 = mockSlackCalls.some((c) => c.method === 'chat.postMessage' && c.params.text && c.params.text.includes('Hello from Slack!'))
  T('E10c inbound Slack message is NOT echoed back to Slack', !echoed1)

  // E11: inbound deduplication (same event_id sent again)
  const chatCountBefore = chatArray.length
  r = await postJSON(`${RELAY_URL}/slack/events/${connId}`, body1, sigHeaders1)
  T('E11 retry with same event_id answered 200', r.status === 200)
  await sleep(300)
  T('E11b duplicate event dropped: chat length unchanged', chatArray.length === chatCountBefore)

  // E12: signature rejection (wrong secret)
  const badSigHeaders = signSlack('wrong-signing-secret', body1)
  r = await postJSON(`${RELAY_URL}/slack/events/${connId}`, body1, badSigHeaders)
  T('E12 bad signature rejected with 401 Q663', r.status === 401 && r.json.code === 'Q663')

  // E13: expired timestamp rejection
  const oldSigHeaders = signSlack(SIGNING_SECRET, body1, Math.floor(Date.now() / 1000) - 400)
  r = await postJSON(`${RELAY_URL}/slack/events/${connId}`, body1, oldSigHeaders)
  T('E13 expired timestamp (>300s) rejected with 401 Q663', r.status === 401 && r.json.code === 'Q663')

  // E14: bot messages are ignored (no bot echo into room)
  const botEvt = {
    type: 'event_callback',
    event_id: 'Evt_1002',
    event: { type: 'message', channel: 'C123', user: 'U_BOT123', bot_id: 'B_APP', text: 'Bot echo text' },
  }
  const botBody = JSON.stringify(botEvt)
  await postJSON(`${RELAY_URL}/slack/events/${connId}`, botBody, signSlack(SIGNING_SECRET, botBody))
  await sleep(200)
  T('E14 bot messages not added to room chat', !chatArray.toArray().some((m) => m && m.text === 'Bot echo text'))

  // E14b: non-target channel messages are ignored
  const otherChanEvt = {
    type: 'event_callback',
    event_id: 'Evt_1002b',
    event: { type: 'message', channel: 'C_OTHER_DIFFERENT', user: 'U_USER1', text: 'Other channel message' },
  }
  const otherChanBody = JSON.stringify(otherChanEvt)
  await postJSON(`${RELAY_URL}/slack/events/${connId}`, otherChanBody, signSlack(SIGNING_SECRET, otherChanBody))
  await sleep(200)
  T('E14b messages from non-connected channels are ignored', !chatArray.toArray().some((m) => m && m.text === 'Other channel message'))

  // E14c: non-person subtypes (e.g. message_changed, channel_join) are ignored
  const subtypeEvt = {
    type: 'event_callback',
    event_id: 'Evt_1002c',
    event: { type: 'message', channel: 'C123', user: 'U_USER1', subtype: 'message_changed', text: 'Edited text' },
  }
  const subtypeBody = JSON.stringify(subtypeEvt)
  await postJSON(`${RELAY_URL}/slack/events/${connId}`, subtypeBody, signSlack(SIGNING_SECRET, subtypeBody))
  await sleep(200)
  T('E14c non-person subtypes are ignored', !chatArray.toArray().some((m) => m && m.text === 'Edited text'))

  // E15: Slack control command "stop" pauses AI agent in controls map
  const stopEvt = {
    type: 'event_callback',
    event_id: 'Evt_1003',
    event: { type: 'message', channel: 'C123', user: 'U_USER1', text: 'stop' },
  }
  const stopBody = JSON.stringify(stopEvt)
  await postJSON(`${RELAY_URL}/slack/events/${connId}`, stopBody, signSlack(SIGNING_SECRET, stopBody))
  let agentPaused = false
  for (let i = 0; i < 30; i++) {
    const c = syncClient.doc.getMap('controls').get('AgentA')
    if (c && c.state === 'paused') { agentPaused = true; break }
    await sleep(100)
  }
  T('E15 Slack "stop" command pauses AI agent in controls map', agentPaused)

  // E15b: Slack control command "resume" resumes AI agent in controls map
  const resumeEvt = {
    type: 'event_callback',
    event_id: 'Evt_1003b',
    event: { type: 'message', channel: 'C123', user: 'U_USER1', text: 'resume' },
  }
  const resumeBody = JSON.stringify(resumeEvt)
  await postJSON(`${RELAY_URL}/slack/events/${connId}`, resumeBody, signSlack(SIGNING_SECRET, resumeBody))
  let agentResumed = false
  for (let i = 0; i < 30; i++) {
    const c = syncClient.doc.getMap('controls').get('AgentA')
    if (c && c.state === 'running') { agentResumed = true; break }
    await sleep(100)
  }
  T('E15b Slack "resume" command resumes AI agent in controls map', agentResumed)

  // E16: Outbound room -> Slack chat forwarding and secret scrubbing
  mockSlackCalls = []
  const fakeToken = ['ghp', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('_')
  chatArray.push([{
    by: 'Bob',
    text: `Check deployment on https://example.com with key ${fakeToken} in room-E2ETEST-1`,
    at: '12:00:00',
  }])

  let outboundPosted = null
  for (let i = 0; i < 40; i++) {
    outboundPosted = mockSlackCalls.find((c) => c.method === 'chat.postMessage' && c.params.text && c.params.text.includes('Bob'))
    if (outboundPosted) break
    await sleep(100)
  }
  T('E16 room chat forwarded to Slack via chat.postMessage', !!outboundPosted)
  T('E16b room id and token scrubbed in Slack post',
    outboundPosted &&
    !outboundPosted.params.text.includes('room-E2ETEST-1') &&
    outboundPosted.params.text.includes('[room id removed]') &&
    outboundPosted.params.text.includes('[GitHub token removed]') &&
    !outboundPosted.params.text.includes(fakeToken))

  // E17: outbound does NOT echo messages originating from Slack back to Slack
  const echoedSlack = mockSlackCalls.some((c) => c.params.text && c.params.text.includes('Hello from Slack!'))
  T('E17 messages originating from Slack are NOT echoed back to Slack', !echoedSlack)

  // E18: Disconnect by id requires valid signing secret
  r = await postJSON(`${RELAY_URL}/slack/disconnect`, { id: connId, signingSecret: 'wrong-secret' })
  T('E18 disconnect with wrong secret fails with 401 Q663', r.status === 401 && r.json.code === 'Q663')

  r = await postJSON(`${RELAY_URL}/slack/disconnect`, { id: connId, signingSecret: SIGNING_SECRET })
  T('E18b disconnect with valid secret succeeds with HTTP 200', r.status === 200 && r.json.ok === true)

  // Events after disconnect are rejected with 404
  r = await postJSON(`${RELAY_URL}/slack/events/${connId}`, body1, sigHeaders1)
  T('E18c events after disconnect return 404 Q661', r.status === 404 && r.json.code === 'Q661')

  // E19: Disconnect by room link (another computer without stored id)
  const ROOM2 = 'room-E2ETEST-2'
  const p2 = await postJSON(`${RELAY_URL}/slack/prepare`, { room: ROOM2 })
  await postJSON(`${RELAY_URL}/slack/connect`, { id: p2.json.id, botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET, channel: 'C123' })
  r = await postJSON(`${RELAY_URL}/slack/disconnect`, { room: ROOM2, signingSecret: SIGNING_SECRET })
  T('E19 disconnect by room succeeds', r.status === 200 && r.json.ok === true)

  try { syncClient.stop() } catch { }
  try { syncAgent.stop() } catch { }
} catch (err) {
  console.error('Test execution error:', err)
  fail++
} finally {
  cleanup()
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
