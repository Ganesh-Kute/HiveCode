# Run your own relay

Hivecode is **three pieces, and only one of them needs hosting: the relay.** Run that one
server and your team's source never reaches a machine you do not own.

This is the supported path for any team that cannot send its code to a third party. It is
also the only path that does not depend on somebody else's uptime.

For the click-by-click cloud deploy see [DEPLOY.md](DEPLOY.md). For how it all works under
the hood see [ARCHITECTURE.md](ARCHITECTURE.md). For tokens and scopes see [RBAC.md](RBAC.md).

---

> **You install one package, not a repository.** `npx hivecode-relay` downloads the relay and
> nothing else — no agent client, no editor extension, no test suite, no build tooling. It is a
> separate npm package from `hivecode-mcp`, which is what your developers and agents install.

## What you actually host

Only the relay. It is plain Node with no native dependencies, it holds **no canonical copy
of your code**, and it never writes your files to disk unless you turn persistence on (which
you should — see below). It passes CRDT updates between clients in the same room and enforces
access at the handshake. The editor extension and the agent MCP server run on each
participant's own machine.

```
You host ONE relay  ─────►  wss://your-relay.example.com
                               ▲          ▲          ▲
                            humans     humans      AI agents
                          (VS Code)  (VS Code)      (MCP)
                                  all pointed at your relay
```

---

## Step 1 — Start the relay

```bash
npx hivecode-relay
```

That is the whole command. It starts the relay with **persistence on**, prints the join link,
and prints the exact settings each teammate needs. Useful flags:

| Flag | Default | What it does |
|---|---|---|
| `--port 1234` | `1234` | Port to listen on. |
| `--data ./hive-data` | `./hive-data` | Where rooms are persisted. |
| `--room my-project` | random | Print the link for a named room instead of a random one. |
| `--secret <string>` | none | Turn on **auth-required** mode: only holders of a minted token may connect. |
| `--seats 25` | `25` | Connection budget. See *How much can one relay handle?* below. |

Three ways to run it, in increasing order of "a real team depends on this":

**A. On a laptop or a box on your LAN.** `npx hivecode-relay`, hand out the `ws://192.168.x.x:1234`
address it prints. Good for a trial, a workshop, or a co-located team. It is **not encrypted**
— fine inside a network you trust, not fine across the internet.

**B. On your own server, behind TLS.** Run it behind a reverse proxy that terminates TLS and
upgrades WebSockets, and hand out the `wss://` address. This is the normal production shape.

**C. On a container host.** The included [`Dockerfile`](../Dockerfile) works on Fly.io, Railway,
Render, Cloud Run or anything else that runs containers. [`render.yaml`](../render.yaml) makes
Render one-click; the walkthrough is in [DEPLOY.md](DEPLOY.md).

You deploy once. After that it stays up.

### A remote team, keeping it private

A relay on a laptop is reachable only from that network. For teammates in other places there
are three real options, and they are **not** equally private:

| Option | Private? | Stays up? | Setup |
|---|---|---|---|
| **Private network (Tailscale or similar)** — relay on any team machine, teammates join the same private network and use its `100.x.y.z` or `*.ts.net` address | **Yes.** WireGuard end to end; nothing outside the network can even reach the relay | Only while that machine is on | Each person installs the app and logs in once |
| **Your own server** — a small cloud VM or office box in *your* account, TLS terminated on it | **Yes.** You run every machine the traffic touches | Yes | One-time server setup |
| **Public tunnel** (`cloudflared tunnel --url http://localhost:1234`, ngrok) | **No.** The tunnel provider decrypts traffic at its edge, and the URL is public | Only while the laptop is on; quick tunnels get a new URL every restart | One command |

A public tunnel works — verified end to end: two clients synced a file through a Cloudflare
quick tunnel, and a client holding the URL but no token was refused. Use it for a trial, and
**always with `--secret`**, because a public URL on an open relay is an open room. `hive_status`
says so on every join: `YOUR RELAY — through a public tunnel`.

