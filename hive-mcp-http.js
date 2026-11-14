// hive-mcp-http — Hivecode as a REMOTE MCP server, so Slackbot can drive a room.
//
//   node hive-mcp-http.js "<relay|room>" --port 8790 [--name Hivecode] [--auth slack|none] [--trust-proxy]
//   env: SLACK_SIGNING_SECRET (required for --auth slack), HIVE_TOKEN, HIVE_TRUST_PROXY=1 (behind a proxy)
//
// WHY A SECOND MCP SERVER. hive-mcp.js speaks stdio, which is what a local agent needs and what
// Slack explicitly does not accept: the Slackbot MCP Client connects OUT over Streamable HTTP,
// and the deprecated HTTP+SSE transport and stdio are both refused. So this is not a rewrite of
// hive-mcp.js, it is the other transport, deliberately kept to a small surface.
//
// WHAT IS EXPOSED, AND WHY IT IS NOT ALL 26 TOOLS.
// Slack aborts any tool that has not returned in 60 SECONDS. hive_wait is a long poll whose whole
// purpose is to block until work arrives -- it would time out every time and surface an error to
// the user, so it is not here. Nor are the editing tools: a person typing into Slackbot is asking
// "what is happening" and "stop that", not writing code from their phone. Every tool below
// returns in milliseconds.
//
// TRUST. Slack attaches the caller's identity as `_meta.slack.user_id` on every tools/call. That
// is ordinary request JSON and anybody who can reach this endpoint can forge it, so nothing reads
// it until the request signature has been verified. In `--auth slack` mode an unsigned request is
// refused before it is parsed as a call at all.

import fs from 'fs'
import http from 'http'
import crypto from 'crypto'
import { startSync, parseLink } from './sync.js'
import { attachRateLimit } from './limits.js'
import { makeSlackActorCheck, formatSlackSender, slackPost } from './hive-slack.js'
import { isSecuredRoom } from './token.js'
import { resolveRoomToken } from './hive-room-key.js'
import { realpathSync as __hiveRealpath } from 'fs'
import { resolve as __hiveResolve } from 'path'
import { fileURLToPath as __hiveFileURLToPath } from 'url'

import { VERSION } from "./hive-version.js"
export { VERSION }

const PROTOCOL = '2025-06-18'
const MAX_BODY = 1 << 20           // a control-plane request is never a megabyte
const SKEW_MS = 5 * 60 * 1000      // Slack's own replay window
const MAX_SESSIONS = 1000          // LRU bound on tracked MCP session IDs

/** Slack's v0 request signature.
 *
 *  Two things here are load-bearing and easy to get wrong: the comparison must be timing-safe,
 *  and the timestamp window must be checked SEPARATELY -- a valid signature on an hour-old body
 *  is a replay, and it verifies perfectly. */
export function verifySlack({ raw, timestamp, signature, secret, now = Date.now() }) {
  if (!secret) return { ok: false, why: 'Q510 no signing secret configured' }
  if (!timestamp || !signature) return { ok: false, why: 'Q511 request is not signed' }
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, why: 'Q511 request is not signed' }
  if (Math.abs(now - ts * 1000) > SKEW_MS) return { ok: false, why: 'Q512 signature is outside the replay window' }
  const mine = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')
  const a = Buffer.from(mine), b = Buffer.from(String(signature))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, why: 'Q513 signature does not match' }
  return { ok: true }
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })

/** Resolve a typed name to the room's real spelling. An unmatched name must REFUSE rather than
 *  write a control entry nothing reads -- see the same bug and comment in hive-agent.js. */
export function resolveName(hive, who) {
  const want = String(who || '').toLowerCase()
  for (const p of (hive.members ? hive.members() : [])) if (String(p.name).toLowerCase() === want) return p.name
  return null
}

const pausedOf = (hive, who) => { const c = hive.doc.getMap('controls').get(who); return !!(c && c.state === 'paused') }

