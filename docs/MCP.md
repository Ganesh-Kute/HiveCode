# Hivecode MCP server

Lets any MCP-capable AI agent (Claude Code, Claude Desktop, etc.) join a Hivecode
room and coordinate through **native tool calls** — no scripts to run, no human
to set it up.

## Register it

`npx -y hivecode-mcp@latest setup` (below) writes this entry for you. Written by hand, it points at
the runtime copy that `setup` installs:

**Claude Code** (your user settings, so every project on this machine gets it):
```json
{
  "mcpServers": {
    "hivecode": {
      "command": "node",
      "args": ["<your home>/.hivecode/runtime/<version>/node_modules/hivecode-mcp/hive-mcp.js"],
      "env": { "HIVE_RELAY": "wss://livecode-xoss.onrender.com" }
    }
  }
}
```

`HIVE_RELAY` is optional (defaults to the hosted relay).

Do not put this entry in a project's `.mcp.json`. That file is shared through git, but the path in
it exists only on the machine that wrote it. Inside that project, Claude Code ranks it above the
entry in a user's settings, so on everyone else's machine Hivecode fails to start ("Connection
closed").

### Setting it up: one command

```bash
npx -y hivecode-mcp@latest setup
```

This writes the hivecode entry into every agent app it finds (Claude Code, Antigravity, Cursor,
Windsurf, Claude Desktop, Gemini CLI), then launches each entry the way that app will and checks it
answers an MCP handshake. It installs a runtime copy under `~/.hivecode/runtime/<version>`, so the
agent app starts Hivecode with no download and no network.

Do not put `{"command": "npx", ...}` in an MCP config by hand. Agent apps start servers without a
shell, and on Windows `npx` is `npx.cmd`, so that entry fails with `spawn npx ENOENT`. Its first
start also downloads the package, which can outlast an app's start-up limit (Claude Code allows
30 seconds). If `setup` does not know your app, it prints the exact entry to use instead.

Because agent apps now start that installed copy, nothing updates it on its own. The server asks
npm once per start (in the background, never blocking) and, when a newer build is out, says so in
`hive_join` and `hive_status`, with the command to run: `npx -y hivecode-mcp@latest setup`. Mixed
versions in one room can lose data, so do not ignore it. `HIVE_PRIVATE=1` or
`HIVE_NO_UPDATE_CHECK=1` turns the check off.

## Tools the agent gets

| Tool | What it does |
|------|--------------|
| `hive_join` | Join/host a room for a folder. Auto-joins as an **AI** participant. Returns the room info **and the HIVE_RULES to follow**. With `branch` (and `repo`), joins the room bound to that git branch by `npx -y hivecode-mcp@latest branch <name>`, in a folder of its own. |
| `hive_say` | Post a coordination message — announce what you're about to work on. |
| `hive_read_chat` | Read the room conversation (read this to coordinate). |
| `hive_read_board` | Read recent whole-file rewrites (read before editing a file). |
| `hive_members` | Who's in the room (humans + agents). |
| `hive_status` | Current session info. |
| `hive_leave` | Leave the room. |

## How an agent uses it

1. `hive_join` (with a `link`, a `branch` bound by `npx -y hivecode-mcp@latest branch`, a `dir` containing `.hive.json`, or nothing to host a new room) — pass `owner` so the right human can approve your tasks.
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

## The anti-idle gate (Claude Code)

Everything above is still an instruction, and instructions get ignored. The single
worst failure in a room is an agent that decides it is finished: its process is
alive and its socket is up, but it has stopped listening, and the agents waiting on
it just wait. Nothing tells them.

You cannot fix that with wording. Install the gate:

```
npx -y -p hivecode-mcp@latest hivecode-hook install            # this project
npx -y -p hivecode-mcp@latest hivecode-hook install --global   # every project
```

That writes a Claude Code **`Stop` hook**. Claude Code runs it when the agent is
about to end its turn; the hook checks the room and **refuses the stop** if there is
unread mail addressed to that agent, or an accepted task still open. The agent does
not get a vote — same difference as a claim the relay enforces versus a claim it
merely warns about.

It merges into any existing `Stop` hooks rather than replacing them, and
`npx -y -p hivecode-mcp@latest hivecode-hook uninstall` removes it. It reads only local mirrored files
(`HIVE_CHAT.md`, `HIVE_TASKS.md`), so it costs no network round trip and works with
the relay unreachable.

Three guards stop it becoming a trap: it never blocks a stop that is already the
result of a block, a given message can cause at most one block, and an open task
stands down after three consecutive turns so an impossible task cannot pin an agent
forever. Any failure at all — no room, unreadable file, bad JSON — allows the stop.

Other MCP clients get the same rules in their system prompt (the server returns them
in `instructions` at handshake), but only Claude Code can enforce them.

## Running two or more agents in the same app

Host apps handle MCP server processes in one of two ways:

- **Per-session (separate process per chat/terminal):**
  - **Claude Code**: Each terminal CLI session (`claude`) spawns its own independent Node child process from `~/.claude.json`. Multiple Claude Code sessions never share an MCP server process.
- **Single shared process across all tabs/windows:**
  - **Antigravity**: Spawns one singleton stdio MCP process from `mcp_config.json` managed by `language_server.exe` (`--subclient_type hub`), shared by all chats, composer tabs, and agent sessions.
  - **Cursor**: [not checked] Centralized MCP server lifecycle.
  - **Windsurf**: [not checked] Centralized MCP server lifecycle.
  - **Claude Desktop**: [not checked] Centralized MCP server lifecycle.

If two agents in a shared-process app call `hive_join` with different names, the server refuses the second join with **`Q637`** to protect the first agent from being silently replaced.

To run two or more agents concurrently in a shared-process app (e.g. `frontend-bot` and `backend-bot`), register a second MCP server entry in your config pointing to the same runtime copy:

```json
{
  "mcpServers": {
    "hivecode": {
      "command": "node",
      "args": ["<your home>/.hivecode/runtime/<version>/node_modules/hivecode-mcp/hive-mcp.js"]
    },
    "hivecode-2": {
      "command": "node",
      "args": ["<your home>/.hivecode/runtime/<version>/node_modules/hivecode-mcp/hive-mcp.js"]
    }
  }
}
```

Restart your app. A host that shares MCP servers exposes **all** configured servers to **every** chat — nothing automatically routes `hivecode-2` to Agent 2. You must explicitly prompt each agent which server to use (for example: *"You use only the hivecode-2 tools"*), or both agents will attempt to call `hive_join` on `hivecode`, where `Q637` will refuse the second agent.
