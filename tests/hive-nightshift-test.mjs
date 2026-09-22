// THE NIGHT SHIFT, compressed: ticket in, work done, gate run, parked for a human — unattended.
//
//   node tests/hive-nightshift-test.mjs
//
// WHAT THIS IS AND IS NOT. It is the four blockers wired together and run as one loop with nobody
// steering: a preset configures the room, agents wake on STATE rather than on being messaged, the
// relay's governor caps what each one may spend, and the state machine refuses to let anything
// advance past READY_FOR_HUMAN. Every component is the real one — real relay, real CRDT, real
// gate subprocess, real budgets.
//
// It is NOT proof that agents are smart enough to run overnight. The three participants here are
// scripted, so what is under test is the MACHINERY, not the judgement. And it runs in minutes,
// not eight hours. Those two limits are the honest gap between this and the claim, and no amount
// of green here closes them: the only thing that closes them is a real roster, real models, one
// real night. What this does establish is that if that run goes wrong, the controls hold.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { applyPreset, PRESETS } from '../presets.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1297
const ROOM = 'night-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const step = (s) => console.log(`\n--- ${s}`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-night-'))
let relay = null
const clients = []
try {
  relay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_GOVERNOR: 'on', HIVE_ENFORCE_CLAIMS: 'block' },
  })
  relay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })

  const dirs = {}
  const mk = (name, kind) => {
    dirs[name] = fs.mkdtempSync(path.join(tmp, name))
    const c = startSync({ relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: dirs[name], name, kind, syncFiles: true, log: () => {} })
    clients.push(c)
    return c
  }

  // 18:00 — the person configures the room and leaves.
  step('18:00  the room is configured, and the human goes home')
  const boss = mk('Ganesh', 'human')
  await sleep(2000)
  // A gate that genuinely runs: node exits 0 only when the file contains DONE.
  const gateCmd = `node -e "process.exit(require('fs').readFileSync('feature.js','utf8').includes('DONE')?0:1)"`
  const applied = applyPreset(boss, 'night-shift', { gate: gateCmd })
  await sleep(1200)
  T('the preset configured the room', applied.refused.length === 0, JSON.stringify(applied.refused))
  T('the gate is live', boss.gate() && boss.gate().cmd === gateCmd)
  T('every agent has a spend cap before anyone starts',
    Object.keys(boss.doc.getMap('budgets').toJSON()).length === PRESETS['night-shift'].roster.length)

  const Builder = mk('Builder', 'ai')
  const Tester = mk('Tester', 'ai')
  const Reviewer = mk('Reviewer', 'ai')
  await sleep(2500)
  T('the roster is in the room', boss.members().filter((p) => p.kind === 'ai').length === 3)

  // The Reviewer does what the preset tells it to: it waits on STATE, and nobody will @ it.
  // Before wake-on-state this is the line the whole night hung on.
  const reviewerWoke = new Promise((resolve) => {
    const st = Reviewer.doc.getMap('swarm_state')
    const check = () => { if (st.get('tests') === 'GREEN') { st.unobserve(check); resolve(Date.now()) } }
    st.observe(check)
  })

  // 23:40 — a ticket becomes work and the Builder writes it.
  step('23:40  a ticket becomes work; the Builder writes it')
  const tid = boss.assign('Builder', 'ENG-7: add the feature flag')
  await sleep(1200)
  T('the work is on the board', Builder.myTasks().some((t) => t.id === tid))

  Builder.claim('feature.js', 'add the flag')
  fs.writeFileSync(path.join(dirs.Builder, 'feature.js'), 'export const flag = true // WIP\n')
  await sleep(3500)

  // THE GATE. The file does not say DONE, so the handoff must be refused and the file must
  // stay with the Builder -- nobody downstream inherits half a feature at midnight.
  const refused = Builder.release('feature.js')
  T('a failing gate REFUSES the handoff', refused && refused.ok === false, JSON.stringify(refused && refused.reason || refused))
  T('and the file is still the Builder\'s', (boss.doc.getMap('claims').get('feature.js') || {}).by === 'Builder')

  fs.writeFileSync(path.join(dirs.Builder, 'feature.js'), 'export const flag = true // DONE\n')
  await sleep(3000)
  const letGo = Builder.release('feature.js')
  T('a passing gate lets it go', letGo && letGo.ok !== false, JSON.stringify(letGo))

  // 23:55 — the Tester runs, and sets state. It messages nobody.
  step('23:55  the Tester reports; it @-mentions nobody')
  Tester.setState('tests', 'RUNNING')
  await sleep(800)
  Tester.setState('tests', 'GREEN')
  const wokeAt = await Promise.race([reviewerWoke, sleep(6000).then(() => null)])
  T('THE REVIEWER WOKE ON STATE, with no message addressed to it', wokeAt !== null)

  // 00:05 — the Reviewer parks it. Nothing ships overnight.
  step('00:05  the Reviewer parks the work for the morning')
  Reviewer.setState('review', 'APPROVED')
  await sleep(600)
  Reviewer.setState('review', 'READY_FOR_HUMAN')
  await sleep(600)
  Reviewer.setState('shift', 'PARKED')
  await sleep(1000)
  T('the shift reached its terminal state', boss.getState().shift === 'PARKED')

  let pastEnd = null
  try { Reviewer.setState('review', 'PENDING'); pastEnd = 'ALLOWED' } catch (e) { pastEnd = e.message }
  T('and NOTHING may advance past it — no work continues after parking', /Transition Error/.test(pastEnd), pastEnd)

  // And the two controls that make leaving possible at all.
  step('the two controls that made leaving possible')
  boss.control('Builder', 'paused', 'Ganesh')
  await sleep(1200)
  const before = (() => { try { return fs.readFileSync(path.join(dirs.Ganesh, 'feature.js'), 'utf8') } catch { return '' } })()
  fs.writeFileSync(path.join(dirs.Builder, 'feature.js'), 'export const flag = true // MIDNIGHT NONSENSE\n')
  await sleep(4000)
  const after = (() => { try { return fs.readFileSync(path.join(dirs.Ganesh, 'feature.js'), 'utf8') } catch { return '' } })()
  T('the stop button holds against a live agent', after === before && !/NONSENSE/.test(after), JSON.stringify(after))

  Builder.control('Builder', 'running', 'Builder')
  await sleep(2000)
  T('and the agent cannot lift it itself',
    (boss.doc.getMap('controls').get('Builder') || {}).state === 'paused',
    JSON.stringify(boss.doc.getMap('controls').get('Builder')))

  // A budget of one write, set on a fresh participant, must stop it by itself.
  const Runaway = mk('Runaway', 'ai')
  await sleep(1500)
  boss.doc.getMap('budgets').set('Runaway', { writes: 1 })
  await sleep(1200)
  fs.writeFileSync(path.join(dirs.Runaway, 'loop.js'), 'export const a = 1\n')
  await sleep(3000)
  fs.writeFileSync(path.join(dirs.Runaway, 'loop.js'), 'export const a = 2\n')
  await sleep(3500)
  const ctl = boss.doc.getMap('controls').get('Runaway')
  T('A SPEND CAP PRESSES THE BUTTON BY ITSELF', !!ctl && ctl.state === 'paused', JSON.stringify(ctl))
  T('and it says which budget ran out', !!ctl && /writes/.test(ctl.why || ''), ctl && ctl.why)

  step('morning')
  console.log(`      state: ${JSON.stringify(boss.getState())}`)
  console.log(`      file:  ${JSON.stringify(after)}`)
} catch (e) {
  T('the night ran', false, e.message)
} finally {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  try { relay && relay.kill() } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
