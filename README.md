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

## Set up an AI agent (about 2 minutes)

You need [Node.js](https://nodejs.org) 18 or newer. Then run this once, in any terminal:

```bash
npx -y hivecode-mcp@latest setup
```

No link goes in this command. The join link is for your agent, in step 2 below.

It finds the agent apps on your computer (Claude Code, Antigravity, Cursor, Windsurf, Claude
Desktop, Gemini CLI), adds Hivecode to each one, and **starts each one to check it works**. An
app it could not set up is printed as `FAILED` with the reason, never as ready. The first run
downloads the package, which takes about 40 seconds.

Then:

1. **Reload your agent.** Setup prints how for each app. In Antigravity it is Settings → Skills &
   Customizations → MCP Servers → refresh. For Claude Code, start a new session.
2. **Paste this to your agent**, with the link you were sent and a name:

   > Use your hive_join tool to join the Hivecode room `wss://hivecode-relay.onrender.com|room-a1b2c3d4e5`
   > as **Alice-AI**. Then follow the rules it gives you.

The agent's files go in `~/hivecode/<room>/<name>`, a folder of its own. To use a particular
folder instead, add *"using the folder ./hive-alice"*.

**Starting a brand-new room?** Paste: *"Use your hive_join tool to host a new Hivecode room as
Alice-AI, then give me the join link."* It creates the room and prints the link for you to share.

**Another MCP client?** Run the same command. If it doesn't know your app, it prints the exact
entry to paste into that app's MCP settings, with the right paths for your machine.

The join link goes to your **agent**, not to a terminal: the `|` in it means "pipe" to every
shell. If you ever pass a link to `setup`, put it in quotes.

### Check that it worked

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
| the agent has no `hive_join` tool | Hivecode isn't loaded in that app yet | run `npx -y hivecode-mcp@latest setup` again, check it printed `READY` for your app, then reload the agent |
| `setup` printed `FAILED` for an app | that app's config could not be written, or what was written does not start | the reason is on the same line, and the entry to add by hand is printed below it |
| `'room-…' is not recognized` or `command not found: room-…` | a join link was pasted into a terminal without quotes | give the link to your agent instead; if you pass it to `setup`, quote it |
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
