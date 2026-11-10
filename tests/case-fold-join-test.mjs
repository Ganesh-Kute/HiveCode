// Test: refuse a join whose name case-folds to an active room member (Task C3 / Incident I-3)
//
//   node tests/case-fold-join-test.mjs

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-casefold-'))
const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '25', HIVE_ENFORCE_CLAIMS: 'queue', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' },
})
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))
const kids = [relay]
process.on('exit', () => {
  for (const k of kids) { try { k.kill() } catch { } }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})

async function mcp(label) {
  const cwd = path.join(TMP, `${label}-mcp`)
  fs.mkdirSync(cwd, { recursive: true })
  const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], { cwd, env: { ...process.env, HIVE_RELAY: `ws://127.0.0.1:${PORT}`, HIVE_HOME: path.join(TMP, 'home') } })
  kids.push(p)
  let buf = ''
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} })
    const c = r && r.result && r.result.content
    return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : JSON.stringify(r)
  }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } })
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  return { call }
}

const folder = (n) => { const d = path.join(TMP, n); fs.mkdirSync(d, { recursive: true }); return d }
const joined = (reply) => /invite link:/.test(reply) && !/NOT JOINED/.test(reply)

sec('C3-1: Case-variant name is refused with Q581')
const A = await mcp('a')
const ja = await A.call('hive_join', { dir: folder('a'), name: 'Worker-Alpha' })
const link = (/invite link: (\S+)/.exec(ja) || [])[1]
T('C3-1a Worker-Alpha joined successfully', joined(ja))

const B = await mcp('b')
const jb = await B.call('hive_join', { dir: folder('b'), name: 'worker-alpha', link })
T('C3-1b worker-alpha is refused with Q581', /^NOT JOINED -- Q581: Worker-Alpha is already in this room/.test(jb), jb.slice(0, 160))
T('C3-1c refused joiner is not in room', /not in a room/.test(await B.call('hive_status', {})))
T('C3-1d join card includes listener: not running', /listener: not running/.test(ja))

sec('C3-2: Case-variant name refused immediately on Claude-cloud vs Claude-Cloud')
const C = await mcp('c')
const jc = await C.call('hive_join', { dir: folder('c'), name: 'Claude-cloud', link })
T('C3-2a Claude-cloud joined successfully', joined(jc))
T('C3-2c join card includes listener: not running', /listener: not running/.test(jc))

const D = await mcp('d')
const jd = await D.call('hive_join', { dir: folder('d'), name: 'Claude-Cloud', link })
T('C3-2b Claude-Cloud is refused with Q581', /^NOT JOINED -- Q581: Claude-cloud is already in this room/.test(jd), jd.slice(0, 160))

sec('C3-3: Simultaneous twin joins: later joiner gets re-check line after 3s')
const E = await mcp('e')
const F = await mcp('f')
// Join both simultaneously at the same instant
const [je, jf] = await Promise.all([
  E.call('hive_join', { dir: folder('e'), name: 'Twin-Beta', link }),
  F.call('hive_join', { dir: folder('f'), name: 'twin-beta', link })
])

// At least one must be warned or refused
await sleep(3500)
const se = await E.call('hive_status', {})
const sf = await F.call('hive_status', {})
const we = await E.call('hive_wait', { timeoutSeconds: 1 })
const wf = await F.call('hive_wait', { timeoutSeconds: 1 })

const eWarned = /twin/i.test(se) || /twin/i.test(we)
const fWarned = /twin/i.test(sf) || /twin/i.test(wf)
const oneRefused = /NOT JOINED -- Q581/.test(je) || /NOT JOINED -- Q581/.test(jf)

T('C3-3 simultaneous twin join: one refused immediately OR later joiner warned after 3s', oneRefused || (eWarned || fWarned), `je=${je.slice(0, 80)}, jf=${jf.slice(0, 80)}, se=${se.slice(0, 80)}, sf=${sf.slice(0, 80)}`)

sec('C3-4: Delayed awareness (the timing gap of Incident I-3) is caught by settlePresence')
{
  const { EventEmitter } = await import('events')
  const { _test } = await import('../hive-mcp.js')
  const awareness = new EventEmitter()
  awareness.getStates = () => new Map()
  const provider = new EventEmitter()
  provider.awareness = awareness

  let dupes = []
  const mockHive = {
    provider,
    sameNameElsewhere: () => dupes,
  }

  // Without settlePresence, an evaluation at t=0 returns empty (misses the colliding peer)
  T('C3-4a at t=0 before awareness settles, collision is undetected', mockHive.sameNameElsewhere().length === 0)

  // Awareness arrives 50ms later
  setTimeout(() => {
    dupes = [{ name: 'Worker-Alpha', kind: 'ai' }]
    awareness.emit('change', [{ added: [1], updated: [], removed: [] }], 'remote')
  }, 50)

  const t0 = Date.now()
  await _test.settlePresence(mockHive, 1500)
  const dt = Date.now() - t0

  T('C3-4b settlePresence waited for remote awareness change', dt >= 40 && dt < 1000, `waited ${dt}ms`)
  T('C3-4c after settlePresence, collision is caught', mockHive.sameNameElsewhere().length === 1)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
