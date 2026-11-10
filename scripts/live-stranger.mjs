// LIVE STRANGER TEST -- run it after every publish and deploy.
//
//   node scripts/live-stranger.mjs [files]            against the hosted relay
//   LIVE_RELAY=ws://localhost:4444 node scripts/...   against any relay, e.g. `npx hivecode-relay`
//
// What a new team member does, against the REAL npm registry and a REAL relay:
//  1. cold `npx -y hivecode-mcp@latest setup "<link>"` into a CLEAN profile (fresh npm cache, no
//     .npmrc, only Claude Code / Antigravity / Cursor "installed"), timed;
//  2. two participants launched EXACTLY as setup registered them (its Claude Code entry), each with
//     a home of its own, speaking MCP over stdio the way an agent app does;
//  3. A brings an N-file project, B joins empty: B must receive every file byte-exact, edits must
//     travel both ways, chat must arrive, and /health must show a socket per PARTICIPANT;
//  4. after they leave, the relay's channel count returns to where it was.
//
// Every profile lives under the OS temp dir: USERPROFILE, HOME, APPDATA and LOCALAPPDATA are all
// redirected, so the machine's real agent configs are never read or written.
// First run, 27 Sep 2026, production: 17/17, setup 8.4s from an empty cache, 151 files in 7.3s,
// 4 sockets for two people where one socket per file would have needed 304.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const R = path.join(os.tmpdir(), 'hivecode-live-stranger', `run-${process.pid}`)
const RELAY = (process.env.LIVE_RELAY || 'wss://livecode-xoss.onrender.com').replace(/\/+$/, '')
const HTTP = RELAY.replace(/^ws/, 'http')
const ROOM = `e2e-stranger-${process.pid.toString(36)}${(Date.now() % 1e6).toString(36)}`
const LINK = `${RELAY}|${ROOM}`
const N = Number(process.argv[2] || 150)
// LIVE_PKG=0.12.1 tests that exact published version; otherwise npx must fetch this repo's version
const EXPECT_VERSION = /^\d+\.\d+\.\d+$/.test(process.env.LIVE_PKG || '') ? process.env.LIVE_PKG : JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
const EXPECT_TOOLS = (fs.readFileSync(path.join(REPO, 'hive-mcp.js'), 'utf8').match(/\{ name: 'hive_[a-z_]+', description:/g) || []).length
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const T0 = Date.now()
const secs = (a) => ((Date.now() - a) / 1000).toFixed(1)
const results = []
const check = (ok, what, detail = '') => { results.push(ok); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '   [' + detail + ']' : ''}`) }
async function until(pred, ms, step = 400) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await pred()) return true } catch { } await sleep(step) } return false }
const health = async () => (await fetch(`${HTTP}/health`, { signal: AbortSignal.timeout(30000) })).json()
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()

function profile(name) {
  const home = path.join(R, name)
  // npm 10's npx lstat()s the global prefix (%APPDATA%\npm) and dies with ENOENT if it is missing
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'npm'), { recursive: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Local'), { recursive: true })
  return { home, env: { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), npm_config_userconfig: path.join(home, '.npmrc') } }
}

// ------------------------------------------------------------------ 1. setup
console.log(`relay ${RELAY}   room ${ROOM}\n\n1. setup: cold npm cache, clean profile`)
const A = profile('home-a')
fs.writeFileSync(path.join(A.home, '.claude.json'), '{}\n')                 // Claude Code, freshly installed
fs.mkdirSync(path.join(A.home, '.gemini', 'antigravity'), { recursive: true }) // Antigravity
fs.mkdirSync(path.join(A.home, '.cursor'), { recursive: true })                // Cursor
fs.mkdirSync(path.join(R, 'cwd'), { recursive: true })
const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js')
const tS = Date.now()
const setup = await new Promise((res) => {
  const p = spawn(process.execPath, [npxCli, '-y', `hivecode-mcp@${process.env.LIVE_PKG || 'latest'}`, 'setup', LINK, '--name', 'Stranger-AI'], {
    cwd: path.join(R, 'cwd'),
    env: { ...process.env, ...A.env, npm_config_cache: path.join(R, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
  })
  let out = ''
  p.stdout.on('data', (d) => { out += d }); p.stderr.on('data', (d) => { out += d })
  p.on('close', (code) => res({ code, out }))
})
const setupSecs = secs(tS)
console.log(setup.out.trim().split('\n').map((l) => '    | ' + l).join('\n'))
check(setup.code === 0, `setup finished in ${setupSecs}s, starting from an empty npm cache`, `exit ${setup.code}`)
const ver = (setup.out.match(/hivecode-mcp (\d+\.\d+\.\d+)/) || [])[1]
check(ver === EXPECT_VERSION, `npx fetched ${EXPECT_VERSION}, the version in this repo`, `got ${ver}`)
const readyCount = (setup.out.match(/ READY /g) || []).length
check(readyCount === 3 && !/FAILED/.test(setup.out), 'Claude Code, Antigravity and Cursor all READY, none FAILED', `READY x${readyCount}`)
check(/is up \(answered/.test(setup.out), 'setup reached the relay')
const cc = JSON.parse(fs.readFileSync(path.join(A.home, '.claude.json'), 'utf8'))
const key = Object.keys(cc.mcpServers || {}).find((k) => /hive/i.test(k))
const entry = key && cc.mcpServers[key]
if (!entry) { console.log('  FAIL no hivecode entry in the stranger .claude.json; keys:', Object.keys(cc)); process.exit(1) }
check(!/npx/i.test(`${entry.command} ${(entry.args || []).join(' ')}`), 'the Claude Code entry launches the installed runtime, not npx', `${path.basename(entry.command)} ${(entry.args || []).map((a) => path.basename(a)).join(' ')}`)
check(norm((entry.args || [])[0]).startsWith(norm(A.home)), 'the runtime was installed in the stranger profile, not the real one')

// ------------------------------------------------------------------ 2. participants
function mcp(label, env, cwd) {
  const p = spawn(entry.command, entry.args || [], { cwd, env: { ...process.env, ...(entry.env || {}), ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = '', id = 0, err = ''
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
  p.stderr.on('data', (d) => { err += d })
  const call = (method, params, ms = 90000) => new Promise((res, rej) => {
    const i = ++id
    waiting.set(i, res)
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
    setTimeout(() => { if (waiting.has(i)) { waiting.delete(i); rej(new Error(`${label} ${method} timed out`)) } }, ms)
  })
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const tool = async (name, args) => {
    const r = await call('tools/call', { name, arguments: args })
    if (r.error) return `ERROR ${JSON.stringify(r.error)}`
    return ((r.result && r.result.content) || []).map((c) => c.text || '').join('\n')
  }
  return { p, call, notify, tool, stderr: () => err }
}
const init = async (c) => { const r = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-stranger', version: '1' } }); c.notify('notifications/initialized', {}); return r }

console.log(`\n2. two participants, launched the way setup registered them; A brings ${N + 1} files`)
const dirA = path.join(R, 'a'), dirB = path.join(R, 'b')
fs.mkdirSync(path.join(dirA, 'src'), { recursive: true }); fs.mkdirSync(dirB, { recursive: true })
const fname = (i) => `src/f${String(i).padStart(3, '0')}.js`
const body = (i) => `// file ${i}\nexport const v${i} = ${i}\n`
for (let i = 1; i <= N; i++) fs.writeFileSync(path.join(dirA, fname(i)), body(i))
fs.writeFileSync(path.join(dirA, 'README.md'), '# e2e\n')
const want = N + 1

const h0 = await health()
console.log(`    relay before: connections=${h0.connections} channels=${h0.channels} rooms=${h0.rooms} mux=${h0.mux}`)
const a = mcp('A', A.env, dirA)
let t = Date.now()
await init(a)
check(Date.now() - t < 30000, `the server answered initialize in ${secs(t)}s (Claude Code gives up at 30s)`)
const tools = ((await a.call('tools/list', {})).result || {}).tools || []
check(tools.length === EXPECT_TOOLS, `tools/list returns ${tools.length} tools, as this repo defines`, `expected ${EXPECT_TOOLS}`)
t = Date.now()
const joinA = await a.tool('hive_join', { link: LINK, dir: dirA, name: 'Stranger-A' })
console.log(joinA.split('\n').slice(0, 4).map((l) => '    A| ' + l).join('\n'))
check(!/NOTHING WAS JOINED|ERROR|refused/i.test(joinA.split('\n').slice(0, 6).join(' ')), `A joined in ${secs(t)}s`)

const B = profile('home-b')
const b = mcp('B', B.env, dirB)
await init(b)
const tB = Date.now()
const joinB = await b.tool('hive_join', { link: LINK, dir: dirB, name: 'Stranger-B' })
console.log(joinB.split('\n').slice(0, 4).map((l) => '    B| ' + l).join('\n'))
check(!/NOTHING WAS JOINED|ERROR|refused/i.test(joinB.split('\n').slice(0, 6).join(' ')), `B joined in ${secs(tB)}s`)
const have = () => {
  let n = 0
  for (let i = 1; i <= N; i++) { try { if (fs.readFileSync(path.join(dirB, fname(i)), 'utf8') === body(i)) n++ } catch { } }
  try { if (fs.readFileSync(path.join(dirB, 'README.md'), 'utf8') === '# e2e\n') n++ } catch { }
  return n
}
const got = await until(() => have() === want, 240000, 500)
check(got, `B received all ${want} files byte-exact, ${secs(tB)}s after joining`, got ? '' : `${have()}/${want}`)

const h1 = await health()
console.log(`    relay with both in: connections=${h1.connections} channels=${h1.channels} rooms=${h1.rooms}`)
const dSock = h1.connections - h0.connections, dChan = (h1.channels || 0) - (h0.channels || 0)
check(dSock <= 4, `the two of them cost the relay ${dSock} sockets (one per participant: 4; one per file: ${2 * (want + 1)})`)
check(dChan >= 2 * want, `and ${dChan} channels on those sockets (${want} files each)`)

// ------------------------------------------------------------------ 3. edits and chat
t = Date.now()
fs.writeFileSync(path.join(dirB, fname(7)), '// edited by B\nexport const v7 = 700\n')
check(await until(() => fs.readFileSync(path.join(dirA, fname(7)), 'utf8').includes('edited by B'), 60000), `an edit B made on disk reached A's disk in ${secs(t)}s`)
t = Date.now()
fs.writeFileSync(path.join(dirA, 'README.md'), '# e2e\nedited by A\n')
check(await until(() => fs.readFileSync(path.join(dirB, 'README.md'), 'utf8').includes('edited by A'), 60000), `an edit A made on disk reached B's disk in ${secs(t)}s`)
const say = tools.find((x) => x.name === 'hive_say')
const sayKey = (say && say.inputSchema && (say.inputSchema.required || [])[0]) || 'text'
await a.tool('hive_say', { [sayKey]: '@Stranger-B ping from A' })
check(await until(async () => /ping from A/.test(await b.tool('hive_read_chat', {})), 30000, 1500), 'a chat message from A reached B')

// ------------------------------------------------------------------ 4. leave
await a.tool('hive_leave', {}).catch(() => { })
await b.tool('hive_leave', {}).catch(() => { })
a.p.stdin.end(); b.p.stdin.end()
let h2 = h1
const back = await until(async () => { h2 = await health(); return (h2.channels || 0) <= (h0.channels || 0) }, 30000, 2000)
check(back, `after they left, the relay is back to ${h2.channels} channels and ${h2.connections} connections (before: ${h0.channels}, ${h0.connections})`)

for (const [label, c] of [['A', a], ['B', b]]) {
  const lines = c.stderr().split('\n').filter((l) => /mux|socket per file|falling back|Q4\d\d|Q5\d\d/i.test(l)).slice(0, 6)
  if (lines.length) console.log(lines.map((l) => `    ${label} stderr| ${l.slice(0, 180)}`).join('\n'))
}
setTimeout(() => { try { a.p.kill() } catch { } try { b.p.kill() } catch { } }, 1500)
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed in ${secs(T0)}s   (files kept at ${R})`)
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 2000)