// `room` is passed in: startSync returns no room field, so `hive.room` is undefined and the
// status tool reported "room: undefined" to whoever asked Slackbot what was going on.
export function makeTools(hive, room = '', { actorCheck = null, allow = [] } = {}) {
  const ai = () => (hive.members ? hive.members() : []).filter((p) => p.kind === 'ai')
  const userIdOf = (actor) => {
    const s = String(actor || '')
    return s.startsWith('slack:') ? s.slice(6) : ''
  }
  return [
    {
      name: 'hive_status',
      description: 'What is happening in the Hivecode room right now: how many agents are running or paused, how many tasks are open, and what is awaiting a human. Ask this first.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const people = hive.members ? hive.members() : []
        const tasks = [...hive.doc.getMap('tasks').values()]
        const paused = people.filter((p) => pausedOf(hive, p.name))
        return text([
          `room: ${room || '(unnamed)'}`,
          `${people.length} in the room (${people.filter((p) => p.kind === 'ai').length} agents, ${paused.length} paused)`,
          `${tasks.filter((t) => t.status === 'accepted').length} in progress, ${tasks.filter((t) => t.status === 'pending').length} awaiting approval, ${tasks.filter((t) => t.status === 'done').length} done`,
          paused.length ? `paused: ${paused.map((p) => p.name).join(', ')}` : 'nothing is paused',
        ].join('\n'))
      },
    },
    {
      name: 'hive_members',
      description: 'Who is in the room, whether each one is a human or an AI agent, and whether it is running or paused.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const people = hive.members ? hive.members() : []
        if (!people.length) return text('nobody is in the room')
        return text(people.map((p) => `${p.name} (${p.kind})${pausedOf(hive, p.name) ? ' — PAUSED' : ''}`).join('\n'))
      },
    },
    {
      name: 'hive_tasks',
      description: 'The task board: who was asked to do what, and where each task stands (pending approval, accepted, done, denied).',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const all = [...hive.doc.getMap('tasks').values()]
        if (!all.length) return text('no tasks')
        return text(all.map((t) => `[${t.status}] ${t.by} -> ${t.to}: ${t.text}`).join('\n'))
      },
    },
    {
      name: 'hive_claims',
      description: 'Which files each agent is holding right now. This is what to read before asking whether it is safe to stop someone.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const c = hive.doc.getMap('claims')
        const rows = [...c.entries()].map(([region, v]) => `${region} — ${(v && v.by) || 'unknown'}`)
        return text(rows.length ? rows.join('\n') : 'nothing is claimed')
      },
    },
    {
      name: 'hive_recent',
      description: 'The last things said in the room, newest last. Use this to answer "what happened overnight".',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'how many messages, default 20' } } },
      run: ({ limit }) => {
        const n = Math.max(1, Math.min(100, Number(limit) || 20))
        const all = hive.doc.getArray('chat').toArray().slice(-n)
        return text(all.length ? all.map((m) => `${m.by}: ${m.text}`).join('\n') : 'the room has said nothing')
      },
    },
    {
      name: 'hive_pause',
      description: 'STOP an agent: it finishes its current step and is then refused any new work until resumed. Pass who="all" to stop every agent in the room. This is the control to reach for when something is going wrong and nobody is at a desk.',
      inputSchema: { type: 'object', properties: { who: { type: 'string', description: 'an agent name, or "all"' } }, required: ['who'] },
      run: async ({ who }, actor) => {
        let by = actor
        let unverifiedNote = ''
        const uid = userIdOf(actor)
        if (actorCheck) {
          const resolved = await actorCheck.resolve(uid)
          const check = actorCheck.mayAct(resolved, 'stop', allow)
          if (!check.ok) return text(check.reply || 'Q521 refused by Slack actor check')
          by = (resolved.ok && resolved.handle && resolved.handle !== uid) ? check.by : (actor || check.by)
          if (check.unverified && check.reply) unverifiedNote = ` (${check.reply})`
        }
        if (String(who).toLowerCase() === 'all') {
          const names = ai().map((p) => p.name)
          for (const n of names) hive.control(n, 'paused', by)
          return text(names.length ? `paused ${names.join(', ')} — nothing new will be picked up${unverifiedNote}` : 'there are no agents to pause')
        }
        const real = resolveName(hive, who)
        if (!real) return text(`Q514 there is nobody called "${who}" in this room. Here now: ${(hive.members ? hive.members() : []).map((p) => p.name).join(', ') || 'nobody'}`)
        hive.control(real, 'paused', by)
        return text(`paused ${real} — it will finish its current step and then stop picking up work${unverifiedNote}`)
      },
    },
    {
      name: 'hive_resume',
      description: 'Let a paused agent pick up work again. Pass who="all" to resume every agent.',
      inputSchema: { type: 'object', properties: { who: { type: 'string', description: 'an agent name, or "all"' } }, required: ['who'] },
      run: async ({ who }, actor) => {
        let by = actor
        if (actorCheck) {
          const uid = userIdOf(actor)
          const resolved = await actorCheck.resolve(uid)
          const check = actorCheck.mayAct(resolved, 'resume', allow)
          if (!check.ok) return text(check.reply || 'Q521 refused: not in --allow')
          by = check.by || actor
        }
        if (String(who).toLowerCase() === 'all') {
          const names = ai().map((p) => p.name)
          for (const n of names) hive.control(n, 'running', by)
          return text(names.length ? `resumed ${names.join(', ')}` : 'there are no agents to resume')
        }
        const real = resolveName(hive, who)
        if (!real) return text(`Q514 there is nobody called "${who}" in this room`)
        hive.control(real, 'running', by)
        return text(`resumed ${real}`)
      },
    },
    {
      name: 'hive_say',
      description: 'Send a message into the room. Address an agent with @Name so it lands as mail rather than ambient chatter — an agent only acts on what names it.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: async ({ text: t }, actor) => {
        let by = formatSlackSender(userIdOf(actor) || actor || 'user')
        if (actorCheck) {
          const uid = userIdOf(actor)
          const resolved = await actorCheck.resolve(uid)
          const check = actorCheck.mayAct(resolved, 'reply', allow)
          if (!check.ok) return text(check.reply || 'Q521 refused: not in --allow')
          by = check.by || by
        }
        if (hive && hive.doc && typeof hive.doc.getArray === 'function') {
          hive.doc.getArray('chat').push([{
            by,
            kind: 'say',
            at: Date.now() * 1000,
            text: String(t || '').trim(),
            viaSlack: true,
          }])
        } else if (hive && typeof hive.say === 'function') {
          hive.say(`${t}`, { by })
        }
        return text(`sent to the room as ${by}`)
      },
    },
  ]
}

