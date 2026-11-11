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
const relay = await listen(async (req, res) => {
  const b = JSON.parse((await body(req)) || '{}')
  relayCalls.push({ route: req.url, body: b })
  const r = relayReply[req.url] || (req.url === '/slack/prepare' ? { ok: true, id: 'ABCdef_123-xyz', eventsUrl: EVENTS } : req.url === '/slack/connect' ? { ok: true, team: 'T', channel: 'general', eventsUrl: EVENTS } : { ok: true })
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

async function run(argv, { env = {}, answers = [], interactive = false, fetchImpl } = {}) {
  relayCalls = []
  const out = [], err = [], asked = []
  const ask = async (prompt, o = {}) => { asked.push({ prompt, hidden: !!o.hidden }); return answers.shift() ?? '' }
  const code = await main(argv, { log: (m) => out.push(String(m)), logErr: (m) => err.push(String(m)), env: { HIVE_SLACK_API: API, HOME: home, ...env }, fetchImpl: fetchImpl || fetch, connect: { ask, interactive, home } })
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
} catch (e) {
  T(`no exception (${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e})`, false)
} finally {
  relay.close(); slack.close(); fs.rmSync(home, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
