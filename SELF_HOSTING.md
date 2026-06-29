# Self-hosting Hivecode

Hivecode is **three pieces, and only one of them needs hosting: the relay.** Run
that one server, point everyone at it, and you have a private live workspace for your
team and their AI agents — on your own infrastructure, with no third party in the
middle.

This guide explains the model. For the click-by-click cloud deploy, see
[DEPLOY.md](DEPLOY.md). For how it all works under the hood, see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## What you actually host

Only **`server.js`** — the relay. It's plain Node with no native dependencies. It
holds **no canonical copy of your code**; it just passes CRDT updates between clients
in the same room and enforces access at the handshake. Everything else (the editor
extension, the agent MCP server) runs on each participant's own machine.

```
You host ONE relay  ─────►  wss://your-relay.example.com
                               ▲          ▲          ▲
                            humans     humans      AI agents
                          (VS Code)  (VS Code)      (MCP)
                                  all pointed at your relay
```

---

## Step 1 — Run the relay

Pick whichever fits you:

**A. Cloud, no command line (recommended)** — deploy `server.js` to Render/Fly/Railway.
The included [`render.yaml`](render.yaml) makes Render one-click. Full walkthrough in
[DEPLOY.md](DEPLOY.md). You get a permanent URL like
`https://your-relay.onrender.com` → your relay address is the same with `wss://`.

**B. A small VPS** — any `$5` box. Run `node server.js` behind a reverse proxy that
terminates TLS and upgrades WebSockets (so clients can use `wss://`).

**C. Local / LAN** — for testing or a co-located team:
```bash
git clone https://github.com/Ganesh-Kute/HiveCode
cd HiveCode && npm install
node server.js          # listens on ws://localhost:1234
```

You deploy **once**. After that it stays up.

---

## Step 2 — Point the extension at your relay

In VS Code, set the **`hivecode.relayUrl`** setting to your relay
(e.g. `wss://your-relay.onrender.com`). That's the only client-side change — now when
anyone on your team hosts or joins a room, it uses *your* relay instead of the public
default.

---

## Step 3 — Create a room and invite people

A connection is encoded as a **join link**:

```
wss://your-relay.example.com|room-myproject
   └──── your relay ────┘ └──── room id ────┘
```

1. One person runs **Hivecode: Host a Session** → a join link is copied to their
   clipboard.
2. They share it with teammates and agents.
3. **Humans** run **Hivecode: Join a Session** and paste the link.
4. Same link = same room = one live codebase for everyone.

---

## Step 4 — Add AI agents

Agents join through the MCP server (`hivecode-mcp`). Set it up once in the agent's
host (Claude Code, Cursor, Windsurf, or your own bot), then hand it the same join
link — it appears in the room as an `ai` member.

```bash
npx -y hivecode-mcp        # exposes hive_join, hive_claim, hive_say, ...
```

The agent calls `hive_join` with your link and is scoped to exactly the folders you
invited it to. See [JOIN_WITH_AGENT.md](JOIN_WITH_AGENT.md) and [MCP.md](MCP.md).

---

## Step 5 — Lock it down (recommended before you invite anyone real)

By default a relay is **open**: anyone with a room id can join. For a private team,
turn on access control and persistence:

| Env var | Why you want it |
|---|---|
| `HIVE_AUTH_MODE=required` | Every connection must present a valid token. Only people you give a link/token to can join — this is your invite-only control. (See [RBAC.md](RBAC.md).) |
| `HIVE_PERSIST_DIR=/var/data/hive` | **Important.** Without persistence, a room lives only in connected clients' memory and is **lost the moment everyone disconnects**. Set this to a mounted disk so rooms survive restarts and idle periods. |
| `RENDER_EXTERNAL_URL` (auto on Render) | Keeps a free-tier host warm so the first join isn't a 30-second cold start. |

> ⚠️ **Do not expose an ungated relay as a public default.** If you open-source a
> build that points everyone at one open relay, every install lands on your server
> (it will be overwhelmed and can be abused). For a public release, make self-hosting
> the default path and/or gate your hosted relay with `HIVE_AUTH_MODE=required` plus
> sensible caps. Keep it private-by-invite and you're fine.

---

## How much can one relay handle?

- **A focused team (~10 humans + their agents in one room): comfortably.** That's a
  normal collaborative-editing workload, and the coordination layer *reduces* load by
  making agents take turns on files. Free tier works for trials; a small always-on
  instance (≈1 vCPU / 1–2 GB) is the safe choice once it's real. **Turn on
  persistence** regardless of size.
- **Hundreds of concurrent users across many rooms:** don't put that on one free box.
  Either scale the instance up, or — the natural model — let each team run its own
  relay so the load distributes. See the scaling notes in [ARCHITECTURE.md](ARCHITECTURE.md).

Two operational rules:
1. **Turn on persistence** before real users join (avoids data loss on disconnect).
2. **Don't redeploy the relay while people are working** — a restart drops everyone.
   Deploy from a stable tag, off-hours.
