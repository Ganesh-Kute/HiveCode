// Seed the WHOLE of Hivecode into a room's map — the detailed one.
//
//   node seed-hivecode-full.mjs "ws://127.0.0.1:1235|hivecode-workflow" [YourName] [--clear]
//
// `seed-hivecode-map.mjs` draws the 18-step agent loop. This draws the system: the identity, the
// seven subsystems, the medium under them, every one of the 26 tools, the files that enforce
// each thing, the surfaces, the packages, the hard-won rules, and the gaps that are still open.
//
// STATES ARE CLAIMS ABOUT REALITY, NOT WISHES.
//   built    verified working -- it was run
//   wip      exists and is being worked on, or exists and is not yet shipped
//   broken   verified failing
//   planned  agreed to exist, no code
// Setting `built` because a file exists is the one thing that would make this map worthless,
// because its entire job is to be trusted at a glance.
//
// Edges carry two different meanings and must not be drawn the same way:
//   needs  A depends on B -- "if B breaks, A breaks"
//   then   A is followed by B -- the agent loop, read as a sequence

import { startSync, parseLink } from './sync.js'
import { applyCommand } from './hive-map.js'

const [, , LINK = '', NAME = 'seed'] = process.argv
const CLEAR = process.argv.includes('--clear')
if (!LINK) { console.error('usage: node seed-hivecode-full.mjs "<relay|room>" [YourName] [--clear]'); process.exit(2) }

