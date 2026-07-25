// CONFLICT: two clients edit the SAME function differently -> must SURFACE a conflict
// (both versions kept with markers), never silently pick one and drop the other.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from './sync.js'

const PORT = 1302
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = (port, env) => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }

const relay = await startRelay(PORT, { HIVE_PROVENANCE: 'strict' })
process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on' // exercise the experimental silent-fork gate
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-conflict-'))
const room = 'conflict-' + crypto.randomBytes(6).toString('hex')
const dA = path.join(tmp, 'a'), dB = path.join(tmp, 'b'); fs.mkdirSync(dA, { recursive: true }); fs.mkdirSync(dB, { recursive: true })
console.log(`CONFLICT: 2 clients edit the SAME line, room ${room}\n`)
const A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dA, name: 'A', kind: 'ai', log: () => {} })
const B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
await sleep(3000)

// seed
A.claim('m.js', 'seed'); fs.writeFileSync(path.join(dA, 'm.js'), 'function foo() {\n  return 1\n}\n'); await sleep(3000); A.release('m.js')
await sleep(2500)
T('B received the seed', fs.existsSync(path.join(dB, 'm.js')))

// both edit the SAME line 'return 1' differently, ~simultaneously
console.log('# A: return 1 -> return 2   |   B: return 1 -> return 3  (same line)')
const eA = path.join(dA, 'm.js'), eB = path.join(dB, 'm.js')
fs.writeFileSync(eA, fs.readFileSync(eA, 'utf8').replace('return 1', 'return 2'))
fs.writeFileSync(eB, fs.readFileSync(eB, 'utf8').replace('return 1', 'return 3'))
await sleep(7000) // reconcile

const ca = fs.readFileSync(eA, 'utf8'), cb = fs.readFileSync(eB, 'utf8')
console.log('--- A copy ---\n' + ca + '--- B copy ---\n' + cb + '--------------')
const markers = (s) => s.includes('<<<<<<<') && s.includes('>>>>>>>')
const bothValues = (s) => s.includes('return 2') && s.includes('return 3')
// The guarantee: NO silent loss. Either conflict markers appear, or both values are kept.
const surfaced = (markers(ca) || bothValues(ca)) && (markers(cb) || bothValues(cb))
const silentLoss = (ca === 'function foo() {\n  return 2\n}\n' && cb === 'function foo() {\n  return 2\n}\n') || (ca === 'function foo() {\n  return 3\n}\n' && cb === 'function foo() {\n  return 3\n}\n')
T('conflict SURFACED (markers or both kept) on both peers', surfaced)
T('NO silent single-winner clobber', !silentLoss)
T('both peers agree on the same conflicted state (converged)', ca === cb)

for (const c of [A, B]) { try { c.stop() } catch {} }
relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\n=== CONFLICT: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
