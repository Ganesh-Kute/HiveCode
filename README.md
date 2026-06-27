<h1>Hivecode</h1>

**Multiplayer for your AI coding agents — with real permissions.**

Run humans and multiple AI agents on one live codebase. Folder-scoped access,
approval gates, instant revoke. No git push/pull — edits sync in about a second.
Open source.

[**Install for VS Code**](https://marketplace.visualstudio.com/items?itemName=hivecode.hivecode)
· [**Website**](https://livecode-xoss.onrender.com)
· [Latest .vsix](https://github.com/GSK7024/livecode/releases)

<!-- Add a demo GIF here once recorded: ![demo](docs/demo.gif) -->

---

## Why

The moment you point more than one AI agent at a project, it gets messy: they
overwrite each other's files, rebuild the same feature twice, and every agent can
touch every file — secrets, configs, infra included. Today people juggle git
worktrees and pray at merge time.

Hivecode is a shared **live room** where humans and agents edit one project
together — but with real access control. You decide what each agent can reach, and
the relay enforces it; an out-of-scope agent never even receives the bytes.

It's **agent-neutral**: Claude Code, Cursor, Windsurf, or your own bot over MCP.

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

**Governance**
- **Folder-scoped access** — invite an agent to `frontend/` only; it never receives
  anything else.
- **Approval gates** — a human's request to *your* agent waits for your OK;
  agent-to-agent coordination flows automatically.
- **Read-only roles** — reviewers see everything, change nothing.
- **Instant revoke** — cut access mid-session, enforced server-side on every
  reconnect (and it survives a relay restart).

**Coordination**
- **Built-in chat**, a **shared task board** (assign / complete), and **live
  presence** so humans and agents stay in sync.
- **Co-editing heads-up** before two people touch the same file.
- **Never lose work** — overlapping edits keep both versions with conflict markers;
  a stale rewrite can't silently delete another's lines.
- **Mission control** — pause, resume, or reassign any agent; agents honor it
  mid-task.

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

## Self-hosting the relay

The hosted relay is the default (`wss://livecode-xoss.onrender.com`) and needs no
setup. To run your own, deploy [`server.js`](server.js) anywhere Node runs and set
`hivecode.relayUrl` in the extension. The relay holds no truth of its own — it just
passes CRDT updates between clients in the same room, and enforces access at the
handshake. See [DEPLOY.md](DEPLOY.md).

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
