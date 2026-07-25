// hive-claim — real file claims from the CLI, using the SAME coordinator the
// MCP hive_claim tool uses (sync.js -> hive-coord.js). Claims live in the shared
// Yjs 'claims' map with a 5-min TTL, so a one-shot claim persists for everyone to
// see while you edit, then you release it.
//
//   node hive-claim.js claim   <region> [name] [dir]
//   node hive-claim.js release <region> [name] [dir]
//   node hive-claim.js board            [name] [dir]
//
// Room/relay/token are read from <dir>/.hive.json (default ./workspace). Uses a
// throwaway sync dir with syncFiles:false so it never touches the project files —
// only the shared claim map.
import fs from 'fs'
import path from 'path'
import os from 'os'
import { startSync } from './sync.js'

const [action = '', region = '', NAME = 'PM', DIR = './workspace'] = process.argv.slice(2)
if (!['claim', 'release', 'board'].includes(action)) {
  console.error('usage: node hive-claim.js <claim|release|board> <region> [name] [dir]'); process.exit(1)
}
if (action !== 'board' && !region) { console.error('need a <region> (file path) for ' + action); process.exit(1) }

let cfg
try { cfg = JSON.parse(fs.readFileSync(path.join(path.resolve(DIR), '.hive.json'), 'utf8')) }
catch { console.error('no .hive.json in ' + DIR); process.exit(1) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-claim-'))
const hive = startSync({
  relay: cfg.relay, room: cfg.room, dir: tmp, name: NAME, kind: 'ai',
  token: process.env.HIVE_TOKEN || cfg.token || '', syncFiles: false, log: () => {},
})

hive.provider.on('sync', (s) => {
  if (!s) return
  let out
  if (action === 'board') out = JSON.stringify(hive.claimsBoard())
  else if (action === 'release') { hive.release(region); out = 'RELEASED ' + region }
  else { out = (hive.claim(region, 'edit') ? 'CLAIMED ' : 'DENIED ') + region }
  console.log(out)
  setTimeout(() => { hive.stop(); process.exit(0) }, 1500) // let the claim update propagate
})
setTimeout(() => { console.error('timeout connecting'); process.exit(2) }, 12000)
