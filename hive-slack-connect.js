// hive-slack-connect.js -- `slack connect` / `slack disconnect`: Slack <-> a room through the relay, with
// nothing running on anyone's machine (issue #22, part B). The relay does the work (parts A and C); this
// is the setup: ask the relay for a request URL, print the app manifest with it, take the bot token and
// signing secret once, let the person pick the channel, hand all of it to the relay.
//
// Relay contract (v2): POST /slack/prepare {room} -> {ok,id,eventsUrl}; POST /slack/connect {id,botToken,
// signingSecret,channel} -> {ok,team,channel,eventsUrl}; POST /slack/disconnect {id|room,signingSecret} -> {ok}.
// Errors come back as {ok:false,code,why}. Codes here: Q665 bad room link, Q666 relay not reached,
// Q667 token or signing secret missing, Q668 channel to choose.
// The secrets go to the relay and nowhere else: not to the log, not to a file, not to the room.
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { parseLink } from './sync.js'
import { slackPost } from './hive-slack.js'

export const CONNECT_USAGE = `usage:
  npx -y hivecode-mcp@latest slack connect "<relay|room>" [--channel <id>]     (SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET, or it asks)
  npx -y hivecode-mcp@latest slack disconnect "<relay|room>" [--id <connection id>]   (SLACK_SIGNING_SECRET, or it asks)
`

const BOT_SCOPES = ['chat:write', 'channels:history', 'groups:history', 'users:read', 'channels:read', 'groups:read']

/** The Slack app to create from a manifest: events to the relay, no Socket Mode, so no xapp- token. */
export function slackManifest(eventsUrl) {
  return {
    display_information: { name: 'Hivecode', description: 'Messages between a Slack channel and a Hivecode room.', background_color: '#111318' },
    features: { bot_user: { display_name: 'Hivecode', always_online: true } },
    oauth_config: { scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { request_url: eventsUrl, bot_events: ['message.channels', 'message.groups'] },
      org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false,
    },
  }
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

async function callRelay(base, route, body, fetchImpl) {
  try {
    const r = await fetchImpl(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) })
    const j = await r.json().catch(() => null)
    if (j && typeof j === 'object') return j.ok ? j : { ok: false, code: j.code || `http_${r.status}`, why: j.why || `the relay answered ${r.status}` }
    return { ok: false, code: `http_${r.status}`, why: `the relay answered ${r.status} without a reason` }
  } catch (e) {
    return { ok: false, code: 'Q666', why: `could not reach ${base} (${e && e.message ? e.message : e})` }
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

export async function runSlackConnect({ link, channel = '', env = process.env, log = console.log, logErr = console.error, fetchImpl = fetch, ask = askLine, interactive = Boolean(process.stdin.isTTY), home = os.homedir(), api = env.HIVE_SLACK_API || 'https://slack.com/api' } = {}) {
  const t = target(link, logErr)
  if (!t) return 2

  const prep = await callRelay(t.base, '/slack/prepare', { room: t.room }, fetchImpl)
  if (!prep.ok || !prep.id || !prep.eventsUrl) { logErr(`${prep.code || 'Q666'} the relay did not prepare a Slack connection: ${prep.why || 'no id came back'}`); return 1 }

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

  const done = await callRelay(t.base, '/slack/connect', { id: prep.id, botToken, signingSecret, channel: chosen }, fetchImpl)
  if (!done.ok) { logErr(`${done.code} ${done.why}`); return 1 }
  const s = readState(home)
  s[t.room] = { id: prep.id, relay: t.base }
  try { writeState(home, s) } catch { /* disconnecting then needs --id; connecting worked */ }
  log(`✓ Slack is connected to this room${done.channel ? ` (#${done.channel})` : ''}. Post a line in the channel: it shows up in the room.\n  To disconnect: npx -y hivecode-mcp@latest slack disconnect "<room link>"`)
  return 0
}

export async function runSlackDisconnect({ link, id = '', env = process.env, log = console.log, logErr = console.error, fetchImpl = fetch, ask = askLine, interactive = Boolean(process.stdin.isTTY), home = os.homedir() } = {}) {
  const t = target(link, logErr)
  if (!t) return 2
  const state = readState(home)
  // The id this computer remembers, or --id; failing both, the relay finds the connection by room (the
  // signing secret is still what proves it is the person who connected).
  const connection = String(id || (state[t.room] && state[t.room].id) || '')
  let signingSecret = String(env.SLACK_SIGNING_SECRET || '').trim()
  if (!signingSecret && interactive) signingSecret = await ask('Signing secret: ', { hidden: true })
  if (!signingSecret) { logErr('Q667 SLACK_SIGNING_SECRET is missing. Only the person who connected can disconnect: it is the same secret.'); return 1 }
  const r = await callRelay(t.base, '/slack/disconnect', connection ? { id: connection, signingSecret } : { room: t.room, signingSecret }, fetchImpl)
  if (!r.ok) { logErr(`${r.code} ${r.why}`); return 1 }
  if (state[t.room]) { delete state[t.room]; try { writeState(home, state) } catch { } }
  log('✓ Slack is disconnected from this room. The relay no longer holds the token.')
  return 0
}
