# GitHub workflow: label an issue, get back a tested PR

Status, 13 Oct 2026:
- **Built:** the watcher (`hive-github.js`).
- **Tested:** `tests/github-watcher-test.mjs` runs a real relay, real git with a real `origin`, and
  the real MCP join, against a fake GitHub and a fake agent.
- **Mutants:** `scripts/github-mutants.mjs` removes each defence in turn and checks that its row
  goes red.
- **Not yet run:** against a real repository with a real agent.

The tables below describe what the code does.

## What the user does

1. Once per repo, in their clone:
   `npx -y hivecode-mcp@latest github start --agent "<agent command>"`
   It checks that `gh` is logged in, that the agent command exists and that the labels exist, then
   keeps running and watches the repo.
2. They label an issue `hivecode`.
3. A PR comes back, with:
   - the issue's title;
   - `Closes #12`;
   - what changed and why;
   - which tests ran and what they returned;
   - one commit per agent.
4. If CI fails or they review the PR, the agent gets it and pushes fixes to the same PR.
   - Inline comments and reviews always go to the agent.
   - A plain comment goes only if it starts with `/hivecode`, so "thanks" or "LGTM" never spends a run.
5. They merge. To stop at any point, they remove the label or comment `/hivecode stop`.
   `/hivecode retry` starts it again.

They never open a terminal for an issue and never watch a chat.

## How it works

The watcher is one process on a machine that has the clone, `gh` logged in, and an agent CLI:
Claude Code, Codex or Gemini CLI. That machine can be a laptop, a desktop or a VM.

Every minute it asks GitHub, through `gh`, what changed. Nothing has to reach in from outside, so it
works behind a company firewall, and no server of ours ever holds a GitHub key.

For each labelled issue:

| step | what happens |
|---|---|
| claim | It comments on the issue, with a hidden marker so no second watcher takes it, and creates the branch `hivecode/12-<slug>` from the default branch. |
| run | It opens a fresh room seeded from that branch and starts the agent with the task on stdin. It waits, with a time limit. |
| land | It makes one commit per agent on the branch and pushes. The first run opens the PR. Later runs push to that PR and comment on what they changed. |
| test | Optional `--test "<command>"`. The watcher runs the project's tests itself before pushing, so "tested" is a fact we checked, not the agent's word. |
| watch | It reads the CI result for the PR's newest commit, and the reviews and comments from people with write access. |
| loop | Each new CI failure, or batch of review comments, becomes the next run's task. The agent gets the failing job's log, not just "failed". A review becomes one run once nothing new has arrived for 90 s, not one run per comment. |
| finish | When the PR is merged or closed, it stops, removes the room folders and sends a notification. |

Every run gets a new room, seeded from the branch as it is right now. So the room always includes
commits a person pushed to the branch, and a relay that loses its rooms costs at most the run in
progress. The watcher keeps its own state in the repo's `.git` folder, never on the relay.

Notifications are optional: one Slack or Discord webhook URL. They are sent when:
- a PR is ready;
- CI failed (the fix is under way);
- the issue needs you;
- the PR was merged or closed;
- CI has hung for two hours (once);
- the daily run limit is reached (once).

Nothing is sent for each comment.

## Why `gh` and not a GitHub App, for now

- **With `gh`, nothing new is exposed.**
  - There's no public endpoint to attack, and no private key on our relay.
  - It works with a self-hosted relay inside a company network.
  - It ships today, without waiting for an app to be registered.
- **Every API call is the user's own.** They can see each one and revoke it with `gh auth logout`.
- **The App comes next, for three things `gh` can't give:**
  - PRs and comments from `hivecode[bot]` instead of the user. Under branch protection you cannot
    approve your own PR.
  - Instant webhooks instead of a one-minute poll.
  - A listing on the GitHub Marketplace.

  The watcher's design does not change. Only where events come from, and who signs the PR.

## What stays the same

- Git is the record, and the room is where the work happens.
- CI, required reviewers and branch protection all keep working as before.
- Agents never merge. A person does.

## What can go wrong, and what we do

"Wrong but green" is the failure this project keeps producing: it says it worked, and it didn't.
Each row below says what the user sees.

### GitHub

