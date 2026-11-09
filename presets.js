// presets — a room that is already configured, because nobody designs one from scratch at 6pm.
//
//   node presets.js "<relay|room>" <preset> --gate "npm test" [--dry-run]
//   node presets.js --list
//
// WHY THIS IS A BLOCKER AND NOT A NICETY. Every part needed to run a night shift already existed
// and none of it was assembled: a gate command, a state machine with transitions and requires,
// per-agent budgets, a roster with roles. Handing somebody those primitives and asking them to
// compose a safe configuration is the same as shipping nothing -- it is why people use compose
// files and starter workflows instead of writing their own. A preset is the assembled answer.
//
// WHAT A PRESET ACTUALLY SETS, all of it enforced somewhere real rather than described in a doc:
//   gate:cmd / gate:timeout   the handoff check. A failing check KEEPS the file with whoever
//                             broke it, so nobody downstream inherits it (hive-gate.js).
//   schema                    enum + transitions + requires on each state key. `requires` is the
//                             one that matters: it makes the contract executable, so a release
//                             cannot reach APPROVED while tests are RED, by construction rather
//                             than by everyone remembering.
//   budgets                   per-agent caps the relay enforces (governor.js). Every preset ships
//                             with them set, because an unattended roster without a spend cap is
//                             the configuration nobody should be running and the default should
//                             not be the dangerous one.
//   roster                    who to start and what each one is for. Advisory -- this file
//                             configures the room, it does not launch processes.
//
// TERMINAL STATES ARE PART OF THE DESIGN. `READY_FOR_HUMAN` is a legal end state in every preset
// here, and nothing may advance past it. The failure mode of an overnight roster is not that it
// does too little, it is waking up to 3,000 unreviewed lines -- morning review debt is a worse
// trade than no night shift at all. A roster that stops and says "this is ready for you" is
// finished; one that keeps going is accruing a bill.

import { realpathSync as __hiveRealpath } from 'fs'
import { resolve as __hiveResolve } from 'path'
import { fileURLToPath as __hiveFileURLToPath } from 'url'