// id, label, kind, state, file, note
const NODES = [
  // ── what it is, and what is sold ──────────────────────────────────────────────────────────
  ['hivecode', 'HIVECODE', 'milestone', 'built', 'HIVECODE.md', 'An operating system for AI agents that share a workspace. The identity — it does not change.', 'core'],
  ['sell', 'WHAT THEY BUY: control', 'milestone', 'built', '', 'What an agent can touch, what it did, how to undo just that agent. The door in — not a different product.', 'core'],
  ['sell-scope', 'scope', 'capability', 'built', 'token.js', 'An agent only RECEIVES what you grant. The relay never sends the rest — not a prompt it could ignore.', 'core'],
  ['sell-receipts', 'receipts', 'capability', 'built', 'substrate.js', 'Every change signed. Prove which agent wrote which line, months later.', 'core'],
  ['sell-undo', 'undo by agent', 'capability', 'built', 'sync.js', 'revertAuthor(who, since) erases ONE agent across N files and leaves everyone else intact.', 'core'],

  // ── the seven subsystems ──────────────────────────────────────────────────────────────────
  ['sub-identity', '1. IDENTITY', 'service', 'built', 'substrate.js', 'Ed25519 on every landed change. The relay deletes forged receipts and reverts forged heads.', 'identity'],
  ['sub-perms', '2. PERMISSIONS', 'service', 'built', 'token.js', 'Scoped tokens, path globs, read-only roles. Out of scope means never delivered.', 'perms'],
  ['sub-locks', '3. LOCKS', 'service', 'built', 'hive-coord.js', 'Claims with TTL and max-hold, so a dead agent never deadlocks a file.', 'locks'],
  ['sub-ipc', '4. IPC', 'service', 'built', 'hive-mailbox.js', '@mentions, per-participant read cursors, ambient digest, reply debts, busy state.', 'ipc'],
  ['sub-sched', '5. SCHEDULING', 'service', 'built', 'hive-await.js', 'hive_wait blocks and returns the instant your name is said. Idle costs ZERO tokens.', 'sched'],
  ['sub-audit', '6. AUDIT', 'service', 'built', 'sync.js', 'The receipt ledger, plus revert: restore, restoreFileTo, revertAuthor.', 'audit'],
  ['sub-policy', '7. POLICY', 'service', 'built', 'hive-mcp.js', 'State machine guards, counted leases, the path registry, the release gate.', 'policy'],

  // ── the medium underneath ─────────────────────────────────────────────────────────────────
  ['relay', 'the relay', 'service', 'built', 'server.js', '1152 lines. The only thing that DECIDES. No model is ever asked.', 'medium'],
  ['crdt', 'CRDT sync (Yjs)', 'service', 'built', 'sync.js', 'One Y.Doc per file. Converges always — coherence was never promised, which is the whole problem.', 'medium'],
  ['filerooms', 'one room per file', 'component', 'built', 'token.js', 'room<SEP>path. Lets the relay refuse a single file to a scoped client without hiding the project.', 'perms'],
  ['icr', 'ICR structural merge', 'service', 'built', 'icr.js', '745 lines. Merges declarations, not text. Refuses to emit anything that will not parse; falls back to diff3.', 'medium'],
  ['langs', 'language providers', 'component', 'built', 'lang-js.js', 'JS via acorn, plus brace-family, python, ruby, json, yaml, toml.', 'medium'],
  ['limits', 'tiers and caps', 'service', 'built', 'limits.js', 'Rate, bytes, frame size, connections. Free tier caps a room at 8.', 'medium'],
  ['gate', 'the release gate', 'service', 'built', 'hive-gate.js', 'gate:cmd runs in the releasing agent\'s folder. A failing check KEEPS the claim.', 'policy'],
  ['statemachine', 'state machine', 'service', 'built', 'hive-mcp.js', 'hive_set_schema enum + requires guards. A transition is refused until its precondition holds.', 'policy'],
  ['leases', 'PUBLISH:<n> leases', 'component', 'built', 'hive-mcp.js', 'A counted grant the SERVER spends and auto-closes at zero. The window shuts without anyone remembering to shut it.', 'policy'],
  ['pathreg', 'path: registry', 'component', 'built', 'hive-mcp.js', 'LIVE / SUPERSEDED / CORRUPT / DIVERGED / DELETED_UNWRITABLE. Five values because each implies a different action.', 'policy'],
  ['dco', 'DCO lock', 'component', 'built', 'hive-mcp.js', 'LOCKED status refuses tool execution outright.', 'policy'],
  ['attest', 'attestation + quorum', 'component', 'built', 'sync.js', 'Per-peer byte counts. Two peers disagreeing stays a DISAGREEMENT instead of converging on the last writer.', 'audit'],
  ['forkgate', 'silent-fork gate', 'service', 'wip', 'sync.js', 'Health-gated convergence: refuses to converge to code nobody authored. Experimental, off by default.', 'identity'],

  // ── the 26 tools ──────────────────────────────────────────────────────────────────────────
  ['t-join', 'hive_join', 'step', 'built', '', 'Once per session. Rejoining tears down your session; it used to overwrite your own newer files.', 'tools'],
  ['t-leave', 'hive_leave', 'step', 'built', '', 'Leave cleanly. A dropped socket leaves a seat behind — see presence never expires.', 'tools'],
  ['t-members', 'hive_members', 'step', 'built', '', 'Who is actually here. A self-declared name is not a credential.', 'tools'],
  ['t-status', 'hive_status', 'step', 'built', '', 'Am I actually in a room? The first thing to call when a join looks like it failed.', 'tools'],
  ['t-claim', 'hive_claim', 'step', 'built', 'hive-coord.js', 'Goes through claimSettled — the synchronous claim grants three simultaneous callers at once.', 'locks'],
  ['t-claims', 'hive_claims', 'step', 'built', '', 'Authoritative. Read it instead of asking the room who holds what.', 'locks'],
  ['t-release', 'hive_release', 'step', 'built', 'hive-gate.js', 'Can be REFUSED by the gate. A refused release is not a refused claim — the file stays yours.', 'locks'],
  ['t-edit', 'hive_edit', 'step', 'built', '', 'The authored write: intent and transition stamped race-free, so the receipt signs what you MEANT, not what converged.', 'tools'],
  ['t-say', 'hive_say', 'step', 'built', 'hive-mailbox.js', 'A message naming nobody lands in a digest everyone is told to skip.', 'ipc'],
  ['t-wait', 'hive_wait', 'step', 'built', 'hive-await.js', 'The idle state, not the end of a turn. Blocked costs nothing.', 'sched'],
  ['t-check', 'hive_check', 'step', 'built', '', 'Between edits, mid-task. hive_wait blocks, so it cannot be used while working.', 'ipc'],
  ['t-busy', 'hive_busy', 'step', 'built', 'hive-busy.js', 'Posts nothing. Tells anyone who @mentions you, as they send, that you are mid-task.', 'ipc'],
  ['t-assign', 'hive_assign', 'step', 'built', '', 'AI to AI is auto-accepted; a human directing someone else\'s agent needs that owner\'s approval.', 'tools'],
  ['t-approve', 'hive_approve', 'step', 'built', '', 'The owner decides. A human directing an agent they do not own cannot bypass this.', 'tools'],
  ['t-deny', 'hive_deny', 'step', 'built', '', 'Refuse assigned work, with the refusal recorded rather than silent.', 'tools'],
  ['t-complete', 'hive_complete', 'step', 'built', '', 'Close a task. Done is a state in the room, not an opinion in chat.', 'tools'],
  ['t-attest', 'hive_attest', 'step', 'built', '', 'Record what YOUR folder holds. One attestation is explicitly not proof.', 'audit'],
  ['t-verified', 'hive_verified', 'step', 'built', '', 'Quorum, divergence, AND whose gate passed. Same bytes means it propagated, not that it works.', 'audit'],
  ['t-setstate', 'hive_set_state', 'step', 'built', '', 'Every transition auto-posts to chat, so it is a machine fact and a human-readable event at once.', 'policy'],
  ['t-setschema', 'hive_set_schema', 'step', 'built', '', 'Turns a shared notepad into a state machine. Skipping it makes every flag a free string.', 'policy'],
  ['t-readstate', 'hive_read_state', 'step', 'built', '', 'The rooms flags. Read before assuming you are unlocked.', 'policy'],
  ['t-fork', 'hive_fork', 'step', 'built', '', 'The active fork on a file as a resolvable object: base, every version, and each signed intent.', 'tools'],
  ['t-resolve', 'hive_resolve', 'step', 'built', '', 'Any agent may reconcile a fork; the medium validates before it lands.', 'tools'],
  ['t-readchat', 'hive_read_chat', 'step', 'built', '', 'The ordered log. Messages land here even when nobody was woken.', 'ipc'],
  ['t-readboard', 'hive_read_board', 'step', 'built', '', 'Who rewrote what, recorded even when the agent forgot to announce it.', 'ipc'],
  ['t-readtasks', 'hive_read_tasks', 'step', 'built', '', 'Work directed at you, and its approval state.', 'tools'],

  // ── the loop, as things that happen ───────────────────────────────────────────────────────
  ['w-decide', 'RELAY DECIDES', 'gate', 'wip', 'server.js', 'The transport refuses the write. The prompt is not asked. This is the whole product in one node.', 'locks'],
  ['w-denied', 'DENIED', 'gate', 'wip', '', 'Not an error and not something to retry. Go do other work, or @ the holder.', 'locks'],
  ['w-granted', 'granted', 'step', 'built', '', 'The lease starts here. TTL and max-hold both run from this moment.', 'locks'],
  ['w-write', 'write the file', 'step', 'built', '', '', 'flow'],
  ['w-gate', 'GATE RUNS', 'gate', 'wip', 'hive-gate.js', 'Only if the room set gate:cmd. Exit non-zero and the handoff is refused.', 'policy'],
  ['w-kept', 'STILL YOURS', 'gate', 'wip', '', 'The refusal that matters: nobody else can take it, so nobody can build on your broken work.', 'locks'],

  // ── surfaces ──────────────────────────────────────────────────────────────────────────────
  ['ui-control', 'control room', 'ui', 'built', 'public/control.html', '/control — members, chat, claims, tasks, live.', 'surface'],
  ['ui-map', 'the live map', 'ui', 'built', 'public/map.html', '/map?room=NAME — this page. Nodes pulse while their file is held.', 'surface'],
  ['ui-five', 'social stage', 'ui', 'built', 'public/five.html', 'The 9:16 cut. Card states are read from the real claims map.', 'surface'],
  ['crdtbundle', 'hive-crdt.js', 'asset', 'built', 'public/hive-crdt.js', 'ONE Yjs, same origin. Two module URLs is two instances and the page goes silently deaf.', 'surface'],
  ['ext', 'VS Code extension', 'ui', 'wip', 'extension/extension.js', 'Carries a DUPLICATE copy of reconcile(); fixing one silently ships the other broken.', 'surface'],

  // ── CLI ───────────────────────────────────────────────────────────────────────────────────
  ['cli-await', 'hive-await.js', 'script', 'built', 'hive-await.js', 'Blocks on the event. Sleeping is deaf, which from outside looks exactly like ignoring people.', 'sched'],
  ['cli-claim', 'hive-claim.js', 'script', 'built', 'hive-claim.js', 'claim / release / board. release takes --force "reason".', 'tools'],
  ['cli-map', 'hive-map.js', 'script', 'built', 'hive-map.js', 'add / link / state / note / rm / unlink / clear yes / list.', 'tools'],
  ['cli-say', 'hive-say.js', 'script', 'built', 'hive-say.js', 'Speak into a room from a shell. Its own process, so its own identity.', 'ipc'],
  ['mcpserver', 'hivecode-mcp', 'package', 'built', 'hive-mcp.js', 'The 26 tools. 840 installs/month, 124 last week — the distribution, and nobody has talked to them.', 'tools'],
  ['remotemcp', 'remote MCP endpoint', 'service', 'built', 'remote-mcp.js', 'HTTP MCP for cloud agents. Token-gated, fail-closed: no token configured serves nobody.', 'tools'],
  ['hook', 'stop hook', 'script', 'built', 'hive-stop-hook.js', 'Refuses to let a Claude Code agent end its turn with unread mail. Claude Code only — no other IDE has the hook.', 'ipc'],

  // ── distribution ──────────────────────────────────────────────────────────────────────────
  ['pkg-relay', 'hivecode-relay', 'package', 'wip', 'scripts/build-relay.mjs', 'Built and smoke-tested, 25 files / 173 kB. NOT PUBLISHED — self-hosting still has no install command.', 'dist'],
  ['builder', 'the package builder', 'script', 'built', 'scripts/build-relay.mjs', 'Derives the package by PARSING server.js\'s import graph. No second copy of any source.', 'dist'],
  ['checkfiles', 'check-files guard', 'script', 'built', 'scripts/check-files.mjs', 'Refuses to publish a package that would throw ERR_MODULE_NOT_FOUND on a stranger\'s first run.', 'dist'],

  // ── evidence ──────────────────────────────────────────────────────────────────────────────
  ['tests', 'test:prod', 'script', 'built', 'tests/', '95 core + 80 map + 55 gate + limits + metering + rejoin + billing.', 'proof'],
  ['bench-ab', 'coordination A/B', 'script', 'built', 'bench/coordination-ab.mjs', 'Real git vs a real room. Aborts if our own merge driver would have rigged the baseline.', 'proof'],
  ['demo-off', 'the off switch', 'script', 'wip', 'demo/offswitch.mjs', 'Same system, coordination off. The OFF column is right; the ON column is not trusted yet.', 'proof'],
  ['demo-five', 'the 9:16 cut', 'script', 'built', 'demo/five.mjs', 'Throws rather than films a re-enactment if the refusals do not happen.', 'proof'],

  // ── the rules that each cost a real failure ───────────────────────────────────────────────
  ['r-settled', 'RULE: settle every claim', 'gate', 'built', 'sync.js', 'The sync claim verifies against its OWN replica and told 3 of 3 agents "yours". Writes use claimSettled.', 'locks'],
  ['r-perfolder', 'RULE: per-folder != global', 'gate', 'built', '', 'path:llm.js=POISONED was FALSE in one folder. Gate verdicts and attestations are keyed per peer.', 'rule'],
  ['r-seats', 'RULE: 8 conns, invisibly', 'gate', 'built', 'limits.js', 'The 9th socket connects and never syncs. Ten participants need HIVE_SEATS.', 'rule'],
  ['r-oneyjs', 'RULE: one Yjs', 'gate', 'built', 'public/hive-crdt.js', 'Two module URLs = bulk sync lands, incremental updates stop. Browser only; npm dedupes.', 'rule'],
  ['r-built', 'RULE: built means you ran it', 'gate', 'built', 'hive-map.js', 'Setting built because a file exists destroys the only thing this map is for.', 'rule'],
  ['r-micros', 'RULE: unix micros UTC', 'gate', 'built', '', 'Integers. ISO strings banned outside the display boundary.', 'rule'],
  ['r-qcode', 'RULE: Q + 3 digits', 'gate', 'built', '', 'Every user-facing error carries a code matching ^Q\\d{3}$.', 'rule'],

  // ── open gaps ─────────────────────────────────────────────────────────────────────────────
  ['gap-presence', 'presence never expires', 'component', 'broken', 'sync.js', 'Claims have a TTL; SEATS do not. A dead agent keeps its seat and shows as present.', 'gap'],
  ['gap-dupe', 'reconcile() exists twice', 'component', 'broken', 'extension/extension.js', 'sync.js and the extension both carry it, and no test covers the extension copy.', 'gap'],
  ['gap-relaygate', 'gate is client-side', 'component', 'wip', 'hive-gate.js', 'The relay cannot run your tests, so a hand-rolled client could skip the gate. Relay-side needs a signed receipt.', 'gap'],
  ['gap-users', 'FIVE NAMED USERS', 'milestone', 'planned', '', 'The only gap that is not a feature. Worth more than everything else on this map.', 'gap'],
]

