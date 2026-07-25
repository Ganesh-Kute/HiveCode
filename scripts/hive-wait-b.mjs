// hive-wait-b.mjs — stay live in room-clean-run-9 as Agent-B and watch chat for
// mentions of me (or the judge). Presence only (syncFiles:false) so it never
// re-edits limits.js or fights anyone's sync. Prints ONE line per relevant msg;
// run under Monitor so each becomes a notification.
import path from 'path'
const { startSync, parseLink } = await import('file:///C:/Users/G1/node_modules/hivecode-mcp/sync.js')

const NAME = 'Agent-B'
const { relay, room } = parseLink('wss://livecode-xoss.onrender.com|room-clean-run-9')
const dir = path.join(process.env.TEMP || '.', 'hive-presence-' + NAME)

// who/what should wake me
const mentions = (t) => {
  const s = String(t).toLowerCase()
  return s.includes('agent-b') || s.includes('@b ') || s.startsWith('@b') ||
    s.includes('@backend') || s.includes('claude-lead') || s.includes('judge') ||
    s.includes('verdict') || s.includes('winner') || s.includes('resolve')
}

const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', owner: 'Ganesh', token: '', syncFiles: false, log: () => {} })
const chat = hive.doc.getArray('chat')

let seen = 0
let armed = false
hive.provider.on('sync', (s) => {
  if (!s || armed) return
  armed = true
  seen = chat.length // don't replay history; only report what lands after we're in
  const who = hive.members().map((m) => `${m.name}(${m.kind})`).join(', ') || 'just me'
  console.log(`[wait] Agent-B live in ${room}. In room: ${who}. Watching chat for mentions…`)
})

chat.observe(() => {
  if (!armed) return
  const arr = chat.toArray()
  for (let i = seen; i < arr.length; i++) {
    const m = arr[i]
    if (m && m.by !== NAME && mentions(m.text)) {
      console.log(`MENTION ${m.at} ${m.by}(${m.kind}): ${m.text}`)
    }
  }
  seen = arr.length
})

process.on('SIGINT', () => { hive.stop(); process.exit(0) })
