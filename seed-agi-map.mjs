// Seed the personal-AGI architecture into a room's map, as it actually stands.
//
//   node seed-agi-map.mjs "wss://livecode-xoss.onrender.com|personal-agi" [YourName]
//
// Written as a script rather than a shell loop because Git Bash rewrites any argument that looks
// like a unix path -- "/mcp endpoint" became "C:/Program Files/Git/mcp endpoint" in the first run,
// silently, in the label a human reads.
//
// `built` means VERIFIED WORKING, not "the file exists". Every built node below was actually run.
// If that stops being true this map is worth nothing, because its only job is to be trusted at a
// glance.

import { startSync, parseLink } from './sync.js'
import { applyCommand } from './hive-map.js'

const [, , LINK = '', NAME = 'seed'] = process.argv
if (!LINK) { console.error('usage: node seed-agi-map.mjs "<relay|room>" [YourName]'); process.exit(2) }

const NODES = [
  // id,          label,                  kind,       state,     file,                    note
  ['relay',       'relay (server.js)',    'service',  'built',   'server.js', ''],
  ['claims',      'claim enforcement',    'service',  'built',   'sync.js', 'relay refuses the write; not a prompt asking nicely'],
  ['icr',         'ICR merge',            'service',  'built',   'icr.js', ''],
  ['mcp',         'remote MCP endpoint',  'service',  'built',   'remote-mcp.js', ''],
  ['mcpauth',     'token auth',           'service',  'built',   'remote-mcp.js', 'verified live: 401 to a stranger, 200 to the token'],
  ['crdtbundle',  'hive-crdt.js',         'asset',    'built',   'public/hive-crdt.js', 'one Yjs. Two is what made /control deaf.'],
  ['control',     'control room',         'ui',       'built',   'public/control.html', ''],
  ['map',         'live map',             'ui',       'built',   'public/map.html', 'this page'],
  ['await',       'hive-await',           'script',   'built',   'hive-await.js', 'blocks on the event; sleeping is deaf'],
  ['timeline',    'timeline.jsonl',       'script',   'built',   'agi/timeline.mjs', ''],
  ['watchmail',   'watch-mail (IMAP)',    'script',   'built',   'agi/watch-mail.mjs', 'bulk filter measured: 40 mails/day down to 5'],
  ['beat',        'beat',                 'script',   'built',   'agi/beat.mjs', ''],
  ['morning',     '8am brief',            'script',   'built',   'agi/morning.mjs', 'zero model tokens. The only thing that delivered on 11 Sep.'],
  ['hook',        'injection hook',       'script',   'built',   'hive-context-hook.js', '23/23; abstains when nothing is held'],
  ['hostinger',   'Hostinger IMAP',       'external', 'built',   '', 'getgrm.tech mail actually lives here'],

  ['telegram',    'Telegram bridge',      'external', 'broken',  'agi/telegram-bridge.mjs', 'Q501 telegram poll failed x31 in the timeline'],
  ['presence',    'presence expiry',      'service',  'broken',  'sync.js', 'claims have a TTL, seats do not - dead agents keep their seat'],
  ['gmail',       'Gmail connector',      'external', 'broken',  '', 'getgrm.tech MX is Hostinger. There is no Google mailbox to connect.'],

  ['gemconn',     'Gemini connector',     'external', 'wip',     '', 'endpoint answers 200; tools are not reaching the agent yet'],
  ['scout',       'Scout',                'agent',    'wip',     '', 'created in Gemini, no mail source yet'],

  ['npmrelay',    'hivecode-relay',       'package',  'planned', '', '404 on npm. This is what makes self-hosting one command.'],
  ['director',    'Director',             'agent',    'planned', '', 'the only agent that talks to Ganesh'],
  ['researcher',  'Researcher',           'agent',    'planned', '', ''],
]

const EDGES = [
  ['claims', 'relay', 'enforced at the relay'],
  ['icr', 'relay', ''],
  ['mcp', 'relay', ''],
  ['mcpauth', 'mcp', ''],
  ['control', 'crdtbundle', ''],
  ['map', 'crdtbundle', ''],
  ['map', 'claims', 'a node pulses while its file is held'],
  ['await', 'relay', ''],
  ['watchmail', 'hostinger', ''],
  ['watchmail', 'timeline', ''],
  ['beat', 'timeline', ''],
  ['morning', 'timeline', ''],
  ['morning', 'telegram', 'this is how the brief reaches the phone'],
  ['hook', 'claims', ''],
  ['director', 'telegram', ''],
  ['director', 'timeline', ''],
  ['director', 'gemconn', ''],
  ['scout', 'gmail', 'BROKEN - this is why Scout has no input'],
  ['scout', 'gemconn', ''],
  ['researcher', 'gemconn', ''],
  ['gemconn', 'mcpauth', ''],
  ['npmrelay', 'relay', 'would package this'],
  ['presence', 'relay', ''],
]

const { relay, room } = parseLink(LINK)
const dir = (process.env.TEMP || '.') + '/hive-map-seed'
const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {} })
const graph = hive.doc.getMap('graph')

let done = false
hive.provider.on('sync', (s) => {
  if (!s || done) return
  done = true
  let n = 0, e = 0, bad = 0
  for (const [id, label, kind, state, file, note] of NODES) {
    const r = applyCommand(graph, NAME, 'add', [id], { label, kind, state, file, note })
    r.ok ? n++ : (bad++, console.error(`${r.code} ${r.msg}`))
  }
  for (const [from, to, why] of EDGES) {
    const r = applyCommand(graph, NAME, 'link', [from, to], { why })
    r.ok ? e++ : (bad++, console.error(`${r.code} ${r.msg}`))
  }
  console.log(`seeded ${n} nodes, ${e} edges into ${room}${bad ? ` (${bad} refused)` : ''}`)
  setTimeout(() => { try { hive.stop() } catch {} ; process.exit(bad ? 1 : 0) }, 1200)
})
setTimeout(() => { console.error(`Q470 could not reach the relay at ${relay}`); process.exit(1) }, 20000)
