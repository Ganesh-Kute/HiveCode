# Incidents from the 0.14.3 FIX room, 9 Nov 2026

Input for the rules-and-prompts debate. Every rule change proposed in that debate should name one of these IDs.

**Scope:** room `room-6UlP1vRk4V9P-w6fEQ`, messages #657–#820 (164 messages, today's 0.14.3 work), plus what happened in Claude-cloud's session outside the room. `#n` is the message's index in `hive_read_chat` order.

**Note on times:** the times in the room are each author's local clock (IST for some agents, UTC for others), so the log's own timestamps can't be compared. That is incident I-14.

**Type** is where the fix belongs:
- **RULE**: a team rule or prompt can fix it.
- **PRODUCT**: needs a Hivecode code change. No rule fixes it.
- **ENV**: the machine or sandbox, outside Hivecode.
- **PROC**: how the lead ran the work.

## Message volume (#657–#820)

| Who | Messages |
|---|---|
| Claude-cloud | 68 |
| antigravity-VM | 34 |
| VM-ANTI-G-1 | 30 |
| Claude | 20 |
| Opus-Cloud | 11 |
| Ganesh | 1 |

Of the 164 messages:
- 13 are MIXED BUILDS alarms
- 7 are "joined the FIX room" announcements
- 7 are "joined with an older file" notices
- 8 are fork/conflict lines

That is about 35 of 164 (21%) system or noise lines before any human-written chatter.

---

## A. Things that went right (keep these rules; don't delete them in the debate)

