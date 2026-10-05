// OVER THE RATE, A FRAME WAITS; IT IS NEVER DROPPED (27 Sep 2026). The relay used to drop a frame
// once a connection was over its rate. A dropped Yjs update is a gap every later update from that
// client builds on, so the relay parked them all as pending and the document froze for that client:
// a 1,000-file first publish on the free tier left a teammate's file list at 305 entries, forever,
// with every socket healthy. Now an over-budget frame waits in order and the connection stops being
// read until the queue drains at the tier's rate. Pinned here against a real relay, on the three
// paths a frame can take:
//   A. a plain socket (the base room, where the manifest lives) -- every update arrives, and the
//      rate is still honoured (a relay that simply stopped limiting would fail the timing check);
//   B. a mux channel -- same, and the participant's OTHER channels work again once it drains
//      (a channel that paused the shared socket and never released it would fail);
//   C. the backstop -- a connection that keeps pushing past a paused read is closed, and a real
//      provider's reconnect resyncs everything, so even that path loses nothing.
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { F, encodeFrame, decodeFrame, muxPath } = await import(pathToFileURL(path.join(ROOT, 'hive-mux-proto.js')).href)
const L = await import(pathToFileURL(path.join(ROOT, 'limits.js')).href)
const BASE = Number(process.env.HIVE_TEST_PORT) || (29000 + (process.pid % 9000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }
const RATE = 100, BURST = 40

const relays = []
async function startRelay(port, extra = {}) {
  const env = { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off', HIVE_FREE_MSGS_PER_SEC: String(RATE), HIVE_FREE_MSG_BURST: String(BURST), ...extra }
  delete env.HIVE_SEATS
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  p.log = ''
  p.stderr.on('data', (d) => { p.log += d })
  await new Promise((res, rej) => { p.stdout.on('data', (d) => { if (/listening on/.test(d)) res() }); p.on('exit', (c) => rej(new Error('relay exited ' + c))) })
  relays.push(p)
  return p
}
const updateMsg = (u) => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, u); return encoding.toUint8Array(e) }
// Applies every sync message in `payload` to `doc` (what a real provider does with a broadcast).
const applySync = (doc, payload) => {
  const dec = decoding.createDecoder(new Uint8Array(payload))
  if (decoding.readVarUint(dec) !== 0) return
  try { syncProtocol.readSyncMessage(dec, encoding.createEncoder(), doc, 'relay') } catch { }
}
// N separate transactions on `doc`, each captured as its own update: N frames, as a seeder sends.
function manyUpdates(n, write) {
  const doc = new Y.Doc(), out = []
  doc.on('update', (u) => out.push(u))
  for (let i = 0; i < n; i++) doc.transact(() => write(doc, i))
  return out
}

console.log('\n=== OVER THE RATE, A FRAME WAITS ===')

console.log('\n# The limiter contract')
{
  const lim = L.attachRateLimit({}, { tier: 'free', msgsPerSec: 10, msgBurst: 3, bytesPerSec: 1000, byteBurst: 100, maxFrameBytes: 10000 })
  T('within the burst, frames pass', [1, 2, 3].every(() => lim.check(10) === null))
  const over = lim.check(10)
  T('over the rate says WAIT, not refuse', !!over && over.hold === true && /^Q432/.test(over.reason))
  T('...with how long to wait', !!over && over.retryMs > 0 && over.retryMs <= 100, `retryMs=${over && over.retryMs}`)
  T('a wait is not a refusal', lim.refused === 0)
  const big = lim.check(20000)
  T('an oversized frame is still refused outright (no wait can fix it)', !!big && !big.hold && /^Q433/.test(big.reason))
  const lim2 = L.attachRateLimit({}, { tier: 'free', msgsPerSec: 10, msgBurst: 3, bytesPerSec: 1000, byteBurst: 100, maxFrameBytes: 10000 })
  T('a frame bigger than the whole byte burst passes when the bucket is full', lim2.check(500) === null)
  const after = lim2.check(10)
  T('...and leaves a debt the rate repays', !!after && after.hold && /^Q434/.test(after.reason) && after.retryMs >= 400, `retryMs=${after && after.retryMs}`)
  // msgs 2, bytes 100: a 90-byte frame passes, a 50-byte one waits on BYTES. Had that wait kept
  // its message token, the message bucket would now be empty and a 5-byte frame would wait too.
  const lim3 = L.attachRateLimit({}, { tier: 'free', msgsPerSec: 0.001, msgBurst: 2, bytesPerSec: 0.001, byteBurst: 100, maxFrameBytes: 10000 })
  const p1 = lim3.check(90), w = lim3.check(50), p2 = lim3.check(5)
  T('a byte wait gives its message token back', p1 === null && !!w && /^Q434/.test(w.reason) && p2 === null)
}

