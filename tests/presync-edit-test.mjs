// tests/presync-edit-test.mjs -- P0-1b of 0.14.3: an edit made right after joining, before the file
// synced, over HTTPS long-poll (the Antigravity VMs' transport), is never lost.
//
// Measured on 0.14.2 (tests/diag/presync-edit-race.mjs): the agent's folder holds the room's copy, it
// edits through hive_edit a moment after joining. Over long-poll the file's own doc has not synced yet,
// so first contact found no ancestor, kept the edit local without publishing it, and set the merge
// base to that unpublished edit; the next reconcile merged (local, local, room) = room, wrote the room's
// copy over the edit and announced "nothing lost". 8 runs: 0 arrived, 3 kept local only, 5 LOST from
// the room AND the agent's disk. Over WebSocket the file synced first and it arrived. (Root cause traced
// by Claude-cloud from the code, 9 Nov.)
//
//   E  hive_edit before the file synced: arrives in the room every time (its ancestor is known)
//   N  a plain disk write before the file synced (no ancestor recorded): may be kept local, but never
//      lost -- the agent's disk keeps the edit in every run

import http from 'http'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNS = Number(process.env.PRESYNC_EDIT_RUNS) || 6
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const port = await freePort()
const relayProc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((r) => relayProc.stdout.on('data', (d) => { if (/listening on/.test(d)) r() }))
// The VM's network: every WebSocket upgrade refused with 403, plain HTTP passed through.
const pport = await freePort()
const proxy = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const p = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res) })
    p.on('error', () => { try { res.writeHead(502); res.end() } catch { } }); p.end(Buffer.concat(chunks))
  })
})
proxy.on('upgrade', (req, socket) => { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy() })
await new Promise((r) => proxy.listen(pport, '127.0.0.1', r))
const direct = `ws://127.0.0.1:${port}`, vm = `ws://127.0.0.1:${pport}`
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const until = async (f, ms = 15000) => { const e = Date.now() + ms; while (Date.now() < e) { try { if (f()) return true } catch { } await sleep(100) } return false }

async function run(mode, i) {
  const room = `room-presync-edit-${mode}-${i}`
  const dB = fs.mkdtempSync(path.join(os.tmpdir(), 'pse-b-')), dA = fs.mkdtempSync(path.join(os.tmpdir(), 'pse-a-'))
  fs.writeFileSync(path.join(dB, 'early.txt'), 'v0\n')
  const B = startSync({ relay: direct, room, dir: dB, name: 'peer', kind: 'ai', log: () => { } })
  await until(() => B.provider.synced); await sleep(500)
  // The agent's folder holds the room's copy -- or, for 'local', a local change L the room never saw.
  fs.writeFileSync(path.join(dA, 'early.txt'), mode === 'local' ? 'v0\nL\n' : 'v0\n')
  const A = startSync({ relay: vm, room, dir: dA, name: 'vm-agent', kind: 'ai', log: () => { } })
  await until(() => A.provider.synced)
  if (mode === 'edit') A.edit('early.txt', 'v1\n', 'P0-1b')
  else if (mode === 'local') A.edit('early.txt', 'v0\nL\nE\n', 'P0-1b on top of L')
  else fs.writeFileSync(path.join(dA, 'early.txt'), 'v1\n')
  if (mode === 'local') { await sleep(4000); const out = { peer: read(path.join(dB, 'early.txt')), agent: read(path.join(dA, 'early.txt')) }; A.stop(); B.stop(); return out }
  await until(() => read(path.join(dB, 'early.txt')) === 'v1\n', 8000)
  await sleep(2000) // long enough for any later reconcile to have run
  const out = { peer: read(path.join(dB, 'early.txt')), agent: read(path.join(dA, 'early.txt')) }
  A.stop(); B.stop()
  return out
}

try {
  console.log(`\n# E  hive_edit before the file synced, over long-poll (${RUNS} runs)`)
  let arrived = 0, lostE = 0
  for (let i = 0; i < RUNS; i++) {
    const r = await run('edit', i)
    if (r.peer === 'v1\n') arrived++
    if (r.peer !== 'v1\n' && r.agent !== 'v1\n') lostE++
    console.log(`    run ${i}: peer=${JSON.stringify(r.peer)} agent=${JSON.stringify(r.agent)}`)
  }
  T(`E the edit reached the room in every run (${arrived}/${RUNS})`, arrived === RUNS)
  T(`E the edit was never lost from both the room and the agent's disk (${lostE} lost)`, lostE === 0)

  console.log(`\n# N  a plain disk write before the file synced, over long-poll (${RUNS} runs)`)
  let lostN = 0
  for (let i = 0; i < RUNS; i++) {
    const r = await run('disk', i)
    if (r.peer !== 'v1\n' && r.agent !== 'v1\n') lostN++
    console.log(`    run ${i}: peer=${JSON.stringify(r.peer)} agent=${JSON.stringify(r.agent)}`)
  }
  T(`N the write is never lost from both the room and the agent's disk (${lostN} lost; kept-local counts as not lost)`, lostN === 0)

  // Claude-cloud's review R1: the pre-sync ancestor must be one the room held. A folder carrying a
  // local change L the room never saw, edited before sync, must not have L merged away.
  console.log(`\n# L  a local change the room never saw, then hive_edit on top of it before sync (${RUNS} runs)`)
  let lostL = 0
  for (let i = 0; i < RUNS; i++) {
    const r = await run('local', i)
    const lSurvives = /\nL\n/.test(r.agent || '') || /\nL\n/.test(r.peer || '')
    if (!lSurvives) lostL++
    console.log(`    run ${i}: peer=${JSON.stringify(r.peer)} agent=${JSON.stringify(r.agent)}`)
  }
  T(`L the room-unseen local change L survives somewhere in every run (${lostL} lost)`, lostL === 0)
} catch (e) {
  fail++
  console.log('  FAIL threw: ' + (e && e.stack || e))
} finally {
  try { relayProc.kill('SIGKILL') } catch { }
  proxy.close()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
