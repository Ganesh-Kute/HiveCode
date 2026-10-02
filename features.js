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
      { suite: 'tests/branch-test.mjs', assertion: 'binary, over-1MB and always-ignored files were filled from git' },
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
    breaks: 'Run in a folder that is not its own repository, the command finds the enclosing one -- a home directory under git, on the development machine -- and publishes its committed files to a room.',
    proves: [{ suite: 'tests/branch-test.mjs', assertion: 'a folder inside a home-directory repo is refused' }],
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
