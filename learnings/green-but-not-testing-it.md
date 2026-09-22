# Green, but not testing it

**The suite passes. The behaviour it was written for is unprotected.**

Two doors into one room, and they need different detection, so they are written up together:

1. **The assertion is beside the behaviour** — the test exercises the right code and then checks a
   different property of it.
2. **The code is never reached** — the logic is correct, thoroughly unit-tested, and nothing in
   the product calls it.

Both end in the same place: a green suite that would stay green through the exact regression it
was written to prevent.

## The shape of it

**Door one.** Writing an assertion is harder than writing a call. Setting up the scenario is the
work; by the time the state exists, the temptation is to assert the nearest thing that is true.
`used?.writes > 0` is true. It is about a different field than the one the ticket changed.

**Door two.** A predicate and its call site are written in different files, often in different
sittings. The predicate gets the tests, because it is the interesting part and it is pure. The
wiring is one line and feels too small to test — and a guard that is never called refuses nothing
at all, no matter how correct it is.

## Why it survives review

- **Green is read as a verdict, not as evidence.** Nobody opens a passing suite. That is the point
  of a suite, and it is exactly the property this class exploits.
- **The pass line often contains the disproof, in plain text.** HIV-13's test printed
  `{"minutes":0,...}` in its own `ok` line. It was on screen, in the output, on the day. Passing
  output is not read, only counted.
- **Door two looks covered from both sides.** The predicate's author sees full coverage. The
  wiring's author sees a well-tested function being called. Neither is looking at the seam.
- **Coverage tools agree with the defect.** Line coverage is satisfied by a call. It has no
  opinion about whether the assertion afterwards was the right one.

## Why the obvious fix makes it worse

For door one the instinct is **add more assertions**. That reduces the odds and does not change
the class — five assertions chosen by the same reasoning that chose the first are five assertions
about adjacent properties. It also inflates the number everyone quotes, which makes the suite feel
stronger while it is not.

For door two the instinct is **test the wiring too**. Better, but it creates a second thing to
maintain that can drift from the first, and the drift is silent. (That is
[repair-the-class-not-the-copy.md](repair-the-class-not-the-copy.md) arriving from the other
direction.)

**The fix for door one is to run the test RED.** Break the behaviour on purpose, confirm the suite
fails, restore. A test that has never failed has never been shown to test anything. This is
cheap — under a minute — and it is the only direct evidence that an assertion is load-bearing.
Every guard landed on this repo this week was RED-checked, and the counts are in the commit
messages because they are the actual claim:

```
weakening the author-only rule          → 7 assertions die
collapsing UNKNOWN into READ            → 5 assertions die
letting the cooldown outrank a change   → 6 assertions die
```

**The fix for door two is to drive the real entry point**, not the predicate. If the product calls
an MCP tool, the test calls that MCP tool.

## How to catch it before you ship

**Door one — read the pass lines of the test you just wrote, once.** Not the count, the lines.
This repo's harness prints the extra column for exactly this reason:

```
ok   snapshot reports 30 minutes after 30 minutes, not 3   {"minutes":30,"writes":1,...}
```

The value sits next to the claim. A human comparing those two for one second catches HIV-13.

**Door one, mechanically** — an assertion whose subject does not appear in the diff is suspect:

```bash
git diff --name-only | grep -E '\.(js|mjs)$' | grep -v tests/   # what changed
# then: does any assertion in the matching suite name the changed symbol?
```

**Door two** — after wiring a guard, delete the wiring and run the suite. If it still passes, the
suite is testing the predicate, not the product.

And once landed, name the assertion in [features.js](../features.js). That is what makes it
survive: the manifest checks the named assertion *ran and passed*, so the promise cannot quietly
stop being checked by a rename.

## What it is not

This is not "write more tests", and it is not an argument against unit tests. Pure unit tests on
pure predicates are the cheapest, fastest, most stable tests here, and 43 of them proved the
obligation state machine in under a second with no relay.

The claim is narrower: **a unit test proves a predicate, and the product is not a predicate.** One
end-to-end assertion through the real entry point is worth more than twenty more unit tests, and
is not a substitute for them either.

Nor is it an argument for end-to-end everything. E2E suites are slow and flaky and a repo made of
them stops being run. The split that works here: the state machine gets units with an injected
clock, and *one* path gets driven for real.

## Worked example one: the assertion beside the behaviour

HIV-13, [governor.js](../governor.js). The ticket changed the minutes divisor. The test asserted
`used?.writes > 0`.

`writes` was 1. The assertion was true. `minutes` was 0 and printed in the same line. The suite
went green, the ticket shipped, and the operator's dashboard under-reported runtime by 10× until a
human happened to read a number and think it looked small.

Fixed by an injected clock and three assertions that are *about minutes*:

```js
clock += 30 * 60000
T('snapshot reports 30 minutes after 30 minutes, not 3', g.snapshot('r').A.used.minutes === 30)
clock += 6000
T('and it keeps the one decimal place the idiom exists for', g.snapshot('r').A.used.minutes === 30.1)
T('the all-rooms form reports the same minutes as the single-room form',
  g.snapshot().r.A.used.minutes === g.snapshot('r').A.used.minutes)
```

The third one is worth its own note: **it passed both before and after the fix.** A consistency
check between two paths cannot catch an error that is systematic across both, and it is the kind
of assertion that feels rigorous while proving nothing about correctness. It is kept because it
guards a different regression, not because it would have caught this one.

## Worked example two: the guard that was never reached

HIV-27, [sync.js](../sync.js). `whyNotShared()` decides whether a path is inside the room's sync
scope and returns a sentence explaining why not. It is correct. Under an allow-list `.gitignore`
it handles the case that catches everyone — `isIgnored()` returns true for *every* string, so a
naive check would refuse every logical-region claim.

Wired into `hive_claim` and `hive_edit` in [hive-mcp.js](../hive-mcp.js), it refuses the real
defect. Unwired, `hive_claim` answers on a file no other agent will ever see:

```
FAIL E1  ... claimed scripts/check-deploy.mjs — it's yours.
```

That line is from the RED run with the two wiring lines removed, and it is the original incident
verbatim. [tests/claim-scope-test.mjs](../tests/claim-scope-test.mjs) therefore has a section E
that drives `_test.callTool('hive_claim', ...)` — the tool an agent actually calls — because
testing the predicate and assuming the wiring is precisely the mistake the ticket was about.

Writing that suite also produced the best single piece of evidence for keeping it: **the guard
refused a case I was certain was fine**, a new file in a narrowed allow-list directory. The guard
was right and my expectation was wrong. The assertion `C1b a NEW file in a narrowed allow-list
directory is flagged, not assumed fine` is permanent, and the comment above it records that it
caught the person writing the guard.
