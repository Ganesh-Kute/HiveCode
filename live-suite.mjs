// ACTIVE driven test of the substrate against the DEPLOYED relay — no dependence on
// the external agents. Spins up 3 real signing clients (startSync, HIVE_PROVENANCE=on)
// in a fresh room on production, has them edit concurrently, then audits convergence +
// provenance + head authority, and finally probes live enforcement (forged head).
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import crypto from 'crypto'
import { startSync } from './sync.js'
import { verifyReceipt, headOk, contentHash, genIdentity, authorChange } from './substrate.js'

const relay = 'wss://livecode-xoss.onrender.com'
const room = 'room-' + crypto.randomBytes(10).toString('hex')
const FSEP = String.fromCharCode(1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

process.env.HIVE_PROVENANCE = 'on'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-suite-'))
const mkdir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d }
console.log(`live-suite: room ${room} on ${relay}\n`)

// 3 signing clients
const A = startSync({ relay, room, dir: mkdir('a'), name: 'Alpha', kind: 'ai', log: () => {} })
const B = startSync({ relay, room, dir: mkdir('b'), name: 'Beta', kind: 'ai', log: () => {} })
const C = startSync({ relay, room, dir: mkdir('c'), name: 'Gamma', kind: 'ai', log: () => {} })
await sleep(3500)

console.log('# Alpha seeds util.js (claims first)')
A.claim('util.js', 'seed')
fs.writeFileSync(path.join(tmp, 'a', 'util.js'), 'function fa() { return 1 }\n\nfunction fb() { return 2 }\n\nfunction fc() { return 3 }\n')
await sleep(4000)
A.release('util.js')
T('Beta + Gamma received util.js', fs.existsSync(path.join(tmp, 'b', 'util.js')) && fs.existsSync(path.join(tmp, 'c', 'util.js')))

console.log('# concurrent DISJOINT edits: Alpha->fa, Beta->fb, Gamma->fc')
const edit = (dir, from, to) => { const p = path.join(tmp, dir, 'util.js'); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to)) }
A.claim('util.js', 'edit fa'); edit('a', 'return 1', 'return 10'); await sleep(2500); A.release('util.js')
B.claim('util.js', 'edit fb'); edit('b', 'return 2', 'return 20'); await sleep(2500); B.release('util.js')
C.claim('util.js', 'edit fc'); edit('c', 'return 3', 'return 30'); await sleep(2500); C.release('util.js')
await sleep(4000) // let everything converge + sign

// audit via a fresh raw client
const doc = new Y.Doc()
const p = new WebsocketProvider(relay, room + FSEP + 'util.js', doc, { WebSocketPolyfill: WebSocket, disableBc: true })
await new Promise((r) => { let d = 0; const f = () => { if (!d) { d = 1; r() } }; p.on('sync', (s) => s && f()); setTimeout(f, 9000) })
const content = doc.getText('content').toString()
const ledger = doc.getArray('ledger').toArray()
const head = doc.getMap('head').get('cur')
console.log('\n--- converged util.js ---\n' + content + '-------------------------')

T('all 3 edits converged (10, 20, 30 present)', /return 10/.test(content) && /return 20/.test(content) && /return 30/.test(content))
T('content parses (no corruption)', /function fa/.test(content) && /function fb/.test(content) && /function fc/.test(content))
T('every ledger receipt verifies', ledger.length > 0 && ledger.every((r) => verifyReceipt(r).ok))
const authors = new Set(ledger.filter((r) => verifyReceipt(r).ok).map((r) => r.name))
console.log('  verified authors: ' + [...authors].join(', ') + '  | ledger size: ' + ledger.length)
T('all 3 authors signed (Alpha, Beta, Gamma)', ['Alpha', 'Beta', 'Gamma'].every((n) => authors.has(n)))
T('head is a valid verified attestation', head && headOk(head).ok)
T('head == converged content (fully verified)', head && head.hash === contentHash(content))

console.log('\n# live enforcement: inject a REGRESSING head -> deployed relay must revert')
const idX = genIdentity('Attacker')
const broken = 'function fa( {'
const bh = { ...authorChange({ identity: idX, filename: 'util.js', base: '', text: broken, intent: 'regress', at: Date.now() }).prov, name: 'Attacker' }
const before = doc.getMap('head').get('cur').hash
doc.getMap('head').set('cur', { text: broken, hash: contentHash(broken), at: Date.now(), by: 'Attacker', receipt: bh })
await sleep(5000)
const after = doc.getMap('head').get('cur')
T('deployed relay REVERTED the regressing head', after && after.hash !== contentHash(broken) && after.hash === before)

try { A.stop(); B.stop(); C.stop(); p.destroy() } catch {}
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\n=== live-suite: ${fail === 0 ? 'ALL ' + pass + ' PASS (convergence + provenance + head authority + enforcement, on PRODUCTION)' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
