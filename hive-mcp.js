#!/usr/bin/env node
// Hivecode MCP server — lets ANY MCP-capable AI agent join a hive room and
// coordinate through native tool calls (no script-running, no human setup).
//
// Register it with an MCP client (e.g. Claude Code / Claude Desktop):
//   command: node   args: ["<abs-path>/hive-mcp.js"]
//   env (optional): HIVE_RELAY = wss://your-relay   (defaults to the hosted relay)
//
// Tools exposed:
//   hive_join         join/host a room for a folder (auto kind:ai) -> returns the rules
//   hive_say          post a coordination message to the room
//   hive_read_chat    read the room conversation (read this to coordinate)
//   hive_read_board   read recent whole-file rewrites (read before editing)
//   hive_members      who is in the room
//   hive_status       current session info
//   hive_leave        leave the room
//
// This operationalizes SPEC.md: one server turns the protocol into agent-native
// actions. The agent's FIRST move after hive_join should be to follow the rules
// it returns (read chat + board before editing, announce intent, prefer patches).

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
// Substrate defaults for MCP agents: signed provenance + the silent-fork gate are ON
// unless explicitly disabled. Agents register this server with arbitrary (often empty)
// env, so relying on per-registration env vars left rooms in mixed signed/unsigned mode —
// which is exactly the condition that disabled fork detection in live testing. sync.js
// reads these when startSync() runs (not at import), so setting them here covers every join.
if (!process.env.HIVE_PROVENANCE) process.env.HIVE_PROVENANCE = 'on'
if (!process.env.HIVE_FORK_GATE) process.env.HIVE_FORK_GATE = 'on'
import { startSync, parseLink } from './sync.js'
import { createMailbox, formatMessage, mentionsName, mentionedNames, mentionsAll, unansweredFor, priorityOf, ambientDigest, validateMemberName } from './hive-mailbox.js'
import { INSTRUCTIONS } from './hive-instructions.js'
import { makeBusy, isBusy, describeRecipient } from './hive-busy.js'
import * as ACT from './hive-activity.js'   // HIV-P11; key MUST be 'activity'
import * as OB from './hive-obligations.js'
import * as RC from './hive-receipts.js'
import { makeThrottle, RULES_NUDGE } from './hive-throttle.js'

const DEFAULT_RELAY = process.env.HIVE_RELAY || 'wss://livecode-xoss.onrender.com'
let session = null // { hive, room, relay, dir, name, mailbox }

// ONE THROTTLE PER SERVER PROCESS, which is one agent. It deliberately does NOT live on the
// session: a rejoin does not empty the agent's context, so resetting the throttle there would
// re-send everything the agent can still see -- the exact waste this removes.
const throttle = makeThrottle()

const text = (s) => {
  const body = typeof s === 'string' ? s : JSON.stringify(s, null, 2)
  // THE METER. Every tool result leaves through here, so this count is exact rather than
  // sampled -- it is the local equivalent of the PTY output bytes Agent Relay's broker measures,
  // and it is the only evidence available that an agent has done enough since it last saw a
  // block for that block to have been compacted away.
  try { throttle.note(body.length) } catch { /* the meter must never break a tool result */ }
  return { content: [{ type: 'text', text: body }] }
}
const err = (s) => ({ content: [{ type: 'text', text: s }], isError: true })

function resolveRoom(link, dir) {
  if (link) { const { relay, room, token } = parseLink(link); return { relay: relay || DEFAULT_RELAY, room, token, mode: 'joined (link)' } }
  const cfgPath = path.join(path.resolve(dir), '.hive.json')
  if (fs.existsSync(cfgPath)) {
    try { const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); if (c.room) return { relay: c.relay || DEFAULT_RELAY, room: c.room, token: c.token || '', mode: 'joined (.hive.json)' } } catch {}
  }
  return { relay: DEFAULT_RELAY, room: 'room-' + crypto.randomBytes(13).toString('base64url'), token: '', mode: 'HOSTED (new room)' }
}

// Session persistence: keyed to this process's cwd, so each agent runtime (which starts
// its own MCP process from its own directory) resumes only its own identity. Lets the
// session survive MCP host restarts, which otherwise silently drop the agent from the room.
const SESSION_FILE = path.join(process.cwd(), '.hive-mcp-session.json')
function persistSession({ dir, name, owner, cursor }) {
  try {
    const prev = readSessionFile() || {}
    const chatCursor = cursor === undefined ? prev.chatCursor : cursor
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ dir, name, owner, chatCursor }))
  } catch { /* best-effort */ }
}
function readSessionFile() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) } catch { return null }
}
/** Save the read cursor so a host restart does not reopen the blind window it just closed. */
function persistCursor() {
  if (!session || !session.mailbox) return
  persistSession({ dir: session.dir, name: session.name, owner: session.owner, cursor: session.mailbox.cursor })
  // AND PUBLISH IT INTO THE ROOM. The file above is for resuming THIS session; the room copy is
  // what makes "did they actually read it" answerable by anybody other than me. The cursor only
  // advances inside box.take(), which is the call that hands messages to the agent -- so a cursor
  // past a message is the one honest piece of evidence this system has that the message reached
  // somebody's context. Before this, that evidence existed and was thrown away on disk.
  try { RC.publishCursor(session.hive.doc.getMap('cursors'), session.name, session.mailbox.cursor) } catch { /* a room that predates receipts */ }
}
async function tryResumeSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return
    const s = readSessionFile()
    if (s && s.dir && s.name && fs.existsSync(path.join(path.resolve(s.dir), '.hive.json'))) await joinRoom(s)
  } catch { /* resume is best-effort; the agent can always hive_join explicitly */ }
}

async function joinRoom({ link = '', dir = './workspace', name = `agent-${crypto.randomBytes(2).toString('hex')}`, owner = '', token = '', chatCursor, kind = 'ai', passive = false }) {
  // REFUSED BEFORE THE OLD SESSION IS TORN DOWN. joinRoom's first act is to stop whatever session
  // exists, so validating after that point would leave an agent with a bad name holding nothing at
  // all -- it would lose a working room to a refusal it could have been given for free.
  const nameCheck = validateMemberName(name)
  if (!nameCheck.ok) {
    return `${nameCheck.error}

Nothing was joined and your current session is untouched. Re-run hive_join with name: "${nameCheck.suggested}".

This is refused rather than fixed for you because renaming silently is worse: if another member is already called "${nameCheck.suggested}", you would be merged into them -- one awareness entry, one read cursor, one mailbox -- and neither of you would be told. Your own prompt would also still say your name is "${name}", so you would stop recognising messages about yourself.`
  }
  if (session) { try { session.hive.stop() } catch {} ; session = null }
  const ROOT = path.resolve(dir)
  fs.mkdirSync(ROOT, { recursive: true })
  const { relay, room, token: linkToken, mode } = resolveRoom(link, dir)
  // token precedence: explicit arg > token baked into the join link > $HIVE_TOKEN.
  const useToken = token || linkToken || process.env.HIVE_TOKEN || ''
  // persist the token too, so a re-join from .hive.json keeps the grant (the
  // invitee pastes the link once; subsequent joins just read the folder config).
  fs.writeFileSync(path.join(ROOT, '.hive.json'), JSON.stringify({ relay, room, ...(useToken ? { token: useToken } : {}) }, null, 2))
  // The ACCOUNT licence is passed through but NOT persisted to .hive.json above, and that
  // asymmetry is deliberate. `.hive.json` sits in the project folder, so it gets committed
  // and it gets shared -- fine for a room invite, which is what it is for, and wrong for a
  // billing credential. startSync resolves the licence from $HIVE_LICENSE (this server's env
  // block) or ~/.hivecode/config.json instead, both of which are per-machine.
  // A refused folder lock must reach the AGENT as a readable instruction, not as a stack
  // trace. An agent that gets an opaque failure retries, and two of them retrying on one
  // folder is precisely the situation the lock exists to prevent.
  let hive
  try {
    hive = startSync({ relay, room, dir, name, kind: kind || 'ai', owner, token: useToken, log: () => {}, passive: !!passive })
  } catch (e) {
    if (e && e.code === 'EHIVELOCKED') {
      return text(
        `${e.message}\n\n` +
        `Do NOT retry this folder. Either join with a different \`dir\`, or stop process ${e.pid} first.`,
      )
    }
    throw e
  }
  session = { hive, room, relay, dir, name, owner, kind: kind || 'ai', passive: !!passive, mailbox: null }
  persistSession({ dir, name, owner }) // survive MCP host restarts (see tryResumeSession)
  // Wait for the first sync so members/board/rules are ready.
  //
  // REPORT THE TRUTH ABOUT THIS. Until 18 Sep 2026 the timeout below simply resolved and the
  // caller returned a cheerful "joined" banner whether or not the relay had accepted us. On a
  // relay at capacity that is a false success report: the agent is told it is in a room, reads
  // the rules, claims files and writes code, and NONE of it reaches anybody. It happened for
  // real -- a relay answered 38,011 connections with Q430 while three agents believed they were
  // collaborating. An agent cannot detect this on its own; the only honest place to catch it is
  // here, at the moment we know whether the socket came up.
  let synced = false
  let connErr = ''
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    hive.provider.on('sync', (s) => { if (s) { synced = true; finish() } })
    // A refusal arrives as a failed upgrade: the relay writes an HTTP status line carrying the
    // Q-code and destroys the socket, so this event is the only place the reason is visible.
    hive.provider.on('connection-error', (ev) => {
      const code = ev && (ev.code || ev.status || ev.type)
      if (!connErr) connErr = `the relay refused the connection${code ? ` (${code})` : ''}`
    })
    setTimeout(finish, 8000) // don't hang if the relay is cold
  })
  if (!synced) {
    const why = connErr || 'no sync within 8s -- the relay did not answer'
    return [
      `NOT JOINED -- ${why}.`,
      `room: ${room}`,
      `relay: ${relay}`,
      `folder: ${ROOT}`,
      '',
      'DO NOT START WORK. You are not in this room. Nothing you write will reach anyone, no',
      'claim you make binds anyone else, and the files in this folder are NOT shared. Any work',
      'you do now is invisible to the team and can be silently overwritten later.',
      '',
      'Most likely causes, in the order worth checking:',
      '  - the relay is at capacity (Q430). Hivecode opens one socket PER FILE, so a large',
      '    folder can exhaust it by itself. Check <relay-http>/health: connections vs',
      '    limits.maxConnsTotal. Raise HIVE_MAX_CONNS_TOTAL, or narrow what syncs via .gitignore.',
      '  - the relay is not running, or the port/room in the link is wrong.',
      '  - the room is secured and this link carries no token (Q4xx on connect).',
      '',
      'Tell whoever is running the relay, then retry hive_join. Call hive_status to re-check:',
      'it reports `connected` and `filesSynced`, and both are authoritative.',
    ].join('\n')
  }
  // The mailbox is created AFTER the first sync, so chat.length is the real room history and
  // not 0 — otherwise a fresh joiner would be handed the entire backlog as unread mail.
  // A resumed session carries its saved cursor forward instead, so anything posted while this
  // process was down is still delivered rather than falling into the old blind window.
  const chatLen = hive.doc.getArray('chat').length
  const startAt = Number.isFinite(Number(chatCursor)) ? Number(chatCursor) : chatLen
  session.mailbox = createMailbox({ me: name, startAt })
  persistCursor()

  const others = hive.members().filter((m) => m.name !== name).map((m) => `${m.name}(${m.kind})`)

  // Event-Driven Wakeups: notify the MCP client the millisecond the DCO state changes
  hive.doc.getMap('swarm_state').observe(() => {
    // SAME DEFECT AS THE MAIL DOORBELL BELOW, AND FOUND THE SAME WAY -- a test crashed inside a
    // Yjs observer with the stack pointing at a `try` that looked like it had the case covered.
    // `notification()` is async: a failure is a REJECTED PROMISE, which sails past this catch,
    // becomes an unhandled rejection and takes the whole agent down.
    //
    // Worth recording that the first fix only repaired the copy in the chat observer. This one
    // survived untouched for another two tickets and then crashed a second test -- which is the
    // duplicated-wire-contract lesson arriving in person: repair the CLASS, not the instance.
    // Both call sites are now the same shape, deliberately.
    try {
      Promise.resolve(server.notification({ method: 'notifications/hive_state_changed', params: { state: hive.getState() } }))
        .catch(() => { /* no transport, or a client that does not take notifications */ })
    } catch (e) {
      // client might not support notifications, swallow error
    }
  })

  // MAIL WAKEUPS — the other half of the same channel, and it was missing.
  //
  // The observer above pushes a notification the instant swarm_state changes, so a state flip
  // reaches an agent mid-task. Chat had no such channel: it is observed only INSIDE the
  // hive_wait handler, which means an @mention reached a working agent only if it happened to
  // already be blocked in that call. An agent heads-down in a task is exactly the one that
  // cannot choose to look.
  //
  // Measured on a real four-agent build (JARVIS, 2026-07-28/29): 345 mentions in the room log,
  // agents repeatedly reporting they never saw the one addressed to them, and a PM that ended up
  // writing open work to disk files and a shell watcher because the coordination channel could
  // not be relied on to deliver. Every one of those workarounds exists to replace these lines.
  //
  // This is a DOORBELL, NOT A DELIVERY. It uses mailbox.peek(), so nothing is consumed and
  // hive_wait/hive_check still hand over the full message with their cursor bookkeeping intact.
  // Reusing the mailbox also inherits its two hard-won behaviours for free: an agent is never
  // woken by its own hive_say, and repeat runs are collapsed instead of flooding.
  let lastMailSignal = 0
  hive.doc.getArray('chat').observe(() => {
    try {
      const s = session
      if (!s || !s.mailbox) return
      const m = s.mailbox.peek(hive.doc.getArray('chat').toArray())
      // Compare with !== rather than >: after hive_wait consumes the backlog the count drops to
      // 0, and a later single mention must still ring. `>` would go permanently silent.
      if (!m.mentioned || m.mentions.length === lastMailSignal) return
      lastMailSignal = m.mentions.length
      // THE CATCH BELOW DOES NOT COVER THIS CALL. `notification()` is async, so a failure inside
      // it is a REJECTED PROMISE, not a thrown exception -- it sails past the surrounding
      // try/catch, becomes an unhandled rejection, and takes the whole agent down. Observed
      // 19 Sep 2026: a second agent posting chat to a server whose transport was not connected
      // crashed the process from inside this Yjs observer, with the stack pointing at a `try`
      // that looked like it had the case covered.
      //
      // A doorbell that can kill the agent is strictly worse than no doorbell -- and this one is
      // already optional by design (custom MCP notifications are ignorable by spec), so the right
      // behaviour on any failure is silence.
      Promise.resolve(server.notification({
        method: 'notifications/hive_mail',
        params: {
          mentioned: true,
          priority: m.priority, // 'stop' when someone marked it urgent — handle before continuing
          count: m.mentions.length,
          from: [...new Set(m.mentions.map((x) => x && x.by).filter(Boolean))],
          latest: formatMessage(m.mentions[m.mentions.length - 1] || {}),
          hint: 'call hive_wait or hive_check to read it — this notification consumed nothing',
        },
      })).catch(() => { /* no transport, or a client that does not take notifications */ })
    } catch (e) {
      // client might not support notifications, swallow error
    }
  })

  // The sync engine writes HIVE_RULES.md into the folder on first sync — return it inline
  // so the agent gets the rules with its join. (Fixes a ReferenceError: `rules` was never
  // defined, which made every hive_join return "error: rules is not defined".)
  let rulesText = ''
  try { rulesText = fs.readFileSync(path.join(ROOT, 'HIVE_RULES.md'), 'utf8') } catch {}
  if (!rulesText) rulesText = 'Read HIVE_RULES.md in this folder. In short: read chat + board before editing; CLAIM a file with hive_claim before you edit it and hive_release when done; announce intent with hive_say; prefer small patches; act only on accepted tasks; resolve <<<<<<< conflict markers rather than blindly overwriting.'
  // The invite link carries the token when there is one — without it a secured room rejects
  // whoever you hand it to, and the Control Room says the link is missing its token.
  const inviteLink = `${relay}|${room}${useToken ? `|${useToken}` : ''}`
  return `${mode}\nroom: ${room}\nrelay: ${relay}\nfolder: ${ROOT}\nhivecode: ${VERSION}\nothers here: ${others.join(', ') || 'none yet'}\ninvite link: ${inviteLink}\n\nANNOUNCE YOUR VERSION: say "joined on hivecode ${VERSION}" in chat. Mixed builds in one room cause data loss, and this is the only way anyone finds out.\n\n--- FOLLOW THESE RULES ---\n${rulesText}`
}

