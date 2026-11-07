// hive-slack end to end, against a FAKE Slack.
//
//   node tests/hive-slack-test.mjs
//
// There is no Slack workspace here and there should not be: the thing worth testing is OUR
// routing -- threading, pacing, the echo guard, what reaches the channel -- not Slack's HTTP.
// So a local server stands in for the Web API and records every call, and the room, relay and
// CRDT underneath are all real.

import fs from 'fs'
import os from 'os'
import http from 'http'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import * as HS from '../hive-slack.js'

const {
  makeBridge,
  makeQueue,
  render,
  TO_CHANNEL,
  scrubSlack,
  makeSlackThreader,
  makeSlackActorCheck,
  preflightSlack,
  preflightSocketMode,
  connectSocketMode,
  checkDuplicateBridge,
  formatSlackSender,
} = HS

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1281, SLACK_PORT = 1282, SOCK_PORT = 1285
const ROOM = 'slack-test-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- the fake Slack ------------------------------------------------------------------------
const calls = []
let tsSeq = 1000
let nextResponses = [] // optional queued responses: { status, headers, body }
const USERS = {
  U_OWNER: { id: 'U_OWNER', name: 'Ganesh', team_id: 'T_OUR_TEAM', is_restricted: false, is_ultra_restricted: false },
  U_COWORKER: { id: 'U_COWORKER', name: 'alice', team_id: 'T_OUR_TEAM', is_restricted: false, is_ultra_restricted: false },
  U_GUEST: { id: 'U_GUEST', name: 'guest_bob', team_id: 'T_OUR_TEAM', is_restricted: true, is_ultra_restricted: false },
  U_EXTERNAL: { id: 'U_EXTERNAL', name: 'ext_carol', team_id: 'T_OTHER_WORKSPACE', is_restricted: false, is_ultra_restricted: false },
}
const DEFAULT_SCOPES = 'chat:write,channels:read,groups:read,channels:history,groups:history,users:read'
const slack = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const method = req.url.split('/').pop().split('?')[0]
    let j = {}
    try { j = JSON.parse(body || '{}') } catch { j = {} }
    calls.push({ method, auth: req.headers.authorization, at: Date.now(), ...j })
    const defaultHeaders = { 'Content-Type': 'application/json', 'x-oauth-scopes': DEFAULT_SCOPES }
    if (nextResponses.length) {
      const custom = nextResponses.shift()
      res.writeHead(custom.status || 200, { ...defaultHeaders, ...(custom.headers || {}) })
      res.end(JSON.stringify(custom.body))
      return
    }
    if (method === 'auth.test') {
      res.writeHead(200, defaultHeaders)
      res.end(JSON.stringify({ ok: true, user: 'hivecode', user_id: 'U_BOT', team: 'TestTeam', team_id: 'T_OUR_TEAM' }))
      return
    }
    if (method === 'conversations.info') {
      res.writeHead(200, defaultHeaders)
      res.end(JSON.stringify({ ok: true, channel: { id: j.channel || 'C-TEST', name: 'dev-agents', is_member: true, is_private: false } }))
      return
    }
    if (method === 'users.info') {
      const u = USERS[j.user] || { id: j.user, name: j.user, team_id: 'T_OUR_TEAM', is_restricted: false, is_ultra_restricted: false }
      res.writeHead(200, defaultHeaders)
      res.end(JSON.stringify({ ok: true, user: u }))
      return
    }
    if (method === 'apps.connections.open') {
      res.writeHead(200, defaultHeaders)
      res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${SOCK_PORT}` }))
      return
    }
    res.writeHead(200, defaultHeaders)
    res.end(JSON.stringify({ ok: true, ts: String(tsSeq++) }))
  })
})
await new Promise((r) => slack.listen(SLACK_PORT, '127.0.0.1', r))
process.env.HIVE_SLACK_API = `http://127.0.0.1:${SLACK_PORT}/api`
const { slackPost } = await import('../hive-slack.js?fresh=1')

// ---- pure: pacing, rendering, routing ------------------------------------------------------
console.log('\n# routing + pacing')
{
  T('only open/done reach the channel', TO_CHANNEL.has('task-open') && !TO_CHANNEL.has('gate-fail'))
  T('a gate failure says where the file stayed', /stays with them/.test(render({ kind: 'gate-fail', by: 'A', file: 'x.js' })))
  T('chat renders as person then text', render({ kind: 'chat', by: 'Rai', text: 'hi' }) === '*Rai*: hi')

  // Slack drops or reorders past ~1 msg/sec per channel, so the queue must SPACE them.
  const stamps = []
  let clock = 0
  const q = makeQueue({
    send: async () => { stamps.push(clock); return { ok: true } },
    minGapMs: 1000,
    now: () => clock,
    timer: (fn, ms) => { clock += ms; fn() },      // virtual time: the test must not take 3s
  })
  await Promise.all([q.push({}), q.push({}), q.push({})])
  T('three bursts are paced ~1s apart', stamps.length === 3 && stamps[1] - stamps[0] >= 1000 && stamps[2] - stamps[1] >= 1000,
    stamps.join(','))
}

// ---- secrets & room link scrubbing ---------------------------------------------------------
console.log('\n# secrets + room link scrubbing')
{
  const fakeKey = ['ghp', 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5'].join('_')
  const roomLink = 'wss://hivecode-relay.onrender.com|room-6UlP1vRk4V9P-w6fEQ'
  const out = typeof scrubSlack === 'function'
    ? scrubSlack(`key=${fakeKey} link=${roomLink} id=room-6UlP1vRk4V9P-w6fEQ`, { room: 'room-6UlP1vRk4V9P-w6fEQ', link: roomLink })
    : ''
  T('scrubSlack strips API keys before Slack', out !== '' && !out.includes(fakeKey) && /removed\]/.test(out))
  T('scrubSlack strips room link and room id before Slack', out !== '' && !out.includes('room-6UlP1vRk4V9P-w6fEQ') && !out.includes('wss://hivecode-relay'))
  const bareOut = typeof scrubSlack === 'function'
    ? scrubSlack('link=wss://hivecode-relay.onrender.com|room-6UlP1vRk4V9P-w6fEQ bare=room-gh-issue-42-run-1')
    : ''
  T('scrubSlack with no options strips generic wss://...|room-... links and bare room-... ids',
    bareOut !== '' && !bareOut.includes('wss://hivecode-relay') && !bareOut.includes('room-6UlP1vRk4V9P-w6fEQ') && !bareOut.includes('room-gh-issue-42-run-1') && /\[room link removed\]/.test(bareOut) && /\[room id removed\]/.test(bareOut),
    bareOut)
}

// ---- makeSlackThreader (reusable GitHub / room thread API) ---------------------------------
console.log('\n# makeSlackThreader: open, reply, broadcast, 429 retry, permanent halt')
{
  if (typeof makeSlackThreader !== 'function') {
    T('makeSlackThreader is exported', false, 'missing export')
  } else {
    const sent = []
    const store = new Map()
    let clock = 0
    const threader = makeSlackThreader({
      token: 'xoxb-t',
      channel: 'C-GH',
      threads: store,
      minGapMs: 0,
      now: () => clock,
      timer: (fn, ms) => { clock += ms; fn() },
      post: async (m) => { sent.push(m); return { ok: true, ts: String(2000 + sent.length) } },
    })
    const secretInIssue = ['ghp', 'zY9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE9dC8'].join('_')
    const opened = await threader.open('gh-12', 'Issue #12 opened with ' + secretInIssue)
    T('threader.open posts top-level and stores ts in Map adapter', opened.ok && store.get('gh-12') === opened.ts && !sent[0].thread_ts)
    T('threader.open scrubs secrets before posting', !sent[0].text.includes(secretInIssue) && /removed\]/.test(sent[0].text))
    const rep = await threader.reply('gh-12', 'CI green')
    T('threader.reply posts inside the stored thread_ts', rep.ok && sent[1].thread_ts === opened.ts && !sent[1].reply_broadcast)
    await threader.reply('gh-12', 'PR ready', { broadcast: true })
    T('threader.reply with broadcast sets reply_broadcast: true', sent[2].thread_ts === opened.ts && sent[2].reply_broadcast === true)

    // 429 retry: retries up to 5 times honouring Retry-After, then succeeds
    let attempts = 0
    let retryClock = 0
    const retryThreader = makeSlackThreader({
      token: 'xoxb-t',
      channel: 'C-GH',
      threads: new Map(),
      minGapMs: 0,
      now: () => retryClock,
      timer: (fn, ms) => { retryClock += ms; fn() },
      post: async () => {
        attempts++
        if (attempts <= 3) {
          const e = new Error('slack chat.postMessage: ratelimited')
          e.code = 'ratelimited'
          e.status = 429
          e.retryAfterMs = 2000
          throw e
        }
        return { ok: true, ts: '3001' }
      },
    })
    const r429 = await retryThreader.open('gh-429', 'hello after rate limit')
    T('429 ratelimited is retried and honours Retry-After', r429.ok && attempts === 4 && retryClock >= 6000, `attempts=${attempts}, waited=${retryClock}ms`)

    // Permanent error: invalid_auth / not_in_channel is NEVER retried, reported once, and halts posting
    let authAttempts = 0
    const errors = []
    const badThreader = makeSlackThreader({
      token: 'xoxb-revoked',
      channel: 'C-GH',
      threads: new Map(),
      minGapMs: 0,
      onError: (err) => errors.push(err),
      post: async () => {
        authAttempts++
        const e = new Error('slack chat.postMessage: token_revoked')
        e.slackError = 'token_revoked'
        throw e
      },
    })
    const rBad1 = await badThreader.open('gh-bad', 'first try')
    const rBad2 = await badThreader.reply('gh-bad', 'second try after halt')
    T('token_revoked is never retried and halts further posting', !rBad1.ok && !rBad2.ok && authAttempts === 1 && errors.length === 1, `attempts=${authAttempts}, errors=${errors.length}`)

    // slackPost timeout: default 15s AbortSignal + real hanging TCP server test
    let capturedSignal = null
    await slackPost(
      'chat.postMessage',
      { channel: 'C-TEST', text: 'probe' },
      'xoxb-test',
      async (_url, opts) => {
        capturedSignal = opts && opts.signal
        return { status: 200, headers: new Map(), json: async () => ({ ok: true, ts: '1' }) }
      },
    )
    T('slackPost attaches an AbortSignal timeout (15s default)',
      HS.SLACK_TIMEOUT_MS === 15000 && Boolean(capturedSignal && typeof capturedSignal.aborted === 'boolean'))

    const hangSockets = new Set()
    const hangSrv = http.createServer((_req, _res) => {
      // Accept connection and never answer
    })
    hangSrv.on('connection', (s) => { hangSockets.add(s); s.on('close', () => hangSockets.delete(s)) })
    await new Promise((r) => hangSrv.listen(0, '127.0.0.1', r))
    const hangPort = hangSrv.address().port
    const t0 = Date.now()
    let hangErr = null
    try {
      await slackPost('chat.postMessage', { channel: 'C-TEST', text: 'hang' }, 'xoxb-test', fetch, `http://127.0.0.1:${hangPort}/api`, 250)
    } catch (e) {
      hangErr = e
    } finally {
      for (const s of hangSockets) s.destroy()
      await new Promise((r) => hangSrv.close(r))
    }
    const elapsed = Date.now() - t0
    T('slackPost aborts when Slack accepts the TCP connection and never answers',
      Boolean(hangErr) && elapsed < 3000, `${hangErr ? hangErr.name : 'no error'} in ${elapsed}ms`)
  }
}

