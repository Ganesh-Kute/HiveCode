// hive-setup.js -- `npx -y hivecode-mcp@latest setup ["<join link>"] [--name You-AI]`
//
// ONE COMMAND FROM NOTHING TO AN AGENT THAT CAN JOIN. It exists because setup cost a real
// tester an hour on 24 Sep 2026, and when it was measured the next day on a cold machine the
// hour had concrete causes, none of them in the relay (hive_join itself took 0.5s):
//
//   1. The README's config was {"command":"npx", ...}. Agent apps start MCP servers WITHOUT a
//      shell, and on Windows npx is npx.cmd, so the launch fails with `spawn npx ENOENT` -- the
//      agent just never gets the hive_* tools, and nothing on screen says why.
//   2. The first `npx hivecode-mcp@latest` start took 36.7s, downloading. Claude Code gives an
//      MCP server 30s, so a new user's FIRST launch fails, and the second one may not.
//   3. hive_join's default folder was './workspace', relative to whatever directory the agent
//      app happened to start the server in -- sometimes the user's project, sometimes a
//      directory nobody can write to.
//
// So this does the four things a person was doing by hand, and then CHECKS them:
//   - installs a runtime copy under ~/.hivecode/runtime/<version>, so launching needs no
//     download, no network and no npx;
//   - writes the hivecode entry into every agent config it finds, with the absolute path of
//     THIS node, which also dodges GUI apps on macOS not seeing an nvm PATH;
//   - launches each entry exactly the way the agent app will -- read back from the file, no
//     shell -- and does a real MCP handshake with it;
//   - prints the one sentence to paste into the agent.
//
// THE FAILURE THIS MUST NEVER HAVE is the one every defect in this repo has had: reporting
// success while the result is wrong. An agent whose config could not be written, or whose entry
// does not start, is printed as FAILED and makes the exit code non-zero. "Configured" is only
// ever printed about an entry that was read back from disk and answered a handshake.
//
// WHAT IT COSTS WHEN WRONG: these are the user's own config files, holding their other MCP
// servers. So a file is parsed or refused (JSON with comments is refused, not rewritten), the
// original is backed up once before the first change, only the `hivecode` key is touched, and
// every other key survives byte-for-byte as a value.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { VERSION } from './hive-version.js'
import { currentRelayFor, controlUrl, PUBLIC_DEFAULT_RELAY } from './hive-privacy.js'
import { validateMemberName } from './hive-mailbox.js'

export const SERVER_KEY = 'hivecode'
const BACKUP_SUFFIX = '.before-hivecode'

/** Every agent app we know how to configure, and where each keeps its MCP servers. */
export function agentTargets(home = os.homedir(), env = process.env, platform = process.platform) {
  const claudeDesktopDir = platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude')
    : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude')
  // `present` is how we decide the app is installed. It is deliberately the app's OWN directory
  // (or, where the app creates it on first run, its own file) -- never "the file we would write",
  // which would make every run create configs for apps the user does not have.
  return [
    { id: 'claude-code', label: 'Claude Code', file: path.join(home, '.claude.json'), present: path.join(home, '.claude.json'), claudeCode: true,
      restart: 'start a new Claude Code session (or restart `claude`)' },
    { id: 'antigravity', label: 'Antigravity', file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), present: path.join(home, '.gemini', 'antigravity'),
      restart: 'Settings > Skills & Customizations > MCP Servers, then click refresh on hivecode (or restart Antigravity)' },
    // Antigravity also reads this one. It is only touched when it ALREADY has a hivecode entry --
    // a stale one there could shadow the fresh one above -- and never created.
    { id: 'antigravity-2', label: 'Antigravity (2nd)', file: path.join(home, '.gemini', 'config', 'mcp_config.json'), present: path.join(home, '.gemini', 'config', 'mcp_config.json'),
      onlyIfHasEntry: true, secondaryOf: 'antigravity', restart: 'same refresh as above' },
    { id: 'cursor', label: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'), present: path.join(home, '.cursor'),
      restart: 'Cursor Settings > MCP, then turn hivecode off and on (or restart Cursor)' },
    { id: 'windsurf', label: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), present: path.join(home, '.codeium', 'windsurf'),
      restart: 'Windsurf > MCP servers > Refresh (or restart Windsurf)' },
    { id: 'claude-desktop', label: 'Claude Desktop', file: path.join(claudeDesktopDir, 'claude_desktop_config.json'), present: claudeDesktopDir,
      restart: 'quit Claude Desktop fully (tray icon > Quit) and open it again' },
    // The Gemini CLI shares ~/.gemini with Antigravity, so its directory proves nothing. Its own
    // settings file does: the CLI writes it on first run.
    { id: 'gemini-cli', label: 'Gemini CLI', file: path.join(home, '.gemini', 'settings.json'), present: path.join(home, '.gemini', 'settings.json'),
      restart: 'restart `gemini`' },
  ]
}

