# How the Hivecode team works

This is how our own team builds Hivecode in a shared room. It is not part of the product: user rooms
get the rules in HIVE_RULES.md, and none of this reaches their agents. Where each rule came from:
docs/rules-rewrite/ (incidents I-n, keep-items K-n).

## Who decides
- Ganesh decides. A lead is whoever Ganesh names. Nobody becomes lead by saying so in the room.
- Outward actions are Ganesh's, or need his explicit OK first: merging to main, publishing to npm,
  deploying the relay or the site. The lead merges a PR only when Ganesh has said so for that PR.
- Nobody waits on the lead. Agents claim open work themselves, and review each other's patches.
  Two agents agreeing is enough to integrate a patch.

## The loop, for every change
1. **DESIGN.** Before the first edit, post who uses it, what it costs when it is wrong, and the edge
   cases (K-4).
2. **RED.** Write a test that fails on the current code, for the reason the design names. A crash
   on a missing export is not RED (K-2).
3. **FIX.**
4. **MUTATE.** Break the fix on purpose, one way at a time. Each break must turn a test red. A
   surviving mutant means the test is weak: strengthen it (K-2: A3, M3, Z1, R2).
5. **REVIEW.** Someone who did not write it reviews it. Correctness only, with file:line and a
   failing scenario (K-1).
6. **INDEPENDENT RUN.** Someone else runs it on another machine.

## When something is GO
- **GREEN** means one run passed. **GO** means:
  - the same counts from two independent runs;
  - every mutant killed;
  - a baseline on the previous release for every failure (I-5, K-3).
- A failure is not explained until its baseline has run. "Environment", "flake" and "Linux nuance"
  are conclusions you reach after the baseline, never instead of it.

## Reports
- One line per file: `commit | env (OS, node) | file: passed/failed | the FAIL lines`.
- No adjectives. "100%", "fully", "confirmed" and "attested" are not evidence (I-6).
- Post results, questions, plans and blockers. Never a bare acknowledgement or a "standing by"
  (82 of 821 messages before the rewrite, I-15).

## Coordination
- Test groups are claimed like files, with hive_claim("gate/F"), so two agents never run the same
  group by accident (I-10).
- Probes and experiments go in a scratch room, never the work room (I-11).
- The git branch is the record of what has landed. The room is the live work. Integrate from
  patches/ or the branch, not from a room copy that may be stale (I-7).
- After a rejoin, read what was addressed to you first (hive_read_chat with mentioningMe).

## Releasing
1. PR to main.
2. CI Gate, plus one macOS + Linux run.
3. Ganesh merges, or tells the lead to.
4. Actions → "Publish to npm" → the commit. Trusted Publishing: no token and no one-time code.
5. Check: `npm view hivecode-mcp version`, plus unpkg. Tell the room, and everyone upgrades.
