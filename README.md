<h1>Hivecode</h1>

**Oversight and control for your AI coding agents.**

Run AI agents on your codebase and actually stay in control: **watch** every edit
live, **fence** each agent to the folders it's allowed in, **approve** the risky
moves, and **undo** any agent instantly. No git push/pull. Open source.

[**Install for VS Code**](https://marketplace.visualstudio.com/items?itemName=hivecode.hivecode)
· [**Website**](https://livecode-xoss.onrender.com)
· [Latest .vsix](https://github.com/GSK7024/livecode/releases)

---

## Why

You can't trust an AI agent blindly. The faster it edits, the more you have to
check — and the moment you run more than one, it gets worse: they touch files they
shouldn't, overwrite each other, and you lose track of who changed what. Today's
answer is to isolate each agent in a git worktree and pray at merge time — which
doesn't help you *trust* the output, it just defers the mess.

Hivecode adds the missing layer: **oversight and control.**

- **See everything** — a live Control Room (browser or phone) shows every agent and every file it touches, in real time.
- **Fence them in** — folder-scoped access the relay enforces; an out-of-scope agent never even receives the code.
- **Approve what matters** — gate risky work so nothing lands without your OK.
- **Undo anything** — instant rollback: restore any file, or revert *everything* one agent did.

It's **agent-neutral**: Claude Code, Cursor, Windsurf, or your own bot over MCP. No
git push/pull — edits sync in about a second.

---

## Documentation

To keep this README clean, we've modularized the documentation into separate files. Click below to read more about each specific topic:

- **[🔌 Connecting & Hosting Rooms](docs/CONNECTING_ROOMS.md)** - Learn how humans join rooms, how to host your own relay server, and how the self-certifying security model works.
- **[🤖 AI Agent Manual](docs/AI_AGENT_MANUAL.md)** - A guide written specifically for AI agents on how to download the MCP server, join a room, and behave within the hive.
- **[🏛️ Hivecode Architecture](docs/HIVECODE_EXPLAINED.md)** - A breakdown of the three core components, the CRDT data model, and how it scales.
- **[🧠 ICR (Intent-Centric Resolution)](docs/ICR_EXPLAINED.md)** - How our semantic AST-aware merge algorithm guarantees no lines are lost during multi-agent collisions.
- **[🔐 DCO (Deterministic Context Override)](docs/DCO_EXPLAINED.md)** - The core breakthrough paradigm that physically locks tools based on CRDT state, structurally preventing agent hallucination and drift. Includes our End-to-End Test Report.

---

## Development

```bash
npm install
node test.js          # unit tests
node hive-edge-test.js # adversarial / edge-case live tests
```

Other live suites: `hive-secure-test.js`, `hive-scope-test.js`, `hive-auth-test.js`,
`hive-readonly-test.js`, `hive-resume-test.js`, `hive-control-test.js`,
`hive-durable-revoke-test.js`, `hive-relay-robust-test.js`.

The extension source is in [`extension/`](extension/).

---

## License

MIT.
