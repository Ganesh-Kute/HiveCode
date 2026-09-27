// tests/setup-test.mjs -- `hivecode-mcp setup`, and the three defects that made setup take an hour.
//
// On 24 Sep 2026 a tester needed about an hour to get one agent into one room. Measured the next
// day on a cold machine, the relay was never the problem (hive_join: 0.5s). These were:
//   - the README's {"command":"npx"} cannot start on Windows: agent apps launch MCP servers with
//     no shell, and npx is npx.cmd -> `spawn npx ENOENT`;
//   - the first npx start took 36.7s, past Claude Code's 30s MCP start limit;
//   - on macOS and Linux npx starts the bin through a symlink, and hive-mcp.js compared argv[1]
//     to its own path without resolving it, so the server exited 0 before saying anything.
//
// Every assertion below is about what an agent app will actually meet: files read back from disk,
// entries LAUNCHED with no shell and made to answer an MCP handshake, folders that exist. None of
// them trusts what setup printed about itself -- that is how the last hour happened.
//
//   node tests/setup-test.mjs            A-D, about 15s
//   node tests/setup-test.mjs --package  also E: pack, install like npx, delete the install
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MCP = path.join(ROOT, 'hive-mcp.js')
const S = await import('../hive-setup.js')
const { VERSION } = await import('../hive-version.js')

let pass = 0, fail = 0
const T = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? '\n         ' + extra : ''}`) }
const section = (s) => console.log(`\n${s}`)
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const json = (p) => JSON.parse(rd(p))
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `hv-setup-${tag}-`))
const envFor = (home) => ({ ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config') })
const runSetup = (home, args = [], bin = [process.execPath, MCP]) => {
  const r = spawnSync(bin[0], [...bin.slice(1), 'setup', ...args], { cwd: home, env: envFor(home), encoding: 'utf8', timeout: 180000, windowsHide: true })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}
const lineFor = (out, label) => (out.split('\n').find((l) => l.trimStart().startsWith(label + ' ')) || '')
const desktopDir = (home) => process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming', 'Claude')
  : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude') : path.join(home, '.config', 'Claude')

// ---------------------------------------------------------------------------------------------
section('A. a machine with four agent apps, a stale config from the old README, and two traps')
const home = tmp('home')
const F = {
  claude: path.join(home, '.claude.json'),
  anti: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
  anti2: path.join(home, '.gemini', 'config', 'mcp_config.json'),
  cursor: path.join(home, '.cursor', 'mcp.json'),
  desktop: path.join(desktopDir(home), 'claude_desktop_config.json'),
}
const put = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s) }
const ORIG = {
  // `claude mcp add` without a scope writes under projects[<folder>]: this is what the old README
  // left behind, and it overrides a user-wide entry inside that folder.
  claude: JSON.stringify({ numStartups: 5, mcpServers: { other: { command: 'x', args: ['y'] } },
    projects: { 'C:/proj': { allowedTools: [], mcpServers: { hivecode: { type: 'stdio', command: 'npx', args: ['-y', 'hivecode-mcp@latest'], env: { HIVE_RELAY: 'wss://mine.example' } } } }, 'C:/other': { allowedTools: ['Bash'] } } }, null, 2),
  anti: JSON.stringify({ mcpServers: { other2: { command: 'z' }, hivecode: { command: 'npx', args: ['-y', 'hivecode-mcp'], env: { HIVE_TOKEN: 'keepme' } } } }, null, 2),
  anti2: JSON.stringify({ mcpServers: { memory: { command: 'm' } } }, null, 2),
  // JSON with comments and trailing commas, with a "//" inside a string that must survive.
  cursor: '{\n  // my servers\n  "mcpServers": {\n    "c1": { "command": "c", "args": ["http://x//y"] }, /* keep */\n  },\n}\n',
  desktop: '{ this is not json',
}
for (const k of Object.keys(ORIG)) put(F[k], ORIG[k])

const r1 = runSetup(home, ['--name', 'Tester'])
const node = S.stableNodePath()
T('A1 a config that cannot be parsed makes the exit code non-zero', r1.code === 1, `exit ${r1.code}\n${r1.out}`)
T('A2 ...and is reported FAILED, never READY', /FAILED/.test(lineFor(r1.out, 'Claude Desktop')) && !/READY/.test(lineFor(r1.out, 'Claude Desktop')), lineFor(r1.out, 'Claude Desktop'))
T('A3 ...and is left byte-for-byte as it was', rd(F.desktop) === ORIG.desktop)
for (const [label, f, key] of [['Claude Code', F.claude, 'other'], ['Antigravity', F.anti, 'other2'], ['Cursor', F.cursor, 'c1']]) {
  const c = json(f)
  const e = c.mcpServers.hivecode
  T(`A4 ${label}: READY, and the entry launches this node with the checkout's hive-mcp.js`, /READY/.test(lineFor(r1.out, label)) && e && e.command === node && e.args[0] === MCP, `${lineFor(r1.out, label)}\n         ${JSON.stringify(e)}`)
  T(`A5 ${label}: the other server "${key}" survived`, !!c.mcpServers[key])
}
T('A6 the user\'s env on the old entry survived the rewrite', json(F.anti).mcpServers.hivecode.env.HIVE_TOKEN === 'keepme')
T('A7 a JSON-with-comments file is parsed, not refused, and a "//" inside a string survives', json(F.cursor).mcpServers.c1.args[0] === 'http://x//y')
const proj = json(F.claude).projects['C:/proj'].mcpServers.hivecode
T('A8 Claude Code\'s per-folder entry from the old README is fixed too (it would otherwise win)', proj.command === node && proj.args[0] === MCP && proj.env.HIVE_RELAY === 'wss://mine.example', JSON.stringify(proj))
T('A9 keys setup has no business with are untouched', json(F.claude).numStartups === 5 && json(F.claude).projects['C:/other'].allowedTools[0] === 'Bash')
T('A10 each original is backed up before the first change', ['claude', 'anti', 'cursor'].every((k) => rd(F[k] + '.before-hivecode') === ORIG[k]))
T('A11 Antigravity\'s 2nd config has no hivecode entry, so it is not touched', rd(F.anti2) === ORIG.anti2)
T('A12 apps that are not installed get no config created', !fs.existsSync(path.join(home, '.codeium')) && !fs.existsSync(path.join(home, '.gemini', 'settings.json')))
T('A13 without a link, both sentences are printed: join one, or host one', /join the Hivecode room <the link you were sent> as Tester/.test(r1.out) && /host a new Hivecode room as Tester/.test(r1.out))

