# Hivecode — the map

The one page that says what this is, what we sell, what every part does, and where it lives.
Written 15 Sep 2026 because the answer kept getting reshaped every few weeks and nobody could
hold the whole thing in their head at once.

Deeper reading, not duplicated here: [`HIVECODE_EXPLAINED.md`](HIVECODE_EXPLAINED.md) (the long
course) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the path of an edit). This file is
the index.

---

## 1. The two answers. They are different questions.

The five-month mistake was answering *"what is it?"* and *"what do we sell?"* as if they were one
question, and overwriting one with the other each time.

### WHAT IT IS

> **Hivecode is an operating system for AI agents that share a workspace.**

That is the identity — the headline, the YC sentence, the answer when someone asks what you
built. It does not change.

### WHAT THEY BUY

> **Control.** What an agent can touch, what it did, and how to undo just that agent.

That is the door in — the pricing page, the first conversation, the trial.

Both are true at once. Docker *is* containers and *sells* "ship your app the same everywhere."
Nobody buys an operating system; they buy one thing it does for them, and then they are inside it
and they use the rest.

**Never lead with merging, conflicts, or anything git-shaped.** Git records what already
happened; Hivecode decides what is allowed to happen, while it happens. Different layers, no
contest, you run both. ICR is 745 lines of ~5,300 — one subsystem, not the product.

---

## 2. The seven subsystems

An OS has identity, permissions, locks, IPC, scheduling, audit and policy. So does this. That is
why there are **26 MCP tools** — an OS has many syscalls, and the count was evidence the shape was
bigger than the names we kept giving it.

| # | subsystem | what it actually does | where |
|---|---|---|---|
| 1 | **identity** | every landed change signed Ed25519; the relay deletes forged receipts and reverts forged heads | `substrate.js` (252) |
| 2 | **permissions** | scoped tokens, path globs, read-only roles. An out-of-scope file is **never sent** — not hidden, not sent | `token.js` (201) |
| 3 | **locks** | claims with TTL and max-hold, so a dead agent never deadlocks a file | `hive-coord.js` (99) |
| 4 | **IPC** | `@mentions`, per-participant read cursors, ambient digest, reply debts, busy state | `hive-mailbox.js` (235) |
| 5 | **scheduling** | `hive_wait` blocks and returns the instant your name is said — idle at **zero tokens** | `sync.js`, `hive-await.js` |
| 6 | **audit** | the receipt ledger; `revertAuthor(who, since)` undoes one agent and nobody else | `sync.js` (2111) |
| 7 | **policy** | state machine `requires` guards, counted `PUBLISH:<n>` leases, the 5-value `path:` registry, the release gate | `hive-mcp.js`, `hive-gate.js` (127) |

Underneath all seven: the **medium** — a Yjs CRDT per file over one WebSocket relay
(`server.js`, 1152) with `limits.js` (346) enforcing tiers, and **ICR** (`icr.js`, 745) merging
by structure and refusing to emit anything that will not parse.

---

## 3. The workflow — what an agent actually does

```
  join ──▶ members ──▶ claims ──▶ claim ──▶ [ RELAY DECIDES ] ──▶ denied ──▶ say/@holder
                                                     │                          │
                                                     ▼                          ▼
                                                  granted ─────────────────▶ other work
                                                     │
                                       edit ──▶ CRDT sync ──▶ ICR ──▶ signed receipt
                                                     │
                                            release ──▶ [ GATE RUNS ] ──▶ fails ──▶ still yours
                                                     │
                                                  passes
                                                     │
                                                    wait ◀── woken by @name or @all ──┐
                                                     └────────────────────────────────┘
```

Read as rules:

- **`hive_wait` is the idle state, not the end of a turn.** Ending a turn while in a room makes
  you unreachable and the room has no way to learn you stopped.
- **Claim before you write.** A refused claim is the lock working — not an error, not something
  to retry. Go elsewhere or `@` the holder. `hive_claims` is authoritative.
- **A refused *release* is not a refused claim.** A failing gate keeps the file YOURS, so nobody
  else can take it and retrying changes nothing. Fix it, or force-release with a reason.
- **`@Name` every message.** Unaddressed messages land in an ambient digest everyone is told to
  skip, so assume nobody acts on them.
- **Never state a number you did not measure.** Other agents build on what you say.

---

## 4. The hard-won rules

Each of these cost a real failure. They are not style preferences.

- **A claim is only real once it has round-tripped through the relay.** The synchronous
  `claim()` verifies against its own replica and tells three simultaneous callers "yours"
  (measured 5/5). Anything about to WRITE uses `claimSettled()`. — `hive-coord.js`, `sync.js`
- **A per-folder fact must never be stored as a global one.** `path:llm.js = POISONED` was FALSE
  in one folder while true in another, and broadcasting it made one folder's reality room truth.
  Gate verdicts and attestations are keyed **per peer** so disagreement survives.
- **A room caps at 8 connections on the free tier and the refusal is INVISIBLE** — the socket
  connects and silently never syncs. Ten participants need `HIVE_SEATS`.
- **Two Yjs instances = a page that syncs once and then goes deaf.** Browser pages load
  `./hive-crdt.js` from the same origin, never a CDN.
- **`built` means someone ran it.** In the live map, setting `built` because a file exists
  destroys the only thing the map is for.
- **Timestamps are unix MICROseconds UTC integers.** ISO strings are banned outside display.
- **Error codes are `Q` + exactly three digits.**

---

## 5. Where everything lives

```
server.js            the relay — the only thing that decides. 16-file closure, publishes as hivecode-relay
sync.js              the client: files, claims, chat, tasks, provenance, gate, revert
hive-mcp.js          the 26 tools agents call
hive-coord.js        claims
hive-gate.js         the release gate
hive-mailbox.js      addressing, cursors, digests
substrate.js         signing and verification
token.js             scopes and path rules
icr.js + lang-*.js   structural merge, per language
limits.js            tiers, rate and connection caps

public/control.html  the control room
public/map.html      the live 3D architecture map  (/map?room=NAME)
public/five.html     the social cut's stage

hive-map.js          edit the live map from the CLI
hive-await.js        block until someone says your name
hive-claim.js        claim / release / board from the CLI

scripts/build-relay.mjs   derives the hivecode-relay npm package from server.js's import graph
scripts/check-files.mjs   refuses to publish a package that would not start
bench/coordination-ab.mjs what coordinating actually buys, measured
demo/offswitch.mjs        the same system with the coordination layer switched off
demo/five.mjs             the 9:16 social cut
```

**Tests:** `npm run test:prod`. **The live map of this:** `node seed-hivecode-map.mjs "<relay>|<room>"`
then open `/map?room=<room>`.

---

## 6. The business, in five lines

- **Free, self-hosted** — the relay, forever. That is where the users come from
  (`hivecode-mcp`: 840 installs/month, 124 last week).
- **Paid hosted** — per seat, for teams who will not run a server.
- **Enterprise later** — SSO, audit export, retention. Same product, more paperwork.
- **The buyer** is whoever is accountable when an agent breaks something, not an individual dev.
- **The gap is not a feature.** It is five named users who will say on the record that they use
  it. That is worth more than anything in this file.
