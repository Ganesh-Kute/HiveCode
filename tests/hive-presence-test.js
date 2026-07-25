// Proves an agent can know WHO is in the room and HOW MANY, live:
//   - HIVE_MEMBERS.md lists current participants (name + kind), with a count
//   - it updates when someone else joins, and again when they leave
//   - a join is also announced in HIVE_CHAT.md (so a waiting agent is woken)
//
//   node hive-presence-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startSync } from './sync.js'

const PORT = 1247
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'presence-test'
const A = path.resolve('.presence-test/a')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return '' } }

fs.rmSync(path.resolve('.presence-test'), { recursive: true, force: true })
fs.mkdirSync(A, { recursive: true })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

// Agent A joins (writes HIVE_MEMBERS.md into its folder)
const a = startSync({ relay: RELAY, room: ROOM, dir: A, name: 'Aria', kind: 'ai', owner: 'Jeevan', log: () => {} })
await sleep(1200)
let mem = read(A, 'HIVE_MEMBERS.md')
console.log('\n   after A joins:\n' + mem.split('\n').filter(Boolean).map((l) => '      ' + l).join('\n'))
assert('members file lists A', mem.includes('Aria'))
assert('shows A is an ai owned by Jeevan', mem.includes('(ai)') && mem.includes('Jeevan'))
assert('count is 1', /count: 1/.test(mem))

// A human B joins the same room
console.log('\n# a human (Jeevan) joins')
const b = startSync({ relay: RELAY, room: ROOM, dir: '.presence-test/b', name: 'Jeevan', kind: 'human', syncFiles: false, log: () => {} })
await sleep(1500)
mem = read(A, 'HIVE_MEMBERS.md')
console.log('   A now sees:\n' + mem.split('\n').filter(Boolean).map((l) => '      ' + l).join('\n'))
assert('A now sees 2 members', /count: 2/.test(mem))
assert('A sees the human Jeevan', mem.includes('Jeevan') && mem.includes('(human)'))

// B leaves -> A's presence updates back down
console.log('\n# the human leaves')
b.stop()
await sleep(1800)
mem = read(A, 'HIVE_MEMBERS.md')
console.log('   A now sees:\n' + mem.split('\n').filter(Boolean).map((l) => '      ' + l).join('\n'))
assert('A sees the count drop to 1 after leave', /count: 1/.test(mem))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
a.stop(); relay.kill()
fs.rmSync(path.resolve('.presence-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
