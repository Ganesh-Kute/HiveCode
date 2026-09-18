// Tests for /usage endpoint (HIV-13):
// - refuses without admin header (Q441 / Q442)
// - accepts with X-Hive-Admin header
// - includes per-room, per-participant governor snapshot: state, why, budget, used
//
//   node tests/usage-endpoint-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1297
const ROOM = 'usage-test-' + process.pid
const ADMIN_SECRET = 'secret-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const clients = []
let relay = null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-usage-t-'))

async function fetchUsage(urlPath, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${urlPath}`, { headers })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch {}
  return { status: res.status, data, text }
}

try {
  // 1. Boot relay with ADMIN_SECRET and GOVERNOR on
  relay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HIVE_ADMIN_SECRET: ADMIN_SECRET,
      HIVE_GOVERNOR: 'on',
      HIVE_PERSIST_DIR: 'off',
    },
  })
  relay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })

  // 2. Auth checks
  console.log('\n# admin authentication on /usage')
  const noAuth = await fetchUsage('/usage')
  T('/usage without header returns 403', noAuth.status === 403)
  T('/usage without header has Q441 error', noAuth.data && /Q441/.test(noAuth.data.error), JSON.stringify(noAuth.data))

  const badAuth = await fetchUsage('/usage', { 'X-Hive-Admin': 'wrong-secret' })
  T('/usage with wrong secret returns 403', badAuth.status === 403)
  T('/usage with wrong secret has Q441 error', badAuth.data && /Q441/.test(badAuth.data.error))

  const authedEmpty = await fetchUsage('/usage', { 'X-Hive-Admin': ADMIN_SECRET })
  T('/usage with valid secret returns 200', authedEmpty.status === 200)
  T('/usage returns governor field', authedEmpty.data && typeof authedEmpty.data.governor === 'object')

  // 3. Connect a human and an agent with budgets
  console.log('\n# governor snapshot in /usage')
  const bossDir = fs.mkdtempSync(path.join(tmp, 'boss'))
  const agentDir = fs.mkdtempSync(path.join(tmp, 'agent'))

  const boss = startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: bossDir,
    name: 'Ganesh', kind: 'human', syncFiles: true, log: () => {},
  })
  const agent = startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: agentDir,
    name: 'BuilderBot', kind: 'ai', syncFiles: true, log: () => {},
  })
  clients.push(boss, agent)
  await sleep(3000)

  // Set budget for BuilderBot
  boss.doc.getMap('budgets').set('BuilderBot', { writes: 5, minutes: 30 })
  await sleep(1000)

  // Agent makes a write
  fs.writeFileSync(path.join(agentDir, 'hello.js'), 'export const hello = "world"\n')
  await sleep(3000)

  // Query /usage
  const authed = await fetchUsage('/usage', { 'X-Hive-Admin': ADMIN_SECRET })
  T('/usage returns 200 with room data', authed.status === 200)
  const roomGov = authed.data?.governor?.[ROOM]
  T('governor snapshot contains room', !!roomGov, JSON.stringify(roomGov))

  const botSnapshot = roomGov?.['BuilderBot']
  T('participant snapshot exists', !!botSnapshot, JSON.stringify(botSnapshot))
  T('snapshot includes state', botSnapshot?.state === 'running' || botSnapshot?.state === 'paused')
  T('snapshot includes why', typeof botSnapshot?.why === 'string')
  T('snapshot includes budget with writes and minutes', botSnapshot?.budget?.writes === 5 && botSnapshot?.budget?.minutes === 30, JSON.stringify(botSnapshot?.budget))
  T('snapshot includes used with writes > 0', botSnapshot?.used?.writes > 0, JSON.stringify(botSnapshot?.used))

  // Query /usage?room=ROOM
  const filtered = await fetchUsage(`/usage?room=${ROOM}`, { 'X-Hive-Admin': ADMIN_SECRET })
  T('/usage?room=ROOM returns 200', filtered.status === 200)
  T('filtered governor has the target room', !!filtered.data?.governor?.[ROOM])

} catch (err) {
  T('suite executed without unhandled errors', false, err.message)
} finally {
  for (const c of clients) { try { c.stop() } catch {} }
  try { relay && relay.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
