# State-Machine Prompting (SMP) / Cognitive ICR

State-Machine Prompting (SMP) is Hivecode's answer to the "Agent Drift" problem. Just as Intent-aware Code Replication (ICR) mathematically prevents agents from corrupting the codebase, SMP mathematically prevents agents from hallucinating their project state.

## The Problem: Conversational Drift

In traditional multi-agent frameworks (like AutoGen or CrewAI), agents rely on a massive, ever-growing chat history to figure out what they should be doing. 

For example, a PM agent might say in chat: *"The contract is ready. Backend, you may begin."*
The Backend agent reads that chat message, infers its state, and starts coding. 

But as the chat history grows to hundreds of messages, LLMs suffer from "context drift." They forget past instructions, hallucinate their current permissions, or get trapped in conversational loops. Natural language is too subjective to use as a reliable state machine.

## The Solution: Hardware-Level Interrupts for LLMs

Hivecode treats agents like threads in a CPU. Instead of asking them to interpret their state from a chat log, Hivecode uses **Yjs CRDTs (Conflict-Free Replicated Data Types)** to inject a rigid, deterministic state machine directly into their Model Context Protocol (MCP) tool loops.

### How it works technically:

1. **The Shared CRDT Map (`swarm_state`)**
   Hivecode’s synchronization engine maintains a real-time, decentralized key-value map called `swarm_state`. Because it runs on Yjs, any change to this map synchronizes across all connected agents instantly, regardless of where in the world they are running.

2. **The `hive_wait` Cognitive Injection**
   When an agent has no immediate tasks, it calls the `hive_wait` MCP tool to block and listen for work. 
   When the wait loop resolves, the MCP server does not just return new chat messages. It physically reads the `swarm_state` map and **prepends it** to the agent's response payload.

   Every single time an agent checks for work, its prompt context is structurally overridden with an unarguable truth:
   ```json
   [GLOBAL PROJECT STATE]
   {
     "contract": "APPROVED",
     "qa_status": "PENDING"
   }
   ```

3. **Mastermind Control (`hive_set_state`)**
   The Lead PM (or a human) is given a special tool: `hive_set_state`. 
   If the PM uses this tool to set `contract` to `APPROVED`, the CRDT map updates instantly. The next time the Backend agent polls `hive_wait`, it receives the new state and is physically unblocked.

## Why this is a Paradigm Shift

- **Decentralized Coordination:** There is no "master Python script" controlling the agents. The agents run completely independently, and the CRDT math handles the state synchronization.
- **Eradication of Drift:** By aggressively overriding the agent's context window with the physical state of the project, they can run indefinitely without forgetting their role.
- **Cognitive ICR:** If ICR perfectly merges agent *code* by structural intent, SMP perfectly merges agent *cognitive states* by structural intent. They no longer guess; they know.

---

# SMP 0.10.0 — from *knowing* the state to being *governed* by it

Everything above describes SMP as a **truth channel**: the state is pushed into the agent's context so
it cannot drift. That works, and it is the foundation. But a four-agent production build
(JARVIS, 2026-07-29) exposed the gap: **agents that knew the rule broke it anyway.**

