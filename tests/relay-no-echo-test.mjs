// NO ECHO TO THE SENDER (27 Sep 2026). Stock y-websocket broadcast every update to every connection
// on a document, INCLUDING the one that sent it: a write on the relay and a decode on the client for
// an edit the client made itself -- half of all fan-out in a two-person room. vendor/y-websocket/
// utils.cjs now skips the origin. Pinned against a real relay: the other participant still gets every
// update, byte-for-byte applicable, and the sender gets none of its own back.
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import WebSocket from 'ws'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { F, encodeFrame, decodeFrame, muxPath } = await import(pathToFileURL(path.join(ROOT, 'hive-mux-proto.js')).href)
const PORT = Number(process.env.HIVE_TEST_PORT) || (27000 + (process.pid % 13000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }

const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
relay.stderr.on('data', () => { })
await new Promise((res, rej) => { relay.stdout.on('data', (d) => { if (/listening on/.test(d)) res() }); relay.on('exit', (c) => rej(new Error('relay exited ' + c))) })

function peer(name) {
  const ws = new WebSocket(`ws://localhost:${PORT}/${muxPath('echoroom')}?mux=1&name=${name}`)
  ws.binaryType = 'arraybuffer'
  const got = { opened: false, msgs: [] }
  ws.on('message', (d) => { const f = decodeFrame(new Uint8Array(d)); if (f.kind === F.OPENED) got.opened = true; else if (f.kind === F.MSG) got.msgs.push(f.payload) })
  return new Promise((res) => ws.on('open', () => res({ ws, got })))
}

console.log('\n=== NO ECHO TO THE SENDER ===')
const A = await peer('Echo-A'), B = await peer('Echo-B')
const DOC = 'echoroom\u0001src/echo.js'
A.ws.send(encodeFrame(F.OPEN, 1, DOC)); B.ws.send(encodeFrame(F.OPEN, 1, DOC))
while (!A.got.opened || !B.got.opened) await sleep(50)
await sleep(800)                                  // let the sync handshake finish
const a0 = A.got.msgs.length, b0 = B.got.msgs.length

const mine = new Y.Doc()
const N = 20
for (let i = 0; i < N; i++) {
  const sv = Y.encodeStateVector(mine)
  mine.getText('content').insert(mine.getText('content').length, `line ${i}\n`)
  const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(mine, sv))
  A.ws.send(encodeFrame(F.MSG, 1, encoding.toUint8Array(e)))
}
const end = Date.now() + 10000
while (B.got.msgs.length - b0 < N && Date.now() < end) await sleep(50)
await sleep(500)

const theirs = new Y.Doc()
for (const p of B.got.msgs.slice(b0)) {
  const dec = decoding.createDecoder(new Uint8Array(p))
  if (decoding.readVarUint(dec) !== 0) continue
  syncProtocol.readSyncMessage(dec, encoding.createEncoder(), theirs, 'relay')
}
T('the other participant receives every update', B.got.msgs.length - b0 === N, `${B.got.msgs.length - b0}/${N}`)
T('...and applying them reproduces the sender\'s text exactly', theirs.getText('content').toString() === mine.getText('content').toString())
T('the sender receives none of its own updates back', A.got.msgs.length - a0 === 0, `${A.got.msgs.length - a0} echoed`)

for (const p of [A, B]) { try { p.ws.close() } catch { } }
relay.kill()
console.log(`\n=== NO ECHO TO THE SENDER: ${pass} passed, ${fail} failed ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 300)
