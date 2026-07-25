// Stay present in a Hive room as Ganesh-AI AND wake on @mention.
// Keeps a live presence connection (no file sync) and observes the chat array;
// exits the instant a new message mentions @Ganesh-AI (authored by someone else)
// so the supervising agent can read+reply, then re-launch this watcher.
// Idle timeout keeps quiet periods cheap.
//   node hive-watch-ganesh.js "<link>" [idleMinutes]
import { startSync, parseLink } from './sync.js'

const [, , LINK = '', IDLE_MIN = '30'] = process.argv
const NAME = 'Ganesh-AI'
const { relay, room } = parseLink(LINK)
const dir = (process.env.TEMP || '.') + '/hive-presence-' + NAME

const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {} })
const chat = hive.doc.getArray('chat')
const rx = new RegExp('@' + NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
let armed = false

function finish(reason, payload) {
  console.log(JSON.stringify({ reason, ...payload }))
  try { hive.stop() } catch {}
  process.exit(0)
}

// Anchor on MY last message: any @mention by someone else AFTER the last thing
// Ganesh-AI said is unhandled. This survives relay naps / late arming (unlike a
// connect-time index), which is why the first ping was missed.
function check() {
  const msgs = chat.toArray()
  let lastMine = -1
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].by === NAME) { lastMine = i; break } }
  const hits = msgs.slice(lastMine + 1).filter((m) => rx.test(String(m.text || '')) && m.by !== NAME)
  if (hits.length) finish('mention', { messages: hits.map((m) => `${m.by}(${m.kind}): ${m.text}`) })
}

hive.provider.on('sync', (s) => {
  if (!s) return
  if (!armed) {
    armed = true
    const who = hive.members().map((m) => `${m.name}(${m.kind})`).join(', ')
    console.error(`[watch] Ganesh-AI present in ${room}. In room: ${who}`)
    chat.observe(check)
  }
  check() // also check on every (re)sync, in case mentions landed while disconnected
})

setTimeout(() => finish('idle', { note: `no @${NAME} mention in ${IDLE_MIN} min` }), Number(IDLE_MIN) * 60 * 1000)
process.on('SIGINT', () => { try { hive.stop() } catch {}; process.exit(0) })
