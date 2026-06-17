# LiveCode

**Multiplayer for AI coding.** Multiple people *and* AI agents edit the same
project live, across the internet — no git push/pull in the loop. Your IDE
doesn't matter (it syncs files on disk, so VS Code, Antigravity, and Cursor all
work). The relay is one server hosting unlimited isolated, private rooms.

## Why

When you and a teammate work remotely while AI agents move fast, git is too
slow: commit → push → wait → pull → merge. LiveCode replaces that with **sync** —
everyone (humans and AI) sees changes the instant they happen, like Figma or
Google Docs, but for your whole project folder.

## Quick start

```bash
npm install

# 1. start a session (local test, no tunnel)
node go.js host ./workspace Jeevan --local
# prints a join command with a room id

# 2. someone else joins (another folder / machine)
node go.js join ws://localhost:1234 <room> ./theirfolder Friend

# 3. add an AI teammate
node agent-coord.js ws://localhost:1234 <room> MyAI
```

For a real session across cities, deploy the relay (see [DEPLOY.md](DEPLOY.md))
and drop `--local`. For the no-terminal experience, install the VS Code
extension in [`extension/`](extension/) (see [SETUP.md](SETUP.md)).

## How it works

| Layer | What it does |
|---|---|
| **CRDT (Yjs)** | Concurrent edits to the same spot always merge identically — text never corrupts. |
| **Relay (`server.js`)** | One WebSocket server, many isolated rooms (each project = a private unguessable link). |
| **Folder sync (`folder.js`)** | Mirrors a whole directory both ways: create, edit, delete, nested folders. |
| **Agent coordination** | The hard part — how multiple AI agents share files without chaos. |

### Agent coordination — the five guarantees

| Problem | Mechanism | File |
|---|---|---|
| Two edits to one spot corrupt the file | CRDT convergence | (Yjs) |
| Two AIs do the same task | Claim protocol | `agent-coord.js` |
| Two AIs need the same region | Region lease + intent | `agent-lease.js` |
| An AI reasons on code that then changed | Version-checked write | `safe-write-demo.js` |
| Two AIs need the same file — ask permission | Lock + negotiation | `agent-lock.js` |

A real Claude-powered editing agent lives in `agent-ai.js` (stub by default;
set `LIVECODE_AI=1` + `ANTHROPIC_API_KEY` for the real model).

## Files

- `server.js` — relay; `client.js` — single-file sync; `folder.js` — whole-folder sync
- `go.js` — one-command launcher (relay + tunnel + sync)
- `agent-coord.js` / `agent-lease.js` / `agent-lock.js` / `agent-ai.js` — agents
- `core.js` — shared, tested logic; `test.js` — `npm test` (18 tests)
- `extension/` — VS Code / Antigravity / Cursor extension

## Test

```bash
npm test
```

## Status

Working prototype: deployed relay, whole-folder sync, installable editor
extension, and a five-part agent-coordination model. See [IMPROVEMENTS.md](IMPROVEMENTS.md)
for the roadmap.
