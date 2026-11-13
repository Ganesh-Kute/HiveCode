// One-click Slack, the two halves together: the real CLI (hive-slack.js main: connect / status / disconnect /
// app-manifest) against the real relay (makeSlackRelay behind an HTTP server), with only Slack faked.
//   E1 the printed install link redirects to Slack's authorize page with the state
//   E2 the callback page says Slack is connected
//   E3 slack connect, polling /slack/status, ends 0 and says Slack is connected to this room
//   E4 the CLI output never carries the room id, the token or the secrets
//   E5 slack status says connected
//   E6 slack disconnect with no secret set (the id is remembered) ends the one-link connection
//   E7 afterwards status no longer says connected
//   E8 app-manifest prints this relay's callback and events urls
//   E9 its scopes and events are exactly the relay's SHARED_BOT_SCOPES and SHARED_BOT_EVENTS (two lists, so they must not drift)
import http from 'http'; import fs from 'fs'; import os from 'os'; import path from 'path'; import { createRequire } from 'module'
import { makeSlackRelay, SHARED_BOT_SCOPES, SHARED_BOT_EVENTS } from '../hive-slack-relay.js'
import { main } from '../hive-slack.js'
const require = createRequire(import.meta.url); const Y = require('yjs')
let pass = 0, fail = 0
const T = (n, c, x = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : '   ' + String(x).slice(0, 300)}`); c ? pass++ : fail++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const docs = new Map(); const getDoc = (r) => { let d = docs.get(r); if (!d) { d = new Y.Doc(); d.awareness = { getStates: () => new Map() }; docs.set(r, d) } return d }
const TOKEN = 'xoxb-9999-zzzz-zzzzzzzzzzzzzzzzzzzzzzzz'
const slackFetch = async (url, opts) => {
  const m = String(url).split('/').pop(); const p = Object.fromEntries(new URLSearchParams(opts.body || ''))
  const r = (j) => ({ status: 200, json: async () => j })
  if (m === 'oauth.v2.access') return r(p.code === 'good' ? { ok: true, access_token: TOKEN, bot_user_id: 'UBOT', team: { id: 'T1', name: 'Alpha' }, incoming_webhook: { channel_id: 'C0PUB', channel: 'general', url: 'https://hooks.slack.com/x' } } : { ok: false, error: 'invalid_code' })
  if (m === 'conversations.info') return r({ ok: true, channel: { name: 'general', is_member: true } })
  if (m === 'chat.postMessage') return r({ ok: true, ts: '1' })
  return r({ ok: false, error: 'unknown_method' })
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-relay-')); const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-home-'))
let relay; const srv = http.createServer((q, s) => relay.handle(q, s)); await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`
relay = makeSlackRelay({ getDoc, docs, dir, key: 'k-test-1234', fetchImpl: slackFetch, api: 'https://fake/api', publicUrl: base, clientId: 'cid', clientSecret: 'csec', appSecret: 'asec', authorizeUrl: 'https://fake/authorize', tickMs: 50 })
const LINK = `ws://127.0.0.1:${srv.address().port}|room-CliRelayRoom1`
const run = async (argv, env = {}, extra = {}, tap = null) => { const out = [], err = []; const code = await main(argv, { log: (m) => { out.push(String(m)); if (tap) tap.push(String(m)) }, logErr: (m) => err.push(String(m)), env: { HOME: home, ...env }, fetchImpl: fetch, connect: { interactive: false, home, pollMs: 50, waitMs: 5000, ...extra } }); return { code, out: out.join('\n'), err: err.join('\n') } }
try {
  const printed = []
  const pending = run(['connect', LINK], {}, {}, printed)
  // the person opens the link and approves: the URL is the one the CLI PRINTED (its own line), not one rebuilt from disk
  let url = ''; for (let i = 0; i < 100 && !url; i++) { await sleep(50); const l = printed.join('\n').split('\n').map((x) => x.trim()).find((x) => /^https?:\/\/\S+\/slack\/install\/[A-Za-z0-9_-]+$/.test(x)); if (l) url = l }
  T('E0 the CLI printed an install link on a line of its own, on this relay', url.startsWith(`${base}/slack/install/`), printed.join(' | '))
  const m = await fetch(url, { redirect: 'manual' }); const loc = new URL(m.headers.get('location') || 'http://x/')
  T('E1 the printed install link redirects to Slack\'s authorize page with the state', m.status === 302 && loc.searchParams.get('state') === url.split('/').pop(), `${m.status} ${m.headers.get('location')}`)
  const cb = await fetch(`${base}/slack/oauth/callback?code=good&state=${loc.searchParams.get('state')}`)
  const page = await cb.text()
  T('E2 the callback page says Slack is connected', cb.status === 200 && /connected to #general/i.test(page), page.slice(0, 200))
  const r = await pending
  T('E3 the CLI, polling /slack/status, ends 0 and says Slack is connected to this room (#general)', r.code === 0 && /Slack is connected to this room \(#general\)/.test(r.out), r.err + r.out.slice(-300))
  T('E4 the CLI printed the link, never the room id, token or secrets', /\/slack\/install\//.test(r.out) && ![TOKEN, 'csec', 'asec', 'room-CliRelayRoom1'].some((x) => (r.out + r.err).includes(x)), r.out)
  const st = await run(['status', LINK])
  T('E5 slack status says connected', st.code === 0 && /connected/i.test(st.out), st.err + st.out)
  const rememberedId = (JSON.parse(fs.readFileSync(path.join(home, '.hivecode', 'slack-connect.json'), 'utf8'))['room-CliRelayRoom1'] || {}).id
  const dis = await run(['disconnect', LINK])
  T('E6 slack disconnect with no secret set (id remembered) ends the one-link connection', dis.code === 0 && /disconnected/i.test(dis.out), dis.err + dis.out)
  // disconnect forgets the id on this computer, so ask the relay by that id: a /slack/disconnect that answered 200
  // without ending the connection would still say connected here
  const st2 = await run(['status', LINK, '--id', rememberedId])
  T('E7 afterwards the relay itself (asked by the old id) no longer says connected', !!rememberedId && !/is connected|: connected/i.test(st2.out) && !/connected to #general/i.test(st2.out), st2.err + st2.out)
  const man = await run(['app-manifest', base])
  T('E8 app-manifest prints the shared app manifest with this relay\'s callback and events urls', man.code === 0 && man.out.includes(`${base}/slack/oauth/callback`) && man.out.includes(`${base}/slack/events`), man.err + man.out.slice(0, 200))
  let mj = null; try { mj = JSON.parse(man.out.slice(man.out.indexOf('{'), man.out.lastIndexOf('}') + 1)) } catch { }
  const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().join() === [...b].sort().join()
  T('E9 the manifest\'s bot scopes and bot events are exactly the relay\'s lists', !!mj && sameSet(mj.oauth_config && mj.oauth_config.scopes && mj.oauth_config.scopes.bot, SHARED_BOT_SCOPES) && sameSet(mj.settings && mj.settings.event_subscriptions && mj.settings.event_subscriptions.bot_events, SHARED_BOT_EVENTS), JSON.stringify([mj && mj.oauth_config, mj && mj.settings && mj.settings.event_subscriptions]))
} catch (e) { T('no exception ' + (e.stack || e), false) }
finally { relay.stop(); srv.close(); for (const d of [dir, home]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } } console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0) }
