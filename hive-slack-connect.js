// hive-slack-connect.js -- `slack connect` / `slack status` / `slack disconnect` / `slack app-manifest`:
// Slack <-> a room through the relay, with nothing running on anyone's machine.
// When the relay enables one-click OAuth, /slack/prepare returns installUrl: the user opens one link,
// picks a channel in Slack, and `slack connect` polls /slack/status until connected. Otherwise (or with
// --manifest) it prints the per-room app manifest and collects tokens once as before.
//
// Relay contract: POST /slack/prepare {room} -> {ok,id,eventsUrl,installUrl?}; POST /slack/status {id} ->
// {ok,connected,pending?,channel?}; POST /slack/connect {id,botToken,signingSecret,channel} ->
// {ok,team,channel,eventsUrl}; POST /slack/disconnect {id|room,signingSecret} -> {ok}.
// Errors come back as {ok:false,code,why}. Codes here: Q661 unknown id, Q665 bad link/URL, Q666 relay not reached,
// Q667 token or signing secret missing, Q668 channel to choose, Q673 one-click install did not finish in time.
// The secrets stay on the relay and nowhere else: not in logs, files, URLs, or room chat.
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { parseLink } from './sync.js'
import { slackPost } from './hive-slack.js'

export const CONNECT_USAGE = `usage:
  npx -y hivecode-mcp@latest slack connect "<relay|room>" [--channel <id>] [--manifest] [--no-wait]
  npx -y hivecode-mcp@latest slack status "<relay|room>" [--id <connection id>]
  npx -y hivecode-mcp@latest slack disconnect "<relay|room>" [--id <connection id>]   (SLACK_SIGNING_SECRET, or it asks)
  npx -y hivecode-mcp@latest slack app-manifest "<relay https url>"
`

const BOT_SCOPES = ['chat:write', 'channels:history', 'groups:history', 'users:read', 'channels:read', 'groups:read']
const SHARED_BOT_SCOPES = [...BOT_SCOPES, 'channels:join', 'incoming-webhook']
const SHARED_BOT_EVENTS = [
  'message.channels', 'message.groups', 'member_joined_channel',
  'member_left_channel', 'channel_left', 'group_left', 'app_uninstalled', 'tokens_revoked',
]

function buildManifest({ scopes, eventsUrl, botEvents, redirectUrls } = {}) {
  const oauth = { scopes: { bot: scopes } }
  if (redirectUrls && redirectUrls.length) oauth.redirect_urls = redirectUrls
  return {
    display_information: { name: 'Hivecode', description: 'Messages between a Slack channel and a Hivecode room.', background_color: '#111318' },
    features: { bot_user: { display_name: 'Hivecode', always_online: true } },
    oauth_config: oauth,
    settings: {
      event_subscriptions: { request_url: eventsUrl, bot_events: botEvents },
      org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false,
    },
  }
}

/** Per-connection Slack manifest for a self-managed app: events to the relay, no Socket Mode. */
export function slackManifest(eventsUrl) {
  return buildManifest({ scopes: BOT_SCOPES, eventsUrl, botEvents: ['message.channels', 'message.groups'] })
}

/** Shared OAuth Slack app manifest for relay owners enabling one-click setup. */
export function sharedSlackManifest(origin) {
  const clean = String(origin || '').replace(/\/+$/, '')
  return buildManifest({
    scopes: SHARED_BOT_SCOPES,
    redirectUrls: [`${clean}/slack/oauth/callback`],
    eventsUrl: `${clean}/slack/events`,
    botEvents: SHARED_BOT_EVENTS,
  })
}

export function relayOrigin(targetUrl) {
  let raw = String(targetUrl || '').trim()
  if (!raw) return ''
  if (raw.includes('|')) raw = parseLink(raw).relay || raw.split('|')[0]
  raw = raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
  if (!/^[a-z]+:\/\//i.test(raw)) return ''
  let u
  try { u = new URL(raw) } catch { return '' }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))) return ''
  return `${u.protocol}//${u.host}`
}

