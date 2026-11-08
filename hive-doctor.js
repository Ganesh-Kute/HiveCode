// hive-doctor — is this room SAFE TO JOIN?
//
// Built 18 Sep 2026, the night three agent folders each lost 186 files to 0 bytes.
//
// A room can be in a state where joining it destroys your work, and nothing tells you.
// A file's NAME lives in the parent doc's manifest; its CONTENT lives in the file's own
// doc, on a separate connection. There is no atomicity between them. A client that joins
// a large project and dies mid-join publishes every name and only some bodies — leaving
// the room asserting that paths exist with nothing behind them. The next client to join
// believes the manifest, syncs an empty doc, and writes 0 bytes over its real file.
//
// That is invisible from outside: /health reports connections and doc counts, all of
// which look perfectly normal. The only way to know is to open the docs and look.
//
//   node hive-doctor.js "ws://127.0.0.1:1300|my-room"
//   node hive-doctor.js "<link>" --dir C:/path/to/folder     # also compare against disk
//   node hive-doctor.js "<link>" --limit 500                 # cap how many docs to open
//
// Exit 0 = safe to join. Exit 1 = joining this room will empty files. Exit 2 = usage.
//
// The --dir form is the one that matters before a join: it reports HOLLOW paths, meaning
// registered in the room, empty there, and non-empty on your disk. Those are precisely
// the files you are about to lose.

import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
// HiveSocket, not raw ws: the same pipe every client uses, so the doctor reaches the relay behind a
// proxy too (CONNECT tunnel, long-poll where the upgrade is refused; loopback direct; HIVE_PROXY=off).
import { HiveSocket, unreachedReason } from './hive-transport.js'
import { parseLink } from './sync.js'
import { fileRoom } from './token.js'

const argv = process.argv.slice(2)
const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || d) }
const LINK = argv.find((a) => !a.startsWith('--'))
if (!LINK) {
  console.error('usage: node hive-doctor.js "<relay|room>" [--dir <folder>] [--limit N] [--json]')
  process.exit(2)
}
const DIR = flag('dir', '')
const LIMIT = Number(flag('limit', '4000')) || 4000
const JSON_OUT = argv.includes('--json')
const { relay, room } = parseLink(LINK)
const wsOpts = { WebSocketPolyfill: HiveSocket, connect: true }
const BATCH = 24          // sockets open at once — a full project is thousands of files
const SYNC_MS = 6000      // how long one batch may take to report synced

const log = (...a) => { if (!JSON_OUT) console.log(...a) }

function syncedOnce(provider, ms) {
  return new Promise((res) => {
    let done = false
    const finish = (ok) => { if (!done) { done = true; res(ok) } }
    const t = setTimeout(() => finish(false), ms)
    provider.on('sync', (s) => { if (s) { clearTimeout(t); finish(true) } })
  })
}

const doc = new Y.Doc()
const provider = new WebsocketProvider(relay, room, doc, wsOpts)
let firstError = null // the first connection error says WHY: never reached it, or it refused
provider.on('connection-error', (ev) => { if (!firstError) firstError = ev })
if (!(await syncedOnce(provider, 15000))) {
  const why = firstError && unreachedReason(firstError)
  console.error(`Q543 could not reach the relay at ${relay} (room "${room}")${why ? `: ${why}` : ''}`)
  process.exit(2)
}

const manifest = doc.getMap('manifest')
const paths = [...manifest.keys()].sort()
log(`\n  room      ${room}`)
log(`  relay     ${relay}`)
log(`  registered ${paths.length} path(s)${paths.length > LIMIT ? ` — checking the first ${LIMIT}` : ''}`)

const onDisk = (rel) => {
  if (!DIR) return null
  try { return fs.statSync(path.join(DIR, rel)).size } catch { return null }
}

const empty = []    // registered, but the doc holds nothing
const hollow = []   // empty in the room AND non-empty on disk -> joining destroys these
const checked = paths.slice(0, LIMIT)
let bytes = 0

for (let i = 0; i < checked.length; i += BATCH) {
  const slice = checked.slice(i, i + BATCH)
  await Promise.all(slice.map(async (rel) => {
    const fdoc = new Y.Doc()
    const fprov = new WebsocketProvider(relay, fileRoom(room, rel), fdoc, wsOpts)
    await syncedOnce(fprov, SYNC_MS)
    const len = fdoc.getText('content').toString().length
    bytes += len
    if (len === 0) {
      empty.push(rel)
      const disk = onDisk(rel)
      if (disk && disk > 0) hollow.push({ file: rel, diskBytes: disk })
    }
    try { fprov.destroy() } catch { }
    try { fdoc.destroy() } catch { }
  }))
  if (!JSON_OUT) process.stdout.write(`\r  opened    ${Math.min(i + BATCH, checked.length)}/${checked.length}   `)
}
log('')

const verdict = hollow.length ? 'UNSAFE' : (empty.length ? 'SUSPECT' : 'OK')

if (JSON_OUT) {
  console.log(JSON.stringify({ room, relay, registered: paths.length, checked: checked.length, contentBytes: bytes, empty: empty.length, hollow, verdict }, null, 2))
} else {
  log(`  content   ${(bytes / 1024).toFixed(1)} KB across ${checked.length} doc(s)`)
  log(`  empty     ${empty.length} registered path(s) hold nothing`)
  if (DIR) log(`  hollow    ${hollow.length} of those are NON-EMPTY on your disk`)
  log('')
  if (verdict === 'OK') {
    log('  SAFE TO JOIN — every registered path has content behind it.\n')
  } else if (verdict === 'SUSPECT') {
    log('  SUSPECT — some paths are registered with empty docs. That is normal only if')
    log('  those files are genuinely empty. Re-run with --dir <your folder> to find out')
    log('  whether joining would overwrite real bytes.\n')
  } else {
    log('  DO NOT JOIN. These files are registered in the room, empty there, and real on')
    log('  your disk. Joining replaces them with 0 bytes:\n')
    for (const h of hollow.slice(0, 40)) log(`    ${String(h.diskBytes).padStart(9)} B   ${h.file}`)
    if (hollow.length > 40) log(`    ... and ${hollow.length - 40} more`)
    log('\n  A client died mid-join and left its promises behind. Seed the room from a')
    log('  complete copy, or start a fresh room, before anyone else connects.\n')
  }
}

try { provider.destroy() } catch { }
process.exit(hollow.length ? 1 : 0)
