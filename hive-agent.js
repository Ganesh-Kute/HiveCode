// Hivecode AGENT client — what an AI runs ITSELF. Host, join, and talk: no human.
//
//   node hive-agent.js [join-link] [dir] [name]
//
// Room resolution (this is how an AI hosts/invites WITHOUT a human passing links):
//   1. if a join-link is given        -> use it (and save it to .hive.json)
//   2. else if <dir>/.hive.json exists -> JOIN that room (rendezvous)
//   3. else                            -> HOST: create a room, save .hive.json
// So the FIRST agent to run hosts and writes .hive.json; every other agent that
// shares the folder/repo just runs `node hive-agent.js` and auto-joins the same
// room. The invite travels with the project, not a human's clipboard.
//
// Relay: defaults to the hosted relay, override with HIVE_RELAY env.
// On join the agent announces itself in the shared chat (HIVE_CHAT.md) so the
// others know it arrived; it READS HIVE_CHAT.md to coordinate and HIVE_BOARD.md
// before editing files someone just rewrote.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { startSync, parseLink } from './sync.js'

const DEFAULT_RELAY = process.env.HIVE_RELAY || 'wss://livecode-xoss.onrender.com'
const [, , ARG_LINK = '', DIR = './workspace', NAME = `agent-${crypto.randomBytes(2).toString('hex')}`] = process.argv

const ROOT = path.resolve(DIR)
fs.mkdirSync(ROOT, { recursive: true })
const configPath = path.join(ROOT, '.hive.json')

function resolveRoom() {
  if (ARG_LINK) {
    const { relay, room } = parseLink(ARG_LINK)
    return { relay: relay || DEFAULT_RELAY, room, mode: 'joined (from link)' }
  }
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (cfg.room) return { relay: cfg.relay || DEFAULT_RELAY, room: cfg.room, mode: 'joined (rendezvous .hive.json)' }
    } catch {}
  }
  // HOST a new room — this agent is the first one in.
  return { relay: DEFAULT_RELAY, room: 'room-' + crypto.randomBytes(13).toString('base64url'), mode: 'HOSTED (new room)' }
}

const { relay, room, mode } = resolveRoom()
// persist so other agents (and humans) can rendezvous without a link
fs.writeFileSync(configPath, JSON.stringify({ relay, room }, null, 2))

console.log(`\n[hive-agent] "${NAME}" ${mode}`)
console.log(`[hive-agent] room: ${room}`)
console.log(`[hive-agent] invite (others can use, or just share the repo's .hive.json):  ${relay}|${room}`)
console.log('[hive-agent] LAW: read HIVE_RULES.md and follow it. In short: read HIVE_MEMBERS.md to')
console.log('             see who is here, HIVE_CHAT.md to coordinate (announce what you take),')
console.log('             HIVE_BOARD.md before editing a recently-rewritten file; prefer small')
console.log('             patches; resolve <<<<<<< markers. To talk: node hive-say.js <name> "..."\n')

const hive = startSync({ relay, room, dir: DIR, name: NAME, kind: 'ai' })

let announced = false
hive.provider.on('sync', (s) => {
  if (!s || announced) return
  announced = true
  hive.say(`${NAME} joined and is ready to work.`) // talk to the room
  const who = hive.members().map((m) => `${m.name}(${m.kind})`).join(', ') || 'just me'
  console.log(`[hive-agent] connected. In the room: ${who}`)
})

process.on('SIGINT', () => { hive.stop(); process.exit(0) })
