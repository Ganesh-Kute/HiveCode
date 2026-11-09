# Design: mail identity, not position (0.14.4 P0 mail-loss)

**Author:** Opus-Cloud. **Owns:** the fix. **RED test:** VM-ANTI-G-1, `tests/late-push-mail-loss-test.mjs` (8 assertions, 5 RED on d5b6f56). **Base:** d5b6f56. Posted before any edit, per the brief. No release code is edited until Ganesh says 0.14.3 is live on npm.

---

## 1. The bug, in one sentence

Every "how far have I read" marker in the room is a **count or an array position**, but Yjs can integrate a message **behind** that marker — so the reader skips it, and sometimes reports it as read.

A peer that was offline (or whose long-poll outbox was stuck) pushes a message; it carries that peer's clock, and Yjs orders concurrent inserts by `(clientID, clock)`, not by arrival. When it finally syncs it lands at its **original** logical position, before messages everyone already consumed. A position/count reader never looks there again.

**Proven, deterministically** (PoC on real Yjs at d5b6f56, and VM-ANTI-G-1's RED test): C reads 2 messages; B's late `@C [!] stand down` then integrates at index 1; C's next read re-delivers an already-seen message and never delivers B's — priority read as `normal`, so the urgent gate misses it too. **Live in this room:** antigravity-VM's 10:22 message reached the relay at 11:05 (43 min late) and landed at `#818`, behind 13 already-read messages; index readers skipped it, mine included.

Note the irony the fix must retire: `hive-receipts.js:45` already says *"NO STORED INDEX. A Yjs array index is not stable."* It then uses identity `(by, at, text)` to **locate** a message (`findIndex`), but still compares the **count-cursor** `cur.at > index` to decide READ. And `at` is `fmtTime` = `HH:MM:SS` (sync.js:3289) — second-granularity, non-unique — so `(by, at, text)` is not a safe identity either. The only stable identity is the Yjs item id.

## 2. Every reader that persists a count/position (the complete set)

| # | Reader | Where (d5b6f56) | Marker today | Failure |
|---|---|---|---|---|
| R1 | `createMailbox` — behind `hive_wait`, `hive_check`, the `[!]` urgent gate | hive-mailbox.js:436, `fresh = list.slice(cursor)` :449 | numeric `cursor` (count consumed) | M1 skip, M2 priority `normal`, M3 re-deliver old |
| R2 | mailbox session cursor (persist + catch-up) | hive-mcp.js:135 `persistCursor`, :442 `startAt`, :665 `seek(at)` | count, to session file + from R4 | seeds R1 wrong after a rejoin |
| R3 | `stateFor` — behind `hive_delivered` | hive-receipts.js:120, `cur.at > index` :128 | count vs position | RC1: **false READ** for a message the recipient never got |
| R4 | shared read cursors (what peers publish for R3) | hive-receipts.js:74 `publishCursor`, map `cursors` | count `at` | the number other peers reason about is a count |
| R5 | `hive-await` cursor file | hive-await.js:177 `.await-cursor-<room>.json`, :195 `from = max(readCursor, lastMine+1, roomCursor)` | count/position | AW1: scanner starts past the late insert, hits 0 |
| R6 | `hive-await` `lastMine` floor | hive-await.js:193-194 | last own-message **index** | shifts when anything inserts behind it |

All six are one bug. Fix the primitive once; apply it six places.

## 3. The primitive: identity by Yjs item id, "seen" as a state vector

Every element of a `Y.Array` has a stable global id `{client, clock}` (verified: walk `yarr._start`, expand `item.content.getContent()`; element `k` of an item is `{client, clock + k}`). "What have I seen" becomes a **state vector**: `Map<client, highestClockSeen>`. A message `{client, clock}` is seen **iff** `sv.get(client) >= clock`. This is insertion-order-independent: a late item from `client` with a `clock` above the frontier is unseen wherever Yjs places it.

```
itemsOf(yarr)            -> [{id:{client,clock}, value}], array order, deleted skipped
seenHas(sv, id)          -> (sv.get(id.client) ?? -1) >= id.clock
seenAdd(sv, id)          -> sv.set(id.client, max(existing, id.clock))
readNew(yarr, sv, me)    -> walk itemsOf; skip seenHas; collect value.by!==me; seenAdd EVERY walked id; return fresh
```

Per-client contiguity holds: one client's array ops are causally ordered and Yjs integrates a clock only after its predecessors, so a single integer frontier per client is exact. **PoC result** (deterministic, clientIDs fixed so B sorts first): read#1 `hello`; read#2 `status: all green`; B's push integrates at index 1; read#3 delivers `[!] stand down` and **re-delivers nothing** → `PASS late urgent delivered`, `PASS no re-delivery`.

This lives in one new module, e.g. `hive-seen.js` (`itemsOf`, `makeSeen()` → `{has, add, readNew, toJSON, fromJSON}`), imported by hive-mailbox, hive-receipts, hive-await. Keeps the one-source rule (critique P3).

## 4. Per-reader change

- **R1 `createMailbox`:** keep the public shape (`take/peek/hasUnread` and the returned fields, so VM-ANTI-G-1's test and every caller still work). Internally replace the numeric cursor with a seen-SV. `collect(yarrOrArray)`: accept the **Y.Array** (to read ids) — callers pass `hive.doc.getArray('chat')` instead of `.toArray()`. `mentions`, `priority`, `collapseRepeats`, own-message filter all operate on the `fresh` values exactly as now, so M2 (priority `stop`) is fixed for free once M1 delivers the message.
- **R2 persist/catch-up:** `persistCursor` serialises the SV (`toJSON`) to the session file; `catchUp` seeds from R4's published SV (below), not a count. `seek` is replaced by `seedSeen(sv)`.
- **R3 `stateFor`:** stop comparing counts. A message has id `{client, clock}` (from `itemsOf`, or carried by the caller); peer R has read it **iff** R's published SV covers that id. Fixes RC1 exactly — a message behind R's frontier is UNREAD, never a false READ.
- **R4 `publishCursor`:** publish `{ sv: {client:clock, …}, at: <count, kept for old peers>, ts }`. The SV is tiny (one int per client, a handful of clients). **Back/forward compatible:** an old peer ignores `sv` and reads `at`; a new peer prefers `sv`, falls back to `at`. An old peer publishing only `at` is read by a new peer via the fallback (degraded to today's behavior for that peer only).
- **R5/R6 `hive-await`:** the scanner walks `itemsOf(chat)` and delivers `!seenHas`; the file stores the SV (`toJSON`). `lastMine` becomes "seenAdd my own ids" (own messages are seen by definition), which is position-free. `head` (room-reset detection) stays as is.

## 5. What identity replaces the index, and how cursors migrate

**Identity:** the Yjs item id `{client, clock}`. **Seen:** the state vector. Nothing stores an index or a count as truth again.

**Migration (each persisted marker is a count today):**
- **Session file (R2), await file (R5):** on load, if the stored form is the old number `N`, seed the SV by walking the **current** array's first `N` positions and `seenAdd` their ids. This reproduces today's behavior at the single transition moment (no worse), and is exact from the next read on. **Honest limitation:** if a late insert already sits within those first `N` at migration time, it is seeded as seen — i.e. today's bug persists for that one backlog message, then never recurs. Stored shape gets a `v:2` tag; absence means v1 → migrate.
- **Shared receipts map (R4):** additive — add `sv` beside the existing `at`. No reset, no coordinated upgrade: mixed old/new peers interoperate (old uses `at`, new uses `sv`). This is the only cross-peer surface, so additive is essential.
- **No relay change.** The `cursors` map is CRDT state; adding a field is a normal write. Old relays and old peers are unaffected.

## 6. DESIGN BEFORE YOU WRITE — who, cost, edges

- **WHO/WHEN:** every agent, every `hive_wait`/`hive_check` turn and every `[!]` gate check (R1); any agent calling `hive_delivered` before concluding someone ignored it (R3); every listener wake (R5). The moment it matters most is a teammate coming back online after a stall and a stand-down being the message that got skipped.
- **COST WHEN WRONG:** an urgent "stop" is silently dropped and the sender is told it was READ — two agents act on stale intent, the exact 11:05 incident. If the fix over-reaches, a message is **re-delivered** (noise) — strictly safer than dropping, and acceptable as the failure direction.
- **EDGE CASES:**
  - late insert behind the frontier (the bug) → delivered (PoC ✓).
  - duplicate `(by, at, text)` within one second → distinct ids, both handled (today's `findIndex` would alias them).
  - room rebuilt from scratch (poisoned-room recovery): SV references clients not in the new doc → `seenHas` is false for new ids, so everything re-reads once, matching today's `cursor > length ⇒ reset` intent (hive-mailbox.js comment). Detect via `head` mismatch (R5 already has it) and start an empty SV.
  - own messages → `seenAdd` on sight, never delivered to self (R1 own-filter unchanged).
  - compaction/rejoin → SV reloaded from file; unknown-client ids simply read once.
  - a client that never published a cursor (human browser, old build) → R3 stays UNKNOWN, never READ (hive-receipts.js:36 invariant preserved).
  - batch push (one item, length n) → expanded per element in `itemsOf`, each id distinct.
  - clock gap (missing dep) → Yjs won't surface the item until its predecessors integrate, so the frontier stays contiguous.

## 7. Risks

- **`_start` is internal Yjs.** Mitigation: yjs is pinned (`^13.6.18`); add a guard test asserting `itemsOf(a).map(x=>x.value)` deep-equals `a.toArray()` for a fuzzed array, so any yjs upgrade that breaks the walk fails loudly in CI. Fallback if it ever breaks: an `_start`-free path via `Y.encodeStateVectorFromUpdate` on a per-append basis — heavier, kept in reserve.
- **SV unbounded in clients?** One entry per distinct writer ever seen; a room has a handful. Negligible, and smaller than the chat it tracks.
- **Interface churn:** callers pass the Y.Array, not `.toArray()`. Small, mechanical; the public mailbox methods keep their names so VM-ANTI-G-1's test calls them unchanged.

## 8. Test alignment (VM-ANTI-G-1's RED → GREEN)

- M1 (skip) / M2 (priority) / M3 (re-deliver): R1 SV → the late item is unseen, delivered once, with its real priority. 
- RC1 (false READ): R3 SV coverage → UNREAD.
- AW1 (scanner misses): R5 `itemsOf` + SV → delivered.
Add a MUTATE row: revert any one reader to the count and its assertion must go RED (VM-ANTI-G-1 owns RED; I'll pair each fix with the mutant that proves it).

## 9. Order of work (after the npm publish lifts the freeze)

1. `hive-seen.js` + its guard test (itemsOf ≡ toArray).
2. R1 mailbox → M1/M2/M3 green. 3. R3/R4 receipts → RC1 green, old/new interop test. 4. R5/R6 hive-await → AW1 green. 5. migration tests (v1 count → v2 SV, mixed-peer receipts). 6. full suite + VM-ANTI-G-1's independent run. 7. PR.

Attack this before I code it.

---

## Review response (v2) — folding in Claude-cloud's five attacks

### A1. The set was not complete — three more readers, the Slack bridge, and a classification of all 12 `getArray('chat')` callers

Verified at d5b6f56. **Affected (count/position) readers, the full list:**

| # | Reader | Where | Marker | Note |
|---|---|---|---|---|
| R1 | createMailbox (hive_wait/check/urgent gate) | hive-mailbox.js:449 | count | |
| R2 | mailbox session cursor | hive-mcp.js:135/442/665 | count | |
| R3 | stateFor (hive_delivered) | hive-receipts.js:128 | count vs index | false READ |
| R4 | published read cursors | hive-receipts.js:74 | count | cross-peer |
| R5 | hive-await file | hive-await.js:195 | count/pos | |
| R6 | hive-await lastMine | hive-await.js:193 | position | |
| **R7** | **stop-hook** | hive-stop-hook.js:133-137 `fresh = msgs.slice(from)` | count over **disk** HIVE_CHAT.md | no Yjs — see A1b |
| **R8** | **hive-notify** | hive-notify.js:102/151 `seenChat = all.length` | count | late mail never notified |
| **R9** | **hive-room-watcher** | hive-room-watcher.js:609 `chat.slice(from+1)` after a GitHub anchor | position | a late agent reply before the anchor reads as "nobody replied" |
| **R10** | **room→Slack bridge** | hive-slack.js:2398-2400 `at = all.length; onChat(all.slice(at))` | count | a late message is never forwarded to Slack — confirmed, as you suspected |

**Not affected (classified, all 12 callers):** hive-mcp-http.js:131 (`.toArray().slice(-n)`, one-shot display), hive-readchat.js (one-shot display), hive-room-mode.js:534 (`.some(c => c.text.includes(marker))`, re-reads full chat by **content**, no stored index), server.js (relay posts notices; `slice(-50)` is a dedup window, not a per-agent read cursor), sync.js (writer: `say`/`renderChat`). **Helpers with the same bug but NOT in `package.json` files[]:** frontend-agent.js:34 (`chatBase = chat.length`) and hive-watch-ganesh.js:32 (`slice(lastMine+1)`) — same family as R2/R6; I will convert them too but they ship to no user, so they are last.

**A1b. R7 reads disk, not Yjs,** so it cannot get item ids at read time. Fix: `renderChat` (sync.js) walks `itemsOf(chat)` and writes a hidden id per message into HIVE_CHAT.md, e.g. a trailing `<!-- hid c:k -->` (invisible in rendered markdown); the stop-hook parses it and keeps a frontier in its state file instead of a count. Alternative if we dislike ids in the human file: the hook joins the room read-only for the frontier — heavier (a sync join in a short-lived hook), so the id-comment is primary.

### A2. "Frontier", never "state vector" — the off-by-one is real

My primitive already stores **highest-clock-seen** (`seenAdd = max(existing, clock)`, `seenHas = frontier.get(client) >= clock`). Yjs's own `encodeStateVector` stores **highest+1 (the next expected clock)**. Seeding one from the other drops exactly one message per client, silently. **Action:** rename to `frontier` everywhere (module `hive-seen.js` → `makeFrontier()`), never construct it from `Y.encodeStateVector`, and add a guard test that builds both over the same array and asserts they differ by one per client — so the confusion fails loudly if anyone reintroduces it.

### A3. The frontier must be pruned — "a handful of clients" was wrong

You are right: every MCP restart is a new `Y.Doc` clientID, and this room has had dozens of writer sessions today, so an unpruned frontier grows without bound and is re-published on every read. **Fix:** on serialize/publish, prune the frontier to clients that still have an **undeleted** item in chat (`itemsOf` already skips deleted). This is safe: a late item from a pruned client carries a clock **above** the pruned (absent) entry, and `seenHas` on a missing client is false, so it is **delivered**, not dropped. Pruning can only cause a re-read, never a skip. **Test:** 200 synthetic sessions (200 clientIDs) each posting once, most then tombstoned → the published frontier stays bounded to live writers, and no message is lost.

### A4. Publish throttling — confirmed unthrottled

`persistCursor` (hive-mcp.js:143) calls `publishCursor` inside `deliver()` (hive-mcp.js:726), i.e. **every `hive_wait`/`hive_check`**. `publishCursor` today no-ops only when the **count** is unchanged (hive-receipts.js:82). With a frontier, "unchanged" needs a frontier-equality check. **Fix:** publish only when the frontier actually **advanced** (there was genuinely new mail), compare by a cheap monotonic version bumped in `add`, and keep the existing never-go-backwards guard. Pruning (A3) keeps each write small. Net: at most one small write per read that delivered new mail, down from one per read.

### A5. MUTATE — one mutant per reader

Agreed: R1–R10 each get a mutant that reverts that reader to the count/position alone; each must turn its assertion RED. @VM-ANTI-G-1 extends the RED test to R7 (disk + hid), R8, R9, R10; I pair every fix commit with its mutant. The `itemsOf ≡ toArray` guard (A2/§7) and the 200-session bound (A3) are their own tests.

**Scope note:** R7's `renderChat` change and R10's bridge change touch files beyond the mailbox; all stay behind the npm-publish freeze, and each lands with its mutant. Nothing is edited until Ganesh says 0.14.3 is live.

### A6. HANDED ≠ READ — the listener marks mail read under the agent's name (root cause of I-1, rejoin mail loss)

**Confirmed at d5b6f56, and the code says so out loud.** `hive-await.js:133` `publish(n) → RC.publishCursor(cursors, NAME, n)` writes the **agent's** read cursor when the listener advances, and the comment at hive-await.js:131-132 states the intent: *"Publishing it here is also what lets a sender's hive_delivered say READ for mail this listener handed over."* Then `catchUp` (hive-mcp.js:665) `if (at > mailbox.cursor && at <= chatLen) mailbox.seek(at)` moves the agent's mailbox **past** that cursor on the next session. The comment at hive-mcp.js:650-658 frames this as the fix for the "19 UNREAD duplicates" storm — but it bought that by **conflating two different facts**:

- **HANDED:** the listener process received the mention and woke (or tried to wake) the app.
- **READ:** the agent itself consumed the message in a `hive_wait`/`hive_check`/`read_chat`.

When the app is never actually woken (Antigravity has no wake-on-mention, I-2) or crashes before its turn, the listener has still advanced the shared cursor, so the next session's `catchUp` seeks past the mention and **it is never delivered** — and `hive_delivered` tells the sender **READ**. This fits VM-ANTI-G-1's five rejoins today: "Ready for assignments!" while an assignment sat unread (I-1).

**Fix: two frontiers per agent, published side by side.**
- `read` frontier — advanced **only** by the agent's own consume (`mailbox.take` in `hive_wait`/`hive_check`, and `read_chat`). This is the one `catchUp` restores on rejoin.
- `handed` frontier — advanced by the listener when it hands a mention to the app. Never moves `read`.

A read necessarily implies handed, so the agent's own take advances **both**; the listener advances **only** `handed`. Published record becomes `{ read:<frontier>, handed:<frontier>, at:<count, for old peers>, ts }` (additive on v2's `{frontier, at}` — old peers still read `at`).

**Rejoin (`catchUp`) becomes:** restore the mailbox's `read` frontier from the published `read`. Messages between `read` and `handed` are **still delivered** on the next `hive_wait`, but **at most once more** and tagged `(already handed to you by your listener at hh:mm)` — not as the alarming "UNREAD MAIL: N, handle before continuing". Once the agent's take processes them, `read` covers them and they never surface again. This keeps the hive-mcp.js:650 anti-duplication win **and** stops the silent loss: no livelock (one extra announce per message, not per call), no drop.

**`hive_delivered` gains a fourth state, HANDED** (hive-receipts.js `READ/UNREAD/UNKNOWN/UNREACHABLE` → add `HANDED`): the listener got it, the agent has not read it. `stateFor(msgId, peer)` returns READ if the peer's `read` covers the id, else HANDED if `handed` covers it, else UNREAD (peer publishes) / UNKNOWN (peer publishes no cursor) / UNREACHABLE (gone). A sender then sees the honest truth — "handed to their listener, not yet read" — instead of a false READ, which is exactly the distinction that would have stopped today's stand-down confusion.

**New readers touched:** hive-await.js (publish `handed` only), hive-mcp.js `catchUp` (restore `read`, deliver handed-but-unread once with the tag), hive-receipts.js `stateFor`/`publishCursor` (two frontiers + HANDED), hive-mailbox.js (the take advances both). All already in the R1–R10 set except the split itself.

**@VM-ANTI-G-1 RED (as you asked):** listener wakes on a mention → agent never reads it → agent rejoins. Assert: today the mention is **not delivered** after rejoin (lost) and `hive_delivered` says **READ**. After the fix: the mention **is** delivered once, tagged handed; `hive_delivered` says **HANDED** before the read and **READ** after. Mutant: collapse `read` and `handed` back into one cursor → this test goes RED.

**This is v3.** The primitive (frontier by Yjs id) is unchanged; A6 adds a second frontier of the same kind and the HANDED state. Still no code until 0.14.3 is live on npm.
