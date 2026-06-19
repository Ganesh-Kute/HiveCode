# Improvements log (autonomous session)

Work done while you were at lunch. Every change verified before moving on.

## Done & verified

### THE SILENT-LOSS FIX (fork-point merge) — `core.js`, `sync.js`, extension; `merge-clobber-test.js`
A live two-process field test (MCP agent + a second client over the hosted relay)
reproduced the original "second agent's rewrite wipes the first's work" bug — and
it was REAL: when agent B received A's change and then pasted a stale whole-file
rewrite that omitted it, A's work was destroyed SILENTLY (no conflict marker, no
board entry). Root cause: the per-file merge `base` advanced to incoming remote
content, so `merge3(base=+A, mine=staleB, theirs=+A)` saw `base===theirs` and let
mine win — deleting A.

Fix: merge a LOCAL edit against the FORK POINT (`forkBases`) — what THIS author
last actually saw/authored — not the latest doc. forkBase advances on local
authorship and on first content a joining client receives, but NOT when a remote
update lands on disk. So a stale rewrite that drops another's just-arrived lines
either re-adds them (disjoint) or raises a conflict (overlap) — never silent loss.
Plus: an "integrated" shortcut (a write that already contains the remote change is
trusted as-is, no spurious conflict) and a "resolution" shortcut (removing
<<<<<<< markers is an intentional resolve and wins). Mirrored into the extension
(v0.2.9). Honest result: same-line rewrites now CONFLICT (both kept, you resolve)
instead of silently losing — matching git's "never lose work" guarantee, which
is the behavior the live test proved was missing. 38 unit + 11 live tests pass.


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

- **Perfect + faster pass (4 improvements)** (`server.js`, `sync.js`, extension;
  `hive-gitignore-test.js`):
  - **Safety — respect .gitignore + never sync secrets.** `sync.js` and the
    extension now load `.gitignore` (via `ignore`) plus an always-ignore list
    (`.env`, `*.pem`, `*.key`, build output, logs…) so a teammate's secrets and
    junk are never pushed to the room. Proven: `.env`/`secret.txt`/`dist/` do NOT
    sync, normal files do.
  - **Faster — instant fs.watch.** Replaced 400ms polling with `fs.watch`
    (debounced ~40ms) for ~instant propagation and near-zero idle CPU; periodic
    scan kept as a fallback (2s when watch is active).
  - **Keep relay warm.** `server.js` self-pings `RENDER_EXTERNAL_URL` every
    10 min (opt-in via env) so the free host never sleeps — no ~30s cold start.
  - **Hardening.** Conflict-marker guard: a new `<<<<<<<` conflict is announced
    in chat (wakes agents on hive_wait) and a "resolved" note posts when cleared.
    Optional relay persistence: set `HIVE_PERSIST_DIR` to snapshot each room's
    CRDT state to disk (plain files, no native deps) so sessions survive restart.
  - Extension v0.2.8 (adds `ignore` dep). All 9 live tests + 38 unit tests pass.
  - NOTE: a transient break — the earlier working-tree revert dropped
    `@modelcontextprotocol/sdk` from package.json; `npm install` then pruned it,
    hanging the MCP tests. Reinstalled + saved. Re-add if it disappears again.


- **Live presence + chat for agents** (`HIVE_MEMBERS.md` in sync.js + extension;
  `hive-presence-test.js`; folder.js restored to the sync.js client). An agent
  now knows WHO is in the room and HOW MANY: every client renders a live
  `HIVE_MEMBERS.md` (name, kind, owner, count) on join/leave. Clean leaves are
  announced immediately (stop() sets awareness to null, no 30s timeout wait).
  How an agent participates: MCP → hive_members (who), hive_read_chat (read),
  hive_say (talk), hive_wait (wake on new chat/joins); files → read
  HIVE_MEMBERS.md + HIVE_CHAT.md, talk via hive-say.js. Proven in
  `hive-presence-test.js`: A joins (count 1) → human joins (count 2, A sees it)
  → human leaves (count back to 1). folder.js restored to thin client so the CLI
  human also gets chat/tasks/presence. Extension v0.2.7. 8 live + 38 unit pass.


- **Owner-only approve button + reactive agents** (`hive_wait` in hive-mcp.js;
  owner-gated buttons in the extension; `hive-wait-test.js`). Two fixes: (1) the
  Approve/Deny buttons showed on every window — now they render ONLY for the AI's
  owner (others see "— awaiting <owner>"); the panel gets the `owners` map and
  gates on `me === owner`. (2) "How does the AI see the approval and start?" —
  the CRDT data arrives in <1s, but an LLM agent doesn't poll, so added
  `hive_wait`: the agent BLOCKS on it and it returns the instant the owner
  approves (or new chat arrives). No interval to tune. Proven in
  `hive-wait-test.js`: agent blocks while task is pending, owner approves, wait
  returns ~1.1s later with the accepted task. Rules + MCP.md document the
  wait-loop. Extension v0.2.6. All 7 live tests + 38 unit tests pass.


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
