// governor end to end: the stop button is a guarantee, and a budget presses it by itself.
//
//   node tests/hive-governor-test.mjs
//
// THE ASSERTION THIS SUITE EXISTS FOR is not "a paused agent stops asking for work" -- that was
// already true and it was never worth anything, because the agent being asked to stop is the same
// agent deciding whether to obey. It is:
//
//     a paused agent's write to a FILE does not land, and the agent cannot unpause itself.
//
// Both halves matter. Without the first, "stop" is advice. Without the second, "stop" is advice
// with extra steps, because the base room has never been write-gated and the control map sits
// right there in it.
//
// Everything below runs against a real relay with real clients and a real CRDT. The "rogue" agent
// is not a special harness -- it is an ordinary startSync client, which is exactly what an agent
// that ignores the rules looks like from the relay's side: it just writes.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { makeGovernor, normalizeBudget, overBudget, mayControl } from '../governor.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1293
const ROOM = 'gov-test-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- pure ----------------------------------------------------------------------------------
console.log('\n# budgets + who may press the button')
{
  T('a budget keeps only the dimensions actually set', JSON.stringify(normalizeBudget({ minutes: 5, writes: 0, bytes: -1, junk: 9 })) === '{"minutes":5}')
  T('an empty budget is no budget, not a budget of zero', normalizeBudget({}) === null && normalizeBudget({ writes: 0 }) === null)

  const use = { firstSeen: 0, writes: 3, bytes: 100, tokens: 0 }
  T('under budget is null', overBudget({ writes: 5 }, use, 0) === null)
  T('over budget names the dimension and both numbers',
    JSON.stringify(overBudget({ writes: 3 }, use, 0)) === '{"dim":"writes","limit":3,"used":3}')
  T('minutes fire on wall clock with no writes at all',
    (overBudget({ minutes: 2 }, { firstSeen: 1000, writes: 0, bytes: 0, tokens: 0 }, 1000 + 121000) || {}).dim === 'minutes')
  // The relay cannot see tokens. A tokens budget is the agent's own number, and must say so.
  T('a tokens overrun is flagged as self-reported',
    overBudget({ tokens: 10 }, { firstSeen: 0, writes: 0, bytes: 0, tokens: 10 }, 0).reported === true)

  // The rule that would have been wrong: on an OPEN relay a real person is `unknown`, never
  // `human`, because the relay refuses to honour a self-declared human.
  T('an AI may never touch the control map', mayControl({ kind: 'ai' }, 'open', false) === false)
  T('a person on an open relay CAN, even though they read as "unknown"', mayControl({ kind: 'unknown' }, 'open', false) === true)
  T('a reader never controls anything', mayControl({ kind: 'unknown' }, 'reader', false) === false)
  T('under strict auth, "unknown" is no longer enough', mayControl({ kind: 'unknown' }, 'writer', true) === false)
  T('under strict auth a verified human does', mayControl({ kind: 'human' }, 'writer', true) === true)
  T('under strict auth an admin does', mayControl({ kind: 'unknown' }, 'admin', true) === true)
  T('an AI is refused under strict too', mayControl({ kind: 'ai' }, 'admin', true) === false)

  // A blown budget presses the button itself -- that is the whole reason these share a file.
  let clock = 0
  const g = makeGovernor({ now: () => clock })
  g.setBudget('r', 'A', { writes: 2 })
  g.note('r', 'A', 10); T('under the cap, still running', g.isPaused('r', 'A') === false)
  const over = g.note('r', 'A', 10)
  T('the write that hits the cap pauses the agent', g.isPaused('r', 'A') === true, JSON.stringify(over))
  T('and the reason says which dimension and by how much', /2\/2 writes/.test(g.snapshot('r').A.why), g.snapshot('r').A.why)
}

