// hive-slack — the room speaks to Slack, and Slack speaks back into the room.
//
//   node hive-slack.js "<relay|room>" --channel C123 [--name SlackBridge] [--dry-run]
//   env: SLACK_BOT_TOKEN (xoxb-…), optional HIVE_SLACK_API to point at a different base URL
//
// WHY OUT AND NOT IN. A team will not move its conversation into our control room, and asking
// them to is how the integration dies quietly. So Slack stays where the humans are: the room
// posts there, and a reply in the thread comes back into the room. Nobody has to open a new tab
// to find out what happened overnight.
//
// ONE THREAD PER TASK. This is the decision the whole integration lives or dies on. Everything
// about a task -- its claims, its gate result, its completion -- goes into that task's own
// thread, and only the opening and the outcome reach the channel itself. Untasked room chat
// shares one room thread (__room__) so chatter never floods the main channel either.
//
// The thread map lives in ROOM STATE (or the caller's persistent store for makeSlackThreader),
// not in this process. A bridge that restarts must land its next update in the same Slack
// thread, or a task's history splits in half and the thread stops being worth reading.
//
// Error codes Q630-Q635 are this module's:
//   Q630  SLACK_BOT_TOKEN missing, invalid, or revoked at preflight
//   Q631  --channel missing, not found, or the bot has not been invited (/invite @Hivecode)
//   Q632  a Slack bridge with this name is already running in the room
//   Q634  SLACK_APP_TOKEN (xapp-…) invalid or missing connections:write for Socket Mode
//   Q635  multiple concurrent Socket Mode processes on same app token

import WebSocket from 'ws'
import { startSync, parseLink } from './sync.js'
import { scrub } from './hive-webhook.js'

const DEFAULT_API = 'https://slack.com/api'
const ROOM_THREAD_KEY = '__room__'
const CURSOR_KEY = '__cursor__'
const MAX_SEEN_EVENTS = 500

export const USAGE = `usage:
  SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest slack start "<relay|room>" --channel <id> [--name SlackBridge] [--allow <U123,U456>] [--dry-run] [--start-retry <ms>]
  SLACK_BOT_TOKEN=xoxb-… [SLACK_APP_TOKEN=xapp-…] npx -y hivecode-mcp@latest slack check --channel <id> [--agent] [--timeout <ms>] [--start-retry <ms>]
`

export const NON_RETRYABLE = new Set([
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'not_authed',
  'not_in_channel',
  'channel_not_found',
  'is_archived',
  'missing_scope',
  'ekm_access_denied',
])

function extractSlackError(err) {
  if (!err) return ''
  if (err.slackError) return String(err.slackError)
  if (err.code && typeof err.code === 'string') return err.code
  const m = /slack [^:]+:\s*([a-z0-9_]+)/i.exec(err.message || '')
  return m ? m[1].toLowerCase() : ''
}

function formatSlackWhy(err) {
  if (!err) return 'unknown_error'
  const code = extractSlackError(err) || err.message || 'unknown_error'
  if (code === 'missing_scope' && err.needed) return `missing_scope: needs ${err.needed}`
  return code
}

export function isRateLimitError(err) {
  if (!err) return false
  if (err.status === 429) return true
  const code = extractSlackError(err)
  return code === 'ratelimited'
}

export function isPermanentSlackError(err) {
  const code = extractSlackError(err)
  return NON_RETRYABLE.has(code)
}

/** Scrub secrets/tokens (via hive-webhook.js) AND strip room links / room IDs so a room's
 *  capability link never leaks to an external Slack channel. */
