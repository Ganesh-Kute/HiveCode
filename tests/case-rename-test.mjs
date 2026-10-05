// tests/case-rename-test.mjs
// Case-Only Rename Test
// Invariants tested:
//   1. Alice on Windows creates Readme.md. Both Alice and Bob sync it.
//   2. Alice renames Readme.md -> README.md (case-only rename on disk).
//   3. After rename settles, the room keys are exactly ['README.md'] (no duplicate Readme.md).
//   4. Bob's disk lists README.md (new casing) and not Readme.md.
//   5. Content is intact on both clients.
//   6. Nobody posts a "both exist" collision notice.
//   7. A second rename back to Readme.md round-trips cleanly.

import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeoutMs = 10000, stepMs = 150) => {
  const d = Date.now() + timeoutMs
  while (Date.now() < d) {
    try { const res = await fn(); if (res) return res } catch {}
    await sleep(stepMs)
  }
  return false
}

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ` (${extra})` : ''}`); c ? pass++ : fail++ }

// A relay that cannot start (its port taken) exits, and nothing else holds this process open: it
// used to end with node's exit 13 (an unsettled top-level await) and not one line saying why. It
// fails loudly now, on a port the OS hands out instead of one from a range other suites also use.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-case-rename-'))
const aliceDir = path.join(tmp, 'alice')
const bobDir = path.join(tmp, 'bob')
fs.mkdirSync(aliceDir, { recursive: true })
fs.mkdirSync(bobDir, { recursive: true })

const ROOM = 'case-ren-' + crypto.randomBytes(4).toString('hex')
const RELAY_URL = `ws://localhost:${PORT}`

const README_TEXT = '# Hello World\nCase rename test\n'
fs.writeFileSync(path.join(aliceDir, 'Readme.md'), README_TEXT)

console.log('\n# Alice and Bob start sync')
const alice = startSync({ relay: RELAY_URL, room: ROOM, dir: aliceDir, name: 'Alice', kind: 'ai', log: (m) => console.log(m) })
const bob = startSync({ relay: RELAY_URL, room: ROOM, dir: bobDir, name: 'Bob', kind: 'ai', log: (m) => console.log(m) })

await until(() => alice.status().connected && bob.status().connected, 6000)

// Wait for Bob to receive Readme.md
await until(() => {
  try {
    const files = fs.readdirSync(bobDir).filter(f => !f.startsWith('.') && !f.startsWith('HIVE_'))
    return files.includes('Readme.md') && fs.readFileSync(path.join(bobDir, 'Readme.md'), 'utf8') === README_TEXT
  } catch { return false }
}, 8000)

console.log('\n# Initial state synced: Readme.md on both disks')
const initialFiles = fs.readdirSync(bobDir).filter(f => !f.startsWith('.') && !f.startsWith('HIVE_'))
T('0 Setup: Bob has Readme.md', initialFiles.includes('Readme.md'))

// --- STEP 1: Alice renames Readme.md -> README.md ---
console.log('\n# Alice renames Readme.md -> README.md')
// On Windows, fs.renameSync('Readme.md', 'README.md') in-place may fail or be no-op on some node versions
// Standard atomic rename on Windows: rename to temp or use fs.renameSync
try {
  fs.renameSync(path.join(aliceDir, 'Readme.md'), path.join(aliceDir, 'README.md'))
} catch {
  // If direct case rename throws EPERM on Windows node fs, hop through temp:
  const tmpHop = path.join(aliceDir, '.tmp-rename')
  fs.renameSync(path.join(aliceDir, 'Readme.md'), tmpHop)
  fs.renameSync(tmpHop, path.join(aliceDir, 'README.md'))
}

// Wait for rename to settle and sync across the room
await sleep(4000)

// Check room manifest keys
const roomKeys1 = [...alice.doc.getMap('manifest').keys()].sort()
console.log('Room manifest keys after rename 1:', roomKeys1)
T('1 Room keys after rename 1 are exactly [README.md]', roomKeys1.length === 1 && roomKeys1[0] === 'README.md', JSON.stringify(roomKeys1))

