// Proves the live "control room" activity layer: each client broadcasts which
// file it is editing (rendered into HIVE_MEMBERS.md), and when a SECOND client
// starts editing a file someone is already on, it posts a proactive heads-up in
// chat — so collisions get coordinated before a clobber, not just merged after.
//
//   node hive-activity-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const PORT = 1250
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'activity'
const A = path.resolve('.activity-test/A')
const B = path.resolve('.activity-test/B')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return '' } }
const write = (dir, f, t) => fs.writeFileSync(path.join(dir, f), t)

fs.rmSync(path.resolve('.activity-test'), { recursive: true, force: true })
fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true })
write(A, 'shared.js', ['function a() { return 1 }', 'function b() { return 2 }', 'function c() { return 3 }'].join('\n'))

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const procs = []
const start = (dir, name) => {
  const p = spawn(process.execPath, ['folder.js', RELAY, ROOM, dir, name])
  p.stdout.on('data', (d) => process.stdout.write(`   [${name}] ${d}`))
  p.stderr.on('data', (d) => process.stdout.write(`   [${name}] ${d}`))
  procs.push(p)
}
start(A, 'Alice'); start(B, 'Bob')
await sleep(2500)
assert('Bob received shared.js', read(B, 'shared.js').includes('function a'))

console.log('\n# Alice starts editing shared.js -> her activity shows in the live member list')
write(A, 'shared.js', read(A, 'shared.js').replace('return 1', 'return 10'))
await sleep(2000)
const membersAfterAlice = read(B, 'HIVE_MEMBERS.md')
console.log('\n   HIVE_MEMBERS.md (seen by Bob):\n' + membersAfterAlice.split('\n').map((l) => '      ' + l).join('\n'))
assert('member list shows Alice editing shared.js', /Alice.*editing shared\.js/.test(membersAfterAlice))

console.log('\n# Bob ALSO starts editing shared.js -> proactive heads-up posted to chat')
write(B, 'shared.js', read(B, 'shared.js').replace('return 2', 'return 20'))
await sleep(2500)
const chat = read(A, 'HIVE_CHAT.md')
console.log('\n   tail of HIVE_CHAT.md:\n' + chat.split('\n').filter((l) => l.includes('heads-up') || l.includes('editing')).map((l) => '      ' + l).join('\n'))
assert('Bob posted a co-editing heads-up naming shared.js', /heads-up.*Bob.*shared\.js/.test(chat))
assert('the heads-up names the other editor (Alice)', /heads-up[\s\S]*Alice/.test(chat))
assert('both edits still merged (no work lost)', read(A, 'shared.js').includes('return 10') && read(A, 'shared.js').includes('return 20'))

console.log('\n# Activity fades: after idle, the member list no longer shows them editing')
await sleep(16000) // > EDIT_FRESH_MS (15s)
const membersIdle = read(B, 'HIVE_MEMBERS.md')
assert('editing status cleared after idle', !/editing shared\.js/.test(membersIdle))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
for (const p of procs) p.kill()
relay.kill()
fs.rmSync(path.resolve('.activity-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
