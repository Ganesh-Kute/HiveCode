// tests/slack-connect-test.mjs -- `slack connect` / `slack disconnect` (issue #22, part B), against a fake relay
// and a fake Slack on local ports. What is worth pinning: the manifest carries the URL the relay gave (and
// never the room id); the secrets reach the relay and nothing else; every refusal has a code and a next step.
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { main } = await import(pathToFileURL(path.join(HERE, '..', 'hive-slack.js')).href)

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c || !extra ? '' : `   ${extra}`}`); c ? pass++ : fail++ }

const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)) })
const body = (req) => new Promise((res) => { let b = ''; req.on('data', (d) => { b += d }); req.on('end', () => res(b)) })

const ROOM = 'room-SECRETROOMID123', TOKEN = 'xoxb-test-token-111', SIGN = 'signing-secret-222'
const EVENTS = 'https://relay.test/slack/events/ABCdef_123-xyz'
let relayCalls = [], relayReply = {}, slackChannels = [], slackError = ''
const INSTALL = 'https://relay.test/slack/install/ABCdef_123-xyz'
let withInstall = false, statusSeq = []   // one-click: /slack/prepare also answers installUrl; /slack/status answers these in turn
const relay = await listen(async (req, res) => {
  const b = JSON.parse((await body(req)) || '{}')
  relayCalls.push({ route: req.url, body: b })
  const reply = typeof relayReply[req.url] === 'function' ? relayReply[req.url](b) : relayReply[req.url]
  const r = reply || (req.url === '/slack/prepare' ? { ok: true, id: 'ABCdef_123-xyz', eventsUrl: EVENTS, ...(withInstall ? { installUrl: INSTALL } : {}) } : req.url === '/slack/status' ? { ok: true, ...(statusSeq.length > 1 ? statusSeq.shift() : statusSeq[0] || { connected: false }) } : req.url === '/slack/connect' ? { ok: true, team: 'T', channel: 'general', eventsUrl: EVENTS } : { ok: true })
  res.writeHead(r.status || 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json || r))
})
const slack = await listen(async (req, res) => {
  await body(req)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(slackError ? { ok: false, error: slackError } : { ok: true, channels: slackChannels }))
})
const LINK = `ws://127.0.0.1:${relay.address().port}|${ROOM}`
const API = `http://127.0.0.1:${slack.address().port}`
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-connect-'))

async function run(argv, { env = {}, answers = [], interactive = false, fetchImpl, wait } = {}) {
  relayCalls = []
  const out = [], err = [], asked = []
  const ask = async (prompt, o = {}) => { asked.push({ prompt, hidden: !!o.hidden }); return answers.shift() ?? '' }
  const code = await main(argv, { log: (m) => out.push(String(m)), logErr: (m) => err.push(String(m)), env: { HIVE_SLACK_API: API, HOME: home, ...env }, fetchImpl: fetchImpl || fetch, connect: { ask, interactive, home, ...(wait || { pollMs: 10, waitMs: 2000 }) } })
  return { code, out: out.join('\n'), err: err.join('\n'), asked }
}
const ENV = { SLACK_BOT_TOKEN: TOKEN, SLACK_SIGNING_SECRET: SIGN }

