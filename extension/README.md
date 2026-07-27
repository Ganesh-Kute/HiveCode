# Hivecode — oversight & control for AI coding agents

**You can't trust an AI agent blindly. Hivecode lets you watch it, fence it, gate
it, and undo it.** Run AI agents on your codebase and stay in control — see every
edit live, restrict each agent to the folders it's allowed in, approve the risky
moves, and roll back any agent instantly. No git push/pull; edits sync in ~1s.

> Isolating each agent in a git worktree doesn't help you *trust* the output — it
> just defers the merge. Hivecode adds the layer worktrees don't: real-time
> oversight and control over what every agent does.

---

## Why Hivecode

- 👀 **Live Control Room.** Watch every agent and every file it touches in real
  time — from any browser or your phone. No more "what is it even doing?"
- 🔐 **Folder-scoped access.** Invite an agent to `frontend/` only. It literally
  never receives the bytes for anything outside its scope — enforced by the relay,
  not by trust.
- ✅ **Approval gates.** Risky work waits for your OK. Agent-to-agent coordination
  flows automatically.
- ⏮️ **Instant rollback.** Restore any file to an earlier point, or **revert
  *everything* one agent did** in a click — undo a rogue agent without losing the
  rest of the team's work.
- 🎛️ **Mission control.** Pause, resume, or reassign any agent; it honors it
  mid-task.
- ✂️ **Instant revoke.** Cut someone's access mid-session; enforced server-side on
  every reconnect, and it survives a relay restart.
- 🤖 **Agent-neutral.** Claude Code, Cursor, Windsurf, or your own bot over MCP.
  Hivecode is the glue, not another model.
- ⚡ **Conflict-safe sync.** Yjs CRDTs: disjoint edits auto-merge; overlaps keep
  *both* versions — nobody's work is ever silently lost.

---

## Quick start

1. Open the folder you want to share (**File → Open Folder**).
2. `Ctrl/Cmd+Shift+P` → **Hivecode: Host a Secured Session**.
   A join link is copied to your clipboard.
3. **Hivecode: Invite to folders…** → pick the folders and a role (edit /
   read-only) for the person or agent. Send them the link.
4. They run **Hivecode: Join a Session** and paste the link — or an AI joins over
   MCP. You're now editing the same project live.

Run **Hivecode: Leave Session** to stop, or **Manage access** to re-scope or
revoke anyone at any time.

Works in **VS Code, Cursor, Windsurf, and Antigravity**.

---

## Adding an AI agent

Agents join through the Hivecode MCP server (`hive-mcp.js` in the repo). Point your
agent's MCP config at it, hand it the join link, and it appears in the room as an
`ai` member — scoped to exactly the folders you invited it to. See
[the repo](https://github.com/Ganesh-Kute/HiveCode) for MCP setup.

## Commands

| Command | What it does |
|---|---|
| **Host a Secured Session** | Start a room only your key can administer |
| **Host an Open Session** | Quick, no-auth room (good for a fast pairing) |
| **Join a Session** | Paste a link to join |
| **Invite to folders…** | Pick folders + role, get a scoped invite link |
| **Manage access** | Re-scope or revoke any member |
| **Leave Session** / **End Room** | Stop sharing / forget the room |

## How it stays safe

The access-control core is **dependency-free** (only Node's `crypto`), signed
tokens are **algorithm-pinned and fail-closed**, file paths are guarded against
traversal, and unauthorized clients never even complete the WebSocket handshake —
so they never receive a single byte of a room they can't access. Secured rooms are
*self-certifying*: your private key lives in the editor's secure storage and is
never written to a file or handed to anyone.

---

Free and open source (MIT). Source, issues, and the relay:
**https://github.com/Ganesh-Kute/HiveCode**
