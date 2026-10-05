// PERSISTENCE: IN SMALL TURNS, NEVER HALF-WRITTEN (27 Sep 2026).
//
// A persisting relay flushed every doc with a writeFileSync straight onto its snapshot, straight
// from a 1-second debounce timer. A first publish arms a thousand of those timers at once, so the
// relay did a thousand synchronous writes in a row (4.9 s of them on the dev machine) and served
// no room meanwhile; a relay killed mid-write left a truncated snapshot that loads as "no prior
// state". Now due flushes drain a few per event-loop turn and each write is a temp file renamed
// over the snapshot. What is pinned: every doc still reaches disk, no temp file is left behind, a
// restarted relay serves what was persisted, and a stale temp file from a crash is harmless.
//   node tests/persist-batch-test.mjs
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import WebSocket from 'ws'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { F, encodeFrame, decodeFrame, muxPath } = await import(pathToFileURL(path.join(ROOT, 'hive-mux-proto.js')).href)
const PORT = Number(process.env.HIVE_TEST_PORT) || (23000 + (process.pid % 9000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-persist-batch-'))
const startRelay = () => new Promise((res, rej) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: persist, HIVE_SEATS: '10' }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.on('data', () => { })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  p.on('exit', (c) => rej(new Error('relay exited ' + c)))
})
const updateMsg = (u) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, u); return encoding.toUint8Array(e) }
const step1 = (doc) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, doc); return encoding.toUint8Array(e) }
function peer(room, name) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/${muxPath(room)}?mux=1&name=${name}`)
    ws.binaryType = 'arraybuffer'
    const got = { opened: new Set(), docs: new Map() }
    ws.on('message', (d) => {
      const f = decodeFrame(new Uint8Array(d))
      if (f.kind === F.OPENED) got.opened.add(f.id)
      else if (f.kind === F.MSG && got.docs.has(f.id)) {
        const dec = decoding.createDecoder(new Uint8Array(f.payload))
        if (decoding.readVarUint(dec) === 0) { try { syncProtocol.readSyncMessage(dec, encoding.createEncoder(), got.docs.get(f.id), 'relay') } catch { } }
      }
    })
    ws.on('open', () => res({ ws, got }))
  })
}

console.log('\n=== PERSISTENCE: IN SMALL TURNS, NEVER HALF-WRITTEN ===')
const room = 'pbatch'
const N = 120
let relay = await startRelay()
{
  const A = await peer(room, 'Writer')
  for (let i = 1; i <= N; i++) A.ws.send(encodeFrame(F.OPEN, i, `${room}\u0001src/f${i}.js`))
  while (A.got.opened.size < N) await sleep(25)
  for (let i = 1; i <= N; i++) {
    const d = new Y.Doc(); let u = null
    d.on('update', (x) => { u = x })
    d.getText('content').insert(0, `export const v${i} = ${i}\n`)
    A.ws.send(encodeFrame(F.MSG, i, updateMsg(u)))
  }
  await sleep(3000) // 1 s debounce, then the batched drain
  const files = fs.readdirSync(persist)
  const bins = files.filter((f) => f.endsWith('.bin') && decodeURIComponent(f).includes('src/f')).length
  T('every written doc reached disk', bins === N, `${bins}/${N}`)
  T('no temp file is left behind', !files.some((f) => f.endsWith('.tmp')), files.filter((f) => f.endsWith('.tmp')).join(','))
  A.ws.close()
}
await sleep(500)
relay.kill()
await sleep(800)
// A crash between writing a temp file and renaming it leaves the temp beside the snapshot.
const victim = fs.readdirSync(persist).find((f) => f.endsWith('.bin') && decodeURIComponent(f).endsWith('src/f7.js.bin'))
if (victim) fs.writeFileSync(path.join(persist, victim + '.tmp'), 'half a write')
relay = await startRelay()
{
  const B = await peer(room, 'Reader')
  for (const i of [1, 7, N]) { B.got.docs.set(i, new Y.Doc()); B.ws.send(encodeFrame(F.OPEN, i, `${room}\u0001src/f${i}.js`)) }
  while (B.got.opened.size < 3) await sleep(25)
  for (const i of [1, 7, N]) B.ws.send(encodeFrame(F.MSG, i, step1(B.got.docs.get(i))))
  const want = (i) => `export const v${i} = ${i}\n`
  const end = Date.now() + 5000
  const ok = () => [1, 7, N].every((i) => B.got.docs.get(i).getText('content').toString() === want(i))
  while (!ok() && Date.now() < end) await sleep(50)
  T('a restarted relay serves what was persisted', ok(), [1, 7, N].map((i) => JSON.stringify(B.got.docs.get(i).getText('content').toString())).join(' '))
  T('...including the doc with a stale temp file beside its snapshot', B.got.docs.get(7).getText('content').toString() === want(7))
  B.ws.close()
}
relay.kill()
try { fs.rmSync(persist, { recursive: true, force: true }) } catch { }
console.log(`\n=== PERSISTENCE: ${pass} passed, ${fail} failed ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 300)
