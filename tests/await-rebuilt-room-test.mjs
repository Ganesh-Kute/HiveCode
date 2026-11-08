// tests/await-rebuilt-room-test.mjs -- a listener started after the relay lost the room still wakes.
//
// 7 Nov 2026, found by antigravity-2: every deploy on Render's free plan restarts the relay with no
// rooms, so chat starts again from zero. hive-await kept its cursor on disk ({"at": 300}) and
// scanned from message 300 of a 3-message chat: the agent showed LISTENING and no mention woke it
// until the idle timeout, which then moved the cursor past everything it had missed. The 0.14.0
// rollout itself (a relay deploy, then every agent re-arms) would have hit it.
//
//   node tests/await-rebuilt-room-test.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'
import { pathToFileURL, fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const free = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-rebuilt-'))
const procs = [], clients = []

async function startRelay(port) {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(p)
  await new Promise((r, j) => { const t = setTimeout(() => j(new Error('relay did not start')), 20000); p.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); r() } }) })
}
function peer(relay, room, name) {
  const dir = path.join(tmp, 'peer-' + name); fs.mkdirSync(dir, { recursive: true })
  const c = startSync({ relay, room, dir, name, kind: 'ai', syncFiles: false, log: () => { } }); clients.push(c); return c
}
// The cursor file exactly where hive-await keeps it: awaitDir(name) + .await-cursor-<room>.json
function plant(name, room, cursor) {
  const d = (tmp + '/hive-await-' + name); fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, `.await-cursor-${room}.json`), JSON.stringify(cursor))
}
function listen(link, name) {
  const child = spawn(process.execPath, ['hive-await.js', link, name, '2'], { cwd: ROOT, env: { ...process.env, TEMP: tmp, TMPDIR: tmp, HIVE_AWAIT_KEEP_ALIVE: '1' } })
  procs.push(child)
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  return {
    ready: async () => { const t0 = Date.now(); while (!/listening in/.test(err) && Date.now() - t0 < 20000) await sleep(100); return /listening in/.test(err) },
    // exit within ms, or null (still running: deaf, or correctly quiet)
    exit: async (ms) => {
      const code = await Promise.race([exited, sleep(ms).then(() => 'running')])
      if (code === 'running') return null
      let j = {}; try { j = JSON.parse(out.trim().split('\n').pop()) } catch { }
      return { code, ...j }
    },
    kill: () => { try { child.kill() } catch { } },
  }
}
const said = (r, text) => !!r && r.reason === 'mention' && (r.messages || []).some((m) => m.includes(text))

try {
  const PORT = await free()
  await startRelay(PORT)
  const relay = `ws://localhost:${PORT}`

  console.log('\n# W1. the cursor on disk points past the end of a chat that started again')
  const room1 = 'rebuilt-a-' + Date.now()
  const p1 = peer(relay, room1, 'Pat')
  await sleep(1500)
  p1.say('the rebuilt room says hello'); p1.say('second message')
  plant('Vee', room1, { at: 300 }) // counted in the room before the relay lost it
  const L1 = listen(`${relay}|${room1}`, 'Vee')
  const r1ready = await L1.ready()
  p1.say('@Vee wake up after the deploy')
  const r1 = await L1.exit(8000)
  L1.kill()
  ok('W1 a stale cursor (at 300, chat of 3): the listener still wakes on a new mention', r1ready && said(r1, 'wake up after the deploy'), r1 ? `exit ${r1.code} ${r1.reason}` : 'still running after 8 s: deaf')

  console.log('\n# W2. the rebuilt room has already grown past the old cursor')
  const room2 = 'rebuilt-b-' + Date.now()
  const p2 = peer(relay, room2, 'Quin')
  await sleep(1500)
  p2.say('@Wes are you there? (said before your listener started)'); p2.say('b'); p2.say('c')
  // Written by a listener in the room's previous life, where message 0 was something else.
  plant('Wes', room2, { at: 3, head: 'Old|09:00:00|the room before the deploy' })
  const L2 = listen(`${relay}|${room2}`, 'Wes')
  const r2ready = await L2.ready()
  const r2 = await L2.exit(6000)
  L2.kill()
  ok('W2 a cursor counted in the room\'s previous life is ignored: the mention at message 0 is delivered', r2ready && said(r2, 'are you there'), r2 ? `exit ${r2.code} ${r2.reason}` : 'still running after 6 s: skipped it')

  console.log('\n# W3. guard: in the SAME room, mail already delivered is never delivered again')
  const room3 = 'rebuilt-c-' + Date.now()
  const p3 = peer(relay, room3, 'Ros')
  await sleep(1500)
  p3.say('room three opens')
  const L3a = listen(`${relay}|${room3}`, 'Xan')
  await L3a.ready()
  p3.say('@Xan first mention')
  const r3a = await L3a.exit(8000)
  L3a.kill()
  await sleep(500)
  const L3b = listen(`${relay}|${room3}`, 'Xan')
  const r3bready = await L3b.ready()
  const quiet = await L3b.exit(3000) // must NOT wake again on "first mention"
  p3.say('@Xan second mention')
  const r3b = quiet || await L3b.exit(8000)
  L3b.kill()
  ok('W3 re-armed in the same room: quiet on the delivered mention, wakes on the next one only', said(r3a, 'first mention') && r3bready && quiet === null && said(r3b, 'second mention') && !said(r3b, 'first mention'), `first=${r3a && r3a.reason} quiet=${quiet === null} second=${r3b && (r3b.messages || []).join(' / ')}`)
} catch (e) {
  ok('no exception', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const c of clients) { try { c.stop() } catch { } }
  for (const p of procs) { try { p.kill() } catch { } }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
