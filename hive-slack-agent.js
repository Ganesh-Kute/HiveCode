// hive-slack-agent — the room, rendered onto Slack's agent surface.
//
// NAMED hive-slack-agent, NOT hive-agent: hive-agent.js already exists and is the headless join
// client an AI runs to enter a room at all. This file is a Slack bridge and has nothing to do
// with that one.
//
//   node hive-slack-agent.js "<relay|room>" --channel D123 [--name Hivecode] [--allow <U123,U456>]
//   env: SLACK_BOT_TOKEN (xoxb-…), SLACK_APP_TOKEN (xapp-…), optional SLACK_ALLOW, HIVE_SLACK_API
//
// WHY THIS AND NOT THE FEED. hive-slack.js posts what HAPPENED into a channel thread: the
// team's record of the night, read in the morning. This is the other half -- the panel one
// person opens to see what is happening RIGHT NOW, and to stop it. Both are needed and
// neither replaces the other.
//
// THE STOP BUTTON IS THE PRODUCT. Everything else here is decoration around one guarantee:
// somebody who is not at their desk can halt every agent in a room from their phone. Slack
// renders that button natively for any app subscribed to `agent_session_stopped`, so the
// control panel THE SECOND SHIFT needs is a MAPPING job, not a front-end project. That is the
// whole reason this file is short.
//
// WHAT WE DO NOT PRETEND. The pause is cooperative: control() writes 'paused' into the room and
// hive_wait refuses to hand that agent new work. An agent mid-step finishes its step. Calling
// that a kill switch would be a stronger claim than the mechanism supports, and the first
// person to test it would find out. It stops the NEXT thing, reliably, and that is what makes
// it safe to walk away.

import WebSocket from 'ws'
import { startSync, parseLink } from './sync.js'
import {
  makeQueue,
  slackPost,
  stopAll,
  resumeAll,
  resolveName,
  route,
  makeSlackActorCheck,
  formatSlackSender,
  checkAgentScopes,
  preflightSocketMode,
  connectSocketMode,
  parseSlackAllow,
  notFromAPerson,
} from './hive-slack.js'

export { stopAll, resumeAll, resolveName, route }

// Slack's plan block knows four states. The room knows four task statuses. They are not the
// same four, and the join is the only interesting decision in this file.
//
//   pending   -> pending       waiting on a human owner to approve it
//   accepted  -> in_progress   an agent has it and may work
//   done      -> completed
//   denied    -> error         the owner said no; that IS the terminal state, not a failure
//
// A PAUSED assignee overrides 'accepted' back to 'pending'. Slack has no paused state, and
// showing a spinner next to an agent that has been halted is a lie told by the exact panel
// somebody is trusting to tell them whether they can go to bed. The title carries the reason
// so it can never be confused with the approval-pending case.
export const STATE_OF = { pending: 'pending', accepted: 'in_progress', done: 'completed', denied: 'error' }

export function taskState(t, paused) {
  const base = STATE_OF[t.status] || 'pending'
  return base === 'in_progress' && paused ? 'pending' : base
}

export function taskTitle(t, paused) {
  const who = t.to || 'unassigned'
  if (paused) return `${who} — ${t.text}  (paused)`
  if (t.status === 'pending') return `${who} — ${t.text}  (awaiting approval)`
  return `${who} — ${t.text}`
}

/** Read the live room into a plain object. Kept separate from rendering so the renderer can be
 *  tested without a relay, and so one read is used for the whole frame -- sampling the CRDT
 *  per-task would let the panel show two different moments in the same picture. */
export function snapshot(hive) {
  const controls = hive.doc.getMap('controls')
  const tasks = [...hive.doc.getMap('tasks').values()]
  const pausedOf = (who) => { const c = controls.get(who); return !!(c && c.state === 'paused') }
  const people = (hive.members ? hive.members() : []) || []
  return {
    tasks: tasks.sort((a, b) => String(a.at).localeCompare(String(b.at))),
    people: people.map((p) => ({ ...p, paused: pausedOf(p.name) })),
    pausedOf,
    open: tasks.filter((t) => t.status === 'accepted').length,
    waiting: tasks.filter((t) => t.status === 'pending').length,
  }
}

/** The room as Slack streaming chunks: a one-line summary, then one task card per task. */
export function planChunks(snap) {
  const live = snap.people.filter((p) => !p.paused).length
  const head = snap.people.length
    ? `*${live}/${snap.people.length} running* · ${snap.open} in progress · ${snap.waiting} awaiting approval`
    : '_nobody is in the room_'
  const chunks = [{ type: 'markdown_text', markdown_text: head }]
  for (const t of snap.tasks) {
    const paused = snap.pausedOf(t.to)
    chunks.push({
      type: 'task_update',
      task: { task_id: String(t.id), title: taskTitle(t, paused), status: taskState(t, paused) },
    })
  }
  return chunks
}

