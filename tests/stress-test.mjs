// STRESS: N signing clients hammer ONE file concurrently -> must converge, all sign.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import { WebSocket } from 'ws'
import crypto from 'crypto'
import { startSync } from './sync.js'
import { verifyReceipt, headOk, contentHash } from './substrate.js'

const PORT = 1301, N = 6, FSEP = String.fromCharCode(1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = (port, env) => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }

const relay = await startRelay(PORT, { HIVE_PROVENANCE: 'strict' })
process.env.HIVE_PROVENANCE = 'on'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-stress-'))
const room = 'stress-' + crypto.randomBytes(6).toString('hex')
console.log(`STRESS: ${N} signing clients, room ${room}\n`)
const dirs = Array.from({ length: N }, (_, i) => { const d = path.join(tmp, 'c' + i); fs.mkdirSync(d, { recursive: true }); return d })
const clients = dirs.map((d, i) => startSync({ relay: `ws://localhost:${PORT}`, room, dir: d, name: 'C' + i, kind: 'ai', log: () => {} }))
await sleep(3000)

// seed one file with N functions
const base = Array.from({ length: N }, (_, i) => `function f${i}() { return ${i} }\n`).join('\n')
clients[0].claim('util.js', 'seed'); fs.writeFileSync(path.join(dirs[0], 'util.js'), base); await sleep(3000); clients[0].release('util.js')
await sleep(2500)
T('all clients received the seed', dirs.every((d) => fs.existsSync(path.join(d, 'util.js'))))

// concurrent: each client i edits its OWN function fi (disjoint) -> return 1000+i
console.log(`# ${N} concurrent disjoint edits...`)
for (let i = 0; i < N; i++) {
  const p = path.join(dirs[i], 'util.js')
  try { fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`return ${i} `, `return ${1000 + i} `)) } catch {}
  await sleep(500) // slight stagger, still heavily overlapping
}
await sleep(8000) // converge + sign

// audit via a fresh raw client
const doc = new Y.Doc()
const pr = new WebsocketProvider(`ws://localhost:${PORT}`, room + FSEP + 'util.js', doc, { WebSocketPolyfill: WebSocket, disableBc: true })
await new Promise((r) => { let d = 0; const f = () => { if (!d) { d = 1; r() } }; pr.on('sync', (s) => s && f()); setTimeout(f, 8000) })
const content = doc.getText('content').toString(), ledger = doc.getArray('ledger').toArray(), head = doc.getMap('head').get('cur')

console.log('--- converged util.js ---\n' + content + '--------------------------')
const allEdits = Array.from({ length: N }, (_, i) => new RegExp(`return ${1000 + i}\\b`).test(content))
console.log('  present: ' + Array.from({ length: N }, (_, i) => (allEdits[i] ? 'f' : 'x') + i).join(' '))
T(`all ${N} concurrent edits converged`, allEdits.every(Boolean))
T('converged content parses (no corruption)', Array.from({ length: N }, (_, i) => new RegExp(`function f${i}\\b`).test(content)).every(Boolean))
T('every ledger receipt verifies', ledger.length > 0 && ledger.every((r) => verifyReceipt(r).ok))
const authors = new Set(ledger.filter((r) => verifyReceipt(r).ok).map((r) => r.name))
console.log('  verified authors: ' + [...authors].sort().join(',') + '  ledger=' + ledger.length)
T('all clients ended on the SAME converged file', dirs.map((d) => { try { return contentHash(fs.readFileSync(path.join(d, 'util.js'), 'utf8')) } catch { return 'x' } }).every((h, _, a) => h === a[0]))
T('head is a valid verified attestation', head && headOk(head).ok)

for (const c of clients) { try { c.stop() } catch {} }
try { pr.destroy() } catch {}; relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\n=== STRESS: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
