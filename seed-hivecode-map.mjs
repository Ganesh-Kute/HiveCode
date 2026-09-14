// Seed the HIVECODE WORKFLOW into a room's map.
//
//   node seed-hivecode-map.mjs "wss://livecode-xoss.onrender.com|hivecode-workflow" [YourName]
//
// This is not the architecture -- `seed-agi-map.mjs` covers what depends on what. This is the
// SEQUENCE an agent actually goes through, drawn as `then` edges so it reads as a flow.
//
// It exists because of the problem this whole product has: when Hivecode works, nothing happens.
// A collision that was prevented leaves no trace, so the thing you are selling is invisible in
// every demo of it. This map is the trace. The refusal is a node, and when real agents are in the
// room the nodes pulse as their files are claimed -- so you point at the screen instead of
// explaining.
//
// The three enforcement points are marked `broken` ONLY in the sense that the palette has no
// "this is a gate" colour yet; they are marked `wip` so they read amber, which is the one thing on
// the flow a viewer should look at. Everything the agent does is `built`, because all of it runs.

import { startSync, parseLink } from './sync.js'
import { applyCommand } from './hive-map.js'

const [, , LINK = '', NAME = 'seed'] = process.argv
if (!LINK) { console.error('usage: node seed-hivecode-map.mjs "<relay|room>" [YourName]'); process.exit(2) }

const NODES = [
  // the agent's loop
  ['join',      'hive_join',            'step',  'built', '', 'one join per session. Rejoining tears down your session and can overwrite your own files.'],
  ['members',   'hive_members',         'step',  'built', '', 'who is actually here. A self-declared name is not a credential.'],
  ['readclaims','hive_claims',          'step',  'built', '', 'authoritative. Read this instead of asking the room who holds what.'],
  ['claim',     'hive_claim',           'step',  'built', '', ''],

  ['gate',      'RELAY DECIDES',        'gate',  'wip',   'server.js', 'no model involved. The transport refuses the write; the prompt is not asked.'],
  ['denied',    'DENIED',               'gate',  'wip',   '', 'not an error and not something to retry. Go do other work, or @ the holder.'],
  ['granted',   'granted',              'step',  'built', '', ''],

  ['edit',      'write the file',       'step',  'built', '', ''],
  ['crdt',      'CRDT sync',            'step',  'built', 'sync.js', 'every other folder changes within about a second. No git, no branches, no merge at the end.'],
  ['icr',       'ICR structural merge', 'gate',  'wip',   'icr.js', 'merges declarations, not text. Refuses to emit anything that will not parse; falls back to diff3.'],
  ['prov',      'signed provenance',    'step',  'built', 'substrate.js', 'who wrote this, stamped, not claimed'],
  ['release',   'hive_release',         'step',  'built', '', 'release what you have finished'],
  ['ttl',       'TTL expiry',           'step',  'built', '', 'the safety net: an agent that dies mid-edit does not hold the file forever'],

  ['say',       'hive_say @Name',       'step',  'built', '', 'a message naming nobody lands in an ambient digest where everyone is told to skip it'],
  ['check',     'hive_check',           'step',  'built', '', 'between edits, mid-task. hive_wait blocks, so it cannot be used while working.'],
  ['wait',      'hive_wait',            'step',  'built', 'hive-await.js', 'the idle state, not the end of the turn. Blocked costs nothing; returns the instant your name is said.'],

  // what a human sees
  ['map',       'the live map',         'ui',    'built', 'public/map.html', 'nodes pulse while their file is held - the prevented collision, made visible'],
  ['control',   'control room',         'ui',    'built', 'public/control.html', ''],
]

// The loop, as `then` edges.
const FLOW = [
  ['join', 'members', ''],
  ['members', 'readclaims', ''],
  ['readclaims', 'claim', ''],
  ['claim', 'gate', 'the relay, not the agent, decides'],
  ['gate', 'denied', 'someone else holds it'],
  ['gate', 'granted', 'free, or the lease expired'],
  ['denied', 'say', '@ the holder, or take other work'],
  ['granted', 'edit', ''],
  // The failure branch. A lease that outlives the agent holding it would lock a file forever, so
  // this is the path taken when nobody calls release -- because the process died, not because it
  // misbehaved. Leaving it unconnected was a real gap, and the reading panel is what surfaced it.
  ['granted', 'ttl', 'if the agent dies still holding it'],
  ['ttl', 'gate', 'the region becomes claimable again'],
  ['edit', 'crdt', ''],
  ['crdt', 'icr', 'only when two edits actually collide'],
  ['icr', 'prov', ''],
  ['prov', 'release', ''],
  ['release', 'wait', ''],
  ['wait', 'readclaims', 'woken by @name or @all - the loop closes'],
  ['edit', 'check', 'mid-task, because wait would block'],
  ['check', 'edit', ''],
  ['say', 'wait', ''],
]

// What the human surfaces read. These are dependencies, not steps.
const NEEDS = [
  ['map', 'gate', 'reads the claim map'],
  ['map', 'crdt', ''],
  ['control', 'crdt', ''],
]

const { relay, room } = parseLink(LINK)
const dir = (process.env.TEMP || '.') + '/hive-map-seed-workflow'
const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {} })
const graph = hive.doc.getMap('graph')

let done = false
hive.provider.on('sync', (s) => {
  if (!s || done) return
  done = true
  let n = 0, e = 0, bad = 0
  const take = (r) => { r.ok ? null : (bad++, console.error(`${r.code} ${r.msg}`)); return r.ok }
  for (const [id, label, kind, state, file, note] of NODES) {
    if (take(applyCommand(graph, NAME, 'add', [id], { label, kind, state, file, note }))) n++
  }
  for (const [from, to, why] of FLOW) {
    if (take(applyCommand(graph, NAME, 'link', [from, to], { why, kind: 'then' }))) e++
  }
  for (const [from, to, why] of NEEDS) {
    if (take(applyCommand(graph, NAME, 'link', [from, to], { why, kind: 'needs' }))) e++
  }
  console.log(`seeded ${n} nodes, ${e} edges into ${room}${bad ? ` (${bad} refused)` : ''}`)
  setTimeout(() => { try { hive.stop() } catch {} ; process.exit(bad ? 1 : 0) }, 1200)
})
setTimeout(() => { console.error(`Q470 could not reach the relay at ${relay}`); process.exit(1) }, 20000)
