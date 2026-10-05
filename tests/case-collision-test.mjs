// tests/case-collision-test.mjs
// Case-Only Path Collision Test
// Invariants tested:
//   1. On case-insensitive filesystems (Windows/macOS), two files whose paths differ
//      only in case (e.g. Case.js and case.js) map to the same physical file on disk.
//   2. Bob's folder must hold exactly ONE of the collided files on disk (the first seen/existing).
//   3. The collided file must NOT be written to disk.
//   4. The unwritten collided file must be reported in Bob's status().collided.
//   5. The room must be told once via chat notice.
//   6. Most importantly: Neither file's content in the ROOM may be corrupted or overwritten
//      by scans or local writes from Bob.

import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { startSync } from '../sync.js'
import { fileRoom } from '../token.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeoutMs = 8000, stepMs = 150) => {
  const d = Date.now() + timeoutMs
  while (Date.now() < d) {
    try { const res = await fn(); if (res) return res } catch {}
    await sleep(stepMs)
  }
  return false
}

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ` (${extra})` : ''}`); c ? pass++ : fail++ }

// A relay that cannot start (its port taken) used to end this test with node's exit 13 (an unsettled
// top-level await) and no line saying why. It fails loudly now, on a port the OS hands out.
const startRelay = (port, env = {}) => new Promise((res, rej) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  p.on('error', rej)
  p.on('exit', (code) => rej(new Error(`the relay exited (code ${code}) before it was listening on ${port}`)))
})
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })

const PORT = await freePort()
console.log(`# Starting relay on port ${PORT}...`)
const relay = await startRelay(PORT)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-case-collision-'))
const bobDir = path.join(tmp, 'bob')
fs.mkdirSync(bobDir, { recursive: true })

const ROOM = 'case-col-' + crypto.randomBytes(4).toString('hex')
const RELAY_URL = `ws://localhost:${PORT}`

// 1. Raw client (simulating Linux peer with no disk) publishes Case.js and case.js
const rawBaseDoc = new Y.Doc()
const rawBaseProv = new WebsocketProvider(RELAY_URL, ROOM, rawBaseDoc, { WebSocketPolyfill: WebSocket, disableBc: true })

await until(() => rawBaseProv.wsconnected, 5000)

const rawCaseDoc = new Y.Doc()
const rawCaseProv = new WebsocketProvider(RELAY_URL, fileRoom(ROOM, 'Case.js'), rawCaseDoc, { WebSocketPolyfill: WebSocket, disableBc: true })

const rawLowerDoc = new Y.Doc()
const rawLowerProv = new WebsocketProvider(RELAY_URL, fileRoom(ROOM, 'case.js'), rawLowerDoc, { WebSocketPolyfill: WebSocket, disableBc: true })

await until(() => rawCaseProv.wsconnected && rawLowerProv.wsconnected, 5000)

const CASE_CONTENT = 'export const UPPER_CASE = 1\n'
const LOWER_CONTENT = 'export const lower_case = 2\n'

rawCaseDoc.getText('content').insert(0, CASE_CONTENT)
rawLowerDoc.getText('content').insert(0, LOWER_CONTENT)

// Publish to manifest
rawBaseDoc.transact(() => {
  rawBaseDoc.getMap('manifest').set('Case.js', 1)
  rawBaseDoc.getMap('manifest').set('case.js', 1)
})

await sleep(500)

// 2. Bob joins with startSync on this Windows machine
console.log('\n# Bob joins on case-insensitive platform')
const bob = startSync({ relay: RELAY_URL, room: ROOM, dir: bobDir, name: 'Bob', kind: 'ai', log: () => {} })

await until(() => bob.status().connected, 6000)

// Let Bob sync and run multiple scan cycles
await sleep(4000)

// 3. Verification
const filesOnDisk = fs.readdirSync(bobDir).filter(f => !f.startsWith('.') && !f.startsWith('HIVE_'))
console.log('Files on Bob disk:', filesOnDisk)
if (filesOnDisk.length) {
  console.log('Content on Bob disk:', JSON.stringify(fs.readFileSync(path.join(bobDir, filesOnDisk[0]), 'utf8')))
}

