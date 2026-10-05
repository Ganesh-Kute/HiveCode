// A BIG JOIN DOES NOT FREEZE THE RELAY (27 Sep 2026).
//
// A 1,000-file join sends 1,000 OPEN frames in a socket read or two, and the relay used to open
// every channel back to back, logging a line for each: measured by the relay's own event-loop
// delay across a 1,000-file publish with persistence on, the worst stall was 5-7 s, during which
// no other room on the relay was served. Now OPENs past a per-turn allowance wait their turn in
// order (relay-mux.js), and channel opens/closes are one 'channels' audit line per burst
// (server.js auditChannel). Worst stall after: ~1 s. What is pinned is the part that could go
// wrong, run with a deliberately tiny allowance (4 per turn) so almost everything queues:
//   - every channel opens, in the order asked
//   - a channel closed while still waiting never opens, and holds no slot
//   - a duplicate id is refused while its first OPEN is still waiting
//   - a burst writes one 'channels' line, not one line per file
//   node tests/mux-open-turns-test.mjs
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import WebSocket from 'ws'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { F, encodeFrame, decodeFrame, muxPath } = await import(pathToFileURL(path.join(ROOT, 'hive-mux-proto.js')).href)
const PORT = Number(process.env.HIVE_TEST_PORT) || (25000 + (process.pid % 9000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const out = []
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_SEATS: '10', HIVE_MUX_OPENS_PER_TURN: '4' }, stdio: ['ignore', 'pipe', 'pipe'] })
relay.stdout.on('data', (d) => out.push(String(d)))
relay.stderr.on('data', () => { })
await new Promise((res) => relay.stdout.on('data', (d) => { if (/listening on/.test(d)) res() }))

console.log('\n=== A BIG JOIN DOES NOT FREEZE THE RELAY ===')
const room = 'turns'
const ws = new WebSocket(`ws://localhost:${PORT}/${muxPath(room)}?mux=1&name=Joiner`)
ws.binaryType = 'arraybuffer'
const opened = [], refused = []
ws.on('message', (d) => {
  const f = decodeFrame(new Uint8Array(d))
  if (f.kind === F.OPENED) opened.push(f.id)
  else if (f.kind === F.REFUSED) refused.push({ id: f.id, code: f.code })
})
await new Promise((r) => ws.on('open', r))
const logBefore = out.join('').length

const N = 200, DROP = 150
for (let i = 1; i <= N; i++) ws.send(encodeFrame(F.OPEN, i, `${room}\u0001src/f${i}.js`))
ws.send(encodeFrame(F.CLOSE, DROP))                                   // closed while it waits
ws.send(encodeFrame(F.OPEN, 190, `${room}\u0001src/dup.js`))          // an id still waiting
const end = Date.now() + 15000
while (opened.length < N - 1 && Date.now() < end) await sleep(50)
await sleep(500)

T('every channel opens', opened.length === N - 1, `${opened.length}/${N - 1}`)
T('...in the order asked', opened.every((id, k) => k === 0 || id > opened[k - 1]))
T('a channel closed while waiting never opens', !opened.includes(DROP))
T('a duplicate id is refused while its first OPEN still waits', refused.some((r) => r.id === 190 && r.code === 409), JSON.stringify(refused.slice(0, 3)))
const health = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json()).catch(() => null)
T('...and the dropped one holds no slot', !!health && health.channels === N - 1, `channels=${health && health.channels}`)

await sleep(2600) // one 'channels' line per participant per burst, 2 s after it begins
const log = out.join('').slice(logBefore)
const perFile = (log.match(/opened "src\/f\d+\.js"/g) || []).length + (log.match(/"event":"connect"[^\n]*"file":"src\/f/g) || []).length
const summaries = (log.match(/"event":"channels"/g) || []).length
T('the burst is one summary line, not one line per file', summaries >= 1 && perFile === 0, `summaries=${summaries} per-file=${perFile}`)
const m = /"event":"channels"[^\n]*"opened":(\d+)/.exec(log)
T('...which counts every open', !!m && Number(m[1]) === N - 1, m ? `opened=${m[1]}` : 'no count')

ws.close()
relay.kill()
console.log(`\n=== MUX OPEN TURNS: ${pass} passed, ${fail} failed ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 300)