function requireSession() { if (!session) throw new Error('not in a room — call hive_join first'); return session }
/** The read cursor for this participant. Lazily built if a session predates it. */
function mailbox() {
  const s = requireSession()
  // hive_join has just handed over the full HIVE_RULES.md, so the nudge would be pure noise on
  // the next wait. Marking it sent here is what makes the join and the reminder one mechanism
  // rather than two that disagree.
  try { throttle.sent('rules', RULES_NUDGE) } catch { }
  if (!s.mailbox) s.mailbox = createMailbox({ me: s.name, startAt: s.hive.doc.getArray('chat').length })
  return s.mailbox
}
function chatArray() { return requireSession().hive.doc.getArray('chat').toArray() }

// HIV-P11. Returns null rather than throwing when there is no session: a liveness stamp is an
// observation about a tool call, not part of it, and it must never be the reason a tool fails.
function activityMap() { try { return requireSession().hive.doc.getMap('activity') } catch { return null } }
// Names are matched case-insensitively everywhere else (mentionsName is /i), so a busy lookup
// keyed on the exact string would silently miss whenever a sender typed @sam for Sam.
function findBusy(map, name) {
  const want = String(name || '').toLowerCase()
  for (const [k, v] of map.entries()) if (String(k).toLowerCase() === want) return v
  return null
}
function boardMap() { const b = requireSession().hive.doc.getMap('board'); return [...b.entries()].map(([file, e]) => ({ file, ...e })) }
function taskList() { return [...requireSession().hive.doc.getMap('tasks').values()] }
const fmtTask = (t) => `${t.id} [${t.status}] ${t.by} -> ${t.to}: ${t.text}${t.decidedBy ? ` (by ${t.decidedBy})` : ''}`

// Block until there is approved work for me (or a new chat message), then return.
// This is how the agent reacts the INSTANT the owner approves — no polling loop,
// no interval to tune. Resolves immediately if approved work already exists.
/** WAKE ON STATE — the predicate that lets a roster run itself.
 *
 *  Without this, hive_wait only returns on work assigned TO you or a message naming you, so every
 *  multi-agent roster silently depends on agents remembering to @ each other after each step. The
 *  rules ASK them to (sync.js: "block on hive_wait until your specific state flag turns
 *  APPROVED/READY") and nothing MAKES them, so a night roster stalls with no error: the reviewer
 *  is asleep, the tests went green an hour ago, and nobody said so.
 *
 *  Shapes, all on one state key:
 *     { key: 'tests', is: 'GREEN' }            exactly this value
 *     { key: 'tests', in: ['GREEN', 'SKIP'] }  any of these
 *     { key: 'tests', not: 'RED' }             anything except this (INCLUDING unset)
 *     { key: 'tests' }                         any value at all, i.e. the key exists
 *
 *  `not` deliberately matches an unset key. A reviewer told "wake unless the build is RED" should
 *  wake on a fresh room where nobody has set `build` yet -- treating absent as RED would hang it
 *  forever waiting for a flag no one is going to write. */
export function stateMatches(until, get) {
  if (!until || !until.key) return false
  const v = get(until.key)
  if (Object.prototype.hasOwnProperty.call(until, 'is')) return String(v) === String(until.is)
  if (Array.isArray(until.in)) return until.in.some((x) => String(x) === String(v))
  if (Object.prototype.hasOwnProperty.call(until, 'not')) return String(v) !== String(until.not)
  return v !== undefined && v !== null
}