export function scrubSlack(text, { room = '', link = '' } = {}) {
  let s = scrub(String(text || ''))
  if (link) s = s.split(link).join('[room link removed]')
  // Any wss://...|room-... or ws://...|room-... link
  s = s.replace(/\bwss?:\/\/[^\s|"'<>]+\|[^\s"'<>]+/gi, '[room link removed]')
  if (room) s = s.split(room).join('[room id removed]')
  s = s.replace(/\broom-[A-Za-z0-9_-]{6,}\b/g, '[room id removed]')
  return s
}

// Slack allows roughly one message per second per channel and silently reorders or drops when
// you exceed it. A room can emit a dozen events in a burst, so everything leaves through one
// paced queue rather than going straight out.
//
// 429 / ratelimited is retried in-place at the head of the queue up to maxRetries (5) times,
// honouring Retry-After. Permanent auth/channel errors (invalid_auth, token_revoked,
// not_in_channel, channel_not_found) are never retried: reported once via onError, then the
// queue halts so a dead token or missing invite never hammers Slack in a loop.
export function makeQueue({
  send,
  minGapMs = 1000,
  maxRetries = 5,
  now = () => Date.now(),
  timer = setTimeout,
  onError = null,
}) {
  const q = []
  let running = false, last = 0
  let halted = false, haltedErr = null

  async function pump() {
    if (running) return
    running = true
    while (q.length) {
      const job = q[0]
      if (halted) {
        q.shift()
        job.reject(haltedErr || new Error('slack queue halted'))
        continue
      }
      const wait = Math.max(0, minGapMs - (now() - last))
      if (wait > 0) await new Promise((r) => timer(r, wait))
      last = now()
      try {
        const res = await send(job.msg)
        q.shift()
        job.resolve(res)
      } catch (e) {
        if (isRateLimitError(e) && job.attempts < maxRetries) {
          job.attempts++
          const retryWait = Number(e.retryAfterMs) > 0 ? Number(e.retryAfterMs) : Math.max(minGapMs, 1000)
          await new Promise((r) => timer(r, retryWait))
          last = now()
          continue
        }
        if (isPermanentSlackError(e)) {
          halted = true
          haltedErr = e
          if (typeof onError === 'function') {
            try { onError(e) } catch { /* reporter must not crash the queue */ }
          }
        } else if (typeof onError === 'function') {
          try { onError(e) } catch { }
        }
        q.shift()
        job.reject(e)
      }
    }
    running = false
  }

  return {
    push: (msg) => {
      if (halted) return Promise.reject(haltedErr || new Error('slack queue halted'))
      return new Promise((resolve, reject) => { q.push({ msg, attempts: 0, resolve, reject }); pump() })
    },
    depth: () => q.length,
    isHalted: () => halted,
    haltedError: () => haltedErr,
  }
}

export const SLACK_TIMEOUT_MS = 15000

/** POST to Slack's Web API. Kept tiny and injectable so the bridge can be tested without a
 *  workspace -- the thing worth testing is our routing, not Slack's HTTP.
 *  Applies a 15s AbortSignal timeout by default so a hung TCP socket never stalls the queue. */
export async function slackPost(
  method,
  body,
  token,
  fetchImpl = fetch,
  apiBase = process.env.HIVE_SLACK_API || DEFAULT_API,
  timeoutMs = Number(process.env.HIVE_SLACK_TIMEOUT_MS) || SLACK_TIMEOUT_MS,
) {
  const r = await fetchImpl(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const retryHeader = r.headers && typeof r.headers.get === 'function' ? Number(r.headers.get('retry-after') || 0) : 0
  const rawScopes = r.headers && typeof r.headers.get === 'function'
    ? r.headers.get('x-oauth-scopes')
    : (r.headers && (r.headers['x-oauth-scopes'] || r.headers['X-OAuth-Scopes']))
  const j = await r.json().catch(() => ({ ok: false, error: r.status === 429 ? 'ratelimited' : 'bad_json' }))
  if (r.status === 429 || (j && j.error === 'ratelimited')) {
    const retrySec = retryHeader || Number(j && j.retry_after) || 1
    const err = new Error(`slack ${method}: ratelimited`)
    err.status = 429
    err.code = 'ratelimited'
    err.slackError = 'ratelimited'
    err.retryAfterMs = retrySec * 1000
    throw err
  }
  if (!j || !j.ok) {
    const code = (j && j.error) || `http_${r.status || 'unknown'}`
    const needed = j && j.needed ? String(j.needed) : ''
    const provided = j && j.provided ? String(j.provided) : ''
    const detail = code === 'missing_scope' && needed ? `${code} (needs ${needed})` : code
    const err = new Error(`slack ${method}: ${detail}`)
    err.status = r.status
    err.code = code
    err.slackError = code
    if (needed) err.needed = needed
    if (provided) err.provided = provided
    throw err
  }
  if (rawScopes !== undefined && rawScopes !== null && j && typeof j === 'object') {
    const parsedScopes = String(rawScopes).split(',').map((s) => s.trim()).filter(Boolean)
    Object.defineProperty(j, '_scopes', { value: parsedScopes, enumerable: false, configurable: true })
  }
  return j
}

/** Reusable threaded Slack sender for both hive-slack.js and hive-github.js.
 *  `threads` is any Map-like store exposing .get(key) and .set(key, ts).
 *  NOTE: open(key, text) and reply(key, text, { broadcast }) never throw on Slack API errors;
 *  they return { ok: true, ts, ... } or { ok: false, error, code, halted }. Always check .ok
 *  on the returned object. */
export function makeSlackThreader({
  token,
  channel,
  threads = new Map(),
  api = process.env.HIVE_SLACK_API || DEFAULT_API,
  post = null,
  minGapMs = 1000,
  maxRetries = 5,
  now = () => Date.now(),
  timer = setTimeout,
  onError = null,
  room = '',
  link = '',
}) {
  const sendImpl = post || ((m) => slackPost('chat.postMessage', m, token, fetch, api))
  const queue = makeQueue({ send: sendImpl, minGapMs, maxRetries, now, timer, onError })
  const opening = new Map() // key -> in-flight open Promise, so synchronous bursts share one root thread

  async function open(key, text) {
    if (queue.isHalted()) return { ok: false, halted: true, error: queue.haltedError()?.message || 'halted' }
    const clean = scrubSlack(text, { room, link })
    if (key && opening.has(key)) {
      try { await opening.get(key) } catch { }
    }
    const existing = key ? threads.get(key) : undefined
    if (existing) return { ok: true, ts: existing, reused: true }
    const run = (async () => {
      const res = await queue.push({ channel, text: clean })
      if (res && res.ts && key) threads.set(key, res.ts)
      return res
    })()
    if (key) opening.set(key, run)
    try {
      const res = await run
      return { ok: true, ts: res && res.ts }
    } catch (e) {
      return { ok: false, error: e.message, code: extractSlackError(e) }
    } finally {
      if (key && opening.get(key) === run) opening.delete(key)
    }
  }

  async function reply(key, text, { broadcast = false } = {}) {
    if (queue.isHalted()) return { ok: false, halted: true, error: queue.haltedError()?.message || 'halted' }
    const clean = scrubSlack(text, { room, link })
    if (key && opening.has(key)) {
      try { await opening.get(key) } catch { }
    }
    const ts = key ? threads.get(key) : undefined
    if (!ts) return open(key, clean)
    try {
      const payload = { channel, text: clean, thread_ts: ts }
      if (broadcast) payload.reply_broadcast = true
      const res = await queue.push(payload)
      return { ok: true, ts: res && res.ts, thread_ts: ts }
    } catch (e) {
      return { ok: false, error: e.message, code: extractSlackError(e) }
    }
  }

  return {
    open,
    reply,
    threads,
    queue,
    halted: () => ({ halted: queue.isHalted(), error: queue.haltedError()?.message || '' }),
  }
}

/** Verify token and channel membership BEFORE printing READY (Q630, Q631). */
export async function preflightSlack({
  token,
  channel,
  api = process.env.HIVE_SLACK_API || DEFAULT_API,
  fetchImpl = fetch,
} = {}) {
  if (!token || !String(token).trim()) {
    return { ok: false, code: 'Q630', error: 'Q630 SLACK_BOT_TOKEN is missing. Set SLACK_BOT_TOKEN=xoxb-… in your environment.' }
  }
  if (!channel || !String(channel).trim()) {
    return { ok: false, code: 'Q631', error: 'Q631 --channel <id> is required (for example: --channel C0123456789).' }
  }
  let auth
  try {
    auth = await slackPost('auth.test', {}, token, fetchImpl, api)
  } catch (e) {
    const why = formatSlackWhy(e)
    return { ok: false, code: 'Q630', error: `Q630 SLACK_BOT_TOKEN was rejected by Slack (${why}). Check the token or reinstall the Slack app.` }
  }
  const botUser = auth.user || 'Hivecode'
  let info
  try {
    info = await slackPost('conversations.info', { channel }, token, fetchImpl, api)
  } catch (e) {
    const why = formatSlackWhy(e)
    return { ok: false, code: 'Q631', error: `Q631 Slack channel ${channel} could not be accessed (${why}). Check the channel ID and run /invite @${botUser} in the channel.` }
  }
  if (info && info.channel && info.channel.is_member === false) {
    const chName = info.channel.name ? `#${info.channel.name}` : channel
    return { ok: false, code: 'Q631', error: `Q631 @${botUser} is not a member of ${chName} (${channel}). In Slack, open ${chName} and run: /invite @${botUser}` }
  }
  const scopes = Array.isArray(auth && auth._scopes)
    ? auth._scopes
    : (Array.isArray(info && info._scopes) ? info._scopes : null)
  const isPrivate = Boolean(
    info && info.channel && (
      info.channel.is_private === true ||
      info.channel.is_group === true ||
      String(channel || '').startsWith('G')
    ),
  )
  return {
    ok: true,
    botUser,
    botUserId: auth.user_id || '',
    team: auth.team || '',
    teamId: auth.team_id || '',
    channelName: (info && info.channel && info.channel.name) || channel,
    isPrivate,
    scopes,
  }
}

/** Return the list of missing inbound scopes (users:read, plus channels:history for public or groups:history for private).
 *  When `scopes` is null/undefined (header absent), returns [] so "unknown" is never treated as "none". */
export function missingInboundScopes({ scopes = null, isPrivate = false, channel = '' } = {}) {
  if (scopes === null || scopes === undefined) return []
  const have = new Set(
    (Array.isArray(scopes) ? scopes : String(scopes || '').split(','))
      .map((s) => String(s || '').trim())
      .filter(Boolean),
  )
  const histScope = (isPrivate || String(channel || '').startsWith('G')) ? 'groups:history' : 'channels:history'
  const missing = []
  if (!have.has('users:read')) missing.push('users:read')
  if (!have.has(histScope)) missing.push(histScope)
  return missing
}

/** Verify that SLACK_BOT_TOKEN has the scopes required for inbound replies (users:read + channels:history or groups:history). */
export function checkInboundScopes({ scopes = null, isPrivate = false, channel = '' } = {}) {
  const missing = missingInboundScopes({ scopes, isPrivate, channel })
  if (missing.length) {
    return {
      ok: false,
      code: 'Q634',
      missingScopes: missing,
      error: `Q634 SLACK_BOT_TOKEN is missing required inbound scope(s): ${missing.join(', ')}. Reinstall your Slack app with slack-app-manifest-inbound.json (docs/SLACK_SETUP.md Section 5).`,
    }
  }
  return { ok: true, missingScopes: [] }
}

/** Return the list of missing Slack Agent surface scopes (chat:write, assistant:write, users:read, plus im:history / channels:history / groups:history).
 *  When `scopes` is null/undefined (header absent), returns [] so "unknown" is never treated as "none". */
export function missingAgentScopes({ scopes = null, isPrivate = false, channel = '' } = {}) {
  if (scopes === null || scopes === undefined) return []
  const have = new Set(
    (Array.isArray(scopes) ? scopes : String(scopes || '').split(','))
      .map((s) => String(s || '').trim())
      .filter(Boolean),
  )
  const ch = String(channel || '').trim()
  const histScope = (!ch || ch.startsWith('D'))
    ? 'im:history'
    : ((isPrivate || ch.startsWith('G')) ? 'groups:history' : 'channels:history')
  const required = ['chat:write', 'assistant:write', histScope, 'users:read']
  return required.filter((s) => !have.has(s))
}

/** Verify that SLACK_BOT_TOKEN has the scopes required for the Slack Agent surface (hive-slack-agent.js). */
export function checkAgentScopes({ scopes = null, isPrivate = false, channel = '' } = {}) {
  const missing = missingAgentScopes({ scopes, isPrivate, channel })
  if (missing.length) {
    return {
      ok: false,
      code: 'Q634',
      missingScopes: missing,
      error: `Q634 SLACK_BOT_TOKEN is missing required agent scope(s): ${missing.join(', ')}. Reinstall your Slack app with slack-app-manifest-agent.json (docs/SLACK_SETUP.md Section 5).`,
    }
  }
  return { ok: true, missingScopes: [] }
}

/** Read Slack warnings from both shapes Slack uses: top-level `warning` string and `response_metadata.warnings[]`. */
export function extractSlackWarnings(res) {
  if (!res || typeof res !== 'object') return []
  const out = []
  if (typeof res.warning === 'string' && res.warning.trim()) {
    for (const w of res.warning.split(',')) {
      if (w.trim()) out.push(w.trim())
    }
  }
  const metaWarnings = res.response_metadata && Array.isArray(res.response_metadata.warnings)
    ? res.response_metadata.warnings
    : []
  for (const w of metaWarnings) {
    if (typeof w === 'string' && w.trim() && !out.includes(w.trim())) out.push(w.trim())
  }
  return out
}

/** Verify SLACK_APP_TOKEN (xapp-…) with apps.connections.open (and inbound bot scopes when passed) before READY (Q634). */
export async function preflightSocketMode({
  appToken,
  scopes = null,
  isPrivate = false,
  channel = '',
  api = process.env.HIVE_SLACK_API || DEFAULT_API,
  fetchImpl = fetch,
} = {}) {
  if (!appToken || !String(appToken).trim()) {
    return {
      ok: false,
      code: 'Q634',
      error: 'Q634 SLACK_APP_TOKEN is missing. Set SLACK_APP_TOKEN=xapp-… (with connections:write scope) to enable inbound Socket Mode.',
    }
  }
  if (scopes !== null && scopes !== undefined) {
    const sc = checkInboundScopes({ scopes, isPrivate, channel })
    if (!sc.ok) return sc
  }
  try {
    const res = await slackPost('apps.connections.open', {}, appToken, fetchImpl, api)
    if (!res || !res.url) {
      return { ok: false, code: 'Q634', error: 'Q634 Slack apps.connections.open did not return a WebSocket URL.' }
    }
    return { ok: true, url: res.url }
  } catch (e) {
    const why = extractSlackError(e) || e.message
    return {
      ok: false,
      code: 'Q634',
      error: `Q634 SLACK_APP_TOKEN was rejected by Slack (${why}). Enable Socket Mode and generate an App-Level Token (xapp-…) with connections:write.`,
    }
  }
}

/** Connect to Slack Socket Mode over ws. Immediately acknowledges every envelope_id (<3s),
 *  deduplicates event_id across reconnects, reconnects on Slack's periodic disconnect frame,
 *  and halts on permanent token errors. */
export async function connectSocketMode({
  appToken,
  initialUrl = '',
  api = process.env.HIVE_SLACK_API || DEFAULT_API,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  onEvent,
  onError = null,
  onMultiConnection = null,
  logErr = console.error,
  reconnectDelayMs = 1000,
  helloTimeoutMs = Number(process.env.HIVE_SLACK_HELLO_TIMEOUT_MS) || 10000,
  startRetryMs = Number(process.env.HIVE_SLACK_START_RETRY_MS) || 60000,
  startRetryDelayMs = 1000,
  timer = setTimeout,
} = {}) {
  let ws = null
  let stopped = false
  let halted = false
  let reconnectTimer = null
  const seenEvents = new Set()
  let lastCloseTime = 0
  let warnedMulti = false

  function rememberEvent(id) {
    if (!id) return false
    if (seenEvents.has(id)) return true
    seenEvents.add(id)
    if (seenEvents.size > MAX_SEEN_EVENTS) {
      const oldest = seenEvents.values().next().value
      seenEvents.delete(oldest)
    }
    return false
  }

  function wireSocket(sock) {
    sock.on('message', (raw) => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      // Acknowledge every envelope immediately (<3s) so Slack never retries and duplicates a stop/reply.
      if (frame && frame.envelope_id) {
        try { sock.send(JSON.stringify({ envelope_id: frame.envelope_id })) } catch { }
      }
      if (!frame) return
      if (frame.type === 'hello') {
        const num = Number(frame.num_connections) || 1
        const isOwnLingering = (num === 2 && (Date.now() - lastCloseTime < 15000))
        if (num > 1 && !isOwnLingering) {
          if (!warnedMulti) {
            warnedMulti = true
            if (typeof logErr === 'function') {
              try {
                logErr(`WARNING: Slack Socket Mode reports ${num} active connections on this SLACK_APP_TOKEN. Events may go to another process (check for another terminal running "hivecode-mcp slack start", "github start --slack-allow", or "hive-slack-agent").`)
              } catch { }
            }
            if (typeof onMultiConnection === 'function') {
              try { onMultiConnection(num) } catch { }
            }
          }
        } else if (num <= 1) {
          warnedMulti = false
        }
        return
      }
      if (frame.type === 'disconnect') {
        try { sock.close() } catch { }
        return
      }
      const evId = (frame.payload && frame.payload.event_id) || frame.envelope_id || ''
      if (evId && rememberEvent(evId)) return
      const ev = frame.payload && frame.payload.event
      if (ev && typeof onEvent === 'function') {
        Promise.resolve(onEvent(ev, frame.payload)).catch((e) => {
          if (typeof onError === 'function') { try { onError(e) } catch { } }
        })
      }
    })

    sock.on('error', (e) => {
      if (typeof onError === 'function') { try { onError(e) } catch { } }
    })

    sock.on('close', () => {
      lastCloseTime = Date.now()
      if (ws === sock) ws = null
      if (!stopped && !halted) {
        reconnectTimer = timer(() => openSocket(''), reconnectDelayMs)
      }
    })
  }

  async function openSocket(firstUrl = '') {
    if (stopped || halted) return
    let url = firstUrl
    if (!url) {
      try {
        const res = await slackPost('apps.connections.open', {}, appToken, fetchImpl, api)
        url = res && res.url
      } catch (e) {
        if (isPermanentSlackError(e)) {
          halted = true
          if (typeof onError === 'function') { try { onError(e) } catch { } }
          return
        }
        if (typeof onError === 'function') { try { onError(e) } catch { } }
        if (!stopped) reconnectTimer = timer(() => openSocket(''), reconnectDelayMs)
        return
      }
    }
    if (!url || stopped || halted) return
    const sock = new WebSocketImpl(url)
    ws = sock
    wireSocket(sock)
  }

  // Initial connection handshake with startRetryMs retry for transient socket/network errors and num_connections > 1
  const startTime = Date.now()
  let currentUrl = initialUrl
  let lastWhy = ''
  let lastNum = 1
  let warnedRetry = false

  while (true) {
    if (stopped || halted) return { stop: () => {}, isHalted: () => true }
    if (!currentUrl) {
      try {
        const res = await slackPost('apps.connections.open', {}, appToken, fetchImpl, api)
        currentUrl = res && res.url
      } catch (e) {
        if (isPermanentSlackError(e)) {
          halted = true
          throw e
        }
        lastWhy = extractSlackError(e) || e.message
        const elapsed = Date.now() - startTime
        if (elapsed < startRetryMs) {
          if (!warnedRetry && typeof logErr === 'function') {
            warnedRetry = true
            try { logErr(`Slack Socket Mode could not connect (${lastWhy}); retrying for up to ${Math.round(startRetryMs / 1000)} s...`) } catch { }
          }
          await new Promise((r) => timer(r, Math.min(startRetryDelayMs, startRetryMs - elapsed)))
          continue
        }
        halted = true
        stopped = true
        const err = new Error(`Q634 Socket Mode could not connect: ${lastWhy}`)
        err.code = 'Q634'
        throw err
      }
    }
    if (!currentUrl) {
      const err = new Error('Q634 Slack apps.connections.open did not return a WebSocket URL.')
      err.code = 'Q634'
      throw err
    }

    let sock = null
    const handshake = await new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(hTimer)
        resolve(result)
      }
      const hTimer = timer(() => finish({ type: 'timeout', reason: 'no hello frame received within timeout' }), helloTimeoutMs)
      try {
        sock = new WebSocketImpl(currentUrl)
      } catch (e) {
        finish({ type: 'error', error: e, reason: e.message })
        return
      }
      ws = sock

      const onMsg = (raw) => {
        let frame
        try { frame = JSON.parse(String(raw)) } catch { return }
        if (frame && frame.envelope_id) {
          try { sock.send(JSON.stringify({ envelope_id: frame.envelope_id })) } catch { }
        }
        if (!frame) return
        if (frame.type === 'hello') {
          finish({ type: 'hello', frame, sock, onMsg, onErr, onClose })
          return
        }
      }

      const onErr = (e) => {
        finish({ type: 'error', error: e, reason: e.message || String(e) })
      }

      const onClose = () => {
        lastCloseTime = Date.now()
        finish({ type: 'close', reason: 'connection closed before receiving hello frame' })
      }

      sock.on('message', onMsg)
      sock.on('error', onErr)
      sock.on('close', onClose)
    })

    if (handshake.type === 'hello') {
      const num = Number(handshake.frame && handshake.frame.num_connections) || 1
      lastNum = num
      if (num <= 1) {
        wireSocket(handshake.sock)
        try {
          handshake.sock.removeListener('message', handshake.onMsg)
          handshake.sock.removeListener('close', handshake.onClose)
          handshake.sock.removeListener('error', handshake.onErr)
        } catch { }
        break
      }

      lastWhy = `${num} active connections`
      const elapsed = Date.now() - startTime
      if (elapsed < startRetryMs) {
        if (!warnedRetry && typeof logErr === 'function') {
          warnedRetry = true
          try { logErr(`Slack reports ${num} connections on this app token; waiting up to ${Math.round(startRetryMs / 1000)} s for the other to drop...`) } catch { }
        }
        try { handshake.sock.removeAllListeners && handshake.sock.removeAllListeners() } catch { }
        try { handshake.sock.close() } catch { }
        const waitTime = Math.min(startRetryDelayMs, Math.max(50, startRetryMs - elapsed))
        await new Promise((r) => timer(r, waitTime))
        currentUrl = initialUrl || ''
        continue
      }

      halted = true
      stopped = true
      try { handshake.sock.close() } catch { }
      const err = new Error(`Q635 Another process is already connected to Slack Socket Mode with this SLACK_APP_TOKEN (${num} active connections). Slack distributes incoming events across connections, so messages and "stop" commands may go to the other process. Check for another terminal or service running "hivecode-mcp slack start", "github start --slack-allow", or "hive-slack-agent" with the same app token. If you just stopped a bridge, wait a minute for Slack to release the connection and start again.`)
      err.code = 'Q635'
      throw err
    }

    // Handshake failed (socket error, timeout, or close-before-hello)
    lastWhy = handshake.reason || (handshake.error && handshake.error.message) || 'could not connect'
    if (sock) {
      try { sock.removeAllListeners && sock.removeAllListeners() } catch { }
      try { sock.close() } catch { }
      try { sock.terminate && sock.terminate() } catch { }
    }

    const elapsed = Date.now() - startTime
    if (elapsed < startRetryMs) {
      if (!warnedRetry && typeof logErr === 'function') {
        warnedRetry = true
        try { logErr(`Slack Socket Mode could not connect (${lastWhy}); retrying for up to ${Math.round(startRetryMs / 1000)} s...`) } catch { }
      }
      const waitTime = Math.min(startRetryDelayMs, Math.max(50, startRetryMs - elapsed))
      await new Promise((r) => timer(r, waitTime))
      currentUrl = initialUrl || ''
      continue
    }

    halted = true
    stopped = true
    const err = new Error(`Q634 Socket Mode could not connect: ${lastWhy}`)
    err.code = 'Q634'
    throw err
  }

  return {
    stop: () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) { try { ws.close() } catch { } ws = null }
    },
    isHalted: () => halted,
  }
}

