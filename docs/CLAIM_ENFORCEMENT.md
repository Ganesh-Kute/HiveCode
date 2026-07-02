# Relay-Enforced Claims — the last mile of DCO

> **Status: IMPLEMENTED + tested.** `warn` / `block` / `queue` modes live in
> `server.js` (opt-in via `HIVE_ENFORCE_CLAIMS`, off by default); proven end-to-end
> over the real relay in `hive-enforce-test.js` (non-owner blocked, owner allowed,
> DCO-lock blocked, unlock allowed, and queue-mode zero-loss hold+replay).
>
> Turns coordination from "the agent shouldn't" (DCO, client-side) into "the agent
> *can't*" (relay-side) — the missing half that makes the Hive coordination layer a
> true primitive.

## The gap this closes

We have two enforcement points today:

| Layer | Where it runs | What it blocks | Weakness |
|---|---|---|---|
| **DCO** (`enforceDcoLock`) | the agent's **own** MCP server (`hive-mcp.js`) | `hive_claim` / `hive_assign` / `hive_complete` when `LOCKED` | client-side — a misconfigured/rogue/edited client can bypass it; and it gates the *coordination tools*, **not the raw file write** |
| **Read-only** (`makeReadOnly`) | the **relay** (`server.js`) | all Yjs writes on a connection | static — decided once at handshake, can't react to a claim/lock taken mid-session |

So a locked (or non-owning) agent that simply **edits a file on disk** still syncs — the write reaches the relay and propagates. DCO says "you shouldn't"; nothing yet says "you can't." The relay is the one place **every** write converges and **no client controls it** — the correct place for true enforcement (same trust model as per-path scope and read-only).

## The design in one line

Generalize `makeReadOnly()` into a **dynamic write-gate**: on every inbound write to a *file* room, look up the live `claims` and `swarm_state` from that project's **base** doc and drop (or queue) the write if the sender is DCO-locked or doesn't own the file.

## Why it's cheap to build (the pieces already exist)

- **Per-file rooms.** A project is `<base>` + per-file rooms `<base>␁<path>`. Each connection is to one room; `pathOf(room)` / `baseRoomOf(room)` (token.js) already split them.
- **The write-drop hook.** `makeReadOnly(conn)` already wraps `conn.on('message')` and detects writes (sync `step2`=1 / `update`=2) via `lib0/decoding`. We reuse that decoder verbatim.
- **Server-side doc access.** `y-websocket/bin/utils` exposes `getYDoc(name)`; the relay can read the base doc's `claims` and `swarm_state` maps server-side — no new storage.
- **The state to read already exists.** `claims` (hive-coord.js, `{by,intent,at,ttl}`, 5-min TTL) and `swarm_state` (DCO). Nothing new to persist.
- **Identity is on the connection.** `conn._hive = { room, identity:{name,kind,owner}, role }`.

## Implementation sketch (server.js)

```js
import { setupWSConnection, getYDoc } from 'y-websocket/bin/utils'
import * as decoding from 'lib0/decoding'

// opt-in, off by default — like HIVE_AUTH_MODE. off | warn | block | queue
const ENFORCE = (process.env.HIVE_ENFORCE_CLAIMS || 'off').toLowerCase()

function isWriteMessage(data) {
  try {
    const dec = decoding.createDecoder(new Uint8Array(data))
    if (decoding.readVarUint(dec) !== 0) return false      // 0 = sync
    const t = decoding.readVarUint(dec)
    return t === 1 || t === 2                               // step2 | update = a write
  } catch { return false }                                  // unparseable -> not gated
}

// The core decision. Returns { allow, reason }.
function writeDecision(conn) {
  const room = conn._hive?.room, who = conn._hive?.identity?.name
  const filePath = pathOf(room)
  if (filePath === null) return { allow: true }             // base-room writes (chat/claims/state) never gated
  if (conn._hive?.identity?.kind === 'human') return { allow: true } // humans/overseers exempt (configurable)

  const base = baseRoomOf(room)
  const baseDoc = getYDoc(base)                             // already in memory (y-websocket docs map)
  if (!baseDoc) return { allow: true }                     // fail-OPEN: availability > strictness for coordination

  const state = baseDoc.getMap('swarm_state')
  if (state.get(`${who}_status`) === 'LOCKED' || state.get(`${who}_locked`) === 'true')
    return { allow: false, reason: 'DCO-locked' }          // composes with DCO — same flag

  const claim = baseDoc.getMap('claims').get(filePath)
  const live = claim && (!claim.ttl || (claim.at || 0) + claim.ttl > Date.now())
  if (live && claim.by && claim.by !== who)
    return { allow: false, reason: `held by ${claim.by}` }

  // Optional STRICT mode: require a claim before ANY write (uncomment to enforce)
  // if (STRICT && !(live && claim.by === who)) return { allow:false, reason:'no claim held' }
  return { allow: true }
}

function installWriteGate(conn) {
  const realOn = conn.on.bind(conn)
  conn.on = (event, handler) => {
    if (event !== 'message') return realOn(event, handler)
    return realOn('message', (data, ...rest) => {
      if (isWriteMessage(data)) {
        const d = writeDecision(conn)
        if (!d.allow) {
          if (ENFORCE === 'warn')  { auditBlock(conn, d, true);  return handler(data, ...rest) } // log, allow
          if (ENFORCE === 'block') { auditBlock(conn, d, false); return }                        // drop
          if (ENFORCE === 'queue') { queueWrite(conn, data); return }                            // hold + replay
        }
      }
      return handler(data, ...rest)
    })
  }
}
```

