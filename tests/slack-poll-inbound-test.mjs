// Black-box E2E specification for Slack Inbound over HTTPS Polling (`hive-slack.js`)
// behind Antigravity VM's exact 403 WebSocket-blocking egress proxy.
//
//   node tests/slack-poll-inbound-test.mjs
//
// Written RED-first from the room spec before implementation (antigravity-2 writes the test,
// Claude writes the poller, so neither grades its own work). Drives `hive-slack.js` as real
// child OS processes against a real `server.js` relay and a stateful local Fake Slack server
// whose Socket Mode WebSocket URL answers every Upgrade with:
//   HTTP/1.1 403 Forbidden — "WebSocket upgrades are not allowed"

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { startSync } from '../sync.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SLACK_BIN = path.join(ROOT, 'hive-slack.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

async function waitUntil(pred, ms, step = 80) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await pred()) return true } catch {}
    await sleep(step)
  }
  return false
}

let pass = 0, fail = 0
const T = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `   ${extra}` : ''}`)
  if (ok) pass++; else fail++
}
const section = (s) => console.log(`\n# ${s}`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slack-poll-e2e-'))
const RELAY_PORT = await freePort()
const SLACK_PORT = await freePort()
const CHANNEL = 'C0123POLL'
const ROOM = 'room-slack-poll-' + crypto.randomBytes(5).toString('hex')
const LINK = `ws://127.0.0.1:${RELAY_PORT}|${ROOM}`
const SLACK_API = `http://127.0.0.1:${SLACK_PORT}/api`

// ---------------------------------------------------------------------------
// 1. Stateful Fake Slack Web API + 403-on-Upgrade Socket Mode Server
// ---------------------------------------------------------------------------
const DEFAULT_SCOPES = 'chat:write,channels:read,groups:read,channels:history,groups:history,users:read'
const USERS = {
  U01OWNER99: { id: 'U01OWNER99', name: 'Ganesh', team_id: 'T01OURTEAM', is_restricted: false, is_ultra_restricted: false },
  U02COWRK88: { id: 'U02COWRK88', name: 'alice', team_id: 'T01OURTEAM', is_restricted: false, is_ultra_restricted: false },
  U03GUEST77: { id: 'U03GUEST77', name: 'guest_bob', team_id: 'T01OURTEAM', is_restricted: true, is_ultra_restricted: false },
}

let tsBaseSec = Math.floor(Date.now() / 1000) - 120
let tsCounter = 1
function nextTs(offsetSec = 0) {
  tsCounter++
  const sec = tsBaseSec + offsetSec + Math.floor(tsCounter / 1000)
  const usec = String((tsCounter % 1000) * 100).padStart(6, '0')
  return `${sec}.${usec}`
}

const slackState = {
  scopes: DEFAULT_SCOPES,
  channelMessages: [],           // top-level messages in CHANNEL (stored chronologically; served newest-first!)
  hiddenFromHistory: new Set(),  // parent ts aged out of recent conversations.history page (Spec #6)
  threads: new Map(),            // thread_ts -> { parent, replies: [] }
  rateLimitNextHistory: 0,
  rateLimitedAt: 0,
  nextHistoryAfter429At: 0,
  autoReplyCheckPrompt: false,
  stats: {
    wsUpgradesRefused: 0,
    connectionsOpen: 0,
    historyCalls: 0,
    repliesCalls: [],            // { ts, oldest, at }
    postedMessages: [],          // { channel, thread_ts, text, ts }
  },
}

// Strip `.channel` from message objects returned by history/replies to match real Slack Web API!
function wireMsg(m) {
  const copy = { ...m }
  delete copy.channel
  return copy
}

function addTopMessage({ user = 'U02COWRK88', text = '', ts = nextTs(), subtype, bot_id, thread_ts, edited }) {
  const msg = {
    type: 'message',
    user,
    text,
    ts,
    ...(subtype ? { subtype } : {}),
    ...(bot_id ? { bot_id } : {}),
    ...(thread_ts ? { thread_ts } : {}),
    ...(edited ? { edited } : {}),
  }
  slackState.channelMessages.push(msg)
  if (!thread_ts || thread_ts === ts) {
    if (!slackState.threads.has(ts)) {
      slackState.threads.set(ts, { parent: msg, replies: [] })
    }
  }
  return msg
}

