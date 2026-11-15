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
| 1 | Rules text: never end a turn unreachable, one answer per question, "For agents only" | Claude-cloud | done, c45cb3b. **Needs a review.** |
| 2 | `rules install`: the short block in AGENTS.md / CLAUDE.md / GEMINI.md | Claude-cloud | done (commit "Rules install"). **Needs a review.** |
| 3 | `hivecode-stay`: an agent with no MCP engine stays listed between listeners | Opus-Cloud | taken, starts on Ganesh's go |
| 4a | `.hive/`: the engine writes the seven generated files there | Claude-cloud | next |
| 4b | `.hive/`: docs, scripts, demo and the tests that read those files by path | Antigravity-1 | after 4a's commit |
| 5 | Docs: the block and `rules install` in the getting-started guide; one line in the join result | Antigravity-1 | after 4b |
| 6 | VS Code extension: same rules text, same `.hive/` layout | nobody | **not in this update**; its own release |
| 7 | A mention with a Slack format mark after the `@` (`@*Name`) wakes nobody | Antigravity-1 (found it) | spec below |

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
- Only the seven generated files move: `HIVE_RULES.md`, `HIVE_FOR_AGENTS.md`, `HIVE_BOARD.md`,
  `HIVE_CHAT.md`, `HIVE_TASKS.md`, `HIVE_MEMBERS.md`, `HIVE_CLAIMS.md` to `.hive/<same name>`.
- `.hive.json` and the five per-agent dotfiles stay where they are. `.hive-lock.json` is what keeps
  two clients out of one folder, and an old build looks for it at the top level.
- `.hive/` is never synced. The seven old top-level names stay in the skip list for good: an older
  client still writes them there.
- A top-level copy an older build left behind: removed on join when git does not track it; left
  alone, and named once in `hive_status`, when git tracks it. The package's own `HIVE_RULES.md`
  stays at the package root.
- One path constant in `hive-instructions.js`; every text that names a file uses it.

**4a (Claude-cloud):** `sync.js`, `hive-stop-hook.js`, `hive-instructions.js`, `hive-mcp.js`, and
their tests, including an old client and a new client in one room.
**4b:** `docs/`, `scripts/`, `demo/`, `scorecard.mjs`, the site pages, and the tests that read one
of the seven files by path. Wait for 4a's commit, then `grep -rn "HIVE_\(RULES\|FOR_AGENTS\|BOARD\|CHAT\|TASKS\|MEMBERS\|CLAIMS\)"`.

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
