// Post one coordination message to a Hive room, then exit. For agents/humans to
// "speak" without holding a long-running client.
//
//   node hive-say.js [join-link] <name> "<message>" [dir]
//
// If no join-link is given it reads <dir>/.hive.json (default ./workspace) to
// find the room — same rendezvous as hive-agent.js. The message appears in
// everyone's HIVE_CHAT.md.

import fs from 'fs'
import path from 'path'
import { startSync, parseLink } from './sync.js'

const DEFAULT_RELAY = process.env.HIVE_RELAY || 'wss://livecode-xoss.onrender.com'
const args = process.argv.slice(2)
// link is optional first arg (contains "|" or starts with ws); detect it
let link = ''
if (args[0] && (args[0].includes('|') || args[0].startsWith('ws'))) link = args.shift()
const [NAME = 'anon', MESSAGE = '', DIR = './workspace'] = args

if (!MESSAGE) { console.error('Usage: node hive-say.js [join-link] <name> "<message>" [dir]'); process.exit(1) }

let relay, room
if (link) { const p = parseLink(link); relay = p.relay || DEFAULT_RELAY; room = p.room }
else {
  try { const cfg = JSON.parse(fs.readFileSync(path.join(path.resolve(DIR), '.hive.json'), 'utf8')); relay = cfg.relay || DEFAULT_RELAY; room = cfg.room } catch {}
}
if (!room) { console.error('No room found (give a link or run from a folder with .hive.json).'); process.exit(1) }

const hive = startSync({ relay, room, dir: DIR, name: NAME, kind: 'ai', log: () => {}, syncFiles: false })
hive.provider.on('sync', (s) => {
  if (!s) return
  hive.say(`${NAME}: ${MESSAGE}`)
  console.log(`[hive-say] sent to room ${room}: "${MESSAGE}"`)
  setTimeout(() => { hive.stop(); process.exit(0) }, 700) // let it propagate
})
