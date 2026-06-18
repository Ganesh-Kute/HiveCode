// Hivecode AGENT client — what an AI runs ITSELF to join a room.
//
//   node hive-agent.js "<join-link>" <dir> [name]
//   e.g. node hive-agent.js "wss://livecode-xoss.onrender.com|room-AbC123" ./project Claude
//
// No human setup required. An agent runs this, and from then on it is a
// first-class participant in the room:
//   - it joins as kind:'ai' AUTOMATICALLY (no setting to toggle, no human to
//     "declare" it — running this client IS the declaration)
//   - the folder it points at is kept live-merged with everyone else's (humans
//     and other agents), with the same 3-way merge + auto-board protections
//   - it just edits files in <dir> with its own tools; changes sync safely
//
// The protocol the agent should follow (printed on start so the agent reads it):
//   1. Before editing a file, read HIVE_BOARD.md. If your target file is listed
//      as recently rewritten, RE-READ that file before changing it.
//   2. Prefer small patches over full rewrites. Patches merge automatically.
//   3. If you must rewrite a whole file, that's fine — it's auto-logged for
//      everyone; just make sure you re-read first so you build on current code.

import { startSync, parseLink } from './sync.js'

const DEFAULT_RELAY = 'wss://livecode-xoss.onrender.com'
const [, , LINK = '', DIR = './workspace', NAME = `agent-${Math.floor(process.uptime() * 1000) % 9000 + 1000}`] = process.argv

if (!LINK) {
  console.error('Usage: node hive-agent.js "<join-link>" <dir> [name]')
  console.error('  join-link looks like  wss://host|room-xxxx  (or just  room-xxxx  to use the default relay)')
  process.exit(1)
}

const { relay, room } = parseLink(LINK)
const RELAY = relay || DEFAULT_RELAY
if (!room) { console.error('Could not read a room from the link.'); process.exit(1) }

console.log(`\n[hive-agent] joining room "${room}" on ${RELAY} as AI participant "${NAME}"`)
console.log('[hive-agent] PROTOCOL FOR THIS AGENT:')
console.log('  1. Before editing a file, read HIVE_BOARD.md; if your file is listed as recently')
console.log('     rewritten, re-read it before changing it.')
console.log('  2. Prefer small patches (grep + edit) over full rewrites — they merge automatically.')
console.log('  3. A full rewrite is OK and auto-logged; just re-read the file first.\n')

const hive = startSync({ relay: RELAY, room, dir: DIR, name: NAME, kind: 'ai' })

let announced = false
hive.provider.on('sync', (s) => {
  if (!s || announced) return
  announced = true
  const others = hive.members().filter((m) => m.name !== NAME)
  console.log(`[hive-agent] connected. In the room: ${hive.members().map((m) => `${m.name}(${m.kind})`).join(', ') || 'just me'}`)
  console.log(`[hive-agent] editing folder: ${DIR}  —  edits here sync live to ${others.length} other participant(s).`)
})

process.on('SIGINT', () => { hive.stop(); process.exit(0) })
