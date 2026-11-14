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

### One socket per participant (and the older transport that is one per file)

Every file is its own shared document. Until 25 Sep 2026 each of those documents cost its
own WebSocket, so a relay's socket budget was spent on files rather than people: on 18 Sep
2026 889 files against a 512-socket relay refused 38,011 connections in one evening.

A client now carries **all of its files on one socket**, next to the one for the room: two
sockets per participant, whatever the file count. Each file is a *channel* on that socket,
and the relay admits every channel through exactly the gates a per-file socket passes —
token, path scope, read-only role, claims, rate and size limits. The relay advertises this
in `/health` (`"mux": 1`) and the client uses it only when it is advertised, so a new client
still works against an old relay.

The older transport — **one socket per file** — is still spoken by the VS Code extension,
the browser panel, any relay that predates the change, and any client started with
`HIVE_MUX=0`. The two converge in the same room. An operator who needs to turn the new
transport off sets `HIVE_RELAY_MUX=off` on the relay; clients already connected fall back
to one socket per file by themselves, without a restart.

Either way the client keeps a **bounded working set** — the most recently used
`HIVE_MAX_OPEN_FILES` stay open and the rest are closed and reopened on demand. The bound is
4,096 files on one-socket mode, so an ordinary repository is held whole, and 128 on the
older transport, where every open file is a socket. Everything below about files that are
not on disk applies only past that bound.

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

Two budgets, one per transport, and the relay is shared with every other room on it:

- **Sockets** (`maxConnsTotal`, default 2048, ~56 KB each). A one-socket client costs **2**.
  A client on the older transport costs **1 + its open files**, so at defaults five of those
  want 5 × (1 + 128) = **645**. The default was 512 until 25 Sep 2026, when three such
  participants on a 150-file room measured 409 of them and a fourth was refused.
- **Open files on one-socket clients** (`HIVE_MAX_CHANNELS_TOTAL`, default 8,192; at most
  `HIVE_MUX_MAX_DOCS`, default 4,096, per participant). Measured 25 Sep 2026 with small files:
  about **25.8 KB** for a file nobody else has open (the document is most of that, and it grows
  with the file's content and history) and **2.4 KB** for each further participant on the same
  file. Five people on a 900-file repository of small files is ~4,500 channels, roughly 32 MB. The default is sized so 8,192 files nobody shares stays near 211 MB on the
  512 MB hosted instance: raise it with the instance, not before.

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
| `Q438` | open files across all one-socket participants at `HIVE_MAX_CHANNELS_TOTAL` | raise it (and the instance's memory with it) |
| `Q439` | one participant at `HIVE_MUX_MAX_DOCS` open files | raise it, or narrow what that participant syncs |

`roomConns` is keyed on the **file**-room (`baseRoom + FILE_SEP + relPath`), so a room's
per-room count is *how many participants have that one file open*, not how many files the
folder has. Five participants sharing a file is 5 against a free-tier 8. `Q431` therefore
needs roughly nine or more participants on the *same* file — which is why a five-person team
hits `Q430` first, and why reaching for `HIVE_SEATS` is the wrong instinct. Measured by
@Antigravity while designing the five-participant capacity suite; it corrected this section.

If files stop syncing, the client fetches `/health` itself and tells you which of these it
is, or says plainly that capacity is not the cause. It will not guess.

### What a real repository costs (measured 13 Nov 2026)

The per-file figures above were measured with small files. With a real repository they are higher,
so size the instance from these. `node bench/relay-capacity.mjs` shares this repository's own tracked
files (727 files, 11 MB of text) through a relay with real clients and reads the relay's memory and
CPU after each step:

| | Measured |
|---|---|
| Relay with nobody on it | 80 MB fresh, about 140 MB once it has been used |
| Each room open at the same time (727 files) | about **+50 MB** (164, 196, 235 MB for one, two, three rooms) |
| Each further client in a room | under 10 MB; it costs **706 channels**, one per file |
| A room everyone has left | given back: 242 MB with three rooms open, 138 MB after they left, flat over four more rooms |
| CPU for the first client to open a room | 1.0 to 1.4 s; 0.2 to 0.6 s for each further client |

What follows from it:

- **The channel cap is reached before memory.** 8,192 channels is 11 clients of a 700-file
  repository across the whole relay, whoever they belong to; the twelfth is refused with `Q438`.
- **A 512 MB instance holds about five such rooms open at once** ((400 - 140) / 50), so on it the
  cap should stay near its default: raising it only lets more rooms in than the memory holds.
- **A 2 GB instance holds about 28**, and `HIVE_MAX_CHANNELS_TOTAL=20000` matches that: 28 clients
  of a 700-file repository, and if every one of them were alone in a room, 28 rooms at 50 MB.
- **A join is CPU.** On a 0.1 CPU instance one client opening a 700-file room occupies the relay
  for 10 to 14 seconds, and after a restart every client reconnects at once: fifteen clients is
  minutes during which the relay answers nothing else, `/health` included.
- **A relay without a persistent disk forgets on every deploy.** Rooms come back from the clients
  that are still connected. Slack connections do not: the stored token is gone, the channel goes
  quiet in both directions, and neither the room nor Slack is told. Mount a disk and point
  `HIVE_PERSIST_DIR` at it before connecting a channel anyone relies on.

### Who is on the relay right now

`/health` counts sockets, and a socket is not a person: one client holds a socket per file (or one
mux socket for hundreds), and one person may run an editor, an agent and a listener. To count people
and agents, ask the relay with its admin secret (the same `HIVE_ADMIN_SECRET` that opens `/usage`;
for a relay you host yourself, use its address):

```bash
curl -s -H "X-Hive-Admin: $HIVE_ADMIN_SECRET" https://livecode-xoss.onrender.com/presence
```

It answers `agents`, `humans`, `unknown` (a client that gave no kind), `rooms` with someone in them,
and `people`: each name once, with how many rooms and sockets it holds, the app and version it
reported, whether it runs a listener, and `silent: true` for a client connected without announcing
itself (a watcher, an old process). On an open relay a kind is what the client declared;
`verified` is set only when it came from a signed token. Rooms are listed as `r-` plus the first 10
hex characters of the room id's SHA-256, never the id itself, so you can match a row to a room you
hold and nobody else can:

```bash
node -e "console.log('r-' + require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0, 10))" "<room id>"
```

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