/** JSON-RPC dispatch. Returns the response object, or null for a notification (which takes 202). */
export async function dispatch({ msg, tools, actor }) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } })

  if (msg.method === 'initialize') {
    return reply({
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'hivecode', version: VERSION },
    })
  }
  // Notifications carry no id and MUST NOT be answered with a result.
  if (typeof msg.id === 'undefined') return null
  if (msg.method === 'tools/list') {
    return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  }
  if (msg.method === 'tools/call') {
    const t = tools.find((x) => x.name === (msg.params || {}).name)
    if (!t) return fail(-32602, `Q515 unknown tool: ${(msg.params || {}).name}`)
    try {
      return reply(await t.run((msg.params || {}).arguments || {}, actor))
    } catch (e) {
      // A thrown tool is a tool ERROR, not a protocol error: the model should see the text and
      // be able to try something else, rather than the whole session failing.
      return reply({ ...text(`Q516 ${t.name} failed: ${e.message}`), isError: true })
    }
  }
  return fail(-32601, `Q517 method not supported: ${msg.method}`)
}

/** Who is making this call. Slack attaches it under params._meta.slack, and it is only read
 *  after the signature has been verified -- the field is forgeable by anyone who can reach us. */
export function actorOf(msg, verified) {
  const s = ((msg.params || {})._meta || {}).slack || {}
  if (verified && s.user_id) return `slack:${s.user_id}`
  return 'slack'
}

// WHOSE ADDRESS IS IT (27 Sep 2026). The per-IP limit keyed on the FIRST X-Forwarded-For entry,
// which is whatever the caller wrote: a flood that sent a different made-up address on every
// request got a fresh budget every time, and each made-up address was a new entry in a map that
// never shrank. X-Forwarded-For is now read only when this sits behind a proxy the operator
// names (HIVE_TRUST_PROXY=1 or --trust-proxy), and then its LAST entry -- the hop that proxy
// appended, not one the client typed. Otherwise the socket's own address.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.HIVE_TRUST_PROXY || '')
const MAX_LIMITERS = 10000
export function clientAddress(req, trustProxy = TRUST_PROXY) {
  const sock = String((req.socket && req.socket.remoteAddress) || '127.0.0.1')
  if (!trustProxy) return sock
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  return hops.length ? hops[hops.length - 1] : sock
}

