# Operating Hivecode with a team

The setup guide is in the [README](../README.md). This page is the next layer down: the
behaviours that surprise people once a real team is in a room, and how to check each one.

The failures that cost real time here are not merge failures. They are setup failures that
report success. Each item below was measured, not guessed.

### One folder per participant. Always.

Two agents pointed at the same directory coordinate through the filesystem, and every
`hive_*` call still returns success. It looks like multiplayer and it is not — nothing is
being tested, and the collision handling you came to evaluate never runs.

```
alice/   <- her agent syncs here
bob/     <- his agent syncs here
```

Same room, different folders. `hive_members` should list every participant; if it doesn't,
they are not actually in the room together.

### One WebSocket is opened per file

This is the most important operational fact about Hivecode and the one that surprises
people. A relay admits a bounded number of connections (`maxConnsTotal`, default 2048;
per-room default 8 on the free tier). A repository with more files than that cannot open a
socket for each one, so the client keeps a **bounded working set** — the most recently used
`HIVE_MAX_OPEN_FILES` (default 128) stay connected and the rest are closed and reopened on
demand.

**The consequence, stated plainly: a file outside the working set is not on your disk yet.**
It exists in the room, and `hive_claim` on the path — or `fetch(path)` if you want to wait for
the bytes — brings it down. An agent that instead lists its directory, does not see the file,
and concludes it does not exist will write a new one, and that is how you get two definitions
of the same thing.

That sentence was false until 21 Sep 2026, and it is worth saying so rather than quietly
fixing it. Measured against a client holding 8 of a room's 41 files, on a path that *was* in
the manifest: `claim()` returned `true`, the file's doc was never opened (`headOf` → `null`,
0 provenance receipts), no bytes arrived after 9 seconds, and there was no `fetch`, `read` or
`open` in the API at all. One line in `reconcile` was the cause — the file doc was only opened
when something already existed on local disk — so the *only* way to obtain a file you could
not see was to write to the path, which is exactly the blind recreate described below. The
documented safe route did nothing and the dangerous route worked.

`fetch(path)` resolves when the bytes are on disk, not when a flag flips, and it tells the two
lookalike cases apart:

| what you get back | what it means | what to do |
|---|---|---|
| `{ ok: true, bytes: N }` | it was in the room, it is on your disk now | read it |
| `{ ok: true, alreadyLocal: true }` | you already had it | nothing |
| `{ ok: false, notInRoom: true }` | **no client has ever published this path** | nothing will ever fetch it; check the room's ignore rules, then have whoever holds the file write it into their synced folder |
| `{ ok: false, timedOut: true }` | in the room, did not arrive | the file's own socket is likely refused — check `filesHeld` against `roomFiles` |

The `notInRoom` case is the one that cost an afternoon. From an empty directory it is
indistinguishable from a working-set miss, and the remedies are opposite: one is fetchable, the
other never arrives no matter how long you wait.

So the client now tells you, at join:

```
!! THIS FOLDER IS INCOMPLETE ON PURPOSE. The room has 41 files; 8 are on disk
   here and 33 are NOT. ... A missing file EXISTS — it simply has not been
   fetched. Do not treat it as absent and do not create it.
```

And `hive_status` reports `filesHeld` against `roomFiles`, not a self-satisfied total.
If those two numbers differ, that is expected — not a fault.

### Sizing a relay for N participants

Each participant opens **one connection for the room plus one per open file**, so budget
`participants × (1 + HIVE_MAX_OPEN_FILES)` against the relay's `maxConnsTotal`, and remember
the relay is shared with every other room on it. At defaults, five participants want
5 × (1 + 128) = **645 connections**. The default was 512 until 25 Sep 2026, when three
participants on a 150-file room measured 409 of them, so a fourth was refused. It is now 2048,
which costs about 115 MB of relay memory (measured: ~56 KB per connection).

That shortfall is `Q430`, the whole-relay cap — so the fix is `HIVE_MAX_CONNS_TOTAL`, or
fewer open files per client. **`HIVE_SEATS` will not help here**, and an earlier version of
this section wrongly suggested it would. Verified in `limits.js`: `limitsFor()` returns no
`maxConnsTotal` at all, and the refusal at `limits.js:166` reads the module-level
`LIMITS.maxConnsTotal`, so seats never touch the total. Seats raise the **per-room** cap,
which is a different ceiling that bites in a different place — see the table below.

Check headroom before you start:

```bash
curl -s https://your-relay/health
```

Two different refusals with two different fixes, which is worth knowing before you debug
the wrong one:

| Code | Meaning | What actually fixes it |
|---|---|---|
| `Q430` | whole relay at `maxConnsTotal` | raise `HIVE_MAX_CONNS_TOTAL`, or sync fewer files |
| `Q431` | one room past its per-room cap | set `HIVE_SEATS` — raising the total will **not** help |

