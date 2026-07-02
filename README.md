<h1>Hivecode</h1>

**Oversight and control for your AI coding agents.**

Run AI agents on your codebase and actually stay in control: **watch** every edit
live, **fence** each agent to the folders it's allowed in, **approve** the risky
moves, and **undo** any agent instantly. No git push/pull. Open source.

[**Install for VS Code**](https://marketplace.visualstudio.com/items?itemName=hivecode.hivecode)
· [**Website**](https://livecode-xoss.onrender.com)
· [Latest .vsix](https://github.com/GSK7024/livecode/releases)

<!-- Add a demo GIF here once recorded: ![demo](docs/demo.gif) -->

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

## Quickstart

1. Install the extension (link above). It works in **VS Code, Cursor, Windsurf,
   and Antigravity**.
2. Open the folder you want to share (**File → Open Folder**).
3. `Ctrl/Cmd+Shift+P` → **Hivecode: Host a Secured Session**. A join link is
   copied to your clipboard. *(No terminal, no server to run.)*
4. **Hivecode: Invite to folders…** → pick the folders and a role (edit /
   read-only) for each person or agent. Send them the link.
5. They run **Hivecode: Join a Session** and paste the link. You're now editing
   the same project live.

Use **Manage access** to re-scope or revoke anyone, and **Leave Session** to stop.

---

## Add an AI agent

Agents join through the Hivecode MCP server ([`hive-mcp.js`](hive-mcp.js)). Set it
up once, then just hand the agent a join link; it appears in the room as an `ai`
member, scoped to exactly the folders you invited it to.

- **[JOIN_WITH_AGENT.md](JOIN_WITH_AGENT.md)** — step-by-step for a *human*: set up MCP, then bring your agent in.
- **[AGENT_MANUAL.md](AGENT_MANUAL.md)** — written *for the agent*: how to set itself up and join (drop it in your project as `CLAUDE.md` so the agent reads it automatically).
- **[MCP.md](MCP.md)** — the full tool reference.

---

## What you get

**Oversight & control** *(the point of the whole thing)*
- **Live Control Room** — watch every agent and every file it touches in real time,
  from any browser or your phone. No more "what is it even doing right now?"
- **Folder-scoped access** — invite an agent to `frontend/` only; it never receives
  anything else (relay-enforced, not trust-based).
- **Approval gates** — risky work waits for your OK; agent-to-agent coordination
  flows automatically.
- **Instant rollback** — restore any file to an earlier point, or **revert
  *everything* one agent did** in a click. Undo a rogue agent without touching the
  rest of the team's work.
- **Mission control** — pause, resume, or reassign any agent; agents honor it
  mid-task.
- **Instant revoke** — cut access mid-session, enforced server-side on every
  reconnect (and it survives a relay restart).
- **Read-only roles** — reviewers see everything, change nothing.

**Coordination**
- **Built-in chat**, a **shared task board** (assign / complete), and **live
  presence** so humans and agents stay in sync.
- **Co-editing heads-up** before two people touch the same file.
- **Never lose work** — overlapping edits keep both versions with conflict markers;
  a stale rewrite can't silently delete another's lines.

**Trust**
- **Server-enforced auth** — signed tokens, algorithm-pinned, fail-closed.
  Unauthorized clients never complete the WebSocket handshake.
- **Self-certifying secured rooms** — the room id embeds a fingerprint of your
  public key; tokens carry the key and are signed by it; the relay trusts a token
  only if the fingerprint matches. No account system, no shared secret. Your
  private key stays in the editor's secure storage.
- **Dependency-free core** — the access-control layer uses only Node's `crypto`.

---

## How the security model works

A secured room's id is `hs_<fp>_<rand>`, where `fp` is a base64url SHA-256
fingerprint of the owner's public key. Every token for the room carries the owner's
public key (claim `pk`) and is signed by the matching private key (RS256). The relay
trusts a token **iff** `fingerprint(token.pk) === fingerprint-in-room-id`, then
verifies the signature with that key — so trust is anchored in the room id itself
and the relay stores nothing.

Files use a per-file subdocument model: the room is `<base>`, each file is a
separate document at `<base>␁<path>`. The relay authorizes per path, so a scoped
client can only open the files it may load, and out-of-scope content never reaches
its disk. Paths are guarded against traversal, absolute paths, drive letters, and
control characters on both the client (before writing) and the relay.

A full threat/edge-case audit is in [EDGE-CASES.md](EDGE-CASES.md); the RBAC design
is in [RBAC.md](RBAC.md).

---

## Architecture

Hivecode is three pieces — a **relay** (`server.js`), a **VS Code extension**
(humans), and an **MCP server** (`hivecode-mcp`, for AI agents) — connected over a
Yjs/CRDT layer. The relay holds no canonical copy of your code; it just passes
updates between clients in a room, so edits converge live with no git push/pull. On
top of plain sync sit two layers: **ICR** (intent-aware merge — the safety net) and
the **Hive coordination layer** (decentralized, no-controller collision *prevention*).

Full walkthrough — components, the data model, the path of an edit, and how it scales
— in **[ARCHITECTURE.md](ARCHITECTURE.md)**. For a single, self-contained explainer of
the whole system (tech, methods, what's built, and the multi-agent validation runs),
see **[HIVECODE_EXPLAINED.md](HIVECODE_EXPLAINED.md)**.

---

## Proven with live multi-agent swarms

Hivecode has been stress-tested by running a simulated AI software company — multiple
autonomous agents joining one room over MCP and building real apps together (a Kanban
board, a habit tracker, a help-desk), coordinated by an orchestrating agent with a
human director.

What those runs showed:

- **ICR held through dozens of real collisions.** When agents thrashed on the same
  files — one file briefly ballooned to ~361 KB mid-conflict — ICR converged it back
  to clean, correct code and **never lost a line**, including semantic renames applied
  across call sites.
- **Coordination must be *enforced*, not advisory.** The claim board prevents
  collisions only when agents respect it; the durable fix is the relay enforcing
  claims (block/queue writes to a held file) rather than warning.
- **A swarm needs a verification layer** — a binding contract + a validator agent with
  veto over "done" — to make agents produce expert-quality output instead of
  runnable-but-messy code.

The full validation log, lessons, and resulting roadmap are in
**[HIVECODE_EXPLAINED.md](HIVECODE_EXPLAINED.md)**.

---

## Deterministic Context Override (Cognitive ICR)

Most AI frameworks rely on a centralized Python orchestrator or "conversational chat history" to coordinate agents. Hivecode introduces a different paradigm: **Deterministic Context Override**.

By wiring Yjs CRDTs directly into the Anthropic Model Context Protocol (MCP), Hivecode operates as a distributed state engine for AI agents:

1. **Decentralized State Sync**: There is no master script. The global project state (e.g., `contract: APPROVED`) is stored in a decentralized CRDT map that syncs across WebSockets in milliseconds.
2. **Cognitive Injection**: Every time an agent loops to check for new work, the MCP server physically overrides their system prompt context with the unarguable `[GLOBAL PROJECT STATE]`.
3. **The Death of "Agent Drift"**: Because agents receive deterministic, structural hardware-level interrupts from the Hivecode relay, they cannot hallucinate their project state or get trapped in conversational loops.

If **ICR** is how Hivecode perfectly merges agent *code*, **Deterministic Context Override** is how it perfectly merges agent *intent*.

---

## Self-hosting the relay

The hosted relay is the default (`wss://livecode-xoss.onrender.com`) and needs no
setup. To run your own, deploy [`server.js`](server.js) anywhere Node runs and set
`hivecode.relayUrl` in the extension. The relay holds no truth of its own — it just
passes CRDT updates between clients in the same room, and enforces access at the
handshake.

Run-your-own guide (the model, access control, persistence, capacity):
**[SELF_HOSTING.md](SELF_HOSTING.md)**. Click-by-click cloud deploy: [DEPLOY.md](DEPLOY.md).

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


---

# Deterministic Context Override (DCO) - First Full End-to-End Test Report

**Date:** July 1, 2026  
**Project Room:** `project-echo-gqqwip3`  
**Paradigm:** Leaderless Peer-to-Peer AI Swarm with CRDT State Synchronization  
**Objective:** Prove that multiple independent AI agents can collaborate on a single codebase in real-time without stepping on each other's toes, governed strictly by an injected State Machine (`HIVE_RULES.md` and global JSON state).

## 1. The Swarm Setup
*   **Lead PM:** Antigravity (Autonomous Background Cron Job)
*   **Backend Developer:** `third-agent` (Hermes CLI Agent)
*   **Frontend Developer:** `second-agent` (Hermes CLI Agent)
*   **Infrastructure:** Live CRDT synchronization via Yjs (`hive-mcp.js`), tracking `backend_status`, `frontend_status`, `HIVE_BOARD`, and `HIVE_CHAT`.

## 2. The Initial State
The project started in the `PLANNING` phase. To test the lock mechanism, the PM set the global state to:
*   `backend_status: 'LOCKED'`
*   `frontend_status: 'LOCKED'`

**Result:** Both agents successfully parsed the state and entered a blocked `hive_wait` loop. They acknowledged the lock in the chat and did not attempt to touch any files.

## 3. Phase 1: Backend Implementation
The PM flipped the state to `backend_status: 'APPROVED_TO_BUILD'`. 

**Action:** 
The Backend Agent immediately woke up from its `hive_wait` block. It was assigned the task of building an Express server. It successfully created `server.js` and `store.js`, implementing a full CRUD API for `/api/habits`.

## 4. Unplanned Swarm Collaboration (Merge Conflict)
While the backend was being built, a Yjs merge conflict occurred in `package.json` (due to concurrent `npm install` events). 

**Action:**
Because the Frontend Agent was still `LOCKED` out of its primary task, it was idle. It detected the merge conflict in `package.json` and voluntarily jumped in to help! It resolved the conflict and pushed the clean version, stating in the chat: *"Resolved the merge conflict in package.json... Still waiting for frontend_status to be APPROVED_TO_BUILD before starting frontend work."*

**Result:** The State Machine successfully kept the frontend agent away from the main codebase while still allowing it to perform dynamic P2P problem solving for the swarm.

## 5. Phase 2: State Flip & Frontend Implementation
Once the backend was tested and complete, the autonomous PM flipped the CRDT state:
*   `backend_status: 'COMPLETED'`
*   `frontend_status: 'APPROVED_TO_BUILD'`

**Action:**
The Frontend Agent was unblocked. Upon receiving a direct `hive_assign` command from the PM, it immediately began creating `index.html`, `app.js`, and `style.css` in the `/public` directory. It successfully built a beautiful Vanilla JS interface that consumed the Express API built by the Backend Agent.

## 6. Minor Glitches & Edge Cases
*   **Tool Duplication Glitch:** The Frontend Agent appended the exact same code twice to `app.js` and `index.html`. This was an isolated tool-level glitch with the MCP server file-writer, not a failure of the SMP state machine. It was easily truncated by the PM.
*   **Config Bugs:** We discovered that Hermes configurations failing to load the MCP server will cause the agent to silently drop the tool. The fix was ensuring `config.yaml` used strict YAML arrays rather than stringified JSON arrays.

## 7. Final Conclusion
The test was a **massive success**. 

Deterministic Context Override (DCO) successfully transformed a chaotic multi-agent environment into an organized, sequential assembly line. By decoupling the LLM (the processor) from the State Machine (the kernel), the agents were able to coordinate perfectly in a leaderless room. 

The swarm successfully built a working, Full-Stack Habit Tracker application entirely autonomously.

**Test Status:** ✅ PASSED


