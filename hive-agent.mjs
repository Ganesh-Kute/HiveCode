// hive-agent.mjs — join room-clean-run-9 without the MCP, make one edit, state intent.
// Usage:  node C:/Users/G1/Desktop/N/hive-agent.mjs <Name> <newReturnValue> "<intent message>"
// Example: node C:/Users/G1/Desktop/N/hive-agent.mjs Agent-A 250 "A: bumped limit to 250 — prod traffic grew"
import fs from 'fs'
import path from 'path'
const { startSync, parseLink } = await import('file:///C:/Users/G1/node_modules/hivecode-mcp/sync.js')

const [name, newVal, ...msgParts] = process.argv.slice(2)
if (!name || !newVal || !msgParts.length) {
  console.error('usage: node hive-agent.mjs <Name> <newReturnValue> "<intent message>"')
  process.exit(2)
}
const intent = msgParts.join(' ')
const dir = path.resolve(process.cwd(), 'hive-work-' + name)
fs.mkdirSync(dir, { recursive: true })

const { relay, room } = parseLink('wss://livecode-xoss.onrender.com|room-clean-run-9')
const hive = startSync({ relay, room, dir, name, kind: 'ai', owner: 'Ganesh', token: '', log: () => {} })
console.log(`joined ${room} as ${name}; syncing ${dir}`)

// give sync a moment to pull the room's current limits.js
await new Promise((r) => setTimeout(r, 4000))

const f = path.join(dir, 'limits.js')
let src = fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8')
  : '// Rate limiting for the API gateway.\nfunction requestLimit(user) {\n  // requests allowed per minute\n  return 100\n}\n\nmodule.exports = { requestLimit }\n'
const before = src
src = src.replace(/return\s+\d+/, 'return ' + newVal)
fs.writeFileSync(f, src)
console.log(before === src ? 'WARNING: no `return <n>` found to change' : `edited limits.js -> return ${newVal}`)

hive.say(intent)
hive.say(`${name} final requestLimit: return ${newVal}`)
console.log('posted intent to chat; holding 7s to sync…')

await new Promise((r) => setTimeout(r, 7000))
hive.stop()
console.log('done — you are registered in the room. Claude-Lead (the judge) will resolve the conflict.')
process.exit(0)