/** Pause every AI in the room (excluding the bridge itself when skipName is given). */
export function stopAll(hive, by = 'slack', skipName = '') {
  const done = []
  for (const p of (hive.members ? hive.members() : [])) {
    if (p.kind !== 'ai' || (skipName && p.name === skipName)) continue
    hive.control(p.name, 'paused', by)
    done.push(p.name)
  }
  return done
}

export function resumeAll(hive, by = 'slack', skipName = '') {
  const done = []
  for (const p of (hive.members ? hive.members() : [])) {
    if (p.kind !== 'ai' || (skipName && p.name === skipName)) continue
    hive.control(p.name, 'running', by)
    done.push(p.name)
  }
  return done
}

/** Find the room's real spelling of a participant name (case-insensitive). */
export function resolveName(hive, who) {
  const want = String(who || '').toLowerCase()
  for (const p of (hive.members ? hive.members() : [])) {
    if (String(p.name).toLowerCase() === want) return p.name
  }
  return null
}

/** Turn a typed prompt into a deterministic control/status intent. */
export function route(text) {
  const s = String(text || '').trim().toLowerCase()
  let m
  if ((m = s.match(/^(?:resume|unpause|start|continue)\s+(?:agent\s+)?([a-z0-9_.-]+)$/))) {
    return m[1] === 'all' || m[1] === 'everything' ? { intent: 'resume-all' } : { intent: 'resume', who: m[1] }
  }
  if ((m = s.match(/^(?:stop|pause|halt|kill)\s+(?:agent\s+)?([a-z0-9_.-]+)$/))) {
    return m[1] === 'all' || m[1] === 'everything' ? { intent: 'stop-all' } : { intent: 'stop', who: m[1] }
  }
  if (/^(stop|pause|halt|stop it|stop them|shut it down)\b/.test(s)) return { intent: 'stop-all' }
  if (/^(resume|unpause|carry on|keep going)\b/.test(s)) return { intent: 'resume-all' }
  if (/status|what.*(running|happening|going on)|who.*(here|working)|overnight/.test(s)) return { intent: 'status' }
  return { intent: 'ask', text: String(text || '') }
}