// ---- end to end ----------------------------------------------------------------------------
console.log('\n# real relay: a paused agent cannot write, and cannot free itself')
let relay = null
const clients = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-gov-t-'))
try {
  relay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_GOVERNOR: 'on', HIVE_ENFORCE_CLAIMS: 'block' },
  })
  let banner = ''
  relay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    relay.stdout.on('data', (d) => { banner += String(d); if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })
  await sleep(300)
  T('the relay says out loud that the governor is on', /governor \(stop button \+ spend caps\): on/.test(banner),
    (banner.match(/\[relay\] governor[^\n]*/) || [''])[0])

  const dirs = {}
  const mk = (name, kind) => {
    dirs[name] = fs.mkdtempSync(path.join(tmp, name))
    return startSync({ relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: dirs[name], name, kind, syncFiles: true, log: () => {} })
  }
  const boss = mk('Ganesh', 'human'); clients.push(boss)
  const A = mk('AgentA', 'ai'); clients.push(A)
  await sleep(2500)

  const readBoss = () => { try { return fs.readFileSync(path.join(dirs.Ganesh, 'alpha.js'), 'utf8') } catch { return '' } }

  // 1. control: an unpaused agent's write reaches the human's folder.
  fs.writeFileSync(path.join(dirs.AgentA, 'alpha.js'), 'export const v = 1\n')
  await sleep(4000)
  T('an UNPAUSED agent write reaches the human', /v = 1/.test(readBoss()), JSON.stringify(readBoss()))

  // 2. the human presses stop.
  boss.control('AgentA', 'paused', 'Ganesh')
  await sleep(1500)
  T('the room shows the agent paused', (boss.doc.getMap('controls').get('AgentA') || {}).state === 'paused')

  fs.writeFileSync(path.join(dirs.AgentA, 'alpha.js'), 'export const v = 2\n')
  await sleep(4000)
  T('THE PAUSED WRITE DID NOT LAND', !/v = 2/.test(readBoss()) && /v = 1/.test(readBoss()), JSON.stringify(readBoss()))

  // 3. THE ONE THAT MAKES IT A GUARANTEE: the agent tries to free itself.
  A.control('AgentA', 'running', 'AgentA')
  await sleep(2000)
  T('the relay REVERTED the agent unpausing itself',
    (boss.doc.getMap('controls').get('AgentA') || {}).state === 'paused',
    JSON.stringify(boss.doc.getMap('controls').get('AgentA')))
  fs.writeFileSync(path.join(dirs.AgentA, 'alpha.js'), 'export const v = 3\n')
  await sleep(4000)
  T('and it is still blocked after trying', !/v = 3/.test(readBoss()), JSON.stringify(readBoss()))

  // 4. the human lets it go. Held writes replay -- a pause costs the agent nothing.
  boss.control('AgentA', 'running', 'Ganesh')
  await sleep(5000)
  T('after RESUME the held work lands', /v = 3/.test(readBoss()) || /v = 2/.test(readBoss()), JSON.stringify(readBoss()))

  // 5. a paused agent can still SPEAK. Stopping work is not stopping reporting.
  boss.control('AgentA', 'paused', 'Ganesh')
  await sleep(1200)
  A.say('paused mid-edit, alpha.js is half-written')
  await sleep(2000)
  T('a paused agent can still post to chat',
    boss.doc.getArray('chat').toArray().some((m) => /half-written/.test(m.text || '')))

  // 6. ONE AGENT'S PAUSE MUST NOT FREEZE THE ROOM. Stopping the thing that is going wrong is only
  //    useful if everyone else keeps working; otherwise the button costs a whole night's work.
  //    AgentA is still paused from step 5.
  //
  //    This asserts on CONTENT, not existence. An empty file appears in every folder the moment
  //    the manifest propagates -- the manifest is a base-room write and is never gated -- so
  //    `existsSync` is true even when the content write was refused, and the first version of
  //    this assertion passed for exactly that wrong reason.
  fs.writeFileSync(path.join(dirs.Ganesh, 'human.js'), 'export const h = 1\n')
  await sleep(4500)
  const gotHuman = (() => { try { return fs.readFileSync(path.join(dirs.AgentA, 'human.js'), 'utf8') } catch { return '' } })()
  T('everyone else keeps working while one agent is stopped', /h = 1/.test(gotHuman), JSON.stringify(gotHuman))

  // 7. And a paused participant can release themselves. On an open room the relay cannot verify
  //    who is a person, so pausing one DOES stop them -- which means the way out must never
  //    require a second person to be awake.
  boss.control('Ganesh', 'paused', 'Ganesh')
  await sleep(1500)
  T('a person can be paused too, on a relay that cannot verify who is human',
    (boss.doc.getMap('controls').get('Ganesh') || {}).state === 'paused')
  boss.control('Ganesh', 'running', 'Ganesh')
  await sleep(1500)
  T('and can release themselves without anyone else',
    (boss.doc.getMap('controls').get('Ganesh') || {}).state === 'running')

  // ---- persistence across relay restart (HIV-12) -----------------------------
  console.log('\n# relay restart: usage counters and caps survive (HIV-12)')
  const persistDir = path.join(tmp, 'persist')
  fs.mkdirSync(persistDir, { recursive: true })
  const P_PORT = PORT + 1
  const P_ROOM = 'gov-restart-' + process.pid

  let pRelay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(P_PORT), HIVE_PERSIST_DIR: persistDir, HIVE_GOVERNOR: 'on', HIVE_ENFORCE_CLAIMS: 'block' },
  })
  pRelay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('persist relay did not start')), 15000)
    pRelay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })
  await sleep(500)

  const pDirs = {
    boss: fs.mkdtempSync(path.join(tmp, 'p-boss')),
    agent: fs.mkdtempSync(path.join(tmp, 'p-agent')),
  }
  const pBoss = startSync({ relay: `ws://127.0.0.1:${P_PORT}`, room: P_ROOM, dir: pDirs.boss, name: 'Ganesh', kind: 'human', syncFiles: true, log: () => {} })
  const pAgent = startSync({ relay: `ws://127.0.0.1:${P_PORT}`, room: P_ROOM, dir: pDirs.agent, name: 'AgentP', kind: 'ai', syncFiles: true, log: () => {} })
  clients.push(pBoss, pAgent)
  await sleep(5000)

  // Wait for initial sync writes to settle and record baseline
  let baseWrites = 0
  for (let i = 0; i < 10; i++) {
    const u = pBoss.doc.getMap('usage').get('AgentP')
    if (u && u.writes > 0) {
      baseWrites = u.writes
      break
    }
    await sleep(500)
  }
  console.log('  [test] settled baseline writes =', baseWrites)

  // Agent writes file1
  fs.writeFileSync(path.join(pDirs.agent, 'file1.js'), 'export const f1 = 1\n')
  await sleep(4000)

  const usageBefore = pBoss.doc.getMap('usage').get('AgentP')
  T('pre-restart: usage is recorded in document', usageBefore && usageBefore.writes > 0, JSON.stringify(usageBefore))

  // Monotonicity test: AI attempts to tamper and lower its usage to zero
  pAgent.doc.getMap('usage').set('AgentP', { writes: 0, bytes: 0, tokens: 0 })
  await sleep(1500)
  const docReverted = pBoss.doc.getMap('usage').get('AgentP')
  T('monotonicity: lower doc usage rejected and reverted in doc', docReverted && docReverted.writes >= usageBefore.writes, JSON.stringify(docReverted))

  // Agent is still running (no budget set yet)
  T('pre-restart: agent is not paused yet', (pBoss.doc.getMap('controls').get('AgentP') || {}).state !== 'paused')

  // Kill the relay
  pBoss.stop(); pAgent.stop()
  pRelay.kill()
  await sleep(2000)

  // Restart relay with same persist dir
  pRelay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(P_PORT), HIVE_PERSIST_DIR: persistDir, HIVE_GOVERNOR: 'on', HIVE_ENFORCE_CLAIMS: 'block' },
  })
  pRelay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('restart relay did not start')), 15000)
    pRelay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })
  await sleep(1000)

  // Reconnect fresh clients
  const pBoss2 = startSync({ relay: `ws://127.0.0.1:${P_PORT}`, room: P_ROOM, dir: pDirs.boss, name: 'Ganesh', kind: 'human', syncFiles: true, log: () => {} })
  const pAgent2 = startSync({ relay: `ws://127.0.0.1:${P_PORT}`, room: P_ROOM, dir: pDirs.agent, name: 'AgentP', kind: 'ai', syncFiles: true, log: () => {} })
  clients.push(pBoss2, pAgent2)
  await sleep(2500)

  const usageAfter = pBoss2.doc.getMap('usage').get('AgentP')
  T('post-restart: usage counter SURVIVED relay restart', usageAfter && usageAfter.writes >= usageBefore.writes, JSON.stringify(usageAfter))

  // Set cap to current writes + 1, then write file2 to hit cap
  pBoss2.doc.getMap('budgets').set('AgentP', { writes: usageAfter.writes + 1 })
  await sleep(1000)

  fs.writeFileSync(path.join(pDirs.agent, 'file2.js'), 'export const f2 = 2\n')
  await sleep(4000)

  const controlAfter = pBoss2.doc.getMap('controls').get('AgentP') || {}
  T('post-restart: subsequent write hits cap and pauses agent', controlAfter.state === 'paused', JSON.stringify(controlAfter))

  try { pRelay.kill() } catch {}
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  try { relay && relay.kill() } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}


