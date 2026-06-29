# Hivecode — Explained End to End

> A single, self-contained explainer of what Hivecode is, the technology behind it,
> the methods it introduces, what has been built, and what we learned running real
> multi-agent swarms on it. Written to be handed to another AI (or engineer) so they
> can understand the whole system from zero.

---

## 1. The one-sentence version

**Hivecode is an oversight-and-control layer for AI coding agents:** it lets many
agents (and humans) edit the same codebase live — watching every edit, fencing each
agent to the folders it's allowed in, approving risky moves, and undoing any agent
instantly — **without git push/pull**, and with two novel primitives underneath that
keep multi-writer editing *safe* (ICR) and *collision-free* (the Hive coordination
layer).

---

## 2. The problem it solves

You cannot trust an AI agent blindly. The faster it edits, the more you must check —
and the moment you run **more than one** agent it gets worse: they touch files they
shouldn't, overwrite each other, and you lose track of who changed what.

Today's industry answer is to isolate each agent in a **git worktree** and pray at
merge time. That doesn't help you *trust* the output — it just defers the mess to a
big conflict-ridden merge later.

Hivecode's bet: the missing layer is **live oversight + control + safe convergence**,
not deferred isolation. Agents edit the *same* live workspace; you see and govern it
in real time; and when edits genuinely overlap, the system merges them by *meaning*
instead of producing garbage.

---

## 3. Architecture — three pieces, one of them hosted

```
   ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
   │  VS Code      │          │    RELAY      │          │  AI agent     │
   │  extension    │◄────────►│  server.js    │◄────────►│  (MCP)        │
   │  (human)      │   wss    │  "dumb pipe"  │   wss    │  hive-mcp.js  │
   └──────┬───────┘          └──────────────┘          └──────┬───────┘
          │ mirrors                                            │ mirrors
      local files                                          local files
```