// ---- makeSlackActorCheck (shared access rules for Slack + GitHub) --------------------------
console.log('\n# makeSlackActorCheck (shared access rules)')
{
  let fakeNow = 1000
  const ac = makeSlackActorCheck({
    token: 'xoxb-test',
    teamId: 'T_OUR_TEAM',
    api: process.env.HIVE_SLACK_API,
    now: () => fakeNow,
  })
  const coworker = await ac.resolve('U_COWORKER')
  const owner = await ac.resolve('U_OWNER')
  const guest = await ac.resolve('U_GUEST')
  const external = await ac.resolve('U_EXTERNAL')
  T('makeSlackActorCheck allows any full member to stop, but requires allow for retry/resume',
    ac.mayAct(coworker, 'stop', ['U_OWNER']).ok === true &&
    ac.mayAct(coworker, 'retry', ['U_OWNER']).ok === false &&
    ac.mayAct(owner, 'retry', ['U_OWNER']).ok === true)
  T('makeSlackActorCheck refuses guests and external Slack Connect users even for stop',
    ac.mayAct(guest, 'stop', ['U_GUEST']).ok === false &&
    ac.mayAct(external, 'stop', ['U_EXTERNAL']).ok === false)
  nextResponses.push({ status: 500, body: { ok: false, error: 'internal_error' } })
  const failedLookup = await ac.resolve('U_OUTAGE')
  const stopOnOutage = ac.mayAct(failedLookup, 'stop', ['U_OWNER'])
  const retryOnOutage = ac.mayAct(failedLookup, 'retry', ['U_OUTAGE'])
  T('makeSlackActorCheck fails open on stop during users.info outage with unverified: true, refuses retry',
    stopOnOutage.ok === true && stopOnOutage.unverified === true && /stopped; I could not confirm who you are/.test(stopOnOutage.reply) && retryOnOutage.ok === false)

  const ghAc = makeSlackActorCheck({
    token: 'xoxb-test',
    teamId: 'T_OUR_TEAM',
    api: process.env.HIVE_SLACK_API,
    allowFlag: '--slack-allow',
  })
  const ghRefusal = ghAc.mayAct(coworker, 'retry', ['U_OWNER'])
  T('makeSlackActorCheck names custom allowFlag (--slack-allow) in refusal message',
    !ghRefusal.ok && /--slack-allow/.test(ghRefusal.reply) && !/--allow\b/.test(ghRefusal.reply))
}