try {
  slackChannels = [{ id: 'C1', name: 'general' }, { id: 'G2', name: 'secret', is_private: true }]

  let r = await run(['connect', LINK, '--channel', 'C1'], { env: ENV })
  const conn = relayCalls.find((c) => c.route === '/slack/connect')
  T('S1 connect succeeds and says so', r.code === 0 && /Slack is connected to this room \(#general\)/.test(r.out), r.err + r.out.slice(-200))
  T('S2 the relay is asked for a URL with the room only', relayCalls[0].route === '/slack/prepare' && JSON.stringify(relayCalls[0].body) === JSON.stringify({ room: ROOM }))
  const manifest = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))
  T('S3 the manifest uses the URL the relay gave, no Socket Mode', manifest.settings.event_subscriptions.request_url === EVENTS && manifest.settings.socket_mode_enabled === false)
  T('S4 the manifest subscribes to channel and group messages and asks for the history scopes', ['message.channels', 'message.groups'].every((e) => manifest.settings.event_subscriptions.bot_events.includes(e)) && ['chat:write', 'channels:history', 'groups:history'].every((s) => manifest.oauth_config.scopes.bot.includes(s)))
  T('S5 connect sends id, token, signing secret and channel', conn && conn.body.id === 'ABCdef_123-xyz' && conn.body.botToken === TOKEN && conn.body.signingSecret === SIGN && conn.body.channel === 'C1', JSON.stringify(conn && Object.keys(conn.body)))
  T('S6 neither secret nor the room id is printed', ![TOKEN, SIGN, ROOM].some((x) => (r.out + r.err).includes(x)))
  const st = JSON.parse(fs.readFileSync(path.join(home, '.hivecode', 'slack-connect.json'), 'utf8'))
  T('S7 only the connection id is remembered, in a private file', st[ROOM].id === 'ABCdef_123-xyz' && !JSON.stringify(st).includes(TOKEN) && !JSON.stringify(st).includes(SIGN) && (process.platform === 'win32' || (fs.statSync(path.join(home, '.hivecode', 'slack-connect.json')).mode & 0o077) === 0))

  r = await run(['connect', LINK], { env: ENV, interactive: true, answers: ['2'] })
  T('S8 with no --channel the channels are listed and the number picked is used', r.code === 0 && /1\. #general/.test(r.out) && /2\. 🔒secret/.test(r.out) && relayCalls.find((c) => c.route === '/slack/connect').body.channel === 'G2', r.err)

  r = await run(['connect', LINK], { interactive: true, answers: [TOKEN, SIGN, '1'] })
  T('S9 token and signing secret are asked for hidden when not in the environment', r.code === 0 && r.asked.slice(0, 2).every((a) => a.hidden) && !r.asked[2].hidden, JSON.stringify(r.asked))

  r = await run(['connect', LINK], { env: ENV })
  T('S10 several channels and no terminal: Q668, the list, and nothing sent to the relay', r.code === 1 && /Q668/.test(r.err) && /C1/.test(r.err) && /G2/.test(r.err) && !relayCalls.some((c) => c.route === '/slack/connect'))

  slackChannels = [{ id: 'C1', name: 'general' }]
  r = await run(['connect', LINK], { env: ENV })
  T('S11 one channel and no terminal: it is used', r.code === 0 && relayCalls.find((c) => c.route === '/slack/connect').body.channel === 'C1')

  slackChannels = []
  r = await run(['connect', LINK], { env: ENV })
  T('S12 the bot is in no channel: Q668 says to /invite it', r.code === 1 && /Q668/.test(r.err) && /\/invite/.test(r.err))

  slackError = 'invalid_auth'
  r = await run(['connect', LINK], { env: ENV })
  T('S13 Slack refuses the token: Q662, nothing sent to the relay', r.code === 1 && /Q662/.test(r.err) && !relayCalls.some((c) => c.route === '/slack/connect') && !r.err.includes(TOKEN))
  slackError = ''

  r = await run(['connect', LINK], { env: { SLACK_SIGNING_SECRET: SIGN } })
  T('S14 no token and no terminal: Q667 names it', r.code === 1 && /Q667.*SLACK_BOT_TOKEN/.test(r.err))
  r = await run(['connect', LINK], { env: { SLACK_BOT_TOKEN: TOKEN } })
  T('S15 no signing secret and no terminal: Q667 names it', r.code === 1 && /Q667.*SLACK_SIGNING_SECRET/.test(r.err))

  relayReply['/slack/connect'] = { ok: false, code: 'Q664', why: 'the bot is not in that channel' }
  r = await run(['connect', LINK, '--channel', 'C1'], { env: ENV })
  T('S16 a refusal from the relay is shown with its own code and reason', r.code === 1 && /Q664 the bot is not in that channel/.test(r.err))
  relayReply['/slack/connect'] = { status: 503, json: { ok: false, code: 'Q660', why: 'HIVE_SLACK_KEY is not set on this relay' } }
  r = await run(['connect', LINK, '--channel', 'C1'], { env: ENV })
  T('S17 a relay that cannot keep tokens (503, Q660) says why', r.code === 1 && /Q660 HIVE_SLACK_KEY/.test(r.err))
  delete relayReply['/slack/connect']

  r = await run(['connect', `ws://127.0.0.1:1|${ROOM}`, '--channel', 'C1'], { env: ENV })
  T('S18 a relay that cannot be reached: Q666', r.code === 1 && /Q666/.test(r.err))
  r = await run(['connect', 'not-a-link'], { env: ENV })
  T('S19 a link without a relay: Q665', r.code === 2 && /Q665/.test(r.err))
  r = await run(['connect'])
  T('S20 no link: usage', r.code === 2 && /slack connect/.test(r.err))

  // disconnect: the id remembered at connect, the signing secret from the person
  r = await run(['connect', LINK, '--channel', 'C1'], { env: ENV })
  r = await run(['disconnect', LINK], { env: { SLACK_SIGNING_SECRET: SIGN } })
  const dis = relayCalls.find((c) => c.route === '/slack/disconnect')
  T('S21 disconnect sends the remembered id and the signing secret', r.code === 0 && dis && dis.body.id === 'ABCdef_123-xyz' && dis.body.signingSecret === SIGN && /disconnected/.test(r.out), r.err)
  T('S22 and forgets the id', !JSON.parse(fs.readFileSync(path.join(home, '.hivecode', 'slack-connect.json'), 'utf8'))[ROOM])
  r = await run(['disconnect', LINK], { env: { SLACK_SIGNING_SECRET: SIGN } })
  T('S23 nothing remembered (another computer): the relay is asked by room, with the signing secret', r.code === 0 && relayCalls[0].body.room === ROOM && relayCalls[0].body.signingSecret === SIGN && relayCalls[0].body.id === undefined, r.err)
  r = await run(['disconnect', LINK, '--id', 'OTHERid'], { env: { SLACK_SIGNING_SECRET: SIGN } })
  T('S24 --id works without a remembered id', r.code === 0 && relayCalls[0].body.id === 'OTHERid')
  r = await run(['disconnect', LINK, '--id', 'x'])
  T('S25 no signing secret: Q667, nothing sent', r.code === 1 && /Q667/.test(r.err) && !relayCalls.length)
  relayReply['/slack/disconnect'] = { status: 401, json: { ok: false, code: 'Q663', why: 'bad signature' } }
  r = await run(['disconnect', LINK, '--id', 'x'], { env: { SLACK_SIGNING_SECRET: 'wrong' } })
  T('S26 the wrong signing secret is refused with the relay\'s code', r.code === 1 && /Q663/.test(r.err))
  delete relayReply['/slack/disconnect']

  // one-click (issue: connect a room to Slack with one link). The relay offers it by answering installUrl.
  withInstall = true
  statusSeq = [{ connected: false }, { connected: false }, { connected: true, channel: 'general' }]
  r = await run(['connect', LINK])
  const calls1 = relayCalls.map((c) => c.route)
  T('S27 one-click: the install link is printed, on a line of its own', r.code === 0 && r.out.split('\n').some((l) => l.trim() === INSTALL), r.err + r.out.slice(-300))
  T('S28 one-click: no manifest, no token or secret asked for, nothing sent to /slack/connect', !r.out.includes('"event_subscriptions"') && !r.asked.length && !calls1.includes('/slack/connect'), JSON.stringify(calls1))
  T('S29 one-click: it waits on /slack/status with the id only, then says Slack is connected', calls1.filter((x) => x === '/slack/status').length === 3 && relayCalls.filter((c) => c.route === '/slack/status').every((c) => JSON.stringify(c.body) === JSON.stringify({ id: 'ABCdef_123-xyz' })) && /Slack is connected to this room \(#general\)/.test(r.out), r.out.slice(-200))
  T('S30 one-click: neither the room id nor anything secret is printed', ![ROOM, TOKEN, SIGN].some((x) => (r.out + r.err).includes(x)))
  T('S31 one-click: the id is remembered like the manifest route does', (() => { try { return JSON.parse(fs.readFileSync(path.join(home, '.hivecode', 'slack-connect.json'), 'utf8'))[ROOM].id === 'ABCdef_123-xyz' } catch { return false } })())

  statusSeq = [{ connected: false }]
  r = await run(['connect', LINK], { wait: { pollMs: 10, waitMs: 120 } })
  T('S32 one-click: the link is not approved in time: Q673 says to open it and run again, exit 1 (Q669 is "one-click not enabled" on the relay)', r.code === 1 && /Q673/.test(r.err) && r.err.includes(INSTALL), r.err)

  statusSeq = [{ connected: false, pending: 'invite', channel: 'secret' }, { connected: true, channel: 'secret' }]
  r = await run(['connect', LINK])
  T('S32b private channel waiting for the invite: it says to type /invite @Hivecode there and keeps waiting until connected', r.code === 0 && /\/invite @Hivecode/.test(r.out) && /Slack is connected to this room \(#secret\)/.test(r.out), r.err + r.out.slice(-300))

  withInstall = true
  statusSeq = [{ connected: true, channel: 'general' }]
  slackChannels = [{ id: 'C1', name: 'general' }]
  r = await run(['connect', LINK, '--manifest'], { env: ENV, interactive: false })
  T('S33 --manifest forces the manifest route even when the relay offers one-click', r.code === 0 && relayCalls.some((c) => c.route === '/slack/connect') && !relayCalls.some((c) => c.route === '/slack/status') && r.out.includes('"event_subscriptions"') && !r.out.includes(INSTALL), r.err + r.out.slice(-200))

  // --no-wait + slack status (agent flow)
  statusSeq = [{ connected: false, pending: 'invite', channel: 'ops' }]
  r = await run(['connect', LINK, '--no-wait'])
  T('S38 --no-wait prints the link, remembers id, does not poll /slack/status, exits 0', r.code === 0 && r.out.includes(INSTALL) && !relayCalls.some((c) => c.route === '/slack/status'), r.err)
  r = await run(['status', LINK])
  T('S39 slack status when pending invite prints /invite @Hivecode and exits 1', r.code === 1 && /\/invite @Hivecode/.test(r.out) && relayCalls.some((c) => c.route === '/slack/status' && c.body.id === 'ABCdef_123-xyz'), r.err + r.out)
  statusSeq = [{ connected: true, channel: 'ops' }]
  r = await run(['status', LINK])
  T('S40 slack status uses remembered id and exits 0 when connected', r.code === 0 && /Slack is connected to this room \(#ops\)/.test(r.out), r.err + r.out)
  r = await run(['status', LINK, '--id', 'EXPLICIT123'])
  T('S40b slack status --id uses explicit connection id', r.code === 0 && relayCalls.some((c) => c.route === '/slack/status' && c.body.id === 'EXPLICIT123'))
  r = await run(['status', `ws://127.0.0.1:${relay.address().port}|room-UNSEEN999`])
  T('S40c slack status without remembered id refuses with Q661', r.code === 1 && /Q661/.test(r.err), r.err)
  statusSeq = [{ connected: false, ended: 'bot removed' }]
  r = await run(['connect', LINK])
  T('S44 connect stops immediately with Q673 if status reports ended', r.code === 1 && /Q673/.test(r.err) && /bot removed/.test(r.err), r.err)
  r = await run(['status', LINK])
  T('S44b slack status prints ended reason cleanly and exits 1', r.code === 1 && /bot removed/.test(r.out), r.err + r.out)
  r = await run(['disconnect', LINK])
  T('S45 disconnect with remembered id and no secret sends {id} alone for one-click connections', r.code === 0 && relayCalls.some((c) => c.route === '/slack/disconnect' && c.body.id === 'ABCdef_123-xyz' && c.body.signingSecret === undefined) && !JSON.parse(fs.readFileSync(path.join(home, '.hivecode', 'slack-connect.json'), 'utf8'))[ROOM], r.err)
  await run(['connect', LINK, '--no-wait'])
  relayReply['/slack/disconnect'] = (b) => b.signingSecret ? { ok: true } : { status: 401, json: { ok: false, code: 'Q663', why: 'signingSecret required for manual disconnect' } }
  const dNonTty = await run(['disconnect', LINK])
  const dTty = await run(['disconnect', LINK], { interactive: true, answers: [SIGN] })
  delete relayReply['/slack/disconnect']
  T('S45b disconnect falls back on Q663: refuses non-interactively with Q663, prompts hidden secret interactively', dNonTty.code === 1 && /Q663/.test(dNonTty.err) && dTty.code === 0 && dTty.asked.length === 1 && dTty.asked[0].hidden && relayCalls.some((c) => c.route === '/slack/disconnect' && c.body.id === 'ABCdef_123-xyz' && c.body.signingSecret === SIGN), `${dNonTty.err} | ${dTty.err}`)
  withInstall = false

  // app-manifest for relay owners
  r = await run(['app-manifest', 'https://relay.example.com/some/path'])
  const shared = r.code === 0 ? JSON.parse(r.out) : null
  const wantScopes = ['chat:write', 'channels:history', 'groups:history', 'users:read', 'channels:read', 'groups:read', 'channels:join', 'incoming-webhook']
  const wantEvents = ['message.channels', 'message.groups', 'member_joined_channel', 'member_left_channel', 'channel_left', 'group_left', 'app_uninstalled', 'tokens_revoked']
  T('S41 app-manifest prints the shared OAuth manifest with callback, events URL, scopes and events', Boolean(
    shared && shared.oauth_config && Array.isArray(shared.oauth_config.redirect_urls) && shared.oauth_config.redirect_urls[0] === 'https://relay.example.com/slack/oauth/callback'
    && wantScopes.every((s) => shared.oauth_config.scopes.bot.includes(s))
    && shared.settings && shared.settings.event_subscriptions && shared.settings.event_subscriptions.request_url === 'https://relay.example.com/slack/events'
    && wantEvents.every((e) => shared.settings.event_subscriptions.bot_events.includes(e))
    && shared.settings.socket_mode_enabled === false && shared.settings.org_deploy_enabled === false && shared.settings.token_rotation_enabled === false
  ), r.err + r.out.slice(0, 200))
  r = await run(['app-manifest', `wss://relay.example.com|${ROOM}`])
  const fromWss = r.code === 0 ? JSON.parse(r.out) : null
  T('S42 app-manifest accepts wss:// relay URLs and never echoes room ids', Boolean(fromWss && fromWss.oauth_config.redirect_urls[0] === 'https://relay.example.com/slack/oauth/callback' && !r.out.includes(ROOM)), r.err)
  r = await run(['app-manifest', 'http://insecure.example.com'])
  const badUrl = await run(['app-manifest', 'not-a-url'])
  T('S43 app-manifest refuses non-https public URLs and bad URLs with Q665', r.code === 2 && /Q665/.test(r.err) && badUrl.code === 2 && /Q665/.test(badUrl.err), `${r.err} | ${badUrl.err}`)

  r = await run(['connect', LINK, '--channel', 'C1'], { env: ENV })
  T('S34 a relay without one-click keeps the manifest route as before', r.code === 0 && !relayCalls.some((c) => c.route === '/slack/status') && r.out.includes('"event_subscriptions"'))

  // Behind an HTTPS proxy Node 22 needs NODE_USE_ENV_PROXY=1 or fetch fails: Q666 must say so.
  const broken = async () => { throw new TypeError('fetch failed') }
  r = await run(['connect', LINK, '--channel', 'C1'], { env: { ...ENV, HTTPS_PROXY: 'http://proxy.test:3128' }, fetchImpl: broken })
  T('S35 Q666 behind an HTTPS proxy names the fix: NODE_USE_ENV_PROXY=1 and Node 22.21+', r.code === 1 && /Q666/.test(r.err) && /NODE_USE_ENV_PROXY=1/.test(r.err) && /22\.21/.test(r.err), r.err)
  r = await run(['connect', LINK, '--channel', 'C1'], { env: { ...ENV, HTTPS_PROXY: 'http://proxy.test:3128', NODE_USE_ENV_PROXY: '1' }, fetchImpl: broken })
  T('S36 with NODE_USE_ENV_PROXY already set the hint is not repeated', r.code === 1 && /Q666/.test(r.err) && !/NODE_USE_ENV_PROXY=1/.test(r.err), r.err)
  r = await run(['connect', LINK, '--channel', 'C1'], { env: ENV, fetchImpl: broken })
  T('S37 no proxy configured: no proxy hint', r.code === 1 && /Q666/.test(r.err) && !/NODE_USE_ENV_PROXY/.test(r.err))
} catch (e) {
  T(`no exception (${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e})`, false)
} finally {
  relay.close(); slack.close(); fs.rmSync(home, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
