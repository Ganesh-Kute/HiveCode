// hive-slack-agent — the room, rendered onto Slack's agent surface.
//
// NAMED hive-slack-agent, NOT hive-agent: hive-agent.js already exists and is the headless join
// client an AI runs to enter a room at all. This file is a Slack bridge and has nothing to do
// with that one.
//
//   node hive-slack-agent.js "<relay|room>" --channel D123 [--name Hivecode]
//   env: SLACK_BOT_TOKEN (xoxb-…), optional HIVE_SLACK_API
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

import { startSync, parseLink } from './sync.js'
import { makeQueue, slackPost } from './hive-slack.js'

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

/** Pause every AI in the room. This is what the Slack stop button is wired to.
 *  Humans are not paused: pausing a person is meaningless, and the control map is read by
 *  hive_wait, which only agents call. */
export function stopAll(hive, by = 'slack') {
  const done = []
  for (const p of (hive.members ? hive.members() : [])) {
    if (p.kind !== 'ai') continue
    hive.control(p.name, 'paused', by)
    done.push(p.name)
  }
  return done
}

export function resumeAll(hive, by = 'slack') {
  const done = []
  for (const p of (hive.members ? hive.members() : [])) {
    if (p.kind !== 'ai') continue
    hive.control(p.name, 'running', by)
    done.push(p.name)
  }
  return done
}

/** Find the room's real spelling of a participant name.
 *
 *  Necessary because the router lowercases in order to match, and the control map is keyed by
 *  the participant's exact name -- so routing "stop AgentA" straight through wrote a control
 *  entry for "agenta", which nothing reads. The agent kept running and the panel said it had
 *  stopped. A control surface that reports a stop it did not perform is worse than one that
 *  refuses, so an unresolved name returns null here and the caller must refuse. */
export function resolveName(hive, who) {
  const want = String(who || '').toLowerCase()
  for (const p of (hive.members ? hive.members() : [])) {
    if (String(p.name).toLowerCase() === want) return p.name
  }
  return null
}

/** Turn a typed prompt into an intent. Deliberately deterministic rather than model-driven:
 *  a control panel that needs an LLM round trip to understand "stop" is not a control panel.
 *  An agent wrapper is free to fall back to a model for anything this returns as 'ask'. */
export function route(text) {
  const s = String(text || '').trim().toLowerCase()
  let m
  if ((m = s.match(/^(?:resume|unpause|start|continue)\s+(?:agent\s+)?([a-z0-9_.-]+)$/))) {
    return m[1] === 'all' || m[1] === 'everything' ? { intent: 'resume-all' } : { intent: 'resume', who: m[1] }
  }
  if ((m = s.match(/^(?:stop|pause|halt|kill)\s+(?:agent\s+)?([a-z0-9_.-]+)$/))) {
    return m[1] === 'all' || m[1] === 'everything' ? { intent: 'stop-all' } : { intent: 'stop', who: m[1] }
  }
  if (/^(stop|pause|halt|stop it|stop them|shut it down)\b/.test(s)) return { intent: 'stop-all' }
  if (/^(resume|unpause|carry on|keep going)\b/.test(s)) return { intent: 'resume-all' }
  if (/status|what.*(running|happening|going on)|who.*(here|working)|overnight/.test(s)) return { intent: 'status' }
  return { intent: 'ask', text: String(text || '') }
}