/** Never let a Slack display name impersonate a room member: always attribute as slack:<handle>. */
export function formatSlackSender(handleOrUser) {
  const raw = String(handleOrUser || 'user').trim().replace(/^slack:/i, '')
  const clean = raw.replace(/[^A-Za-z0-9_.-]/g, '') || 'user'
  return `slack:${clean}`
}

/** Refuse to run a second bridge under the same name in the same room (Q632). */
export function checkDuplicateBridge(hive, botName = 'SlackBridge') {
  let dupes = []
  try { dupes = hive && typeof hive.sameNameElsewhere === 'function' ? hive.sameNameElsewhere() : [] } catch { dupes = [] }
  if (dupes.length) {
    return {
      ok: false,
      code: 'Q632',
      error: `Q632 Another Slack bridge (${botName}) is already running in this room. Stop the other bridge before starting a new one so events are not posted twice.`,
    }
  }
  return { ok: true }
}

/** What a room event looks like in Slack. Plain text on purpose: blocks render badly in
 *  notifications and thread previews, which is where most of these are actually read. */
export function render(ev) {
  if (ev.kind === 'task-open') return `:inbox_tray: *${ev.text || ev.task}*  —  assigned to *${ev.to}*`
  if (ev.kind === 'task-done') return `:white_check_mark: *${ev.text || ev.task}* — done by *${ev.by}*`
  if (ev.kind === 'gate-fail') return `:no_entry: gate failed for *${ev.by}* on \`${ev.file}\` — the file stays with them, nobody downstream gets it`
  if (ev.kind === 'gate-pass') return `:heavy_check_mark: gate passed for *${ev.by}* on \`${ev.file}\``
  if (ev.kind === 'chat') return `*${ev.by}*: ${ev.text}`
  return `${ev.kind}: ${ev.text || ''}`
}

/** Which events reach the CHANNEL, and which only ever go inside a thread.
 *  Getting this wrong is the difference between a useful feed and a muted one. */
export const TO_CHANNEL = new Set(['task-open', 'task-done'])

export const USER_CACHE_TTL_MS = 10 * 60 * 1000

/** Shared Slack actor verification and asymmetric authorization (used by both hive-slack.js
 *  and hive-github.js):
 *  - caches verified users.info results for ttlMs (default 10 minutes); lookup failures are not cached
 *  - refuses bots, deleted users, guests (is_restricted / is_ultra_restricted / is_stranger),
 *    and external Slack Connect users (team_id !== teamId)
 *  - allows 'stop' / 'stop-all' for any full workspace member, AND fails open with unverified: true
 *    ("stopped; I could not confirm who you are") if users.info failed during an outage
 *  - allows 'resume' / 'retry' / 'reply' only when actor.ok === true AND userId is in allow */
