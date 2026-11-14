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
// ONE LINK (13 Nov 2026). The contract above makes every person create their own Slack app and carry
// a bot token and a signing secret to a terminal; a person who only works with cloud agents has no
// terminal. When the relay's owner has registered ONE Slack app and set HIVE_SLACK_CLIENT_ID,
// HIVE_SLACK_CLIENT_SECRET and HIVE_SLACK_APP_SECRET (that app's signing secret), a workspace installs
// it through Slack's OAuth instead, and nobody but the relay ever holds a secret:
//   POST /slack/prepare          also answers installUrl
//   GET  /slack/install/<id>     302 to Slack's authorize page; `state` is the prepared id
//   GET  /slack/oauth/callback   exchanges the code, joins the channel the person picked on Slack's
//                                own screen, connects; answers a small page
//   POST /slack/events           the shared app's events, signed with the app's secret, routed to a
//                                connection by workspace id + channel id
//   POST /slack/status {id}      {connected, pending?, ended?, channel?}: an agent can confirm without secrets
// A one-link connection has no secret of its own, so it ends from Slack: the bot is removed from the
// channel, or the app from the workspace. {id} alone also ends it (the id is only ever given to the
// person who ran slack connect); {room} alone never does.
// More codes: Q669 one-link setup is not enabled on this relay, Q670 that channel is already
// connected, Q671 a direct message cannot be connected, Q672 Slack did not complete the install.
//
// A PRIVATE ROOM (hs_...) AND SLACK (14 Nov 2026). A room id is not a secret in a private room: every
// past guest knows it, and the relay refuses their websocket without a live invite. /slack/prepare
// took only the room id, so the same people could attach their own Slack channel and read the chat
// there. Now, for a private room: prepare, list and disconnect-by-room need the HOST's token (the
// `access` callback is the relay's own authorize()), because a Slack channel adds everyone in it to
// the room's chat and only the host decides who is in the room. The connection belongs to the room,
// not to one token: the host's token is re-minted, and any valid host token lists or ends it.
// Q674 a private room needs the host's invite here, Q675 that invite is not the host's.
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
import { isSecuredRoom } from './token.js'

export const SLACK_PREFIX = '/slack/'
const DEFAULT_API = 'https://slack.com/api'
const STORE_FILE = 'slack-relay.json'
const PREPARED_TTL_MS = 24 * 3600 * 1000
const MAX_PREPARED = 2000          // unconnected ids at once: a cap, so /slack/prepare cannot fill the disk
const MAX_BODY = 1024 * 1024       // Slack event payloads are a few KB
const SIG_WINDOW_S = 300           // Slack's own replay window
const SEEN_EVENTS = 1000           // event ids remembered per connection, for Slack's retries
const USERS_TTL_MS = 5 * 60 * 1000 // cache users.info results per connection for 5 min (B3)
const MAX_TEXT = 3500
const ROOM_RE = /^[A-Za-z0-9_.~-]{1,200}$/
const CHANNEL_RE = /^[CGD][A-Z0-9]{2,30}$/
// The same rule as hive-slack.js notFromAPerson: these subtypes are a person saying something.
const PERSON_SUBTYPES = new Set(['thread_broadcast', 'file_share'])
const FORWARDED_MAP = 'slack_forwarded'
const DEFAULT_AUTHORIZE = 'https://slack.com/oauth/v2/authorize'
const STATUS_CHECK_MS = 5000       // a waiting connection asks Slack "is the bot in yet?" at most this often
/** What the shared app asks for. incoming-webhook is there for one thing: it puts Slack's own channel
 *  picker on the approval screen and tells us the channel. The webhook URL it also returns is dropped. */
