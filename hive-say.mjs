// Claude-Lead's voice: post one message to room-resolve-live-1 and exit.
//   node hive-say.mjs "message text"
import fs from 'fs'
const { startSync, parseLink } = await import('file:///C:/Users/G1/node_modules/hivecode-mcp/sync.js')
const msg = process.argv.slice(2).join(' ')
if (!msg) { console.error('usage: node hive-say.mjs "<message>"'); process.exit(1) }
fs.mkdirSync('./hive-work-resolve', { recursive: true })
const { relay, room } = parseLink('wss://livecode-xoss.onrender.com|room-resolve-live-1')
const hive = startSync({ relay, room, dir: './hive-work-resolve', name: 'Claude-Lead', kind: 'ai', owner: 'Ganesh', token: '', log: () => {} })
await new Promise((r) => setTimeout(r, 3500)) // pull state
hive.say(msg)
await new Promise((r) => setTimeout(r, 3000)) // let it sync out
hive.stop()
console.log('said:', msg)
process.exit(0)