/**
 * The node to write into configs: an absolute path (a bare "node" fails with ENOENT in GUI apps
 * started from the macOS Dock, which do not see an nvm or Homebrew PATH), but the most STABLE
 * absolute path that is still this same program. process.execPath on Homebrew is the versioned
 * Cellar path, which `brew upgrade node` deletes; /opt/homebrew/bin/node is a link that follows
 * the upgrade. A candidate is only taken when its realpath is exactly this node, so the choice
 * can never change WHICH node runs -- and verifyEntry launches whatever was chosen anyway.
 */
export function stableNodePath(execPath = process.execPath, env = process.env) {
  const real = (p) => { try { return fs.realpathSync(p) } catch { return null } }
  const target = real(execPath)
  if (!target) return execPath
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const versioned = /[\\/]v?\d+\.\d+\.\d+[\\/]|[\\/]Cellar[\\/]/
  const fromPath = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe))
  const cands = ['/opt/homebrew/bin/node', '/usr/local/bin/node', ...fromPath.filter((c) => !versioned.test(c))]
  for (const c of cands) if (c !== execPath && fs.existsSync(c) && real(c) === target) return c
  return execPath
}

/**
 * Parse the JSON-with-comments that Cursor, VS Code and friends accept: // and /* *\/ comments and
 * trailing commas, all outside strings. Returns the plain-JSON text.
 */
export function stripJsonc(src) {
  let out = ''
  for (let i = 0, inStr = false; i < src.length; i++) {
    const c = src[i]
    if (inStr) { out += c; if (c === '\\') out += src[++i] ?? ''; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue }
    out += c
  }
  let res = ''
  for (let i = 0, inStr = false; i < out.length; i++) {
    const c = out[i]
    if (inStr) { res += c; if (c === '\\') res += out[++i] ?? ''; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; res += c; continue }
    if (c === ',') { let j = i + 1; while (j < out.length && /\s/.test(out[j])) j++; if (out[j] === '}' || out[j] === ']') continue }
    res += c
  }
  return res
}

/** The entry every agent gets: this node, by absolute path, running hive-mcp.js directly. */
export function serverEntry(runtimeJs, { claudeCode = false, previous = null, node = stableNodePath() } = {}) {
  const entry = { command: node, args: [runtimeJs] }
  // What the user added to an existing entry is theirs: a token, a relay, a working directory.
  // Only the launch itself -- command and args -- is ours to replace.
  if (previous && typeof previous === 'object') {
    if (previous.env && typeof previous.env === 'object') entry.env = previous.env
    if (typeof previous.cwd === 'string') entry.cwd = previous.cwd
  }
  if (claudeCode) return { type: 'stdio', ...entry, env: entry.env || {} }
  return entry
}

/**
 * Write the hivecode entry into one config file. Returns { status, detail }, where status is one
 * of: 'written', 'unchanged', 'refused' (the file exists but is not plain JSON), 'error'.
 */
