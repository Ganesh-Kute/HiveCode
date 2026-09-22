# The Second Shift — the workflow Hivecode is for

Written 16 Sep 2026, from Ganesh's call: *"we cant fit hivecode in a existing workflow of teams,
we need to create a new one around it — and if its effective people use it."*

That is the whole strategy on one line. Every tool in a team's current day — the editor, the pull
request, the standup — assumes **a human is present**. A persistent multi-agent workspace cannot
be slotted into that, because it breaks the assumption the workflow is built on. So we stop trying
to be a plugin inside someone else's day and ship the day itself.

Slack did not fit into email. Docker did not fit into deployment. Neither asked permission from
the workflow it replaced.

---

## The pitch

> **Your team goes home at 6. Your agents don't — and nobody has to watch them.**

The second half is not a detail. Without it this is a pager, and a pager is a product nobody
adopts.

One product, two shifts. It has to be good at both or it is a novelty.

| | **DAY** (people present) | **NIGHT** (nobody present) |
|---|---|---|
| what the room does | removes the **wait** | keeps **working** |
| who is in it | 5 people + their AIs + the standing roster | the standing roster |
| the win | a check takes seconds, not a PR round trip | the backlog moves while everyone sleeps |
| the risk it answers | two agents writing the same file | an agent running unwatched for 12 hours |

---

## 1. DAY — the room removes the wait

The daily case has to stand on its own. A tool people only use overnight gets uninstalled.

**09:40** — Rai's agent claims `routes.ts`. Granted.

**10:15** — Alex's agent asks for the same file. **Refused by the relay** — not a prompt it can
argue with. It goes to the search indexer instead. *The duplicate work is never written.* This is
the single biggest saving and it happens before anything needs resolving.

**10:16** — Rai's route appears in everyone's editor in about a second. Alex's agent now *reads*
it rather than inventing a second version of it.

**10:50** — Rai's agent releases. The gate runs the team's test command **in Rai's own folder**.
It fails, so the file **stays with Rai**. Nobody downstream ever pulls the broken version.

**10:52** — passes. The Reviewer agent — already in the room, already looking at the same file —
approves in seconds. There is no branch to push, no PR to open, no one to interrupt.

**The day-mode claim:** the round trip disappears. Review, test and deploy are participants in the
room rather than stages in a queue, so the gap between *done* and *verified* collapses from hours
to seconds.

---

## 2. NIGHT — the second shift

**18:00** — laptops close. The room does not: it lives on the relay, not on anyone's machine.

**18:00–09:00** — the roster works the backlog. Each agent claims, works, releases; the gate runs;
a failing check keeps the file with whoever broke it so nothing broken propagates to the next
agent. Waiting agents cost **zero tokens** — `hive_wait` blocks rather than polls.

**23:00 — you do not look.** That is the product. The phone view exists so you *can*, never so
you *must*: a workflow whose promise is "now you have something to watch at night" is a pager, and
devs hate pagers more than they hate any other part of this job. What makes not-looking safe is
not trust in the agent's judgement — it is bounds it cannot cross: scope it cannot reach past, a
gate it cannot hand off through, a state it cannot advance beyond.

**09:00 — you skim, you do not audit.** This is the second failure mode and it would sink the
product on its own: waking to 3,000 lines of unreviewed overnight AI code is WORSE than having no
night shift, because "work didn't happen" has been traded for "review debt I now owe."

The roster is the answer. The reviewer and test agents are *in* the night shift, so by morning the
work is already reviewed, already gated, already individually revertable — "6 tickets closed, each
passed, here is the diff, here is a revert button per agent." And `READY_FOR_HUMAN` can be a
terminal state in the schema, so nothing ships overnight unless you configured that it may.

---

## 3. Why "control" is the point, not a feature

Selling control as a property — scope, receipts, undo — never landed, because a property is not a
reason to install anything. The correct statement:

> **Control is what lets you leave.**

Nobody walks away from five agents in their repo overnight. Every subsystem is a precondition for
that walk, not a bullet on a list:

| the worry at 6pm | the answer | status |
|---|---|---|
| what can it touch? | scoped tokens — an out-of-scope file is **never sent**, not merely refused | built |
| what if it breaks the build for everyone? | the release gate — a failing check keeps the file with its author | built, 55/55 |
| what if two collide? | claims, refused server-side and replayed after release | built |
| what did it actually do? | Ed25519-signed receipts, per participant | built |
| how do I undo just the bad one? | `revertAuthor(who, since)` | built |
| what does idling cost? | nothing — `hive_wait` blocks at zero tokens | built |
| **how do I stop it, from anywhere?** | — | **MISSING** |
| **what if it burns 15 hours doing something useless?** | — | **MISSING** |

---

## 4. The roster

A room is a team you staff. Each seat is a participant with its own identity, its own scope, and
its own wake condition — and costs nothing while asleep.

| seat | wakes on | scope |
|---|---|---|
| dev + AI (×5) | the person working | their feature's files |
| **Reviewer** | a release | read-only, everything |
| **Test runner** | a release | owns the gate command |
| **Deployer** | state reaches `TESTED` | deploy config only — **cannot receive source** |
| **Supervisor** | a task blocked or unclaimed | the board, not the code |
| **Docs** | a public signature changes | `docs/` only |

The deployer is the clearest illustration of the difference from an agent framework: it takes full
part in the workflow and **physically cannot receive a source file**. Not instructed — never sent.

