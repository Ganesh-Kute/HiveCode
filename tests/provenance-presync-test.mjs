// tests/provenance-presync-test.mjs -- P0-3 of 0.14.3: nothing a client publishes enters the room
// unsigned, so a branch room's chain always reaches back to the branch it was cut from.
//
// The 8-9 Nov mock run: demo-3's test.js held ONE receipt, whose parent matched no version of the
// file anyone had committed, and the room's current copy had no receipt at all. `pr demo-3` refused
// with Q506 ("the branch holds content this room has never seen") although nobody had touched the
// branch, and the plan credited test.js to the one agent that had signed. Measured here: an edit
// made before the file first synced on a fresh join (the VM agents' sequence) is published without
// a receipt about one time in four, on 0.14.2 -- a race on whether a baseline existed yet.
//
//   S1..S<N>  N fresh joins, each editing a seeded file before it synced (open delayed so the edit
//             always comes first): every one must leave a receipt for the published text, and the
//             chain must contain the seed, so the staleness check says DESCENDS, never DIVERGED
//   A         the plan credits the file to the agent who wrote it
//   F         a genuine concurrent edit on one line by two agents still surfaces a fork (the new
//             signing must not hide one)

import net from 'net'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'
const { startSync } = await import('../sync.js')
const { contentHash } = await import('../substrate.js')
const { accountFor, DESCENDS } = await import('../hive-pr-staleness.js')
const { authorsOf } = await import('../hive-authors.js')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const port = await freePort()
const relayProc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('relay start timeout')), 8000)
  relayProc.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve() } })
})
const relay = `ws://127.0.0.1:${port}`
const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `hive-presync-${t}-`))
const until = async (f, ms = 15000) => { const e = Date.now() + ms; while (Date.now() < e) { try { if (f()) return true } catch { } await sleep(100) } return false }
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const join = (room, dir, name, env = {}) => {
  const saved = {}
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v }
  try { return startSync({ relay, room, dir, name, kind: 'ai', log: () => { } }) }
  finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
}
const live = []
const N = Number(process.env.PRESYNC_RUNS) || 8
try {
  console.log(`\n# S  ${N} fresh joins, each editing before the file synced`)
  let unsigned = 0, diverged = 0, wrongCredit = 0
  for (let i = 1; i <= N; i++) {
    const room = `room-presync-${i}`, dB = tmp('b'), dA = tmp('a')
    const seed = `export const n = ${i}\n`, mine = `export const n = ${i}\nexport const by = 'agentA'\n`
    fs.writeFileSync(path.join(dB, 'f.js'), seed)
    // Seeded the way `branch` seeds a room: provenance off, so the branch copy carries no receipt.
    const B = join(room, dB, 'seeder', { HIVE_PROVENANCE: 'off', HIVE_FORK_GATE: 'off' }); live.push(B)
    await until(() => B.provider.synced); await sleep(600)
    fs.writeFileSync(path.join(dA, 'f.js'), seed) // the agent's folder already holds the branch copy
    const A = join(room, dA, 'agentA', { HIVE_TEST_OPEN_DELAY_MS: '1200' }); live.push(A)
    await until(() => A.provider.synced)
    A.edit('f.js', mine, 'P0-3 presync')
    const arrived = await until(() => readOr(path.join(dB, 'f.js')) === mine, 15000)
    await sleep(1200)
    // ...then a second, ordinary edit after sync: signed, with the first edit as its parent. If the
    // first went in unsigned, the chain now skips the seed entirely -- demo-3's test.js exactly.
    const mine2 = mine + 'export const two = 2\n'
    A.edit('f.js', mine2, 'P0-3 second edit')
    await until(() => readOr(path.join(dB, 'f.js')) === mine2, 15000)
    await sleep(1200)
    const rc = A.provenanceOf('f.js') || []
    const signed = rc.some((r) => r && r.contentHash === contentHash(mine))
    const st = accountFor({ rel: 'f.js', branchText: seed, roomText: readOr(path.join(dB, 'f.js')), receipts: rc }).state
    const who = authorsOf(rc, () => true, readOr(path.join(dB, 'f.js')))
    if (!signed) unsigned++
    if (st !== DESCENDS) diverged++
    if (!who.last || who.last.name !== 'agentA') wrongCredit++
    console.log(`    run ${i}: arrived=${arrived} receipts=${rc.length} signed=${signed} staleness=${st} credit=${who.last && who.last.name}`)
    A.stop(); B.stop()
  }
  T(`S every published edit has a receipt (${N - unsigned}/${N})`, unsigned === 0)
  T(`S the staleness check says DESCENDS for an untouched branch, never DIVERGED (${N - diverged}/${N})`, diverged === 0)
  T(`A the file is credited to the agent who wrote it (${N - wrongCredit}/${N})`, wrongCredit === 0)

  console.log('\n# F  a genuine same-line edit by two agents still surfaces as a fork')
  {
    const room = 'room-presync-fork', dB = tmp('fb'), dA = tmp('fa')
    fs.writeFileSync(path.join(dB, 'g.js'), 'export const v = 1\n')
    const B = join(room, dB, 'agentB'); live.push(B)
    await until(() => B.provider.synced); await sleep(600)
    const A = join(room, dA, 'agentA'); live.push(A)
    await until(() => A.provider.synced)
    await until(() => readOr(path.join(dA, 'g.js')) === 'export const v = 1\n')
    await sleep(1500)
    A.edit('g.js', 'export const v = 2\n', 'A sets 2')
    B.edit('g.js', 'export const v = 3\n', 'B sets 3')
    await sleep(4000)
    const fa = A.forkInfo('g.js'), fb = B.forkInfo('g.js')
    const ta = readOr(path.join(dA, 'g.js')), tb = readOr(path.join(dB, 'g.js'))
    const visible = !!(fa || fb) || /<<<<<<</.test(ta || '') || /<<<<<<</.test(tb || '')
    const converged = ta === tb && !/<<<<<<</.test(ta || '')
    // Either outcome is honest: a surfaced fork, or one side cleanly winning with the other's write
    // never fused into it. What must not happen is a fused line that nobody wrote, unflagged.
    const fused = !visible && ta != null && !['export const v = 2\n', 'export const v = 3\n'].includes(ta)
    T('F no fused, unflagged line nobody wrote', !fused, `A=${JSON.stringify(ta)} B=${JSON.stringify(tb)} forkA=${!!fa} forkB=${!!fb}`)
    T('F the collision is visible (fork or markers) or the copies agree on one author\'s line', visible || converged, `A=${JSON.stringify(ta)} B=${JSON.stringify(tb)}`)
  }
} catch (e) {
  fail++
  console.log('  FAIL threw: ' + (e && e.stack || e))
} finally {
  for (const h of live) { try { h.stop() } catch { } }
  try { relayProc.kill('SIGKILL') } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