export function writeEntry(target, runtimeJs, { dryRun = false } = {}) {
  let raw = ''
  try { raw = fs.readFileSync(target.file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') return { status: 'error', detail: e.message } }
  let cfg = {}
  let droppedComments = false
  if (raw.trim()) {
    const text = raw.replace(/^﻿/, '')
    try { cfg = JSON.parse(text) } catch {
      // JSON with comments is legal in the files Cursor and VS Code write. Refusing it would hand
      // the user back the hand-editing this command exists to remove; the original is kept.
      try { cfg = JSON.parse(stripJsonc(text)); droppedComments = true } catch {
        return { status: 'refused', detail: 'not valid JSON even allowing comments, so it was left exactly as it is' }
      }
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { status: 'refused', detail: 'the file is not a JSON object' }
  }
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers) ? cfg.mcpServers : {}
  const previous = servers[SERVER_KEY] || null
  if (target.onlyIfHasEntry && !previous) return { status: 'skipped' }
  const entry = serverEntry(runtimeJs, { claudeCode: !!target.claudeCode, previous })
  const next = { ...cfg, mcpServers: { ...servers, [SERVER_KEY]: entry } }
  // CLAUDE CODE'S OTHER SCOPE. `claude mcp add` stores a server under projects[<folder>] unless
  // told otherwise, and that entry OVERRIDES the user-wide one inside that folder. Everyone who
  // followed the old README therefore has a broken npx entry that would silently win over the one
  // written above -- and this command would have printed READY about it. Those are ours by name.
  let projectFixes = 0
  if (target.claudeCode && cfg.projects && typeof cfg.projects === 'object') {
    for (const [p, v] of Object.entries(cfg.projects)) {
      const old = v && v.mcpServers && v.mcpServers[SERVER_KEY]
      if (!old || typeof old !== 'object') continue
      const fixed = serverEntry(runtimeJs, { claudeCode: true, previous: old })
      if (JSON.stringify(fixed) === JSON.stringify(old)) continue
      if (next.projects === cfg.projects) next.projects = { ...cfg.projects }
      next.projects[p] = { ...v, mcpServers: { ...v.mcpServers, [SERVER_KEY]: fixed } }
      projectFixes++
    }
  }
  if (previous && !projectFixes && JSON.stringify(previous) === JSON.stringify(entry)) return { status: 'unchanged', detail: 'already set up' }
  if (dryRun) return { status: 'written', detail: 'dry run: would write', entry }
  try {
    fs.mkdirSync(path.dirname(target.file), { recursive: true })
    // The backup is taken ONCE, of the file as it was before Hivecode ever touched it, so a
    // second or tenth run can never overwrite the one copy worth going back to.
    if (raw && !fs.existsSync(target.file + BACKUP_SUFFIX)) fs.writeFileSync(target.file + BACKUP_SUFFIX, raw)
    const tmp = target.file + '.hivecode-tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
    try { fs.renameSync(tmp, target.file) } catch {
      // A locked destination (an app holding it, an antivirus scan) refuses the rename on
      // Windows. Writing in place is less atomic but still leaves a whole file behind.
      fs.writeFileSync(target.file, JSON.stringify(next, null, 2) + '\n'); try { fs.rmSync(tmp, { force: true }) } catch {}
    }
  } catch (e) { return { status: 'error', detail: e.message } }
  let detail = previous ? 'replaced the old hivecode entry' : 'added hivecode'
  if (projectFixes) detail += `, and fixed ${projectFixes} per-folder entr${projectFixes === 1 ? 'y' : 'ies'} that would have overridden it`
  if (droppedComments) detail += ` (its comments were dropped; the original is ${path.basename(target.file)}${BACKUP_SUFFIX})`
  return { status: 'written', detail }
}

/**
 * Every hivecode entry in a written file must launch the same thing -- including Claude Code's
 * per-folder ones, which are never verified by launching separately. Returns the first entry
 * that disagrees with `entry`, or null.
 */
export function strayEntry(file, entry) {
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return null }
  for (const [p, v] of Object.entries((cfg && cfg.projects) || {})) {
    const e = v && v.mcpServers && v.mcpServers[SERVER_KEY]
    if (e && (e.command !== entry.command || JSON.stringify(e.args) !== JSON.stringify(entry.args))) return p
  }
  return null
}

/** Read the entry back FROM DISK -- the thing the agent app will actually launch. */
export function readEntry(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).mcpServers[SERVER_KEY] || null } catch { return null }
}

