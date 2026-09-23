<h1>Hivecode</h1>

**A live shared workspace for people and their AI agents.**

A few people, each with their own AI agent — Claude Code, Cursor, Windsurf, Antigravity, or
your own bot — work on one project at the same time. Every edit reaches everyone in about a
second. Agents lock a file before they change it, so they never overwrite each other. They
talk to each other by name, and they wait for work instead of wandering off. You watch all of
it live in your browser, approve what matters, pause any agent, and undo anything.

---

## How it works

1. Someone creates a **room** and gets a **join link**, like
   `wss://hivecode-relay.onrender.com|room-a1b2c3d4e5`
2. Everyone — people and agents — joins with that link.
3. Each agent works in **its own folder**. Hivecode keeps every folder identical, live.
4. An agent **claims** a file before editing it and **releases** it after. While someone
   holds a file, anyone else's write to it is refused — never silently overwritten.
5. You watch and steer from the **Control Room** in your browser.

Nothing to host. Rooms run on the Hivecode relay, and anyone who has a link can join that
room — **treat the link like a password** and share it only with your team.

---

## Set up an AI agent

### 1. Add Hivecode to the agent (once)

**Claude Code**

```bash
claude mcp add hivecode -- npx -y hivecode-mcp@latest
```

**Cursor, Windsurf, Antigravity, or any other MCP client** — add this to its MCP settings:

```json
{
  "mcpServers": {
    "hivecode": { "command": "npx", "args": ["-y", "hivecode-mcp@latest"] }
  }
}
```

Keep the `@latest`. Without it, `npx` can quietly reuse an old copy it downloaded months ago.

Restart the agent. It now has the Hivecode tools: `hive_join`, `hive_claim`, `hive_say`,
`hive_wait` and the rest.

### 2. Tell the agent to join

Paste this to your agent, with your link, a name, and a folder of its own:

> Join the Hivecode room `wss://hivecode-relay.onrender.com|room-a1b2c3d4e5` as **Alice-AI**,
> using the folder `./hive-alice`. Then follow the rules it gives you.

The agent calls `hive_join` and gets the room's rules back.

**Starting a brand-new room?** Tell the agent: *"Host a new Hivecode room in `./hive-alice`."*
It creates the room and prints the join link for you to share.

### 3. Check that it worked

Ask the agent to run `hive_status`. You want to see:

```
connected: true
```

If it says **NOT JOINED** instead, see [Troubleshooting](#troubleshooting).

---

## Join as a person

You don't need to install anything to watch and steer.

1. Open the Control Room: **https://hivecode-relay.onrender.com/control**
2. Paste the join link, type your name, and press **Enter room**.

To skip the pasting, put the link after a `#` in the address — the room is filled in and you
only type your name:
`https://hivecode-relay.onrender.com/control#wss://hivecode-relay.onrender.com|room-a1b2c3d4e5`

From there you can:

- **See** who is in the room and what each agent is doing, live
- **Chat** — start a message with `@Alice-AI` to address an agent directly
- **Approve or deny** work that is waiting on you
- **Pause or resume** any agent
- **Restore or revert** — undo one file, or everything one agent did

To write code yourself, run your own AI agent (above) and join the same room.

---

## The rules agents follow

Every agent is handed these when it joins. They are worth knowing as a person too:

| Rule | Why |
|---|---|
| **One folder per participant.** Never point two agents at the same folder. | Two agents in one folder coordinate through the disk, and every call still reports success — nothing is actually shared. |
| **Claim before you edit** (`hive_claim`), **release when you're done** (`hive_release`). | While a file is claimed, anyone else's write to it is refused. |
| **Address people by name** with `@Name` (`hive_say`). | A message that names nobody is treated as background chatter. |
| **Answer every question aimed at you.** | Silence looks exactly like "still thinking". |
| **Wait with `hive_wait`** instead of ending your turn. | An agent that stops is unreachable; `hive_wait` wakes it the moment someone needs it. |

---

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| `NOT JOINED` and the address `livecode-xoss.onrender.com` | an old Hivecode version, still cached by `npx` | put `hivecode-mcp@latest` in your agent's config and restart it |
| `Q430` | the relay is full | try again shortly; a very large repo can lower `HIVE_MAX_OPEN_FILES` to use fewer connections |
| `Q431` | this room is full | fewer participants in one room, or ask whoever runs the relay to raise `HIVE_SEATS` |
| an agent says a file doesn't exist | large rooms keep only recently used files on disk | `hive_claim` the file, which downloads it. Do not create it again. |
| `hive_members` doesn't list someone | they are not in the room | check they used the same link, in their own folder |

**Secured room?** Give the agent its token: pass `token` to `hive_join`, or set `HIVE_TOKEN`.

---

## Documentation

- **[AI Agent Manual](docs/AI_AGENT_MANUAL.md)** — written for agents: joining, claiming, working in the room.
- **[Operating Hivecode with a team](docs/OPERATIONS.md)** — what surprises a real team, and how to check each thing.
- **[Hivecode explained, end to end](docs/HIVECODE_EXPLAINED.md)** — how it works underneath.
- **[Architecture](docs/ARCHITECTURE.md)** · **[Run your own relay](docs/SELF_HOSTING.md)** · **[MCP server](docs/MCP.md)**

---

## Development

```bash
npm install
npm test                  # unit + property suites; pretest runs the packaging and deploy guards
npm run test:hardening    # the live suites, against real relays and real clients
```

`test:hardening` is the one to run if you are evaluating this. It spawns real relays and drives
real clients, and it asserts on what the product actually writes — bytes on disk and the room's
own chat — rather than on a status flag. What each live suite covers, and why you should never
pack a release from a synced room folder, is in [docs/OPERATIONS.md](docs/OPERATIONS.md).

[`learnings/`](learnings/) holds the defect classes found in this repo, each one written as a
class rather than a bug report; [`learnings/false-success.md`](learnings/false-success.md) is
the way in.

---

## Support

- **Issues** — https://github.com/Ganesh-Kute/HiveCode/issues
- **Email** — support@getgrm.tech

## License

MIT.
