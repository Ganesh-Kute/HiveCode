// MINIMAL REPRO — no sync.js involved. A raw y-websocket client pushes items
// into a Y.Array + edits a Y.Text on the relay; the relay restarts and reloads
// its persisted snapshot; the SAME client (kept alive, auto-reconnect) pushes
// again. Does the post-restart push reach the server?
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import { WebSocket } from 'ws'

const PORT = 1351
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const startRelay = (env) => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_PROVENANCE: 'off', ...env } }); p.stderr.on('data', (d) => process.stderr.write('[relay-err] ' + d)); p.stdout.on('data', (d) => { if (/error|Error|failed/.test(d)) process.stderr.write('[relay-out] ' + d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }

const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-snapbug-'))
let relay = await startRelay({ HIVE_PERSIST_DIR: persist })
const room = 'snapbug-' + Math.random().toString(36).slice(2, 8)

// long-lived client
const doc = new Y.Doc()
const pr = new WebsocketProvider(`ws://localhost:${PORT}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
const arr = doc.getArray('ledger'); const txt = doc.getText('content')
await new Promise((r) => pr.on('sync', (s) => s && r()))

arr.push([{ n: 1 }]); arr.push([{ n: 2 }]); txt.insert(0, 'hello ')
await sleep(2500) // sync + persist flush (1s debounce)

async function serverView(tag) {
  const d2 = new Y.Doc()
  const p2 = new WebsocketProvider(`ws://localhost:${PORT}`, room, d2, { WebSocketPolyfill: WebSocket, disableBc: true })
  await new Promise((r) => { let done = 0; const f = () => { if (!done) { done = 1; r() } }; p2.on('sync', (s) => s && setTimeout(f, 500)); setTimeout(f, 6000) })
  console.log(`${tag}: server array=${JSON.stringify(d2.getArray('ledger').toArray().map((x) => x.n))} text="${d2.getText('content').toString()}"`)
  try { p2.destroy() } catch {}; d2.destroy()
}
await serverView('pre-restart ')

console.log('>> restart relay (loads snapshot)')
relay.kill(); await sleep(2000)
relay = await startRelay({ HIVE_PERSIST_DIR: persist })
await sleep(8000) // client auto-reconnects

arr.push([{ n: 3 }]); txt.insert(0, 'again ')
await sleep(3000)
console.log(`client       : array=${JSON.stringify(arr.toArray().map((x) => x.n))} text="${txt.toString()}"`)
await serverView('post-restart')

// second restart to see if the loss compounds
relay.kill(); await sleep(2000)
relay = await startRelay({ HIVE_PERSIST_DIR: persist })
await sleep(8000)
arr.push([{ n: 4 }]); txt.insert(0, 'more ')
await sleep(3000)
console.log(`client       : array=${JSON.stringify(arr.toArray().map((x) => x.n))} text="${txt.toString()}"`)
await serverView('restart x2  ')

try { pr.destroy() } catch {}
relay.kill()
try { fs.rmSync(persist, { recursive: true, force: true }) } catch {}
process.exit(0)