/**
 * Launch an entry exactly as an MCP client does -- no shell, the entry's own env and cwd -- and
 * complete a real `initialize` handshake. Anything short of a hivecode server answering is a
 * failure with the reason attached.
 */
export function verifyEntry(entry, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    if (!entry || !entry.command) return resolve({ ok: false, error: 'no hivecode entry in the file' })
    const t0 = Date.now()
    const cwd = entry.cwd && fs.existsSync(entry.cwd) ? entry.cwd : os.tmpdir()
    let child
    try {
      child = spawn(entry.command, entry.args || [], { cwd, env: { ...process.env, ...(entry.env || {}) }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) { return resolve({ ok: false, error: e.message }) }
    let out = ''
    let errTail = ''
    let settled = false
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill() } catch {}; resolve({ ms: Date.now() - t0, ...r }) }
    const timer = setTimeout(() => done({ ok: false, error: `no answer within ${Math.round(timeoutMs / 1000)}s${errTail ? ': ' + errTail.trim().split('\n').pop() : ''}` }), timeoutMs)
    child.on('error', (e) => done({ ok: false, error: `${e.code || ''} ${e.message}`.trim() }))
    child.on('exit', (code) => done({ ok: false, error: `the server exited (code ${code}) before answering${errTail ? ': ' + errTail.trim().split('\n').pop() : ''}` }))
    child.stderr.on('data', (d) => { errTail = (errTail + d).slice(-400) })
    child.stdout.on('data', (d) => {
      out += d
      let i
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i); out = out.slice(i + 1)
        let m; try { m = JSON.parse(line) } catch { continue }
        if (m.id !== 1) continue
        const info = m.result && m.result.serverInfo
        if (info && info.name === 'hivecode') done({ ok: true, version: info.version })
        else done({ ok: false, error: 'something answered, but it is not the hivecode server' })
      }
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hivecode-setup', version: VERSION } } }) + '\n')
  })
}

/**
 * Put a runtime where agent apps can launch it with no download. When this file is running out
 * of a checkout (development), the checkout IS the runtime. When it is running out of an
 * installed package (npx), the package and its dependency closure are copied under
 * ~/.hivecode/runtime/<version> -- the npx cache is not a place to point a config at, because
 * npm prunes it and the config would break months later with nothing to connect it to setup.
 */
export function installRuntime(home = os.homedir(), here = fileURLToPath(import.meta.url)) {
  const pkgDir = path.dirname(here)
  const nm = path.dirname(pkgDir)
  if (path.basename(nm) !== 'node_modules') return { mode: 'checkout', js: path.join(pkgDir, 'hive-mcp.js') }
  const dest = path.join(home, '.hivecode', 'runtime', VERSION)
  const js = path.join(dest, 'node_modules', 'hivecode-mcp', 'hive-mcp.js')
  if (fs.existsSync(js)) return { mode: 'installed', js, dir: dest, reused: true }
  // ONLY the dependency closure is copied, never the whole node_modules around us: that would
  // be every global package on a machine where hivecode-mcp was installed with `npm i -g`.
  const closure = new Set()
  const seen = new Set()
  const visit = (name, fromDir) => {
    // Node's own resolution: <dir>/node_modules/<name> for each directory walking up from the
    // requiring package, skipping directories that ARE node_modules (Node never looks in
    // node_modules/node_modules), and stopping at the folder that holds our node_modules.
    for (let d = fromDir; ;) {
      if (path.basename(d) !== 'node_modules') {
        const cand = path.join(d, 'node_modules', name)
        if (fs.existsSync(path.join(cand, 'package.json'))) {
          if (seen.has(cand)) return // dependency cycles are real (and legal) in npm trees
          seen.add(cand)
          // Nested copies travel inside their parent's directory; only top-level ones are listed.
          if (path.relative(nm, cand) === path.join(...name.split('/'))) closure.add(name)
          let pj = {}
          try { pj = JSON.parse(fs.readFileSync(path.join(cand, 'package.json'), 'utf8')) } catch {}
          for (const dep of Object.keys({ ...pj.dependencies, ...pj.optionalDependencies, ...pj.peerDependencies })) visit(dep, cand)
          return
        }
      }
      const up = path.dirname(d)
      if (up === d || d === path.dirname(nm)) return // a missing optional or peer dependency
      d = up
    }
  }
  closure.add('hivecode-mcp')
  let rootPj = {}
  try { rootPj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) } catch {}
  for (const dep of Object.keys({ ...rootPj.dependencies, ...rootPj.optionalDependencies })) visit(dep, pkgDir)
  const tmp = `${dest}.tmp-${process.pid}`
  fs.rmSync(tmp, { recursive: true, force: true })
  for (const name of closure) {
    fs.cpSync(path.join(nm, name), path.join(tmp, 'node_modules', name), { recursive: true, dereference: true })
  }
  fs.rmSync(dest, { recursive: true, force: true })
  fs.renameSync(tmp, dest)
  return { mode: 'installed', js, dir: dest, packages: closure.size }
}

