# Repair the class, not the copy

**The fix lands on the instance in front of you. The other instances are still there, and one of
them is now harder to find, because the class no longer has a memorable failure attached to it.**

This is the defect that justifies this directory existing, and the most recent instance of it is
the directory's own author fixing one of two identical bugs and calling it done.

## The shape of it

A defect is found in one place. The fix is correct and local. Nobody asks the second question:

> *Is there another site with this same property?*

The asking is the whole job, and it is skipped for an honest reason — at the moment of the fix you
are holding one stack trace, one file, one reproduction. The other sites have no symptom yet. They
are not hiding; nothing has drawn a line to them.

So the class survives, and the next occurrence arrives stripped of context: a different file, a
different symptom, weeks later, investigated from scratch by somebody who does not connect it to a
fix they read about once.

## Why it survives review

- **The diff is correct.** There is nothing to object to. A reviewer checks what changed, and what
  changed is right.
- **The reproduction closes.** The test passes, the crash stops, the ticket is verifiable. Every
  signal says done.
- **Finding siblings requires a query nobody formulated.** You cannot grep for "the same mistake";
  you have to first name the *property* that made it a mistake — here, *an async call whose
  rejection escapes a synchronous `try`* — and naming that is a separate act of thought from
  fixing it.
- **The second site often has a comment claiming it is handled.** Both of ours did. Both said
  `// client might not support notifications, swallow error`, sitting directly under a `catch` that
  could not catch the thing.

## Why the obvious fix makes it worse

The instinct after being bitten is **be more careful next time**. That is not a mechanism, it does
not survive the person who said it, and it cannot be checked.

The second instinct is **fix the sibling too** — necessary, insufficient. Two hand-repaired copies
with no link between them is exactly the state that produced the defect, now with a precedent that
keeping them in sync by hand is how this codebase works. The next one drifts too. (Agent Relay's
[`duplicated-wire-contract.md`](https://github.com/AgentWorkforce/relay) reaches the same
conclusion from the other end: *"Repair the link, not the copy."*)

**The fix is to make the class countable.** Name the property, find every site, make them
identical on purpose, and leave behind something that fails if a new one appears:

```bash
# both numbers must match — every notification site is guarded
grep -c "Promise.resolve(server.notification" hive-mcp.js
grep -c "server.notification" hive-mcp.js
```

That is two lines and it converts "be careful" into a thing that can be run.

## How to catch it before you ship

**At the moment you finish a fix, before you commit, ask what made it wrong** — as a property, in
words, not as a location. Then grep for the property.

| the instance | the property | the grep |
|---|---|---|
| this `try` did not catch an async rejection | a promise-returning call inside a sync `try` | `git grep -n "try {" -A3 \| grep -v await` |
| this type described a payload twice | two declarations of one runtime shape | grep a **sibling** field, not the new one |
| this empty came from a refusal | a failure path returning the success type | `git grep -n "} catch { }"` |

The middle row is Agent Relay's heuristic and it is the sharpest of the three: the field you are
adding appears nowhere by definition, so search for one that has been on the payload a while. Two
hits in two files means two declarations.

If the grep returns one site, write that down in the commit. If it returns several, the ticket just
got bigger and that is the correct outcome.

## What it is not

This is not "always generalise the fix". Most fixes should stay local. Generalising a one-off into
a framework is its own failure mode and a more expensive one.

The trigger is narrow: **the fix was correct because of a property the code has, and that property
is not unique to this file.** A logic error in one function is a logic error in one function. A
`catch` that structurally cannot catch what it wraps is a property, and properties repeat.

Nor is it an argument for deduplication. Two similar-looking things that describe genuinely
different subjects should stay apart; merging those couples things that are free to diverge.

## Worked example: the crash that outlived its own fix

[hive-mcp.js](../hive-mcp.js) has two places that push an MCP notification from inside a Yjs
observer — one for mail, one for `swarm_state`. Both were written the same way:

```js
try {
  server.notification({ ... })
} catch (e) {
  // client might not support notifications, swallow error
}
```

`notification()` is **async**. A failure is a rejected promise, not a thrown exception, so it
passes the `catch` untouched, becomes an unhandled rejection, and takes the process down from
inside an observer — with a stack pointing at a `try` that looks like it has the case covered.

**19 Sep, first sighting.** A second agent posting chat crashed the obligations end-to-end suite.
Found, understood, fixed:

```js
Promise.resolve(server.notification({ ... })).catch(() => { })
```

I fixed the mail observer. I did not ask whether there was another one. There was, eleven lines
above, visible in the same file I had open.

**Two tickets later.** The throttle end-to-end suite crashed. Same error, same shape, same file —
`Error: Not connected`, thrown from the `swarm_state` observer at line 197. The investigation
started from zero, because nothing linked it to the fix two commits earlier.

Total cost: one crash re-diagnosed, one suite blocked, and a defect that lived through HIV-30 and
HIV-31 in a file that was edited in both.

What exists now, and what did not before:

- both sites are written identically, deliberately, with a comment at each saying the other exists
- the two `grep -c` counts above must match, which is checkable in one line
- this file

The instance took four minutes to fix, twice. The class took one paragraph, once.