/** One line from the person. Hidden (no echo) for secrets. Only used on a terminal. */
export function askLine(prompt, { hidden = false, input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true })
    if (hidden) rl._writeToOutput = (s) => { if (s === prompt || /[\r\n]/.test(s)) output.write(s) }
    rl.question(prompt, (a) => { rl.close(); resolve(String(a).trim()) })
  })
}

const stateFile = (home) => path.join(home, '.hivecode', 'slack-connect.json')
function readState(home) { try { return JSON.parse(fs.readFileSync(stateFile(home), 'utf8')) || {} } catch { return {} } }
function writeState(home, s) {
  fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true })
  fs.writeFileSync(stateFile(home), JSON.stringify(s, null, 2), { mode: 0o600 })
}

function rememberConnection(home, room, id, base) {
  const s = readState(home)
  s[room] = { id, relay: base }
  try { writeState(home, s) } catch { /* connecting worked; status/disconnect may need --id */ }
}

async function callRelay(base, route, body, fetchImpl, env = process.env) {
  try {
    const r = await fetchImpl(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) })
    const j = await r.json().catch(() => null)
    if (j && typeof j === 'object') return j.ok ? j : { ok: false, code: j.code || `http_${r.status}`, why: j.why || `the relay answered ${r.status}` }
    return { ok: false, code: `http_${r.status}`, why: `the relay answered ${r.status} without a reason` }
  } catch (e) {
    const proxy = String((env && (env.HTTPS_PROXY || env.https_proxy)) || '').trim()
    const useEnvProxy = String((env && env.NODE_USE_ENV_PROXY) || '').trim() === '1'
    const hint = proxy && !useEnvProxy ? ' Set NODE_USE_ENV_PROXY=1 (Node 22.21+) so fetch uses HTTPS_PROXY.' : ''
    return { ok: false, code: 'Q666', why: `could not reach ${base} (${e && e.message ? e.message : e})${hint}` }
  }
}

function target(link, logErr) {
  const { relay, room } = parseLink(link || '')
  if (!relay || !room) { logErr(`Q665 "${link || ''}" is not a room link (expected wss://relay|room-…).`); return null }
  return { base: String(relay).replace(/^ws/i, 'http').replace(/\/+$/, ''), room }
}

