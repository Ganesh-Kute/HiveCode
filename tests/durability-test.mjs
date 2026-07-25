// DURABILITY: with HIVE_PERSIST_DIR set, a relay RESTART must NOT lose the ledger.
// Proves the fix for the round-1 wipe. A signing client writes+signs a file; we capture
// the ledger, KILL the relay, RESTART it (same persist dir), then connect a FRESH client
// (no local data) and confirm the content + ledger + head RELOADED from disk.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import { WebSocket } from 'ws'
import crypto from 'crypto'
import { startSync } from './sync.js'
import { verifyReceipt, headOk, contentHash } from './substrate.js'

const PORT = 1303, FSEP = String.fromCharCode(1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = (port, env) => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }
async function audit(room) {
  const doc = new Y.Doc()
  const pr = new WebsocketProvider(`ws://localhost:${PORT}`, room + FSEP + 'keep.js', doc, { WebSocketPolyfill: WebSocket, disableBc: true })
  await new Promise((r) => { let d = 0; const f = () => { if (!d) { d = 1; r() } }; pr.on('sync', (s) => s && f()); setTimeout(f, 8000) })
  await sleep(1500)
  const out = { content: doc.getText('content').toString(), ledger: doc.getArray('ledger').toArray(), head: doc.getMap('head').get('cur') }
  pr.destroy(); return out
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dur-'))
const persist = path.join(tmp, 'persist'); fs.mkdirSync(persist, { recursive: true })
const room = 'dur-' + crypto.randomBytes(6).toString('hex')
console.log(`DURABILITY: persist dir set; room ${room}\n`)

// --- run 1: write + sign, let it persist ---
let relay = await startRelay(PORT, { HIVE_PROVENANCE: 'strict', HIVE_PERSIST_DIR: persist })
process.env.HIVE_PROVENANCE = 'on'
const dir = path.join(tmp, 'writer'); fs.mkdirSync(dir, { recursive: true })
const W = startSync({ relay: `ws://localhost:${PORT}`, room, dir, name: 'Writer', kind: 'ai', log: () => {} })
await sleep(3000)
W.claim('keep.js', 'seed'); fs.writeFileSync(path.join(dir, 'keep.js'), 'function keep() { return 42 }\n'); await sleep(3500); W.release('keep.js')
await sleep(3000) // let persistence flush (debounced ~1s)
const before = await audit(room)
console.log('  before restart: ledger=' + before.ledger.length + ' headValid=' + (before.head ? headOk(before.head).ok : false))
T('pre-restart: content signed + head verified', before.ledger.length >= 1 && before.head && headOk(before.head).ok && before.head.hash === contentHash(before.content))

// --- KILL the relay (simulating a Render sleep/redeploy) ---
try { W.stop() } catch {}
relay.kill(); await sleep(2000)
console.log('  >>> relay KILLED (client gone too) <<<')

// --- run 2: restart with the SAME persist dir; audit with a FRESH client (no local data) ---
relay = await startRelay(PORT, { HIVE_PROVENANCE: 'strict', HIVE_PERSIST_DIR: persist })
await sleep(2000)
const after = await audit(room)
console.log('  after restart:  ledger=' + after.ledger.length + ' headValid=' + (after.head ? headOk(after.head).ok : false))

T('ledger SURVIVED the restart (reloaded from disk)', after.ledger.length === before.ledger.length && after.ledger.length >= 1)
T('every reloaded receipt still verifies', after.ledger.length > 0 && after.ledger.every((r) => verifyReceipt(r).ok))
T('content SURVIVED (identical hash)', contentHash(after.content) === contentHash(before.content) && /return 42/.test(after.content))
T('head SURVIVED + still attests the content', after.head && headOk(after.head).ok && after.head.hash === contentHash(after.content))

relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\n=== DURABILITY: ${fail === 0 ? 'ALL ' + pass + ' PASS (HIVE_PERSIST_DIR fixes the round-1 wipe)' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
