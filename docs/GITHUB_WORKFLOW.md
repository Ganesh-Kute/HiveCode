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
   It checks that `gh` is logged in, that the agent command exists and can use Hivecode, and that the
   labels exist, then keeps running and watches the repo.
   **Private code:** every run puts the branch in a room on a relay, by default our public one.
   Run your own (`npx -y hivecode-relay`, see docs/SELF_HOSTING.md) and add
   `--relay wss://<your relay>`.
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

### See it first: `--dry-run`

`github start --dry-run` reads GitHub once. For each labelled issue it says what a start would do
and what is in the way. It writes nothing anywhere: no label, comment, branch, lock, watcher id or
state file, and it starts no agent. Use it first on a repo that matters. It is also the first
answer to "why isn't it picking up my issue?".

`--repo <folder>` points `start` or `status` at that clone, from any folder.

| what goes wrong | what the dry run does |
|---|---|
| A watcher has run on this clone before | It reads the state file as it is, and never moves or rewrites it. An issue that is in review, stopped, closed, or waiting for a person is reported as that, with what moves it on. It is never "would start now". |
| Today's runs are used up | It says "would wait: today's limit of 20 runs is reached". |
| Another watcher claimed the issue | It says "would skip". It reads the claim comment, as a start would. |
| This clone lost its state file, and the issue has our claim and an open PR | It says it would pick that PR up again, without a run. A start does exactly that. |
| A watcher is running on this clone right now | It says so first. A dry run takes no lock, so it neither stops nor blocks that watcher. |
| The state file says a run is going, and no watcher is alive | It says the run was cut off, and that a start runs it again. |
| The state file cannot be read | It leaves the file where it is, and says that a start would move it aside and rebuild from GitHub. `status` leaves it alone too. |
| GitHub fails to list the issues | It says so and exits 1. It never reports "no labelled issues". |

### Progress in Slack: `--slack-channel`

`github start --slack-channel C0123456789`, with the Slack app's bot token in `SLACK_BOT_TOKEN`,
gives each issue **one Slack thread**. The thread opens with the issue's number, title and link.
Inside it:
- each run starting;
- the pull request, which is also shown in the channel;
- CI failures;
- the tester's verdict;
- waiting for a person, which is also shown in the channel;
- merged or closed, also shown in the channel.

Setting up the Slack app is in [SLACK_SETUP.md](SLACK_SETUP.md).

| what goes wrong | what we do |
|---|---|
| No `SLACK_BOT_TOKEN` | `start` refuses with Q633 and the fix, before anything is written. |
| A token Slack refuses, or a bot that is not in the channel | Checked against Slack before any work starts (Q630, Q631), naming the `/invite` that fixes it. |
| Slack says "ready for review" for a PR that GitHub refused | Every post goes out only after the GitHub write it reports has succeeded. |
| A restart opens a second thread for the same issue | The thread id is kept in the watcher's state file, so a restart continues the same thread. |
| The room's id reaches Slack | It is never posted. Anyone with the id can read the code in the room, and Slack is outside it. |
| Slack is down, or the token is revoked mid-run | The work on GitHub goes on. The refusal is said once per reason, not once per post. |
| The token ends up somewhere it shouldn't | It is read from the environment only. It is never a flag, so it is never saved with the flags or left in shell history. |
| A secret in an agent's summary | Scrubbed before posting, the same as on GitHub. |

**Replies from Slack.** With `SLACK_APP_TOKEN` set as well (Socket Mode, so no public URL is
needed), a reply of `stop` in an issue's thread stops that issue. A reply of `retry` starts it
again, but only from the Slack user ids in `--slack-allow`. The watcher turns the reply into the
same `/hivecode stop` or `/hivecode retry` comment on the issue, "(from Slack, by @handle)". So one
command path acts on it, and GitHub keeps who asked.