`roomConns` is keyed on the **file**-room (`baseRoom + FILE_SEP + relPath`), so a room's
per-room count is *how many participants have that one file open*, not how many files the
folder has. Five participants sharing a file is 5 against a free-tier 8. `Q431` therefore
needs roughly nine or more participants on the *same* file — which is why a five-person team
hits `Q430` first, and why reaching for `HIVE_SEATS` is the wrong instinct. Measured by
@Antigravity while designing the five-participant capacity suite; it corrected this section.

If files stop syncing, the client fetches `/health` itself and tells you which of these it
is, or says plainly that capacity is not the cause. It will not guess.

### When an agent goes quiet

An agent whose turn has ended is still connected, so "is it online" is the wrong question.
The room answers the one that is decidable — is it inside a blocking `hive_wait` right now:

```
Alice  (ai) — WORKING: last action 2 min ago (hive_claim). Reachable.
Bob    (ai) — WAITING: blocked in hive_wait, wakes the moment anything arrives. Reachable.
Carol  (ai) — PARKED: connected, but NOT inside hive_wait and silent for 22 min.
               It will not wake on its own — anything you send it now will sit
               unread until a human prompts it.
Dave   (ai) — GONE: not connected. Last action 41 min ago (hive_say).
```

`hive_say` warns you at send time if you address a PARKED or GONE agent, and `hive_owed`
marks a debt owed by one as `[UNREACHABLE]` rather than pending.

### Known limits

- **Marketplace extension**: loses offline edits on rejoin. Not fixed — it needs a real
  VS Code host to verify, and we will not claim it without one. The `sync.js` engine is
  covered; the extension is not.
- **Bounded working set**: described above. A real behaviour change, deliberately taken.
- **`git`-vs-room drift**: a room checkout and a git branch can diverge.
  `scripts/check-drift.mjs` reports it.
- **Relay deploy**: pushing this repo does not redeploy a hosted relay unless auto-deploy
  is on. Check `/health` uptime against your last deploy.
- **Dead-heat file creation** (HIV-P17, fixed in `929323b`). If two participants create the
  *same* path in the same instant, the creation-race path now runs `fusionReason()` — the same
  check the normal merge path uses. When both inputs parse but the merged output does not (or
  has structural duplication), the merge is REFUSED: nothing is written, both copies stay
  intact, and the room is told via `say()`. Disjoint functions that parse cleanly when merged
  are still unioned as before. Non-code files (no language support) are unaffected.
  `tests/genesis-collision-test.mjs` pins the fix. It is currently timing-flaky -- on
  23 Sep 2026 it failed 2 of 6 assertions in roughly one run in four, on identical code --
  because it races two real creations; that is tracked as its own ticket rather than
  quietly retried.

---

## For maintainers

### Never pack or publish from a synced room folder

This one is specific to Hivecode and it bites its own maintainers. A room folder holds a
**bounded working set**, so a file listed in `files[]` may simply not be on disk there.
Measured 21 Sep 2026: of 35 `files[]` entries, `night/room` had 25 missing and
`night/deepmind` 26, while the repo itself had none.

`npm publish` is safe — `prepublishOnly` runs the guard, which fails with
`files[] lists "hive-mailbox.js" but it does not exist on disk`, one line per entry.

**`npm pack` is not.** On npm 9.6.1 a real `npm pack` runs *no* lifecycle script — not
`prepack`, not `prepare` — so it cannot be guarded that way. It omits a `files[]` entry it
cannot find and says nothing at all: no warning, no non-zero exit, just a smaller tarball
that installs cleanly and throws on the user's first import. Verified with a two-file probe
where one listed file did not exist.

So: pack from the repository, never from a participant folder, and check the tarball
against `files[]` rather than trusting the count.

Live suites spawn a real relay on a pid-derived port, so they can run concurrently:

```bash
node tests/agent-liveness-test.mjs        # WORKING / WAITING / PARKED / GONE, real dispatch
node tests/relay-diagnosis-test.mjs       # a real relay made genuinely full, and the advice it gets
node tests/unreachable-recipient-test.mjs # send-time warnings for unreachable recipients
node tests/open-file-cap-test.mjs         # the bounded working set, and the trade it makes
node tests/ceiling-no-data-loss-test.mjs  # a full relay must not cost you your files
node tests/first-contact-refusal-test.mjs # clone-then-join must not clobber local work
node tests/genesis-claim-test.mjs         # a claim whose bytes could never leave is refused
node tests/blind-recreate-test.mjs        # writing a file you cannot see, that the room already has
node tests/genesis-collision-test.mjs     # HIV-P17: two whole-module rewrites in a creation race are refused
node tests/join-honesty-test.mjs          # what a join says when the relay refused it
node tests/mention-boundary-test.mjs      # who owes an answer, and who cannot be asked
node tests/coordination-test.mjs          # claims, leases, flow-around under contention

npm run test:ceiling · test:gate · test:learnings · test:features · test:coordination
```
