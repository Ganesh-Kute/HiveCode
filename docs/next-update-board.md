# Next update: board

Asked for by Ganesh, 15 Nov 2026. Branch: `claude/gifted-fermi-fpp34y`. This file is the record;
the room carries only what changed.

**No PR, merge, publish or deploy.** Ganesh says when.

## How we work on it
- One owner per item. Say what you take before you start.
- Rebase on the branch before you push. One commit per item.
- Failing test first. A crash on a missing file is not a failing test.
- Review by someone who did not write it: correctness only, `file:line` and an input that breaks it.
- Report: `commit | what you ran | passed/failed | the failing lines | what you did not check`.

## Items

| # | Item | Owner | State |
|---|---|---|---|
| 1 | Rules text: never end a turn unreachable, one answer per question, "For agents only" | Claude-cloud | done, c45cb3b. **Reviewed by Antigravity-1 (14/14, 57/57 on win32).** |
| 2 | `rules install`: the short block in AGENTS.md / CLAUDE.md / GEMINI.md | Claude-cloud | done, 6b38d97. **Reviewed by Antigravity-1 (13/13 on win32; 2 minor edge-case notes).** |
| 3 | `hivecode-stay`: an agent with no MCP engine stays listed between listeners | Opus-Cloud | **done, 578e5c6 (on `claude/blissful-allen-2ymvsk`). Reviewed by Antigravity-1 (28/28 on win32).** Still to come onto this branch. |
| 4a | `.hive/`: the engine renders the room there; every test that reads those files | Claude-cloud | done (commit ".hive/"). **Needs a review.** |
| 4b | `.hive/`: docs, scripts, demo, the site pages | Antigravity-1 | open: 4a is on the branch |
| 5 | Docs: the block and `rules install` in the getting-started guide; one line in the join result | Antigravity-1 | after 4b |
| 6 | VS Code extension: same rules text, same `.hive/` layout | nobody | **not in this update**; its own release |
| 7 | A mention with a Slack format mark after the `@` (`@*Name`) wakes nobody | Antigravity-1 (found it) | **done, 2a1f0dc + follow-up. Reviewed by Opus-Cloud (246/246 on Linux).** |

Already on the branch from before: 09380fd (a relay says a revoke lasts only when it does),
547ceb7 (the docs claim is tested), 0da215e (a person at the control panel shows as a person).

## 1. Rules text (done, review wanted)
What and why: `docs/rules-rewrite/2026-11-15-reachable-and-quality.md`.
Check: every claim in the new text against the code (does `hive_status` say when you are out of the
room? does each named tool exist? is anything in "For agents only" something an agent cannot do?).
`node tests/rules-promises-test.mjs` (14 checks) and `node tests/stop-hook-test.mjs` (57).