// ---- preflight Q630-Q632 -------------------------------------------------------------------
console.log('\n# preflight checks (Q630 auth, Q631 channel/not_in_channel, Q632 duplicate bridge)')
{
  if (typeof preflightSlack !== 'function' || typeof checkDuplicateBridge !== 'function') {
    T('preflightSlack and checkDuplicateBridge are exported', false, 'missing exports')
  } else {
    nextResponses.push({ status: 200, body: { ok: false, error: 'invalid_auth' } })
    const pAuth = await preflightSlack({ token: 'xoxb-bad', channel: 'C-TEST', api: process.env.HIVE_SLACK_API })
    T('Q630: invalid_auth is caught before READY', !pAuth.ok && /Q630/.test(pAuth.error) && /invalid_auth/.test(pAuth.error))

    const pDead = await preflightSlack({ token: 'xoxb-ok', channel: 'C-TEST', fetchImpl: () => Promise.reject(new TypeError('fetch failed')) })
    T('preflightSlack returns Q636 and transient: true when Slack is unreachable',
      pDead.ok === false && pDead.transient === true && pDead.code === 'Q636' && /Q636 could not reach Slack/.test(pDead.error))

    const smDead = await preflightSocketMode({ appToken: 'xapp-ok', fetchImpl: () => Promise.reject(new TypeError('fetch failed')) })
    T('preflightSocketMode returns Q636 and transient: true when Slack is unreachable',
      smDead.ok === false && smDead.transient === true && smDead.code === 'Q636' && /Q636 could not reach Slack/.test(smDead.error))

    nextResponses.push(
      { status: 200, body: { ok: true, user: 'hivecode', user_id: 'U1' } },
      { status: 200, body: { ok: true, channel: { id: 'C-TEST', name: 'general', is_member: false } } },
    )
    const pNotIn = await preflightSlack({ token: 'xoxb-ok', channel: 'C-TEST', api: process.env.HIVE_SLACK_API })
    T('Q631: bot not in channel is caught with /invite instruction', !pNotIn.ok && /Q631/.test(pNotIn.error) && /\/invite/.test(pNotIn.error))

    nextResponses.push(
      { status: 200, headers: { 'x-oauth-scopes': 'chat:write,channels:read,groups:read,users:read' }, body: { ok: true, user: 'hivecode', user_id: 'U1' } },
      { status: 200, body: { ok: true, channel: { id: 'C-TEST', name: 'general', is_member: true, is_private: false } } },
    )
    const pOk = await preflightSlack({ token: 'xoxb-ok', channel: 'C-TEST', api: process.env.HIVE_SLACK_API })
    T('preflight succeeds when auth and channel membership pass', pOk.ok && pOk.botUser === 'hivecode')
    T('preflightSlack returns token scopes from x-oauth-scopes header and isPrivate from channel info',
      Array.isArray(pOk.scopes) && pOk.scopes.includes('users:read') && pOk.scopes.includes('chat:write') && pOk.isPrivate === false,
      `scopes=${JSON.stringify(pOk.scopes)} isPrivate=${pOk.isPrivate}`)

    const pNoHeader = await preflightSlack({
      token: 'xoxb-ok',
      channel: 'C-TEST',
      fetchImpl: async (url) => ({
        status: 200,
        headers: new Map(), // x-oauth-scopes header absent
        json: async () => String(url).endsWith('/auth.test')
          ? { ok: true, user: 'hivecode', user_id: 'U1', team_id: 'T1' }
          : { ok: true, channel: { id: 'C-TEST', name: 'general', is_member: true, is_private: true } },
      }),
    })
    T('preflightSlack returns scopes: null when x-oauth-scopes header is absent and isPrivate: true for private channel',
      pNoHeader.ok && pNoHeader.scopes === null && pNoHeader.isPrivate === true &&
      typeof HS.missingInboundScopes === 'function' &&
      HS.missingInboundScopes({ scopes: null, isPrivate: false }).length === 0 &&
      JSON.stringify(HS.missingInboundScopes({ scopes: ['chat:write'], isPrivate: false })) === JSON.stringify(['users:read', 'channels:history']),
      `scopes=${pNoHeader.scopes} isPrivate=${pNoHeader.isPrivate}`)

    const dup = checkDuplicateBridge({ sameNameElsewhere: () => [{ name: 'SlackBridge', kind: 'ai' }] }, 'SlackBridge')
    T('Q632: second SlackBridge in same room is refused', !dup.ok && /Q632/.test(dup.error))

    nextResponses.push({ status: 200, body: { ok: false, error: 'invalid_auth' } })
    const pSockBad = await preflightSocketMode({ appToken: 'xapp-bad', api: process.env.HIVE_SLACK_API })
    T('Q634: invalid SLACK_APP_TOKEN is caught before READY', !pSockBad.ok && /Q634/.test(pSockBad.error) && /invalid_auth/.test(pSockBad.error))

    const pMissingPublicScopes = await preflightSocketMode({
      appToken: 'xapp-ok',
      scopes: ['chat:write', 'channels:read', 'groups:read'],
      isPrivate: false,
      api: process.env.HIVE_SLACK_API,
    })
    T('Q634: inbound is refused when SLACK_BOT_TOKEN lacks users:read or channels:history (names slack-app-manifest-inbound.json)',
      !pMissingPublicScopes.ok &&
      /Q634/.test(pMissingPublicScopes.error || '') &&
      /users:read/.test(pMissingPublicScopes.error || '') &&
      /channels:history/.test(pMissingPublicScopes.error || '') &&
      /slack-app-manifest-inbound\.json/.test(pMissingPublicScopes.error || ''),
      pMissingPublicScopes.error || 'succeeded unexpectedly')

    const pMissingPrivateScope = await preflightSocketMode({
      appToken: 'xapp-ok',
      scopes: ['chat:write', 'channels:read', 'groups:read', 'channels:history', 'users:read'],
      isPrivate: true,
      api: process.env.HIVE_SLACK_API,
    })
    T('Q634: inbound on a private channel is refused when groups:history is missing',
      !pMissingPrivateScope.ok &&
      /Q634/.test(pMissingPrivateScope.error || '') &&
      /groups:history/.test(pMissingPrivateScope.error || '') &&
      /slack-app-manifest-inbound\.json/.test(pMissingPrivateScope.error || ''),
      pMissingPrivateScope.error || 'succeeded unexpectedly')

    // CLI main(): missing SLACK_BOT_TOKEN prints Q630 (not just usage), --dry-run succeeds
    const errs1 = []
    const c1 = await HS.main(['start', 'ws://127.0.0.1:1281|room-123456', '--channel', 'C-TEST'], {
      env: {}, log: () => {}, logErr: (m) => errs1.push(m),
    })
    T('slack start with no token prints Q630 SLACK_BOT_TOKEN is missing', c1 === 1 && errs1.some((m) => /Q630.*SLACK_BOT_TOKEN is missing/.test(m)), errs1.join(' | '))

    const outs2 = []
    const c2 = await HS.main(['start', '--channel', 'C-TEST', 'ws://127.0.0.1:1281|room-123456', '--dry-run'], {
      env: { SLACK_BOT_TOKEN: 'xoxb-ok' }, log: (m) => outs2.push(m), logErr: () => {},
    })
    T('slack start --dry-run verifies token + channel regardless of flag order', c2 === 0 && outs2.some((m) => /DRY RUN OK/.test(m)), outs2.join(' | '))

    // CLI main(): with SLACK_APP_TOKEN set, outbound-only bot token scopes (missing users:read, channels:history) refuse with Q634
    nextResponses.push(
      { status: 200, headers: { 'x-oauth-scopes': 'chat:write,channels:read,groups:read' }, body: { ok: true, user: 'hivecode', user_id: 'U_BOT', team_id: 'T_OUR_TEAM' } },
      { status: 200, headers: { 'x-oauth-scopes': 'chat:write,channels:read,groups:read' }, body: { ok: true, channel: { id: 'C-TEST', name: 'dev-agents', is_member: true, is_private: false } } },
    )
    const errsInboundScope = []
    const c3 = await HS.main(['start', 'ws://127.0.0.1:1281|room-123456', '--channel', 'C-TEST', '--dry-run'], {
      env: { SLACK_BOT_TOKEN: 'xoxb-outbound-only', SLACK_APP_TOKEN: 'xapp-ok' },
      log: () => {},
      logErr: (m) => errsInboundScope.push(m),
    })
    T('slack start with SLACK_APP_TOKEN and outbound-only bot token fails with Q634 and slack-app-manifest-inbound.json',
      c3 === 1 && errsInboundScope.some((m) => /Q634/.test(m) && /slack-app-manifest-inbound\.json/.test(m)),
      errsInboundScope.join(' | ') || `code=${c3}`)

    // parseSlackAllow validator unit tests
    T('parseSlackAllow is exported from hive-slack.js', typeof HS.parseSlackAllow === 'function')
    if (typeof HS.parseSlackAllow === 'function') {
      T('parseSlackAllow accepts valid member ids (U..., W...) and empty string',
        HS.parseSlackAllow('').ok === true &&
        HS.parseSlackAllow('U12345, W67890').ok === true &&
        JSON.stringify(HS.parseSlackAllow('U12345, W67890').ids) === JSON.stringify(['U12345', 'W67890']))
      const badAllowFlag = HS.parseSlackAllow('ganesh, @alice', '--allow')
      T('parseSlackAllow refuses invalid member ids naming --allow and Q634',
        !badAllowFlag.ok && badAllowFlag.code === 'Q634' &&
        /Q634 --allow takes Slack member ids like U012AB3CD, not ganesh, @alice/.test(badAllowFlag.error))
      const badAllowEnv = HS.parseSlackAllow('ganesh', 'SLACK_ALLOW')
      T('parseSlackAllow names SLACK_ALLOW when value came from environment',
        !badAllowEnv.ok && badAllowEnv.code === 'Q634' &&
        /Q634 SLACK_ALLOW takes Slack member ids like U012AB3CD, not ganesh/.test(badAllowEnv.error))
    }

    // CLI --allow validation tests (spawning CLI)
    const spawnOut = (cmd, args, envExtra = {}) => {
      const res = spawnSync(cmd, args, {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, ...envExtra },
      })
      return { code: res.status, out: res.stdout || '', err: res.stderr || '' }
    }
    const badCliAllow = spawnOut(process.execPath, [
      path.join(ROOT, 'hive-mcp.js'), 'slack', 'start',
      'ws://127.0.0.1:1281|room-123456', '--channel', 'C-TEST', '--allow', 'ganesh',
    ], { SLACK_BOT_TOKEN: 'xoxb-dummy', SLACK_APP_TOKEN: 'xapp-dummy' })
    T('slack start --allow ganesh refuses with Q634 naming --allow before connecting',
      badCliAllow.code === 1 && /Q634 --allow takes Slack member ids.*not ganesh/.test(badCliAllow.err),
      badCliAllow.err || `code=${badCliAllow.code}`)

    const badCliAllowEnv = spawnOut(process.execPath, [
      path.join(ROOT, 'hive-mcp.js'), 'slack', 'start',
      'ws://127.0.0.1:1281|room-123456', '--channel', 'C-TEST',
    ], { SLACK_BOT_TOKEN: 'xoxb-dummy', SLACK_APP_TOKEN: 'xapp-dummy', SLACK_ALLOW: 'ganesh' })
    T('slack start with SLACK_ALLOW=ganesh refuses naming SLACK_ALLOW before connecting',
      badCliAllowEnv.code === 1 && /Q634 SLACK_ALLOW takes Slack member ids.*not ganesh/.test(badCliAllowEnv.err),
      badCliAllowEnv.err || `code=${badCliAllowEnv.code}`)

    const dryRunAllowOut = []
    nextResponses.push(
      { status: 200, headers: { 'x-oauth-scopes': 'chat:write,channels:read,groups:read' }, body: { ok: true, user: 'hivecode', user_id: 'U_BOT', team_id: 'T_OUR_TEAM' } },
      { status: 200, headers: { 'x-oauth-scopes': 'chat:write,channels:read,groups:read' }, body: { ok: true, channel: { id: 'C-TEST', name: 'dev-agents', is_member: true, is_private: false } } },
    )
    await HS.main(['start', '--channel', 'C-TEST', 'ws://127.0.0.1:1281|room-123456', '--allow', 'U12345,W67890', '--dry-run'], {
      env: { SLACK_BOT_TOKEN: 'xoxb-ok' }, log: (m) => dryRunAllowOut.push(m), logErr: () => {},
    })
    T('slack start --allow U12345,W67890 prints resume info in READY / DRY RUN line',
      dryRunAllowOut.some((m) => /resume: U12345, W67890/.test(m)),
      dryRunAllowOut.join(' | '))

    // hive-slack-agent spawn tests
    const badAgentAllow = spawnOut(process.execPath, [
      path.join(ROOT, 'hive-slack-agent.js'),
      'ws://127.0.0.1:1281|room-123456', '--channel', 'D-TEST', '--allow', 'ganesh',
    ], { SLACK_BOT_TOKEN: 'xoxb-dummy', SLACK_APP_TOKEN: 'xapp-dummy' })
    T('hive-slack-agent --allow ganesh refuses with Q634 naming --allow before connecting',
      badAgentAllow.code === 1 && /Q634 --allow takes Slack member ids.*not ganesh/.test(badAgentAllow.err),
      badAgentAllow.err || `code=${badAgentAllow.code}`)

    const badAgentAllowEnv = spawnOut(process.execPath, [
      path.join(ROOT, 'hive-slack-agent.js'),
      'ws://127.0.0.1:1281|room-123456', '--channel', 'D-TEST',
    ], { SLACK_BOT_TOKEN: 'xoxb-dummy', SLACK_APP_TOKEN: 'xapp-dummy', SLACK_ALLOW: 'ganesh' })
    T('hive-slack-agent with SLACK_ALLOW=ganesh refuses naming SLACK_ALLOW before connecting',
      badAgentAllowEnv.code === 1 && /Q634 SLACK_ALLOW takes Slack member ids.*not ganesh/.test(badAgentAllowEnv.err),
      badAgentAllowEnv.err || `code=${badAgentAllowEnv.code}`)

    // Verify slack-app-manifest-inbound.json matches package.json files[] and docs/SLACK_SETUP.md Section 5
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const inboundManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'slack-app-manifest-inbound.json'), 'utf8'))
    const setupDoc = fs.readFileSync(path.join(ROOT, 'docs', 'SLACK_SETUP.md'), 'utf8')
    const jsonBlocks = [...setupDoc.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]))
    T('slack-app-manifest-inbound.json is in package.json files[] and matches docs/SLACK_SETUP.md Section 5',
      Array.isArray(pkg.files) &&
      pkg.files.includes('slack-app-manifest-inbound.json') &&
      jsonBlocks.length >= 2 &&
      JSON.stringify(inboundManifest) === JSON.stringify(jsonBlocks[1]))

    const baseManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'slack-app-manifest.json'), 'utf8'))
    T('slack-app-manifest.json is in package.json files[] and matches docs/SLACK_SETUP.md Section 1',
      Array.isArray(pkg.files) &&
      pkg.files.includes('slack-app-manifest.json') &&
      jsonBlocks.length >= 1 &&
      JSON.stringify(baseManifest) === JSON.stringify(jsonBlocks[0]))

    const agentManifestPath = path.join(ROOT, 'slack-app-manifest-agent.json')
    const agentManifestExists = fs.existsSync(agentManifestPath)
    const agentManifest = agentManifestExists ? JSON.parse(fs.readFileSync(agentManifestPath, 'utf8')) : null
    T('slack-app-manifest-agent.json is in package.json files[], includes assistant:write + agent_session_stopped + assistant_view, and matches docs/SLACK_SETUP.md Section 5',
      agentManifestExists &&
      Array.isArray(pkg.files) &&
      pkg.files.includes('slack-app-manifest-agent.json') &&
      Boolean(agentManifest?.features?.assistant_view) &&
      Array.isArray(agentManifest?.oauth_config?.scopes?.bot) &&
      agentManifest.oauth_config.scopes.bot.includes('assistant:write') &&
      agentManifest.oauth_config.scopes.bot.includes('im:history') &&
      Array.isArray(agentManifest?.settings?.event_subscriptions?.bot_events) &&
      agentManifest.settings.event_subscriptions.bot_events.includes('agent_session_stopped') &&
      jsonBlocks.length >= 3 &&
      JSON.stringify(agentManifest) === JSON.stringify(jsonBlocks[2]))

    const agentScopeCheck = typeof HS.checkAgentScopes === 'function'
      ? HS.checkAgentScopes({ scopes: ['chat:write', 'channels:read', 'users:read'], channel: 'D12345' })
      : { ok: true }
    const agentScopeNull = typeof HS.checkAgentScopes === 'function'
      ? HS.checkAgentScopes({ scopes: null, channel: 'D12345' })
      : { ok: false }
    T('checkAgentScopes refuses with Q634 naming assistant:write, im:history, and slack-app-manifest-agent.json (and passes when scopes is null)',
      !agentScopeCheck.ok &&
      agentScopeCheck.code === 'Q634' &&
      /assistant:write/.test(agentScopeCheck.error || '') &&
      /im:history/.test(agentScopeCheck.error || '') &&
      /slack-app-manifest-agent\.json/.test(agentScopeCheck.error || '') &&
      agentScopeNull.ok === true,
      agentScopeCheck.error || 'missing checkAgentScopes')
  }
}