function waitForWork(timeoutMs, opts = {}) {
  const s = requireSession()
  const tmap = s.hive.doc.getMap('tasks')
  const chat = s.hive.doc.getArray('chat')
  const controls = s.hive.doc.getMap('controls')
  const me = s.name
  const box = mailbox()
  const paused = () => { const c = controls.get(me); return !!(c && c.state === 'paused') }
  const accepted = () => (paused() ? [] : [...tmap.values()].filter((t) => t.to === me && t.status === 'accepted'))
  // Deliver through the mailbox on EVERY return path. The old code captured a call-scoped
  // `baseChatLen` here and returned `chat.slice(baseChatLen)`, which meant anything posted
  // between one wait returning and the next one starting — the whole time the agent was
  // working — was returned by no path at all. Two paths also hardcoded `newChat: []`.
  const deliver = (extra) => { const got = box.take(chat.toArray()); persistCursor(); return { ...got, ...extra } }
  // Only wake for ambient chatter if asked to. Defaults to waking on anything, as before.
  const wakeOnMentionOnly = opts.wakeOn === 'mention'
  const mentionsMe = (t) => mentionsName(t, me)
  // PAUSED: stop auto-working, but STAY LISTENING. A paused agent doesn't pull its
  // queued work — yet it still wakes the moment it's directly addressed: a new
  // @mention in chat, or a new task assigned to it. It handles that, then calls
  // hive_wait again (still paused) until a human resumes it.
  if (paused()) {
    const baseTaskIds = new Set([...tmap.values()].filter((t) => t.to === me).map((t) => t.id))
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (!done) { done = true; controls.unobserve(onCtl); chat.unobserve(onChat); tmap.unobserve(onTask); resolve(v) } }
      const directTasks = () => [...tmap.values()].filter((t) => t.to === me && t.status === 'accepted' && !baseTaskIds.has(t.id))
      const check = () => {
        // Resumed: hand over the backlog too. This path returned `newChat: []`, so an agent
        // came back from a pause having silently lost everything said while it was paused.
        if (!paused()) return finish(deliver({ tasks: accepted(), resumed: true }))
        const dt = directTasks()
        if (dt.length) return finish(deliver({ paused: true, mentioned: true, tasks: dt }))
        // A paused agent stays deaf to chatter but wakes when directly addressed. Unchanged,
        // except the messages come from the mailbox now, so none are skipped.
        if (box.peek(chat.toArray()).mentioned) finish(deliver({ paused: true, tasks: [] }))
      }
      const onCtl = check, onChat = check, onTask = check
      controls.observe(onCtl); chat.observe(onChat); tmap.observe(onTask)
      setTimeout(() => finish({ paused: true }), timeoutMs)
    })
  }
  // Queued work no longer hides the mail. This returned `newChat: []` outright, which made
  // the busiest agent in the room the one guaranteed to see no messages at all.
  // A state the caller is waiting for, checked BEFORE anything blocks: if it is already true the
  // agent must not sit through a timeout waiting to be told something that happened an hour ago.
  const state = s.hive.doc.getMap('swarm_state')
  const until = opts.until && opts.until.key ? opts.until : null
  const stateHit = () => stateMatches(until, (k) => state.get(k))
  if (until && stateHit()) return Promise.resolve(deliver({ tasks: accepted(), stateReached: { ...until, value: state.get(until.key) } }))

  const ready = accepted()
  if (ready.length) return Promise.resolve(deliver({ tasks: ready }))
  // Anything already unread is handed over immediately rather than waited past — that backlog
  // is exactly what used to be unreachable.
  if (box.hasUnread(chat.toArray())) {
    const pending = box.peek(chat.toArray())
    if (!wakeOnMentionOnly || pending.mentioned) return Promise.resolve(deliver({ tasks: [] }))
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; tmap.unobserve(onTask); chat.unobserve(onChat); controls.unobserve(onCtl); if (until) { try { state.unobserve(onState) } catch { /* never observed */ } } resolve(v) } }
    const onTask = () => { const a = accepted(); if (a.length) finish(deliver({ tasks: a })) }
    const onChat = () => {
      const seen = box.peek(chat.toArray())
      if (!seen.unreadCount) return                      // only this agent's own messages — not mail
      if (wakeOnMentionOnly && !seen.mentioned) return    // ambient chatter, and the caller opted out
      finish(deliver({ tasks: accepted() }))
    }
    const onCtl = () => { if (paused()) finish({ paused: true }) } // paused mid-wait -> stop handing out work
    // A paused agent is NOT woken by state: pausing means stop picking up work, and a state flag
    // turning green is the room offering it work. It re-checks the predicate on its next wait
    // after a human resumes it.
    const onState = () => { if (until && !paused() && stateHit()) finish(deliver({ tasks: accepted(), stateReached: { ...until, value: state.get(until.key) } })) }
    tmap.observe(onTask); chat.observe(onChat); controls.observe(onCtl); if (until) state.observe(onState)
    // On timeout, flush anything that arrived rather than dropping it: a message must never
    // expire unread just because the wait window closed on it.
    setTimeout(() => finish(box.hasUnread(chat.toArray()) ? deliver({ tasks: accepted() }) : null), timeoutMs)
  })
}

