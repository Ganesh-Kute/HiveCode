// Hivecode sync engine — the reusable core both the human client (folder.js)
// and the autonomous agent client (hive-agent.js) run on. This is also the seed
// of the public SDK: any tool or AI agent can `startSync(...)` to become a
// first-class participant in a room — no human setup required.
//
//   startSync({ relay, room, dir, name, kind, log }) -> { doc, provider, stop }
//
// `kind` is the participant's identity ('human' | 'ai'). It is set BY WHOEVER
// STARTS THE CLIENT — a human editor passes 'human', an agent passes 'ai' — so
// nobody has to manually "declare" anything; the identity is implicit in which
// client is run.
//
// Every change (disk->doc and doc->disk) goes through reconcile(): a 3-way merge
// against each file's last agreed base, so disjoint edits merge, same-line edits
// get conflict markers (nobody's work is silently lost), and wholesale rewrites
// are auto-logged to a shared board (HIVE_BOARD.md) for other agents to read.

import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import ignore from 'ignore'
import { applyDiff, summarizeChange, changedRange, hasConflictMarkers, merge3 } from './core.js'
import { icrMerge3 } from './icr-merge.js' // structure/intent-aware merge; falls back to line merge3
import { makeCoordinator } from './hive-coord.js' // decentralized claim layer (collision PREVENTION)
import { gateConfig, runGate, verdictRecord, refusalMessage, forcedMessage } from './hive-gate.js' // the HANDOFF gate: a claim you cannot give back while your own check fails
import { fileRoom, decodeUnsafe, scopeForRoom, pathAllowed, writeAllowed, isSafeRelPath } from './token.js'
import { validateMemberName } from './hive-mailbox.js' // a name the mention parser cannot produce is not a name
import { genIdentity, authorChange, verifyReceipt, contentHash } from './substrate.js' // convergent-substrate: signed provenance for every landed change
// `languageFor` belongs in this list and was missing: reconcile() calls it on the
// clean-rewrite path, so a local whole-file rewrite of a supported file threw
// ReferenceError and killed the sync process outright. Nothing caught it -- the client
// simply died mid-session, which reads to a user as "sync stopped working". Rewriting a
// whole file is the most common thing an agent does, so this fired constantly.
import grmLink from './grm-link.cjs' // hands this room's history to GRM, so the ROOM has a memory
import { structuralMerge, supports, languageFor } from './icr.js' // validates a judged fork resolution before it may land (parse + dangling refs)
import { accountFor, sameText, DESCENDS, IDENTICAL, DIVERGED, UNPROVEN } from './hive-pr-staleness.js' // room-versus-branch provenance staleness checks (HIV-P9)
// HIV-P8. The map key MUST be the string 'obligations' — hive-mcp.js:656 reads that exact key, and
// a debt written anywhere else would be invisible to hive_owed: a warning nobody can see, which is
// the defect this ticket is about, one level down.
import * as RH from './hive-relay-health.js' // HIV-P13; the ONLY producer of the not-syncing diagnosis
import { checkRelay } from './hive-privacy.js' // HIV-P20; which relay is this, and did anybody choose it
import * as OB from './hive-obligations.js'

// Wire-format/protocol version. Bump when a change makes clients incompatible
// (e.g. the v2 per-file-subdoc model). Broadcast via awareness so peers can warn
// when someone joins on an incompatible build instead of silently failing to sync.
const PROTOCOL_VERSION = 2

// Never sync these, even if not in .gitignore — secrets and obvious junk. This
// prevents pushing a teammate's .env / private keys / build output to the room.
const ALWAYS_IGNORE = [
  '.git/', 'node_modules/',
  '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', 'id_rsa', 'id_ed25519', '*.keystore',
  '.hive-id.json', // this client's substrate signing identity (holds a PRIVATE key) — never sync it
  // This client's own session + chat read cursor. Syncing it would push one agent's identity
  // and read position into every other agent's folder, and a shared cursor means one agent
  // consuming another's unread mail.
  '.hive-mcp-session.json',
  // This client's record of what IT last wrote to each file — the common ancestor it uses
  // to tell an authored edit from its own write after a restart (see SHADOW_FILE). It is
  // per-client by definition: syncing it would hand every peer a false ancestor.
  '.hive-shadow.json',
  // Names a PID on THIS machine. Syncing it would tell every peer their folder is locked by
  // a process that does not exist for them.
  '.hive-lock.json',
  '*.log', '.DS_Store', 'Thumbs.db', '*.vsix',

  // MOBILE AND CLOUD SECRETS. These are the files a mobile project keeps OUT of git via
  // a NESTED .gitignore (android/.gitignore, ios/.gitignore) -- which is exactly the case
  // this client used to miss, so a real user's `android/key.properties` (Android release
  // signing: storePassword, keyPassword, keyAlias) went through the relay. Nested
  // .gitignore files are read now, but these are listed here as well: the belt-and-braces
  // is cheap, and a leaked signing password is not recoverable by fixing the bug later.
  'key.properties', 'local.properties', 'secrets.properties',
  '*.jks', '*.mobileprovision', '*.p8',
  'google-services.json', 'GoogleService-Info.plist',
  'credentials.json', 'service-account*.json',
  '.npmrc', 'terraform.tfvars', '*.tfstate', '*.tfstate.backup',

  // BUILD OUTPUT that is regenerated from source and has no business crossing a network.
  // Only the unambiguous ones: `build/` and `dist/` are deliberately left to .gitignore,
  // because a handful of real projects keep hand-written files in them.
  '.gradle/', '.dart_tool/', 'ios/Flutter/ephemeral/', 'Pods/', 'DerivedData/',
  '__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.venv/',
]

// Is this "merge" actually a FUSION — output neither author wrote? Returns the reason, or ''.
//
// Exported and pure so it can be tested against crafted inputs. Forcing a real fusion is
// timing-dependent (it needs concurrent writes landing inside the sync window), and a guard
// this important should not be covered only by a test that is inherently flaky.
//
// The two signals, and why each is here:
//   - BROKE IT: both versions parsed and the merged output does not. There is no reading of
//     that which is correct — whatever it produced, neither author wrote it.
//   - DUPLICATION: distinctive lines appear MORE often in the output than in the side they
//     came from. That is content copied rather than merged, and it is what a union of two
//     near-identical versions looks like — the live corruption had `const MAX_OPEN` and
//     `function evictIfOverCap` three times each.
//
// LENGTH IS DELIBERATELY NOT A SIGNAL, and the first version of this got that wrong. "The
// output is about as long as both inputs combined" describes a fusion, but it equally
// describes two authors who each added two hundred lines in different places — a perfectly
// good merge. The test caught it firing on exactly that. Duplication separates them: a
// genuine disjoint merge repeats nothing.
export function fusionReason(merged, mine, theirs, lang) {
  if (!merged || !mine || !theirs || mine === theirs) return ''
  // If a side was ALREADY broken, the merge did not break it — blaming the merge would make
  // every merge on a half-written file look like corruption.
  if (lang && lang.parses(mine) && lang.parses(theirs) && !lang.parses(merged)) {
    return 'the merged result does not parse, although BOTH versions did'
  }
  // Only distinctive lines: a closing brace or a blank line legitimately repeats, and
  // counting those would make every file look duplicated.
  const sig = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 24)
  const tally = (arr) => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) || 0) + 1); return m }
  const M = tally(sig(merged)), A = tally(sig(mine)), B = tally(sig(theirs))
  let dup = 0, seen = 0
  for (const [line, n] of M) {
    const expected = Math.max(A.get(line) || 0, B.get(line) || 0)
    if (expected === 0) continue // content in neither side — new, and not our business here
    seen++
    if (n > expected) dup++
  }
  // Needs enough lines to mean anything, and enough of them repeated to be structural rather
  // than one unlucky duplicated statement.
  if (seen >= 10 && dup / seen >= 0.25) {
    return `${dup} of ${seen} distinctive lines appear more often in the result than in either version — that is content duplicated, not merged`
  }
  return ''
}

const IGNORE = new Set(['node_modules', '.git'])
const MAX_BYTES = 1_000_000
const BOARD_FILE = 'HIVE_BOARD.md' // generated locally from `board`; never synced as a file
const CHAT_FILE = 'HIVE_CHAT.md'   // generated locally from `chat`; the agents' conversation
const TASKS_FILE = 'HIVE_TASKS.md' // generated locally from `tasks`; directed work + approvals
const CONFIG_FILE = '.hive.json'   // local rendezvous config (room id); not synced
const SHADOW_FILE = '.hive-shadow.json' // what THIS client last wrote per file; the cross-restart ancestor
const LOCK_FILE = '.hive-lock.json'     // one sync client per folder; see acquireFolderLock
const ID_FILE = '.hive-id.json'    // this client's substrate signing identity (private); never synced
const RULES_FILE = 'HIVE_RULES.md' // the law every participant follows; written into every room
const MEMBERS_FILE = 'HIVE_MEMBERS.md' // live presence: who is in the room right now
// The claim map is the stigmergic trace agents SENSE before editing (see `claims` below), but it
// was the one part of the room that never reached disk — so an agent could only learn it by
// remembering to call a tool, and a trace nobody can see coordinates nothing. Rendered here for
// the same reason HIVE_CHAT.md is: a file in the working folder needs no tool call and no memory.
const CLAIMS_FILE = 'HIVE_CLAIMS.md'
const AGENTS_FILE = 'HIVE_FOR_AGENTS.md' // how an AI agent opening this folder joins (via .hive.json) + behaves
// Generated/coordination files are rendered locally from CRDT state — never
// synced as ordinary files (that would cause echo loops / conflicts).
const SKIP = new Set([BOARD_FILE, CHAT_FILE, TASKS_FILE, CONFIG_FILE, ID_FILE, RULES_FILE, MEMBERS_FILE, CLAIMS_FILE, AGENTS_FILE])

// Written into every room folder on sync (like the rules). An AI agent that opens
// this project reads it to learn it's a Hivecode room and how to JOIN — via the
// .hive.json already in the folder, so no human has to paste a link.
const AGENT_MANUAL_TEXT = `# Hivecode — for AI agents working in this folder

This project is part of a live Hivecode room: humans and AI agents editing the same
codebase together, in real time, with no git push/pull. If you are an AI assistant
asked to collaborate here, follow this.

## Join the room
1. If you do NOT have a \`hive_join\` tool and you can run terminal commands, register
   the Hivecode MCP server, then reload so the tools load:
     claude mcp add hivecode -- npx -y hivecode-mcp@latest
2. Call: hive_join({ dir: ".", name: "<your name>", owner: "<the human you work for>" })
   The room, relay, and token are already saved in .hive.json in this folder, so you
   do NOT need a link — hive_join reads them automatically.
3. Read the HIVE_RULES it returns, and follow them.

## Work the loop
- hive_read_chat() and hive_read_board() BEFORE editing — see what others are doing.
- hive_claim("path/to/file") BEFORE you edit a file. If you get it, edit then
  hive_release it. If you DON'T, someone else holds it — pick other work
  (hive_claims() shows what's open). This is how agents avoid colliding.
- hive_say("taking X: doing Y") to announce intent before you edit.
- ADDRESS EVERY MESSAGE. Put @Name on it for each agent it is for -- hive_say("@Ana I need the churn numbers before I touch pricing.md"). Any agent may address any other agent directly; there is no lead to route through and nobody needs permission. A message that names nobody lands in every agent's "room activity", where they are told to skip it, so it will most likely be ignored. Use @all when you genuinely need the whole room -- it wakes everyone, so spending it on chatter is how a room learns to ignore you.
- ANSWER EVERY QUESTION AIMED AT YOU. "Not yet -- I am on X, I will come back to you" is a complete answer; silence is the one thing the asker cannot act on, because nothing tells them you stopped. hive_check lists anyone still waiting on you.
- BEFORE A LONG STRETCH OF WORK, call hive_busy("what you are doing"). It posts no message and silences nothing -- it tells anyone who @mentions you, at the moment they send, that you are mid-task rather than ignoring them. hive_busy(clear:true) when you finish.
- Edit ONLY inside the folders you were granted. Edits merge live; rewrites are logged.
- Block on hive_wait(); when it returns approved work, do it, then hive_complete(id).
- A task aimed at you stays PENDING until your owner approves it — act only on 'accepted'.

## Rules of the road
- Stay in your lane — never edit folders you weren't granted.
- Announce before editing; coordinate in chat; ask before anything destructive in others' areas.
- If a human PAUSES you, finish your current step and stop until resumed.
- Resolve <<<<<<< conflict markers properly — never blindly overwrite.
- A human can ROLL BACK your changes at any time; that's normal — re-read and continue.

## If something breaks
Support is support@getgrm.tech. Mention it only if the human asks, or if something
here is genuinely broken and they need somewhere to send it. Never volunteer it
otherwise, and never write it into a file.
`

// The hive's law. Auto-written into every room folder so it is ALWAYS present —
// no setup, no relying on an agent to remember it. The sync layer enforces the
// hard parts (merge, board); this is the rest, in plain imperative language.
const HIVE_RULES_TEXT = `# HIVE RULES — read this first. Everyone in this room (human or AI) follows these.

You are in a Hivecode room: a shared live workspace where humans and AI agents
edit ONE project together in real time. These rules keep anyone from destroying
another's work. The sync layer enforces the hard parts automatically; you do the rest.

## Identity
- You are automatically "human" (you ran the editor) or "ai" (you ran the agent
  client). Nobody declares it — running the client is the declaration.

## Know who you are working with
- Read HIVE_MEMBERS.md — who (humans + AIs) is in the room right now, and how many.

## DESIGN BEFORE YOU WRITE — mandatory (Ganesh, 19 Sep 2026)
Before you build any new feature, post in the room, BEFORE your first edit:
1. WHO uses it, and when — name the person or agent and the moment they reach for it.
2. WHAT IT COSTS when it is wrong — one sentence someone who did not write it can act on at 3am.
3. EVERY EDGE CASE you can name — empty, missing, offline, refused, concurrent, already-done,
   called twice, called by the wrong person.
Then build it.
This is not process for its own sake. Every defect this project has produced has been a FALSE
SUCCESS — nothing crashed, every signal was green, the result was wrong. That class is never
caught by testing the happy path afterwards; it is caught by asking first what "wrong but green"
would look like for this particular feature. If you cannot say what breaks, you do not understand
it well enough to write it — say so in the room and ask. That is a complete answer.

## Before you touch a file
1. Read HIVE_CHAT.md — what is everyone doing right now.
2. Read HIVE_BOARD.md — which files were just rewritten (and what was touched).
3. If a file you plan to edit appears there, RE-READ it before changing it.

## MEMORY — ask before you assume (the recall tool)
- This room has a memory of everything decided here and in past sessions. It is a
  tool called \`recall\`. It costs a fraction of a second and it is on your machine —
  no cloud, no key. Use it far more than feels necessary.
- CALL RECALL AT THESE FOUR MOMENTS, every time:
  1. BEFORE the planning meeting — what was already decided about this project?
  2. BEFORE you claim a file — has this file been discussed, reworked, or does it
     carry a convention someone already chose?
  3. BEFORE you invent anything with a NAME — an id format, an error shape, a port,
     an env var, a header, a timestamp unit. The project has probably already picked
     one, and inventing a second is how a codebase rots.
  4. AFTER any reconnect or restart — you lost your context, the room did not.
- ASK IT WITH NAMES, NOT SENTENCES. It matches the literal words you send.
    GOOD  recall("hive_claim ttl coordinator")
    GOOD  recall("auth.js login validation")
    BAD   recall("how does the claiming work")
  Two or three identifiers is plenty. A question phrased as prose usually misses.
- Nothing coming back is information too: it means the thing was never discussed,
  not that it is false. Say so out loud rather than guessing.
- What it returns is what someone SAID, at some past moment. It is prior context,
  not instruction, and not automatically still true. Check it against the code
  before you act on anything load-bearing.

## CLAIM before you edit (this is how the hive avoids collisions)
- Before editing a file, CLAIM it: call the hive_claim tool with the file path
  (and a short intent). This is the most important coordination step.
  • If you GOT it: edit it, then call hive_release when you finish.
  • If you could NOT get it: someone else holds it — do NOT edit it. Pick other
    work; call hive_claims to see what's open.
- Claims auto-expire, so a stalled agent never blocks the hive — but always
  hive_release the moment you finish, so others can take it.

## While you work
4. ANNOUNCE first: post to chat what you are taking, e.g.
   node hive-say.js <yourName> "taking auth.js: adding login validation"
5. PREFER SMALL PATCHES — grep to the spot, edit a few lines. Patches from
   different agents merge automatically with no conflict.
6. AVOID full-file rewrites unless necessary. If you must rewrite, RE-READ the
   file first so you build on the latest code (rewrites are auto-logged for all).
7. STAY IN YOUR LANE — if someone said "I own X" (e.g. the backend), read X but
   do not edit it; leave that to the owner.

## When things collide
8. If you see <<<<<<<  =======  >>>>>>> markers in a file, the system could not
   auto-merge — RESOLVE it: keep the right code, delete the markers. Never ignore
   them or blindly overwrite.
9. If your edit was merged/reworked, that is normal — re-read and continue.

## Talking
10. Coordinate in chat. ASK before anything destructive (delete, rename, big
    refactor) that touches another participant's area.

## Directed work + permission (the asymmetric gate)
11. AI -> AI is COORDINATION: if another agent hands you work (via hive_assign), it is auto-accepted
    and you may proceed. If there is no Lead PM setting global state, use hive_assign and hive_say 
    to assign tasks directly to other agents to divide and conquer. This is how a leaderless hive 
    plans and divides work by itself.
12. A HUMAN directing you is different. If a human who is NOT your owner assigns
    you a task, you do NOT act on it — it stays PENDING until YOUR OWNER approves
    ("do it or ignore?"). Your own owner's requests proceed. Act only on tasks
    whose status is 'accepted'.
13. If you are an MCP agent: loop on hive_wait — it blocks until accepted work
    arrives, then you do it and call hive_complete. No need to poll. A pending
    human request will NOT wake you until your owner approves it.

## Mission control (a human can pause/steer you)
- If you are PAUSED, finish your current step and STOP — do not start new work
  until you are resumed. (MCP agents: hive_wait returns no work while paused.)
- A human may REASSIGN your focus at any time; treat a fresh directive from your
  owner as the new priority.

## When a ping arrives while you are mid-task (interruptions)
14. hive_wait only checks BETWEEN steps, so a ping never interrupts mid-step.
    Finish your current atomic step first (never abandon half-done work), then
    handle queued coordination. If it's urgent (build broken, blocking others),
    do it now.
15. ACKNOWLEDGE a ping as soon as you see it so the sender isn't left hanging,
    e.g. say "got it — finishing X (~2 min), then on your fix".
16. YOU triage: announce do-now vs after-current. Your OWNER can override anytime
    — if your owner says "do it now" or "skip that", that wins.

## State-Machine Prompting (SMP)
17. The Lead PM controls the [GLOBAL PROJECT STATE] via hive_set_state.
18. ONLY use short enum flags (e.g. "APPROVED", "LOCKED"). Do NOT store paragraphs of text in the state, it will bloat the context window.
19. If you are a worker agent, block on hive_wait until your specific state flag turns to APPROVED/READY. Do not write code if you are LOCKED.

Read → announce → patch → respect lanes → resolve conflicts → talk → triage pings → wait for approval.

---
Support: support@getgrm.tech
`

/**
 * Where an account licence may come from, in precedence order — and where it may NOT.
 *
 *   1. an explicit argument (the extension reads it from SecretStorage and passes it here)
 *   2. $HIVE_LICENSE            (the MCP config's env block: per-machine, not in the repo)
 *   3. ~/.hivecode/config.json  (the CLI's home, for anyone not going through MCP)
 *
 * NOT from the join link, and not from `.hive.json` in the project folder. Both of those are
 * shared or committed: `.hive.json` sits in the repo, and the link is pasted into chat and
 * written into HIVE_FOR_AGENTS.md, which is itself synced to every participant. A billing
 * credential that travels with an invitation is a credential that bills you for strangers.
 */
export function resolveLicense(explicit) {
  const e = (explicit || '').trim()
  if (e) return e
  const env = (process.env.HIVE_LICENSE || '').trim()
  if (env) return env
  try {
    const p = path.join(os.homedir(), '.hivecode', 'config.json')
    const c = JSON.parse(fs.readFileSync(p, 'utf8'))
    const k = (c && (c.license || c.licenseKey) || '').trim()
    if (k) return k
  } catch { /* absent or unreadable -> anonymous, which is a valid state */ }
  return ''
}

/**
 * ONE CLIENT PER FOLDER. Refuses a second sync process on the same directory.
 *
 * Nothing prevented this before, and the identical mistake cost GRM most of a journal:
 * nothing refused a second watcher on one graph, two processes appended concurrently, their
 * writes interleaved, and 99% of the journal became unreadable -- while the watermark went
 * on claiming the files were indexed. The failure is silent, and it is discovered much later
 * by someone trying to read the data.
 *
 * Here the damage would be two clients with two shadow files, two fork bases and two views
 * of the same disk, racing to reconcile the same paths. The CRDT would converge; the local
 * files would not.
 *
 * Returns a release function. A lock whose PID is gone is stale and is taken over -- a
 * crashed process must not lock a folder forever, which is the failure mode that makes
 * people delete lock files by hand and lose the protection entirely.
 */
