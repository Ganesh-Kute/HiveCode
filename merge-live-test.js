// LIVE proof of patch-apply-or-rework over the real relay.
//
//   node merge-live-test.js
//
// Spins up a relay on :1239, seeds a shared file, then launches the REAL
// agent-merge.js processes (separate OS processes, talking over WebSocket) and
// stages two collisions:
//   Scenario A — two agents edit DIFFERENT lines  -> both survive (merge, no rework)
//   Scenario B — two agents edit the SAME line     -> slow one conflicts & reworks
// A persistent observer reads the final file and asserts the outcome.

import { spawn } from 'child_process'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { applyDiff } from './core.js'

const PORT = 1239
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'merge-test'
const FILE = 'login.js'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (name, cond) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++ }

// --- relay ---
const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => {
  relay.stdout.on('data', (d) => { if (/listening on/.test(d.toString())) res() })
})
console.log(`relay up on :${PORT}\n`)

// --- persistent observer (seeds the file and reads the result) ---
const odoc = new Y.Doc()
const ofiles = odoc.getMap('files')
const oprov = new WebsocketProvider(RELAY, ROOM, odoc, { WebSocketPolyfill: WebSocket })
await new Promise((res) => oprov.on('sync', (s) => s && res()))

function seed(text) {
  let yt = ofiles.get(FILE)
  if (!yt) { yt = new Y.Text(); ofiles.set(FILE, yt) }
  applyDiff(yt, text)
}
const current = () => ofiles.get(FILE).toString()

function runAgent(name, reasonMs, find, replace) {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['agent-merge.js', RELAY, ROOM, name, FILE, String(reasonMs), find, replace])
    p.stdout.on('data', (d) => process.stdout.write('   ' + d))
    p.stderr.on('data', (d) => process.stdout.write('   ' + d))
    p.on('exit', res)
  })
}

const BASE = [
  'const greeting = "hi"',
  'function login(u, p) {',
  '  return check(u, p)',
  '}',
  'const farewell = "bye"',
].join('\n')

// ===================================================================
console.log('# Scenario A — disjoint edits (different lines) -> merge, no rework')
seed(BASE)
await sleep(600)
// Slow agent edits the greeting; fast agent edits the farewell. Slow starts
// first (reads base), fast writes first; slow then merges on top.
await Promise.all([
  runAgent('Slow', 2200, '"hi"', '"hello"'),
  (async () => { await sleep(250); return runAgent('Fast', 700, '"bye"', '"goodbye"') })(),
])
await sleep(600)
const a = current()
console.log('\n   final file:\n' + a.split('\n').map((l) => '      ' + l).join('\n') + '\n')
assert('Slow edit survived (greeting changed)', a.includes('"hello"'))
assert('Fast edit survived (farewell changed)', a.includes('"goodbye"'))
assert('no rework needed — both landed', a.includes('"hello"') && a.includes('"goodbye"'))

// ===================================================================
console.log('\n# Scenario B — same line, two ways -> slow agent conflicts & reworks')
seed(BASE)
await sleep(600)
await Promise.all([
  runAgent('Slow', 2200, 'check(u, p)', 'check(u, p) /*Slow*/'),
  (async () => { await sleep(250); return runAgent('Fast', 700, 'check(u, p)', 'check(u, p) /*Fast*/') })(),
])
await sleep(600)
const b = current()
console.log('\n   final file:\n' + b.split('\n').map((l) => '      ' + l).join('\n') + '\n')
assert('Fast edit survived', b.includes('/*Fast*/'))
assert('Slow edit survived too (reworked onto fresh code)', b.includes('/*Slow*/'))
assert('nobody silently clobbered — both tags present', b.includes('/*Fast*/') && b.includes('/*Slow*/'))

// ===================================================================
console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
oprov.destroy()
relay.kill()
process.exit(failed === 0 ? 0 : 1)