// ── A. plain socket, the base room ──────────────────────────────────────────────────────────────
console.log('\n# A. a plain socket over its rate: every update arrives, at the rate')
const relayA = await startRelay(BASE)
{
  const room = 'holdA'
  const N = 400
  const ups = manyUpdates(N, (d, i) => d.getMap('manifest').set(`src/f${i}.js`, 1))
  const open = (name) => new Promise((res) => { const ws = new WebSocket(`ws://localhost:${BASE}/${room}?name=${name}`); ws.binaryType = 'arraybuffer'; ws.on('open', () => res(ws)) })
  const recv = new Y.Doc()
  const B = await open('Hold-B')
  B.on('message', (d) => applySync(recv, d))
  const A = await open('Hold-A')
  await sleep(300)
  const t0 = Date.now()
  for (const u of ups) A.send(updateMsg(u))
  const keys = () => recv.getMap('manifest').size
  const end = Date.now() + 25000
  while (keys() < N && Date.now() < end) await sleep(50)
  const took = Date.now() - t0
  T('the other participant gets EVERY update (it froze at the burst before)', keys() === N, `${keys()}/${N} in ${took} ms`)
  const floor = ((N - BURST) / RATE) * 1000 * 0.7
  T('...and the rate is still honoured, not bypassed', took >= floor, `${took} ms >= ${Math.round(floor)} ms`)
  T('the relay said so, and said nothing was dropped', /Q432[^\n]*nothing dropped/.test(relayA.log))
  // The connection must be READ again once drained: one more update lands promptly.
  const one = manyUpdates(1, (d) => d.getMap('late').set('x', 1))
  A.send(updateMsg(one[0]))
  const e2 = Date.now() + 3000
  while (!recv.getMap('late').has('x') && Date.now() < e2) await sleep(25)
  T('after draining, the socket is read again', recv.getMap('late').has('x'))
  A.close(); B.close()
}

// ── B. a mux channel ────────────────────────────────────────────────────────────────────────────
console.log('\n# B. a mux channel over its rate: nothing lost, and the shared socket is released')
{
  const room = 'holdB'
  const docA = `${room}\u0001src/a.js`, docB = `${room}\u0001src/b.js`
  const peer = (name) => new Promise((res) => {
    const ws = new WebSocket(`ws://localhost:${BASE}/${muxPath(room)}?mux=1&name=${name}`)
    ws.binaryType = 'arraybuffer'
    const got = { opened: new Set(), docs: { 1: new Y.Doc(), 2: new Y.Doc() } }
    ws.on('message', (d) => {
      const f = decodeFrame(new Uint8Array(d))
      if (f.kind === F.OPENED) got.opened.add(f.id)
      else if (f.kind === F.MSG && got.docs[f.id]) applySync(got.docs[f.id], f.payload)
    })
    ws.on('open', () => res({ ws, got }))
  })
  const C = await peer('Hold-C'), D = await peer('Hold-D')
  for (const p of [C, D]) { p.ws.send(encodeFrame(F.OPEN, 1, docA)); p.ws.send(encodeFrame(F.OPEN, 2, docB)) }
  while (C.got.opened.size < 2 || D.got.opened.size < 2) await sleep(25)
  await sleep(500)
  const N = 300
  const ups = manyUpdates(N, (d, i) => d.getText('content').insert(d.getText('content').length, `line ${i}\n`))
  for (const u of ups) C.ws.send(encodeFrame(F.MSG, 1, updateMsg(u)))
  const text = () => D.got.docs[1].getText('content').toString()
  const lines = () => (text().match(/\n/g) || []).length
  const end = Date.now() + 25000
  while (lines() < N && Date.now() < end) await sleep(50)
  T('the flooded file arrives complete, in order', lines() === N && text().startsWith('line 0\nline 1\n') && text().endsWith(`line ${N - 1}\n`), `${lines()}/${N} lines`)
  // The OTHER channel of the same participant: if the flooded channel paused the physical socket
  // and never released it, this never arrives.
  const other = manyUpdates(1, (d) => d.getText('content').insert(0, 'other file\n'))
  C.ws.send(encodeFrame(F.MSG, 2, updateMsg(other[0])))
  const e2 = Date.now() + 3000
  while (!D.got.docs[2].getText('content').toString().includes('other file') && Date.now() < e2) await sleep(25)
  T("the participant's other file still flows after the drain", D.got.docs[2].getText('content').toString().includes('other file'))
  // A channel closed WHILE held must not leave the shared socket paused either.
  const more = manyUpdates(BURST * 3, (d, i) => d.getMap('m').set(`k${i}`, i))
  for (const u of more) C.ws.send(encodeFrame(F.MSG, 1, updateMsg(u)))
  C.ws.send(encodeFrame(F.CLOSE, 1))
  const last = manyUpdates(1, (d) => d.getText('content').insert(0, 'after close\n'))
  await sleep(100)
  C.ws.send(encodeFrame(F.MSG, 2, updateMsg(last[0])))
  const e3 = Date.now() + 4000
  while (!D.got.docs[2].getText('content').toString().includes('after close') && Date.now() < e3) await sleep(25)
  T('a channel closed while held releases the socket', D.got.docs[2].getText('content').toString().includes('after close'))
  C.ws.close(); D.ws.close()
}

