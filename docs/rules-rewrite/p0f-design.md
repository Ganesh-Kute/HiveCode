# P0-F: same-line saves made at the same moment fuse silently — design

## What happens (measured 9 Nov 2026)
Base `ship friday`. Alice saves `ship monday`; at the same moment Bob saves `ship tuesday`. Neither has
seen the other's edit, so `reconcile()` sends each save to the shared Y.Text as a character diff
(`fri` → `mon`, `fri` → `tues`). The CRDT keeps both inserts. Every folder converges on `ship montuesday`:
- no conflict markers;
- no chat line;
- no divergence, so every signal reads green.

Present in every published version:

| Version | Saves 0 ms apart | Saves 40 ms apart |
|---|---|---|
| 0.6.0, 0.8.0, 0.11.0, 0.13.0, 0.14.0, 0.14.3 | fused, 3 of 3 runs | conflict markers, 3 of 3 |
| 0.12.4 | fused, 2 of 3 runs | conflict markers, 3 of 3 |

At 40 ms apart the second save has already seen the first edit, so it takes the 3-way merge and gets markers.

`fusionReason()` doesn't catch it, because it only fires when a merge breaks parsing or duplicates
10 or more distinctive lines. The fork gate (`HIVE_FORK_GATE`) catches it, but it's off by default. When
it's on, it also turns edits on adjacent lines into conflicts: 5 agents editing 5 adjacent lines becomes
one 5-way block (`bigproject-test` W1, 8 of 23 checks fail).

## Who it hits
Anyone who saves without claiming the file first:
- humans in an editor;
- an agent that skips rule 3 (claim before you edit);
- any self-hosted relay, where `HIVE_ENFORCE_CLAIMS` is off by default.

**Cost when wrong:** code that neither author wrote lands on every machine, and nothing says so.

## The fix: each save says what it changed, and a clash is resolved exactly once
1. **INTENT.** Every save that reconcile sends to the shared text also writes, in the same Yjs transaction,
   one entry into the file's `intent` map:

   ```
   intent[clientID] = { b: contentHash(F), h: [[baseStart, baseEnd, newLines]...], n: name }
   ```

   - `F` is the text the save was made from.
   - `h` holds only the changed line hunks (from `lineHunks`), not the whole file.
   - Old clients ignore the map.
2. **DETECT, on every client.** A remote transaction that changes an `intent` entry is checked against
   the other intents this client has seen in the last 15 s, its own included. Two intents are a CLASH
   when all of these hold:
   - Same base hash: neither save saw the other.
   - The texts that client recently held include `F`. The last 8 states are kept per file.
   - A hunk of one intersects a hunk of the other on base lines: they changed the same line.
     Edits on adjacent lines are **not** a clash. The character CRDT merges those correctly, and
     treating them as conflicts is exactly the fork gate's W1 false positive.
3. **RESOLVE.**
   - The result is `final = merge3(F, side(low), side(high))`, where:
     - `side(c)` applies `c`'s hunks to `F`;
     - `low` and `high` are the lower and higher Yjs clientID.
   - Every client computes the same `final`. If the two changes differ, it holds conflict markers
     with both versions, as the 40 ms case already does. If both made the same change, it holds that
     change once (`ship monday`, never `ship monmonday`).
   - Only the clashing client with the lowest clientID writes `final` into the shared text. Two clients
     inserting the same text at once would duplicate it, so there is exactly one writer.
   - The existing reconcile path then writes `final` to disk and posts the one MERGE CONFLICT line
     (`postOnce`).
4. **NO FUSED TEXT ON DISK.** Every other client holds its disk while a detected clash is unresolved:
   - Its remote reconcile writes nothing until the shared text equals `final`.
   - Fallback after 8 s, if the writer never delivered:
     - a clashing client writes `final` itself;
     - a bystander releases the hold, so the fused text reaches its disk, and says so in the log.

## Edge cases
- **Three or more clients clash on the same base:** fold `merge3` across them in clientID order. The
  lowest clientID writes.
- **A save built on the other's edit:** its base is the other's text, not `F`, so it's no clash. That is
  the normal merge.
- **A clash already resolved:** each `(base, clients)` set is handled once. A later edit of the markers
  is a resolution, never a new clash.
