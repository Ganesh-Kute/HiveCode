// ADVERSARIAL TEST SUITE FOR editLines ON release-0.14.2 (d27bf08)
// Testing Claude's 5 adversarial vectors:
// (a) mixed endings inside one file
// (b) old/new across a file the watcher hasn't re-read since a CRLF <-> LF flip
// (c) old containing a lone \r
// (d) two agents' old/new on different lines within 100 ms
// (e) old/new on a file whose disk write is still debounced
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = 1355
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`)
  if (c) pass++; else fail++
}

process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'

const startRelay = async () => {
  const r = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), HIVE_ENFORCE_CLAIMS: 'queue', HIVE_PERSIST_DIR: '' },
  })
  r.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 20000)
    r.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); res() } })
  })
  return r
}
let relay = await startRelay()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-adv-'))
const room = 'adv-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`
const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const join = (dir, name) => startSync({ relay: wsUrl, room, dir, name, kind: 'ai', log: () => {} })
const normLF = (s) => (s || '').replace(/\r\n/g, '\n')
const lines = (agent, ...a) => agent.editLines(...a)

let A, B
try {
  A = join(dA, 'A'); B = join(dB, 'B')
  await sleep(2500)

  const seed = async (file, text) => {
    A.claim(file, 'seed')
    fs.writeFileSync(path.join(dA, file), text)
    await sleep(3000)
    A.release(file)
    await sleep(1500)
  }

  // =========================================================================
  // Case (a): mixed endings inside one file
  // =========================================================================
  console.log('\n# Case (a): mixed endings inside one file')
  // Line 1 has CRLF, Line 2 has LF, Line 3 has CRLF
  const mixedContent = 'line 1\r\nline 2\nline 3\r\n'
  await seed('mixed.txt', mixedContent)
  // Check what landed on B
  const diskB_mixed = read(path.join(dB, 'mixed.txt'))
  console.log('  [info] B initial disk content:', JSON.stringify(diskB_mixed))
  B.claim('mixed.txt', 'edit line 2')
  const r_a = lines(B, 'mixed.txt', 'line 2', 'line 2 edited // B', 'edit line 2')
  await sleep(3000)
  T('(a) editLines succeeds on file with mixed endings', r_a && r_a.ok === true, JSON.stringify(r_a))
  const landedA_a = read(path.join(dA, 'mixed.txt'))
  const landedB_a = read(path.join(dB, 'mixed.txt'))
  T('(a) both folders hold the edit without markers', normLF(landedA_a) === 'line 1\nline 2 edited // B\nline 3\n' && normLF(landedB_a) === normLF(landedA_a), JSON.stringify([landedA_a, landedB_a]))
  B.release('mixed.txt'); await sleep(1000)

  // =========================================================================
  // Case (b): old/new across a file the watcher hasn't re-read since a CRLF <-> LF flip
  // =========================================================================
  console.log('\n# Case (b): CRLF <-> LF flip on disk before watcher re-reads')
  await seed('flip.txt', 'row one\nrow two\nrow three\n')
  B.claim('flip.txt', 'flip')
  // Agent flips disk from LF to CRLF directly on disk without sleeping (watcher hasn't debounced/re-read)
  fs.writeFileSync(path.join(dB, 'flip.txt'), 'row one\r\nrow two\r\nrow three\r\n')
  // Immediately call editLines
  const r_b = lines(B, 'flip.txt', 'row two', 'row 2 replaced // B', 'flip')
  await sleep(3000)
  T('(b) editLines succeeds immediately after disk CRLF flip', r_b && r_b.ok === true, JSON.stringify(r_b))
  const landedA_b = read(path.join(dA, 'flip.txt'))
  const landedB_b = read(path.join(dB, 'flip.txt'))
  T('(b) both folders hold replaced line', normLF(landedA_b) === 'row one\nrow 2 replaced // B\nrow three\n' && normLF(landedB_b) === normLF(landedA_b), JSON.stringify([landedA_b, landedB_b]))
  B.release('flip.txt'); await sleep(1000)

  // =========================================================================
  // Case (c): old containing a lone \r
  // =========================================================================
  console.log('\n# Case (c): old containing a lone \\r')
  await seed('cr.txt', 'first line\nsecond line\nthird line\n')
  B.claim('cr.txt', 'lone cr')
  const r_c = lines(B, 'cr.txt', 'second\rline', 'second line replaced', 'lone cr')
  await sleep(1500)
  // Old does not exist in room copy (room has \n), so it should be refused, not corrupt or crash
  T('(c) lone \\r in old is safely refused (old not found in room copy)', r_c && r_c.ok !== true && !!r_c.error, JSON.stringify(r_c))
  B.release('cr.txt'); await sleep(1000)

  // =========================================================================
  // Case (d): two agents' old/new on different lines within 100 ms
  // =========================================================================
  console.log('\n# Case (d): two agents edit different lines concurrently within 100 ms')
  const baseLines = 'func one() {\n  return 1\n}\n\nfunc two() {\n  return 2\n}\n'
  await seed('concurrent.js', baseLines)
  // Neither holds an exclusive claim, or both claim different parts (or concurrent edits without claims)
  // Call editLines concurrently on A and B
  const pA = lines(A, 'concurrent.js', '  return 1', '  return 101 // A', 'concurrent A')
  const pB = lines(B, 'concurrent.js', '  return 2', '  return 202 // B', 'concurrent B')
  console.log('  [info] rA:', JSON.stringify(pA))
  console.log('  [info] rB:', JSON.stringify(pB))
  await sleep(4000)
  const landedA_d = read(path.join(dA, 'concurrent.js'))
  const landedB_d = read(path.join(dB, 'concurrent.js'))
  console.log('  [info] landedA_d:', JSON.stringify(landedA_d))
  console.log('  [info] landedB_d:', JSON.stringify(landedB_d))
  T('(d) concurrent edits on different lines: both land or clean status', (pA.ok && pB.ok) || (pA.ok && pB.error) || (pB.ok && pA.error))
  T('(d) no silent loss: whatever landed is consistent across both folders', normLF(landedA_d) === normLF(landedB_d))
  // Converging is not enough: both folders agreeing on ONE of two edits that each said ok is a silent loss.
  const keptD = (t) => (!pA.ok || (t || '').includes('101 // A')) && (!pB.ok || (t || '').includes('202 // B')) && !(t || '').includes('<<<<<<<')
  T('(d) every edit that reported ok is in both folders, no markers', keptD(landedA_d) && keptD(landedB_d), JSON.stringify([landedA_d, landedB_d]))

  // =========================================================================
  // Case (e): old/new on a file whose disk write is still debounced
  // =========================================================================
  console.log('\n# Case (e): old/new on a file whose disk write is still debounced')
  await seed('debounce.js', 'const x = 10\nconst y = 20\n')
  B.claim('debounce.js', 'debounce')
  // B writes a local edit to disk
  fs.writeFileSync(path.join(dB, 'debounce.js'), 'const x = 999\nconst y = 20\n')
  // Immediately call editLines for y, BEFORE the disk write for x has been synced to the room
  const r_e = lines(B, 'debounce.js', 'const y = 20', 'const y = 2000', 'debounce edit')
  console.log('  [info] r_e:', JSON.stringify(r_e))
  T('(e) refused while disk has unsent changes (protecting local edit from being clobbered)', r_e && r_e.ok !== true && r_e.error && r_e.error.includes('differs from the room'))
  B.release('debounce.js'); await sleep(1000)

} catch (e) {
  console.log('  FAIL (threw) ' + (e && e.stack || e)); fail++
} finally {
  for (const c of [A, B]) { try { c && c.stop() } catch { } }
  relay.kill()
  console.log(`\n=== ADVERSARIAL REVIEW: ${pass} passed, ${fail} failed ===`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