/** The project this was run in, when there is one to offer: a git work tree with at least one
 *  commit, whose top is not the home folder (a home kept in git is a dotfiles repo, not a project;
 *  this machine's is one). Returns the repo's top folder, or null. Any git failure is null: setup
 *  must never fail because git is missing. */
export function projectRepo(cwd = process.cwd(), home = os.homedir()) {
  const git = (...args) => {
    try {
      const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true })
      return r.status === 0 ? String(r.stdout || '').trim() : ''
    } catch { return '' }
  }
  const top = git('rev-parse', '--show-toplevel')
  if (!top || !git('rev-parse', '--verify', '-q', 'HEAD^{commit}')) return null
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(top) === norm(home) ? null : path.resolve(top)
}

function defaultName() {
  let base = 'agent'
  try { base = os.userInfo().username || base } catch {}
  const cand = (base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent') + '-AI'
  const v = validateMemberName(cand)
  return v.ok ? cand : v.suggested
}

async function wakeRelay(relay) {
  const url = relay.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/health'
  const t0 = Date.now()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(75000) })
    return { ok: r.ok, ms: Date.now() - t0, status: r.status }
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.name === 'TimeoutError' ? 'no answer in 75s' : e.message } }
}

function parseArgs(argv) {
  const o = { link: '', name: '', dryRun: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') o.name = argv[++i] || ''
    else if (a.startsWith('--name=')) o.name = a.slice(7)
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '-h' || a === '--help') o.help = true
    else if (!a.startsWith('-') && !o.link) o.link = a
  }
  return o
}

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, Math.max(n, s.length))

