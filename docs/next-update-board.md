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
| 2 | `rules install`: the short block in AGENTS.md / CLAUDE.md / GEMINI.md | Claude-cloud | done, 6b38d97 + 6fd143a + 2898c62. **Reviewed by Antigravity-1 (18/18 on win32).** |
| 3 | `hivecode-stay`: an agent with no MCP engine stays listed between listeners | Opus-Cloud | **done: 60d4cc3 on this branch** (578e5c6 cherry-picked, clean). Reviewed by Antigravity-1 (28/28 on win32). |
| 4a | `.hive/`: the engine renders the room there; every test that reads those files | Claude-cloud | done, 2499e8d + f3433d3 + b424c00. **Reviewed by Opus-Cloud (Linux) & Antigravity-1 (win32, 10/10 with 0.14.15 D5 + 61/61 stop-hook).** 17 mutants, all caught. |
| 4b | `.hive/`: docs, scripts, demo, the site pages | Antigravity-1 | **done, 55c643d. Reviewed by Opus-Cloud (9/9 on Linux).** |
| 5 | Docs: the block and `rules install` in the getting-started guide; one line in the join result | Antigravity-1 | **done, 5b6efb8 + follow-up. Reviewed by Opus-Cloud & Claude-cloud.** |
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
  it; left alone, byte for byte, when git tracks it, and then named to the agent in `hive_status`
  (`thisFolderOnly`) with where the live copy is. The package's own `HIVE_RULES.md` stays at the
  package root.
- The paths are constants in `hive-instructions.js` (`RULES_PATH`, `CHAT_PATH`, ...). `sync.js`
  writes by them and every agent-facing text names files by them.
- The Stop hook runs as the newest build while the agent's MCP server may still be the one it
  started as, so it reads the copy that server writes. The server names the folder in the record
  it writes on join (`hiveDir` in `.hive-mcp-session.json`); a record without it was written by an
  older build, which renders at the top. It is not told from file times.

**4a (Claude-cloud):** `sync.js`, `hive-stop-hook.js`, `hive-instructions.js`, `hive-throttle.js`,
`hive-pr.js`, and every test that reads one of the six files. `tests/hive-dir-test.mjs` D1 to D8:
D5 runs a real 0.14.15 client and this build in one room, D7 asks git which old copies it tracks,
D8 lands a room on a git branch and checks nothing from `.hive/` is taken.
**What ran for 2499e8d** (Linux, node 22, one at a time; every one exit 0): hive-dir 6/0,
rules-promises, rules-install 13/0, stop-hook 60/0, hive-presence, hive-activity, hive-talk,
folder-board, hive-agent, shared-launch-folder 8/0, resolve-fork 19, mail-identity 46/0, mcp-wait
59/0, private-room-client 12/0, test.js 95/0, branch 53/0, hive-await 34/0, presence-listener 19/0,
agent-liveness 22/0, listener-status 8/0, mailbox 77/0, readme-promises 24/0, site-cli-usage,
mcp-conformance 20/0. After the rebase on cbc1711: hive-dir, stop-hook, rules-promises,
rules-install, mention-boundary 37/0, mailbox 77/0, mail-identity 46/0.
Not checked: Windows, macOS, the VS Code extension.

**Mutants for 4a** (f3433d3, in a scratch copy, one break at a time, then the test that should
notice). All 11 were caught:

| The break | Caught by |
|---|---|
| `.hive/` is not ignored, so it syncs to the room | D2 |
| the six old top-level names are no longer skipped | D4 |
| a top-level copy git tracks is removed too | D4 |
| old top-level copies are never cleared | D3, D4 |
| "git could not be asked" is read as "git tracks none" | D7 |
| the sign (`HIVE_FOR_AGENTS.md`) moves into `.hive/` too | D1, D6 |
| the rules file stays at the top level | D1, D3, D4, D5 |
| landing on a branch takes files from `.hive/` | D8 |
| the Stop hook reads `.hive/` only | H16 |
| the Stop hook reads the top level only | H1, H4, H5, H6 |
| the Stop hook takes the first copy it finds, not the newest | H16 |

