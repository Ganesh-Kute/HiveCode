// tests/unshared-binary-notice-test.mjs
// Guard test: binary and oversized files must not be SILENTLY unshared.
//
// Invariant tested:
//   When an agent creates a binary file (e.g. real PNG bytes with null bytes) or an
//   oversized file (> 1MB) in their room folder:
//   Within 20 seconds, EITHER:
//     1. Peers receive byte-identical content on disk (if binary sync is supported), OR
//     2. The session visibly reports that the path is unshared and states the reason (binary / oversized),
//        surfacing in status() and in chat/obligations directed to the author with guidance to share another way.
//
// Also checks:
//   - Normal text files written in the same window DO sync cleanly to Bob.
//   - Bob does NOT have logo.png on disk.
//   - A file that starts as text and becomes binary after an edit is visibly reported as unshared/binary.
//
// On unfixed builds (such as d3eeead), readText() returns null, scan() silently continues,
// Bob never gets the file, and Alice's session reports green with zero warning. This test
// catches that silent false-green failure.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ` (${extra})` : ''}`); c ? pass++ : fail++ }

const PORT = Number(process.env.HIVE_TEST_PORT) || (22000 + (process.pid % 10000))
const startRelay = (port) => new Promise((res, rej) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  p.on('error', rej)
})

const relay = await startRelay(PORT)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-bin-test-'))
const aliceDir = path.join(tmp, 'alice')
const bobDir = path.join(tmp, 'bob')
fs.mkdirSync(aliceDir, { recursive: true })
fs.mkdirSync(bobDir, { recursive: true })

const ROOM = 'bin-room-' + crypto.randomBytes(4).toString('hex')
const RELAY = `ws://localhost:${PORT}`

const alice = startSync({ relay: RELAY, room: ROOM, dir: aliceDir, name: 'Alice', kind: 'ai', log: () => {} })
const bob = startSync({ relay: RELAY, room: ROOM, dir: bobDir, name: 'Bob', kind: 'ai', log: () => {} })

// Wait for sync connections to establish
await sleep(2000)

// Real 1x1 PNG bytes (contains null bytes 0x00)
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82,
])

// 1. Alice writes normal.js (control: valid text file that must sync)
fs.writeFileSync(path.join(aliceDir, 'normal.js'), 'export const hello = "world"\n')

// 2. Alice writes text file evolving.txt (to test text-to-binary transition)
fs.writeFileSync(path.join(aliceDir, 'evolving.txt'), 'initial plain text content\n')

// 3. Alice writes binary logo.png
fs.writeFileSync(path.join(aliceDir, 'logo.png'), PNG_BYTES)

// Alice claims logo.png
alice.claim('logo.png', 'adding branding asset')

// Poll for up to 10 seconds (well within 20s bound)
const deadline = Date.now() + 10000
let syncedToBob = false
let aliceNoticed = false
let reasonReported = ''
let normalSynced = false
let evolvingSynced = false

while (Date.now() < deadline) {
  if (!normalSynced && fs.existsSync(path.join(bobDir, 'normal.js'))) {
    normalSynced = true
  }
  if (!evolvingSynced && fs.existsSync(path.join(bobDir, 'evolving.txt'))) {
    evolvingSynced = true
  }

  // Check if Bob received identical bytes for logo.png
  const bobLogo = path.join(bobDir, 'logo.png')
  if (fs.existsSync(bobLogo)) {
    try {
      const bobBuf = fs.readFileSync(bobLogo)
      if (bobBuf.equals(PNG_BYTES)) {
        syncedToBob = true
        break
      }
    } catch {}
  }

  // Check if Alice's session reports logo.png as unshared
  const st = alice.status()
  const unshared = (st.unsharedFiles || st.notSyncingFiles || [])
  const hasUnsharedInStatus = unshared.some((u) => (typeof u === 'string' ? u : u.path).includes('logo.png'))

  // Check chat messages for notice
  const chatMsgs = alice.doc.getArray('chat').toArray().map((m) => String(m.text || ''))
  const hasChatNotice = chatMsgs.some((m) => m.includes('logo.png') && (m.includes('binary') || m.includes('unshared') || m.includes('never leave') || m.includes('stays on')))

  // Check obligations map
  const obligations = [...alice.doc.getMap('obligations').values()]
  const hasObligation = obligations.some((o) => (o.text || '').includes('logo.png'))

  if (hasUnsharedInStatus || hasChatNotice || hasObligation) {
    aliceNoticed = true
    reasonReported = hasUnsharedInStatus ? 'status' : (hasChatNotice ? 'chat' : 'obligation')
  }

  if (normalSynced && evolvingSynced && (syncedToBob || aliceNoticed)) {
    break
  }

  await sleep(250)
}

// Assertions on logo.png:
T('control: text file normal.js synced to Bob', normalSynced)
T('guard: Bob does NOT have logo.png on disk', !fs.existsSync(path.join(bobDir, 'logo.png')))
T(
  'guard: binary file logo.png is either byte-identically synced to Bob OR visibly reported as unshared to Alice',
  syncedToBob || aliceNoticed,
  syncedToBob ? 'synced byte-identical' : (aliceNoticed ? `reported via ${reasonReported}` : 'SILENT LOSS: neither synced nor reported!')
)

