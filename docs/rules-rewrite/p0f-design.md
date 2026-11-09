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
