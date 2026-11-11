// hive-slack-relay -- Slack <-> a room, run by the relay itself (issue #22).
//
// WHY THIS LIVES ON THE RELAY. Until 0.14.12, Slack and a room only talked while `slack start`
// ran on somebody's computer: it held a Socket Mode connection to Slack and a room connection, and
// when that computer slept Slack went quiet and nobody was told. The relay is the one process that
// is always up and already holds every open room's document, so it can do both halves itself:
//   Slack -> room   Slack's Events API POSTs each message to /slack/events/<id>; the relay checks
//                   the signature, answers 200 at once (Slack's 3 s deadline), then writes the line
//                   into that room's chat.
//   room -> Slack   the relay watches that room's chat and sends each new line with chat.postMessage.
//
// THE CONTRACT (agreed in the room, 11 Nov 2026; the `slack connect` CLI is the other half):
//   POST /slack/prepare    {room}                                  -> {ok, id, eventsUrl}
//   POST /slack/connect    {id, botToken, signingSecret, channel, allow?} -> {ok, team, channel, eventsUrl}
//   POST /slack/disconnect {id, signingSecret} or {room, signingSecret} -> {ok}
//   POST /slack/events/<id>                                        Slack's Events API
// Errors are {ok:false, code, why}: Q660 no HIVE_SLACK_KEY on this relay (503), Q661 unknown or
// expired id, Q662 Slack refused the token, Q663 bad signature or secret (401), Q664 the bot is not
// in that channel.
//
// WHAT NEVER LEAVES. The bot token and signing secret are stored on the relay's disk only, encrypted
// (AES-256-GCM, key from HIVE_SLACK_KEY), never logged, never written into a room. The events URL
// carries a random id, not the room id: the room id is the key to read the room, and Slack keeps
// request URLs in app configs and logs. The room id is also scrubbed out of every line sent to Slack.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import * as SEEN from './hive-seen.js'
import { findSecrets } from './hive-secrets.js'

export const SLACK_PREFIX = '/slack/'
const DEFAULT_API = 'https://slack.com/api'
const STORE_FILE = 'slack-relay.json'
const PREPARED_TTL_MS = 24 * 3600 * 1000
const MAX_PREPARED = 2000          // unconnected ids at once: a cap, so /slack/prepare cannot fill the disk
const MAX_BODY = 1024 * 1024       // Slack event payloads are a few KB
const SIG_WINDOW_S = 300           // Slack's own replay window
const SEEN_EVENTS = 1000           // event ids remembered per connection, for Slack's retries
const MAX_TEXT = 3500
const ROOM_RE = /^[A-Za-z0-9_.~-]{1,200}$/
const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/
// The same rule as hive-slack.js notFromAPerson: these subtypes are a person saying something.
const PERSON_SUBTYPES = new Set(['thread_broadcast', 'file_share'])
const FORWARDED_MAP = 'slack_forwarded'

const hhmmss = (t = new Date()) => t.toTimeString().slice(0, 8)
const fail = (status, code, why) => ({ status, body: { ok: false, code, why: `${code} ${why}` } })

/** Slack's v0 request signature. True only for a fresh timestamp and a matching HMAC. */
export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, nowS = Math.floor(Date.now() / 1000) }) {
  if (!signingSecret || !timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > SIG_WINDOW_S) return false
  const want = 'v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')
  const a = Buffer.from(String(signature)), b = Buffer.from(want)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Encrypt / decrypt the per-connection secrets. The key is any string; it is hashed to 32 bytes. */
export function sealSecrets(obj, key) {
  const k = crypto.createHash('sha256').update(String(key)).digest()
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', k, iv)
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }
}
export function openSecrets(sealed, key) {
  const k = crypto.createHash('sha256').update(String(key)).digest()
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(sealed.iv, 'base64'))
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return JSON.parse(Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8'))
}

/** A Slack sender as the room sees it. Never a display name a member could share: slack:<handle>. */
export function slackSender(handle) {
  const clean = String(handle || 'user').trim().replace(/^slack:/i, '').replace(/[^A-Za-z0-9_.-]/g, '') || 'user'
  return `slack:${clean}`
}