export function makeHandler({
  hive,
  room = '',
  auth = 'slack',
  signingSecret = '',
  now = Date.now,
  tier = null,
  trustProxy = TRUST_PROXY,
  allow = [],
  token = '',
  teamId = '',
  lookupUser = null,
  api = undefined,
  fetchImpl = undefined,
  actorCheck = null,
}) {
  const effectiveActorCheck = actorCheck || (auth === 'slack'
    ? makeSlackActorCheck({ token, teamId, api, fetchImpl, lookupUser, now })
    : null)
  const tools = makeTools(hive, room, { actorCheck: effectiveActorCheck, allow })
  const sessions = new Set() // insertion order = LRU order (oldest first, most-recently-used last)
  const limiters = new Map() // insertion order = age, so the oldest address is the first key

  function touchSession(sid) {
    if (!sid) return
    if (sessions.has(sid)) sessions.delete(sid)
    sessions.add(sid)
    if (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.values().next().value)
    }
  }

  function limiterFor(ip) {
    let l = limiters.get(ip)
    if (!l) {
      const conn = {}
      l = attachRateLimit(conn, tier)
      limiters.set(ip, l)
      if (limiters.size > MAX_LIMITERS) limiters.delete(limiters.keys().next().value)
    }
    return l
  }

  handle.limiterCount = () => limiters.size
  handle.sessionCount = () => sessions.size
  handle.hasSession = (sid) => sessions.has(sid)
  return handle
  async function handle(req, res) {
    const send = (code, obj, headers = {}) => {
      const body = obj === null ? '' : JSON.stringify(obj)
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
      res.end(body)
    }
    if (req.method === 'GET') return send(405, { error: 'Q518 this endpoint takes POST' })
    if (req.method !== 'POST') return send(405, { error: 'Q518 this endpoint takes POST' })

    // Rate limiting (HIV-15): per-IP rate limit applied BEFORE signature verification
    const ip = clientAddress(req, trustProxy)
    const limiter = limiterFor(ip)
    const rateRefusal = limiter.check(1)
    if (rateRefusal) {
      return send(429, { error: rateRefusal.reason })
    }

    let raw = ''
    let tooBig = false
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > MAX_BODY) { tooBig = true; break }
    }
    if (tooBig) return send(413, { error: 'Q519 body too large' })

    let verified = auth !== 'slack'
    if (auth === 'slack') {
      const v = verifySlack({
        raw,
        timestamp: req.headers['x-slack-request-timestamp'],
        signature: req.headers['x-slack-signature'],
        secret: signingSecret,
        now: now(),
      })
      // Refuse BEFORE parsing: an unsigned body should never reach the dispatcher at all.
      if (!v.ok) return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: v.why } })
      verified = true
    }

    let msg
    try { msg = JSON.parse(raw || '{}') } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Q520 body is not JSON' } }) }

    const batch = Array.isArray(msg) ? msg : [msg]
    const out = []
    for (const m of batch) {
      const r = await dispatch({ msg: m, tools, actor: actorOf(m, verified) })
      if (r) out.push(r)
    }
    if (!out.length) return send(202, null)      // notifications only

    const payload = Array.isArray(msg) ? out : out[0]
    const sid = req.headers['mcp-session-id'] || crypto.randomUUID()
    touchSession(sid)

    // Streamable HTTP: the client says which framing it can read. Slack accepts either, but a
    // client that asked ONLY for an event stream will not parse a plain JSON body.
    const accept = String(req.headers.accept || '')
    if (/text\/event-stream/.test(accept) && !/application\/json/.test(accept)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Mcp-Session-Id': sid })
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
      return
    }
    return send(200, payload, { 'Mcp-Session-Id': sid })
  }
}

