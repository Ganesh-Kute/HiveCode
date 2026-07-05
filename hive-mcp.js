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

const DEFAULT_RELAY = process.env.HIVE_RELAY || 'wss://livecode-xoss.onrender.com'
let session = null // { hive, room, relay, dir, name }

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
function persistSession({ dir, name, owner }) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ dir, name, owner })) } catch { /* best-effort */ }
}
async function tryResumeSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    if (s && s.dir && s.name && fs.existsSync(path.join(path.resolve(s.dir), '.hive.json'))) await joinRoom(s)
  } catch { /* resume is best-effort; the agent can always hive_join explicitly */ }
}

async function joinRoom({ link = '', dir = './workspace', name = `agent-${crypto.randomBytes(2).toString('hex')}`, owner = '', token = '' }) {
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
  session = { hive, room, relay, dir, name }
  persistSession({ dir, name, owner }) // survive MCP host restarts (see tryResumeSession)
  // wait for the first sync so members/board/rules are ready
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    hive.provider.on('sync', (s) => s && finish())
    setTimeout(finish, 8000) // don't hang if the relay is cold
  })
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
function chatArray() { return requireSession().hive.doc.getArray('chat').toArray() }
function boardMap() { const b = requireSession().hive.doc.getMap('board'); return [...b.entries()].map(([file, e]) => ({ file, ...e })) }
function taskList() { return [...requireSession().hive.doc.getMap('tasks').values()] }
const fmtTask = (t) => `${t.id} [${t.status}] ${t.by} -> ${t.to}: ${t.text}${t.decidedBy ? ` (by ${t.decidedBy})` : ''}`

// Block until there is approved work for me (or a new chat message), then return.
// This is how the agent reacts the INSTANT the owner approves — no polling loop,
// no interval to tune. Resolves immediately if approved work already exists.
function waitForWork(timeoutMs) {
  const s = requireSession()
  const tmap = s.hive.doc.getMap('tasks')
  const chat = s.hive.doc.getArray('chat')
  const controls = s.hive.doc.getMap('controls')
  const me = s.name
  const paused = () => { const c = controls.get(me); return !!(c && c.state === 'paused') }
  const accepted = () => (paused() ? [] : [...tmap.values()].filter((t) => t.to === me && t.status === 'accepted'))
  const baseChatLen = chat.length
  const rx = new RegExp('@' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const mentionsMe = (t) => rx.test(String(t || ''))
  // PAUSED: stop auto-working, but STAY LISTENING. A paused agent doesn't pull its
  // queued work — yet it still wakes the moment it's directly addressed: a new
  // @mention in chat, or a new task assigned to it. It handles that, then calls
  // hive_wait again (still paused) until a human resumes it.
  if (paused()) {
    const baseTaskIds = new Set([...tmap.values()].filter((t) => t.to === me).map((t) => t.id))
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (!done) { done = true; controls.unobserve(onCtl); chat.unobserve(onChat); tmap.unobserve(onTask); resolve(v) } }
      const mentions = () => chat.toArray().slice(baseChatLen).filter((m) => mentionsMe(m.text))
      const directTasks = () => [...tmap.values()].filter((t) => t.to === me && t.status === 'accepted' && !baseTaskIds.has(t.id))
      const check = () => {
        if (!paused()) return finish({ tasks: accepted(), newChat: [], resumed: true })
        const dt = directTasks(), mn = mentions()
        if (dt.length || mn.length) finish({ paused: true, mentioned: true, tasks: dt, newChat: mn })
      }
      const onCtl = check, onChat = check, onTask = check
      controls.observe(onCtl); chat.observe(onChat); tmap.observe(onTask)
      setTimeout(() => finish({ paused: true }), timeoutMs)
    })
  }
  const ready = accepted()
  if (ready.length) return Promise.resolve({ tasks: ready, newChat: [] })
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; tmap.unobserve(onTask); chat.unobserve(onChat); controls.unobserve(onCtl); resolve(v) } }
    const onTask = () => { const a = accepted(); if (a.length) finish({ tasks: a, newChat: [] }) }
    const onChat = () => { const extra = chat.toArray().slice(baseChatLen); if (extra.length) finish({ tasks: accepted(), newChat: extra }) }
    const onCtl = () => { if (paused()) finish({ paused: true }) } // paused mid-wait -> stop handing out work
    tmap.observe(onTask); chat.observe(onChat); controls.observe(onCtl)
    setTimeout(() => finish(null), timeoutMs)
  })
}

