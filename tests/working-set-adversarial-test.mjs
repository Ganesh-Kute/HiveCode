// ADVERSARIAL TEST SUITE FOR WORKING-SET CAP (f4e10d4 / 5953cb3) ON WINDOWS
// Testing Claude's 3 adversarial scenarios:
// (1) A new file renamed while it's queued
// (2) A peer's new file whose name collides only by case (Windows case-insensitivity)
// (3) Cap reached during a rejoin (in-session socket reconnect & process rejoin)
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = 1364
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`)
  if (c) pass++; else fail++
}

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-wsadv-'))
const room = 'wsadv-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`
const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
const dC = path.join(tmp, 'c'); fs.mkdirSync(dC)
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const exists = (p) => fs.existsSync(p)

// Set low working set cap: HIVE_MAX_OPEN_FILES = 4
process.env.HIVE_MAX_OPEN_FILES = '4'
const join = (dir, name) => startSync({ relay: wsUrl, room, dir, name, kind: 'ai', log: () => {} })

let A, B, C
try {
  A = join(dA, 'A'); B = join(dB, 'B')
  await sleep(2500)

  // Pre-fill B's working set to cap (4 files)
  console.log('\n# Setup: Fill working set to cap (4 files)')
  for (let i = 1; i <= 4; i++) {
    A.claim(`base-${i}.txt`, 'seed')
    fs.writeFileSync(path.join(dA, `base-${i}.txt`), `base content ${i}\n`)
    await sleep(200)
    A.release(`base-${i}.txt`)
  }
  await sleep(3500)
  const bStatus = B.status()
  console.log('  [info] B status after base fill: files =', bStatus.files, 'openCap =', bStatus.openCap)
  T('B working set is at cap', bStatus.files >= 4)

  // =========================================================================
  // Scenario 1: A new file renamed while it is queued
  // =========================================================================
  console.log('\n# Scenario 1: A new file renamed while queued')
  // We burst 10 files from A so that some queue up behind the headroom, and rename one immediately
  for (let i = 1; i <= 10; i++) {
    A.claim(`burst-${i}.txt`, 'burst')
    fs.writeFileSync(path.join(dA, `burst-${i}.txt`), `burst ${i}\n`)
  }
  // Immediately rename burst-10.txt -> burst-10-renamed.txt on A
  fs.renameSync(path.join(dA, 'burst-10.txt'), path.join(dA, 'burst-10-renamed.txt'))
  for (let i = 1; i <= 9; i++) A.release(`burst-${i}.txt`)
  A.release('burst-10.txt')
  A.claim('burst-10-renamed.txt', 'renamed')
  A.release('burst-10-renamed.txt')

  await sleep(6000)
  // Check B's disk
  const bHasRenamed = exists(path.join(dB, 'burst-10-renamed.txt'))
  const bHasOld = exists(path.join(dB, 'burst-10.txt'))
  console.log('  [info] B has renamed:', bHasRenamed, 'B has old:', bHasOld)
  T('Scenario 1: Renamed file arrives on B', bHasRenamed === true)
  T('Scenario 1: Old queued name does NOT persist or resurrect on B', bHasOld === false)

  // =========================================================================
  // Scenario 2: A peer's new file whose name collides only by case (Windows)
  // =========================================================================
  console.log('\n# Scenario 2: Peer creates a new file colliding only by case')
  // A creates "case-file.txt"
  A.claim('case-file.txt', 'case seed')
  fs.writeFileSync(path.join(dA, 'case-file.txt'), 'lowercase version\n')
  await sleep(2000)
  A.release('case-file.txt')
  await sleep(2000)
  T('Lowercase case-file.txt reached B', exists(path.join(dB, 'case-file.txt')))

  // Peer C in separate folder dC creates "CASE-FILE.txt" (different case)
  C = join(dC, 'C')
  await sleep(2000)
  C.claim('CASE-FILE.txt', 'uppercase collision')
  fs.writeFileSync(path.join(dC, 'CASE-FILE.txt'), 'UPPERCASE VERSION\n')
  await sleep(2000)
  C.release('CASE-FILE.txt')
  await sleep(3500)

  // Check how B on Windows handles the case collision
  const bCollided = B.collided()
  console.log('  [info] B collided list:', JSON.stringify(bCollided))
  const bDiskContent = read(path.join(dB, 'case-file.txt'))
  console.log('  [info] B disk content for case-file.txt:', JSON.stringify(bDiskContent))
  // The collision exists only where the filesystem folds case (Windows, default macOS). On a
  // case-sensitive disk (Linux) the two names are two files, sync.js records no collision, and the
  // right outcome is that BOTH arrive intact.
  const probe = path.join(dB, '.Case-Probe-' + process.pid)
  let foldsCase = false
  try { fs.writeFileSync(probe, ''); foldsCase = fs.existsSync(probe.toLowerCase()) } catch { } finally { try { fs.unlinkSync(probe) } catch { } }
  if (foldsCase) {
    T('Scenario 2: Case collision detected and recorded in collided list on B', Array.isArray(bCollided) && bCollided.length > 0)
  } else {
    T('Scenario 2 (case-sensitive disk): the upper-case file arrives as its own file', read(path.join(dB, 'CASE-FILE.txt')) === 'UPPERCASE VERSION\n')
  }
  T('Scenario 2: Original file is not overwritten on disk by collided file', bDiskContent === 'lowercase version\n')

  // =========================================================================
  // Scenario 3: Cap reached during a rejoin
  // =========================================================================
  console.log('\n# Scenario 3: Cap reached during a rejoin')
  // Part A: In-session reconnect while cap is reached
  console.log('  [info] Part A: In-session reconnect with cap reached')
  // Rejoin B
  B.stop()
  await sleep(1000)
  B = join(dB, 'B')
  await sleep(3500)
  const bStatusRejoin = B.status()
  console.log('  [info] B reconnected:', bStatusRejoin.connected, 'files =', bStatusRejoin.files, 'openCap =', bStatusRejoin.openCap)
  T('Scenario 3A: Reconnect respects open cap + headroom', bStatusRejoin.connected === true && bStatusRejoin.files <= bStatusRejoin.openCap + 32)

  // Part B: Fresh client B2 in empty folder against room with >15 files
  console.log('  [info] Part B: Fresh client B2 in empty folder against room with >15 files')
  const dB2 = path.join(tmp, 'b2'); fs.mkdirSync(dB2)
  const B2 = join(dB2, 'B2')
  await sleep(4000)
  const b2Status = B2.status()
  console.log('  [info] B2 connected:', b2Status.connected, 'files =', b2Status.files, 'openCap =', b2Status.openCap, 'roomFiles =', b2Status.roomFiles, 'filesHeld =', b2Status.filesHeld)
  T('Scenario 3B: B2 respects open file bound on initial sweep', b2Status.files <= b2Status.openCap)
  T('Scenario 3B: B2 reports honest roomFiles and filesHeld', b2Status.roomFiles > b2Status.filesHeld)

  // Demand fetch for a file outside B2's initial open set
  console.log('  [info] Demand fetch base-1.txt on B2')
  const fetched = await B2.fetch('base-1.txt', { timeoutMs: 5000 })
  console.log('  [info] Fetch result:', JSON.stringify(fetched))
  T('Scenario 3B: Demand fetch succeeds for file outside initial cap set', fetched && fetched.ok === true)
  T('Scenario 3B: Fetched file is written to B2 disk', exists(path.join(dB2, 'base-1.txt')))

  B2.stop()
} catch (e) {
  console.log('  FAIL (threw) ' + (e && e.stack || e)); fail++
} finally {
  try { A && A.stop() } catch {}
  try { B && B.stop() } catch {}
  try { C && C.stop() } catch {}
  relay.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n=== WORKING-SET ADVERSARIAL: ${pass} passed, ${fail} failed ===`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
