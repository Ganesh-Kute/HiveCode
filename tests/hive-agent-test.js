// Proves an AI can join and use a room BY ITSELF — no human setup, no manual
// "I am an AI" declaration. A human client (folder.js) and an agent client
// (hive-agent.js) join the same room; we check the agent shows up as kind:'ai'
// automatically and its edits sync + get attributed to it on the board.
//
//   node hive-agent-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const PORT = 1242
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'agent-self'
const H = path.resolve('.agent-test/human')
const G = path.resolve('.agent-test/agent')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }

fs.rmSync(path.resolve('.agent-test'), { recursive: true, force: true })
fs.mkdirSync(H, { recursive: true }); fs.mkdirSync(G, { recursive: true })
fs.writeFileSync(path.join(H, 'main.js'), ['function a() {', '  return 1', '}', 'function b() {', '  return 2', '}'].join('\n'))

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const procs = []
const start = (args, tag) => {
  const p = spawn(process.execPath, args)
  p.stdout.on('data', (d) => process.stdout.write(`   [${tag}] ${d}`))
  p.stderr.on('data', (d) => process.stdout.write(`   [${tag}] ${d}`))
  procs.push(p); return p
}

// human joins via folder.js; AI joins BY ITSELF via hive-agent.js (link form)
start(['folder.js', RELAY, ROOM, H, 'Jeevan'], 'human')
start(['hive-agent.js', `${RELAY}|${ROOM}`, G, 'Bot'], 'agent')
await sleep(3000)

// observe awareness to see who's in the room and how they're identified
const odoc = new Y.Doc()
const oprov = new WebsocketProvider(RELAY, ROOM, odoc, { WebSocketPolyfill: WebSocket })
await new Promise((res) => oprov.on('sync', (s) => s && res()))
await sleep(1200)
const users = [...oprov.awareness.getStates().values()].map((s) => s.user).filter(Boolean)
console.log('\n   participants:', JSON.stringify(users))
assert('human present and tagged human', users.some((u) => u.name === 'Jeevan' && u.kind === 'human'))
assert('AGENT present and AUTO-tagged ai (no human declared it)', users.some((u) => u.name === 'Bot' && u.kind === 'ai'))

console.log('\n# the AI received the human\'s file by itself')
assert('agent got main.js without any human action', (read(G, 'main.js') || '').includes('function a'))

console.log('\n# the AI rewrites a file itself -> auto-logged + synced back to the human')
fs.writeFileSync(path.join(G, 'main.js'), ['function a(x) {', '  validate(x)', '  return x + 1', '}', 'function b(y) {', '  return y * 2', '}'].join('\n'))
await sleep(3000)
assert('human received the agent\'s rewrite', (read(H, 'main.js') || '').includes('validate(x)'))
const boardH = read(H, 'HIVE_BOARD.md') || ''
console.log('\n   human HIVE_BOARD.md:\n' + (boardH || '(none)').split('\n').map((l) => '      ' + l).join('\n'))
assert('board attributes the rewrite to the AI (Bot)', boardH.includes('Bot') && boardH.includes('main.js'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
oprov.destroy()
for (const p of procs) p.kill()
relay.kill()
fs.rmSync(path.resolve('.agent-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
