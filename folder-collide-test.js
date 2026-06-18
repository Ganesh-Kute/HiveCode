// Proves the SYNC-LAYER fix end-to-end: two real folder.js processes, two
// separate directories (like your two machines/folders), both editing the SAME
// file at the same time. Before the fix the second write wiped the first; now
// reconcile() 3-way-merges so nobody's work is lost.
//
//   node folder-collide-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const PORT = 1240
const RELAY = `ws://localhost:${PORT}`
const ROOM = 'folder-collide'
const A = path.resolve('.collide-test/A')
const B = path.resolve('.collide-test/B')
const FILE = 'app.js'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const read = (dir) => { try { return fs.readFileSync(path.join(dir, FILE), 'utf8') } catch { return '<missing>' } }
const write = (dir, t) => fs.writeFileSync(path.join(dir, FILE), t)

// fresh dirs
fs.rmSync(path.resolve('.collide-test'), { recursive: true, force: true })
fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true })

const BASE = [
  'function login(user, pass) {',
  '  return check(user, pass)',
  '}',
  '',
  'function logout() {',
  '  clearSession()',
  '}',
].join('\n')
write(A, BASE) // A starts with the file; B will receive it

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
await sleep(2500) // let both connect and B pull BASE
assert('B received the file on join', read(B).includes('function login'))

// ===================================================================
console.log('\n# Two agents edit DIFFERENT functions in the same file, at once')
// A's agent rewrites login(); B's agent rewrites logout() — concurrently.
const aEdit = read(A).replace('return check(user, pass)', 'return check(user, pass) // A: added validation')
const bEdit = read(B).replace('clearSession()', 'clearSession() // B: also clear cache')
write(A, aEdit)
write(B, bEdit)
await sleep(3000) // let it propagate + reconcile

console.log('\n   --- final A/app.js ---\n' + read(A).split('\n').map((l) => '      ' + l).join('\n'))
const fa = read(A), fb = read(B)
assert('A still has A\'s edit', fa.includes('// A: added validation'))
assert('A ALSO has B\'s edit (not clobbered)', fa.includes('// B: also clear cache'))
assert('B has both edits too', fb.includes('// A: added validation') && fb.includes('// B: also clear cache'))
assert('both folders converged identically', fa === fb)

// ===================================================================
console.log('\n# Sequential edit on top of a teammate\'s change (realistic case)')
// A edits again, AFTER everything settled, building on the merged file.
write(A, read(A).replace('clearSession() // B: also clear cache', 'clearSession() // B: also clear cache\n  log("bye")'))
await sleep(2500)
const ga = read(A), gb = read(B)
assert('new edit kept', ga.includes('log("bye")'))
assert('earlier edits still present', ga.includes('// A: added validation') && ga.includes('// B: also clear cache'))
assert('still converged', ga === gb)

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
for (const p of procs) p.kill()
relay.kill()
fs.rmSync(path.resolve('.collide-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
