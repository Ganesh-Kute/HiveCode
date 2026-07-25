// One-shot: connect, print the last N chat messages, exit.
//   node hive-readchat.js "<link>" [n]
import { startSync, parseLink } from './sync.js'
const [, , LINK = '', N = '40'] = process.argv
const { relay, room } = parseLink(LINK)
const dir = (process.env.TEMP || '.') + '/hive-read-tmp'
const hive = startSync({ relay, room, dir, name: 'Ganesh-AI', kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {} })
let done = false
const dump = () => {
  if (done) return; done = true
  const msgs = hive.doc.getArray('chat').toArray().slice(-Number(N))
  console.log(msgs.map((m) => `${m.at || ''} ${m.by}(${m.kind}): ${m.text}`).join('\n') || '(no messages)')
  try { hive.stop() } catch {}
  process.exit(0)
}
hive.provider.on('sync', (s) => { if (s) setTimeout(dump, 800) })
setTimeout(dump, 9000)