const TOOLS = [
  { name: 'hive_join', description: 'Join (or host) a Hivecode room for a project folder. Joins automatically as an AI participant. If a join link is given, uses it; else reads <dir>/.hive.json; else hosts a new room. Returns the room info and the HIVE_RULES you must follow.',
    inputSchema: { type: 'object', properties: { link: { type: 'string', description: 'optional join link "wss://relay|room"' }, dir: { type: 'string', description: 'project folder to sync (default ./workspace)' }, name: { type: 'string', description: 'your display name in the room' }, owner: { type: 'string', description: 'the human responsible for you — only they may approve tasks directed at you' }, token: { type: 'string', description: 'access token for a secured room (else uses $HIVE_TOKEN). Required only if the relay runs in auth-required mode.' } } } },
  { name: 'hive_assign', description: 'Direct a task at another participant by name (e.g. ask another agent to work on a file). If the target is an AI with an owner, it stays PENDING until that owner approves.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'participant name to assign to' }, text: { type: 'string', description: 'what to do' } }, required: ['to', 'text'] } },
  { name: 'hive_read_tasks', description: 'Read tasks. Shows tasks directed at YOU (act only on accepted ones) and all pending tasks awaiting approval.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_wait', description: 'BLOCK until there is approved work for you (or new chat), then return it. Use this as your main loop: call hive_wait; when it returns an accepted task, do the work and call hive_complete; then call hive_wait again. Returns instantly if approved work already exists. Times out after timeoutSeconds (default 60) so you can re-call.',
    inputSchema: { type: 'object', properties: { timeoutSeconds: { type: 'number', description: 'max seconds to wait (default 60, max 300)' } } } },
  { name: 'hive_approve', description: 'Approve a pending task (you must be the owner of the target AI). The AI may then act on it.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_deny', description: 'Deny a pending task (you must be the owner of the target AI).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_complete', description: 'Mark a task you were doing as done (optionally with a note).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
  { name: 'hive_say', description: 'Post a coordination message to the room chat. Use this to announce what you are about to work on BEFORE editing (e.g. "taking auth.js: adding login").',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'the message' } }, required: ['text'] } },
  { name: 'hive_read_chat', description: 'Read the room conversation. Read this to see what humans and other agents are doing before and while you work.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'how many recent messages (default 30)' } } } },
  { name: 'hive_read_board', description: 'Read recent whole-file rewrites (who rewrote what, which symbols). Read this before editing a file — if it was just rewritten, re-read the file first.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_claim', description: 'CLAIM a file (or region) BEFORE you edit it, so other agents flow around you instead of colliding. Returns whether you got it — if false, someone else holds it: work on something else. Claims auto-expire, so call hive_release when done (or it frees itself).',
    inputSchema: { type: 'object', properties: { region: { type: 'string', description: 'the file path (or region id) you want to edit' }, intent: { type: 'string', description: 'short note on what you intend to do' } }, required: ['region'] } },
  { name: 'hive_release', description: 'Release a file/region you claimed, so other agents can take it. Call this when you finish editing it.',
    inputSchema: { type: 'object', properties: { region: { type: 'string', description: 'the file path (or region id) to release' } }, required: ['region'] } },
  { name: 'hive_claims', description: 'See what every agent is currently working on (the live claim board). Read this to pick open work and avoid taken regions.',
    inputSchema: { type: 'object', properties: {} } },
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
      case 'hive_say': { requireSession().hive.say(String(args.text || '')); return text(`sent: ${args.text}`) }
      case 'hive_read_chat': { const n = args.limit || 30; const msgs = chatArray().slice(-n).map((m) => `${m.at} ${m.by}(${m.kind}): ${m.text}`); return text(msgs.join('\n') || '(no messages yet)') }
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
        const r = await waitForWork(ms)
        const globalState = requireSession().hive.getState()
        const stateStr = Object.keys(globalState).length ? `\n[GLOBAL PROJECT STATE]\n${JSON.stringify(globalState, null, 2)}\n` : ''
        
        if (r && r.paused) {
          if (r.mentioned) {
            const parts = []
            if (r.newChat && r.newChat.length) parts.push(`💬 Mentioned while paused:\n${r.newChat.map((m) => `${m.by}(${m.kind}): ${m.text}`).join('\n')}`)
            if (r.tasks && r.tasks.length) parts.push(`📌 Directed task(s):\n${r.tasks.map(fmtTask).join('\n')}`)
            return text(`⏸ You are PAUSED, but were directly addressed. Handle ONLY this, then call hive_wait again (you stay paused until a human resumes you — don't pick up other queued work):\n\n${parts.join('\n\n')}`)
          }
          return text(`⏸ You are PAUSED by mission control. Stop new work and wait. You will be woken if someone @mentions you or assigns you a task; otherwise just call hive_wait again.${stateStr}`)
        }
        if (!r) return text(`(nothing yet — no approved work or new messages in the wait window. Call hive_wait again to keep waiting.)${stateStr}`)
        const parts = []
        if (r.resumed) parts.push('▶ You were RESUMED by mission control — continue.')
        if (r.tasks.length) parts.push(`APPROVED WORK — do these now, then hive_complete each:\n${r.tasks.map(fmtTask).join('\n')}`)
        if (r.newChat.length) parts.push(`NEW MESSAGES:\n${r.newChat.map((m) => `${m.at} ${m.by}(${m.kind}): ${m.text}`).join('\n')}`)
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
      case 'hive_members': { const now = Date.now(); return text(requireSession().hive.members().map((m) => `${m.name} (${m.kind})${m.editing && now - m.editing.at < 15000 ? ` — editing ${m.editing.file}` : ''}`).join('\n') || '(none)') }
      case 'hive_status': { const s = requireSession(); return text({ room: s.room, relay: s.relay, dir: s.dir, name: s.name }) }
      case 'hive_leave': { requireSession().hive.stop(); session = null; try { fs.rmSync(SESSION_FILE) } catch {}; return text('left the room') }
      default: return err(`unknown tool: ${name}`)
    }
  } catch (e) { return err(`error: ${e.message}`) }
})

const transport = new StdioServerTransport()
await server.connect(transport)
// stderr is fine for logs; stdout is the JSON-RPC channel and must stay clean.
console.error('[hive-mcp] Hivecode MCP server ready (stdio). Default relay:', DEFAULT_RELAY)