// ---- end to end ----------------------------------------------------------------------------
console.log('\n# end to end: room -> fake Slack -> Socket Mode inbound -> room')
let relaySrv = null
let relayWss = null
let sockSrv = null
let sockWss = null
let sockConn = null
const clients = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slack-t-'))
try {
  calls.length = 0
  const { WebSocketServer } = await import('ws')
  const { setupWSConnection } = await import('../vendor/y-websocket/utils.cjs')
  relaySrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
  relayWss = new WebSocketServer({ server: relaySrv })
  relayWss.on('connection', (ws, req) => {
    const docName = (req.url || '/').slice(1).split('?')[0]
    setupWSConnection(ws, req, { docName })
  })
  await new Promise((r) => relaySrv.listen(PORT, '127.0.0.1', r))

  // Fake Slack Socket Mode WSS server
  const acks = []
  let activeSock = null
  let onSockConn = null
  let suppressHello = false
  let helloNumConnections = 1
  sockSrv = http.createServer()
  sockWss = new WebSocketServer({ server: sockSrv })
  sockWss.on('connection', (ws) => {
    activeSock = ws
    if (typeof onSockConn === 'function') {
      try { onSockConn(ws) } catch { }
    }
    if (!suppressHello) {
      const num = typeof helloNumConnections === 'function' ? helloNumConnections() : helloNumConnections
      try { ws.send(JSON.stringify({ type: 'hello', num_connections: num })) } catch { }
    }
    ws.on('message', (raw) => {
      try { acks.push(JSON.parse(String(raw))) } catch { }
    })
  })
  await new Promise((r) => sockSrv.listen(SOCK_PORT, '127.0.0.1', r))

  const mk = (name) => startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: fs.mkdtempSync(path.join(tmp, name)),
    name, kind: 'ai', syncFiles: false, log: () => {},
  })
  const bridgeHive = mk('SlackBridge'); clients.push(bridgeHive)
  const agent = mk('AgentA'); clients.push(agent)
  await sleep(1500)

  const bridgeErrors = []
  let bridgeClock = 1_000_000
  const bridge = makeBridge({
    hive: bridgeHive,
    channel: 'C-TEST',
    token: 'xoxb-test',
    botName: 'SlackBridge',
    allow: ['U_OWNER'],
    teamId: 'T_OUR_TEAM',
    botUserId: 'U_BOT',
    minGapMs: 20,
    now: () => bridgeClock,
    onError: (e) => bridgeErrors.push(e),
    post: (m) => slackPost('chat.postMessage', m, 'xoxb-test'),
  })
  const chat = bridgeHive.doc.getArray('chat')
  let at = chat.length
  chat.observe(() => { const all = chat.toArray(); bridge.onChat(all.slice(at), at); at = all.length })

  // Multi-connection restart retry on start (fake sends 2, then on retry sends 1 -> starts cleanly)
  let retryAttempts = 0
  helloNumConnections = () => (++retryAttempts === 1 ? 2 : 1)
  let retryConn = null
  let retryErr = null
  try {
    retryConn = await connectSocketMode({
      appToken: 'xapp-test',
      api: process.env.HIVE_SLACK_API,
      startRetryMs: 1500,
      startRetryDelayMs: 60,
      reconnectDelayMs: 80,
    })
  } catch (e) {
    retryErr = e
  }
  T('connectSocketMode retries when num_connections > 1 and starts cleanly when count drops to 1',
    Boolean(retryConn) && !retryErr && retryAttempts >= 2 && !retryConn.isHalted(),
    retryErr ? retryErr.message : `attempts=${retryAttempts}`)
  if (retryConn) retryConn.stop()

  // Multi-connection persistent refusal on start-up (Q635)
  helloNumConnections = 2
  let multiConnErr = null
  try {
    await connectSocketMode({
      appToken: 'xapp-test',
      api: process.env.HIVE_SLACK_API,
      startRetryMs: 150,
      startRetryDelayMs: 50,
      reconnectDelayMs: 80,
    })
  } catch (e) {
    multiConnErr = e
  }
  T('connectSocketMode refuses with Q635 after startRetryMs expires when num_connections stays > 1',
    Boolean(multiConnErr) &&
    multiConnErr.code === 'Q635' &&
    /Q635.*Another process is already connected/.test(multiConnErr.message) &&
    /If you just stopped a bridge, wait a minute for Slack to release the connection and start again/.test(multiConnErr.message) &&
    !/pkill/.test(multiConnErr.message) &&
    !/~50%/.test(multiConnErr.message) &&
    !/round-robin/.test(multiConnErr.message),
    multiConnErr ? `code=${multiConnErr.code} msg=${multiConnErr.message}` : 'succeeded unexpectedly')
  helloNumConnections = 1

  // Dead WebSocket URL: retries for startRetryMs then fails with coded Q634 Error (not raw ECONNREFUSED)
  let deadErr = null
  const deadStderr = []
  try {
    await connectSocketMode({
      appToken: 'xapp-test',
      initialUrl: 'ws://127.0.0.1:9/nobody-listens',
      startRetryMs: 120,
      startRetryDelayMs: 40,
      logErr: (m) => deadStderr.push(m),
    })
  } catch (e) {
    deadErr = e
  }
  T('connectSocketMode throws coded Q634 on dead socket after retry window',
    Boolean(deadErr) && deadErr.code === 'Q634' && /^Q634 Socket Mode could not connect: /m.test(deadErr.message),
    deadErr ? `code=${deadErr.code} msg=${deadErr.message}` : 'succeeded unexpectedly')
  T('connectSocketMode logs retry warning to logErr once during retry',
    deadStderr.some((m) => /Slack Socket Mode could not connect/.test(m)),
    `stderr=${JSON.stringify(deadStderr)}`)

  // Liveness check: (a) half-open socket (simulated with ws._socket.pause())
  // Must detect silence, probe with ping, timeout, terminate, reconnect, and log outage + recovery
  let halfOpenConnections = 0
  const halfOpenLogs = []
  onSockConn = (ws) => {
    halfOpenConnections++
    if (halfOpenConnections === 1) {
      setTimeout(() => {
        try { ws._socket.pause() } catch { }
      }, 20)
    }
  }
  const halfOpenConn = await connectSocketMode({
    appToken: 'xapp-test',
    api: process.env.HIVE_SLACK_API,
    pingIntervalMs: 80,
    probeTimeoutMs: 40,
    reconnectDelayMs: 40,
    logErr: (m) => halfOpenLogs.push(m),
  })
  await sleep(350)
  halfOpenConn.stop()
  onSockConn = null

  T('half-open socket: detects silence, probes, terminates, reconnects, and logs outage + recovery',
    halfOpenConnections >= 2 &&
    halfOpenLogs.some((m) => /went silent/i.test(m)) &&
    halfOpenLogs.some((m) => /reconnected/i.test(m)),
    `connections=${halfOpenConnections} logs=${JSON.stringify(halfOpenLogs)}`)

  // Liveness check: (b) quiet but ALIVE server that sends nothing but answers pings
  // Must NOT reconnect over multiple watchdog periods
  let quietConnections = 0
  const quietLogs = []
  onSockConn = () => {
    quietConnections++
  }
  const quietConn = await connectSocketMode({
    appToken: 'xapp-test',
    api: process.env.HIVE_SLACK_API,
    pingIntervalMs: 60,
    probeTimeoutMs: 30,
    reconnectDelayMs: 40,
    logErr: (m) => quietLogs.push(m),
  })
  await sleep(280)
  quietConn.stop()
  onSockConn = null

  T('quiet but alive server: answers pings and does NOT reconnect over multiple watchdog periods',
    quietConnections === 1 &&
    !quietLogs.some((m) => /went silent/i.test(m)),
    `connections=${quietConnections} logs=${JSON.stringify(quietLogs)}`)

  const bridgeStderr = []
  sockConn = await connectSocketMode({
    appToken: 'xapp-test',
    api: process.env.HIVE_SLACK_API,
    reconnectDelayMs: 80,
    logErr: (m) => bridgeStderr.push(m),
    onEvent: (ev) => bridge.onInboundEvent(ev),
    onMultiConnection: (n) => bridge.postChannel(
      `:warning: Another process connected to Slack Socket Mode with this app token (${n} active connections). Slack will distribute events across them, so commands or replies may be dropped. Check for another running bridge or agent panel.`,
    ),
  })
  await sleep(200)

  // 1. a task opens -> the CHANNEL, and a thread is born
  const open = await bridge.emit({ kind: 'task-open', task: 'T-1', to: 'AgentA' })
  const postCalls = () => calls.filter((c) => c.method === 'chat.postMessage')
  T('task-open reached Slack', postCalls().length === 1 && postCalls()[0].channel === 'C-TEST')
  T('it went to the channel, not a thread', !postCalls()[0].thread_ts)
  T('the bot token was sent', postCalls()[0].auth === 'Bearer xoxb-test')
  const ts = open.ts
  T('the thread id is stored in ROOM state', bridge.threads.get('T-1') === ts, `ts=${ts}`)

  // 2. everything else about that task lands INSIDE the thread
  await bridge.emit({ kind: 'gate-fail', task: 'T-1', by: 'AgentA', file: 'alpha.js' })
  T('the gate failure went into the task thread', postCalls()[1].thread_ts === ts, `thread_ts=${postCalls()[1].thread_ts}`)

  // 3. untasked room chat: first message opens the room thread, follow-ups stay INSIDE it (no channel flood)
  const chatSecret = ['ghp', 'kL9mN8pQ7rS6tU5vW4xY3zA2bC1dE0fG9hJ8'].join('_')
  agent.doc.getArray('chat').push([
    { by: 'AgentA', kind: 'say', at: Date.now() * 1000, text: 'claiming alpha.js' },
    { by: 'AgentA', kind: 'say', at: Date.now() * 1000 + 1, text: 'editing alpha.js' },
    { by: 'AgentA', kind: 'say', at: Date.now() * 1000 + 2, text: 'secret ' + chatSecret + ' in ws://127.0.0.1:1281|' + ROOM },
  ])
  await sleep(600)
  const chatCalls = postCalls().filter((c) => /^\*AgentA\*:/.test(c.text || ''))
  T('a room message crossed to Slack', chatCalls.some((c) => c.text === '*AgentA*: claiming alpha.js'), `${postCalls().length} post(s)`)
  const roomTs = bridge.threads.get('__room__')
  T('follow-up untasked chat stays inside one room thread instead of flooding the channel',
    Boolean(roomTs) && chatCalls.length === 3 && !chatCalls[0].thread_ts && chatCalls[1].thread_ts === roomTs && chatCalls[2].thread_ts === roomTs,
    `roomTs=${roomTs}, threads=${chatCalls.map((c) => c.thread_ts || 'root').join(',')}`)
  T('outbound room chat scrubs secrets and room links before reaching Slack',
    chatCalls.length === 3 && !chatCalls[2].text.includes(chatSecret) && !chatCalls[2].text.includes(ROOM))

  // 4. Socket Mode inbound: Guest & external Slack Connect users are refused even for STOP
  // TIMING NOTE: the fixed sleep()s in this block are waits for real network + CRDT round trips.
  // On a heavily loaded machine three checks below ("the Slack reply arrived in the room",
  // "it was attributed to the task", "NO IMPERSONATION") failed once and passed on every rerun.
  // If they fail again, replace the 600 ms sleeps with a poll-until-condition (up to N seconds)
  // rather than a longer sleep.
  T('AgentA is running before inbound events', agent.isPaused() === false)
  activeSock.send(JSON.stringify({
    envelope_id: 'env-guest',
    payload: { event_id: 'Ev_GUEST', event: { type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_GUEST', text: 'stop' } },
  }))
  activeSock.send(JSON.stringify({
    envelope_id: 'env-ext',
    payload: { event_id: 'Ev_EXT', event: { type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_EXTERNAL', text: 'stop' } },
  }))
  await sleep(500)
  T('Socket Mode sends immediate envelope_id acks (<3s)', acks.some((a) => a.envelope_id === 'env-guest') && acks.some((a) => a.envelope_id === 'env-ext'))
  T('guests (is_restricted) and external Slack Connect users (team_id mismatch) cannot stop agents',
    agent.isPaused() === false && postCalls().some((c) => /guests and external Slack Connect users cannot/.test(c.text || '')))

  // 5. Asymmetric auth: any full workspace member (U_COWORKER, not in --allow) MAY stop agents
  activeSock.send(JSON.stringify({
    envelope_id: 'env-stop-1',
    payload: { event_id: 'Ev_STOP_1', event: { type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_COWORKER', text: 'stop AgentA' } },
  }))
  await sleep(600)
  T('any full workspace member can STOP an agent (AgentA is paused ON ITS OWN CLIENT)', agent.isPaused() === true)

  // 6. Asymmetric auth: U_COWORKER (not in --allow U_OWNER) CANNOT resume or post replies into the room
  activeSock.send(JSON.stringify({
    envelope_id: 'env-unauth-resume',
    payload: { event_id: 'Ev_UNAUTH_RES', event: { type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_COWORKER', text: 'resume AgentA' } },
  }))
  activeSock.send(JSON.stringify({
    envelope_id: 'env-unauth-reply',
    payload: { event_id: 'Ev_UNAUTH_REP', event: { type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_COWORKER', text: '@AgentA delete everything' } },
  }))
  await sleep(600)
  T('member not in --allow is refused when trying to RESUME (AgentA stays paused)',
    agent.isPaused() === true && postCalls().some((c) => /only Slack user IDs listed in --allow/.test(c.text || '')))
  T('member not in --allow cannot inject thread replies into the room',
    !agent.doc.getArray('chat').toArray().some((m) => /delete everything/.test(m.text || '')))

  // 7. Allowed owner (U_OWNER in --allow) CAN resume and reply; attribution is slack:<handle> (never bare Ganesh)
  activeSock.send(JSON.stringify({
    envelope_id: 'env-owner-resume',
    payload: { event_id: 'Ev_OWN_RES', event: { type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_OWNER', text: 'resume AgentA' } },
  }))
  await sleep(600)
  T('allowed user (--allow U_OWNER) resumes AgentA ON ITS OWN CLIENT', agent.isPaused() === false)

  // Re-sending duplicate event_id Ev_STOP_1 must be ignored (deduped)
  activeSock.send(JSON.stringify({
    envelope_id: 'env-stop-dup',
    payload: { event_id: 'Ev_STOP_1', event: { type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_COWORKER', text: 'stop AgentA' } },
  }))
  await sleep(300)
  T('duplicate event_id is deduplicated and does not re-pause AgentA', agent.isPaused() === false)

  const beforeReplyPosts = postCalls().length
  activeSock.send(JSON.stringify({
    envelope_id: 'env-owner-reply',
    payload: { event_id: 'Ev_OWN_REP', event: { type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_OWNER', text: '@AgentA use the other helper' } },
  }))
  await sleep(600)
  const roomChat = agent.doc.getArray('chat').toArray()
  const slackMsg = roomChat.find((m) => m.text === '@AgentA use the other helper' && m.viaSlack)
  T('the Slack reply arrived in the room', Boolean(slackMsg))
  T('it was attributed to the task it replied to', Boolean(slackMsg && slackMsg.task === 'T-1'))
  T('NO IMPERSONATION: Slack user "Ganesh" is attributed as "slack:Ganesh", never bare "Ganesh"',
    Boolean(slackMsg && slackMsg.by === 'slack:Ganesh' && formatSlackSender('Ganesh') === 'slack:Ganesh'),
    slackMsg ? slackMsg.by : 'missing')

  // 8. THE ECHO GUARD: that reply must not be sent straight back out to Slack
  await sleep(400)
  T('the reply did NOT echo back to Slack', postCalls().length === beforeReplyPosts,
    `${postCalls().length - beforeReplyPosts} extra post(s)`)

  // 9. Socket Mode disconnect frame triggers a clean reconnect via apps.connections.open
  const openCallsBefore = calls.filter((c) => c.method === 'apps.connections.open').length
  // (a) Reconnect with num_connections: 2 within 15s of our own socket closing (recognized as our own socket, no warning)
  helloNumConnections = 2
  activeSock.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }))
  await sleep(350)
  const openCallsAfter = calls.filter((c) => c.method === 'apps.connections.open').length
  T('Socket Mode reconnects via apps.connections.open on disconnect frame', openCallsAfter > openCallsBefore, `${openCallsBefore} -> ${openCallsAfter}`)
  T('reconnect with num_connections: 2 within 15s does not warn (recognized as own lingering socket)',
    !postCalls().some((c) => /Another process connected to Slack Socket Mode/.test(c.text || '')))

  // (b) Later reconnect with num_connections: 3 (foreign process joined while running) warns in channel and stderr once per rise, and keeps running
  helloNumConnections = 3
  activeSock.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }))
  await sleep(350)
  T('foreign process with num_connections > 2 warns in channel and stderr once and keeps running',
    postCalls().some((c) => /Another process connected to Slack Socket Mode/.test(c.text || '')) &&
    bridgeStderr.some((c) => /WARNING: Slack Socket Mode reports 3 active connections/.test(c)) &&
    !sockConn.isHalted())
  const stderrCountBefore = bridgeStderr.length
  // Another disconnect frame while num_connections is still 3: does not warn again (once per rise)
  activeSock.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }))
  await sleep(350)
  T('mid-run warning does not repeat while count stays high',
    bridgeStderr.length === stderrCountBefore)
  // Drop back to 1:
  helloNumConnections = 1
  activeSock.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }))
  await sleep(350)
  // Rise back to 3:
  helloNumConnections = 3
  activeSock.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }))
  await sleep(350)
  T('mid-run warning emits again on next rise',
    bridgeStderr.length === stderrCountBefore + 1)
  helloNumConnections = 1

  // 10. Fail-safe STOP when users.info fails (outage / rate limit): stop succeeds, resume stays refused
  nextResponses.push({ status: 500, body: { ok: false, error: 'internal_error' } })
  await bridge.onInboundEvent({ type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_EMERGENCY', text: 'stop AgentA' })
  await sleep(450)
  T('STOP succeeds even when users.info fails ("stopped; I could not confirm who you are")',
    agent.isPaused() === true && postCalls().some((c) => /stopped; I could not confirm who you are/.test(c.text || '')))

  nextResponses.push({ status: 500, body: { ok: false, error: 'internal_error' } })
  await bridge.onInboundEvent({ type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_EMERGENCY', text: 'resume AgentA' })
  await sleep(450)
  T('RESUME stays refused when users.info fails', agent.isPaused() === true)

  // Resume via allowed owner, then test 10-minute userCache TTL expiry when a member becomes a guest
  await bridge.onInboundEvent({ type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_OWNER', text: 'resume AgentA' })
  await sleep(450)
  USERS.U_COWORKER.is_restricted = true
  bridgeClock += 10 * 60 * 1000 + 1000 // past 10-minute TTL
  await bridge.onInboundEvent({ type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_COWORKER', text: 'stop AgentA' })
  await sleep(450)
  T('userCache expires after 10 minutes: a member demoted to guest is re-checked and refused',
    agent.isPaused() === false)

  // 10a. "Also send to channel" marks a thread reply subtype thread_broadcast, and a reply with a
  // file is file_share: both are a person talking. The filter dropped every subtype, so a stop sent
  // either way was silently ignored (found by antigravity-4, 7 Nov 2026).
  for (const subtype of ['thread_broadcast', 'file_share']) {
    await bridge.onInboundEvent({ type: 'message', subtype, channel: 'C-TEST', thread_ts: ts, user: 'U_OWNER', text: 'stop AgentA' })
    await sleep(450)
    T(`a "stop" sent as ${subtype} stops the agent`, agent.isPaused() === true)
    await bridge.onInboundEvent({ type: 'message', channel: 'C-TEST', thread_ts: ts, user: 'U_OWNER', text: 'resume AgentA' })
    await sleep(450)
  }
  for (const subtype of ['message_changed', 'message_deleted', 'channel_join', 'bot_message']) {
    await bridge.onInboundEvent({ type: 'message', subtype, channel: 'C-TEST', thread_ts: ts, user: 'U_OWNER', text: 'stop AgentA' })
  }
  await sleep(450)
  T('...while an edit, a deletion, a join or a bot message saying "stop" is still ignored', agent.isPaused() === false)

  // 10b. THE ROOM'S OWN EVENTS REACH SLACK. docs/SLACK_SETUP.md Section 4 says `slack start` shows
  // task-open and task-done in the channel and gate pass/fail inside a thread. Until now only the
  // test ever called emit() with those: `slack start` itself watched the chat and nothing else, so
  // a real task was never announced -- a doc row that was true of the renderer and false of the product.
  console.log('\n# room tasks and gates reach Slack (docs/SLACK_SETUP.md Section 4)')
  {
    const R2 = ROOM + '-tasks'
    const mk2 = (name) => startSync({
      relay: `ws://127.0.0.1:${PORT}`, room: R2, dir: fs.mkdtempSync(path.join(tmp, name)),
      name, kind: 'ai', syncFiles: false, log: () => {},
    })
    const watcherHive = mk2('SlackBridgeW'); clients.push(watcherHive)
    const worker = mk2('AgentW'); clients.push(worker)
    const boss = mk2('AgentBoss'); clients.push(boss)
    await sleep(1500)
    const sent = []
    let wTs = 7000
    const mkBridge = () => makeBridge({
      hive: watcherHive, channel: 'C-W', token: 'xoxb-test', botName: 'SlackBridgeW', minGapMs: 5,
      post: async (m) => { sent.push(m); return { ok: true, ts: String(wTs++) } },
    })
    boss.assign('AgentW', 'old task from before the bridge started')
    await sleep(800)
    const b1 = mkBridge()
    if (typeof b1.watchRoom !== 'function') {
      T('the bridge watches the room\'s tasks and gates (bridge.watchRoom)', false, 'missing: nothing in `slack start` emits task-open / task-done / gate-pass / gate-fail')
    } else {
      await b1.watchRoom()
      await sleep(300)
      T('a task that existed before the bridge first attached is not announced (no flood on first start)', sent.length === 0, `${sent.length} post(s)`)

      const id = boss.assign('AgentW', 'refactor the parser')
      await sleep(1500)
      const opened = sent.find((m) => /refactor the parser/.test(m.text || ''))
      T('task-open reaches the CHANNEL as a root post that names the task and its assignee',
        Boolean(opened) && opened.channel === 'C-W' && !opened.thread_ts && /AgentW/.test(opened.text),
        opened ? JSON.stringify(opened) : 'no post')
      const openTs = b1.threads.get(id)
      T('the task thread id is stored in room state', Boolean(openTs), `ts=${openTs}`)

      worker.complete(id, 'done')
      await sleep(1500)
      const done = sent.find((m) => /done by/i.test(m.text || '') && /AgentW/.test(m.text || ''))
      T('task-done lands in the task\'s thread AND is broadcast to the channel (reply_broadcast)',
        Boolean(done) && done.thread_ts === openTs && done.reply_broadcast === true,
        done ? JSON.stringify(done) : 'no post')

      const gates = boss.doc.getMap('gate_results')
      gates.set('alpha.js|AgentW', { region: 'alpha.js', by: 'AgentW', pass: false, exit: 1, forced: false, at: Date.now() * 1000 })
      await sleep(1200)
      const gf = sent.find((m) => /gate failed for \*AgentW\* on `alpha\.js`/.test(m.text || ''))
      T('a failed gate is announced, and is NOT broadcast to the channel', Boolean(gf) && !gf.reply_broadcast, gf ? JSON.stringify(gf) : 'no post')
      gates.set('beta.js|AgentW', { region: 'beta.js', by: 'AgentW', pass: true, exit: 0, forced: false, at: Date.now() * 1000 + 1 })
      await sleep(1200)
      const gp = sent.find((m) => /gate passed for \*AgentW\* on `beta\.js`/.test(m.text || ''))
      T('a passed gate is announced inside the shared room thread, not the channel root',
        Boolean(gp) && Boolean(b1.threads.get('__room__')) && gp.thread_ts === b1.threads.get('__room__') && !gp.reply_broadcast,
        gp ? JSON.stringify(gp) : 'no post')

      const before = sent.length
      const b2 = mkBridge()
      await b2.watchRoom()
      await sleep(1200)
      T('a restarted bridge does not announce the same tasks and gates again',
        sent.length === before && !sent.some((m) => /old task from before/.test(m.text || '')),
        `${sent.length - before} extra post(s)`)
    }
  }

  // 11. slack check end-to-end: events arrive (0), never arrive (1), token bad (1), no hello (1), missing_scope needed (1)
  console.log('\n# slack check end-to-end')
  if (sockConn) { try { sockConn.stop() } catch { } sockConn = null }

  async function runWithBound(fn, boundMs) {
    let timer
    const t0 = Date.now()
    const hung = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ hung: true, code: -1 }), boundMs)
    })
    const res = await Promise.race([
      fn().then((code) => ({ hung: false, code })),
      hung,
    ])
    clearTimeout(timer)
    return { ...res, elapsed: Date.now() - t0 }
  }

  // (a) Events arrive (exit 0): prompt says "reply anything in this thread", says up front it posts in #dev-agents, and a reply of "ok" passes
  {
    const logs = [], errs = []
    const checkWatcher = setInterval(() => {
      const promptPost = calls.slice().reverse().find((c) => c.method === 'chat.postMessage' && /reply anything in this thread/i.test(c.text || ''))
      if (promptPost && activeSock && activeSock.readyState === 1) {
        clearInterval(checkWatcher)
        // Find the ts returned for that prompt (tsSeq - 1 at the time it was answered)
        const promptIdx = calls.filter((c) => c.method === 'chat.postMessage').length
        const promptTs = String(1000 + promptIdx - 1)
        activeSock.send(JSON.stringify({
          envelope_id: 'env-check-ok',
          payload: {
            event_id: 'Ev_CHECK_OK_1',
            event: { type: 'message', channel: 'C-TEST', thread_ts: promptTs, user: 'U_OWNER', text: 'ok' },
          },
        }))
      }
    }, 30)
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'C-TEST', '--timeout', '1500'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-ok', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      1500 + 5000,
    )
    clearInterval(checkWatcher)
    const allOut = logs.join('\n')
    T('slack check (events arrive): exits 0 within timeout+5s and prints every verified step + replies reach Hivecode',
      !r.hung && r.code === 0 && r.elapsed < 6500 &&
      /token/i.test(allOut) &&
      /workspace/i.test(allOut) &&
      /channel/i.test(allOut) &&
      /scopes/i.test(allOut) &&
      /Socket Mode/i.test(allOut) &&
      /This posts one message in #dev-agents \(and one reply in its thread\)/.test(allOut) &&
      /replies reach Hivecode/.test(allOut),
      `code=${r.code} elapsed=${r.elapsed}ms out=${JSON.stringify(logs)} err=${JSON.stringify(errs)}`)
  }

  // (b) Events never arrive (exit 1): Socket Mode connects (hello) but no reply arrives within timeout
  {
    const logs = [], errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'C-TEST', '--timeout', '200'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-ok', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      200 + 5000,
    )
    const allOut = logs.join('\n')
    const allErr = errs.join('\n')
    T('slack check (events never arrive): exits 1 within timeout+5s, never prints replies reach Hivecode, and names slack-app-manifest-inbound.json',
      !r.hung && r.code === 1 && r.elapsed < 5200 &&
      !/replies reach Hivecode/.test(allOut) &&
      /replies did not arrive\. Event subscriptions are probably missing: reinstall from slack-app-manifest-inbound\.json/.test(allErr),
      `code=${r.code} elapsed=${r.elapsed}ms err=${allErr}`)
  }

  // (c) Token bad (exit 1): auth.test fails -> exits 1 with Q630, never prints ✓ for workspace/channel/scopes/Socket Mode
  {
    nextResponses.push({ status: 200, body: { ok: false, error: 'invalid_auth' } })
    const logs = [], errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'C-TEST', '--timeout', '200'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-bad', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      200 + 5000,
    )
    const allOut = logs.join('\n')
    const allErr = errs.join('\n')
    T('slack check (token bad): exits 1 with Q630 and never prints OK/✓ for unverified steps',
      !r.hung && r.code === 1 && r.elapsed < 5200 &&
      /Q630/.test(allErr) &&
      !/workspace|channel|scopes|Socket Mode|replies reach Hivecode/i.test(allOut),
      `code=${r.code} out=${allOut} err=${allErr}`)
  }

  // (c2) Slack API unreachable (exit 1): exits 1 with Q636 and never prints OK/✓
  {
    const logs = [], errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'C-TEST', '--timeout', '200'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-ok', SLACK_APP_TOKEN: 'xapp-ok' },
        fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      200 + 5000,
    )
    const allOut = logs.join('\n')
    const allErr = errs.join('\n')
    T('slack check (unreachable Slack): exits 1 with Q636 and never prints OK/✓ for unverified steps',
      !r.hung && r.code === 1 && r.elapsed < 5200 &&
      /Q636/.test(allErr) && /could not reach Slack/.test(allErr) &&
      !/workspace|channel|scopes|Socket Mode|replies reach Hivecode/i.test(allOut),
      `code=${r.code} out=${allOut} err=${allErr}`)
  }

  // (d) Socket Mode never sends `hello` frame (exit 1): times out on hello and exits 1 with Q634, never hangs
  {
    suppressHello = true
    const logs = [], errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'C-TEST', '--timeout', '500', '--hello-timeout', '150'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-ok', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      500 + 5000,
    )
    suppressHello = false
    const allOut = logs.join('\n')
    const allErr = errs.join('\n')
    T('slack check (Socket Mode no hello frame): exits 1 with Q634 within timeout+5s and never hangs or prints Socket Mode OK',
      !r.hung && r.code === 1 && r.elapsed < 5500 &&
      /Q634/.test(allErr) &&
      !/✓ Socket Mode/.test(allOut),
      `code=${r.code} elapsed=${r.elapsed}ms err=${allErr}`)
  }

  // (d1) Socket Mode multi-connection persistent failure (exit 1 with Q635)
  {
    helloNumConnections = 2
    const logs = [], errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'C-TEST', '--timeout', '500', '--start-retry', '120'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-ok', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      500 + 5000,
    )
    helloNumConnections = 1
    const allOut = logs.join('\n')
    const allErr = errs.join('\n')
    T('slack check (multi-connection persistent failure): exits 1 with Q635, names retry guidance, and never prints Socket Mode OK',
      !r.hung && r.code === 1 &&
      /Q635/.test(allErr) &&
      /Another process is already connected/.test(allErr) &&
      /wait a minute for Slack to release the connection/.test(allErr) &&
      !/✓ Socket Mode/.test(allOut),
      `code=${r.code} err=${allErr}`)
  }

  // (d2) Socket Mode multi-connection retry succeeds (fake sends 2, then on retry sends 1 -> exits 0)
  {
    let checkRetry = 0
    helloNumConnections = () => (++checkRetry === 1 ? 2 : 1)
    const logs = [], errs = []
    const checkWatcher = setInterval(() => {
      const promptPost = calls.slice().reverse().find((c) => c.method === 'chat.postMessage' && /reply anything in this thread/i.test(c.text || ''))
      if (promptPost && activeSock && activeSock.readyState === 1) {
        clearInterval(checkWatcher)
        const promptIdx = calls.filter((c) => c.method === 'chat.postMessage').length
        const promptTs = String(1000 + promptIdx - 1)
        activeSock.send(JSON.stringify({
          envelope_id: 'env-check-retry-ok',
          payload: {
            event_id: 'Ev_CHECK_RETRY_OK_1',
            event: { type: 'message', channel: 'C-TEST', thread_ts: promptTs, user: 'U_OWNER', text: 'ok' },
          },
        }))
      }
    }, 30)
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'C-TEST', '--timeout', '1500', '--start-retry', '1500'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-ok', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      1500 + 5000,
    )
    clearInterval(checkWatcher)
    helloNumConnections = 1
    const allOut = logs.join('\n')
    T('slack check (multi-connection retry): retries when count is 2 and exits 0 when count drops to 1',
      !r.hung && r.code === 0 && checkRetry >= 2 &&
      /✓ Socket Mode: connected/.test(allOut) &&
      /✓ replies reach Hivecode/.test(allOut),
      `code=${r.code} checkRetry=${checkRetry} out=${allOut} err=${errs.join('\n')}`)
  }

  // (e) missing_scope on conversations.info or chat.postMessage names the exact `needed` scope from Slack's response
  {
    nextResponses.push(
      { status: 200, body: { ok: true, user: 'hivecode', user_id: 'U_BOT', team: 'TestTeam', team_id: 'T_OUR_TEAM' } },
      { status: 200, body: { ok: false, error: 'missing_scope', needed: 'groups:read', provided: 'chat:write,channels:read' } },
    )
    const logs = [], errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'G123PRIV', '--timeout', '200'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      200 + 5000,
    )
    const allErr = errs.join('\n')
    T('missing_scope error names the exact scope from Slack\'s `needed` field (groups:read)',
      !r.hung && r.code === 1 && /groups:read/.test(allErr),
      `code=${r.code} err=${allErr}`)
  }

  // (f) slack check --agent: top-level `warning: "missing_agent_session_stopped_event_subscription"` refuses with Q634 AND clears status in finally
  {
    const agentScopes = 'chat:write,assistant:write,im:history,im:read,im:write,channels:read,groups:read,channels:history,groups:history,users:read'
    nextResponses.push(
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, user: 'hivecode', user_id: 'U_BOT', team: 'TestTeam', team_id: 'T_OUR_TEAM' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, channel: { id: 'D-TEST', name: 'hivecode-dm', is_member: true, is_im: true } } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, url: `ws://127.0.0.1:${SOCK_PORT}` } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, ts: '9101.01' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, warning: 'missing_agent_session_stopped_event_subscription' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true } },
    )
    const beforeCalls = calls.length
    const logs = [], errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'D-TEST', '--agent', '--timeout', '300'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-agent', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      300 + 5000,
    )
    const recentStatusCalls = calls.slice(beforeCalls).filter((c) => c.method === 'agents.sessions.setStatus')
    const allErr = errs.join('\n')
    T('slack check --agent (top-level warning): refuses with Q634 naming missing_agent_session_stopped_event_subscription + slack-app-manifest-agent.json, and clears status in finally',
      !r.hung && r.code === 1 &&
      /Q634/.test(allErr) &&
      /missing_agent_session_stopped_event_subscription/.test(allErr) &&
      /slack-app-manifest-agent\.json/.test(allErr) &&
      recentStatusCalls.length === 2 &&
      recentStatusCalls[0].status === 'processing' &&
      recentStatusCalls[0].thread_ts === '9101.01' &&
      recentStatusCalls[1].status === 'active' &&
      recentStatusCalls[1].thread_ts === '9101.01',
      `code=${r.code} statusCalls=${JSON.stringify(recentStatusCalls)} err=${allErr}`)
  }

  // (g) slack check --agent: `response_metadata.warnings: ["missing_agent_session_stopped_event_subscription"]` refuses with Q634 AND clears status in finally
  {
    const agentScopes = 'chat:write,assistant:write,im:history,im:read,im:write,channels:read,groups:read,channels:history,groups:history,users:read'
    nextResponses.push(
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, user: 'hivecode', user_id: 'U_BOT', team: 'TestTeam', team_id: 'T_OUR_TEAM' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, channel: { id: 'D-TEST', name: 'hivecode-dm', is_member: true, is_im: true } } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, url: `ws://127.0.0.1:${SOCK_PORT}` } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, ts: '9102.02' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, response_metadata: { warnings: ['missing_agent_session_stopped_event_subscription'] } } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true } },
    )
    const beforeCalls = calls.length
    const logs = [], errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'D-TEST', '--agent', '--timeout', '300'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-agent', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      300 + 5000,
    )
    const recentStatusCalls = calls.slice(beforeCalls).filter((c) => c.method === 'agents.sessions.setStatus')
    const allErr = errs.join('\n')
    T('slack check --agent (response_metadata.warnings[]): refuses with Q634 and clears status in finally',
      !r.hung && r.code === 1 &&
      /Q634/.test(allErr) &&
      /missing_agent_session_stopped_event_subscription/.test(allErr) &&
      recentStatusCalls.length === 2 &&
      recentStatusCalls[0].status === 'processing' &&
      recentStatusCalls[1].status === 'active' &&
      recentStatusCalls[1].thread_ts === '9102.02',
      `code=${r.code} statusCalls=${JSON.stringify(recentStatusCalls)} err=${allErr}`)
  }

  // (h) slack check --agent: `feature_disabled` or `thread_ts_required` error is named and still clears status in finally
  {
    const agentScopes = 'chat:write,assistant:write,im:history,im:read,im:write,channels:read,groups:read,channels:history,groups:history,users:read'
    nextResponses.push(
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, user: 'hivecode', user_id: 'U_BOT', team: 'TestTeam', team_id: 'T_OUR_TEAM' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, channel: { id: 'D-TEST', name: 'hivecode-dm', is_member: true, is_im: true } } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, url: `ws://127.0.0.1:${SOCK_PORT}` } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, ts: '9103.03' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: false, error: 'feature_disabled' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true } },
    )
    const beforeCalls = calls.length
    const errs = []
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'D-TEST', '--agent', '--timeout', '300'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-agent', SLACK_APP_TOKEN: 'xapp-ok' },
        log: () => {},
        logErr: (m) => errs.push(m),
      }),
      300 + 5000,
    )
    const recentStatusCalls = calls.slice(beforeCalls).filter((c) => c.method === 'agents.sessions.setStatus')
    const allErr = errs.join('\n')
    T('slack check --agent (feature_disabled): names feature_disabled + paid Slack plan and clears status in finally',
      !r.hung && r.code === 1 &&
      /Q634/.test(allErr) &&
      /feature_disabled/.test(allErr) &&
      recentStatusCalls.length === 2 &&
      recentStatusCalls[1].status === 'active',
      `code=${r.code} err=${allErr}`)

    nextResponses.push(
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, user: 'hivecode', user_id: 'U_BOT', team: 'TestTeam', team_id: 'T_OUR_TEAM' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, channel: { id: 'D-TEST', name: 'hivecode-dm', is_member: true, is_im: true } } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, url: `ws://127.0.0.1:${SOCK_PORT}` } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, ts: '9104.04' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: false, error: 'thread_ts_required' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true } },
    )
    const errsThreadTs = []
    const rThreadTs = await runWithBound(
      () => HS.main(['check', '--channel', 'D-TEST', '--agent', '--timeout', '300'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-agent', SLACK_APP_TOKEN: 'xapp-ok' },
        log: () => {},
        logErr: (m) => errsThreadTs.push(m),
      }),
      300 + 5000,
    )
    T('slack check --agent (thread_ts_required): names thread_ts_required when Slack rejects setStatus',
      !rThreadTs.hung && rThreadTs.code === 1 && /thread_ts_required/.test(errsThreadTs.join('\n')),
      `code=${rThreadTs.code} err=${errsThreadTs.join('\n')}`)
  }

  // (i) slack check --agent happy path: passes thread_ts to setStatus, verifies no warning, receives reply, clears status in finally, exits 0
  {
    const agentScopes = 'chat:write,assistant:write,im:history,im:read,im:write,channels:read,groups:read,channels:history,groups:history,users:read'
    nextResponses.push(
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, user: 'hivecode', user_id: 'U_BOT', team: 'TestTeam', team_id: 'T_OUR_TEAM' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, channel: { id: 'D-TEST', name: 'hivecode-dm', is_member: true, is_im: true } } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, url: `ws://127.0.0.1:${SOCK_PORT}` } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, ts: '9105.05' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true, ts: '9105.06' } },
      { status: 200, headers: { 'x-oauth-scopes': agentScopes }, body: { ok: true } },
    )
    const beforeCalls = calls.length
    const logs = [], errs = []
    const checkWatcher = setInterval(() => {
      const statusPost = calls.slice(beforeCalls).find((c) => c.method === 'agents.sessions.setStatus' && c.status === 'processing')
      if (statusPost && activeSock && activeSock.readyState === 1) {
        clearInterval(checkWatcher)
        activeSock.send(JSON.stringify({
          envelope_id: 'env-agent-ok',
          payload: {
            event_id: 'Ev_AGENT_OK_1',
            event: { type: 'message', channel: 'D-TEST', thread_ts: '9105.05', user: 'U_OWNER', text: 'ok' },
          },
        }))
      }
    }, 30)
    const r = await runWithBound(
      () => HS.main(['check', '--channel', 'D-TEST', '--agent', '--timeout', '1500'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-agent', SLACK_APP_TOKEN: 'xapp-ok' },
        log: (m) => logs.push(m),
        logErr: (m) => errs.push(m),
      }),
      1500 + 5000,
    )
    clearInterval(checkWatcher)
    const recentStatusCalls = calls.slice(beforeCalls).filter((c) => c.method === 'agents.sessions.setStatus')
    const allOut = logs.join('\n')
    T('slack check --agent (happy path): exits 0, verifies agent session with thread_ts, receives reply, and clears status in finally',
      !r.hung && r.code === 0 &&
      /agent session/i.test(allOut) &&
      /replies reach Hivecode/.test(allOut) &&
      recentStatusCalls.length === 2 &&
      recentStatusCalls[0].status === 'processing' &&
      recentStatusCalls[0].thread_ts === '9105.05' &&
      recentStatusCalls[1].status === 'active' &&
      recentStatusCalls[1].thread_ts === '9105.05',
      `code=${r.code} out=${allOut} err=${errs.join('\n')}`)
  }
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  if (sockConn) { try { sockConn.stop() } catch { } }
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  if (relayWss) {
    for (const c of relayWss.clients) { try { c.terminate() } catch { } }
    try { relayWss.close() } catch { }
  }
  if (relaySrv) {
    try { relaySrv.closeAllConnections && relaySrv.closeAllConnections() } catch { }
    await new Promise((r) => relaySrv.close(r))
  }
  if (sockWss) {
    for (const c of sockWss.clients) { try { c.terminate() } catch { } }
    try { sockWss.close() } catch { }
  }
  if (sockSrv) {
    try { sockSrv.closeAllConnections && sockSrv.closeAllConnections() } catch { }
    await new Promise((r) => sockSrv.close(r))
  }
  await new Promise((r) => slack.close(r))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
