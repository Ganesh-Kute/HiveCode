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
import { resolveRoomToken } from './hive-room-key.js'

let args = process.argv.slice(2)
let action, region = '', NAME = 'PM', DIR = ''
if (args[0] && ['claim', 'release', 'board'].includes(args[0])) {
  action = args[0]
  // `board` takes NO region. Destructuring one anyway shifted every later argument by one, so
  // `board <name> <dir>` bound NAME to the directory and left DIR empty — the search then fell
  // through to a different .hive.json and read a DIFFERENT ROOM. It printed `[]`: "nothing is
  // claimed", while two files were held. For a SENSE call that is the worst possible wrong
  // answer, because "the coast is clear" is the one reply that makes an agent write.
  if (action === 'board') [NAME = 'PM', DIR = ''] = args.slice(1)
  else [region = '', NAME = 'PM', DIR = ''] = args.slice(1)
} else {
  action = 'claim'
  ;[region = '', NAME = 'PM', DIR = ''] = args
}
if (action !== 'board' && !region) { console.error('need a <region> (file path) for ' + action); process.exit(1) }

const searchDirs = [DIR, '.', './workspace'].filter(Boolean)
let cfg = null
for (const d of searchDirs) {
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(path.resolve(d), '.hive.json'), 'utf8'))
    DIR = d
    break
  } catch {}
}
if (!cfg) { console.error('no .hive.json in ' + (DIR || './ or ./workspace')); process.exit(1) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-claim-'))
const hive = startSync({
  relay: cfg.relay, room: cfg.room, dir: tmp, name: NAME, kind: 'ai',
  token: resolveRoomToken({ room: cfg.room, name: NAME, dir: DIR }), syncFiles: false, log: () => {},
})

hive.provider.on('sync', async (s) => {
  if (!s) return
  let out
  if (action === 'board') out = JSON.stringify(hive.claimsBoard())
  else if (action === 'release') {
    // `--force "reason"` is the honest way out when work is being abandoned. Without it, a failing
    // gate keeps the claim and this must say so rather than printing RELEASED over a refusal.
    const fi = process.argv.indexOf('--force')
    const r = hive.release(region, fi > 0 ? { force: true, why: process.argv[fi + 1] || '' } : {})
    if (r && r.ok === false) { console.error(r.message); setTimeout(() => { try { hive.stop() } catch {} ; process.exit(1) }, 300); return }
    out = (r && r.forced ? 'FORCE-RELEASED ' : 'RELEASED ') + region
  }
  else {
    // Settled, not optimistic: the synchronous claim grants three simultaneous callers at once.
    const got = await hive.claimSettled(region, 'edit')
    out = (got ? 'CLAIMED ' : 'DENIED ') + region
  }
  console.log(out)
  setTimeout(() => { hive.stop(); process.exit(0) }, 1500) // let the claim update propagate
})
setTimeout(() => { console.error('timeout connecting'); process.exit(2) }, 12000)