// -- snapshot() must report REAL minutes (HIV-13 follow-up) --------------------------
// Builder exposed governor.snapshot() on /usage for HIV-13, and on the way past changed
// the minutes divisor from /6000 then /10, to /60000 then /10. 6000 reads like a typo
// for 60000, but it is the one-decimal idiom: ms/6000 rounded, divided by 10, is
// minutes to one decimal place. The change made every reported figure TEN TIMES small.
//
// Enforcement was never affected -- check() computes minutes itself and was untouched,
// so caps kept firing on time. What broke is the number an OPERATOR READS, on /usage
// and in the control room: thirty minutes of agent runtime displayed as 3.0. For a
// product whose pitch is that you can leave the room and still be in control, the
// dashboard under-reporting how long an agent has been running is the defect that
// matters, even though nothing enforced on it.
//
// It survived 85 green assertions across three suites. Builder's own HIV-13 test
// PRINTED it while passing -- {"minutes":0,...} -- because the assertion was
// `used.writes > 0` and nothing ever looked at minutes. A value that is logged but
// never asserted is not covered; it is just visible.
{
  let clock = 1000000
  const g = makeGovernor({ now: () => clock })
  g.note('r', 'A', 10)                  // firstSeen is stamped on the first write
  clock += 30 * 60000                   // thirty minutes pass
  T('snapshot reports 30 minutes after 30 minutes, not 3',
    g.snapshot('r').A.used.minutes === 30, JSON.stringify(g.snapshot('r').A.used))
  clock += 6000                         // six seconds more
  T('and it keeps the one decimal place the idiom exists for',
    g.snapshot('r').A.used.minutes === 30.1, JSON.stringify(g.snapshot('r').A.used))
  T('the all-rooms form reports the same minutes as the single-room form',
    g.snapshot().r.A.used.minutes === g.snapshot('r').A.used.minutes)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