| what goes wrong | what we do |
|---|---|
| `gh` is missing, logged out, or its token can't do something | `start` refuses and prints the exact fix, e.g. `gh auth login`. A token that expires later stops the watcher with the same message, never silently. |
| The `hivecode` label doesn't exist | `start` creates `hivecode` and `hivecode:needs-human`. |
| A read from GitHub fails (network, outage, 5xx) | **A failed read is never treated as "no issues" or "PR closed".** Nothing changes state on a failed read. We back off and retry, and status says so. |
| Rate limit, primary or secondary | We wait for `Retry-After` or the reset time and do nothing twice. Status shows it. |
| The label was added by someone who can't push (a stranger, or a bot) | Skipped. Status and the log name who labelled it. Only write, maintain or admin counts. |
| The "issue" is a pull request (the issues API returns both) | Skipped. |
| More than 100 labelled issues | We read every page. They queue oldest first; `--max-parallel` (default 1) run at once. Only a claimed issue gets a comment. |
| Two watchers on one repo (two terminals, two machines) | A lock file covers one machine. Across machines, the claim comment's marker does: whoever commented first owns the issue. |
| The branch name is already taken | We add `-2`, `-3`, … We never reuse a branch we didn't create. |
| Someone pushes to the PR branch | The next run's room is seeded from the branch, so it includes their commits. If they push during a run, our push is refused, nothing of theirs is overwritten, and the issue goes to needs-human. |
| The default branch moves and the PR conflicts | We try a clean merge of the default branch. If it conflicts, the issue goes to needs-human. Agents resolving conflicts comes later. |
| The issue is edited after it was picked up | Runs use the text as it was when claimed. `/hivecode retry` reads it again, so a person can clarify the issue and retry. |
| The issue or the PR is closed, or the label is removed | We stop. A run in progress is killed, and we don't push. |
| The PR is reopened | We watch it again. |
| A huge issue body, or images only | The text is cut to 20 KB, and the task tells the agent so. The task also says how many images the issue has, and that the agent cannot see them. |
| The state file is lost or unreadable | It is set aside, never deleted. Each claim comment names its branch, so the watcher picks up its pull requests, and anything waiting for a person, without running anything again. |
| CI never finishes (a stuck job) | After 2 hours pending we notify once, and keep watching. |
| The repo has no CI | The PR waits for review. Nothing is assumed passed. |

### The agent

| what goes wrong | what we do |
|---|---|
| The agent CLI isn't installed | `start` refuses. |
| Logged out, usage limit, bad API key | The run fails fast. We retry once, after 15 minutes. A second failure in a row sends the issue to needs-human, with the agent's last lines in the comment and the notification. We never retry in a tight loop. |
| The agent never joins its room (Hivecode isn't set up for that agent CLI) | Said as exactly that, with the setup command. Never reported as "no changes". |
| It runs forever: stuck, or waiting for a permission prompt in headless mode | A time limit per run (`--max-minutes`, default 40). We kill the whole process tree, push nothing, keep its folder for inspection, and mark the issue needs-human. |
| It finishes without changing anything | On a first run: no PR. We comment with its own last words and mark the issue needs-human. On a review run, a question answered needs no change: its answer is posted on the PR. |
| It has a question | Nobody answers during a run, and the task says so. It writes `BLOCKED: <question>` and stops. We post the question on the issue and notify. A reply from someone with write access starts the next run. |
| Its last edit didn't reach the room before it exited | Before landing, we reconnect its folder, under its own identity, to send anything still pending. Landing refuses to land part of a room (Q507). |
| It says the tests pass and they don't | With `--test`, we run them ourselves. A failure becomes the next run's task. Without `--test`, the PR body says the result is the agent's report, not ours. |
| It edits `.github/workflows/` | Refused unless `--allow-workflow-changes` is set. An agent misled by an issue could write a workflow that leaks the repo's secrets when CI runs. |
| It writes a key or token into a file | The room never carries a file with a key in it (hive-secrets.js), so the landing doesn't either. We also scan everything we post on GitHub. |
| A CI fix loop that never converges (a flaky test) | `--max-runs` per issue (default 6) and per day (default 20). If the same checks fail twice in a row, it goes to needs-human. |
| It pushes or opens a PR itself, bypassing the watcher | The task tells it not to. If it does anyway, nothing it pushed is overwritten: our push is refused, and the issue goes to a person. |
| It does damage outside the repo | On the user's own machine, an agent can do anything the user can. We say so plainly. To isolate it, run the watcher in a container or VM. |
| Prompt injection in an issue or a comment | Work starts only from a label someone with push access added. Only comments from people with write access are forwarded, checked against GitHub's permission for each person, not just their badge. The task quotes the issue as data from someone else. Agents can't merge, and a person reviews every PR. |

### The room and the relay

| what goes wrong | what we do |
|---|---|
| The relay is unreachable, or cold-starting (about 50 s on Render free) | The run doesn't start. We retry, and status says why. |
| The relay restarts mid-run and loses the room | The agent's folder still has its files, and its server refills the room when it reconnects. Landing checks that every file arrived (Q507). Worst case, we redo the run from the branch. |
| The public relay holds the code | Room ids are random (104 bits) and never posted on GitHub. `start` warns once when the repo is private and the relay is ours. Recommended: run your own relay (`npx hivecode-relay`). |
| A repo too big for a room | Rooms skip binaries and files over 1 MB, and agents on the watcher's machine fill those in from git. Past 5,000 files on the public relay, `start` refuses (Q608) and offers two ways out: your own relay, or `--allow-large`. |

### The machine

| what goes wrong | what we do |
|---|---|
| The laptop sleeps | Everything pauses. On wake we push each deadline back by the time asleep, so a sleeping run is not killed for being slow. For 24/7, run on a machine that stays on. |
| The watcher crashes, or Ctrl+C | It kills its agents' process trees on the way out. On restart, a run marked running whose process is gone counts as a failed run and is retried. |
| Windows | Agent CLIs are `.cmd` shims, so we start them through the shell. The prompt goes on stdin, never on the command line, so no quoting can break it. Process trees are killed with `taskkill /T`. |
| git asks for a password, or a credential manager opens a login window, and nobody is there to answer | Git is never allowed to prompt (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), so it fails at once instead of hanging. The error says to run `gh auth setup-git`, and the issue goes to a person rather than retrying every two minutes. |
| The home folder is itself a git repository, and `start` is run outside the project | `start` says exactly that, instead of a puzzling "origin (none)". |
| The disk fills with room folders | Finished issues' folders are removed. Only the last failed run's folder is kept. |

### People

| what goes wrong | what we do |
|---|---|
| They comment while a run is going | It waits for the next run. One run per issue at a time. |
| They merge while a fix run is going | We kill the run, push nothing, and finish. |
| They want everything stopped | Remove the label, comment `/hivecode stop`, or Ctrl+C the watcher. |
| Notifications become noise | One per change of state, never one per comment. |
| They write "thanks" or "LGTM" on the PR | Nothing runs. Only reviews, inline comments, and comments starting with `/hivecode` go to the agent. |
| They can't approve the PR (it's theirs, under branch protection) | Said in the docs. The GitHub App fixes it. |
| A squash merge | GitHub keeps co-authors in the squash commit. The per-agent commits stay visible in the PR. |

