// tester-bot.js — backendBOT's persistent presence in a Hivecode room.
//
// Joins the room (as AI, owner-scoped) and STAYS connected so HIVE_CHAT.md /
// HIVE_TASKS.md stay live on disk. Its stdout is an EVENT STREAM (one line per
// occurrence) meant to be consumed by the Monitor tool: it emits a line whenever
// a human/AI addresses me or asks for a test, or when an owner-approved task
// lands. Replies/results are sent by appending JSON lines to an OUTBOX file —
// the bot drains it and posts via the shared chat. This is the same startSync
// engine the MCP server (hive-mcp.js) wraps; we just bypass MCP because MCP
// servers can't be hot-loaded into a running Claude Code session.
//
//   node tester-bot.js "<relay>|<room>|<jwt>" "<absDir>" "<outboxPath>" "<name>"
//
// stdout lines:
//   ONLINE | room=... | others=...
//   EVENT MENTION | by=<name>(<kind>) | <text>
//   EVENT TASK <id> | by=<name> | <text>

import fs from 'fs'
import { startSync, parseLink } from './sync.js'

const [LINK = '', DIR = '.', OUTBOX = '', NAME = 'testai'] = process.argv.slice(2)
const ME = NAME
const OWNER = 'user-8166'

const { relay, room, token } = parseLink(LINK)
if (!room) { console.error('no room in link'); process.exit(1) }

// keywords that mean "this message is for me / wants a test run"
const TRIGGERS = [/backendbot/i, /@backend/i, /\btester\b/i, /\btests?\b/i, /\brun\b/i, /\bverify\b/i, /\bcheck\b/i]
const directedAtMe = (text) => TRIGGERS.some((re) => re.test(text || ''))

const hive = startSync({ relay, room, dir: DIR, name: ME, kind: 'ai', owner: OWNER, token, log: () => {} })

const chat = hive.doc.getArray('chat')
const tasks = hive.doc.getMap('tasks')
let chatBase = 0
const seenTasks = new Set()
const out = (line) => { process.stdout.write(line + '\n') }

hive.provider.on('sync', (s) => {
  if (!s) return
  if (chatBase === 0) {
    chatBase = chat.length // ignore history; only react to messages from now on
    const others = hive.members().filter((m) => m.name !== ME).map((m) => `${m.name}(${m.kind})`).join(', ') || 'none'
    hive.say(`${ME} (Tester) is online and on alert. Say "run tests" / mention me and I'll run the test suite and post results here.`)
    out(`ONLINE | room=${room} | others=${others}`)
  }
})

chat.observe(() => {
  const msgs = chat.toArray()
  for (let i = chatBase; i < msgs.length; i++) {
    const m = msgs[i]
    if (!m || m.by === ME) continue                 // skip my own posts
    if (directedAtMe(m.text)) out(`EVENT MENTION | by=${m.by}(${m.kind}) | ${m.text}`)
  }
  chatBase = msgs.length
})

tasks.observe(() => {
  for (const t of tasks.values()) {
    if (t.to === ME && t.status === 'accepted' && !seenTasks.has(t.id)) {
      seenTasks.add(t.id)
      out(`EVENT TASK ${t.id} | by=${t.by} | ${t.text}`)
    }
  }
})

// OUTBOX: I append JSON lines; the bot drains and acts, then truncates.
//   {"say":"<message>"}            -> post to chat
//   {"complete":{"id","note"}}     -> mark a task done
if (OUTBOX) {
  const drain = () => {
    let raw
    try { raw = fs.readFileSync(OUTBOX, 'utf8') } catch { return }
    if (!raw.trim()) return
    try { fs.writeFileSync(OUTBOX, '') } catch {}      // claim the batch
    for (const line of raw.split('\n')) {
      const s = line.trim(); if (!s) continue
      let cmd; try { cmd = JSON.parse(s) } catch { continue }
      if (cmd.say) hive.say(String(cmd.say))
      if (cmd.complete && cmd.complete.id) hive.complete(String(cmd.complete.id), String(cmd.complete.note || ''))
    }
  }
  try { fs.writeFileSync(OUTBOX, '') } catch {}
  setInterval(drain, 800)
}

process.on('SIGTERM', () => { try { hive.stop() } catch {}; process.exit(0) })
process.on('SIGINT', () => { try { hive.stop() } catch {}; process.exit(0) })
