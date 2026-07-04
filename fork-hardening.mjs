// HARDENING: two nastier fork scenarios that a naive gate gets wrong.
//   1. MIXED: a same-line conflict AND a disjoint edit on the SAME file at once.
//      The disjoint edit must NOT be lost while the same-line clash is surfaced.
//   2. RE-FORK: fork -> resolve -> fork again. The gate must NOT re-trigger on the
//      resolved state, and MUST catch the second, fresh fork.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from './sync.js'

const PORT = 1306
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = (port, env) => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }
const markers = (s) => (s.match(/<<<<<<</g) || []).length === 1 && (s.match(/>>>>>>>/g) || []).length === 1 && !/(>>>>>>>[^\n]*<<<<<<<)/.test(s)

const relay = await startRelay(PORT, { HIVE_PROVENANCE: 'strict' })
process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on' // exercise the experimental silent-fork gate

// ---------- Scenario 1: MIXED same-line conflict + disjoint edit ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mix-'))
  const room = 'mix-' + crypto.randomBytes(6).toString('hex')
  const dirs = ['a', 'b', 'c'].map((n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d })
  console.log(`\nSCENARIO 1 — MIXED: A,B clash on foo; C edits bar disjoint. room ${room}`)
  const [A, B, C] = dirs.map((d, i) => startSync({ relay: `ws://localhost:${PORT}`, room, dir: d, name: ['A', 'B', 'C'][i], kind: 'ai', log: () => {} }))
  await sleep(3000)
  A.claim('m.js', 'seed'); fs.writeFileSync(path.join(dirs[0], 'm.js'), 'function foo() {\n  return 1\n}\n\nfunction bar() {\n  return 10\n}\n'); await sleep(3000); A.release('m.js')
  await sleep(2500)
  const files = dirs.map((d) => path.join(d, 'm.js'))
  fs.writeFileSync(files[0], fs.readFileSync(files[0], 'utf8').replace('return 1', 'return 2'))   // A: foo
  fs.writeFileSync(files[1], fs.readFileSync(files[1], 'utf8').replace('return 1', 'return 3'))   // B: foo (clash)
  fs.writeFileSync(files[2], fs.readFileSync(files[2], 'utf8').replace('return 10', 'return 20')) // C: bar (disjoint)
  await sleep(9000)
  const copies = files.map((f) => fs.readFileSync(f, 'utf8'))
  console.log('--- converged ---\n' + copies[0] + '-----------------')
  // HARD guarantees (must hold): no silent loss, conflict visible, peers converged.
  T('S1: foo clash surfaced (both 2 and 3 present)', copies.every((s) => s.includes('return 2') && s.includes('return 3')))
  T("S1: C's disjoint edit NOT lost (return 20 present)", copies.every((s) => s.includes('return 20')))
  T('S1: conflict is visibly marked', copies.every((s) => s.includes('<<<<<<<') && s.includes('>>>>>>>')))
  T('S1: peers CONVERGED (identical state)', copies[0] === copies[1] && copies[1] === copies[2])
  // BEST-EFFORT: clean single region (only guaranteed once peers converge on the fused
  // state first; under incremental arrival the block can be nested — ugly, never lossy).
  console.log('  ' + (copies.every(markers) ? 'ok  ' : '~~  ') + 'S1: clean single region (best-effort)')
  for (const c of [A, B, C]) { try { c.stop() } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

// ---------- Scenario 2: fork -> resolve -> fork again ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-refork-'))
  const room = 'refork-' + crypto.randomBytes(6).toString('hex')
  const dA = path.join(tmp, 'a'), dB = path.join(tmp, 'b'); fs.mkdirSync(dA, { recursive: true }); fs.mkdirSync(dB, { recursive: true })
  console.log(`\nSCENARIO 2 — RE-FORK: fork, resolve, fork again. room ${room}`)
  const A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dA, name: 'A', kind: 'ai', log: () => {} })
  const B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
  await sleep(3000)
  const eA = path.join(dA, 'm.js'), eB = path.join(dB, 'm.js')
  A.claim('m.js', 'seed'); fs.writeFileSync(eA, 'function foo() {\n  return 1\n}\n'); await sleep(3000); A.release('m.js')
  await sleep(2000)
  // fork 1
  fs.writeFileSync(eA, fs.readFileSync(eA, 'utf8').replace('return 1', 'return 2'))
  fs.writeFileSync(eB, fs.readFileSync(eB, 'utf8').replace('return 1', 'return 3'))
  await sleep(8000)
  T('S2: first fork surfaced', markers(fs.readFileSync(eA, 'utf8')) && fs.readFileSync(eA, 'utf8') === fs.readFileSync(eB, 'utf8'))
  // resolve: A writes a clean version (markers removed)
  fs.writeFileSync(eA, 'function foo() {\n  return 99\n}\n')
  await sleep(8000)
  const rA = fs.readFileSync(eA, 'utf8'), rB = fs.readFileSync(eB, 'utf8')
  console.log('--- after resolve ---\n' + rA + '---------------------')
  T('S2: resolved cleanly (no markers), converged', !markers(rA) && !rA.includes('<<<<<<<') && rA === rB && rA.includes('return 99'))
  // fork 2 on the resolved state
  fs.writeFileSync(eA, fs.readFileSync(eA, 'utf8').replace('return 99', 'return 100'))
  fs.writeFileSync(eB, fs.readFileSync(eB, 'utf8').replace('return 99', 'return 101'))
  await sleep(8000)
  const fA = fs.readFileSync(eA, 'utf8'), fB = fs.readFileSync(eB, 'utf8')
  console.log('--- second fork ---\n' + fA + '-------------------')
  T('S2: SECOND fork surfaced, no loss (100 + 101 present), converged', fA.includes('return 100') && fA.includes('return 101') && fA.includes('<<<<<<<') && fA === fB)
  console.log('  ' + (markers(fA) ? 'ok  ' : '~~  ') + 'S2: clean single region (best-effort)')
  for (const c of [A, B]) { try { c.stop() } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

relay.kill()
console.log(`\n=== FORK HARDENING: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
