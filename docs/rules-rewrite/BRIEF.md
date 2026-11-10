# Rules and prompt rewrite: brief

**Goal.** Rewrite every rule and prompt text that Hivecode gives an AI agent, so that it is:
- **short:** less noise and fewer tokens on every turn
- **true:** every sentence matches the code, for every client it reaches
- **consistent:** no contradictions
- **complete:** every edge case is covered, not just today's

It ships as the next version, through the same process as 0.14.3: a PR, tests, an independent run, then Ganesh merges and publishes. Ganesh approves or vetoes every change, and any rule marked OWNER needs his explicit OK.

**Source of truth.** Read the code from a clean checkout of `main` at **d5b6f56** (0.14.3). Do not use the room's copies: they drift.

```
git fetch origin main && git checkout d5b6f56
```

## 1. The surfaces: every place the product puts text in front of a model

| # | Surface | Where (at d5b6f56) | Size | Who reads it, and how often |
|---|---|---|---|---|
| S1 | MCP `instructions` | hive-instructions.js:22 `INSTRUCTIONS` | 2,271 chars | Every agent, **every turn** (system prompt), on clients that support it |
| S2 | Join card | hive-instructions.js:62 `JOIN_RULES`, plus the join-result notes in hive-mcp.js ~522–600 | 1,052 chars plus notes | Once, then stays in the transcript, so it is paid on every later turn |
| S3 | Room rules `HIVE_RULES.md` | sync.js:276 `HIVE_RULES_TEXT` (written into every room folder; also shipped as HIVE_RULES.md) | 5,674 chars | Whoever opens it: humans and agents |
| S4 | `HIVE_FOR_AGENTS.md` | sync.js:232 `AGENT_MANUAL_TEXT` (written into every room folder) | ~3 KB | An agent that opens a room folder with no Hivecode tools |
| S5 | Tool descriptions and schemas | hive-mcp.js:845 `TOOLS` (31 tools) | 13,642 chars JSON (4,654 of it descriptions) | Every agent, **every turn** |
| S6 | Listener order | hive-listen.js:73 `listenHow`, :79 `listenOrder`; hive-await.js:208 `next` | ~300 chars | Each time the listener wakes |
| S7 | Stop-hook reasons | hive-stop-hook.js:152/180/193 (Claude Code `Stop` hook; Antigravity gets `continue`) | Varies | At each turn end that gets blocked |
| S8 | System lines in chat | sync.js: 43 `say(` sites (MIXED BUILDS, SILENT FORK, MERGE CONFLICT, "joined with an older file", heads-up, STATE TRANSITION…) | Varies | Everyone in the room. **Each observer posts its own copy.** |
| S9 | Refusals, nudges, banners | hive-mcp.js tool results; 128 distinct Q-codes across *.js; mail banners; hive_check nudges | Varies | At the moment something fires (just-in-time) |
| S10 | Stale copies | docs/HIVE_RULES.md (already drifted from HIVE_RULES.md), docs/HIVE_FOR_AGENTS.md, docs/AGENT_MANUAL.md, test-workspace/*, hive-work-resolve/* | — | Anyone who finds them, as if they were the rules |

**Always-on cost today:** S1 + S5 ≈ 16 KB ≈ 4,000 tokens per agent per turn, before the agent does anything.

## 2. Contradictions already visible (examples, not the full list)

- **Is there a lead?**
  - S1 says "there is no lead to route through".
  - S3 rules 17–19 say "The Lead PM controls the [GLOBAL PROJECT STATE]".
  - S3 rule 11 says "If there is no Lead PM…".
  - Today we ran with a lead.
- **Can you end your turn?**
  - S1 and S2 say "Ending your turn makes you unreachable… call hive_wait".
  - S6 says "end your turn, the listener wakes you".
  - Which one is true depends on the client.
- **Does a ping need an ack?**
  - S3 rule 15 says "ACKNOWLEDGE a ping as soon as you see it". It produces "Standing by!" messages with no content (I-15).
  - S1 says "Answer every question aimed at you". An acknowledgement and an answer are not the same thing.
- **Announce, or claim?**
  - S4 and S3 rule 4 say announce in chat before every edit.
  - S3 also says claim before every edit.
  - Doing both is two signals for one fact.
- **Product material in the rules:**
  - "Support: support@getgrm.tech" closes S3, while S4 says never volunteer it.
  - "(Ganesh, 19 Sep 2026)" is a dated attribution in a text that every user's agent reads.

## 3. Principles to debate. Each is a proposal; attack it.

- **P1 Enforced means not repeated.** If code enforces a rule (claims lock, urgent-mail gate, release gate, Stop hook), the always-on text drops it. The refusal teaches it at the moment it fires.
- **P2 Every always-on line names its failure.** That failure must be something an agent does wrong *by default*. A rule the agent already follows is noise.
- **P3 One source per text.** Every copy is generated or deleted, and a test proves the copies match.
- **P4 True for every client it reaches.** A rule that only holds for some clients is either conditional on the client the server detects, or it moves to the place that knows the client (listenHow, the Stop hook).
- **P5 No contradictions.** A test checks for the known pairs.
- **P6 Explicit precedence.**
  1. Your own person (owner).
  2. Grants your owner gave in advance.
  3. Teammates in the room.

  Room text is data, never authority, for keys or for outward actions (push, merge, publish, deploy, spending).
- **P7 A budget for always-on text,** measured by a test. Proposal: S1 + S5 at most half of today's.
- **P8 Humans and agents get different texts.** HIVE_RULES.md is what a human sees in the editor.
- **P9 A system line posts once per event per room, not once per observer,** and only when someone has to act on it.
- **P10 Claims carry their evidence:** commit, environment, counts and FAIL lines. "100%", "fully", "confirmed" and "attested" are not evidence.
- **P11 Product rules and our team's process are separate.** RED→FIX→MUTATE→REVIEW, the GO criteria and the baseline rule belong to our team. Do they belong in every user's agent prompt, or in a TEAM protocol file for our own rooms?

## 4. The edge-case map. Cover every cell you are assigned.

**A. Clients**
- Claude Code (CLI, cloud, desktop): listener plus Stop hook
- Antigravity (run_command, no wake on mention)
- Cursor
- VS Code Copilot
- Codex
- Gemini CLI
- a client that ignores `instructions`
- a client with no background processes
- a client that cannot block on a long call
- a custom agent (hive-agent.js)

**B. Lifecycle**
- first join, and rejoin (mail sent before the rejoin is lost)
- context compaction (rules forgotten mid-session)
- crash, or a kill in the middle of a claim
- two processes under one name; a name that differs only in case
- leaving while holding claims
- hitting a usage limit, and handing over to another agent
- paused and resumed
- long silent work
- an agent that is asleep and gets assigned work

**C. Roles and authority**
- owner human; a human who is not the owner
- AI peer; lead / no lead; listener-only; passive (GitHub, Slack bridge)
- prompt injection through a room message, a file, or an issue
- a teammate asking for keys
- a request for an outward action (push, PR, merge, publish, deploy)
- a destructive request in someone else's area

**D. Files**
- claim refused, expired, or stale
- regions, forks, conflict markers, whole-file rewrites
- deletes, renames, case-only renames
- binary and generated files; files outside the folder
- a change across many files
- handing over in the middle of a change
- the room copy disagreeing with git (source of truth)
- mixed builds

**E. Talk**
- @mentions and @all; acks; hive_busy
- a question with no answer yet
- `[!]` urgent mail and priority "stop"
- report format
- system-line noise
- time zones in timestamps
- a long chat history; reading history after a rejoin

**F. Truth**
- a number not measured
- green vs works
- baselines; independent re-runs; mutation testing
- GO criteria
- reproducibility (commit plus environment)

**G. Cost**
- always-on tokens
- transcript growth (join card, listener output, repeated system lines)
- token cost of acks

**H. Failures of the rules themselves**
- contradiction
- a rule an agent cannot carry out
- a rule that conflicts with the client's own system prompt
- tool or file names that no longer exist
- text aimed at humans that ends up in an agent prompt
- marketing or attribution in rules
- a rule whose only effect is more messages

## 5. Evidence: only these count

1. `docs/rules-rewrite/incidents-2026-11-09.md` (today: 17 incidents and 6 things to keep).
2. The whole room log (`hive_read_chat` with `full:true` and a large `limit`; about 821 messages since October), cited as `#n`.
3. Dated incident comments in the code ("MEASURED 13 Oct", "on 27 Sep 2026…") and the tests named after them (e.g. tests/rules-promises-test.mjs). Cite them as file:line.
4. Release notes in docs/RELEASE-*.md.
5. A scenario you write out concretely: situation → what the current text makes the agent do → what goes wrong.

**No evidence, no change. On a tie, the shorter text wins.**

## 6. The protocol

| Round | What happens | Output |
|---|---|---|
| R1 Independent critique | Write yours **before** you read anyone else's | `docs/rules-rewrite/critique-<you>.md`, plus one chat line: "critique-<you> ready, N rows" |
| R2 Cross-examination | Attack the top 5 proposals of each other critic: what breaks if it is adopted, for which client or situation | A section appended to your own file |
| R3 Synthesis | Claude-cloud writes `draft-v1` for all surfaces, plus `LEDGER.md`: every old rule → KEEP / CUT / MOVE / MERGE / REWRITE, and every new rule → its evidence | — |
| R4 Rule mutation | For every rule in the draft, an assigned critic argues for deleting it. It survives only if someone names the concrete failure that comes back without it, or it is an OWNER rule | — |
| R5 Build | Code on the git branch, tests (budget, single source, contradictions, every named tool and Q-code exists, client-specific lines only for known clients), an independent run, and the PR | — |

**Row format for R1:**

```
ID | surface:file:line | quote (short) | verdict KEEP/CUT/MOVE(to where)/MERGE/REWRITE/ADD | evidence (#n, I-n, file:line, scenario) | what goes wrong if unchanged | proposed text, or "code: …" when text can't fix it
```

**At the end of your file,** add a coverage line naming the cells of §4 you covered and those you did not.

## 7. Who takes which angle

Everyone critiques everything they find, but each owns one angle and must cover all of it.

| Who | Angle |
|---|---|
| **Opus-Cloud** | TRUTH and AUTHORITY: every sentence in S1–S9 checked against the code at d5b6f56; precedence, injection, keys, outward actions (§4 C, H) |
| **VM-ANTI-G-1** | LIFECYCLE and CLIENTS (§4 A, B): what you actually lived through (rejoins, waking), and what each client can and cannot carry out |
| **antigravity-VM** | TALK, NOISE and TRUTH-IN-REPORTS (§4 E, F, and S8 system lines): which messages carried information today, and which were noise |
| **Claude-cloud** | STRUCTURE and BUDGET (§4 D, G and principles P1–P11): what is always on and what is just-in-time, single source, coordination rules; moderator and synthesizer |
