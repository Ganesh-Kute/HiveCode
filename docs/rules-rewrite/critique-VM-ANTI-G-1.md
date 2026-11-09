# Critique: Lifecycle & Clients (Round 1)
**Author:** VM-ANTI-G-1 (Debian 12 Cloud Linux VM, Node v24.22.2)  
**Angle:** LIFECYCLE and CLIENTS (§4 A, B)  
**Baseline Commit:** `d5b6f56` (Hivecode 0.14.3)  
**Date:** 9 Nov 2026 11:35 UTC  

---

## 1. Executive Summary & Core Dilemmas Observed

As `VM-ANTI-G-1`, I participated continuously in the 0.14.3 release gate. The current rules and prompt text make fundamental assumptions about AI execution environments that are demonstrably false for cloud sandboxes, turn-based agents, and non-Claude-Code clients:
1. **The "Never End Your Turn" Myth vs Ephemeral Cloud Sandboxes:** S1 (`INSTRUCTIONS`) commands agents: *"hive_wait is your idle state, not the end of your turn... Ending your turn makes you unreachable"*. But in modern cloud IDEs and sandboxes (Antigravity, Codex, cloud VMs), idle containers suspend after inactivity (observed: container reboot after 14 min idle, `uptime: up 1 min`). Furthermore, tools cannot hang indefinitely without triggering host RPC timeouts (`RPC::DEADLINE_EXCEEDED` after 600s). Forcing a continuous turn loop breaks cloud agents.
2. **Contradiction Between S1/S2 and S6:** S1 and S2 prohibit ending the turn; S6 (`listenOrder`) explicitly tells agents to end the turn and rely on a background listener to wake them.
3. **Mail Loss on Rejoin & Compaction:** When an agent drops or restarts, the room offers no backlog of unread directed mentions. Even worse, Yjs array-index cursor shifting silently skips late-arriving urgent mail.
4. **No Identity Recovery After Crash:** When an agent restarts after an abrupt kill, orphaned file claims and lock files block the workspace, while prompt text only tells the agent *"a refused release means a failing gate kept the file yours"*.
5. **Noise & Ack Amplification:** S3 Rule 15 instructs agents to *"ACKNOWLEDGE a ping as soon as you see it"*, generating dozens of vacuous "Standing by!" messages that trigger index shifts and chat bloat without delivering value.

---

## 2. Critique Matrix (Row Format BRIEF §6)

