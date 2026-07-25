// HiveLabs "Frontend" agent client. Joins a Hivecode room via the same startSync
// engine the MCP server wraps, and exposes the coordination tools (say, claim,
// release, claims, members) over a file command-channel so the driving model can
// call them and read definitive results — claims are held by THIS long-lived
// process (5-min TTL refreshed while alive).
//
//   node frontend-agent.js "<link>" "<dir>" "<inbox>" "<resp>" "<name>" "<owner>"
//
// stdout (Monitor event stream): ONLINE, EVENT MENTION, CLAIM/RELEASE results.
// resp file (jsonl, one line per command): { id, op, ... } for the driver to read.
import fs from 'fs'
import { startSync, parseLink } from './sync.js'

const [LINK = '', DIR = '.', INBOX = '', RESP = '', NAME = 'Frontend', OWNER = 'Ganesh'] = process.argv.slice(2)
const { relay, room, token } = parseLink(LINK)
if (!room) { console.error('no room in link'); process.exit(1) }

const hive = startSync({ relay, room, dir: DIR, name: NAME, kind: 'ai', owner: OWNER, token, log: () => {} })
const chat = hive.doc.getArray('chat')
let chatBase = 0
const out = (l) => process.stdout.write(l + '\n')
const resp = (o) => { try { fs.appendFileSync(RESP, JSON.stringify(o) + '\n') } catch {} }

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const namePart = NAME.split(/[_-]/)[0]
const TRIGGERS = [new RegExp('\\b' + esc(NAME) + '\\b', 'i'), new RegExp('@' + esc(namePart), 'i')]
// Surface: any mention of my name/@name, AND every message from CEO, my owner,
// or a human (Ganesh) — standing order is to always respond to those, even with
// no explicit @mention.
const forMe = (m) => m.kind === 'human' || m.by === 'CEO' || m.by === OWNER || TRIGGERS.some((re) => re.test(m.text || ''))

hive.provider.on('sync', (s) => {
  if (!s || chatBase !== 0) return
  chatBase = chat.length
  const others = hive.members().filter((m) => m.name !== NAME).map((m) => `${m.name}(${m.kind})`).join(', ') || 'none'
  out(`ONLINE | room=${room} | others=${others}`)
})

chat.observe(() => {
  const msgs = chat.toArray()
  for (let i = chatBase; i < msgs.length; i++) {
    const m = msgs[i]
    if (!m || m.by === NAME) continue
    if (forMe(m)) out(`EVENT MENTION | by=${m.by}(${m.kind}) | ${m.text}`)
  }
  chatBase = msgs.length
})

function handle(c) {
  const id = c.id || ''
  try {
    switch (c.op) {
      case 'say': hive.say(String(c.text || '')); resp({ id, op: 'say', ok: true }); break
      case 'claim': {
        const got = hive.claim(c.region, c.intent || 'edit')
        const held = got ? null : hive.senseClaim(c.region)
        resp({ id, op: 'claim', region: c.region, got, heldBy: held ? held.by : null })
        out(`CLAIM ${c.region} -> ${got ? 'GOT' : 'DENIED' + (held ? ' (held by ' + held.by + ')' : '')}`)
        break
      }
      case 'release': hive.release(c.region); resp({ id, op: 'release', region: c.region, ok: true }); out(`RELEASE ${c.region}`); break
      case 'claims': resp({ id, op: 'claims', board: hive.claimsBoard() }); break
      case 'members': resp({ id, op: 'members', members: hive.members().map((m) => ({ name: m.name, kind: m.kind })) }); break
      default: resp({ id, op: c.op, error: 'unknown op' })
    }
  } catch (e) { resp({ id, op: c.op, error: String(e.message) }) }
}

function drain() {
  let raw; try { raw = fs.readFileSync(INBOX, 'utf8') } catch { return }
  if (!raw.trim()) return
  try { fs.writeFileSync(INBOX, '') } catch {}
  for (const line of raw.split('\n')) { const s = line.trim(); if (!s) continue; let c; try { c = JSON.parse(s) } catch { continue } handle(c) }
}

try { fs.writeFileSync(INBOX, '') } catch {}
try { fs.writeFileSync(RESP, '') } catch {}
setInterval(drain, 300)
// Resilience: a transient relay/WS error must NOT kill the long-lived presence.
// Log and keep running so the client stays in the room until explicitly stopped.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && (e.stack || e.message || e)))
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && (e.stack || e.message || e)))
process.on('SIGTERM', () => { try { hive.stop() } catch {}; process.exit(0) })
process.on('SIGINT', () => { try { hive.stop() } catch {}; process.exit(0) })