Wire it where read-only is wired (server.js:281), for AI connections to file rooms:

```js
wss.on('connection', (conn, req) => {
  if (conn._hive?.role === 'reader') makeReadOnly(conn)          // existing
  else if (ENFORCE !== 'off')        installWriteGate(conn)      // NEW
  setupWSConnection(conn, req, { docName: room })
})
```

## Two enforcement modes

- **`block`** (simple, ship first): drop the update. The writer's local Yjs doc still holds the change, so when the lock clears / claim releases and the next sync round runs, it re-propagates. Backstop for a rogue write; matches `makeReadOnly` exactly.
- **`queue`** (zero-loss, phase 2): buffer dropped updates per `(conn, file)`; when `claims`/`swarm_state` change to permit it (observe the base doc), replay them in order, then flush. No lost edits, no conflict — the write simply lands the moment the agent is allowed. This is the nicest UX and the strongest story: *"held, not dropped."*

## Closing the loop (feedback)

On a block/queue, the relay can write one line into the base doc's `chat` (or an `activity`/`enforcement` map) — `"⛔ write to <file> by <who> blocked — held by <holder>"` — so the agent and the Control Room *see* it. The relay already has the base doc handle, so this is a one-liner and it makes the enforcement visible in the Control Room's activity feed.

## Edge cases / decisions

1. **Fail-open** for coordination (base doc missing / parse error → allow). This is collision-*prevention*, not access-*control*; availability wins. (Access-control stays fail-closed at the handshake, unchanged.)
2. **Own claim → allow.** `claim.by === who` passes.
3. **No claim → allow** by default; **strict mode** (opt-in) requires a claim before any write.
4. **TTL honored** — an expired claim is treated as free (no deadlock if an agent crashes).
5. **Base-room writes never gated** — agents must always be able to `hive_claim`/`release`/`set_state`; only `<base>␁<path>` file writes are gated.
6. **Humans exempt by default** (overseers can always intervene); flip with a config if you want symmetric enforcement.
7. **Cost:** two `Map.get`s per write message; negligible. Cache per-connection for a few ms if ever needed.
8. **Rollout:** `HIVE_ENFORCE_CLAIMS=off` by default → zero change to existing open rooms. Turn to `warn` to observe, then `block`, then `queue`.

## How it composes with DCO (the whole primitive)

```
Agent wants to edit a locked/held file
   │
   ├─ DCO (client)   : state injected on hive_wait → agent KNOWS it's locked;
   │                    hive_claim/assign/complete THROW           →  "you shouldn't"
   │
   └─ Relay gate (server): even if the agent ignores that and writes
                        the file directly, the write is dropped/queued →  "you can't"
```

DCO handles the **cognitive** layer (no drift, cooperative agents self-govern); the relay gate handles the **physical** layer (rogue/misconfigured writes can't land). Together they are the airtight, LLM-independent coordination primitive — the same class as ICR, and the thing that makes "provably can't go rogue" true rather than aspirational.

## Test plan

- Extend `hive-coord-live-test.js`: agent B (no claim) writes a file A holds → assert the update never reaches A's doc in `block` mode; assert it *does* land after A releases in `queue` mode.
- DCO path: set `B_status=LOCKED`, have B write a file → assert dropped; unlock → assert propagates.
- Fail-open: kill the base doc handle → assert writes pass (availability).
- Humans-exempt: a `kind:'human'` connection writes a held file → assert allowed.
```