Sequencing is `hive_set_schema` with `transitions` and `requires`, enforced at the relay. An agent
cannot move a task to `DEPLOYED` without passing `TESTED`, however confidently it believes it
already tested.

---

## 5. Build order

Five things stand between this document and a team using it.

### 1. The stop button — the hard blocker

Nothing halts an agent mid-work today. `hive_busy` is a courtesy flag; state changes are not
checked mid-task. **You cannot ask anyone to leave agents running overnight if they cannot stop
them from a phone**, so this gates the entire night shift.

It must be **relay-enforced**, for the same reason claims are: a paused participant's writes are
refused by the server, so pausing does not depend on the agent choosing to obey. Shape:
`hive_pause(who | all)` / `hive_resume`, a `paused` set in room state, the relay checking it on
every write, and the control room exposing it as one button per participant plus a pause-all.

### 2. wake-on-state

`hive_wait` returns on an `@mention` or on assigned work — not on a state change. So every roster
above currently depends on a releasing agent *remembering* to address the next role, which is
prompting, which is exactly what we are selling the alternative to. `hive_wait` needs to accept a
state predicate alongside `wakeOn: 'mention'`. The state map already broadcasts over the CRDT, so
this is a wait condition, not new plumbing.

### 3. Spend caps

Idle is free. **Wrong is not.** An agent that spends fifteen hours on the wrong thing costs fifteen
hours of tokens and you find out in the morning, which makes "go home and leave them running" a
sentence nobody will act on. Needs a per-participant budget — stop after N tokens or N minutes —
enforced at the relay like everything else, not a number in a prompt.

### 4. The boundary adapters

Ticket in, Slack out, PR out. See section 6 — for adoption this may outrank two of the items above,
because without it the room is a place people have to remember to visit.

### 5. Presets

Nobody designs a roster from scratch, so nobody would ever start. Ship `hivecode init --preset
review-loop` (and `migration-crew`, `overnight-crew`) writing the state machine, the gate command,
the roles and their scopes. The team edits one line — their test command.

**Only `review-loop` is proven end to end today.** The other two are compositions of built pieces
that have never been run together; they are designs, not claims.

---

## 6. What already exists for this

- persistent rooms on the relay (`server.js`), one Yjs doc per file
- the control room, `public/control.html` — live members, chat, tasks, files, and messaging in
- the release gate (`hive-gate.js`), claims (`hive-coord.js`), scoped tokens (`token.js`),
  signed provenance (`substrate.js`), `revertAuthor` (`sync.js`)
- `hive_wait` — blocking idle at zero tokens
- always-on hosts: Maritime agents at **$1/month** each, three already running
- Telegram inbound, proven with 18 real messages

The gap is not capability. It is the stop button, and then a workflow anyone can start in one
command.

---

## 6. The boundaries — what we replace, keep, and add

The mistake this section exists to prevent: trying to replace a team's whole toolchain. That is
how an infrastructure product dies, because every tool you displace is a separate argument you
have to win before anyone can try yours.

A five-person team runs a **ticket tracker** (Linear/Jira), **Slack**, **git + PRs**, **CI**, a
**deploy pipeline**, and a **daily standup**. Their loop is: pick a ticket, branch, write, push,
PR, *wait for review*, address comments, push, merge, deploy. The largest non-coding delay in that
loop is **waiting for review** — hours, often overnight, because the reviewer is mid-task and does
not want to context-switch.

### REPLACE — where we are genuinely better

- **The branch -> PR -> wait -> review cycle for work inside the team.** Claims stop the collision,
  live sync means the second agent reads instead of duplicating, the gate checks before handoff,
  and the reviewer is already in the room. Hours become seconds.
- **The standup.** The claims board answers "who is on what, who is blocked" continuously and
  live. Nobody needs to say it out loud at 10am.
- **The 6pm-9am gap.** There is no tool for this today. We are not displacing anything — we are
  filling an empty slot, which is a far easier sell than taking something away.

### KEEP — do not try to take these, we would lose

| tool | why it stays |
|---|---|
| **Linear / Jira** | Teams live in it. Our board will not beat Linear and trying is how we lose the deal. |
| **Slack** | They will not move their conversation into our control room. Humans stay in Slack. |
| **git** | The permanent record that CI, deploy, rollback, compliance and every audit hang off. |
| **CI** | Our gate is a PRE-HANDOFF check in one person's folder. CI is the shared check on the real branch. Different jobs. |
| **deploy pipeline** | Not our problem and not our advantage. |

### ADD — the three adapters that decide whether anyone can adopt this

1. **Ticket in** — a Linear/Jira/GitHub issue becomes a room task. Without it, the room is
   somewhere you have to *remember* to go.
2. **Slack out** — the room posts to Slack and a human replies from Slack. Never ask them to live
   in our UI.
3. **PR out** — work in the room lands as a pull request.

### The decision that makes adoption possible

Asking a team to abandon pull requests is an enormous ask. PRs are how review, compliance and
audit happen, and in many companies they are mandatory for reasons nobody on the team controls.

So do not ask. **The room's output is a PR.**

```
Linear ticket  ->  [ HIVECODE ROOM: live work, agents, claims, gate ]  ->  PR  ->  CI  ->  deploy
```

Hivecode changes everything **inside** the box and nothing at the boundaries. The team keeps their
tracker, their Slack, their PR process, their CI, their deploy — and what disappears is the
branch-and-wait in the middle. In the second shift the box runs while they sleep and the PR is
waiting in the morning.

That is how Docker fitted in: it did not replace your deploy, it changed what you shipped.