/** Returns the process exit code: 0 only when nothing that exists failed. */
export async function main(argv = [], { home = os.homedir(), log = console.log } = {}) {
  const o = parseArgs(argv)
  if (o.help) {
    log('Usage: npx -y hivecode-mcp@latest setup ["<join link>"] [--name You-AI] [--dry-run]')
    return 0
  }
  log(`\nHivecode setup  (hivecode-mcp ${VERSION})\n`)
  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) { log(`  FAILED  Node ${process.versions.node} is too old. Install Node 18 or newer from https://nodejs.org and run this again.`); return 1 }

  let name = o.name || defaultName()
  const nv = validateMemberName(name)
  if (!nv.ok) { log(`  note    "${name}" cannot be a room name (${nv.error.split('.')[0]}); using "${nv.suggested}".`); name = nv.suggested }

  let runtime
  try { runtime = o.dryRun ? { mode: 'dry-run', js: path.join(home, '.hivecode', 'runtime', VERSION, 'node_modules', 'hivecode-mcp', 'hive-mcp.js') } : installRuntime(home) }
  catch (e) { log(`  FAILED  could not install the runtime under ${path.join(home, '.hivecode')}: ${e.message}`); return 1 }
  log(`  runtime   ${runtime.js}`)
  log(`  node      ${process.execPath}\n`)

  const results = []
  for (const t of agentTargets(home)) {
    // A second config path of an app that IS installed is not an app of its own: printing
    // "Antigravity (2nd) not installed" made a stranger ask what part of Antigravity was missing.
    if (!fs.existsSync(t.present)) { if (!t.onlyIfHasEntry) results.push({ t, status: 'absent' }); continue }
    const w = writeEntry(t, runtime.js, { dryRun: o.dryRun })
    if (w.status !== 'skipped') results.push({ t, ...w })
  }
  // Verify what is ON DISK, once per distinct launch -- the entries are normally identical.
  const cache = new Map()
  for (const r of results) {
    if (r.status !== 'written' && r.status !== 'unchanged') continue
    if (o.dryRun) { r.verify = { ok: true, ms: 0, skipped: true }; continue }
    const entry = readEntry(r.t.file)
    const key = JSON.stringify(entry)
    if (!cache.has(key)) cache.set(key, await verifyEntry(entry))
    r.verify = cache.get(key)
    const stray = r.verify.ok && entry && strayEntry(r.t.file, entry)
    if (stray) r.verify = { ok: false, error: `the entry for the folder ${stray} still launches something else, and it wins inside that folder` }
  }
  // A project's own .mcp.json outranks everything written above, inside that project. It is a
  // shared, committed file, so it is reported rather than rewritten with this machine's paths.
  const projectMcp = path.join(process.cwd(), '.mcp.json')
  if (readEntry(projectMcp)) log(`  WARNING   ${projectMcp} defines its own hivecode server, which overrides this setup inside this folder. Remove that entry.\n`)

  let failed = 0
  const ready = []
  // A second config file of an app is not an app of its own. A READY one folds into its app's line
  // ("Antigravity (2nd) READY" under "Antigravity READY" made a stranger ask which one was real);
  // a FAILED one is never folded -- it keeps a line of its own.
  const isReady = (r) => (r.status === 'written' || r.status === 'unchanged') && r.verify && r.verify.ok
  const folded = new Set(results.filter((r) => r.t.secondaryOf && isReady(r) && results.some((p) => p.t.id === r.t.secondaryOf && isReady(p))))
  for (const r of results) {
    if (folded.has(r)) continue
    const where = r.t.file
    if (r.status === 'absent') { log(`  ${pad(r.t.label, 15)} not installed`); continue }
    if (r.status === 'refused' || r.status === 'error') {
      failed++
      log(`  ${pad(r.t.label, 15)} FAILED  ${where}\n  ${' '.repeat(15)}         ${r.detail}. Add the hivecode entry below by hand.`)
      continue
    }
    if (!r.verify.ok) {
      failed++
      log(`  ${pad(r.t.label, 15)} FAILED  ${where}\n  ${' '.repeat(15)}         written, but it does not start: ${r.verify.error}`)
      continue
    }
    const extra = results.filter((x) => folded.has(x) && x.t.secondaryOf === r.t.id)
    r.changed = r.status === 'written' || extra.some((x) => x.status === 'written')
    ready.push(r)
    const how = r.verify.skipped ? 'dry run, nothing written' : `starts in ${(r.verify.ms / 1000).toFixed(1)}s`
    const what = r.status === 'written' ? r.detail : r.changed ? 'updated its second config file' : 'already set up'
    log(`  ${pad(r.t.label, 15)} READY   ${what}  (${how}${extra.length ? `, ${extra.length + 1} config files` : ''})`)
  }

  const manual = { mcpServers: { [SERVER_KEY]: serverEntry(runtime.js) } }
  if (failed || !ready.length) {
    log(`\n  ${ready.length ? 'For the agents above that FAILED' : 'No supported agent app was found. For any MCP agent'}, add this to its MCP settings:\n`)
    log(JSON.stringify(manual, null, 2).split('\n').map((l) => '    ' + l).join('\n'))
  }

  let link = o.link.trim()
  if (link) {
    const [relayPart, ...rest] = link.split('|')
    const { relay, migratedFrom } = currentRelayFor(relayPart.trim() || PUBLIC_DEFAULT_RELAY)
    if (migratedFrom) { link = [relay, ...rest].join('|'); log(`\n  note    that link used a retired relay; it now points at ${relay}`) }
    if (!rest.length || !rest[0].trim()) {
      // THE PIPE TRAP. Unquoted, `setup wss://relay|room-x` is two commands to every shell: this
      // one gets `wss://relay`, and our stdout is piped into a program called room-x. So the
      // explanation also goes to stderr, the one stream still reaching the terminal.
      const hint = `\n  WARNING  "${o.link}" has no room in it -- the part after | was cut off. Put the whole link in quotes, or leave it out: you give the link to your agent, not to this command.`
      log(hint)
      if (!process.stdout.isTTY) console.error(hint)
    }
    const w = await wakeRelay(relay)
    log(w.ok ? `\n  relay     ${relay} is up (answered in ${(w.ms / 1000).toFixed(1)}s)` : `\n  WARNING  ${relay} did not answer (${w.error || 'HTTP ' + w.status}). Joining will fail until it does.`)
  }

  if (ready.length) {
    log(`\nNEXT\n`)
    // Numbered steps only where this run wrote something. An entry that was already right says
    // nothing about whether the RUNNING app has loaded it -- "run setup again, then reload the agent"
    // is the README's first fix for a missing hive_join -- so those apps get one line, never silence.
    const toRestart = ready.filter((r) => r.changed)
    const already = ready.filter((r) => !r.changed)
    toRestart.forEach((r, i) => log(`  ${i + 1}. ${r.t.label}: ${r.t.restart}.`))
    if (already.length) log(`  Already set up: ${already.map((r) => r.t.label).join(', ')}. Restart ${already.length === 1 ? 'it' : 'them'} only if the hivecode tools are missing there.`)
    if (link) {
      log(`\n  Then paste this to your agent:\n`)
      log(`    Use your hive_join tool to join the Hivecode room ${link} as ${name}. Then follow the rules it gives you.`)
    } else {
      // THE EMPTY-ROOM TRAP (onboarding audit, 2 Oct 2026). A team runs setup in its project and
      // is told to host a room, which is new and empty: its code is not in it, and nothing said how
      // to bring it in. `branch` does, so inside a repo it comes first -- with the privacy line
      // BEFORE the command, because running it publishes the repo's committed files. The name is
      // a real one: `<name>` pasted into PowerShell is a parse error, not a placeholder.
      const repo = projectRepo(process.cwd(), home)
      if (repo) {
        const relay = process.env.HIVE_RELAY || PUBLIC_DEFAULT_RELAY
        log(`\n  You're in a git repo (${repo}). To give your agents its code, run this here first:\n`)
        log(`    npx -y hivecode-mcp@latest branch hive-work\n`)
        log(`  It cuts a new branch, hive-work, without switching your checkout, puts its committed files in a room,`)
        log(`  and prints the line for your agents and for teammates.${currentRelayFor(relay).relay === PUBLIC_DEFAULT_RELAY ? ' This uses the public relay: anyone with the room\'s link can read those files.' : ''}`)
      }
      // Inside a repo the empty-room line is the trap itself: Antigravity1's scripted stranger walk
      // (3 Oct) found a stranger skips the command above and pastes "host a new, empty room". Only
      // the line for someone who was SENT a link stays; the README still documents an empty room.
      if (repo) {
        log(`\n  If you were sent a link instead, paste this to your agent:\n`)
        log(`    Use your hive_join tool to join the Hivecode room <the link you were sent> as ${name}. Then follow the rules it gives you.`)
      } else {
        log(`\n  Then paste ONE of these to your agent:\n`)
        log(`    Use your hive_join tool to join the Hivecode room <the link you were sent> as ${name}. Then follow the rules it gives you.`)
        log(`    Use your hive_join tool to host a new, empty Hivecode room as ${name}, then give me the join link.`)
      }
    }
    log(`\n  Its files go in ${path.join(home, 'hivecode', '<room>', name)} unless you name a folder.`)
    // With a link, the room itself: its relay's Control Room with the link in the hash, so a person
    // never pastes wss:// into an address bar. Without one, the panel they paste a link into.
    const panel = (link && controlUrl(link)) || `${(process.env.HIVE_RELAY || PUBLIC_DEFAULT_RELAY).replace(/^ws/, 'http').replace(/\/+$/, '')}/control`
    log(`  People join from a browser, no install: ${panel}\n`)
  }
  return failed ? 1 : 0
}