export function makeSlackActorCheck({
  token,
  teamId = '',
  api = process.env.HIVE_SLACK_API || DEFAULT_API,
  fetchImpl = fetch,
  lookupUser = null,
  ttlMs = USER_CACHE_TTL_MS,
  now = () => Date.now(),
  allowFlag = '--allow',
} = {}) {
  const userCache = new Map() // userId -> { value, expiresAt }

  function put(userId, value) {
    userCache.set(userId, { value, expiresAt: now() + ttlMs })
    return value
  }

  async function resolve(userId) {
    if (!userId) return { ok: false, userId: '', reason: 'missing_user' }
    const cached = userCache.get(userId)
    if (cached) {
      if (now() < cached.expiresAt) return cached.value
      userCache.delete(userId)
    }
    let res
    try {
      res = lookupUser
        ? await lookupUser(userId)
        : await slackPost('users.info', { user: userId }, token, fetchImpl, api)
    } catch (e) {
      return { ok: false, userId, handle: userId, reason: 'lookup_failed', error: e.message }
    }
    const u = res && res.user
    if (!u || u.deleted || u.is_bot) {
      return put(userId, { ok: false, userId, isBot: Boolean(u && u.is_bot), reason: 'bot_or_deleted' })
    }
    const handle = u.name || (u.profile && u.profile.display_name) || userId
    if (u.is_restricted || u.is_ultra_restricted || u.is_stranger) {
      return put(userId, { ok: false, userId, handle, reason: 'guest' })
    }
    if (teamId && u.team_id && u.team_id !== teamId) {
      return put(userId, { ok: false, userId, handle, reason: 'external_team' })
    }
    return put(userId, { ok: true, userId, handle, teamId: u.team_id || '' })
  }

  function mayAct(actor, action, allow = []) {
    if (!actor || actor.isBot) {
      return { ok: false, ignored: true, unverified: false, reason: 'bot_or_empty', by: '', reply: '' }
    }
    const uid = actor.userId || ''
    const allowSet = allow instanceof Set
      ? allow
      : new Set(
          (Array.isArray(allow) ? allow : String(allow || '').split(','))
            .map((s) => String(s || '').trim())
            .filter(Boolean),
        )
    const isStop = action === 'stop' || action === 'stop-all'
    const by = formatSlackSender(actor.handle || uid || 'user')

    if (!actor.ok) {
      if (actor.reason === 'lookup_failed' && isStop) {
        return { ok: true, unverified: true, by, reply: 'stopped; I could not confirm who you are' }
      }
      const reply = actor.reason === 'lookup_failed'
        ? `:no_entry: Refused: could not verify your Slack user (${uid || 'unknown'}) via users.info.`
        : `:no_entry: Refused: guests and external Slack Connect users cannot control or message this room.`
      return { ok: false, unverified: false, refused: actor.reason, by, reply }
    }

    if (isStop) {
      return { ok: true, unverified: false, by, reply: '' }
    }

    if (!allowSet.has(uid)) {
      return {
        ok: false,
        unverified: false,
        refused: 'not_in_allow',
        by,
        reply: `:no_entry: Refused: only Slack user IDs listed in ${allowFlag} may resume/retry agents or send replies into the room (your ID: \`${uid}\`). Any full workspace member may still type \`stop\`.`,
      }
    }

    return { ok: true, unverified: false, by, reply: '' }
  }

  return { resolve, mayAct }
}

/** Parse and validate Slack member ids from --allow or SLACK_ALLOW (Q634).
 *  Refuses anything not matching /^[UW][A-Z0-9]{2,}$/ (e.g. usernames or handles). */
export function parseSlackAllow(allowRaw, flag = '--allow') {
  const raw = Array.isArray(allowRaw) ? allowRaw.join(',') : String(allowRaw || '').trim()
  if (!raw) return { ok: true, ids: [] }
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const notIds = list.filter((s) => !/^[UW][A-Z0-9]{2,}$/.test(s))
  if (notIds.length) {
    return {
      ok: false,
      code: 'Q634',
      error: `Q634 ${flag} takes Slack member ids like U012AB3CD, not ${notIds.join(', ')}. In Slack, open the person's profile, click More, then Copy member ID.`,
    }
  }
  return { ok: true, ids: list }
}

export const validateSlackAllow = parseSlackAllow