export function acquireFolderLock(root, room, log = console.log) {
  const lockPath = path.join(root, LOCK_FILE)
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const prev = JSON.parse(raw)
    if (prev && typeof prev.pid === 'number' && prev.pid !== process.pid) {
      let alive = false
      // Signal 0 checks existence without delivering anything, and works on Windows.
      try { process.kill(prev.pid, 0); alive = true } catch { alive = false }
      if (alive) {
        const err = new Error(
          `Q470 this folder is already synced by process ${prev.pid}` +
          (prev.room && prev.room !== room ? ` (in room ${prev.room})` : '') +
          `. Two clients on one folder corrupt each other's view of the files. ` +
          `Stop that process, or use a different folder.`,
        )
        err.code = 'EHIVELOCKED'
        err.pid = prev.pid
        throw err
      }
      log(`[hive] taking over a stale lock from process ${prev.pid} (no longer running)`)
    }
  } catch (e) {
    if (e && e.code === 'EHIVELOCKED') throw e
    // Absent or unparseable: nothing to respect. An unreadable lock is not a reason to
    // refuse to start, or a corrupted byte would brick the folder.
  }
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, room, at: Date.now() }))
  } catch { /* read-only dir: proceed unlocked rather than refuse to run */ }
  let released = false
  const release = () => {
    if (released) return
    released = true
    // Only remove OUR lock. Removing someone else's would hand the folder to a third
    // process while the second is still writing to it.
    try {
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      if (cur && cur.pid === process.pid) fs.unlinkSync(lockPath)
    } catch { /* already gone */ }
  }
  return release
}