export const PRESETS = {
  'review-loop': {
    title: 'Review loop',
    why: 'The default. Work never leaves its author until a check passes, so nobody inherits a broken file.',
    attended: true,
    roster: [
      { name: 'Builder', kind: 'ai', role: 'writes the change' },
      { name: 'Tester', kind: 'ai', role: 'runs the suite, sets tests' },
      { name: 'Reviewer', kind: 'ai', role: 'reads the diff, sets review' },
    ],
    gate: { timeoutMs: 120000 },
    state: { tests: 'UNKNOWN', review: 'PENDING' },
    schema: {
      tests: {
        enum: ['UNKNOWN', 'RUNNING', 'GREEN', 'RED'],
        transitions: { UNKNOWN: ['RUNNING'], RUNNING: ['GREEN', 'RED'], GREEN: ['RUNNING'], RED: ['RUNNING'] },
      },
      review: {
        enum: ['PENDING', 'CHANGES', 'APPROVED', 'READY_FOR_HUMAN'],
        transitions: { PENDING: ['CHANGES', 'APPROVED'], CHANGES: ['PENDING'], APPROVED: ['READY_FOR_HUMAN'], READY_FOR_HUMAN: [] },
        // The whole point of the preset in one line: approval is unreachable while tests are red.
        requires: { APPROVED: { tests: 'GREEN' } },
      },
    },
    budgets: { Builder: { minutes: 120, writes: 400 }, Tester: { minutes: 60, writes: 60 }, Reviewer: { minutes: 60, writes: 60 } },
    waits: {
      Tester: { key: 'tests', is: 'RUNNING' },
      Reviewer: { key: 'tests', is: 'GREEN' },
    },
  },

  'night-shift': {
    title: 'Night shift',
    why: 'The unattended roster. Same machinery as the review loop with tighter caps and a hard stop at READY_FOR_HUMAN, so the morning is a skim and not an audit.',
    attended: false,
    roster: [
      { name: 'Builder', kind: 'ai', role: 'takes the ticket, writes the change' },
      { name: 'Tester', kind: 'ai', role: 'runs the suite after every handoff' },
      { name: 'Reviewer', kind: 'ai', role: 'reviews, then parks the work for a human' },
    ],
    gate: { timeoutMs: 180000 },
    state: { tests: 'UNKNOWN', review: 'PENDING', shift: 'RUNNING' },
    schema: {
      tests: {
        enum: ['UNKNOWN', 'RUNNING', 'GREEN', 'RED'],
        transitions: { UNKNOWN: ['RUNNING'], RUNNING: ['GREEN', 'RED'], GREEN: ['RUNNING'], RED: ['RUNNING'] },
      },
      review: {
        enum: ['PENDING', 'CHANGES', 'APPROVED', 'READY_FOR_HUMAN'],
        transitions: { PENDING: ['CHANGES', 'APPROVED'], CHANGES: ['PENDING'], APPROVED: ['READY_FOR_HUMAN'], READY_FOR_HUMAN: [] },
        requires: { APPROVED: { tests: 'GREEN' } },
      },
      // Nothing ships overnight. The shift ends parked, never deployed.
      shift: { enum: ['RUNNING', 'PARKED'], transitions: { RUNNING: ['PARKED'], PARKED: [] }, requires: { PARKED: { review: 'READY_FOR_HUMAN' } } },
    },
    // Tighter than the attended preset ON PURPOSE. Nobody is watching, so the cap is the only
    // thing standing between a looping agent and an eight-hour bill.
    budgets: { Builder: { minutes: 240, writes: 600 }, Tester: { minutes: 120, writes: 120 }, Reviewer: { minutes: 120, writes: 120 } },
    waits: {
      Tester: { key: 'tests', is: 'RUNNING' },
      Reviewer: { key: 'tests', is: 'GREEN' },
    },
  },

  migration: {
    title: 'Migration crew',
    why: 'One mechanical change across many files. Parallel writers, one verifier, and the build gate stops a half-migrated tree from spreading.',
    attended: true,
    roster: [
      { name: 'Scout', kind: 'ai', role: 'finds every site that needs changing, assigns them out' },
      { name: 'Migrator-1', kind: 'ai', role: 'transforms assigned files' },
      { name: 'Migrator-2', kind: 'ai', role: 'transforms assigned files' },
      { name: 'Verifier', kind: 'ai', role: 'builds, and sets build' },
    ],
    gate: { timeoutMs: 300000 },
    state: { survey: 'PENDING', build: 'UNKNOWN' },
    schema: {
      survey: { enum: ['PENDING', 'DONE'], transitions: { PENDING: ['DONE'], DONE: [] } },
      build: {
        enum: ['UNKNOWN', 'RUNNING', 'GREEN', 'RED', 'READY_FOR_HUMAN'],
        transitions: { UNKNOWN: ['RUNNING'], RUNNING: ['GREEN', 'RED'], GREEN: ['RUNNING', 'READY_FOR_HUMAN'], RED: ['RUNNING'], READY_FOR_HUMAN: [] },
        // Migrators must not start before the survey exists, or two of them pick the same file.
        requires: { RUNNING: { survey: 'DONE' } },
      },
    },
    budgets: { Scout: { minutes: 60, writes: 40 }, 'Migrator-1': { minutes: 180, writes: 800 }, 'Migrator-2': { minutes: 180, writes: 800 }, Verifier: { minutes: 90, writes: 60 } },
    waits: { 'Migrator-1': { key: 'survey', is: 'DONE' }, 'Migrator-2': { key: 'survey', is: 'DONE' }, Verifier: { key: 'build', is: 'RUNNING' } },
  },
}

export const listPresets = () => Object.entries(PRESETS).map(([k, p]) => ({ name: k, title: p.title, why: p.why, agents: p.roster.length, attended: p.attended }))

/** What a preset would do, as data, so it can be printed before it is applied and asserted on in
 *  a test without a relay. A preset that cannot be inspected before it runs is one nobody trusts. */
export function planPreset(name, { gate = '' } = {}) {
  const p = PRESETS[name]
  if (!p) return { error: `Q540 no preset called "${name}". Have: ${Object.keys(PRESETS).join(', ')}` }
  const cmd = String(gate || '').trim()
  return {
    name,
    title: p.title,
    attended: p.attended,
    roster: p.roster,
    waits: p.waits,
    budgets: p.budgets,
    schema: p.schema,
    state: { ...p.state, ...(cmd ? { 'gate:cmd': cmd, 'gate:timeout': String(p.gate.timeoutMs) } : {}) },
    // A roster whose gate is unset runs with NO handoff check, which is the one thing every
    // preset here is built around. Say so rather than letting it look configured.
    warning: cmd ? '' : 'Q541 no --gate command: the handoff check is OFF, so a failing build will hand off like a passing one',
  }
}

