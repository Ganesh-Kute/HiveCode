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
import { createMailbox, formatMessage, mentionsName, priorityOf } from './hive-mailbox.js'

const DEFAULT_RELAY = process.env.HIVE_RELAY || 'wss://livecode-xoss.onrender.com'
let session = null // { hive, room, relay, dir, name, mailbox }

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] })
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
}
async function tryResumeSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return
    const s = readSessionFile()
    if (s && s.dir && s.name && fs.existsSync(path.join(path.resolve(s.dir), '.hive.json'))) await joinRoom(s)
  } catch { /* resume is best-effort; the agent can always hive_join explicitly */ }
}

async function joinRoom({ link = '', dir = './workspace', name = `agent-${crypto.randomBytes(2).toString('hex')}`, owner = '', token = '', chatCursor }) {
  if (session) { try { session.hive.stop() } catch {} ; session = null }
  const ROOT = path.resolve(dir)
  fs.mkdirSync(ROOT, { recursive: true })
  const { relay, room, token: linkToken, mode } = resolveRoom(link, dir)
  // token precedence: explicit arg > token baked into the join link > $HIVE_TOKEN.
  const useToken = token || linkToken || process.env.HIVE_TOKEN || ''
  // persist the token too, so a re-join from .hive.json keeps the grant (the
  // invitee pastes the link once; subsequent joins just read the folder config).
  fs.writeFileSync(path.join(ROOT, '.hive.json'), JSON.stringify({ relay, room, ...(useToken ? { token: useToken } : {}) }, null, 2))
  const hive = startSync({ relay, room, dir, name, kind: 'ai', owner, token: useToken, log: () => {} })
  session = { hive, room, relay, dir, name, owner, mailbox: null }
  persistSession({ dir, name, owner }) // survive MCP host restarts (see tryResumeSession)
  // wait for the first sync so members/board/rules are ready
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    hive.provider.on('sync', (s) => s && finish())
    setTimeout(finish, 8000) // don't hang if the relay is cold
  })
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
    try {
      server.notification({ method: 'notifications/hive_state_changed', params: { state: hive.getState() } })
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
  return `${mode}\nroom: ${room}\nrelay: ${relay}\nfolder: ${ROOT}\nothers here: ${others.join(', ') || 'none yet'}\ninvite link: ${relay}|${room}\n\n--- FOLLOW THESE RULES ---\n${rulesText}`
}

function requireSession() { if (!session) throw new Error('not in a room — call hive_join first'); return session }
/** The read cursor for this participant. Lazily built if a session predates it. */
function mailbox() {
  const s = requireSession()
  if (!s.mailbox) s.mailbox = createMailbox({ me: s.name, startAt: s.hive.doc.getArray('chat').length })
  return s.mailbox
}
function chatArray() { return requireSession().hive.doc.getArray('chat').toArray() }
function boardMap() { const b = requireSession().hive.doc.getMap('board'); return [...b.entries()].map(([file, e]) => ({ file, ...e })) }
function taskList() { return [...requireSession().hive.doc.getMap('tasks').values()] }
const fmtTask = (t) => `${t.id} [${t.status}] ${t.by} -> ${t.to}: ${t.text}${t.decidedBy ? ` (by ${t.decidedBy})` : ''}`

// Block until there is approved work for me (or a new chat message), then return.
// This is how the agent reacts the INSTANT the owner approves — no polling loop,
// no interval to tune. Resolves immediately if approved work already exists.
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
    const finish = (v) => { if (!done) { done = true; tmap.unobserve(onTask); chat.unobserve(onChat); controls.unobserve(onCtl); resolve(v) } }
    const onTask = () => { const a = accepted(); if (a.length) finish(deliver({ tasks: a })) }
    const onChat = () => {
      const seen = box.peek(chat.toArray())
      if (!seen.unreadCount) return                      // only this agent's own messages — not mail
      if (wakeOnMentionOnly && !seen.mentioned) return    // ambient chatter, and the caller opted out
      finish(deliver({ tasks: accepted() }))
    }
    const onCtl = () => { if (paused()) finish({ paused: true }) } // paused mid-wait -> stop handing out work
    tmap.observe(onTask); chat.observe(onChat); controls.observe(onCtl)
    // On timeout, flush anything that arrived rather than dropping it: a message must never
    // expire unread just because the wait window closed on it.
    setTimeout(() => finish(box.hasUnread(chat.toArray()) ? deliver({ tasks: accepted() }) : null), timeoutMs)
  })
}

