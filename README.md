<h1>Hivecode</h1>

**Oversight and control for your AI coding agents.**

Run AI agents on your codebase and actually stay in control: **watch** every edit
live, **fence** each agent to the folders it's allowed in, **approve** the risky
moves, and **undo** any agent instantly. No git push/pull. Open source.

[**Install for VS Code**](https://marketplace.visualstudio.com/items?itemName=hivecode.hivecode)
· [**Website**](https://hivecode.vercel.app)
· [Latest .vsix](https://github.com/Ganesh-Kute/HiveCode/releases)

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

## Proof

The hard part is what happens when two agents edit the same file. Git compares lines, so
a rename on one side and a new call site on the other merge with no conflict — and ship a
crash. **ICR**, our merge engine, compares structure and intent instead.

Measured on [CooperBench](https://arxiv.org/abs/2601.13295) (Stanford, 2026), which gives
two agents independent features on one repo and scores the result by running **both**
features' own test suites. Of its 652 gold pairs — professional human patches, the
cleanest possible input — **505 conflict under git**:

| Merge layer | Of those 505, integrated cleanly | Passes both test suites |
|---|---|---|
| `git merge` | 0 (0%) | — |
| mergiraf 0.18 | 56 (11.1%) | — |
| **ICR** — safe default | **112 (22.2%)** | **100%** (27/27) |
| **ICR** — union mode | **206 (40.8%)** | **96.2%** (50/52) |

Three more independent checks:

- **279 real conflicts humans already resolved** — compared against what the maintainer
  actually committed: ICR matched 87, mergiraf 64, zero broken outputs, ICR ahead on all
  five repositories.
- **[ConGra](https://arxiv.org/abs/2409.14121), 6,430 real Python conflicts** verified with
  CPython's own `ast.parse`: 32.1% resolved vs mergiraf's 31.8%, with **zero crashes and
  zero parse-guarantee violations**.
- **Properties, not examples** — symmetry (`M(b,x,y) = M(b,y,x)`), fixed-point, no-loss and
  the parse guarantee, under seeded fuzz across 20+ languages: 13,000+ assertions, green.

Reproduce any of it: the harnesses are in [`scripts/`](scripts/) and the raw receipts in
[`data/`](data/).

```bash
npx git-clash scan      # audit YOUR repo's merge history for silent breaks
npm i icr-merge         # the engine: library, CLI, and git merge driver (MIT)
npx hivecode-mcp        # the live medium, as MCP tools for any agent
```

---

## Documentation

To keep this README clean, we've modularized the documentation into separate files. Click below to read more about each specific topic:

- **[🔌 Connecting & Hosting Rooms](docs/CONNECTING_ROOMS.md)** - Learn how humans join rooms, how to host your own relay server, and how the self-certifying security model works.
- **[🤖 AI Agent Manual](docs/AI_AGENT_MANUAL.md)** - A guide written specifically for AI agents on how to download the MCP server, join a room, and behave within the hive.
- **[🏛️ Hivecode Explained, end to end](HIVECODE_EXPLAINED.md)** - The full course: every mechanism motivated, explained, and shown with worked examples and runnable code — CRDT internals, the ICR pipeline, provenance, the benchmarks.
- **[🧠 ICR (Intent-aware Code Replication)](docs/ICR_EXPLAINED.md)** - How our semantic AST-aware merge algorithm guarantees no lines are lost during multi-agent collisions.
- **[🔐 DCO (Deterministic Context Override)](docs/DCO_EXPLAINED.md)** - The core breakthrough paradigm that physically locks tools based on CRDT state, structurally preventing agent hallucination and drift. Includes our End-to-End Test Report.
- **[🔗 The Substrate](docs/SUBSTRATE.md)** - A governed *medium* (not a channel) for multi-agent code: every change is a signed `(intent, patch, provenance)` triple, and the medium guarantees it converges, never regresses, and is provenance-verified — enforced by the relay, with no controller. Runnable + testable in one command.

---

## Development

```bash
npm install
node tests/test.js     # unit tests
node hive-edge-test.js # adversarial / edge-case live tests

npm run test:substrate:all   # the substrate: 4 suites (core + live + enforcement + content authority)
```

Other live suites: `hive-secure-test.js`, `hive-scope-test.js`, `hive-auth-test.js`,
`hive-readonly-test.js`, `hive-resume-test.js`, `hive-control-test.js`,
`hive-durable-revoke-test.js`, `hive-relay-robust-test.js`.

The extension source is in [`extension/`](extension/).

---

## License

MIT.
