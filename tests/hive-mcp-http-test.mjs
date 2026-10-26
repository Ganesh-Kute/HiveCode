// hive-mcp-http end to end: Slackbot's transport, driving a real room.
//
//   node tests/hive-mcp-http-test.mjs
//
// Three claims are under test and they fail in different ways, so they are checked separately.
//
//   1. THE DOOR HOLDS. Slack's MCP client reaches this over the open internet, so an unsigned or
//      replayed request must be refused before it is ever parsed as a tool call. A control plane
//      for somebody's repo that anyone can POST to is worse than having no remote control at all.
//   2. THE PROTOCOL IS REAL. initialize / tools/list / tools/call over Streamable HTTP, exercised
//      through actual sockets rather than by calling the dispatcher directly -- the transport IS
//      the part Slack refused to accept from hive-mcp.js, so testing around it proves nothing.
//   3. THE TOOLS MOVE THE ROOM. `hive_pause` over HTTP must pause an agent ON THAT AGENT'S OWN
//      CLIENT, which is a different process's replica.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { verifySlack, serve, makeTools, actorOf } from '../hive-mcp-http.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1285, HTTP_PORT = 1286
const ROOM = 'mcp-http-' + process.pid
const SECRET = 'test-signing-secret'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- the door -----------------------------------------------------------------------------
console.log('\n# request signing')
{
  const raw = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  const ts = String(Math.floor(Date.now() / 1000))
  const sign = (body, stamp, secret = SECRET) =>
    'v0=' + crypto.createHmac('sha256', secret).update(`v0:${stamp}:${body}`).digest('hex')

  T('a correctly signed request passes', verifySlack({ raw, timestamp: ts, signature: sign(raw, ts), secret: SECRET }).ok)
  T('an unsigned request is refused', !verifySlack({ raw, timestamp: undefined, signature: undefined, secret: SECRET }).ok)
  T('a tampered body is refused', !verifySlack({ raw: raw + ' ', timestamp: ts, signature: sign(raw, ts), secret: SECRET }).ok)
  T('a different secret is refused', !verifySlack({ raw, timestamp: ts, signature: sign(raw, ts, 'other'), secret: SECRET }).ok)
  // A replay carries a PERFECT signature. The window is the only thing that catches it.
  const old = String(Math.floor(Date.now() / 1000) - 3600)
  const replay = verifySlack({ raw, timestamp: old, signature: sign(raw, old), secret: SECRET })
  T('an hour-old request is refused even though its signature is valid', !replay.ok, replay.why)
  T('and it is refused for the RIGHT reason', /Q512/.test(replay.why || ''), replay.why)
  T('a missing secret fails closed', !verifySlack({ raw, timestamp: ts, signature: sign(raw, ts), secret: '' }).ok)

  T('an unverified request never yields an identity', actorOf({ params: { _meta: { slack: { user_id: 'U9' } } } }, false) === 'slack')
  T('a verified one does', actorOf({ params: { _meta: { slack: { user_id: 'U9' } } } }, true) === 'slack:U9')
}