// second run: the broken file repaired by hand, everything else must be a no-op
const after1 = Object.fromEntries(['claude', 'anti', 'cursor'].map((k) => [k, rd(F[k])]))
put(F.desktop, '{}')
const r2 = runSetup(home, ['--name', 'Tester'])
T('A14 once nothing is broken, the exit code is 0', r2.code === 0, `exit ${r2.code}\n${r2.out}`)
T('A15 the repaired app is set up on the next run', /READY/.test(lineFor(r2.out, 'Claude Desktop')) && json(F.desktop).mcpServers.hivecode.command === node)
T('A16 a second run changes nothing it already did', ['claude', 'anti', 'cursor'].every((k) => rd(F[k]) === after1[k]) && /already set up/.test(lineFor(r2.out, 'Claude Code')))
T('A17 the backup is still the ORIGINAL, not the first run\'s output', ['claude', 'anti', 'cursor'].every((k) => rd(F[k] + '.before-hivecode') === ORIG[k]))

// a pasted link: retired relay followed, and the sentence carries it
const r3 = runSetup(home, ['wss://livecode-xoss.onrender.com|room-probe', '--name', 'Tester'])
T('A18 a link on the retired relay is moved to the current one in the sentence to paste', /join the Hivecode room wss:\/\/hivecode-relay\.onrender\.com\|room-probe as Tester/.test(r3.out), r3.out.split('\n').filter((l) => /hive_join|relay/.test(l)).join('\n         '))
// the pipe trap: an unquoted `setup wss://relay|room` reaches us as `setup wss://relay`
const r4 = runSetup(home, ['wss://hivecode-relay.onrender.com', '--name', 'Tester'])
T('A19 a link cut off at "|" (the unquoted-shell trap) is explained, not joined', /the part after \| was cut off/.test(r4.out))
// Antigravity1's stranger test: "Antigravity (2nd) not installed" read as a missing component.
const lone = tmp('lone')
put(path.join(lone, '.gemini', 'antigravity', 'mcp_config.json'), '{}')
const r5 = runSetup(lone, ['--name', 'Tester'])
T('A20 an app\'s second config path is never printed as an app that is "not installed"', r5.code === 0 && !/\(2nd\)/.test(r5.out) && /READY/.test(lineFor(r5.out, 'Antigravity')), r5.out)
// The paste-by-hand entry is all a user of any other MCP app gets. Parse it the way a person
// would -- the brace-balanced block -- and then LAUNCH it: a snippet that parses but does not
// start is the old README all over again.
const bare = tmp('bare')
const r6 = runSetup(bare, ['--name', 'Tester'])
let snippet = null
{
  const lines = r6.out.split('\n'), i = lines.findIndex((l) => l.trim() === '{')
  if (i >= 0) { let d = 0, buf = []; for (const l of lines.slice(i)) { buf.push(l); d += (l.match(/{/g) || []).length - (l.match(/}/g) || []).length; if (d === 0) break } try { snippet = JSON.parse(buf.join('\n')) } catch {} }
}
const se = snippet && snippet.mcpServers && snippet.mcpServers.hivecode
T('A21 with no known app, the printed entry is valid JSON with absolute paths', !!se && path.isAbsolute(se.command) && path.isAbsolute(se.args[0]), r6.out)
const v6 = se ? await S.verifyEntry(se) : { ok: false }
T('A22 ...and that printed entry, launched as written, answers', v6.ok, JSON.stringify(v6))