function addThreadReply({ thread_ts, user = 'U01OWNER99', text = '', ts = nextTs(), broadcast = false, subtype, bot_id }) {
  let entry = slackState.threads.get(thread_ts)
  if (!entry) {
    const syntheticParent = { type: 'message', user: 'U00HIVEBOT', bot_id: 'B_HIVE', text: 'root', ts: thread_ts, thread_ts }
    entry = { parent: syntheticParent, replies: [] }
    slackState.threads.set(thread_ts, entry)
  }
  const effSubtype = subtype || (broadcast ? 'thread_broadcast' : undefined)
  const reply = {
    type: 'message',
    user,
    text,
    ts,
    thread_ts,
    ...(effSubtype ? { subtype: effSubtype } : {}),
    ...(bot_id ? { bot_id } : {}),
  }
  entry.replies.push(reply)
  entry.parent.thread_ts = thread_ts
  entry.parent.reply_count = entry.replies.length
  entry.parent.latest_reply = entry.replies.reduce((mx, r) => (Number(r.ts) > Number(mx) ? r.ts : mx), '0')
  if (broadcast) {
    slackState.channelMessages.push(reply)
  }
  return reply
}

function parseBody(raw, contentType = '') {
  if (!raw) return {}
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw))
  }
  try { return JSON.parse(raw) } catch {
    return Object.fromEntries(new URLSearchParams(raw))
  }
}