/** Verify SLACK_BOT_TOKEN and resolve workspace team_id via auth.test when --team is not given (Q630, Q634). */
export async function preflightMcpSlack({ token = '', teamId = '', api = undefined, fetchImpl = undefined } = {}) {
  if (!token || !String(token).trim()) {
    return {
      ok: false,
      code: 'Q630',
      error: 'Q630 --auth slack needs SLACK_BOT_TOKEN. Set SLACK_BOT_TOKEN=xoxb-… in your environment (docs/SLACK_SETUP.md).',
    }
  }
  if (teamId && String(teamId).trim()) {
    return { ok: true, teamId: String(teamId).trim() }
  }
  let auth
  try {
    auth = await slackPost('auth.test', {}, token, fetchImpl, api)
  } catch (e) {
    if (!e || !e.slackError) {
      const why = (e && e.message) || 'network error'
      return { ok: false, transient: true, code: 'Q636', error: `Q636 could not reach Slack (${why}). The token was not checked; check this machine's network and try again.` }
    }
    const why = (e && (e.slackError || e.code || e.message)) || 'auth_failed'
    return {
      ok: false,
      code: 'Q630',
      error: `Q630 SLACK_BOT_TOKEN was rejected by Slack (${why}). Check SLACK_BOT_TOKEN or reinstall the Slack app (docs/SLACK_SETUP.md).`,
    }
  }
  if (!auth || !auth.team_id) {
    return {
      ok: false,
      code: 'Q634',
      error: 'Q634 Slack did not say which workspace the bot is in (auth.test returned no team_id), so external workspaces could not be refused. Pass --team <T…> (or SLACK_TEAM_ID) or reinstall the Slack app.',
    }
  }
  const scopes = Array.isArray(auth._scopes) ? auth._scopes : null
  if (Array.isArray(scopes) && !scopes.includes('users:read')) {
    return {
      ok: false,
      code: 'Q634',
      error: 'Q634 SLACK_BOT_TOKEN is missing the users:read scope required to verify Slack callers. Reinstall your Slack app with slack-app-manifest-inbound.json (docs/SLACK_SETUP.md Section 5).',
    }
  }
  return {
    ok: true,
    teamId: String(auth.team_id),
    scopes: scopes || [],
    botUser: auth.user || 'Hivecode',
    botUserId: auth.user_id || '',
  }
}

export async function serve({
  hive,
  room = '',
  port,
  auth = 'slack',
  signingSecret,
  now,
  tier = null,
  trustProxy = TRUST_PROXY,
  allow = [],
  token = '',
  teamId = '',
  lookupUser = null,
  api = undefined,
  fetchImpl = undefined,
  actorCheck = null,
}) {
  let resolvedTeamId = teamId
  if (auth === 'slack' && !actorCheck) {
    const pf = await preflightMcpSlack({ token, teamId, api, fetchImpl })
    if (!pf.ok) throw new Error(pf.error)
    resolvedTeamId = pf.teamId
  }
  const handle = makeHandler({
    hive,
    room,
    auth,
    signingSecret,
    now,
    tier,
    trustProxy,
    allow,
    token,
    teamId: resolvedTeamId,
    lookupUser,
    api,
    fetchImpl,
    actorCheck,
  })
  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => { try { res.writeHead(500); res.end('{}') } catch { /* already sent */ } })
  })
  return new Promise((resolve) => server.listen(port, () => resolve(server)))
}

export function resolveConfig(argv = process.argv.slice(2), env = process.env) {
  const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || '') }
  const link = argv.find((a) => !a.startsWith('--')) || ''
  const port = Number(flag('port', '') || env.PORT || '8790')
  const auth = flag('auth', 'slack')
  const secret = env.SLACK_SIGNING_SECRET || ''
  const allow = flag('allow', env.SLACK_ALLOW || '')
  const token = env.SLACK_BOT_TOKEN || ''
  const teamId = flag('team', env.SLACK_TEAM_ID || '')
  const name = flag('name', 'Hivecode')
  const trustProxy = /^(1|true|yes)$/i.test(env.HIVE_TRUST_PROXY || '') || argv.includes('--trust-proxy')
  const parsed = link ? parseLink(link) : { relay: '', room: '', token: null }
  const hiveToken = parsed.room ? resolveRoomToken({ room: parsed.room, explicit: (!parsed.token && env && env.HIVE_TOKEN) || '', link: link || '' }) : ''
  return { link, relay: parsed.relay, room: parsed.room, port, auth, secret, allow, token, teamId, name, trustProxy, hiveToken }
}