/** Apply a plan to a live room. Order matters: the SCHEMA goes in before any value, or the very
 *  first state write is validated against nothing and a preset can seed a state its own machine
 *  would have rejected. */
export function applyPreset(hive, name, { gate = '' } = {}) {
  const plan = planPreset(name, { gate })
  if (plan.error) return plan
  for (const [key, rules] of Object.entries(plan.schema)) hive.setSchema(key, rules)
  const budgets = hive.doc.getMap('budgets')
  for (const [who, b] of Object.entries(plan.budgets)) budgets.set(who, b)
  const applied = []
  const refused = []
  for (const [key, val] of Object.entries(plan.state)) {
    // setState THROWS on an illegal move or an unmet guard rather than returning a verdict, and a
    // preset applied to a room that already has state will hit that. Without this catch the loop
    // aborts on the first refusal and leaves the room HALF configured -- schema and budgets in,
    // some state keys missing -- which is the worst of the three possible outcomes because it
    // looks like it worked. Collect the refusals and report them instead.
    try { hive.setState(key, val); applied.push(key) } catch (e) { refused.push({ key, val, why: e.message }) }
  }
  return { ...plan, applied, refused }
}

// ---- main -------------------------------------------------------------------------------
// Run directly? Compared by real path, as every shipped program does since 5c24d7d: the old
// `file:///${argv[1]}` test built "file:////..." on macOS and Linux and never matched, so
// `node presets.js --list` exited 0 having printed nothing (0.14.3 P1-12; not shipped, still used).
function __hiveIsEntry() {
  if (!process.argv[1]) return false
  const me = __hiveFileURLToPath(import.meta.url)
  try { return __hiveRealpath(process.argv[1]) === __hiveRealpath(me) } catch { return __hiveResolve(process.argv[1]) === __hiveResolve(me) }
}
if (__hiveIsEntry()) {
  const argv = process.argv.slice(2)
  const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || '') }
  if (argv.includes('--list') || !argv.length) {
    for (const p of listPresets()) {
      console.log(`\n  ${p.name}${p.attended ? '' : '   (unattended)'}\n    ${p.title} — ${p.agents} agents\n    ${p.why}`)
    }
    console.log('\n  usage: node presets.js "<relay|room>" <preset> --gate "npm test" [--dry-run]\n')
    process.exit(0)
  }
  const [LINK, NAME] = argv.filter((a) => !a.startsWith('--'))
  const plan = planPreset(NAME, { gate: flag('gate') })
  if (plan.error) { console.error(plan.error); process.exit(2) }
  console.log(`\n${plan.title}${plan.attended ? '' : '   (unattended)'}`)
  for (const r of plan.roster) console.log(`  ${r.name.padEnd(12)} ${r.role}${plan.waits[r.name] ? `   [wakes on ${plan.waits[r.name].key}=${plan.waits[r.name].is}]` : ''}`)
  console.log('\n  budgets (relay-enforced):')
  for (const [who, b] of Object.entries(plan.budgets)) console.log(`    ${who.padEnd(12)} ${Object.entries(b).map(([k, v]) => `${v} ${k}`).join(', ')}`)
  console.log('\n  state:', JSON.stringify(plan.state))
  if (plan.warning) console.log(`\n  ${plan.warning}`)
  if (argv.includes('--dry-run') || !LINK) { console.log('\n--dry-run: nothing applied\n'); process.exit(0) }

  const { startSync, parseLink } = await import('./sync.js')
  const { relay, room } = parseLink(LINK)
  const hive = startSync({
    relay, room, dir: (process.env.TEMP || '.') + '/hive-preset-' + room,
    name: flag('name', 'Ganesh'), kind: 'human', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {},
  })
  hive.provider.on('sync', (ok) => {
    if (!ok) return
    setTimeout(() => {
      const res = applyPreset(hive, NAME, { gate: flag('gate') })
      console.log(`\napplied to ${room}: ${res.applied.length} state key(s), ${Object.keys(res.budgets).length} budget(s), ${Object.keys(res.schema).length} schema(s)`)
      if (res.refused.length) console.log('refused:', JSON.stringify(res.refused))
      setTimeout(() => { try { hive.stop() } catch { /* going */ } process.exit(0) }, 600)
    }, 1500)
  })
  setTimeout(() => { console.error(`Q542 could not reach the relay at ${relay}`); process.exit(1) }, 20000)
}