// A needs B  ->  if B breaks, A breaks.
const NEEDS = [
  ['hivecode', 'sub-identity', ''], ['hivecode', 'sub-perms', ''], ['hivecode', 'sub-locks', ''],
  ['hivecode', 'sub-ipc', ''], ['hivecode', 'sub-sched', ''], ['hivecode', 'sub-audit', ''], ['hivecode', 'sub-policy', ''],
  ['hivecode', 'sell', 'the door people walk in through'],
  ['sell', 'sell-scope', ''], ['sell', 'sell-receipts', ''], ['sell', 'sell-undo', ''],
  ['sell-scope', 'sub-perms', ''], ['sell-receipts', 'sub-identity', ''], ['sell-undo', 'sub-audit', ''],

  ['sub-identity', 'relay', 'the relay enforces it; a forged receipt is deleted'],
  ['sub-perms', 'filerooms', 'refusing one file needs one room per file'],
  ['sub-perms', 'relay', ''],
  ['sub-locks', 'crdt', 'claims live in the same CRDT as everything else'],
  ['sub-locks', 'r-settled', 'a claim is only real once it has round-tripped'],
  ['sub-ipc', 'crdt', ''],
  ['sub-sched', 'crdt', 'the wait returns on a CRDT event, not a timer'],
  ['sub-audit', 'sub-identity', 'you can only undo one agent if you know which agent'],
  ['sub-policy', 'statemachine', ''], ['sub-policy', 'leases', ''], ['sub-policy', 'pathreg', ''],
  ['sub-policy', 'dco', ''], ['sub-policy', 'gate', ''],

  ['crdt', 'relay', ''], ['crdt', 'filerooms', ''],
  ['icr', 'langs', ''], ['crdt', 'icr', 'only when two edits actually collide'],
  ['relay', 'limits', ''], ['limits', 'r-seats', ''],
  ['forkgate', 'sub-identity', 'reconstructing both originals needs signed receipts'],
  ['attest', 'r-perfolder', ''], ['gate', 'r-perfolder', ''],
  ['pathreg', 'r-perfolder', 'the rule was learned HERE, from a global flag that was locally false'],

  ['t-claim', 'sub-locks', ''], ['t-claims', 'sub-locks', ''], ['t-release', 'gate', ''],
  ['t-say', 'sub-ipc', ''], ['t-wait', 'sub-sched', ''], ['t-check', 'sub-ipc', ''], ['t-busy', 'sub-ipc', ''],
  ['t-attest', 'attest', ''], ['t-verified', 'attest', ''], ['t-verified', 'gate', 'it reports whose check passed'],
  ['t-setschema', 'statemachine', ''], ['t-setstate', 'statemachine', ''], ['t-readstate', 'statemachine', ''],
  ['t-resolve', 'icr', ''], ['t-fork', 'forkgate', ''], ['t-edit', 'leases', 'a write spends a lease'],
  ['t-assign', 'sub-policy', ''], ['t-approve', 't-assign', ''], ['t-deny', 't-assign', ''], ['t-complete', 't-assign', ''],
  ['t-join', 'relay', ''], ['t-leave', 'relay', ''], ['t-members', 'relay', ''], ['t-status', 'relay', ''],
  ['t-readchat', 'sub-ipc', ''], ['t-readboard', 'sub-locks', ''], ['t-readtasks', 't-assign', ''],

  ['ui-control', 'crdtbundle', ''], ['ui-map', 'crdtbundle', ''], ['ui-five', 'crdtbundle', ''],
  ['crdtbundle', 'r-oneyjs', ''],
  ['ui-map', 'sub-locks', 'a node pulses while its file is held'],
  ['ext', 'gap-dupe', 'the duplicate lives here'],

  ['mcpserver', 'relay', ''], ['remotemcp', 'relay', ''], ['hook', 'sub-ipc', ''],
  ['cli-await', 'sub-sched', ''], ['cli-claim', 'sub-locks', ''], ['cli-map', 'ui-map', ''], ['cli-say', 'sub-ipc', ''],

  ['pkg-relay', 'builder', ''], ['builder', 'relay', 'it parses this file\'s import graph'],
  ['mcpserver', 'checkfiles', 'it caught a package that would not have started'],
  ['tests', 'relay', ''], ['bench-ab', 'relay', ''], ['demo-off', 'sub-locks', ''], ['demo-five', 'sub-locks', ''],
  ['ui-map', 'r-built', ''], ['cli-map', 'r-built', ''],

  ['gap-presence', 'relay', ''], ['gap-relaygate', 'gate', ''],
  ['gap-users', 'mcpserver', '840 a month install it and nobody has spoken to one of them'],
  ['sell', 'gap-users', 'no feature closes this'],
  ['sub-audit', 'r-micros', 'a receipt with an ambiguous clock is not evidence'],
  ['sub-locks', 'r-micros', 'TTL and max-hold are arithmetic on it'],
  ['relay', 'r-qcode', 'every refusal a caller sees carries one'],
  ['sub-policy', 'r-qcode', ''],
]

