# False success

**Nothing throws. Every signal is green. The result is wrong.**

This is the umbrella. Every defect this project has produced has been one of these, which is worth
saying plainly because it changes where to look: the interesting failures on this codebase have
never been crashes, and time spent hardening against crashes has never paid.

## The shape of it

A system reports the outcome it reports on success, while doing something else. The report is not
a lie anybody wrote — it is the *same sentence* the healthy path emits, produced by a code path
that never checked the thing the sentence claims.

    hive_say         "sent to @Builder: ..."      with the socket down
    hive_join        "joined", rules attached      while the relay refused the connection
    hive_claim       "it's yours"                  on a file outside sync scope
    hive_set_state   set                           to the literal string "undefined"
    the governor     {"minutes": 0}                after thirty minutes of runtime
    a file doc       ""                            because its socket was refused, not because it is empty
    hive-pr          three clean signed commits    that revert four tickets of work

Seven different subsystems. One shape.

## Why it survives review

**Because there is nothing to see.** Not "we missed it" — there is no output anywhere that differs
from the healthy case. That is the whole property.

- **The happy path and the failing path print the same string.** Whoever wrote the success message
  wrote it before the failure mode existed, and nobody goes back to narrow a message that is
  working.
- **The test asserts the call returned.** Which it did. See
  [green-but-not-testing-it.md](green-but-not-testing-it.md).
- **The failure is one layer below the reporter.** `hive_say` pushes into a local Yjs array and
  returns. Whether that array is attached to a live socket is somebody else's business, and the
  two never spoke.
- **Nothing in the room contradicts it.** An unsynced file reads as empty, a departed agent reads
  as quiet, an unanswered question reads as answered. See
  [absence-rendered-as-a-value.md](absence-rendered-as-a-value.md).

## Why the obvious fix makes it worse

The instinct is **add a check and log a warning**. That fails twice over.

A warning in a log is invisible to an agent — an agent reads tool results, not logs. And a warning
next to a success message is read as decoration: the tool said it worked, and a line underneath
saying "maybe not" loses that argument every time.

The second instinct, **make it throw**, is worse in a different way. Half of these conditions are
transient and self-healing. A socket that is reconnecting does not warrant an exception; it
warrants a different sentence. Throwing turns a blip into a crash and teaches the agent to
`hive_join` its way out, which is the call that overwrites local edits.

**The fix is the sentence.** The tool must not be able to produce the success wording in the
failing case. Not a flag beside it, not a suffix — a different string, in the same slot, saying
what is actually known:

```
NOT SENT — this client is OFFLINE. The message is in your local copy only; it has not
reached the relay and no one else can see it.
```

Success wording is a resource. Spend it only where it has been earned.

## How to catch it before you ship

**Read the success message and ask what it asserts.** Then find the line that checks that. If the
message says "sent" and nothing in the function consults a socket, that is the defect, sitting in
plain sight, today.

Mechanically, on this repo:

```bash
# every place that reports an outcome it may not have verified
git grep -n "return text(\`sent\|return text(\`joined\|it's yours\|\bok\b.*true"
```

And in review, one question, which is cheaper than it sounds: **what would this print if the thing
it depends on were dead?** If the answer is "the same", stop.

## What it is not

This is not "add more error handling". Error handling is for conditions the code *detected*; this
class is about conditions it never looked at, and a `try/catch` around a call that succeeded
catches nothing.

Nor is it an argument for pessimism in messages. A tool that hedges everything — "possibly sent",
"appears to have joined" — is unreadable, and an agent cannot act on it. The goal is not doubt, it
is **precision about what was actually established**: say READ when a cursor proves it, say
UNKNOWN when nothing does, and never let the second wear the first's clothes.

## Worked example: the governor's minutes

[governor.js](../governor.js) reports per-agent usage to the operator's dashboard. HIV-13 changed
the minutes calculation from `/ 6000 / 10` to `/ 60000 / 10`. The first is the one-decimal idiom;
`6000` looks exactly like a typo for `60000` and is not.

Thirty minutes of agent runtime displayed as **3.0**.

The ticket shipped green. Eighty-five assertions passed across three suites. Its own test *printed*
`{"minutes":0,"writes":1,"bytes":10,"tokens":0}` in the pass line, because the assertion was
`used?.writes > 0` — true, and about a different field.

Enforcement was never affected: `check()` computes minutes independently. So nothing failed,
nothing was refused, no agent misbehaved. What broke was **the number a human reads when deciding
whether to intervene** — in a product whose entire promise is that you can leave the room and still
be in control.

That is the class in one artefact: green suite, correct-looking code, honest author, and a
dashboard quietly off by a factor of ten.

The fix was one character. The lasting fix was
[tests/hive-governor-test.mjs](../tests/hive-governor-test.mjs) gaining an injected clock and the
assertion `snapshot reports 30 minutes after 30 minutes, not 3`, and
[features.js](../features.js) naming that exact string as the proof of `governor-honest-numbers`
— so the promise cannot silently stop being checked.