// ---------------------------------------------------------------------------------------------
section('B. verification cannot be fooled -- each of these must FAIL')
const scratch = tmp('verify')
if (process.platform === 'win32') {
  const v = await S.verifyEntry({ command: 'npx', args: ['-y', 'hivecode-mcp@latest'] }, { timeoutMs: 8000 })
  T('B1 the OLD README entry {"command":"npx"} fails on Windows, as it did for real', !v.ok && /ENOENT/.test(v.error), JSON.stringify(v))
} else {
  const v = await S.verifyEntry({ command: 'hivecode-no-such-command', args: [] }, { timeoutMs: 8000 })
  T('B1 a command that does not exist fails with ENOENT', !v.ok && /ENOENT/.test(v.error), JSON.stringify(v))
}
let v = await S.verifyEntry({ command: process.execPath, args: [path.join(scratch, 'missing.js')] }, { timeoutMs: 8000 })
T('B2 a path to nothing fails', !v.ok, JSON.stringify(v))
const impostor = path.join(scratch, 'impostor.js')
fs.writeFileSync(impostor, `process.stdin.on('data',()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{serverInfo:{name:'someone-else',version:'1'}}})+'\\n')})`)
v = await S.verifyEntry({ command: process.execPath, args: [impostor] }, { timeoutMs: 8000 })
T('B3 a server that answers but is not hivecode fails', !v.ok && /not the hivecode server/.test(v.error), JSON.stringify(v))
const mute = path.join(scratch, 'mute.js')
fs.writeFileSync(mute, 'setInterval(()=>{},1000)')
v = await S.verifyEntry({ command: process.execPath, args: [mute] }, { timeoutMs: 1500 })
T('B4 a server that never answers fails on the timeout', !v.ok && /no answer/.test(v.error), JSON.stringify(v))
v = await S.verifyEntry({ command: process.execPath, args: [MCP] })
T('B5 the real server passes, reporting this build\'s version', v.ok && v.version === VERSION, JSON.stringify(v))
const strayFile = path.join(scratch, 'claude.json')
fs.writeFileSync(strayFile, JSON.stringify({ mcpServers: { hivecode: { command: node, args: [MCP] } }, projects: { 'C:/p': { mcpServers: { hivecode: { command: 'npx', args: [] } } } } }))
T('B6 a per-folder entry that still launches something else is caught', S.strayEntry(strayFile, { command: node, args: [MCP] }) === 'C:/p')

// ---------------------------------------------------------------------------------------------
section('C. started through a link, the way npx starts it on macOS and Linux')
const link = path.join(tmp('link'), 'pkg')
fs.symlinkSync(ROOT, link, 'junction') // a junction on Windows (no admin needed), a dir symlink elsewhere
v = await S.verifyEntry({ command: process.execPath, args: [path.join(link, 'hive-mcp.js')] })
T('C1 hive-mcp.js answers when argv[1] is a linked path (it used to exit 0, silently)', v.ok, JSON.stringify(v))

// ---------------------------------------------------------------------------------------------
section('D. where an agent\'s files go when nobody names a folder')
const dHome = tmp('hivehome')
const dCwd = tmp('cwd')
process.env.HIVE_HOME = dHome
process.chdir(dCwd) // the session file and the legacy ./workspace are both relative to cwd
const M = await import('../hive-mcp.js')
const D = M._test.defaultJoinTarget
const a = D('ws://h|room-abc', 'Ann')
T('D1 a link and a name give ~/hivecode/<room>/<name>', path.resolve(a.dir) === path.join(dHome, 'room-abc', 'Ann') && !a.hostedHere, JSON.stringify(a))
T('D2 two names in one room never share a folder', D('ws://h|room-abc', 'Bob').dir !== a.dir)
const h = D('', 'Ann')
T('D3 no link hosts a new room, in a folder named after it', h.hostedHere && h.link.endsWith('|' + path.basename(path.dirname(h.dir))) && path.dirname(path.dirname(h.dir)) === dHome, JSON.stringify(h))
T('D4 a hostile room id cannot climb out of ~/hivecode', !path.relative(dHome, D('ws://h|../../etc', 'x').dir).startsWith('..'))
T('D5 a reserved Windows device name is not used as a folder', path.basename(D('ws://h|room-abc', 'con').dir) === '_con')
fs.mkdirSync(path.join(dCwd, 'workspace'))
fs.writeFileSync(path.join(dCwd, 'workspace', '.hive.json'), JSON.stringify({ relay: 'ws://h', room: 'room-old' }))
const legacy = D('', 'Ann')
T('D6 a returning agent whose room is in ./workspace/.hive.json still gets THAT room back', legacy.dir === './workspace' && !legacy.hostedHere, JSON.stringify(legacy))

