// USAGE LIMITS test — the bounds that let one relay be shared by paying customers.
//
// Two halves, and both matter:
//   1. the bucket/counter logic in isolation (fast, deterministic, no sockets)
//   2. a LIVE relay proving a flood is actually refused and, crucially, that a normal
//      session is NOT -- a limit that also blocks legitimate work is worse than none,
//      because it looks like the product is broken rather than protected.
//
//   node tests/limits-test.mjs
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import * as L from '../limits.js'
import { startSync } from '../sync.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

console.log('\n# Connection admission')
L._reset()
T('admits the first connection', L.admitConnection('r1') === null)
for (let i = 0; i < L.LIMITS.maxConnsPerRoom; i++) L.noteConnectionOpened('r1')
const roomFull = L.admitConnection('r1')
T('refuses past the per-room cap', !!roomFull && /Q431/.test(roomFull.reason))
T('...with 429, not 503 (the room is full, the relay is not)', roomFull.code === 429)
T('a DIFFERENT room is still admitted', L.admitConnection('r2') === null)
L.noteConnectionClosed('r1')
T('a close frees a slot', L.admitConnection('r1') === null)

L._reset()
for (let i = 0; i < L.LIMITS.maxConnsTotal; i++) L.noteConnectionOpened('r' + (i % 50))
const relayFull = L.admitConnection('brand-new-room')
T('refuses past the relay-wide cap even for a fresh room', !!relayFull && /Q430/.test(relayFull.reason))
T('...with 503 (the relay is at capacity)', relayFull.code === 503)

L._reset()
L.noteConnectionOpened('r9'); L.noteConnectionClosed('r9'); L.noteConnectionClosed('r9')
T('a double close cannot drive the count negative', L.stats().connections === 0)
T('an emptied room leaves no entry behind (no per-room leak)', L.stats().rooms === 0)

console.log('\n# Document size cap')
L._reset()
T('a fresh doc is under the cap', !L.docOverCap('d1'))
L.noteDocBytes('d1', L.LIMITS.maxDocBytes - 1)
T('just under the cap is still allowed', !L.docOverCap('d1'))
L.noteDocBytes('d1', 1)
T('at the cap, writes are refused', L.docOverCap('d1'))
T('another doc is unaffected', !L.docOverCap('d2'))
L.setDocBytes('d1', 0)
T('setDocBytes can reseed a doc (used when loading a snapshot)', !L.docOverCap('d1'))
L.setDocBytes('d3', 999)
L.forgetDoc('d3')
T('forgetDoc clears a doc', L.docSize('d3') === 0)

console.log('\n# Per-connection rate limiting')
L._reset()
const fake = { on: () => { }, _hive: { room: 'r' } }
const lim = L.attachRateLimit(fake)
T('a normal frame passes', lim.check(100) === null)
let firstRefusalAt = -1
for (let i = 0; i < L.LIMITS.msgBurst + 50; i++) {
  if (lim.check(10) && firstRefusalAt < 0) firstRefusalAt = i
}
T('a sustained flood is eventually refused', firstRefusalAt > 0)
T('...and the burst allowance was honoured first (not refused immediately)', firstRefusalAt > 100)
const refusal = lim.check(10)
T('a refusal carries a Q-code and a reason', !!refusal && /^Q43[24]/.test(refusal.reason))
T('the refusal says how long to back off', !!refusal && /backing off|rate/.test(refusal.reason))
T('refusals are counted', lim.refused > 0)

const lim2 = L.attachRateLimit({ on: () => { } })
const big = lim2.check(L.LIMITS.maxFrameBytes + 1)
T('one oversized frame is refused on its own terms', !!big && /Q433/.test(big.reason))
T('...and does NOT trigger a cooloff (it is a client bug, not a flood)', lim2.check(100) === null)

console.log('\n# Live relay: a flood is refused, a real session is not')
const PORT = 1331
const startRelay = (env = {}) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}
// A tiny cap so the test is fast and deterministic rather than pushing 8 MB/s.
const relay = await startRelay({ HIVE_MAX_MSGS_PER_SEC: '5', HIVE_MAX_MSG_BURST: '20', HIVE_RATE_COOLOFF_MS: '3000' })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-lim-'))
const room = 'lim-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`

const health = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json()).catch(() => null)
T('/health answers', !!health && health.ok === true)
T('/health reports the configured limits', !!health && health.limits && health.limits.msgsPerSec === 5)
T('/health leaks no room names or identities',
  !!health && !JSON.stringify(health).includes(room) && !/identity|names/.test(JSON.stringify(health)))

// A NORMAL session under a deliberately tight limit must still converge. This is the
// assertion that would fail if the limiter were counting the wrong thing.
const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
const A = startSync({ relay: wsUrl, room, dir: dA, name: 'A', kind: 'ai', log: () => { } })
await sleep(2500)
fs.writeFileSync(path.join(dA, 'note.md'), '# hello\n\nsome ordinary content\n')
await sleep(3000)
const B = startSync({ relay: wsUrl, room, dir: dB, name: 'B', kind: 'ai', log: () => { } })
await sleep(4000)
T('an ordinary two-client session still syncs under a tight limit',
  (fs.readFileSync(path.join(dB, 'note.md'), 'utf8') || '').includes('ordinary content'))

const after = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json()).catch(() => null)
T('/health counts the live connections', !!after && after.connections >= 2)
T('/health tracks document sizes', !!after && after.docsTracked > 0)

for (const c of [A, B]) { try { c.stop() } catch { } }
await sleep(800)
const drained = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json()).catch(() => null)
T('connections are released on close (no leak)', !!drained && drained.connections === 0)


