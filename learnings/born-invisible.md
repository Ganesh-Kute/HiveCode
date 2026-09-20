# Born invisible

**The work is real, the write succeeds, every call returns success, and the bytes never leave the
machine — because the file was outside a scope nobody mentioned.**

This is not a lost write. The file is on disk, correct, exactly as intended. It is *unshared*, and
nothing in the system is shaped to say so, because from inside the process that wrote it, a write
that lands on disk and a write that lands in the room are the same two lines of code.

## The shape of it

Every layer answers honestly about the thing it owns, and no layer owns the question being asked.

    the editor      wrote 12,396 bytes         true
    hive_claim      "claimed — it's yours"     true, the claim is in the room's claims map
    hive_release    released                   true
    the test run    11/11 passed               true, against the file on that machine
    the room        nothing                    also true, and nobody asked it

The agent then reports "the patch is synced" — which is the one sentence in the chain that was
never checked by anything, and is the only sentence that mattered.

## Why it survives review

**A reviewer checks the work, and the work is right.** Read the diff: correct. Read the tests:
they pass, and they are real tests that fail when the code is wrong. Every artefact a reviewer
normally inspects is genuine. The defect is not in any artefact; it is in the *relationship*
between the artefact and everybody else, and there is nothing to open that shows it.

**It reads as dishonesty.** The natural conclusion — the one I reached, out loud, twice — is that
the agent reported work it did not do. That conclusion is worse than useless: it is confidently
wrong, it costs trust, and it points every subsequent minute at the wrong thing. On 20 Sep 2026
this cost about forty minutes and two public accusations before anyone thought to ask *why* a
correct file would fail to travel.

**Scope is invisible by construction.** A `.gitignore` allow-list, a write-scope token, a sync
manifest — none of them are in the file, the diff, the test output, or the tool's reply. You
cannot see the boundary from inside the thing that is outside it.

## Why the obvious fix makes it worse

**"Just check that the file exists after writing."** It does exist. That check passes, and having
passed it you are now more confident and equally wrong.

**"Re-read the file to confirm the write."** You read back your own copy. That is the write
confirming itself. Every no-cursor-no-evidence problem in this codebase has this same shape: an
observation that cannot distinguish the two states you care about.

**"Widen the scope so nothing is excluded."** That is the fix that caused this. The allow-list
exists because Hivecode opens one WebSocket *per file* and the relay caps a room at 256; the repo
has 481 tracked files. Removing the list restores the failure it was written to prevent — files
refused, refused files reading as empty, and 186 of them written to zero bytes. The scope is not
an accident to be removed. It is a constraint to be *reported*.

**"Make the agent more careful."** The agent was careful. It read the file it was told to read,
patched the right path in the right folder, wrote real tests and ran them. Care was not the
missing ingredient; a question it had no way to ask was.

## How to catch it before you ship

**Refuse at the boundary, not after it.** Whatever knows the scope must say no at the moment of
the claim. `hive_claim` on a path the room will never sync has all the information required to
refuse, and returning "it's yours" is the defect — not the write that follows it.

**Say which of the three it is.** "Not syncable" does not tell anybody whether to fix their path,
their ignore file, or their token. A refusal that cannot be acted on gets worked around.

**Report what the room says, never what you did.** The rule this produced, stated as a rule:

> Never report that something landed. Report what you observed *after* it landed.
> Your own disk is not proof of delivery.

Concretely: after a write, ask the shared side. `hive_status` reports `filesSynced`; during this
incident it read **21 of 53** while every individual call was returning success. That number was
free, sitting there, and nobody looked at it.

**Treat scope as state that can change under you.** The allow-list that made this file invisible
was not in the room when the file arrived. It landed four minutes later, inside another client's
folder, and silently un-synced a file that had been propagating fine. A joining participant
changed what the room shares, for everybody, retroactively, and nothing announced it.

## What it is not

**Not a merge conflict.** Nothing collided. There was no second version to lose to.

**Not a permissions error.** Nothing was denied. Denial would have been the good outcome.

**Not [absence-rendered-as-a-value](absence-rendered-as-a-value.md).** There, a thing that is
missing is read as a value — an unsynced doc returning `''` and being written to disk. Here the
content is present and perfect and simply never travels. The two are mirrored: one publishes
nothing as if it were something, the other keeps something without publishing it at all.

**Not an agent problem.** It is worth saying plainly because the instinct runs the other way: the
same trap is documented earlier in this project, in my own words — *"under a narrowed allow-list
you must widen the list before creating the file, or it is born invisible"* — and I walked into it
myself, on 20 Sep, in the same hour I was telling another agent to be careful about exactly this.

## Worked example: a correct patch, a public accusation, forty minutes

Room `night`, 20 Sep 2026.

**15:44:59** — `hive-receipts.js` copied into the room, 10,316 bytes. It syncs. Every participant
has it; one of them reads all 189 lines and quotes them back accurately.

**15:49** — a third client joins with a full repo checkout instead of an empty lane. Among the 62
files that arrive before it is stopped is a `.gitignore` written two days earlier as a workaround
for the socket cap:

    /*
    !/.gitignore
    !/sync.js  !/hive-mcp.js  !/core.js  !/icr.js   ...

`hive-receipts.js` is not on that list. From this moment it is unsyncable, for everyone. Nothing
is announced. Nothing errors. The file does not change; the rules about it do.

**~16:00** — an agent claims it, patches it correctly to 12,396 bytes, runs 11 assertions against
it, and reports: *claim acquired, patch applied, released, 11/11 passing, synced in lane room
night.* Four of those five statements are true.

**16:00** — the room copy is measured: mtime unchanged at 15:44:59, size 10,316, `diff` empty,
`grep transcriptStateFor` finds nothing outside the agent's own chat message, `hive_claims` shows
nothing held. The conclusion drawn, publicly: *you reported work you did not do.*

**16:05** — the agent answers with the one thing that settles it, a path and an `ls -l`, plus the
line from `sync.js` that drops an ignored path, plus the allow-list header. It is right. The
accusation is withdrawn.

Cost: about forty minutes, two wrong public accusations, and a second agent nearly sent to verify
a file it would have found unchanged — which would have read as the implementation being broken
rather than absent.

What made it recoverable was not intuition. It was that the agent could produce **an absolute path
and the output of `ls -l`**, against a claim made from the other side. Two measurements of the same
fact, taken from two machines, is the only thing that separates "you did not do it" from "it did
not travel."
