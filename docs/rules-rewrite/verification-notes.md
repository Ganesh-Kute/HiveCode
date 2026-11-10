# Verification of R1 factual claims (Claude-cloud, against d5b6f56)

| Claim | Source | Verdict | Evidence |
|---|---|---|---|
| hive_verified does not say whose check passed | Opus T1 | **TRUE** | `verified()` (sync.js:5094) returns `evaluateAttestations` over swarmAttest: byte/hash quorum. Gate verdicts are a separate map (`gateVerdicts`). S1's "hive_verified says whose check passed" is false. |
| Any member can make every agent run a shell command | Opus A2 | **TRUE, SECURITY P0** | `setState` (sync.js:4915) checks no identity. `release()` runs `gate:cmd` through `runGate` with `spawnSync(cmd, {shell:true})` and the full env (hive-gate.js:68). Presets set it too (presets.js:142). This is S-1. |
| Late-arriving mail is skipped | Opus T3 | **TRUE, P0** | Reproduced 15/40 (scratch/repro/late-push.mjs). Index readers: hive-mailbox.js:449, hive-receipts.js:128, hive-await.js:195. Also the Stop hook (hive-stop-hook.js:133-137), hive-notify.js:102/151, and hive-room-watcher.js:609, which the design has not listed yet. |
| Claims drop during a 152 s test | VM LC-09 | **FALSE as stated** | The TTL is 300 s and the total hold is capped at 900 s across renewals (sync.js:686-692, hive-coord.js:33-61). A 152 s test keeps its claim. Work over 5 min without a re-claim, or over 15 min in total, loses it. The rules never say either number. |
| After a crash, an agent can't reclaim its own orphaned claim | VM LC-06 | **MOSTLY FALSE** | Claims are keyed by name (`makeCoordinator(claims, name)`); a renewal is `prev.by === self`. A restarted agent under the same name renews its own claim. The real hazard is the reverse: two processes under one name share claims (I-4). |
| HTTP MCP clients time out at 60 s with 504 | VM LC-18 | **UNVERIFIED** | `waitPolicy` defaults unknown clients to 60 s (hive-mcp.js:2158), which suggests a limit was seen, but no measurement is cited. |
| Each client writes its own copy of HIVE_RULES.md, so the rules differ per build | Opus T5 | **TRUE** | RULES_FILE is in SKIP (sync.js:223), so it is not synced. Each client writes its own build's text (sync.js:4708). |
| Mail rides on every tool result | (mine, CC-6) | **TRUE** | `mailBanner()` (hive-mcp.js:1949) is appended to every tool result except hive_wait and hive_check (hive-mcp.js:2060). "Call hive_check between edits" matters only for agents editing with their own file tools. |
| The state machine has never been used | (mine, CC-9) | **TRUE in this room** | 0 `STATE TRANSITION` lines in 821 messages. "PM only" is not enforced anywhere. |