export function makeAgent({ hive, channel, token, post, botName = 'Hivecode', setStatus }) {
  const queue = makeQueue({ send: (m) => post(m) })
  const status = setStatus || ((body) => slackPost('agents.sessions.setStatus', body, token))

  /** Push the current room onto the surface as one streamed message. */
  async function frame(thread_ts, closing = 'Ask me to stop anything.') {
    const chunks = planChunks(snapshot(hive))
    const started = await queue.push({
      method: 'chat.startStream', channel, thread_ts, task_display_mode: 'plan', chunks: chunks.slice(0, 1),
    })
    const message_ts = started && started.ts
    if (chunks.length > 1) {
      await queue.push({ method: 'chat.appendStream', channel, message_ts, thread_ts, chunks: chunks.slice(1) })
    }
    await queue.push({
      method: 'chat.stopStream', channel, message_ts, thread_ts,
      chunks: [{ type: 'markdown_text', markdown_text: closing }],
    })
    return message_ts
  }

  // The loading state does NOT clear itself when a message is posted -- Slack leaves the
  // session in `processing` for a full hour if nobody says otherwise. So every path that
  // sets it must clear it, which is why this lives in a finally.
  async function busy(thread_ts, on) {
    try { await status({ status: on ? 'processing' : 'active', channel_id: channel, thread_ts }) } catch { /* the panel still works */ }
  }

  /** A human typed something at the agent. */
  async function onPrompt({ text, thread_ts, user }) {
    await busy(thread_ts, true)
    try {
      const r = route(text)
      if (r.intent === 'stop-all') {
        const who = stopAll(hive, user || 'slack')
        return { r, ts: await frame(thread_ts, who.length ? `:octagonal_sign: paused *${who.join('*, *')}*. Nothing new will be picked up.` : 'No agents to pause.') }
      }
      if (r.intent === 'resume-all') {
        const who = resumeAll(hive, user || 'slack')
        return { r, ts: await frame(thread_ts, who.length ? `:arrow_forward: resumed *${who.join('*, *')}*.` : 'No agents to resume.') }
      }
      if (r.intent === 'stop' || r.intent === 'resume') {
        const real = resolveName(hive, r.who)
        if (!real) {
          const here = (hive.members ? hive.members() : []).map((p) => p.name).join(', ') || 'nobody'
          return { r, ok: false, ts: await frame(thread_ts, `I do not see *${r.who}* in this room. Here right now: ${here}.`) }
        }
        hive.control(real, r.intent === 'stop' ? 'paused' : 'running', user || 'slack')
        return { r, ok: true, who: real, ts: await frame(thread_ts, `${r.intent === 'stop' ? ':octagonal_sign: paused' : ':arrow_forward: resumed'} *${real}*.`) }
      }
      if (r.intent === 'status') return { r, ts: await frame(thread_ts) }
      return { r, ts: await frame(thread_ts, `I can stop, resume and report. I did not act on "${r.text}".`) }
    } finally {
      await busy(thread_ts, false)
    }
  }

  /** Slack's native stop button. This is the one path that must never be clever. */
  async function onSessionStopped({ thread_ts, user }) {
    const who = stopAll(hive, user || 'slack')
    await busy(thread_ts, false)
    return who
  }

  return { onPrompt, onSessionStopped, frame, queue }
}

export const SUGGESTED = [
  { title: 'What is running?', message: 'status' },
  { title: 'Stop everything', message: 'stop all' },
  { title: 'What happened overnight?', message: 'what happened overnight' },
]

// ---- main -------------------------------------------------------------------------------
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const argv = process.argv.slice(2)
  const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || '') }
  const LINK = argv.find((a) => !a.startsWith('--')) || ''
  const CHANNEL = flag('channel')
  const TOKEN = process.env.SLACK_BOT_TOKEN || ''
  if (!LINK || !CHANNEL || !TOKEN) {
    console.error('usage: SLACK_BOT_TOKEN=xoxb-… node hive-slack-agent.js "<relay|room>" --channel <id>')
    process.exit(2)
  }
  const { relay, room } = parseLink(LINK)
  const hive = startSync({
    relay, room, dir: (process.env.TEMP || '.') + '/hive-agent-' + room,
    name: flag('name', 'Hivecode'), kind: 'human', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {},
  })
  const agent = makeAgent({ hive, channel: CHANNEL, token: TOKEN, post: (m) => slackPost(m.method, m, TOKEN) })
  console.log(`[hive-slack-agent] ${room} -> ${CHANNEL}`)
  // The Bolt/Socket-Mode wrapper calls agent.onPrompt() on message.im and
  // agent.onSessionStopped() on agent_session_stopped.
  globalThis.__hiveAgent = agent
}
