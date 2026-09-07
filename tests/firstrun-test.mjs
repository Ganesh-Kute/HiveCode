// FIRST-RUN and GUARD-RAIL test — the three things that decide whether a trial survives.
//
// 1. THE COLD START. The existing reachability reporting waits for three consecutive
//    FAILURES before it speaks. A sleeping relay does not fail: the socket is just slow to
//    be accepted, so no error event fires and nothing is said. On a free host that is 30
//    seconds of a command appearing to hang, on someone's very first run. It is not an error
//    at all -- it only needed saying.
//
// 2. THE DOUBLE JOIN. Nothing refused a second sync client on one folder. The identical
//    omission cost GRM most of a journal: two watchers appended concurrently, their writes
//    interleaved, and 99% of it became unreadable while the watermark still claimed the
//    files were indexed. Silent, and discovered much later by someone trying to read it.
//
// 3. THE WARNING BEFORE THE WALL. A limit that arrives with no notice reads as a fault. The
//    customer's first conclusion is "it broke", not "I am on the free plan".
//
//   node tests/firstrun-test.mjs
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import http from 'http'
import { startSync, acquireFolderLock } from '../sync.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-first-'))

console.log('\n# The cold start says something instead of hanging')
// A port with nothing on it is indistinguishable, from the client's side, from a relay that
// has not woken yet: no accept, no error worth reporting for the first few seconds.
const dead = path.join(tmp, 'dead'); fs.mkdirSync(dead)
const lines = []
const s0 = startSync({
  relay: 'ws://127.0.0.1:1', room: 'cold-' + crypto.randomBytes(3).toString('hex'),
  dir: dead, name: 'A', kind: 'ai', log: (m) => lines.push(String(m)),
})
await sleep(1000)
T('it does not shout immediately (one slow second is not an outage)',
  !lines.some((l) => /waiting for the relay/.test(l)))
await sleep(4200)
const said = lines.join('\n')
T('by ~5s it says it is waiting', /waiting for the relay/.test(said))
T('...and names the relay it is waiting on', /ws:\/\/127\.0\.0\.1:1/.test(said))
T('...and explains a cold start can take 30s', /30s|sleeping relay/.test(said))
s0.stop()

console.log('\n# A relay that IS there produces no cold-start noise')
const PORT = 1461
const relay = await (() => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
})()
const warm = path.join(tmp, 'warm'); fs.mkdirSync(warm)
const wlines = []
const s1 = startSync({
  relay: `ws://127.0.0.1:${PORT}`, room: 'warm-' + crypto.randomBytes(3).toString('hex'),
  dir: warm, name: 'B', kind: 'ai', log: (m) => wlines.push(String(m)),
})
await sleep(6000)
T('a reachable relay never prints the waiting message', !wlines.some((l) => /waiting for the relay/.test(l)))
T('...and never prints NOT SYNCING', !wlines.some((l) => /NOT SYNCING/.test(l)))

console.log('\n# One client per folder')
const held = path.join(tmp, 'held'); fs.mkdirSync(held)
const rel1 = acquireFolderLock(held, 'roomX', () => { })
T('the first lock is granted', typeof rel1 === 'function')
T('a lock file is written', fs.existsSync(path.join(held, '.hive-lock.json')))
const lock = JSON.parse(fs.readFileSync(path.join(held, '.hive-lock.json'), 'utf8'))
T('it records this process id', lock.pid === process.pid)
T('...and the room', lock.room === 'roomX')

// Same process re-locking must NOT be refused: startSync -> stop -> startSync on one folder
// is a normal sequence, and refusing it would break every test suite and every reconnect.
let sameProcOk = true
try { acquireFolderLock(held, 'roomX', () => { }) } catch { sameProcOk = false }
T('the SAME process may re-lock (stop/start is normal)', sameProcOk)

// A live foreign pid must be refused. Using pid 1 / the parent: something that exists and
// is definitely not us.
const foreign = path.join(tmp, 'foreign'); fs.mkdirSync(foreign)
const alienPid = process.ppid && process.ppid !== process.pid ? process.ppid : 1
fs.writeFileSync(path.join(foreign, '.hive-lock.json'), JSON.stringify({ pid: alienPid, room: 'other', at: Date.now() }))
let refusal = null
try { acquireFolderLock(foreign, 'roomY', () => { }) } catch (e) { refusal = e }
T('a lock held by a LIVE other process is refused', !!refusal && refusal.code === 'EHIVELOCKED')
T('...with a Q-code', !!refusal && /Q470/.test(refusal.message))
T('...naming the pid so it can be stopped', !!refusal && refusal.pid === alienPid)
T('...and saying WHY, not just that it failed', !!refusal && /corrupt/.test(refusal.message))

