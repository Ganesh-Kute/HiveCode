# Improvements log (autonomous session)

Work done while you were at lunch. Every change verified before moving on.

## Done & verified

### Safety net
- **`test.js`** — automated test suite (18 tests, all passing). Covers: text
  diff, CRDT convergence, claim protocol, version check, lock/negotiation
  logic, deadlock-safe ordering, room isolation. Run any time: `node test.js`.
- **`core.js`** — shared pure logic (applyDiff, safeBump, lock helpers,
  lockOrder) so the same tested code is used everywhere instead of copies.

### Performance
- **Folder sync now skips unchanged files.** Before: it re-read every file's
  full contents every 400 ms. Now: it checks each file's modification time and
  only reads the ones that actually changed. On a big project this is the
  difference between heavy constant disk reads and almost nothing.
  Applied to both `folder.js` and the VS Code extension.
- Verified create / edit / delete still sync correctly after the change.

### Robustness
- **Deadlock-safe multi-file locking** (`acquireAll` in `agent-lock.js`):
  agents that need several files lock them in sorted order, so two agents can
  never deadlock waiting on each other. Unit-tested.
- `agent-lock.js` refactored to use the shared, tested `core.js` helpers.
- Live negotiation re-tested after refactor — still works.

### Housekeeping
- Extension repackaged with the optimizations → `extension/livecode-0.1.0.vsix`.
- Stopped tracking the `.vsix` build artifact in git.

## Roadmap (not done — needs your input or is bigger)

1. **Live cursors + keystroke sync** in the extension (the Google-Docs feel).
   Bigger: bind to the editor buffer instead of the file on disk.
3. **Business plan** — tiers, pricing, what to charge for.

## Also done

- **THE LAW + THE SPEC** (`HIVE_RULES.md` auto-generated; `SPEC.md`). The hive is
  now the core every agent follows. `sync.js` and the extension auto-write
  `HIVE_RULES.md` into every room folder on join — short, imperative rules
  (read chat+board first, announce, prefer patches, re-read before rewrite, stay
  in your lane, resolve conflict markers, ask before destructive acts). It is
  always present (no setup, no relying on the agent to remember); the sync layer
  still enforces the unbreakable parts (merge, board). `SPEC.md` is the v0.1
  vendor-neutral protocol (transport, document model files/board/chat, awareness
  identity, merge guarantee, rendezvous, conformance) — the artifact that lets
  others implement the standard. Extension also now skips all coordination files
  (HIVE_*/.hive.json) from sync. Dropped the global-discovery idea (the shared
  project IS the connection — agents on one project already share the repo).
  Extension repackaged → hivecode.vsix v0.2.4. All live + 38 unit tests pass.


- **HIVE MIND: AIs host + rendezvous + TALK, no human** (`sync.js` chat channel;
  `hive-agent.js` host/join logic; `hive-say.js`; `hive-talk-test.js`). Three
  gaps closed so the system is a coordination medium, not just file sync:
  (1) SELF-HOST/INVITE without link-passing — an agent run with no link HOSTS a
  room and writes `.hive.json`; any agent sharing the folder/repo runs
  `node hive-agent.js` and auto-joins the same room (the invite travels with the
  project, not a human's clipboard). (2) COMMUNICATION — a shared ordered `chat`
  channel; everyone renders the conversation to `HIVE_CHAT.md`; agents read it to
  coordinate and `say()` / `node hive-say.js` to talk; agents announce themselves
  on join. (3) `startSync` gained `syncFiles:false` so a pure message-sender
  (hive-say) doesn't drag a folder into the room. Proven in `hive-talk-test.js`:
  agent One hosts, agent Two rendezvous-joins via shared `.hive.json`, both see
  each other's chat, a broadcast message reaches both. No regression (collide +
  board + agent live tests pass; 38 unit tests pass).


- **AGENTS JOIN THEMSELVES — no human setup, auto-identity** (`sync.js` engine +
  `hive-agent.js` + `hive-agent-test.js`). Refactored the whole-folder sync
  engine out of folder.js into a reusable `sync.js` (`startSync({relay, room,
  dir, name, kind, log})`) — this is also the SDK seed. folder.js is now a thin
  CLI that joins as `human`; `hive-agent.js` is what an AI runs ITSELF
  (`node hive-agent.js "<link>" <dir> [name]`) and joins as `ai`. Identity is
  IMPLICIT in which client you run — nobody toggles a setting or "declares" a
  kind. Proven in `hive-agent-test.js`: an agent self-joins, is auto-tagged
  `ai` next to a `human`, receives files with no human action, and its rewrite
  auto-logs to the board attributed to the agent + syncs back. Same 3-way merge
  + auto-board protections apply. No regression (collide + board live tests
  still pass; 38 unit tests pass).


