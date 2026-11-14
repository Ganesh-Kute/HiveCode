// What a relay costs in memory and CPU when real clients join rooms holding a real repository.
//
//   node bench/relay-capacity.mjs [rooms=2] [clientsPerRoom=2] [sequentialRooms=3]
//
// It starts a relay from this checkout, copies this repository's tracked files under 1 MB into a
// folder, and has real clients (sync.js) share it. It prints one JSON line per step: the relay's
// resident memory (MB), its CPU seconds so far, and what /health reports. Two phases:
//   1. `rooms` rooms open AT ONCE, `clientsPerRoom` clients each: memory per active room and per client.
//   2. `sequentialRooms` rooms opened and left ONE AFTER ANOTHER: whether an empty room's memory comes back.
// Linux only (it reads /proc). Numbers from 13 Nov 2026 are in docs/OPERATIONS.md.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const [ROOMS = '2', PER_ROOM = '2', SEQ = '3'] = process.argv.slice(2)
const PORT = 1371
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-capacity-'))

// The repository as a client would share it: tracked files, nothing of 1 MB or more.
const src = path.join(tmp, 'src')
let files = 0, bytes = 0
for (const f of execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 << 20 }).toString().split('\0').filter(Boolean)) {
  let st; try { st = fs.statSync(path.join(ROOT, f)) } catch { continue }
  if (!st.isFile() || st.size >= 1048576) continue
  fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true })
  fs.copyFileSync(path.join(ROOT, f), path.join(src, f))
  files++; bytes += st.size
}
console.log(JSON.stringify({ shared: { files, MB: +(bytes / 1048576).toFixed(1) } }))

const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: path.join(tmp, 'store'), HIVE_SEATS: '32', HIVE_MAX_CHANNELS_TOTAL: '100000', HIVE_MAX_CONNS_TOTAL: '10000' } })
relay.stderr.on('data', () => { })
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('relay did not start')), 15000); relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } }) })

const rss = () => Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${relay.pid}/status`, 'utf8'))[1]) / 1024)
const cpu = () => { const f = fs.readFileSync(`/proc/${relay.pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100 }
const health = async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).json()
/** Wait until the channel count has not moved for six seconds: the join is over. */
const settle = async () => { let last = '', same = 0; for (let i = 0; i < 240; i++) { const h = await health(); const k = `${h.channels}`; if (k === last) { if (++same >= 6) return h } else same = 0; last = k; await sleep(1000) } return health() }
const note = async (step) => { const h = await settle(); await sleep(3000); console.log(JSON.stringify({ step, rssMB: rss(), cpuS: cpu(), sockets: h.connections, channels: h.channels })) }
const folder = (name, seeded) => { const d = path.join(tmp, name); if (seeded) fs.cpSync(src, d, { recursive: true }); else fs.mkdirSync(d, { recursive: true }); return d }
const join = (room, dir, name) => startSync({ relay: `ws://127.0.0.1:${PORT}`, room, dir, name, kind: 'ai', log: () => { } })

try {
  await note('empty relay')
  const open = []
  for (let r = 0; r < Number(ROOMS); r++) for (let i = 0; i < Number(PER_ROOM); i++) {
    open.push(join(`room-capacity-${process.pid}-${r}`, folder(`r${r}c${i}`, i === 0), `agent${i}`))
    await note(`room ${r + 1} of ${ROOMS} open at once: client ${i + 1}`)
  }
  for (const c of open) { try { c.stop() } catch { } }
  await sleep(5000); await note('every room left')
  for (let r = 0; r < Number(SEQ); r++) {
    const c = join(`room-sequential-${process.pid}-${r}`, folder(`s${r}`, true), 'agent')
    await note(`one room at a time, room ${r + 1}: open`)
    try { c.stop() } catch { }
    await sleep(4000); await note(`one room at a time, room ${r + 1}: left`)
  }
} finally {
  relay.kill()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
process.exit(0)