// ---- main -------------------------------------------------------------------------------
export const USAGE = `usage:
  SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=xoxb-… npx -y hivecode-mcp@latest slack mcp-server "<relay|room>" [--port 8790] [--auth slack|none] [--allow <U123,U456>] [--trust-proxy]`

export async function main(argv = process.argv.slice(2), {
  log = console.log,
  logErr = console.error,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (argv.includes('--help') || argv.includes('-h') || argv.includes('help')) {
    log(USAGE)
    return 0
  }
  const cfg = resolveConfig(argv, env)
  if (!cfg.link) {
    logErr(USAGE)
    return 2
  }
  // Fail closed. Starting in `slack` mode without a secret would silently serve an OPEN control
  // plane for a room -- anybody who found the URL could stop every agent in it.
  if (cfg.auth === 'slack' && !cfg.secret) {
    logErr('Q510 --auth slack needs SLACK_SIGNING_SECRET. Use --auth none only on localhost.')
    return 2
  }
  if (cfg.auth === 'slack' && !cfg.token) {
    logErr('Q630 --auth slack needs SLACK_BOT_TOKEN. Set SLACK_BOT_TOKEN=xoxb-… in your environment (docs/SLACK_SETUP.md).')
    return 2
  }
  let resolvedTeamId = cfg.teamId
  if (cfg.auth === 'slack') {
    const pf = await preflightMcpSlack({ token: cfg.token, teamId: cfg.teamId, fetchImpl })
    if (!pf.ok) {
      logErr(pf.error)
      return 1
    }
    resolvedTeamId = pf.teamId
  }
  const safeRoomDir = isSecuredRoom(cfg.room) ? crypto.createHash('sha256').update(cfg.room).digest('hex').slice(0, 12) : cfg.room
  const displayRoom = isSecuredRoom(cfg.room) ? `${cfg.room.slice(0, 8)}…` : cfg.room
  const hive = startSync({
    relay: cfg.relay,
    room: cfg.room,
    dir: (env.TEMP || '.') + '/hive-mcp-http-' + safeRoomDir,
    name: cfg.name,
    kind: 'human',
    token: cfg.hiveToken,
    syncFiles: false,
    log: () => {},
  })
  let server
  try {
    server = await serve({
      hive,
      room: cfg.room,
      port: cfg.port,
      auth: cfg.auth,
      signingSecret: cfg.secret,
      allow: cfg.allow,
      token: cfg.token,
      teamId: resolvedTeamId,
      trustProxy: cfg.trustProxy,
    })
    log(`[hive-mcp-http] room ${displayRoom} on :${cfg.port}/  auth=${cfg.auth}`)
    if (cfg.auth === 'none') log('  auth=none: do NOT expose this beyond localhost.')
  } catch (e) {
    logErr((e && e.message) || String(e))
    try { hive.stop() } catch {}
    return 1
  }

  return new Promise((resolve) => {
    let done = false
    const finish = (code = 0) => {
      if (done) return
      done = true
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      try { server.close() } catch {}
      try { hive.stop() } catch {}
      resolve(code)
    }
    const onSignal = () => finish(0)
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    server.on('close', () => finish(0))
  })
}

// Run directly (node <file>, or through an npx / node_modules/.bin symlink)? Compared by real path:
// the old `file:///${argv[1]}` test built "file:////..." on macOS and Linux, never matched, and the
// process exited 0 having done nothing.
function __hiveIsEntry() {
  if (!process.argv[1]) return false
  const me = __hiveFileURLToPath(import.meta.url)
  try { return __hiveRealpath(process.argv[1]) === __hiveRealpath(me) } catch { return __hiveResolve(process.argv[1]) === __hiveResolve(me) }
}
if (__hiveIsEntry()) {
  main().then((code) => { if (code !== 0) process.exit(code) })
}