### When real users arrive

| what goes wrong | what we do |
|---|---|
| A stranger's private code on our public relay | The warning above, plus `--relay` in the first line of the docs. |
| Their tokens get spent without them | Runs only start from a label. Every run is capped and counted, and `github status` shows today's runs. |
| A support question | Every refusal has a Q-code and the exact command that fixes it. |
| Mixed versions | The agent's own Hivecode must know branch rooms (`hive_join` with `branch`). Landing needs signed receipts, which every such runtime has. |
| Mac, Linux and Windows | The tests run on all three, through the existing Mac/Linux workflow. |

## Defaults

| setting | default |
|---|---|
| `--label` | `hivecode` |
| `--every` | 60 s |
| `--max-parallel` | 1 issue |
| `--max-minutes` | 40 per run |
| `--max-runs` | 6 per issue, 20 per day |
| `--relay` | the public relay; self-hosted recommended for private code |
| `--test` | off; the PR says the test result is the agent's report |

## Build order

All built on 13 Oct 2026:
1. The watcher core: claim, run, land, PR, with caps and state.
2. The loop: CI results and trusted comments become the next run.
3. Kill switches and needs-human.
4. Notifications.
5. `github status`.
6. Docs, plus this file kept true.

## How it is tested

- `tests/github-watcher-test.mjs` runs everything for real except GitHub and the agent: a local
  relay, a real git repo with a local `origin`, a fake GitHub inside the test, and a fake agent that
  joins its room through the real MCP server code. It spends no tokens and touches no real repo.
- `tests/github-cli-test.mjs` checks what a stranger meets first: each refusal, and its fix.
- `scripts/github-mutants.mjs` removes each important defence in turn, and its check has to go red.
  A defence whose check stays green is not covered, whatever the test claims.

## Not in this version

- A second, independent tester agent per issue. Next.
- The GitHub App: bot identity, webhooks, Marketplace. It needs Ganesh's account.
- Agents resolving merge conflicts.
- One watcher for several repos.
- Always-on hosting, on a VM or Maritime. The watcher is the piece that would run there.
