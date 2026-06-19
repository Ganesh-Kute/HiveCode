// Reproduces the SILENT-LOSS bug found in the live MCP field test and proves the
// fork-point fix. The dangerous sequence (NOT the same as folder-collide-test):
//
//   1. A and B share index.js (a routes file).
//   2. A adds /login.  It propagates to B's disk.
//   3. B — working from the OLD copy it read earlier (no /login) — pastes a WHOLE
//      new file that contains only /signup. ("AI forgot to re-read.")
//
// Before the fix: B's stale paste looked like a deliberate deletion of /login
// (base had advanced to include /login), so /login was SILENTLY destroyed in
// BOTH folders. After the fix: B's edit is merged against the FORK POINT it
// actually saw, so /login survives — cleanly if disjoint, or with conflict
// markers if it touched the same lines. Either way NOTHING IS LOST.
//
//   node merge-clobber-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const PORT = 1249
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'merge-clobber'
const A = path.resolve('.clobber-test/A')
const B = path.resolve('.clobber-test/B')
const FILE = 'index.js'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir) => { try { return fs.readFileSync(path.join(dir, FILE), 'utf8') } catch { return '<missing>' } }
const write = (dir, t) => fs.writeFileSync(path.join(dir, FILE), t)

fs.rmSync(path.resolve('.clobber-test'), { recursive: true, force: true })
fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true })

const BASE = [
  'const routes = {',
  '  // ROUTES HERE',
  '}',
  '',
  'module.exports = routes',
].join('\n')

const A_WITH_LOGIN = [
  'const routes = {',
  "  '/login': (req, res) => res.end('logged in'),",
  '}',
  '',
  'module.exports = routes',
].join('\n')

// B's STALE paste: a whole new file built from the OLD base (no /login), adding
// only /signup. This is the realistic "agent pasted a full file in one go".
const B_STALE_SIGNUP = [
  'const routes = {',
  "  '/signup': (req, res) => res.end('signed up'),",
  '}',
  '',
  'module.exports = routes',
].join('\n')

write(A, BASE)

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const procs = []
function startClient(dir, name) {
  const p = spawn(process.execPath, ['folder.js', RELAY, ROOM, dir, name])
  p.stdout.on('data', (d) => process.stdout.write(`   [${name}] ${d}`))
  p.stderr.on('data', (d) => process.stdout.write(`   [${name}] ${d}`))
  procs.push(p)
}
startClient(A, 'A')
startClient(B, 'B')
await sleep(2500)
assert('B received base index.js on join', read(B).includes('ROUTES HERE'))

console.log('\n# A adds /login; it propagates to B')
write(A, A_WITH_LOGIN)
await sleep(2500)
assert('B now has /login on disk', read(B).includes('/login'))

console.log('\n# B pastes a STALE whole-file rewrite (only /signup, no /login)')
write(B, B_STALE_SIGNUP)
await sleep(3000)

console.log('\n   --- final A/index.js ---\n' + read(A).split('\n').map((l) => '      ' + l).join('\n'))
console.log('\n   --- final B/index.js ---\n' + read(B).split('\n').map((l) => '      ' + l).join('\n'))

const fa = read(A), fb = read(B)
assert("A's /login SURVIVED (not silently clobbered)", fa.includes('/login'))
assert("B's /signup is present", fa.includes('/signup'))
assert('B has both too', fb.includes('/login') && fb.includes('/signup'))
assert('both folders converged identically', fa === fb)

console.log('\n# A resolves the conflict (keeps both routes, removes markers)')
const RESOLVED = [
  'const routes = {',
  "  '/login': (req, res) => res.end('logged in'),",
  "  '/signup': (req, res) => res.end('signed up'),",
  '}',
  '',
  'module.exports = routes',
].join('\n')
write(A, RESOLVED)
await sleep(3000)
assert('conflict markers gone after resolve', !read(A).includes('<<<<<<<') && !read(B).includes('<<<<<<<'))
assert('both routes kept after resolve', read(B).includes('/login') && read(B).includes('/signup'))

console.log('\n# Control: a good agent that RE-READ before writing merges cleanly (no spurious conflict)')
// B re-reads (sees both), then adds /logout building on the latest.
const latest = read(B)
const withLogout = latest.replace("'/signup': (req, res) => res.end('signed up'),", "'/signup': (req, res) => res.end('signed up'),\n  '/logout': (req, res) => res.end('bye'),")
write(B, withLogout)
await sleep(3000)
const ga = read(A), gb = read(B)
assert('all three routes present after an integrated edit', ga.includes('/login') && ga.includes('/signup') && ga.includes('/logout'))
assert('no conflict markers on the integrated edit', !ga.includes('<<<<<<<'))
assert('still converged', ga === gb)

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
for (const p of procs) p.kill()
relay.kill()
fs.rmSync(path.resolve('.clobber-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