| what goes wrong | what we do |
|---|---|
| A guest, or someone from another workspace (Slack Connect), replies `stop` | Refused, and told so in the thread. Who may is decided by the same rules as `slack start`, in one place in `hive-slack.js`. |
| A full member who is not in `--slack-allow` replies `retry` | Refused, and told so. Stopping is the safe direction, so any full member may stop, but only named people may start agents again. |
| Slack cannot confirm who replied `stop` (rate limit, outage) | It stops anyway, and says it could not confirm who asked. `retry` stays refused. |
| GitHub refuses the comment | Slack is told "Could not stop: GitHub refused". It never says "stopping" for a stop that did not happen. |
| A reply in a thread the watcher does not own | Ignored. |
| `--slack-allow` without `SLACK_APP_TOKEN` | Start refuses (Q634) and says to set it. Without it the replies are never read, so nobody could retry from Slack, while the start looked fine. |
| `--slack-allow` without `--slack-channel` | Start refuses (Q634): there are no threads to reply in. |
| `SLACK_APP_TOKEN` set, but the bot token lacks `users:read` or the channel's history scope (`channels:history`, or `groups:history` for a private channel) | Start refuses (Q634), names the missing scopes, and says to reinstall the app from `slack-app-manifest-inbound.json`. Without the history scope Slack never sends the replies, so a `stop` would silently do nothing; without `users:read` every stop is "unverified" and every retry refused. Slack reports a token's scopes on every answer; if it does not, start says so and goes on. |
| `--slack-allow ganesh` or `@ganesh` (a name, not a member id) | Start refuses (Q634) and says where the id is: profile, More, Copy member ID. Slack sends ids like `U012AB3CD`, so a name would never match and every retry would be refused. |
| A `--slack-allow` (or `--slack-channel`) saved by the last start, refused now | The error says it was saved by the last start, and that passing it empty (`--slack-allow ""`) drops it. Every flag is saved and used again by the next start. |

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

### Which agents

The agent command gets its task on stdin, from its working folder, and must end with the lines the
task asks for.

| agent | command | status |
|---|---|---|
| Claude Code | `claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode` | the default this was built for |
| Codex | `codex exec --skip-git-repo-check -s workspace-write -` | flags checked against its `--help`; not yet run end to end |
| Gemini CLI | `gemini -p "Do the task above." --approval-mode auto_edit` | flags checked against its `--help`; not yet run end to end |

Codex refuses to run outside a git repository unless given `--skip-git-repo-check`. A room's
folder is deliberately not a checkout, so the flag is required, not optional.

### A second agent checks the first (`--tester`)

`--tester "<command>"` adds a tester. It can be a different vendor's agent, so the check is
independent.

1. The builder runs, and its work lands on the local branch. Nothing is pushed yet.
2. The tester runs in a fresh room seeded from that branch, so it holds the change.
   - It gets the issue and the builder's diff. The room's folder is not a git checkout, so it could
     not see the diff otherwise.
   - It may add or change tests only.
   - It ends with `VERDICT: PASS` or `VERDICT: FAIL`, plus a report.
3. On PASS, its tests land, and the branch is pushed. The PR shows commits from both agents, and a
   "Checked by Tester" section with the verdict and report.
4. On FAIL, nothing is pushed. Its report, and any failing test it wrote, become the builder's next
   task. Then the tester checks again.