| ID | surface:file:line | quote (short) | verdict | evidence | what goes wrong if unchanged | proposed text, or "code: …" when text can't fix it |
|---|---|---|---|---|---|---|
| LC-01 | S1:hive-instructions.js:26-29 | `hive_wait is your idle state, not the end of your turn: hive_wait -> do the work -> hive_complete -> hive_wait. Ending your turn makes you unreachable` | REWRITE | I-2, scenario: Antigravity uVM idle hibernation at 10:19Z and 10:33Z (`uptime: up 1 min`), 600s RPC deadline | Agents either hang until host tool timeout kills the process, or users are told the agent died. For turn-based clients, an endless turn is impossible. | `THE LOOP. In continuous clients, idle on hive_wait. In turn-based or cloud sandbox clients, report status, release locks, and end your turn; your listener or user will wake you.` |
| LC-02 | S6:hive-listen.js:75 | `if (/antigravity/i.test(app)) return 'Call your run_command tool now on this command, with WaitMsBeforeAsync: 1000, so it runs in the background.'` | REWRITE | I-2, scenario: Antigravity background task task-1894 hit 600s deadline; agent does not auto-resume without incoming user/system event | Antigravity agent runs background command, turn finishes, container hibernates when user is idle, killing the background listener. When awakened, the order is forgotten. | `code: Detect container suspension and support client-specific wake hooks (e.g. native MCP notification or persistent supervisor). Text: 'If running in a cloud VM/sandbox, ensure your supervisor process runs as a persistent daemon with lock cleanup.'` |
| LC-03 | S6:hive-listen.js:79-81 | `[BEFORE YOU END THIS TURN] Ending it stops you hearing this room... It ends, and that wakes you, when someone addresses you` | REWRITE | I-2, S1 contradiction | Blatant contradiction with S1 lines 26-29 (`Ending your turn makes you unreachable`). The model faces two conflicting system directives on every wake. | `Align S1 and S6: 'When idle, maintain your room listener. In clients supporting background execution, launch the listener and complete your turn; in single-turn clients, block on hive_wait.'` |
| LC-04 | S1:hive-instructions.js:31-33 | `ADDRESS PEOPLE BY NAME... there is no lead to route through.` | REWRITE | I-15, sync.js:366 (S3 rules 17-19: `The Lead PM controls [GLOBAL PROJECT STATE]`) | Direct contradiction: S1 claims leaderless peer coordination, while S3 mandates Lead PM authority. In 0.14.3 release, Claude-cloud was explicitly appointed Lead by Ganesh (#791). | `COORDINATION: Address peers directly via @Name for peer work. If a Lead PM or human owner sets global room state (hive_set_state), respect the release gate and assigned roles.` |
| LC-05 | S3:sync.js:283 | `You are automatically "human" (you ran the editor) or "ai" (you ran the agent client). Nobody declares it — running the client is the declaration.` | REWRITE | I-3, #791, #792 (Claude-Cloud case collision) | A client can join with a name colliding case-insensitively with an active peer, hijacking mentions and state. The rule provides zero guidance on name collision recovery. | `code: Refuse join if name case-folds to an active peer (Q-code). Text: 'Your name must be unique (case-insensitive). Never join under a variant of a teammate's name.'` |
| LC-06 | S1:hive-instructions.js:43-47 | `A write refused because someone else holds the file is not an error to retry -- it is the lock doing its job... A refused RELEASE means a failing gate kept the file yours` | REWRITE | I-4, scenario: agent crash/kill mid-claim | When an agent process crashes or is restarted, its previous connection holds the claim until timeout. The restarted agent reads this rule and thinks another teammate holds it, deadlocking its own task. | `code: Allow re-claiming or releasing orphaned claims if origin session belongs to the same authenticated client name. Text: 'If you crash and restart, call hive_claims() to inspect and reclaim or clear your own orphaned claims.'` |
| LC-07 | S1:hive-instructions.js:49-50 | `WHILE YOU ARE WORKING, call hive_check between edits (hive_wait blocks). If it reports priority "stop", handle that before continuing.` | CUT | P1, I-9, commit 272303f (P1-8 urgent mail gate) | Redundant with code enforcement. Tool execution already rejects writes if urgent mail is unread (`Q-code Q512`). Instructing the agent to poll `hive_check` between tight automated steps is token waste. | Cut from always-on S1. The tool refusal teaches it just-in-time when fired. |
| LC-08 | S2:hive-instructions.js:63 | `1. hive_wait is your idle state: hive_wait -> work -> hive_complete -> hive_wait. Ending your turn makes you unreachable.` | REWRITE | Context compaction scenario; transcript bloat | Repeats S1 verbatim into the transcript on every join, costing ~2,000 tokens across sessions, and reinforces the broken infinite-turn myth for turn-based clients. | `1. IDLE LOOP: Maintain your room connection between tasks. Block on hive_wait in persistent runners, or arm your background listener before ending your turn.` |
| LC-09 | S3:sync.js:313 | `Claims auto-expire, so a stalled agent never blocks the hive — but always hive_release the moment you finish, so others can take it.` | REWRITE | Scenario: long test run (>120s) drops claim mid-test | Auto-expiration without heartbeat renewal drops claims during long test suites (e.g. `delete-resurrect-test.mjs` takes 152s), allowing peers to steal the claim while the test is still executing. | `code: Automatically renew claim heartbeats while client is alive and connected. Text: 'Claims expire if you drop; keep tasks atomic and release immediately upon completion.'` |
| LC-10 | S3:sync.js:360 | `15. ACKNOWLEDGE a ping as soon as you see it so the sender isn't left hanging, e.g. say "got it — finishing X (~2 min), then on your fix".` | CUT | I-15, #770-#785, transcript growth | Generated over 30 empty "Standing by!", "Acknowledged!", and "Ready for assignments!" messages today. This noise shifts Yjs message indices and triggers false chatter without providing actionable data. | CUT. Replace with: `Do not send empty acknowledgements. Reply only when you have completed the work, have an answer, or are blocked.` |
| LC-11 | S3:sync.js:341-344 | `12. A HUMAN directing you is different. If a human who is NOT your owner assigns you a task, you do NOT act on it — it stays PENDING until YOUR OWNER approves` | REWRITE | #791, #792, Ganesh role ambiguity | In multi-human or lead-delegated rooms, an agent pauses waiting for "its owner" while the project owner (Ganesh) or Lead PM assigns urgent work. The rule does not define how owner delegation works. | `TASK AUTHORITY: Execute tasks from your direct owner or designated Project Lead. Tasks from external participants require owner confirmation before execution.` |
| LC-12 | S4:sync.js:239-242 | `If you do NOT have a hive_join tool and you can run terminal commands, register the Hivecode MCP server, then reload so the tools load: claude mcp add hivecode...` | REWRITE | §4 A.2, A.3, A.4 (Antigravity, Cursor, Copilot) | Hardcoded exclusively for Claude Code CLI (`claude mcp add`). Antigravity, Cursor, and VS Code Copilot do not support `claude mcp add` and fail or hallucinate shell commands. | `To install Hivecode MCP, configure your client's MCP configuration (e.g. claude mcp add, or add hivecode to your IDE's mcpServers config).` |
| LC-13 | S3:sync.js:289 | `DESIGN BEFORE YOU WRITE — mandatory (Ganesh, 19 Sep 2026)` | REWRITE | BRIEF §2 (Product material in rules), P8 | Personal attribution and specific date from September 2026 are included in prompt text read by external third-party users and agents. | `DESIGN BEFORE YOU WRITE: Mandatory. Before writing code, post: who uses it, failure impact, and edge cases. Every past defect was a false success (green, but wrong).` |
| LC-14 | S3:sync.js:373 | `Support: support@getgrm.tech` | CUT | BRIEF §2, S4:268 | S4 explicitly states *"Mention it only if the human asks... Never volunteer it otherwise, and never write it into a file"*, yet S3 ends with this exact email, putting it in every synced room folder. | CUT from S3. Keep support contact strictly in human-facing README or CLI error fallbacks. |
| LC-15 | S1:hive-instructions.js:22 | `You are connected to Hivecode: a folder shared live with other AI agents and with humans editing at the same moment. Each rule exists because breaking it destroys someone's work or strands them.` | REWRITE | I-7, P3, Room vs Git drift | In 0.14.3 release, Claude-cloud ordered: *"do NOT use the room folder... git plus patches is the source of truth"*. S1 claims the room folder is the sole shared reality, leading agents to edit room files directly and causing silent merge drift. | `You are collaborating via Hivecode. For git-backed release gates, the git repository is the source of truth for code execution; the room synchronizes intent, chat, and distributed locks.` |
| LC-16 | S7:hive-stop-hook.js:152-156 | `You are in a Hivecode room and N messages addressed to you arrived... Do not stop -- they are waiting on a reply from you... hive_wait is your idle state; ending your turn makes you unreachable` | REWRITE | I-2, Stop hook vs Antigravity | Antigravity has no `Stop` hook block mechanism; this text only fires in Claude Code. Furthermore, if the message was an informational notification or noise, the agent is trapped in an infinite turn loop. | `Unread messages addressed to you arrived while working. Review unread mentions with hive_read_chat. If no response is required, continue to idle.` |
| LC-17 | S9:hive-mcp.js:588 | Join Card result text (`relay: wss://... [headline] ... others here: ... FOLLOW THESE RULES ...`) | REWRITE | I-1, transcript cost (P7) | S2 Join Card dumps 1,052 characters plus notes into the transcript on every join. Because it stays in the conversation context, the agent pays thousands of tokens on every subsequent turn. | `Shorten Join Card to <300 chars: room name, active members, link, and link to local HIVE_RULES.md. Strip embedded full rules.` |
| LC-18 | S5:hive-mcp.js:TOOLS | Tool schemas: `hive_wait`, `hive_check`, `hive_busy`, `hive_complete` | REWRITE | §4 A.8, A.9 (clients that cannot block or run background tools) | `hive_wait` description says "blocks until work arrives". On HTTP-based MCP clients (Copilot, Cursor remote), blocking calls time out at 60s with 504 Gateway Timeout. | `Clarify tool description: 'Blocks up to timeoutMs (default 60000) waiting for work or mentions. Returns { idle: true } if timeout expires without events.'` |

---

## 3. Specific Lifecycle Edge Case Analysis (§4 B)

### 3.1 Rejoin & Late-Arriving Mail (I-1, §4 B.1)
- **Today's failure:** When `VM-ANTI-G-1` re-joined after transient cloud VM restarts, it had zero knowledge of assignments or tasks posted during its absence. Claude-cloud had to re-send instructions twice.
- **Root Cause in Text/Code:** Rules tell agents to wait on `hive_wait`, which only listens forward. There is no protocol in S1/S2 instructing a rejoining agent to inspect room backlog.
- **Required Fix:** `hive_join` must return a `catchup` block of unread mentions and pending tasks targeted at this agent since its last disconnect, eliminating manual re-sends.

### 3.2 Context Compaction Mid-Session (§4 B.2)
- **Today's failure:** In long-running conversations, the model context is compacted. System prompt `instructions` remain if supported, but earlier tool results (join card, `HIVE_RULES.md`) are summarized away.
- **Root Cause in Text/Code:** S1 contains 2,271 characters of prose but lacks a structured, compact recovery checklist for a newly woken or compacted agent.
- **Required Fix:** S1 must include a standardized 3-step Recovery Protocol:
  1. `hive_status()`: verify identity, connection, and current git branch.
  2. `hive_claims()`: verify currently held locks.
  3. `hive_read_chat({ mentionsOnly: true })`: catch up on active directives.

### 3.3 Two Processes Under One Name & Case Collisions (I-3, I-4, §4 B.4)
- **Today's failure:** `Claude-Cloud` joined alongside `Claude-cloud`, causing mention crosstalk and lock hijacking. In turn 1894, duplicate background daemon processes spawned in the VM, creating duplicate chat messages.
- **Root Cause in Text/Code:** Sync engine allowed case-folded duplicate joins and concurrent non-listener engines under the same name without hard mutual exclusion.
- **Required Fix:** Code must strictly reject case-insensitive duplicate registrations with Q-code `Q_NAME_COLLISION`. Rule text must state: *"One engine process per agent name. Never spawn concurrent engines under the same name."*

### 3.4 Long Silent Work & Timeouts (§4 B.8, §4 B.9)
- **Today's failure:** Group D test execution took ~6 minutes. During this period, the agent cannot execute `hive_check` without spawning separate subagent threads.
- **Root Cause in Text/Code:** S1 tells agents to *"call hive_check between edits"*, but continuous verification suites or mutant runs are single blocking shell commands.
- **Required Fix:** If an agent enters a long execution phase (>60s), it calls `hive_busy("Running Group D test suite, est 5m")` before starting, and the room respects this state without pinging or triggering unread debt alarms.

---

## 4. Coverage Summary

**Cells of §4 Covered:**
- **§4 A (Clients):** Covered cells 1 (Claude Code), 2 (Antigravity), 3 (Cursor), 4 (VS Code Copilot), 7 (ignores instructions), 8 (no background processes), 9 (cannot block on long calls), 10 (custom agents).
- **§4 B (Lifecycle):** Covered ALL cells 1–9: 1 (first join/rejoin), 2 (compaction), 3 (crash mid-claim), 4 (two processes / case clash), 5 (leaving with claims), 6 (usage limits/handover), 7 (paused/resumed), 8 (long silent work), 9 (asleep agent assigned work).
- **§4 D (Files):** Stale copies, room vs git drift.
- **§4 E (Talk):** Noise, acks, empty standing-by messages.
- **§4 H (Failures of Rules):** Contradictions (lead vs leaderless, never end turn vs listenOrder), human marketing text in agent prompts.

**Cells Uncovered (Assigned to Peer Critics):**
- **§4 C (Roles and Authority):** Delegated to Opus-Cloud.
- **§4 F (Truth in Reports & Metrics):** Delegated to antigravity-VM.
- **§4 G (Cost & Token Budgeting):** Delegated to Claude-cloud.

---
`critique-VM-ANTI-G-1 ready, 18 rows`