export function makeBridge({
  hive,
  channel,
  token,
  post,
  botName = 'SlackBridge',
  onError = null,
  room = '',
  link = '',
  allow = [],
  teamId = '',
  botUserId = '',
  lookupUser = null,
  minGapMs = 1000,
  now = () => Date.now(),
  userCacheTtlMs = USER_CACHE_TTL_MS,
  api = process.env.HIVE_SLACK_API || DEFAULT_API,
  fetchImpl = fetch,
}) {
  const threads = hive.doc.getMap('slack_threads')   // task id -> thread_ts, shared + durable
  const seen = new Set()
  const allowSet = new Set(
    (Array.isArray(allow) ? allow : String(allow || '').split(','))
      .map((s) => String(s || '').trim())
      .filter(Boolean),
  )
  const actorCheck = makeSlackActorCheck({
    token,
    teamId,
    api,
    fetchImpl,
    lookupUser,
    ttlMs: userCacheTtlMs,
    now,
  })
  let reportedFatal = false

  const handleFatal = (e) => {
    if (typeof onError === 'function') onError(e)
    if (!reportedFatal && isPermanentSlackError(e)) {
      reportedFatal = true
      console.error(`[hive-slack] STOPPED POSTING: ${e.message}`)
    }
  }

  const threader = makeSlackThreader({
    token,
    channel,
    threads,
    post,
    minGapMs,
    onError: handleFatal,
    room: room || (hive && hive.room) || '',
    link,
  })
  const { queue } = threader

  async function emit(ev) {
    if (queue.isHalted()) return { ok: false, halted: true }
    const text = scrubSlack(render(ev), { room: room || (hive && hive.room) || '', link })
    if (ev.task) {
      // A task's first event opens the thread; everything after lands inside it. The outcome
      // (TO_CHANNEL) is also broadcast, so the channel sees "done" without anyone opening the thread.
      return threader.reply(ev.task, text, { broadcast: TO_CHANNEL.has(ev.kind) })
    }
    // Untasked events (general room chat): open one shared __room__ thread on the first message,
    // and route every subsequent untasked chat inside it so chatter never floods the channel.
    if (!TO_CHANNEL.has(ev.kind)) {
      return threader.reply(ROOM_THREAD_KEY, text)
    }
    return queue.push({ channel, text })
  }

  function onChat(msgs, startIdx = null) {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (!m || !m.text) continue
      // THE ECHO GUARD. Anything this bridge itself put into the room must never go back out,
      // or a Slack reply becomes a room message becomes a Slack message, forever.
      if (m.by === botName || m.viaSlack) continue
      const key = `${m.by}|${m.at}|${m.text}`
      if (seen.has(key)) continue
      seen.add(key)
      if (typeof startIdx === 'number') {
        const nextCursor = startIdx + i + 1
        if (nextCursor > (Number(threads.get(CURSOR_KEY)) || 0)) threads.set(CURSOR_KEY, nextCursor)
      }
      emit({ kind: 'chat', by: m.by, text: m.text, task: m.task }).catch((e) => handleFatal(e))
    }
  }

  /** A human replied in a Slack thread. Put it into the room, addressed, attributed as
   *  `slack:<handle>` (never bare member name, preventing impersonation), and marked `viaSlack`
   *  so the echo guard above will not send it straight back to Slack. */
  function deliver({ thread_ts, text, user }) {
    let task = null
    for (const [id, ts] of threads.entries()) {
      if (id === ROOM_THREAD_KEY || id === CURSOR_KEY) continue
      if (ts === thread_ts) { task = id; break }
    }
    const addressed = /^@/.test(text.trim()) ? text.trim() : text.trim()
    const by = formatSlackSender(user || 'user')
    hive.doc.getArray('chat').push([{
      by, kind: 'say', at: Date.now() * 1000, text: addressed, task, viaSlack: true,
    }])
    return { ok: true, task, by }
  }

  async function replyInThread(thread_ts, text) {
    const clean = scrubSlack(text, { room: room || (hive && hive.room) || '', link })
    try {
      const payload = thread_ts ? { channel, text: clean, thread_ts } : { channel, text: clean }
      await queue.push(payload)
    } catch (e) {
      handleFatal(e)
    }
  }

  /** Handle an inbound Socket Mode event (`message` or `agent_session_stopped`).
   *  Asymmetric authorization via makeSlackActorCheck:
   *  - Guests (`is_restricted` / `is_ultra_restricted`) and Slack Connect users from other workspaces
   *    (`team_id !== teamId`) are refused for everything.
   *  - STOP (`stop`, `stop all`, `stop <Agent>`, or `agent_session_stopped`) is fail-safe: any full
   *    workspace member may stop agents, and if `users.info` fails during an outage/rate-limit,
   *    `stop` still goes through ("stopped; I could not confirm who you are").
   *  - RESUME and thread replies into the room require `ev.user` to be in `--allow U123,U456`. */
  async function onInboundEvent(ev) {
    if (!ev) return { ok: false, ignored: 'empty' }
    if (ev.bot_id || ev.subtype || (botUserId && ev.user === botUserId)) {
      return { ok: false, ignored: 'bot_or_subtype' }
    }
    if (ev.channel && channel && ev.channel !== channel) {
      return { ok: false, ignored: 'wrong_channel' }
    }
    const replyTs = ev.thread_ts || ev.ts || threads.get(ROOM_THREAD_KEY) || undefined
    const r = ev.type === 'message' && ev.text ? route(ev.text) : null
    const isStopAction =
      ev.type === 'agent_session_stopped' ||
      Boolean(r && (r.intent === 'stop-all' || r.intent === 'stop'))

    const actor = await actorCheck.resolve(ev.user)
    if (actor.isBot) return { ok: false, ignored: 'bot_user' }

    if (isStopAction) {
      const check = actorCheck.mayAct(actor, 'stop', allowSet)
      if (!check.ok) {
        if (check.reply) await replyInThread(replyTs, check.reply)
        return { ok: false, refused: check.refused || actor.reason }
      }
      const sender = check.by
      const unverifiedStop = Boolean(check.unverified)
      const unverifiedNote = unverifiedStop ? ` (${check.reply})` : ''

      if (ev.type === 'agent_session_stopped' || (r && r.intent === 'stop-all')) {
        const who = stopAll(hive, sender, botName)
        await replyInThread(
          replyTs,
          who.length
            ? `:octagonal_sign: *${sender}* paused *${who.join('*, *')}*. Nothing new will be picked up.${unverifiedNote}`
            : 'No agents to pause.',
        )
        return { ok: true, action: 'stop-all', stopped: who, by: sender, unverified: unverifiedStop && who.length > 0 }
      }
      const real = resolveName(hive, r.who)
      if (!real || real === botName) {
        const here = (hive.members ? hive.members() : []).filter((p) => p.name !== botName).map((p) => p.name).join(', ') || 'nobody'
        await replyInThread(replyTs, `:no_entry: I do not see *${r.who}* in this room. Here right now: ${here}.`)
        return { ok: false, refused: 'unknown_agent' }
      }
      hive.control(real, 'paused', sender)
      await replyInThread(replyTs, `:octagonal_sign: *${sender}* paused *${real}*.${unverifiedNote}`)
      return { ok: true, action: 'stop', who: real, by: sender, unverified: unverifiedStop }
    }

    if (!actor.ok) {
      const check = actorCheck.mayAct(actor, 'reply', allowSet)
      if (check.reply) await replyInThread(replyTs, check.reply)
      return { ok: false, refused: check.refused || actor.reason }
    }

    if (ev.type !== 'message' || !ev.text || !r) return { ok: false, ignored: 'unsupported_event' }

    // RESUME requires --allow <U123,U456>.
    if (r.intent === 'resume-all' || r.intent === 'resume') {
      const check = actorCheck.mayAct(actor, 'resume', allowSet)
      if (!check.ok) {
        if (check.reply) await replyInThread(replyTs, check.reply)
        return { ok: false, refused: check.refused || 'not_in_allow' }
      }
      const sender = check.by
      if (r.intent === 'resume-all') {
        const who = resumeAll(hive, sender, botName)
        await replyInThread(
          replyTs,
          who.length ? `:arrow_forward: *${sender}* resumed *${who.join('*, *')}*.` : 'No agents to resume.',
        )
        return { ok: true, action: 'resume-all', resumed: who, by: sender }
      }
      const real = resolveName(hive, r.who)
      if (!real || real === botName) {
        const here = (hive.members ? hive.members() : []).filter((p) => p.name !== botName).map((p) => p.name).join(', ') || 'nobody'
        await replyInThread(replyTs, `:no_entry: I do not see *${r.who}* in this room. Here right now: ${here}.`)
        return { ok: false, refused: 'unknown_agent' }
      }
      hive.control(real, 'running', sender)
      await replyInThread(replyTs, `:arrow_forward: *${sender}* resumed *${real}*.`)
      return { ok: true, action: 'resume', who: real, by: sender }
    }

    // Thread replies into the room require a tracked thread_ts AND --allow <U123,U456>.
    if (!ev.thread_ts) return { ok: false, ignored: 'not_in_thread' }
    let knownThread = ev.thread_ts === threads.get(ROOM_THREAD_KEY)
    if (!knownThread) {
      for (const [id, ts] of threads.entries()) {
        if (id !== CURSOR_KEY && ts === ev.thread_ts) { knownThread = true; break }
      }
    }
    if (!knownThread) return { ok: false, ignored: 'untracked_thread' }
    const check = actorCheck.mayAct(actor, 'reply', allowSet)
    if (!check.ok) {
      if (check.reply) await replyInThread(ev.thread_ts, check.reply)
      return { ok: false, refused: check.refused || 'not_in_allow' }
    }
    const d = deliver({ thread_ts: ev.thread_ts, text: ev.text, user: check.by })
    return { ok: true, action: 'reply', task: d.task, by: d.by }
  }

  // ---- the room's own events: tasks and gates ------------------------------------------------
  // `slack start` used to watch the chat and nothing else, so task-open / task-done / gate-pass /
  // gate-fail were rendered by render() and never sent by anything. What was announced is kept in
  // ROOM STATE (slack_seen), so a restarted bridge does not say it all again. The first time a
  // bridge ever attaches to a room it only records what is already there: announcing a room's
  // whole history on first start would flood the channel.
  const announced = hive.doc.getMap('slack_seen')
  function unannounced() {
    const baseline = !announced.has('__init__')
    const out = []
    const note = (key, ev) => { if (announced.has(key)) return; announced.set(key, 1); if (!baseline && ev) out.push(ev) }
    for (const t of hive.doc.getMap('tasks').values()) {
      if (!t || !t.id) continue
      note(`task-open|${t.id}`, { kind: 'task-open', task: t.id, to: t.to, by: t.by, text: t.text })
      if (t.status === 'done') note(`task-done|${t.id}`, { kind: 'task-done', task: t.id, by: t.to, text: t.text })
    }
    hive.doc.getMap('gate_results').forEach((v, k) => {
      if (!v) return
      // A forced release already says so in room chat, which the bridge carries over.
      note(`gate|${k}|${v.at}`, v.forced ? null : { kind: v.pass ? 'gate-pass' : 'gate-fail', by: v.by, file: v.region })
    })
    if (baseline) announced.set('__init__', 1)
    return out
  }

  /** Announce task and gate changes from now on. Resolves once the current state has been handled. */
  async function watchRoom() {
    const pass = async () => {
      for (const ev of unannounced()) {
        try { await emit(ev) } catch (e) { handleFatal(e) }
      }
    }
    let chain = pass()
    const kick = () => { chain = chain.then(pass) }
    const tasks = hive.doc.getMap('tasks')
    const gates = hive.doc.getMap('gate_results')
    tasks.observe(kick)
    gates.observe(kick)
    await chain
    return { stop: () => { try { tasks.unobserve(kick); gates.unobserve(kick) } catch { } } }
  }

  const postChannel = (text) => queue.push({ channel, text })

  return { emit, onChat, deliver, onInboundEvent, watchRoom, threads, queue, threader, postChannel }
}