// stopAll, resumeAll, resolveName, and route live in hive-slack.js so both the channel thread
// bridge and this Slack agent surface share the exact same deterministic router and case-insensitive
// participant lookup without duplicating control logic.

/** WHO MAY ACT, AND FROM WHERE. This surface used to act for anybody who could type at it: no guest
 *  refusal, no --allow, and main() handed it every `message` event the app hears -- which, with
 *  message.channels and message.groups in the manifest, is every channel the bot is in. Now it is
 *  the same rules as `slack start` (makeSlackActorCheck, one place in hive-slack.js):
 *   - stop / stop all / the native stop button: any full workspace member; if Slack cannot say who
 *     they are, it stops anyway and says so (stopping is the safe direction);
 *   - resume: only user ids in `allow`;
 *   - guests and users from other workspaces: refused for everything, status included, so they are
 *     never shown the room's tasks.
 *  A typed message counts only in the configured channel or in a DM (each user has their own
 *  assistant DM, so any `im` channel is a valid place, and the answer goes to THAT DM). */
export function makeAgent({
  hive, channel, token, post, botName = 'Hivecode', setStatus,
  teamId = '', allow = [], botUserId = '', lookupUser = null, actorCheck = null, api, fetchImpl,
}) {
  const queue = makeQueue({ send: (m) => post(m) })
  const status = setStatus || ((body) => slackPost('agents.sessions.setStatus', body, token))
  const allowSet = new Set((Array.isArray(allow) ? allow : String(allow || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean))
  const actors = actorCheck || makeSlackActorCheck({ token, teamId, lookupUser, ...(api ? { api } : {}), ...(fetchImpl ? { fetchImpl } : {}) })

  /** Push the current room onto the surface as one streamed message. */
  async function frame(thread_ts, closing = 'Ask me to stop anything.', ch = channel) {
    const chunks = planChunks(snapshot(hive))
    const started = await queue.push({
      method: 'chat.startStream', channel: ch, thread_ts, task_display_mode: 'plan', chunks: chunks.slice(0, 1),
    })
    const message_ts = started && started.ts
    if (chunks.length > 1) {
      await queue.push({ method: 'chat.appendStream', channel: ch, message_ts, thread_ts, chunks: chunks.slice(1) })
    }
    await queue.push({
      method: 'chat.stopStream', channel: ch, message_ts, thread_ts,
      chunks: [{ type: 'markdown_text', markdown_text: closing }],
    })
    return message_ts
  }

  // The loading state does NOT clear itself when a message is posted -- Slack leaves the
  // session in `processing` for a full hour if nobody says otherwise. So every path that
  // sets it must clear it, which is why this lives in a finally.
  async function busy(thread_ts, on, ch = channel) {
    try { await status({ status: on ? 'processing' : 'active', channel_id: ch, thread_ts }) } catch { /* the panel still works */ }
  }

  /** A plain reply in the thread. Used for refusals, which must not stream the room's tasks. */
  async function say(thread_ts, text, ch = channel) {
    try { await queue.push({ method: 'chat.postMessage', channel: ch, thread_ts, text }) } catch { /* nothing more to do */ }
  }

  /** May this user do this? -> { ok, by, unverified, reply } */
  async function authorize(user, intent) {
    const actor = await actors.resolve(user)
    if (intent === 'stop' || intent === 'stop-all') return actors.mayAct(actor, 'stop', allowSet)
    if (intent === 'resume' || intent === 'resume-all') return actors.mayAct(actor, 'resume', allowSet)
    // status and everything else: any verified full member. mayAct(..., 'reply') would demand
    // --allow, which is for acting on agents, not for reading what is running.
    if (actor && actor.ok) return { ok: true, by: formatSlackSender(actor.handle || actor.userId), unverified: false, reply: '' }
    return actors.mayAct(actor, 'reply', allowSet)
  }

  /** A human typed something at the agent. */
  async function onPrompt({ text, thread_ts, user, channel: ch = channel }) {
    const r = route(text)
    const check = await authorize(user, r.intent)
    if (!check.ok) {
      if (check.reply) await say(thread_ts, check.reply, ch)
      return { r, refused: check.refused || 'refused' }
    }
    const by = check.by || formatSlackSender(user)
    const note = check.unverified ? ` (${check.reply})` : ''
    await busy(thread_ts, true, ch)
    try {
      if (r.intent === 'stop-all') {
        const who = stopAll(hive, by)
        return { r, ts: await frame(thread_ts, who.length ? `:octagonal_sign: paused *${who.join('*, *')}*. Nothing new will be picked up.${note}` : 'No agents to pause.', ch) }
      }
      if (r.intent === 'resume-all') {
        const who = resumeAll(hive, by)
        return { r, ts: await frame(thread_ts, who.length ? `:arrow_forward: resumed *${who.join('*, *')}*.` : 'No agents to resume.', ch) }
      }
      if (r.intent === 'stop' || r.intent === 'resume') {
        const real = resolveName(hive, r.who)
        if (!real) {
          const here = (hive.members ? hive.members() : []).map((p) => p.name).join(', ') || 'nobody'
          return { r, ok: false, ts: await frame(thread_ts, `I do not see *${r.who}* in this room. Here right now: ${here}.`, ch) }
        }
        hive.control(real, r.intent === 'stop' ? 'paused' : 'running', by)
        return { r, ok: true, who: real, ts: await frame(thread_ts, `${r.intent === 'stop' ? ':octagonal_sign: paused' : ':arrow_forward: resumed'} *${real}*.${r.intent === 'stop' ? note : ''}`, ch) }
      }
      if (r.intent === 'status') return { r, ts: await frame(thread_ts, undefined, ch) }
      return { r, ts: await frame(thread_ts, `I can stop, resume and report. I did not act on "${r.text}".`, ch) }
    } finally {
      await busy(thread_ts, false, ch)
    }
  }

  /** Slack's native stop button. This is the one path that must never be clever. */
  async function onSessionStopped({ thread_ts, user, channel: ch = channel }) {
    const check = await authorize(user, 'stop-all')
    if (!check.ok) {
      if (check.reply) await say(thread_ts, check.reply, ch)
      await busy(thread_ts, false, ch)
      return []
    }
    const who = stopAll(hive, check.by || formatSlackSender(user))
    await busy(thread_ts, false, ch)
    return who
  }

  /** The one entry point for Slack events. Only a message in the configured channel or in a DM, or
   *  the native stop button, does anything; everything else is ignored before any actor lookup. */
  async function onEvent(ev) {
    if (notFromAPerson(ev) || (botUserId && ev.user === botUserId)) return { ignored: 'bot_or_subtype' }
    const targetChannel = ev.channel || channel
    const isDm = ev.channel_type === 'im' || (typeof targetChannel === 'string' && targetChannel.startsWith('D'))
    const here = targetChannel === channel || isDm
    if (!here) return { ignored: 'wrong_channel' }
    if (ev.type === 'agent_session_stopped') {
      const who = await onSessionStopped({ thread_ts: ev.thread_ts || ev.ts, user: ev.user, channel: targetChannel })
      return { action: 'session-stopped', stopped: who }
    }
    if (ev.type !== 'message' || !ev.text) return { ignored: 'unsupported_event' }
    return onPrompt({ text: ev.text, thread_ts: ev.thread_ts || ev.ts, user: ev.user, channel: targetChannel })
  }

  return { onPrompt, onSessionStopped, onEvent, frame, queue }
}

// Suggested prompts are declared once, in slack-app-manifest-agent.json
// (features.assistant_view.suggested_prompts); there is no second copy in code to drift from it.

/** Verify SLACK_BOT_TOKEN scopes (chat:write, assistant:write, im:history/channels:history/groups:history, users:read)
 *  and SLACK_APP_TOKEN Socket Mode connection before starting hive-slack-agent (Q630, Q634). */
export async function preflightSlackAgent({
  token = '',
  appToken = '',
  channel = '',
  api,
  fetchImpl = fetch,
} = {}) {
  if (!token || !String(token).trim()) {
    return {
      ok: false,
      code: 'Q630',
      error: 'Q630 SLACK_BOT_TOKEN is missing. Set SLACK_BOT_TOKEN=xoxb-… in your environment.',
    }
  }
  if (!appToken || !String(appToken).trim()) {
    return {
      ok: false,
      code: 'Q634',
      error: 'Q634 SLACK_APP_TOKEN is missing. Set SLACK_APP_TOKEN=xapp-… (with connections:write scope) to start slack agent.',
    }
  }
  let auth
  try {
    auth = await slackPost('auth.test', {}, token, fetchImpl, api)
  } catch (e) {
    if (!e || !e.slackError) {
      const why = e.message || 'network error'
      return { ok: false, transient: true, code: 'Q636', error: `Q636 could not reach Slack (${why}). The token was not checked; check this machine's network and try again.` }
    }
    return {
      ok: false,
      code: 'Q630',
      error: `Q630 SLACK_BOT_TOKEN was rejected by Slack (${e.code || e.message || 'auth_failed'}). Check the token or reinstall the Slack app.`,
    }
  }
  const scopes = Array.isArray(auth && auth._scopes) ? auth._scopes : null
  const sc = checkAgentScopes({ scopes, channel })
  if (!sc.ok) return sc
  // Without the workspace id, users from OTHER workspaces (Slack Connect) cannot be told apart, so
  // nobody could be refused as an outsider. Refused here, as hive-github.js and hive-mcp-http.js do.
  if (!auth || !auth.team_id) {
    return { ok: false, code: 'Q634', error: 'Q634 Slack did not say which workspace the bot is in (auth.test returned no team_id), so users from other workspaces could not be refused. Reinstall the Slack app.' }
  }
  const sockPre = await preflightSocketMode({ appToken, api, fetchImpl })
  if (!sockPre.ok) return sockPre
  return {
    ok: true,
    url: sockPre.url,
    botUser: (auth && auth.user) || 'Hivecode',
    botUserId: (auth && auth.user_id) || '',
    teamId: (auth && auth.team_id) || '',
    scopes,
  }
}

// ---- main -------------------------------------------------------------------------------
export const USAGE = `usage:
  SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… npx -y hivecode-mcp@latest slack agent "<relay|room>" --channel <id> [--name <name>] [--allow <U123,U456>]`

export async function main(argv = process.argv.slice(2), {
  log = console.log,
  logErr = console.error,
  env = process.env,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
} = {}) {
  if (argv.includes('--help') || argv.includes('-h') || argv.includes('help')) {
    log(USAGE)
    return 0
  }
  const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || '') }
  const LINK = argv.find((a) => !a.startsWith('--')) || ''
  const CHANNEL = flag('channel')
  const TOKEN = env.SLACK_BOT_TOKEN || ''
  const APP_TOKEN = env.SLACK_APP_TOKEN || ''
  if (!LINK || !CHANNEL) {
    logErr(USAGE)
    return 2
  }
  if (!TOKEN) {
    logErr('Q630 SLACK_BOT_TOKEN is missing. Set SLACK_BOT_TOKEN=xoxb-… in your environment.')
    logErr(USAGE)
    return 2
  }
  if (!APP_TOKEN) {
    logErr('Q634 SLACK_APP_TOKEN is missing. Set SLACK_APP_TOKEN=xapp-… (with connections:write scope) to start slack agent.')
    logErr(USAGE)
    return 2
  }
  const allowIdx = argv.indexOf('--allow')
  const allowSource = allowIdx !== -1 ? '--allow' : (env.SLACK_ALLOW ? 'SLACK_ALLOW' : '--allow')
  const rawAllow = allowIdx !== -1 ? (argv[allowIdx + 1] || '') : (env.SLACK_ALLOW || '')
  const allowParsed = parseSlackAllow(rawAllow, allowSource)
  if (!allowParsed.ok) {
    logErr(allowParsed.error)
    return 1
  }
  const pre = await preflightSlackAgent({ token: TOKEN, appToken: APP_TOKEN, channel: CHANNEL, fetchImpl })
  if (!pre.ok) {
    logErr(pre.error)
    return 1
  }
  const { relay, room } = parseLink(LINK)
  const hive = startSync({
    relay, room, dir: (env.TEMP || '.') + '/hive-agent-' + room,
    name: flag('name', 'Hivecode'), kind: 'human', token: env.HIVE_TOKEN || '', syncFiles: false, log: () => {},
  })
  const agent = makeAgent({
    hive, channel: CHANNEL, token: TOKEN, post: (m) => slackPost(m.method, m, TOKEN, fetchImpl),
    teamId: pre.teamId, botUserId: pre.botUserId, allow: allowParsed.ids,
  })
  let sm
  try {
    sm = await connectSocketMode({
      appToken: APP_TOKEN,
      initialUrl: pre.url,
      fetchImpl,
      WebSocketImpl,
      logErr,
      onEvent: (ev) => agent.onEvent(ev),
      onMultiConnection: (n) => {
        slackPost('chat.postMessage', {
          channel: CHANNEL,
          text: `:warning: Another process connected to Slack Socket Mode with this app token (${n} active connections). Slack distributes incoming events across connections, so messages or "stop" commands may go to the other process. Check for another terminal running hivecode-mcp slack start, github start --slack-allow, or hive-slack-agent.`,
        }, TOKEN, fetchImpl).catch(() => {})
      },
    })
  } catch (e) {
    logErr(e.message)
    try { hive.stop() } catch { }
    return 1
  }
  log(`READY: [hive-slack-agent] ${room} -> ${CHANNEL} (Socket Mode connected) — resume: ${allowParsed.ids.length ? allowParsed.ids.join(', ') : 'off'}`)

  return new Promise((resolve) => {
    let done = false
    const finish = (code = 0) => {
      if (done) return
      done = true
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      try { if (sm && sm.stop) sm.stop() } catch { }
      try { hive.stop() } catch { }
      resolve(code)
    }
    const onSignal = () => finish(0)
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().then((code) => { if (code !== 0) process.exit(code) })
}