// Check Bob disk
const bobFiles1 = fs.readdirSync(bobDir).filter(f => !f.startsWith('.') && !f.startsWith('HIVE_'))
console.log('Bob disk files after rename 1:', bobFiles1)
T('2 Bob disk has README.md and not Readme.md', bobFiles1.includes('README.md') && !bobFiles1.includes('Readme.md'), JSON.stringify(bobFiles1))

// Check Bob content
const bobContent1 = fs.readFileSync(path.join(bobDir, 'README.md'), 'utf8')
T('3 Bob content is intact after rename 1', bobContent1 === README_TEXT)

// Check chat notices: nobody should post "both exist"
const chat1 = alice.doc.getArray('chat').toArray().map(m => String(m.text || ''))
const notice1 = chat1.find(t => t.includes('both exist in the room'))
T('4 No "both exist" notice posted during rename 1', !notice1, notice1 || 'clean')

// --- STEP 2: Alice renames back: README.md -> Readme.md ---
console.log('\n# Alice renames README.md back to Readme.md')
try {
  fs.renameSync(path.join(aliceDir, 'README.md'), path.join(aliceDir, 'Readme.md'))
} catch {
  const tmpHop = path.join(aliceDir, '.tmp-rename')
  fs.renameSync(path.join(aliceDir, 'README.md'), tmpHop)
  fs.renameSync(tmpHop, path.join(aliceDir, 'Readme.md'))
}

await sleep(4000)

const roomKeys2 = [...alice.doc.getMap('manifest').keys()].sort()
console.log('Room manifest keys after rename 2:', roomKeys2)
T('5 Room keys after round-trip rename 2 are exactly [Readme.md]', roomKeys2.length === 1 && roomKeys2[0] === 'Readme.md', JSON.stringify(roomKeys2))

const bobFiles2 = fs.readdirSync(bobDir).filter(f => !f.startsWith('.') && !f.startsWith('HIVE_'))
console.log('Bob disk files after rename 2:', bobFiles2)
T('6 Bob disk has Readme.md after round-trip', bobFiles2.includes('Readme.md') && !bobFiles2.includes('README.md'), JSON.stringify(bobFiles2))

const bobContent2 = fs.readFileSync(path.join(bobDir, 'Readme.md'), 'utf8')
T('7 Bob content is intact after round-trip rename 2', bobContent2 === README_TEXT)

const chat2 = alice.doc.getArray('chat').toArray().map(m => String(m.text || ''))
const notice2 = chat2.find(t => t.includes('both exist in the room'))
T('8 No "both exist" notice posted during rename 2', !notice2, notice2 || 'clean')

// Cleanup
alice.stop()
bob.stop()

// --- SECTION B: Junction / Symlink room folder ---
console.log('\n# Section B: Junction / Symlink room folder')
const juncTarget = path.join(tmp, 'alice-target')
const juncPath = path.join(tmp, 'alice-junc')
fs.mkdirSync(juncTarget, { recursive: true })
if (process.platform === 'win32') {
  fs.symlinkSync(juncTarget, juncPath, 'junction')
} else {
  fs.symlinkSync(juncTarget, juncPath, 'dir')
}

const bobJuncDir = path.join(tmp, 'bob-junc')
fs.mkdirSync(bobJuncDir, { recursive: true })

const JUNC_ROOM = 'case-junc-' + crypto.randomBytes(4).toString('hex')
const aliceJunc = startSync({ relay: RELAY_URL, room: JUNC_ROOM, dir: juncPath, name: 'AliceJunc', kind: 'ai', log: (m) => console.log(m) })
const bobJunc = startSync({ relay: RELAY_URL, room: JUNC_ROOM, dir: bobJuncDir, name: 'BobJunc', kind: 'ai', log: (m) => console.log(m) })

