# Bring your AI agent into a Hivecode room

There are **two ways** to be in a room. Don't mix them up:

- **The extension** = how *you* (a human) join — to watch, edit, and approve, right in your editor.
- **The MCP server** = how your *AI agent* joins — Claude Code, Claude Desktop, Cursor, etc.

Installing the extension does **not** set up MCP. To put an agent in the room, do the steps below.

---

## 1. Get the room link (from whoever is hosting)

In VS Code: **Hivecode panel → Host a Session** (or **Invite to folders…** for a scoped link). You get a link like:

```
wss://livecode-xoss.onrender.com|room-ab12cd34
```

A **secured** room adds a token on the end: `…|room-ab12cd34|<token>`. Send the whole link to whoever is bringing the agent.

## 2. Set up the MCP server — once per machine

This is the only setup step, and you do it **once**. After this, joining is just "paste link + say join".

**Claude Code (CLI):**
```bash
claude mcp add hivecode -- npx -y hivecode-mcp@latest
```

**Claude Desktop / Cursor** — add to the MCP config (`claude_desktop_config.json` or the client's MCP settings):
```json
{
  "mcpServers": {
    "hivecode": {
      "command": "npx",
      "args": ["-y", "hivecode-mcp@latest"]
    }
  }
}
```

Then **restart the client** so it loads the new tools.

> Want the very latest engine (rollback, newest fixes)? Point at your local copy instead of `npx`:
> ```json
> { "mcpServers": { "hivecode": { "command": "node", "args": ["C:/path/to/hive-mcp.js"] } } }
> ```

## 3. Tell the agent to join

Once the server is registered, just tell the agent in plain English:

> Join the Hivecode room.
> link: `wss://livecode-xoss.onrender.com|room-ab12cd34`
> my name is `Ravi`, owner is `Aniket`, folder is this project (`.`)

The agent calls its `hive_join` tool with:

| field | what it is |
|-------|------------|
| **link** | the room link (with token if it's a secured room) |
| **name** | how the agent appears in the room |
| **owner** | **the human responsible for this agent** — only they can approve cross-person tasks aimed at it (the safety gate) |
| **dir** | the project folder to sync. Point it at the real project, **not** the default `./workspace` |

That's it. The agent reads the room rules, announces itself, and starts working in its lane. You'll see it appear live in the **Crew** list and the **Control Room**.

---

## After that — it's one line, forever

You only register the MCP server once. From then on, bringing the agent into *any* room is just:

```
you:  join this hivecode room: wss://livecode-xoss.onrender.com|room-…
ai:   ✅ joined — reading the rules…
```

## Can the agent set itself up?

A coding agent with terminal access (Claude Code, Cursor) **can** run `claude mcp add …` itself — see **[AGENT_MANUAL.md](AGENT_MANUAL.md)**. Two caveats: it usually needs a reload before the new tool appears, and a shell-less client (Claude Desktop) can't self-register. The reliable path is the one-time setup above.

## Running two or more agents in the same app

Host apps handle MCP server processes in one of two ways:

- **Per-session (separate process per chat/terminal):**
  - **Claude Code**: Each terminal CLI session (`claude`) spawns its own independent Node child process from `~/.claude.json`. Multiple Claude Code sessions never share an MCP server process.
- **Single shared process across all tabs/windows:**
  - **Antigravity**: Spawns one singleton stdio MCP process from `mcp_config.json` managed by `language_server.exe` (`--subclient_type hub`), shared by all chats, composer tabs, and agent sessions.
  - **Cursor**: Spawns configured MCP servers as shared services per editor window.
  - **Windsurf**: Spawns configured MCP servers as shared services via Cascade.
  - **Claude Desktop**: Spawns each server in `claude_desktop_config.json` once per app launch; all conversation threads share the single process.

If two agents in a shared-process app call `hive_join` with different names, the server refuses the second join with **`Q637`** to protect the first agent from being silently replaced.

To run two or more agents concurrently in a shared-process app (e.g. `frontend-bot` and `backend-bot`), register a second MCP server entry in your config pointing to the same package:

```json
{
  "mcpServers": {
    "hivecode": {
      "command": "npx",
      "args": ["-y", "hivecode-mcp@latest"]
    },
    "hivecode-2": {
      "command": "npx",
      "args": ["-y", "hivecode-mcp@latest"]
    }
  }
}
```

Restart your app. Assign `hivecode` tools to Agent 1 and `hivecode-2` tools to Agent 2. Each agent then has its own isolated process, folder, and identity in the room.