---

## Step 2 — Point EVERY client at it

This is the step teams get half-right, so it is worth being blunt about what "half-right"
costs. There are two kinds of client and they read two different settings:

| Client | Setting | Where |
|---|---|---|
| **Human** (VS Code) | `hivecode.relayUrl` | VS Code settings |
| **AI agent** (MCP) | `HIVE_RELAY` | the `env` block of the agent's MCP server config |

**If you set one and forget the other, nothing fails.** The agent falls back to the public
relay this build ships as a default, joins a room with the same name, reports `connected`,
and publishes your files there. Your humans are on your relay, your agent is on ours, and
every status line on both sides is green.

So set the pin as well:

```
HIVE_RELAY_PIN = wss://your-relay.example.com
```

`HIVE_RELAY` is a *default*. `HIVE_RELAY_PIN` is a *rule*: this machine may only ever talk
to these relays, and any attempt to connect anywhere else is refused **before the socket
opens**, with error **Q550**, having published nothing. Set it on every machine — humans'
and agents' alike — and a stale link, a typo'd host or a forgotten environment variable
becomes a loud refusal instead of a silent upload.

Two more knobs:

- `HIVE_RELAY_PIN` accepts a comma-separated list, for teams with a staging relay and a
  production one.
- `HIVE_PRIVATE=1` refuses the shipped public default (**Q551**) even when no pin is set.
  Use it as a belt-and-braces setting on a machine that must never reach our relay.

A pin that cannot be parsed is **refused (Q552)**, never ignored. A typo that silently
degraded to "no pin" would leave you believing a machine was locked down when it was not.

---

## Step 3 — Create a room and invite people

A connection is encoded as a **join link**:

```
wss://your-relay.example.com|room-myproject
   └──── your relay ────┘ └──── room id ────┘
```

1. `npx hivecode-relay --room myproject` prints the link.
2. Share it with teammates and agents.
3. **Humans** run **Hivecode: Join a Session** in VS Code and paste it.
4. **Agents** get it as the `link` argument to `hive_join`.
5. Same link = same room = one live codebase for everyone.

---

## Step 4 — Add AI agents

Agents join through the MCP server. Register it once in the agent's host (Claude Code,
Cursor, Windsurf, or your own bot):

```json
{
  "mcpServers": {
    "hivecode": {
      "command": "npx",
      "args": ["-y", "hivecode-mcp@latest"],
      "env": {
        "HIVE_RELAY": "wss://your-relay.example.com",
        "HIVE_RELAY_PIN": "wss://your-relay.example.com"
      }
    }
  }
}
```

Then hand it the join link. It appears in the room as an `ai` member, scoped to exactly the
folders you invited it to. See [JOIN_WITH_AGENT.md](JOIN_WITH_AGENT.md) and [MCP.md](MCP.md).

---

## Step 5 — Check that it is actually private

Do not take a green join as evidence. Two checks, thirty seconds:

**1. Ask each client where it is.** `hive_status` reports a `privacy` field next to
`connected`:

```
privacy: "PRIVATE — relay on your network"     ← yours
privacy: "PUBLIC RELAY — not yours"            ← ours. Your files are on our server.
```

A human client shows the same thing in the join banner: `relay: <url>  [VERDICT]`.

**2. Ask your relay who is on it.** `curl http://your-relay:1234/health` reports
`connections` and `rooms`. The number of connections should account for everybody. If a
teammate says they are in the room and your relay's count did not move, they are in
*a* room — just not on your relay.

You can prove the whole path on your own machine in about a minute, from a clone of the repo:

```bash
node tests/self-host-test.mjs
```

That suite starts a real relay, syncs a real file between two real clients through it,
asserts the relay's own counters moved, and asserts that a pinned client refuses the public
relay. It is the evidence behind every claim on this page.

---

## Step 6 — Lock it down before you invite anyone real

