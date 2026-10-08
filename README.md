<h1>Hivecode</h1>

**An operating system for AI agents that share a workspace.**

A few people, each with their own AI agent — Claude Code, Antigravity, another app that speaks
MCP, or your own bot — work on one project at the same time. Every edit reaches everyone in about
a second. Agents lock a file before they change it, so they never overwrite each other. They
talk to each other by name, and they wait for work instead of wandering off. You watch all of
it live in your browser, approve what matters, pause any agent, and put any file back to an
earlier point.

---

## How it works

1. Someone creates a **room** and gets a **join link**, like
   `wss://hivecode-relay.onrender.com|room-a1b2c3d4e5`
2. Everyone — people and agents — joins with that link.
3. Each agent works in **its own folder**. Hivecode keeps every folder identical, live.
4. An agent **claims** a file before editing it and **releases** it after. While someone
   holds a file, anyone else's write to it is refused — never silently overwritten.
5. You watch and steer from the **Control Room** in your browser.
6. A file someone deletes is deleted for everyone, but every other folder keeps a copy in
   `.hive-deleted/` for 7 days. A folder that disappears, or empties all at once, deletes nothing.

Nothing to host. Rooms run on the Hivecode relay, and anyone who has a link can join that
room — **treat the link like a password** and share it only with your team.

---

## Your code: where it goes, and who can see it

Read this before you join from a real project.

- **Your shared files go to the relay and to everyone in the room.** The default relay is run by
  the Hivecode author, not by you. Files travel over an encrypted connection (`wss://`), and the
  relay keeps a copy so the room survives everyone going offline. Your agent's `hive_join` says
  which relay it is using every time, and whose it is.
- **The link is the key.** Anyone who has it can read and change every file in the room. Share
  it like a password. If it leaks, start a new room. Let your agent host the room, so its name is
  random: a name you type yourself, like `myteam`, can be guessed, and on our relay your agent is
  warned when it joins one.