// (a) Bob folder must hold exactly ONE of the collided files
T('1 Bob folder holds exactly one user file', filesOnDisk.length === 1, `actual: ${filesOnDisk.length} [${filesOnDisk.join(', ')}]`)

// (b) Raw client edits case.js
console.log('\n# Raw client edits case.js')
const LOWER_V2 = '// linux edit\n' + LOWER_CONTENT
rawLowerDoc.getText('content').insert(0, '// linux edit\n')
await sleep(3000)

// Check room copies
const currentCase = rawCaseDoc.getText('content').toString()
const currentLower = rawLowerDoc.getText('content').toString()

T('2 Case.js room content is intact (not corrupted by case.js edit)', currentCase === CASE_CONTENT, JSON.stringify({ expected: CASE_CONTENT, actual: currentCase }))
T('3 case.js room content has linux edit', currentLower === LOWER_V2, JSON.stringify({ expected: LOWER_V2, actual: currentLower }))

// (c) Bob status() lists collided
const st = bob.status()
console.log('Bob status:', JSON.stringify({ collided: st.collided }))
T('4 Bob status reports collided', Array.isArray(st.collided) && st.collided.length >= 1)

// (d) Room notice was posted
const chat = rawBaseDoc.getArray('chat').toArray().map(m => String(m.text || ''))
const notice = chat.find(t => t.includes('both exist in the room') && t.includes('cannot hold both'))
T('5 Room notice was posted', !!notice, notice || 'no notice found')

// 4. Bob edits Case.js on disk
console.log('\n# Bob edits Case.js locally')
fs.appendFileSync(path.join(bobDir, 'Case.js'), 'export const BOB = 3\n')
const caseHasBob = await until(() => rawCaseDoc.getText('content').toString().includes('BOB = 3'), 6000)
T('6 Bob local edit reached Case.js in room', caseHasBob)
T('7 Bob edit did NOT leak to case.js in room', rawLowerDoc.getText('content').toString() === LOWER_V2)

// 5. Deleting Case.js promotes case.js to disk
console.log('\n# Remote deletes Case.js -> case.js promoted to disk')
rawBaseDoc.getMap('manifest').delete('Case.js')
const promotedToDisk = await until(() => {
  try {
    const content = fs.readFileSync(path.join(bobDir, 'case.js'), 'utf8')
    return content === LOWER_V2
  } catch { return false }
}, 6000)
T('8 case.js promoted to disk after Case.js deleted', promotedToDisk)
const stAfter = bob.status()
T('9 Bob status collided is cleared after promotion', !stAfter.collided || stAfter.collided.length === 0)

// 6. Pre-existing file on disk wins over incoming manifest key
console.log('\n# Pre-existing file on disk wins over different-cased room key')
const PRE_CONTENT = 'export const PRE = 1\n'
fs.writeFileSync(path.join(bobDir, 'PreExisting.js'), PRE_CONTENT)
await sleep(1500)

// Raw client publishes preexisting.js to room
const rawPreDoc = new Y.Doc()
const rawPreProv = new WebsocketProvider(RELAY_URL, fileRoom(ROOM, 'preexisting.js'), rawPreDoc, { WebSocketPolyfill: WebSocket, disableBc: true })
await until(() => rawPreProv.wsconnected, 4000)
rawPreDoc.getText('content').insert(0, 'export const remote_pre = 2\n')
rawBaseDoc.getMap('manifest').set('preexisting.js', 1)

await sleep(2000)

// Assert PreExisting.js remains on disk, and preexisting.js is listed as collided
const onDiskPre = fs.readdirSync(bobDir).filter(f => f.toLowerCase() === 'preexisting.js')
T('10 Disk retains exact casing PreExisting.js', onDiskPre.length === 1 && onDiskPre[0] === 'PreExisting.js')
T('11 PreExisting.js content intact', fs.readFileSync(path.join(bobDir, 'PreExisting.js'), 'utf8') === PRE_CONTENT)
const stPre = bob.status()
const colPre = (stPre.collided || []).find(c => c.path === 'preexisting.js')
T('12 incoming preexisting.js is marked collided with PreExisting.js', !!colPre && colPre.with === 'PreExisting.js')
rawPreProv.destroy()

// Cleanup
bob.stop()
rawCaseProv.destroy()
rawLowerProv.destroy()
rawBaseProv.destroy()
relay.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
