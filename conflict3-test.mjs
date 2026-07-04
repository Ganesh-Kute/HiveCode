// ADVERSARIAL: THREE clients edit the SAME line differently, concurrently.
// The core guarantee is "no silent loss". If the fork gate only surfaces two of the
// three versions, one agent's work is silently dropped — the exact failure the whole
// substrate claims to prevent. This test tries to break that.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from './sync.js'

const PORT = 1305
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = (port, env) => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }

const relay = await startRelay(PORT, { HIVE_PROVENANCE: 'strict' })
process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on' // exercise the experimental silent-fork gate
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-c3-'))
const room = 'c3-' + crypto.randomBytes(6).toString('hex')
const dirs = ['a', 'b', 'c'].map((n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d })
console.log(`3-WAY CONFLICT: A,B,C edit the SAME line, room ${room}\n`)
const [A, B, C] = dirs.map((d, i) => startSync({ relay: `ws://localhost:${PORT}`, room, dir: d, name: ['A', 'B', 'C'][i], kind: 'ai', log: () => {} }))
await sleep(3000)

// seed
A.claim('m.js', 'seed'); fs.writeFileSync(path.join(dirs[0], 'm.js'), 'function foo() {\n  return 1\n}\n'); await sleep(3000); A.release('m.js')
await sleep(2500)
T('B and C received the seed', fs.existsSync(path.join(dirs[1], 'm.js')) && fs.existsSync(path.join(dirs[2], 'm.js')))

// all three edit the SAME line differently, ~simultaneously
console.log('# A: return 1->return 2 | B: return 1->return 3 | C: return 1->return 4  (same line)')
const files = dirs.map((d) => path.join(d, 'm.js'))
fs.writeFileSync(files[0], fs.readFileSync(files[0], 'utf8').replace('return 1', 'return 2'))
fs.writeFileSync(files[1], fs.readFileSync(files[1], 'utf8').replace('return 1', 'return 3'))
fs.writeFileSync(files[2], fs.readFileSync(files[2], 'utf8').replace('return 1', 'return 4'))
await sleep(9000) // reconcile + fork detection

const copies = files.map((f) => fs.readFileSync(f, 'utf8'))
console.log('--- A ---\n' + copies[0] + '--- B ---\n' + copies[1] + '--- C ---\n' + copies[2] + '---------')
const has2 = copies.every((s) => s.includes('return 2'))
const has3 = copies.every((s) => s.includes('return 3'))
const has4 = copies.every((s) => s.includes('return 4'))
T('ALL THREE versions preserved (no silent drop)', has2 && has3 && has4)
T('conflict is marked on all peers', copies.every((s) => s.includes('<<<<<<<') && s.includes('>>>>>>>')))
T('all peers converged to the same state', copies[0] === copies[1] && copies[1] === copies[2])
// CLEANLINESS: a human must be able to resolve it. Exactly ONE conflict region, no
// glued/nested markers, balanced open/close.
const clean = (s) => {
  const opens = (s.match(/<<<<<<</g) || []).length
  const closes = (s.match(/>>>>>>>/g) || []).length
  const glued = /(>>>>>>>[^\n]*<<<<<<<)|(<<<<<<<[^\n]*<<<<<<<)/.test(s)
  return opens === 1 && closes === 1 && !glued
}
T('conflict block is CLEAN + human-resolvable (single region, no nested markers)', copies.every(clean))

for (const c of [A, B, C]) { try { c.stop() } catch {} }
relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\n=== 3-WAY CONFLICT: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED (silent loss or divergence)'} ===`)
process.exit(fail === 0 ? 0 : 1)
