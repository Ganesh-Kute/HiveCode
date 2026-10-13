// features.js — what this product promises, how hard each promise is to check, and the exact
// assertion that proves it still holds.
//
// THE INCIDENT THIS EXISTS FOR. On 18 Sep 2026 an agent shipped six tickets. Every suite was
// green. Two of the six were wrong. One of them, HIV-13, changed a divisor and made the operator's
// dashboard under-report agent runtime by 10x; its own test PRINTED `{"minutes":0,...}` while
// passing, because the assertion was `used?.writes > 0`. The test ran, went green, and asserted
// something other than the behaviour that mattered.
//
// A file listing features would not have caught that, and neither would a document of procedures.
// What catches it is naming, per promise, THE ASSERTION THAT PROVES IT -- and then mechanically
// checking that the assertion actually ran and actually passed. That is what tests/features-test
// .mjs does with this file, and it is the difference between a manifest and a gate.
//
// (Agent Relay keeps the same artefact at .agentworkforce/features/manifest.yaml, scored by
// criticality and by a 1-6 verify tier, with a guardian agent reading it. Their own comment is the
// load-bearing one: "Tier alone is deliberately not a test plan." Theirs is a document an LLM
// reads; this one is executable, which is the only version that can fail a build.)
//
// A JS MODULE RATHER THAN YAML, for two reasons that are not style. This repo has no YAML parser
// and adding a dependency to describe the repo would be a poor trade. And the `breaks:` line on
// every entry is the part that makes the file worth keeping -- JSON cannot carry a comment, and a
// manifest nobody can annotate is a manifest that rots.
//
// HOW TO ADD A FEATURE: write the promise, say what breaks without it in one sentence a non-author
// would understand, and name a real assertion string from a real suite. `proves: []` is allowed and
// is not a placeholder -- it is a declaration that this promise is currently unproven, and the
// checker reports every one of them. That list is the most useful thing this file produces.

/** How much of the world has to exist before a promise can be checked at all. */
export const TIERS = {
  1: 'pure — no relay, no network, no clock. Runs anywhere in milliseconds.',
  2: 'a local relay and one client.',
  3: 'a local relay and two or more clients — everything about contention lives here.',
  4: 'two or more MCP sessions driven exactly as an agent drives them.',
  5: 'an external service (Linear, Telegram, npm, the hosted relay).',
  6: 'a human, a browser, or another vendor\'s agent. CANNOT be automated in this repo.',
}

/**
 * critical — the product is not the product without it. Check on every change.
 * hot      — used constantly; check whenever anything near it moves.
 * standard — real, but a regression here is an inconvenience rather than a breach.
 */
export const CRITICALITY = ['critical', 'hot', 'standard']

/**
 * THE POINT OF `breaks`. A feature name tells a reader what the code does. `breaks` tells them
 * what it costs when it stops, which is the only thing that lets somebody who did not write it
 * decide whether a red line matters at 3am. Every entry is written for that reader.
 */
