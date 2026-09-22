// presets: a configured room, and the configuration has to actually hold.
//
//   node tests/hive-preset-test.mjs
//
// A preset is only worth shipping if the thing it sets up REFUSES something. So the assertions
// here are not "the keys were written" -- they are: the state machine rejects an illegal move,
// approval is unreachable while tests are red, and the budgets the preset wrote are the ones the
// relay's governor ends up enforcing. If a preset can be talked out of its own rules it is a
// document, not a configuration.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { PRESETS, listPresets, planPreset, applyPreset } from '../presets.js'
import { makeGovernor } from '../governor.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1295
const ROOM = 'preset-test-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- the plans -----------------------------------------------------------------------------
console.log('\n# the presets themselves')
{
  T('there are presets to choose from', listPresets().length >= 3, listPresets().map((p) => p.name).join(', '))
  T('an unknown preset names the ones that exist', /no preset called/.test(planPreset('nope').error || ''))

  for (const [name, p] of Object.entries(PRESETS)) {
    // Every preset must be able to STOP. A roster with no terminal state accrues review debt all
    // night, which is a worse trade than not running it.
    const terminal = Object.values(p.schema).some((r) => (r.transitions || {}).READY_FOR_HUMAN && (r.transitions || {}).READY_FOR_HUMAN.length === 0)
    T(`${name}: has a terminal state so the shift can END`, terminal)
    // And every agent in every preset must have a cap. The default must not be the dangerous one.
    const uncapped = p.roster.filter((r) => !p.budgets[r.name])
    T(`${name}: every agent has a relay-enforced budget`, uncapped.length === 0, uncapped.map((r) => r.name).join(',') || 'all capped')
  }

  const plan = planPreset('review-loop', { gate: 'npm test' })
  T('the gate command lands in room state', plan.state['gate:cmd'] === 'npm test')
  T('a preset with no gate SAYS its check is off rather than looking configured',
    /Q541/.test(planPreset('review-loop').warning))
  T('the unattended preset caps tighter than nothing', PRESETS['night-shift'].budgets.Builder.minutes > 0)
  T('agents are told what to wake on, so the roster does not need @mentions',
    plan.waits.Reviewer.key === 'tests' && plan.waits.Reviewer.is === 'GREEN', JSON.stringify(plan.waits.Reviewer))
}

// ---- against a real room -------------------------------------------------------------------
console.log('\n# applied to a real room: does it refuse anything?')
let relay = null
const clients = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-preset-t-'))
try {
  relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  relay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })

  const boss = startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: fs.mkdtempSync(path.join(tmp, 'boss')),
    name: 'Ganesh', kind: 'human', syncFiles: false, log: () => {},
  })
  clients.push(boss)
  await sleep(2500)

  const res = applyPreset(boss, 'review-loop', { gate: 'npm test' })
  await sleep(1000)
  T('the preset applied without refusals', res.refused.length === 0, JSON.stringify(res.refused))
  T('the gate command is live in the room', boss.gate() && boss.gate().cmd === 'npm test', JSON.stringify(boss.gate()))

  // setState THROWS on a refusal rather than returning a verdict, so a refusal is a caught error.
  const move = (k, v) => { try { boss.setState(k, v); return { ok: true } } catch (e) { return { ok: false, why: e.message } } }

  // THE ONE THAT MATTERS: the machine refuses an illegal move.
  const illegal = move('tests', 'GREEN')       // UNKNOWN -> GREEN is not a legal transition
  T('an illegal transition is REFUSED', illegal.ok === false, illegal.why)
  T('and the refusal says what WAS legal', /Legal from UNKNOWN: RUNNING/.test(illegal.why || ''), illegal.why)
  T('and the legal one is allowed', move('tests', 'RUNNING').ok === true)

  // requires: approval is unreachable while tests are red. This is the line the whole preset
  // exists for -- a release gate that holds by construction rather than by everyone remembering.
  move('tests', 'RED')
  const blocked = move('review', 'APPROVED')
  T('APPROVAL IS UNREACHABLE WHILE TESTS ARE RED', blocked.ok === false, blocked.why)
  move('tests', 'RUNNING'); move('tests', 'GREEN')
  T('and reachable once they are green', move('review', 'APPROVED').ok === true)

  T('the shift can reach its terminal state', move('review', 'READY_FOR_HUMAN').ok === true)
  const past = move('review', 'PENDING')
  T('and nothing may advance past it', past.ok === false, past.why)

  // A preset re-applied to a room that already moved on must not abort half way through.
  const again = applyPreset(boss, 'review-loop', { gate: 'npm test' })
  T('re-applying to a live room reports refusals instead of aborting',
    again.refused.length > 0 && again.applied.length > 0,
    `applied=${again.applied.length} refused=${again.refused.length}`)

  // The budgets the preset wrote must be the ones the relay ends up enforcing -- otherwise the
  // caps are decoration in a document nobody reads.
  const written = boss.doc.getMap('budgets').toJSON()
  T('budgets were written into room state', !!written.Builder && written.Builder.minutes === 120, JSON.stringify(written.Builder))
  const gov = makeGovernor()
  gov.attach(ROOM, boss.doc)
  T('the governor adopts exactly those budgets on attach',
    JSON.stringify(gov.budgetOf(ROOM, 'Builder')) === JSON.stringify({ minutes: 120, writes: 400 }),
    JSON.stringify(gov.budgetOf(ROOM, 'Builder')))
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  try { relay && relay.kill() } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
