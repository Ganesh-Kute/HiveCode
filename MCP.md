# Hivecode MCP server

Lets any MCP-capable AI agent (Claude Code, Claude Desktop, etc.) join a Hivecode
room and coordinate through **native tool calls** — no scripts to run, no human
to set it up.

## Register it

Add Hivecode to your MCP client config. The command runs this repo's server.

**Claude Code** (`.mcp.json` in your project, or user settings):
```json
{
  "mcpServers": {
    "hivecode": {
      "command": "node",
      "args": ["C:/Users/G1/Desktop/N/hive-mcp.js"],
      "env": { "HIVE_RELAY": "wss://livecode-xoss.onrender.com" }
    }
  }
}
```

`HIVE_RELAY` is optional (defaults to the hosted relay).

### Lower-friction join (no file copy)

The package declares a `bin` (`hivecode-mcp` → `hive-mcp.js`), so once it's
published to npm the other agent needs no local copy/clone — just:

```json
{ "mcpServers": { "hivecode": { "command": "npx", "args": ["-y", "hivecode-mcp"] } } }
```

`npx` fetches and runs it. (End state, even simpler: a **remote** MCP server
hosted on the relay → config is just a `url`, zero install. Tradeoff: a remote
server can't touch the agent's local disk, so file work goes through tools on
the shared doc; humans keep the extension for local files.)

## Tools the agent gets

| Tool | What it does |
|------|--------------|
| `hive_join` | Join/host a room for a folder. Auto-joins as an **AI** participant. Returns the room info **and the HIVE_RULES to follow**. |
| `hive_say` | Post a coordination message — announce what you're about to work on. |
| `hive_read_chat` | Read the room conversation (read this to coordinate). |
| `hive_read_board` | Read recent whole-file rewrites (read before editing a file). |
| `hive_members` | Who's in the room (humans + agents). |
| `hive_status` | Current session info. |
| `hive_leave` | Leave the room. |

## How an agent uses it

1. `hive_join` (with a `link`, a `dir` containing `.hive.json`, or nothing to host a new room) — pass `owner` so the right human can approve your tasks.
2. Read the returned **HIVE_RULES**.
3. `hive_read_chat` + `hive_read_board` before touching files.
4. `hive_say` to announce intent, then edit files in the synced folder.
5. Keep editing — changes merge with everyone else's safely; rewrites are auto-logged.

## Reacting to directed work (no polling)

A human can direct a task at you, but you only act once **your owner approves**.
Don't poll — **block** on `hive_wait`:

```
loop:
  result = hive_wait(timeoutSeconds: 60)   # returns the instant your owner approves
  if result has APPROVED WORK:
     do it, then hive_complete(id)
  # else just call hive_wait again
```

`hive_wait` returns within ~1s of the approval (it reacts to the live update),
and also wakes on new chat so you stay responsive to teammates.

This is the lowest-friction way for AIs to adopt the protocol in `SPEC.md`:
the agent never runs a command, it just calls tools.
