// Proves the AUTO-BOARD end-to-end with two real folder.js processes.
//   - a small grep-and-patch edit  -> NOT logged (board stays quiet)
//   - a wholesale file rewrite      -> auto-logged to HIVE_BOARD.md in BOTH folders
// The agent never writes the board itself — the sync layer detects the rewrite.
//
//   node folder-board-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const PORT = 1241
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'folder-board'
const A = path.resolve('.board-test/A')
const B = path.resolve('.board-test/B')
const FILE = 'app.js'
const BOARD = 'HIVE_BOARD.md'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir, f = FILE) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
const write = (dir, t, f = FILE) => fs.writeFileSync(path.join(dir, f), t)

fs.rmSync(path.resolve('.board-test'), { recursive: true, force: true })
fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true })

const BASE = [
  'function login(u, p) {',
  '  return check(u, p)',
  '}',
  'function logout() {',
  '  clearSession()',
  '}',
  'function ping() {',
  '  return 1',
  '}',
].join('\n')
write(A, BASE)

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

const procs = []
function startClient(dir, name) {
  const p = spawn(process.execPath, ['folder.js', RELAY, ROOM, dir, name])
  p.stdout.on('data', (d) => process.stdout.write(`   [${name}] ${d}`))
  procs.push(p)
}
startClient(A, 'A'); startClient(B, 'B')
await sleep(2500)
assert('B received the file', (read(B) || '').includes('function login'))

// ---------------------------------------------------------------
console.log('\n# A makes a SMALL patch (one line) — should NOT hit the board')
write(A, read(A).replace('return 1', 'return Date.now()'))
await sleep(2500)
assert('patch synced to B', (read(B) || '').includes('Date.now()'))
assert('no board file created for a small patch', read(A, BOARD) === null && read(B, BOARD) === null)

// ---------------------------------------------------------------
console.log('\n# A REWRITES most of the file — should auto-log to the board on BOTH sides')
const REWRITE = [
  'function login(user, pass, opts) {',
  '  validate(user)',
  '  return check(user, pass, opts)',
  '}',
  'function logout(session) {',
  '  audit("logout")',
  '  clearSession(session)',
  '}',
  'function ping() {',
  '  return Date.now()',
  '}',
].join('\n')
write(A, REWRITE)
await sleep(3000)

const boardA = read(A, BOARD), boardB = read(B, BOARD)
console.log('\n   --- B/HIVE_BOARD.md ---\n' + (boardB || '(missing)').split('\n').map((l) => '      ' + l).join('\n'))
assert('board file exists on A (author)', boardA !== null)
assert('board file exists on B (teammate) — they learn of it', boardB !== null)
assert('board names the rewritten file', (boardB || '').includes('app.js'))
assert('board says it was a rewrite by A', (boardB || '').includes('rewrote') && (boardB || '').includes('A '))
assert('board records what was touched (login)', (boardB || '').includes('login'))
assert('the rewrite content itself still synced', (read(B) || '').includes('validate(user)'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
for (const p of procs) p.kill()
relay.kill()
fs.rmSync(path.resolve('.board-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