/** Channels the bot is in: id, name, privacy. Follows Slack's cursor, at most 5 pages. */
async function botChannels(token, fetchImpl, api) {
  const out = []
  let cursor = ''
  for (let i = 0; i < 5; i++) {
    const r = await slackPost('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor: cursor || undefined }, token, fetchImpl, api)
    for (const c of r.channels || []) out.push({ id: c.id, name: c.name || c.id, isPrivate: !!(c.is_private || c.is_group) })
    cursor = (r.response_metadata && r.response_metadata.next_cursor) || ''
    if (!cursor) break
  }
  return out
}

export async function runSlackConnect({ link, channel = '', manifest = false, noWait = false, pollMs = 2000, waitMs = 120000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, env = process.env, log = console.log, logErr = console.error, fetchImpl = fetch, ask = askLine, interactive = Boolean(process.stdin.isTTY), home = os.homedir(), api = env.HIVE_SLACK_API || 'https://slack.com/api' } = {}) {
  const t = target(link, logErr)
  if (!t) return 2

  const prep = await callRelay(t.base, '/slack/prepare', { room: t.room }, fetchImpl, env)
  if (!prep.ok || !prep.id || (!prep.installUrl && !prep.eventsUrl)) { logErr(`${prep.code || 'Q666'} the relay did not prepare a Slack connection: ${prep.why || 'no id came back'}`); return 1 }

  if (prep.installUrl && !manifest) {
    rememberConnection(home, t.room, prep.id, t.base)
    log('Open this link in your browser, pick a Slack channel, and click Allow:\n')
    log(prep.installUrl)
    log('')
    if (noWait) return 0

    const deadline = now() + Math.max(0, Number(waitMs) || 0)
    let toldInvite = false
    while (true) {
      const st = await callRelay(t.base, '/slack/status', { id: prep.id }, fetchImpl, env)
      if (!st.ok) { logErr(`${st.code} ${st.why}`); return 1 }
      if (st.connected) {
        const chLabel = st.channel ? ` (#${String(st.channel).replace(/^#/, '')})` : ''
        log(`✓ Slack is connected to this room${chLabel}. Post a line in the channel: it shows up in the room.\n  To disconnect: remove @Hivecode from the channel, uninstall the app in Slack, or run slack disconnect "<room link>".`)
        return 0
      }
      if (st.ended) {
        logErr(`Q673 Slack connection ended before finishing (${st.ended}). Run slack connect again.`)
        return 1
      }
      if (st.pending === 'invite' && !toldInvite) {
        toldInvite = true
        const chLabel = st.channel ? `#${String(st.channel).replace(/^#/, '')}` : 'that private channel'
        log(`Private channel selected: in Slack, open ${chLabel} and type:\n  /invite @Hivecode`)
      }
      if (now() >= deadline) {
        logErr(toldInvite
          ? `Q673 still waiting for /invite @Hivecode in the private channel. Invite the bot there (or open ${prep.installUrl}) and run slack connect again.`
          : `Q673 Slack approval did not finish in time. Open this link in your browser, pick a channel, click Allow, then run slack connect again:\n  ${prep.installUrl}`)
        return 1
      }
      await sleep(Math.max(1, Number(pollMs) || 2000))
    }
  }

  if (!prep.eventsUrl) { logErr('Q666 the relay did not return a Slack eventsUrl for manifest setup.'); return 1 }

  log('1. In Slack, open https://api.slack.com/apps -> Create New App -> From a manifest, and paste this:\n')
  log(JSON.stringify(slackManifest(prep.eventsUrl), null, 2))
  log('\n2. Install the app to your workspace. Copy the Bot User OAuth Token (xoxb-…) from "OAuth & Permissions"\n   and the Signing Secret from "Basic Information". Both stay between you and the relay.\n')

  const need = async (name, prompt) => {
    const v = String(env[name] || '').trim()
    if (v) return v
    return interactive ? ask(prompt, { hidden: true }) : ''
  }
  const botToken = await need('SLACK_BOT_TOKEN', 'Bot token (xoxb-…): ')
  const signingSecret = botToken ? await need('SLACK_SIGNING_SECRET', 'Signing secret: ') : ''
  if (!botToken || !signingSecret) { logErr(`Q667 ${!botToken ? 'SLACK_BOT_TOKEN' : 'SLACK_SIGNING_SECRET'} is missing. Set it in the environment (it is never taken as a flag) and run this again.`); return 1 }

  let chosen = String(channel || '').trim()
  if (!chosen) {
    let list
    try { list = await botChannels(botToken, fetchImpl, api) } catch (e) {
      const why = (e && (e.slackError || e.message)) || 'unknown'
      logErr(`Q662 Slack refused the bot token (${why}). Check it is the Bot User OAuth Token and the app is installed.`)
      return 1
    }
    if (!list.length) { logErr('Q668 the bot is in no channel. In Slack, open the channel you want and run: /invite @Hivecode'); return 1 }
    if (list.length === 1 && !interactive) chosen = list[0].id
    else if (!interactive) {
      logErr(`Q668 the bot is in ${list.length} channels; say which with --channel <id>:\n${list.map((c) => `  ${c.id}  ${c.isPrivate ? '🔒' : '#'}${c.name}`).join('\n')}`)
      return 1
    } else {
      log('Channels the bot is in:')
      list.forEach((c, i) => log(`  ${i + 1}. ${c.isPrivate ? '🔒' : '#'}${c.name}  (${c.id})`))
      const n = Number(await ask(`Pick one [1-${list.length}]: `)) || 1
      if (n < 1 || n > list.length) { logErr(`Q668 ${n} is not one of the ${list.length} channels.`); return 1 }
      chosen = list[n - 1].id
    }
  }

  const done = await callRelay(t.base, '/slack/connect', { id: prep.id, botToken, signingSecret, channel: chosen }, fetchImpl, env)
  if (!done.ok) { logErr(`${done.code} ${done.why}`); return 1 }
  rememberConnection(home, t.room, prep.id, t.base)
  log(`✓ Slack is connected to this room${done.channel ? ` (#${done.channel})` : ''}. Post a line in the channel: it shows up in the room.\n  To disconnect: npx -y hivecode-mcp@latest slack disconnect "<room link>"`)
  return 0
}

export async function runSlackStatus({ link, id = '', env = process.env, log = console.log, logErr = console.error, fetchImpl = fetch, home = os.homedir() } = {}) {
  const t = target(link, logErr)
  if (!t) return 2
  const state = readState(home)
  const connection = String(id || (state[t.room] && state[t.room].id) || '')
  if (!connection) { logErr('Q661 no remembered Slack connection id for this room; run slack connect or pass --id <id>.'); return 1 }
  const st = await callRelay(t.base, '/slack/status', { id: connection }, fetchImpl, env)
  if (!st.ok) { logErr(`${st.code} ${st.why}`); return 1 }
  if (st.connected) {
    log(`✓ Slack is connected to this room${st.channel ? ` (#${String(st.channel).replace(/^#/, '')})` : ''}.`)
    return 0
  }
  if (st.pending === 'invite') {
    log(`Waiting for /invite @Hivecode in ${st.channel ? `#${String(st.channel).replace(/^#/, '')}` : 'that private channel'}.`)
    return 1
  }
  if (st.ended) {
    log(`Slack is disconnected (${st.ended}).`)
    return 1
  }
  log('Slack approval has not finished yet. Open the install link, pick a channel, and click Allow.')
  return 1
}

export function runSlackAppManifest({ url, log = console.log, logErr = console.error } = {}) {
  const origin = relayOrigin(url)
  if (!origin) {
    logErr(`Q665 "${url || ''}" is not a relay https URL (expected https://<relay-host>).`)
    return 2
  }
  log(JSON.stringify(sharedSlackManifest(origin), null, 2))
  return 0
}

export async function runSlackDisconnect({ link, id = '', env = process.env, log = console.log, logErr = console.error, fetchImpl = fetch, ask = askLine, interactive = Boolean(process.stdin.isTTY), home = os.homedir() } = {}) {
  const t = target(link, logErr)
  if (!t) return 2
  const state = readState(home)
  const remembered = state[t.room] && state[t.room].id ? String(state[t.room].id) : ''
  // The id this computer remembers, or --id; failing both, the relay finds the connection by room (the
  // signing secret is still what proves it is the person who connected). For one-click connections there
  // is no signing secret, so the remembered id alone tries /slack/disconnect before prompting.
  const connection = String(id || remembered || '')
  let signingSecret = String(env.SLACK_SIGNING_SECRET || '').trim()
  if (!signingSecret && remembered && (!id || id === remembered)) {
    const r = await callRelay(t.base, '/slack/disconnect', { id: remembered }, fetchImpl, env)
    if (r.ok) {
      delete state[t.room]; try { writeState(home, state) } catch { }
      log('✓ Slack is disconnected from this room. The relay no longer holds the token.')
      return 0
    }
    if (r.code !== 'Q663') { logErr(`${r.code} ${r.why}`); return 1 }
    if (!interactive) { logErr(`${r.code} ${r.why} Set SLACK_SIGNING_SECRET and run this again.`); return 1 }
    signingSecret = await ask('Signing secret: ', { hidden: true })
    if (!signingSecret) { logErr('Q667 SLACK_SIGNING_SECRET is missing. Only the person who connected can disconnect: it is the same secret.'); return 1 }
  }
  if (!signingSecret && interactive) signingSecret = await ask('Signing secret: ', { hidden: true })
  if (!signingSecret) { logErr('Q667 SLACK_SIGNING_SECRET is missing. Only the person who connected can disconnect: it is the same secret.'); return 1 }
  const r = await callRelay(t.base, '/slack/disconnect', connection ? { id: connection, signingSecret } : { room: t.room, signingSecret }, fetchImpl, env)
  if (!r.ok) { logErr(`${r.code} ${r.why}`); return 1 }
  if (state[t.room]) { delete state[t.room]; try { writeState(home, state) } catch { } }
  log('✓ Slack is disconnected from this room. The relay no longer holds the token.')
  return 0
}