const TOOLS = [
  { name: 'hive_join', description: 'Join (or host) a Hivecode room for a project folder. Joins automatically as an AI participant. If a join link is given, uses it; else reads <dir>/.hive.json; else hosts a new room. Returns the room info and the HIVE_RULES you must follow.',
    inputSchema: { type: 'object', properties: { link: { type: 'string', description: 'optional join link "wss://relay|room"' }, dir: { type: 'string', description: 'project folder to sync (default ./workspace)' }, name: { type: 'string', description: 'your display name in the room' }, owner: { type: 'string', description: 'the human responsible for you — only they may approve tasks directed at you' }, token: { type: 'string', description: 'access token for a secured room (else uses $HIVE_TOKEN). Required only if the relay runs in auth-required mode.' }, kind: { type: 'string', description: 'participant kind (ai or human)' }, passive: { type: 'boolean', description: 'true = this participant is a passive listener or bot daemon and does not take turns or answer questions' } } } },
  { name: 'hive_assign', description: 'Direct a task at another participant by name (e.g. ask another agent to work on a file). If the target is an AI with an owner, it stays PENDING until that owner approves.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'participant name to assign to' }, text: { type: 'string', description: 'what to do' } }, required: ['to', 'text'] } },
  { name: 'hive_read_tasks', description: 'Read tasks. Shows tasks directed at YOU (act only on accepted ones) and all pending tasks awaiting approval.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_wait', description: 'BLOCK until there is approved work for you, unread mail arrives, or a project-state flag you named reaches the value you are waiting for — then return all of it. Use this as your main loop: call hive_wait; do the work; hive_complete; call hive_wait again. Returns instantly if any of those is ALREADY true, so nothing that happened while you were busy can be missed. Pass `until` to wait on the state machine instead of on somebody remembering to message you — that is how a roster runs itself overnight: the tester sets tests=GREEN, and the reviewer waiting on it wakes by itself.',
    inputSchema: { type: 'object', properties: { timeoutSeconds: { type: 'number', description: 'max seconds to wait (default 60, max 300)' }, wakeOn: { type: 'string', enum: ['any', 'mention'], description: "'any' (default) wakes on any new message; 'mention' only wakes when you are @mentioned or assigned a task — use it in a noisy room. Ambient messages are still delivered on the next wake either way, never dropped." }, until: { type: 'object', description: 'wake when a GLOBAL PROJECT STATE key reaches a value. { key, is } for one exact value, { key, in: [...] } for any of several, { key, not } for anything else (an unset key counts as "not"), or { key } alone for "as soon as this is set at all". The result carries stateReached with the value that fired.', properties: { key: { type: 'string' }, is: { type: 'string' }, in: { type: 'array', items: { type: 'string' } }, not: { type: 'string' } }, required: ['key'] } } } },
  { name: 'hive_check', description: 'NON-BLOCKING: is anyone calling me? Returns unread messages addressed to you, plus approved work, and returns immediately. Call this between edits during a long task — that is the whole point: hive_wait blocks, so it cannot be used while you are working, and this can. If it reports priority "stop", deal with that BEFORE continuing what you were doing.',
    inputSchema: { type: 'object', properties: { peek: { type: 'boolean', description: 'true = look without marking messages read (default false: reading them here counts as read)' } } } },
  { name: 'hive_approve', description: 'Approve a pending task (you must be the owner of the target AI). The AI may then act on it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_deny', description: 'Deny a pending task (you must be the owner of the target AI).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_complete', description: 'Mark a task you were doing as done (optionally with a note).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_say', description: 'Post a coordination message to the room chat. Use this to announce what you are about to work on BEFORE editing (e.g. "taking auth.js: adding login"). Address someone directly with @Name — that is what makes it land as mail rather than ambient chatter. Set urgent:true when you need them to stop what they are doing. Set needsReply:true when you are ASKING something — the room then tracks that you are owed an answer, and tells you if you addressed somebody who is not here.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'the message' }, urgent: { type: 'boolean', description: 'true = prefix [!] so the recipient treats it as "handle before continuing", not "read at your next boundary"' }, needsReply: { type: 'boolean', description: 'true = this is a QUESTION and you are owed an answer. Records an obligation against everyone you named. It stays open until YOU call hive_answered -- the person you asked cannot close it, and answering is not closing. If you named someone who is not in the room you are told so immediately, instead of waiting forever.' }, replyWithinMinutes: { type: 'number', description: 'how long before you are reminded (default 10). The reminder arrives on a hive_wait you were going to make anyway, so it costs nothing.' } }, required: ['text'] } },
  { name: 'hive_delivered', description: 'Did anyone actually READ what you said? "sent" only means the message entered your local copy. This reports, per recipient: READ (their read position passed it — real evidence), UNREAD (they are here and behind), UNKNOWN (they publish no read position, e.g. a bridge or a human client — so their silence means NOTHING either way), UNREACHABLE (they left, or you are offline). Read it before concluding an agent is ignoring you, and before believing a handoff landed.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'how many of your recent addressed messages to check (default 10)' } } } },
  { name: 'hive_answered', description: 'Close a question YOU asked with needsReply — you are saying you got what you needed. Only the asker can call this: the agent you asked cannot mark its own answer sufficient, and a reply alone does not close anything. Pass id for one, or from:"Name" to close everything you asked that agent.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'the obligation id from hive_say or hive_owed' }, from: { type: 'string', description: 'close every open question you asked this agent' } } } },
  { name: 'hive_owed', description: 'Who owes an answer to whom, and for how long. Read this when the room has gone quiet: an agent that stopped replying looks exactly like an agent that is thinking, and this is the difference. Shows questions aimed at YOU (answer these) and questions you asked (close these with hive_answered). Anything marked STALE has been reminded three times and is now the room\'s problem, not one agent\'s.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'true = the whole room, not just yours' } } } },
  { name: 'hive_busy', description: 'Tell the room you are mid-task, so anyone who @mentions you is told to expect a delay AT THE MOMENT THEY SEND, instead of waiting on a reply that is not coming yet. This posts no message and silences nothing — you still receive mail and must still call hive_check between edits. It expires by itself, so a crash cannot leave you permanently "busy". Clear it when you finish.',
    inputSchema: { type: 'object', properties: { what: { type: 'string', description: 'what you are working on, in a few words — the sender reads this' }, minutes: { type: 'number', description: 'how long to hold it (default 10). It expires on its own either way.' }, clear: { type: 'boolean', description: 'true = I am free again' } } } },
  { name: 'hive_read_chat', description: 'Read the room conversation. Read this to see what humans and other agents are doing before and while you work. Use mentioningMe to recover only what was addressed to you.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'how many recent messages (default 30)' }, mentioningMe: { type: 'boolean', description: 'true = only messages that @mention you, across the whole room history — use this to recover your own backlog' }, unreadOnly: { type: 'boolean', description: 'true = only what you have not been handed yet (does not mark it read)' } } } },
  { name: 'hive_read_board', description: 'Read recent whole-file rewrites (who rewrote what, which symbols). Read this before editing a file — if it was just rewritten, re-read the file first.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_claim', description: 'CLAIM a file (or region) BEFORE you edit it, so other agents flow around you instead of colliding. Returns whether you got it — if false, someone else holds it: work on something else. Claims auto-expire, so call hive_release when done (or it frees itself).',
    inputSchema: { type: 'object', properties: { region: { type: 'string', description: 'the file path (or region id) you want to edit' }, intent: { type: 'string', description: 'short note on what you intend to do' } }, required: ['region'] } },
  { name: 'hive_release', description: 'Hand a file back so other agents can take it. If the room has set a gate, this RUNS it in your folder first and a failing check REFUSES the handoff — you keep the file, nobody else can take it, and retrying will not help. Fix what the gate reported, or pass force with a reason if you are abandoning the work (recorded against your name and announced).',
    inputSchema: { type: 'object', properties: {
      region: { type: 'string', description: 'the file path (or region id) to release' },
      force: { type: 'boolean', description: 'release even though the gate failed. Recorded against your name in the room and posted to chat — use it for abandoned work, never to get past a failing check.' },
      why: { type: 'string', description: 'why the work is being abandoned. Give this whenever force is true; a forced release with no reason is recorded as exactly that.' },
    }, required: ['region'] } },
  { name: 'hive_claims', description: 'See what every agent is currently working on (the live claim board). Read this to pick open work and avoid taken regions.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_edit', description: 'Write a file THROUGH the medium (preferred over editing on disk): your intent and exact change are cryptographically stamped into the provenance ledger at the instant of writing — race-free — then merged and synced like any edit. Claim the file first with hive_claim; pass your intent here too so the WHY travels with the change.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'relative file path in the room' }, content: { type: 'string', description: 'the complete new file content' }, intent: { type: 'string', description: 'WHY you are making this change (signed into provenance)' } }, required: ['file', 'content'] } },
  { name: 'hive_fork', description: 'Read an active SILENT FORK on a file as a resolvable object: the common base plus EVERY divergent version with its author and cryptographically signed intent (the WHY). Call this when chat announces a fork, then reconcile both intents and submit via hive_resolve.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'the forked file path (as announced in chat)' } }, required: ['file'] } },
  { name: 'hive_resolve', description: 'Resolve an active fork by submitting the FULL reconciled file content — code that serves EVERY side\'s signed intent (read them with hive_fork), not just one winner. The medium VALIDATES your proposal with ICR (must parse, no dangling references) before it lands; a broken proposal is refused and nothing changes. On success the resolution is signed by you, synced to every peer, and announced.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'the forked file path' }, code: { type: 'string', description: 'the complete resolved file content (no <<<<<<< markers)' } }, required: ['file', 'code'] } },
  { name: 'hive_members', description: 'List who is currently in the room (humans and AI agents).', inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_status', description: 'Show the current session (room, relay, folder, name).', inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_leave', description: 'Leave the room and stop syncing.', inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_set_state', description: 'PM ONLY: Set a global project state flag (e.g. key="contract", val="READY"). This physically unblocks/blocks other agents. WARNING: ONLY use short enum values. Do NOT use this to store paragraphs of text or code, as it will bloat the context window. Use files for text.', inputSchema: { type: 'object', properties: { key: { type: 'string' }, val: { type: 'string' } }, required: ['key', 'val'] } },
  { name: 'hive_read_state', description: 'Read the global project state flags.', inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_set_schema', description: 'PM ONLY: Define strict JSON schema validation for a global state key. Beyond `enum` you can make it a real state MACHINE: `transitions` ({"READY":["IN_PROGRESS"]}) says which moves are legal at all, and `requires` ({"LIVE":{"suppression_ui":"APPROVED"}}) says what must already be true to arrive at a value — which is how you make a release gate hold by construction instead of by everyone remembering it. Example: rules={"enum":["PLANNING","READY","APPROVED"],"transitions":{"PLANNING":["READY"],"READY":["APPROVED"],"APPROVED":[]},"requires":{"APPROVED":{"tests":"GREEN"}}}', inputSchema: { type: 'object', properties: { key: { type: 'string' }, rules: { type: 'object' } }, required: ['key', 'rules'] } },
  { name: 'hive_attest', description: 'Record what YOUR folder actually holds for a file, so the room can tell whether peers agree. Measure it yourself (bytes and lines) and report. If another peer has attested a DIFFERENT size, everyone is warned immediately — that disagreement is the point. Use it after publishing a file, and when asked to confirm somebody else\'s publish. Two matching attestations from different peers is the only real proof a write landed; your own folder shows your own write whether or not it propagated.', inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'workspace-relative path' }, bytes: { type: 'number', description: 'exact byte count in YOUR folder' }, lines: { type: 'number', description: 'line count in YOUR folder' } }, required: ['file', 'bytes'] } },
  { name: 'hive_verified', description: 'Has a file been independently confirmed? Returns every peer\'s attested size, whether they DISAGREE, and whether quorum is reached (2+ peers, same bytes). Check this before trusting that a publish landed, and before building on a file somebody else wrote.', inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
]

// The state machine's enforcement point. Three separate gates, and each one exists because a rule
// written in prose was read by four capable agents and then broken anyway (JARVIS, 2026-07-29).
//
//   1. LOCKED           the original gate — you may work, you may not publish
//   2. PUBLISH:<n>      a LEASED grant: n writes, decremented by the server, auto-closes at zero
//   3. path:<p>=POISONED a path nobody may write, ever, for as long as the flag stands
//
// `opts.consumes` marks a tool as spending a lease (the write tools). `opts.path` is the region it
// would write, checked against the path gate.
function enforceDcoLock(opts = {}) {
  const s = requireSession()
  const state = s.hive.getState()
  const name = s.name
  const status = state[`${name}_status`]

  // --- gate 3: the path itself may be untouchable, regardless of who you are -------------------
  // Attached to the RESOURCE, not the ACTOR, and that is the new idea here. Every other guard in
  // this system asks "may this agent write?"; none could express "this file must never be written
  // again by anyone." That question has a real answer: a path whose delete has propagated is
  // poisoned — writing it silently resurrects the old content over the new, or leaves two folders
  // permanently disagreeing with no marker and no warning. Tonight that fact lived in a markdown
  // file that agents had to remember to read, and the PM ordered a live credential route deleted
  // anyway. A flag in the state map cannot be forgotten.
  // FIVE VALUES, BECAUSE EACH ONE IMPLIES A DIFFERENT ACTION. A single POISONED flag was the first
  // design and it was wrong — @Claude-Engine caught it live: `path:engine/brain/llm.js = POISONED`
  // was FALSE in its folder, where that path held the correct 8,012-byte file while mine held a
  // 22,312-line wreck. Marking it globally poisoned broadcast ONE FOLDER'S REALITY as room truth,
  // inside the one channel every agent trusts. Its objection is the rule: a per-folder fact must
  // never be stored as a global one.
  //
  //   LIVE / OPEN         default. Writable under the normal one-spaced-write rule.
  //   SUPERSEDED          clean, valid code that has been REPLACED. Read freely, do not import, do
  //                       not write. Distinct from corruption: calling hn.js "poisoned" would send
  //                       the next agent rewriting a file that is perfectly fine.
  //   CORRUPT             content unusable in every folder that has measured it. Do not read it as
  //                       reference; publish the replacement to a NEW path.
  //   DIVERGED            peers hold DIFFERENT bytes. Nobody writes until it is reconciled, because
  //                       there is no single truth to write on top of. Use hive_attest to establish
  //                       who holds what — that is what it is for.
  //   DELETED_UNWRITABLE  a delete propagated. Writes here vanish or silently resurrect the old
  //                       content. Never write, never delete, new path only. Globally true.
  if (opts.path) {
    const ps = state[`path:${String(opts.path)}`]
    const stop = {
      POISONED: `[Path Poisoned] ${opts.path} must NOT be written. Publish to a NEW path instead. (Legacy flag — prefer DELETED_UNWRITABLE / CORRUPT / DIVERGED, which say WHY.)`,
      DELETED_UNWRITABLE: `[Path Unwritable] ${opts.path} had a delete propagate. A write here vanishes or silently resurrects the deleted content, and two folders end up permanently disagreeing with no marker. Never write it and never delete it again — publish to a NEW path.`,
      CORRUPT: `[Path Corrupt] ${opts.path} is unusable in every folder that has measured it. Do not write it and do not read it as reference — build the replacement out-of-tree and publish it to a NEW path.`,
      DIVERGED: `[Path Diverged] peers hold DIFFERENT bytes for ${opts.path}, so there is no single truth to write on top of. Call hive_attest to record what YOUR folder holds and see who disagrees. Nobody writes this path until it is reconciled.`,
      FROZEN: `[Path Frozen] ${opts.path} is frozen by the state machine. Ask the owner to set path:${opts.path}=LIVE before writing it.`,
    }
    if (ps && stop[ps]) throw new Error(stop[ps])
    // An unrecognised value fails CLOSED. A safety registry that silently ignores a flag it does not
    // understand is worse than no registry, because agents will trust it — and a 0.9.0 client
    // ignoring these flags entirely is already the known hole here.
    if (ps && ps !== 'LIVE' && ps !== 'OPEN') {
      throw new Error(`[Path Restricted] path:${opts.path} is set to "${ps}", which this build does not recognise. Refusing the write rather than guessing. Ask the room what it means, or have the owner set it to LIVE.`)
    }
  }

  if (status === 'LOCKED' || state[`${name}_locked`] === 'true') {
    throw new Error(`[DCO Enforced] You are locked by the global state machine. Tool execution denied. Block on hive_wait until your status changes.`)
  }

  // --- gate 2: leased publication grants -------------------------------------------------------
  // "One clean write per path" was the single most expensive lesson of the JARVIS build: a file
  // written once landed byte-perfect in every folder (7 for 7), and a file written twice in quick
  // succession was destroyed (333 -> 22,312 lines; 104 -> 70,881). Stated as a protocol it was
  // violated within the hour by everyone including its author. A COUNTED lease makes the second
  // write impossible rather than discouraged: the server spends it, and the window shuts itself.
  const lease = /^PUBLISH(?::(\d+))?$/.exec(String(status || ''))
  if (lease && opts.consumes) {
    const left = lease[1] === undefined ? 1 : Number(lease[1])
    if (left <= 0) {
      throw new Error(`[Lease Spent] Your PUBLISH window is used up. Ask for a new one — and if this is a revision of what you just wrote, publish to a NEW path rather than rewriting it.`)
    }
    const next = left - 1
    try {
      s.hive.setState(`${name}_status`, next > 0 ? `PUBLISH:${next}` : 'LOCKED')
    } catch (e) {
      // A schema whose transitions forbid the auto-close must not strand the agent mid-write, and
      // must not silently leave the window open either. Say it loudly and let the write proceed.
      try { s.hive.say(`[!] lease for ${name} could not auto-close (${e.message}) — treat the window as SPENT and do not write again.`) } catch { }
    }
  }
}

// Bumped from 0.8.0 when message delivery changed (see hive-mailbox.js). Two builds with the
// same version number but different delivery behaviour is precisely the mixed-build room that
// breaks rooms — and the standing rule "report your Hivecode version when you join" cannot work
// if the builds are indistinguishable. So the version is reported on join and by hive_status.
// 0.10.0 — mail now rides out on EVERY tool result (mailBanner), the DCO gate gained leased
// PUBLISH:<n> grants and per-PATH poisoning, setState became a real state machine (transitions +
// requires), and hive_attest/hive_verified were added. Delivery behaviour changed, so by the rule
// stated directly above this line the version MUST move: a 0.9.0 room and a 0.10.0 room disagree
// about how a message reaches a working agent, and that is exactly the mixed-build condition that
// breaks rooms. Two builds that behave differently must never share a number.
// 0.11.1 -- what this client SENDS to the relay changed: sync.js now passes `name` and `kind`
// as connection params so the relay can record who is in a room and how many at once (it
// previously stamped every connection `anon`/`unknown` and could not tell an agent from a
// person). By the rule above that is a delivery-behaviour change, and it is the kind that
// matters most here: an 0.10.0 client in a room with an 0.11.1 one is invisible in the audit
// log while its roommate is named, so the room's own membership record disagrees with itself.
// Also carries the ICR fix that stopped a whole-file rewrite duplicating every declaration.
// VERSION is load-bearing, not cosmetic: the join message (see buildJoinReply) instructs every
// arriving agent to announce it in chat, because a MIXED BUILD in one room causes data loss and
// this is the only way anyone finds out. Hardcoding it meant that the moment package.json was
// bumped the two disagreed silently -- so the one mechanism for detecting a mixed build was
// itself reporting the wrong build. Read the truth instead; package.json always ships in the
// tarball and sits beside this file in both the repo and the published package.
// A failed read must never stop the server from starting, so it falls back rather than throwing.
import { VERSION } from "./hive-version.js"
export { VERSION }
// `instructions` is placed in the agent's SYSTEM PROMPT by the client at connect time, which
// makes it the only channel that reaches an agent before its first tool call. Everything else we
// have -- tool descriptions, the HIVE_RULES returned by hive_join -- is read too late or scrolls
// away, and the rule that matters most (hive_wait is your idle state; ending your turn makes you
// unreachable) is exactly the one an agent needs up front. See hive-instructions.js.
const server = new Server(
  { name: 'hivecode', version: VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
async function dispatch(req) {
  const { name, arguments: args = {} } = req.params
  try {
    // AUTO-RESUME: the MCP host may restart this server process at any time, which
    // wipes the in-memory session and silently kicks the agent out of its room. If a
    // persisted session exists for this cwd, transparently rejoin before any tool runs —
    // the agent (and its human) never see a "not in a room" flake again.
    if (!session && name !== 'hive_join' && name !== 'hive_leave') await tryResumeSession()
    // HIV-P11. STAMPED BEFORE THE TOOL RUNS, not after it returns.
    //
    // The first version stamped in a `finally` -- which is wrong by exactly one call, and the
    // suite caught it: an agent that called hive_members saw ITSELF reported PARKED, because the
    // record it read still held the timestamp of its previous call. The activity is the call
    // BEGINNING; a tool that takes four minutes is working for all four of them, and a tool that
    // throws was still an agent doing something. Stamping first covers both, and covers every
    // tool anyone adds later, because there is no path into the switch that skips this line.
    //
    // hive_wait stamps its own entry and exit (waitingSince must mean "inside the call RIGHT
    // NOW"). hive_leave drops the row instead of refreshing it. hive_join has no session yet, so
    // it is stamped in the finally below -- the one case where after is the only option.
    if (session && name !== 'hive_wait' && name !== 'hive_leave') {
      try { ACT.noteAction(activityMap(), { name: session.name, tool: name }) } catch { }
    }
    switch (name) {
      case 'hive_join': return text(await joinRoom(args))
      case 'hive_say': {
        // THE CONNECTION IS CHECKED BEFORE ANYTHING ELSE. Until today this tool reported
        // "sent to @Builder: ..." with the socket down, which is a false success in the most
        // literal sense: the bytes are in a local Yjs doc, the relay has never seen them, and the
        // word the agent reads is the same word it reads on success. status().connected was
        // right there and free the whole time.
        const sendConn = (() => { try { return requireSession().hive.status() } catch { return null } })()
        const sendWarn = RC.sendWarning({ connected: !sendConn || !!sendConn.connected })
        const stamp = (t) => (sendWarn ? `${sendWarn}\n\n${t}` : t)
        const raw = String(args.text || '')
        // The marker is in the text itself so it survives into HIVE_CHAT.md and is visible to
        // a human reading the log, not just to the recipient's tool output.
        const body = args.urgent && !/^\s*\[!\]/.test(raw) ? `[!] ${raw}` : raw
        requireSession().hive.say(body)
        // ADDRESSING IS THE PROTOCOL, and a rule an agent merely read is a rule it forgets once
        // its context fills. So the tool itself answers back: a message that named nobody is
        // reported as landing in everyone's ambient digest, where it is meant to be skipped.
        // Immediate, per-call feedback, at the moment the mistake is made.
        const named = mentionedNames(body)
        if (!named.length) {
          return text(stamp(`sent: ${body}`) + `\n\nNOBODY WAS ADDRESSED. This went to every agent's "room ` +
            `activity", where they are told to skip it — so assume no one acts on it. Name the ` +
            `agents you actually need with @Name (hive_members lists who is here). Use an ` +
            `unaddressed message only for a genuine announcement to the whole room.`)
        }
        // WHO IS ACTUALLY GOING TO READ THIS. The sender is the only participant who can act on
        // "they left" or "they are mid-task", and it is worth strictly more here than in a
        // reply: it arrives before the sender starts waiting, and it costs the room no message.
        // This is the whole reason busy is state rather than an auto-reply (see hive-busy.js).
        const s = requireSession()
        const members = s.hive.members()
        const memberMap = new Map(members.map((m) => [String(m.name).toLowerCase(), m]))
        const present = new Set(members.map((m) => String(m.name).toLowerCase()))
        const busyMap = s.hive.doc.getMap('busy')
        const notes = named
          .filter((n) => n.toLowerCase() !== 'all' && n.toLowerCase() !== s.name.toLowerCase())
          .map((n) => describeRecipient(n, findBusy(busyMap, n), present.has(n.toLowerCase())))
          .filter(Boolean)
        const to = mentionsAll(body) ? 'the whole room (@all)' : named.map((n) => '@' + n).join(', ')
        // NEEDS REPLY. A question is recorded, not just spoken. One obligation per agent named.
        // HIV-P6: If the room knows nobody will answer, DO NOT record a debt.
        //   1. Absent names: warned immediately, ZERO obligations opened.
        //   2. Passive listeners (bot daemons, wake listeners): warned immediately, ZERO obligations opened.
        //   3. Active participants: real debt opened, dischargeable ONLY by the asker.
        //   4. @all broadcast: targets only active non-passive AI agents in the room.
        let obStr = ''
        if (args.needsReply) {
          const obMap = s.hive.doc.getMap('obligations')
          const dueMs = Math.max(1000, (Number(args.replyWithinMinutes) || 10) * 60000)

          const everHere = new Set(present)
          for (const m of s.hive.doc.getArray('chat').toArray()) {
            if (m && m.by) everHere.add(String(m.by).toLowerCase())
          }

          let activeTargets = []
          let awayTargets = []
          let neverSeenNames = []
          let passiveNames = []

          if (mentionsAll(body)) {
            activeTargets = members
              .filter((m) => String(m.name).toLowerCase() !== s.name.toLowerCase() && !m.passive && m.kind === 'ai')
              .map((m) => String(m.name))
          } else {
            const candidateNames = named.filter((n) => n.toLowerCase() !== 'all' && n.toLowerCase() !== s.name.toLowerCase())
            const seen = new Set()
            for (const n of candidateNames) {
              const lc = n.toLowerCase()
              if (seen.has(lc)) continue
              seen.add(lc)
              const mem = memberMap.get(lc)
              if (mem) {
                if (mem.passive) {
                  passiveNames.push(mem.name || n)
                } else {
                  activeTargets.push(mem.name || n)
                }
              } else {
                if (everHere.has(lc)) {
                  awayTargets.push(n)
                } else {
                  neverSeenNames.push(n)
                }
              }
            }
          }

          const openedActive = activeTargets.map((n) => OB.open(obMap, {
            from: s.name, to: n, text: body, dueMs,
            absent: false,
            neverSeen: false,
          }))

          const openedAway = awayTargets.map((n) => OB.open(obMap, {
            from: s.name, to: n, text: body, dueMs,
            absent: true,
            neverSeen: false,
          }))

          const opened = [...openedActive, ...openedAway]

          if (opened.length) {
            obStr += `\n\nYOU ARE OWED AN ANSWER — ${opened.map((o) => `${o.id} (${o.to})`).join(', ')}\n` +
              `This stays open until YOU call hive_answered. The agent you asked cannot close it, and ` +
              `a reply does not close it either — you decide whether you were actually answered. If it ` +
              `is still open in ${Math.round(dueMs / 60000)} min you will be reminded on your next hive_wait.`
          }
          if (awayTargets.length) {
            obStr += `\n\n⚠ ${awayTargets.map((n) => '@' + n).join(', ')} — AWAY RIGHT NOW. Not connected at the moment, but has worked here before; obligation recorded for when they return.`
          }
          if (neverSeenNames.length) {
            obStr += `\n\n⚠ ${neverSeenNames.map((n) => '@' + n).join(', ')} — NOT IN THIS ROOM. Nobody by that ` +
              `name is here, so nobody is going to answer. Call hive_members and re-address it now; ` +
              `this is the one failure mode that otherwise costs you a whole shift.`
          }
          if (passiveNames.length) {
            obStr += `\n\n⚠ ${passiveNames.map((n) => '@' + n).join(', ')} — PASSIVE LISTENER. This process does not take turns or answer questions; no obligation recorded.`
          }
        }
        return text(stamp(`sent to ${to}: ${body}`) + (notes.length ? '\n\n' + notes.join('\n') : '') + obStr)
      }
      case 'hive_busy': {
        const s = requireSession()
        const busyMap = s.hive.doc.getMap('busy')
        if (args.clear) { busyMap.delete(s.name); return text('busy cleared — the room will expect normal replies from you again') }
        const e = makeBusy(args.what, { ttl: args.minutes ? args.minutes * 60000 : undefined })
        busyMap.set(s.name, e)
        // Say what it does NOT do, because an agent that believes this silences its mail will
        // stop calling hive_check and go deaf on purpose.
        return text(`marked busy: ${e.what}\n\nThis posts no message and silences nothing — you still ` +
          `receive mail and must still call hive_check between edits. It only tells anyone who ` +
          `@mentions you, at the moment they send, that you are mid-task. It expires by itself in ` +
          `${Math.round(e.ttl / 60000)} minutes, so a crash cannot leave the room believing you are ` +
          `permanently busy. Call hive_busy with clear:true when you finish.`)
      }
      case 'hive_read_chat': {
        const me = requireSession().name
        const all = chatArray()
        if (args.mentioningMe) {
          // Backlog recovery: the whole history, filtered to what was addressed to you. This
          // is what the PM agent had to do by hand with grep when delivery failed.
          const mine = all.filter((m) => mentionsName(m.text, me))
          if (!mine.length) return text('(nothing in this room has @mentioned you)')
          return text(`${mine.length} message(s) addressed to you:\n` + mine.map(formatMessage).join('\n'))
        }
        if (args.unreadOnly) {
          const seen = mailbox().peek(all)
          if (!seen.unreadCount) return text('(nothing unread)')
          return text(`${seen.unreadCount} unread (still marked unread — hive_check or hive_wait will hand these over):\n` + seen.messages.map(formatMessage).join('\n'))
        }
        const n = args.limit || 30
        const msgs = all.slice(-n).map((m) => `${m.at} ${m.by}(${m.kind}): ${m.text}`)
        return text(msgs.join('\n') || '(no messages yet)')
      }
      case 'hive_check': {
        const s = requireSession()
        const all = chatArray()
        const box = mailbox()
        const got = args.peek ? box.peek(all) : box.take(all)
        if (!args.peek) persistCursor()
        const tasks = [...s.hive.doc.getMap('tasks').values()].filter((t) => t.to === s.name && t.status === 'accepted')
        // WHO IS STILL WAITING ON YOU. Read mail is not answered mail: the cursor advances the
        // moment a message is handed over, so an agent can absorb a direct question, get busy,
        // and never notice it left someone hanging -- which is the failure that made a previous
        // room's PM give up on this channel and tail the chat file with a shell script instead.
        // Derived from the log, so it needs no state and cannot drift.
        const owed = unansweredFor(all, s.name)
        const owedLine = owed.length
          ? `\n\n⏳ STILL WAITING ON A REPLY FROM YOU: ${owed.map((o) => '@' + o.from).join(', ')}. ` +
            `Answer with hive_say (name them), even if the answer is "not yet, I am on X" — ` +
            `silence is the one thing they cannot act on.`
          : ''
        if (!got.unreadCount && !tasks.length) {
          return text(owed.length
            ? `✓ no new mail and no approved work.${owedLine}`
            : '✓ nothing waiting — nobody is calling you and you have no approved work. Carry on.')
        }
        const parts = []
        if (got.priority === 'stop') {
          // HANDLING URGENT MAIL COUNTS AS LIVENESS.
          //
          // Claims evaporate after 5 minutes so a crashed agent never deadlocks the room.
          // But an agent that is preempted -- told to stop and deal with something else --
          // is not crashed, it is obeying. Without this refresh it loses the file it was
          // halfway through editing WHILE DOING WHAT IT WAS ASKED, another agent takes the
          // claim, and it resumes writing into a region it no longer owns. The agent gets
          // punished for complying, and the resulting clobber looks like a merge bug.
          //
          // Re-claiming a region you already hold is safe: acquire() only defers when a
          // DIFFERENT owner holds it, so this refreshes `at` and never steals.
          //
          // One refresh buys another full TTL. A long interruption stays safe because the
          // rules have the agent calling hive_check between steps of the urgent work too.
          try {
            for (const c of s.hive.claimsBoard()) {
              if (c.by === s.name) s.hive.claim(c.region, c.intent || 'edit')
            }
          } catch { /* delivering the urgent message matters more than the refresh */ }
          parts.push('🛑 URGENT — someone needs you to STOP what you are doing and handle this FIRST:')
          parts.push('(your claims were just refreshed — the files you hold stay yours while you deal with this)')
          parts.push(got.mentions.filter((m) => priorityOf(m.text) === 'stop').map(formatMessage).join('\n'))
        } else if (got.mentioned) {
          parts.push(`📣 ${got.mentions.length} message(s) addressed to YOU — answer at your next safe stopping point:`)
          parts.push(got.mentions.map(formatMessage).join('\n'))
        }
        const ambient = got.messages.filter((m) => !mentionsName(m.text, s.name))
        const dig = ambientDigest(ambient)
        if (dig) parts.push(dig)
        if (tasks.length) parts.push(`approved work queued for you:\n${tasks.map(fmtTask).join('\n')}`)
        return text(parts.join('\n\n') + owedLine)
      }
      case 'hive_read_board': { const b = boardMap(); return text(b.length ? b.map((e) => `${e.at} ${e.by} rewrote ${e.file} (${e.churn}) — touched: ${(e.symbols || []).join(', ')}`).join('\n') : '(no rewrites logged)') }
      case 'hive_assign': { enforceDcoLock(); const id = requireSession().hive.assign(String(args.to || ''), String(args.text || '')); return id ? text(`assigned task ${id} to ${args.to} (pending approval if they have an owner)`) : err('need to and text') }
      case 'hive_read_tasks': {
        const all = taskList(); const me = requireSession().name
        const mine = all.filter((t) => t.to === me)
        const pending = all.filter((t) => t.status === 'pending')
        return text(`TASKS FOR YOU (act only on 'accepted'):\n${mine.map(fmtTask).join('\n') || '(none)'}\n\nPENDING (awaiting approval):\n${pending.map(fmtTask).join('\n') || '(none)'}`)
      }
      case 'hive_wait': {
        const ms = Math.min(Math.max(Number(args.timeoutSeconds) || 60, 1), 300) * 1000
        // HIV-P11. `waitingSince` means "inside this call right now", never "waited at some
        // point", and the finally is what keeps that true. A wait that returns or throws while
        // leaving the flag set describes an agent parked in a call it has already left -- and
        // describes it as WAITING, the single most reassuring state in the taxonomy. stateOf()
        // gates WAITING on awareness so a process that DIES here cannot fake it, but a live
        // process that merely threw is still present, so the gate does not cover that and this
        // does. The name is captured first because the session can be gone by the finally.
        const waitName = requireSession().name
        ACT.noteWaitStart(activityMap(), { name: waitName })
        let r
        try {
          r = await waitForWork(ms, { wakeOn: args.wakeOn, until: args.until })
        } finally {
          try { ACT.noteWaitEnd(activityMap(), { name: waitName }) } catch { }
        }
        const globalState = requireSession().hive.getState()
        // THE STATE BLOCK WAS RETURNED ON EVERY SINGLE WAIT, unchanged, forever -- an agent
        // sitting in the night-shift loop was handed the same JSON hundreds of times and paid for
        // it each time. It is now sent when the agent has not seen it, when it CHANGED (which
        // always wins: a suppressed state change is a wrong answer, not a saving), or when enough
        // time AND enough output have passed that it is probably no longer in context.
        const stateBody = Object.keys(globalState).length ? `\n[GLOBAL PROJECT STATE]\n${JSON.stringify(globalState, null, 2)}\n` : ''
        const stateStr = stateBody && throttle.send('state', stateBody) ? stateBody : ''
        // The room rules went the other way: 6 KB handed over ONCE in the hive_join result, where
        // compaction reaches them first. They are the ROOM-specific half -- lanes, gate command,
        // ownership -- so the general rules in the system prompt do not cover them. A pointer is
        // re-sent, never a copy: the file is on this agent's own disk, and a second summary here
        // would be one more description to drift out of date.
        const rulesStr = throttle.should('rules', RULES_NUDGE).why === 'likely-compacted'
          ? (throttle.sent('rules', RULES_NUDGE), `\n${RULES_NUDGE}\n`)
          : ''
        // Connection state, reported ONLY when it is bad. An agent that cannot tell a
        // quiet room from a dead socket reaches for hive_join -- which calls stop() and
        // tears the session down, turning a blip that would have healed itself into a
        // real detach, and running the rejoin path that can overwrite local edits. The
        // provider reconnects on its own with backoff, so the correct action is to do
        // nothing; the agent just has to be told that, in the one place it is looking.
        const conn = (() => {
          try { return requireSession().hive.status() } catch { return null }
        })()
        const connStr = (conn && !conn.connected)
          ? `\n[CONNECTION] ${conn.connecting ? 'reconnecting' : 'offline'} — this heals itself, the client retries automatically. Do NOT call hive_join; that tears down the session and can overwrite your local edits. Keep calling hive_wait.\n`
          : ''
        
        const me = requireSession().name
        // THE KNOCK RIDES THE WAIT. hive_wait is the agent's idle state and a blocked wait costs
        // zero tokens, so a reminder delivered here arrives on a call that was going to happen
        // anyway. Agent Relay re-injects its boomerang on a broker timer, which spends a turn on
        // every knock; this spends nothing. The reminder is deliberately NOT sent to a paused
        // agent -- paused means stop, and nagging a stopped agent is just noise.
        const obMap = (() => { try { return requireSession().hive.doc.getMap('obligations') } catch { return null } })()
        let owedStr = ''
        if (obMap) {
          const due = OB.overdue(obMap, me)
          if (due.length) {
            // Only a DELIVERED knock moves the deadline. If merely NOTICING an overdue record
            // rescheduled it, an agent that never calls hive_wait would have its deadline pushed
            // out forever by whoever happened to read the board -- exactly backwards.
            for (const o of due) OB.knock(obMap, o.id)
            owedStr = `\n[YOU OWE ${due.length} ANSWER(S)] These were asked of you and are still open. ` +
              `Answer in chat with @Name — you cannot close them yourself, the asker does that.\n` +
              due.map((o) => '  ' + OB.describe(o)).join('\n') + '\n'
          }
        }
        // Direct address is separated from ambient traffic on every path. It used to be that
        // only a PAUSED agent got this distinction, so a working agent could not tell "stop,
        // wrong file" from two other agents talking to each other.
        const mentionBlock = (r) => (r.mentions && r.mentions.length)
          ? `${r.priority === 'stop' ? '🛑 STOP — handle this BEFORE anything else' : '📣 ADDRESSED TO YOU'}:\n${r.mentions.map(formatMessage).join('\n')}`
          : ''
        // Both delivery paths go through the SAME digest. They used to format ambient traffic
        // separately, which is how two copies of a rule drift apart -- the exact hazard that
        // already bit the duplicated reconcile() and the two HIVE_RULES copies.
        const ambientBlock = (r) => ambientDigest((r.messages || []).filter((m) => !mentionsName(m.text, me)))

        if (r && r.paused) {
          const parts = [mentionBlock(r), ambientBlock(r)].filter(Boolean)
          if (r.tasks && r.tasks.length) parts.push(`📌 Directed task(s):\n${r.tasks.map(fmtTask).join('\n')}`)
          if (parts.length) {
            return text(`⏸ You are PAUSED, but were directly addressed. Handle ONLY this, then call hive_wait again (you stay paused until a human resumes you — don't pick up other queued work):\n\n${parts.join('\n\n')}`)
          }
          return text(`⏸ You are PAUSED by mission control. Stop new work and wait. You will be woken if someone @mentions you or assigns you a task; otherwise just call hive_wait again.${stateStr}`)
        }
        if (!r) return text(`(nothing yet — no approved work or new messages in the wait window. Call hive_wait again to keep waiting.)${owedStr}${connStr}${stateStr}${rulesStr}`)
        const parts = []
        if (r.resumed) parts.push('▶ You were RESUMED by mission control — continue.')
        const mb = mentionBlock(r); if (mb) parts.push(mb)
        if (r.tasks.length) parts.push(`APPROVED WORK — do these now, then hive_complete each:\n${r.tasks.map(fmtTask).join('\n')}`)
        const ab = ambientBlock(r); if (ab) parts.push(ab)
        return text(`${owedStr}${connStr}${stateStr}${rulesStr}\n` + (parts.join('\n\n') || '(resumed — no queued work yet. Call hive_wait again.)'))
      }
      case 'hive_delivered': {
        const s2 = requireSession()
        const conn = (() => { try { return s2.hive.status() } catch { return null } })()
        const connected = !conn || !!conn.connected
        const here = new Set(s2.hive.members().map((m) => String(m.name).toLowerCase()))
        const rs = RC.receipts({
          chat: s2.hive.doc.getArray('chat').toArray(),
          cursors: s2.hive.doc.getMap('cursors'),
          me: s2.name,
          present: (n) => here.has(String(n).toLowerCase()),
          connected,
          limit: Math.min(Math.max(Number(args.limit) || 10, 1), 50),
        })
        if (!rs.length) return text('You have not addressed anyone recently, so there is nothing to confirm. (Unaddressed and @all messages are not tracked — nobody promised to read those.)')
        const states = rs.flatMap((r) => r.to)
        const read = RC.countDelivered(states)
        const unknown = states.filter((x) => x.state === RC.UNKNOWN).length
        // The headline deliberately reports READ over TOTAL and names UNKNOWN separately rather
        // than folding it in. Summing "not proven undelivered" into the good number is how a
        // receipt system starts reassuring instead of measuring.
        const head = `${read}/${states.length} confirmed READ` +
          (unknown ? ` — ${unknown} UNKNOWN (no read position published; that is an absence of evidence, not evidence of delivery)` : '')
        const worst = states.filter((x) => x.state !== RC.READ)
        return text(`${head}\n\n` + rs.map((r) => '  ' + RC.describe(r)).join('\n') +
          (worst.length ? '\n\n' + [...new Set(worst.map((x) => `${x.name}: ${x.why}`))].join('\n') : ''))
      }
      case 'hive_answered': {
        const s2 = requireSession()
        const obMap = s2.hive.doc.getMap('obligations')
        if (args.from) {
          const closed = OB.dischargeFrom(obMap, { by: s2.name, to: String(args.from) })
          if (!closed.length) return text(`Nothing open that you asked @${args.from}. hive_owed shows what is.`)
          return text(`Closed ${closed.length} question(s) you asked @${args.from}:\n` + closed.map((o) => '  ' + o.text).join('\n'))
        }
        if (!args.id) return err('hive_answered needs either id (one question) or from (everything you asked one agent). hive_owed lists both.')
        const r2 = OB.discharge(obMap, { id: String(args.id), by: s2.name })
        if (!r2.ok) return err(r2.reason)
        return text(r2.already ? `${args.id} was already closed.` : `Closed ${args.id}: "${r2.rec.text}"`)
      }
      case 'hive_owed': {
        const s2 = requireSession()
        const obMap = s2.hive.doc.getMap('obligations')
        if (args.all) {
          const b = OB.board(obMap)
          if (!b.open) return text('Nothing outstanding in this room.')
          return text(`${b.open} open, ${b.stale} stale:\n` + b.lines.map((l) => '  ' + l).join('\n'))
        }
        const mine = OB.owedBy(obMap, s2.name), theirs = OB.owedTo(obMap, s2.name)
        if (!mine.length && !theirs.length) return text('You owe nothing and are owed nothing. (Pass all:true for the whole room.)')
        const parts = []
        if (mine.length) parts.push(`YOU OWE ${mine.length} ANSWER(S) — answer in chat with @Name; the asker closes it:\n` + mine.map((o) => '  ' + OB.describe(o)).join('\n'))
        if (theirs.length) parts.push(`YOU ARE OWED ${theirs.length} — close with hive_answered once you actually have what you needed:\n` + theirs.map((o) => '  ' + OB.describe(o)).join('\n'))
        return text(parts.join('\n\n'))
      }
      case 'hive_set_state': { requireSession().hive.setState(String(args.key), String(args.val)); return text(`Set global state [${args.key}] to [${args.val}]`) }
      case 'hive_read_state': { return text(requireSession().hive.getState()) }
      case 'hive_set_schema': { requireSession().hive.setSchema(String(args.key), args.rules); return text(`Set schema validation for [${args.key}]`) }
      case 'hive_attest': {
        const f = String(args.file || ''); if (!f) return err('need a file path')
        if (!Number.isFinite(Number(args.bytes))) return err('need bytes — measure your own folder, do not estimate')
        const r = requireSession().hive.attest(f, Number(args.bytes), Number(args.lines || 0))
        const who = Object.entries(r.peers).map(([n, v]) => `${n}: ${v.bytes} bytes / ${v.lines} lines`).join('\n  ')
        if (r.diverged) {
          return text(`[!] DIVERGENCE on ${f} — peers do NOT agree:\n  ${who}\n\nThe room has no single truth for this path. Nobody should write it. If it cannot be reconciled, have the owner set path:${f}=POISONED and publish the correct content to a NEW path.`)
        }
        return text(`attested ${f} at ${args.bytes} bytes.\n  ${who}\n${r.count >= 2 ? 'QUORUM: 2+ peers agree — this publish is confirmed.' : 'Only you so far. Ask another agent to hive_attest the same path; a single folder proves nothing.'}`)
      }
      case 'hive_verified': {
        const f = String(args.file || ''); if (!f) return err('need a file path')
        const r = requireSession().hive.verified(f)
        // Attestation and gate verdicts are independent records, so an unattested path must still
        // report its gate. Returning early here would hide a FAILED check behind "nobody measured
        // the bytes", which is the opposite of what this tool is for.
        if (!r.count) {
          const g0 = requireSession().hive.gateVerdicts(f)
          const extra = Object.entries(g0).map(([n, v]) => v.forced
            ? `\n  [!] ${n} FORCE-released it without passing the gate${v.why ? ` — "${v.why}"` : ''}`
            : `\n  ${v.pass ? '[ok]' : '[!]'} ${n}'s gate ${v.pass ? 'passed' : `FAILED (exit ${v.exit})`}`).join('')
          return text(`${f}: NOT attested by anyone. Unverified — measure it and call hive_attest.${extra}`)
        }
        const who = Object.entries(r.peers).map(([n, v]) => `${n}: ${v.bytes} bytes / ${v.lines} lines at ${v.at}`).join('\n  ')
        // Same bytes in two folders says the file PROPAGATED. It says nothing about whether it
        // WORKS, which is the actual question an agent is asking here — so the gate verdicts
        // belong in this answer. A file two peers agree on and whose owner's tests failed is the
        // exact thing somebody is about to build on.
        const g = requireSession().hive.gateVerdicts(f)
        const gLines = Object.entries(g).map(([n, v]) => v.forced
          ? `  [!] ${n} FORCE-released it without passing the gate${v.why ? ` — "${v.why}"` : ' and gave no reason'}`
          : `  ${v.pass ? '[ok]' : '[!]'} ${n}'s gate ${v.pass ? 'passed' : `FAILED (exit ${v.exit})`}: ${v.cmd}`)
        const gate = gLines.length
          ? `\n\nCHECKS RUN BY THE AGENTS THAT HELD IT:\n${gLines.join('\n')}${Object.values(g).some((v) => !v.pass) ? '\n  Somebody handed this back knowing it did not pass. Read it before you build on it.' : ''}`
          : '\n\nNo gate verdict recorded for this path — nobody has run a check on it here.'
        return text(`${f}\n  ${who}\n\n${r.diverged ? '[!] DIVERGED — peers hold different bytes. Do not write or build on this path.' : r.quorum ? 'QUORUM: confirmed by 2+ peers at the same size.' : 'Attested by ONE peer only — not yet proof.'}${gate}`)
      }
      case 'hive_approve': { const r = requireSession().hive.decide(String(args.id), true); return r.ok ? text(`approved ${args.id}`) : err(r.error) }
      case 'hive_deny': { const r = requireSession().hive.decide(String(args.id), false); return r.ok ? text(`denied ${args.id}`) : err(r.error) }
      case 'hive_complete': { enforceDcoLock(); const r = requireSession().hive.complete(String(args.id), String(args.note || '')); return r.ok ? text(`completed ${args.id}`) : err(r.error) }
      case 'hive_claim': {
        const region = String(args.region || ''); if (!region) return err('need a region (file path)')
        // Claiming does not spend a lease — it is not a write. But claiming a poisoned path is
        // always a mistake, and refusing here is far cheaper than refusing after the agent has
        // built the content it intended to write.
        enforceDcoLock({ path: region });
        // HIV-27: A CLAIM YOU CANNOT PUBLISH IS NOT A CLAIM. The claim is a path string in the
        // shared map; whether that path's BYTES sync is decided separately, per client. Nothing
        // compared them, so an agent could hold an exclusive claim on a file nobody else can
        // see, do the work, pass a gate running in its own folder where the file is real, and
        // hand back something that never existed for anyone else -- every signal green.
        // Refused HERE rather than at release: by release time the work is already built and
        // all we could do is tell the agent it was wasted.
        const unshared = requireSession().hive.whyNotShared(region)
        if (unshared) {
          return err(`refusing to claim ${region} — ${unshared}

Nothing was claimed. Put the path inside the room's sync scope, or pick one that is already in it, BEFORE you start work: a claim whose bytes never leave this folder is indistinguishable from one that works.`)
        }
        // SETTLED, not optimistic. The synchronous claim answers from this replica alone and
        // tells three simultaneous callers "it's yours" (measured 5/5). An agent then edits
        // behind a lock it does not hold. This waits for the relay to serialise it.
        const got = await requireSession().hive.claimSettled(region, String(args.intent || 'edit'))
        if (got) return text(`claimed ${region} — it's yours. Edit it, then call hive_release.`)
        const c = requireSession().hive.senseClaim(region)
        return text(`could NOT claim ${region}${c ? ` — held by ${c.by}${c.intent ? ` (${c.intent})` : ''}` : ''}. Work on something else; check hive_claims for open files.`)
      }
      case 'hive_release': {
        const region = String(args.region || '')
        if (!region) return err('need a region')
        // A gated release can REFUSE, and reporting "released" either way is the worst thing this
        // could do: the agent moves on believing it handed the file back while it still holds it.
        const r = requireSession().hive.release(region, { force: !!args.force, why: String(args.why || '') })
        if (r && r.ok === false) return text(r.message)
        if (r && r.forced) return text(`released ${region} WITHOUT passing the gate — recorded against your name in the room`)
        return text(`released ${region}${r && r.gated ? ' (gate passed)' : ''}`)
      }
      case 'hive_claims': { const b = requireSession().hive.claimsBoard(); return text(b.length ? b.map((c) => `${c.region} — ${c.by}${c.intent ? ` (${c.intent})` : ''}`).join('\n') : '(nothing claimed right now — all open)') }
      case 'hive_edit': {
        const editPath = String(args.file || '')
        // Path gate + lease consumed BEFORE the write, not after: a spent lease that still wrote is
        // indistinguishable from no lease at all.
        enforceDcoLock({ consumes: true, path: editPath })
        // HIV-27, same reasoning: this tool's entire promise is that the change reaches every
        // peer. On a path this client never opens a connection for, it would not -- and it
        // would still report success.
        const unshared = requireSession().hive.whyNotShared(editPath)
        if (unshared) {
          return err(`refusing to write ${editPath} through the medium — ${unshared}

Nothing was written. This tool exists to guarantee the change syncs to every peer; on this path it cannot.`)
        }
        const r = requireSession().hive.edit(editPath, String(args.content ?? ''), String(args.intent || ''))
        if (r.error) return err(r.error)
        return text(r.conflicted
          ? `wrote ${r.file}, but it now carries <<<<<<< conflict markers (a concurrent edit collided). Read the file and resolve before continuing.`
          : `✓ wrote ${r.file} through the medium — your intent is signed into its provenance ledger and the change is syncing to every peer.`)
      }
      case 'hive_fork': {
        const file = String(args.file || ''); if (!file) return err('need a file path')
        const f = requireSession().hive.forkInfo(file)
        if (!f) return text(`(no active fork on ${file} — nothing to resolve)`)
        const vs = f.versions.map((v, i) => `--- VERSION ${i + 1}: ${v.name} — signed intent: "${v.intent || '(none stated)'}" ---\n${v.text ?? '(text unavailable)'}`).join('\n\n')
        return text(`ACTIVE FORK on ${file} — ${f.versions.length} agents changed the same region concurrently. Reconcile ALL intents into one version and submit it with hive_resolve.\n\n--- COMMON BASE (what everyone edited from) ---\n${f.base ?? '(unavailable)'}\n\n${vs}`)
      }
      case 'hive_resolve': {
        const file = String(args.file || ''); if (!file) return err('need a file path')
        // A resolution IS a write, so it spends a lease and respects the path gate. Resolving a
        // poisoned path is the exact move that produced two permanently disagreeing folders.
        enforceDcoLock({ consumes: true, path: file })
        const r = requireSession().hive.resolveFork(file, String(args.code ?? ''))
        if (!r.ok) return err(`resolution NOT landed: ${r.reason}`)
        const dropped = (r.coverage || []).filter((c) => !c.covered)
        return text(`✓ resolution LANDED in ${file} — validated by ICR (parses, no dangling refs), signed by you, synced to every peer.${dropped.length ? ` ⚠ Intent coverage: ${dropped.map((c) => `${c.name}'s changes (${c.missing.slice(0, 5).join(', ')}) did not survive`).join('; ')} — if that was not deliberate, submit a better reconciliation.` : ' Full intent coverage: every side\'s changes survived.'}`)
      }
      case 'hive_members': {
        const now = Date.now()
        const s = requireSession()
        const act = activityMap()
        const controls = s.hive.doc.getMap('controls')
        const parkedAfter = ACT.parkedAfterMs()
        const present = s.hive.members()
        const presentKeys = new Set(present.map((m) => String(m.name).toLowerCase()))

        const rows = present.map((m) => {
          const rec = act ? act.get(String(m.name).toLowerCase()) : null
          const c = controls.get(m.name)
          const editing = m.editing && now - m.editing.at < 15000 ? `\n    editing ${m.editing.file}` : ''
          return ACT.line(`${m.name} (${m.kind})`, rec, {
            present: true, passive: !!m.passive,
            paused: !!(c && c.state === 'paused'),
            now, parkedAfter,
          }) + editing
        })

        // HIV-P11. THE ONES THAT ARE NOT HERE ANY MORE, which is the half a human coming back in
        // the morning actually needs. Awareness is ephemeral: an agent that died at 23:00 simply
        // vanishes from members(), so the old output could not distinguish "never joined" from
        // "worked here for three hours and stopped". The activity record is durable, so it can.
        const goneRows = ACT.all(act)
          .filter((r) => !presentKeys.has(r.key))
          .map((r) => ACT.line(r.name || r.key, r, { present: false, now, parkedAfter }))

        const body = [...rows, ...(goneRows.length ? ['', '— not connected —', ...goneRows] : [])]
        return text(body.join('\n') || '(none)')
      }
      case 'hive_status': {
        const s = requireSession()
        // Connection state belongs here too, not only in hive_wait: this is the tool an
        // agent reaches for when it suspects something is wrong, and the answer it needs
        // is almost always "you are still connected, do nothing".
        let conn = null
        try { conn = s.hive.status() } catch { }
        return text({
          room: s.room, relay: s.relay, dir: s.dir, name: s.name, hivecode: VERSION,
          unread: mailbox().peek(chatArray()).unreadCount,
          connected: conn ? conn.connected : null,
          filesSynced: conn ? `${conn.filesSynced}/${conn.files}` : null,
        })
      }
      // HIV-P11. A deliberate leave is the one departure the room KNOWS about, so the activity
      // row is dropped rather than left to read as GONE. GONE means "stopped without saying so",
      // and diluting it with agents that signed off correctly is how a signal stops being read.
      case 'hive_leave': { try { ACT.forget(activityMap(), requireSession().name) } catch { }; requireSession().hive.stop(); session = null; try { fs.rmSync(SESSION_FILE) } catch {}; return text('left the room') }
      default: return err(`unknown tool: ${name}`)
    }
  } catch (e) { return err(`error: ${e.message}`) }
  finally {
    // hive_join only: the session does not exist until the case has run, so this is the single
    // tool that cannot be stamped on the way in. Everything else is stamped above, before the
    // switch, so that an agent's own record reflects the call it is currently making.
    try {
      if (session && name === 'hive_join') ACT.noteAction(activityMap(), { name: session.name, tool: name })
    } catch { /* a liveness stamp must never be able to fail a tool call */ }
  }
}

// MAIL PIGGYBACK — the delivery channel that cannot be ignored.
//
// Everything else that tries to reach a busy agent is best-effort. `notifications/hive_mail` and
// `notifications/hive_state_changed` are CUSTOM MCP methods, and the spec requires a receiver to
// IGNORE notification methods it does not recognise — so on most hosts they are a doorbell wired to
// nothing. That is why a live four-agent build accumulated 345 mentions in the room log while agents
// repeatedly reported never seeing the one addressed to them, and why the room resorted to disk files
// and a shell watcher to do the job of a coordination tool.
//
// A TOOL RESULT, by contrast, lands in the model's context by definition. So mail rides out on every
// single tool call. An agent that is heads-down still calls tools constantly — that is what being
// heads-down IS — and now every one of those calls tells it who is waiting.
//
// PEEK, NOT TAKE, and the distinction is the whole design: this is a DOORBELL, not a delivery. It
// consumes nothing and advances no cursor, so hive_wait/hive_check remain the only things that hand
// over a message and mark it read. Delivering here instead would make the full text arrive on a
// random unrelated tool call and vanish from the inbox, which is worse than not delivering at all.
// A CONTEXT IS APPEND-ONLY, AND THAT CHANGES THE DESIGN.
//
// The obvious implementation — append the banner whenever mail is pending — is wrong in two ways, and
// both are the very drift SMP exists to prevent:
//
//   1. SPAM. Mail stays pending until the agent reads it, so 50 tool calls produce 50 identical
//      banners, burning context to say one thing.
//   2. STALE TRUTH. Nothing can REMOVE text from a transcript. Once a banner is in context it is there
//      for the rest of the session, so after the agent reads its mail the old "URGENT MAIL" notices
//      remain, contradicting the present. An agent scanning back acts on a message handled ten
//      minutes ago.
//
// Since removal is impossible, the only correct approach is to make LATER TEXT AUTHORITATIVE and say
// so explicitly:
//
//   - emit ONLY when the mail state actually changes, so one new message = one notice
//   - NUMBER each notice, and state that it supersedes every earlier one
//   - emit exactly ONE "cleared" notice when the inbox empties, which retires the stale banners
//     instead of leaving them as the newest thing the agent can see
//
// Signature includes the session name so a rejoin re-announces rather than inheriting a stale state.
let mailSig = ''
let mailNotice = 0

function mailBanner() {
  try {
    if (!session || !session.mailbox) return ''
    const m = session.mailbox.peek(chatArray())
    const frame = (body) => `\n\n--- MAIL NOTICE #${mailNotice} (supersedes every earlier MAIL NOTICE above) ---\n${body}\n--- end notice #${mailNotice} ---`

    if (!m.mentioned) {
      // Emit the all-clear once, and only if we had previously announced something. Without this the
      // last thing in context stays "you have 2 unread", forever, after they were read.
      if (!mailSig) return ''
      mailSig = ''
      mailNotice += 1
      return frame('MAIL CLEARED: nothing is addressed to you right now. Any unread-mail notice earlier in this conversation has been handled and is now STALE — ignore it.')
    }

    const last = m.mentions[m.mentions.length - 1] || {}
    // Keyed on the NEWEST mention, not the count: a count alone would stay silent when one message is
    // read and another arrives, and would re-fire on unrelated ambient chatter.
    const sig = `${session.name}|${m.mentions.length}|${last.at || ''}|${last.by || ''}`
    if (sig === mailSig) return '' // already announced — the notice is in context, do not repeat it
    mailSig = sig
    mailNotice += 1

    const who = [...new Set(m.mentions.map((x) => x && x.by).filter(Boolean))].join(', ')
    const urgent = m.priority === 'stop'
    return frame(`${urgent ? '[!] URGENT MAIL' : 'UNREAD MAIL'}: ${m.mentions.length} message(s) addressed to you from ${who}. `
      + `${urgent ? 'Handle before continuing. ' : ''}Call hive_wait or hive_check to read them — this notice consumed nothing.`)
  } catch { return '' }
}

// A MISSING REQUIRED ARGUMENT MUST BE REFUSED, NOT WRITTEN AS `undefined`.
//
// Nothing was validating `inputSchema.required`. The SDK does not enforce it, and every handler
// read its arguments straight off the object, so a near-miss parameter name sailed through as
// `undefined` and the tool reported success. Two real cases, both on 18 Sep 2026:
//   hive_say({ message })    -> posted an EMPTY message and answered "sent: "
//   hive_set_state({ value }) -> answered "Set global state [gate:cmd] to [undefined]", which
//                                overwrote the room's gate command with the string "undefined"
//                                and would have broken the handoff gate for every agent.
// The failure mode is what makes it serious: the agent is told the action happened. It moves on,
// and the room is left holding a corrupted value nobody wrote on purpose. Near-miss names are
// the common case, so the refusal names the unknown argument that was supplied too.
function missingRequired(req) {
  const name = req && req.params && req.params.name
  const tool = TOOLS.find((t) => t.name === name)
  const schema = tool && tool.inputSchema
  const required = schema && Array.isArray(schema.required) ? schema.required : []
  if (!required.length) return ''
  const args = (req.params && req.params.arguments) || {}
  // undefined/null only: '' and 0 and false are legitimate values a caller may mean.
  const missing = required.filter((k) => args[k] === undefined || args[k] === null)
  if (!missing.length) return ''
  const known = Object.keys(schema.properties || {})
  const unknown = Object.keys(args).filter((k) => !known.includes(k))
  const lines = [
    `REFUSED -- ${name} needs ${missing.map((m) => `\`${m}\``).join(', ')} and it was not supplied.`,
    `Nothing was written. This call did NOT happen.`,
  ]
  if (unknown.length) {
    lines.push(`You passed ${unknown.map((u) => `\`${u}\``).join(', ')}, which ${name} does not take -- most likely you meant ${missing.map((m) => `\`${m}\``).join(', ')}.`)
  }
  lines.push(`${name} accepts: ${known.map((k) => (required.includes(k) ? `${k} (required)` : k)).join(', ')}.`)
  return lines.join('\n')
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const bad = missingRequired(req)
  if (bad) return { content: [{ type: 'text', text: bad }], isError: true }
  const res = await dispatch(req)
  // Never let the banner break a tool: append only to a well-formed text result, and skip the two
  // tools that already deliver mail themselves (appending would double-report the same messages).
  const skip = req.params && (req.params.name === 'hive_wait' || req.params.name === 'hive_check')
  if (skip) return res
  const banner = mailBanner()
  if (!banner) return res
  try {
    if (res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === 'string') {
      return { ...res, content: [{ ...res.content[0], text: res.content[0].text + banner }, ...res.content.slice(1)] }
    }
  } catch { /* fall through — a delivered result matters more than a banner */ }
  return res
})

// Only claim stdio when this file IS the program. Importing it (a test, a tool) must not
// hijack the JSON-RPC channel — that is what made the wait/mailbox logic untestable before.
const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntryPoint) {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr is fine for logs; stdout is the JSON-RPC channel and must stay clean.
  console.error('[hive-mcp] Hivecode MCP server ready (stdio). Default relay:', DEFAULT_RELAY)
}

/** Test seam: drive the real wait/delivery logic against a doc, with no relay and no stdio. */
export const _test = {
  waitForWork,
  mailbox,
  // Exposed so the throttle's saving is asserted against the counter itself rather than inferred
  // from what happened not to appear in a tool result. Counting absences is how you prove a thing
  // is quiet, not how you prove it is working.
  throttleStats: () => throttle.stats(),
  setSession(s) { session = s },
  getSession() { return session },
  callTool: (name, args = {}) =>
    server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, {}),
}