// A then B -> the sequence an agent actually goes through.
const FLOW = [
  ['t-join', 't-members', ''], ['t-members', 't-claims', ''], ['t-claims', 't-claim', ''],
  ['t-claim', 'w-decide', 'the relay, not the agent, decides'],
  ['w-decide', 'w-denied', 'someone else holds it'],
  ['w-decide', 'w-granted', 'free, or the lease expired'],
  ['w-denied', 't-say', '@ the holder, or take other work'],
  ['w-granted', 'w-write', ''],
  ['w-write', 'crdt', 'everyone else changes within about a second'],
  ['crdt', 'sub-identity', 'signed as it lands'],
  ['w-write', 't-check', 'mid-task, because wait would block'],
  ['t-check', 'w-write', ''],
  ['sub-identity', 't-release', ''],
  ['t-release', 'w-gate', ''],
  ['w-gate', 'w-kept', 'the check failed'],
  ['w-kept', 'w-write', 'fix it — nobody else can take it'],
  ['w-gate', 't-wait', 'the check passed; the file is handed back'],
  ['t-say', 't-wait', ''],
  ['t-wait', 't-claims', 'woken by @name or @all — the loop closes'],
]

const { relay, room } = parseLink(LINK)
const dir = (process.env.TEMP || '.') + '/hive-map-seed-full'
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
