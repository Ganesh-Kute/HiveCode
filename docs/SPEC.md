# Hivecode Protocol — v0.1 (draft)

A protocol for **humans and AI agents to edit one project together, live**, with
no git push/pull in the loop. This document specifies the wire format and the
coordination rules so that anyone can build a conforming client (editor plugin,
CLI, agent SDK, MCP server) that interoperates with every other implementation.

The goal is the protocol as the standard — like LSP for editors or MCP for tools.
A reference implementation lives in this repo (`sync.js`, the VS Code extension,
`hive-agent.js`).

---

## 1. Roles

- **Participant** — any human or AI agent connected to a room. Equal citizens.
- **Relay** — a dumb message passer. It holds no truth; it only forwards CRDT
  updates between participants in the same room. (Reference: `server.js`.)
- **Room** — one shared document. Identified by an unguessable string. All
  participants connected to the same room share one project state.

A participant's **identity is implicit in the client it runs** — there is no
"declare yourself" step. An editor/human client sets `kind: "human"`; an agent
client sets `kind: "ai"`.

## 2. Transport

- Transport is **WebSocket**. The room name is the URL path: `wss://relay/<room>`.
- State is a **Yjs CRDT document** (`Y.Doc`). Clients exchange Yjs updates via the
  y-websocket protocol. The relay calls the standard y-websocket connection setup.
- The relay MUST keep rooms isolated: a participant in room A never receives room
  B's updates.

## 3. Document model

One `Y.Doc` per room with these shared types:

| Name    | Type                         | Meaning                                              |
|---------|------------------------------|------------------------------------------------------|
| `files` | `Y.Map<string, Y.Text>`      | project files: relative path → file contents         |
| `board` | `Y.Map<string, BoardEntry>`  | log of wholesale rewrites, keyed by path             |
| `chat`  | `Y.Array<ChatMessage>`       | ordered coordination messages                        |

Awareness (presence) carries identity:

```
awareness.user = { name: string, kind: "human" | "ai" }
```

### BoardEntry
```
{ by: string, at: string, churn: string, symbols: string[] }
```
`churn` is human-readable (e.g. "7/11 lines"); `symbols` are the names the rewrite
defined (functions/classes/etc.).

### ChatMessage
```
{ by: string, kind: "human" | "ai", at: string, text: string }
```

### Paths
Paths are POSIX-style, relative to the project root, `/`-separated.

## 4. Local, non-synced files

These are **generated locally** from CRDT state (or are local config). A
conforming client MUST NOT sync them as `files` entries (doing so causes echo
loops). Reference names:

- `HIVE_RULES.md` — the rules every participant follows (see §7). Written into
  every room folder.
- `HIVE_BOARD.md` — human/agent-readable render of `board`.
- `HIVE_CHAT.md` — render of `chat`.
- `.hive.json` — rendezvous config `{ relay, room }` (see §6).

## 5. Sync & merge semantics

A client maps the `files` CRDT to a working directory in both directions. Every
change — local edit → doc, and remote doc → local disk — MUST pass through a
**3-way reconcile** against the last agreed version (`base`) of each file:

- only one side changed → take that side
- both changed **disjoint** line ranges → merge both (no loss)
- both changed the **same** lines → write git-style conflict markers
  (`<<<<<<<` / `=======` / `>>>>>>>`) so BOTH versions survive for a human/AI to
  resolve. A client MUST NOT silently drop either side.

(Reference: `merge3` and `reconcile` in `core.js` / `sync.js`.)

### Rewrite detection (the board)
On a local change, a client classifies it as a small **patch** or a wholesale
**rewrite** (reference threshold: ≥50% of lines churned and ≥4 lines). On a
**rewrite only**, the client MUST record a `BoardEntry` under that path in `board`
(who, when, how much, which symbols). Small patches MUST NOT be logged (noise).
Only the authoring client logs; the entry syncs to all via CRDT.
(Reference: `summarizeChange`.)

## 6. Rendezvous (no human passing links)

A room is shared without a human relaying a link by persisting it with the project:

```
.hive.json = { "relay": "wss://...", "room": "room-..." }
```

- An agent given no link reads `.hive.json` from the project and joins that room.
- If none exists, the first agent **hosts**: it generates a room id and writes
  `.hive.json`.
- Because `.hive.json` lives in the project, sharing the repo shares the room.
  (There is intentionally no global discovery service — participants on the same
  project are already connected through the project.)

A **join link** is the string `"<relay>|<room>"` for ad-hoc sharing.

## 7. Coordination rules (the law)

Every conforming client SHOULD surface `HIVE_RULES.md` to its participant on
join. Agents are expected to follow it. Summary:

1. Before editing: read `HIVE_CHAT.md` and `HIVE_BOARD.md`; re-read any file
   listed as recently rewritten.
2. Announce intent in `chat` before starting work on a file.
3. Prefer small patches over full rewrites; re-read before any rewrite.
4. Respect declared ownership areas (read, don't edit others' lanes).
5. Resolve conflict markers; never ignore or blindly overwrite them.
6. Ask in `chat` before destructive actions (delete/rename/large refactor) in
   another participant's area.

## 8. Conformance

A minimal conforming client MUST:
- connect to a room over WebSocket and exchange Yjs updates;
- represent files as `files: Y.Map<path, Y.Text>`;
- set awareness `user = { name, kind }`;
- reconcile changes with a 3-way merge that never silently loses work;
- not sync the §4 local files.

A client SHOULD additionally: log rewrites to `board`, support `chat`, render the
`HIVE_*` files, and support `.hive.json` rendezvous.

## 9. Versioning

This is **v0.1**. The shared-type names (`files`, `board`, `chat`), the awareness
`user` shape, and the merge guarantee (§5) are the stable core. Future versions
add capabilities without breaking these.