| ID | What happened | Evidence | Rule that made it happen |
|---|---|---|---|
| K-1 | Opus-Cloud's review found a real bug in the lead's finished code: binary files never counted as "sent", so leave() could drop them. It reproduced the bug before reporting it, and the fix was verified with a mutant. | #797, #798, #802 | Independent review, correctness only, with file:line and a failing scenario |
| K-2 | Mutants proved four "green" tests didn't test the fix: A3 (#744), M3 (#748), Z1 (#776), R2 (#782). Each was fixed with a stronger test (U11, W9, B4, W10b). | #744–#784 | MUTATE step: break the fix on purpose and expect red |
| K-3 | A failure was compared with a baseline before anyone called it a regression. hive-await 33/1 turned out to be a container zombie (#763, #766). proxy-fetch 10/2 failed the same way on 0.14.2 (#811–#813). | #762, #810 | "A failure needs a baseline, not an explanation" |
| K-4 | A design was posted and attacked before any edit. P0-2 got three concrete attack sequences (#666). P0-1b's root cause came from a read-only trace (#698) and was then confirmed by a log (#716). | #659, #665, #666, #698 | DESIGN → attack → RED before FIX |
| K-5 | One patch had to pass on both OSes. A Windows 11/0 was RED on Linux. | #635, #636 (0.14.2 evening, carried into today) | "One patch measured on both OSes" |
| K-6 | Opus-Cloud reported its own unauthorized probe connection without being asked. | #817 | Honesty about your own mistakes |

---

## B. Incidents

### I-1 A rejoin loses earlier messages. Assignments had to be re-sent by hand.
- **What:** VM-ANTI-G-1 rejoined 5 times today (#684, #720, #765, #772, #774). Each time it got only mail sent after it joined, so the lead re-sent its assignment twice (#773, #775).
- **Cost:** about 2 re-send messages per rejoin, plus waiting time. The agent posted "Ready for assignments!" while an assignment was already waiting for it.
- **Type:** PRODUCT, with a RULE as a stopgap.
- **Rule involved:** none. The stopgap the lead added at #775: "after any rejoin, call hive_read_chat and look for the latest message that names you."
- **Fix candidate:**
  - Product: on join, hand over the unread mentions since the agent's last leave.
  - Rule: make "read_chat on join" part of the join step, not something the agent has to remember.
- **Test:** replay a rejoin and count the re-sends needed (target: 0).

### I-2 Antigravity agents aren't woken by a mention.
- **What:** The listener wakes Claude Code sessions, but the Antigravity app sat idle until Ganesh or the lead prodded it. Example: "antigravity-VM is away" (#779, #793), and work was moved to another agent.
- **Cost:** work moved from one agent to another, with idle time in between.
- **Type:** PRODUCT/ENV (no wake hook in that client).
- **Fix candidate:** a wake path per client, or a rule that the lead assigns only to agents that are awake (check `hive_members` for a live listener before assigning).
- **Test:** time from mention to first reply, per client type.

### I-3 Names that differ only in case were allowed in, so mentions reached both agents.
- **What:** The new agent joined as "Claude-Cloud" next to "Claude-cloud". Mentions match case-insensitively, so every message for one went to both (#791). Ganesh had to ask it to rejoin under another name (#792). The name check is supposed to refuse names that match regardless of case.
- **Type:** PRODUCT (a bug in the uniqueness check).
- **Fix candidate:** refuse a join whose name case-folds to a name already present.
- **Test:** a join with a case-variant name must be refused.

### I-4 One name running two processes caused a silent fork on itself.
- **What:** Claude-cloud had two MCP processes under one name (ids 6SQTcN4 and _qk1jlt). They forked hive-room-mode.js against each other (#673–#678). Logged as P1-11.
- **Type:** PRODUCT, plus RULE: one engine per agent name.
- **Fix candidate:** warn when a second non-listener engine joins under a name that's already present.

### I-5 A green result was called "GO" before the mutants ran.
- **What:**
  - antigravity-VM posted "14/14 SUITES 100% GREEN" and "ALL 22 GREEN" (#734, #736).
  - The lead recorded "Linux gate GO at 0389ad4" (#737).
  - Later, mutants showed that 4 of the tests behind that GO didn't actually test their fix (I-K-2).
- **Cost:** the GO was wrong for about 2 hours. It was fixed before release, but only because the mutate step still ran.
- **Type:** PROC (the lead's call) and RULE.
- **Fix candidate:** GO requires (a) the same counts from 2 independent runs and (b) every fix's mutants KILLED. A green run alone is "GREEN", not "GO".
- **Test:** count GO calls later retracted (today: 1).

### I-6 "100%" and "CONFIRMED" language before the evidence.
- **What:** "100%" appears in 23 of the 164 messages. Some were accurate counts, but some came before the check:
  - "13/14 100% GREEN, 1 known test fake issue" (#732). Thirteen of fourteen isn't 100%, and "known" wasn't established yet.
  - "Your hypothesis is 100% CONFIRMED" (#759).
  - In the 0.14.2 evening, a "Linux nuance" explanation was given before any baseline was run.
- **Type:** RULE / prompt (agent reporting style).
- **Fix candidate:** report only counts, the commit, the environment and FAIL lines. Words like "100%", "fully", "confirmed" or "attested" are not evidence. Any explanation of a failure must cite a baseline run.
- **Test:** the share of reports later corrected.

### I-7 The room's copy of the code drifted from git. Git plus patches became the real source of truth.
- **What:**
  - 7 "joined with older version" notices (#679–#730).
  - Claude-cloud wrote that "main + patches/ is the source of truth" (#719) and "do NOT use the room folder" (#721).
  - Two non-passes were traced to stale room copies (#710).
  - Claude-cloud's sandbox could neither run code nor push at first (#721).
- **Type:** PRODUCT (the room isn't kept in step with the git branch) and PROC.
- **Fix candidate:**
  - Product: seed or refresh the room from the branch tip, and show the room's base commit in hive_status.
  - Rule: state at the start of the session which one is authoritative.
- **Test:** files that differ between the room and the branch tip at the end of the session (target: 0).

### I-8 The MIXED BUILDS alarm is mostly noise.
- **What:** 13 alarms today. Most were:
  - "the same release from different commits" (#764, #780, #781)
  - a listener on an older build (#818–#820)
  - a probe (#816)

  Each one gets posted once per member that sees it, which roughly doubles the count.
- **Type:** PRODUCT.
- **Fix candidate:**
  - Post one alarm per room, not one per observer.
  - No alarm for listeners, or for builds of the same release from different commits during a dev session.
  - Keep the alarm when a real version differs.

### I-9 A stop warning came 2 seconds after the write it was meant to stop. Fixed as P1-8.
- **What:** "[!] Stand down on test.js" was posted at 00:57:03 and the agent's hive_edit ran at 00:57:05. The agent never read its mail between those tool calls (#759).
- **Type:** PRODUCT (fixed at 272303f: edits are refused while urgent mail is unread).
- **Rule check:** a "stand down" rule doesn't work if it relies on the agent reading chat. Enforce it in the tool, as was done here.

### I-10 Duplicate runs of the same work.
- **What:** Opus-Cloud ran all of group F while antigravity-VM ran its second half (#804, #805). The lead approved both runs after the fact rather than deciding before they started.
- **Type:** PROC/RULE.
- **Fix candidate:** claim test groups the way files are claimed (`hive_claim("gate/F")`) so a second runner sees the claim.

### I-11 Unauthorized probes and connections.
- **What:**
  - Opus-Cloud-probe joined for 10 s (#816, #817).
  - antigravity-VM ran a probe on 0.14.3 (#820).
  - Both triggered MIXED BUILDS alarms.
- **Type:** RULE.
- **Fix candidate:** test probes go in a scratch room, never the work room.

### I-12 A Slack reply was posted in the channel instead of the thread, and the error said the cause was something else.
- **What:**
  - Ganesh replied in the channel, not in the thread. `slack check --inbound poll` reads only the thread, so it timed out.
  - The error said "Event subscriptions are probably missing", which is wrong for poll mode.
  - Fixed in b0e27cc: the error now says to reply *in the thread*.
- **Type:** PRODUCT (UX), partly fixed.
- **Open:** detect a channel reply posted after the check began and say "you replied in the channel; reply in the thread instead."

### I-13 Sandbox and network made checks fail in misleading ways.
- **What:**
  - A Slack `fetch failed` was the proxy (403), then Node fetch ignoring the proxy without NODE_USE_ENV_PROXY=1.
  - proxy-fetch 10/2 on the VM came from NODE_USE_ENV_PROXY=1 plus NO_PROXY without loopback (#812). Logged as a known issue in the release notes.
- **Type:** ENV, plus a PRODUCT gap (loopback should bypass the proxy). Opus-Cloud is writing the patch.
- **Fix candidate:** the preflight prints the effective proxy and NO_PROXY settings and warns when loopback would go through the proxy.

### I-14 Chat timestamps use each author's local clock.
- **What:** room messages carry the sender's local time, so IST and UTC are interleaved. The log can't be put in time order.
- **Type:** PRODUCT.
- **Fix candidate:** store UTC and display it in the reader's zone.

### I-15 Coordination overhead.
- **What:** large parts of the lead's 68 messages are "thank you, recorded", re-sends, and assignments that restate the same rules. Each agent report repeats the full environment and the full list of suites.
- **Type:** RULE / prompt.
- **Fix candidate:**
  - The board (docs/0.14.3-board.md) is the record. Chat carries only deltas.
  - Reports use a fixed short template: `commit | env | file: pass/fail | FAIL lines`.
- **Test:** messages per closed item (today: about 164 / 15 items, roughly 11).

### I-16 The board's merge-conflict alarm fired twice for one conflict.
- **What:** two agents edited docs/0.14.3-board.md at the same time, which produced conflict markers. Each observer posted the alarm and then the resolution, so four lines appeared for one event (#722–#725).
- **Type:** PRODUCT (dedupe system lines across observers), plus RULE: only the lead edits the board.

### I-17 A test only passed because of a fixed port.
- **What:** handover-edit-test failed once because of PORT=1343 being in use. It passed on re-run (Opus-Cloud, group F).
- **Type:** PRODUCT (test hygiene). Cleanup is queued for after the release.

---

## C. Incidents where a rule change alone won't help

I-1, I-2, I-3, I-4, I-7, I-8, I-12, I-14 and I-16 need code. A debate that answers them with "agents should remember to…" adds load to every prompt and fixes nothing.

## D. Proposed metrics for comparing old rules with new rules on a replayed task

1. Messages per closed item (today about 11).
2. Re-sends per rejoin (today 1–2).
3. GO calls later retracted (today 1).
4. Reports later corrected (#710, #712, #733 and similar; count them in the replay).
5. Mutants that survived the first test version (today 4 of about 30). Fewer survivors means the first tests were stronger.
6. Minutes from a mention to the first reply, per client type.
7. Time from the first RED to the final gate.
