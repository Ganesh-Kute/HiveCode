// tests/dead-heat-forced-test.mjs
// Forced dead-heat genesis collision test.
// Asserts:
// 1. Both docs identical (CRDT convergence)
// 2. Winner content in the room
// 3. Loser disk intact (no data loss)
// 4. Loser draft snapshot present with kind 'manual'
// 5. Exactly one REFUSED announcement in chat

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (24200 + (process.pid % 17000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-deadheat-'))
const room = 'dh-' + crypto.randomBytes(5).toString('hex')
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const dirA = path.join(tmp, 'a'); fs.mkdirSync(dirA, { recursive: true })
fs.writeFileSync(path.join(dirA, '.gitignore'), 'node_modules/\n')
const dirB = path.join(tmp, 'b'); fs.mkdirSync(dirB, { recursive: true })
fs.writeFileSync(path.join(dirB, '.gitignore'), 'node_modules/\n')

let A, B
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirA, name: 'A', kind: 'ai', log: () => {} })
  B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirB, name: 'B', kind: 'ai', log: () => {} })

  // Wait for both to connect and settle initial empty manifest
  await sleep(4000)

  const FILENAME = 'service.js'
  const TEXT_A = 'export default function service() {\n  console.log("version A")\n  return { role: "serviceA", port: 8080 }\n}\n'
  const TEXT_B = 'export default function service() {\n  console.log("version B")\n  return { role: "serviceB", port: 9090 }\n}\n'

  // FORCE DEAD HEAT: Write both files synchronously within 0 ms of each other
  fs.writeFileSync(path.join(dirA, FILENAME), TEXT_A)
  fs.writeFileSync(path.join(dirB, FILENAME), TEXT_B)

  // Wait for sync and dead-heat resolution to complete
  const deadline = Date.now() + 30000
  let chatMsgs = []
  while (Date.now() < deadline) {
    chatMsgs = (A.doc.getArray('chat').toArray() || [])
      .map((m) => String((m && m.text) || ''))
      .filter((t) => t.includes(FILENAME) && /fused rather than merged|would fuse them/.test(t))
    if (chatMsgs.length > 0) break
    await sleep(400)
  }

  // Allow CRDT convergence to fully settle
  await sleep(3000)

  // 1. Both docs identical
  const textInA = A._fileText(FILENAME)
  const textInB = B._fileText(FILENAME)

  T('1 both docs converge identically', textInA !== '' && textInA === textInB, `len=${textInA.length}`)

  // 2. Winner content in the room
  const aWon = textInA === TEXT_A
  const bWon = textInA === TEXT_B
  T('2 room copy is a single uncorrupted winner version', aWon || bWon, aWon ? 'winner is A' : 'winner is B')

  // 3. Loser disk intact & Winner disk intact
  const diskA = fs.readFileSync(path.join(dirA, FILENAME), 'utf8')
  const diskB = fs.readFileSync(path.join(dirB, FILENAME), 'utf8')

  T('3 A local disk is intact', diskA === TEXT_A, `matches original A draft: ${diskA === TEXT_A}`)
  T('4 B local disk is intact', diskB === TEXT_B, `matches original B draft: ${diskB === TEXT_B}`)

  // 4. Loser draft snapshot present with kind 'manual'
  const loserSnaps = aWon ? B._fileSnaps(FILENAME) : A._fileSnaps(FILENAME)
  const draftSnap = loserSnaps.find((s) => s.kind === 'manual' && /creation-race refused/.test(s.label || ''))
  T('5 loser client preserved snapshot with kind manual', !!draftSnap && draftSnap.kind === 'manual',
    draftSnap ? `label: "${draftSnap.label}"` : 'no snapshot found')

  // 5. Exactly one REFUSED announcement in chat
  const allRefusals = (A.doc.getArray('chat').toArray() || [])
    .map((m) => String((m && m.text) || ''))
    .filter((t) => t.includes(FILENAME) && /fused rather than merged|would fuse them/.test(t))
  T('6 exactly ONE refused announcement posted in chat', allRefusals.length === 1,
    `count=${allRefusals.length}: ${allRefusals.join(' | ')}`)

} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { A && A.stop() } catch { }
  try { B && B.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== FORCED DEAD-HEAT TEST: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
