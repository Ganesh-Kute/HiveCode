# Launch posts — "oversight & control" angle

Messaging is built around the #1 pain real devs voice (from HN research): you can't
*trust* what an AI agent does, and the moment you run more than one you lose track.
Lead with **oversight / control / undo**, not "multiplayer" or "speed." Be humble —
it's early, ask for feedback, don't overclaim.

---

## Hacker News — Show HN

**Title:**
Show HN: Hivecode – watch, fence, and roll back your AI coding agents

**Body:**
I kept hitting the same wall running coding agents: the faster they edit, the more I
have to verify, and the moment I ran two at once I lost track of who changed what —
and one would happily touch files it had no business in.

The popular answer is to isolate each agent in its own git worktree, but that never
helped me *trust* the output — it just moved the mess to merge time. What I actually
wanted was oversight: to see what each agent was doing, stop it before it touched
the wrong thing, and undo it when it went sideways.

So I built Hivecode. Humans and AI agents work on one live codebase (Yjs CRDT, edits
sync in ~1s, no git push/pull), and you get a control layer on top:

- **Live Control Room** (browser or phone) — every agent and every file it touches, in real time.
- **Folder-scoped access** — an agent invited to `frontend/` literally never receives bytes outside it; the relay enforces it, it's not trust-based.
- **Approval gates** — risky work waits for your OK; agent-to-agent coordination flows on its own.
- **Instant rollback** — restore any file, or revert *everything* one agent did, without losing the rest of the team's work.

Agents join over MCP (Claude Code, Cursor, Windsurf, or your own bot) — it's
agent-neutral, it's the glue, not another model. The access-control core is
dependency-free (Node `crypto`); secured rooms are self-certifying (the room id is a
fingerprint of your key, the relay stores nothing). You can self-host the relay.

It's open source (MIT) and early — I'd genuinely like feedback on whether the
oversight model is the right shape, and where it breaks for you.

Repo: https://github.com/GSK7024/HiveCode
Install (VS Code/Cursor/Windsurf): <Marketplace link>

---

## Reddit — r/ClaudeAI (or r/ChatGPTCoding / r/cursor)

**Title:**
I couldn't see or undo what my Claude agents were doing, so I built oversight for them

**Body:**
Running one agent is fine. Running two on the same repo got messy fast for me — they
overwrote each other, one edited stuff it shouldn't have, and I couldn't tell what
either was doing without diffing everything afterward.

Git worktrees (the usual advice) isolate them, but that doesn't help me *trust* the
output — it just defers the merge pain.

I built **Hivecode** to add the missing layer: oversight and control.
- A **live Control Room** (works on your phone too) showing every agent + every file it touches, as it happens.
- **Folder fences** — scope an agent to just the folders it's allowed in; it never even receives the rest of the code.
- **Approval gates** — gate the risky stuff so nothing lands without your OK.
- **One-click rollback** — restore a file, or undo *everything* one agent did, while keeping everyone else's work.

Works with Claude Code / Cursor / Windsurf via MCP. Open source, free, self-hostable.

It's early and I want honest feedback — does this match how you'd want to supervise
agents, or am I solving the wrong half of the problem?

GitHub: https://github.com/GSK7024/HiveCode

---

## X / Twitter — short thread

**1/**
You can't trust an AI coding agent blindly.
The faster it edits, the more you verify. Run two and you lose track entirely.

Worktrees isolate them — but that doesn't help you *trust* the output. It defers the mess.

So I built oversight for agents. 🧵

**2/**
Hivecode gives you control over agents on one live codebase:
👀 watch every edit live (Control Room, even on your phone)
🔐 fence each agent to its folders (it never sees the rest)
✅ approve the risky moves
⏮️ undo *everything* one agent did, in a click

**3/**
Agent-neutral — Claude Code, Cursor, Windsurf, or your own bot over MCP.
Open source, free, self-hostable. No git push/pull; edits sync in ~1s.

Early and looking for feedback 👉 https://github.com/GSK7024/HiveCode

---

### Posting notes
- Replace `<Marketplace link>` and confirm the repo URL (GitHub now redirects to /HiveCode).
- HN: post Tue–Thu morning US time; reply fast to every comment; never argue, ask questions.
- Lead with the *problem* in the first sentence everywhere. The features are proof, not the pitch.
- Have the 60-sec demo ready to drop in the first comment — the research showed people "get it" by *seeing* it.