Not through defiance — through being busy. Rules lived in prose (*"prefer small patches"*, *"verify
from a peer"*, *"never reuse a deleted path"*). Four capable agents read every one of them and violated
them within the hour, **including the agent that authored the rule.** Knowing a rule and being unable
to break it are different properties, and only the second one survives an agent under load.

So 0.10.0 adds the second half: **the state machine as an enforcement point.** The full incident log
lives in that project's `_log/FAILURE_MODES.md`.

## The design principle

An agent only knows what is in its context, so there are exactly two ways to reach one:

1. **Put text in front of it** — and only a *tool result* is guaranteed to land there.
2. **Refuse to let it act** — an error it cannot skip.

### Why not notifications

Hivecode emits `notifications/hive_state_changed` and `notifications/hive_mail`. **Do not depend on
them.** The MCP spec requires a receiver to *ignore* notification methods it does not recognise, and
both are custom methods — so on most hosts they are a doorbell wired to nothing. Keep them for hosts
that do understand them; never build on them.

## 1. State became a machine, not a variable

`hive_set_schema` previously validated `enum` only — spellcheck. It stopped a typo and permitted any
value at any time, so `APPROVED` could slide backwards and a release gate could be opened by an agent
that simply set the flag.

```js
hive_set_schema({ key: 'sending', rules: {
  enum: ['BLOCKED', 'SELFTEST_ONLY', 'LIVE'],
  transitions: { BLOCKED: ['SELFTEST_ONLY'], SELFTEST_ONLY: ['LIVE', 'BLOCKED'], LIVE: ['BLOCKED'] },
  requires: { SELFTEST_ONLY: { suppression_ui: 'APPROVED', unsubscribe_url: 'SET' } },
}})
```

- **`transitions`** — which moves are legal at all. Checked only when the key already has a value; the
  first write is initialisation, not a move.
- **`requires`** — what must already be true to *arrive* at a value. **This makes a contract
  executable.**

On the motivating build, *"nobody calls a real email provider until the suppression UI exists and the
unsubscribe URL is real"* held for nine hours **because a PM kept repeating it in chat.** Expressed as
`requires`, it holds because the transition cannot be made:

```
[Guard Error] [sending] cannot become SELFTEST_ONLY until:
  suppression_ui=APPROVED (is unset); unsubscribe_url=SET (is unset)
```

## 2. Leased write grants — `PUBLISH:<n>`

`<name>_status` gates five tools: `hive_assign`, `hive_complete`, `hive_claim`, `hive_edit`,
`hive_resolve`. Reads, `hive_say` and `hive_wait` are never gated — **being locked must never stop an
agent working or talking, only publishing.**

| value | meaning |
|---|---|
| `OPEN` | unrestricted |
| `LOCKED` | may work and talk; may not claim, edit, complete or assign |
| `PUBLISH:<n>` | **a lease** — `n` writes, spent by the server, auto-closes to `LOCKED` at zero |

The measurement behind it: a file written **once** landed byte-identical in every folder — **7 for 7**.
A file written **twice in quick succession** was destroyed: 333 → 22,312 lines, and 104 → 70,881 lines
in three minutes. As a protocol, *"publish once, never rewrite"* was violated by everyone who read it.
A counted lease makes the second write **impossible rather than discouraged**, and the window shuts
itself so nobody has to remember to close it.

## 3. Per-path state — the genuinely new primitive

```js
hive_set_state({ key: 'path:engine/brain/llm.js', val: 'POISONED' })   // or FROZEN / OPEN
```

**State attached to the resource, not the actor.** Every other guard in the system answers *"may this
agent write?"*. None could express *"this file must never be written again by anyone."*

That question has a real answer. A path whose delete has propagated is poisoned: writing it either
silently resurrects the deleted content over the new content, or leaves two peers permanently
disagreeing with no marker and no warning. On the motivating build that fact lived in a markdown file
agents were expected to remember — and a live credential route was ordered deleted anyway, one
confirmation from breaking the product's entire credential path. **A flag cannot be forgotten.**

`hive_claim` checks it too, so an agent is refused *before* building content it could never land.

## 4. `hive_attest` / `hive_verified` — is the file actually there?

```js
hive_attest({ file: 'engine/brain/llm.js', bytes: 8012, lines: 178 })
hive_verified({ file: 'engine/brain/llm.js' })
```

**Your own folder shows your own write whether or not it propagated**, so one measurement is not
evidence — and `hive_attest` says so out loud when only one peer has reported.

The ledger is keyed **per peer**, which is the entire design: a CRDT map keyed by peer name *merges*,
so two peers attesting different sizes both survive and **the disagreement becomes the signal.** A
single shared `size` field would have silently converged on whichever peer wrote last — precisely the
failure it exists to catch.

```
[!] DIVERGENCE on engine/brain/llm.js — peers do NOT agree:
  Alpha: 8012 bytes / 178 lines
  Beta: 1039347 bytes / 22312 lines
```

This exact state persisted for hours on the motivating build: one folder held a clean 178-line file,
two held a 22,312-line wreck, and the agent with the clean copy reported a fully green test suite in
complete good faith. Nothing in the product could have told any of them.

**Divergence announces; it does not throw.** The agent that measured second did nothing wrong — the
*room* is what is broken.

## 5. Mail rides every tool result

The `hive_wait` injection described earlier only reaches an agent that is *already waiting*. Chat was
observed only inside that call, so an `@mention` reached a working agent **only if it happened to be
blocked** — which is exactly when it isn't. That build accumulated 345 mentions while agents
repeatedly, honestly reported never seeing the one addressed to them.

Now unread mail is appended to **every** tool result:

```
--- UNREAD MAIL: 2 message(s) addressed to you from Beta. Call hive_wait or
    hive_check to read them — this notice consumed nothing. ---
```

An agent heads-down in a task still calls tools constantly — that is what being heads-down *is*.

**`peek`, not `take` — a doorbell, not a delivery.** It consumes nothing and advances no cursor, so
`hive_wait` and `hive_check` remain the only things that hand over a message and mark it read.
Delivering here instead would make the full text arrive on some unrelated tool call and vanish from the
inbox, which is worse than not delivering at all.

## Known gaps

Stated so nobody over-trusts this layer:

1. **"PM ONLY" is not enforced.** No role check on `setState`/`setSchema`, and `hive_set_state` is
   itself ungated — **a locked agent can unlock itself.** Cooperative at that layer.
2. **The gate cannot see native file writes.** It gates `hive_edit`, not an agent's own editor tool.
   Real for the Hivecode write path, honour-based for the rest. Still worth having: `hive_edit` is the
   tool that produced the 22,312-line file.
3. **No transition history** — guards check current state, not how it was reached.
4. **`requires` compares strings only** — no ranges, negation, or cross-key expressions.

## Testing

`tests/hive-smp-test.js` — 27 assertions, two real agents over stdio JSON-RPC against a local relay.
Covers every feature including the negative cases: an illegal transition, an unmet guard, a spent
lease, a poisoned path, a divergent attestation, and that `hive_check` does *not* double-report.