await until(() => aliceJunc.status().connected && bobJunc.status().connected, 6000)

// Alice writes a.js, b.js, c.js inside junction
fs.writeFileSync(path.join(juncPath, 'a.js'), 'export const a = 1\n')
fs.writeFileSync(path.join(juncPath, 'b.js'), 'export const b = 2\n')
fs.writeFileSync(path.join(juncPath, 'c.js'), 'export const c = 3\n')

// Wait for room to publish and Bob to receive
const synced3 = await until(() => {
  try {
    const files = fs.readdirSync(bobJuncDir).filter(f => !f.startsWith('.') && !f.startsWith('HIVE_'))
    return files.includes('a.js') && files.includes('b.js') && files.includes('c.js')
  } catch { return false }
}, 8000)

const juncRoomKeys = [...aliceJunc.doc.getMap('manifest').keys()].sort()
console.log('Junction room manifest keys:', juncRoomKeys)
T('9 Junction: room has [a.js, b.js, c.js] and Bob receives all 3', !!synced3 && juncRoomKeys.length === 3, JSON.stringify(juncRoomKeys))

// Alice edits a.js inside junction
fs.writeFileSync(path.join(juncPath, 'a.js'), 'export const a = 100 // edited\n')
const editSynced = await until(() => {
  try {
    return fs.readFileSync(path.join(bobJuncDir, 'a.js'), 'utf8').includes('100')
  } catch { return false }
}, 8000)
T('10 Junction: Alice edit to a.js reaches Bob', !!editSynced)

// Alice renames a.js -> A.js inside junction
try {
  fs.renameSync(path.join(juncPath, 'a.js'), path.join(juncPath, 'A.js'))
} catch {
  const tmpHop = path.join(juncPath, '.hive-case-hop-test')
  fs.renameSync(path.join(juncPath, 'a.js'), tmpHop)
  fs.renameSync(tmpHop, path.join(juncPath, 'A.js'))
}

await sleep(4000)

const bobJuncFiles1 = fs.readdirSync(bobJuncDir).filter(f => !f.startsWith('.') && !f.startsWith('HIVE_'))
const juncRoomKeysAfterRename = [...aliceJunc.doc.getMap('manifest').keys()].sort()
console.log('Junction Bob files after rename:', bobJuncFiles1)
T('11 Junction: Bob has A.js and not a.js after rename', bobJuncFiles1.includes('A.js') && !bobJuncFiles1.includes('a.js'), JSON.stringify(bobJuncFiles1))
T('12 Junction: room manifest has A.js and not a.js', juncRoomKeysAfterRename.includes('A.js') && !juncRoomKeysAfterRename.includes('a.js'), JSON.stringify(juncRoomKeysAfterRename))

// Round-trip rename A.js -> a.js inside junction
try {
  fs.renameSync(path.join(juncPath, 'A.js'), path.join(juncPath, 'a.js'))
} catch {
  const tmpHop = path.join(juncPath, '.hive-case-hop-test')
  fs.renameSync(path.join(juncPath, 'A.js'), tmpHop)
  fs.renameSync(tmpHop, path.join(juncPath, 'a.js'))
}

await sleep(4000)

const bobJuncFilesBack = fs.readdirSync(bobJuncDir).filter(f => !f.startsWith('.') && !f.startsWith('HIVE_'))
const juncRoomKeysBack = [...aliceJunc.doc.getMap('manifest').keys()].sort()
T('13 Junction: Bob has a.js after round-trip rename', bobJuncFilesBack.includes('a.js') && !bobJuncFilesBack.includes('A.js'), JSON.stringify(bobJuncFilesBack))
T('14 Junction: room manifest has a.js after round-trip rename', juncRoomKeysBack.includes('a.js') && !juncRoomKeysBack.includes('A.js'), JSON.stringify(juncRoomKeysBack))

aliceJunc.stop()
bobJunc.stop()

// Cleanup
relay.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
