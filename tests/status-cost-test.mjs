// THE TOOLS AN AGENT CALLS ALL DAY DO NOT STAT THE ROOM (27 Sep 2026).
//
// hive_say, hive_check, hive_wait and hive_delivered each asked status() whether the socket was up.
// status() also counts filesHeld -- one existsSync per file in the room -- so every one of those
// calls did a synchronous stat of every file: 292 ms a call in a 1,000-file room on the dev machine,
// with the event loop blocked the whole time, for a boolean. They now ask connection(). hive_status
// still reports the counts; that is the call that is FOR them.
//
// Pinned by counting status() calls on the live session, not by timing, so it holds on any machine.
//   node tests/status-cost-test.mjs
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'

const PORT = Number(process.env.HIVE_TEST_PORT) || (21000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-statuscost-'))
process.chdir(sandbox)
const { _test } = await import('../hive-mcp.js')
const room = 'stcost-' + crypto.randomBytes(6).toString('hex')
const dir = path.join(sandbox, 'work'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, 'src', `f${i}.js`), `export const v${i} = ${i}\n`)

console.log('\n=== THE TOOLS AN AGENT CALLS ALL DAY DO NOT STAT THE ROOM ===')
await _test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir, name: 'Probe', owner: 'test' })
await sleep(2000)

const hive = _test.getSession().hive
T('the engine offers connection() alongside status()', typeof hive.connection === 'function')
const c = hive.connection(), s = hive.status()
T('...and it agrees with status() on the two fields it carries', c.connected === s.connected && c.connecting === s.connecting, JSON.stringify(c))

let statusCalls = 0
const realStatus = hive.status
hive.status = function (...a) { statusCalls++; return realStatus.apply(this, a) }
await _test.callTool('hive_say', { text: 'taking src/f1.js' })
await _test.callTool('hive_check', {})
await _test.callTool('hive_wait', { timeoutSeconds: 1 })
await _test.callTool('hive_delivered', {})
T('hive_say, hive_check, hive_wait and hive_delivered never call status()', statusCalls === 0, `${statusCalls} calls`)
await _test.callTool('hive_status', {})
T('hive_status still does (the counter is live, so the zero above means something)', statusCalls >= 1, `${statusCalls} calls`)
hive.status = realStatus

try { _test.getSession().hive.stop() } catch { }
relay.kill()
console.log(`\n=== STATUS COST: ${pass} passed, ${fail} failed ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 300)