// Check notice guidance
const allChat = alice.doc.getArray('chat').toArray().map((m) => String(m.text || ''))
const hasGuidance = allChat.some((m) => m.includes('Share it another way') || m.includes('commit it') || m.includes('stays on'))
T('guard: notice explains why and provides actionable guidance', hasGuidance, hasGuidance ? 'guidance found' : 'no guidance found')

// 4. Test Case (c): file that starts as text, then becomes binary after edit
T('evolving.txt initially synced to Bob as text', evolvingSynced)

// Alice now overwrites evolving.txt with binary bytes (contains nulls)
fs.writeFileSync(path.join(aliceDir, 'evolving.txt'), Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]))
await sleep(1500)

let evolvingNoticed = false
const deadline2 = Date.now() + 5000
while (Date.now() < deadline2) {
  const st = alice.status()
  const unshared = (st.unsharedFiles || st.notSyncingFiles || [])
  const hasEvolvingInStatus = unshared.some((u) => (typeof u === 'string' ? u : u.path).includes('evolving.txt'))
  const chatMsgs = alice.doc.getArray('chat').toArray().map((m) => String(m.text || ''))
  const hasEvolvingChat = chatMsgs.some((m) => m.includes('evolving.txt') && (m.includes('binary') || m.includes('unshared') || m.includes('stays on')))

  if (hasEvolvingInStatus || hasEvolvingChat) {
    evolvingNoticed = true
    break
  }
  await sleep(250)
}

T('guard: file that becomes binary after edit is reported as unshared/binary', evolvingNoticed, evolvingNoticed ? 'reported' : 'silent divergence!')

// 5. Test Case: oversized text file (> 1MB)
const OVERSIZED_TEXT = 'A'.repeat(1_100_000)
fs.writeFileSync(path.join(aliceDir, 'large.txt'), OVERSIZED_TEXT)
await sleep(1500)

let oversizedNoticed = false
const deadline3 = Date.now() + 5000
while (Date.now() < deadline3) {
  const st = alice.status()
  const unshared = (st.unsharedFiles || st.notSyncingFiles || [])
  const u = unshared.find((x) => (typeof x === 'string' ? x : x.path).includes('large.txt'))
  if (u && (typeof u === 'object' ? u.reason === 'oversized' : true)) {
    oversizedNoticed = true
    break
  }
  await sleep(250)
}
T('guard: oversized file (> 1MB) is reported as unshared with reason oversized', oversizedNoticed)
T('guard: Bob does NOT have large.txt on disk', !fs.existsSync(path.join(bobDir, 'large.txt')))

// 6. Test Case: deleting unshared file discharges warning
fs.unlinkSync(path.join(aliceDir, 'logo.png'))
await sleep(1500)
const stAfterDelete = alice.status()
const unsharedAfter = (stAfterDelete.unsharedFiles || [])
const logoStillThere = unsharedAfter.some((x) => (typeof x === 'string' ? x : x.path).includes('logo.png'))
T('guard: deleting unshared file discharges it from unshared list', !logoStillThere)

// 7. Test Case: "Text in room, binary on disk" — teammate's remote edit to that text must not cause silent loss of Alice's binary bytes
const ALICE_BIN_BYTES = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE])
fs.writeFileSync(path.join(bobDir, 'evolving.txt'), 'Bob edits text in room\n')
await sleep(2000)

let aliceBytesPreserved = false
let preservedWhere = ''

// Check if Alice's local evolving.txt still holds her binary bytes
const aliceEvolving = path.join(aliceDir, 'evolving.txt')
if (fs.existsSync(aliceEvolving)) {
  try {
    if (fs.readFileSync(aliceEvolving).equals(ALICE_BIN_BYTES)) {
      aliceBytesPreserved = true
      preservedWhere = 'kept on disk (skipped clobber)'
    }
  } catch {}
}

// Check if Alice's binary bytes were saved to .hive-deleted
if (!aliceBytesPreserved) {
  const deletedDir = path.join(aliceDir, '.hive-deleted')
  if (fs.existsSync(deletedDir)) {
    function findSavedCopy(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          const res = findSavedCopy(full)
          if (res) return res
        } else if (ent.name === 'evolving.txt') {
          if (fs.readFileSync(full).equals(ALICE_BIN_BYTES)) return full
        }
      }
      return null
    }
    const saved = findSavedCopy(deletedDir)
    if (saved) {
      aliceBytesPreserved = true
      preservedWhere = `saved to .hive-deleted (${path.relative(aliceDir, saved)})`
    }
  }
}

T('guard: text in room, binary on disk - teammate remote edit does not silently destroy Alice binary bytes', aliceBytesPreserved, preservedWhere)

// Clean teardown
alice.stop()
bob.stop()
relay.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
