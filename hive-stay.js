// Persistent presence/chat client — stay in a Hive room as a live participant
// WITHOUT syncing files (so it never conflicts with an extension already syncing
// the folder). Keeps me listed in HIVE_MEMBERS and lets me read the live chat.
//
//   node hive-stay.js "<link>" "<name>"
import path from 'path'
import { startSync, parseLink } from './sync.js'

const [, , LINK = '', NAME = 'Claude-Backend'] = process.argv
const { relay, room } = parseLink(LINK)
const dir = path.join(process.env.TEMP || '.', 'hive-presence-' + NAME)

const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', syncFiles: false, log: () => {} })
hive.provider.on('sync', (s) => {
  if (!s) return
  const who = hive.members().map((m) => `${m.name}(${m.kind})`).join(', ') || 'just me'
  console.log(`[hive-stay] "${NAME}" present in ${room}. In room: ${who}`)
})
process.on('SIGINT', () => { hive.stop(); process.exit(0) })