**Opus-Cloud's review of 4a (f3433d3): pass, with two findings. Both fixed.**
- *Gap against this board.* The copy that is left alone was named only in the client's log, and
  the board said `hive_status`. An agent never reads the log; it does open a `HIVE_CHAT.md` at the
  top of the folder. Now it goes through the engine's `note()`, which `hive_status` shows. D10.
- *The Stop hook trusted file times.* In a repository that committed `HIVE_CHAT.md`, a
  `git checkout` rewrites the top-level copy and a dead chat is the newest file. "Prefer `.hive/`
  when git tracks the other" is wrong the other way round (an older server in that repository keeps
  writing the tracked copy). So the server says where it renders: `hiveDir` in its record. Opus-Cloud
  checked that 0.14.15 builds its record fresh on join, so an older server's join drops the field.
  H16 and H17 failed first on the old code; H18 keeps the hook from following any other path;
  `shared-launch-folder` S1b checks a real server writes the field.

Six more mutants, all caught:

| The break | Caught by |
|---|---|
| the server does not name its folder in the record | S1b, S2a, S2b (shared-launch-folder) |
| the hook always reads `.hive/` | H16, H18 |
| the hook always reads the top level | H1, H4, H5, H6 |
| the hook follows whatever folder the record carries | H18 |
| a kept copy is only logged | D10 |
| a removed copy is announced to the agent too | D10 |

Ran after the fix (Linux, node 22, one at a time, all exit 0): stop-hook 61/0, hive-dir 10/0,
shared-launch-folder 9/0, private-room-client 12/0, mail-identity 46/0, coordination 60/0, mcp-wait
59/0, mcp-conformance 20/0, rules-promises, readme-promises 24/0, session-resume 5/0, lifecycle 35,
hive-wakestate 18, presence-listener 19/0, delete-safety 39/0, test.js 95/0, stay 28/0, hive-await
35/0, throttle 33, rules-install 15/0. Not checked: Windows, macOS.

**4b (Antigravity-1):** `docs/`, `scripts/`, `demo/`, `scorecard.mjs`, `public/`, `README.md`. Wait
for 4a's commit, then
`grep -rnE "HIVE_(RULES|BOARD|CHAT|TASKS|MEMBERS|CLAIMS)\.md" docs scripts demo public README.md scorecard.mjs`.
Leave `extension/` alone (item 6) and leave the history in `docs/rules-rewrite/` as it was written.

## 5. The join-result line, measured
The first version (5b6efb8) printed `rules install --dir "<ROOT>"`. ROOT is the room folder, and on
a default join that is `~/hivecode/<room>/<name>`, not the folder the agent's app starts in. Run as
printed, in a room of two agents on a local relay:
1. `AGENTS.md` was created in the room folder;
2. it arrived in the other agent's folder (a room folder is synced), so every member gets it and
   `hive_pr` would land it;
3. the file the app really loads (`CLAUDE.md` in the launch folder) was untouched, so nothing loaded
   on every turn.

The server cannot know where the app started. So the line names no folder and leaves it to the
person (c99905b, Antigravity-1), and `rules install`, `show` and `remove` say when the folder they
write in is a synced room folder (2898c62). Checks: I11b (the source line), I12 (the note), and
`shared-launch-folder` S1c, which reads the line from a real `hive_join` whose room folder is under
the Hivecode home. Five mutants for the note, all caught (only the file's own folder checked; said
when nothing changed; `remove` silent; every folder taken for a room; `show` silent).

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
Each was run on a clean copy of main (6df8390) and on this branch, same machine, same day.
- `tests/token-budget-test.mjs`: "carried on every request <= 3,500 tok" reads 3,715 on main and
  3,750 with item 1. It is not in CI.
- `tests/billing-test.mjs`: "the relay serves it too (it hosts the site)": 97/1 on main, 97/1 here.
- `tests/ci-gate-workflow-test.mjs`: "finds acorn in github.action_path": 10/1 on main, 10/1 here.