// A dead pid is a stale lock. If a crash locked a folder forever, people would delete lock
// files by hand and lose the protection entirely.
const stale = path.join(tmp, 'stale'); fs.mkdirSync(stale)
fs.writeFileSync(path.join(stale, '.hive-lock.json'), JSON.stringify({ pid: 999999, room: 'gone', at: 1 }))
const staleLog = []
let staleOk = true
try { acquireFolderLock(stale, 'roomZ', (m) => staleLog.push(String(m))) } catch { staleOk = false }
T('a lock whose process is GONE is taken over, not honoured forever', staleOk)
T('...and it says so', staleLog.some((l) => /stale lock/.test(l)))

// Corrupt lock must not brick the folder.
const bad = path.join(tmp, 'bad'); fs.mkdirSync(bad)
fs.writeFileSync(path.join(bad, '.hive-lock.json'), '{ truncated')
let badOk = true
try { acquireFolderLock(bad, 'roomW', () => { }) } catch { badOk = false }
T('an unreadable lock file does not brick the folder', badOk)

// Release only removes OUR lock.
rel1()
T('release removes the lock', !fs.existsSync(path.join(held, '.hive-lock.json')))
fs.writeFileSync(path.join(held, '.hive-lock.json'), JSON.stringify({ pid: alienPid, room: 'someone-else', at: Date.now() }))
rel1() // already released; must be a no-op and must not touch the new owner's lock
T('release never removes ANOTHER process\'s lock', fs.existsSync(path.join(held, '.hive-lock.json')))

console.log('\n# startSync refuses a locked folder end to end')
const dbl = path.join(tmp, 'dbl'); fs.mkdirSync(dbl)
fs.writeFileSync(path.join(dbl, '.hive-lock.json'), JSON.stringify({ pid: alienPid, room: 'r', at: Date.now() }))
let syncRefusal = null
try {
  startSync({ relay: `ws://127.0.0.1:${PORT}`, room: 'r', dir: dbl, name: 'C', kind: 'ai', log: () => { } })
} catch (e) { syncRefusal = e }
T('startSync throws EHIVELOCKED rather than starting a second client', !!syncRefusal && syncRefusal.code === 'EHIVELOCKED')

console.log('\n# The lock file is never synced to peers')
const syncSrc = fs.readFileSync(new URL('../sync.js', import.meta.url), 'utf8')
T('.hive-lock.json is in ALWAYS_IGNORE', /'\.hive-lock\.json',/.test(syncSrc))

console.log('\n# The 80% warning fires once, before the wall')
process.env.HIVE_USAGE_SECRET = 'warn-secret'
process.env.HIVE_FREE_PERIOD_WRITE_BYTES = '1000'
process.env.HIVE_FREE_PERIOD_WRITES = '1000000'
process.env.HIVE_USAGE_API = 'http://127.0.0.1:1/api/usage' // never reached; state is set directly
const m = await import('../usage-meter.js?warn=1')
m._reset()
const a = 'room:warncase'
m._setQuota(a, false, { writeBytes: 500, writes: 0 })
T('at 50% there is no warning', m.warningFor(a) === null)
m._setQuota(a, false, { writeBytes: 850, writes: 0 })
const w = m.warningFor(a)
T('at 85% it warns', !!w)
T('...with the percentage', /85%/.test(w || ''))
T('...with the real numbers, not just a percentage', /of 0 MB|MB of/.test(w || ''))
T('...saying reads keep working', /reads keep working/.test(w || ''))
// Was /pricing/ — the warning named a route that has since been retired, so the assertion
// passed while the message sent customers to a 404. An address is the durable thing to check.
T('...and where to go', /support@getgrm\.tech/.test(w || ''))
T('it warns ONCE, not on every write', m.warningFor(a) === null)

m._reset()
m._setQuota(a, true, { writeBytes: 2000, writes: 0 })
T('an account already OVER gets no warning (the refusal is the message)', m.warningFor(a) === null)

m._reset()
m._setQuota(a, false, { writeBytes: 850, writes: 0 })
T('warnable again after invalidate (e.g. dropped back to free)',
  (m.invalidate(a), m._setQuota(a, false, { writeBytes: 850, writes: 0 }), !!m.warningFor(a)))
T('fractionUsed reports the furthest-along counter', Math.abs(m.fractionUsed({ writeBytes: 500, writes: 0 }) - 0.5) < 0.01)

s1.stop()
relay.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
console.log(`\n=== FIRST RUN + GUARDS: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