const fakeSlack = http.createServer((req, res) => {
  if (/websocket/i.test(String(req.headers.upgrade || ''))) {
    slackState.stats.wsUpgradesRefused++
    const body = 'WebSocket upgrades are not allowed\n'
    res.writeHead(403, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body), connection: 'close' })
    res.end(body)
    return
  }

  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${SLACK_PORT}`)
    const method = u.pathname.replace(/^\/api\//, '').replace(/^\//, '')
    const params = { ...Object.fromEntries(u.searchParams), ...parseBody(raw, String(req.headers['content-type'] || '')) }
    const authHeader = String(req.headers.authorization || '')
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : String(params.token || '')
    const headers = { 'content-type': 'application/json', 'x-oauth-scopes': slackState.scopes }

    if (!token) {
      res.writeHead(200, headers)
      res.end(JSON.stringify({ ok: false, error: 'not_authed' }))
      return
    }
    if (token === 'xoxb-bad' || token === 'xapp-bad') {
      res.writeHead(200, headers)
      res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }))
      return
    }

    if (method === 'auth.test') {
      res.writeHead(200, headers)
      res.end(JSON.stringify({ ok: true, user: 'hivecode', user_id: 'U00HIVEBOT', team: 'TestTeam', team_id: 'T01OURTEAM' }))
      return
    }

    if (method === 'conversations.info') {
      const ch = params.channel || CHANNEL
      res.writeHead(200, headers)
      res.end(JSON.stringify({
        ok: true,
        channel: { id: ch, name: 'dev-agents', is_member: true, is_private: String(ch).startsWith('G') },
      }))
      return
    }

    if (method === 'users.info') {
      const uRec = USERS[params.user] || { id: params.user, name: String(params.user || 'user'), team_id: 'T01OURTEAM', is_restricted: false, is_ultra_restricted: false }
      res.writeHead(200, headers)
      res.end(JSON.stringify({ ok: true, user: uRec }))
      return
    }

    if (method === 'apps.connections.open') {
      slackState.stats.connectionsOpen++
      res.writeHead(200, headers)
      res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${SLACK_PORT}/link` }))
      return
    }

    if (method === 'chat.postMessage') {
      const ts = nextTs()
      const text = String(params.text || '')
      const thread_ts = params.thread_ts ? String(params.thread_ts) : undefined
      slackState.stats.postedMessages.push({ channel: params.channel, thread_ts, text, ts })
      if (thread_ts) {
        addThreadReply({ thread_ts, user: 'U00HIVEBOT', bot_id: 'B_HIVE', text, ts, broadcast: Boolean(params.reply_broadcast) })
      } else {
        addTopMessage({ user: 'U00HIVEBOT', bot_id: 'B_HIVE', text, ts })
      }
      if (slackState.autoReplyCheckPrompt && /reply anything in this thread/i.test(text)) {
        setTimeout(() => {
          addThreadReply({ thread_ts: ts, user: 'U01OWNER99', text: 'check reply over poll' })
        }, 120)
      }
      res.writeHead(200, headers)
      res.end(JSON.stringify({ ok: true, channel: params.channel || CHANNEL, ts, message: { text, user: 'U00HIVEBOT', bot_id: 'B_HIVE', ts } }))
      return
    }

    const scopeSet = new Set(slackState.scopes.split(',').map((s) => s.trim()).filter(Boolean))
    const isPriv = String(params.channel || CHANNEL).startsWith('G')
    const neededHistScope = isPriv ? 'groups:history' : 'channels:history'

    if (method === 'conversations.history') {
      if (!scopeSet.has(neededHistScope)) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ok: false, error: 'missing_scope', needed: neededHistScope, provided: slackState.scopes }))
        return
      }
      if (slackState.rateLimitNextHistory > 0) {
        slackState.rateLimitNextHistory--
        slackState.rateLimitedAt = Date.now()
        res.writeHead(429, { ...headers, 'retry-after': '1' })
        res.end(JSON.stringify({ ok: false, error: 'ratelimited' }))
        return
      }
      if (slackState.rateLimitedAt && !slackState.nextHistoryAfter429At) {
        slackState.nextHistoryAfter429At = Date.now()
      }
      slackState.stats.historyCalls++

      const oldest = params.oldest !== undefined && params.oldest !== '' ? Number(params.oldest) : null
      const latest = params.latest !== undefined && params.latest !== '' ? Number(params.latest) : null
      const inclusive = params.inclusive === true || params.inclusive === 'true' || params.inclusive === '1' || params.inclusive === 1
      const limit = Math.max(1, Math.min(Number(params.limit) || 100, 200))
      const offset = params.cursor ? Number(params.cursor) || 0 : 0

      let list = slackState.channelMessages.filter((m) => !slackState.hiddenFromHistory.has(m.ts))
      if (oldest !== null && Number.isFinite(oldest)) {
        list = list.filter((m) => (inclusive ? Number(m.ts) >= oldest : Number(m.ts) > oldest))
      }
      if (latest !== null && Number.isFinite(latest)) {
        list = list.filter((m) => (inclusive ? Number(m.ts) <= latest : Number(m.ts) < latest))
      }
      // REAL SLACK ORDERING: newest first!
      list.sort((a, b) => Number(b.ts) - Number(a.ts))
      const page = list.slice(offset, offset + limit).map(wireMsg)
      const has_more = offset + limit < list.length
      res.writeHead(200, headers)
      res.end(JSON.stringify({
        ok: true,
        messages: page,
        has_more,
        response_metadata: { next_cursor: has_more ? String(offset + limit) : '' },
      }))
      return
    }

    if (method === 'conversations.replies') {
      if (!scopeSet.has(neededHistScope)) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ok: false, error: 'missing_scope', needed: neededHistScope, provided: slackState.scopes }))
        return
      }
      const threadTs = String(params.ts || '')
      slackState.stats.repliesCalls.push({ ts: threadTs, oldest: params.oldest, at: Date.now() })
      const entry = slackState.threads.get(threadTs)
      if (!entry) {
        res.writeHead(200, headers)
        res.end(JSON.stringify({ ok: false, error: 'thread_not_found' }))
        return
      }
      const oldest = params.oldest !== undefined && params.oldest !== '' ? Number(params.oldest) : null
      const inclusive = params.inclusive === true || params.inclusive === 'true' || params.inclusive === '1' || params.inclusive === 1
      let replies = [...entry.replies]
      if (oldest !== null && Number.isFinite(oldest)) {
        replies = replies.filter((r) => (inclusive ? Number(r.ts) >= oldest : Number(r.ts) > oldest))
      }
      // REAL SLACK ORDERING FOR REPLIES: parent ALWAYS at messages[0], followed by replies oldest-first!
      replies.sort((a, b) => Number(a.ts) - Number(b.ts))
      const parentWire = wireMsg({ ...entry.parent, thread_ts: threadTs })
      const allMsgs = [parentWire, ...replies.filter((r) => r.ts !== threadTs).map(wireMsg)]
      res.writeHead(200, headers)
      res.end(JSON.stringify({ ok: true, messages: allMsgs, has_more: false, response_metadata: { next_cursor: '' } }))
      return
    }

    res.writeHead(200, headers)
    res.end(JSON.stringify({ ok: true }))
  })
})

fakeSlack.on('upgrade', (_req, socket) => {
  slackState.stats.wsUpgradesRefused++
  const body = 'WebSocket upgrades are not allowed\n'
  socket.end(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  )
})

await new Promise((r) => fakeSlack.listen(SLACK_PORT, '127.0.0.1', r))

// ---------------------------------------------------------------------------
// 2. Relay & Child Bridge Process Helpers
// ---------------------------------------------------------------------------
async function startRelay(port) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), HIVE_PERSIST_DIR: 'off' },
    })
    let said = ''
    const timer = setTimeout(() => {
      console.error('Relay failed to start:', said)
      try { p.kill() } catch {}
      process.exit(1)
    }, 15000)
    p.stdout.on('data', (d) => {
      said += d
      if (/listening on/.test(said)) { clearTimeout(timer); res(p) }
    })
    p.stderr.on('data', (d) => { said += d })
  })
}

