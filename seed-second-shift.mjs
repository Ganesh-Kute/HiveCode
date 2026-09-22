// Seed THE SECOND SHIFT — the workflow, as a live map.
//
//   node seed-second-shift.mjs "ws://127.0.0.1:1234|second-shift" [YourName] [--clear]
//
// `seed-hivecode-full.mjs` draws the SYSTEM — what is built. This draws the WORKFLOW — how a team
// actually spends a day inside it, both shifts, plus the three things still missing before anyone
// could live this way. Written from WORKFLOW.md, 16 Sep 2026.
//
// STATES ARE CLAIMS ABOUT REALITY, NOT WISHES.
//   built    verified working -- it was run
//   wip      exists and is being worked on, or exists and is not yet shipped
//   broken   verified failing
//   planned  agreed to exist, no code
// The three blockers are `planned` and sit in the `gap` group, which the renderer draws red. That
// is deliberate: the most useful thing this map can do at a glance is show what is NOT there.

import { startSync, parseLink } from './sync.js'
import { applyCommand } from './hive-map.js'

const [, , LINK = '', NAME = 'seed'] = process.argv
const CLEAR = process.argv.includes('--clear')
if (!LINK) { console.error('usage: node seed-second-shift.mjs "<relay|room>" [YourName] [--clear]'); process.exit(2) }

