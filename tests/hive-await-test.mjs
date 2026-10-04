// hivecode-await: the shipped background listener.
//
//   node tests/hive-await-test.mjs
//
// Every agent on a CLI stays reachable through this one process: it blocks on the room's chat and
// EXITS when the agent is addressed, which is what wakes the agent. So each way it can be wrong is an
// agent that believes it is listening and is not, or one woken for somebody else:
//   - a lookalike name (@Vega-2) must not wake Vega; @Vega and @all must
//   - the idle timeout must exit with reason idle, not hang
//   - a restarted listener must not re-deliver a mention it already delivered (the 420-loop livelock)
//   - while it waits, the room must see it as a LISTENER, so presence can say "listening", not "parked"
//   - it must actually ship: a bin entry, in "files", with a shebang
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

console.log('# it ships')
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  T('bin "hivecode-await" points at hive-await.js', (pkg.bin || {})['hivecode-await'] === 'hive-await.js', JSON.stringify(pkg.bin))
  T('hive-await.js is in "files"', (pkg.files || []).includes('hive-await.js'))
  T('it starts with a shebang', fs.readFileSync(path.join(ROOT, 'hive-await.js'), 'utf8').startsWith('#!/usr/bin/env node'))
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-await-'))
const room = 'aw-' + crypto.randomBytes(5).toString('hex')
const link = `ws://localhost:${PORT}|${room}`
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

// One listener process. Resolves with { code, out, running } -- `running` true if it had not exited by `ms`.
function listen(name, idleMin, ms, { lnk = link, env = { TEMP: tmp, TMPDIR: tmp }, cwd = ROOT } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'hive-await.js'), lnk, name, String(idleMin)],
    { cwd, env: { ...process.env, ...env } })
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const ready = new Promise((r) => { const t = setInterval(() => { if (/listening in/.test(err)) { clearInterval(t); r() } }, 100) })
  const done = new Promise((r) => child.on('exit', (code) => r(code)))
  return {
    ready,
    result: async () => {
      const code = await Promise.race([done, sleep(ms).then(() => 'running')])
      if (code === 'running') child.kill()
      let parsed = null; try { parsed = JSON.parse(out.trim().split('\n').pop()) } catch { }
      return { running: code === 'running', code, parsed }
    },
  }
}

