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
  // wait for the first sync so members/board/rules are ready
  await new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    hive.provider.on('sync', (s) => s && finish())
    setTimeout(finish, 8000) // don't hang if the relay is cold
  })
  hive.say(`${name} joined and is ready to work.`)
  const rules = (() => { try { return fs.readFileSync(path.join(ROOT, 'HIVE_RULES.md'), 'utf8') } catch { return '(rules not yet written)' } })()
  const others = hive.members().filter((m) => m.name !== name).map((m) => `${m.name}(${m.kind})`)
  return `${mode}\nroom: ${room}\nrelay: ${relay}\nfolder: ${ROOT}\nothers here: ${others.join(', ') || 'none yet'}\ninvite link: ${relay}|${room}\n\n--- FOLLOW THESE RULES ---\n${rules}`
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
  const me = s.name
  const accepted = () => [...tmap.values()].filter((t) => t.to === me && t.status === 'accepted')
  const baseChatLen = chat.length
  const ready = accepted()
  if (ready.length) return Promise.resolve({ tasks: ready, newChat: [] })
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; tmap.unobserve(onTask); chat.unobserve(onChat); resolve(v) } }
    const onTask = () => { const a = accepted(); if (a.length) finish({ tasks: a, newChat: [] }) }
    const onChat = () => { const extra = chat.toArray().slice(baseChatLen); if (extra.length) finish({ tasks: accepted(), newChat: extra }) }
    tmap.observe(onTask); chat.observe(onChat)
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
  { name: 'hive_members', description: 'List who is currently in the room (humans and AI agents).', inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_status', description: 'Show the current session (room, relay, folder, name).', inputSchema: { type: 'object', properties: {} } },
  { name: 'hive_leave', description: 'Leave the room and stop syncing.', inputSchema: { type: 'object', properties: {} } },
]

const server = new Server({ name: 'hivecode', version: '0.1.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  try {
    switch (name) {
      case 'hive_join': return text(await joinRoom(args))
      case 'hive_say': { requireSession().hive.say(String(args.text || '')); return text(`sent: ${args.text}`) }
      case 'hive_read_chat': { const n = args.limit || 30; const msgs = chatArray().slice(-n).map((m) => `${m.at} ${m.by}(${m.kind}): ${m.text}`); return text(msgs.join('\n') || '(no messages yet)') }
      case 'hive_read_board': { const b = boardMap(); return text(b.length ? b.map((e) => `${e.at} ${e.by} rewrote ${e.file} (${e.churn}) — touched: ${(e.symbols || []).join(', ')}`).join('\n') : '(no rewrites logged)') }
      case 'hive_assign': { const id = requireSession().hive.assign(String(args.to || ''), String(args.text || '')); return id ? text(`assigned task ${id} to ${args.to} (pending approval if they have an owner)`) : err('need to and text') }
      case 'hive_read_tasks': {
        const all = taskList(); const me = requireSession().name
        const mine = all.filter((t) => t.to === me)
        const pending = all.filter((t) => t.status === 'pending')
        return text(`TASKS FOR YOU (act only on 'accepted'):\n${mine.map(fmtTask).join('\n') || '(none)'}\n\nPENDING (awaiting approval):\n${pending.map(fmtTask).join('\n') || '(none)'}`)
      }
      case 'hive_wait': {
        const ms = Math.min(Math.max(Number(args.timeoutSeconds) || 60, 1), 300) * 1000
        const r = await waitForWork(ms)
        if (!r) return text('(nothing yet — no approved work or new messages in the wait window. Call hive_wait again to keep waiting.)')
        const parts = []
        if (r.tasks.length) parts.push(`APPROVED WORK — do these now, then hive_complete each:\n${r.tasks.map(fmtTask).join('\n')}`)
        if (r.newChat.length) parts.push(`NEW MESSAGES:\n${r.newChat.map((m) => `${m.at} ${m.by}(${m.kind}): ${m.text}`).join('\n')}`)
        return text(parts.join('\n\n'))
      }
      case 'hive_approve': { const r = requireSession().hive.decide(String(args.id), true); return r.ok ? text(`approved ${args.id}`) : err(r.error) }
      case 'hive_deny': { const r = requireSession().hive.decide(String(args.id), false); return r.ok ? text(`denied ${args.id}`) : err(r.error) }
      case 'hive_complete': { const r = requireSession().hive.complete(String(args.id), String(args.note || '')); return r.ok ? text(`completed ${args.id}`) : err(r.error) }
      case 'hive_members': { const now = Date.now(); return text(requireSession().hive.members().map((m) => `${m.name} (${m.kind})${m.editing && now - m.editing.at < 15000 ? ` — editing ${m.editing.file}` : ''}`).join('\n') || '(none)') }
      case 'hive_status': { const s = requireSession(); return text({ room: s.room, relay: s.relay, dir: s.dir, name: s.name }) }
      case 'hive_leave': { requireSession().hive.stop(); session = null; return text('left the room') }
      default: return err(`unknown tool: ${name}`)
    }
  } catch (e) { return err(`error: ${e.message}`) }
})

const transport = new StdioServerTransport()
await server.connect(transport)
// stderr is fine for logs; stdout is the JSON-RPC channel and must stay clean.
console.error('[hive-mcp] Hivecode MCP server ready (stdio). Default relay:', DEFAULT_RELAY)