export const SHARED_BOT_SCOPES = ['chat:write', 'channels:history', 'groups:history', 'users:read', 'channels:read', 'groups:read', 'channels:join', 'incoming-webhook']
export const SHARED_BOT_EVENTS = ['message.channels', 'message.groups', 'member_joined_channel', 'member_left_channel', 'channel_left', 'group_left', 'app_uninstalled', 'tokens_revoked']
/** chat.postMessage errors that mean a one-link connection is over, and what to say about it. */
const GONE = {
  not_in_channel: 'the bot is no longer in the channel', channel_not_found: 'the bot is no longer in the channel',
  is_archived: 'the channel was archived',
  token_revoked: 'the Hivecode app was removed from the Slack workspace', account_inactive: 'the Hivecode app was removed from the Slack workspace',
  invalid_auth: 'the Hivecode app was removed from the Slack workspace',
}
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

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
 *   clientId, clientSecret, appSecret   the relay owner's ONE Slack app (one-link setup); all three or it is off
 *   authorizeUrl   Slack's authorize page (HIVE_SLACK_AUTHORIZE points tests at a fake)
 */
export function makeSlackRelay({ getDoc, docs, access = null, dir = null, key = '', fetchImpl = globalThis.fetch, api = DEFAULT_API, publicUrl = '', now = Date.now, log = () => { }, tickMs = 1000, clientId = '', clientSecret = '', appSecret = '', authorizeUrl = DEFAULT_AUTHORIZE } = {}) {
  // id -> { room, at, connected, channel, channelName, team, botUserId, allow, sealed }
  // a one-link connection also has { shared: true, teamId } and, while it waits for the bot to be
  // invited to a private channel, { connected: false, pending: 'invite' }; its sealed part is the token alone.
  const conns = new Map()
  const oneLink = Boolean(key && clientId && clientSecret && appSecret)
  const runtime = new Map()          // id -> { secrets, seen:Set, seenOrder:[], users:Map, queue:Promise, doc, unobserve }
  const storePath = dir ? path.join(dir, STORE_FILE) : null

  // ---- the store ------------------------------------------------------------------------------
  if (storePath) {
    try {
      const j = JSON.parse(fs.readFileSync(storePath, 'utf8'))
      // A private room's record with no host mark was made before prepare asked who was asking
      // (anyone holding the room id could make one), so it is not served; the host connects again.
      for (const [id, c] of Object.entries((j && j.conns) || {})) if (!(c && isSecuredRoom(String(c.room || '')) && !c.private)) conns.set(id, c)
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

  // ---- a private room's host --------------------------------------------------------------------
  const HOST_ROLES = ['admin', 'maintainer']   // the same two /__hive/revoke accepts
  /** Who is asking, for a private room. { secured:false } for a normal room: nothing changes there.
   *  Otherwise { secured:true, name } for the host, or { secured:true, refuse } with the answer to send.
   *  No `access` (an embedder that never wired the relay's authorize) refuses: fail closed. */
  const hostOf = async (room, token) => {
    if (!isSecuredRoom(room)) return { secured: false }
    let a = null
    try { a = access ? await access(room, String(token || '')) : null } catch { a = null }
    if (!a || !a.ok) return { secured: true, refuse: fail(401, 'Q674', 'this is a private room: connecting it to Slack needs the host\'s own invite. Run slack connect on the computer that hosts the room.') }
    if (!HOST_ROLES.includes(a.role)) return { secured: true, refuse: fail(403, 'Q675', 'only the host of a private room can connect it to Slack: a Slack channel adds everyone in it to the room\'s chat.') }
    return { secured: true, name: String(a.name || 'the host') }
  }
  /** What a rebuilt record keeps: that the host made it, and who that was. */
  const hostMark = (c) => (c && c.private ? { private: true, by: c.by || '' } : {})
  /** What the room is told when a channel is connected. A private room is also told who did it and
   *  what it means: the channel's members are now readers and writers of this chat. */
  const connectedLine = (c) => {
    const base = `Slack is connected to this room (#${c.channelName || c.channel})`
    return c.private ? `${base} by ${c.by || 'the host'}. Everyone in that Slack channel can now read this room's chat and post into it.` : `${base}.`
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
        if (!j.ok) {
          log(`[slack] chat.postMessage refused: ${j.error}`)
          // A one-link connection has nobody to run slack disconnect for it: when Slack says the bot or
          // the app is gone, the connection goes too, even if Slack never sent the event for it.
          if (c.shared && GONE[j.error]) drop(id, GONE[j.error])
        }
      } catch (e) { log(`[slack] chat.postMessage failed: ${e.code || e.message}`) }
    }).catch(() => { }) // the queue itself never rejects: a rejection here would be unhandled
    return r.queue
  }
  /** A one-link connection ends: its token is forgotten, nothing is watched, and the room is told once.
   *  The id goes back to being an unfinished one (for a day, like any other), so /slack/status can say
   *  it ended and why, and the same link connects the room again. */
  const drop = (id, why) => {
    const c = conns.get(id)
    if (!c) return
    const r = runtime.get(id)
    if (r && r.unobserve) { try { r.unobserve() } catch { } }
    runtime.delete(id)
    conns.set(id, { room: c.room, at: now(), connected: false, ended: why, ...hostMark(c) })
    save()
    if (c.connected) sayInRoom(c.room, `Slack (#${c.channelName || c.channel}) is no longer connected to this room: ${why}. Run slack connect to connect it again.`, { src: 'slack' })
  }
  /** The connection that already holds this channel, if any. The same channel twice would say
   *  everything twice, in two rooms. Channel ids are only unique inside a workspace, so another
   *  workspace's one-link connection with the same id is a different channel. */
  const holderOf = (id, teamId, channel) => {
    for (const [oid, o] of conns) if (oid !== id && o.connected && o.channel === channel && (!o.teamId || o.teamId === teamId)) return o
    return null
  }
  const TAKEN = 'that channel is already connected to another room'
  /** A one-link connection that was waiting (or was just made) starts working. False when the
   *  channel was taken in the meantime: two rooms can wait on the same private channel, and one
   *  invite must connect one of them, not both (found by Claude-cloud's review, O9b). */
  const finishShared = (id) => {
    const c = conns.get(id)
    if (!c || c.connected || !c.shared) return false
    if (holderOf(id, c.teamId, c.channel)) {
      const r = runtime.get(id)
      if (r && r.unobserve) { try { r.unobserve() } catch { } }
      runtime.delete(id)
      conns.set(id, { room: c.room, at: now(), connected: false, ended: TAKEN, ...hostMark(c) })
      save()
      sayInRoom(c.room, `Slack (#${c.channelName || c.channel}) was not connected to this room: Q670 ${TAKEN}. Run slack connect and pick another channel.`, { src: 'slack' })
      return false
    }
    const { pending, ...rest } = c
    conns.set(id, { ...rest, connected: true, connectedAt: now() })
    rt(id).doc = null
    save()
    const line = `Slack is connected to this room (#${c.channelName || c.channel}).`
    sayInRoom(c.room, connectedLine(c), { src: 'slack' })   // src: the forwarder does not send this one back
    attach(id)                                  // only lines after this one go to Slack
    // The channel side says who it was bridged to. The link is an invitation: whoever approves it
    // connects THEIR channel to the link-maker's room, and Slack's screen does not name the room.
    let names = []
    try { names = [...new Set(membersOf(getDoc(c.room)).map((u) => String(u.name)))].slice(0, 8) } catch { }
    post(id, `${line}${names.length ? ` In the room now: ${names.join(', ')}.` : ''} To disconnect, remove this bot from the channel.`)
    return true
  }
  /** Waiting for /invite: ask Slack whether the bot is in yet (the event for it may never come). */
  const checkInvited = async (id) => {
    const c = conns.get(id), r = rt(id), s = secretsOf(id)
    if (!c || c.connected || c.pending !== 'invite' || !s) return
    if (r.checkedAt && now() - r.checkedAt < STATUS_CHECK_MS) return
    r.checkedAt = now()
    try {
      const info = await slack('conversations.info', s.botToken, { channel: c.channel })
      if (info.ok && info.channel && info.channel.is_member) {
        if (info.channel.name) conns.set(id, { ...conns.get(id), channelName: info.channel.name })
        finishShared(id)
      }
    } catch { /* asked again on the next status call */ }
  }
  const timer = setInterval(() => { for (const id of conns.keys()) attach(id) }, tickMs)
  if (timer.unref) timer.unref()

  // ---- Slack -> room --------------------------------------------------------------------------
  const senderOf = async (id, user, c) => {
    const r = rt(id)
    const secured = isSecuredRoom(c.room)
    const cached = r.users.get(user)
    if (cached && now() - cached.at < USERS_TTL_MS) return cached
    let handle = user, denied = false, cacheable = !secured
    const s = secretsOf(id)
    if (!s) return { handle, denied: secured }
    try {
      const j = await slack('users.info', s.botToken, { user })
      if (j && j.ok && j.user) {
        const u = j.user
        handle = u.name || (u.profile && u.profile.display_name) || user
        cacheable = true
        if (secured && (u.deleted || u.is_bot || u.is_restricted || u.is_ultra_restricted || u.is_stranger || (c.teamId && u.team_id && u.team_id !== c.teamId))) {
          denied = true
        }
      } else if (secured) {
        denied = true
      }
    } catch {
      if (secured) denied = true
    }
    const entry = { handle, denied, at: now() }
    if (cacheable) r.users.set(user, entry)
    return entry
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
    if (isSecuredRoom(c.room) && c.teamId && ((ev.team && ev.team !== c.teamId) || (payload.team_id && payload.team_id !== c.teamId))) return
    const text = String(ev.text || '').trim()
    if (!text) return
    const sender = await senderOf(id, ev.user, c)
    if (sender.denied) return
    const by = slackSender(sender.handle)
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
    const who = await hostOf(room, j.token)
    if (who.refuse) return who.refuse          // before anything is looked up: no id, no link, for anyone else
    sweepPrepared()
    // ONE UNFINISHED ID PER ROOM. A first `slack connect` that stops after prepare (bot not invited
    // yet, a wrong token) has already printed a manifest with this URL, and the person may already
    // have made the Slack app from it. Running it again must give the same URL, or the app points
    // at an id nobody will ever connect (found by Claude-cloud reviewing part A).
    for (const [pid, c] of conns) {
      if (c.room === room && !c.connected) {
        // Asking again is a new attempt: an id that ended (bot removed, channel taken) stops saying so,
        // or slack connect would read "ended" from /slack/status and give up before the link is opened.
        if (c.ended) { const { ended, ...rest } = c; conns.set(pid, { ...rest, at: now() }); save() }
        return prepared(req, pid)
      }
    }
    if ([...conns.values()].filter((c) => !c.connected).length >= MAX_PREPARED) return fail(503, 'Q661', 'this relay has too many unfinished Slack connections; try again later.')
    const id = crypto.randomBytes(16).toString('base64url')
    conns.set(id, { room, at: now(), connected: false, ...(who.secured ? { private: true, by: who.name } : {}) })
    save()
    return prepared(req, id)
  }
  const prepared = (req, id) => ({
    status: 200,
    body: { ok: true, id, eventsUrl: `${originOf(req)}${SLACK_PREFIX}events/${id}`, ...(oneLink ? { installUrl: `${originOf(req)}${SLACK_PREFIX}install/${id}` } : {}) },
  })

  async function connect(req, raw) {
    const j = json(raw) || {}
    const id = String(j.id || ''), botToken = String(j.botToken || ''), signingSecret = String(j.signingSecret || ''), channel = String(j.channel || '')
    const c = conns.get(id)
    if (!c) return fail(404, 'Q661', 'unknown or expired Slack connection id; run slack connect again.')
    if (c.connected && c.shared) return fail(401, 'Q663', 'this connection was made with the one-link setup and has no signing secret; remove the bot from the channel to end it, then run slack connect again.')
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
    conns.set(id, { room: c.room, at: c.at, connected: true, connectedAt: now(), channel, channelName, team: auth.team || '', teamId: String(auth.team_id || ''), botUserId: auth.user_id || '', allow, sealed: sealSecrets({ botToken, signingSecret }, key), ...hostMark(c) })
    r.secrets = { botToken, signingSecret }; r.unreadable = false; r.doc = null
    save()
    const line = `Slack is connected to this room (#${channelName}).`
    sayInRoom(c.room, connectedLine(conns.get(id)), { src: 'slack' })   // src: the forwarder does not send this one back
    attach(id)                                  // only lines after this one go to Slack
    post(id, line)
    return { status: 200, body: { ok: true, team: auth.team || '', channel: channelName, eventsUrl: `${originOf(req)}${SLACK_PREFIX}events/${id}` } }
  }

  async function disconnect(req, raw) {
    const j = json(raw) || {}
    let id = String(j.id || '')
    const given = String(j.signingSecret || '')
    // A private room's host ends every Slack connection of the room with their own token: no id, no
    // signing secret, one-link connections included. They own the guest list, and this is part of it.
    if (!id && j.room && j.token != null && isSecuredRoom(String(j.room))) {
      const room = String(j.room)
      const who = await hostOf(room, j.token)
      if (who.refuse) return who.refuse
      let ended = 0
      for (const [cid, c] of [...conns]) {
        if (c.room !== room) continue
        const r = runtime.get(cid)
        if (r && r.unobserve) { try { r.unobserve() } catch { } }
        runtime.delete(cid); conns.delete(cid)
        if (c.connected) { ended++; sayInRoom(room, `Slack (#${c.channelName || c.channel}) was disconnected from this room by ${who.name}.`, { src: 'slack' }) }
      }
      save()
      return { status: 200, body: { ok: true, ended } }
    }
    // From another computer the CLI does not know the id: {room, signingSecret} finds the room's
    // connection whose secret matches. Every connection of the room is compared, constant time.
    if (!id && j.room) {
      const room = String(j.room)
      const all = [...conns].filter(([, c]) => c.room === room && c.connected)
      // A one-link connection has no secret, so the room id alone must never end it: the room id is
      // known to everyone in the room, the connection id only to the person who connected.
      const ofRoom = all.filter(([, c]) => !c.shared)
      if (!all.length) return fail(404, 'Q661', 'this room has no Slack connection on this relay.')
      if (!ofRoom.length) return fail(401, 'Q663', 'this room was connected with the one-link setup: remove the bot from the channel in Slack, or run slack disconnect on the computer that connected it.')
      let hit = ''
      for (const [cid] of ofRoom) { const s = secretsOf(cid); if (!hit && (!s || safeEqual(s.signingSecret, given))) hit = cid }
      if (!hit) return fail(401, 'Q663', 'that signing secret is not the one this room was connected with.')
      id = hit
    }
    const c = conns.get(id)
    if (!c) return fail(404, 'Q661', 'unknown Slack connection id.')
    if (c.connected && !c.shared) {
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

  // ---- one link: the owner's Slack app, installed through Slack's OAuth ---------------------------
  /** A small page for the person's browser. Text only: every line is escaped, `code` is the one mark. */
  const page = (res, status, title, lines) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
    const body = lines.map((l) => `<p>${esc(l).replace(/`([^`]+)`/g, '<code>$1</code>')}</p>`).join('')
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>`
      + '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.25rem;color:#111318;background:#fff}h1{font-size:1.3rem}code{background:#eef0f4;padding:.1em .35em;border-radius:4px}'
      + '@media(prefers-color-scheme:dark){body{background:#111318;color:#e8e9ee}code{background:#252932}}</style></head>'
      + `<body><h1>${esc(title)}</h1>${body}</body></html>`)
  }
  const OFF = ['Q669 One-link Slack setup is not enabled on this relay. Its owner sets HIVE_SLACK_CLIENT_ID, HIVE_SLACK_CLIENT_SECRET and HIVE_SLACK_APP_SECRET. Until then, run `slack connect --manifest`.']
  const STALE = ['Q661 This link was already used, or it is more than a day old.', 'If you have just connected Slack, it worked: look for "Slack is connected to this room" in your channel. Otherwise run `slack connect` again for a new link.']
  const NOT_CONNECTED = 'Slack was not connected'
  const slackWord = (e) => (/^[a-z0-9_]{1,60}$/.test(String(e || '')) ? String(e) : 'no reason given')
  const redirectUri = (req) => `${originOf(req)}${SLACK_PREFIX}oauth/callback`

  function install(req, res, id) {
    if (!oneLink) return page(res, 503, 'One-link setup is off', OFF)
    sweepPrepared()
    const c = conns.get(id)
    if (!c || c.connected) return page(res, 404, 'This link is not valid any more', STALE)
    const q = new URLSearchParams({ client_id: clientId, scope: SHARED_BOT_SCOPES.join(','), redirect_uri: redirectUri(req), state: id })
    res.writeHead(302, { location: `${authorizeUrl}?${q}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end()
  }

  async function callback(req, res, query) {
    if (!oneLink) return page(res, 503, 'One-link setup is off', OFF)
    const state = String(query.get('state') || ''), code = String(query.get('code') || '')
    sweepPrepared()
    const c = /^[A-Za-z0-9_-]{8,64}$/.test(state) ? conns.get(state) : null
    // Unknown, expired, or already connected: nothing is changed, whatever else the request carries.
    if (!c || c.connected) return page(res, 404, 'This link is not valid any more', STALE)
    if (query.get('error') || !code) return page(res, 400, NOT_CONNECTED, [`Q672 Slack did not complete the install (${slackWord(query.get('error'))}). Nothing was changed.`, 'Open the link again to try once more.'])
    const r = rt(state)
    if (r.busy) return page(res, 409, 'Still working on it', ['This link is being finished in another tab. Give it a few seconds.'])
    r.busy = true
    try {
      let tok = null
      try {
        const out = await fetchImpl(`${api.replace(/\/$/, '')}/oauth.v2.access`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri(req) }).toString(),
        })
        tok = await out.json().catch(() => null)
      } catch (e) { return page(res, 502, NOT_CONNECTED, [`Q672 The relay could not reach Slack (${slackWord(e && e.code)}). Nothing was changed.`, 'Open the link again to try once more.']) }
      if (!tok || !tok.ok || !tok.access_token) return page(res, 400, NOT_CONNECTED, [`Q672 Slack did not complete the install (${slackWord(tok && tok.error)}). Nothing was changed.`, 'Open the link again to try once more.'])
      if (!tok.team || !tok.team.id) return page(res, 400, NOT_CONNECTED, ['Q672 Slack installed the app for a whole organisation, not one workspace; that is not supported yet. Nothing was changed.'])
      const botToken = String(tok.access_token), teamId = String(tok.team.id), botUserId = String(tok.bot_user_id || '')
      const hook = tok.incoming_webhook || {}           // only the channel is read; the webhook URL is dropped here
      const channel = String(hook.channel_id || '')
      let channelName = String(hook.channel || '').replace(/^#/, '')
      const dm = [`Q671 ${channel ? 'A direct message' : 'No channel'} cannot be connected to a room. Nothing was changed.`, 'Open the link again and pick a channel.']
      if (!CHANNEL_RE.test(channel) || channel[0] === 'D') return page(res, 400, NOT_CONNECTED, dm)
      const takenPage = (o) => page(res, 409, NOT_CONNECTED, [`Q670 #${(o && o.channelName) || channelName || channel} is already connected to a room on this relay. Nothing was changed.`, 'Open the link again and pick another channel, or disconnect that one first.'])
      let holder = holderOf(state, teamId, channel)
      if (holder) return takenPage(holder)
      let info = null, member = false
      try { info = await slack('conversations.info', botToken, { channel }) } catch (e) { return page(res, 502, NOT_CONNECTED, [`Q672 The relay could not reach Slack (${slackWord(e && e.code)}). Nothing was changed.`, 'Open the link again to try once more.']) }
      if (info.ok && info.channel) {
        if (info.channel.is_im || info.channel.is_mpim) return page(res, 400, NOT_CONNECTED, dm)
        channelName = info.channel.name || channelName
        member = !!info.channel.is_member
        // A public channel the bot is not in yet: it joins by itself. If Slack refuses, the person invites it.
        if (!member && !info.channel.is_private) { try { member = !!(await slack('conversations.join', botToken, { channel })).ok } catch { member = false } }
      } else if (info.error !== 'channel_not_found') {
        // channel_not_found is a private channel the bot is not in yet. Anything else is a real refusal.
        return page(res, 400, NOT_CONNECTED, [`Q672 Slack would not show that channel to the bot (${slackWord(info.error)}). Nothing was changed.`, 'Open the link again to try once more.'])
      }
      // Everything above awaited Slack, so look again: the id may be finished, or the channel taken,
      // by another tab or another room that approved in the meantime.
      const again = conns.get(state)
      if (!again || again.connected) return page(res, 404, 'This link is not valid any more', STALE)
      holder = holderOf(state, teamId, channel)
      if (holder) return takenPage(holder)
      const name = channelName || channel
      conns.set(state, { room: c.room, at: c.at, connected: false, pending: 'invite', shared: true, channel, channelName: name, team: String(tok.team.name || ''), teamId, botUserId, allow: [], sealed: sealSecrets({ botToken }, key), ...hostMark(c) })
      r.secrets = { botToken }; r.unreadable = false
      if (member) {
        if (!finishShared(state)) return takenPage(null)
        return page(res, 200, 'Slack is connected', [`Slack is connected to #${name}. Messages in that channel reach the room, and the room's messages appear there.`, 'You can close this tab.'])
      }
      save()
      return page(res, 200, 'One more step', [`#${name} is a private channel, so the bot has to be invited. In Slack, open #${name} and type \`/invite @Hivecode\`.`, 'The room connects as soon as the bot is in the channel. You can close this tab.'])
    } finally { r.busy = false }
  }

  async function status(req, raw) {
    const id = String((json(raw) || {}).id || '')
    if (!conns.get(id)) return fail(404, 'Q661', 'unknown or expired Slack connection id; run slack connect again.')
    await checkInvited(id)
    const c = conns.get(id)
    if (!c) return fail(404, 'Q661', 'unknown or expired Slack connection id; run slack connect again.')
    return { status: 200, body: { ok: true, connected: !!c.connected, ...(!c.connected && c.pending ? { pending: c.pending } : {}), ...(!c.connected && c.ended ? { ended: c.ended } : {}), ...(c.channelName ? { channel: c.channelName } : {}) } }
  }

  /** A private room's host asks what is attached to their room. Never a token or a secret. */
  async function list(req, raw) {
    const j = json(raw) || {}
    const room = String(j.room || '')
    if (!ROOM_RE.test(room)) return fail(400, 'Q661', 'that is not a room id (expected the part after "|" in the room link).')
    const who = await hostOf(room, j.token)
    if (!who.secured) return fail(400, 'Q674', 'listing Slack connections by room is for private rooms: in a normal room the room id is the only key, and it is not proof of who is asking.')
    if (who.refuse) return who.refuse
    const connections = [...conns].filter(([, c]) => c.room === room && c.connected)
      .map(([id, c]) => ({ id, channel: c.channelName || c.channel, team: c.team || '', by: c.by || '', connectedAt: c.connectedAt || c.at || 0, shared: !!c.shared }))
    return { status: 200, body: { ok: true, connections } }
  }

  /** The shared app's events: one URL for every workspace, so the workspace and the channel choose the room. */
  async function sharedEvents(req, res, raw) {
    if (!oneLink) return send(res, 503, { ok: false, code: 'Q669', why: 'Q669 one-link Slack setup is not enabled on this relay.' })
    const ok = verifySlackSignature({ signingSecret: appSecret, timestamp: req.headers['x-slack-request-timestamp'], signature: req.headers['x-slack-signature'], rawBody: raw, nowS: Math.floor(now() / 1000) })
    if (!ok) return send(res, 401, { ok: false, code: 'Q663', why: 'Q663 bad Slack signature.' })
    const payload = json(raw) || {}
    if (payload.type === 'url_verification') return send(res, 200, { challenge: String(payload.challenge || '') })
    send(res, 200, { ok: true })      // first: Slack's 3 s deadline. An event for nobody is dropped below.
    if (payload.type === 'event_callback') setImmediate(() => { routeShared(payload).catch((e) => log(`[slack] delivering an event failed: ${e.message}`)) })
  }
  const routeShared = async (payload) => {
    const ev = payload.event || {}
    const team = String(payload.team_id || ev.team || '')
    const mine = team ? [...conns].filter(([, c]) => c.shared && c.teamId === team) : []
    if (!mine.length) return
    const botGone = ev.type === 'app_uninstalled' || (ev.type === 'tokens_revoked' && (!ev.tokens || (Array.isArray(ev.tokens.bot) && ev.tokens.bot.length > 0)))
    if (botGone) { for (const [id] of mine) drop(id, GONE.token_revoked); return }
    const channel = typeof ev.channel === 'string' ? ev.channel : ''
    if (!channel) return
    for (const [id, c] of mine) {
      if (c.channel !== channel) continue
      if (ev.type === 'member_joined_channel') { if (!c.connected && c.pending === 'invite' && ev.user && ev.user === c.botUserId) finishShared(id) }
      else if ((ev.type === 'member_left_channel' && ev.user && ev.user === c.botUserId) || ev.type === 'channel_left' || ev.type === 'group_left') drop(id, GONE.not_in_channel)
      else if (ev.type === 'message' && c.connected) await deliver(id, payload)
    }
  }

  /** server.js calls this for every request under /slack/. Always answers. */
  async function handle(req, res) {
    const full = String(req.url || '')
    const url = full.split('?')[0]
    // The two pages a person's browser opens. Never logged with their query: it carries Slack's code.
    if (req.method === 'GET' && (url.startsWith('/slack/install/') || url === '/slack/oauth/callback')) {
      if (!key) return page(res, 503, 'Slack is off on this relay', ['Q660 Slack is not enabled on this relay: its owner sets HIVE_SLACK_KEY in its environment and restarts it.'])
      try {
        if (url === '/slack/oauth/callback') return await callback(req, res, new URLSearchParams(full.split('?')[1] || ''))
        const m = url.match(/^\/slack\/install\/([A-Za-z0-9_-]{8,64})$/)
        return m ? install(req, res, m[1]) : page(res, 404, 'This link is not valid any more', STALE)
      } catch (e) {
        log(`[slack] ${url === '/slack/oauth/callback' ? url : '/slack/install'} failed: ${e.message}`)
        if (!res.headersSent) return page(res, 500, 'Something went wrong', ['The relay failed handling this link. Open it again to try once more.'])
        return
      }
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, why: 'POST only' })
    if (!key) return send(res, 503, { ok: false, code: 'Q660', why: 'Q660 Slack is not enabled on this relay: set HIVE_SLACK_KEY (any long random string) in its environment and restart it.' })
    let raw
    try { raw = await readBody(req) } catch (e) { return send(res, e.tooLarge ? 413 : 400, { ok: false, why: e.tooLarge ? 'body too large' : 'could not read the body' }) }
    try {
      const m = url.match(/^\/slack\/events\/([A-Za-z0-9_-]{8,64})$/)
      if (m) return await events(req, res, m[1], raw)
      if (url === '/slack/events') return await sharedEvents(req, res, raw)
      const route = { '/slack/prepare': prepare, '/slack/connect': connect, '/slack/disconnect': disconnect, '/slack/status': status, '/slack/list': list }[url]
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
