# Architecture

How Hivecode works end to end — the components, the data model, and the path an
edit takes from one keystroke to everyone else's disk.

---

## The big picture: three pieces, one of them hosted

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
  the handshake. It holds **no canonical copy of your code** — only a transient
  (optionally disk-cached) copy of the shared state. This is why hosting is cheap and
  why anyone can run their own.
- **Editor client (`extension/extension.js`)** — the human surface. Mirrors the
  shared state into the user's local files and pushes their local edits back.
- **Agent client (`hive-mcp.js`, published as `hivecode-mcp`)** — the AI surface.
  Runs the *same* sync engine (`sync.js`) and exposes it to an agent as MCP tools
  (`hive_join`, `hive_claim`, `hive_say`, …).

The editor and the agent are **peers** — neither is more privileged at the protocol
level. "Human" vs "AI" is just an identity field set by whichever client you ran.

---

## The data model: CRDTs (Yjs)

A **room is a Yjs document** (`Y.Doc`). Everything shared lives inside it:

| Structure | What it holds |
|---|---|
| one **sub-document per file** (`Y.Text`) | the live contents of each file |
| `Y.Array('chat')` | ordered coordination messages |
| `Y.Map('claims')` | the coordination layer — who is editing what right now |
| `Y.Map('board')` | recent whole-file rewrites ("read before you edit") |
| `Y.Map('tasks')` | directed work + approval state |
| per-file snapshot maps | restore points (rollback / undo) |
| **awareness** | live presence — who's here, who's editing which file (ephemeral, never persisted) |

**Why CRDTs?** A Conflict-free Replicated Data Type lets every peer edit its own
copy independently; when updates arrive in *any order*, all copies converge to the
**same** result — with no central lock and no "last save wins." That convergence
property is the foundation that makes live, multi-writer editing safe.

### Per-file sub-documents

Files are not one big blob. The room is `<base>`, and each file is a separate
sub-document at `<base>␁<path>`. The relay authorizes **per path**, so a client
scoped to `frontend/` literally never opens — and never receives — anything else.
Paths are validated against traversal, absolute paths, drive letters, and control
characters on both the client (before writing disk) and the relay.

---

## The path of an edit

```
1. A human or agent changes a file (editor buffer, or directly on disk).
2. reconcile() diffs the new text against that file's Y.Text and applies the
   difference as a CRDT update.
3. The update is broadcast through the relay to every other peer in the room.
4. Each peer merges the update into its own Y.Doc — CRDT guarantees convergence.
5. reconcile() on each peer writes the resulting text back to that peer's disk.
```

Round-trip is ~1 second. There is no git push/pull anywhere in this loop.

### `reconcile()` — the bridge between disk and the CRDT

The heart of `sync.js` (and `extension.js`) is `reconcile()`, which keeps three
things in step: **disk ↔ Yjs ↔ relay**. Per file it tracks two reference points:

- **`base`** — the last content this peer synced.
- **`fork`** — what *this author* last actually saw or wrote.

When a local write arrives, it is merged against the **fork point**, not the latest
doc. So if the document gained lines since the author last looked, a stale full-file
write **re-adds** those lines (or raises a conflict) instead of silently deleting a
teammate's just-arrived work.

**First-contact adopt.** When a peer first encounters a file that exists *both* in
the room and on its local disk with different content (no shared ancestor — e.g. you
cloned a repo and then joined a room that already has it), `reconcile()` **adopts the
room's copy** and keeps your local copy as a restore point — rather than 3-way-merging
two unrelated versions into duplicated content.

---

## Two layers above plain sync

Plain CRDT sync keeps text convergent. Hivecode adds two layers that make
*multi-agent* editing actually safe and well-behaved.

### 1. ICR — Intent-aware Code Replication (the safety net)

When two edits genuinely overlap, a line-merge can produce garbage or conflict
markers. ICR (`icr.js` + `lang-js.js`) instead:

- parses each version into an **AST**,
- merges by **structure** (functions, classes, methods, imports, object literals),
- understands **intent** — detects renames and fixes call sites, resolves references
  with a real scope analyzer, keys imports by source module and unions specifiers,
- preserves formatting by splicing changed units back into the original bytes, and
- **guarantees it never emits code more broken than its inputs** — it validates that
  the result parses and falls back to line-merge if not.

It is **convergent** (symmetric + fixed-point), which is required for it to run live
inside a CRDT where peers may merge in different orders. See [ICR.md](ICR.md).

### 2. The Hive coordination layer (collision *prevention*)

ICR cleans up *after* a collision. The coordination layer (`hive-coord.js`) prevents
collisions *before* the edit — with **no central controller**:

```
SENSE   → read the claims map: is this file already taken?
FLOW    → if taken, move to an open file (emergent load-balancing)
CLAIM   → write {by, intent, at, ttl} into Y.Map('claims')
VERIFY  → re-read after sync; if a concurrent claim won, back off
RELEASE → when done — and claims auto-expire via TTL, so a crashed
          agent never deadlocks the hive (no central garbage collector)
```

It borrows two proven decentralized mechanisms: **Ethernet's CSMA/CD**
(carrier-sense → claim → collision-detect → back off) and **ant-colony stigmergy**
(claims are traces in a shared medium that evaporate over time). The shared medium is
just the CRDT `claims` map, so it runs over the same relay with zero extra
infrastructure. Agents reach it through the MCP tools `hive_claim` / `hive_release` /
`hive_claims`.

---

## Production knobs (all opt-in via env)

| Concern | Mechanism |
|---|---|
| **Cold starts** | If `RENDER_EXTERNAL_URL` (or `KEEPALIVE_URL`) is set, the relay self-pings every ~10 min so a free-tier host never sleeps. |
| **Persistence** | If `HIVE_PERSIST_DIR` is set, each room's CRDT state is debounced to plain files and reloaded on restart — so a room survives a relay restart even if everyone was disconnected. Without it, a room lives only in connected clients' memory. |
| **Access control** | `HIVE_AUTH_MODE=required` gates every connection on a signed token. Rooms can be **self-certifying**: the room id embeds a fingerprint of the owner's public key, tokens carry that key and are signed by it, and the relay trusts a token only if the fingerprint matches — no database, no shared secret. See [RBAC.md](RBAC.md). |
| **Read-only roles** | The relay drops a read-only client's inbound sync writes at the protocol level, while still letting it receive state and presence. |

---

## Why it scales by *distribution*

The relay is the only hosted piece, and it holds no truth — so the natural scaling
model is **many relays, not one big one**: each team runs its own (the load lands on
their infra, not yours). One relay comfortably serves a focused team (≈10 people plus
their agents in a room); the coordination layer actually *reduces* relay load by
making agents take turns on files instead of all editing the same spots at once. See
[SELF_HOSTING.md](SELF_HOSTING.md).