Every run counts against the caps, so a tester doubles what an issue costs.

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
| `gh` is missing, logged out, or its token can't do something | `start` refuses and prints the exact fix, e.g. `gh auth login`. A logged-out `gh` gives no HTTP answer at all, only "please run: gh auth login", so that text is read as a login problem (Q600), not as a network outage. If the login stops working later, the watcher holds off and logs it every minute. It also sends one notification, since nobody may be watching that terminal. |
| The repo doesn't exist, or it is private and the account `gh` uses can't see it | GitHub answers 404 for both. `start` says which repo and which account (Q601), and that a private repo needs an account with access. It doesn't say "is gh logged in?", because the login just worked. |
| The `origin` URL has a token in it (`https://x-access-token:<token>@...`) | A message that quotes the origin drops everything between `//` and `@`, so the token never reaches a log or a screenshot. |
| Someone runs `github --help` | Usage goes to stdout with exit 0, before git or GitHub is asked anything. |
| The `--notify` webhook URL leaks (anyone holding it can post as you) | Only its host is ever printed ("posted to hooks.slack.com"). Given with `--notify`, it is saved with the other flags so a restarted service keeps notifying, in a state file only its owner can read (on Mac and Linux). Given as `HIVE_NOTIFY_WEBHOOK`, it is never saved. Something that is not an http(s) address is refused at start (Q609). |
| A service manager restarts `github start` (systemd, launchd, Task Scheduler) | The exit code says whether a restart can help: 0 stopped cleanly; 1 GitHub or Slack could not be reached, was busy (5xx, rate limit), or it crashed, so try again; 2 a person must change something (a login, a permission, a flag, a token, or a copy already running). What cannot be told apart exits 1, because a machine that booted before its network came up must not be left without a watcher. Recipes that use this are in [ALWAYS_ON.md](ALWAYS_ON.md). |
| The `hivecode` label doesn't exist | `start` creates `hivecode` and `hivecode:needs-human`. |
| A read from GitHub fails (network, outage, 5xx) | **A failed read is never treated as "no issues" or "PR closed".** Nothing changes state on a failed read. We back off and retry, and status says so. |
| Rate limit, primary or secondary | We wait for `Retry-After` or the reset time and do nothing twice. Status shows it. |
| The label was added by someone who can't push (a stranger, or a bot) | Skipped. Status and the log name who labelled it. Only write, maintain or admin counts. |
| The "issue" is a pull request (the issues API returns both) | Skipped. |
| More than 100 labelled issues | We read every page. They queue oldest first; `--max-parallel` (default 1) run at once. Only a claimed issue gets a comment. |
| Two watchers on one repo (two terminals, two machines) | A lock file covers one machine. Across machines, the claim comment's marker does: whoever commented first owns the issue. |
| The branch name is already taken | We add `-2`, `-3`, … We never reuse a branch we didn't create. |
| Someone pushes to the PR branch | The next run's room is seeded from the branch, so it includes their commits. If they push during a run, our push is refused, nothing of theirs is overwritten, and the issue goes to needs-human. |
| The default branch moves on, and GitHub says the PR can't be merged | While the issue is idle in review, the watcher merges the default branch into the PR's branch in a worktree of its own, never your checkout, and pushes the merge commit. CI runs again on it. On a conflict it aborts, pushes nothing, and the issue goes to needs-human with the files named. One try per head commit. Repos that require linear history won't take a merge commit: there the push is refused, and that also goes to a person. Agents resolving conflicts comes later. |
| The issue is edited after it was picked up | Runs use the text as it was when claimed. `/hivecode retry` reads it again, so a person can clarify the issue and retry. |
| The issue or the PR is closed, or the label is removed | We stop. A run in progress is killed, and we don't push. |
| The PR is closed without merging, with the label left on | Nothing starts again: closing it is a "no". `/hivecode retry` starts a new attempt. |
| The PR is reopened | We watch it again. |
| A huge issue body, or images only | The text is cut to 20 KB, and the task tells the agent so. The task also says how many images the issue has, and that the agent cannot see them. |
| The state file is lost or unreadable | An unreadable file is set aside, never deleted, and the start says where it went (Q606). Each claim comment names its branch, so the watcher picks up its pull requests, and anything waiting for a person, without running anything again. |
| CI never finishes (a stuck job) | After 2 hours pending we notify once, and keep watching. |
| The repo has no CI | The PR waits for review. Nothing is assumed passed. |

### The agent