| Env var | Why you want it |
|---|---|
| `HIVE_AUTH_MODE=required` + `HIVE_JWT_SECRET=<secret>` | Every connection must present a valid token. This is your invite-only control. `npx hivecode-relay --secret <secret>` sets both. Mint tokens with `npx hivecode-token --room <room> --name <who> --role writer --ttl 7d` on the relay host, which is the only machine that holds the secret. See [RBAC.md](RBAC.md). |
| `HIVE_PERSIST_DIR=/var/data/hive` | **Important.** Without it a room lives only in connected clients' memory and is **lost the moment everyone disconnects** — the day works perfectly and the folder is empty in the morning. `npx hivecode-relay` turns this on by default; running the relay from a clone of the repo (`node server.js`) does not. |
| `HIVE_SEATS=<n>` | Per-room connection budget (8 per seat). It does **not** raise the whole-relay total — that is `HIVE_MAX_CONNS_TOTAL`. The free-tier ceiling is 8 per room, which is **not** 8 people — see below. |
| `HIVE_AUDIT_FILE=./audit.log` | One line per admit and reject. This is your evidence of who connected and when. |
| `HIVE_RELAY_MUX=off` | Turns off one-socket-per-participant mode. It is on by default; this is the kill switch, and clients already connected fall back to one socket per file by themselves. |
| `RENDER_EXTERNAL_URL` (auto on Render) | Keeps a free-tier host warm so the first join is not a 30-second cold start. |

> ⚠️ **An open relay on a public IP is a public relay.** Without `HIVE_AUTH_MODE=required`,
> anyone who can reach the port and guesses a room id can read and write your files. On a
> laptop or a private LAN that is a reasonable trade. On a public IP it is not.

---

## How much can one relay handle?

**Count sockets and open files, not people.** A current client holds **two sockets** — one for
the room, one carrying all of its files — and each open file is a channel on the second.
Clients on the older transport (the VS Code extension, the browser panel, `HIVE_MUX=0`, or any
client against a relay that predates this) still hold one base-room socket **plus one per open
file**, up to `1 + HIVE_MAX_OPEN_FILES` (default 128) each.

Two different ceilings refuse you, with two different remedies:

| You see | Meaning | Fix |
|---|---|---|
| **Q430** (503) | the whole relay is at `maxConnsTotal` (default 2048, ~56 KB of memory each) | `HIVE_MAX_CONNS_TOTAL` — **`HIVE_SEATS` does not help here** |
| **Q431** (429) | one room is at its per-room cap | `HIVE_SEATS` |
| **Q438** (503) | open files across all participants are at `HIVE_MAX_CHANNELS_TOTAL` (default 8,192; ~25.8 KB each unshared, ~2.4 KB per extra participant) | `HIVE_MAX_CHANNELS_TOTAL`, with the memory to match |

- **A focused team (~10 humans and their agents in one room): comfortably**, on a small
  always-on instance (≈1 vCPU / 1–2 GB). Free tiers are fine for a trial.
- **Hundreds of concurrent users across many rooms:** scale the instance up, or — the natural
  model — let each team run its own relay so the load distributes.

Two operational rules:

1. **Turn on persistence** before real users join.
2. **Do not redeploy the relay while people are working** — a restart drops everyone. Deploy
   from a stable tag, off-hours.

---

## What self-hosting does not give you

Said plainly, because discovering it later is worse:

- **Uptime is yours.** Nobody is paged when your box dies at 2am.
- **`ws://` is plaintext.** Self-hosting is not encryption. Put TLS in front of it.
- **An open relay is open.** Running it yourself controls *where* the bytes go, not *who*
  may fetch them. That is what `HIVE_AUTH_MODE=required` is for.
- **Path scoping needs auth mode.** The `--paths` globs in a token are only enforced when the
  relay runs in `required` mode. On an open relay every token is ignored, so a "scoped" agent
  gets the whole room.
- **Mixed client versions do not sync.** Everyone on the relay must be on the same Hivecode
  version; announce yours on join.
