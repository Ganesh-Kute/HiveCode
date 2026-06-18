// Proves AIs can host + invite + TALK with NO human in the loop:
//   - agent One runs with no link -> HOSTS a room, writes .hive.json
//   - we copy that .hive.json to agent Two's folder (simulating a shared repo)
//   - agent Two runs with no link -> rendezvous-joins the SAME room
//   - both announce themselves in the chat; a hive-say message reaches both
//
//   node hive-talk-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const PORT = 1243
const RELAY = `ws://localhost:${PORT}`
const ONE = path.resolve('.talk-test/one')
const TWO = path.resolve('.talk-test/two')
const CHAT = 'HIVE_CHAT.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
const env = { ...process.env, HIVE_RELAY: RELAY }

fs.rmSync(path.resolve('.talk-test'), { recursive: true, force: true })
fs.mkdirSync(ONE, { recursive: true }); fs.mkdirSync(TWO, { recursive: true })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const procs = []
const start = (args, tag) => {
  const p = spawn(process.execPath, args, { env })
  p.stdout.on('data', (d) => process.stdout.write(`   [${tag}] ${d}`))
  procs.push(p); return p
}

// 1. agent One HOSTS (no link, no config) -> writes .hive.json
start(['hive-agent.js', '', ONE, 'One'], 'One')
await sleep(2000)
const cfg = read(ONE, '.hive.json')
assert('agent One hosted and wrote .hive.json', cfg && JSON.parse(cfg).room)
const room = cfg ? JSON.parse(cfg).room : ''

// 2. share the rendezvous config with Two (as if the repo was cloned)
fs.writeFileSync(path.join(TWO, '.hive.json'), cfg)

// 3. agent Two JOINS via rendezvous (no link given)
start(['hive-agent.js', '', TWO, 'Two'], 'Two')
await sleep(2500)
assert('agent Two rendezvous-joined the SAME room', (read(TWO, '.hive.json') || '').includes(room))
assert('HIVE_RULES.md auto-written into both folders (the law is present)', (read(ONE, 'HIVE_RULES.md') || '').includes('HIVE RULES') && (read(TWO, 'HIVE_RULES.md') || '').includes('HIVE RULES'))

// 4. both should see both join announcements in the chat
const chatOne = read(ONE, CHAT) || '', chatTwo = read(TWO, CHAT) || ''
console.log('\n   --- One/HIVE_CHAT.md ---\n' + chatOne.split('\n').map((l) => '      ' + l).join('\n'))
assert('One sees its own announce', chatOne.includes('One joined'))
assert('One sees Two\'s announce (they are connected)', chatOne.includes('Two joined'))
assert('Two sees both announces too', chatTwo.includes('One joined') && chatTwo.includes('Two joined'))

// 5. a coordination message reaches everyone
console.log('\n# a coordination message is broadcast to the room')
await new Promise((res) => { const p = start(['hive-say.js', `${RELAY}|${room}`, 'One', 'taking auth.js — adding login()'], 'say'); p.on('exit', res) })
await sleep(1500)
assert('message reached One', (read(ONE, CHAT) || '').includes('taking auth.js'))
assert('message reached Two', (read(TWO, CHAT) || '').includes('taking auth.js'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
for (const p of procs) p.kill()
relay.kill()
fs.rmSync(path.resolve('.talk-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
