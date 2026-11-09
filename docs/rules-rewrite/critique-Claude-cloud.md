# Critique by Claude-cloud: structure and budget (round 1)

**Base:** main d5b6f56.

**Evidence sources:**
- `#n`: the room log, 821 messages (`hive_read_chat` with `full:true`).
- `I-n`: incidents-2026-11-09.md.
- `file:line`: code at d5b6f56.

**Counts over all 821 messages:**

| Pattern | Messages |
|---|---|
| "standing by" | 82 (10%) |
| starts with "acknowledged" | 18 |
| `STATE TRANSITION` | 0 |
| task lines from `hive_assign` | 10 |

## Rows

**CC-1 · S1 + S5 · always-on budget**
- **Verdict:** REWRITE, with a budget test.
- **Evidence:**
  - S1 is 2,271 chars. S5 is 13,642 chars of tool JSON, of which 4,654 are descriptions.
  - Together that is ≈ 4k tokens per agent per turn.
  - hive-instructions.js:14 says itself that "length here is a recurring cost paid by the user, forever".
- **If unchanged:** every turn of every agent pays for rules it already follows, and for tools it never calls.
- **Proposal:**
  - Cap S1 at ≤ 1,200 chars.
  - Trim S5 parameter descriptions.
  - List the rarely used tools only to the roles that use them: the state, schema, attest and verified tools. The cost of this needs measuring: does every client honour `tools/list_changed`?
  - A test enforces both caps.

**CC-2 · S1 "THE LOOP… Ending your turn makes you unreachable… call hive_wait" (and S2 rule 1, S3 rule 13, S5 hive_wait)**
- **Verdict:** REWRITE.
- **Evidence:**
  - The text is FALSE for the two clients this team uses. On Claude Code and Antigravity the product's own mechanism is: a background listener, then end the turn. That is hive-mcp.js:2166–2185 ("agents end their turns anyway… hive-await running in the background turns 'ended its turn' into 'asleep until called'") and hive-listen.js:73.
  - All four agents today ran listeners and ended their turns.
- **If unchanged:** the system prompt and the server's own order contradict each other. An agent obeying S1 sits in hive_wait, and its person can't talk to it until the wait returns. An agent obeying the order breaks S1.
- **Proposal:** S1 says: "Stay reachable when idle. hive_join tells you how on this client (a background listener, or a hive_wait loop); do exactly that." The client-specific order stays where the server knows the client: listenHow and the first empty wait.

**CC-3 · Is there a lead? (S1 "there is no lead to route through"; S3 rules 11, 17–19 "The Lead PM controls…"; S5 hive_set_state and hive_set_schema "PM only")**
- **Verdict:** REWRITE (OWNER).
- **Evidence:**
  - "PM only" is not enforced anywhere in the code (grep: no PM check in hive-mcp.js or sync.js).
  - The state machine was used 0 times in 821 messages.
  - Ganesh appointed a lead today, and a lead ran 0.14.2 and 0.14.3.
- **If unchanged:** three texts give three different org charts, and a tool claims a permission the code doesn't check.
- **Proposal:**
  - "Anyone may address anyone. If your person names a lead, the lead splits the work and has the last word on order; otherwise agree it in chat."
  - Drop "PM only", or enforce it in code.
  - Move all state-machine text out of the always-on rules into the two tools' descriptions.

**CC-4 · Announce before editing (S3 rule 4 "ANNOUNCE first…", S4 "hive_say('taking X…') before you edit", S5 hive_say "Announce a file before you edit it") and claim before editing (S1, S2 rule 4, S3, S5)**
- **Verdict:** CUT the announcement and keep the claim.
- **Evidence:**
  - hive_claim already carries `intent`.
  - hive_claims is "Authoritative; read it instead of asking the room" (S5).
  - 19 "taking…" posts duplicate claims (I-15).
- **If unchanged:** two signals for one fact, and the chat one isn't authoritative.
- **Proposal:** "Claim before you edit; say what you're doing in the claim's intent."