- **These never leave your machine:** anything your `.gitignore` files ignore, `.git/`,
  `node_modules/`, `.env` and `.env.*`, keys and certificates (`*.pem`, `*.key`, `*.p12`, `*.pfx`,
  `*.p8`, `*.ppk`, `*.jks`, `*.keystore`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`), and login
  files (`.envrc`, `.netrc`, `.git-credentials`, `.pypirc`).
- **A key pasted into an ordinary file stays too.** If a file holds an API key or token the room
  does not already have (OpenAI, Anthropic, GitHub, GitLab, AWS, Stripe, Slack, npm, Hugging Face,
  Groq, SendGrid, DigitalOcean, or a private key), Hivecode keeps that file on your machine and
  tells you and your agent which file, and which line. Your agent's `hive_edit` says so too, rather
  than reporting the file as shared. Move the key into `.env` and the file is shared on its next save.
- **What the others in the room can do:** change any shared file, which then changes in your
  folder too (claims stop two agents colliding, not a teammate), and message your agent, which acts
  on it. Hivecode never runs anything on your machine, but what they write lands on your disk.
  Invite only people you would let push to your repository.
- **For code that must never leave your own machines,** run your own relay: `npx hivecode-relay`
  (see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)). Then nothing goes to ours.

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
downloads the package, which takes about 10 seconds.

Then:

1. **Reload your agent.** Setup prints how for each app. In Antigravity it is Settings → Skills &
   Customizations → MCP Servers → refresh. For Claude Code, start a new session.
2. **Paste this to your agent**, with the link you were sent and a name:

   > Use your hive_join tool to join the Hivecode room `wss://hivecode-relay.onrender.com|room-a1b2c3d4e5`
   > as **Alice-AI**. Then follow the rules it gives you.

The agent's files go in `~/hivecode/<room>/<name>`, a folder of its own. To use a particular
folder instead, add *"using the folder ./hive-alice"*.

**Starting a brand-new room?** Paste: *"Use your hive_join tool to host a new, empty Hivecode
room as Alice-AI, then give me the join link."* It creates an empty room and prints the link for
you to share.

**Bringing your project in?** Run `npx -y hivecode-mcp@latest branch fix-login` in the repo
instead: see [Work on a git branch](#work-on-a-git-branch). Setup prints this line for you when
you run it inside a repo.

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
- **Restore or revert** — put one file back to an earlier point, or roll back every file one
  agent touched. A revert takes each of those files back to before that agent's first edit, so
  anyone else's later edits in them go too.

To write code yourself, run your own AI agent (above) and join the same room.

---

## Work on a git branch

In a git repository, one command gives a branch its own room:

```bash
npx -y hivecode-mcp@latest branch fix-login
```

It creates the branch `fix-login` if it doesn't exist yet (your checkout is not switched), creates
a room for it, fills the room with the branch's files, checks that a newcomer receives every one
of them, and prints three lines: one for your agents, one for teammates, and one for when the
work is done.

- **Your agents:** *"Use hive_join with branch `fix-login`, repo `<path to the repo>`, as a name
  of your own (each agent picks a different one)."* Each agent gets its own folder holding the
  branch. Files a room does not carry (binaries, files over 1 MB, and any committed file that holds
  a key or token) are filled in from git instead.
- **A teammate**, in their own clone, after running setup once:
  `npx -y hivecode-mcp@latest branch fix-login --join "<link>"`, then the same line for their agents.
- **When the work is done:**

  ```bash
  npx -y hivecode-mcp@latest pr fix-login
  ```

  This lands the room's work on `fix-login` as one commit per agent, with each agent as the git
  author. Files the agents deleted are deleted too. Add `--pr` to push the branch and open the
  pull request (this needs [`gh`](https://cli.github.com)).

The room's folders are deliberately **not git checkouts**: git refuses to run in them, so no
`checkout`, `stash` or `clean` can rewrite files your teammates are working on. Work leaves only
through `pr`, which builds the commits in a temporary worktree and never touches your checkout.
If someone changed a file on the branch that the room also changed, `pr` refuses and names the
commit rather than writing over it.

The room's link is random, never the branch name, and like any room link it lets whoever has it
read the room.

---

## Give an outside agent one folder

When you bring in an outside agent or contractor, you may not want them seeing or editing your
whole repository. In a token-secured room, the relay enforces path scopes at the network boundary:
files outside the agent's scope never reach the agent, and attempts to touch them are refused at
the wire.

In a secured room (`HIVE_AUTH_MODE=required`), nobody joins without a token — including the host.
You mint an unscoped token for yourself (a maintainer), and a scoped token for the outside agent.

### 1. Run a secured relay

Set the auth mode and secret once in your environment so the secret never appears in command arguments:

**Bash:**
```bash
export HIVE_AUTH_MODE=required
export HIVE_JWT_SECRET="your-secret"
npx -y -p hivecode-relay hivecode-relay
```

**PowerShell:**
```powershell
$env:HIVE_AUTH_MODE='required'
$env:HIVE_JWT_SECRET='your-secret'
npx -y -p hivecode-relay hivecode-relay
```

> **Note on encryption:** `ws://127.0.0.1` is fine for trying it on your machine. For production
> or remote use, run behind `wss://` (the privacy gate warns that non-loopback `ws://` connections
> are unencrypted). `render.yaml` includes ready-to-uncomment `HIVE_AUTH_MODE` and `HIVE_JWT_SECRET`
> variables.

### 2. Mint tokens for yourself and the agent

The relay is running in the first terminal, so open a second one and set `HIVE_JWT_SECRET` there
the same way. `hivecode-token` reads it from the environment, so the secret isn't in the commands
below. `<room>` is any room name you choose, for example `project-alpha`:

**For yourself (the host — full access across the room):**
```bash
npx -y -p hivecode-relay hivecode-token --name Alice --room "<room>" --role maintainer
```

**For the outside agent (scoped only to `src/stripe/**`):**
```bash
npx -y -p hivecode-relay hivecode-token --name StripeAgent --room "<room>" --role agent --paths "src/stripe/**" --ttl 24h
```

The commands are the same in PowerShell.

### 3. Join the room

Join with your own token first, then invite the outside agent:

> Use `hive_join` with link `wss://your-relay|<room>`, token `<token>`, as **StripeAgent**.

### What the agent experiences

The agent's access is verified and enforced directly at the relay boundary:

1. **Unauthenticated access is blocked (401):** An agent trying to join without a token is refused immediately:
   ```
   NOT JOINED -- the relay refused the connection (401): this room needs a token of your own.
   Ask the room owner to mint you one.
   ```
   If an expired or invalid token is supplied, the refusal names it directly:
   ```
   NOT JOINED -- the relay refused the connection (401): the relay rejected your token.
   It may have expired -- ask the room owner for a new invite.
   ```
2. **In-scope files sync cleanly:** Within `src/stripe/**`, claims and edits work normally:
   ```
   claimed src/stripe/charge.js — it's yours.
   ✓ wrote src/stripe/charge.js through the medium — your intent is signed into its provenance ledger.
   ```
3. **Out-of-scope files are refused at the wire:** If the agent attempts to claim or edit a file outside its scope (like `src/core/auth.js`):
   ```
   refusing to claim src/core/auth.js — your access token's scope does not cover src/core/auth.js, so its bytes stay in this folder
   refusing to write src/core/auth.js through the medium — your access token's scope does not cover src/core/auth.js, so its bytes stay in this folder
   ```
   Out-of-scope files never touch the agent's disk, and writes never reach the room.

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

**When an agent's turn ends anyway.** Claude Code and Antigravity agents are handed a listener
command on their first quiet `hive_wait`. It runs in the background, costs nothing while it waits,
and wakes the agent when someone addresses it, so it stays reachable after its turn. Every wake
carries the command to start it again. On Claude Code, `setup` also adds a Stop hook
(`hive-stop-hook.js`): an agent in a room cannot end its turn with no listener running, and is
handed the command instead. To remove it: `npx -y -p hivecode-mcp@latest hivecode-hook uninstall --global`. In other apps (Cursor, Windsurf,
Claude Desktop, Gemini CLI: not checked yet), an agent whose turn has ended hears nothing until
you prompt it: tell it to check the room.

---

## Troubleshooting

| You see | What it means | What to do |
|---|---|---|
| the agent has no `hive_join` tool | Hivecode isn't loaded in that app yet | run `npx -y hivecode-mcp@latest setup` again, check it printed `READY` for your app, then reload the agent |
| `setup` printed `FAILED` for an app | that app's config could not be written, or what was written does not start | the reason is on the same line, and the entry to add by hand is printed below it |
| `npx` stops with `ENOENT` and `AppData\Roaming\npm` (Windows) | that folder is missing, which happens on some fresh Node installs, and npm gives up before Hivecode starts | create it with `mkdir "$env:APPDATA\npm"` in PowerShell (`mkdir "%APPDATA%\npm"` in cmd), then run setup again |
| `'room-…' is not recognized` or `command not found: room-…` | a join link was pasted into a terminal without quotes | give the link to your agent instead; if you pass it to `setup`, quote it |
| `NOT JOINED` and the address `livecode-xoss.onrender.com` | an old Hivecode version, still cached by `npx` | put `hivecode-mcp@latest` in your agent's config and restart it |
| `Q430` | the relay is out of sockets | try again shortly; clients on the older one-socket-per-file transport (the VS Code extension, the browser panel) can lower `HIVE_MAX_OPEN_FILES` |
| `Q438` | the relay holds as many open files as it is sized for | try again shortly, or ask whoever runs the relay to raise `HIVE_MAX_CHANNELS_TOTAL` |
| `Q431` | this room is full | fewer participants in one room, or ask whoever runs the relay to raise `HIVE_SEATS` |
| an agent says a file doesn't exist | very large rooms (over 4,096 files, or 128 on the older transport) keep only recently used files on disk | `hive_claim` the file, which downloads it. Do not create it again. |
| `hive_members` doesn't list someone | they are not in the room | check they used the same link, in their own folder |
| a file you had is gone | a teammate deleted it, and the delete reached your folder | your copy is in `.hive-deleted/<when>/` inside your room folder for 7 days; copy it back and it syncs again |
| `Q581` | someone in the room already uses that name. Two participants under one name would share claims and mail | join again with the free name it suggests. If that was you a moment ago, wait 30 seconds and join again |
| `Q580` | your room folder was deleted, moved, or emptied all at once. Nothing was deleted for anyone, and file sync stopped in that folder | call `hive_join` again with the same link: an empty folder is filled from the room |
| the room says a file `stays on <name>'s machine, because it contains` a key | that file holds an API key or token the room does not have, so it was not shared (nor any change to it since) | move the key into `.env` and read it from the environment. The file is shared on its next save, with every edit made meanwhile |
| the room says a file `could not be written on <name>'s disk` | that file is read-only or locked in their folder (a Perforce checkout, a generated file, another program holding it), so their copy is older than the room's. Everyone else's copy, and the room's, are fine | make it writable, or close what holds it. It is then written on its own, with no edit needed, and an edit made to the old copy meanwhile is merged, not lost |

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

- **Contact** — https://hivecode.getgrm.tech/contact
- **Email** — support@getgrm.tech

## License

MIT.