// id, label, kind, state, file, note, group
const NODES = [
  // ── the workflow itself ───────────────────────────────────────────────────────────────────
  ['second-shift', 'THE SECOND SHIFT', 'milestone', 'wip', 'WORKFLOW.md', 'Your team goes home at 6. Your agents do not. One product, two shifts — it has to be good at both or it is a novelty.', 'core'],
  ['day', 'DAY SHIFT — removes the WAIT', 'milestone', 'wip', '', 'People present. Review, test and deploy are participants in the room, not stages in a queue, so done-to-verified collapses from hours to seconds.', 'core'],
  ['night', 'NIGHT SHIFT — keeps WORKING', 'milestone', 'planned', '', 'Nobody present. Blocked on one thing only: you cannot ask anyone to leave agents running if they cannot stop them from a phone.', 'core'],
  ['control-lets-you-leave', 'CONTROL IS WHAT LETS YOU LEAVE', 'rule', 'built', '', 'The reframe. Control was sold as a property — scope, receipts, undo — and a property is not a reason to install anything. It is the precondition for walking away.', 'rule'],

  // ── the day, as a sequence ────────────────────────────────────────────────────────────────
  ['d1', '09:40 · claim granted', 'step', 'built', 'hive-coord.js', "Rai's agent claims routes.ts.", 'flow'],
  ['d2', '10:15 · second claim REFUSED', 'step', 'built', 'server.js', "Alex's agent asks for the same file. Refused by the relay — not a prompt it can argue with. It goes elsewhere.", 'flow'],
  ['d3', '10:16 · read, not reinvent', 'step', 'built', 'sync.js', "Rai's route is in every editor in ~1s, so Alex's agent READS it instead of writing a second version. The duplicate is never written — the biggest saving, and it happens before anything needs resolving.", 'flow'],
  ['d4', '10:50 · release', 'step', 'built', 'sync.js', 'Handoff requested.', 'flow'],
  ['d5', '10:50 · gate runs, FAILS', 'step', 'built', 'hive-gate.js', "Runs the team's test command in Rai's OWN folder. It fails, so the file stays with Rai. Nobody downstream pulls the broken version.", 'flow'],
  ['d6', '10:52 · reviewer approves', 'step', 'wip', 'hive-mcp.js', 'The reviewer is already in the room, already on the same file. No branch, no PR, nobody interrupted.', 'flow'],
  ['d7', 'the round trip is gone', 'outcome', 'wip', '', 'No branch to push, no queue to wait in. This is the day-mode claim and it has to stand alone — a tool people only use overnight gets uninstalled.', 'proof'],

  // ── the night, as a sequence ──────────────────────────────────────────────────────────────
  ['n1', '18:00 · laptops close', 'step', 'built', 'server.js', 'The room does not close. It lives on the relay, not on anyone machine.', 'flow'],
  ['n2', '18:00-09:00 · roster works', 'step', 'planned', '', 'Claim, work, release, gate, repeat. Waiting agents cost ZERO tokens.', 'flow'],
  ['n3', 'broken work never propagates', 'step', 'built', 'hive-gate.js', 'A failing check keeps the file with whoever broke it, so the next agent never inherits it.', 'flow'],
  ['n4', '23:00 · you do NOT look', 'step', 'wip', 'public/control.html', 'THE PRODUCT. The phone view exists so you CAN, never so you MUST — a workflow whose promise is "now you have something to watch at night" is a pager, and nobody adopts a pager. Safety comes from bounds it cannot cross, not from you watching.', 'flow'],
  ['n5', '09:00 · you skim, you do not audit', 'step', 'wip', 'substrate.js', 'Already reviewed, already gated, individually revertable. "6 tickets closed, each passed, a revert button per agent."', 'flow'],

  // ── the roster ────────────────────────────────────────────────────────────────────────────
  ['role-dev', 'dev + AI (x5)', 'agent', 'built', '', "Wakes when the person works. Scope: their feature's files.", 'ipc'],
  ['role-reviewer', 'Reviewer', 'agent', 'planned', '', 'Wakes on a release. Read-only on everything.', 'ipc'],
  ['role-tests', 'Test runner', 'agent', 'planned', '', 'Wakes on a release. Owns the gate command.', 'ipc'],
  ['role-deployer', 'Deployer', 'agent', 'planned', '', 'Wakes at TESTED. Deploy config only — CANNOT RECEIVE SOURCE. Not instructed: never sent. This is the clearest line between a room and an agent framework.', 'ipc'],
  ['role-supervisor', 'Supervisor', 'agent', 'planned', '', 'Wakes on a blocked or unclaimed task. Owns the board, not the code.', 'ipc'],
  ['role-docs', 'Docs', 'agent', 'planned', '', 'Wakes only when a public signature changes. docs/ only.', 'ipc'],
  ['idle-free', 'a seat costs nothing while asleep', 'rule', 'built', 'hive-await.js', 'hive_wait BLOCKS rather than polls. This is what makes a standing roster affordable — you are not paying six agents to idle.', 'sched'],

  // ── the primitives each worry maps to ─────────────────────────────────────────────────────
  ['w-touch', '"what can it touch?"', 'question', 'built', 'token.js', 'Scoped tokens. An out-of-scope file is NEVER SENT — not hidden, not refused. It cannot act on what it never received.', 'perms'],
  ['w-break', '"what if it breaks the build for everyone?"', 'question', 'built', 'hive-gate.js', 'The release gate. 55/55, live-proven that a failing check holds the claim and the second agent still cannot take the file.', 'policy'],
  ['w-collide', '"what if two collide?"', 'question', 'built', 'hive-coord.js', 'Claims, refused server-side and replayed after release.', 'locks'],
  ['w-did', '"what did it actually do?"', 'question', 'built', 'substrate.js', 'Ed25519-signed receipts, per participant. A framework runs six agents as one process and cannot attribute anything.', 'audit'],
  ['w-undo', '"how do I undo just the bad one?"', 'question', 'built', 'sync.js', 'revertAuthor(who, since) — one agent out, everyone else intact.', 'audit'],
  ['w-cost', '"what does idling cost?"', 'question', 'built', 'hive-await.js', 'Nothing.', 'sched'],
  ['w-stop', '"how do I STOP it from my phone?"', 'question', 'planned', '', 'Unanswered. This is the one that blocks the night shift.', 'gap'],

  // ── the three blockers ────────────────────────────────────────────────────────────────────
  ['stop-button', 'THE STOP BUTTON', 'capability', 'planned', '', 'hive_pause(who|all) / hive_resume, a paused set in room state, the relay refusing a paused participant write, and one button per seat in the control room. Must be RELAY-ENFORCED for the same reason claims are — pausing cannot depend on the agent choosing to obey.', 'gap'],
  ['wake-on-state', 'WAKE-ON-STATE', 'capability', 'planned', 'hive-await.js', 'hive_wait returns on @mention or assigned work, not on a state change — so every roster depends on agents REMEMBERING to address each other, which is prompting, which is what we sell the alternative to. Needs a state predicate beside wakeOn:mention. The state map already broadcasts; this is a wait condition, not new plumbing.', 'gap'],
  ['no-pager', 'DO NOT BUILD A PAGER', 'rule', 'planned', '', 'Failure mode 1. If the promise is "watch your agents at night" it is strictly more work than not having it, and devs hate pagers more than any other part of the job. Ganesh caught this, 16 Sep.', 'gap'],
  ['review-debt', 'DO NOT CREATE MORNING REVIEW DEBT', 'rule', 'planned', '', 'Failure mode 2, worse than the first. Waking to 3,000 lines of unreviewed overnight AI code trades "work did not happen" for "review debt I now owe". The reviewer and test agents must be IN the roster, and READY_FOR_HUMAN must be a valid terminal state.', 'gap'],
  ['spend-cap', 'SPEND CAPS', 'capability', 'planned', '', 'Idle is free. WRONG IS NOT. An agent burning 15 hours on the wrong thing costs 15 hours of tokens and you find out in the morning. Per-participant budget (N tokens or N minutes), relay-enforced. Without it, "go home and leave them running" is a sentence nobody acts on.', 'gap'],
  ['presets', 'PRESETS', 'capability', 'planned', '', 'hivecode init --preset <name> writes the state machine, gate command, roles and scopes. Nobody designs a roster from scratch, so without this nobody ever starts.', 'gap'],
  ['preset-review', 'preset: review-loop', 'capability', 'built', 'hive-gate.js', 'The only one proven end to end. 5 devs + reviewer + test runner, gate = the team test command.', 'proof'],
  ['preset-migration', 'preset: migration-crew', 'capability', 'planned', '', 'One refactor agent across 200 files while five devs keep working. No freeze and nothing goes stale, because there is no separate copy to go stale. A composition of built pieces, never run together.', 'gap'],
  ['preset-overnight', 'preset: overnight-crew', 'capability', 'planned', '', 'Supervisor + 3 workers + tests + reviewer, nobody awake. Measure: tickets closed with no human present. Never run together.', 'gap'],

  // ── the boundaries: what we replace, keep, add ────────────────────────────────────────────
  ['boundary', 'THE BOUNDARY RULE', 'rule', 'built', 'WORKFLOW.md', 'Change everything INSIDE the box and nothing at the edges. Replacing a team whole toolchain is how an infra product dies — every tool you displace is a separate argument you must win before anyone can try yours.', 'rule'],
  ['room-out-pr', "THE ROOM'S OUTPUT IS A PR", 'rule', 'planned', '', 'Linear ticket -> [room: live work, agents, claims, gate] -> PR -> CI -> deploy. Asking a team to abandon pull requests is an enormous ask — PRs are how review, compliance and audit happen and are often mandatory for reasons nobody on the team controls. So do not ask. This is how Docker fitted in: it did not replace your deploy, it changed what you shipped.', 'rule'],

  ['rep-prwait', 'REPLACE: the branch->PR->wait cycle', 'outcome', 'wip', '', 'Waiting for review is the largest non-coding delay in a real team — hours, often overnight, because the reviewer is mid-task and will not context-switch. Hours become seconds when the reviewer is already in the room.', 'proof'],
  ['rep-standup', 'REPLACE: the standup', 'outcome', 'wip', 'hive-coord.js', 'The claims board answers "who is on what, who is blocked" continuously and live. Nobody needs to say it out loud at 10am.', 'proof'],
  ['rep-gap', 'FILL: the 6pm-9am gap', 'outcome', 'planned', '', 'There is no tool for this today. Not displacing anything — filling an empty slot, which is a far easier sell than taking something away.', 'proof'],

  ['keep-tracker', 'KEEP: Linear / Jira', 'external', 'built', '', 'Teams LIVE in it. Our board will not beat Linear and trying is how we lose the deal.', 'surface'],
  ['keep-slack', 'KEEP: Slack', 'external', 'built', '', 'They will not move their conversation into our control room. Humans stay in Slack.', 'surface'],
  ['keep-git', 'KEEP: git', 'external', 'built', '', 'The permanent record that CI, deploy, rollback, compliance and every audit hang off. We are the live layer above it, never a replacement.', 'surface'],
  ['keep-ci', 'KEEP: CI', 'external', 'built', '', 'Our gate is a PRE-HANDOFF check in one person own folder. CI is the shared check on the real branch. Different jobs — do not conflate them.', 'surface'],

  ['adapt-ticket', 'ADD: ticket in', 'capability', 'planned', '', 'A Linear/Jira/GitHub issue becomes a room task. Without it the room is somewhere you have to REMEMBER to go.', 'dist'],
  ['adapt-slack', 'ADD: Slack out', 'capability', 'planned', '', 'The room posts to Slack; a human replies from Slack and the agent hears it. Never ask them to live in our UI.', 'dist'],
  ['adapt-pr', 'ADD: PR out', 'capability', 'planned', '', 'Work in the room lands as a pull request. This is the EXIT, not a competitor — the one place git belongs in the story.', 'dist'],

  // ── what it runs on ───────────────────────────────────────────────────────────────────────
  ['relay', 'the relay', 'service', 'built', 'server.js', 'The only thing that DECIDES. No model is ever asked.', 'medium'],
  ['room', 'the persistent room', 'service', 'built', 'sync.js', 'One Yjs doc per file. Lives on the relay, not on a laptop — which is the entire reason the night shift is possible.', 'medium'],
  ['state-machine', 'state machine (requires)', 'service', 'built', 'hive-mcp.js', 'hive_set_schema with transitions and requires, enforced at the relay. An agent cannot reach DEPLOYED without passing TESTED, however confidently it believes it tested.', 'policy'],
  ['control-room', 'the control room', 'surface', 'wip', 'public/control.html', 'Live members, chat, tasks, files — and you can message into it. Needs the stop button and a phone layout.', 'surface'],
  ['telegram', 'Telegram', 'surface', 'built', '', 'Inbound proven with 18 real messages. The 23:00 check happens here.', 'surface'],
  ['maritime', 'Maritime hosts ($1/mo)', 'surface', 'built', '', 'Always-on containers for the roster. Three already running: hive-2, hive-3, hive-probe.', 'dist'],

  // ── the objection, answered ───────────────────────────────────────────────────────────────
  ['objection', '"they can build the QA agent without us"', 'rule', 'built', '', 'TRUE for one person on one machine — say so, and tell them to use a framework. A framework runs the crew in ONE PROCESS on ONE COPY, humans outside it, every rule a prompt the agent can talk itself out of.', 'rule'],
  ['answer', 'the room is shared; the rules are enforced', 'rule', 'built', '', 'The line: more than one machine, or any human in the loop, and the framework has no answer — its whole model is one process holding all the state.', 'rule'],
]