- **An old client (no intent) clashing with a new one:** not detected. Same as today; listed as a known issue.
- **The writer goes offline before writing:** the 8 s fallback above.
- **Fork gate on:** unchanged. This path runs only when the fork gate is off.

## RED, written before the fix
`tests/same-line-race-test.mjs`: 4 clients on a local relay, fork gate off.
- **R1.** Same line, different text, 0 ms apart:
  - every folder ends with one conflict block holding `ship monday` and `ship tuesday`;
  - no folder ever has `montues` or `tuesmon` on disk (disk sampled every 10 ms);
  - one MERGE CONFLICT line.
- **R2.** Same line, the same change, 0 ms apart: every folder has `ship monday` once; no markers.
- **R3.** Adjacent lines, 0 ms apart: both changes kept; no markers. This is the W1 guard.
- **R4.** 40 ms apart: markers, unchanged.
- **R5.** Different lines far apart: clean merge, no intent clash.
- **R6.** 3 clients on the same line at once: one block, all three versions, nothing fused.

Mutants to kill:
- Overlap counted as touching.
- Every clashing client writes, not just the lowest.
- No disk hold.
- Base hash ignored.
- `low`/`high` swapped on one side only.

## Outcome (9 Nov 2026, integrated on p0f as 5bf73f7)
Built by Claude-cloud and Opus-Cloud, reviewed and run independently by Antigravity-Cloud and VM-ANTI-G-1.
The design above changed during review:
- **Clash rule (Opus-Cloud, F1).** A save is compared by its footprint, the one character span `applyDiff`
  sends. Per-hunk comparison called 8,439 of 49,748 damaging pairs safe.
- **Resolution.** Inside a clash, saves with no line in common are applied cleanly, with no markers. A
  resolution is written only when the shared text equals the union the CRDT must hold, rebuilt from the
  intents (`clashUnion`, Opus-Cloud).
- **Settling.** Every peer waits 750 ms for the whole race before one writer resolves it (R6: three saves
  lost a version).
- **Later saves (Opus-Cloud, F5).** A save made after seeing one side is rebased onto the race's base and
  joins the resolution.
- **Late saves against a block (P0-F-9, 10 Nov).** A late save is merged into every version the block
  holds (block j read as section j), and the distinct results are written as one block per region
  where they differ. Before, a 15 s-late save dropped three authors' versions, and 0.14.3 dropped one
  side of any 2-way block. A first fix kept every section by gluing them together, which let the next
  merge come out clean with lines no author wrote (`a = 1 / b = 1 / a = 2 / b = 2`): now replaced.