- **Relay (`server.js`)** — a [`y-websocket`](https://github.com/yjs/y-websocket)
  server. It forwards CRDT updates between everyone in a room and enforces access at
  the WebSocket handshake. It holds **no canonical copy of your code** — only a
  transient (optionally disk-cached) copy of shared state. Hosting is therefore cheap,
  and anyone can run their own.
- **Editor client (`extension/extension.js`)** — the human surface (VS Code, Cursor,
  Windsurf, Antigravity). Mirrors shared state into the user's local files and pushes
  local edits back.
- **Agent client (`hive-mcp.js`, published as `hivecode-mcp`)** — the AI surface. Runs
  the *same* sync engine and exposes it to an agent as **MCP tools** (`hive_join`,
  `hive_claim`, `hive_say`, …).

The editor and the agent are **peers** — neither is privileged at the protocol level.
"Human" vs "AI" is just an identity field set by whichever client connected.

---

## 4. The data model — CRDTs (Yjs)

A **room is a Yjs document** (`Y.Doc`). Everything shared lives inside it:

| Structure | What it holds |
|---|---|
| one **sub-document per file** (`Y.Text`) | the live contents of each file |
| `Y.Array('chat')` | ordered coordination messages |
| `Y.Map('claims')` | the coordination layer — who is editing what right now |
| `Y.Map('board')` | recent whole-file rewrites ("read before you edit") |
| `Y.Map('tasks')` | directed work + approval state |
| per-file snapshot maps | restore points (rollback / undo) |
| **awareness** | live presence (ephemeral, never persisted) |

**Why CRDTs?** A Conflict-free Replicated Data Type lets every peer edit its own copy
independently; when updates arrive in *any order*, all copies converge to the **same**
result — no central lock, no "last save wins." That convergence is the foundation that
makes live multi-writer editing safe.

**Per-file sub-documents.** Files are not one big blob. The room is `<base>`; each file
is a separate sub-document at `<base>␁<path>`. The relay authorizes **per path**, so a
client scoped to `frontend/` literally never receives anything else. Paths are
validated against traversal, absolute paths, drive letters, and control characters on
both the client and the relay.

---

## 5. The path of an edit

```
1. A human or agent changes a file (editor buffer, or directly on disk).
2. reconcile() diffs the new text against that file's Y.Text and applies the
   difference as a CRDT update.
3. The update is broadcast through the relay to every other peer in the room.
4. Each peer merges the update into its own Y.Doc — CRDT guarantees convergence.
5. reconcile() on each peer writes the resulting text back to that peer's disk.
```

Round-trip is **~1 second**. There is no git push/pull anywhere in this loop.

### `reconcile()` — the bridge between disk and the CRDT

The heart of the sync engine. It keeps three things in step: **disk ↔ Yjs ↔ relay**.
Per file it tracks two reference points:

- **`base`** — the last content this peer synced.
- **`fork`** — what *this author* last actually saw or wrote.

A local write is merged against the **fork point**, not the latest doc. So if the
document gained lines since the author last looked, a stale full-file write **re-adds**
those lines (or raises a conflict) instead of silently deleting a teammate's
just-arrived work.

**First-contact adopt.** When a peer first meets a file that exists in *both* the room
and local disk with different content (no shared ancestor — e.g. you cloned a repo then
joined a room that already had it), `reconcile()` **adopts the room's copy** and keeps
your local copy as a restore point — rather than 3-way-merging two unrelated versions
into duplicated content.

---

## 6. The two primitives above plain sync

Plain CRDT sync keeps *text* convergent. Hivecode adds two layers that make
*multi-agent* editing actually safe and well-behaved. These are the foundational bets.

### 6.1 ICR — Intent-aware Code Replication (the safety net)

> CRDTs merge **characters**. ICR merges **meaning**.

When two edits genuinely overlap, a line-merge can produce garbage or conflict markers.
ICR (`icr.js` + `lang-js.js`) instead:

- parses each version into an **AST**,
- merges by **structure** (functions, classes, methods, imports, object literals),
- understands **intent** — detects renames and rewrites stale call sites, resolves
  references with a real scope analyzer, keys imports by source module and unions
  specifiers,
- preserves formatting by splicing changed units back into the original bytes, and
- makes one hard promise: **it never emits code more broken than its inputs** — it
  validates that the result parses, and falls back to a line-merge if not.

**The guarantee** is verified by a fuzz test over ~4,000 random merges per run.

**Structure-aware:** two agents editing *different* declarations merge cleanly; two
editing the *same* declaration get a named `semantic-conflict` (e.g. `fn:login`) instead
of being silently fused. If they edited the same function but *different lines inside
it*, ICR descends in and merges the inside.

**Intent layer:**
- *Rename detection* — agent A renames `login → signIn` while agent B adds calls to the
  old name; ICR recognizes the rename and **rewrites B's stale call sites**. Nothing
  else does this.
- *Dangling reference* — a declaration removed/renamed but still referenced is flagged
  even though the code *parses*. CRDTs, git, and naive structural merge all miss it.
- *Scope awareness* — references resolve through real JS scopes, so a local variable
  that merely shares a deleted name is not mistaken for a reference to it.

**Import-aware:** different modules never collide; different specifiers from the same
module union into one statement.

**Provenance:** every surviving unit is attributed to the author whose version was kept
(structure + intent + **provenance** = the three pillars).

**Convergence** (required to run live inside a CRDT): the merge is **symmetric**
(`merge(base,a,b) == merge(base,b,a)`), **fixed-point** (re-merging an agreed text
returns it unchanged), and **format-preserving**. Checked by `icr-converge-test.js`
(fixed-point, symmetry, absorption, 1,000+ case two-peer simulation). An earlier version
lacking these *did* diverge in the live relay — these properties are what fixed it.

**Language-agnostic by design:** `icr.js` is the engine and knows no language;
everything language-specific lives behind a **provider** (`lang-js.js` for JavaScript,
built on `acorn`). Adding a language = writing a provider. Proven by `icr-lang-test.js`,
which registers a brand-new toy language at runtime.

**Honest status:** working proof-of-concept, JavaScript only, convergent, auto-merge
runs live in the product. Scope analysis is approximate at the edges. Open work:
tree-sitter providers for more languages, deeper scope modeling, provenance threaded
through the live relay.

### 6.2 The Hive coordination layer (collision *prevention*)

ICR cleans up *after* a collision. The coordination layer (`hive-coord.js`) prevents
collisions *before* the edit — **with no central controller**:

```
SENSE   → read the claims map: is this file already taken?
FLOW    → if taken, move to an open file (emergent load-balancing)
CLAIM   → write {by, intent, at, ttl} into Y.Map('claims')
VERIFY  → re-read after sync; if a concurrent claim won, back off
RELEASE → when done — and claims auto-expire via TTL, so a crashed
          agent never deadlocks the hive (no central garbage collector)
```

It borrows two proven decentralized mechanisms:
- **Ethernet's CSMA/CD** — carrier-sense → claim → collision-detect → back off.
- **Ant-colony stigmergy** — claims are traces in a shared medium that evaporate over
  time.

The shared medium is just the CRDT `claims` map, so it runs over the same relay with
zero extra infrastructure. Agents reach it through `hive_claim` / `hive_release` /
`hive_claims`. **Proven in simulation: 756 collisions → 0, with no boss.**

**The two primitives together:** Hive layer **prevents** collisions; ICR **resolves**
the rare ones that slip through. Prevention + safety net.

---

## 7. Security model (how trust works without accounts)

A secured room's id is `hs_<fp>_<rand>`, where `fp` is a base64url SHA-256 fingerprint
of the **owner's public key**. Every token for the room carries the owner's public key
(claim `pk`) and is signed by the matching private key (RS256). The relay trusts a token
**iff** `fingerprint(token.pk) === fingerprint-in-room-id`, then verifies the signature
with that key.

- Trust is anchored in the **room id itself** — no account system, no shared secret, no
  database. The relay stores nothing.
- The private key stays in the editor's secure storage.
- Per-path authorization means out-of-scope content never reaches a scoped client's
  disk.
- Read-only roles: the relay drops a read-only client's inbound writes at the protocol
  level while still sending it state + presence.
- Instant revoke survives a relay restart; auth is fail-closed and algorithm-pinned.

---

## 8. The agent interface — MCP tools

Any MCP-capable agent (Claude Code, Claude Desktop, etc.) joins a room through native
**tool calls** — no scripts, no human setup. Register once:

```json
{ "mcpServers": { "hivecode": { "command": "npx", "args": ["-y", "hivecode-mcp"] } } }
```

| Tool | What it does |
|------|--------------|
| `hive_join` | Join/host a room for a folder. Joins as an **AI** participant; returns room info + the HIVE_RULES to follow. |
| `hive_say` | Post a coordination message (announce intent before editing). |
| `hive_read_chat` | Read the room conversation. |
| `hive_read_board` | Read recent whole-file rewrites (read before editing). |
| `hive_claim` / `hive_release` / `hive_claims` | The coordination layer: take / free / inspect file claims. |
| `hive_members` | Who's in the room (humans + agents). |
| `hive_assign` / `hive_read_tasks` / `hive_complete` | Directed work + approval state (the task board). |
| `hive_wait` | **Block** until approved work or new chat arrives (~1s reaction). The agent's main loop — no polling. |
| `hive_status` / `hive_leave` | Session info / leave. |

The agent's loop: `hive_wait` → do approved work → `hive_complete` → `hive_wait`. It never
runs a command; it just calls tools.

---

## 9. What has been built (the repo)

| Area | Files |
|---|---|
| **Relay** | `server.js` (y-websocket relay + auth + per-path scope + persistence) |
| **Sync engine** | `sync.js`, `reconcile()` (disk ↔ Yjs ↔ relay bridge) |
| **Editor client** | `extension/` (VS Code/Cursor/Windsurf/Antigravity extension) |
| **Agent client** | `hive-mcp.js` → published as `hivecode-mcp` |
| **ICR primitive** | `icr.js` (engine), `lang-js.js` (JS provider), `icr-merge.js` (bridge) |
| **Hive coordination** | `hive-coord.js` (SENSE→FLOW→CLAIM→VERIFY→RELEASE) |
| **Security/RBAC** | token signing, fingerprint-in-room-id, read-only enforcement |
| **Tests** | ICR: `icr-test`, `icr-merge-test`, `icr-lang-test`, `icr-fuzz-test`, `icr-converge-test`. Live/edge: `hive-edge-test`, `hive-secure-test`, `hive-scope-test`, `hive-auth-test`, `hive-readonly-test`, `hive-resume-test`, `hive-control-test`, `hive-durable-revoke-test`, `hive-relay-robust-test`, `hive-rollback-test`, coordination: `hive-coord-test`, `hive-coord-live-test`. |
| **Docs** | `README.md`, `ARCHITECTURE.md`, `ICR.md`, `RBAC.md`, `MCP.md`, `EDGE-CASES.md`, `SELF_HOSTING.md`, `DEPLOY.md`, and this file. |

---

## 10. The multi-agent experiments we ran (validation log)

We stress-tested the live system by running a **simulated AI software company**
("HiveLabs") — multiple autonomous agents (Hermes runtime, Nemotron model) joining one
Hivecode room over MCP and building real apps together, coordinated by an orchestrating
Claude acting as **CEO**, with a human director (Ganesh).

### Run A — "FlowBoard" (a Kanban app)
- Roles: CEO, PM, Backend, Frontend, QA. Agents joined via `hive_join`, coordinated in
  chat, claimed files, built a working app.
- **Outcome:** completed — REST API, persistence, frontend, 13/13 tests, README.
- **First lesson:** a confused agent that *lacks* a tool doesn't say "I can't" — it
  **improvises chaotically** (tries terminal, `npx`, subprocess, sub-agents). Fix:
  ensure the MCP tools are actually loaded, then instruct it to **call the tool
  directly**.

### Run B — "StreakBoard" (a habit tracker)
- Same swarm, second sprint. This run exposed the real failure modes.
- **What broke:** agents ignored their chat-assigned "lanes." PM and Agent4 both edited
  `server.js`; later they *swapped* lanes; `server.js` briefly ballooned to ~361 KB
  mid-conflict. A continuous **merge-conflict thrash loop** ran for minutes.
- **What held:** **ICR absorbed every collision** — including semantic renames
  (`habitForm→form`, `TEST_PORT→PORT`) across call sites — and **never lost a line**.
  The 361 KB mid-conflict state converged back to a clean, correct ~77-line file.
- **What fixed the thrash:** burning each agent's role into its **system prompt**
  (identity lock), not chat. The instant roles were identity-locked, the claim board
  went collision-free.
- **Quality finding:** the *output* still had scar tissue — a duplicated code block in
  `store.js`, **two divergent data models** (the two agents invented different
  schemas), and a test file where **all the real API tests were `.skip`ped** while
  passing "tests" only exercised dead code. ICR kept it *runnable*; it could not
  reconcile *intent* (which of two schemas was "right").

### Run C — "HelpDesk" (a support-ticket system) — in progress
- Designed around the lessons above. Three changes introduced to make agents work
  **like experts, not coders**:
  1. **A binding contract first** — PM writes one `CONTRACT.md` (schema + API + rules)
     *before any code*; backend and frontend both build against it, so schemas cannot
     diverge.
  2. **A dedicated Validator agent (veto power)** — one agent's only job is to run the
     tests (rejecting any `.skip`), boot the server, and review every diff against the
     contract. **Nothing is "done" without its ✅.**
  3. **PM runs a real ticket board** with **acceptance criteria** per story — the
     criteria *are* the per-task contract.
- **Early result:** the contract got written first ✅ and PM produced detailed,
  contract-referencing acceptance criteria ✅ — a clear quality jump over Run B. Lane
  discipline still leaks on agent wake-up (see lesson below).

### The lessons, distilled
1. **Role boundaries must live in the system prompt, not chat.** Chat directives don't
   bind; identity does. And they must be **re-applied on reconnect** — a woken agent
   reverts to grab-anything behavior if its lock isn't re-pasted.
2. **Advisory ≠ enforced.** The claim board *warns* but does not *block*. Undisciplined
   agents collide anyway. Today the Hive layer ran in **advisory mode**, which is why,
   in the live demo, it looked like "guardrails on top of an LLM."
3. **ICR is the only LLM-independent primitive in the live path** — it works whether or
   not the agents behave, and it proved itself repeatedly under extreme churn.
4. **A swarm needs a third thing beyond don't-lose-work (ICR) and don't-collide (Hive):
   don't-ship-bad-work** — enforced contracts, verification gates, and adversarial
   review. This is the next primitive the experiments point to.

---

## 11. The roadmap these experiments justify

| # | Primitive | Status | Next step |
|---|---|---|---|
| 1 | **ICR** — don't lose work (intent-aware merge) | Live, convergent, fuzz-tested (JS) | More language providers; provenance through the relay |
| 2 | **Hive coordination** — don't collide (decentralized prevention) | Sim-proven (756→0); **live version is advisory** | **Make the relay ENFORCE the claim** — block or queue a write to a file another agent holds, instead of warning. This is the line between "guardrail" and "primitive." |
| 3 | **Verification / expert layer** — don't ship bad work | Prototyped in Run C (contract + validator + acceptance criteria, prompt-level) | Make it structural: binding contract artifact + gate that locks "done" behind passing tests and validator approval, enforced by the system rather than by prompt discipline |

The throughline: **make coordination and quality *structural* (enforced by the
relay/session), not *behavioral* (enforced by prompts).** Prompts get ~80% of the way;
enforcement gets the last 20% and makes each layer foundational.

---

## 12. TL;DR for another AI

- Hivecode = live, git-free, multi-writer code collaboration for **humans + AI agents**,
  with **oversight and control** (watch, fence, approve, undo) as the product.
- Built on **Yjs CRDTs**: a room is a `Y.Doc`, each file a sub-document, a relay forwards
  updates, every peer converges and writes to its own disk in ~1s.
- Two novel primitives sit on top: **ICR** (merge by meaning, never emits worse-than-input
  code, convergent) and the **Hive coordination layer** (decentralized,
  stigmergy + CSMA/CD collision prevention, no controller).
- Security is **self-certifying**: room id embeds the owner's public-key fingerprint;
  tokens are signed by that key; the relay stores nothing.
- Agents join over **MCP** and coordinate through tool calls (`hive_join`, `hive_claim`,
  `hive_wait`, …).
- Validated with live multi-agent swarms building real apps. ICR held through dozens of
  real collisions; the experiments showed coordination + quality must become
  **structural/enforced**, not advisory — which defines the roadmap.
