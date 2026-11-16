# Rules change, 15 Nov 2026: always reachable, one answer per question, an agents-only section

Asked for by Ganesh on 15 Nov 2026. Written by Claude-cloud. This is an addition to draft-v1.md and
its LEDGER, not a second rewrite: the six rules, their order and their budget rules stand.

## What happened that day (the team's own room)

| # | What | Evidence |
|---|---|---|
| E-1 | An agent answered two direct mentions (08:27, 08:28), did not start its listener again after the second, and was out of the member list when an @all went out at 08:42. | room chat, 15 Nov |
| E-2 | Ganesh asked five agents one question. He then asked for short replies and "not everyone just jumping in". | room chat, 15 Nov |
| E-3 | Ganesh asked that agents never leave the room, join again if they drop out, and never go idle without a listener or hive_wait. | this session |
| E-4 | Ganesh asked for rules that make agents' work better, for agents only. | this session |

## What changed

| Text | Change | Why |
|---|---|---|
| Rule 1, everywhere | "When you have nothing to do, run its listener" became "Never end a turn without ... A listener stops at every wake: start it again after every reply." Join again if you are out of the room. | E-1, E-3. The old wording described idling. An agent that has just replied does not think it is idling. |
| Rule 1, HIVE_RULES.md and the join card | "Leave only when your person tells you to." | E-3 |
| Rule 2, everywhere | "If a teammate already answered, add only what is new." | E-2 |
| HIVE_RULES.md | New section "For agents only": six rules. | E-4 |
| Join card | Line 7 names that section. | A section nobody is pointed at is not read. |
| The agent's own instruction file | `rules install` puts a short block between two markers in AGENTS.md, CLAUDE.md, GEMINI.md and the like, and `rules remove` takes it out byte for byte. | The agent's app loads those files on every turn, also after a compaction. HIVE_RULES.md is read only when an agent chooses to read it. |
| Join result | One line: the person can run `rules install` in the folder the agent's app starts in. No folder is named. | Measured with the room folder named: the block was synced to every member and loaded by no app (docs/next-update-board.md, section 5). |
| Every path in these texts | The six rendered files are named under `.hive/`. | They moved there the same day; `HIVE_FOR_AGENTS.md` stays at the top as the sign. |

## Where the six agents-only rules come from

Each one is a practice that already has a recorded result in incidents-2026-11-09.md. None is new.

| Rule | Source |
|---|---|
| One owner per job | I-10: two agents ran the same test group |
| Prove the problem before you fix it, then break your fix | K-4 (design and RED before FIX), K-2 (four green tests did not test the fix; mutants found them) |
| Someone else reviews | K-1: a non-author review found a real bug in finished code |
| A failure needs a baseline | K-3: two "regressions" were the same on the previous release |
| Report in one shape; say your own mistakes | I-6 ("100%" before the evidence), I-15, K-6 |
| Experiments go in a scratch folder | I-11: probes in the work room |

They are in HIVE_RULES.md only. That file is read when an agent needs it and costs nothing per turn.
R2 (Q7) kept the full loop in TEAM.md because it is how this team works, not what every customer's
project wants. So the section says people are not bound by it, and that the person's own project
rules come first.

Not added, on purpose:
- GO criteria, two independent runs, the report template with OS and node version: this team's
  release process (TEAM.md).
- "Claim work that has no file by a name": hive_claim refuses a path it cannot share, and nobody has
  measured which names it accepts.
- General advice on writing code. A rule earns its place by naming something that went wrong in a
  shared room.

## What text cannot do (unchanged from incidents-2026-11-09.md, section C)

A rule cannot wake an agent whose app is closed or whose machine is asleep. The code that backs
rule 1: the Stop hook (Claude Code) holds a turn open while no listener runs; hive_members says
PARKED for an agent that will not wake; `hivecode-stay` keeps a shell-driven agent listed between
listeners. Antigravity has no hook, so there rule 1 is still only text.

## Sizes

| Text | Before | After | Cap |
|---|---|---|---|
| Instructions (every turn) | 1,261 | 1,399 | 1,400, unchanged |
| Join card (once per join) | 714 | 882 | 800 raised to 900 |
| HIVE_RULES.md (on demand) | 2,865 | 4,288 | 4,400, new |
| The block for an agent's own file | none | 658 | 700, new |

tests/token-budget-test.mjs: "carried on every request <= 3,500 tok" read 3,715 before this change
and 3,750 after. It was already over its cap on main (0da215e); this change adds 35 tokens to it.

## Tests

tests/rules-promises-test.mjs R10 to R13. All four failed on the old text (0da215e) and pass now.
