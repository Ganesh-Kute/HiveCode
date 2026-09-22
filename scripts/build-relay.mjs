#!/usr/bin/env node
/**
 * BUILD the `hivecode-relay` package — the self-hostable relay, as one `npx` command.
 *
 *   node scripts/build-relay.mjs            # stage + verify into dist/relay
 *   node scripts/build-relay.mjs --pack     # …and produce the .tgz npm would upload
 *
 * WHY THIS IS A BUILD AND NOT A FOLDER OF FILES.
 *
 * The obvious way to ship a second package is to copy the relay's sources into `packages/relay/`
 * and commit them. This repo already paid for that mistake once: `reconcile()` exists in both
 * `sync.js` and `extension/extension.js`, so fixing one silently ships the other broken and no
 * test covers the second copy. A copy of `server.js` would be the same bug with a bigger blast
 * radius -- the published relay would quietly drift from the one we actually run.
 *
 * So there is exactly ONE copy of every source file, at the repo root, and this script derives
 * the package from it. The file list is COMPUTED by walking `server.js`'s imports rather than
 * typed out, which means a new import is picked up automatically instead of producing a package
 * that installs cleanly and then dies on `ERR_MODULE_NOT_FOUND` at someone else's first run.
 *
 * The dependency list is computed the same way, from the bare imports actually present in the
 * closure -- `hivecode-mcp` ships the Anthropic and MCP SDKs, and a relay that made people
 * install those to run a WebSocket server would be embarrassing.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync, spawn } from 'child_process'
import * as acorn from 'acorn'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'dist', 'relay')
const PACK = process.argv.includes('--pack')
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// ── 1. the closure, computed ────────────────────────────────────────────────────────────────
// A relative import may omit `.js`; a bare one is an npm dependency. Both matter and they are
// collected separately.
const local = new Set()
const bare = new Set()

// PARSED, not pattern-matched. A regex over source also matches imports written inside comments
// and strings -- this file's own doc comment cites `sync.js` and `extension/extension.js`, and
// the first version of this script walked off into a `./m.js` that only ever existed in a
// comment in a test. acorn is already a dependency of the relay, so this costs nothing.
function specifiersOf(src, rel) {
  const out = []
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
  const visit = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const c of n) visit(c); return }
    if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source) out.push(n.source.value)
    // `await import('./x.js')` is a real edge and the relay uses it; a literal argument is
    // resolvable, a computed one is not and must not be guessed at.
    if (n.type === 'ImportExpression' && n.source && n.source.type === 'Literal') out.push(n.source.value)
    for (const k of Object.keys(n)) if (k !== 'type' && k !== 'loc' && k !== 'range') visit(n[k])
  }
  visit(ast)
  return out
}

function walk(rel) {
  if (local.has(rel)) return
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) throw new Error(`Q480 ${rel} is imported but does not exist`)
  local.add(rel)
  const src = fs.readFileSync(abs, 'utf8')
  for (const spec of specifiersOf(src, rel)) {
    if (spec.startsWith('.')) {
      let p = path.normalize(path.join(path.dirname(rel), spec)).replace(/\\/g, '/')
      if (!/\.(js|cjs|mjs|json)$/.test(p)) p += '.js'
      walk(p)
    } else if (!spec.startsWith('node:')) {
      // "lib0/decoding" and "y-websocket/bin/utils" are deep imports; the DEPENDENCY is the
      // package, which for a scoped name is the first two segments.
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      bare.add(pkg)
    }
  }
}
// THE ENTRY IS hive-relay.js, NOT server.js, and the difference is the whole point of the
// package. `node server.js` starts a relay with persistence OFF and says nothing about which
// relay anyone is on. hive-relay.js sets the defaults a team needs, waits for /health before
// claiming to be listening, and prints the exact settings each teammate pastes -- including
// HIVE_RELAY_PIN, without which one stale link puts a teammate back on the public relay.
// server.js comes along automatically because hive-relay.js imports it, which is the property
// this walk exists to guarantee.
walk('hive-relay.js')

// Node builtins are imported without the `node:` prefix all over this codebase, and treating one
// as an npm package would put `fs` in the dependency list.
const BUILTIN = new Set(['fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'child_process',
  'module', 'events', 'stream', 'util', 'zlib', 'net', 'tls', 'buffer', 'worker_threads', 'assert'])
const deps = {}
const undeclared = []
for (const d of [...bare].sort()) {
  if (BUILTIN.has(d)) continue
  let v = rootPkg.dependencies[d]
  if (!v) {
    // `server.js` imports `lib0/decoding` directly, but lib0 is nobody's declared dependency --
    // it resolves only because yjs happens to hoist it. That works here and is a real hazard in
    // a published package, where a different hoist or a stricter installer gives the user
    // ERR_MODULE_NOT_FOUND on first run. Pin what is actually installed and say so out loud.
    const man = path.join(ROOT, 'node_modules', d, 'package.json')
    if (!fs.existsSync(man)) throw new Error(`Q481 ${d} is imported by the relay, is not a declared dependency, and is not installed`)
    v = '^' + JSON.parse(fs.readFileSync(man, 'utf8')).version
    undeclared.push(`${d}@${v}`)
  }
  deps[d] = v
}

// ── 2. the browser surfaces ─────────────────────────────────────────────────────────────────
// Only what the relay's own static allowlist needs to make /control and /map work. The marketing
// homepage and the demo videos are deliberately left out: nobody self-hosting a relay wants to
// download 20 MB of mp4 to run a WebSocket server.
const ASSETS = ['control.html', 'map.html', 'app.js', 'hive-crdt.js', 'favicon-32.png']

// TOOLS NOTHING IMPORTS, THAT THE OPERATOR IS TOLD TO RUN. The closure walk finds everything
// the relay needs to SERVE, and by construction misses anything nobody imports -- which is
// exactly what a CLI is. hive-token.js is the one that matters: the relay's own banner and
// docs/SELF_HOSTING.md both tell an operator to mint tokens with it, and the first build from
// hive-relay.js shipped without it. Minting belongs on the relay host anyway, because that is
// the only machine that holds HIVE_JWT_SECRET.
const TOOLS = ['hive-token.js']
for (const t of TOOLS) walk(t)

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'public'), { recursive: true })
for (const rel of local) {
  const dest = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(path.join(ROOT, rel), dest)
}
for (const a of ASSETS) fs.copyFileSync(path.join(ROOT, 'public', a), path.join(OUT, 'public', a))

// A self-hosted relay answering 404 on `/` looks broken. This page is the package's own, not a
// copy of the marketing site, and it says the two things a new self-hoster needs.
fs.writeFileSync(path.join(OUT, 'public', 'index.html'), `<!doctype html><meta charset="utf-8">
<title>Hivecode relay</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:dark}body{background:#07080D;color:#fff;font:16px/1.6 system-ui,sans-serif;
margin:0;padding:48px 20px;display:flex;justify-content:center}main{max-width:34rem}
h1{font-size:30px;letter-spacing:-1px;margin:0 0 6px}p{color:#93A6C0}code,a{font-family:Consolas,monospace}
a{color:#5B8DEF}ul{padding-left:20px}li{margin:8px 0}</style>
<main><h1>Hivecode relay</h1><p>This relay is running. It is the only thing that decides who may
write to a file &mdash; no model is asked.</p><ul>
<li><a href="/control">/control</a> &mdash; the control room</li>
<li><a href="/map">/map</a> &mdash; the live architecture map</li>
<li><a href="/health">/health</a> &mdash; connections, rooms, limits</li></ul>
<p>Point an agent at <code>ws://&lt;this-host&gt;|&lt;room&gt;</code>.</p></main>`)

const pkg = {
  name: 'hivecode-relay',
  version: process.env.RELAY_VERSION || '0.1.0',
  description: 'Self-hostable Hivecode relay — the server that refuses a write when someone else holds the file.',
  type: 'module',
  bin: { 'hivecode-relay': 'hive-relay.js', 'hivecode-token': 'hive-token.js' },
  main: 'server.js',
  scripts: { start: 'node server.js' },
  engines: { node: '>=18' },
  dependencies: deps,
  keywords: ['hivecode', 'relay', 'crdt', 'yjs', 'multiplayer', 'ai-agents', 'self-hosted', 'websocket'],
  license: rootPkg.license || 'SEE LICENSE IN LICENSE',
  author: rootPkg.author,
  repository: rootPkg.repository,
  homepage: 'https://hivecode.getgrm.tech',
}
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
if (fs.existsSync(path.join(ROOT, 'LICENSE'))) fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'))

fs.writeFileSync(path.join(OUT, 'README.md'), `# hivecode-relay

The Hivecode relay, self-hosted. One command:

\`\`\`bash
npx hivecode-relay
\`\`\`

It listens on \`:1234\` (set \`PORT\` to change it) and prints what it is enforcing. Point agents
and editors at \`ws://localhost:1234|<room>\`, open \`/control\` to watch, \`/map\` for the live
architecture graph, \`/health\` for connections and limits.

## Why run your own

The relay is the component that **decides**. When two participants reach for the same file, the
second write is refused here — at the transport, before it lands, with no model involved. Running
it yourself means your code never leaves your network.

## Seats — read this before a real team uses it

A room caps at **8 connections** by default, and the refusal is **invisible**: the 9th socket
connects and then simply never syncs. Every CLI call is its own connection, so a five-person team
reaches that ceiling quickly.

\`\`\`bash
HIVE_SEATS=4 npx hivecode-relay      # 4 x 8 = 32 connections per room
\`\`\`

## Configuration

| variable | what it does |
|---|---|
| \`PORT\` | listen port (default 1234) |
| \`HIVE_SEATS\` | seats; each grants 8 connections per room |
| \`HIVE_AUTH\` | \`required\` to reject any client without a valid token |
| \`HIVE_JWT_SECRET\` / \`HIVE_JWT_PUBKEY\` | HS256 / RS256 verification keys |
| \`HIVE_ENFORCE_CLAIMS\` | \`on\` to refuse writes to a file someone else holds |
| \`HIVE_PROVENANCE\` | \`on\` to require signed receipts on every change |
| \`ENABLE_REMOTE_MCP\` | \`false\` to shut the HTTP MCP endpoint entirely |

With \`HIVE_AUTH=required\` nothing joins without a token, so an open port is not an open room.

## What this package is not

It is the relay only. Agents connect through [\`hivecode-mcp\`](https://www.npmjs.com/package/hivecode-mcp);
humans use the VS Code extension or \`/control\`. This is the piece that was missing: until now the
client shipped and the server did not, so nobody could actually self-host.
`)

// ── 3. verify — a package that installs and then cannot start is worse than none ─────────────
console.log(`staged ${local.size} sources + ${ASSETS.length + 1} assets -> dist/relay`)
console.log(`dependencies: ${Object.keys(deps).join(', ')}`)
if (undeclared.length) console.log(`  ! pinned from node_modules (imported but undeclared in the root package): ${undeclared.join(', ')}`)

const install = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'],
  { cwd: OUT, encoding: 'utf8', shell: process.platform === 'win32' })
if (install.status !== 0) throw new Error('npm install in the staged package failed: ' + (install.stderr || '').slice(0, 500))

const PORT = 1247
const proc = spawn(process.execPath, ['server.js'], { cwd: OUT, env: { ...process.env, PORT: String(PORT), HIVE_SEATS: '4' }, stdio: ['ignore', 'pipe', 'pipe'] })
let boot = ''
proc.stdout.on('data', (d) => { boot += d })
proc.stderr.on('data', (d) => { boot += d })
await new Promise((r) => setTimeout(r, 3000))

let ok = true
const check = (name, cond, detail) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!cond) ok = false }
try {
  const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json())
  check('the staged relay starts and answers /health', h.ok === true)
  check('HIVE_SEATS is honoured', h.connsPerRoom === 32, `connsPerRoom=${h.connsPerRoom}`)
  const page = await fetch(`http://127.0.0.1:${PORT}/`)
  check('/ serves the relay landing page', page.status === 200)
  const ctl = await fetch(`http://127.0.0.1:${PORT}/control`)
  check('/control is served', ctl.status === 200)
  const crdt = await fetch(`http://127.0.0.1:${PORT}/hive-crdt.js`)
  check('/hive-crdt.js is served (without it /control goes deaf)', crdt.status === 200)
  const map = await fetch(`http://127.0.0.1:${PORT}/map`)
  check('/map is served', map.status === 200)

  // The real test: two independent clients, one shared doc, a write that crosses.
  const { startSync } = await import('../sync.js')
  const os = await import('os')
  const mk = (name) => startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: 'buildcheck', name, kind: 'ai', syncFiles: false, log: () => {},
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'relaychk-')),
  })
  const a = mk('A'), b = mk('B')
  await new Promise((r) => setTimeout(r, 3500))
  a.doc.getMap('graph').set('n:probe', { id: 'probe', label: 'crossed' })
  await new Promise((r) => setTimeout(r, 2500))
  check('a write by one client reaches another through it', (b.doc.getMap('graph').get('n:probe') || {}).label === 'crossed')
  const granted = a.claim('src/routes/index.js', 'edit')
  // The claim map is a CRDT, so a holder is known to everyone only once it has PROPAGATED.
  // Claiming back-to-back in the same tick means B senses its own copy before A's claim has
  // arrived, and both believe they won until the doc converges. That is real behaviour, not a
  // bug -- and testing it without the wait tests the network, not the lock.
  await new Promise((r) => setTimeout(r, 1200))
  const refused = b.claim('src/routes/index.js', 'edit')
  check('it grants a free file and refuses a held one', granted === true && !refused, `granted=${!!granted} second=${!!refused}`)
  a.stop(); b.stop()
} catch (e) {
  check('smoke test ran', false, e.message)
  if (boot) console.log('  relay said: ' + boot.split('\n').slice(0, 4).join(' | '))
} finally {
  proc.kill()
}

if (PACK && ok) {
  const r = spawnSync('npm', ['pack', '--silent'], { cwd: OUT, encoding: 'utf8', shell: process.platform === 'win32' })
  const tgz = (r.stdout || '').trim().split('\n').pop()
  if (tgz) console.log(`\npacked ${tgz}  ${Math.round(fs.statSync(path.join(OUT, tgz)).size / 1024)} kB`)
}

console.log(ok
  ? `\nREADY. publish with:\n  cd dist/relay && npm publish --access public`
  : '\nQ482 the staged package did not pass its own smoke test; not fit to publish')
process.exit(ok ? 0 : 1)