/** stop / resume typed in Slack, as the bridge understands them (hive-slack.js route()). */
export function controlIntent(text) {
  const s = String(text || '').trim().toLowerCase()
  let m
  if ((m = s.match(/^(?:resume|unpause|continue)\s+(?:agent\s+)?([a-z0-9_.-]+)$/))) return m[1] === 'all' ? { state: 'running', who: '' } : { state: 'running', who: m[1] }
  if ((m = s.match(/^(?:stop|pause|halt)\s+(?:agent\s+)?([a-z0-9_.-]+)$/))) return m[1] === 'all' ? { state: 'paused', who: '' } : { state: 'paused', who: m[1] }
  if (/^(stop|pause|halt)$/.test(s)) return { state: 'paused', who: '' }
  if (/^(resume|unpause|carry on|keep going)$/.test(s)) return { state: 'running', who: '' }
  return null
}

/** What one room line looks like in Slack: keys and the room id taken out, plain text. */
export function renderForSlack(m, room) {
  let text = String((m && m.text) || '')
  for (const f of findSecrets(text, { tokens: true })) text = text.split(f.value).join(`[${f.kind} removed]`)
  // Every room link and room id, not only this room's: the same rules as the bridge (hive-slack.js
  // scrubSlack), kept here so the relay does not load the bridge and its room client.
  text = text.replace(/\bwss?:\/\/[^\s|"'<>]+\|[^\s"'<>]+/gi, '[room link removed]')
  if (room) text = text.split(room).join('[room id removed]')
  text = text.replace(/\broom-[A-Za-z0-9_-]{6,}\b/g, '[room id removed]')
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + ' …'
  return `*${String((m && m.by) || 'someone')}*: ${text}`
}

/**
 * The relay's Slack side. Pure apart from what it is handed:
 *   getDoc(room)   the relay's getYDoc (creates the doc, loading its snapshot, when nobody is in it)
 *   docs           the relay's Map of open docs (read only: a room nobody has open is not watched)
 *   dir            where the encrypted store lives (null: memory only, as a relay without persistence)
 *   key            HIVE_SLACK_KEY; without it every Slack route answers Q660
 *   fetchImpl, api the Slack Web API (HIVE_SLACK_API points tests at a fake)
 *   publicUrl      this relay's https origin, for eventsUrl (else the request's Host)
 */
export function makeSlackRelay({ getDoc, docs, dir = null, key = '', fetchImpl = globalThis.fetch, api = DEFAULT_API, publicUrl = '', now = Date.now, log = () => { }, tickMs = 1000 } = {}) {
  const conns = new Map()            // id -> { room, at, connected, channel, channelName, team, botUserId, allow, sealed }
  const runtime = new Map()          // id -> { secrets, seen:Set, seenOrder:[], users:Map, queue:Promise, doc, unobserve }
  const storePath = dir ? path.join(dir, STORE_FILE) : null

  // ---- the store ------------------------------------------------------------------------------
  if (storePath) {
    try {
      const j = JSON.parse(fs.readFileSync(storePath, 'utf8'))
      for (const [id, c] of Object.entries((j && j.conns) || {})) conns.set(id, c)
    } catch { /* no store yet */ }
  }
  const save = () => {
    if (!storePath) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = storePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, conns: Object.fromEntries(conns) }), { mode: 0o600 })
      fs.renameSync(tmp, storePath)
    } catch (e) { log(`[slack] could not save the Slack store: ${e.code || e.message}`) }
  }
  const sweepPrepared = () => {
    let changed = false
    for (const [id, c] of conns) if (!c.connected && now() - (c.at || 0) > PREPARED_TTL_MS) { conns.delete(id); changed = true }
    if (changed) save()
  }
  sweepPrepared()

  const rt = (id) => {
    let r = runtime.get(id)
    if (!r) { r = { secrets: null, seen: new Set(), seenOrder: [], users: new Map(), queue: Promise.resolve(), doc: null, unobserve: null }; runtime.set(id, r) }
    return r
  }
  // UNREADABLE SECRETS ARE A DEAD CONNECTION, NEVER A CRASH. openSecrets throws when HIVE_SLACK_KEY
  // was changed or the store is damaged; thrown from a chat observer it was an unhandled rejection
  // that took the whole relay down, every room with it (found by Antigravity reviewing part A).
  // Now: null, said once, and the connection is treated as gone until slack connect is run again.
  const secretsOf = (id) => {
    const r = rt(id)
    if (!r.secrets && !r.unreadable) {
      const c = conns.get(id)
      if (c && c.sealed) {
        try { r.secrets = openSecrets(c.sealed, key) } catch {
          r.unreadable = true
          log(`[slack] a stored Slack connection cannot be opened (HIVE_SLACK_KEY changed, or the store is damaged); it is off until slack connect is run again`)
          if (c.room) sayInRoom(c.room, `Slack (#${c.channelName || c.channel}) stopped: the relay can no longer read its stored token (its HIVE_SLACK_KEY changed). Run slack connect again.`, { src: 'slack' })
        }
      }
    }
    return r.secrets
  }

  // ---- Slack Web API --------------------------------------------------------------------------
  const slack = async (method, token, params = {}) => {
    const body = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.set(k, String(v))
    const res = await fetchImpl(`${api.replace(/\/$/, '')}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    let j = null
    try { j = await res.json() } catch { j = null }
    return j || { ok: false, error: `http_${res.status}` }
  }

  // ---- the room side --------------------------------------------------------------------------
  const sayInRoom = (room, text, extra = {}) => {
    try { getDoc(room).getArray('chat').push([{ by: 'relay', kind: 'system', at: hhmmss(), text, ...extra }]) } catch (e) { log(`[slack] could not write to a room: ${e.message}`) }
  }
  const membersOf = (doc) => {
    const out = []
    try { for (const st of doc.awareness.getStates().values()) if (st && st.user && st.user.name) out.push(st.user) } catch { }
    return out
  }

  /** room -> Slack: a chat observer on the doc that is open now. Re-attached when the doc is recreated. */
  const attach = (id) => {
    const c = conns.get(id)
    if (!c || !c.connected) return
    const r = rt(id)
    const doc = docs && docs.get(c.room)
    if (!doc || doc === r.doc) return
    if (r.unobserve) { try { r.unobserve() } catch { } }
    r.doc = doc
    const chat = doc.getArray('chat'), forwarded = doc.getMap(FORWARDED_MAP), fkey = `relay:${id}`
    const saved = forwarded.get(fkey)
    // No frontier saved: start from now, so connecting never floods Slack with the room's history.
    const fwd = saved && typeof saved === 'object' ? SEEN.makeFrontier(saved) : SEEN.frontierOfPrefix(chat, chat.length)
    if (!saved) { try { forwarded.set(fkey, fwd.toJSON({ prune: chat })) } catch { } }
    const onChange = () => {
      const fresh = []
      for (const { id: yid, value } of SEEN.itemsOf(chat)) { if (fwd.has(yid)) continue; fwd.add(yid); fresh.push(value) }
      if (!fresh.length) return
      try { forwarded.set(fkey, fwd.toJSON({ prune: chat })) } catch { }
      for (const m of fresh) {
        if (!m || m.src === 'slack' || String(m.by || '').startsWith('slack:')) continue // never echo Slack back
        post(id, renderForSlack(m, c.room))
      }
    }
    chat.observe(onChange)
    r.unobserve = () => chat.unobserve(onChange)
    onChange() // lines that arrived between the doc opening and this observer
  }
  const post = (id, text) => {
    const r = rt(id)
    r.queue = r.queue.then(async () => {
      try {
        const c = conns.get(id); const s = secretsOf(id)
        if (!c || !c.connected || !s) return
        const j = await slack('chat.postMessage', s.botToken, { channel: c.channel, text, unfurl_links: false, unfurl_media: false })
        if (!j.ok) log(`[slack] chat.postMessage refused: ${j.error}`)
      } catch (e) { log(`[slack] chat.postMessage failed: ${e.code || e.message}`) }
    }).catch(() => { }) // the queue itself never rejects: a rejection here would be unhandled
    return r.queue
  }
  const timer = setInterval(() => { for (const id of conns.keys()) attach(id) }, tickMs)
  if (timer.unref) timer.unref()

  // ---- Slack -> room --------------------------------------------------------------------------
  const nameOf = async (id, user) => {
    const r = rt(id)
    if (r.users.has(user)) return r.users.get(user)
    let handle = user
    const s = secretsOf(id)
    if (!s) return handle
    try {
      const j = await slack('users.info', s.botToken, { user })
      if (j.ok && j.user) handle = j.user.name || (j.user.profile && j.user.profile.display_name) || user
    } catch { }
    r.users.set(user, handle)
    return handle
  }
  const deliver = async (id, payload) => {
    const c = conns.get(id); if (!c || !c.connected) return
    const r = rt(id)
    const eid = String(payload.event_id || '')
    if (eid) {
      if (r.seen.has(eid)) return
      r.seen.add(eid); r.seenOrder.push(eid)
      if (r.seenOrder.length > SEEN_EVENTS) r.seen.delete(r.seenOrder.shift())
    }
    const ev = payload.event || {}
    if (ev.type !== 'message' || ev.channel !== c.channel) return
    if (ev.bot_id || (c.botUserId && ev.user === c.botUserId)) return
    if (ev.subtype && !PERSON_SUBTYPES.has(ev.subtype)) return
    if (!ev.user) return
    if (Array.isArray(c.allow) && c.allow.length && !c.allow.includes(ev.user)) return
    const text = String(ev.text || '').trim()
    if (!text) return
    const by = slackSender(await nameOf(id, ev.user))
    const doc = getDoc(c.room)
    const intent = controlIntent(text)
    if (intent) {
      const controls = doc.getMap('controls')
      const ais = membersOf(doc).filter((u) => u.kind === 'ai').map((u) => u.name)
      const targets = intent.who ? ais.filter((n) => n.toLowerCase() === intent.who) : ais
      if (intent.who && !targets.length) { doc.getArray('chat').push([{ by, kind: 'human', at: hhmmss(), text, src: 'slack' }]); return }
      doc.transact(() => {
        for (const t of targets) controls.set(t, { state: intent.state, by, at: hhmmss() })
        doc.getArray('chat').push([{ by, kind: 'human', at: hhmmss(), text, src: 'slack' }])
      })
      const what = intent.state === 'paused' ? '⏸ paused' : '▶ resumed'
      sayInRoom(c.room, targets.length ? `${by} ${what} ${targets.join(', ')}` : `${by} asked to ${intent.state === 'paused' ? 'stop' : 'resume'}, but no agent is in the room`)
      return
    }
    doc.getArray('chat').push([{ by, kind: 'human', at: hhmmss(), text, src: 'slack' }])
  }

  // ---- HTTP -----------------------------------------------------------------------------------
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', (ch) => { n += ch.length; if (n > MAX_BODY) { reject(Object.assign(new Error('too large'), { tooLarge: true })); req.destroy() } else chunks.push(ch) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const originOf = (req) => {
    if (publicUrl) return publicUrl.replace(/\/$/, '')
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    return `${proto}://${req.headers.host || 'localhost'}`
  }
  const json = (raw) => { try { const j = JSON.parse(raw); return j && typeof j === 'object' ? j : null } catch { return null } }

  async function prepare(req, raw) {
    const j = json(raw) || {}
    const room = String(j.room || '')
    if (!ROOM_RE.test(room)) return fail(400, 'Q661', 'that is not a room id (expected the part after "|" in the room link).')
    sweepPrepared()
    // ONE UNFINISHED ID PER ROOM. A first `slack connect` that stops after prepare (bot not invited
    // yet, a wrong token) has already printed a manifest with this URL, and the person may already
    // have made the Slack app from it. Running it again must give the same URL, or the app points
    // at an id nobody will ever connect (found by Claude-cloud reviewing part A).
    for (const [pid, c] of conns) {
      if (c.room === room && !c.connected) return { status: 200, body: { ok: true, id: pid, eventsUrl: `${originOf(req)}${SLACK_PREFIX}events/${pid}` } }
    }
    if ([...conns.values()].filter((c) => !c.connected).length >= MAX_PREPARED) return fail(503, 'Q661', 'this relay has too many unfinished Slack connections; try again later.')
    const id = crypto.randomBytes(16).toString('base64url')
    conns.set(id, { room, at: now(), connected: false })
    save()
    return { status: 200, body: { ok: true, id, eventsUrl: `${originOf(req)}${SLACK_PREFIX}events/${id}` } }
  }

  async function connect(req, raw) {
    const j = json(raw) || {}
    const id = String(j.id || ''), botToken = String(j.botToken || ''), signingSecret = String(j.signingSecret || ''), channel = String(j.channel || '')
    const c = conns.get(id)
    if (!c) return fail(404, 'Q661', 'unknown or expired Slack connection id; run slack connect again.')
    if (c.connected) {
      const s = secretsOf(id)
      if (s && !safeEqual(s.signingSecret, signingSecret)) return fail(401, 'Q663', 'this connection is already set up, and that signing secret is not its own.')
    }
    if (!/^xox[bp]-/.test(botToken)) return fail(400, 'Q662', 'the bot token should start with xoxb-.')
    if (!signingSecret) return fail(400, 'Q663', 'the signing secret is missing (Basic Information -> App Credentials in your Slack app).')
    if (!CHANNEL_RE.test(channel)) return fail(400, 'Q664', 'that is not a Slack channel id (like C0123456789).')
    let auth, info
    try { auth = await slack('auth.test', botToken) } catch (e) { return fail(502, 'Q662', `could not reach Slack (${e.code || e.message}).`) }
    if (!auth.ok) return fail(400, 'Q662', `Slack refused the bot token (${auth.error}).`)
    try { info = await slack('conversations.info', botToken, { channel }) } catch (e) { return fail(502, 'Q664', `could not reach Slack (${e.code || e.message}).`) }
    if (!info.ok) return fail(400, 'Q664', `Slack could not find that channel for this bot (${info.error}).`)
    if (info.channel && info.channel.is_member === false) return fail(400, 'Q664', `the bot is not in #${info.channel.name}; invite it there first (/invite @your-app).`)
    const channelName = (info.channel && info.channel.name) || channel
    const allow = Array.isArray(j.allow) ? j.allow.map(String).filter((u) => /^[UW][A-Z0-9]+$/.test(u)) : []
    const r = rt(id)
    conns.set(id, { room: c.room, at: c.at, connected: true, connectedAt: now(), channel, channelName, team: auth.team || '', botUserId: auth.user_id || '', allow, sealed: sealSecrets({ botToken, signingSecret }, key) })
    r.secrets = { botToken, signingSecret }; r.unreadable = false; r.doc = null
    save()
    const line = `Slack is connected to this room (#${channelName}).`
    sayInRoom(c.room, line, { src: 'slack' })   // src: the forwarder does not send this one back
    attach(id)                                  // only lines after this one go to Slack
    post(id, line)
    return { status: 200, body: { ok: true, team: auth.team || '', channel: channelName, eventsUrl: `${originOf(req)}${SLACK_PREFIX}events/${id}` } }
  }

  async function disconnect(req, raw) {
    const j = json(raw) || {}
    let id = String(j.id || '')
    const given = String(j.signingSecret || '')
    // From another computer the CLI does not know the id: {room, signingSecret} finds the room's
    // connection whose secret matches. Every connection of the room is compared, constant time.
    if (!id && j.room) {
      const room = String(j.room)
      const ofRoom = [...conns].filter(([, c]) => c.room === room && c.connected)
      if (!ofRoom.length) return fail(404, 'Q661', 'this room has no Slack connection on this relay.')
      let hit = ''
      for (const [cid] of ofRoom) { const s = secretsOf(cid); if (!hit && (!s || safeEqual(s.signingSecret, given))) hit = cid }
      if (!hit) return fail(401, 'Q663', 'that signing secret is not the one this room was connected with.')
      id = hit
    }
    const c = conns.get(id)
    if (!c) return fail(404, 'Q661', 'unknown Slack connection id.')
    if (c.connected) {
      const s = secretsOf(id)
      // Unreadable (the relay's key changed): nobody can prove the secret, and the connection cannot
      // send or receive anyway, so removing it is allowed. A readable one needs its own secret.
      if (s && !safeEqual(s.signingSecret, given)) return fail(401, 'Q663', 'that signing secret is not the one this connection was made with.')
    }
    const r = runtime.get(id)
    if (r && r.unobserve) { try { r.unobserve() } catch { } }
    runtime.delete(id); conns.delete(id); save()
    if (c.connected) sayInRoom(c.room, `Slack (#${c.channelName || c.channel}) was disconnected from this room.`, { src: 'slack' })
    return { status: 200, body: { ok: true } }
  }

  async function events(req, res, id, raw) {
    const c = conns.get(id)
    if (!c) return send(res, 404, { ok: false, code: 'Q661', why: 'Q661 unknown Slack connection id.' })
    const payload = json(raw) || {}
    if (!c.connected) {
      // Slack checks the request URL while the app is being created, before anyone has a signing
      // secret to give us. The one unsigned answer: the challenge, echoed, and nothing else.
      if (payload.type === 'url_verification' && typeof payload.challenge === 'string' && payload.challenge.length <= 256) return send(res, 200, { challenge: payload.challenge })
      return send(res, 409, { ok: false, code: 'Q661', why: 'Q661 this Slack connection is not finished; run slack connect.' })
    }
    const s = secretsOf(id)
    const ok = verifySlackSignature({ signingSecret: s && s.signingSecret, timestamp: req.headers['x-slack-request-timestamp'], signature: req.headers['x-slack-signature'], rawBody: raw, nowS: Math.floor(now() / 1000) })
    if (!ok) return send(res, 401, { ok: false, code: 'Q663', why: 'Q663 bad Slack signature.' })
    if (payload.type === 'url_verification') return send(res, 200, { challenge: String(payload.challenge || '') })
    // Answer first: Slack retries anything slower than 3 s, and the room write can wait a tick.
    send(res, 200, { ok: true })
    if (payload.type === 'event_callback') setImmediate(() => { deliver(id, payload).catch((e) => log(`[slack] delivering an event failed: ${e.message}`)) })
  }

  /** server.js calls this for every request under /slack/. Always answers. */
  async function handle(req, res) {
    const url = String(req.url || '').split('?')[0]
    if (req.method !== 'POST') return send(res, 405, { ok: false, why: 'POST only' })
    if (!key) return send(res, 503, { ok: false, code: 'Q660', why: 'Q660 Slack is not enabled on this relay: set HIVE_SLACK_KEY (any long random string) in its environment and restart it.' })
    let raw
    try { raw = await readBody(req) } catch (e) { return send(res, e.tooLarge ? 413 : 400, { ok: false, why: e.tooLarge ? 'body too large' : 'could not read the body' }) }
    try {
      const m = url.match(/^\/slack\/events\/([A-Za-z0-9_-]{8,64})$/)
      if (m) return await events(req, res, m[1], raw)
      const route = { '/slack/prepare': prepare, '/slack/connect': connect, '/slack/disconnect': disconnect }[url]
      if (!route) return send(res, 404, { ok: false, why: 'no such Slack route' })
      const out = await route(req, raw)
      return send(res, out.status, out.body)
    } catch (e) {
      log(`[slack] ${url} failed: ${e.message}`)   // never the body: it may hold the token
      if (!res.headersSent) return send(res, 500, { ok: false, why: 'the relay failed handling that Slack request' })
    }
  }

  return {
    handle,
    stop: () => { clearInterval(timer); for (const r of runtime.values()) if (r.unobserve) { try { r.unobserve() } catch { } } },
    /** for tests: drain every connection's send queue */
    idle: async () => { for (const r of runtime.values()) await r.queue },
    attachAll: () => { for (const id of conns.keys()) attach(id) },
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