| what goes wrong | what we do |
|---|---|
| The agent CLI isn't installed | `start` refuses. |
| The agent is `claude` and has no `hivecode` MCP server (`setup` never ran on this machine), or has one that does not connect | `start` (and `--dry-run`) refuses (Q602) with `npx -y hivecode-mcp@latest setup`, after asking `claude mcp get hivecode`, which is read-only and spends no tokens. Without it the first run fails only after the user has paid for it. `claude` not answering in 60 s is said ("could not check"), never passed. `--skip-agent-check` is for a server set up under another name. |
| The agent command passes `--allowedTools` without `mcp__hivecode` | `start` refuses (Q602): in `-p` mode the hive tools would be denied, the same paid-for failure. |
| Any other agent CLI (Codex, Gemini) | `start` says it did not check it, never that it passed. |
| Logged out, usage limit, bad API key | The run fails fast. We retry once, after 15 minutes. A second failure in a row sends the issue to needs-human, with the agent's last lines in the comment and the notification. We never retry in a tight loop. |
| Codex refuses to start outside a git repository | A room's folder is deliberately not a git checkout. Its command needs `--skip-git-repo-check` (see "Which agents"). |
| The agent never joins its room (Hivecode isn't set up for that agent CLI) | Said as exactly that, with the setup command. Never reported as "no changes". |
| It runs forever: stuck, or waiting for a permission prompt in headless mode | A time limit per run (`--max-minutes`, default 40). We kill the whole process tree, push nothing, keep its folder for inspection, and mark the issue needs-human. |
| It finishes without changing anything | On a first run: no PR. We comment with its own last words and mark the issue needs-human. On a review run, a question answered needs no change: its answer is posted on the PR. |
| It has a question | Nobody answers during a run, and the task says so. It writes `BLOCKED: <question>` and stops. We post the question on the issue and notify. A reply from someone with write access starts the next run. |
| Its last edit didn't reach the room before it exited | Before landing, we reconnect its folder, under its own identity, to send anything still pending. Landing refuses to land part of a room (Q507). |
| It says the tests pass and they don't | With `--test`, we run them ourselves. A failure becomes the next run's task. Without `--test`, the PR body says the result is the agent's report, not ours. |
| The tester says nothing usable: no VERDICT, or "mostly passes" | Only `VERDICT: PASS` or `VERDICT: FAIL` counts. Anything else is a failed run, never a pass. It is retried once after 15 minutes, then goes to a person. |
| The tester fails the builder's work again and again | After three FAILs in a row it goes to a person, with the tester's last report. The run caps apply as well. |
| The tester edits the implementation, not just tests | It is told not to. If it does, the PR names those files under "Checked by", so a reviewer reads them with care. |
| The tester passes broken code | A PASS is the tester's word. The --test gate, then CI, still run after it, and a person reviews the PR. |
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
| The repo has its own git hooks (husky, lefthook, a tool's post-checkout hook) | Hivecode's own scratch worktrees run without them: landing, the catch-up merge and the test gate. A hook that failed there made landing fail although git had done its job, and others run installs in a folder about to be deleted. The developer's checkout and every push keep their hooks. |
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
| `--repo` | the folder it is started in |
| `--dry-run` | off |
| `--slack-channel` | off; the token comes from `SLACK_BOT_TOKEN` |

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
- `tests/github-cli-test.mjs` checks what a stranger meets first: each refusal and its fix, and the
  dry run, both on a fresh clone and on one a watcher has worked in.
- `scripts/github-mutants.mjs` removes each important defence in turn, and its check has to go red.
  A defence whose check stays green is not covered, whatever the test claims.

## Not in this version

- More than one builder working the same issue at once. The tester runs after the builder, not
  beside it.
- The GitHub App: bot identity, webhooks, Marketplace. It needs Ganesh's account.
- Agents resolving merge conflicts.
- One watcher for several repos.
- Always-on hosting, on a VM or Maritime. The watcher is the piece that would run there.
