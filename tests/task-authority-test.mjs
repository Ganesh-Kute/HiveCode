// TASK AUTHORITY: who may finish a task, and who may decide one.
//
//   node tests/task-authority-test.mjs
//
// The asymmetric gate is what we sell: a human who does not own an agent cannot make it act, and an
// agent's work is not "done" because somebody said so. Before 29 Sep 2026 three holes let that
// happen with every signal green:
//   - complete() let ANY participant mark ANY task done -- even one still waiting for its owner,
//     or one the owner DENIED. The room was told "done" about work the owner refused.
//   - decide() accepted any task, so approving a finished task reset it to 'accepted' and handed
//     done work back to the agent to do again.
//   - the browser control panel showed Approve / Deny to EVERY human, owner or not.
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
async function until(pred, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(150) } return pred() }

console.log('# the human clients carry the same rules (static)')
{
  const panel = fs.readFileSync(path.join(ROOT, 'public', 'control.html'), 'utf8')
  const actsLine = panel.split('\n').find((l) => /const acts=s==='pending'/.test(l)) || ''
  T('the panel shows Approve/Deny only to the target agent\'s owner', /!own\|\|own===me/.test(actsLine) && /waiting for/.test(actsLine))
  const click = panel.split('\n').find((l) => /if\(b\.dataset\.tact\)/.test(l)) || ''
  T('...and its click handler re-checks owner and status', /own===me/.test(click) && /t\.status==='pending'\|\|t\.status==='denied'/.test(click))
  const ext = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8')
  T('the VS Code extension refuses to decide a task that is not waiting', /t\.status !== 'pending' && t\.status !== 'denied'/.test(ext))
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-tasks-'))
const room = 'ta-' + crypto.randomBytes(5).toString('hex')
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
const clients = []
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  const join = (name, kind, owner = '') => {
    const c = startSync({ relay: `ws://localhost:${PORT}`, room, dir: path.join(tmp, name), name, kind, owner, syncFiles: false, log: () => {} })
    clients.push(c); return c
  }
  const ganesh = join('Ganesh', 'human'), bot = join('Bot', 'ai', 'Ganesh'), eve = join('Eve', 'ai'), mallory = join('Mallory', 'human')
  await sleep(3000)
  const status = (c, id) => (c.doc.getMap('tasks').get(id) || {}).status

  console.log('# a task from a human who does not own the agent')
  const id = mallory.assign('Bot', 'rewrite the billing module')
  T('it lands PENDING', await until(() => status(bot, id) === 'pending'), status(bot, id))
  let r = eve.complete(id, 'done it for you')
  T('another agent cannot complete it', !!r.error && status(bot, id) === 'pending', r.error)
  r = bot.complete(id, 'did it anyway')
  T('the agent itself cannot complete work its owner has not approved', !!r.error && /waiting for Ganesh/.test(r.error) && status(bot, id) === 'pending', r.error)
  r = mallory.decide(id, true)
  T('a human who is not the owner cannot approve it', !!r.error && status(bot, id) === 'pending', r.error)

  console.log('# the owner decides')
  r = ganesh.decide(id, false)
  T('the owner denies it', r.ok && await until(() => status(bot, id) === 'denied'))
  r = bot.complete(id)
  T('a DENIED task cannot be completed', !!r.error && status(bot, id) === 'denied', r.error)
  r = ganesh.decide(id, true)
  T('the owner may change their mind: denied -> accepted', r.ok && await until(() => status(bot, id) === 'accepted'))
  await until(() => status(eve, id) === 'accepted')
  r = eve.complete(id)
  T('still only the assignee can complete it', !!r.error && status(bot, id) === 'accepted', r.error)
  r = bot.complete(id, 'billing rewritten')
  T('the assignee completes accepted work', r.ok && !r.already && await until(() => status(ganesh, id) === 'done'))
  r = bot.complete(id)
  T('completing it twice is idempotent', r.ok && r.already && status(bot, id) === 'done')
  await until(() => status(ganesh, id) === 'done')
  r = ganesh.decide(id, true)
  T('approving a DONE task is refused -- it does not hand the work back', !!r.error && status(ganesh, id) === 'done', r.error)
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const c of clients) { try { c.stop() } catch { } }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n=== TASK AUTHORITY: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