export async function runSlackCheck({
  token = '',
  appToken = '',
  channel = '',
  agent = false,
  timeoutMs = 120000,
  helloTimeoutMs = Number(process.env.HIVE_SLACK_HELLO_TIMEOUT_MS) || 10000,
  startRetryMs = Number(process.env.HIVE_SLACK_START_RETRY_MS) || 60000,
  startRetryDelayMs = 1000,
  api = process.env.HIVE_SLACK_API || DEFAULT_API,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  log = console.log,
  logErr = console.error,
} = {}) {
  if (!token || !String(token).trim()) {
    logErr('Q630 SLACK_BOT_TOKEN is missing. Set SLACK_BOT_TOKEN=xoxb-… in your environment.')
    return 1
  }
  if (!channel || !String(channel).trim()) {
    logErr('Q631 --channel <id> is required (for example: --channel C0123456789).')
    return 2
  }
  if (agent && (!appToken || !String(appToken).trim())) {
    logErr('Q634 --agent requires SLACK_APP_TOKEN=xapp-… (with connections:write scope) for Socket Mode.')
    return 1
  }

  // 1. Token (auth.test)
  let auth
  try {
    auth = await slackPost('auth.test', {}, token, fetchImpl, api)
  } catch (e) {
    logErr(`Q630 SLACK_BOT_TOKEN was rejected by Slack (${formatSlackWhy(e)}). Check the token or reinstall the Slack app.`)
    return 1
  }
  const botUser = auth.user || 'Hivecode'
  const botUserId = auth.user_id || ''
  log(`✓ token: @${botUser} (${botUserId || 'bot'})`)

  // 2. Workspace
  if (!auth.team_id) {
    logErr('Q634 Slack auth.test did not return a workspace team_id. Reinstall the Slack app.')
    return 1
  }
  log(`✓ workspace: ${auth.team || auth.team_id} (${auth.team_id})`)

  // 3. Channel & membership (conversations.info)
  let info
  try {
    info = await slackPost('conversations.info', { channel }, token, fetchImpl, api)
  } catch (e) {
    logErr(`Q631 Slack channel ${channel} could not be accessed (${formatSlackWhy(e)}). Check the channel ID and run /invite @${botUser} in the channel.`)
    return 1
  }
  if (info && info.channel && info.channel.is_member === false) {
    const chName = info.channel.name ? `#${info.channel.name}` : channel
    logErr(`Q631 @${botUser} is not a member of ${chName} (${channel}). In Slack, open ${chName} and run: /invite @${botUser}`)
    return 1
  }
  const channelName = (info && info.channel && info.channel.name) || channel
  const isPrivate = Boolean(
    info && info.channel && (
      info.channel.is_private === true ||
      info.channel.is_group === true ||
      String(channel || '').startsWith('G')
    ),
  )
  log(`✓ channel: #${channelName} (${channel}, member)`)

  // 4. Scopes (x-oauth-scopes)
  const scopes = Array.isArray(auth && auth._scopes)
    ? auth._scopes
    : (Array.isArray(info && info._scopes) ? info._scopes : null)
  if (scopes === null) {
    log('- scopes: x-oauth-scopes header not returned by server (not verified)')
  } else if (agent) {
    const agCheck = checkAgentScopes({ scopes, isPrivate, channel })
    if (!agCheck.ok) {
      logErr(agCheck.error)
      return 1
    }
    log(`✓ scopes (outbound + inbound + agent): ${scopes.join(', ')}`)
  } else {
    const have = new Set(scopes)
    const readScope = isPrivate ? 'groups:read' : 'channels:read'
    const outMissing = []
    if (!have.has('chat:write')) outMissing.push('chat:write')
    if (!have.has(readScope)) outMissing.push(readScope)
    if (outMissing.length) {
      logErr(`Q630 SLACK_BOT_TOKEN is missing required outbound scope(s): ${outMissing.join(', ')}. Reinstall your Slack app from slack-app-manifest.json.`)
      return 1
    }
    if (appToken) {
      const inCheck = checkInboundScopes({ scopes, isPrivate, channel })
      if (!inCheck.ok) {
        logErr(inCheck.error)
        return 1
      }
      log(`✓ scopes (outbound + inbound): ${scopes.join(', ')}`)
    } else {
      log(`✓ scopes (outbound): ${scopes.join(', ')} (SLACK_APP_TOKEN not set; inbound reply check skipped)`)
    }
  }

  // Outbound-only mode (when SLACK_APP_TOKEN is not set): verify outbound post + thread reply, never claim inbound replies work
  if (!appToken || !String(appToken).trim()) {
    log(`This posts one message in #${channelName} (and one reply in its thread)`)
    try {
      const rootPost = await slackPost('chat.postMessage', { channel, text: 'Hivecode check: outbound posting works.' }, token, fetchImpl, api)
      if (rootPost && rootPost.ts) {
        await slackPost('chat.postMessage', { channel, thread_ts: rootPost.ts, text: '✓ Hivecode check: thread reply works (set SLACK_APP_TOKEN to verify inbound replies).' }, token, fetchImpl, api)
      }
    } catch (e) {
      logErr(`Q630 Slack chat.postMessage failed (${formatSlackWhy(e)}).`)
      return 1
    }
    log(`✓ outbound post: delivered to #${channelName} (set SLACK_APP_TOKEN to verify inbound replies)`)
    return 0
  }

  // 5. Socket Mode connect (must receive Slack's `hello` frame within helloTimeoutMs BEFORE we post the prompt)
  const sm = await preflightSocketMode({ appToken, scopes: agent ? null : scopes, isPrivate, channel, api, fetchImpl })
  if (!sm.ok) {
    logErr(sm.error)
    return 1
  }

  let sock = null
  const closeSock = () => {
    if (!sock) return
    try { sock.removeAllListeners && sock.removeAllListeners() } catch { }
    try { sock.close() } catch { }
    try { sock.terminate && sock.terminate() } catch { }
    sock = null
  }

  let checkTs = ''
  let replyResolver = null
  const replyPromise = new Promise((resolve) => { replyResolver = resolve })

  let currentUrl = sm.url
  const startTime = Date.now()

  while (true) {
    if (!currentUrl) {
      try {
        const res = await slackPost('apps.connections.open', {}, appToken, fetchImpl, api)
        currentUrl = res && res.url
      } catch (e) {
        closeSock()
        logErr(`Q634 Slack apps.connections.open failed (${formatSlackWhy(e)}).`)
        return 1
      }
    }
    if (!currentUrl) {
      closeSock()
      logErr('Q634 Slack apps.connections.open did not return a WebSocket URL.')
      return 1
    }

    const res = await new Promise((resolve) => {
      let settled = false
      const finish = (val) => {
        if (settled) return
        settled = true
        clearTimeout(hTimer)
        resolve(val)
      }
      const hTimer = setTimeout(() => finish({ timedOut: true }), helloTimeoutMs)
      try {
        sock = new WebSocketImpl(currentUrl)
      } catch (e) {
        finish({ error: e })
        return
      }
      sock.on('error', (e) => finish({ error: e }))
      sock.on('close', () => {
        finish({ closed: true })
        if (replyResolver) replyResolver(false)
      })
      sock.on('message', (raw) => {
        let frame
        try { frame = JSON.parse(String(raw)) } catch { return }
        if (frame && frame.envelope_id) {
          try { sock && sock.send(JSON.stringify({ envelope_id: frame.envelope_id })) } catch { }
        }
        if (!frame) return
        if (frame.type === 'hello') {
          finish({ ok: true, frame })
          return
        }
        const ev = frame.payload && frame.payload.event
        if (
          ev &&
          (ev.type === 'message' || (agent && ev.type === 'agent_session_stopped')) &&
          !ev.bot_id &&
          !ev.subtype &&
          ev.user &&
          ev.user !== botUserId &&
          (!ev.channel || ev.channel === channel) &&
          checkTs &&
          (ev.thread_ts || ev.ts) === checkTs
        ) {
          if (replyResolver) replyResolver(true)
        }
      })
    })

    if (res.timedOut || res.closed || res.error) {
      closeSock()
      logErr('Q634 Socket Mode did not open (no hello frame received within timeout). Check SLACK_APP_TOKEN (connections:write) and network access to Slack.')
      return 1
    }

    const num = Number(res.frame && res.frame.num_connections) || 1
    if (num <= 1) {
      break
    }

    const elapsed = Date.now() - startTime
    if (elapsed < startRetryMs) {
      closeSock()
      const waitTime = Math.min(startRetryDelayMs, Math.max(50, startRetryMs - elapsed))
      await new Promise((r) => setTimeout(r, waitTime))
      currentUrl = ''
      continue
    }

    closeSock()
    logErr(`Q635 Another process is already connected to Slack Socket Mode with this SLACK_APP_TOKEN (${num} active connections). Slack distributes incoming events across connections, so messages and "stop" commands may go to the other process. Check for another terminal or service running "hivecode-mcp slack start", "github start --slack-allow", or "hive-slack-agent" with the same app token. If you just stopped a bridge, wait a minute for Slack to release the connection and start again.`)
    return 1
  }

  log('✓ Socket Mode: connected')

  // 6. Real proof: post prompt and wait up to timeoutMs for any non-bot reply in that thread
  log(`This posts one message in #${channelName} (and one reply in its thread)`)
  try {
    const postRes = await slackPost(
      'chat.postMessage',
      { channel, text: 'Hivecode check: reply anything in this thread' },
      token,
      fetchImpl,
      api,
    )
    checkTs = (postRes && postRes.ts) || ''
  } catch (e) {
    closeSock()
    logErr(`Q630 Slack chat.postMessage failed (${formatSlackWhy(e)}).`)
    return 1
  }

  let waitTimer = null
  const onSigInt = () => {
    if (replyResolver) replyResolver(false)
  }
  if (agent) {
    process.once('SIGINT', onSigInt)
  }

  try {
    if (agent) {
      let statusRes
      try {
        statusRes = await slackPost(
          'agents.sessions.setStatus',
          { status: 'processing', channel_id: channel, thread_ts: checkTs },
          token,
          fetchImpl,
          api,
        )
      } catch (e) {
        const code = extractSlackError(e)
        if (code === 'feature_disabled') {
          logErr('Q634 Slack agents.sessions.setStatus failed (feature_disabled): Slack AI agent sessions require a paid Slack plan with Agents & Assistants enabled (slack-app-manifest-agent.json).')
        } else if (code === 'thread_ts_required') {
          logErr('Q634 Slack agents.sessions.setStatus failed (thread_ts_required): Slack requires thread_ts for thread-based agent sessions in DMs.')
        } else {
          logErr(`Q634 Slack agents.sessions.setStatus failed (${formatSlackWhy(e)}). Reinstall from slack-app-manifest-agent.json.`)
        }
        return 1
      }
      const warnings = extractSlackWarnings(statusRes)
      if (warnings.includes('missing_agent_session_stopped_event_subscription')) {
        logErr('Q634 Slack agents.sessions.setStatus returned warning missing_agent_session_stopped_event_subscription: the native Slack stop button is not active because agent_session_stopped is not subscribed. Reinstall from slack-app-manifest-agent.json.')
        return 1
      }
      log('✓ agent session: native stop button subscribed (agents.sessions.setStatus)')
    }

    const arrived = await Promise.race([
      replyPromise,
      new Promise((resolve) => { waitTimer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
    clearTimeout(waitTimer)

    if (!arrived) {
      const manifestName = agent ? 'slack-app-manifest-agent.json' : 'slack-app-manifest-inbound.json'
      logErr(`Q634 replies did not arrive. Event subscriptions are probably missing: reinstall from ${manifestName}`)
      return 1
    }

    await slackPost(
      'chat.postMessage',
      { channel, thread_ts: checkTs, text: '✓ Hivecode check: replies reach Hivecode.' },
      token,
      fetchImpl,
      api,
    ).catch(() => {})
    log('✓ replies reach Hivecode')
    return 0
  } finally {
    clearTimeout(waitTimer)
    if (agent) {
      process.removeListener('SIGINT', onSigInt)
      if (checkTs) {
        await slackPost(
          'agents.sessions.setStatus',
          { status: 'active', channel_id: channel, thread_ts: checkTs },
          token,
          fetchImpl,
          api,
        ).catch(() => {})
      }
    }
    closeSock()
  }
}

export async function main(argv = process.argv.slice(2), { log = console.log, logErr = console.error, fetchImpl = fetch, env = process.env, WebSocketImpl = WebSocket } = {}) {
  let mode = 'start'
  let CHANNEL = env.SLACK_CHANNEL || ''
  let NAME = 'SlackBridge'
  let ALLOW = env.SLACK_ALLOW || ''
  let allowSource = env.SLACK_ALLOW ? 'SLACK_ALLOW' : '--allow'
  let LINK = ''
  let dryRun = false
  let agent = false
  let timeoutMs = Number(env.HIVE_SLACK_CHECK_TIMEOUT_MS) || 120000
  let helloTimeoutMs = Number(env.HIVE_SLACK_HELLO_TIMEOUT_MS) || 10000
  let startRetryMs = Number(env.HIVE_SLACK_START_RETRY_MS) || 60000
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if ((a === 'start' || a === 'check') && !LINK && i === 0) { mode = a; continue }
    if (a === '--help' || a === '-h') { log(USAGE.trim()); return 0 }
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--agent') { agent = true; continue }
    if (a === '--channel') { CHANNEL = argv[++i] || ''; continue }
    if (a === '--name') { NAME = argv[++i] || 'SlackBridge'; continue }
    if (a === '--allow') { ALLOW = argv[++i] || ''; allowSource = '--allow'; continue }
    if (a === '--timeout') { timeoutMs = Number(argv[++i]) || timeoutMs; continue }
    if (a === '--hello-timeout') { helloTimeoutMs = Number(argv[++i]) || helloTimeoutMs; continue }
    if (a === '--start-retry') { startRetryMs = Number(argv[++i]) || startRetryMs; continue }
    if (a.startsWith('--')) { logErr(USAGE.trim()); return 2 }
    if (!LINK) LINK = a
  }
  const TOKEN = env.SLACK_BOT_TOKEN || ''
  const APP_TOKEN = env.SLACK_APP_TOKEN || ''
  if (mode === 'check') {
    return await runSlackCheck({
      token: TOKEN,
      appToken: APP_TOKEN,
      channel: CHANNEL,
      agent,
      timeoutMs,
      helloTimeoutMs,
      startRetryMs,
      fetchImpl,
      WebSocketImpl,
      log,
      logErr,
    })
  }
  if (!LINK) {
    logErr(USAGE.trim())
    return 2
  }
  const allowParsed = parseSlackAllow(ALLOW, allowSource)
  if (!allowParsed.ok) {
    logErr(allowParsed.error)
    return 1
  }
  const pre = await preflightSlack({ token: TOKEN, channel: CHANNEL, fetchImpl })
  if (!pre.ok) {
    logErr(pre.error)
    return 1
  }
  let sockPre = null
  if (APP_TOKEN) {
    sockPre = await preflightSocketMode({
      appToken: APP_TOKEN,
      scopes: pre.scopes,
      isPrivate: pre.isPrivate,
      channel: CHANNEL,
      fetchImpl,
    })
    if (!sockPre.ok) {
      logErr(sockPre.error)
      return 1
    }
  }
  const { relay, room, token: linkToken } = parseLink(LINK)
  if (!relay || !room) {
    logErr(`Q630 "${LINK}" is not a valid room link (expected wss://relay|room-…).`)
    return 2
  }
  if (dryRun) {
    const mode = sockPre ? 'outbound + inbound Socket Mode' : 'outbound'
    log(`DRY RUN OK: @${pre.botUser} is in #${pre.channelName} (${CHANNEL}) [${mode}] and ready to bridge ${room} — resume: ${allowParsed.ids.length ? allowParsed.ids.join(', ') : 'off'}.`)
    return 0
  }
  const dir = (env.TEMP || process.env.TEMP || '.') + '/hive-slack-' + room + '-' + process.pid
  const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: linkToken || env.HIVE_TOKEN || '', syncFiles: false, log: () => {} })
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    hive.provider.on('sync', (s) => { if (s) finish() })
    setTimeout(finish, 8000)
  })
  const dup = checkDuplicateBridge(hive, NAME)
  if (!dup.ok) {
    logErr(dup.error)
    try { hive.stop() } catch { }
    return 1
  }
  const bridge = makeBridge({
    hive,
    channel: CHANNEL,
    token: TOKEN,
    botName: NAME,
    room,
    link: LINK,
    allow: ALLOW,
    teamId: pre.teamId || '',
    botUserId: pre.botUserId || '',
    fetchImpl,
    post: (m) => slackPost('chat.postMessage', m, TOKEN, fetchImpl),
  })
  if (sockPre) {
    try {
      await connectSocketMode({
        appToken: APP_TOKEN,
        initialUrl: sockPre.url,
        fetchImpl,
        WebSocketImpl,
        logErr,
        helloTimeoutMs,
        startRetryMs,
        onEvent: (ev) => bridge.onInboundEvent(ev),
        onMultiConnection: (n) => {
          bridge.postChannel(
            `:warning: Another process connected to Slack Socket Mode with this app token (${n} active connections). Slack distributes incoming events across connections, so messages or "stop" commands may go to the other process. Check for another terminal running hivecode-mcp slack start, github start --slack-allow, or hive-slack-agent.`,
          )
        },
      })
    } catch (e) {
      logErr(e.message)
      try { hive.stop() } catch { }
      return 1
    }
  }
  const chat = hive.doc.getArray('chat')
  const savedCursor = Number(bridge.threads.get(CURSOR_KEY)) || 0
  let at = savedCursor > 0 && savedCursor <= chat.length ? savedCursor : chat.length
  chat.observe(() => { const all = chat.toArray(); bridge.onChat(all.slice(at), at); at = all.length })
  await bridge.watchRoom()
  log(`READY: [hive-slack] @${pre.botUser} bridging ${room} -> #${pre.channelName} (${CHANNEL}) — resume: ${allowParsed.ids.length ? allowParsed.ids.join(', ') : 'off'}`)
  return 0
}

// ---- main -------------------------------------------------------------------------------
if (import.meta.url === `file:///${(process.argv[1] || '').replace(/\\/g, '/')}`) {
  main().then((code) => { if (code !== 0) process.exit(code) })
}