- **AUTO-BOARD for rewrites** (`summarizeChange` in core.js; `noteIfRewrite` +
  `renderBoard` in folder.js AND the extension). Insight (from the user's
  experience): agents mostly grep-and-PATCH a few lines (the disjoint case that
  already merges) — the board only matters for the rare WHOLE-FILE REWRITE, and
  the agent must not be relied on to log it (AIs forget when context is heavy).
  So the SYNC LAYER detects it: every local change is classified patch vs
  rewrite (≥50% churn & ≥4 lines); a rewrite is auto-recorded on a shared
  `board` Y.Map with who/when/how-much/which-symbols, rendered to a read-only
  `HIVE_BOARD.md` in every folder. Small patches stay silent (no noise). Proven
  in `folder-board-test.js`: a one-line patch is NOT logged; a wholesale rewrite
  auto-appears on BOTH folders ("A rewrote app.js (7/11 lines) — touched: login,
  logout"). Honest limit: captures WHAT (objective, from the diff); WHY (intent)
  still needs the agent to state it. Extension repackaged → hivecode.vsix v0.2.3.


- **THE FIX: 3-way merge moved into the SYNC LAYER** (`merge3` in core.js;
  `reconcile()` in folder.js AND the extension). Root cause of "the second
  agent's full rewrite wiped the first's work": the merge logic only lived in
  the standalone `agent-merge.js`, but real edits flow through folder.js / the
  extension, which just MIRRORED disk↔doc with a blind `applyDiff` — so two
  full-file rewrites clobbered. Now every change (typed, AI, either direction)
  goes through `reconcile()`: a 3-way merge against each file's last agreed
  "base". Disjoint edits merge (both kept); same-line edits get git-style
  `<<<<<<<` markers so BOTH survive — never silently lost. Proven end-to-end in
  `folder-collide-test.js` (two real folder.js processes, two folders, both
  editing the same file at once → both edits kept, folders converge). Extension
  repackaged → `hivecode.vsix` v0.2.2. Residual hard case: two edits to the
  EXACT same line at the EXACT same instant (char-CRDT can interleave before
  reconcile runs) — rare, and the common "different parts of the same file"
  case is fully fixed.


- **LIVE lock-free agent** (`agent-merge.js` + `merge-live-test.js`): the
  patch-apply-or-rework model, now running over the real relay (no locks). The
  agent reads the file, posts its intent on a shared `board` Y.Map, reasons,
  then RE-CHECKS at write time: unchanged → write; disjoint lines → merge both;
  same lines → conflict → re-reason on the fresh code. `merge-live-test.js`
  proves it across two real OS processes over WebSocket — Scenario A (different
  lines) merges with no rework; Scenario B (same line) conflicts and the slow
  agent reworks so nobody is clobbered. ALL LIVE CHECKS PASS. Stub mode is
  deterministic (find→replace); live mode uses Claude (`LIVECODE_AI=1`).
  Replaces the lock-based `agent-ai.js` as the scalable path.

- **Patch-apply-or-rework** (`mergeEdit` in core.js + `patch-merge-demo.js`):
  the lock-free model. Agents edit in parallel; at write time a 3-way line
  merge decides — current unchanged → take mine; disjoint edits → merge both
  (no rework); same lines changed two ways → conflict → agent re-does on the
  fresh code. Unit-tested (4 cases). (Area ownership is intentionally NOT code
  — users just instruct their AI "don't touch backend/".)

- **Richer negotiation** (`negotiate` in core.js + `negotiation-v2-demo.js`):
  a lock holder now GRANTs unrelated requests, COUNTERs overlapping ones
  ("let me finish, then it's yours"), and DENYs destructive ones mid-edit.
  Wired live into `agent-lock.js` (holder answers waiters; a denied requester
  backs off). Unit-tested (4 cases) and verified live.

- **Real AI agent** (`agent-ai.js`): joins a room, locks the target file,
  reads it, asks Claude (`claude-opus-4-8`) for the new version, writes it
  back through the shared doc. Safe by default — runs in STUB mode with no
  API key (verified end-to-end), uses the real model when you set
  `LIVECODE_AI=1` + `ANTHROPIC_API_KEY`. This is the bridge from "coordination
  demo" to "AI teammates that actually edit your code."

## How to check my work
```
node test.js          # 18 tests should pass
```