console.log('\n# Tiers: limits scale with what the licence says')
// The first version of limits.js applied ONE ceiling to everyone -- a free room got the same
// 64MB document cap as a room paying $29/seat. These assertions are what stops that
// regressing, because it is invisible until a customer notices they are subsidising strangers.
const tFree = L.limitsFor(null)
const tInvalid = L.limitsFor({ valid: false, seats: 0, plan: null })
const tFreePlan = L.limitsFor({ valid: true, seats: 2, plan: 'free' })
const tPro1 = L.limitsFor({ valid: true, seats: 1, plan: 'pro' })
const tPro5 = L.limitsFor({ valid: true, seats: 5, plan: 'pro' })
const tPro100 = L.limitsFor({ valid: true, seats: 100, plan: 'pro' })

T('no licence -> free tier, not unlimited', tFree.tier === 'free')
T('an INVALID licence -> free tier, still bounded', tInvalid.tier === 'free' && tInvalid.maxDocBytes === tFree.maxDocBytes)
T('an explicit free plan -> free tier', tFreePlan.tier === 'free')
T('a valid pro licence -> pro tier', tPro1.tier === 'pro')
T('one Pro seat already beats the whole free tier', tPro1.maxDocBytes > tFree.maxDocBytes && tPro1.msgsPerSec > tFree.msgsPerSec)
T('limits scale per seat', tPro5.msgsPerSec === tPro1.msgsPerSec * 5 && tPro5.maxConnsPerRoom === tPro1.maxConnsPerRoom * 5)
T('a ceiling stops one licence consuming the relay', tPro100.maxDocBytes < tPro1.maxDocBytes * 100)
T('...and the same for connections', tPro100.maxConnsPerRoom < tPro1.maxConnsPerRoom * 100)
T('a valid licence with no plan field is treated as pro (older validators)', L.limitsFor({ valid: true, seats: 3 }).tier === 'pro')

// The tier must actually be applied, not merely computed.
L._reset()
for (let i = 0; i < tFree.maxConnsPerRoom; i++) L.noteConnectionOpened('freeroom')
const freeCapped = L.admitConnection('freeroom', tFree)
T('the FREE per-room connection cap is enforced', !!freeCapped && /Q431/.test(freeCapped.reason))
T('...and the refusal names the tier', !!freeCapped && /free tier/.test(freeCapped.reason))
T('a Pro room with the same count is still admitted', L.admitConnection('freeroom', tPro5) === null)

L._reset()
L.noteDocBytes('d', tFree.maxDocBytes)
T('the FREE document cap is enforced', L.docOverCap('d', tFree))
T('the same document is fine on Pro', !L.docOverCap('d', tPro5))

const freeLim = L.attachRateLimit({ on: () => { } }, tFree)
const proLim = L.attachRateLimit({ on: () => { } }, tPro5)
let freeRefusedAt = -1, proRefusedAt = -1
for (let i = 0; i < tPro5.msgBurst + 100; i++) {
  if (freeLim.check(10) && freeRefusedAt < 0) freeRefusedAt = i
  if (proLim.check(10) && proRefusedAt < 0) proRefusedAt = i
}
T('the free rate limit bites sooner than the pro one', freeRefusedAt > 0 && proRefusedAt > freeRefusedAt)
// A FRESH limiter, driven to its FIRST refusal. Reusing freeLim would read the cooloff
// message ("backing off for Ns"), which deliberately omits the tier — only the message that
// explains WHY the limit exists names it, and that is the one a customer needs to see.
const freshFree = L.attachRateLimit({ on: () => { } }, tFree)
let firstFreeRefusal = null
for (let i = 0; i < tFree.msgBurst + 50 && !firstFreeRefusal; i++) firstFreeRefusal = freshFree.check(10)
T('the free refusal names its tier', !!firstFreeRefusal && /free tier/.test(firstFreeRefusal.reason))
T('...and carries a Q-code', !!firstFreeRefusal && /^Q43[24]/.test(firstFreeRefusal.reason))

console.log('\n# Per-agent usage (activity, NOT token spend)')
L._reset()
const lim3 = L.attachRateLimit({ on: () => { } }, tPro5)
lim3.check(100); lim3.check(200); lim3.noteWrite(200)
const u = lim3.usage()
T('a connection counts its own messages and bytes', u.msgs === 2 && u.bytes === 300)
T('writes are counted apart from reads', u.writes === 1 && u.writeBytes === 200)
T('time held is recorded', typeof u.heldMs === 'number')

L.recordUsage('proj', 'Ada', { msgs: 10, bytes: 1000, writes: 4, writeBytes: 800, refused: 0, heldMs: 5000 }, 'routes.js')
L.recordUsage('proj', 'Ada', { msgs: 5, bytes: 500, writes: 1, writeBytes: 100, refused: 2, heldMs: 1000 }, 'models.js')
L.recordUsage('proj', 'Blake', { msgs: 3, bytes: 200, writes: 0, writeBytes: 0, refused: 0, heldMs: 900 }, 'routes.js')
L.recordUsage('other', 'Cleo', { msgs: 99, bytes: 9999, writes: 9, writeBytes: 9999, refused: 0, heldMs: 100 }, 'x.js')
const rows = L.usageFor('proj')
T('usage is per room', rows.length === 2 && !rows.some((r) => r.agent === 'Cleo'))
T('a returning agent accumulates rather than resetting', rows[0].msgs === 15 && rows[0].sessions === 2)
T('distinct files touched are counted', rows[0].files === 2)
T('refusals are attributed to the agent', rows[0].refused === 2)
T('the busiest WRITER sorts first', rows[0].agent === 'Ada')
T('a read-only agent shows zero writes', rows.find((r) => r.agent === 'Blake').writes === 0)
T('omitting the room returns every room', L.usageFor().length === 3)

relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
console.log(`\n=== USAGE LIMITS: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