// and for real: a relay, a join with no dir, and the folder on disk
const PORT = 23000 + (process.pid % 9000)
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true })
const up = await new Promise((res) => {
  const t0 = Date.now()
  const tick = () => http.get(`http://localhost:${PORT}/health`, (r) => { r.resume(); res(true) }).on('error', () => Date.now() - t0 > 15000 ? res(false) : setTimeout(tick, 200))
  tick()
})
T('D7 (setup) a local relay came up', up)
if (up) {
  const out = await M._test.callTool('hive_join', { link: `ws://localhost:${PORT}|room-nodir`, name: 'Solo' })
  const text = (out.content || []).map((c) => c.text).join('\n')
  T('D8 hive_join with no dir writes the room into ~/hivecode/<room>/<name>', fs.existsSync(path.join(dHome, 'room-nodir', 'Solo', '.hive.json')), text.split('\n').slice(0, 4).join(' | '))
  T('D9 ...and not into ./workspace under whatever directory the server started in', !fs.existsSync(path.join(dCwd, 'workspace', 'Solo')) && json(path.join(dCwd, 'workspace', '.hive.json')).room === 'room-old')
  // The rejoin cases, read while the session record exists -- as it does after a disconnect or a
  // restart. hive_leave deletes it, which is what makes a later bare hive_join host a new room.
  const soloDir = path.join(dHome, 'room-nodir', 'Solo')
  T('D10 no link, no folder, after a disconnect: back to MY room, not a new empty one', path.resolve(D('', 'Solo').dir) === soloDir && !D('', 'Solo').hostedHere, JSON.stringify(D('', 'Solo')))
  T('D11 the same link again lands in the folder it already used', path.resolve(D(`ws://localhost:${PORT}|room-nodir`, 'Solo').dir) === soloDir)
  T('D12 another name in that room still gets a folder of its own', path.resolve(D(`ws://localhost:${PORT}|room-nodir`, 'Other').dir) === path.join(dHome, 'room-nodir', 'Other'))
  try { await M._test.callTool('hive_leave', {}) } catch {}
}
relay.kill()
process.chdir(ROOT)

// ---------------------------------------------------------------------------------------------
if (process.argv.includes('--package')) {
  section('E. the npx path: packed, installed like npx, then the install deleted')
  const P = tmp('pkg')
  const sh = (cmd) => spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 300000 })
  const packed = sh(`npm pack --silent --pack-destination "${P}"`)
  const tgz = path.join(P, (packed.stdout || '').trim().split('\n').pop())
  T('E1 (setup) the package packs', packed.status === 0 && fs.existsSync(tgz), packed.stderr)
  const inst = path.join(P, 'inst')
  const ins = spawnSync(`npm install --prefix "${inst}" "${tgz}" --no-audit --no-fund --loglevel=error`, { shell: true, encoding: 'utf8', timeout: 300000 })
  T('E2 (setup) it installs', ins.status === 0, ins.stderr)
  const pHome = tmp('pkghome')
  put(path.join(pHome, '.gemini', 'antigravity', 'mcp_config.json'), '{}')
  const binDir = path.join(inst, 'node_modules', '.bin')
  // Through npm's own bin: a .cmd shim on Windows, a SYMLINK elsewhere -- the launch that exited 0.
  const bin = process.platform === 'win32' ? ['cmd', '/c', path.join(binDir, 'hivecode-mcp.cmd')] : [path.join(binDir, 'hivecode-mcp')]
  const rp = runSetup(pHome, ['--name', 'Pkg'], bin)
  const runtimeJs = path.join(pHome, '.hivecode', 'runtime', VERSION, 'node_modules', 'hivecode-mcp', 'hive-mcp.js')
  T('E3 setup through the installed bin exits 0', rp.code === 0, rp.out)
  T('E4 the runtime is copied under ~/.hivecode/runtime/<version>', fs.existsSync(runtimeJs))
  const pe = S.readEntry(path.join(pHome, '.gemini', 'antigravity', 'mcp_config.json'))
  T('E5 the config points at the copy, not at the install it came from', pe && pe.args[0] === runtimeJs, JSON.stringify(pe))
  fs.rmSync(inst, { recursive: true, force: true }) // what npm does to the npx cache, eventually
  v = await S.verifyEntry(pe)
  T('E6 with the install GONE, the configured entry still starts and answers', v.ok && v.version === VERSION, JSON.stringify(v))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