// ── C. the backstop ─────────────────────────────────────────────────────────────────────────────
console.log('\n# C. the backstop: a connection pushing past a paused read is closed, and resyncs losslessly')
const PORT_C = BASE + 1
const relayC = await startRelay(PORT_C, { HIVE_HOLD_MAX_FRAMES: '20' })
{
  const room = 'holdC'
  const docA = new Y.Doc(), docB = new Y.Doc()
  const pa = new WebsocketProvider(`ws://localhost:${PORT_C}`, room, docA, { WebSocketPolyfill: WebSocket, params: { name: 'Hold-E' }, disableBc: true })
  const pb = new WebsocketProvider(`ws://localhost:${PORT_C}`, room, docB, { WebSocketPolyfill: WebSocket, params: { name: 'Hold-F' }, disableBc: true })
  const synced = (p) => new Promise((r) => (p.synced ? r() : p.once('synced', r)))
  await Promise.all([synced(pa), synced(pb)])
  let closes = 0
  pa.on('status', (e) => { if (e.status === 'disconnected') closes++ })
  const N = 300
  for (let i = 0; i < N; i++) docA.transact(() => docA.getMap('manifest').set(`f${i}`, i))
  const end = Date.now() + 25000
  while (docB.getMap('manifest').size < N && Date.now() < end) await sleep(50)
  T('the backstop fired (the flood outran a paused read)', closes >= 1 && /kept sending past a paused read/.test(relayC.log), `closes=${closes}`)
  T('...and the reconnect resynced EVERYTHING', docB.getMap('manifest').size === N, `${docB.getMap('manifest').size}/${N}`)
  pa.destroy(); pb.destroy()
}

// ── D. a refused write is told to the writer ────────────────────────────────────────────────────
// A write over a doc's size cap IS refused (that one no wait can fix), and tell() used to print it
// only in the relay's own log: the writer kept editing into a file that had stopped moving for
// everyone. It must land in the room, addressed to the writer, once -- not once per refused write.
console.log('\n# D. a refused write reaches the writer, once, in the room')
const PORT_D = BASE + 2
await startRelay(PORT_D, { HIVE_FREE_MAX_DOC_BYTES: '3000' })
{
  const room = 'holdD'
  const watch = new Y.Doc()
  const pw = new WebsocketProvider(`ws://localhost:${PORT_D}`, room, watch, { WebSocketPolyfill: WebSocket, params: { name: 'Cap-R' }, disableBc: true })
  await new Promise((r) => (pw.synced ? r() : pw.once('synced', r)))
  const ws = await new Promise((res) => { const w = new WebSocket(`ws://localhost:${PORT_D}/${muxPath(room)}?mux=1&name=Cap-W`); w.binaryType = 'arraybuffer'; w.on('open', () => res(w)) })
  let opened = false
  ws.on('message', (d) => { if (decodeFrame(new Uint8Array(d)).kind === F.OPENED) opened = true })
  ws.send(encodeFrame(F.OPEN, 1, `${room}\u0001src/big.txt`))
  while (!opened) await sleep(25)
  await sleep(300)
  const ups = manyUpdates(10, (d, i) => d.getText('content').insert(d.getText('content').length, String(i).repeat(800)))
  for (const u of ups) ws.send(encodeFrame(F.MSG, 1, updateMsg(u)))
  const notices = () => watch.getArray('chat').toArray().filter((m) => m && m.by === 'relay' && /Q435/.test(m.text || ''))
  const end = Date.now() + 5000
  while (!notices().length && Date.now() < end) await sleep(50)
  await sleep(800) // any duplicate would land in this window
  const n = notices()
  T('the writer is told in the room chat, addressed by name', n.length >= 1 && /^@Cap-W /.test(n[0].text), n[0] ? n[0].text.slice(0, 90) : 'no notice')
  T('...naming the file', n.length >= 1 && n[0].text.includes('src/big.txt'))
  T('...once, not once per refused write', n.length === 1, `${n.length} notices`)
  ws.close(); pw.destroy()
}

for (const r of relays) { try { r.kill() } catch { } }
console.log(`\n=== OVER THE RATE, A FRAME WAITS: ${pass} passed, ${fail} failed ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 200)
