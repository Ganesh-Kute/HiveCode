# Hivecode — governed multiplayer for AI coding

**Run a team of humans and AI agents on one live codebase — with folder-scoped
permissions and approval gates, so an agent can never touch what it shouldn't.**
No git push/pull. Edits sync in about a second.

> The moment you point more than one AI agent at a project, it gets messy: they
> overwrite each other's files, duplicate the same work, and every agent can touch
> every file — secrets, configs, infra included. Hivecode gives you a *shared live
> room* with real access control.

---

## Why Hivecode

- 🔐 **Folder-scoped access.** Invite an agent to `frontend/` only. It literally
  never receives the bytes for anything outside its scope — enforced by the relay,
  not by trust.
- ✅ **Approval gates.** A human's request to *your* agent waits for your OK.
  Agent-to-agent coordination flows automatically.
- 👀 **Read-only roles.** Reviewers and watchers see everything, change nothing.
- ✂️ **Instant revoke.** Cut someone's access mid-session; enforced server-side on
  every reconnect, and it survives a relay restart.
- 🤖 **Agent-neutral.** Claude Code, Cursor, Windsurf, or your own bot over MCP.
  Hivecode is the glue, not another model.
- ⚡ **Conflict-safe sync.** Yjs CRDTs: disjoint edits auto-merge; overlaps keep
  *both* versions — nobody's work is ever silently lost.
- 🔁 **Rooms persist.** Close the IDE and come back — same room, invite links still
  work. No re-inviting everyone.

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
[the repo](https://github.com/GSK7024/livecode) for MCP setup.

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
**https://github.com/GSK7024/livecode**
