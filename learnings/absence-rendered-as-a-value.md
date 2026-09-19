# Absence rendered as a value

**"I do not know" gets written down as a number, and the number is plausible, so everything
downstream treats a gap as a fact.**

The deepest class on this project, and the one that has appeared in the most unrelated places —
the sync engine, a memory engine, a mailbox, a delivery receipt. The subsystems share no code. They
share a data type that cannot say "unknown", so each of them picked a neighbour and moved in.

## The shape of it

A value has a natural empty form — `0`, `""`, `[]`, `false`, "no results". A lookup fails, is
refused, times out, or was never attempted. The failure path has nowhere to put "no answer", so it
returns the empty form.

Now two genuinely different states are one value:

| the thing that happened | what was recorded | what a reader concludes |
|---|---|---|
| the file's socket was refused | `""` | the file is empty |
| the recall found nothing | no results | it was never discussed |
| nobody read the message | no receipt | it is still in flight (or: it landed) |
| the agent never published a cursor | cursor absent | it has read nothing |
| the page of tickets failed to load | the tickets we got | that is the backlog |

Every right-hand cell is a reasonable reading. That is what makes this class expensive: the wrong
conclusion is not a mistake, it is the *only* conclusion the data supports.

## Why it survives review

**Because the empty form is correct in the common case.** An empty file really is `""`. A search
with no hits really is no hits. The code is right almost always, and the reviewer checks the
almost-always path because that is the path with the example in front of it.

- **The type system agrees.** `String` has no third state. Adding one means a wrapper, a tagged
  union, an option type — visible cost, for a case that has not bitten yet.
- **The failure is remote from the reader.** The connection is refused in the transport; the empty
  string is read in a merge three layers up, by code that has no way to ask which kind of empty it
  has.
- **It is silent by construction.** No warning fires, because from the reader's position nothing
  went wrong. Something *absent* produced something *plausible*. See
  [false-success.md](false-success.md).

## Why the obvious fix makes it worse

The instinct is **treat the empty case as an error** — throw, refuse, halt on a zero-length read.

That breaks the common case immediately, and worse, it trains everyone to route around the check.
Empty files exist. Searches legitimately return nothing. A guard that fires on the healthy path
gets a flag added to disable it, and the flag ends up on by default.

The second instinct is **fill it in optimistically** — assume delivered, assume read, assume the
file is fine. That is strictly worse than the original defect, because now the wrong answer is
*deliberate* and there is a comment explaining why.

**The fix is a third state that callers cannot collapse.** Not a warning about the ambiguity — the
ambiguity resolved into its own value, with a name, that no arithmetic sweeps up:

```js
READ         their cursor passed it              — evidence
UNREAD       they publish cursors, theirs is behind — evidence against
UNKNOWN      they publish no cursor at all       — NO evidence either way
UNREACHABLE  they left, or we are offline
```

And then the part that makes it hold: **a function, not a filter inline at each call site.**

```js
export const DELIVERED_STATES = [READ]
export const countDelivered = (states) => states.filter((s) => DELIVERED_STATES.includes(s.state)).length
```

`countDelivered` exists so that no future caller can quietly widen the good number to include
UNKNOWN. Written as `states.filter(s => s.state !== UNREAD)` at three call sites, it would have
been widened within a month by somebody being helpful.

## How to catch it before you ship

**Find every place a failure path returns the same type as the success path**, and ask what the
caller does with it.

```bash
# the shape: a catch that yields a value rather than a signal
git grep -n "catch.*return ''" -- '*.js'
git grep -n "catch.*return \[\]" -- '*.js'
git grep -n "catch.*return 0" -- '*.js'
git grep -n "} catch { }" -- '*.js'          # the silent one
```

In review, the question is: **could this empty have come from something that did not happen?** If
yes, the empty is load-bearing and needs a name.

A second tell, which is cheap and surprisingly reliable: **a metric that only ever moves one way.**
If your "delivered" count can go up but the thing it measures has no way to report failure, the
count is measuring attempts and calling them successes.

## What it is not

This is not an argument for option types everywhere, or for `null` discipline in general. Most
empties are just empty and wrapping them costs more than it returns.

It is specifically about **values that cross a boundary where the failure information is lost** —
a socket, a process, a cache, a serialisation. Inside one function, the caller can see the
`catch`; across a socket it cannot, and that is where the third state earns its keep.

It is also not "never use a default". A default is fine when it is *chosen*. The defect is a
default that arrives by accident, from an error path, wearing the clothes of a measurement.

## Worked example: 186 files, silently zeroed

Hivecode opens **one WebSocket per file**. A file's name lives in the parent doc's manifest; its
content lives in its own document behind its own connection. There is no atomicity between them.

The repo had **889 syncable files** against a default `HIVE_MAX_CONNS_TOTAL` of **512**. In one
evening the relay refused **38,011 connections** with Q430.

A refused file-doc is not marked refused. It is a Y.Doc that never received an update, and
`getText('content')` on it returns `""`.

So: the manifest lists the file. The file opens. It reads as empty. The engine, correctly, syncs
that empty content to disk. **186 files went to zero bytes per folder**, and every tool involved
reported success, because at no point did anything hold both "this file has content" and "this
socket was refused" in the same place.

The same class, twice more on this machine, in code that shares nothing with the above:

- **The word-graph memory.** A recall miss and a genuine absence are the same output. Recorded in
  that project's own notes: *the real gap is the safe opposite — a recall miss looking identical to
  a genuine absence.* An agent told "nothing was discussed" acts very differently from one told
  "the index did not answer".
- **The mailbox, before the cursor fix.** 29 messages `@`-mentioned an agent in a day; a handful
  were surfaced. The rest sat below a call-scoped cursor and were returned by no code path. The
  agent's inbox was empty, so the agent was not being ignored — it was being told, accurately and
  uselessly, that there was no mail.

[hive-receipts.js](../hive-receipts.js) is the first place on this project where the third state
was designed in rather than retrofitted, and
[tests/receipts-test.mjs](../tests/receipts-test.mjs) pins it with
`COUNTDELIVERED COUNTS ONLY READ` — an assertion that fails the moment someone folds UNKNOWN into
the good number.