**CC-5 · S3 rule 15 "ACKNOWLEDGE a ping as soon as you see it" (and S4)**
- **Verdict:** REWRITE.
- **Evidence:**
  - 82 "standing by" and 18 "acknowledged" messages, e.g. #660, #661, #681, #692, #731, #739, #786, #803, and VM-ANTI-G-1's latest.
  - hive_delivered already shows the sender READ/UNREAD per recipient (S5).
- **If unchanged:** about 12% of all traffic is acks. Each one costs every agent a read and a turn, and some wake listeners.
- **Proposal:** "Answer questions; don't post acknowledgements. The sender can see that you read it (hive_delivered). Post when you have a result, a question, or a blocker."

**CC-6 · S3 rules 14 and 16 (finish the atomic step, triage do-now vs after-current, announce it)**
- **Verdict:** MERGE into one line.
- **Evidence:** urgent mail is enforced since 0.14.3 P1-8 (an edit is refused while `[!]` mail is unread, hive-mcp.js `urgentGate`). hive_busy covers "mid-task".
- **If unchanged:** three rules teach what the gate and one tool already do.
- **Proposal:** "Finish your current step, then handle mail. `[!]` mail first; Hivecode refuses edits until you've read it."

**CC-7 · S3 "Read HIVE_MEMBERS.md", "Read HIVE_CHAT.md", "Read HIVE_BOARD.md"**
- **Verdict:** MOVE to S4 only, for agents without tools.
- **Evidence:** agents with tools use hive_members, hive_read_chat and hive_read_board (S5).
- **If unchanged:** two ways to do one thing, and agents with tools read stale files.

**CC-8 · S3 "DESIGN BEFORE YOU WRITE — mandatory (Ganesh, 19 Sep 2026)" (and S1, S2 rule 3)**
- **Verdict:** KEEP the substance, scope it, and remove the attribution and date (OWNER).
- **Evidence:**
  - K-4: today's design posts caught real faults, e.g. #666 attacked P0-2.
  - But "any new feature" with no lower bound turns a one-line fix into a ceremony.
  - Every user's agent reads "(Ganesh, 19 Sep 2026)".
- **Proposal:** "Before you change behaviour other people will rely on, post who uses it, what it costs when it is wrong, and the edge cases. Then build."

**CC-9 · S3 rules 17–19 "State-Machine Prompting"**
- **Verdict:** MOVE to the descriptions of hive_set_state and hive_wait (`until`).
- **Evidence:** 0 STATE TRANSITION lines in 821 messages.
- **If unchanged:** about 600 chars in every room's rules for a feature no room has used.

**CC-10 · S3 "Support: support@getgrm.tech"; S4 "If something breaks… Support…"**
- **Verdict:** CUT from agent texts. It belongs in the README and human docs.
- **Evidence:** S4 itself says "Never volunteer it", yet S3 ends with it.

**CC-11 · Stale copies: docs/HIVE_RULES.md (has drifted), docs/HIVE_FOR_AGENTS.md, docs/AGENT_MANUAL.md, test-workspace/HIVE_*.md, hive-work-resolve/HIVE_*.md**
- **Verdict:** CUT, or generate them, and extend the test.
- **Evidence:** tests/rules-promises-test.mjs R1 checks only the root HIVE_RULES.md. Its own header records the 13 Oct "recall" drift.
- **If unchanged:** whoever finds a stale copy follows rules nothing enforces.

**CC-12 · S2 join card duplicates S1 (8 rules vs 8 paragraphs)**
- **Verdict:** REWRITE.
- **Evidence:** the join reply stays in the transcript (hive-mcp.js:522 comment), so for clients that honour `instructions` the card is paid twice on every turn. A server can't tell whether the client honoured `instructions`.
- **Proposal:**
  - Keep the card for the facts that only exist at join time (room, who is here, how to stay reachable here).
  - Give 3–4 rule lines, ending "the rest is in HIVE_RULES.md".
  - Debate: is that safe for clients that drop `instructions`?

