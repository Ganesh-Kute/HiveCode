# Testing the consumer instead of the derivation

**The test constructs the input it is testing the derivation of.**

A test that hands a module the pre-baked result proves only that the consumer acts on what it was given. It proves nothing about whether the product actually computes that input, computes it correctly, or passes it at all.

When the logic that derives the input is deleted, broken, or never wired, the test stays completely green.

## The shape of it

A pipeline has two halves:

1. **The Producer (Derivation):** Reads durable state, inspects the environment, and derives a fact (e.g. "has this member ever authored a message in this room?").
2. **The Consumer (Action):** Takes the derived fact and acts on it (e.g. "if never seen, open zero obligations; if known but away, open an obligation flagged absent").

Because the consumer is often a pure function in its own module, it is the easiest to unit-test. The test author constructs synthetic records, sets `{ neverSeen: true }` on one and `{ neverSeen: false }` on another, and asserts that the consumer handles both states correctly.

The unit suite passes with 31 assertions and 100% line coverage. Meanwhile, in the product entry point, the code that computes `neverSeen` from the chat log is deleted. The consumer never receives anything except a constant, but every test in the repository stays green.

## Why it survives review

- **The test looks exhaustive.** `tests/mention-boundary-test.mjs` had 31 assertions detailing every transition of the three-state lifecycle: auto-expiry, backoff, caller discharge, third-party refusal. Reviewers see a dense, well-reasoned suite and assume the feature is safe.
- **Decoupling is praised as good architecture.** Separating pure business logic (`hive-obligations.js`) from MCP tool dispatch (`hive-mcp.js`) is good engineering. But testing only the pure half tests the tool in a world where inputs appear by magic.
- **The pass output is confident.** When `npm test` prints `31 passed, 0 failed`, nobody asks whether the flag being passed was typed by the test author or derived by the engine.

Four distinct instances of this exact failure occurred in a single session on 20 Sep 2026:
1. **The Version Scanner:** An automated compliance scanner passed across 81 files while matching 0 of them, because the pattern was evaluated against an empty set.
2. **The Text Regex:** An adoption guard assertion (`/accountFor.*docText/s`) passed against `sync.js` solely because `accountFor` appeared in an import at line 39 and `docText` appeared 200 lines later.
3. **The CRLF Mutation:** A mutation test designed to verify a test failed silently because string replacement failed on Windows `\r\n` line endings, leaving the file untouched while reporting the mutation passed.
4. **The Three-State Provenance Seam:** 31 passing assertions in `tests/mention-boundary-test.mjs` failed to notice that `hive-mcp.js` had stopped computing `neverSeen` entirely, collapsing absent teammates into nonexistent ghosts.

## Why the obvious fix makes it worse

The obvious fix is **add more unit tests to the consumer**.

Adding 50 more assertions to `hive-obligations.js` testing edge cases of `neverSeen` does not increase the probability of catching a missing `everHere` computation in `hive-mcp.js` by even 1%. It only inflates the test count and increases false confidence.

The second wrong fix is **mock the producer in the consumer test**. Mocks codify the test author's assumption of what the producer produces. If the producer drifts or is deleted, the mock continues returning the expected shape.

## How to catch it before you ship

1. **Drive through the real product entry point.** A feature whose subject is how the room derives presence cannot be tested by calling a store helper. It must be tested by joining a client, speaking, leaving, and asking a question through the real MCP tool (`hive_say`) on a real relay.
2. **Verify mutation application.** When writing an adversarial test or mutation check, assert that the mutation actually landed (verify byte delta and replacement count). A mutation that no-ops is identical to a test that cannot fail.
3. **Ask the Seam Question:** *Did this test derive the value the way production derives it, or did the test author hand the answer to the function?*

## What it is not

- **It is not an argument against pure unit tests.** Unit tests for pure state machines (such as `hive-obligations.js`) are essential. They verify microsecond clocks, backoff math, and determinism that would be intractable to exercise against real network timeouts.
- **It is not an argument for giant end-to-end tests for every helper.** Pure string parsers and math functions do not have an ambient producer.
- It applies specifically to **derived contextual state**: state that depends on historical room activity, environment flags, or multi-client presence.

## Worked example

On 20 Sep 2026, HIV-P5 introduced a three-state provenance model for obligations:
- `NEVER_SEEN`: A name that has never existed in the room.
- `KNOWN_AWAY`: A real teammate who spoke earlier and stepped out (e.g. rate-limited for 90 minutes).
- `PRESENT`: An active participant currently connected.

`tests/mention-boundary-test.mjs` verified this lifecycle with 31 assertions:
```javascript
const obGhost = OB.open(store, { ... neverSeen: true ... })
const obTeammate = OB.open(store, { ... neverSeen: false ... })
```

Hours later, during HIV-P6, `hive-mcp.js` was modified to prevent junk debts. The author removed the `everHere` check against the chat log and gated obligations solely on current presence (`s.hive.members()`), hardcoding `neverSeen: false`.

Result:
- If a known teammate stepped out between turns, `hive-mcp.js` treated them as absent and opened zero obligations.
- `tests/mention-boundary-test.mjs` ran 31/31 GREEN because it constructed `neverSeen` itself.
- Only an adversarial probe in `tests/non-answerable-test.mjs` (`D4` / `D4b` / `D5`) that joined a client, authored a chat line, called `hive_leave`, and sent a question caught that zero debts were being recorded for real teammates.
