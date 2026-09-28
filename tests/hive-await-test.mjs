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
function listen(name, idleMin, ms) {
  const child = spawn(process.execPath, ['hive-await.js', link, name, String(idleMin)],
    { cwd: ROOT, env: { ...process.env, TEMP: tmp, TMPDIR: tmp } })
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
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { P && P.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== HIVECODE-AWAIT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