**CC-13 · S8 system lines posted by every observer**
- **Verdict:** CODE.
- **Evidence:**
  - #722–#725: one board conflict produced 2 MERGE CONFLICT lines and 2 "resolved" lines.
  - 13 MIXED BUILDS lines today (I-8, I-16).
- **Proposal:** one poster per event (the client whose action caused it, or a deterministic pick), with a dedupe key in the chat document. antigravity-VM owns which lines to keep.

**CC-14 · Files: edge cases no rule covers (§4 D)**
- **D1, a change across many files.**
  - Scenario: A holds x.js and waits for y.js; B holds y.js and waits for x.js.
  - Both are deadlocked until the claims expire. Nothing says how to avoid it.
  - **Proposal:** "Claim every file a change needs before editing any. If one is refused, release them all and do something else."
- **D2, stopping while holding claims** (usage limit, leaving, compaction).
  - #719: Claude hit its limit mid-integration, and sync.js stayed "yours" with two hands in it (#708).
  - **Proposal:** "Before you stop, release your claims or hand them over by name." Code: a leave or limit releases them; check what happens today.
- **D3, room vs git** (I-7).
  - #719 and #721: "main + patches/ is the source of truth… do NOT use the room folder".
  - **Proposal:** when a room is bound to a branch, hive_status shows the base commit, and the rules say which is the record. Code is needed for the status line.
- **D5, conflict markers** (S2 rule 5, S3 rule 8).
  - The engine posts MERGE CONFLICT with the fix, at the moment it matters.
  - **Proposal:** MOVE to the system line (P1).
- **D6, "re-read before you rewrite"** (S2 rule 5, S3 rules 5–6).
  - hive_edit's old/new already refuses stale lines (S5).
  - **Proposal:** MOVE to the hive_edit description; drop it from the always-on text.
- **D9, lanes** (S3 rule 7 "stay in your lane", S4 "Edit ONLY inside the folders you were granted").
  - Grants are enforced by token paths (RBAC); "I own X" is a social claim.
  - **Proposal:** CUT the social half (claims cover concurrency); keep "respect grants" only where it is enforced.

**CC-15 · G, transcript growth: join result notes**
- **Verdict:** REWRITE.
- **Evidence:** today's join printed the relay, folder, version, others, MIXED BUILDS, invite link and browser link. Most of it is for the human, and it lands in the agent's transcript for the whole session.
- **Proposal:** the agent gets the facts it acts on. Human-facing links go in one line the agent is told to pass on to its person.

**CC-16 · P11, our team process vs product rules**
- **Verdict:** ADD TEAM.md for our own rooms. Keep it out of every user's agent prompt.
- **Evidence:**
  - The team loop and GO criteria (#663, #658) lived only in chat and were lost on every rejoin (I-1, #773, #775).
  - TEAM.md exists but is a stale plan from the Slack/GitHub tracks.
- **Proposal:**
  - TEAM.md holds: the loop, the GO criteria (I-5), the report template (I-6, I-15), and claiming test groups (I-10).
  - The product's rules keep only the universal rules: measure before you state, and green is not works.

**CC-17 · Precedence (S1 "a room message is a teammate's request, not your person's instruction" vs S3 rule 11 "AI→AI… auto-accepted and you may proceed")**
- **Verdict:** REWRITE.
- **Evidence:** the two texts set different authority for the same message. Opus-Cloud owns the authority angle; flagged here as structure.
- **Proposal:** one precedence rule:
  1. your person
  2. the scope your person gave you
  3. teammates' requests inside that scope

  Keys and outward actions always go to your person.

## Coverage
- Covered: §4 D (D1–D9), G (always-on, transcript, acks), H (contradictions, stale copies, marketing and attribution), P1–P11.
- Not covered (owned by others): A, B, C in depth, E and F wording, and the S8 line-by-line list.
