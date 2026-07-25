// POISONED-DOC ROOT-CAUSE EXPERIMENT
// Hypothesis from the live runs: room-clean-run-9 "eats" ledger receipts because its
// file doc was live across a relay redeploy (restart with empty state). Reproduce
// locally: two signing clients collide (gate must catch, receipts land), then the
// relay is KILLED and RESTARTED mid-session (fresh memory, like a Render deploy),
// clients auto-reconnect, and they collide AGAIN. Run twice:
//   scenario A — relay WITHOUT persistence (Render free tier today)
//   scenario B — relay WITH HIVE_PERSIST_DIR   (the proposed fix)
// We audit after every phase: ledger length, receipt verification, gate behavior.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import { WebSocket } from 'ws'
import { startSync } from './sync.js'
import { verifyReceipt } from './substrate.js'

const PORT = 1341, FSEP = String.fromCharCode(1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'
const opens = (t) => (t.match(/^<<<<<<< /gm) || []).length

const startRelay = (env = {}) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_PROVENANCE: 'strict', ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}

async function audit(room, file) {
  const doc = new Y.Doc()
  const pr = new WebsocketProvider(`ws://localhost:${PORT}`, room + FSEP + file, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
  await new Promise((r) => { let d = 0; const f = () => { if (!d) { d = 1; r() } }; pr.on('sync', (s) => s && setTimeout(f, 800)); setTimeout(f, 8000) })
  const content = doc.getText('content').toString()
  const ledger = doc.getArray('ledger').toArray()
  const verified = ledger.filter((r) => verifyReceipt(r).ok)
  const out = { chars: content.length, markers: opens(content), ledger: ledger.length, verified: verified.length, authors: [...new Set(verified.map((r) => r.name))].sort(), line2: (content.match(/function two.*$/m) || ['?'])[0] }
  try { pr.destroy() } catch {}; doc.destroy()
  return out
}

async function scenario(label, relayEnv, opts = {}) {
  console.log(`\n===== SCENARIO ${label} =====`)
  let relay = await startRelay(relayEnv)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poison-'))
  const room = 'poison-' + crypto.randomBytes(5).toString('hex')
  const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)
  const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
  const A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dA, name: 'A', kind: 'ai', log: () => {} })
  const B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
  await sleep(2500)

  const base = 'function one() { return 1 }\n\nfunction two() { return 2 }\n'
  fs.writeFileSync(path.join(dA, 'm.js'), base)
  await sleep(4000)

  // PHASE 1: same-line collision on function one — pre-restart baseline
  const a1 = fs.readFileSync(path.join(dA, 'm.js'), 'utf8').replace('return 1', 'return 111')
  const b1 = fs.readFileSync(path.join(dB, 'm.js'), 'utf8').replace('return 1', 'return 222')
  fs.writeFileSync(path.join(dA, 'm.js'), a1); fs.writeFileSync(path.join(dB, 'm.js'), b1)
  await sleep(9000)
  const p1 = await audit(room, 'm.js')
  const disk1 = { A: fs.readFileSync(path.join(dA, 'm.js'), 'utf8'), B: fs.readFileSync(path.join(dB, 'm.js'), 'utf8') }
  console.log(`P1 collide      : markers A/B ${opens(disk1.A)}/${opens(disk1.B)} | both kept: ${disk1.A.includes('111') && disk1.A.includes('222')} | ledger ${p1.ledger} (verified ${p1.verified}) ${JSON.stringify(p1.authors)}`)

  // resolve so we enter the restart with a clean, agreed doc (like run-9 pre-window)
  const res = fs.readFileSync(path.join(dA, 'm.js'), 'utf8').replace(/<<<<<<<[\s\S]*?>>>>>>> [^\n]*\n?/, 'function one() { return 111 }\n')
  fs.writeFileSync(path.join(dA, 'm.js'), res)
  await sleep(8000)
  const p1r = await audit(room, 'm.js')
  console.log(`P1 resolved     : markers ${p1r.markers} | ledger ${p1r.ledger} (verified ${p1r.verified})`)

  // THE EVENT: relay dies and comes back EMPTY (unless persistence) mid-session
  console.log('>> RELAY RESTART (redeploy simulation)...')
  relay.kill()
  await sleep(2500)
  if (opts.wipeSnapshots && relayEnv.HIVE_PERSIST_DIR) {
    for (const f of fs.readdirSync(relayEnv.HIVE_PERSIST_DIR)) fs.rmSync(path.join(relayEnv.HIVE_PERSIST_DIR, f), { force: true })
    console.log('>> (snapshots wiped — persistence hooks active, no state to load)')
  }
  relay = await startRelay(relayEnv)
  await sleep(12000) // let providers reconnect + resync

  const pr = await audit(room, 'm.js')
  console.log(`post-restart    : chars ${pr.chars} | markers ${pr.markers} | ledger ${pr.ledger} (verified ${pr.verified}) ${JSON.stringify(pr.authors)}  <- did the doc survive?`)

  // PHASE 2: same-line collision on function two — the run-9 scenario
  const a2c = fs.readFileSync(path.join(dA, 'm.js'), 'utf8')
  const b2c = fs.readFileSync(path.join(dB, 'm.js'), 'utf8')
  fs.writeFileSync(path.join(dA, 'm.js'), a2c.replace('return 2', 'return 333'))
  fs.writeFileSync(path.join(dB, 'm.js'), b2c.replace('return 2', 'return 444'))
  await sleep(10000)
  const p2 = await audit(room, 'm.js')
  const disk2 = { A: fs.readFileSync(path.join(dA, 'm.js'), 'utf8'), B: fs.readFileSync(path.join(dB, 'm.js'), 'utf8') }
  const bothKept = disk2.A.includes('333') && disk2.A.includes('444')
  const fused = /return (334433|443344|343434|433433|3344|4433)/.test(disk2.A)
  console.log(`P2 collide      : markers A/B ${opens(disk2.A)}/${opens(disk2.B)} | both kept: ${bothKept} | fused-silently: ${fused || (!bothKept && opens(disk2.A) === 0)} | converged: ${disk2.A === disk2.B}`)
  console.log(`P2 ledger       : ${p2.ledger} receipts (verified ${p2.verified}) ${JSON.stringify(p2.authors)}  <- receipts eaten if < P1's ${p1r.ledger}+2`)
  console.log(`P2 relay content: "${p2.line2}"  <- did TEXT updates reach the relay?`)
  if (opens(disk2.A) === 0 && !bothKept) console.log('   !! GATE DID NOT FIRE post-restart — run-9 behavior REPRODUCED')
  if (p2.ledger < p1r.ledger) console.log('   !! LEDGER SHRANK — receipts eaten, run-9 behavior REPRODUCED')
  // GROUND TRUTH: where did the receipts go?
  const la = A.provenanceOf('m.js'), lb = B.provenanceOf('m.js')
  console.log(`ground truth    : client-A ledger ${la.length} | client-B ledger ${lb.length} | relay ${p2.ledger}`)
  console.log(`   client-A receipts: ${la.map((r) => `${r.name}:${(r.contentHash || '').slice(0, 6)}`).join(' ')}`)
  console.log(`   fused line      : ${(disk2.A.match(/function two.*$/m) || ['?'])[0]}`)
  // relay chat: what did the enforcement guard say?
  {
    const doc = new Y.Doc()
    const pr2 = new WebsocketProvider(`ws://localhost:${PORT}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
    await new Promise((r) => { let d = 0; const f = () => { if (!d) { d = 1; r() } }; pr2.on('sync', (s) => s && setTimeout(f, 800)); setTimeout(f, 6000) })
    const notes = doc.getArray('chat').toArray().filter((m) => m && /⛔/.test(m.text || '')).map((m) => m.text)
    console.log(`   relay ⛔ notes  : ${notes.length ? notes.join(' | ') : '(none)'}`)
    try { pr2.destroy() } catch {}; doc.destroy()
  }

  for (const c of [A, B]) { try { c.stop() } catch {} }
  relay.kill(); await sleep(500)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return { p1, p1r, pr, p2, gateFiredP2: opens(disk2.A) === 1 && bothKept, converged: disk2.A === disk2.B }
}

const which = process.argv[2] || 'AB'
const results = {}
if (which.includes('A')) results.A = await scenario('A: NO persistence', {})
if (which.includes('B')) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-persist-')); results.B = await scenario('B: persist + strict', { HIVE_PERSIST_DIR: d }); try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
if (which.includes('C')) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-persist-')); results.C = await scenario('C: persist + AUDIT mode', { HIVE_PERSIST_DIR: d, HIVE_PROVENANCE: 'audit' }); try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
if (which.includes('D')) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-persist-')); results.D = await scenario('D: persist hooks, SNAPSHOT WIPED at restart', { HIVE_PERSIST_DIR: d }, { wipeSnapshots: true }); try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }

console.log('\n===== VERDICT =====')
for (const [k, r] of Object.entries(results))
  console.log(`${k}: post-restart ledger ${r.pr.ledger}, P2 gate fired: ${r.gateFiredP2}, P2 relay ledger ${r.p2.ledger} (verified ${r.p2.verified}), converged: ${r.converged}`)
process.exit(0)