const NEEDS = [
  ['second-shift', 'day', 'has to be good at both'],
  ['second-shift', 'night', 'has to be good at both'],
  ['second-shift', 'control-lets-you-leave', 'the reframe that makes it sell'],
  ['night', 'stop-button', 'HARD BLOCKER — nothing halts an agent mid-work'],
  ['night', 'spend-cap', 'BLOCKER — wrong is not free'],
  ['night', 'no-pager', 'the promise is that you do not have to watch'],
  ['night', 'review-debt', 'the morning must be a skim, not an audit'],
  ['review-debt', 'role-reviewer', 'this is why the reviewer is in the NIGHT roster'],
  ['review-debt', 'state-machine', 'READY_FOR_HUMAN as a terminal state'],
  ['no-pager', 'w-touch', 'bounds it cannot cross, instead of you watching'],
  ['no-pager', 'w-break', ''],
  ['night', 'wake-on-state', 'else the roster depends on agents addressing each other'],
  ['day', 'role-reviewer', 'the round trip only collapses if review is in the room'],
  ['day', 'role-tests', ''],
  ['night', 'role-supervisor', 'something has to assign while nobody is awake'],
  ['night', 'maritime', 'the roster needs a host that is not a laptop'],
  ['night', 'room', 'the room outlives the session'],

  ['control-lets-you-leave', 'w-touch', ''],
  ['control-lets-you-leave', 'w-break', ''],
  ['control-lets-you-leave', 'w-collide', ''],
  ['control-lets-you-leave', 'w-did', ''],
  ['control-lets-you-leave', 'w-undo', ''],
  ['control-lets-you-leave', 'w-cost', ''],
  ['control-lets-you-leave', 'w-stop', 'the only one unanswered'],
  ['w-stop', 'stop-button', ''],

  ['stop-button', 'relay', 'must be relay-enforced, like claims'],
  ['stop-button', 'control-room', 'one button per seat, plus pause-all'],
  ['wake-on-state', 'state-machine', 'the predicate it waits on'],
  ['presets', 'preset-review', 'the one that is proven'],
  ['presets', 'preset-migration', ''],
  ['presets', 'preset-overnight', ''],
  ['preset-review', 'w-break', 'the gate is its whole point'],

  ['role-deployer', 'w-touch', 'takes part in the workflow, cannot receive source'],
  ['role-dev', 'w-collide', ''],
  ['role-reviewer', 'wake-on-state', ''],
  ['role-tests', 'wake-on-state', ''],
  ['role-deployer', 'wake-on-state', ''],
  ['role-docs', 'wake-on-state', ''],
  ['idle-free', 'room', 'blocks in the room rather than polling it'],
  ['n4', 'telegram', ''],
  ['n4', 'control-room', ''],
  ['second-shift', 'boundary', 'the adoption constraint'],
  ['boundary', 'room-out-pr', 'the decision that makes adoption possible'],
  ['boundary', 'keep-tracker', ''],
  ['boundary', 'keep-slack', ''],
  ['boundary', 'keep-git', ''],
  ['boundary', 'keep-ci', ''],
  ['boundary', 'adapt-ticket', ''],
  ['boundary', 'adapt-slack', ''],
  ['boundary', 'adapt-pr', ''],
  ['room-out-pr', 'adapt-pr', ''],
  ['adapt-pr', 'keep-git', 'the exit'],
  ['adapt-pr', 'keep-ci', 'CI still runs on the real branch'],
  ['adapt-ticket', 'keep-tracker', ''],
  ['adapt-slack', 'keep-slack', ''],
  ['day', 'rep-prwait', ''],
  ['day', 'rep-standup', ''],
  ['night', 'rep-gap', ''],
  ['rep-prwait', 'role-reviewer', 'only collapses if review is IN the room'],
  ['rep-standup', 'w-collide', 'the claims board is the standup'],
  ['objection', 'answer', ''],
  ['answer', 'w-touch', 'never sent beats never allowed'],
  ['answer', 'w-did', 'one process cannot attribute per agent'],
]