const runningProcs = new Set()
function spawnSlackCli(args, extraEnv = {}) {
  const stateDir = extraEnv.TEMP || fs.mkdtempSync(path.join(tmp, 'bridge-state-'))
  const child = spawn(process.execPath, [SLACK_BIN, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HIVE_SLACK_API: SLACK_API,
      HIVE_SLACK_POLL_MS: '150',
      HIVE_SLACK_MIN_GAP_MS: '50',
      HIVE_SLACK_STATE_DIR: stateDir,
      TEMP: stateDir,
      TMPDIR: stateDir,
      ...extraEnv,
    },
  })
  runningProcs.add(child)
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((r) => child.on('exit', (code) => { runningProcs.delete(child); r(code) }))
  return {
    child,
    stateDir,
    stdout: () => out,
    stderr: () => err,
    combined: () => out + '\n' + err,
    waitReady: (ms = 2500) => waitUntil(() => /READY:/.test(out), ms, 60),
    waitExit: async (ms = 4000) => {
      const c = await Promise.race([exited, sleep(ms).then(() => 'running')])
      if (c === 'running') {
        try { child.kill() } catch {}
        return { running: true, code: null, out, err }
      }
      return { running: false, code: c, out, err }
    },
    kill: async () => {
      try { child.kill() } catch {}
      await Promise.race([exited, sleep(500)])
    },
  }
}

let relayProc = await startRelay(RELAY_PORT)
let worker = null
const syncClients = []

async function joinWorker(roomName, agentName = 'Worker') {
  const dir = fs.mkdtempSync(path.join(tmp, `worker-${agentName}-`))
  const h = startSync({
    relay: `ws://127.0.0.1:${RELAY_PORT}`,
    room: roomName,
    dir,
    name: agentName,
    kind: 'ai',
    syncFiles: false,
    log: () => {},
  })
  syncClients.push(h)
  await waitUntil(() => h.status().connected, 6000, 80)
  return h
}

