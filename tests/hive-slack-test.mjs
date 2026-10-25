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
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import * as HS from '../hive-slack.js'

const { makeBridge, makeQueue, render, TO_CHANNEL, scrubSlack, makeSlackThreader, preflightSlack, checkDuplicateBridge } = HS

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1281, SLACK_PORT = 1282
const ROOM = 'slack-test-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- the fake Slack ------------------------------------------------------------------------
const calls = []
let tsSeq = 1000
let nextResponses = [] // optional queued responses: { status, headers, body }
const slack = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const method = req.url.split('/').pop().split('?')[0]
    let j = {}
    try { j = JSON.parse(body || '{}') } catch { j = {} }
    calls.push({ method, auth: req.headers.authorization, at: Date.now(), ...j })
    if (nextResponses.length) {
      const custom = nextResponses.shift()
      res.writeHead(custom.status || 200, { 'Content-Type': 'application/json', ...(custom.headers || {}) })
      res.end(JSON.stringify(custom.body))
      return
    }
    if (method === 'auth.test') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, user: 'hivecode', user_id: 'U_BOT', team: 'TestTeam' }))
      return
    }
    if (method === 'conversations.info') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, channel: { id: j.channel || 'C-TEST', name: 'dev-agents', is_member: true } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
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
  }
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

    nextResponses.push(
      { status: 200, body: { ok: true, user: 'hivecode', user_id: 'U1' } },
      { status: 200, body: { ok: true, channel: { id: 'C-TEST', name: 'general', is_member: false } } },
    )
    const pNotIn = await preflightSlack({ token: 'xoxb-ok', channel: 'C-TEST', api: process.env.HIVE_SLACK_API })
    T('Q631: bot not in channel is caught with /invite instruction', !pNotIn.ok && /Q631/.test(pNotIn.error) && /\/invite/.test(pNotIn.error))

    nextResponses.push(
      { status: 200, body: { ok: true, user: 'hivecode', user_id: 'U1' } },
      { status: 200, body: { ok: true, channel: { id: 'C-TEST', name: 'general', is_member: true } } },
    )
    const pOk = await preflightSlack({ token: 'xoxb-ok', channel: 'C-TEST', api: process.env.HIVE_SLACK_API })
    T('preflight succeeds when auth and channel membership pass', pOk.ok && pOk.botUser === 'hivecode')

    const dup = checkDuplicateBridge({ sameNameElsewhere: () => [{ name: 'SlackBridge', kind: 'ai' }] }, 'SlackBridge')
    T('Q632: second SlackBridge in same room is refused', !dup.ok && /Q632/.test(dup.error))

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
  }
}

// ---- end to end ----------------------------------------------------------------------------
console.log('\n# end to end: room -> fake Slack -> room')
let relaySrv = null
const clients = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slack-t-'))
try {
  calls.length = 0
  const { WebSocketServer } = await import('ws')
  const { setupWSConnection } = await import('../vendor/y-websocket/utils.cjs')
  relaySrv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
  const wss = new WebSocketServer({ server: relaySrv })
  wss.on('connection', (ws, req) => {
    const docName = (req.url || '/').slice(1).split('?')[0]
    setupWSConnection(ws, req, { docName })
  })
  await new Promise((r) => relaySrv.listen(PORT, '127.0.0.1', r))

  const mk = (name) => startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: fs.mkdtempSync(path.join(tmp, name)),
    name, kind: 'ai', syncFiles: false, log: () => {},
  })
  const bridgeHive = mk('SlackBridge'); clients.push(bridgeHive)
  const agent = mk('AgentA'); clients.push(agent)
  await sleep(1500)

  const bridgeErrors = []
  const bridge = makeBridge({
    hive: bridgeHive, channel: 'C-TEST', token: 'xoxb-test', botName: 'SlackBridge',
    onError: (e) => bridgeErrors.push(e),
    post: (m) => slackPost('chat.postMessage', m, 'xoxb-test'),
  })
  const chat = bridgeHive.doc.getArray('chat')
  let at = chat.length
  chat.observe(() => { const all = chat.toArray(); bridge.onChat(all.slice(at), at); at = all.length })

  // 1. a task opens -> the CHANNEL, and a thread is born
  const open = await bridge.emit({ kind: 'task-open', task: 'T-1', to: 'AgentA' })
  T('task-open reached Slack', calls.length === 1 && calls[0].channel === 'C-TEST')
  T('it went to the channel, not a thread', !calls[0].thread_ts)
  T('the bot token was sent', calls[0].auth === 'Bearer xoxb-test')
  const ts = open.ts
  T('the thread id is stored in ROOM state', bridge.threads.get('T-1') === ts, `ts=${ts}`)

  // 2. everything else about that task lands INSIDE the thread
  await bridge.emit({ kind: 'gate-fail', task: 'T-1', by: 'AgentA', file: 'alpha.js' })
  T('the gate failure went into the task thread', calls[1].thread_ts === ts, `thread_ts=${calls[1].thread_ts}`)

  // 3. untasked room chat: first message opens the room thread, follow-ups stay INSIDE it (no channel flood)
  const chatSecret = ['ghp', 'kL9mN8pQ7rS6tU5vW4xY3zA2bC1dE0fG9hJ8'].join('_')
  agent.doc.getArray('chat').push([
    { by: 'AgentA', kind: 'say', at: Date.now() * 1000, text: 'claiming alpha.js' },
    { by: 'AgentA', kind: 'say', at: Date.now() * 1000 + 1, text: 'editing alpha.js' },
    { by: 'AgentA', kind: 'say', at: Date.now() * 1000 + 2, text: 'secret ' + chatSecret + ' in ws://127.0.0.1:1281|' + ROOM },
  ])
  await sleep(3800)
  const chatCalls = calls.filter((c) => /^\*AgentA\*:/.test(c.text || ''))
  T('a room message crossed to Slack', chatCalls.some((c) => c.text === '*AgentA*: claiming alpha.js'), `${calls.length} call(s)`)
  const roomTs = bridge.threads.get('__room__')
  T('follow-up untasked chat stays inside one room thread instead of flooding the channel',
    Boolean(roomTs) && chatCalls.length === 3 && !chatCalls[0].thread_ts && chatCalls[1].thread_ts === roomTs && chatCalls[2].thread_ts === roomTs,
    `roomTs=${roomTs}, threads=${chatCalls.map((c) => c.thread_ts || 'root').join(',')}`)
  T('outbound room chat scrubs secrets and room links before reaching Slack',
    chatCalls.length === 3 && !chatCalls[2].text.includes(chatSecret) && !chatCalls[2].text.includes(ROOM))

  // 4. a human replies in the thread -> back into the room
  const before = calls.length
  bridge.deliver({ thread_ts: ts, text: '@AgentA use the other helper', user: 'ganesh' })
  await sleep(1500)
  const roomChat = agent.doc.getArray('chat').toArray()
  T('the Slack reply arrived in the room', roomChat.some((m) => m.text === '@AgentA use the other helper' && m.viaSlack))
  T('it was attributed to the task it replied to', roomChat.some((m) => m.viaSlack && m.task === 'T-1'))

  // 5. THE ECHO GUARD: that reply must not be sent straight back out to Slack
  await sleep(1200)
  T('the reply did NOT echo back to Slack', calls.length === before,
    `${calls.length - before} extra call(s)`)
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  if (relaySrv) await new Promise((r) => relaySrv.close(r))
  await new Promise((r) => slack.close(r))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