const FLOW = [
  ['day', 'd1', ''],
  ['d1', 'd2', 'a second agent asks'],
  ['d2', 'd3', 'sent elsewhere'],
  ['d3', 'd4', 'work done'],
  ['d4', 'd5', 'handoff requested'],
  ['d5', 'd6', 'passes on the retry'],
  ['d6', 'd7', ''],
  ['night', 'n1', ''],
  ['n1', 'n2', ''],
  ['n2', 'n3', 'someone breaks something'],
  ['n3', 'n4', ''],
  ['n4', 'n5', ''],
]

const { relay, room } = parseLink(LINK)
const dir = (process.env.TEMP || '.') + '/hive-map-' + NAME
const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, log: () => {} })
const graph = hive.doc.getMap('graph')

let done = false
hive.provider.on('sync', (s) => {
  if (!s || done) return
  done = true
  let n = 0, e = 0, bad = 0
  const take = (r) => { if (!r.ok) { bad++; console.error(`${r.code} ${r.msg}`) } return r.ok }
  if (CLEAR) {
    const r = applyCommand(graph, NAME, 'clear', ['yes'], {})
    console.log(r.ok ? r.msg : `${r.code} ${r.msg}`)
  }
  for (const [id, label, kind, state, file, note, group] of NODES) {
    if (take(applyCommand(graph, NAME, 'add', [id], { label, kind, state, file, note, group }))) n++
  }
  for (const [from, to, why] of NEEDS) {
    if (take(applyCommand(graph, NAME, 'link', [from, to], { why, kind: 'needs' }))) e++
  }
  for (const [from, to, why] of FLOW) {
    if (take(applyCommand(graph, NAME, 'link', [from, to], { why, kind: 'then' }))) e++
  }
  console.log(`seeded ${n} nodes, ${e} edges into ${room}${bad ? ` (${bad} refused)` : ''}`)
  setTimeout(() => { try { hive.stop() } catch { /* going away */ } ; process.exit(bad ? 1 : 0) }, 2500)
})
setTimeout(() => { console.error(`Q470 could not reach the relay at ${relay}`); process.exit(1) }, 20000)
