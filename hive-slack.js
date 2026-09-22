// hive-slack — the room speaks to Slack, and Slack speaks back into the room.
//
//   node hive-slack.js "<relay|room>" --channel C123 [--name SlackBridge]
//   env: SLACK_BOT_TOKEN (xoxb-…), optional HIVE_SLACK_API to point at a different base URL
//
// WHY OUT AND NOT IN. A team will not move its conversation into our control room, and asking
// them to is how the integration dies quietly. So Slack stays where the humans are: the room
// posts there, and a reply in the thread comes back into the room. Nobody has to open a new tab
// to find out what happened overnight.
//
// ONE THREAD PER TASK. This is the decision the whole integration lives or dies on. Everything
// about a task -- its claims, its gate result, its completion -- goes into that task's own
// thread, and only the opening and the outcome reach the channel itself. Post every room event
// to the channel and the integration is muted in week one, which is the same as not having it.
//
// The thread map lives in ROOM STATE, not in this process. A bridge that restarts must land its
// next update in the same Slack thread, or a task's history splits in half and the thread stops
// being worth reading.

import { startSync, parseLink } from './sync.js'

const API = process.env.HIVE_SLACK_API || 'https://slack.com/api'

// Slack allows roughly one message per second per channel and silently reorders or drops when
// you exceed it. A room can emit a dozen events in a burst, so everything leaves through one
// paced queue rather than going straight out.
export function makeQueue({ send, minGapMs = 1000, now = () => Date.now(), timer = setTimeout }) {
  const q = []
  let running = false, last = 0
  async function pump() {
    if (running) return
    running = true
    while (q.length) {
      const wait = Math.max(0, minGapMs - (now() - last))
      if (wait) await new Promise((r) => timer(r, wait))
      const job = q.shift()
      last = now()
      try { job.resolve(await send(job.msg)) } catch (e) { job.reject(e) }
    }
    running = false
  }
  return {
    push: (msg) => new Promise((resolve, reject) => { q.push({ msg, resolve, reject }); pump() }),
    depth: () => q.length,
  }
}

/** POST to Slack's Web API. Kept tiny and injectable so the bridge can be tested without a
 *  workspace -- the thing worth testing is our routing, not Slack's HTTP. */
export async function slackPost(method, body, token, fetchImpl = fetch) {
  const r = await fetchImpl(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({ ok: false, error: 'bad_json' }))
  if (!j.ok) throw new Error(`slack ${method}: ${j.error || 'unknown'}`)
  return j
}

/** What a room event looks like in Slack. Plain text on purpose: blocks render badly in
 *  notifications and thread previews, which is where most of these are actually read. */
export function render(ev) {
  if (ev.kind === 'task-open') return `:inbox_tray: *${ev.task}*  —  assigned to *${ev.to}*`
  if (ev.kind === 'task-done') return `:white_check_mark: *${ev.task}* — done by *${ev.by}*`
  if (ev.kind === 'gate-fail') return `:no_entry: gate failed for *${ev.by}* on \`${ev.file}\` — the file stays with them, nobody downstream gets it`
  if (ev.kind === 'gate-pass') return `:heavy_check_mark: gate passed for *${ev.by}* on \`${ev.file}\``
  if (ev.kind === 'chat') return `*${ev.by}*: ${ev.text}`
  return `${ev.kind}: ${ev.text || ''}`
}

/** Which events reach the CHANNEL, and which only ever go inside a thread.
 *  Getting this wrong is the difference between a useful feed and a muted one. */
export const TO_CHANNEL = new Set(['task-open', 'task-done'])

export function makeBridge({ hive, channel, token, post, botName = 'SlackBridge' }) {
  const threads = hive.doc.getMap('slack_threads')   // task id -> thread_ts, shared + durable
  const queue = makeQueue({ send: (m) => post(m) })
  const seen = new Set()

  async function emit(ev) {
    const text = render(ev)
    const thread_ts = ev.task ? threads.get(ev.task) : undefined
    // A task's first event opens the thread; everything after lands inside it.
    if (ev.task && !thread_ts) {
      const res = await queue.push({ channel, text })
      if (res && res.ts) threads.set(ev.task, res.ts)
      return res
    }
    if (thread_ts && !TO_CHANNEL.has(ev.kind)) return queue.push({ channel, text, thread_ts })
    return queue.push({ channel, text, thread_ts })
  }

  function onChat(msgs) {
    for (const m of msgs) {
      if (!m || !m.text) continue
      // THE ECHO GUARD. Anything this bridge itself put into the room must never go back out,
      // or a Slack reply becomes a room message becomes a Slack message, forever.
      if (m.by === botName || m.viaSlack) continue
      const key = `${m.by}|${m.at}|${m.text}`
      if (seen.has(key)) continue
      seen.add(key)
      emit({ kind: 'chat', by: m.by, text: m.text, task: m.task }).catch(() => {})
    }
  }

  /** A human replied in a Slack thread. Put it into the room, addressed, and marked so the
   *  echo guard above will not send it straight back to Slack. */
  function deliver({ thread_ts, text, user }) {
    let task = null
    for (const [id, ts] of threads.entries()) if (ts === thread_ts) { task = id; break }
    const addressed = /^@/.test(text.trim()) ? text.trim() : text.trim()
    hive.doc.getArray('chat').push([{
      by: user || 'slack', kind: 'say', at: Date.now() * 1000, text: addressed, task, viaSlack: true,
    }])
    return { ok: true, task }
  }

  return { emit, onChat, deliver, threads, queue }
}

// ---- main -------------------------------------------------------------------------------
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const argv = process.argv.slice(2)
  const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || '') }
  const LINK = argv.find((a) => !a.startsWith('--')) || ''
  const CHANNEL = flag('channel')
  const NAME = flag('name', 'SlackBridge')
  const TOKEN = process.env.SLACK_BOT_TOKEN || ''
  if (!LINK || !CHANNEL || !TOKEN) {
    console.error('usage: SLACK_BOT_TOKEN=xoxb-… node hive-slack.js "<relay|room>" --channel <id>')
    process.exit(2)
  }
  const { relay, room } = parseLink(LINK)
  const dir = (process.env.TEMP || '.') + '/hive-slack-' + room
  const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {} })
  const bridge = makeBridge({ hive, channel: CHANNEL, token: TOKEN, botName: NAME, post: (m) => slackPost('chat.postMessage', m, TOKEN) })

  const chat = hive.doc.getArray('chat')
  let at = chat.length                    // only forward what arrives AFTER we attach
  chat.observe(() => { const all = chat.toArray(); bridge.onChat(all.slice(at)); at = all.length })
  console.log(`[hive-slack] ${room} -> ${CHANNEL}`)
  // Inbound needs Socket Mode (no public URL required) -- the wrapper calls bridge.deliver().
}
