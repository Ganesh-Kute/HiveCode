# The Substrate — a governed medium for multi-agent code

> **Status: built + proven.** Core + client + relay enforcement + Control Room, with
> four adversarial test suites (all green). Opt-in via `HIVE_PROVENANCE` (off by
> default, so existing rooms are unchanged). Files: [`substrate.js`](../substrate.js),
> wired into [`sync.js`](../sync.js) and [`server.js`](../server.js).

## What it is (in one paragraph)

Most agent tooling is a **channel** — a wire that carries messages between an agent and
its tools (that's MCP). The substrate is a **medium**: a shared place agents write code
into, where the *place itself* guarantees three things no channel can. Coordination is a
property of the medium, not of a controller — there is no lead agent.

The unit of exchange is not a message or a tool call. It is a **change**: a triple

```
(intent, patch, provenance)
```

published against the medium's current state. On every publish the medium enforces
three invariants, and refuses the change if any fails.

## The three invariants

| # | Invariant | Guarantee | Where it lives |
|---|---|---|---|
| **I1** | **Provenance-verified** | every accepted byte traces to a cryptographically verified author + a declared intent, chained | new — `substrate.js` (Ed25519 signatures) |
| **I2** | **Convergent** | any number of agents applying the same changes in ANY order reach the exact same state | ICR (`icr.js`) — deterministic, symmetric merge |
| **I3** | **Non-regressing** | the medium only moves to an equal-or-healthier state; a change that breaks or clobbers is refused, not landed | ICR + relay head-guard |

I2 and I3 already existed in the merge engine ([ICR](ICR_EXPLAINED.md)). **I1 is the new
layer** — verifiable, chained provenance as a first-class type on every change. No CRDT,
git, or MCP carries that.

## Try it in one minute (no setup)

```bash
npm install
npm run test:substrate:all
```

That runs all four suites against a real relay it spins up itself:

| Suite | Proves | What it does |
|---|---|---|
| `test:substrate` | the 3 invariants (core) | forge/tamper/impersonate rejected; 20 random reorderings converge; health held across 60 mixed changes; chain audit catches mutation |
| `test:substrate:live` | provenance works in the real product path | two `startSync` clients over the real relay → signed, verified, attributed, forgery-proof |
| `test:substrate:enforce` | the relay enforces (not just records) | inject a forged receipt → `strict` removes it, `audit` logs it |
| `test:substrate:authority` | content authority | two clients converge to one verified `head`; relay reverts a forged OR regressing head |

Every check prints `ok` / `FAIL`; the process exits non-zero on any failure, so it's a
conformance suite: **anyone reimplementing the contract can run these to prove they did
it right.**

## Try it live (see provenance in a real room)

Provenance is off by default. Turn it on at both ends:

**1. Run a relay with enforcement:**
```bash
HIVE_PROVENANCE=strict node server.js      # off | audit | strict
```

**2. Run a client with signing on** (it mints an Ed25519 identity in `.hive-id.json`,
which never syncs):
```bash
# MCP agent — register the server with the env var:
claude mcp add hivecode --env HIVE_PROVENANCE=on -- node /path/to/hive-mcp.js
#   then, from the agent:  hive_join({ dir: ".", name: "you", owner: "you" })

# or the folder/editor client:
HIVE_PROVENANCE=on node <your-client>
```

**3. Watch it** in the Control Room (`/control` on the relay, or `public/control.html`):
the **Provenance** panel opens each active file's ledger, **verifies every signature in
the browser** (Web Crypto Ed25519 — the same check the relay runs), and shows ✓ verified
/ ✗ forged badges, the "live content" tag on the current verified version, and a feed of
any violations the relay caught.

`HIVE_PROVENANCE` modes on the relay:
- **`off`** (default) — nothing changes; existing rooms behave exactly as before.
- **`audit`** — the relay verifies every receipt and logs/surfaces violations, changing nothing.
- **`strict`** — the relay additionally **removes** forged receipts and **reverts** a forged or regressing `head` to the last verified one.

## Build on it (the API)

`substrate.js` is dependency-light (Node `crypto` + `icr.js`) and pure where it counts —
`publish` reads no clock or randomness, so a peer can replay a change log to byte-identical
state.

```js
import { genIdentity, authorChange, publish, emptyState,
         verifyReceipt, verifyChain, headOk, contentHealth } from './substrate.js'

// 1. an identity IS the fingerprint of its public key (self-certifying, no registry)
const me = genIdentity('Alice')

// 2. turn a raw edit into a signed change
const change = authorChange({
  identity: me, filename: 'app.js',
  base: oldText, text: newText,        // what you edited FROM, and TO
  intent: 'harden login', at: Date.now(),
})

// 3. publish into the medium — enforces all three invariants
const r = publish(state, change)       // state from emptyState() or a prior publish
if (r.accepted) state = r.state         // r.receipt is the new provenance-DAG node
else            console.log(r.reason)   // 'I1 provenance: …' | 'I3 non-regression: …'

// 4. audit anything, independently
verifyReceipt(receipt)                  // one receipt: signature + author identity
verifyChain(state.history)              // the whole chain, end to end
```

### Key functions

| Function | Purpose |
|---|---|
| `genIdentity(name)` | mint an Ed25519 identity `{id, pk, sk, name}`; `id` is the key fingerprint |
| `authorChange({identity, filename, base, text, intent, at})` | sign a change → `{filename, base, text, intent, prov}` |
| `publish(state, change)` | the one operation → `{accepted, state, receipt, reason}`; refuses forged/conflicting/regressing changes |
| `verifyProvenance(change)` | I1 check on a change (signature + identity + content hash) |
| `verifyReceipt(receipt)` | verify one stored ledger receipt in isolation |
| `verifyChain(history)` | audit a full linear provenance chain |
| `headOk(head)` / `contentHealth(text, filename)` | validate an authoritative head; parse-health for non-regression |

### Language support

Structure-aware merge (I2/I3) works for every language ICR has a provider for — JavaScript
(full intent layer via `acorn`), the C-family (TypeScript, Go, Rust, Java, C/C++, C#, Swift,
Kotlin, Scala, PHP, Dart via `lang-brace.js`), and Python (`lang-python.js`). Add a language
by writing one provider; the engine never changes. See [ICR](ICR_EXPLAINED.md).

## Honest boundary

Transport-level *refusal* of unattested content writes is **not** cleanly possible in the
current one-doc-per-file model: a file's content, ledger, and head all ride a single opaque
Yjs update stream, so the relay can't cheaply drop a "content-only" write. The enforcement
is therefore **head-revert**: unverified or broken content cannot become a file's
authoritative current version. That's a real guarantee — stated, not glossed over.

## The one-sentence claim it makes true

> Any number of agents edit shared code at once; the result always **converges**, never
> **regresses**, and every version is **provenance-verified** to a real author — enforced
> by the relay, with no one in charge.
