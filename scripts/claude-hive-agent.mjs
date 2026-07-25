// A PERSISTENT Claude agent for a Hivecode room.
// Unlike the turn-based assistant, this is a real background process: it joins the
// room, registers presence (so it shows up in members), holds a claim for the
// collision test, replies when pinged, and STAYS connected until told to leave.
//
//   node claude-hive-agent.mjs "wss://relay|room"
//
import { startSync, parseLink } from '../sync.js'

const LINK = process.argv[2] || 'wss://livecode-xoss.onrender.com|room-k_SUz4ryCDfpT4oPKw'
const { relay, room, token } = parseLink(LINK)
const NAME = 'Claude'
const HOLD = 'shared.js' // the file Claude holds so a colliding claim is denied

const hive = startSync({
  relay, room, token,
  dir: 'c:/Users/G1/Desktop/hive-test',
  name: NAME, kind: 'ai', owner: 'Ganesh',
  log: (m) => process.stdout.write(`[sync] ${m}\n`),
})

await new Promise((res) => hive.provider.on('sync', (s) => s && res()))
console.log(`[agent] joined ${room} on ${relay} as ${NAME}`)

// Claim the test file and keep re-asserting it (TTL is 5 min; refresh well inside that).
const grabbed = hive.claim(HOLD, 'persistent agent holding for collision test')
console.log(`[agent] claim ${HOLD}: ${grabbed ? 'HELD' : 'could not get'}`)
hive.say(`Claude (persistent agent) is live and STAYING in the room. I am holding ${HOLD}. Ping me with "@claude" any time, or "@claude leave" to dismiss me. Try claiming ${HOLD} from copilot — you should be DENIED.`)
setInterval(() => { hive.claim(HOLD, 'still holding for collision test') }, 60_000)

// Watch chat and respond to pings aimed at Claude.
const chat = hive.doc.getArray('chat')
let seen = chat.length
chat.observe(() => {
  const fresh = chat.toArray().slice(seen)
  seen = chat.length
  for (const m of fresh) {
    if (!m || m.by === NAME) continue
    const t = String(m.text || '').toLowerCase()
    if (!t.includes('claude')) continue
    console.log(`[agent] ping from ${m.by}: ${m.text}`)

    if (/\b(leave|stop|dismiss|bye)\b/.test(t)) {
      hive.say(`Claude leaving the room as requested. Releasing ${HOLD}. 👋`)
      hive.release(HOLD)
      setTimeout(() => { hive.stop(); process.exit(0) }, 800)
      return
    }
    if (/\brelease\b/.test(t)) {
      hive.release(HOLD)
      hive.say(`Released ${HOLD} — it's open now. Board: ${fmtBoard()}`)
      continue
    }
    // default: prove I'm alive and show ground truth
    hive.say(`Claude here (live). Members: ${hive.members().map((x) => x.name + '(' + x.kind + ')').join(', ')}. Claims: ${fmtBoard()}.`)
  }
})

function fmtBoard() {
  const b = hive.claimsBoard()
  const items = Array.isArray(b) ? b : Object.entries(b || {}).map(([region, v]) => ({ region, ...v }))
  if (!items.length) return '(none)'
  return items.map((c) => `${c.region}→${c.by}`).join(', ')
}

console.log('[agent] watching chat; staying alive. Ctrl-C or "@claude leave" to stop.')