export function startSync({ relay = 'ws://localhost:1234', room = 'default', dir = '.', name = 'anon', kind = 'human', owner = '', token = '', license = '', log = console.log, syncFiles = true, passive = false }) {
  // BEFORE ANY DISK OR SOCKET WORK. A name outside the mention grammar joins successfully and is
  // then unreachable: its mail, its obligations and its wake-on-mention are all silently dead,
  // and the only symptom is other people being told "@X is NOT in the room" about someone who is
  // sitting right there. Refusing here costs the caller one clear error; allowing it cost an hour
  // on 20 Sep 2026 and was only found because a human noticed the routing failures by eye.
  // This throws rather than returning, because startSync has no failure channel and a half-joined
  // client is worse than no client.
  const nameCheck = validateMemberName(name)
  if (!nameCheck.ok) {
    const e = new Error(`${nameCheck.error} Try "${nameCheck.suggested}".`)
    e.code = 'EHIVEINVALIDNAME'
    e.suggested = nameCheck.suggested
    throw e
  }
  // THE SAME PRIVACY GATE hive-mcp.js applies at join, repeated here because this is the
  // real choke point. Every client in the product -- the MCP server, hive-agent.js, the
  // CLIs, every demo script -- reaches the network through this one function, and a guard
  // that lives only in the MCP layer protects only agents that went through the MCP layer.
  // An operator who sets HIVE_RELAY_PIN is entitled to expect it means "this machine",
  // not "this machine, except for the seven scripts that call startSync directly".
  //
  // It throws for the reason the name check above throws: startSync has no failure channel,
  // and a client that half-connects to a relay nobody authorised is the failure this exists
  // to prevent. Refusing here means no socket was opened and no file was published.
  const priv = checkRelay({ relay, env: process.env, dir: path.resolve(dir), fs })
  if (!priv.ok) {
    const e = new Error(`${priv.headline}\n\n${priv.detail}`)
    e.code = 'EHIVERELAYPIN'
    e.qcode = priv.code
    throw e
  }
  const ROOT = path.resolve(dir)
  fs.mkdirSync(ROOT, { recursive: true })
  // FIRST, before any socket or file work: if another client already holds this folder,
  const releaseLock = syncFiles ? acquireFolderLock(ROOT, room, log) : () => {}

  // Respect .gitignore (+ always-ignore secrets/junk) so we never sync a
  // teammate's .env, keys, or build output. Reloaded by reloadIgnores().
  //
  // GIT HONOURS A .gitignore IN EVERY DIRECTORY, not just the repository root, and reading
  // only the root one is how a real user's `android/key.properties` reached the relay: it
  // is ignored by `android/.gitignore`, which this never opened. Flutter, Android, iOS,
  // Gradle and most monorepos all put their real ignore rules in nested files, so the root
  // file alone is close to no filter at all for exactly the projects that carry secrets.
  //
  // Rules are scoped to the directory that declared them, which is what git does: a
  // pattern in `android/.gitignore` may only ever match paths under `android/`. A single
  // flattened ignore list would be wrong in the dangerous direction -- `build/` written in
  // one subproject would silently stop syncing another subproject's source.
  let ig = ignore()
  let nested = [] // [{ prefix: 'android/', ig }] -- one entry per nested .gitignore found

  function collectGitignores(dir, rel, out, depth) {
    if (depth > 12) return // pathological trees; a .gitignore 12 levels down is not real
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || IGNORE.has(e.name)) continue
      const sub = path.join(dir, e.name)
      const subRel = rel ? rel + '/' + e.name : e.name
      try {
        out.push({ prefix: subRel + '/', ig: ignore().add(fs.readFileSync(path.join(sub, '.gitignore'), 'utf8')) })
      } catch { /* no .gitignore in this directory */ }
      collectGitignores(sub, subRel, out, depth + 1)
    }
  }

  function reloadIgnores() {
    ig = ignore().add(ALWAYS_IGNORE)
    try { ig.add(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')) } catch { /* no .gitignore */ }
    nested = []
    collectGitignores(ROOT, '', nested, 0)
  }
  reloadIgnores()

  const isIgnored = (relPath) => {
    if (!relPath) return false
    if (ig.ignores(relPath)) return true
    for (const n of nested) {
      if (!relPath.startsWith(n.prefix)) continue
      const sub = relPath.slice(n.prefix.length)   // path relative to the declaring directory
      if (sub && n.ig.ignores(sub)) return true
    }
    return false
  }

  // PARENT doc: the manifest (file registry) + all coordination state. Each FILE
  // lives in its OWN doc, synced at its own room ("<room>␁<path>"). A client only
  // connects to the file-rooms it loads, so per-path access control (Phase 3) is
  // possible — Yjs replicates a whole doc to everyone, so isolation must be by
  // splitting into per-file docs, not by filtering one shared doc.
  const doc = new Y.Doc()
  const manifest = doc.getMap('manifest') // relPath -> 1 (the file registry)
  const board = doc.getMap('board') // relPath -> { by, at, churn, symbols }
  const chat = doc.getArray('chat') // ordered coordination messages { by, kind, at, text }
  const tasks = doc.getMap('tasks') // id -> { id, to, by, text, status, decidedBy, at } directed work
  const owners = doc.getMap('owners') // aiName -> ownerHumanName (who may approve its tasks)
  const controls = doc.getMap('controls') // participantName -> { state: 'running'|'paused', by, at } (mission control)
  // ROLLBACK metadata index: id -> { id, file, by, at, ts, churn, kind, label }. NO
  // file content here — content is scope-sensitive and lives in each FILE's own doc
  // (its `snap` map), so it inherits that file's access control. The parent only
  // holds the timeline (who changed what, when) — same exposure as the manifest,
  // which already lists every path. Lets a monitor (Control Room) show history.
  const historyMeta = doc.getMap('history')
  // The Hive coordination layer: a stigmergic claim map — region(file) -> {by,intent,at,ttl}.
  // Agents SENSE → FLOW → CLAIM before editing so they don't collide. No central controller;
  // claims evaporate via TTL so a stalled agent never deadlocks the hive.
  const claims = doc.getMap('claims')
  const swarmState = doc.getMap('swarm_state')
  const swarmSchema = doc.getMap('swarm_schema')
  // ATTESTATION LEDGER — path -> { <peerName>: { bytes, lines, at } }.
  //
  // The one thing a four-agent build could not do without a human relaying numbers by hand: tell
  // whether two folders actually hold the same file. Measured on the JARVIS run (2026-07-29):
  // engine/brain/llm.js was 178 lines and parsing in one folder and 22,312 lines with 73 conflict
  // markers in two others, and the agent with the clean copy reported a green suite in good faith
  // for hours. Nothing in the product could have told any of them.
  //
  // Why bytes per PEER rather than a single value: a CRDT map keyed by peer name MERGES instead of
  // last-writer-wins, so two peers attesting different byte counts both survive and the
  // DISAGREEMENT becomes the signal. One shared "size" field would have silently converged on
  // whichever peer wrote last, which is precisely the failure it exists to catch.
  const swarmAttest = doc.getMap('swarm_attest')
  // GATE VERDICTS — `<region>|<peerName>` -> the result of that peer running the room's check in
  // ITS OWN folder before handing the file back. Keyed per peer for the same reason swarmAttest
  // is: "the tests pass" is a fact about one folder's bytes, and storing it as a single shared
  // value would converge on whoever released last, silently erasing the disagreement that is the
  // entire signal. Two agents reporting different verdicts for one path both survive here.
  const gateResults = doc.getMap('gate_results')
  // CLAIM LEASE. Expiry is evaluated lazily on read, so the moment a lease passes its TTL the
  // next agent that tries simply gets the file -- that is what stops a stalled agent
  // deadlocking the room.
  //
  // The 5-minute default is unchanged, but it is now overridable, because 5 minutes is longer
  // than some agents work at all: on a 300s run the lease is exactly as long as the whole run,
  // so the protection can never fire and a held file stays held to the end. Measured on a real
  // take -- one file drew 17 claim attempts and 3 releases while eight messages asked who had it.
  const CLAIM_TTL_MS = Number(process.env.HIVE_CLAIM_TTL_MS) || 300000
  // How long anyone may hold a file IN TOTAL, across renewals. The ttl alone only catches a
  // holder that goes SILENT; a holder that keeps working renews forever, which is how one agent
  // held two files for an entire 300s run while six others waited. Default is 3x the ttl so
  // existing behaviour is unchanged for anyone who does not set it.
  const CLAIM_MAXHOLD_MS = Number(process.env.HIVE_CLAIM_MAXHOLD_MS) || CLAIM_TTL_MS * 3
  const coordinator = makeCoordinator(claims, name, { ttl: CLAIM_TTL_MS, maxHold: CLAIM_MAXHOLD_MS })
  // MY declared intent per region — recorded on every claim ATTEMPT, kept locally.
  // The provenance stamp reads this (not the shared claim map) so an agent always signs
  // ITS OWN intent: under a true concurrent collision the shared claim converges to ONE
  // winner, and reading it would misattribute the loser's receipt with the winner's WHY.
  const myIntents = new Map()

  // --- convergent substrate: signed provenance (opt-in via HIVE_PROVENANCE) ------
  // When on, this client loads (or mints) a persistent Ed25519 identity and SIGNS
  // every change it lands, appending a verifiable receipt to each file's provenance
  // ledger. This makes invariant I1 (provenance-verified) real end-to-end: every
  // state the room ever holds is attributable to a cryptographic author + a declared
  // intent. Everything here is wrapped so a failure can NEVER break sync — provenance
  // is an added guarantee, not a new dependency of the live path.
  const PROVENANCE = (process.env.HIVE_PROVENANCE || 'off').toLowerCase() !== 'off'
  // The live SILENT-FORK GATE (detect + surface concurrent same-line edits) is EXPERIMENTAL
  // and OFF by default. It reliably surfaces conflicts for realistic (2-3 agent, non-burst)
  // concurrency, but robustly detecting forks needs a source-level capture of each authored
  // edit BEFORE it merges — the fs.watch/disk-diff model contaminates the authored version,
  // so detection can't be made both complete (catch every clash) and sound (never false-flag
  // a disjoint edit). Opt in with HIVE_FORK_GATE=on. When off, sync behaves exactly as the
  // proven core: provenance still signs every change; only the fork surfacing is disabled.
  const FORK_GATE = PROVENANCE && (process.env.HIVE_FORK_GATE || 'off').toLowerCase() !== 'off'
  let identity = null
  if (PROVENANCE) {
    const idPath = path.join(ROOT, ID_FILE)
    try { if (fs.existsSync(idPath)) { const j = JSON.parse(fs.readFileSync(idPath, 'utf8')); if (j && j.pk && j.sk && j.id) identity = j } } catch { identity = null }
    if (!identity) { try { identity = genIdentity(name); fs.writeFileSync(idPath, JSON.stringify(identity, null, 2)) } catch { identity = null } }
    if (identity) log(`[${name}] substrate provenance ON — signing as ${identity.id.slice(0, 12)}…`)
  }
  // Record a signed receipt for a landed local change (base -> next) on a file's
  // ledger. Intent is taken from this author's live claim on the region, so the
  // WHY that the coordinator already knows is what gets cryptographically bound.
  // Two concerns, deliberately decoupled:
  //   stampIntent -> LEDGER receipt: the author's INTENT — the state they edited FROM (base)
  //     -> the content they WROTE (next). With the fork gate on this comes from the SOURCE
  //     capture (captureLocal), so it is anchored to a clean base, not the fusing shared
  //     text — which is what keeps concurrent same-line edits fork-detectable.
  //   attestHead -> HEAD: content AUTHORITY — attests the ACTUAL landed (converged) content,
  //     so the relay's non-regression guard always judges real content, never partial intent.
  function stampIntent(relPath, base, next) {
    if (!PROVENANCE || !identity) return
    const fe = fileDocs.get(relPath); if (!fe || !fe.ledger) return
    // Idempotent: if THIS author already signed this exact (parent -> content) transition,
    // don't duplicate it — the source capture and the edit path may both stamp the same change.
    const pHash = contentHash(base == null ? '' : base), cHash0 = contentHash(next)
    if (fe.ledger.toArray().some((r) => r && r.author === identity.id && r.parent === pHash && r.contentHash === cHash0)) return
    try {
      const c = coordinator.sense(relPath)
      const intent = myIntents.get(relPath) || (c && c.by === name && c.intent) || 'edit'
      const ch = authorChange({ identity, filename: relPath, base: base == null ? '' : base, text: next, intent, at: Date.now() })
      // `name` is display-only (NOT signed) — the verified identity is `author` (the key
      // fingerprint). A UI shows both: the friendly name, and the cryptographic author it
      // must match. Signature covers everything else, so tampering `name` can't fake trust.
      const receipt = { ...ch.prov, name }
      fe.doc.transact(() => {
        fe.ledger.push([receipt])                 // append INTENT to history (audit + fork detection)
        // Preserve the FULL TEXT of both states, keyed by content hash — the raw material
        // fork detection reconstructs pre-fusion versions from after the char-CRDT fuses them.
        storeVersion(fe, base == null ? '' : base)
        storeVersion(fe, next)
      })
    } catch { /* provenance must never break the sync path */ }
  }
  function attestHead(relPath, landed, base) {
    if (!PROVENANCE || !identity || landed == null) return
    const fe = fileDocs.get(relPath); if (!fe || !fe.head) return
    try {
      const cur = fe.head.get('cur')
      if (cur && cur.hash === contentHash(landed)) return // head already attests this content
      const c = coordinator.sense(relPath)
      const at = Date.now()
      const intent = myIntents.get(relPath) || (c && c.by === name && c.intent) || 'edit'
      const ch = authorChange({ identity, filename: relPath, base: base == null ? '' : base, text: landed, intent, at })
      fe.doc.transact(() => {
        fe.head.set('cur', { text: landed, hash: ch.prov.contentHash, at, by: name, receipt: { ...ch.prov, name } })
        storeVersion(fe, landed)
      })
    } catch { /* provenance must never break the sync path */ }
  }
  // Compatibility wrapper: record intent AND attest the landed content (defaults to next).
  function stampProvenance(relPath, base, next, landed) {
    stampIntent(relPath, base, next)
    attestHead(relPath, landed == null ? next : landed, base)
  }
  // Record text by its content hash, bounded: drop any stored version no longer
  // referenced by a receipt (as a parent or a result) so the map can't grow forever.
  function storeVersion(fe, text) {
    if (!fe || !fe.versions || text == null) return
    fe.versions.set(contentHash(text), text)
    if (fe.versions.size > 64) {
      const live = new Set()
      for (const r of fe.ledger.toArray()) { if (r && r.parent) live.add(r.parent); if (r && r.contentHash) live.add(r.contentHash) }
      for (const h of [...fe.versions.keys()]) if (!live.has(h)) fe.versions.delete(h)
    }
  }
  // SOURCE-LEVEL EDIT CAPTURE — the subsystem that makes fork detection sound.
  // A room folder has exactly TWO writers: this engine (every write it makes is recorded in
  // `shadow`) and the local author (their editor/agent — everything else). So any divergence
  // of disk from shadow IS an authored edit, and (shadow -> disk) is its true, uncontaminated
  // (base -> text) pair — captured and signed BEFORE any merge or conflict render can
  // overwrite the file. This is what after-the-fact disk-diffing could never provide: the
  // author's version unpolluted by concurrent merges. It closes the capture race: the old
  // window was the whole watcher debounce; now capture runs at the entry of every pass that
  // could clobber, so an authored edit enters the provenance DAG before anything overwrites
  // it. Gate-on only; the proven default path is untouched.
  function captureLocal(relPath) {
    if (!FORK_GATE || !identity) return false
    const fe = fileDocs.get(relPath); if (!fe || !fe.synced || !fe.ledger) return false
    if (SKIP.has(relPath) || isIgnored(relPath)) return false
    let disk = null; try { disk = fs.readFileSync(path.join(ROOT, relPath), 'utf8') } catch { return false }
    const base = shadow.get(relPath)
    if (base == null || disk === base) return false // no baseline yet, or nothing new on disk
    if (hasConflictMarkers(disk)) return false      // half-edited conflict block — not an authored state
    stampIntent(relPath, base, disk)                // into the provenance DAG NOW — clobber-proof
    shadow.set(relPath, disk)                       // the captured state is the new baseline
    return true
  }
  // Build ONE clean N-way conflict block from a common parent and N divergent versions:
  // strip the lines they (and the parent) all share as a prefix/suffix, then stack each
  // version's differing middle between markers. Deterministic (caller sorts versions), so
  // every peer produces byte-identical output. Returns null if nothing distinct remains.
  function nwayConflict(parentText, versions) {
    const P = parentText.split('\n')
    const Vs = versions.map((v) => v.text.split('\n'))
    const minLen = Math.min(P.length, ...Vs.map((v) => v.length))
    let pre = 0
    while (pre < minLen && Vs.every((v) => v[pre] === P[pre])) pre++
    let suf = 0
    while (suf < minLen - pre && Vs.every((v) => v[v.length - 1 - suf] === P[P.length - 1 - suf])) suf++
    const out = [...P.slice(0, pre)]
    let any = false
    versions.forEach((v, i) => {
      const mid = Vs[i].slice(pre, Vs[i].length - suf)
      if (mid.length) any = true
      out.push(`${i === 0 ? '<<<<<<<' : '======='} ${v.name} (${String(v.hash).slice(0, 7)})`)
      out.push(...mid)
    })
    // Closing marker MUST carry a trailing label — core.js hasConflictMarkers matches
    // /^>>>>>>> /m (note the space), so a bare ">>>>>>>" would not register as a conflict
    // and the sync layer would treat the block as clean content.
    out.push('>>>>>>> (resolve: keep one, delete the markers)')
    out.push(...P.slice(P.length - suf))
    return any ? out.join('\n') : null
  }
  // SILENT-FORK DETECTION — the health gate, done RIGHT (local-render model).
  //
  // The char-CRDT (Y.Text) always converges, even when it shouldn't: two agents editing
  // the SAME line fuse into valid-but-unauthored code ("return 2" + "return 3" -> "return
  // 32") that no layer flags. Nobody signs that fused byte-string, yet BOTH real versions
  // were signed against the SAME parent. So the provenance ledger still holds the truth
  // the char-merge destroyed.
  //
  // The KEY design choice: we do NOT write conflict markers back into the shared Y.Text
  // (that just makes the markers themselves fuse — the old bug). Instead a fork is recorded
  // as a deterministic, converged RECORD (a per-file LWW register, computed purely from the
  // ledger so every peer derives the identical value), and each peer renders the markers to
  // its OWN disk. Nothing concurrent is written to the shared text, so nothing can tangle.
  // Y.Text is frozen at the fused value and simply ignored until a human resolves.

  // Compute the live fork purely from the ledger. Same input -> same output on every peer,
  // so setting the record is idempotent and needs no applier election. Returns
  // { parent, base, versions:[{hash,name,author}] } or null.
  function computeFork(fe) {
    const receipts = fe.ledger.toArray()
    if (!receipts.length) return null
    const builtOn = new Set(receipts.map((r) => r && r.parent).filter(Boolean))
    const byParent = new Map()
    for (const r of receipts) {
      if (!r || !r.parent || !r.contentHash) continue
      if (!byParent.has(r.parent)) byParent.set(r.parent, new Map())
      byParent.get(r.parent).set(r.contentHash, r) // dedupe divergent children by content
    }
    for (const [parent, kids] of byParent) {
      if (kids.size < 2) continue
      const base = fe.versions.get(parent)
      if (base == null) continue
      let arr = [...kids.values()]
        .map((r) => ({ r, text: fe.versions.get(r.contentHash) }))
        .filter((x) => x.text != null && !fe.forkmark.has(x.r.contentHash)) // skip versions already folded into a resolved conflict
      const tips = arr.filter((x) => !builtOn.has(x.r.contentHash)) // prefer live heads
      if (tips.length >= 2) arr = tips
      if (arr.length < 2) continue
      arr.sort((a, b) => (a.r.contentHash < b.r.contentHash ? -1 : 1)) // deterministic order across peers
      // Discriminator: a REAL same-region fork, or disjoint edits the char-merge combined
      // fine? If no pair actually conflicts on a 3-way against the base, leave it.
      let real = false
      for (let i = 0; i < arr.length && !real; i++)
        for (let j = i + 1; j < arr.length && !real; j++) {
          const m = merge3(base, arr[i].text, arr[j].text)
          if (m.conflict || hasConflictMarkers(m.text)) real = true
        }
      if (!real) continue
      return { parent, base, versions: arr.map((x) => ({ hash: x.r.contentHash, name: x.r.name, author: x.r.author })) }
    }
    return null
  }
  // The deterministic conflict block for a record (byte-identical on every peer).
  function forkBlock(fe, rec) {
    const versions = rec.versions.map((v) => ({ text: fe.versions.get(v.hash), name: v.name, hash: v.hash })).filter((v) => v.text != null)
    if (versions.length < 2) return null
    return nwayConflict(rec.base, versions)
  }
  // Read the ACTIVE fork from the conflict map. The version set is stored as a UNION of
  // per-hash keys ('v:'+hash) that MERGE across peers (not a single LWW register), so a
  // late-arriving version can never be lost to a last-writer-wins race — the set only grows
  // and converges to the full set on every peer. Returns { parent, base, versions } or null.
  function forkRecord(fe) {
    if (!fe || !fe.conflict) return null
    const meta = fe.conflict.get('meta'); if (!meta) return null
    const versions = []
    for (const key of fe.conflict.keys()) {
      if (!key.startsWith('v:')) continue
      const v = fe.conflict.get(key)
      versions.push({ hash: key.slice(2), name: v.name, author: v.author })
    }
    if (versions.length < 2) return null
    versions.sort((a, b) => (a.hash < b.hash ? -1 : 1)) // deterministic order across peers
    return { parent: meta.parent, base: meta.base, versions }
  }
  // Render the active conflict to THIS peer's disk (local only — never Y.Text).
  function renderConflict(relPath) {
    const fe = fileDocs.get(relPath); if (!fe || !fe.conflict) return
    // Before we overwrite this file with the conflict block, capture any local edit sitting
    // on disk that hasn't been stamped yet — otherwise rendering would silently destroy it.
    if (captureLocal(relPath)) { detectFork(relPath); return } // it grew the fork; detectFork re-renders with it included
    const rec = forkRecord(fe); if (!rec) return
    const block = forkBlock(fe, rec); if (!block) return
    let disk = null; try { disk = fs.readFileSync(path.join(ROOT, relPath), 'utf8') } catch { }
    forkBases.set(relPath, block) // this peer has now SEEN the markers — a later clean edit from here is a resolution
    if (disk === block) return
    writeToDisk(relPath, block)
    if (!conflicted.has(relPath)) {
      conflicted.add(relPath)
      const who = rec.versions.map((v) => v.name).join(', ')
      log(`[${name}] ⚠ SILENT FORK in ${relPath} — ${who} changed the same region at once; provenance caught it. Surfaced ALL ${rec.versions.length} versions with <<<<<<< markers (rendered locally, not into the shared text).`)
      // Carry each side's SIGNED intent into the announcement: the WHY is what lets any
      // agent in the room reconcile the fork (via hive_resolve) instead of picking a winner.
      const why = rec.versions.map((v) => `${v.name}: "${versionIntent(fe, rec, v.hash) || 'no stated intent'}"`).join(' | ')
      try { say(`⚠ SILENT FORK in ${relPath}: ${who} changed the same region concurrently. Signed intents — ${why}. Surfaced ALL ${rec.versions.length} versions with <<<<<<< markers. ANY agent may reconcile BOTH intents: call hive_resolve with the full resolved file — it is validated (parses, no dangling refs) before it lands.`) } catch { }
    }
  }
  // A resolution landed elsewhere: the shared text is clean again. Adopt it to disk.
  function adoptResolved(relPath) {
    const fe = fileDocs.get(relPath); if (!fe) return
    const dt = fe.text.toString()
    if (hasConflictMarkers(dt)) return
    captureLocal(relPath) // an authored edit may be sitting on disk — record it before adopting over it
    writeToDisk(relPath, dt)
    bases.set(relPath, dt); forkBases.set(relPath, dt)
    conflicted.delete(relPath)
  }
  // The VERIFIED signed intent behind one fork version: the receipt that produced this
  // content from the fork's parent, signature-checked — so the WHY a judge reconciles is
  // cryptographically the author's own declaration, not something another peer typed.
  function versionIntent(fe, rec, hash) {
    const r = fe.ledger.toArray().find((r) => r && r.contentHash === hash && r.parent === rec.parent && verifyReceipt(r).ok)
    return (r && r.intent) || ''
  }
  // The active fork as a machine-RESOLVABLE object: the common base plus every divergent
  // version with its author and verified intent. This is what an agent judge reads before
  // proposing a reconciliation — the conflict is data, not just markers on a disk.
  function forkInfo(relPath) {
    const fe = fileDocs.get(relPath); if (!fe) return null
    const rec = forkRecord(fe); if (!rec) return null
    return {
      file: relPath,
      base: rec.base,
      versions: rec.versions.map((v) => ({ name: v.name, author: v.author, intent: versionIntent(fe, rec, v.hash), text: fe.versions.get(v.hash) })),
    }
  }
  // INTENT-AWARE FORK RESOLUTION — the judged path out of a surfaced silent fork.
  // Any participant (typically an AI agent that has read both sides' signed intents via
  // forkInfo / the chat announcement) proposes the FULL reconciled file; the MEDIUM
  // validates it before it may land:
  //   - no conflict markers left behind,
  //   - (supported language) judged as a one-sided change from the fork's base through
  //     ICR structuralMerge: it must PARSE and must not leave a DANGLING reference —
  //     the same guarantee the icr-merge library's resolveMerge gives a judge, so broken
  //     judge output physically cannot ship. (A rename in the proposal even gets its
  //     stale call sites rewritten, same as any merge.)
  // A landed resolution takes the exact convergent path a human resolution takes: it is
  // signed by the resolver, folds the fork versions, clears the record on every peer,
  // and is announced. A refused proposal changes NOTHING — the fork stays surfaced.
  function resolveFork(relPath, proposal) {
    const fe = fileDocs.get(relPath)
    if (!fe || !fe.synced || !fe.conflict) return { ok: false, reason: `no active fork on ${relPath}` }
    const rec = forkRecord(fe)
    if (!rec) return { ok: false, reason: `no active fork on ${relPath}` }
    if (!canWrite(relPath)) return { ok: false, reason: `${relPath} is read-only for you` }
    if (typeof proposal !== 'string' || !proposal.trim()) return { ok: false, reason: 'empty resolution' }
    if (hasConflictMarkers(proposal)) return { ok: false, reason: 'resolution still contains <<<<<<< conflict markers — send the final clean file' }
    let landed = proposal
    if (supports(relPath) && rec.base != null) {
      const v = structuralMerge(rec.base, proposal, rec.base, { filename: relPath })
      if (v.status !== 'auto') return { ok: false, reason: `resolution refused by ICR validation: ${v.reason || (v.conflicts || []).join(', ') || v.status}` }
      landed = v.text
    }
    // INTENT COVERAGE (informational, deterministic): did each side's TOKEN-level
    // changes survive into the landed text? Token granularity is what makes a genuine
    // reconciliation count for both sides (a merged ternary contains both sides' new
    // tokens) while a lazy single-winner judgment shows one side's tokens dropped.
    // A resolution may legitimately pick one side — but that becomes VISIBLE to the
    // room instead of silently passing as a reconciliation. Never refuses.
    const tokSet = (s) => new Set(String(s).match(/[A-Za-z_$]\w*|\d[\w.]*/g) || [])
    const baseToks = tokSet(rec.base || ''), landedToks = tokSet(landed)
    const coverage = rec.versions.map((v) => {
      const vt = fe.versions.get(v.hash)
      const changed = vt == null ? [] : [...tokSet(vt)].filter((t) => !baseToks.has(t))
      const missing = changed.filter((t) => !landedToks.has(t))
      return { name: v.name, covered: missing.length === 0, missing }
    })
    const dropped = coverage.filter((c) => !c.covered)
    const block = forkBlock(fe, rec)
    fe.doc.transact(() => {
      applyDiff(fe.text, landed)
      for (const vv of rec.versions) fe.forkmark.set(vv.hash, 1)
      for (const key of [...fe.conflict.keys()]) fe.conflict.delete(key)
    })
    stampProvenance(relPath, block || rec.base || '', landed)
    writeToDisk(relPath, landed)
    conflicted.delete(relPath)
    known.add(relPath); bases.set(relPath, landed); forkBases.set(relPath, landed)
    const covNote = dropped.length
      ? ` ⚠ Coverage: ${dropped.map((c) => `${c.name}'s changes (${c.missing.slice(0, 5).join(', ')}) did NOT survive`).join('; ')} — the room should sanity-check this judgment.`
      : ' Full intent coverage: every side\'s changes survived token-level.'
    try { say(`⚖ FORK RESOLVED by ${name} (intent-aware): reconciled ${rec.versions.map((v) => v.name).join(' + ')} in ${relPath}. Validated by ICR (parses, no dangling refs) before landing.${covNote}`) } catch { }
    return { ok: true, file: relPath, text: landed, coverage }
  }
  // FIRST-CLASS AUTHORED WRITE — an agent writes THROUGH the medium instead of via
  // disk + a debounced watcher. This closes the capture race COMPLETELY for the write:
  // the author's declared intent is recorded and the (base -> text) transition is
  // stamped into the provenance ledger synchronously, before any concurrent merge or
  // conflict render could contaminate the disk (the fs.watch model's residual window
  // does not exist on this path). The content then lands through the SAME reconcile
  // pipeline as any local edit — merging, fork detection, and conflicts behave
  // identically; only the capture is race-free.
  function editFile(relPath, content, intent) {
    relPath = String(relPath || '').replace(/\\/g, '/')
    if (!relPath || typeof content !== 'string') return { error: 'need a file path and string content' }
    if (!isSafeRelPath(relPath)) return { error: 'unsafe path' }
    if (SKIP.has(relPath) || isIgnored(relPath)) return { error: `${relPath} is not a syncable file` }
    if (!canOpen(relPath)) return { error: `${relPath} is out of your scope` }
    if (!canWrite(relPath)) return { error: `${relPath} is read-only for you` }
    if (intent) myIntents.set(relPath, String(intent)) // my declared WHY — what my receipt will sign
    const full = path.join(ROOT, relPath)
    try { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content) }
    catch (e) { return { error: 'write failed: ' + e.message } }
    // Deliberately NOT via writeToDisk (which records engine writes in `shadow`):
    // this write is AUTHORED, so disk-vs-shadow divergence is exactly what captureLocal
    // stamps. Run the pass NOW — no debounce window at all.
    if (FORK_GATE) captureLocal(relPath)
    reconcile(relPath, 'local')
    const fe = fileDocs.get(relPath)
    const landed = fe && fe.synced ? fe.text.toString() : content
    let disk = content; try { disk = fs.readFileSync(full, 'utf8') } catch { }
    return { ok: true, file: relPath, landed, conflicted: hasConflictMarkers(disk) }
  }
  // Detect a live fork and record it. The version set is a CRDT UNION (per-hash keys), so
  // this is monotonic + convergent: every peer contributes what it sees and the set grows
  // to the full fork on all peers regardless of arrival order. Does NOT touch Y.Text.
  function detectFork(relPath) {
    if (!FORK_GATE) return
    const fe = fileDocs.get(relPath)
    if (!fe || !fe.ledger || !fe.versions || !fe.conflict || !fe.synced) return
    const rec = computeFork(fe)
    if (fe.conflict.has('meta')) {
      // Already in conflict — union in any newly-seen versions (never overwrites; only adds).
      if (rec) fe.doc.transact(() => { for (const v of rec.versions) if (!fe.conflict.has('v:' + v.hash)) fe.conflict.set('v:' + v.hash, { name: v.name, author: v.author }) })
      renderConflict(relPath)
      return
    }
    const cur = fe.text.toString()
    // Current content is itself a signed/authored state (one side won cleanly, or a human
    // already resolved) — not a silent fusion.
    if (fe.ledger.toArray().some((r) => r && r.contentHash === contentHash(cur))) return
    if (!rec) return
    fe.doc.transact(() => {
      fe.conflict.set('meta', { parent: rec.parent, base: rec.base })
      for (const v of rec.versions) fe.conflict.set('v:' + v.hash, { name: v.name, author: v.author })
    })
    renderConflict(relPath)
  }
  // disableBc: do NOT sync peer-to-peer over BroadcastChannel. The relay must be
  // the ONLY path between clients — otherwise two clients on the same machine would
  // sync directly and bypass the relay's access control (auth, path scope, read-only).
  // Tell the relay who is connecting. Unlike the editor, a name here is always explicit --
  // the caller passed it on the command line or in the MCP config -- so there is nothing to
  // opt into. `kind` is the valuable half: it is the only way the relay can distinguish an
  // AI agent from a human, which is otherwise invisible to it and to the operator.
  const wsParams = {}
  if (token) wsParams.token = token
  // THE ACCOUNT CREDENTIAL, and it is NOT the same thing as `token` above.
  //
  // `token` is a room invite: it says which folders this client may write, it is short-lived,
  // and it is MEANT to be shared -- it rides in the join link so an invitee can just paste a
  // link. `license` says whose subscription this connection bills to, and must never be
  // shared: a link pasted into a chat would bill to whoever created it, forever.
  //
  // They were already two separate query parameters on the relay side, and the relay has
  // always read both. THE CLIENT NEVER SENT A LICENCE AT ALL -- so with
  // HIVE_REQUIRE_LICENSE=true every connection from a real client was refused 402, because
  // verifyLicense('') can only fail. This is the line that closes that gap.
  //
  // Read from the environment or an explicit argument, and DELIBERATELY not from the join
  // link: see resolveLicense() for where it may come from.
  const lic = resolveLicense(license)
  if (lic) wsParams.license = lic
  if (name) wsParams.name = String(name).slice(0, 48)
  if (kind) wsParams.kind = kind
  if (passive) wsParams.passive = 'true'
  const wsOpts = { WebSocketPolyfill: WebSocket, disableBc: true, params: Object.keys(wsParams).length ? wsParams : undefined }
  const provider = new WebsocketProvider(relay, room, doc, wsOpts)
  provider.awareness.setLocalStateField('user', { name, kind, owner: owner || undefined, v: PROTOCOL_VERSION, passive: !!passive }) // identity is implicit in the client

  // ---- relay reachability, said out loud exactly once -------------------------------
  // y-websocket retries forever and silently. That is the right RECOVERY behaviour and
  // the wrong REPORTING behaviour: if the relay dies mid-session the editor keeps
  // accepting edits, the file keeps saving, and nothing anywhere says the work has
  // stopped leaving the machine. A user cannot tell "synced" from "alone", which is a
  // worse failure than an outage -- an outage you can see.
  //
  // Only the BASE provider reports. Every file is its own socket, so reporting per
  // provider would print the same outage once per file: a 161-file project would emit
  // 161 identical errors and the real one would be unfindable.
  const SUPPORT = process.env.HIVE_SUPPORT || 'support@getgrm.tech'
  let relayFails = 0
  let relayReported = false

  // `ws` puts the HTTP status in the error message for any non-101 response
  // ("Unexpected server response: 402"), and that status is the only way to tell
  // "refused you" from "not there". Browsers withhold it, hence the null case.
  function statusFromError(e) {
    const m = /Unexpected server response:\s*(\d{3})/.exec((e && (e.message || e.reason)) || '')
    return m ? Number(m[1]) : null
  }

  function explain(code) {
    if (code === 401) return 'the relay rejected your token. It may have expired -- ask the room owner for a new invite.'
    if (code === 402) return `this room is over its plan limit. Contact ${SUPPORT} and we will sort it out.`
    if (code === 403) return 'the relay refused this room or path for your token. You are outside the folders you were given.'
    // 429 at the UPGRADE is always Q431 "room at capacity" -- never rate limiting. The rate
    // limiter works on frames after the socket is up and announces itself over the room chat,
    // so it cannot produce this. Saying "rate-limited, wait a minute" here was wrong twice
    // over: it named the wrong cause and it told the user to wait for something that never
    // clears. This one is worth getting right -- a silently-refused connection is invisible
    // (y-websocket retries forever with no error), and on 2026-09-05 that cost an hour and
    // put a wrong root cause into public/control.html: five of thirteen clients never joined
    // a room, and the missing messages were read as a relay bug that does not exist.
    if (code === 429) return `this room is FULL, so you were not let in (Q431). A relay admits a limited ` +
      `number of connections per room -- 8 on the free tier -- and this room is at that ceiling. Note it ` +
      `counts CONNECTIONS, not people: one agent holding several files holds several. If you run the relay, ` +
      `raise it with HIVE_SEATS; otherwise ask whoever does, or contact ${SUPPORT}.`
    if (code === 503) return `the relay is not serving this connection. Either the whole relay is at capacity ` +
      `(Q430) or it could not check your licence and is failing closed rather than guessing. It may also be ` +
      `restarting -- if this lasts, contact ${SUPPORT}.`
    if (code) return `the relay answered ${code} instead of accepting the connection. Contact ${SUPPORT}.`
    return `the relay at ${relay} cannot be reached. It may be down, asleep, or blocked by a network. ` +
           `Your edits are still saved on disk but are NOT being shared. Contact ${SUPPORT} if this continues.`
  }

  // Three consecutive failures (~15s) before speaking. One dropped frame on a train is
  // not an outage, and crying about every reconnect trains people to ignore the message
  // that matters.
  function relayTrouble(e) {
    if (++relayFails < 3 || relayReported) return
    relayReported = true
    const code = statusFromError(e)
    log(`[hive] NOT SYNCING -- ${explain(code)}`)
    log(`[hive] still retrying in the background; this will say so when it reconnects.`)
  }

  // ---- the FIRST connection, which the code above cannot cover -----------------------
  // relayTrouble waits for three consecutive FAILURES. A sleeping relay does not fail: the
  // socket is simply slow to be accepted, so no error event fires and nothing is reported.
  // On a free-tier host that is a 30-second cold start, and the user's first ever experience
  // of the product is a command that appears to hang. That is the single likeliest reason a
  // first run is abandoned, and it is not an error at all -- it just needed saying.
  let everConnected = false
  const firstWait = setTimeout(() => {
    if (everConnected) return
    log(`[hive] waiting for the relay at ${relay} ...`)
    log('[hive] a sleeping relay can take up to 30s to wake on the first connection.')
  }, 4000)
  if (firstWait.unref) firstWait.unref()
  const stillWaiting = setTimeout(() => {
    if (everConnected) return
    log('[hive] still waiting. If this does not clear in a minute the relay may be down --')
    log(`[hive] your files are safe on disk either way. ${SUPPORT} if it persists.`)
  }, 35000)
  if (stillWaiting.unref) stillWaiting.unref()

  provider.on('connection-error', relayTrouble)
  provider.on('connection-close', relayTrouble)
  provider.on('status', ({ status }) => {
    if (status !== 'connected') return
    if (!everConnected) {
      everConnected = true
      clearTimeout(firstWait); clearTimeout(stillWaiting)
    }
    if (relayReported) log('[hive] relay reachable again -- syncing resumed.')
    relayFails = 0
    relayReported = false
  })
  if (kind === 'ai' && owner) owners.set(name, owner) // record who is allowed to approve my tasks

  // One sub-provider + Y.Doc per file, created on demand. `text` is its content.
  // `synced` flips true after the first relay sync — until then an empty doc means
  // "not pulled yet", NOT "new file", so we must not re-seed it from disk (that
  // would create a second CRDT history and duplicate/garble content on rejoin).
  const fileDocs = new Map() // relPath -> { doc, provider, text, synced }

  // REFUSED FILE-ROOMS. y-websocket retries a failed upgrade forever, with backoff and in
  // silence. That is right for a flaky network and badly wrong for a relay that is full: on
  // 18 Sep 2026 a relay answered 38,011 connections with Q430 while the agents involved
  // showed no symptom at all. Their files simply never arrived, and an unsynced file-doc
  // reads as EMPTY, which is how the same evening ended with 186 files written to 0 bytes.
  //
  // So count refusals for docs that have NEVER synced, and say it once. The condition is
  // usually a whole-relay problem rather than a per-file one, so one message naming the
  // count is the useful shape -- one per file would be 800 lines of chat.
  const refusedFiles = new Map() // relPath -> consecutive connection errors, cleared on sync
  const refusedCodes = new Map() // relPath -> the HTTP status the relay refused with, when it gave one
  let refusalSaidAt = 0
  let refusalTimer = null

  function noteRefusals() {
    if (refusalTimer) return
    // Debounced: a full relay refuses every file at once, and we want the total, not the first.
    refusalTimer = setTimeout(async () => {
      refusalTimer = null
      const stuck = [...refusedFiles.keys()].filter((r) => { const e = fileDocs.get(r); return e && !e.synced })
      // One transient error on one file is a blip, not an outage. Two or more files stuck, or
      // repeated failures on one, is the shape of a relay that will not take us.
      const repeated = stuck.some((r) => (refusedFiles.get(r) || 0) >= 3)
      if (stuck.length < 2 && !repeated) return
      const now = Date.now()
      if (now - refusalSaidAt < 300000) return // at most once every 5 minutes
      refusalSaidAt = now
      // HIV-P13. THIS MESSAGE USED TO NAME A CAUSE IT HAD NOT MEASURED.
      //
      // It said "the usual cause is the relay being full (Q430)" on the strength of having
      // observed only that N file docs have synced=false. Measured 21 Sep 2026, at the moment a
      // third agent printed it for 49 files: the relay reported 56 connections of 512, and
      // limits.js keys its per-room count on the FILE-room, so any one file held three
      // connections against a cap of 64. Q430 needed 512 and had 56; Q431 needed 64 and had 3.
      // Neither refusal could have fired. The real event was the relay dropping its room state
      // -- /health went rooms 44 -> 0 -> 29 -> 44 over a few minutes -- and every client
      // reconnecting one socket per file.
      //
      // "The relay is full" and "the relay just dropped everyone and we are all reconnecting"
      // produce an identical symptom and need OPPOSITE responses: a config change, or thirty
      // seconds of patience. Telling an operator to raise a limit that is 89% free is worse
      // than saying nothing, because they will do it, see no change, and conclude the product
      // is broken -- correctly, on the evidence they were given.
      //
      // So the client asks the relay instead of guessing, and reports what came back. It also
      // stops printing the literal string "<relay-http>", which it did for three weeks while
      // holding the relay URL in scope.
      // EVIDENCE BEFORE INFERENCE. If the relay actually refused us it said so with a status,
      // and explain() maps those to the right cause and the right knob -- Q431 to HIVE_SEATS,
      // Q430 to capacity, 401/403 to the token, 402 to the plan. That is a fact from the relay.
      // Only when nothing refused us -- the sockets simply never came up, which is what a
      // dropped-and-reconnecting relay looks like -- is there anything left to infer, and then
      // we go and ASK rather than assert.
      const coded = stuck.map((r) => refusedCodes.get(r)).filter(Boolean)
      const code = coded.length ? coded.sort((a, b) => coded.filter((c) => c === b).length - coded.filter((c) => c === a).length)[0] : null
      const msg = code
        ? `${stuck.length} file(s) are not synced and will READ AS EMPTY until this clears. ` +
          `The relay refused ${coded.length} of them with ${code}: ${explain(code)} ` +
          `Do not trust this folder's contents meanwhile.`
        : (await RH.explainNotSyncing(relay, {
            stuck: stuck.length, what: 'files',
            trailer: `Nothing refused these connections with a status code, so the cause above is ` +
              `inferred from the relay's own counters rather than reported by it. ` +
              `Do not trust this folder's contents meanwhile.`,
          })).text
      log(`[${name}] !! ${msg}`)
      try { say(`[!] @all ${msg}`) } catch { /* chat may itself be unreachable — the log still carries it */ }
    }, 4000)
    if (refusalTimer.unref) refusalTimer.unref()
  }
  // HIV-P18. THE DOCUMENTED REMEDY DID NOT EXIST.
  //
  // The README told every user: "A file outside the working set is not on your disk yet. It
  // exists in the room. Reading or claiming the path fetches it." Measured 21 Sep 2026 against
  // a client holding 8 of a room's 41 files, on a path that WAS in the manifest:
  //
  //   whyNotShared(mod024.js) -> ""      (in scope; edits would reach the room)
  //   claim(mod024.js)        -> true    ("it's yours")
  //   after claim + 9s        -> on disk = false
  //   after release + 9s      -> on disk = false
  //   provenanceOf            -> 0 receipts,  headOf -> null   (doc never opened)
  //   public fetch/read/open  -> undefined
  //
  // Nothing brought the bytes down. The cause is one line in reconcile: `if (disk === null)
  // return` before openFile, plus a warm-up that only opens files already on local disk. A
  // manifest entry with no local copy was never opened, so it could never arrive.
  //
  // The only thing that DID work was writing to the path -- which is precisely the blind
  // recreate HIV-P14b guards. So the sole recovery route was the one dangerous action, reached
  // by an agent that had been told "it's yours" and then saw an empty directory. That is
  // HIV-P3's class arriving inbound: a claim granted over bytes that cannot move.
  //
  // This makes the sentence true. `fetch` opens the doc and RESOLVES WHEN THE CONTENT HAS
  // LANDED, because an un-awaited open is the same false success one layer down: the caller
  // reads the directory, sees nothing, and concludes the file is absent.
  function fetchFile(relPath, { timeoutMs = 15000 } = {}) {
    const r = String(relPath)
    if (!canOpen(r)) return Promise.resolve({ ok: false, reason: `${r} is out of your scope` })
    const full = path.join(ROOT, r)
    // Already here: report it, and say so rather than implying we went and got it.
    if (fs.existsSync(full)) return Promise.resolve({ ok: true, alreadyLocal: true, file: r })
    // Not in the room either. This is the case @Hermes hit, and it is NOT the working-set
    // case: nothing will ever arrive, so saying "fetching" would be a lie. The two look
    // identical from an empty directory and have opposite remedies, so they get different
    // answers here.
    if (!manifest.has(r)) {
      return Promise.resolve({
        ok: false, notInRoom: true, file: r,
        reason: `${r} is not in this room at all — no client has ever published it, so nothing ` +
          `can fetch it. This is not a working-set miss. Check the room's .gitignore allow-list ` +
          `covers the path, then have whoever holds the file write it into their synced folder.`,
      })
    }
    const e = openFile(r)
    if (!e) return Promise.resolve({ ok: false, reason: `could not open ${r}` })
    return new Promise((resolve) => {
      let done = false
      const finish = (res) => { if (done) return; done = true; clearInterval(iv); clearTimeout(to); resolve(res) }
      const check = () => {
        if (!e.synced) return
        // reconcile() runs on the provider's own sync event and writes to disk. Wait for the
        // BYTES, not for the flag -- the flag says the socket settled, which is not the claim
        // being made to the caller.
        if (fs.existsSync(full)) return finish({ ok: true, file: r, bytes: fs.statSync(full).size })
        // Synced and still nothing: the room holds this path with empty content. Real, and a
        // different answer from "not fetched yet".
        if (e.text.toString() === '') return finish({ ok: true, file: r, empty: true, bytes: 0 })
      }
      const iv = setInterval(check, 250)
      if (iv.unref) iv.unref()
      const to = setTimeout(() => finish({
        ok: false, file: r, timedOut: true,
        reason: `${r} is in the room but did not arrive within ${timeoutMs}ms. The file's own ` +
          `socket may be refused — hive_status reports filesHeld of roomFiles, and a refused ` +
          `file doc is indistinguishable from an empty file.`,
      }), timeoutMs)
      if (to.unref) to.unref()
      check()
    })
  }

  function openFile(relPath) {
    let e = fileDocs.get(relPath)
    if (e) return e
    const fdoc = new Y.Doc()
    const fprovider = new WebsocketProvider(relay, fileRoom(room, relPath), fdoc, wsOpts)
    const text = fdoc.getText('content')
    // `snap` (in the FILE's own doc, so it's scope-protected with the file) holds
    // restore points: id -> { id, file, by, at, ts, content, churn, kind, label }.
    // `undo` is a per-file UndoManager tracking THIS client's local edits, so a
    // human/agent can undo their own CRDT changes (Level-0 rollback).
    const snap = fdoc.getMap('snap')
    // The file's provenance LEDGER: an append-only list of signed receipts, one per
    // landed change. Lives in the file's own doc, so it inherits the file's access
    // control and travels with it. Any peer can verifyReceipt() every entry.
    const ledger = fdoc.getArray('ledger')
    // The authoritative HEAD: a single signed pointer at the file's CURRENT content
    // (key 'cur' -> { text, hash, at, by, receipt }). Content authority = the relay
    // guarantees this is always a verified, non-regressing attestation of the content.
    const head = fdoc.getMap('head')
    // versions: contentHash -> full text, for every state any author edited from or
    // produced. The char-CRDT keeps only the fused current bytes; this keeps the
    // pre-fusion originals so a silent fork can be reconstructed and surfaced.
    const versions = fdoc.getMap('versions')
    // forkmark: contentHash -> 1 for every version already folded into a surfaced
    // conflict. Synced, so once ANY peer surfaces a fork, those versions never trigger
    // again — the conflict stays put until a human resolves it, and a resolution can't
    // be re-conflicted by a peer whose ledger lags its content (the re-fork race).
    const forkmark = fdoc.getMap('forkmark')
    // conflict: the per-file LWW fork RECORD (key 'cur' -> { parent, base, versions }).
    // Deterministic (computed from the ledger), converged across peers, and rendered to
    // each peer's DISK — never into the shared text — so conflict markers can't fuse.
    const conflict = fdoc.getMap('conflict')
    const undo = new Y.UndoManager(text, { captureTimeout: 350 }) // default tracks local-origin txns
    e = { doc: fdoc, provider: fprovider, text, snap, ledger, head, versions, forkmark, conflict, undo, synced: false }
    fileDocs.set(relPath, e)
    text.observe((_ev, txn) => { if (!txn.local) reconcile(relPath, 'remote') }) // remote content edits
    // A divergent receipt can arrive slightly after (or before) the fused content — so
    // re-run the fork check whenever the provenance ledger changes too, not only on edits.
    ledger.observe((_ev, txn) => { if (!txn.local) detectFork(relPath) })
    // The fork record arrived/changed from a peer: render it locally, or — if it was
    // cleared (resolved elsewhere) — adopt the now-clean shared text to disk.
    conflict.observe((_ev, txn) => { if (txn.local) return; if (e.conflict.has('meta')) renderConflict(relPath); else adoptResolved(relPath) })
    fprovider.on('sync', (s) => { if (s) { e.synced = true; refusedFiles.delete(relPath); reconcile(relPath, 'remote'); detectFork(relPath) } }) // initial pull settled
    // A refused upgrade lands here. The provider will keep retrying by itself, which is the
    // right behaviour and exactly why nothing surfaces it — so count it and let noteRefusals
    // decide whether this is a blip or a relay that will not take us.
    fprovider.on('connection-error', (ev) => {
      if (e.synced) return // already have the content; a later blip is the provider's business
      refusedFiles.set(relPath, (refusedFiles.get(relPath) || 0) + 1)
      // HIV-P13. THE STATUS CODE WAS THROWN AWAY HERE, and it is the only authoritative evidence
      // in the whole path. joinRoom in hive-mcp.js already captured it from this same event; this
      // handler took no argument at all, so noteRefusals had nothing but "N files are quiet" and
      // had to INFER a cause -- which is how it came to announce Q430 on 21 Sep while the relay
      // sat at 56 of 512. explain() above maps these codes correctly and has done since 5 Sep.
      const code = ev && (ev.code || ev.status)
      if (code) refusedCodes.set(relPath, code)
      noteRefusals()
    })
    // Newly opened counts as used, and opening is the moment the working set can go over
    // its bound — so this is where the least-recently-used ones are let go.
    touched.set(relPath, Date.now())
    evictIfOverCap(relPath)
    return e
  }
  function closeFile(relPath) {
    const e = fileDocs.get(relPath)
    if (!e) return
    try { e.undo && e.undo.destroy() } catch { }
    try { e.provider.destroy() } catch { }
    try { e.doc.destroy() } catch { }
    fileDocs.delete(relPath)
  }
  const fileText = (relPath) => { const e = fileDocs.get(relPath); return e ? e.text : null }

  // HIV-18: BOUND HOW MANY FILE SOCKETS THIS CLIENT HOLDS.
  //
  // Hivecode opens one WebSocket per FILE. A relay allows 512 connections in total by
  // default, and a normal project has more files than that, so a single client could
  // exhaust the whole relay by itself. Measured 18 Sep 2026: 889 files, 38,011 Q430
  // refusals in one evening, three agents locked out — and because a file-doc that never
  // syncs reads as EMPTY, 186 files per folder were written to 0 bytes.
  //
  // Holding every file open forever is what made that possible. A client now keeps a
  // BOUNDED working set: the most recently used MAX_OPEN files stay connected, the rest
  // are closed and reopened on demand. Closing a file doc costs nothing on disk — the
  // bytes stay where they are, the room keeps the content, and touching the file reopens
  // it and pulls the current copy.
  //
  // THE TRADE, stated plainly: a file outside the working set does not receive remote
  // edits until something touches it. That is a real semantic change, and it is strictly
  // better than the alternative it replaces, which was not receiving them either AND
  // believing the file was empty. The default is high enough that ordinary projects never
  // notice; size it as MAX_OPEN x agents < the relay's maxConnsTotal.
  //
  // NEVER EVICT, because these lose work rather than merely adding latency:
  //   - a doc that has not synced (its content has not reached the relay yet)
  //   - a file in an unresolved conflict (its fork record is live and local-only)
  //   - a file anyone currently holds a claim on (they are mid-edit)
  //   - anything used within the grace window
  const MAX_OPEN = Math.max(8, Number(process.env.HIVE_MAX_OPEN_FILES) || 128)
  // Configurable because the grace window is what makes eviction untestable otherwise: in a
  // short run every file was touched seconds ago, so nothing is ever eligible.
  const EVICT_GRACE_MS = Number(process.env.HIVE_EVICT_GRACE_MS) || 30000
  const touched = new Map() // relPath -> last use (ms)
  const touchFile = (relPath) => { if (fileDocs.has(relPath)) touched.set(relPath, Date.now()) }
  let evicted = 0
  function evictIfOverCap(keep) {
    if (fileDocs.size <= MAX_OPEN) return
    const now = Date.now()
    const isClaimed = (r) => { try { return claims.has(r) } catch { return false } }
    const cand = []
    for (const [r, e] of fileDocs) {
      if (r === keep || !e.synced) continue
      if (conflicted.has(r)) continue
      try { if (e.conflict && e.conflict.size) continue } catch { }
      if (isClaimed(r)) continue
      const t = touched.get(r) || 0
      if (now - t < EVICT_GRACE_MS) continue
      cand.push([r, t])
    }
    cand.sort((a, b) => a[1] - b[1]) // least recently used first
    let over = fileDocs.size - MAX_OPEN
    for (const [r] of cand) {
      if (over-- <= 0) break
      closeFile(r); touched.delete(r); evicted++
    }
  }

  // My own path scope, read from my token (for THIS room). Used so I don't even
  // try to open files I'm not granted — the relay would reject them anyway, but
  // this avoids the churn and keeps out-of-scope files off my disk entirely.
  // undefined = no path restriction (open room or whole-room grant).
  let myPaths, myScope = null
  if (token) { const pl = decodeUnsafe(token); const sc = pl && scopeForRoom(pl, room); myScope = sc || null; myPaths = sc ? sc.paths : undefined }
  // canOpen gates BOTH scope (am I granted this path?) AND safety (is the path
  // safe to write to disk — not a "../" traversal, absolute path, or control-char
  // injection a malicious participant slipped into the shared manifest?).
  const canOpen = (relPath) => isSafeRelPath(relPath) && pathAllowed(myPaths, relPath)
  // canWrite: of the files I can SEE, which may I PUSH (edit/create in the room)?
  // A view-only file (in my read scope but not my writePaths) is pull-only — I keep
  // a local copy synced FROM the room but never publish my changes to it. No token
  // or a full-write grant => everything I can open is writable (back-compat).
  const canWrite = (relPath) => !myScope || writeAllowed(myScope, relPath)

  // WOULD AN EDIT TO THIS PATH ACTUALLY REACH ANYONE? '' if yes, else the reason. (HIV-27)
  //
  // A claim is a path STRING in the shared `claims` map. Whether that path's BYTES sync is
  // decided somewhere else entirely, per client, by canOpen/isIgnored. Nothing compared the
  // two, so an agent could hold an exclusive claim on a file nobody else can see, do the work,
  // pass a gate that runs in its OWN folder where the file is real, and hand back something
  // that never existed for anyone else. Every signal green, the work genuinely done, and
  // invisible. Observed live: an agent edited scripts/check-deploy.mjs, claimed it, released it
  // through the gate, and the other two folders still held the old bytes.
  //
  // This is checked at CLAIM time on purpose. Release is too late -- by then the agent has
  // built the thing it intended to write, and all we could do is tell it the work was wasted.
  //
  // THE FALSE-POSITIVE DIRECTION IS WHAT MAKES THIS USABLE, and it is easy to get wrong.
  // A claim may name a logical region rather than a file ("auth-refactor", "the parser"), and
  // under an ALLOW-LIST .gitignore -- `/*` followed by negations, which is how a room bounds
  // itself against the one-socket-per-file limit -- isIgnored() returns true for every string
  // that is not an explicitly allowed path. A naive isIgnored() check would therefore refuse
  // almost every legitimate claim in exactly the rooms that need this guard most, and it would
  // be switched off within a day. So we only judge things we have positive reason to believe
  // are FILES: known to the room, present on disk, or carrying a directory separator.
  // HIV-P3, 20 Sep 2026. THE GENESIS CASE: the five tests above are all false for a root-level
  // file that DOES NOT EXIST YET, which is the most common reason anyone claims at all -- you
  // claim `config.env` precisely because you are about to create it. Found by DeepMind-Agent.
  // So HIV-27's guard had a hole in exactly the case it was written for: claim succeeds, write
  // succeeds, the local gate passes because in YOUR folder the file is real, and the bytes never
  // leave. Born invisible, every signal green.
  //
  // THE ONLY QUESTION IS: is this bare string a FILE-TO-BE or a LOGICAL LABEL? Nothing on disk
  // and nothing in the room can answer it, so this is a guess, and the direction of the guess is
  // what matters. Guessing "file" too eagerly refuses legitimate region claims -- and under an
  // allow-list .gitignore that means refusing ALMOST ALL of them, which gets the guard switched
  // off within a day and costs more than the hole. So every rule here must be one a LABEL would
  // essentially never satisfy.
  //
  // THE DIGIT RULE IS THE LOAD-BEARING ONE and it is not obvious. A trailing dot-segment
  // containing a LETTER is an extension: .js .env .secret. One that is ALL DIGITS is a version
  // number: v1.2, release-0.11.6, HIV-P3.5. Without that distinction every ticket id and release
  // label in this room's own vocabulary gets refused as a file.
  //
  // WHAT THIS DOES NOT CLOSE, stated rather than discovered later. Extensionless root files that
  // are neither conventional nor `*file` shaped -- a bare `config`, `staging`, `hosts` -- are
  // still read as labels and still go invisible. The hole narrows; it does not close. It cannot
  // close here, because at claim time the string is all we have. The rest belongs at WRITE time,
  // where a path that appears on disk inside the room folder is a fact and needs no heuristic.
  // That is HIV-P8, and it is filed rather than quietly assumed.
  const EXTENSIONLESS_ROOT_FILES = new Set([
    'LICENSE', 'LICENCE', 'README', 'CHANGELOG', 'CHANGES', 'NOTICE', 'AUTHORS', 'CONTRIBUTORS',
    'CODEOWNERS', 'COPYING', 'INSTALL', 'CONTRIBUTING', 'VERSION', 'MAINTAINERS', 'TODO',
  ])
  const looksLikeFilename = (p) => {
    if (/\s/.test(p)) return false                       // "the parser rewrite", "P3 lane"
    if (/\.[^.]*[A-Za-z][^.]*$/.test(p)) return true     // .js .env .secret -- but NOT .2 .5 .6
    if (EXTENSIONLESS_ROOT_FILES.has(p.toUpperCase())) return true
    // Makefile, Dockerfile, Rakefile, Gemfile, Procfile, Vagrantfile, Justfile, Caddyfile.
    // Capital-initial and case-SENSITIVE on purpose: lowercase "profile" and "logfile" are
    // perfectly ordinary region names and must stay claimable.
    if (/^[A-Z][A-Za-z]+file$/.test(p)) return true
    return false
  }

  const whyNotShared = (relPath) => {
    const p = String(relPath || '')
    if (!p) return ''
    let onDisk = false
    try { onDisk = fs.existsSync(path.join(ROOT, p)) } catch { onDisk = false }
    // SKIP counts as positive evidence: those names ARE files by definition, and a control
    // file sits in the room root with no separator in its name, so the heuristics below miss it.
    const isFile = manifest.has(p) || fileDocs.has(p) || SKIP.has(p) || onDisk || p.includes('/')
      || looksLikeFilename(p)                    // HIV-P3: the genesis case -- see above
    if (!isFile) return ''                       // a label, not a path -- not ours to judge
    if (!isSafeRelPath(p)) return `"${p}" is not a safe relative path, so it can never be synced`
    if (SKIP.has(p)) return `${p} is a Hivecode control file, not shared source`
    if (!canOpen(p)) return `your access token's scope does not cover ${p}, so its bytes stay in this folder`
    if (isIgnored(p)) return `${p} is ignored by a .gitignore here, so this client never opens a sync connection for it -- anything you write stays in this folder and no other agent will ever see it`
    return ''
  }

  const known = new Set()
  const mtimes = new Map()
  // Paths that already existed on disk when this client STARTED. This is the
  // discriminator between "I cloned a repo and joined a room that already has these
  // files" (adopt the room's copy) and "this file was created during the session"
  // (a creation race -- merge, never adopt). Populated once, on the first scan.
  const preexisting = new Set()
  // HIV-P14b. Manifest keys as of our first sync: what the ROOM held before we arrived.
  // `preexisting` records our DISK, which structurally cannot distinguish "nobody had this file"
  // from "the room had it all along and we never fetched it". null until the first sync, and null
  // must never be read as "the room was empty" -- that would classify every joiner's first
  // creation as a race, which is the bug this exists to fix.
  let roomAtJoin = null
  let firstScanDone = false
  const shadow = new Map()     // relPath -> exact bytes THIS ENGINE last wrote/captured (source-level edit capture)
  // THE SAME THING, FROM THE PREVIOUS SESSION, and the reason it exists:
  //
  // `shadow` in memory is enough to tell an authored edit from our own write while we are
  // running. It died with the process, so after a reconnect there was no ancestor for any
  // file — every rejoin looked like FIRST CONTACT, and the adopt branch below wrote the
  // room's copy over local disk. Observed live: after an MCP drop, a STALE room copy landed
  // on top of a newer local edit, with no conflict markers and no message. The snapshot it
  // takes made that recoverable, but nothing told anyone to go looking.
  //
  // Persisted, the ancestor exists, and the case becomes what it actually is: a three-way
  // merge. Keyed by room — the same folder rejoined against a different room must not
  // inherit an ancestor from unrelated history.
  const priorShadow = new Map()
  const bases = new Map()      // last synced content per file (advances on every reconcile)
  const forkBases = new Map()  // FORK POINT: what THIS author last saw/authored per file.
  // forkBases advances only on local authorship / first adoption — NOT when a
  // remote change is auto-applied to disk. That distinction is what stops a stale
  // local full-file paste from silently deleting another participant's just-arrived
  // work (it would look like a deliberate deletion against an up-to-date base).

  const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/')
  // HIV-P8: `skipped` collects the files this walk DECLINES to sync, and that second list is the
  // whole ticket. Everything in this engine is derived from "the files we sync", so every natural
  // place to notice a born-invisible file is definitionally blind to it: walk() dropped ignored
  // paths, so scan() never saw them, so reconcile() was never called for them, so the guard at the
  // top of reconcile() was unreachable for exactly the class of file it names. Hooking there would
  // have passed a unit test that called reconcile() directly and done nothing in a real session.
  //
  // DIRECTORY PRUNING IS UNCHANGED, deliberately. Descending into ignored directories to find
  // ignored files would walk vendor and build trees on every tick. Measured on a real checkout with
  // pruning kept: 7934 synced, 256 ignored files visible, 280 directories descended, 191ms for the
  // whole traversal — and that traversal already happens. We are keeping an answer isIgnored()
  // already computed instead of discarding it. An ignored file inside an ignored directory stays
  // unseen, which is the correct trade at that price.
  function walk(d, acc = [], skipped = []) {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return acc }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue
      const full = path.join(d, e.name)
      const r = rel(full)
      if (e.isDirectory()) { if (!isIgnored(r + '/')) walk(full, acc, skipped) }   // prune ignored dirs
      else if (e.isFile()) { if (isIgnored(r)) skipped.push(full); else acc.push(full) }
    }
    return acc
  }

  function readText(full) {
    try {
      const buf = fs.readFileSync(full)
      if (buf.length > MAX_BYTES || buf.includes(0)) return null
      return buf.toString('utf8')
    } catch { return null }
  }
  function writeToDisk(relPath, content) {
    if (!isSafeRelPath(relPath)) return // never write a path that could escape ROOT (defense in depth)
    const full = path.join(ROOT, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    shadow.set(relPath, content) // record what THE ENGINE wrote — any later disk divergence is an authored edit
    saveShadowSoon()             // ...and survive a restart, or the next join has no ancestor
    known.add(relPath)
    try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
  }

  // --- the ancestor, across restarts -----------------------------------------------------
  // Written next to writeToDisk deliberately: this file is only ever correct if it is saved
  // by the one function that changes `shadow`. Debounced, because reconcile can touch many
  // files in one pass and a synchronous write per file would show up as sync latency.
  function loadPriorShadow() {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(ROOT, SHADOW_FILE), 'utf8'))
      // A mismatched room or format means we have no ancestor for these files. Returning
      // empty is the SAFE answer — it degrades to the old first-contact behaviour rather
      // than merging against someone else's history.
      if (!o || o.v !== 1 || o.room !== room) return
      for (const [k, v] of Object.entries(o.files || {})) {
        if (typeof k === 'string' && typeof v === 'string' && isSafeRelPath(k)) priorShadow.set(k, v)
      }
      log(`[hive] recovered ${priorShadow.size} file ancestor(s) from the previous session`)
    } catch { /* absent or unreadable: no ancestor, same as before this existed */ }
  }
  let shadowTimer = null
  function saveShadowSoon() {
    if (shadowTimer) return
    shadowTimer = setTimeout(() => { shadowTimer = null; saveShadow() }, 1500)
    if (shadowTimer.unref) shadowTimer.unref() // never hold the process open just to save this
  }
  function saveShadow() {
    const files = {}
    // Only what we could actually merge against later. A file over MAX_BYTES is not synced
    // in the first place, so storing it would inflate this file for no benefit.
    for (const [k, v] of shadow) if (typeof v === 'string' && v.length <= MAX_BYTES) files[k] = v
    const tmp = path.join(ROOT, SHADOW_FILE + '.tmp')
    try {
      // Write-then-rename: a half-written ancestor file is worse than none, because the
      // loader would read a truncated body as the real previous content and merge against it.
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, room, files }))
      fs.renameSync(tmp, path.join(ROOT, SHADOW_FILE))
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch { }
      log(`[hive] could not save the file-ancestor record: ${e.message}`)
    }
  }

  const conflicted = new Set() // files currently holding unresolved <<<<<<< markers
  const icrWarned = new Map()  // relPath -> last ICR semantic warning announced (dedupe)
  function reconcile(relPath, origin = 'local') {
    if (SKIP.has(relPath) || isIgnored(relPath)) return // never sync secrets/ignored files
    if (!canOpen(relPath)) return // out-of-scope OR unsafe path (traversal/control char) — never materialize it
    const full = path.join(ROOT, relPath)
    const exists = fs.existsSync(full)
    const disk = exists ? readText(full) : null
    if (exists && disk === null) return // present on disk but binary/too-large to represent — leave it untouched (never clobber with stale doc text)
    // View-only file: never PUSH our local change/creation (the relay would drop it
    // anyway — it connects this file-room as a reader). Keep disk in sync with the
    // shared copy if we already have it; a brand-new local-only file just stays local
    // and is never registered in the manifest. Reads (origin !== 'local') flow on.
    if (origin === 'local' && !canWrite(relPath)) {
      const fe2 = fileDocs.get(relPath)
      if (fe2 && fe2.synced) { const dt = fe2.text.toString(); if (dt && dt !== disk) writeToDisk(relPath, dt) }
      return
    }
    // Per-file doc gating: we must know the RELAY's content before touching disk.
    // Until the file-doc has synced, an empty Y.Text means "not pulled yet", not
    // "empty file" — acting now would re-seed from disk and fork the CRDT history
    // (duplicated/garbled content on rejoin). So: open if needed, then defer until
    // the 'sync' handler re-runs us. Once synced, "" genuinely means empty.
    let fe = fileDocs.get(relPath)
    if (!fe) { if (disk === null) return; openFile(relPath); return }
    if (!fe.synced) return
    touchFile(relPath) // reconciling a file IS using it — keep it in the working set
    // SOURCE CAPTURE (fork gate): before ANYTHING in this pass can merge over or render into
    // this file, record any authored edit sitting on disk. The edit enters the provenance
    // DAG first; whatever happens to the disk afterwards can no longer lose it.
    if (FORK_GATE) captureLocal(relPath)
    // --- provenance conflict state machine (local-render model) ---
    // While a file is in a surfaced fork, its markers live ONLY on disk; the shared
    // Y.Text is left at the fused value. This is what avoids the marker-fusion the old
    // in-CRDT approach suffered — nothing conflict-related is ever written to Y.Text.
    if (FORK_GATE && fe.conflict) {
      const rec = forkRecord(fe)
      if (rec) {
        const block = forkBlock(fe, rec)
        if (origin === 'local') {
          if (disk === block) return // our own rendered conflict — ignore
          const fork0 = forkBases.get(relPath)
          // Did THIS author edit FROM the conflict block (i.e. they saw the markers)? Only
          // then is a clean edit a RESOLUTION. A clean edit from a NON-marked base is just a
          // concurrent authored edit that happened during the fork — it must NOT be mistaken
          // for a resolution, or that agent's work silently replaces everyone's conflict.
          const sawMarkers = fork0 === block || hasConflictMarkers(fork0 || '')
          if (sawMarkers && disk !== null && !hasConflictMarkers(disk)) {
            // RESOLUTION: a human replaced the markers with clean code. Publish it to the
            // shared text, fold the fork versions, and clear the record for everyone.
            fe.doc.transact(() => {
              applyDiff(fe.text, disk)
              for (const v of rec.versions) fe.forkmark.set(v.hash, 1)
              for (const key of [...fe.conflict.keys()]) fe.conflict.delete(key)
            })
            stampProvenance(relPath, block || '', disk)
            conflicted.delete(relPath)
            known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk)
            try { say(`✓ conflict in ${relPath} resolved by ${name}.`) } catch { }
            return
          }
          if (!sawMarkers && disk !== null && disk !== fork0) {
            // A concurrent authored edit landed WHILE the fork was open (this agent never saw
            // the markers). The source capture at the top of this pass already stamped it, so
            // it is in the fork's version set — re-detect so the record grows to include it.
            detectFork(relPath)
            return
          }
          renderConflict(relPath); return // still conflicted (or partially edited) — re-assert canonical block
        }
        renderConflict(relPath); return // remote churn while in conflict — keep our local render
      }
      // No active record, but our disk still shows stale markers while the shared text is
      // clean again -> a resolution landed elsewhere; adopt it (order-independent w/ observer).
      if (disk !== null && hasConflictMarkers(disk) && !hasConflictMarkers(fe.text.toString())) { adoptResolved(relPath); return }
    }
    const docText = fe.text.toString()
    // An empty shared doc is authoritative ONLY if we have history for this path.
    // A file's NAME lives in the parent doc and its CONTENT in the file's own doc, on two
    // different connections — there is no atomicity across them. A client that joins a large
    // project and dies mid-join gets every manifest key up and only some file bodies, leaving
    // the room asserting that paths exist with nothing behind them. With no ancestor and real
    // bytes on disk, "" means the publisher never finished, not that the file is empty, and
    // adopting it deletes real work (measured: 186 files zeroed across three folders).
    // A genuine emptying of a file we HAVE synced still has an ancestor, so it falls through
    // to the merge below and still lands.
    const noHistory = !bases.has(relPath) && !priorShadow.has(relPath)
    // HIV-P14b tracing, env-gated. Which branch a blind recreate actually takes was guessed
    // wrong twice from reading the code; this answers it from the running product.
    if (process.env.HIVE_P14_DEBUG && new RegExp(process.env.HIVE_P14_DEBUG).test(relPath)) {
      log(`[P14] ${relPath} origin=${origin} synced=${fe.synced} docLen=${docText.length} ` +
        `diskLen=${disk === null ? 'null' : disk.length} hasBase=${bases.has(relPath)} ` +
        `priorShadow=${priorShadow.has(relPath)} inManifest=${manifest.has(relPath)} ` +
        `preexisting=${preexisting.has(relPath)}`)
    }
    if (docText === '' && (!manifest.has(relPath) || (disk && noHistory))) {
      // the relay has no usable copy of this path -> publish ours (a genuinely new file,
      // or one whose registration outlived the join that promised it)
      if (disk === null) return
      if (process.env.HIVE_P14_DEBUG) log(`[P14] BRANCH=genesis-publish ${relPath}`)
      fe.doc.transact(() => applyDiff(fe.text, disk))
      stampProvenance(relPath, '', disk) // genesis: sign the file's first content (base = empty)
      manifest.set(relPath, 1)
      known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk); shadow.set(relPath, disk)
      try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
      captureSnapshot(relPath, disk, name, { force: true, kind: 'base', label: 'created' }); snappedBase.add(relPath)
      return
    }
    const yt = fe.text
    if (disk === null) { writeToDisk(relPath, docText); bases.set(relPath, docText); forkBases.set(relPath, docText); return }
    if (disk === docText) {
      // CREATING a file is editing it. This branch is where a locally-authored NEW file
      // lands: scan() finds it, openFile() syncs the content up, and by the time reconcile
      // runs disk and doc already agree -- so it returns below, before the markEditing() at
      // the end of this function. Measured effect: an agent that creates a file and moves on
      // shows as plain "online", and only an agent that writes the SAME file twice ever
      // appears to be working. In a room of agents each producing a file or two, that renders
      // a busy room as an idle one.
      // Gated on FIRST SIGHT (`known` is set just below) so the 2s safety-net scan cannot
      // re-mark an untouched file, and on local origin so a remote change landing on disk is
      // not attributed to whoever received it -- the same distinction forkBases makes here.
      if (origin === 'local' && !known.has(relPath) && disk) markEditing(relPath)
      known.add(relPath); bases.set(relPath, disk); shadow.set(relPath, disk) // agreed state = capture baseline
      // disk and doc already agree — a safe fork point, but only adopt it as
      // THIS author's fork on first sight or our own local activity (a remote
      // change landing on disk doesn't mean the local author has seen it).
      if (!forkBases.has(relPath) || origin === 'local') forkBases.set(relPath, disk)
      if (!snappedBase.has(relPath) && disk) { captureSnapshot(relPath, disk, name, { force: true, kind: 'base', label: 'baseline' }); snappedBase.add(relPath) }
      return
    }
    // FIRST-CONTACT ADOPT (no common ancestor). We have never reconciled this file
    // this session (no base history), yet it ALREADY exists in the room (non-empty
    // docText) AND on local disk with DIFFERENT content. There is no shared base, so
    // a 3-way merge would UNION the two copies — the duplicated-content bug seen when
    // a client clones a repo and then joins a room that already has those files. A
    // joining client adopts the ROOM's copy wholesale; its local copy is preserved as
    // a restore point so nothing is lost and the user can revert if it was the good one.
    if (!bases.has(relPath) && docText !== '' && disk !== docText) {
      // CREATION RACE, not a late join. The adopt below is correct only when our local
      // copy PRE-DATES this session (clone-then-join). If this path appeared on disk
      // after we started, then both copies were authored concurrently -- two agents
      // creating the same new file within the sync window -- and adopting the room's
      // copy silently discards work its author just wrote, with no conflict shown.
      // There is genuinely no common ancestor here, so merge from an EMPTY base:
      // disjoint additions union (the normal case -- each author added their own
      // block), and a real overlap raises conflict markers for a human to settle
      // instead of the engine quietly picking a winner on arrival order.
      // HIV-P14b, OPEN AND DELIBERATELY NOT IMPLEMENTED HERE YET.
      //
      // There is a third case this dichotomy misses: the path appeared on OUR disk after we
      // started AND the room already had it before we joined. That is not a race -- the agent
      // could not see the file (bounded working set, nothing touched it), believed it did not
      // exist, and wrote one. Measured 21 Sep 2026: agent B recreated mod039.js and agent A's
      // copy ended up with two const declarations of the same name.
      //
      // `preexisting` records our DISK, so it structurally cannot tell those apart; the manifest
      // as of first sync can. A guard on that was written and REMOVED before shipping, because
      // the probe showed it never firing -- most likely the manifest is not yet populated at the
      // instant the base provider reports sync, so the snapshot came back empty. A refusal path
      // that silently never runs is worse than none: it reads as protection in review and does
      // nothing in production, which is the defect class this repo keeps hitting.
      //
      // What ships instead is the reporting half, which is verified: status() now exposes
      // filesHeld/roomFiles/filesMissing instead of a full house, and the join announces the gap
      // with the count and the remedy. An agent told "33 files exist here that you do not have,
      // reading the path fetches it" will not recreate them. That removes the cause; the guard
      // is the belt for when it happens anyway, and it lands when it is proven to fire.
      if (process.env.HIVE_P14_DEBUG) log(`[P14] BRANCH=no-base-block ${relPath} preexisting=${preexisting.has(relPath)}`)
      // HIV-P14b. A BLIND RECREATE IS NOT A RACE, and the empty-base merge below corrupts it.
      //
      // The dichotomy above has a third case: the path appeared on OUR disk after we started AND
      // the room already had it before we joined. The working set is bounded, nothing touched
      // that file, so the agent could not see it, concluded it did not exist, and wrote one.
      //
      // Measured 21 Sep 2026, traced through the running product. Agent B, holding 8 of a room's
      // 41 files, wrote mod039.js:
      //   mod039.js origin=remote synced=true docLen=22 diskLen=39 hasBase=false
      //             inManifest=true preexisting=false   -> BRANCH=no-base-block
      // It lands exactly here, `preexisting` is false, and the empty-base merge unions two whole
      // files into agent A's copy:
      //   export const v39 = 39
      //   export const v39 = "FROM SCRATCH BY B"
      // Two const declarations of the same name. Invalid code, in someone else's folder, from B
      // doing the only thing available to it.
      //
      // The union is right for what the comment above describes -- two authors adding DIFFERENT
      // blocks to a file they both just created. It is wrong for two independent whole-file
      // creations of the same module, which is what a blind recreate always is.
      //
      // `roomAtJoin` is the discriminator `preexisting` cannot be: a path in it existed in the
      // ROOM before we did, however new it is on our disk. The `roomAtJoin &&` guard is
      // load-bearing -- before first sync it is null, and treating null as an empty room would
      // classify every joiner's first creation as a race.
      //
      // Adopt the room's copy, because it is the real file and the agent needs it to work from,
      // and snapshot the local draft so nothing the agent wrote is lost. Then say so loudly: the
      // entire failure was the agent not knowing the file was already there.
      if (roomAtJoin && roomAtJoin.has(relPath) && !preexisting.has(relPath)) {
        captureSnapshot(relPath, disk, name, {
          force: true, kind: 'manual',
          label: `local draft preserved — ${relPath} already existed in the room before this client joined`,
        })
        bases.set(relPath, docText); forkBases.set(relPath, docText); shadow.set(relPath, docText)
        if (docText !== disk) writeToDisk(relPath, docText)
        try {
          say(`⚠ ${relPath} ALREADY EXISTED IN THE ROOM before I joined — I had not fetched it, so it was ` +
            `written here from scratch. The room's copy is now on disk and my draft was snapshotted. ` +
            `This folder holds a bounded working set: a file you cannot see may still exist, so read or ` +
            `claim the path before creating it. hive_status reports filesHeld of roomFiles.`)
        } catch { }
        if (process.env.HIVE_P14_DEBUG) log(`[P14] BRANCH=blind-recreate-refused ${relPath}`)
        return
      }
      if (!preexisting.has(relPath)) {
        // Terminate both sides before merging. With an empty base there is no shared
        // trailing context, so a side whose last line lacks a newline gets its final
        // statement fused onto the other side's first one. The result still parses,
        // which is worse than failing -- it reads as corruption to whoever opens it.
        const nl = (s) => (s === '' || s.endsWith('\n') ? s : s + '\n')
        const r0 = icrMerge3('', nl(disk), nl(docText), relPath)
        // HIV-P17: SILENT COLLISION DETECTION on genesis-publish creation race.
        // The normal merge path (below, ~line 1880) runs fusionReason() to catch merges
        // that broke valid code or duplicated structure. This creation-race path skipped
        // that check entirely — a dead-heat race could silently fuse two whole-file
        // rewrites of the same module and nobody was told. Now we run the same check:
        // if both inputs parsed but the merged result does not, or if the merge duplicated
        // structure, refuse it — keep both sides intact and announce loudly.
        if (!r0.conflict) {
          const why = fusionReason(r0.text, nl(disk), nl(docText), supports(relPath) ? languageFor(relPath) : null)
          if (why) {
            conflicted.add(relPath)
            // Do NOT write the fused result to doc or disk. The doc already holds docText
            // (the room's copy) and disk holds the local draft — both are intact. Setting
            // bases to docText means the next normal edit will merge against the room's copy,
            // which is the same recovery path the normal-merge refusal uses.
            bases.set(relPath, docText); forkBases.set(relPath, docText); shadow.set(relPath, docText)
            if (!manifest.has(relPath)) manifest.set(relPath, 1)
            if (icrWarned.get(relPath) !== why) {
              icrWarned.set(relPath, why)
              log(`[${name}] !! HIV-P17 REFUSED a fused creation-race merge of ${relPath}: ${why}`)
              try {
                say(`[!] @all ${relPath}: a creation-race merge was REFUSED because it fused rather than merged — ${why}. Nothing was written: the room's copy and ${name}'s local copy are both intact. Someone must reconcile them deliberately; a plain file write will merge against the other version again, hive_edit replaces it outright.`)
              } catch { /* the log still carries it */ }
            }
            return
          }
        }
        if (r0.text !== docText) fe.doc.transact(() => applyDiff(yt, r0.text))
        if (r0.text !== disk) writeToDisk(relPath, r0.text)
        if (r0.conflict) conflicted.add(relPath)
        bases.set(relPath, r0.text); forkBases.set(relPath, r0.text); shadow.set(relPath, r0.text)
        if (!manifest.has(relPath)) manifest.set(relPath, 1)
        try { say(`⚠ ${relPath} was created by two participants at once — both versions were merged${r0.conflict ? ', and CONFLICT markers need resolving' : ''}.`) } catch { }
        return
      }
      // REJOIN, NOT A FIRST JOIN. If a previous session of this client wrote this file in
      // this room, we DO have a common ancestor and the adopt below is simply wrong: the
      // local copy may be newer than the room's (edited while disconnected, or the room
      // came back stale). This is the data-loss case that was seen live.
      const anc = priorShadow.get(relPath)
      if (anc !== undefined && disk !== null) {
        if (disk === anc) {
          // Local is exactly what we last wrote — nobody touched it while we were away, so
          // the room's copy is strictly newer and adopting it loses nothing.
          writeToDisk(relPath, docText)
          bases.set(relPath, docText); forkBases.set(relPath, docText)
          if (!snappedBase.has(relPath)) { captureSnapshot(relPath, docText, name, { force: true, kind: 'base', label: 'room copy adopted on rejoin (local was unchanged)' }); snappedBase.add(relPath) }
          return
        }
        // Divergent AND we know the ancestor: merge the two, do not pick a winner. Snapshot
        // the local side first so the pre-merge bytes are recoverable regardless of outcome.
        captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy before rejoin merge' })
        const rj = icrMerge3(anc, disk, docText, relPath)
        if (rj.text !== docText) fe.doc.transact(() => applyDiff(yt, rj.text))
        if (rj.text !== disk) writeToDisk(relPath, rj.text)
        if (rj.conflict) conflicted.add(relPath)
        bases.set(relPath, rj.text); forkBases.set(relPath, rj.text); shadow.set(relPath, rj.text)
        if (!manifest.has(relPath)) manifest.set(relPath, 1)
        try { say(`⚠ ${relPath} changed locally while ${name} was disconnected — the local edit and the room copy were merged${rj.conflict ? ', and CONFLICT markers need resolving' : ''}. Pre-merge local copy is in the file's history.`) } catch { }
        return
      }
      // Genuinely no ancestor (a clone-then-join, or joining with an existing checkout).
      // HIV-P9: Do NOT adopt the room's copy blindly. Check provenance!
      // Has the room ever seen what is currently on disk?
      const receipts = fe && fe.ledger ? fe.ledger.toArray() : []
      const st = accountFor({ rel: relPath, branchText: disk, roomText: docText, receipts })

      if (st.state === DESCENDS || st.state === IDENTICAL) {
        // Safe: The room has passed through our disk content, so the room's copy is a true descendant.
        captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy at join (room copy adopted)' })
        writeToDisk(relPath, docText)
        bases.set(relPath, docText); forkBases.set(relPath, docText)
        if (!snappedBase.has(relPath)) { captureSnapshot(relPath, docText, name, { force: true, kind: 'base', label: 'adopted from room at join' }); snappedBase.add(relPath) }
        try { say(`↓ ${relPath} already existed in this room — ${name} adopted the room's copy. The local version before joining is saved in the file's history.`) } catch { }
        return
      }

      // DIVERGED or UNPROVEN: The room has NEVER seen local disk's content, or has no proof.
      // Overwriting disk with docText would cause silent data loss (e.g. wiping out local fixes).
      // Merging from an empty base would concatenate both copies, creating invalid syntax.
      // Refuse adoption: keep local disk untouched, keep room doc untouched, snapshot local, and announce loudly.
      captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: `local copy preserved at join (${st.state}: room copy refused)` })
      bases.set(relPath, disk); forkBases.set(relPath, disk)
      try {
        say(`⚠ ${relPath} already existed in room with different content (${st.state}) — room copy was NOT adopted. Local disk was preserved. Resolve deliberately.`)
      } catch { }
      return
    }
    const base = bases.has(relPath) ? bases.get(relPath) : disk
    const fork = forkBases.has(relPath) ? forkBases.get(relPath) : base
    if (origin === 'local') { noteCoEditing(relPath); markEditing(relPath) } // broadcast activity + warn if someone else is on this file

    let res, reAdded = false
    if (origin === 'local' && hasConflictMarkers(docText) && !hasConflictMarkers(disk)) {
      // Resolving a conflict: the doc still has <<<<<<< markers and this local
      // write removed them — the author has resolved it. Their clean version wins.
      res = { text: disk, conflict: false }
    } else if (origin === 'local') {
      noteIfRewrite(relPath, fork, disk)
      // Check if this write is an intentional clean rewrite
      const sc = summarizeChange(fork, disk)
      const isCleanRewrite = sc.isRewrite && supports(relPath) && languageFor(relPath).parses(disk)

      // Merge a local edit against the FORK POINT (what this author
      // last saw), not the latest doc. If the doc gained lines since the fork
      // that this write does NOT contain, the author was working from a stale
      // copy — merging against the fork re-adds those lines (disjoint) or raises
      // a conflict (overlap) instead of silently deleting another's work.
      const theirsNew = changedRange(fork.split('\n'), docText.split('\n')).newLines.filter((l) => l.length)
      const mineLines = new Set(disk.split('\n'))
      const integrated = theirsNew.every((l) => mineLines.has(l)) // this write already contains the remote change
      if (integrated || (isCleanRewrite && !hasConflictMarkers(docText))) {
        res = { text: disk, conflict: false } // author built on the latest or cleanly rewrote — trust it
      } else {
        res = icrMerge3(fork, disk, docText, relPath)
        reAdded = !res.conflict && res.text !== disk // we restored remote lines a stale write had dropped
      }
    } else {
      res = icrMerge3(base, disk, docText, relPath) // incoming remote change merged into our working copy
    }

    // FUSION GUARD (HIV-26). A merge must never produce something NEITHER author wrote.
    //
    // On 18 Sep 2026 three peers wrote the same file within about a second of each other and
    // the character-CRDT UNIONED the versions instead of converging: sync.js went 144,144 ->
    // 291,750 bytes, `const MAX_OPEN` appeared three times, and the splice landed mid-token
    // (`evicted// Newly opened...`). There were NO conflict markers, every peer converged on
    // the corruption — so agreement proved nothing — and the only thing that caught it was a
    // parse failure at the handoff gate, by which point it had already reached every folder.
    //
    // Two cheap signals, each catching what the other misses:
    //   - the merge BROKE a file both sides could parse. Definitionally wrong: whatever that
    //     output is, neither author wrote it.
    //   - the result is about as long as both sides put together. That is concatenation in a
    //     merge's clothing, and it catches a fusion that happens to still parse.
    //
    // We land NOTHING. Not a conflict block either: this engine deliberately keeps markers
    // out of the shared text, because writing them into the very layer that fuses is what
    // produced marker-fusion before. So the doc keeps its version, disk keeps its version,
    // both are still intact and recoverable, and the room is TOLD. A file left visibly
    // divergent is a bad day; a file silently fused is an unrecoverable one.
    if (res && !res.conflict) {
      const why = fusionReason(res.text, disk, docText, supports(relPath) ? languageFor(relPath) : null)
      if (why) {
        conflicted.add(relPath)
        if (icrWarned.get(relPath) !== why) {
          icrWarned.set(relPath, why)
          log(`[${name}] !! REFUSED a fused merge of ${relPath}: ${why}`)
          try {
            say(`[!] @all ${relPath}: a merge was REFUSED because it fused rather than merged — ${why}. Nothing was written: the room's copy and ${name}'s local copy are both intact and unchanged. Someone must reconcile them deliberately; a plain file write will merge against the other version again, hive_edit replaces it outright.`)
          } catch { /* the log still carries it */ }
        }
        return
      }
    }

    // Snapshot the state JUST BEFORE this author's edit lands, attributed to them —
    // captured only on local origin so each change is recorded once, by its author.
    if (origin === 'local' && res.text !== docText) {
      const sc = summarizeChange(docText, res.text)
      captureSnapshot(relPath, docText, name, { force: sc.isRewrite, churn: `${sc.changedLines}/${sc.totalLines} lines` })
      lastLocalEdit = relPath
    }
    fileDocs.get(relPath).doc.transact(() => applyDiff(yt, res.text))
    // Sign this landed local change into the file's provenance ledger (I1). Stamp the
    // author's TRUE intent — the state THEY edited from (fork) -> the content THEY wrote
    // (disk) — NOT the live shared text, which under truly-concurrent edits is already
    // fusing. Recording (fork, disk) keeps every concurrent same-line edit anchored to the
    // SAME clean parent, so the fork stays detectable no matter how the char-CRDT fuses.
    if (origin === 'local') {
      // Gate ON: the author's INTENT was already captured at the source (captureLocal, top
      // of this pass) — here we only advance the authority head to the landed content.
      // Gate OFF (default): the proven landed-transition stamp, unchanged.
      if (FORK_GATE) { if (res.text !== docText) attestHead(relPath, res.text, docText) }
      else if (res.text !== docText) stampProvenance(relPath, docText, res.text)
    }
    if (res.text !== disk) writeToDisk(relPath, res.text)
    known.add(relPath); bases.set(relPath, res.text)
    if (origin === 'local') forkBases.set(relPath, res.text) // we authored this state; it's our new fork
    else if (!forkBases.get(relPath)) forkBases.set(relPath, res.text) // bootstrap: first real content a joining client receives is its fork
    // Conflict guard: announce a NEW conflict in chat (so everyone — and any
    // agent on hive_wait — is alerted), and announce when it's later resolved.
    const hasMarkers = res.conflict || hasConflictMarkers(res.text)
    if (hasMarkers && !conflicted.has(relPath)) {
      conflicted.add(relPath)
      log(`[${name}] ⚠ merge conflict in ${relPath} — kept BOTH versions with <<<<<<< markers`)
      try { say(`⚠ MERGE CONFLICT in ${relPath} — it has <<<<<<< markers. Whoever owns it: resolve before continuing.`) } catch { }
    } else if (!hasMarkers && conflicted.has(relPath)) {
      conflicted.delete(relPath)
      try { say(`✓ conflict in ${relPath} resolved.`) } catch { }
    } else if (reAdded) {
      log(`[${name}] protected ${relPath}: your edit was based on an older version — re-added changes that arrived since (nobody's work lost)`)
      try { say(`↺ ${relPath}: ${name}'s edit was based on an older copy — kept the changes that landed in between (nothing lost).`) } catch { }
    } else if (!hasMarkers && res.icr === 'rename') {
      log(`[${name}] ICR merged ${relPath} (detected a rename and updated the call sites)`)
    } else if (!hasMarkers && res.icr === 'structural') {
      log(`[${name}] ICR merged ${relPath} structurally (both edits kept, syntax guaranteed)`)
    } else if (!hasMarkers) {
      log(`[${name}] merged ${relPath} (both edits kept)`)
    }

    // ICR semantic warning: the text merged, but ICR saw a meaning-level problem a line
    // merge can't (e.g. a dangling reference). Surface it once per distinct warning so it
    // isn't lost — this is exactly the class of bug ICR exists to catch.
    if (res.icrWarning && icrWarned.get(relPath) !== res.icrWarning) {
      icrWarned.set(relPath, res.icrWarning)
      log(`[${name}] ⚠ ICR flag in ${relPath} — ${res.icrWarning}`)
      try { say(`⚠ ICR flag in ${relPath}: ${res.icrWarning}. It merged, but review — this is a break a plain merge can't see.`) } catch { }
    } else if (!res.icrWarning && icrWarned.has(relPath)) {
      icrWarned.delete(relPath)
    }

    // Health gate on the live path: after the char-CRDT has converged, check whether the
    // current content is a SILENT FORK (a fusion nobody authored). If so, record it (the
    // record is rendered to disk locally — never written back into the shared text).
    detectFork(relPath)
  }

  const fmtTime = () => new Date().toTimeString().slice(0, 8)
  // Log file activity to the shared board: EVERY meaningful edit (so the live
  // activity feed reflects ongoing work), tagged with whether it was a full-file
  // `rewrite` and a numeric `ts` for ordering. HIVE_BOARD.md stays rewrites-only
  // (see renderBoard) so the "read before editing" coordination doc isn't noisy.
  function noteIfRewrite(relPath, base, next) {
    if (base == null || base === next) return
    const s = summarizeChange(base, next)
    if (!s.changedLines) return
    board.set(relPath, { by: name, at: fmtTime(), ts: Date.now(), churn: `${s.changedLines}/${s.totalLines} lines`, symbols: s.symbols, rewrite: s.isRewrite })
    if (s.isRewrite) log(`[${name}] board: logged REWRITE of ${relPath} (${s.changedLines}/${s.totalLines} lines; touched ${s.symbols.join(', ') || 'n/a'})`)
  }
  function renderBoard() {
    // HIVE_BOARD.md is the coordination doc: full-file REWRITES only (small edits
    // live in the activity feed via the board map, but don't clutter this file).
    const entries = [...board.entries()].map(([file, e]) => ({ file, ...e })).filter((e) => e.rewrite).sort((a, b) => (b.ts || 0) - (a.ts || 0) || (a.at < b.at ? 1 : -1))
    if (!entries.length) return // no rewrites yet — don't create/clutter the board file
    const out = [
      '# Hive Board — recent full-file rewrites (auto-logged by Hivecode).',
      '# READ THIS before editing a file someone just rewrote, then re-read that file.',
      '',
    ]
    for (const e of entries) out.push(`- ${e.at}  ${e.by} rewrote \`${e.file}\` (${e.churn}) — touched: ${(e.symbols || []).join(', ') || 'n/a'}`)
    writeToDisk(BOARD_FILE, out.join('\n') + '\n')
  }
  if (syncFiles) board.observe(() => { renderBoard(); linkMemory() })

  // --- rollback: restore points + per-author revert + undo --------------------
  // Every meaningful change captures a RESTORE POINT: the file's content from JUST
  // BEFORE the edit, stored in that file's own doc (scope-safe) and indexed in the
  // parent `history` (metadata only). Restoring is a normal forward edit (applyDiff
  // back to the saved content) — so it propagates live to everyone, merges cleanly,
  // and is itself recoverable. Because each client snapshots only ITS OWN local
  // edits, every restore point is attributed to its true author exactly once.
  const SNAP_KEEP = 30          // max AUTO restore points kept per file (manual ones never evicted)
  const SNAP_MIN_GAP_MS = 4000  // throttle auto-capture per file (fine-grained undo is the editor's job)
  const META_KEEP = 400         // global cap on the parent timeline index
  const lastSnapAt = new Map()  // relPath -> ts of last auto-capture
  const snappedBase = new Set() // files we've already floored with a baseline snapshot
  const snapId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  function pruneMeta() {
    if (historyMeta.size <= META_KEEP) return
    const all = [...historyMeta.values()].filter((e) => e.kind === 'auto').sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const overflow = historyMeta.size - META_KEEP
    if (overflow <= 0) return
    doc.transact(() => { for (let i = 0; i < Math.min(overflow, all.length); i++) historyMeta.delete(all[i].id) })
  }

  // Capture `content` as a restore point for relPath, attributed to `byWho`.
  // kind: 'auto' (an ordinary edit), 'base' (a file's floor), 'manual' (a named
  // checkpoint), 'restore' (the pre-restore state, kept so restore is reversible).
  function captureSnapshot(relPath, content, byWho, { force = false, churn = '', kind = 'auto', label = '' } = {}) {
    if (content == null) return null
    const fe = fileDocs.get(relPath); if (!fe) return null
    const now = Date.now()
    if (kind === 'auto' && !force && now - (lastSnapAt.get(relPath) || 0) < SNAP_MIN_GAP_MS) return null
    const snap = fe.snap
    let latest = null
    for (const e of snap.values()) if (!latest || (e.ts || 0) > (latest.ts || 0)) latest = e
    if (latest && latest.content === content) return null // identical to the most recent point — nothing to keep
    const id = snapId()
    const at = fmtTime()
    const pruned = []
    fe.doc.transact(() => {
      snap.set(id, { id, file: relPath, by: byWho, at, ts: now, content, churn, kind, label })
      const autos = [...snap.values()].filter((e) => e.kind === 'auto').sort((a, b) => (a.ts || 0) - (b.ts || 0))
      for (let i = 0; i < autos.length - SNAP_KEEP; i++) { snap.delete(autos[i].id); pruned.push(autos[i].id) }
    })
    if (kind === 'auto') lastSnapAt.set(relPath, now)
    doc.transact(() => {
      historyMeta.set(id, { id, file: relPath, by: byWho, at, ts: now, churn, kind, label }) // metadata only — no content
      for (const pid of pruned) historyMeta.delete(pid) // keep the index in step with evicted content
    })
    pruneMeta()
    return id
  }

  // Find which file a restore-point id belongs to (via the index, else by scanning
  // open file docs as a fallback).
  function fileOfSnap(id) {
    const m = historyMeta.get(id)
    if (m && m.file) return m.file
    for (const [rp, fe] of fileDocs) if (fe.snap.has(id)) return rp
    return null
  }

  // Restore a file to a saved restore point. It first snapshots the CURRENT state
  // (so the restore can itself be undone), then writes the saved content back as a
  // normal edit — which syncs to everyone and to disk.
  function restore(id, by = name) {
    const relPath = fileOfSnap(id)
    if (!relPath) return { error: 'restore point not found' }
    if (!canOpen(relPath)) return { error: `${relPath} is out of your scope` }
    if (!canWrite(relPath)) return { error: `${relPath} is read-only for you` }
    let fe = fileDocs.get(relPath)
    if (!fe) { openFile(relPath); fe = fileDocs.get(relPath) }
    if (!fe) return { error: 'could not open file' }
    const entry = fe.snap.get(id)
    if (!entry || entry.content == null) return { error: 'restore point content unavailable (it may have aged out)' }
    const current = fe.text.toString()
    if (current === entry.content) return { ok: true, unchanged: true, file: relPath }
    captureSnapshot(relPath, current, by, { force: true, kind: 'restore', label: `before restore to ${entry.at}` })
    captureLocal(relPath) // record any pending authored edit before the restore overwrites it
    fe.doc.transact(() => applyDiff(fe.text, entry.content))
    writeToDisk(relPath, entry.content)
    bases.set(relPath, entry.content); forkBases.set(relPath, entry.content)
    try { say(`↩ ${by} restored ${relPath} to ${entry.at}${entry.by && entry.by !== by ? ` (state before ${entry.by}'s edit)` : ''}.`) } catch { }
    return { ok: true, file: relPath }
  }

  // Restore one file to its state as of timestamp `ts` (the newest point at/below ts).
  function restoreFileTo(relPath, ts, by = name) {
    const fe = fileDocs.get(relPath)
    if (!fe) return { error: 'file not open' }
    let best = null
    for (const e of fe.snap.values()) if ((e.ts || 0) <= ts && (!best || (e.ts || 0) > (best.ts || 0))) best = e
    if (!best) return { error: 'no restore point at/before that time' }
    return restore(best.id, by)
  }

  // Revert everything an author did since `sinceTs` (default: all of it): for each
  // file they touched, roll back to the state BEFORE their first edit in the window.
  // Honest limitation: this is checkpoint-granular, so if SOMEONE ELSE also edited
  // the same file after that point, their edits in that file are rolled back too.
  // For the dangerous case — an agent rewriting files — that's exactly right.
  function revertAuthor(who, sinceTs = 0, by = name) {
    if (!who) return { error: 'no author given' }
    const earliest = new Map() // file -> earliest meta authored by `who` in the window
    for (const m of historyMeta.values()) {
      if (m.by !== who || (m.ts || 0) < sinceTs) continue
      const cur = earliest.get(m.file)
      if (!cur || (m.ts || 0) < (cur.ts || 0)) earliest.set(m.file, m)
    }
    const files = []
    for (const [file, m] of earliest) files.push({ file, ...restore(m.id, by) })
    const ok = files.filter((f) => f.ok).length
    if (files.length) { try { say(`⏮ ${by} reverted ${who}'s changes across ${ok}/${files.length} file(s).`) } catch { } }
    return { ok: true, reverted: ok, files }
  }

  // The timeline (newest first), read from the parent index. Optional filters.
  function listHistory({ file = null, by = null, limit = 200 } = {}) {
    return [...historyMeta.values()]
      .filter((e) => (!file || e.file === file) && (!by || e.by === by))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit)
  }

  // A named manual checkpoint of a file's current state (never auto-evicted).
  function checkpoint(relPath, label = '', by = name) {
    const fe = fileDocs.get(relPath); if (!fe) return { error: 'file not open' }
    const id = captureSnapshot(relPath, fe.text.toString(), by, { force: true, kind: 'manual', label: label || `checkpoint by ${by}` })
    return id ? { ok: true, id } : { ok: true, unchanged: true }
  }

  // Level-0 undo/redo: a client undoes its OWN recent CRDT edits to a file. (In an
  // editor, native Ctrl-Z already covers your own typing; this also covers edits
  // applied programmatically and keeps the doc, disk, and peers in step.)
  let lastLocalEdit = null
  function undoLast() {
    const rp = lastLocalEdit; const fe = rp && fileDocs.get(rp)
    if (!fe || !fe.undo || !fe.undo.canUndo()) return { error: 'nothing to undo' }
    fe.undo.undo()
    const t = fe.text.toString(); writeToDisk(rp, t); bases.set(rp, t); forkBases.set(rp, t)
    return { ok: true, file: rp }
  }
  function redoLast() {
    const rp = lastLocalEdit; const fe = rp && fileDocs.get(rp)
    if (!fe || !fe.undo || !fe.undo.canRedo()) return { error: 'nothing to redo' }
    fe.undo.redo()
    const t = fe.text.toString(); writeToDisk(rp, t); bases.set(rp, t); forkBases.set(rp, t)
    return { ok: true, file: rp }
  }

  // --- coordination channel: the agents (and humans) talk to each other ---
  // say() posts a message into the shared, ordered chat. Everyone renders the
  // whole conversation to HIVE_CHAT.md locally, so an agent just READS that file
  // to see what others are doing and APPENDS via say() (or `node hive-say.js`).
  function say(text) {
    if (!text) return
    chat.push([{ by: name, kind, at: fmtTime(), text: String(text) }])
  }
  function renderChat() {
    const out = [
      '# Hive Chat — the live coordination channel for everyone in this room.',
      '# Humans and AI agents talk here. Agents: READ this before/while working,',
      '# and announce what you are about to do (e.g. "taking auth.js: add login").',
      '',
    ]
    for (const m of chat.toArray()) out.push(`- ${m.at}  ${m.by} (${m.kind}): ${m.text}`)
    writeToDisk(CHAT_FILE, out.join('\n') + '\n')
  }
  // Hand the room's history to GRM whenever it changes, so this ROOM has a memory: an
  // agent joining tomorrow can ask what was decided here last week, including in
  // conversations it was never present for.
  //
  // Called from the writers rather than once at join, because at join these files do not
  // exist yet -- a room only has a history after something happens in it. linkRoom()
  // compares before it writes, so calling it per message costs four stat() calls and no
  // disk write, and the relay watcher never sees needless churn.
  let memoryLinked = false
  function linkMemory() {
    if (!syncFiles) return
    const r = grmLink.linkRoom(ROOT, memoryLinked ? () => {} : log) // announce once, not per message
    if (r.linked) memoryLinked = true
  }

  if (syncFiles) chat.observe(() => { renderChat(); linkMemory() })

  // --- directed work + permission ---
  // ASYMMETRIC gate (this is the rule that makes a hive both autonomous AND safe):
  //  - AI -> AI  = COORDINATION. Agents plan and hand work to each other freely;
  //    these tasks are auto-accepted so the hive flows without a human in the loop.
  //  - owner -> own AI = the owner directing their own agent; auto-accepted.
  //  - any OTHER human -> AI = a human telling someone else's agent what to do.
  //    This does NOT auto-run. It stays PENDING until that AI's OWNER says
  //    "do it or ignore" (decide). The agent acts only on 'accepted' tasks.
  // So agents coordinate among themselves, but a human can never make an agent
  // act without that agent's owner approving it.
  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  function assign(to, text) {
    if (!to || !text) return null
    const id = newId()
    const ownerOf = owners.get(to)
    // auto-accept when it's AI->AI coordination, the target has no owner to ask,
    // or the asker IS the target's owner. Otherwise it needs owner approval.
    const auto = kind === 'ai' || !ownerOf || name === ownerOf
    const status = auto ? 'accepted' : 'pending'
    const decidedBy = auto ? (kind === 'ai' ? `${name} (AI coordination)` : name) : null
    tasks.set(id, { id, to, by: name, byKind: kind, text: String(text), status, decidedBy, at: fmtTime() })
    if (auto) say(`@${to}: ${text}  (task ${id} — ${kind === 'ai' ? 'AI coordination, proceeding' : 'from owner, proceeding'})`)
    else say(`@${to}: ${text}  (task ${id} — ${ownerOf} must approve: do it or ignore?)`)
    return id
  }
  function decide(id, accept, by = name) {
    const t = tasks.get(id)
    if (!t) return { error: 'no such task' }
    const ownerOf = owners.get(t.to)
    if (ownerOf && by !== ownerOf) return { error: `only ${ownerOf} (owner of ${t.to}) can approve task ${id}` }
    tasks.set(id, { ...t, status: accept ? 'accepted' : 'denied', decidedBy: by })
    say(`task ${id} ${accept ? 'APPROVED' : 'denied'} by ${by}: "${t.text}"`)
    return { ok: true }
  }
  function complete(id, note = '') {
    const t = tasks.get(id); if (!t) return { error: 'no such task' }
    tasks.set(id, { ...t, status: 'done', decidedBy: t.decidedBy })
    say(`task ${id} done by ${name}${note ? ': ' + note : ''}`)
    return { ok: true }
  }
  const myTasks = () => [...tasks.values()].filter((t) => t.to === name)

  // --- mission control: pause / resume / steer an agent ---
  // A human (or an owner) can PAUSE an agent: it should finish its current step,
  // then stop picking up new work until resumed. Agents honor this via hive_wait
  // (it won't return work while paused) and the HIVE_RULES. Cooperative, not forced
  // — but combined with the task gate it gives a real "stop that agent" control.
  function control(target, state, by = name) {
    if (!target) return { error: 'no target' }
    controls.set(target, { state: state === 'paused' ? 'paused' : 'running', by, at: fmtTime() })
    say(`${by} ${state === 'paused' ? '⏸ paused' : '▶ resumed'} ${target}`)
    return { ok: true }
  }
  const isPaused = (who = name) => { const c = controls.get(who); return !!(c && c.state === 'paused') }
  function renderTasks() {
    const all = [...tasks.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
    const out = ['# Hive Tasks — directed work and approvals.', '# AI->AI = auto-accepted coordination. A non-owner human\'s request to an AI', '# stays PENDING until that AI\'s owner approves (do it or ignore).', '']
    if (!all.length) out.push('(no tasks)')
    for (const t of all) out.push(`- [${t.status}] ${t.id}  ${t.by} -> ${t.to}: ${t.text}${t.decidedBy ? `  (by ${t.decidedBy})` : ''}`)
    writeToDisk(TASKS_FILE, out.join('\n') + '\n')
  }
  if (syncFiles) tasks.observe(() => renderTasks())

  // --- live presence + activity: who is here AND what they're touching right now ---
  // Each client broadcasts the file it is currently editing via awareness, so the
  // whole room (and a watching human) sees "who is on what" live — the control-room
  // view of parallel agents. When you start editing a file someone else is already
  // on, you post a one-time heads-up so collisions get coordinated BEFORE a clobber,
  // not just merged after. Activity decays after EDIT_FRESH_MS of no edits.
  const EDIT_FRESH_MS = 15000
  let myEditing = null, myLastEdit = null
  let editingClearTimer = null
  const warnedAt = new Map() // file -> last time we warned about co-editing it
  const setUserState = () => provider.awareness.setLocalStateField('user', { name, kind, owner: owner || undefined, editing: myEditing || undefined, lastEdit: myLastEdit || undefined, v: PROTOCOL_VERSION, passive: !!passive })
  function markEditing(relPath) {
    myEditing = { file: relPath, at: Date.now() }
    myLastEdit = myEditing
    setUserState()
    if (editingClearTimer) clearTimeout(editingClearTimer)
    // `editing` still goes NULL at the boundary, exactly as before -- every consumer of it
    // (coEditors, HIVE_MEMBERS.md) keeps its old semantics, and the "editing" label stays
    // event-driven rather than clock-driven. `lastEdit` is purely ADDITIVE and never
    // cleared, so a panel can say "last edit 40s ago" instead of "idle". Deriving the
    // label from a timestamp instead broke hive-activity-test.js: the members file is only
    // rewritten on an event, so a render landing just before the boundary froze forever.
    editingClearTimer = setTimeout(() => { myEditing = null; setUserState() }, EDIT_FRESH_MS)
  }
  function coEditors(relPath) {
    const now = Date.now(), others = []
    for (const s of provider.awareness.getStates().values()) {
      const u = s.user
      if (!u || u.name === name) continue
      if (u.editing && u.editing.file === relPath && now - u.editing.at < EDIT_FRESH_MS) others.push(u.name)
    }
    return others
  }
  function noteCoEditing(relPath) {
    const others = coEditors(relPath)
    const now = Date.now()
    if (others.length && now - (warnedAt.get(relPath) || 0) > 30000) {
      warnedAt.set(relPath, now)
      try { say(`⚠ heads-up: ${name} is also editing ${relPath} (with ${others.join(', ')}). Small patches auto-merge; coordinate before a full rewrite.`) } catch { }
    }
  }
  function memberList() {
    const seen = new Map()
    for (const s of provider.awareness.getStates().values()) {
      if (s.user && s.user.name) seen.set(s.user.name, s.user)
    }
    return [...seen.values()]
  }
  function renderMembers() {
    const us = memberList()
    const now = Date.now()
    const out = ['# Hive Members — who is in this room right now (live).', '', `count: ${us.length}`, '']
    for (const u of us) {
      const ed = u.editing && now - u.editing.at < EDIT_FRESH_MS ? ` — editing ${u.editing.file}` : ''
      out.push(`- ${u.name} (${u.kind})${u.owner ? ' — owned by ' + u.owner : ''}${ed}`)
    }
    writeToDisk(MEMBERS_FILE, out.join('\n') + '\n')
  }
  /** The claim map as a file. Same contract as renderMembers: generated locally, never synced.
   *
   *  EXPIRY IS SHOWN, NOT HIDDEN. A claim whose TTL has run out is not a lock any more — the
   *  region is free — so rendering it as "held" would make agents queue behind a crashed peer,
   *  which is the deadlock TTLs exist to prevent. Expired rows stay visible but labelled, because
   *  "AgentX died holding this" is information, and silently dropping the row loses it. */
  function renderClaims() {
    const now = Date.now()
    const rows = []
    claims.forEach((c, region) => {
      if (!c || !c.by) return
      const ttl = Number(c.ttl) || 0
      const age = now - (Number(c.at) || 0)
      const left = ttl - age
      rows.push({ region, by: c.by, intent: c.intent || 'edit', age, left, dead: left <= 0 })
    })
    rows.sort((a, b) => a.region.localeCompare(b.region))

    const secs = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`
    const live = rows.filter((r) => !r.dead)
    const out = [
      '# Hive Claims — who holds which file right now (live).',
      '# SENSE this before you edit. A region held by someone else is not yours to write:',
      '# flow to open work instead of waiting. Claims expire on their own, so nothing deadlocks.',
      '',
      `held: ${live.length}`,
      '',
    ]
    for (const r of rows) {
      out.push(r.dead
        ? `- ${r.region} — EXPIRED (was ${r.by}, ${r.intent}, ${secs(r.age)} ago) — free to take`
        : `- ${r.region} — ${r.by} (${r.intent}) — held ${secs(r.age)}, ${secs(r.left)} left`)
    }
    if (!rows.length) out.push('- nothing claimed; every region is open')
    writeToDisk(CLAIMS_FILE, out.join('\n') + '\n')
  }
  if (syncFiles) claims.observe(() => renderClaims())

  // Warn (once per peer) when someone joins on an incompatible protocol version —
  // otherwise they'd silently fail to sync and look like a "broken room".
  const versionWarned = new Set()
  function checkVersions() {
    for (const s of provider.awareness.getStates().values()) {
      const u = s.user
      if (!u || u.name === name || u.v === PROTOCOL_VERSION) continue
      if (versionWarned.has(u.name)) continue
      versionWarned.add(u.name)
      const theirs = u.v ? `v${u.v}` : 'an older build'
      log(`[${name}] ⚠ ${u.name} is on ${theirs} (incompatible with v${PROTOCOL_VERSION}) — they won't sync correctly until everyone updates.`)
      try { say(`⚠ ${u.name} is on an incompatible version — files won't sync with them until everyone updates Hivecode.`) } catch { }
    }
  }
  if (syncFiles) provider.awareness.on('change', () => { renderMembers(); renderClaims(); checkVersions() })

  // HIV-P8: A FILE THAT WILL NEVER LEAVE THIS FOLDER, SAID OUT LOUD.
  //
  // HIV-P3 closed the genesis-claim hole at CLAIM time by classifying the claim string, and it
  // could only ever be a classifier: at claim time a bare string is all there is, and `config`,
  // `hosts` and `staging` are indistinguishable from ticket labels. At WRITE time there is no
  // ambiguity left — the file is on disk and isIgnored() is exact. So this is the backstop for
  // everything the classifier could not decide.
  //
  // IT CANNOT REFUSE. The bytes are already written by the time anyone knows, so this is
  // structurally a warning — and a warning is exactly what every born-invisible incident has
  // already scrolled past. That is why the claimed case opens an OBLIGATION instead of logging:
  // an obligation rides hive_wait, backs off, escalates to STALE and shows on the board. It is
  // un-ignorable by construction and costs nothing while nobody is idle.
  //
  // THE TWO GATES ARE THE WHOLE DESIGN, and the numbers are why. On a real checkout there are 256
  // ignored files. Warning about all of them would open 256 debts on join, each closable only by
  // its author, and the ledger would be unusable inside one join — the same flooding we spent this
  // morning clearing forty entries of. So:
  //   CLAIMED     the author declared they were working on this path. That is their own stated
  //               intent, already in the CRDT — not a guess about the filename.
  //   NOT PREEXISTING   it appeared during this session, rather than having sat there for a week.
  // Neither alone is sufficient: without the claim gate, 256; without the other, every long-lived
  // ignored file re-fires on every join.
  //
  // THE UNCLAIMED CASE GETS ONE LINE AND NO LEDGER ENTRY. The room rule is CLAIM BEFORE YOU WRITE,
  // so an unclaimed write is outside the protocol and does not get to consume the ledger. I am not
  // confident this tier earns its place — a chat line is precisely the signal these incidents
  // scroll past — but deleting the case entirely is worse than announcing it cheaply.
  const ENGINE_ID = 'hivecode'
  const invisibleWarned = new Map()  // relPath -> obligation id, or null for the ambient case

  function noticeBornInvisible(ignoredRel) {
    // DISCHARGE FIRST. A file that has gone away takes its debt with it: the question "this will
    // never sync" stops being a question when there is nothing left to sync. Left open, the ledger
    // fills with debts about paths that no longer exist, which is the noise the three-state
    // lifecycle exists to prevent. Its expiry cannot help here — that only covers names never seen
    // in the room, and this path was seen, on disk, by us.
    for (const [r, id] of [...invisibleWarned]) {
      if (ignoredRel.has(r)) continue
      if (id) { try { OB.discharge(doc.getMap('obligations'), { id, by: ENGINE_ID }) } catch { } }
      invisibleWarned.delete(r)
    }
    for (const r of ignoredRel) {
      if (SKIP.has(r)) continue           // control files are ours and are supposed to be invisible
      if (preexisting.has(r)) continue    // it was already here; nobody did this during the session
      if (invisibleWarned.has(r)) continue // once per path, not once per scan tick
      const holder = coordinator.sense(r)
      if (holder && holder.by) {
        let id = null
        try {
          const rec = OB.open(doc.getMap('obligations'), {
            from: ENGINE_ID,
            to: holder.by,
            text: `${r} is on disk and claimed by you, but it is ignored by a .gitignore here — ` +
              `no sync connection is opened for it, so nothing written to it will ever reach the room. ` +
              `Add it to the allow-list, or confirm the work is deliberately local.`,
            absent: false,
            neverSeen: false,
          })
          id = rec && rec.id
        } catch { }
        invisibleWarned.set(r, id)
        try {
          say(`⛔ ${r} is claimed and on disk, but it is ignored by a .gitignore here — its bytes will never leave this folder.`)
        } catch { }
      } else {
        invisibleWarned.set(r, null)
        try {
          say(`· ${r} was created here but is ignored by a .gitignore — it stays local, and no other agent will see it.`)
        } catch { }
      }
    }
  }

  function scan() {
    const skippedFulls = []
    const diskFulls = walk(ROOT, [], skippedFulls)
    const diskRel = new Set(diskFulls.map(rel))
    const ignoredRel = new Set(skippedFulls.map(rel))
    // Snapshot the starting file set BEFORE the first reconcile pass touches anything.
    // Everything here pre-dates our participation; anything that shows up later was
    // authored while we were connected. See `preexisting`.
    // The ancestor must be loaded BEFORE any path can reach reconcile(), and this is the
    // one place guaranteed to run first exactly once. Loading it later would mean the first
    // scan's reconciles see no ancestor — precisely the bug this is here to close.
    //
    // HIV-P8: THE UNION IS NOT A DETAIL. `preexisting` used to be seeded from diskRel alone, and
    // diskRel comes from walk(), which dropped ignored files — so `preexisting.has(r)` was
    // permanently FALSE for every ignored path, whether it was created a second ago or had been
    // sitting there for a week. Any check phrased as "ignored AND not preexisting" therefore
    // reduced to "ignored", and a client joining a real checkout would have opened an obligation
    // for each of its 256 ignored files, about files nobody touched. Seeding the union is what
    // makes "not preexisting" mean what it says: authored during this session.
    if (!firstScanDone) {
      loadPriorShadow()
      for (const r of diskRel) preexisting.add(r)
      for (const r of ignoredRel) preexisting.add(r)
      firstScanDone = true
    }
    noticeBornInvisible(ignoredRel)
    for (const full of diskFulls) {
      const r = rel(full)
      if (SKIP.has(r)) continue
      let mt
      try { mt = fs.statSync(full).mtimeMs } catch { continue }
      if (mtimes.get(r) === mt && manifest.has(r)) continue
      if (readText(full) === null) continue
      mtimes.set(r, mt)
      reconcile(r, 'local')
    }
    const removed = [...known].filter((r) => !diskRel.has(r) && manifest.has(r))
    if (removed.length) {
      doc.transact(() => { for (const r of removed) manifest.delete(r) })
      for (const r of removed) { closeFile(r); known.delete(r); mtimes.delete(r); bases.delete(r); forkBases.delete(r) }
    }
  }

  // Manifest changes from OTHERS: a new path -> open its file-room (its sync pulls
  // the content); a removed path -> tear down + delete the local file.
  if (syncFiles) manifest.observe((ev, txn) => {
    if (txn.local) return
    ev.changes.keys.forEach((change, key) => {
      if (change.action === 'delete') {
        closeFile(key)
        try { fs.rmSync(path.join(ROOT, key)) } catch { }
        known.delete(key); bases.delete(key); forkBases.delete(key); mtimes.delete(key)
        log(`[${name}] <- deleted ${key}`)
      } else if (canOpen(key) && !SKIP.has(key) && !isIgnored(key)) {
        // Same rule as the initial sweep: a path this client ignores must not cost it a
        // socket just because somebody else registered it.
        //
        // AND the same BOUND. This observer is how a joining client learns the room's whole
        // manifest — every existing path arrives here as a remote change — so capping only
        // the sweep achieved nothing: the first measurement of this cap showed a client with
        // cap 8 holding 30 file docs, every one of them opened right here. A path we decline
        // to open now is not lost; it opens when something touches it.
        if (fileDocs.size < MAX_OPEN) openFile(key)
      }
    })
  })

  // INSTANT propagation: fs.watch fires on the actual edit, so changes go out in
  // ~tens of ms instead of waiting for the poll. A periodic scan stays as a
  // safety net (and the only mechanism where recursive watch isn't supported).
  let scanTimer = null
  let watcher = null
  let debounce = null
  const onFsEvent = (_evt, fname) => {
    if (fname && String(fname).endsWith('.gitignore')) reloadIgnores()
    if (debounce) return
    debounce = setTimeout(() => { debounce = null; scan() }, 40)
  }
  function startWatch() {
    try { watcher = fs.watch(ROOT, { recursive: true }, onFsEvent) }
    catch { watcher = null } // recursive watch unsupported (some Linux) -> rely on scan
  }

  provider.on('sync', (s) => {
    if (!s || !syncFiles) return
    // HIV-P14b. Snapshot what the room already had, once. Measured: the manifest IS populated at
    // this point -- a fresh joiner's observer fires with 13 of 13 entries before the sync event,
    // so reading it here is sound. (That was checked because the first version of this guard was
    // wrongly assumed to be failing for this reason.)
    if (!roomAtJoin) {
      roomAtJoin = new Set()
      try { for (const k of manifest.keys()) roomAtJoin.add(k) } catch { }
    }
    writeToDisk(RULES_FILE, HIVE_RULES_TEXT) // the law is always present in the room
    writeToDisk(AGENTS_FILE, AGENT_MANUAL_TEXT) // so an agent opening this folder learns how to join + behave
    // Connect to every file I'm granted AND have not excluded; each file-room's sync pulls
    // its content. `canOpen` is the TOKEN's scope -- what the relay would let me see. It is
    // not the same question as "do I want this file", and using it alone meant a participant
    // could not bound its own footprint: on 18 Sep 2026 two agents kept opening demo/** file
    // rooms after their .gitignore had been narrowed to 35 paths, and between them consumed
    // the relay's entire 512-connection budget. Since one socket is opened PER FILE, an
    // ignore rule that does not stop the connection is not a containment tool at all.
    // Same predicate reconcile() uses, so a file is never open but unreconcilable.
    // BOUND THE INITIAL SWEEP, not just the steady state. This burst is precisely when the
    // budget blows: a client with 889 files used to try to open 889 sockets at once against
    // a 512-connection relay. LRU eviction cannot help here — during a burst every file was
    // touched seconds ago, so nothing is eligible to evict. The only thing that works is to
    // not open them all.
    //
    // Files that exist on THIS client's disk come first: they are the ones that need
    // reconciling, and a path we have no local copy of can wait until something asks for it.
    const openable = [...manifest.keys()].filter((k) => canOpen(k) && !SKIP.has(k) && !isIgnored(k))
    const localFirst = openable.sort((a, b) => {
      const la = fs.existsSync(path.join(ROOT, a)) ? 0 : 1
      const lb = fs.existsSync(path.join(ROOT, b)) ? 0 : 1
      return la - lb
    })
    for (const key of localFirst.slice(0, MAX_OPEN)) openFile(key)
    if (localFirst.length > MAX_OPEN) {
      log(`[${name}] ${localFirst.length} files in this room, holding ${MAX_OPEN} open (HIVE_MAX_OPEN_FILES). The rest sync when touched.`)
    }
    if (board.size) renderBoard()
    if (chat.length) renderChat()
    if (tasks.size) renderTasks()
    renderMembers()
    renderClaims() // unconditional: "nothing is claimed" is the answer an arriving agent needs most
    scan()
    log(`[${name}] folder sync active on ${ROOT} (room "${room}") as ${kind}. ${manifest.size} files.`)
    // HIV-P14. SAY THE GAP OUT LOUD, ONCE, AT JOIN.
    //
    // The working set is bounded on purpose, and the documented trade is that "a file outside it
    // does not arrive until something touches it". For a human reading a folder that is fine. For
    // an AI agent it is not, because an agent decides what exists by listing its directory: a
    // file it cannot see is a file it believes does not exist, and it writes one. Measured 21 Sep
    // 2026, a 40-file room and MAX_OPEN=8: the joiner held 7 files, reported "filesSynced 8/8",
    // said nothing, and its agent recreated a file the room already had.
    //
    // Nothing here changes the cap. It tells the agent the number it needs in order to ASK,
    // which is the one thing that makes "until something touches it" true.
    setTimeout(() => {
      try {
        const want = [...manifest.keys()].filter((r) => canOpen(r) && !SKIP.has(r))
        const have = want.filter((r) => fs.existsSync(path.join(ROOT, r)))
        const short = want.length - have.length
        if (short <= 0) return
        log(`[${name}] !! THIS FOLDER IS INCOMPLETE ON PURPOSE. The room has ${want.length} files; ` +
          `${have.length} are on disk here and ${short} are NOT. The working set is bounded to ` +
          `${MAX_OPEN} open files (HIVE_MAX_OPEN_FILES), because one socket is opened per file and a ` +
          `relay admits a limited number. A missing file EXISTS — it simply has not been fetched. ` +
          `Do not treat it as absent and do not create it: reading or claiming the path fetches it. ` +
          `hive_status reports filesHeld of roomFiles, and hive_read_board lists what the room holds.`)
      } catch { }
    }, 4000).unref?.()
    if (!scanTimer) {
      startWatch()
      scanTimer = setInterval(scan, watcher ? 2000 : 400) // watch handles fast path; scan is the net
    }
  })

  return {
    doc,
    provider,
    // A STATE MACHINE, not a validated variable.
    //
    // `enum` alone makes this a notepad with spellcheck: it stops a typo and permits any value at any
    // time, so APPROVED can slide back to LOCKED and a release gate can be opened by an agent that
    // simply set the flag. Two additions turn it into a machine, and both exist because a live
    // four-agent build (JARVIS, 2026-07-29) was governed entirely by rules written in prose that four
    // capable agents read and then broke:
    //
    //   transitions: { FROM: [TO, ...] }   which moves are legal AT ALL
    //   requires:    { TO: { key: val } }  what must already be true to arrive at TO
    //
    // `requires` is the important one. It makes a contract EXECUTABLE. "Nobody sends email until the
    // suppression UI exists and the unsubscribe URL is real" held for nine hours only because a PM
    // kept repeating it; expressed as
    //   requires: { LIVE: { suppression_ui: 'APPROVED', unsubscribe_url: 'SET' } }
    // it holds because the transition cannot be made. That is the whole point of this layer: the
    // place where a rule stops being advice.
    setState: (key, val) => {
      const rules = swarmSchema.get(key)
      const cur = swarmState.get(key)
      // PARAMETERISED VALUES. `PUBLISH:2` must satisfy an enum containing `PUBLISH` — otherwise the
      // two features collide: a leased grant is a PUBLISH carrying a count, and schema-ing the status
      // key would make every lease illegal. So a value of the form BASE:arg validates on BASE.
      // Found by trying to use both at once on a live room, which is the only way this surfaces.
      const base = String(val).includes(':') ? String(val).slice(0, String(val).indexOf(':')) : val
      if (rules && rules.enum && !rules.enum.includes(val) && !rules.enum.includes(base)) {
        throw new Error(`[Schema Error] Invalid state for [${key}]. Allowed values: ${rules.enum.join(', ')}${base !== val ? ` (parameterised values like ${base}:<n> are allowed when ${base} is listed)` : ''}`);
      }
      // Transitions are checked only when the key ALREADY has a value — the first write to a key is
      // initialisation, not a move, and demanding a `from` entry for it would make every schema
      // carry a synthetic start state.
      // Transitions compare on the BASE too, for the same reason as the enum above: a lease counting
      // down PUBLISH:2 -> PUBLISH:1 is one state decrementing its own parameter, not a move between
      // states, and demanding a transition entry per count would be absurd.
      const curBase = cur !== undefined && String(cur).includes(':') ? String(cur).slice(0, String(cur).indexOf(':')) : cur
      if (rules && rules.transitions && cur !== undefined && curBase !== base) {
        const allowed = rules.transitions[curBase] || rules.transitions[cur]
        if (!Array.isArray(allowed) || !(allowed.includes(val) || allowed.includes(base))) {
          throw new Error(`[Transition Error] [${key}] cannot go ${cur} -> ${val}. Legal from ${curBase}: ${Array.isArray(allowed) && allowed.length ? allowed.join(', ') : '(nothing — terminal state)'}`)
        }
      }
      if (rules && rules.requires && rules.requires[val]) {
        const unmet = Object.entries(rules.requires[val])
          .filter(([k, want]) => String(swarmState.get(k)) !== String(want))
          .map(([k, want]) => `${k}=${want} (is ${swarmState.get(k) === undefined ? 'unset' : swarmState.get(k)})`)
        if (unmet.length) {
          throw new Error(`[Guard Error] [${key}] cannot become ${val} until: ${unmet.join('; ')}`)
        }
      }
      swarmState.set(key, val)
      say(`STATE TRANSITION: [${key}] is now [${val}]`)
    },
    getState: () => {
      const s = {}
      for (const [k, v] of swarmState.entries()) s[k] = v
      return s
    },
    setSchema: (key, rules) => {
      swarmSchema.set(key, rules)
      say(`SCHEMA UPDATED: [${key}] rules set to ${JSON.stringify(rules)}`)
    },
    // --- attestation: does another folder actually hold the same bytes? ---
    // Records THIS peer's measurement of a path. Returns the merged picture including, crucially,
    // whether the peers DISAGREE — see the swarm_attest declaration for why it is keyed per peer.
    attest: (relPath, bytes, lines) => {
      const p = String(relPath)
      const prev = swarmAttest.get(p) || {}
      const next = { ...prev, [name]: { bytes: Number(bytes), lines: Number(lines), at: new Date().toISOString() } }
      swarmAttest.set(p, next)
      const sizes = [...new Set(Object.values(next).map((v) => v && v.bytes))]
      const split = sizes.length > 1
      if (split) {
        // Announce, do not throw. The measuring agent did nothing wrong and its report is valid; the
        // ROOM is what is broken. Throwing here would punish whoever happened to measure second.
        const detail = Object.entries(next).map(([who, v]) => `${who}:${v.bytes}b/${v.lines}L`).join('  ')
        say(`[!] DIVERGENCE on ${p} — peers hold DIFFERENT bytes: ${detail}. Nobody may write this path until it is reconciled; mark it path:${p}=POISONED if it cannot be.`)
      }
      return { path: p, peers: next, count: Object.keys(next).length, sizes, diverged: split }
    },
    verified: (relPath) => {
      const p = String(relPath)
      const rec = swarmAttest.get(p) || {}
      const sizes = [...new Set(Object.values(rec).map((v) => v && v.bytes))]
      return { path: p, peers: rec, count: Object.keys(rec).length, sizes, diverged: sizes.length > 1, quorum: Object.keys(rec).length >= 2 && sizes.length === 1 }
    },
    say,                 // post a coordination message
    assign,              // direct a task at a participant (needs approval if target AI has an owner)
    decide,              // approve/deny a task (owner only, if set)
    complete,            // mark a task done
    myTasks,             // tasks directed at me
    control,             // pause/resume an agent (mission control)
    isPaused,            // is a participant currently paused?
    controls,            // the live control map
    // --- hive coordination: claim a region BEFORE editing (collision prevention) ---
    // HIV-P18: a claim is a promise about BYTES, so granting one over bytes the claimer cannot
    // see is the same false success we shut in the outbound direction (HIV-27: a claim whose
    // writes could never leave). The claim itself is unchanged -- callers and every existing
    // suite still get the same boolean -- but it now also starts the fetch the README has been
    // promising, so an agent that claims a path it does not hold actually receives it instead of
    // finding an empty directory and creating the file from scratch.
    claim: (region, intent) => {
      const r = String(region), i = String(intent || 'edit')
      myIntents.set(r, i)
      const held = coordinator.acquire(r, i)
      // Fire-and-forget on purpose: claim's contract is synchronous and changing that would
      // break every caller. Use fetch(path) directly when you need to WAIT for the bytes.
      if (held) { try { fetchFile(r).catch(() => {}) } catch { } }
      return held
    }, // true iff you hold it (my intent recorded either way — it's what my receipts sign)
    // HIV-P18: bring a file the room has but this folder does not. Resolves when the BYTES have
    // landed, and distinguishes "outside the working set" (fetchable) from "not in the room at
    // all" (nothing will ever arrive) -- two states that look identical from an empty directory
    // and have opposite remedies.
    fetch: fetchFile,
    // RELEASE IS A HANDOFF, AND A HANDOFF CAN BE REFUSED.
    //
    // Until the room sets `gate:cmd`, this behaves exactly as it always did and returns
    // {ok:true} — no configured gate means no new failure mode for existing rooms.
    //
    // With a gate set, the check runs in THIS agent's folder and a non-zero exit keeps the claim.
    // That is the whole idea: the file stays visibly yours, so the next agent cannot quietly
    // inherit something that looked finished. It does NOT unsend the bytes — the CRDT syncs
    // continuously and they are already everywhere — it refuses the "I am done, it is yours".
    //
    // `force` exists because abandoning work is legitimate, and it is never silent: it releases,
    // records that it was forced, and says so in the room.
    release: (region, opts = {}) => {
      const r = String(region)
      const g = gateConfig((k) => swarmState.get(k))
      const letGo = () => { myIntents.delete(r); coordinator.release(r) }
      if (!g) { letGo(); return { ok: true, gated: false } }

      if (opts.force) {
        const rec = verdictRecord({ region: r, by: name, cmd: g.cmd, result: null, forced: true, why: opts.why })
        gateResults.set(`${r}|${name}`, rec)
        letGo()
        try { say(forcedMessage({ region: r, by: name, why: opts.why })) } catch { /* chat is not the point */ }
        return { ok: true, gated: true, forced: true }
      }

      const result = runGate({ cmd: g.cmd, cwd: ROOT, timeoutMs: g.timeoutMs })
      gateResults.set(`${r}|${name}`, verdictRecord({ region: r, by: name, cmd: g.cmd, result }))
      if (!result.ok) {
        // The claim is NOT dropped. Saying so in the room is what makes the refusal visible to
        // everyone rather than a private error the holder can ignore.
        try { say(`@all ${name} could not hand back ${r}: the gate failed (exit ${result.code}). Still held.`) } catch { /* ignore */ }
        return { ok: false, gated: true, code: result.timedOut ? 'Q491' : 'Q490', result, message: refusalMessage({ region: r, cmd: g.cmd, result }) }
      }
      letGo()
      return { ok: true, gated: true, result }
    },
    /** The verdicts recorded for a path, by peer. Read this before building on someone's file. */
    gateVerdicts: (region) => {
      const out = {}
      const pre = String(region) + '|'
      gateResults.forEach((v, k) => { if (k.startsWith(pre)) out[k.slice(pre.length)] = v })
      return out
    },
    /** The room's gate, or null. Exposed so a client can say what it is about to be judged by. */
    gate: () => gateConfig((k) => swarmState.get(k)),
    // THE LOCK YOU MAY WRITE BEHIND. `claim()` answers from this replica alone, so under real
    // concurrency it says yes to everyone (see hive-coord.js). This waits for the claim to
    // round-trip through the relay -- the only place the room is actually serialised -- and then
    // asks who the converged map says holds it. Exactly one caller gets true.
    //
    // The loser has nothing to release: the winner's entry replaced its own under last-writer-
    // wins on the same key, so conceding is just returning false.
    claimSettled: async (region, intent, waitMs = 900) => {
      const r = String(region), i = String(intent || 'edit')
      myIntents.set(r, i)
      if (!coordinator.acquire(r, i)) return false          // someone already visibly holds it
      await new Promise((res) => setTimeout(res, Math.max(200, waitMs)))
      const holder = coordinator.sense(r)
      if (holder && holder.by === name) return true
      myIntents.delete(r)
      return false
    },
    senseClaim: (region) => coordinator.sense(String(region)), // the live claim on a region, or null
    whyNotShared,        // '' if edits to this path reach the room, else why they would not (HIV-27)
    claimsBoard: () => coordinator.board(),                     // everything currently claimed
    // --- intent-aware fork resolution: any agent may judge; the medium validates ---
    forkInfo,            // the active fork on a file as a resolvable object (base + versions + signed intents), or null
    resolveFork,         // propose the reconciled file; ICR-validated (parse + dangling) before it lands, refused otherwise
    edit: editFile,      // first-class authored write: intent + transition stamped race-free, then normal reconcile
    // --- convergent substrate: provenance (I1) ---
    identity: () => identity ? { id: identity.id, name: identity.name, pk: identity.pk } : null, // never exposes the private key
    provenanceOf: (relPath) => { const e = fileDocs.get(relPath); return e && e.ledger ? e.ledger.toArray() : [] }, // signed receipts for a file
    headOf: (relPath) => { const e = fileDocs.get(relPath); return e && e.head ? e.head.get('cur') || null : null }, // the file's authoritative attested current content
    // Audit a file's ledger: verify EVERY receipt's signature + author identity, and
    // report which authors contributed. Returns { ok, count, verified, bad, authors }.
    verifyProvenanceOf: (relPath) => {
      const e = fileDocs.get(relPath)
      const rs = e && e.ledger ? e.ledger.toArray() : []
      let verified = 0; const bad = []; const authors = new Set()
      for (let i = 0; i < rs.length; i++) { const v = verifyReceipt(rs[i]); if (v.ok) { verified++; authors.add(rs[i].author) } else bad.push({ i, reason: v.reason }) }
      return { ok: bad.length === 0, count: rs.length, verified, bad, authors: [...authors] }
    },
    // --- rollback ---
    listHistory,         // the restore-point timeline (newest first; filter by file/by)
    restore,             // restore a file to a restore point by id (reversible)
    restoreFileTo,       // restore one file to its state as of a timestamp
    revertAuthor,        // roll back everything an author did since a time
    checkpoint,          // save a named restore point of a file's current state
    captureSnapshot,     // (low-level) capture a restore point
    undoLast,            // undo this client's last local edit
    redoLast,            // redo it
    // One entry PER NAME, not per connection: the same user open in two windows
    // (e.g. the editor + the browser Control Room) is ONE member. Merge their
    // fields so we keep whichever connection has an active `editing`/`owner`.
    members: () => {
      const seen = new Map()
      for (const s of provider.awareness.getStates().values()) {
        const u = s.user
        if (!u || !u.name) continue
        const prev = seen.get(u.name) || {}
        seen.set(u.name, { ...prev, ...u, editing: u.editing || prev.editing, owner: u.owner || prev.owner, passive: !!(u.passive || prev.passive) })
      }
      return [...seen.values()]
    },
    // Live connection state. An agent parked on hive_wait has no way to tell a quiet
    // room from a dead socket, so it guesses -- and the guess it reaches for is
    // hive_join, which tears the session down and rebuilds it (see hive-mcp.js: join
    // calls stop() first). That turns one recoverable blip into a real detach, and it
    // runs the rejoin path that can clobber local edits. The provider already
    // reconnects on its own with backoff, so the agent never needs to act; it just
    // needs to be told. `connected` is the room socket; `files` counts per-file
    // sockets, which are the ones that actually carry content.
    status: () => {
      let synced = 0
      for (const e of fileDocs.values()) if (e.synced) synced++
      // `notSyncing` is the number the caller actually needs when something is wrong: files
      // whose own socket the relay refused. They are not slow, they are not arriving, and
      // until they do they read as empty. filesSynced alone shows a shortfall but not a cause.
      const notSyncing = [...refusedFiles.keys()].filter((r) => { const e = fileDocs.get(r); return e && !e.synced })
      // HIV-P14. THE FULL-HOUSE LIE.
      //
      // `files` and `filesSynced` both counted OPEN docs, so a client holding eight of the
      // room's forty files reported "filesSynced 8/8" -- a complete set. Measured 21 Sep 2026:
      // a second agent joined a 40-file room, received 7, stayed at 7 for a full minute, and
      // reported 8/8. Its manifest listed all forty the whole time.
      //
      // The bounded working set is deliberate and correct -- one socket per file against a 512
      // ceiling is the wall, and tests/open-file-cap-test.mjs documents the trade rather than
      // hiding it: "a file outside the working set does not arrive until something touches it."
      // What that header does not cover is that FOR AN AGENT, NOTHING EVER TOUCHES IT. An agent
      // decides what exists by reading its folder; a file it cannot see is a file it believes
      // does not exist, so it writes one from scratch. Measured consequence, same probe: agent B
      // created mod039.js, and agent A's copy ended up holding two const declarations of the
      // same name -- invalid code, in someone else's folder, from B doing the only reasonable
      // thing available to it.
      //
      // So the trade stays and the reporting changes. `files` keeps meaning open docs, because
      // tests/open-file-cap-test.mjs:71 pins it as the proof the cap is respected. What is added
      // is the pair that was missing: what the ROOM has, and what this client actually HOLDS.
      const roomFiles = (() => { try { return [...manifest.keys()].filter((r) => canOpen(r)).length } catch { return 0 } })()
      const held = (() => {
        let n = 0
        try { for (const r of manifest.keys()) { if (canOpen(r) && fs.existsSync(path.join(ROOT, r))) n++ } } catch { }
        return n
      })()
      return {
        connected: !!provider.wsconnected,
        connecting: !!provider.wsconnecting,
        files: fileDocs.size,
        filesSynced: synced,
        // The honest pair. `filesHeld` of `roomFiles` is the number a joiner needs, and the one
        // that says 7 of 40 where filesSynced said 8 of 8.
        roomFiles,
        filesHeld: held,
        filesMissing: Math.max(0, roomFiles - held),
        notSyncing: notSyncing.length,
        notSyncingFiles: notSyncing.slice(0, 20),
        // The working set and its bound. `openCap` x agents must stay under the relay's
        // maxConnsTotal, and `evicted` climbing steadily means the cap is too small for
        // how this room actually works — both are things an operator can only act on if
        // they can see them.
        openCap: MAX_OPEN,
        evicted,
      }
    },
    stop: () => {
      if (scanTimer) clearInterval(scanTimer)
      if (debounce) clearTimeout(debounce)
      if (editingClearTimer) clearTimeout(editingClearTimer)
      try { watcher && watcher.close() } catch { }
      for (const r of [...fileDocs.keys()]) closeFile(r) // tear down every per-file provider
      try { provider.awareness.setLocalState(null) } catch { } // announce departure now (don't wait for timeout)
      try { provider.destroy() } catch { }
      try { doc.destroy() } catch { }
      // A room you have left should stop colouring what your agents recall.
      if (memoryLinked) try { grmLink.unlinkRoom(ROOT, log) } catch { }
      // Last, so a crash anywhere above still frees the folder on the next run via the
      // stale-PID path rather than leaving it locked.
      try { releaseLock() } catch { }
      // A final flush of the ancestor record. The debounced save may still be pending, and
      // losing it would make the next join see no common ancestor -- the exact condition
      // that produced the rejoin clobber.
      try { if (shadowTimer) { clearTimeout(shadowTimer); shadowTimer = null } saveShadow() } catch { }
    },
  }
}

// Parse a Hivecode join link into { relay, room, token }. Two shapes:
//   "wss://relay|room"          (open room — no token)
//   "wss://relay|room|<token>"  (secured room — the access token is baked in, so
//                                the invitee just pastes the link; no settings)
// A JWT contains '.' but never '|', and room ids/relay URLs never contain '|',
// so splitting on '|' is unambiguous.
export function parseLink(link) {
  if (link && link.includes('|')) { const [r, m, t] = link.split('|'); return { relay: r.trim(), room: (m || '').trim(), token: (t || '').trim() } }
  return { relay: null, room: (link || '').trim(), token: '' }
}