let P
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  P = startSync({ relay: `ws://localhost:${PORT}`, room, dir: path.join(tmp, 'poster'), name: 'Ganesh', kind: 'human', syncFiles: false, log: () => {} })
  await sleep(2500)

  console.log('# who wakes it')
  {
    const L = listen('Vega', 1, 4000)
    await L.ready
    await sleep(500)
    const seen = [...P.provider.awareness.getStates().values()].map((s) => s && s.user).filter((u) => u && u.name === 'Vega')
    T('while waiting, the room sees Vega as a LISTENER', seen.some((u) => u.listener === true), JSON.stringify(seen))
    T('...and not as passive (passive = "never answers")', seen.every((u) => !u.passive))
    P.say('@Vega-2 can you check the build?')
    const r = await L.result()
    T('@Vega-2 does NOT wake Vega', r.running, r.parsed ? JSON.stringify(r.parsed).slice(0, 120) : '')
  }
  {
    const L = listen('Vega', 1, 8000)
    await L.ready
    P.say('@Vega please review sync.js')
    const r = await L.result()
    T('@Vega wakes Vega with reason "mention"', !r.running && r.parsed && r.parsed.reason === 'mention', JSON.stringify(r.parsed || {}).slice(0, 160))
    T('...carrying exactly that message', !!r.parsed && r.parsed.messages.length === 1 && /please review sync\.js/.test(r.parsed.messages[0]))
  }
  {
    const L = listen('Vega', 1, 3500)
    await L.ready
    const r = await L.result()
    T('a restarted listener does not re-deliver the mention it already delivered', r.running, r.parsed ? JSON.stringify(r.parsed).slice(0, 120) : '')
  }
  {
    const L = listen('Vega', 1, 8000)
    await L.ready
    P.say('@all standup in 5')
    const r = await L.result()
    T('@all wakes Vega', !r.running && r.parsed && r.parsed.reason === 'mention')
  }

  console.log('# idle')
  {
    const L = listen('Vega', 0.05, 12000) // 3 s
    const r = await L.result()
    T('nothing addressed to it: exits with reason "idle"', !r.running && r.parsed && r.parsed.reason === 'idle', JSON.stringify(r.parsed || {}))
  }

  console.log('# idle says what to do next')
  {
    const L = listen('Vega', 0.05, 12000)
    const r = await L.result()
    T('the idle exit tells the agent to run the same command again', !!r.parsed && /again/i.test(String(r.parsed.note || '')), JSON.stringify(r.parsed || {}))
    T('...and gives that exact command, not a description of it', !!r.parsed && String(r.parsed.note || '').includes('hive-await.js') && String(r.parsed.note || '').includes(link), JSON.stringify(r.parsed || {}))
  }

  // ── ARMED (4 Oct 2026) ─────────────────────────────────────────────────────────────────────
  // Agents joined, answered once, and went deaf: the order to listen was said once, at join, and an
  // agent had to remember it after every wake. Now the listener records that it is running, and the
  // Stop hook and the MCP server check that before a turn ends. A false "running" here is a deaf
  // agent that nobody knows is deaf, so the "no" cases matter as much as the "yes".
  const { isArmed, armedFile, awaitDir } = await import(`file:///${ROOT.replace(/\\/g, '/')}/hive-listen.js`)
  const env3 = { TEMP: tmp, TMPDIR: tmp }
  const room3 = 'aw-' + crypto.randomBytes(5).toString('hex')
  const link3 = `ws://localhost:${PORT}|${room3}`
  const P3 = startSync({ relay: `ws://localhost:${PORT}`, room: room3, dir: path.join(tmp, 'poster3'), name: 'Ganesh', kind: 'human', syncFiles: false, log: () => {} })
  await sleep(1500)

  console.log('# a running listener says so, and stops saying so when it ends')
  {
    const L = listen('Wren', 1, 15000, { lnk: link3, env: { ...env3, CLAUDE_CODE_SESSION_ID: 'sess-A' } })
    await L.ready
    await sleep(300)
    T('A1 while it waits, the agent is armed', isArmed({ name: 'Wren', room: room3 }, { env: env3 }))
    T('A2 ...for the session that started it', isArmed({ name: 'Wren', room: room3, session: 'sess-A' }, { env: env3 }))
    T('A3 ...and NOT for another session: its exit wakes the session that started it', !isArmed({ name: 'Wren', room: room3, session: 'sess-B' }, { env: env3 }))
    P3.say('@Wren ping one')
    const r = await L.result()
    const next = String((r.parsed && r.parsed.next) || '')
    T('A4 a wake carries the exact command to listen again, on the wake itself', !r.running && next.includes('hive-await.js') && next.includes(link3) && next.includes('"Wren"'), JSON.stringify(r.parsed || {}).slice(0, 300))
    T('A5 once it has exited, the agent is no longer armed', !isArmed({ name: 'Wren', room: room3 }, { env: env3 }) && !fs.existsSync(armedFile('Wren', room3, env3)))
  }

  console.log('# two listeners for one agent: the newest wins, so one message wakes it once')
  {
    const fast = { ...env3, HIVE_AWAIT_BEAT_MS: '300' }
    const L1 = listen('Wren', 1, 15000, { lnk: link3, env: fast })
    await L1.ready
    const L2 = listen('Wren', 1, 15000, { lnk: link3, env: fast })
    await L2.ready
    const r1 = await L1.result()
    T('N1 the older listener leaves, saying why', !r1.running && !!r1.parsed && r1.parsed.reason === 'superseded', JSON.stringify(r1.parsed || {}).slice(0, 200))
    T('N2 ...and the agent is still armed, by the newer one', isArmed({ name: 'Wren', room: room3 }, { env: env3 }))
    P3.say('@Wren ping two')
    const r2 = await L2.result()
    T('N3 the newer one is woken by the mention', !r2.running && !!r2.parsed && r2.parsed.reason === 'mention' && /ping two/.test(r2.parsed.messages.join(' ')), JSON.stringify(r2.parsed || {}).slice(0, 200))
  }

  console.log('# with TEMP and TMPDIR unset (most Linux), nothing lands in the folder it was started in')
  {
    T('L1 its folder is under the system temp folder', path.resolve(awaitDir('Wren', {})).startsWith(path.resolve(os.tmpdir())), awaitDir('Wren', {}))
    const started = fs.mkdtempSync(path.join(tmp, 'started-in-'))
    const L = listen('Lin', 0.05, 12000, { lnk: link3, env: { TEMP: '', TMPDIR: '' }, cwd: started })
    await L.result()
    T('L2 the listener wrote nothing into the folder it was started in', fs.readdirSync(started).length === 0, JSON.stringify(fs.readdirSync(started)))
  }
  try { P3.stop() } catch { }

  console.log('# an orphaned listener stops claiming to listen')
  // 2 Oct 2026: a listener outlives the agent that started it when the agent's app is closed. It
  // then keeps that agent marked as LISTENING, reachable, in every teammate's hive_members: the most
  // reassuring false state there is. It must notice its parent is gone and leave the room.
  // A room of its own: an earlier section left "@all standup" in the first room's history, and a
  // listener with no history of its own wakes on it at once (measured, the first time this ran).
  const room2 = 'aw-' + crypto.randomBytes(5).toString('hex')
  const link2 = `ws://localhost:${PORT}|${room2}`
  const P2 = startSync({ relay: `ws://localhost:${PORT}`, room: room2, dir: path.join(tmp, 'poster2'), name: 'Ganesh', kind: 'human', syncFiles: false, log: () => {} })
  await sleep(1500)
  const orphan = async (who, extraEnv, waitMs) => {
    const logPath = path.join(tmp, who + '.log')
    const script = `const { spawn } = require('child_process')
const logFd = require('fs').openSync(${JSON.stringify(logPath)}, 'a')
const c = spawn(process.execPath, ['hive-await.js', ${JSON.stringify(link2)}, ${JSON.stringify(who)}, '5'], { cwd: ${JSON.stringify(ROOT)},
  env: { ...process.env, TEMP: ${JSON.stringify(tmp)}, TMPDIR: ${JSON.stringify(tmp)}, HIVE_AWAIT_PARENT_CHECK_MS: '500', ...${JSON.stringify(extraEnv)} },
  stdio: ['ignore', logFd, logFd], detached: true, windowsHide: true })
console.log('PID ' + c.pid)
setInterval(() => {}, 1000)`
    // DETACHED, because that is what an orphan is. On Windows a non-detached child sits in its
    // parent's job object and dies with it (so a Claude Code background task cannot leave one
    // behind there); on macOS and Linux it is reparented and lives on. Detached reproduces the
    // second case on every OS. The child's stdio is NOT piped to the parent either. A pipe would break when the parent dies, and a
    // listener killed by that broken pipe would pass this test for the wrong reason (measured: it
    // did, on the old code). Readiness is read from the room instead, which is what is asserted.
    const parent = spawn(process.execPath, ['-e', script], { cwd: ROOT })
    const pid = await new Promise((res) => {
      let o = ''
      parent.stdout.on('data', (d) => { o += d; const m = /PID (\d+)/.exec(o); if (m) res(Number(m[1])) })
      setTimeout(() => res(0), 20000)
    })
    const alive = (p) => { try { process.kill(p, 0); return true } catch (e) { return e.code === 'EPERM' } }
    const listed = () => [...P2.provider.awareness.getStates().values()].some((s) => s && s.user && s.user.name === who && s.user.listener)
    for (let t = 0; t < 15000 && !listed(); t += 250) await sleep(250)
    const listedBefore = listed()
    parent.kill()
    let gone = false
    for (let t = 0; t < waitMs && !gone; t += 250) { await sleep(250); gone = !alive(pid) }
    await sleep(1500)
    const listedAfter = listed()
    if (pid && !gone) { try { process.kill(pid) } catch { } }
    let log = ''; try { log = fs.readFileSync(logPath, 'utf8').trim().slice(-300) } catch { }
    return { pid, listedBefore, gone, listedAfter, log }
  }
  {
    const o = await orphan('Orpha', {}, 10000)
    T('the room saw the listener while its parent lived', o.pid > 0 && o.listedBefore, JSON.stringify(o))
    T('when its parent dies, the listener exits within 10 s', o.gone, JSON.stringify(o))
    T('...and the room stops listing it as a listener', o.pid > 0 && !o.listedAfter, JSON.stringify(o))
  }
  {
    const o = await orphan('Orphb', { HIVE_AWAIT_KEEP_ALIVE: '1' }, 4000)
    T('HIVE_AWAIT_KEEP_ALIVE=1 keeps a deliberately detached listener running', o.pid > 0 && !o.gone, JSON.stringify(o))
  }
  try { P2.stop() } catch { }
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { P && P.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== HIVECODE-AWAIT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