// ---- protocol + room ----------------------------------------------------------------------
console.log('\n# streamable http -> real room')
let relay = null, httpd = null
const clients = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mcphttp-t-'))
try {
  relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  relay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })

  const mk = (name, kind) => startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: fs.mkdtempSync(path.join(tmp, name)),
    name, kind, syncFiles: false, log: () => {},
  })
  const panel = mk('Hivecode', 'human'); clients.push(panel)
  const A = mk('AgentA', 'ai'); clients.push(A)
  const B = mk('AgentB', 'ai'); clients.push(B)
  await sleep(2500)

  httpd = await serve({
    hive: panel,
    room: ROOM,
    port: HTTP_PORT,
    auth: 'slack',
    signingSecret: SECRET,
    token: 'xoxb-test',
    allow: ['U0GANESH'],
    teamId: 'T1',
    lookupUser: async (uid) => ({ ok: true, user: { id: uid || 'U0GANESH', name: uid || 'U0GANESH', team_id: 'T1', is_restricted: false, is_ultra_restricted: false } }),
  })

  // Every call goes over a real socket, signed the way Slack signs.
  let id = 0
  async function rpc(method, params, { accept = 'application/json', secret = SECRET, stamp } = {}) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
    const ts = stamp || String(Math.floor(Date.now() / 1000))
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', Accept: accept, 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig },
    })
    return { status: r.status, ct: r.headers.get('content-type') || '', text: await r.text() }
  }
  const json = (r) => JSON.parse(r.text)
  const said = (r) => (json(r).result.content[0] || {}).text || ''

  // 1. the handshake
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' })
  T('initialize succeeds over http', init.status === 200 && !!json(init).result.protocolVersion)
  T('it identifies itself as hivecode', json(init).result.serverInfo.name === 'hivecode')

  // 2. the catalogue -- and the one that must be ABSENT
  const list = await rpc('tools/list', {})
  const names = json(list).result.tools.map((t) => t.name)
  T('tools are advertised', names.length >= 8, names.join(','))
  T('hive_wait is NOT exposed (it would blow Slack\'s 60s limit every call)', !names.includes('hive_wait'))
  T('the control tools are there', names.includes('hive_pause') && names.includes('hive_resume'))
  T('every tool carries a description for the model to route on',
    json(list).result.tools.every((t) => t.description && t.description.length > 30))

  // 3. an unsigned call must not reach the dispatcher
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'hive_pause', arguments: { who: 'all' } } })
  const naked = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json' } })
  T('an unsigned tool call is refused with 401', naked.status === 401)
  T('and it did NOT pause anybody', A.isPaused() === false && B.isPaused() === false)

  const stale = await rpc('tools/call', { name: 'hive_status', arguments: {} }, { stamp: String(Math.floor(Date.now() / 1000) - 3600) })
  T('a replayed call is refused with 401', stale.status === 401)

  // 4. reads reflect the real room
  const status = await rpc('tools/call', { name: 'hive_status', arguments: {} })
  T('status reports the real roster', /2 agents/.test(said(status)), said(status).split('\n')[1])
  T('status says nothing is paused yet', /nothing is paused/.test(said(status)))
  // Caught by reading the output rather than by an assertion: the sync handle has no `room`
  // field, so this line used to say "room: undefined" to whoever asked Slackbot what was going on.
  T('status names the real room, not undefined', said(status).includes(ROOM) && !/undefined/.test(said(status)),
    said(status).split('\n')[0])

  // 5. THE ONE THAT MATTERS: stop, over HTTP, lands on the agents' own clients
  const stop = await rpc('tools/call', {
    name: 'hive_pause', arguments: { who: 'all' },
    _meta: { slack: { user_id: 'U0GANESH', team_id: 'T1' } },
  })
  await sleep(1500)
  T('hive_pause reports what it stopped', /AgentA/.test(said(stop)) && /AgentB/.test(said(stop)), said(stop))
  T('AgentA is paused ON ITS OWN CLIENT', A.isPaused() === true)
  T('AgentB is paused ON ITS OWN CLIENT', B.isPaused() === true)
  // The Slack user id is the audit trail: the room records WHO reached in, not just "slack".
  T('the room recorded the Slack user as the actor',
    (panel.doc.getMap('controls').get('AgentA') || {}).by === 'slack:U0GANESH',
    JSON.stringify(panel.doc.getMap('controls').get('AgentA')))

  const resume = await rpc('tools/call', { name: 'hive_resume', arguments: { who: 'agenta' }, _meta: { slack: { user_id: 'U0GANESH', team_id: 'T1' } } })
  await sleep(1500)
  T('a lowercase name still resolves', /resumed AgentA/.test(said(resume)), said(resume))
  T('only that agent resumed', A.isPaused() === false && B.isPaused() === true)

  const ghost = await rpc('tools/call', { name: 'hive_pause', arguments: { who: 'Nobody' } })
  T('pausing someone absent is refused, not faked', /Q514/.test(said(ghost)), said(ghost))
  T('and no phantom control was written', !panel.doc.getMap('controls').get('Nobody'))

  // 6. protocol edges
  const bogus = await rpc('tools/call', { name: 'hive_delete_everything', arguments: {} })
  T('an unknown tool is a protocol error, not a crash', json(bogus).error && /Q515/.test(json(bogus).error.message))

  const notifBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const nts = String(Math.floor(Date.now() / 1000))
  const nsig = 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${nts}:${notifBody}`).digest('hex')
  const notif = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
    method: 'POST', body: notifBody,
    headers: { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': nts, 'X-Slack-Signature': nsig },
  })
  T('a notification gets 202 and no body', notif.status === 202 && (await notif.text()) === '')

  // A client that can only read an event stream must not be handed a bare JSON body.
  const sse = await rpc('tools/list', {}, { accept: 'text/event-stream' })
  T('an SSE-only client gets SSE framing', /text\/event-stream/.test(sse.ct) && /^event: message\ndata: \{/.test(sse.text),
    sse.ct)

  // 7. rate limiting (HIV-15)
  console.log('\n# per-IP rate limiting (HIV-15)')
  const ratePort = HTTP_PORT + 10
  const rateHttpd = await serve({
    hive: panel, room: ROOM, port: ratePort, auth: 'slack', signingSecret: SECRET, token: 'xoxb-test', teamId: 'T1', trustProxy: true,
    tier: { msgsPerSec: 1, msgBurst: 2, cooloffMs: 2000, bytesPerSec: 1024 * 1024, byteBurst: 2 * 1024 * 1024 }
  })

  async function postMcp(body, headers = {}) {
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')
    const r = await fetch(`http://127.0.0.1:${ratePort}/mcp`, {
      method: 'POST', body,
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': ts,
        'X-Slack-Signature': sig,
        ...headers,
      },
    })
    return { status: r.status, text: await r.text() }
  }

  const normalBody = JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list' })
  const r1 = await postMcp(normalBody, { 'X-Forwarded-For': '192.168.1.50' })
  T('request 1 from IP is allowed', r1.status === 200)

  const r2 = await postMcp(normalBody, { 'X-Forwarded-For': '192.168.1.50' })
  T('request 2 within burst is allowed', r2.status === 200)

  const r3 = await postMcp(normalBody, { 'X-Forwarded-For': '192.168.1.50' })
  T('request 3 exceeding burst is refused with 429', r3.status === 429)
  T('refusal contains Q-code (Q432)', /Q432/.test(r3.text), r3.text)

  // Critical assertion: limit applies BEFORE signature verification
  // Send an unsigned / bad-signature request from the throttled IP
  const unsignedReq = await fetch(`http://127.0.0.1:${ratePort}/mcp`, {
    method: 'POST',
    body: normalBody,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.168.1.50' },
  })
  T('throttled IP is refused with 429 BEFORE signature check (not 401)', unsignedReq.status === 429)

  // Request from a different IP is admitted normally
  const otherIp = await postMcp(normalBody, { 'X-Forwarded-For': '192.168.1.99' })
  T('request from different IP is admitted while first IP is throttled', otherIp.status === 200)

  // A made-up address prepended by the CLIENT is not an escape: behind a trusted proxy the key is
  // the hop the proxy appended (the last one), and it is still the throttled address.
  const spoofPrepended = await postMcp(normalBody, { 'X-Forwarded-For': '10.9.9.9, 192.168.1.50' })
  T('a client-written first hop does not escape the limit', spoofPrepended.status === 429)

  // Not behind a proxy: the header is not read at all, so rotating it buys nothing.
  const { clientAddress, makeHandler, resolveConfig } = await import('../hive-mcp-http.js')
  const fakeReq = (xff) => ({ socket: { remoteAddress: '203.0.113.7' }, headers: { 'x-forwarded-for': xff } })
  T('without a trusted proxy, X-Forwarded-For is ignored', clientAddress(fakeReq('1.1.1.1'), false) === '203.0.113.7')
  T('behind one, the last hop is used', clientAddress(fakeReq('6.6.6.6, 198.51.100.4'), true) === '198.51.100.4')
  const h = makeHandler({ hive: panel, room: ROOM, auth: 'none', trustProxy: true, tier: { msgsPerSec: 10000, msgBurst: 10000, cooloffMs: 1, bytesPerSec: 1e9, byteBurst: 1e9 } })
  const sink = { writeHead() { }, end() { } }
  // POST: a GET is refused before the limiter ever runs, so it would prove nothing.
  const post = (xff) => ({ method: 'POST', headers: { 'x-forwarded-for': xff }, socket: {}, async *[Symbol.asyncIterator]() { } })
  for (let i = 0; i < 10050; i++) { try { await h(post(`10.0.${i >> 8}.${i & 255}`), sink) } catch { } }
  T('...and actually filled, so the bound is what held it', h.limiterCount() >= 9999, `${h.limiterCount()}`)
  T('the per-address table is bounded', h.limiterCount() <= 10000, `${h.limiterCount()} entries after 10,050 addresses`)

  // 8. sessions LRU cap (1,000)
  console.log('\n# sessions LRU cap (1,000)')
  const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const postSession = (sid) => ({
    method: 'POST',
    headers: { 'mcp-session-id': sid },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield rpcBody },
  })
  for (let i = 0; i < 1050; i++) {
    if (i === 500) await h(postSession('sid-0'), sink) // touch sid-0 so it is recently used
    await h(postSession(`sid-${i}`), sink)
  }
  const sessCount = typeof h.sessionCount === 'function' ? h.sessionCount() : Infinity
  const keptTouched = typeof h.hasSession === 'function' && h.hasSession('sid-0') === true && h.hasSession('sid-1') === false
  T('sessions table is bounded at 1,000 entries', sessCount <= 1000, `count=${sessCount}`)
  T('sessions eviction is LRU (touched sid-0 survives while untouched sid-1 is evicted)', keptTouched)

  // 9. makeSlackActorCheck on hive_pause / hive_resume / hive_say (--allow, guest/external refusal, fail-open stop)
  console.log('\n# makeSlackActorCheck on hive_pause, hive_resume, hive_say')
  await rpc('tools/call', { name: 'hive_resume', arguments: { who: 'all' }, _meta: { slack: { user_id: 'U0GANESH' } } })
  await sleep(600)
  const USERS = {
    U_OWNER: { id: 'U_OWNER', name: 'Ganesh', team_id: 'T_OUR_TEAM', is_restricted: false, is_ultra_restricted: false },
    U_COWORKER: { id: 'U_COWORKER', name: 'alice', team_id: 'T_OUR_TEAM', is_restricted: false, is_ultra_restricted: false },
    U_GUEST: { id: 'U_GUEST', name: 'guest_bob', team_id: 'T_OUR_TEAM', is_restricted: true, is_ultra_restricted: false },
    U_EXTERNAL: { id: 'U_EXTERNAL', name: 'ext_carol', team_id: 'T_OTHER', is_restricted: false, is_ultra_restricted: false },
  }
  let failLookup = false
  const aclPort = HTTP_PORT + 20
  const aclHttpd = await serve({
    hive: panel,
    room: ROOM,
    port: aclPort,
    auth: 'slack',
    signingSecret: SECRET,
    token: 'xoxb-test',
    allow: ['U_OWNER'],
    teamId: 'T_OUR_TEAM',
    lookupUser: async (uid) => {
      if (failLookup) throw new Error('slack users.info: internal_error')
      return { ok: true, user: USERS[uid] }
    },
  })
  async function aclRpc(name, args, userId) {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name, arguments: args, _meta: { slack: { user_id: userId, team_id: (USERS[userId] && USERS[userId].team_id) || 'T_OUR_TEAM' } } },
    })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')
    const r = await fetch(`http://127.0.0.1:${aclPort}/mcp`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig },
    })
    return { status: r.status, text: await r.text() }
  }
  try {
    // Guest and external workspace user cannot even pause
    const gStop = await aclRpc('hive_pause', { who: 'AgentA' }, 'U_GUEST')
    const eStop = await aclRpc('hive_pause', { who: 'AgentA' }, 'U_EXTERNAL')
    await sleep(500)
    T('guests and external workspace users are refused on hive_pause',
      /Refused/i.test(said(gStop)) && /Refused/i.test(said(eStop)) && A.isPaused() === false,
      `guest="${said(gStop)}" ext="${said(eStop)}" paused=${A.isPaused()}`)

    // Any full workspace member (not in --allow) CAN pause
    const cStop = await aclRpc('hive_pause', { who: 'AgentA' }, 'U_COWORKER')
    await sleep(800)
    T('full workspace member not in --allow CAN call hive_pause', A.isPaused() === true && /paused AgentA/.test(said(cStop)), said(cStop))

    // Member not in --allow CANNOT call hive_resume or hive_say
    const cResume = await aclRpc('hive_resume', { who: 'AgentA' }, 'U_COWORKER')
    const chatBefore = panel.doc.getArray('chat').length
    const cSay = await aclRpc('hive_say', { text: '@AgentA do unauthorized work' }, 'U_COWORKER')
    await sleep(600)
    T('member not in --allow is refused on hive_resume (AgentA stays paused)',
      /Refused/i.test(said(cResume)) && /--allow/.test(said(cResume)) && A.isPaused() === true, said(cResume))
    T('member not in --allow is refused on hive_say (nothing posted to room)',
      /Refused/i.test(said(cSay)) && panel.doc.getArray('chat').length === chatBefore, said(cSay))

    // User in --allow CAN call hive_resume and hive_say (attributed as slack:Ganesh, never bare Ganesh)
    const oResume = await aclRpc('hive_resume', { who: 'AgentA' }, 'U_OWNER')
    const oSay = await aclRpc('hive_say', { text: '@AgentA hello from owner' }, 'U_OWNER')
    await sleep(800)
    const lastChat = panel.doc.getArray('chat').toArray().slice(-1)[0] || {}
    T('user in --allow CAN call hive_resume and hive_say (attributed as slack:Ganesh)',
      A.isPaused() === false && /resumed AgentA/.test(said(oResume)) && lastChat.by === 'slack:Ganesh',
      `paused=${A.isPaused()} by=${lastChat.by}`)

    // Fail-open stop when users.info fails
    failLookup = true
    const outStop = await aclRpc('hive_pause', { who: 'AgentA' }, 'U_EMERGENCY')
    await sleep(800)
    T('hive_pause fails open when users.info throws, noting unverified stop',
      A.isPaused() === true && /stopped; I could not confirm who you are/.test(said(outStop)), said(outStop))
  } finally {
    try { aclHttpd.close() } catch {}
  }

  // 10. PORT from environment and token from wss://relay|room|token link
  console.log('\n# PORT from env + token from wss://relay|room|token link')
  const cfg = typeof resolveConfig === 'function'
    ? resolveConfig(['wss://hivecode-relay.onrender.com|room-xyz123|tok-secret-99', '--auth', 'none'], { PORT: '9912', HIVE_TOKEN: '' })
    : {}
  T('PORT is read from environment when --port is not given', cfg.port === 9912, `port=${cfg.port}`)
  T('token is extracted from a wss://relay|room|token link', cfg.hiveToken === 'tok-secret-99', `token=${cfg.hiveToken}`)

  // 11. Slack startup preflight: SLACK_BOT_TOKEN required + team_id resolved from auth.test when no --team given
  console.log('\n# Slack startup: require SLACK_BOT_TOKEN and resolve team_id from auth.test')
  await rpc('tools/call', { name: 'hive_resume', arguments: { who: 'all' }, _meta: { slack: { user_id: 'U0GANESH' } } })
  await sleep(600)

  // (a) serve() in slack mode without SLACK_BOT_TOKEN is refused with Q-code and fix
  let noTokErr = ''
  let noTokSrv = null
  try {
    noTokSrv = await serve({
      hive: panel,
      room: ROOM,
      port: HTTP_PORT + 30,
      auth: 'slack',
      signingSecret: SECRET,
      token: '',
    })
  } catch (e) {
    noTokErr = e.message || String(e)
  } finally {
    try { noTokSrv && noTokSrv.close() } catch {}
  }
  T('start without SLACK_BOT_TOKEN is refused with Q-code and fix',
    /Q630/.test(noTokErr) && /SLACK_BOT_TOKEN/.test(noTokErr),
    noTokErr || 'started without error')

  // (b) CLI process start in slack mode without SLACK_BOT_TOKEN is refused with Q-code and fix
  const cliNoTok = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['hive-mcp-http.js', `ws://127.0.0.1:${PORT}|${ROOM}`, '--port', String(HTTP_PORT + 31), '--auth', 'slack'], {
      cwd: ROOT,
      env: { ...process.env, SLACK_SIGNING_SECRET: SECRET, SLACK_BOT_TOKEN: '' },
    })
    let out = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} resolve({ code: 0, out: out || 'timed out (server started instead of refusing)' }) }, 2500)
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { out += String(d) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }) })
  })
  T('CLI start without SLACK_BOT_TOKEN exits non-zero with Q-code and fix',
    cliNoTok.code !== 0 && /Q630/.test(cliNoTok.out) && /SLACK_BOT_TOKEN/.test(cliNoTok.out),
    `code=${cliNoTok.code} out=${cliNoTok.out}`)

  // (c) serve() in slack mode when auth.test fails or returns no team_id is refused with Q-code
  let noTeamErr = ''
  let noTeamSrv = null
  try {
    noTeamSrv = await serve({
      hive: panel,
      room: ROOM,
      port: HTTP_PORT + 32,
      auth: 'slack',
      signingSecret: SECRET,
      token: 'xoxb-valid',
      fetchImpl: async () => ({
        status: 200,
        headers: new Map(),
        json: async () => ({ ok: true, user: 'Hivecode', user_id: 'B1', team_id: '' }),
      }),
    })
  } catch (e) {
    noTeamErr = e.message || String(e)
  } finally {
    try { noTeamSrv && noTeamSrv.close() } catch {}
  }
  T('start when auth.test returns no team_id is refused with Q634 and fix',
    /Q634/.test(noTeamErr) && /--team|reinstall/i.test(noTeamErr),
    noTeamErr || 'started without error')

  // (d) With NO --team given, serve() fetches team_id from auth.test and refuses external workspace stop
  const autoTeamPort = HTTP_PORT + 33
  const autoTeamSrv = await serve({
    hive: panel,
    room: ROOM,
    port: autoTeamPort,
    auth: 'slack',
    signingSecret: SECRET,
    token: 'xoxb-valid',
    // NO teamId passed! Must come from auth.test below:
    fetchImpl: async (url, opts) => {
      const body = JSON.parse((opts && opts.body) || '{}')
      if (String(url).endsWith('/auth.test')) {
        return {
          status: 200,
          headers: new Map(),
          json: async () => ({ ok: true, user: 'Hivecode', user_id: 'B1', team: 'HomeTeam', team_id: 'T_HOME_AUTO' }),
        }
      }
      if (String(url).endsWith('/users.info')) {
        const map = {
          U_EXT_AUTO: { id: 'U_EXT_AUTO', name: 'ext_carol', team_id: 'T_FOREIGN_WS', is_restricted: false, is_ultra_restricted: false },
          U_HOME_AUTO: { id: 'U_HOME_AUTO', name: 'home_alice', team_id: 'T_HOME_AUTO', is_restricted: false, is_ultra_restricted: false },
        }
        return {
          status: 200,
          headers: new Map(),
          json: async () => ({ ok: true, user: map[body.user] }),
        }
      }
      throw new Error('unexpected url: ' + url)
    },
  })
  try {
    async function autoRpc(name, args, userId) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name, arguments: args, _meta: { slack: { user_id: userId } } },
      })
      const ts = String(Math.floor(Date.now() / 1000))
      const sig = 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')
      const r = await fetch(`http://127.0.0.1:${autoTeamPort}/mcp`, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig },
      })
      return { status: r.status, text: await r.text() }
    }
    const extStop = await autoRpc('hive_pause', { who: 'AgentA' }, 'U_EXT_AUTO')
    await sleep(600)
    T('an external user\'s stop is refused with no --team given (team_id resolved from auth.test)',
      /Refused/i.test(said(extStop)) && A.isPaused() === false,
      `reply="${said(extStop)}" paused=${A.isPaused()}`)

    const homeStop = await autoRpc('hive_pause', { who: 'AgentA' }, 'U_HOME_AUTO')
    await sleep(600)
    T('a home-workspace member\'s stop succeeds with team_id resolved from auth.test',
      /paused AgentA/.test(said(homeStop)) && A.isPaused() === true,
      `reply="${said(homeStop)}" paused=${A.isPaused()}`)
  } finally {
    try { autoTeamSrv.close() } catch {}
  }

  try { rateHttpd.close() } catch {}
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  try { httpd && httpd.close() } catch { /* already closed */ }
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  try { relay && relay.kill() } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
