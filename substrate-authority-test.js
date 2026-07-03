// LIVE proof of CONTENT AUTHORITY: the file's authoritative `head` (its attested
// current content) is always a verified, non-regressing attestation — enforced by the
// relay. Shows:
//   1. two real clients converge -> head is the SAME verified attestation on both,
//      and it attests the actual converged content.
//   2. a FORGED head (bad receipt) injected by a rogue client is reverted by the relay.
//   3. a REGRESSING head (valid receipt over code that no longer parses) is reverted.
// Run over the real relay in strict mode.
//
//   node substrate-authority-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { startSync } from './sync.js'
import { fileRoom } from './token.js'
import { genIdentity, authorChange, headOk, contentHash } from './substrate.js'

const PORT = 1291
const ROOM = 'authproj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

function startRelay() {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_PROVENANCE: 'strict' } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}
function raw(room) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://localhost:${PORT}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
  return { doc, provider }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-auth-'))
const dirA = path.join(tmp, 'a'), dirB = path.join(tmp, 'b')
fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })

process.env.HIVE_PROVENANCE = 'on'
const relay = await startRelay()
console.log(`relay up on :${PORT} (HIVE_PROVENANCE=strict); clients ON\n`)

const A = startSync({ relay: `ws://localhost:${PORT}`, room: ROOM, dir: dirA, name: 'Alice', kind: 'ai', log: () => {} })
const B = startSync({ relay: `ws://localhost:${PORT}`, room: ROOM, dir: dirB, name: 'Bob', kind: 'ai', log: () => {} })
await sleep(1500)

console.log('# 1. Two clients converge -> one verified head attesting the live content')
A.claim('app.js', 'scaffold')
fs.writeFileSync(path.join(dirA, 'app.js'), 'function login(u) {\n  return u\n}\n\nfunction logout() {\n  return true\n}\n')
await sleep(2500)
A.claim('app.js', 'harden login')
fs.writeFileSync(path.join(dirA, 'app.js'), 'function login(u) {\n  return u && u.length > 0\n}\n\nfunction logout() {\n  return true\n}\n')
await sleep(2000)
B.claim('app.js', 'audit logout')
fs.writeFileSync(path.join(dirB, 'app.js'), fs.readFileSync(path.join(dirB, 'app.js'), 'utf8').replace('return true', 'return { ok: true }'))
await sleep(3500)

const hA = A.headOf('app.js'), hB = B.headOf('app.js')
assert('both clients have a head', !!hA && !!hB)
assert('head is identical on both (same content hash)', hA && hB && hA.hash === hB.hash)
assert('head is a valid verified attestation', hA && headOk(hA).ok)
const diskA = fs.readFileSync(path.join(dirA, 'app.js'), 'utf8')
assert('head attests the ACTUAL converged content on disk', hA && contentHash(diskA) === hA.hash)
const goodHead = hA

console.log('\n# 2. A forged head (bad receipt) is reverted by the relay')
const rogue = raw(fileRoom(ROOM, 'app.js'))
await sleep(1000)
const evilId = genIdentity('Evil')
const evilReceipt = { ...authorChange({ identity: evilId, filename: 'app.js', base: '', text: 'HIJACKED\n', intent: 'take over', at: Date.now() }).prov, intent: 'tampered' } // signature now broken
rogue.doc.getMap('head').set('cur', { text: 'HIJACKED\n', hash: contentHash('HIJACKED\n'), at: Date.now(), by: 'Evil', receipt: evilReceipt })
await sleep(2000)
const afterForge = rogue.doc.getMap('head').get('cur')
assert('forged head reverted (not the hijacked text)', afterForge && afterForge.hash !== contentHash('HIJACKED\n'))
assert('reverted head is the last VERIFIED content', afterForge && headOk(afterForge).ok && afterForge.hash === goodHead.hash)

console.log('\n# 3. A regressing head (valid receipt over unparseable code) is reverted')
const broken = 'function login(u) {\n  return u &&&& \n' // does not parse
const validButBroken = authorChange({ identity: evilId, filename: 'app.js', base: '', text: broken, intent: 'oops', at: Date.now() }).prov // genuinely signed
assert('the regressing head is itself well-signed (so only non-regression can stop it)', headOk({ text: broken, hash: contentHash(broken), receipt: validButBroken }).ok)
rogue.doc.getMap('head').set('cur', { text: broken, hash: contentHash(broken), at: Date.now(), by: 'Evil', receipt: validButBroken })
await sleep(2000)
const afterRegress = rogue.doc.getMap('head').get('cur')
assert('regressing head reverted (broken code rejected as current content)', afterRegress && afterRegress.hash !== contentHash(broken))
assert('current content still the last healthy verified head', afterRegress && afterRegress.hash === goodHead.hash)

try { A.stop(); B.stop(); rogue.provider.destroy() } catch {}
relay.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n=== ${failed === 0 ? 'CONTENT AUTHORITY WORKS (head converges, verified; relay reverts forged + regressing heads)' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
