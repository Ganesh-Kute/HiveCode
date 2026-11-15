// tests/stay-test.mjs -- hivecode-stay: an agent with no MCP engine stays listed between listeners.
//
// Board item 3 (docs/next-update-board.md). A cloud agent drives Hivecode from its shell: it is in
// the member list only while its listener (hive-await.js) runs, and every wake drops it. hive-stay.js
// is a presence-only keeper under the agent's name. It must keep the agent LISTED without making a
// deaf agent look reachable, and it must end on its own.
//
//   S1  listed while listening: one keeper and one listener under the name
//   S2  the listener exits on a mention: still listed, and the name is NOT a listener (PARKED)
//   S3  a new listener: listening again, and still exactly one keeper process
//   S4  no listener for the grace: the keeper leaves, and the name is gone
//   S5  a full engine with the same name joins: its join is not refused, and the keeper leaves
//   S6  a newer keeper for the same name and room: the older one leaves
//   S7  --detach returns in under 5 s, prints the pid, and the child is alive and listed
//   S8  members(): keeper only when every connection under the name is one; stateOf never WAITING
//       for a keeper alone
//
// A local relay; the grace and the engine window are shortened through HIVE_STAY_GRACE_MS and
// HIVE_STAY_ENGINE_MS.
import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = fn(); if (v) return v } catch { } await sleep(100) } try { return fn() } catch { return false } }
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
const { stateOf, WAITING, PARKED } = await import(pathToFileURL(path.join(ROOT, 'hive-activity.js')).href)
const port = await freePort()
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('relay start timeout')), 8000)
  relay.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve() } })
})
const URL_ = `ws://127.0.0.1:${port}`
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-stay-test-'))
const GRACE_MS = 4000, ENGINE_MS = 2000
const ENV = { ...process.env, TEMP: TMP, TMPDIR: TMP, HIVE_STAY_GRACE_MS: String(GRACE_MS), HIVE_STAY_ENGINE_MS: String(ENGINE_MS), HIVE_AWAIT_BEAT_MS: '1000', CLAUDE_CODE_SESSION_ID: '', ANTIGRAVITY_CONVERSATION_ID: '' }
const kids = [], live = []
const run = (args, extraEnv = {}) => {
  const p = spawn(process.execPath, args, { cwd: TMP, env: { ...ENV, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.out = ''; p.stdout.on('data', (d) => { p.out += d }); p.stderr.on('data', (d) => { p.out += d })
  p.exited = false; p.on('exit', (code) => { p.exited = true; p.code = code })
  kids.push(p); return p
}
const keeper = (room, name, more = []) => run([path.join(ROOT, 'hive-stay.js'), `${URL_}|${room}`, name, ...more])
const listener = (room, name) => run([path.join(ROOT, 'hive-await.js'), `${URL_}|${room}`, name, '30'])
const join = (room, name, opts = {}) => { const h = startSync({ relay: URL_, room, dir: fs.mkdtempSync(path.join(TMP, 'eng-')), name, kind: 'ai', syncFiles: false, log: () => { }, ...opts }); live.push(h); return h }
const conns = (h, name) => [...h.provider.awareness.getStates().values()].map((s) => s && s.user).filter((u) => u && u.name === name)
const keepersOf = (h, name) => conns(h, name).filter((u) => u.keeper).length
const listenersOf = (h, name) => conns(h, name).filter((u) => u.listener).length
const memberOf = (h, name) => h.members().find((m) => m.name === name)

try {
  // ---------------------------------------------------------------------------------------------
  console.log('\n# S1-S4  keeper and listener, one agent')
  {
    const room = 'room-stay-a', NAME = 'CloudA'
    const W = join(room, 'Watcher', { kind: 'human' })
    await until(() => W.provider.synced)
    const L1 = listener(room, NAME)
    const K = keeper(room, NAME)
    const s1 = await until(() => keepersOf(W, NAME) === 1 && listenersOf(W, NAME) === 1)
    T('S1 listed while listening: one keeper and one listener under the name', !!s1, JSON.stringify(conns(W, NAME)))
    T('S1b the keeper says it is present (the line older callers read)', !!(await until(() => /present in/.test(K.out), 5000)), K.out.slice(0, 200))
    const m1 = memberOf(W, NAME)
    T('S1c members(): a listener is up, so the name is a listener and not a keeper', !!(m1 && m1.listener && !m1.keeper), JSON.stringify(m1))

    W.say(`@${NAME} wake up`)
    await until(() => L1.exited, 10000)
    T('S2 setup: the listener exited on the mention', L1.exited)
    const s2 = await until(() => listenersOf(W, NAME) === 0 && keepersOf(W, NAME) === 1, 8000)
    const m2 = memberOf(W, NAME)
    T('S2 still listed after the listener exits, by the keeper alone', !!s2 && !!m2, JSON.stringify(conns(W, NAME)))
    T('S2b and NOT a listener: the room does not call a deaf agent reachable', !!(m2 && !m2.listener && !m2.passive && m2.keeper), JSON.stringify(m2))
    T('S2c stateOf for the keeper alone is PARKED, never WAITING', stateOf(null, { present: true, listener: !!(m2 && m2.listener), connections: conns(W, NAME) }) === PARKED)

    const L2 = listener(room, NAME)
    const s3 = await until(() => listenersOf(W, NAME) === 1, 8000)
    T('S3 a new listener: listening again', !!s3)
    await sleep(1500)
    T('S3b still exactly one keeper connection, and the first keeper process is the one', keepersOf(W, NAME) === 1 && !K.exited, `keepers=${keepersOf(W, NAME)} exited=${K.exited}`)
    T('S3c the keeper did not leave while a listener was armed for longer than the grace', !K.exited)

    try { L2.kill('SIGINT') } catch { }
    await until(() => L2.exited, 5000)
    const t0 = Date.now()
    await until(() => K.exited, GRACE_MS + 15000)
    T('S4 no listener for the grace: the keeper leaves on its own', K.exited, `after ${Date.now() - t0} ms; out=${K.out.slice(-200)}`)
    T('S4b it did not leave before the grace', Date.now() - t0 >= GRACE_MS - 500, `${Date.now() - t0} ms`)
    T('S4c and the name is gone from the room', !!(await until(() => conns(W, NAME).length === 0, 8000)), JSON.stringify(conns(W, NAME)))
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n# S5  a full engine with the same name')
  {
    const room = 'room-stay-b', NAME = 'CloudB'
    const W = join(room, 'Watcher', { kind: 'human' })
    await until(() => W.provider.synced)
    run([path.join(ROOT, 'hive-await.js'), `${URL_}|${room}`, NAME, '30'])
    const K = keeper(room, NAME)
    await until(() => keepersOf(W, NAME) === 1, 8000)
    const E = join(room, NAME)
    await until(() => E.provider.synced)
    await until(() => conns(E, NAME).some((u) => u.keeper), 5000)
    const dupes = E.sameNameElsewhere()
    T('S5 the engine\'s own join is not refused because of its own keeper', dupes.length === 0, JSON.stringify(dupes))
    const t0 = Date.now()
    await until(() => K.exited, ENGINE_MS + 10000)
    T('S5b the keeper leaves once the full engine has been present for the window', K.exited, `after ${Date.now() - t0} ms; out=${K.out.slice(-200)}`)
    T('S5c it says why', /engine/i.test(K.out), K.out.slice(-200))
    const mE = memberOf(W, NAME)
    T('S5d the name stays listed, by the engine, not as a keeper', !!(mE && !mE.keeper), JSON.stringify(mE))
    E.stop(); live.splice(live.indexOf(E), 1)
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n# S6  newest keeper wins')
  {
    const room = 'room-stay-c', NAME = 'CloudC'
    const W = join(room, 'Watcher', { kind: 'human' })
    await until(() => W.provider.synced)
    run([path.join(ROOT, 'hive-await.js'), `${URL_}|${room}`, NAME, '30'])
    const K1 = keeper(room, NAME)
    await until(() => keepersOf(W, NAME) === 1, 8000)
    await sleep(300)
    const K2 = keeper(room, NAME)
    await until(() => K1.exited, 10000)
    T('S6 the older keeper leaves when a newer one starts', K1.exited, K1.out.slice(-200))
    T('S6b the newer one stays', !K2.exited)
    await sleep(1500)
    T('S6c one keeper connection in the room', keepersOf(W, NAME) === 1, `keepers=${keepersOf(W, NAME)}`)
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n# S7  --detach')
  {
    const room = 'room-stay-d', NAME = 'CloudD'
    const W = join(room, 'Watcher', { kind: 'human' })
    await until(() => W.provider.synced)
    run([path.join(ROOT, 'hive-await.js'), `${URL_}|${room}`, NAME, '30'])
    const t0 = Date.now()
    const D = keeper(room, NAME, ['--detach'])
    await until(() => D.exited, 6000)
    const took = Date.now() - t0
    const pid = Number((D.out.match(/pid\D*(\d+)/i) || [])[1]) || 0
    T('S7 --detach returns in under 5 s', D.exited && took < 5000 && D.code === 0, `took=${took} code=${D.code} out=${D.out.trim().slice(0, 200)}`)
    T('S7b it prints the pid, and the child is alive', pid > 0 && alive(pid), `pid=${pid}`)
    T('S7c the detached keeper is listed', !!(await until(() => keepersOf(W, NAME) === 1, 8000)))
    if (pid) try { process.kill(pid, 'SIGTERM') } catch { }
    T('S7d SIGTERM ends it', !!(await until(() => !alive(pid), 5000)))
  }

  // ---------------------------------------------------------------------------------------------
  console.log('\n# S8  members() and stateOf, in-process')
  {
    const room = 'room-stay-e', NAME = 'CloudE'
    const W = join(room, 'Watcher', { kind: 'human' })
    await until(() => W.provider.synced)
    const K = join(room, NAME, { keeper: true })
    await until(() => keepersOf(W, NAME) === 1, 5000)
    const m = memberOf(W, NAME)
    T('S8 startSync({ keeper: true }) carries the tag, and is neither listener nor passive', !!(m && m.keeper && !m.listener && !m.passive), JSON.stringify(m))
    T('S8b stateOf for a keeper alone with no record is PARKED', stateOf(null, { present: true, listener: !!m.listener, passive: !!m.passive, connections: conns(W, NAME) }) === PARKED)
    const L = join(room, NAME, { listener: true })
    await until(() => listenersOf(W, NAME) === 1, 5000)
    const m2 = memberOf(W, NAME)
    T('S8c keeper + listener: members() says listener, not keeper', !!(m2 && m2.listener && !m2.keeper), JSON.stringify(m2))
    T('S8d stateOf with the listener up is WAITING', stateOf(null, { present: true, listener: !!m2.listener, connections: conns(W, NAME) }) === WAITING)
    K.stop(); L.stop()
  }
} finally {
  for (const h of live) try { h.stop() } catch { }
  for (const k of kids) try { if (!k.exited) k.kill('SIGKILL') } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}
console.log(`\n=== STAY: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
