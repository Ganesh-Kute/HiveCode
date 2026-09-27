// TOKEN COST OF THE AGENT-FACING SURFACE (27 Sep 2026).
//
//   node bench/token-cost.mjs            table
//   node bench/token-cost.mjs --json     machine-readable, for tests/token-budget-test.mjs
//
// Every character Hivecode hands an agent is paid for in its context, and most of it is paid
// again on every turn: the tool list and the server instructions ride along with every request,
// and a result stays in the transcript until the session ends. This drives the repo's hive-mcp.js
// over stdio -- exactly as an agent app does -- through the scenarios agents actually live in, on a
// local relay, and counts what each call returns. ~tokens is chars/4: rough, but the same ruler
// before and after a change, which is what a saving is measured with.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const JSON_OUT = process.argv.includes('--json')
const PORT = Number(process.env.HIVE_TEST_PORT) || (23000 + (process.pid % 17000))
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tok = (n) => Math.round(n / 4)
const rows = []
const DUMP = (process.argv.find((a) => a.startsWith('--dump=')) || '').slice(7)
const note = (scenario, call, text) => { rows.push({ scenario, call, chars: text.length, tokens: tok(text.length) }); if (DUMP && call.includes(DUMP)) console.error(`
===== ${call} =====
${text}`); return text }

const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
relay.stderr.on('data', () => { })
await new Promise((res, rej) => { relay.stdout.on('data', (d) => { if (/listening on/.test(d)) res() }); relay.on('exit', (c) => rej(new Error('relay exited ' + c))) })

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-tokcost-'))
function agent(name) {
  const home = path.join(base, `home-${name}`), dir = path.join(base, name)
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), HIVE_RELAY: RELAY }
  const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = '', id = 0
  const waiting = new Map()
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.id != null && !m.method && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
    }
  })
  p.stderr.on('data', () => { })
  const call = (method, params, ms = 90000) => new Promise((res, rej) => {
    const i = ++id
    waiting.set(i, res)
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
    setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); rej(new Error(`${name} ${method} timed out`)) } }, ms)
  })
  const tool = async (tname, args = {}) => {
    const r = await call('tools/call', { name: tname, arguments: args })
    if (r.error) return `ERROR ${JSON.stringify(r.error)}`
    return ((r.result && r.result.content) || []).map((c) => c.text || '').join('\n')
  }
  return { name, dir, p, call, tool, notify: (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: {} }) + '\n') }
}

const A = agent('Ada'), B = agent('Bo')
const init = async (a) => { const r = await a.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'token-cost', version: '1' } }); a.notify('notifications/initialized'); return r }

// --- every turn: what the agent app carries on each request
const initA = await init(A)
note('every turn', 'server instructions', String((initA.result && initA.result.instructions) || ''))
const tl = await A.call('tools/list', {})
note('every turn', 'tools/list (all schemas)', JSON.stringify((tl.result && tl.result.tools) || []))
const TOOLS = (tl.result && tl.result.tools) || []
for (const t of [...TOOLS].sort((x, y) => JSON.stringify(y).length - JSON.stringify(x).length).slice(0, 5)) note('every turn', `  schema: ${t.name}`, JSON.stringify(t))

// --- joining
fs.writeFileSync(path.join(A.dir, 'app.js'), 'export const a = 1\n')
const joinA = note('join', 'hive_join (host a room)', await A.tool('hive_join', { name: 'Ada', owner: 'Ganesh' }))
const link = (joinA.match(/invite link: (\S+)/) || [])[1]
if (!link) { console.error('no invite link in:\n' + joinA.slice(0, 400)); process.exit(1) }
await init(B)
note('join', 'hive_join (join by link)', await B.tool('hive_join', { link, name: 'Bo', owner: 'Ganesh' }))
note('join', 'hive_status', await A.tool('hive_status'))
note('join', 'hive_members', await A.tool('hive_members'))
await sleep(1500)

// --- a question and its answer between two agents
const Q = 'Can you take src/auth.js? I need the login handler split from the session code before I touch the routes, and tell me when it is released.'
note('ask/answer', 'hive_say (question, needsReply)', await A.tool('hive_say', { text: `@Bo ${Q}`, needsReply: true }))
await sleep(800)
note('ask/answer', 'hive_check (the one asked)', await B.tool('hive_check'))
note('ask/answer', 'hive_say (the answer)', await B.tool('hive_say', { text: '@Ada Yes, taking src/auth.js now. I will say when it is released.' }))
await sleep(800)
note('ask/answer', 'hive_check (the asker)', await A.tool('hive_check'))
note('ask/answer', 'hive_answered', await A.tool('hive_answered', { from: 'Bo' }))

// --- claiming a file around an edit
note('claim/release', 'hive_claim', await B.tool('hive_claim', { region: 'app.js', intent: 'split the login handler' }))
note('claim/release', 'hive_claims', await A.tool('hive_claims'))
note('claim/release', 'hive_release', await B.tool('hive_release', { region: 'app.js' }))

// --- idle: the loop an agent spends most of its life in
note('idle', 'hive_wait (nothing happens, 3s)', await A.tool('hive_wait', { timeoutSeconds: 3 }))
note('idle', 'hive_check (nothing new)', await A.tool('hive_check'))

// --- a busy room: thirty lines of other people's chatter
for (let i = 1; i <= 30; i++) await B.tool('hive_say', { text: `status ${i}: rebuilt the fixtures for suite ${i} and the snapshot diff is clean; moving on to the next one.` })
await sleep(1500)
note('busy room', 'hive_check (30 ambient lines)', await A.tool('hive_check'))
note('busy room', 'hive_read_chat (default)', await A.tool('hive_read_chat'))
note('busy room', 'hive_read_chat (unreadOnly)', await A.tool('hive_read_chat', { unreadOnly: true }))
note('busy room', 'hive_read_board', await A.tool('hive_read_board'))
note('busy room', 'hive_read_tasks', await A.tool('hive_read_tasks'))

for (const a of [A, B]) { try { a.p.stdin.end() } catch { } }
setTimeout(() => { for (const a of [A, B]) { try { a.p.kill() } catch { } } relay.kill(); try { fs.rmSync(base, { recursive: true, force: true }) } catch { } }, 800)

const perTurn = rows.filter((r) => r.scenario === 'every turn' && !r.call.startsWith('  ')).reduce((s, r) => s + r.tokens, 0)
const byScenario = {}
for (const r of rows) if (!r.call.startsWith('  ')) byScenario[r.scenario] = (byScenario[r.scenario] || 0) + r.tokens
if (JSON_OUT) {
  console.log(JSON.stringify({ rows, perTurn, byScenario }))
} else {
  let last = ''
  for (const r of rows) {
    if (r.scenario !== last) { console.log(`\n${r.scenario.toUpperCase()}`); last = r.scenario }
    console.log(`  ${r.call.padEnd(38)} ${String(r.chars).padStart(7)} chars  ~${String(r.tokens).padStart(6)} tok`)
  }
  console.log(`\ncarried on EVERY request: ~${perTurn} tok`)
  console.log('per scenario (results only): ' + Object.entries(byScenario).filter(([k]) => k !== 'every turn').map(([k, v]) => `${k} ~${v}`).join(', '))
}
setTimeout(() => process.exit(0), 1200)