## 2. `rules install` (done, review wanted)
`npx -y hivecode-mcp@latest rules install | remove | show`, in `hive-rules-install.js`; the block is
`AGENT_FILE_BLOCK` in `hive-instructions.js`. `node tests/rules-install-test.mjs`: 13 checks; seven
mutants killed (append, remove, a lone marker, creating files, CRLF, a second install, an emptied
file). Not checked: Windows; which file each agent app really reads beyond AGENTS.md, CLAUDE.md and
GEMINI.md (the list in `KNOWN` is from the apps' documentation, not from a run).

## 3. `hivecode-stay`
**Problem.** An agent that drives Hivecode from its shell (a cloud session: no MCP engine) is in the
member list only while its listener runs. Every wake and every idle exit drops it from the list
until it starts the listener again. Ganesh, 15 Nov: "you drop the connection and leave".

**Build.** Ship `hive-stay.js` as a command:
`hivecode-stay "<relay|room>" <Name> [--grace <minutes>] [--detach]`
- Presence only (`syncFiles: false`), under the agent's name, with a new awareness tag `keeper: true`.
- It is **not** `listener` and **not** `passive`. So the room keeps telling the truth with the code
  it already has (`hive-activity.js stateOf`): WAITING while a listener is also connected, PARKED
  when only the keeper is. A keeper must never make a deaf agent look reachable.
- Do not stamp activity when a listener wakes the app. A wake is not proof the agent acted: the
  same reason the listener publishes HANDED and never READ (`hive-await.js`).
- It ends on its own:
  - no listener for this name and room armed on this machine (`hive-listen.js isArmed`) for
    `grace` minutes (default 30);
  - a full engine with the same name (not a listener, not a keeper) present for 30 s: presence is
    that engine's job;
  - a newer keeper for the same name and room started (newest wins, as `ARMED` does);
  - SIGINT / SIGTERM.
- `--detach`: start itself detached with stdio ignored, print the pid, return at once. An agent
  must be able to start it from one tool call on any OS.
- `sync.js`: `sameNameElsewhere` skips a keeper (or the agent's own MCP join is refused because of
  its own keeper); `members()` reports `keeper` only when every connection under the name is one.
- `hive-await.js` lifetimes do not change. Nothing starts a keeper automatically in this update.
- `package.json`: `files` and `bin`.

**Tests** (`tests/stay-test.mjs`, a local relay, short grace through an env var):
listed while listening; still listed and not `listener` after the listener exits; listening again
after a new listener, with one keeper process; gone after the grace with no listener; leaves when a
full engine with the same name joins, and that join is not refused; an older keeper leaves when a
newer one starts; `--detach` returns in under 5 s and the child is alive. Say what an old build
shows for a keeper.

## 4. `.hive/`
**Decided.**
- **Six** rendered files move: `HIVE_RULES.md`, `HIVE_CHAT.md`, `HIVE_MEMBERS.md`, `HIVE_CLAIMS.md`,
  `HIVE_BOARD.md`, `HIVE_TASKS.md` to `.hive/<same name>`.
- **`HIVE_FOR_AGENTS.md` stays at the top level.** It is the sign on the door: its whole job is to
  be seen by an agent that opens the folder with no Hivecode tools, and nobody looks inside a
  dot-folder for a sign. It now points at `.hive/`. (Changed from "all seven" while building 4a.
  One line to flip: `MANUAL_PATH` in `hive-instructions.js`.)
- `.hive.json` and the five per-agent dotfiles stay where they are. `.hive-lock.json` is what keeps
  two clients out of one folder, and an old build looks for it at the top level.
- `.hive/` is never synced (`ALWAYS_IGNORE`). The six old top-level names stay in `SKIP` for good:
  an older client still writes them there.
- A top-level copy an older build left behind: removed at the first sync when git does not track
  it; left alone, byte for byte, and named in the client's log when git tracks it. The package's
  own `HIVE_RULES.md` stays at the package root.
- The paths are constants in `hive-instructions.js` (`RULES_PATH`, `CHAT_PATH`, ...). `sync.js`
  writes by them and every agent-facing text names files by them.
- The Stop hook reads whichever copy of the chat was written last, `.hive/` or the top level: it
  runs as the newest build while the agent's MCP server may still be the one it started as.

**4a (Claude-cloud):** `sync.js`, `hive-stop-hook.js`, `hive-instructions.js`, `hive-throttle.js`,
`hive-pr.js`, and every test that reads one of the six files. `tests/hive-dir-test.mjs` D1 to D6:
D5 runs a real 0.14.15 client and this build in one room.
**4b (Antigravity-1):** `docs/`, `scripts/`, `demo/`, `scorecard.mjs`, `public/`, `README.md`. Wait
for 4a's commit, then
`grep -rnE "HIVE_(RULES|BOARD|CHAT|TASKS|MEMBERS|CLAIMS)\.md" docs scripts demo public README.md scorecard.mjs`.
Leave `extension/` alone (item 6) and leave the history in `docs/rules-rewrite/` as it was written.

## 7. `@*Name` wakes nobody
**Found by Antigravity-1, 15 Nov.** Ganesh bolded part of a Slack message and Slack sent
`@*Antigravity-1 ...*`. `hive-await.js:111` and `hive-mailbox.js mentionsName` both need the name
straight after the `@`, so the listener and the mailbox both missed it.

**Fix in two places, a failing test first for each.**
- At the source: where `hive-slack-relay.js` turns a Slack message into room text, move the format
  marks (`*`, `_`, `~`, a backtick) out from between `@` and the name. The relay is deployed on its
  own, so this also fixes every client that is already installed.
- In the client: one matcher. `hive-await.js` should use the mailbox's `mentionsName` instead of its
  own regex, and that one matcher skips format marks between `@` and the name. If moving the
  listener to the mailbox's matcher changes what wakes it (a mention inside quotes or a code span
  does not count there), say so before you push: that is a behaviour change others rely on.

## Known red, not ours
`tests/token-budget-test.mjs`: "carried on every request <= 3,500 tok" reads 3,715 on main and
3,750 with item 1. It is not in CI.