try {
  // -------------------------------------------------------------------------
  section('1. Fake Slack anti-vacuity & fast 403 Socket Mode fallback')

  const wsProbe = await new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SLACK_PORT}/link`)
    ws.on('unexpected-response', (_req, upRes) => {
      let body = ''
      upRes.on('data', (c) => { body += c })
      upRes.on('end', () => res({ status: upRes.statusCode, body }))
    })
    ws.on('open', () => { ws.close(); res({ status: 101, body: '' }) })
    ws.on('error', (e) => res({ status: null, body: e.message }))
  })
  const authProbe = await fetch(`${SLACK_API}/auth.test`, {
    method: 'POST',
    headers: { authorization: 'Bearer xoxb-valid', 'content-type': 'application/json' },
    body: '{}',
  }).then((r) => r.json())

  T(
    'S0 Fake Slack refuses Socket Mode WS upgrade with exact 403 "WebSocket upgrades are not allowed" while HTTP API returns 200 ok',
    wsProbe.status === 403 && /WebSocket upgrades are not allowed/.test(wsProbe.body) && authProbe.ok === true,
    `wsStatus=${wsProbe.status} authOk=${authProbe.ok}`
  )

  worker = await joinWorker(ROOM, 'Worker')

  // Seed pre-existing channel history BEFORE first bridge attach (for S3: must NOT replay!)
  addTopMessage({ user: 'U02COWRK88', text: 'stop', ts: nextTs(-120) })
  addTopMessage({ user: 'U01OWNER99', text: 'pre-existing message before bridge attached', ts: nextTs(-5) })

  const sharedStateDir = fs.mkdtempSync(path.join(tmp, 'shared-bridge-disk-'))
  const wsRefusedBeforeS1 = slackState.stats.wsUpgradesRefused
  const tStart0 = Date.now()
  // Note: intentionally do NOT lower --start-retry here! Default is 60s; the 403 probe must fast-fail in <2s.
  const bridge1 = spawnSlackCli(
    ['start', LINK, '--channel', CHANNEL, '--allow', 'U01OWNER99'],
    { SLACK_BOT_TOKEN: 'xoxb-valid', SLACK_APP_TOKEN: 'xapp-valid', TEMP: sharedStateDir }
  )
  const b1Ready = await bridge1.waitReady(2200)
  const b1ReadyMs = Date.now() - tStart0
  // Wait briefly for initial poll anchor
  if (b1Ready) await waitUntil(() => slackState.stats.historyCalls >= 1, 2000, 60)

  T(
    'S1 auto-fallback: slack start hits 403 on Socket Mode, skips 60s retry loop, and starts HTTPS polling in <2s with notice',
    b1Ready &&
      b1ReadyMs < 2200 &&
      slackState.stats.wsUpgradesRefused > wsRefusedBeforeS1 &&
      slackState.stats.historyCalls >= 1 &&
      bridge1.stderr().includes('[hivecode] Slack replies are read over HTTPS'),
    `ready=${b1Ready} elapsedMs=${b1ReadyMs} wsRefusedDelta=${slackState.stats.wsUpgradesRefused - wsRefusedBeforeS1} historyCalls=${slackState.stats.historyCalls}`
  )

  // S2: --inbound poll without SLACK_APP_TOKEN
  const connOpenBeforeS2 = slackState.stats.connectionsOpen
  const roomS2 = ROOM + '-s2'
  const bridgePollFlag = spawnSlackCli(
    ['start', `ws://127.0.0.1:${RELAY_PORT}|${roomS2}`, '--channel', CHANNEL, '--name', 'PollOnlyBridge', '--inbound', 'poll'],
    { SLACK_BOT_TOKEN: 'xoxb-valid', SLACK_APP_TOKEN: '' }
  )
  const b2Ready = await bridgePollFlag.waitReady(2200)
  const histBeforeKillB2 = slackState.stats.historyCalls
  await bridgePollFlag.kill()

  T(
    'S2 --inbound poll starts inbound HTTPS polling with SLACK_BOT_TOKEN alone (never calls apps.connections.open)',
    b2Ready && slackState.stats.connectionsOpen === connOpenBeforeS2 && histBeforeKillB2 >= 1,
    `ready=${b2Ready} extraConnOpen=${slackState.stats.connectionsOpen - connOpenBeforeS2} err=${bridgePollFlag.stderr().trim().slice(0, 140)}`
  )

  // -------------------------------------------------------------------------
  section('2. Ordering, tracked threads, subtypes, overlap dedupe, and 429 Retry-After')

  // S3: First-attach baseline must NOT replay the pre-existing "stop" message
  await sleep(b1Ready ? 350 : 50)
  const workerCtrlAfterAttach = worker.doc.getMap('controls').get('Worker')
  T(
    'S3 first-attach baseline anchors to Slack server ts and never replays pre-existing "stop" history',
    b1Ready && (!workerCtrlAfterAttach || workerCtrlAfterAttach.state !== 'paused'),
    `b1Ready=${b1Ready} workerCtrl=${JSON.stringify(workerCtrlAfterAttach || null)}`
  )

  // S4: Reversed conversations.history ordering ("stop" at t1, then "resume all" at t2 > t1) + missing .channel
  const tStop = nextTs(1)
  const tResume = nextTs(2)
  const postedBeforeS4 = slackState.stats.postedMessages.length
  addTopMessage({ user: 'U02COWRK88', text: 'stop', ts: tStop })
  addTopMessage({ user: 'U01OWNER99', text: 'resume all', ts: tResume })

  const s4Done = b1Ready && await waitUntil(() => {
    const posts = slackState.stats.postedMessages.slice(postedBeforeS4)
    return posts.some((p) => /paused/i.test(p.text)) && posts.some((p) => /resumed/i.test(p.text))
  }, 3000, 80)
  const ctrlAfterS4 = worker.doc.getMap('controls').get('Worker')

  T(
    'S4 reversed conversations.history (newest-first, no .channel): processes chronologically ("stop" then "resume all" -> running)',
    Boolean(s4Done && ctrlAfterS4 && ctrlAfterS4.state === 'running'),
    `s4Done=${s4Done} finalCtrl=${JSON.stringify(ctrlAfterS4 || null)}`
  )

  // S5: Tracked task thread replies + parent [0] skip + aged-out parent + settled-task budget guard
  const idDone = worker.assign('Worker', 'Settled task')
  worker.decide(idDone, true)
  worker.complete(idDone, 'already done')

  const idOpen = worker.assign('Worker', 'Active VM task')
  worker.decide(idOpen, true)

  const threadsMap = worker.doc.getMap('slack_threads')
  const threadsReady = b1Ready && await waitUntil(() => Boolean(threadsMap.get(idOpen) && threadsMap.get(idDone)), 4000, 80)
  const tsOpen = String(threadsMap.get(idOpen) || '')
  const tsDone = String(threadsMap.get(idDone) || '')

  // Age `tsOpen` out of recent `conversations.history` (Spec #6: replies to OLD threads must still arrive!)
  if (tsOpen) slackState.hiddenFromHistory.add(tsOpen)
  const repliesDoneBefore = slackState.stats.repliesCalls.filter((c) => c.ts === tsDone).length

  if (tsOpen) {
    addThreadReply({ thread_ts: tsOpen, user: 'U01OWNER99', text: '@Worker ship the poll fix' })
  }

  const chatArr = worker.doc.getArray('chat')
  const s5Arrived = threadsReady && await waitUntil(() => {
    return chatArr.toArray().some((m) => m && /ship the poll fix/.test(m.text))
  }, 3500, 80)
  if (b1Ready) await sleep(500) // observe several poll cycles for duplicate / budget check

  const matchingS5 = chatArr.toArray().filter((m) => m && /ship the poll fix/.test(m.text))
  const parentEchoed = chatArr.toArray().some((m) => m && /Active VM task/.test(m.text) && m.viaSlack)
  const repliesDoneDelta = slackState.stats.repliesCalls.filter((c) => c.ts === tsDone).length - repliesDoneBefore

  T(
    'S5 aged-out active task thread: delivers reply once (slack:Ganesh, task=idOpen, viaSlack), skips parent[0], and skips settled task',
    Boolean(
      s5Arrived &&
      matchingS5.length === 1 &&
      matchingS5[0].by === 'slack:Ganesh' &&
      matchingS5[0].task === idOpen &&
      matchingS5[0].viaSlack === true &&
      !parentEchoed &&
      repliesDoneDelta <= 1
    ),
    `arrived=${s5Arrived} count=${matchingS5.length} parentEchoed=${parentEchoed} donePolls=${repliesDoneDelta}`
  )

  // S6: thread_broadcast ("Also send to #channel") + file_share + edit/delete/bot ignore
  const postsBeforeS6 = slackState.stats.postedMessages.length
  if (tsOpen) {
    // Appears in BOTH conversations.history and conversations.replies with same ts & subtype: 'thread_broadcast'
    addThreadReply({ thread_ts: tsOpen, user: 'U02COWRK88', text: 'stop', broadcast: true })
  }
  const bcastStopped = b1Ready && await waitUntil(() => {
    const c = worker.doc.getMap('controls').get('Worker')
    return c && c.state === 'paused'
  }, 3000, 80)
  if (b1Ready) await sleep(350)
  const pauseRepliesCount = slackState.stats.postedMessages.slice(postsBeforeS6).filter((p) => /paused/i.test(p.text)).length

  // Resume and send file_share + edited duplicate + deleted + bot message
  worker.control('Worker', 'running', 'test')
  let fileShareTs = ''
  if (tsOpen) {
    const fsMsg = addThreadReply({ thread_ts: tsOpen, user: 'U01OWNER99', text: '@Worker attached crash.log', subtype: 'file_share' })
    fileShareTs = fsMsg.ts
    // Simulate Slack edit on already-seen message + message_deleted + bot message
    fsMsg.edited = { user: 'U01OWNER99', ts: nextTs(3) }
    addThreadReply({ thread_ts: tsOpen, user: 'U01OWNER99', text: '@Worker deleted text', subtype: 'message_deleted' })
    addThreadReply({ thread_ts: tsOpen, user: 'U00HIVEBOT', bot_id: 'B_OTHER', text: '@Worker bot loop' })
  }
  const fileShareArrived = b1Ready && await waitUntil(() => {
    return chatArr.toArray().some((m) => m && /attached crash\.log/.test(m.text))
  }, 3000, 80)
  if (b1Ready) await sleep(300)
  const fsMatches = chatArr.toArray().filter((m) => m && /attached crash\.log/.test(m.text))
  const badDelivered = chatArr.toArray().some((m) => m && (/deleted text|bot loop/.test(m.text)))

  T(
    'S6 subtypes: thread_broadcast "stop" pauses once across history+replies; file_share text delivers once; edits/deletes/bots ignored',
    Boolean(bcastStopped && pauseRepliesCount === 1 && fileShareArrived && fsMatches.length === 1 && !badDelivered && fileShareTs),
    `bcastStopped=${bcastStopped} pausePosts=${pauseRepliesCount} fileShare=${fsMatches.length} bad=${badDelivered}`
  )

  // S7: 30s overlap window catches late-indexed message + two-bridge room-state ts dedupe
  const bridgeDup = b1Ready
    ? spawnSlackCli(
        ['start', LINK, '--channel', CHANNEL, '--name', 'SlackBridgeSecondary', '--allow', 'U01OWNER99', '--inbound', 'poll'],
        { SLACK_BOT_TOKEN: 'xoxb-valid' }
      )
    : null
  if (bridgeDup) await bridgeDup.waitReady(2000)

  const tsAdvance = nextTs(10)
  if (tsOpen) addThreadReply({ thread_ts: tsOpen, user: 'U01OWNER99', text: '@Worker high-water-msg', ts: tsAdvance })
  if (b1Ready) {
    await waitUntil(() => chatArr.toArray().some((m) => m && /high-water-msg/.test(m.text)), 3000, 80)
    // Now insert a late-indexed message 4 seconds BEHIND tsAdvance (inside the 30s overlap window!)
    const tsLate = `${ Math.floor(Number(tsAdvance)) - 4 }.555000`
    addThreadReply({ thread_ts: tsOpen, user: 'U01OWNER99', text: '@Worker late-indexed-overlap-msg', ts: tsLate })
  }
  const lateArrived = b1Ready && await waitUntil(() => {
    return chatArr.toArray().some((m) => m && /late-indexed-overlap-msg/.test(m.text))
  }, 3000, 80)
  if (b1Ready) await sleep(400)
  if (bridgeDup) await bridgeDup.kill()

  const highCount = chatArr.toArray().filter((m) => m && /high-water-msg/.test(m.text)).length
  const lateCount = chatArr.toArray().filter((m) => m && /late-indexed-overlap-msg/.test(m.text)).length

  T(
    'S7 30s overlap + two-bridge room-state ts dedupe: late-indexed message arrives and neither message duplicates across 2 bridges',
    Boolean(lateArrived && highCount === 1 && lateCount === 1),
    `lateArrived=${lateArrived} highCount=${highCount} lateCount=${lateCount}`
  )

  // S8: 429 Retry-After: 1 honoured + zero message loss
  worker.control('Worker', 'running', 'test')
  slackState.rateLimitedAt = 0
  slackState.nextHistoryAfter429At = 0
  slackState.rateLimitNextHistory = 1
  addTopMessage({ user: 'U02COWRK88', text: 'stop', ts: nextTs(15) })

  const pausedAfter429 = b1Ready && await waitUntil(() => {
    const c = worker.doc.getMap('controls').get('Worker')
    return c && c.state === 'paused' && slackState.nextHistoryAfter429At > 0
  }, 4500, 80)
  const retryGapMs = slackState.nextHistoryAfter429At - slackState.rateLimitedAt

  T(
    'S8 HTTP 429 Retry-After: 1 backs off >=850ms without advancing cursor and delivers queued "stop" on next poll',
    Boolean(pausedAfter429 && retryGapMs >= 850),
    `pausedAfter429=${pausedAfter429} retryGapMs=${retryGapMs}`
  )

  // -------------------------------------------------------------------------
  section('3. Scope guard, Render relay-wipe survival, and `slack check` behind 403 proxy')

  // S9: Missing channels:history scope fails loudly naming scope + manifest
  const savedScopes = slackState.scopes
  slackState.scopes = 'chat:write,channels:read,users:read'
  const badScopeRun = spawnSlackCli(
    ['start', `ws://127.0.0.1:${RELAY_PORT}|${ROOM}-scope`, '--channel', CHANNEL, '--inbound', 'poll'],
    { SLACK_BOT_TOKEN: 'xoxb-valid', SLACK_APP_TOKEN: '' }
  )
  const badScopeExit = await badScopeRun.waitExit(3000)
  slackState.scopes = savedScopes

  T(
    'S9 missing channels:history fails loudly (exit 1) naming channels:history and slack-app-manifest-inbound.json',
    !badScopeExit.running &&
      badScopeExit.code === 1 &&
      /channels:history/.test(badScopeExit.err) &&
      /slack-app-manifest-inbound\.json/.test(badScopeExit.err),
    `code=${badScopeExit.code} err=${badScopeExit.err.trim().slice(0, 160)}`
  )

  // S10: Relay wiped on deploy + bridge restarted with same HIVE_SLACK_STATE_DIR disk state -> downtime thread reply arrives!
  await bridge1.kill()
  try { worker.stop() } catch {}
  try { relayProc.kill() } catch {}
  await sleep(250)

  // Message sent in pre-wipe Slack thread `tsOpen` WHILE both bridge and relay are completely down
  // (nextTs(25) is ~now-95s, well inside default 30m HIVE_SLACK_CATCHUP_MS).
  slackState.hiddenFromHistory.delete(tsOpen)
  if (tsOpen) {
    addThreadReply({ thread_ts: tsOpen, user: 'U01OWNER99', text: '@Worker sent-during-relay-wipe', ts: nextTs(25) })
  }

  // Fresh relay with wiped RAM (HIVE_PERSIST_DIR=off), simulating Render deploy!
  relayProc = await startRelay(RELAY_PORT)
  const workerRebuilt = await joinWorker(ROOM, 'Worker')
  const bridgeRebuilt = spawnSlackCli(
    ['start', LINK, '--channel', CHANNEL, '--allow', 'U01OWNER99', '--inbound', 'poll'],
    { SLACK_BOT_TOKEN: 'xoxb-valid', TEMP: sharedStateDir }
  )
  const bRebuiltReady = await bridgeRebuilt.waitReady(2500)
  const rebuiltChat = workerRebuilt.doc.getArray('chat')
  const wipeSurvived = bRebuiltReady && await waitUntil(() => {
    return rebuiltChat.toArray().some((m) => m && /sent-during-relay-wipe/.test(m.text))
  }, 4000, 80)
  await bridgeRebuilt.kill()

  const wipeMsg = rebuiltChat.toArray().find((m) => m && /sent-during-relay-wipe/.test(m.text))
  T(
    'S10 Render relay wipe recovery: disk cursor + threads survive wiped Y.Doc and deliver thread reply sent during downtime',
    Boolean(wipeSurvived && wipeMsg && wipeMsg.by === 'slack:Ganesh' && wipeMsg.task === idOpen),
    `survived=${wipeSurvived} msg=${JSON.stringify(wipeMsg || null)}`
  )

  // S10b: Catch-up limit (HIVE_SLACK_CATCHUP_MS=15000):
  // Disk cursor in `sharedStateDir` is now at nextTs(25) (~now - 95s).
  // While the bridge is down, two messages arrive after nextTs(25):
  //   1) A stale "stop" at ~now - 50s (50s old > 15s HIVE_SLACK_CATCHUP_MS) -> MUST NOT pause Worker, and bridge posts catch-up skip notice once!
  //   2) A fresh thread reply at ~now - 1s (1s old < 15s HIVE_SLACK_CATCHUP_MS) -> MUST be delivered!
  workerRebuilt.control('Worker', 'running', 'test')
  const postsBeforeS10b = slackState.stats.postedMessages.length
  const nowSec = Math.floor(Date.now() / 1000)
  addTopMessage({ user: 'U02COWRK88', text: 'stop', ts: `${nowSec - 50}.100000` })
  if (tsOpen) {
    addThreadReply({ thread_ts: tsOpen, user: 'U01OWNER99', text: '@Worker fresh-inside-catchup-window', ts: `${nowSec - 1}.200000` })
  }

  const bridgeCatchup = spawnSlackCli(
    ['start', LINK, '--channel', CHANNEL, '--allow', 'U01OWNER99', '--inbound', 'poll'],
    { SLACK_BOT_TOKEN: 'xoxb-valid', TEMP: sharedStateDir, HIVE_SLACK_CATCHUP_MS: '15000' }
  )
  const bCatchupReady = await bridgeCatchup.waitReady(2500)
  const freshCatchupArrived = bCatchupReady && await waitUntil(() => {
    return rebuiltChat.toArray().some((m) => m && /fresh-inside-catchup-window/.test(m.text))
  }, 4000, 80)
  if (bCatchupReady) await sleep(300)
  await bridgeCatchup.kill()

  const ctrlAfterCatchup = workerRebuilt.doc.getMap('controls').get('Worker')
  const catchupPosts = slackState.stats.postedMessages.slice(postsBeforeS10b)
  const skippedNotices = catchupPosts.filter((p) => /offline/i.test(p.text) && /not acted on/i.test(p.text))

  T(
    'S10b HIVE_SLACK_CATCHUP_MS catch-up limit: skips stale "stop" older than window, posts notice once, and delivers fresh reply inside window',
    Boolean(
      freshCatchupArrived &&
      (!ctrlAfterCatchup || ctrlAfterCatchup.state === 'running') &&
      skippedNotices.length === 1
    ),
    `freshArrived=${freshCatchupArrived} workerState=${ctrlAfterCatchup?.state} notices=${skippedNotices.length}`
  )

  // S11: `slack check` behind 403 Socket Mode proxy auto-falls back to polling and verifies inbound reply
  slackState.autoReplyCheckPrompt = true
  const checkProc = spawnSlackCli(
    ['check', '--channel', CHANNEL, '--timeout', '3500', '--hello-timeout', '600', '--start-retry', '600'],
    { SLACK_BOT_TOKEN: 'xoxb-valid', SLACK_APP_TOKEN: 'xapp-valid' }
  )
  const checkRes = await checkProc.waitExit(5000)

  T(
    'S11 `slack check` behind 403 proxy falls back to HTTPS polling, receives thread reply, and exits 0',
    !checkRes.running && checkRes.code === 0 && /replies reach Hivecode/i.test(checkRes.out),
    `code=${checkRes.code} out=${checkRes.out.trim().slice(-120)} err=${checkRes.err.trim().slice(-140)}`
  )
} finally {
  for (const p of [...runningProcs]) { try { p.kill() } catch {} }
  for (const c of syncClients) { try { c.stop() } catch {} }
  await new Promise((r) => fakeSlack.close(() => r()))
  try { relayProc.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
