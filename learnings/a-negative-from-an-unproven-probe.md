# A negative from an unproven probe

**The check reads a different channel than the product writes to, finds nothing there, and reports that the feature does not work.**

This is the mirror of [green-but-not-testing-it.md](green-but-not-testing-it.md), and the mirror is
the dangerous half. A false pass leaves working code in place and costs you confidence you had not
earned. A false *fail* makes you act: you delete the feature, revert the commit, reopen the ticket,
and tell your teammates it does not work. The instrument was wrong, and the only thing it destroyed
was the thing it was pointed at.

Asked plainly, the question is never "did the feature fire?" It is "would I have seen it if it had?"

## The shape of it

Anything worth checking crosses a boundary. The product writes its evidence somewhere — a channel,
a store, a stream, a file — and the check reads from somewhere. When those two are the same place,
a negative means something. When they are not, a negative means nothing at all, and it looks
identical:

| the product writes to | the probe read | what the probe printed |
|---|---|---|
| the room chat, via `say()` | the `log` callback passed to `startSync` | "GUARD FIRED: NO" |
| a Y.Map on the file doc, indexed in `history` | a `.hive-snapshots` directory on disk | "no snapshots at all" |
| citations carrying a directory, e.g. tests/mention-boundary-test.mjs | a regex with no `/` in its character class | "12 citations, all resolve" |

Every one of those three is a clean, quiet, believable negative. None of them is a crash, an error,
or a suspicious zero. The probe worked perfectly; it was aimed at the wrong wall.

## Why it survives review

- **A negative needs no explanation, so nobody writes one.** A passing assertion invites "what did
  it prove?" A failing one already tells a story — the feature is broken — and the reviewer's
  attention goes to the feature, never to the instrument.
- **The probe is usually correct about its own channel.** `log` really does receive lines.
  `.hive-snapshots` really would contain snapshots in a design where snapshots were files. Nothing
  about the reading code is wrong in isolation, which is why reading it again does not help.
- **Debug probes are written to be thrown away.** The check that deleted a working guard was an
  ad-hoc script, not a suite entry. It got none of the scrutiny a committed test would have, and it
  was trusted exactly as much.
- **It is cheapest to believe.** A negative confirms the suspicion that sent you looking. On
  21 Sep 2026 the probe agreed with what the code seemed to say, and the agreement of two wrong
  readings read as corroboration.

## Why the obvious fix makes it worse

The obvious fix is "read the right channel." It is not a fix, because **you cannot tell from a
negative which channel you read.** That is the entire defect. Applying it produces an agent that
re-reads the product source, satisfies itself that the channel is right, and re-runs the same probe
with more confidence than before. Both readings were wrong on 21 Sep, in the same direction: the
stated reason for deleting the guard ("the manifest is not populated at the sync event") was later
measured at 13 of 13 populated.

The second obvious fix — "be more careful with negatives" — is not checkable, so it does not
survive a week.

The fix that works is structural and it is one line of discipline:

> **Before you accept a negative about a feature, make the probe produce a positive.**

Force the condition you believe is absent, by whatever crude means — hand-write the record, call the
internal function directly, plant the string. If the probe now reports it, the probe can see; a
negative from it is evidence. If the probe still reports nothing, you have found your bug, and it is
in the probe. This costs one extra run and it is the only thing that distinguishes "the feature did
not fire" from "I cannot see this feature at all."

## How to catch it before you ship

1. **Grep your own assertions for absence.** Failure messages of the form `no X at all`, `never
   fired`, `not found`, `0 matches`, `GUARD FIRED: NO` are the signature. Each one needs a companion
   assertion, in the same suite, that goes red when the feature is removed *and* green when it is
   present. `tests/blind-recreate-test.mjs` D3 is that companion: it pins that the announcement is
   **not** in `log`, so the next reader cannot repeat the search that lost the fix.
2. **Name the channel in the assertion text.** "the refusal is announced in the ROOM CHAT, where
   `say()` puts it" carries the boundary into the output. "the refusal is announced" does not, and a
   reader six weeks later has to re-derive it.
3. **Count what you examined, not just what passed.** A probe that searched zero candidates and a
   probe that searched forty and found nothing print the same negative. `tests/learnings-test.mjs`
   B3 exists only to report the count.
4. **When a negative would make you delete code, it needs two instruments.** Not two runs of one
   probe — two independent readers. Disk bytes and the room chat disagree loudly when one of them
   is wrong.

## What it is not

- **It is not "test the happy path too."** The probes here were all aimed at real defects and three
  of them were right about the defect existing. The failure is in trusting the aim, not the target.
- **It is not [testing-the-consumer-instead-of-the-derivation.md](testing-the-consumer-instead-of-the-derivation.md).**
  There, the test fabricates the input and the derivation is never exercised. Here nothing is
  fabricated — the product ran, correctly, and the observer was looking elsewhere. The two can
  co-occur, and the tell is different: that class is caught by asking "who computed this input?",
  this one by asking "where does the product write, and is that where I read?"
- **It is not [absence-rendered-as-a-value.md](absence-rendered-as-a-value.md).** That class is the
  *product* turning "I do not know" into a number a caller believes. This class is the *observer*
  doing it to itself. The product is innocent; often it is working exactly as designed, which is why
  the instinct to go fix it is so expensive.
- **It does not mean every negative needs a ceremony.** A negative you are about to *act* on needs a
  positive control. A negative that merely sends you to read more code does not.

## Worked example: the guard that worked and was deleted anyway

HIV-P14b. An agent holding 8 of a room's 41 files writes mod039.js, a file it cannot see because
that file is outside its bounded working set. The room already has it. Without a guard, the
empty-base merge unions two whole files into the other agent's copy and produces two `const v39`
declarations — invalid code, in someone else's folder, with every signal green.

The guard was written in `sync.js`, in the no-base block, and it announces its refusal with `say()`
into the room chat. A probe was then written to confirm it fired. The probe collected the `log`
callback passed to `startSync` and searched it for the announcement. It printed:

    GUARD FIRED: NO

The guard had fired. The other agent's file was clean — one declaration, byte-identical to the
original — which the same probe could have checked and did not. Acting on the negative, the guard
was removed from `sync.js` and the ticket reopened as unsolved.

What it cost to undo: re-deriving the design, instrumenting `reconcile()` with four env-gated trace
lines to find which branch a blind recreate actually takes, and one measured run to produce

    [P14] mod039.js origin=remote synced=true docLen=22 diskLen=39 hasBase=false
          inManifest=true preexisting=false   -> BRANCH=no-base-block

which put the deleted guard back in exactly the same place it had been. The measurement also refuted
the stated reason for the deletion: the manifest held 13 of 13 entries at that moment.

The same suite written to replace the probe hit the class again, four assertions later. C2 asserted
that the refused agent's draft survived as a restore point, and looked for a `.hive-snapshots`
directory. Restore points are not files — `captureSnapshot` writes into a `snap` Y.Map on the file
doc with an index in `history`, surfaced by `listHistory()`. C2 reported `no snapshots at all` about
a feature that had worked on the first run. Reading listHistory for that path returns the
entry, labelled `local draft preserved — mod039.js already existed in the room before this client
joined`, attributed to the agent that wrote it.

Three instances, one working day, one class: **the probe and the product disagreed about where the
evidence lives, and the probe was believed.** The final suite reads only channels the product
actually writes — bytes on disk and the room's `chat` array — and D3 pins the boundary that cost the
first fix.
