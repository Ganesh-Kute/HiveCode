# learnings

Writeups of **defect classes**, not of defects.

A bug report says what broke. A learning says what *kind* of thing broke, why it got through
review, why the obvious fix makes it worse, and how to spot the next one — which is the only part
that pays for itself, because the next one will be in different code and will not look the same.

Eight are here. Every one was found on this repo, and every one has already recurred at least once.

| | what it is | first cost |
|---|---|---|
| [false-success.md](false-success.md) | nothing fails, every signal is green, the result is wrong | the umbrella; every defect on this project has been one |
| [absence-rendered-as-a-value.md](absence-rendered-as-a-value.md) | "I do not know" is written down as a number, and the number is believable | 186 files silently zeroed per folder |
| [green-but-not-testing-it.md](green-but-not-testing-it.md) | the suite passes and proves nothing — wrong assertion, or right code never called | a 10× wrong dashboard shipped past 85 passing assertions |
| [repair-the-class-not-the-copy.md](repair-the-class-not-the-copy.md) | the fix lands on one instance and the class survives | an identical crash lived through two more tickets |
| [born-invisible.md](born-invisible.md) | the write is real and correct, and lands outside a scope nobody mentioned, so it never travels | a correct patch read as a fabricated one — 40 min and two wrong public accusations |
| [testing-the-consumer-instead-of-the-derivation.md](testing-the-consumer-instead-of-the-derivation.md) | the test constructs the input it is testing the derivation of | a deleted provenance check stayed green across 31 passing assertions |
| [a-negative-from-an-unproven-probe.md](a-negative-from-an-unproven-probe.md) | the check reads a different channel than the product writes, and its negative is believed | a working fix deleted on a clean, wrong "did not fire" |
| [a-default-nobody-chose.md](a-default-nobody-chose.md) | the code is correct and nobody agreed to it — a value reached by omission | a team's source published to a relay they do not run, every status green |

## What belongs here

A class earns a file when **all four** are true:

1. **It has happened at least twice**, in different code. Once is a bug. Write the bug in the
   commit message and move on.
2. **Review did not catch it**, and you can say why. "We were careless" is not a reason; it does
   not generalise and it cannot be checked for.
3. **There is a detection heuristic** — something concrete to grep for, assert, or look at. A
   learning with no way to spot the next instance is an essay.
4. **The obvious fix is wrong**, or at least insufficient. If the fix is obvious and complete,
   the class does not need a document.

## What does not

- A bug, however painful. That is a commit message and a test.
- A convention ("name helpers `vx_`"). That is a rule, and rules go in the rules file.
- Anything you have not measured. Every number in these files came off this machine, and every
  file path in them exists. `tests/learnings-test.mjs` enforces the second part.

## How to write one

Follow the shape of the ones already here. The two sections that make it more than a bug report are
**"Why the obvious fix makes it worse"** and **"What it is not"** — the first stops the class
recurring under a new name, and the second stops the lesson being over-applied by someone who
just read it and is now seeing it everywhere.

End with a **worked example** naming real files and real numbers. A class without a worked example
reads as generic advice, and generic advice is skipped.

## Why this directory exists at all

The idea is borrowed. Agent Relay (YC F26, Apache-2.0) keeps `learnings/` in their repo with one
file in it, `duplicated-wire-contract.md`. That file describes, in a codebase none of us has
touched, the defect this repo already had in `reconcile()` — two hand-written descriptions of one
thing, only one of which anybody keeps current.

Two independent teams reaching the same writeup is the argument for keeping these. The shape of a
defect travels further than the defect does.