- **Adjacent lines (#17, 10 Nov).** The sync merge (`icrMerge3`, and the fork gate's real-fork check)
  applies two touching edits side by side when both replace lines one for one, as the footprint rule
  and the character CRDT already do. Overlap, an insertion or deletion at the edge, and a change of
  line count still conflict. Plain `merge3`, git-clash and the extension keep git's rule.
- **A same-line save that arrives after the block was written (P0-F-12, 10 Nov; Antigravity-Cloud).** It
  landed as a character edit against the text the block replaced, beside the block:
  `wednes<<<<<<< Bob`, at 8, 17 and 30 s late alike. Every client now recognises that shape
  (`lateOverBlock`: the save's inserted text, at an edge of a block whose versions are edits of the
  same lines). The late author's client adds its version to the block, and the others hold their disks
  until it lands. It acts only against a race's resolution, never a block a merge raised, which the
  race path keeps (R10). `same-line-very-late-test` 12/0 (6 failing before), `same-line-late-unit-test`
  9/0.
- **Blank lines (#19, 10 Nov).** Found on the way: the structural merge added a blank line after every
  edited one-line top-level statement in .py, .rb and .yaml files, and left a deleted line's blank
  lines behind. Fixed in `spliceUnits`, and the sync merge takes the clean line merge when the two
  differ only in blank lines (`icr-blank-lines-test` 11/0).
- **Two late-save cases the soak found (P0-F-13, 10 Nov).** `same-line-soak-test` checks the thing
  itself: on every disk, during the round and after it, every line is one somebody wrote. Its first
  round (seed 1: one client 18 s late, one 9 s late) failed twice.
  - *A late author's repair was dropped for good.* Its client cleared the pending save before the
    repair was written. When another change arrived in the same burst (the 9 s client's edit of the next
    line), the text had moved on, the write was skipped, and nothing retried it:
    `>>>>>>> carol"alice-r1"`, alice's line gone, in every folder. The pending save now stays until a
    repair lands, so the next arrival takes it up against the newer text.
  - *The other disks took the fused line for about a second.* A save 18 s late met a line that one
    other author had changed. Clients forgot a save after the 15 s race window, so only the two authors
    still knew of both, and the others wrote `const v4 = "carol-r1""alice-r1"` to disk until the block
    landed. Every client now remembers a save for as long as a held save still counts as a race (2 min).
  - *A file's author did not know its own text* (seed 2). A first publish records no intent, so the
    text was never remembered; two later saves of one line looked like no race to that client, and
    their fused line went to its disk. Every text a client puts in the room is now remembered.
  - *A far-line edit stopped the late repair* (seed 3). `lateOverBlock` wanted the block's versions to
    differ from the base on the save's lines and nowhere else. It now asks only that each edits those
    lines; the late-save merge carries the other change into every version.
  - *An unresolved race said nothing* (seed 2). See the first known limit below.
  - *A dropped connection erased the race* (seeds 4, 5, 7; every case had a 25 s hold). A client took
    its intent out of the room after 16 s. A client whose connection dropped for longer resyncs in one
    update, in which an intent set and then deleted is not there at all: nobody saw the race, and the
    fused line stayed with no markers and no message. Intents now stay for 2 min, like everything else
    about a late save. The "check by hand" warning is sent on evidence (a line nobody wrote, or a
    broken marker), not merely because the text has no markers.

### Evidence

| Test | Result |
|---|---|
| `same-line-race-test` | 30/0 |
| `same-line-later-save-test` | 18/0 |
| `same-line-intent-unit-test` | 63/0 |
| `same-line-fuzz-test` | 15/0 |
| `late-save-merge-test` | 19/0 (RED on f051913: unmarked fusion in 962 of 1,500 fuzz cases; on 0.14.4: lines lost in 1,310) |
| `same-line-very-late-test` | 12/0 (6 failing before: `wednes<<<<<<< Bob` at 8, 17 and 30 s) |
| `adjacent-lines-merge-test` | 23/0 (9 failing before; 408 of 4,000 fuzz cases merge only under the new rule, each exactly both sides' edits) |
| `same-line-soak-test` | seeds 1 to 3, 3 rounds each: 9 of 9 rounds (5 rounds failing before P0-F-13) |
| `same-line-late-unit-test` | 11/0 |
| `merge-balloon` | PASS |
| `r9-loop` | 20/20 |

- **`bigproject` with the fork gate on:** all 23 checks pass, against 8 of 23 failing on f051913 (W1, W2, W3).
- **`bigproject` in default mode:**
  - W2, the same-line collisions, fused in 4 of 4 runs on 0.14.3 and in 0 runs since the fix.
  - With one client 5 s late, 0.14.3 produced `ship monwednesthurstuesday` in every folder. The fix gives
    one 4-version block everywhere.

  - W1, adjacent lines: README.md got markers in 2 of 3 runs on f051913 (only non-code files: .js and
    .py went through the structural merge); 0 of 3 since #17.

### Known, not fixed here
- **Two races in one file, both with late saves.** The second race cannot be resolved: the file changed
  since its base (the first race's block), so no client can compute the text it should replace. Its line
  stays fused. It is never silent: the room is told to check that file by hand, also when the file
  already holds markers (before P0-F-13 that case said nothing). The sound fix is for a late save to be
  merged against the exact text the room held before it arrived, which every receiving client has.
- **A late save's repair needs its author online** (its client writes it). If it is not, the others
  let the text through after 8 s and say "check by hand". A save held for more than 2 min is treated as
  an offline edit (F4).
- **A block that the base and the author's copy both hold** (an edit made with the block on disk, while
  the room's copy changed elsewhere) still merges into one coarse 2-sided block, and a 3-version block
  has its later sections glued inside it. Everything stays inside markers and nothing is lost.
  Pre-existing.
- **Different bases (F4).** When the two saves were made from different texts, because one client had not
  yet received the last change, the race is not seen.
- **Clients on 0.14.4 or older** write no intents, so a race with them is not seen.
- **The VS Code extension** keeps its own copy of reconcile, still with 0.14.4's one-side strip.
  VM-ANTI-G-1's port has to take `mergeLateSave` and pass `sideBySide` from its sync merge.
