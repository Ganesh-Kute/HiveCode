// Proves the reactivity model: an MCP agent calls hive_wait and BLOCKS; the
// moment its owner approves a task, hive_wait returns and the agent can work.
// No polling interval — it reacts as fast as the approval propagates (<1s).
//
//   node hive-wait-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startSync } from './sync.js'

const PORT = 1246
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'wait-test'
const DIR = path.resolve('.wait-test/agent')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

fs.rmSync(path.resolve('.wait-test'), { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

// Boss = the human owner, in the same room (drives assign + approve)
const boss = startSync({ relay: RELAY, room: ROOM, dir: '.wait-test/boss', name: 'Boss', kind: 'human', syncFiles: false, log: () => {} })

// MCP server hosting the agent
const mcp = spawn(process.execPath, ['hive-mcp.js'], { env: { ...process.env, HIVE_RELAY: RELAY } })
mcp.stderr.on('data', () => {})
let buf = ''; const pending = new Map(); let nextId = 1
mcp.stdout.on('data', (d) => {
  buf += d.toString(); let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
const notify = (method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
const callTool = async (name, args) => ((await rpc('tools/call', { name, arguments: args || {} })).result?.content || []).map((c) => c.text).join('\n')

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } })
notify('notifications/initialized')
await sleep(300)

// agent joins the SAME room as Boss, declaring Boss as its owner
await callTool('hive_join', { link: `${RELAY}|${ROOM}`, dir: DIR, name: 'WaitBot', owner: 'Boss' })
await sleep(800)

console.log('# Boss assigns work (pending), agent starts WAITING')
const id = boss.assign('WaitBot', 'build the parser module')
await sleep(500)
const waitStart = Date.now()
const waitPromise = callTool('hive_wait', { timeoutSeconds: 25 }) // BLOCKS here

console.log('# 1s later, Boss APPROVES — the wait should return right after')
await sleep(1000)
let resolvedEarly = false
Promise.race([waitPromise.then(() => { resolvedEarly = true }), sleep(50)])
await sleep(100)
assert('hive_wait is still blocking while task is only pending', !resolvedEarly)
boss.decide(id, true) // approve

const result = await waitPromise
const waited = Date.now() - waitStart
console.log(`\n   hive_wait returned after ${waited}ms:\n` + result.split('\n').map((l) => '      ' + l).join('\n'))
assert('hive_wait returned (did not time out)', !/nothing yet/.test(result))
assert('returned well before the 25s timeout (reacted to approval)', waited < 10000)

await sleep(300)
const tasksAfter = await callTool('hive_read_tasks', {})
assert('the task is now accepted for the agent', /accepted/.test(tasksAfter) && /build the parser/.test(tasksAfter))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
boss.stop(); mcp.kill(); relay.kill()
fs.rmSync(path.resolve('.wait-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
