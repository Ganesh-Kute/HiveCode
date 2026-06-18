// One-command collision test against your LIVE Hivecode session.
//
//   node hive-collide.js "<paste your join link>"
//   e.g. node hive-collide.js "wss://livecode-xoss.onrender.com|room-AbC123"
//
// (The join link is in the Hivecode panel under "Your join link" — it's the
//  relay and room separated by a "|".  Copy it with the Copy button.)
//
// It joins the SAME room your editor folders share, seeds a throwaway file
// (hive-test.js — it will NOT touch your real source), then launches two
// lock-free agents that BOTH edit the same line. You watch hive-test.js appear
// and update live in BOTH connected folders: the fast agent writes first, the
// slow one detects the conflict and reworks on top — nothing is lost.

import { spawn } from 'child_process'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { applyDiff } from './core.js'

const LINK = process.argv[2] || ''
if (!LINK.includes('|')) {
  console.error('Usage: node hive-collide.js "<relay>|<room>"   (paste your Hivecode join link)')
  process.exit(1)
}
const [RELAY, ROOM] = LINK.split('|').map((s) => s.trim())
const FILE = 'hive-test.js'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BASE = [
  '// Hivecode collision test — safe to delete.',
  'function login(u, p) {',
  '  return check(u, p)',
  '}',
].join('\n')

const doc = new Y.Doc()
const files = doc.getMap('files')
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })

console.log(`connecting to ${RELAY}  room ${ROOM} ...`)
await new Promise((res) => provider.on('sync', (s) => s && res()))
console.log('connected. seeding hive-test.js into the room...')

let yt = files.get(FILE)
if (!yt) { yt = new Y.Text(); files.set(FILE, yt) }
applyDiff(yt, BASE)
await sleep(1500) // let both folders write it to disk

function runAgent(name, reasonMs, find, replace) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['agent-merge.js', RELAY, ROOM, name, FILE, String(reasonMs), find, replace])
    p.stdout.on('data', (d) => process.stdout.write(`   ${d}`))
    p.stderr.on('data', (d) => process.stdout.write(`   ${d}`))
    p.on('exit', res)
  })
}

console.log('firing two agents at the SAME line (Fast writes first, Slow reworks)...\n')
await Promise.all([
  runAgent('Slow', 5000, 'return check(u, p)', 'return check(u, p) // Slow: validated input'),
  (async () => { await sleep(300); return runAgent('Fast', 800, 'return check(u, p)', 'return check(u, p) // Fast: added logging') })(),
])

await sleep(1200)
console.log('\nfinal hive-test.js in the room:\n')
console.log(files.get(FILE).toString().split('\n').map((l) => '   ' + l).join('\n'))
console.log('\n^ both comments present = the slow agent reworked instead of clobbering.')
console.log('Check hive-test.js in BOTH folders — it should match this. (Delete it when done.)')
provider.destroy()
process.exit(0)
