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
// Error codes Q630-Q632 are this module's:
//   Q630  SLACK_BOT_TOKEN missing, invalid, or revoked at preflight
//   Q631  --channel missing, not found, or the bot has not been invited (/invite @Hivecode)
//   Q632  a Slack bridge with this name is already running in the room

import { startSync, parseLink } from './sync.js'
import { scrub } from './hive-webhook.js'

const DEFAULT_API = 'https://slack.com/api'
const ROOM_THREAD_KEY = '__room__'
const CURSOR_KEY = '__cursor__'

export const USAGE = `usage:
  SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest slack start "<relay|room>" --channel <id> [--name SlackBridge] [--dry-run]
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

/** POST to Slack's Web API. Kept tiny and injectable so the bridge can be tested without a
 *  workspace -- the thing worth testing is our routing, not Slack's HTTP. */
export async function slackPost(method, body, token, fetchImpl = fetch, apiBase = process.env.HIVE_SLACK_API || DEFAULT_API) {
  const r = await fetchImpl(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const retryHeader = r.headers && typeof r.headers.get === 'function' ? Number(r.headers.get('retry-after') || 0) : 0
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
    const err = new Error(`slack ${method}: ${code}`)
    err.status = r.status
    err.code = code
    err.slackError = code
    throw err
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
    const why = extractSlackError(e) || e.message
    return { ok: false, code: 'Q630', error: `Q630 SLACK_BOT_TOKEN was rejected by Slack (${why}). Check the token or reinstall the Slack app.` }
  }
  const botUser = auth.user || 'Hivecode'
  let info
  try {
    info = await slackPost('conversations.info', { channel }, token, fetchImpl, api)
  } catch (e) {
    const why = extractSlackError(e) || e.message
    return { ok: false, code: 'Q631', error: `Q631 Slack channel ${channel} could not be accessed (${why}). Check the channel ID and run /invite @${botUser} in the channel.` }
  }
  if (info && info.channel && info.channel.is_member === false) {
    const chName = info.channel.name ? `#${info.channel.name}` : channel
    return { ok: false, code: 'Q631', error: `Q631 @${botUser} is not a member of ${chName} (${channel}). In Slack, open ${chName} and run: /invite @${botUser}` }
  }
  return {
    ok: true,
    botUser,
    botUserId: auth.user_id || '',
    team: auth.team || '',
    channelName: (info && info.channel && info.channel.name) || channel,
  }
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
  if (ev.kind === 'task-open') return `:inbox_tray: *${ev.task}*  —  assigned to *${ev.to}*`
  if (ev.kind === 'task-done') return `:white_check_mark: *${ev.task}* — done by *${ev.by}*`
  if (ev.kind === 'gate-fail') return `:no_entry: gate failed for *${ev.by}* on \`${ev.file}\` — the file stays with them, nobody downstream gets it`
  if (ev.kind === 'gate-pass') return `:heavy_check_mark: gate passed for *${ev.by}* on \`${ev.file}\``
  if (ev.kind === 'chat') return `*${ev.by}*: ${ev.text}`
  return `${ev.kind}: ${ev.text || ''}`
}

/** Which events reach the CHANNEL, and which only ever go inside a thread.
 *  Getting this wrong is the difference between a useful feed and a muted one. */
export const TO_CHANNEL = new Set(['task-open', 'task-done'])

export function makeBridge({
  hive,
  channel,
  token,
  post,
  botName = 'SlackBridge',
  onError = null,
  room = '',
  link = '',
}) {
  const threads = hive.doc.getMap('slack_threads')   // task id -> thread_ts, shared + durable
  const seen = new Set()
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
    onError: handleFatal,
    room: room || (hive && hive.room) || '',
    link,
  })
  const { queue } = threader

  async function emit(ev) {
    if (queue.isHalted()) return { ok: false, halted: true }
    const text = scrubSlack(render(ev), { room: room || (hive && hive.room) || '', link })
    if (ev.task) {
      // A task's first event opens the thread; everything after lands inside it.
      return threader.reply(ev.task, text)
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

  /** A human replied in a Slack thread. Put it into the room, addressed, and marked so the
   *  echo guard above will not send it straight back to Slack. */
  function deliver({ thread_ts, text, user }) {
    let task = null
    for (const [id, ts] of threads.entries()) {
      if (id === ROOM_THREAD_KEY || id === CURSOR_KEY) continue
      if (ts === thread_ts) { task = id; break }
    }
    const addressed = /^@/.test(text.trim()) ? text.trim() : text.trim()
    hive.doc.getArray('chat').push([{
      by: user || 'slack', kind: 'say', at: Date.now() * 1000, text: addressed, task, viaSlack: true,
    }])
    return { ok: true, task }
  }

  return { emit, onChat, deliver, threads, queue, threader }
}

export async function main(argv = process.argv.slice(2), { log = console.log, logErr = console.error, fetchImpl = fetch, env = process.env } = {}) {
  let CHANNEL = env.SLACK_CHANNEL || ''
  let NAME = 'SlackBridge'
  let LINK = ''
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'start' && !LINK && i === 0) continue
    if (a === '--help' || a === '-h') { log(USAGE.trim()); return 0 }
    if (a === '--dry-run') { dryRun = true; continue }
    if (a === '--channel') { CHANNEL = argv[++i] || ''; continue }
    if (a === '--name') { NAME = argv[++i] || 'SlackBridge'; continue }
    if (a.startsWith('--')) { logErr(USAGE.trim()); return 2 }
    if (!LINK) LINK = a
  }
  const TOKEN = env.SLACK_BOT_TOKEN || ''
  if (!LINK) {
    logErr(USAGE.trim())
    return 2
  }
  const pre = await preflightSlack({ token: TOKEN, channel: CHANNEL, fetchImpl })
  if (!pre.ok) {
    logErr(pre.error)
    return 1
  }
  const { relay, room, token: linkToken } = parseLink(LINK)
  if (!relay || !room) {
    logErr(`Q630 "${LINK}" is not a valid room link (expected wss://relay|room-…).`)
    return 2
  }
  if (dryRun) {
    log(`DRY RUN OK: @${pre.botUser} is in #${pre.channelName} (${CHANNEL}) and ready to bridge ${room}.`)
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
    post: (m) => slackPost('chat.postMessage', m, TOKEN, fetchImpl),
  })
  const chat = hive.doc.getArray('chat')
  const savedCursor = Number(bridge.threads.get(CURSOR_KEY)) || 0
  let at = savedCursor > 0 && savedCursor <= chat.length ? savedCursor : chat.length
  chat.observe(() => { const all = chat.toArray(); bridge.onChat(all.slice(at), at); at = all.length })
  log(`READY: [hive-slack] @${pre.botUser} bridging ${room} -> #${pre.channelName} (${CHANNEL})`)
  return 0
}

// ---- main -------------------------------------------------------------------------------
if (import.meta.url === `file:///${(process.argv[1] || '').replace(/\\/g, '/')}`) {
  main().then((code) => { if (code !== 0) process.exit(code) })
}