const TOOLS = [
  { name: 'hive_join', description: 'Join (or host) a Hivecode room for a project folder. Joins automatically as an AI participant. If a join link is given, uses it; else reads <dir>/.hive.json; else hosts a new room. Returns the room info and the HIVE_RULES you must follow.',
    inputSchema: { type: 'object', properties: { link: { type: 'string', description: 'optional join link "wss://relay|room"' }, dir: { type: 'string', description: 'project folder to sync (default ./workspace)' }, name: { type: 'string', description: 'your display name in the room' }, owner: { type: 'string', description: 'the human responsible for you — only they may approve tasks directed at you' }, token: { type: 'string', description: 'access token for a secured room (else uses $HIVE_TOKEN). Required only if the relay runs in auth-required mode.' } } } },
  { name: 'hive_assign', description: 'Direct a task at another participant by name (e.g. ask another agent to work on a file). If the target is an AI with an owner, it stays PENDING until that owner approves.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'participant name to assign to' }, text: { type: 'string', description: 'what to do' } }, required: ['to', 'text'] } },
  { name: 'hive_read_tasks', description: 'Read tasks. Shows tasks directed at YOU (act only on accepted ones) and all pending tasks awaiting approval.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_wait', description: 'BLOCK until there is approved work for you, or unread mail arrives, then return BOTH. Use this as your main loop: call hive_wait; do the work; hive_complete; call hive_wait again. Returns instantly if approved work or unread mail already exists — nothing addressed to you can be missed while you were busy, because your read position is remembered between calls.',
    inputSchema: { type: 'object', properties: { timeoutSeconds: { type: 'number', description: 'max seconds to wait (default 60, max 300)' }, wakeOn: { type: 'string', enum: ['any', 'mention'], description: "'any' (default) wakes on any new message; 'mention' only wakes when you are @mentioned or assigned a task — use it in a noisy room. Ambient messages are still delivered on the next wake either way, never dropped." } } } },
  { name: 'hive_check', description: 'NON-BLOCKING: is anyone calling me? Returns unread messages addressed to you, plus approved work, and returns immediately. Call this between edits during a long task — that is the whole point: hive_wait blocks, so it cannot be used while you are working, and this can. If it reports priority "stop", deal with that BEFORE continuing what you were doing.',
    inputSchema: { type: 'object', properties: { peek: { type: 'boolean', description: 'true = look without marking messages read (default false: reading them here counts as read)' } } } },
  { name: 'hive_approve', description: 'Approve a pending task (you must be the owner of the target AI). The AI may then act on it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_deny', description: 'Deny a pending task (you must be the owner of the target AI).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_complete', description: 'Mark a task you were doing as done (optionally with a note).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_say', description: 'Post a coordination message to the room chat. Use this to announce what you are about to work on BEFORE editing (e.g. "taking auth.js: adding login"). Address someone directly with @Name — that is what makes it land as mail rather than ambient chatter. Set urgent:true when you need them to stop what they are doing.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'the message' }, urgent: { type: 'boolean', description: 'true = prefix [!] so the recipient treats it as "handle before continuing", not "read at your next boundary"' } }, required: ['text'] } },
  { name: 'hive_read_chat', description: 'Read the room conversation. Read this to see what humans and other agents are doing before and while you work. Use mentioningMe to recover only what was addressed to you.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'how many recent messages (default 30)' }, mentioningMe: { type: 'boolean', description: 'true = only messages that @mention you, across the whole room history — use this to recover your own backlog' }, unreadOnly: { type: 'boolean', description: 'true = only what you have not been handed yet (does not mark it read)' } } } },
  { name: 'hive_read_board', description: 'Read recent whole-file rewrites (who rewrote what, which symbols). Read this before editing a file — if it was just rewritten, re-read the file first.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_claim', description: 'CLAIM a file (or region) BEFORE you edit it, so other agents flow around you instead of colliding. Returns whether you got it — if false, someone else holds it: work on something else. Claims auto-expire, so call hive_release when done (or it frees itself).',
    inputSchema: { type: 'object', properties: { region: { type: 'string', description: 'the file path (or region id) you want to edit' }, intent: { type: 'string', description: 'short note on what you intend to do' } }, required: ['region'] } },
  { name: 'hive_release', description: 'Release a file/region you claimed, so other agents can take it. Call this when you finish editing it.',
    inputSchema: { type: 'object', properties: { region: { type: 'string', description: 'the file path (or region id) to release' } }, required: ['region'] } },
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
  { name: 'hive_set_schema', description: 'PM ONLY: Define strict JSON schema validation for a global state key to prevent agents from hallucinating values (e.g. key="contract", rules={"enum": ["PLANNING", "READY", "APPROVED"]}).', inputSchema: { type: 'object', properties: { key: { type: 'string' }, rules: { type: 'object' } }, required: ['key', 'rules'] } },
]

function enforceDcoLock() {
  const state = requireSession().hive.getState()
  const name = requireSession().name
  if (state[`${name}_status`] === 'LOCKED' || state[`${name}_locked`] === 'true') {
    throw new Error(`[DCO Enforced] You are locked by the global state machine. Tool execution denied. Block on hive_wait until your status changes.`)
  }
}

const server = new Server({ name: 'hivecode', version: '0.8.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  try {
    // AUTO-RESUME: the MCP host may restart this server process at any time, which
    // wipes the in-memory session and silently kicks the agent out of its room. If a
    // persisted session exists for this cwd, transparently rejoin before any tool runs —
    // the agent (and its human) never see a "not in a room" flake again.
    if (!session && name !== 'hive_join' && name !== 'hive_leave') await tryResumeSession()
    switch (name) {
      case 'hive_join': return text(await joinRoom(args))
      case 'hive_say': {
        const raw = String(args.text || '')
        // The marker is in the text itself so it survives into HIVE_CHAT.md and is visible to
        // a human reading the log, not just to the recipient's tool output.
        const body = args.urgent && !/^\s*\[!\]/.test(raw) ? `[!] ${raw}` : raw
        requireSession().hive.say(body)
        return text(`sent: ${body}`)
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
        if (!got.unreadCount && !tasks.length) return text('✓ nothing waiting — nobody is calling you and you have no approved work. Carry on.')
        const parts = []
        if (got.priority === 'stop') {
          parts.push('🛑 URGENT — someone needs you to STOP what you are doing and handle this FIRST:')
          parts.push(got.mentions.filter((m) => priorityOf(m.text) === 'stop').map(formatMessage).join('\n'))
        } else if (got.mentioned) {
          parts.push(`📣 ${got.mentions.length} message(s) addressed to YOU — answer at your next safe stopping point:`)
          parts.push(got.mentions.map(formatMessage).join('\n'))
        }
        const ambient = got.messages.filter((m) => !mentionsName(m.text, s.name))
        if (ambient.length) parts.push(`room activity (${ambient.length}):\n` + ambient.map(formatMessage).join('\n'))
        if (tasks.length) parts.push(`approved work queued for you:\n${tasks.map(fmtTask).join('\n')}`)
        return text(parts.join('\n\n'))
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
        const r = await waitForWork(ms, { wakeOn: args.wakeOn })
        const globalState = requireSession().hive.getState()
        const stateStr = Object.keys(globalState).length ? `\n[GLOBAL PROJECT STATE]\n${JSON.stringify(globalState, null, 2)}\n` : ''
        
        const me = requireSession().name
        // Direct address is separated from ambient traffic on every path. It used to be that
        // only a PAUSED agent got this distinction, so a working agent could not tell "stop,
        // wrong file" from two other agents talking to each other.
        const mentionBlock = (r) => (r.mentions && r.mentions.length)
          ? `${r.priority === 'stop' ? '🛑 STOP — handle this BEFORE anything else' : '📣 ADDRESSED TO YOU'}:\n${r.mentions.map(formatMessage).join('\n')}`
          : ''
        const ambientBlock = (r) => {
          const rest = (r.messages || []).filter((m) => !mentionsName(m.text, me))
          return rest.length ? `room activity:\n${rest.map(formatMessage).join('\n')}` : ''
        }

        if (r && r.paused) {
          const parts = [mentionBlock(r), ambientBlock(r)].filter(Boolean)
          if (r.tasks && r.tasks.length) parts.push(`📌 Directed task(s):\n${r.tasks.map(fmtTask).join('\n')}`)
          if (parts.length) {
            return text(`⏸ You are PAUSED, but were directly addressed. Handle ONLY this, then call hive_wait again (you stay paused until a human resumes you — don't pick up other queued work):\n\n${parts.join('\n\n')}`)
          }
          return text(`⏸ You are PAUSED by mission control. Stop new work and wait. You will be woken if someone @mentions you or assigns you a task; otherwise just call hive_wait again.${stateStr}`)
        }
        if (!r) return text(`(nothing yet — no approved work or new messages in the wait window. Call hive_wait again to keep waiting.)${stateStr}`)
        const parts = []
        if (r.resumed) parts.push('▶ You were RESUMED by mission control — continue.')
        const mb = mentionBlock(r); if (mb) parts.push(mb)
        if (r.tasks.length) parts.push(`APPROVED WORK — do these now, then hive_complete each:\n${r.tasks.map(fmtTask).join('\n')}`)
        const ab = ambientBlock(r); if (ab) parts.push(ab)
        return text(`${stateStr}\n` + (parts.join('\n\n') || '(resumed — no queued work yet. Call hive_wait again.)'))
      }
      case 'hive_set_state': { requireSession().hive.setState(String(args.key), String(args.val)); return text(`Set global state [${args.key}] to [${args.val}]`) }
      case 'hive_read_state': { return text(requireSession().hive.getState()) }
      case 'hive_set_schema': { requireSession().hive.setSchema(String(args.key), args.rules); return text(`Set schema validation for [${args.key}]`) }
      case 'hive_approve': { const r = requireSession().hive.decide(String(args.id), true); return r.ok ? text(`approved ${args.id}`) : err(r.error) }
      case 'hive_deny': { const r = requireSession().hive.decide(String(args.id), false); return r.ok ? text(`denied ${args.id}`) : err(r.error) }
      case 'hive_complete': { enforceDcoLock(); const r = requireSession().hive.complete(String(args.id), String(args.note || '')); return r.ok ? text(`completed ${args.id}`) : err(r.error) }
      case 'hive_claim': {
        enforceDcoLock();
        const region = String(args.region || ''); if (!region) return err('need a region (file path)')
        const got = requireSession().hive.claim(region, String(args.intent || 'edit'))
        if (got) return text(`claimed ${region} — it's yours. Edit it, then call hive_release.`)
        const c = requireSession().hive.senseClaim(region)
        return text(`could NOT claim ${region}${c ? ` — held by ${c.by}${c.intent ? ` (${c.intent})` : ''}` : ''}. Work on something else; check hive_claims for open files.`)
      }
      case 'hive_release': { const region = String(args.region || ''); if (!region) return err('need a region'); requireSession().hive.release(region); return text(`released ${region}`) }
      case 'hive_claims': { const b = requireSession().hive.claimsBoard(); return text(b.length ? b.map((c) => `${c.region} — ${c.by}${c.intent ? ` (${c.intent})` : ''}`).join('\n') : '(nothing claimed right now — all open)') }
      case 'hive_edit': {
        enforceDcoLock()
        const r = requireSession().hive.edit(String(args.file || ''), String(args.content ?? ''), String(args.intent || ''))
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
        enforceDcoLock()
        const file = String(args.file || ''); if (!file) return err('need a file path')
        const r = requireSession().hive.resolveFork(file, String(args.code ?? ''))
        if (!r.ok) return err(`resolution NOT landed: ${r.reason}`)
        const dropped = (r.coverage || []).filter((c) => !c.covered)
        return text(`✓ resolution LANDED in ${file} — validated by ICR (parses, no dangling refs), signed by you, synced to every peer.${dropped.length ? ` ⚠ Intent coverage: ${dropped.map((c) => `${c.name}'s changes (${c.missing.slice(0, 5).join(', ')}) did not survive`).join('; ')} — if that was not deliberate, submit a better reconciliation.` : ' Full intent coverage: every side\'s changes survived.'}`)
      }
      case 'hive_members': { const now = Date.now(); return text(requireSession().hive.members().map((m) => `${m.name} (${m.kind})${m.editing && now - m.editing.at < 15000 ? ` — editing ${m.editing.file}` : ''}`).join('\n') || '(none)') }
      case 'hive_status': { const s = requireSession(); return text({ room: s.room, relay: s.relay, dir: s.dir, name: s.name }) }
      case 'hive_leave': { requireSession().hive.stop(); session = null; try { fs.rmSync(SESSION_FILE) } catch {}; return text('left the room') }
      default: return err(`unknown tool: ${name}`)
    }
  } catch (e) { return err(`error: ${e.message}`) }
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
  setSession(s) { session = s },
  getSession() { return session },
  callTool: (name, args = {}) =>
    server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, {}),
}