export const FEATURES = [
  // ── the concurrency guarantees: the reason this product exists ───────────────────────────
  {
    id: 'crdt-converge',
    name: 'Concurrent edits converge without losing text',
    criticality: 'critical', tier: 1,
    breaks: 'Two agents edit one file and one of them silently loses their work.',
    proves: [{ suite: 'tests/test.js', assertion: 'no text lost' }],
  },
  {
    id: 'claim-exclusive',
    name: 'A claimed file is held against every other agent',
    criticality: 'critical', tier: 1,
    breaks: 'Claims become decoration: two agents "own" the same file and both write it.',
    proves: [
      { suite: 'tests/test.js', assertion: 'B sees A holds the lock' },
      { suite: 'tests/test.js', assertion: 'expired lock is free' },
    ],
  },
  {
    id: 'held-file-not-deleted',
    name: 'A file someone holds is not deleted under them: refused by the deleting client, and restored by the relay when an older client sends the delete anyway',
    criticality: 'critical', tier: 3,
    breaks: 'A teammate\'s delete removes a file another agent holds and is mid-edit on, from every folder, the holder\'s included. A client from before the check, or a script, sends that delete straight to the room.',
    proves: [
      { suite: 'tests/delete-safety-test.mjs', assertion: 'H1 Bob keeps the file he holds, with his edit in it' },
      { suite: 'tests/delete-safety-test.mjs', assertion: 'H3 it is back in Alice\'s folder, with the room\'s content' },
      { suite: 'tests/relay-claim-delete-test.mjs', assertion: 'A1 Alice direct manifest.delete of held.js is compensated/restored by relay' },
      { suite: 'tests/relay-claim-delete-test.mjs', assertion: 'C1 Atomic claim-clear + delete-manifest is caught and restored' },
      { suite: 'tests/relay-claim-delete-test.mjs', assertion: 'B1 Bob (holder) deleting own.js is permitted by relay' },
    ],
  },
  {
    id: 'claim-scope',
    name: 'A claim on a file outside sync scope is refused, with the reason',
    criticality: 'critical', tier: 3,
    breaks: 'An agent works for hours on a file nobody else can see, and every tool says fine. (HIV-27, and it happened.)',
    proves: [{ suite: 'tests/claim-scope-test.mjs', assertion: 'hive_claim REFUSES the unshared path' }],
  },
  {
    id: 'conflict-surfaced',
    name: 'An overlapping edit is surfaced as a conflict, not fused',
    criticality: 'critical', tier: 1,
    breaks: 'Two edits to one region merge into code neither agent wrote and nothing reports it.',
    proves: [
      { suite: 'tests/test.js', assertion: 'flags overlapping edit as conflict' },
      { suite: 'tests/test.js', assertion: 'conflict has git-style markers' },
    ],
  },
  {
    id: 'rejoin-no-clobber',
    name: 'Reconnecting merges; it does not push the room\'s stale copy over newer local edits',
    criticality: 'critical', tier: 3,
    breaks: 'Every dropped connection is a silent data-loss event. Observed live before it was fixed.',
    proves: [{ suite: 'tests/rejoin-clobber-test.mjs', assertion: 'REJOIN DID NOT CLOBBER' }],
  },

  // ── control: the half that lets a human leave the room ───────────────────────────────────
  {
    id: 'stop-button',
    name: 'A paused agent\'s write does not land',
    criticality: 'critical', tier: 3,
    breaks: 'The stop button is advice. Nobody can leave a room running unattended.',
    proves: [{ suite: 'tests/hive-governor-test.mjs', assertion: 'THE PAUSED WRITE DID NOT LAND' }],
  },
  {
    id: 'self-unpause',
    name: 'An AI cannot unpause itself',
    criticality: 'critical', tier: 1,
    breaks: 'The stop button is advice with extra steps — the control map sits in the room the agent can write.',
    proves: [{ suite: 'tests/hive-governor-test.mjs', assertion: 'an AI may never touch the control map' }],
  },
  {
    id: 'budget-caps',
    name: 'A spend cap pauses the agent that hits it',
    criticality: 'hot', tier: 1,
    breaks: 'An overnight run can spend without bound.',
    proves: [{ suite: 'tests/hive-governor-test.mjs', assertion: 'the write that hits the cap pauses the agent' }],
  },
  {
    id: 'governor-honest-numbers',
    name: 'The usage dashboard reports the real figures',
    criticality: 'critical', tier: 1,
    breaks: 'The operator decides whether to intervene using a number that is wrong. THIS IS THE HIV-13 DEFECT: 30 minutes displayed as 3.0, shipped green.',
    proves: [{ suite: 'tests/hive-governor-test.mjs', assertion: 'snapshot reports 30 minutes after 30 minutes, not 3' }],
  },

  // ── honesty: every defect on this project has been a false success ───────────────────────
  {
    id: 'join-honesty',
    name: 'A refused join says NOT JOINED and withholds the rules',
    criticality: 'critical', tier: 2,
    breaks: 'An agent believes it is in the room, works for an hour, and nothing it did exists.',
    proves: [{ suite: 'tests/join-honesty-test.mjs', assertion: 'a refused join does NOT claim to have joined' }],
  },
  {
    id: 'say-offline',
    name: 'hive_say refuses the word "sent" when the socket is down',
    criticality: 'hot', tier: 4,
    breaks: 'An agent reports a handoff it never made, in the same words it uses on success. (HIV-30.)',
    proves: [{ suite: 'tests/receipts-e2e-test.mjs', assertion: 'hive_say REFUSES THE WORD "SENT"' }],
  },
  {
    id: 'receipts-unknown',
    name: 'An agent that publishes no read position is UNKNOWN, never counted as delivered',
    criticality: 'hot', tier: 1,
    breaks: 'A receipt system that reassures instead of measuring: every bridge and human reads as confirmed.',
    proves: [
      { suite: 'tests/receipts-test.mjs', assertion: 'AN AGENT THAT PUBLISHES NO CURSOR IS UNKNOWN' },
      { suite: 'tests/receipts-test.mjs', assertion: 'COUNTDELIVERED COUNTS ONLY READ' },
    ],
  },
  {
    id: 'backlog-truncation',
    name: 'A partially read backlog says so, with its Q-code',
    criticality: 'hot', tier: 1,
    breaks: 'The night shift plans against half the tickets and believes it has them all. (HIV-14 / Q443.)',
    proves: [{ suite: 'tests/hive-linear-test.mjs', assertion: 'a page that errors mid-pagination is reported, not swallowed' }],
  },
  {
    id: 'truncation-no-false-alarm',
    name: 'A COMPLETE read is not flagged as truncated',
    criticality: 'standard', tier: 1,
    breaks: 'A warning that fires on healthy runs is a warning nobody reads.',
    proves: [{ suite: 'tests/hive-linear-test.mjs', assertion: 'a complete multi-page read is NOT flagged as truncated' }],
  },

  // ── coordination: the half this week's failures came from ────────────────────────────────
  {
    id: 'obligation-author-only',
    name: 'Only the asker can close a question they asked',
    criticality: 'hot', tier: 1,
    breaks: 'An agent marks its own answer sufficient, and "answered" stops meaning anything. (HIV-29.)',
    proves: [
      { suite: 'tests/obligations-test.mjs', assertion: 'THE DEBTOR CANNOT CLOSE ITS OWN OBLIGATION' },
      { suite: 'tests/obligations-e2e-test.mjs', assertion: 'BUILDER IS REFUSED' },
    ],
  },
  {
    id: 'obligation-absent-target',
    name: 'Addressing an agent that is not in the room is reported at once',
    criticality: 'hot', tier: 4,
    breaks: 'A question hangs unanswered for a whole shift. Happened 19 Sep: one message to @Reviewer, who never existed, then six hours of silence.',
    proves: [{ suite: 'tests/obligations-e2e-test.mjs', assertion: 'NOBODY BY THAT NAME IS HERE' }],
  },
  {
    id: 'doorbell-cannot-kill',
    name: 'An optional notification cannot take the agent down',
    criticality: 'hot', tier: 1,
    breaks: 'A doorbell that fails kills the whole agent from inside a Yjs observer, with the stack pointing at a try/catch that structurally cannot catch it. Crashed two suites two tickets apart, because the first fix repaired one of the two identical sites. See learnings/repair-the-class-not-the-copy.md.',
    proves: [{ suite: 'tests/learnings-test.mjs', assertion: 'EVERY server.notification() is wrapped' }],
  },
  {
    id: 'throttle-change-wins',
    name: 'A changed block is always delivered, whatever the throttle says',
    criticality: 'critical', tier: 1,
    breaks: 'An agent acts on tests=RUNNING while the room has said RED, and nothing reports the message was withheld. (HIV-31.)',
    proves: [
      { suite: 'tests/throttle-test.mjs', assertion: 'A CHANGED BLOCK IS SENT IMMEDIATELY' },
      { suite: 'tests/throttle-e2e-test.mjs', assertion: 'A CHANGE IS DELIVERED AT ONCE' },
    ],
  },

  // ── the relay's own perimeter ────────────────────────────────────────────────────────────
  {
    id: 'room-isolation',
    name: 'One room never sees another room\'s content',
    criticality: 'critical', tier: 3,
    breaks: 'Two customers on one relay read each other\'s source.',
    proves: [{ suite: 'tests/test.js', assertion: 'room Y never sees room X' }],
  },
  {
    id: 'token-forgery',
    name: 'Forged, unsigned and alg-confused tokens are refused',
    criticality: 'critical', tier: 1,
    breaks: 'Anyone who can reach the relay can join any secured room.',
    proves: [
      { suite: 'tests/test.js', assertion: 'alg-confusion (HS256 signed with public key) is rejected' },
      { suite: 'tests/test.js', assertion: 'unsigned token (empty sig) is rejected' },
    ],
  },
  {
    id: 'ratelimit-before-auth',
    name: 'A throttled IP is refused BEFORE the signature is checked',
    criticality: 'hot', tier: 2,
    breaks: 'An unauthenticated flood spends your CPU on signature verification for free.',
    proves: [{ suite: 'tests/hive-mcp-http-test.mjs', assertion: 'BEFORE signature check' }],
  },

  // ── PROMISES WITH NO PROOF. Not placeholders. These are the gap list, and the reason this ──
  // ── file is worth more than the passing half above. ───────────────────────────────────────
  {
    id: 'pr-staleness',
    name: 'hive-pr refuses to overwrite a branch that has moved',
    criticality: 'critical', tier: 3,
    breaks: 'A PR that looks perfect — clean per-agent commits, signed attribution — silently reverts every commit that reached the branch another way. MEASURED 19 Sep: a generated PR deleted the HIV-27 guard, the HIV-14 fix and ~200 lines of tests, and restored the 10x dashboard bug. (HIV-28, closed.)',
    proves: [
      { suite: 'tests/pr-staleness-test.mjs', assertion: 'AND IT IS NOT WRITABLE' },
      { suite: 'tests/pr-staleness-e2e-test.mjs', assertion: 'HIVE-PR REFUSES' },
      { suite: 'tests/pr-staleness-e2e-test.mjs', assertion: 'NO BRANCH WAS CREATED' },
    ],
  },
  {
    id: 'pr-still-works',
    name: 'hive-pr still produces a PR when the branch has not moved',
    criticality: 'critical', tier: 3,
    breaks: 'The staleness guard refuses everything and the tool is dead. This is the assertion that stops the safety check from being the bug — a guard that fires on the healthy path is the one that earns a --force alias and stops being run. It nearly happened: git() trims its output, so reading a blob through it dropped the trailing newline and every file read as diverged.',
    proves: [{ suite: 'tests/pr-staleness-e2e-test.mjs', assertion: 'hive-pr succeeds when the branch is where the room left it' }],
  },
  {
    id: 'extension-bundle-current',
    name: 'The extension\'s generated ICR bundle matches its sources, and behaves like them',
    criticality: 'critical', tier: 1,
    breaks: 'extension/icr.cjs is GENERATED from icr.js + lang-*.js, and the generator\'s own instruction was "re-run this whenever a source changes" — a sentence aimed at a person. MEASURED 19 Sep: the committed bundle was 18,563 bytes behind its sources, 373 insertions of engine work, shipped in marketplace v0.9.3. Users got an older merge engine than the relay and nothing reported it, because a stale bundle loads fine and merges fine. It is just behind.',
    proves: [
      { suite: 'tests/extension-parity-test.mjs', assertion: 'THE SHIPPED BUNDLE IS CURRENT' },
      { suite: 'tests/extension-parity-test.mjs', assertion: 'EVERY case answers identically' },
    ],
  },
  {
    id: 'extension-reconcile-divergence-pinned',
    name: 'Divergence between the two reconcile() copies cannot grow silently',
    criticality: 'critical', tier: 1,
    breaks: 'Merge logic exists TWICE and the copies are NOT equivalent — they share 34 lines; sync.js has 182 code lines to the extension\'s 105. This does not claim they match, because they do not. It claims a NEW divergence fails a test instead of shipping. Without it, a fix landing in sync.js silently leaves the marketplace extension broken — which is how the rejoin-clobber gap below happened.',
    proves: [
      { suite: 'tests/extension-parity-test.mjs', assertion: 'known sync-only capabilities' },
      { suite: 'tests/extension-parity-test.mjs', assertion: 'AND IT ACTUALLY RUNS' },
    ],
  },
  {
    id: 'extension-rejoin-safety',
    name: 'A VS Code user\'s offline edits survive a reconnect',
    criticality: 'critical', tier: 6,
    breaks: 'KNOWN BROKEN TODAY, not merely unproven. The .hive-shadow.json ancestor that makes a rejoin a 3-way merge has ZERO mentions in the extension\'s 109 KB. sync.js has it, covered by 17 assertions; marketplace v0.9.3 does not, so a user who edits offline and reconnects loses that work silently. The characterisation suite PINS it as current behaviour (tests/extension-reconcile-characterisation-test.mjs: "clobbers offline edits on rejoin"). Fixing it means porting the shadow record into the extension and verifying in a real VS Code host, which is why this is tier 6.',
    proves: [],
  },
  {
    id: 'connection-ceiling-reported',
    name: 'Running out of connections is reported, by name, once',
    criticality: 'critical', tier: 3,
    breaks: 'One socket per file against a 512 cap. MEASURED 18 Sep: 38,011 Q430 refusals in one evening while the agents involved showed no symptom at all — y-websocket retries a failed upgrade forever, in silence, which is right for a flaky network and badly wrong for a relay that is full.',
    proves: [
      { suite: 'tests/refused-visible-test.mjs', assertion: 'status reports files whose sockets were refused' },
      { suite: 'tests/refused-visible-test.mjs', assertion: 'the client says so rather than retrying quietly' },
      { suite: 'tests/refused-visible-test.mjs', assertion: 'a healthy relay reports nothing refused' },
    ],
  },
  {
    id: 'connection-ceiling-no-data-loss',
    name: 'A full relay does not cost you your files',
    criticality: 'critical', tier: 3,
    breaks: 'THE 186-FILE INCIDENT. A file-doc whose socket was refused is a Y.Doc that never received an update, so getText() returns "" — indistinguishable from a file the room knows to be empty. The engine then writes that to disk. Everything succeeds, nothing throws, the folder is destroyed. 186 files went to 0 bytes across three folders in one evening.',
    proves: [
      { suite: 'tests/ceiling-no-data-loss-test.mjs', assertion: 'NOT ONE FILE WAS ZEROED' },
      { suite: 'tests/ceiling-no-data-loss-test.mjs', assertion: 'none was altered at all' },
      { suite: 'tests/ceiling-no-data-loss-test.mjs', assertion: 'NOT ONE ARRIVED EMPTY' },
    ],
  },
  {
    id: 'telegram-reach',
    name: 'A message from the phone reaches the room and wakes a waiting agent',
    criticality: 'standard', tier: 5,
    breaks: 'The operator cannot start or stop a shift from outside the house. Proven by hand 19 Sep (round trip ~2s); never automated.',
    proves: [],
  },
  {
    id: 'multi-vendor',
    name: 'Agents from different vendors coordinate in one room',
    criticality: 'hot', tier: 6,
    breaks: 'The central claim of the product — "any agent, any vendor" — is unproven. STRUCTURALLY unautomatable here: it needs another vendor\'s agent running. Demonstrated by hand with Antigravity; that is the only evidence there is, and it should be described that way.',
    proves: [],
  },

  // ── branch rooms (hive-branch.js): a room bound to a git branch ──────────────────────────
  {
    id: 'personal-room',
    name: 'An agent can host a room only the people it invites can enter',
    criticality: 'critical', tier: 2,
    breaks: 'Every room an agent hosts is open: on the public relay its name is the only key, so whoever learns or guesses it reads every file and chat line in it. That happened to our own room "night" on 8 Oct 2026.',
    proves: [
      { suite: 'tests/personal-room-test.mjs', assertion: 'private:true hosts a personal room: an hs_ id whose fingerprint is the host\'s own key' },
      { suite: 'tests/personal-room-test.mjs', assertion: 'the room\'s key sits outside the room folder, and no file in the room folder holds it' },
      { suite: 'tests/personal-room-test.mjs', assertion: 'a stranger with the room\'s link alone is refused, and receives none of its files' },
      { suite: 'tests/personal-room-test.mjs', assertion: 'invite makes a link for one person: their name, signed by the room\'s key, never the host\'s token' },
      { suite: 'tests/personal-room-test.mjs', assertion: 'a reader invite sees the files, and its edit does not reach the host' },
      { suite: 'tests/personal-room-test.mjs', assertion: 'a --paths invite sees only those folders' },
      { suite: 'tests/personal-room-test.mjs', assertion: 'revoke closes the guest\'s live connection, refuses it from then on, and its edits stop arriving' },
      { suite: 'tests/personal-room-test.mjs', assertion: 'a host whose own token has run out rejoins: renewed from the key, not refused' },
    ],
  },
  {
    id: 'shared-launch-folder',
    name: 'Two agents started from one folder each stay themselves',
    criticality: 'critical', tier: 2,
    breaks: 'Two Claude Code sessions in one repo, the natural way to run a branch room, shared one session record: the Stop hook steered one agent as the other (its mail, a listener under its name), a restart brought it back as the other, one leaving took both off the record, and the record sat in the developer\'s git status. Found walking the founder flow end to end on 9 Oct 2026.',
    proves: [
      { suite: 'tests/shared-launch-folder-test.mjs', assertion: 'both agents are on record, each with its own folder' },
      { suite: 'tests/shared-launch-folder-test.mjs', assertion: 'by conversation id: Bob\'s hook holds Bob\'s mail, not Alice\'s' },
      { suite: 'tests/shared-launch-folder-test.mjs', assertion: 'by transcript: Alice\'s hook holds Alice\'s mail, not Bob\'s' },
      { suite: 'tests/shared-launch-folder-test.mjs', assertion: 'a hook that cannot tell which agent it guards speaks for neither' },
      { suite: 'tests/shared-launch-folder-test.mjs', assertion: 'the restarted server comes back as Bob, not as Alice' },
      { suite: 'tests/shared-launch-folder-test.mjs', assertion: 'Alice leaving keeps Bob on record, and only Bob' },
      { suite: 'tests/shared-launch-folder-test.mjs', assertion: 'neither of our files shows in the developer\'s git status' },
      { suite: 'tests/shared-launch-folder-test.mjs', assertion: 'the Stop hook\'s own file never syncs into a room' },
    ],
  },
  {
    id: 'branch-room-random-id',
    name: 'A branch room\'s id is random, never the branch name',
    criticality: 'critical', tier: 2,
    breaks: 'Every repo\'s feature/login lands in the same room, and on an open relay anyone who guesses a branch name reads the code in it.',
    proves: [
      { suite: 'tests/branch-test.mjs', assertion: 'the room id is random, never the branch name' },
      { suite: 'tests/branch-test.mjs', assertion: 'the same branch name in another repo gets a different room' },
    ],
  },
  {
    id: 'branch-room-not-a-checkout',
    name: 'No git command can rewrite a branch room\'s files',
    criticality: 'critical', tier: 4,
    breaks: 'An agent runs git stash -u or git clean in its folder and every teammate\'s copy of those files is deleted with it. Measured: an EMPTY .git directory does not stop this -- git walks past it to the enclosing repo and stashes the room away.',
    proves: [
      { suite: 'tests/branch-test.mjs', assertion: 'git refuses inside an agent folder, although it sits inside another repo' },
      { suite: 'tests/branch-test.mjs', assertion: 'stash -u, clean -fdx and checkout run inside an agent folder all refuse' },
      { suite: 'tests/branch-test.mjs', assertion: 'changed nothing in the room' },
    ],
  },
  {
    id: 'branch-room-seed',
    name: 'A branch room starts as the whole branch, and the checkout is not touched',
    criticality: 'critical', tier: 4,
    breaks: 'Agents build on a partial tree -- or the developer\'s checkout is switched under them by the command that was supposed to leave it alone.',
    proves: [
      { suite: 'tests/branch-test.mjs', assertion: 'the checkout was not switched and nothing in it changed' },
      { suite: 'tests/branch-test.mjs', assertion: 'every text file of the branch arrived byte-exact' },
      { suite: 'tests/branch-test.mjs', assertion: 'binary, over-1MB, always-ignored and key-holding files were filled from git' },
      { suite: 'tests/branch-test.mjs', assertion: 'deleted in the room, is not recreated by a later joiner' },
    ],
  },
  {
    id: 'branch-room-landing',
    name: 'pr lands the room on its branch, one commit per agent, and never over unseen changes',
    criticality: 'critical', tier: 4,
    breaks: 'A PR that looks complete and is not: agents\' deletions left behind, files still in flight left out, or a teammate\'s commit to the branch silently written over.',
    proves: [
      { suite: 'tests/branch-test.mjs', assertion: 'pr lands one commit per agent, plus the room' },
      { suite: 'tests/branch-test.mjs', assertion: 'checkout was never touched' },
      { suite: 'tests/branch-test.mjs', assertion: 'is not written over (Q506)' },
      { suite: 'tests/branch-test.mjs', assertion: 'is refused (Q572)' },
      { suite: 'tests/branch-test.mjs', assertion: 'refused (Q571) when that worktree has uncommitted changes' },
    ],
  },
  {
    id: 'room-rules-true',
    name: 'The rules every room is given ask only for what an agent can do',
    criticality: 'hot', tier: 1,
    breaks: 'A stranger\'s agent is told, as its first instruction, to run a script that was never shipped, or to call a tool it does not have, and the copy of the rules a person reads on npm is not the one agents follow.',
    proves: [
      { suite: 'tests/rules-promises-test.mjs', assertion: 'the shipped HIVE_RULES.md is exactly what every room is given' },
      { suite: 'tests/rules-promises-test.mjs', assertion: 'every script the rules ask an agent to run is in the package' },
      { suite: 'tests/rules-promises-test.mjs', assertion: 'the rules name no tool from outside Hivecode' },
    ],
  },
  // ── GitHub: label an issue, get back a pull request (hive-github.js, docs/GITHUB_WORKFLOW.md) ──
  {
    id: 'github-issue-to-pr',
    name: 'A labelled GitHub issue comes back as a pull request, and CI and reviews go back to the agent',
    criticality: 'critical', tier: 4,
    breaks: 'The one workflow a founder buys: they label an issue at night and in the morning there is no PR, or a PR whose description, author or files are not what the agent did, or a CI failure nobody told the agent about.',
    proves: [
      { suite: 'tests/github-watcher-test.mjs', assertion: 'a pull request is opened for the issue' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'its body closes the issue and carries the agent\'s summary' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'the agent is the commit\'s git author' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'a fix was pushed to the same pull request' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'the task had the failing check\'s log, without timestamps' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'one run for the whole review' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'the answer started the next run, and it is in the pull request' },
    ],
  },
  {
    id: 'github-trust',
    name: 'Only people who can push hand work to the agent',
    criticality: 'critical', tier: 4,
    breaks: 'A stranger labels an issue or leaves a review comment on a public repo, and an agent running with the owner\'s permissions does what the stranger wrote.',
    proves: [
      { suite: 'tests/github-watcher-test.mjs', assertion: 'labelled by someone with read access: skipped' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'a stranger\'s review comment never reaches the agent or the branch' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'not "thanks!", not the approval' },
    ],
  },
  {
    id: 'github-no-false-decisions',
    name: 'A failed read, a sleeping laptop or a lost state file is never taken for a decision',
    criticality: 'critical', tier: 4,
    breaks: 'GitHub hiccups and the watcher reads it as "label removed" and kills the night\'s work; or the laptop sleeps and a run is killed for time it never had; or a lost file brings a second PR for the same issue.',
    proves: [
      { suite: 'tests/github-watcher-test.mjs', assertion: 'the list failing (network) changed no issue' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'a 502 reading the issue does not stop it' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'not killed for the time the machine was asleep' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'merged: done, not "stopped"' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'no second pull request, no second claim, no run' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'rate-limited: it waits for the reset and asks nothing' },
    ],
  },
  {
    id: 'github-caps',
    name: 'Runs stop when they stop making progress, and a person is told why',
    criticality: 'critical', tier: 4,
    breaks: 'A flaky test or a logged-out agent turns into a loop that spends the owner\'s tokens all night and produces nothing.',
    proves: [
      { suite: 'tests/github-watcher-test.mjs', assertion: 'the same check failing twice in a row goes to a person' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'the second failure in a row goes to a person' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'past --max-minutes, the run is killed and goes to a person' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'over the daily limit nothing starts' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'said as "never joined", not "no changes"' },
    ],
  },
  {
    id: 'github-push-guards',
    name: 'What leaves the machine is checked first',
    criticality: 'critical', tier: 4,
    breaks: 'An agent misled by an issue adds a workflow that leaks the repo\'s secrets the moment CI runs; or the agent\'s last edit is silently missing from a PR that looks complete; or "tests pass" is only the agent\'s word.',
    proves: [
      { suite: 'tests/github-watcher-test.mjs', assertion: 'it goes to a person, saying why' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'nothing was pushed' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'its last edit still reached the pull request' },
      { suite: 'tests/github-watcher-test.mjs', assertion: 'the pull request says Hivecode ran the tests and they passed' },
    ],
  },
  {
    id: 'github-cli',
    name: 'github start refuses with the problem and its fix, before writing anything',
    criticality: 'hot', tier: 1,
    breaks: 'A stranger\'s first run fails with a stack trace or a silent nothing, and they never come back.',
    proves: [
      { suite: 'tests/github-cli-test.mjs', assertion: 'gh missing: says where to get it' },
      { suite: 'tests/github-cli-test.mjs', assertion: 'gh logged out: says gh auth login' },
      { suite: 'tests/github-cli-test.mjs', assertion: 'none of those left a state file behind' },
      { suite: 'tests/github-cli-test.mjs', assertion: 'a second watcher on the same clone is refused, naming the first' },
      { suite: 'tests/github-cli-test.mjs', assertion: 'refused on the public relay, with both ways out' },
    ],
  },
  {
    id: 'git-file-never-synced',
    name: 'A .git FILE is never published to a room',
    criticality: 'critical', tier: 3,
    breaks: 'In a worktree or submodule, `.git` is a file naming this machine\'s git directory. MEASURED before the fix: an edit to one participant\'s sub/.git was published, and a peer\'s own sub/.git -- its submodule pointer -- was overwritten with conflict markers and then deleted.',
    proves: [
      { suite: 'tests/branch-test.mjs', assertion: 'a .git FILE never enters the room, not even briefly' },
      { suite: 'tests/branch-test.mjs', assertion: 'own .git file (a submodule pointer) is left exactly as it was' },
    ],
  },
  {
    id: 'branch-room-not-home',
    name: 'A home directory kept under git is never taken for the project',
    criticality: 'hot', tier: 1,
    breaks: 'Run in a folder that is not its own repository, the command finds the enclosing one -- a home directory under git, on the development machine -- and publishes its committed files to a room. Through a link (every macOS temp folder sits behind one) the home was not recognised and its files were published (6 Oct 2026, the first macOS run).',
    proves: [
      { suite: 'tests/branch-test.mjs', assertion: 'a folder inside a home-directory repo is refused' },
      { suite: 'tests/branch-test.mjs', assertion: 'also when the home directory is reached through a link' },
      { suite: 'tests/setup-test.mjs', assertion: 'F7 a folder whose repo is the HOME folder gets no branch line' },
      { suite: 'tests/setup-test.mjs', assertion: 'also when the home folder is reached through a link' },
    ],
  },
  {
    id: 'claude-code-listen-line',
    name: 'A Claude Code or Antigravity agent is told, once, how to stay reachable after its turn ends',
    criticality: 'hot', tier: 1,
    breaks: 'The agent ends its turn and goes deaf: everyone who addresses it waits on a reply that never comes, and nothing tells them it stopped (the 4-agent KCDE run\'s first complaint).',
    proves: [
      { suite: 'tests/mcp-wait-test.mjs', assertion: 'Claude Code\'s first empty wait orders it to start the listener in the background' },
      { suite: 'tests/mcp-wait-test.mjs', assertion: 'Antigravity\'s first empty wait orders it to start the listener, in its own tool\'s words' },
      { suite: 'tests/mcp-wait-test.mjs', assertion: 'an app nobody has measured (Cursor) is not told to start a listener' },
    ],
  },
  {
    id: 'setup-brings-the-repo-in',
    name: 'Setup run inside a project points at the command that brings its code into a room',
    criticality: 'hot', tier: 1,
    breaks: 'A team runs setup in its project, is told to host a room, and gets an empty one: its code is not there and nothing says how to bring it in.',
    proves: [{ suite: 'tests/setup-test.mjs', assertion: 'inside a repo, NEXT gives the command that brings the repo in, before the lines to paste' }],
  },
  {
    id: 'host-invite-to-forward',
    name: 'The host is handed an invite a person can forward as is',
    criticality: 'hot', tier: 1,
    breaks: 'The host assembles the install command, the reload step, the sentence and the link by hand, for every teammate.',
    proves: [{ suite: 'tests/hive-mcp-test.js', assertion: 'a host is handed an invite to forward: setup with the quoted link, and the browser link' }],
  },
  {
    id: 'first-contact-one-message',
    name: 'A teammate who joins with their own checkout is reported once, in plain words',
    criticality: 'hot', tier: 1,
    breaks: 'Every differing file gets its own chat line in engine words, and a Windows checkout (CRLF against the room\'s LF) makes nearly every file differ.',
    proves: [
      { suite: 'tests/first-contact-summary-test.mjs', assertion: 'ONE message tells the room about B\'s first contact, not one per file' },
      { suite: 'tests/first-contact-summary-test.mjs', assertion: 'C posts no chat line about them' },
    ],
  },
  {
    id: 'lost-folder-is-not-a-delete',
    name: 'A room folder that vanishes, or is emptied at once, deletes nothing for anyone',
    criticality: 'critical', tier: 1,
    breaks: 'One person deletes or moves their room folder and every teammate\'s copy of every file is deleted (measured 3 Oct 2026: 12 of 12), or the agent\'s server crashes on the watcher error.',
    proves: [
      { suite: 'tests/delete-safety-test.mjs', assertion: 'A1 the process survives its room folder being deleted' },
      { suite: 'tests/delete-safety-test.mjs', assertion: 'A2 Bob keeps every file: a vanished folder is not 12 deletes' },
      { suite: 'tests/delete-safety-test.mjs', assertion: 'B1 Bob keeps all 8: an emptied folder is not 8 deliberate deletes' },
    ],
  },
  {
    id: 'deletes-keep-a-copy',
    name: 'A file a teammate deletes is moved into .hive-deleted/ on your machine, not destroyed',
    criticality: 'critical', tier: 1,
    breaks: 'One agent\'s rm -rf in the wrong folder takes the files out of every teammate\'s folder with nothing kept (measured 3 Oct 2026: 30 files, 0 copies).',
    proves: [
      { suite: 'tests/delete-safety-test.mjs', assertion: 'C2 Bob keeps a byte-identical copy of each of the 30 in .hive-deleted/' },
      { suite: 'tests/delete-safety-test.mjs', assertion: 'C1 a deliberate bulk delete still reaches Bob' },
      { suite: 'tests/delete-safety-test.mjs', assertion: 'E1 Bob never lost e.js while Alice\'s editor deleted and rewrote it' },
    ],
  },
  {
    id: 'one-name-one-participant',
    name: 'A second participant cannot join under a name already in the room',
    criticality: 'critical', tier: 1,
    breaks: 'Two agents under one name are one identity: both are told they hold the same claims, read each other\'s mail, and one\'s writes land on the other\'s files (measured 3 Oct 2026; two agents named Hermes once fused a file to 32,038 lines).',
    proves: [
      { suite: 'tests/duplicate-name-test.mjs', assertion: 'D1 a second agent named Claude is NOT joined, and is told why (Q581)' },
      { suite: 'tests/duplicate-name-test.mjs', assertion: 'P1 an agent joining as Ganesh, while the person Ganesh is here, is refused (Q581)' },
      { suite: 'tests/duplicate-name-test.mjs', assertion: 'R1 Rex rejoining from its own folder is NOT refused' },
    ],
  },
  {
    id: 'credentials-stay-home',
    name: 'A key or token inside a file is held on that machine, not sent to the room or the relay',
    criticality: 'critical', tier: 3,
    breaks: 'A file whose content held an API key went to the relay and to every participant\'s disk like any other, and hive_edit told the agent that pasted it that the change was "syncing to every peer" (measured 3 Oct 2026). .env was kept at home by name; a key pasted into config.js was not.',
    proves: [
      { suite: 'tests/secret-gate-test.mjs', assertion: 'S1 a new file holding a key is not shared: Alice never gets it, and the room never has the key' },
      { suite: 'tests/secret-gate-test.mjs', assertion: 'S2b ...and nothing Bob\'s client lists or says contains the key' },
      { suite: 'tests/secret-gate-test.mjs', assertion: 'S6c neither key reached the room at any moment' },
      { suite: 'tests/secret-gate-test.mjs', assertion: 'S6 once the key is read from the environment, Bob\'s change flows and both edits are kept' },
      { suite: 'tests/secret-gate-test.mjs', assertion: 'S8 placeholders and documentation examples are shared like any other file' },
      { suite: 'tests/secret-gate-test.mjs', assertion: 'M1 hive_edit says the file was NOT shared, and why' },
      { suite: 'tests/secret-gate-test.mjs', assertion: 'M4 hive_say refuses a message holding a key, and the room never gets it' },
      { suite: 'tests/secret-gate-test.mjs', assertion: 'M6 a message that only says where a key is kept is sent as usual' },
    ],
  },
  {
    id: 'invite-carries-no-token',
    name: 'In a room that checks tokens, the invite a host passes on never carries the host\'s own token',
    criticality: 'critical', tier: 3,
    breaks: 'hive_join printed the invite link and the browser link WITH the host\'s maintainer token in them, as the thing to hand to others, and hive_say posted a token to the whole room (measured 3 Oct 2026). An outside agent given that link joined as the host, with every path and every role, and revoking the token locked the host out too.',
    proves: [
      { suite: 'tests/secured-invite-test.mjs', assertion: 'I1 the invite link it prints carries no token' },
      { suite: 'tests/secured-invite-test.mjs', assertion: 'I2 nothing meant for someone else carries the host\'s token; a line that does is marked as the host\'s own' },
      { suite: 'tests/secured-invite-test.mjs', assertion: 'I3 it says each person needs a token of their own, and how to mint one' },
      { suite: 'tests/secured-invite-test.mjs', assertion: 'I4 hive_say refuses a message carrying a token, and the room never gets it' },
      { suite: 'tests/secured-invite-test.mjs', assertion: 'I5 a message without one still goes' },
    ],
  },
  {
    id: 'case-only-names-on-windows-and-mac',
    name: 'Room files that differ only by case never overwrite each other on a Windows or Mac disk, and a case-only rename stays a rename',
    criticality: 'critical', tier: 3,
    breaks: 'On a case-insensitive disk Case.js and case.js are one file: an edit to one was written over the other and pushed back into the room, overwriting a teammate\'s file for everyone. Renaming Readme.md to README.md left both names in the room, so every Linux teammate got two files (both measured 3 Oct 2026).',
    proves: [
      { suite: 'tests/case-collision-test.mjs', assertion: '2 Case.js room content is intact (not corrupted by case.js edit)' },
      { suite: 'tests/case-collision-test.mjs', assertion: '7 Bob edit did NOT leak to case.js in room' },
      { suite: 'tests/case-rename-test.mjs', assertion: '1 Room keys after rename 1 are exactly [README.md]' },
      { suite: 'tests/case-rename-test.mjs', assertion: '9 Junction: room has [a.js, b.js, c.js] and Bob receives all 3' },
      { suite: 'tests/case-rename-test.mjs', assertion: '14 Junction: room manifest has a.js after round-trip rename' },
      { suite: 'tests/collided-notice-test.mjs', assertion: 'C1 hive_wait tells Cara which room file is not in its folder, and which of its own it is not' },
    ],
  },
  {
    id: 'guessable-room-called-out',
    name: 'Joining a room whose name can be guessed, on the public relay, says so',
    criticality: 'hot', tier: 1,
    breaks: 'On a relay anyone can reach, a room\'s name is its only key. A typed name like "night" (this project\'s own room on 3 Oct 2026) lets whoever guesses it read every file and write into every folder, and nothing told the people in it.',
    proves: [
      { suite: 'tests/guessable-room-test.mjs', assertion: 'G1 names people type are guessable' },
      { suite: 'tests/guessable-room-test.mjs', assertion: 'G2 a hosted room\'s id is not (under 0.05% of 20,000 random ids flagged)' },
      { suite: 'tests/guessable-room-test.mjs', assertion: 'G4 on the public relay, the warning names a guessable room and says so' },
      { suite: 'tests/guessable-room-test.mjs', assertion: 'G6 hive_join and hive_status both pass the room to the check' },
    ],
  },
  {
    id: 'package-ships-what-it-loads',
    name: 'The published client contains every module it loads',
    criticality: 'critical', tier: 1,
    breaks: 'package.json lists the client\'s files by hand. A module added to sync.js but not to that list passes every test here, where the file exists, and kills every install with ERR_MODULE_NOT_FOUND before the agent can say anything.',
    proves: [
      { suite: 'tests/package-closure-test.mjs', assertion: 'P1 every module the client loads is in package.json files, or loaded only inside a try' },
      { suite: 'tests/package-closure-test.mjs', assertion: 'P3 it sees the one optional load known to exist (grm-link.cjs, inside a try, not shipped)' },
    ],
  },
  {
    id: 'unwritable-file-said-and-retried',
    name: 'A room change that cannot be written to someone\'s disk is said, retried, and never turned into a revert',
    criticality: 'critical', tier: 3,
    breaks: 'A read-only or locked file (a Perforce checkout, a generated file, a handle another program holds) stayed at the old version on that disk while the room moved on: status read all green, nothing tried again, and the agent working from the stale copy was never told. A first fix that retried it reverted the teammate\'s change for everyone (measured 3 Oct 2026).',
    proves: [
      { suite: 'tests/unwritable-file-test.mjs', assertion: 'U1 Alice\'s change stands: the room and Alice keep it while Bob cannot write it' },
      { suite: 'tests/unwritable-file-test.mjs', assertion: 'U2b the room is told once that Bob\'s copy is behind' },
      { suite: 'tests/unwritable-file-test.mjs', assertion: 'U5b ...and so does the room: neither edit was dropped or reverted' },
      { suite: 'tests/unwritable-file-test.mjs', assertion: 'U6 it catches up on its own: nothing waits for an edit to notice it is behind' },
      { suite: 'tests/unwritable-file-test.mjs', assertion: 'M1 hive_wait tells Cara its m.js is older than the room\'s' },
    ],
  },
  {
    id: 'mail-handed-over-once',
    name: 'A message the listener woke the agent for is not raised again as unread mail',
    criticality: 'hot', tier: 1,
    breaks: 'The next tool reply says "URGENT MAIL ... Handle before continuing" about mail the agent already acted on (19 in one session, 3 Oct 2026), and an agent that obeys redoes old work.',
    proves: [
      { suite: 'tests/listener-mail-once-test.mjs', assertion: 'M1 the next tool reply does not announce the delivered message as unread mail' },
      { suite: 'tests/listener-mail-once-test.mjs', assertion: 'R1 it does not wake the agent again for job-two' },
      { suite: 'tests/listener-mail-once-test.mjs', assertion: 'N1 a new mention IS handed over by hive_check' },
    ],
  },
  {
    id: 'no-token-says-so',
    name: 'An agent that joins a token room without a token is told it needs one',
    criticality: 'standard', tier: 2,
    breaks: 'The agent is told its token may have expired when it never had one, and asks for a "new" invite that would not help.',
    proves: [{ suite: 'tests/join-honesty-test.mjs', assertion: 'join with no token says "this room needs a token"' }],
  },
  {
    id: 'orphan-listener-leaves',
    name: 'A listener whose agent app has closed leaves the room',
    criticality: 'hot', tier: 1,
    breaks: 'The app closes, its background listener lives on, and the room keeps showing the agent as listening and reachable while nobody can wake it.',
    proves: [{ suite: 'tests/hive-await-test.mjs', assertion: 'when its parent dies, the listener exits within 10 s' }],
  },
  {
    id: 'agent-stays-reachable',
    name: 'An agent in a room does not end its turn deaf: a listener is running, or it is handed the command to start one',
    criticality: 'critical', tier: 1,
    breaks: 'Agents joined, answered once, and went deaf (Ganesh, 4 Oct 2026). The command to listen was said once, on the first quiet hive_wait, and an agent had to remember it after every wake. Agents forget, and a forgotten listener is invisible: the room still shows the agent as present while nothing can wake it.',
    proves: [
      { suite: 'tests/stop-hook-test.mjs', assertion: 'H1 no listener: blocked, with the command for THIS agent and room' },
      { suite: 'tests/stop-hook-test.mjs', assertion: 'H4 a listener running in ANOTHER session does not count' },
      { suite: 'tests/stop-hook-test.mjs', assertion: 'H5 a listener whose process has gone does not count' },
      { suite: 'tests/stop-hook-test.mjs', assertion: 'L4 mail AND no listener: ONE block that carries both, since a second block is never given' },
      { suite: 'tests/stop-hook-test.mjs', assertion: 'L5 an agent that never starts one is let go after 3 turns' },
      { suite: 'tests/hive-await-test.mjs', assertion: 'A4 a wake carries the exact command to listen again, on the wake itself' },
      { suite: 'tests/hive-await-test.mjs', assertion: 'A5 once it has exited, the agent is no longer armed' },
      { suite: 'tests/hive-await-test.mjs', assertion: 'N1 the older listener leaves, saying why' },
      { suite: 'tests/hive-await-test.mjs', assertion: 'R2 the newer one stays, and is the one the mention wakes' },
      { suite: 'tests/setup-test.mjs', assertion: 'G1 setup adds the Hivecode stop gate to ~/.claude/settings.json' },
      { suite: 'tests/setup-test.mjs', assertion: 'G2 ...and leaves the Stop hook already there, and the rest of the file, as they were' },
    ],
  },
  {
    id: 'approval-wakes-the-agent',
    name: 'An owner approving a task wakes the agent it is for',
    criticality: 'hot', tier: 1,
    breaks: 'The approval named nobody, and an agent waiting between turns is woken only by its own name, so it slept through being cleared to work (4 Oct 2026; the old code fails all three checks).',
    proves: [
      { suite: 'tests/task-authority-test.mjs', assertion: 'the approval wakes the agent\'s listener: it names the agent' },
      { suite: 'tests/task-authority-test.mjs', assertion: 'the panel\'s approval names the agent, so its listener wakes it' },
      { suite: 'tests/task-authority-test.mjs', assertion: '...and so does the VS Code extension\'s' },
    ],
  },
  {
    id: 'listener-leaves-no-files-in-project',
    name: 'With TEMP and TMPDIR unset (most Linux), the listener keeps its files in the system temp folder',
    criticality: 'standard', tier: 2,
    breaks: 'The listener fell back to the folder it was started in, so its cursor folder landed in the agent\'s project, where a room folder would share it with everyone, and a Stop hook started elsewhere could not find it.',
    proves: [
      { suite: 'tests/hive-await-test.mjs', assertion: 'L2 the listener wrote nothing into the folder it was started in' },
      { suite: 'tests/hive-await-test.mjs', assertion: 'L3 ...it wrote them under the system temp folder, which here is this test\'s own' },
    ],
  },
  {
    id: 'resume-keeps-who-you-joined-as',
    name: 'After an MCP restart a participant comes back as what it joined as, and a passive one is never held open for a listener',
    criticality: 'standard', tier: 2,
    breaks: 'The MCP host restarts and hive-mcp rejoins from its session file, which held no kind and no passive flag: a human came back as an AI, a passive bot came back as a participant the room waits on, and the Stop hook and hive_wait ordered that bot to keep a listener running for messages it is never sent.',
    proves: [
      { suite: 'tests/session-resume-test.mjs', assertion: 'R3 it comes back passive' },
      { suite: 'tests/session-resume-test.mjs', assertion: 'R4 it comes back human, not as an AI' },
      { suite: 'tests/stop-hook-test.mjs', assertion: 'H14 a passive participant with no listener is let through, in both apps' },
      { suite: 'tests/mcp-wait-test.mjs', assertion: 'a passive participant is not ordered to start a listener' },
    ],
  },
  {
    id: 'merge-keeps-every-comment',
    name: 'A merge never ships without a comment one side wrote',
    criticality: 'hot', tier: 1,
    breaks: 'Two people edit one file; the merge reports a clean structural merge, and the comment one of them wrote above a function (or after a def, or at the end of the file) is gone. Nobody is told.',
    proves: [
      { suite: 'tests/icr-gap-comments-test.mjs', assertion: 'nothing one side added is lost' },
      { suite: 'tests/icr-comment-fuzz-test.mjs', assertion: 'no comment either side added was lost' },
    ],
  },
]

/** Group by criticality for reporting; order is the order in CRITICALITY. */
export function byCriticality(features = FEATURES) {
  const out = {}
  for (const c of CRITICALITY) out[c] = features.filter((f) => f.criticality === c)
  return out
}

/** Every distinct suite this manifest depends on. The checker runs each exactly once. */
export function suites(features = FEATURES) {
  return [...new Set(features.flatMap((f) => f.proves.map((p) => p.suite)))].sort()
}

/**
 * The gap list, and the reason to keep this file.
 *
 * Tier 6 is separated from the rest because the distinction is real and collapsing it is a lie:
 * `multi-vendor` is not unproven through neglect, it is unprovable in this repo without another
 * vendor's agent running. A coverage number that quietly counts it as a failure would push someone
 * to write a fake test for it; one that quietly counts it as a pass is worse.
 */
export function unproven(features = FEATURES) {
  const none = features.filter((f) => !f.proves.length)
  return {
    automatable: none.filter((f) => f.tier < 6),
    manualOnly: none.filter((f) => f.tier === 6),
  }
}
