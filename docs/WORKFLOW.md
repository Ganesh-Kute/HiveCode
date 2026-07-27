# How Hivecode is actually used

Written for someone who has never seen this before. No prior context assumed.

Everything here works today except the two limits named honestly at the bottom.

---

## 1. The problem, in one example

You use AI coding agents. One works fine. The moment you run two on the same project they
overwrite each other — agent A rewrites `auth.js` while agent B is editing it, and whichever
saves last wins. So you run them one at a time, and you are the bottleneck.

The usual answer is "give each agent its own git branch." That fails for a specific reason:

**git merges lines of text, so it will happily produce a clean merge that is broken code.**

Agent A renames `getUser` to `fetchUser` and updates its three callers. Agent B, on its own
branch, adds a fourth call to `getUser`. Git merges both without a single conflict marker —
different lines, no overlap, nothing to complain about. Your program now calls a function that
does not exist. You find out an hour later when the tests fail, and nothing in the merge tells
you why.

That is not a rare edge case. It is the normal outcome of two agents working in parallel,
because agents rename and move things far more aggressively than humans do.

Hivecode is two pieces that fix two halves of it:

| | What it is | Cost |
|---|---|---|
| **ICR** | A merge engine that understands code structure instead of lines | Free, MIT, forever |
| **The room** | A live shared workspace where agents never diverge in the first place | Free to 2 committers, then paid |

---

## 2. See it happen, then check your own branches

Nobody should take the claim above on faith. Run this anywhere:

```bash
npx git-clash
```

With no arguments it walks three real collision scenarios, showing side by side what git
produces and what a structural merge produces. It takes about ten seconds and needs no repo.

Then point it at a merge you are actually about to make:

```bash
npx git-clash --scan --base=main --head=my-feature-branch
```

It finds the merge base of those two refs, pulls all three versions of every changed file, and
reports the files where git merges cleanly but the result is semantically broken. Read-only,
entirely local, nothing is uploaded anywhere. Add it to CI and it exits non-zero when it finds
drift.

---

## 3. Fix it, for free, in one command

```bash
npx icr-merge-install
```

That registers ICR as a git merge driver for the current repository. From then on, every
`git merge` and every `git rebase` merges by structure first.

What "by structure" means concretely: each version of a file is parsed and split into keyed
units — `fn:login`, `class:Auth`, `import:./db`. The key is identity, so "the same function in
all three versions" becomes a fact rather than a guess based on line position. Changed on one
side only? That side wins. Changed on both? It descends a tier — statements, then lines, then
tokens — instead of giving up and printing conflict markers around the whole function.

Rename detection is the part that catches the example above. ICR sees that `getUser` became
`fetchUser` on one side, sees a new reference to `getUser` on the other, and reports a real
conflict instead of a clean merge that does not run.

**The one guarantee that matters:** ICR never emits output more broken than what went in.
Every merged unit and every final result is re-parsed before it is allowed out. If the result
does not parse, ICR refuses it and falls back to a plain line merge. The worst case is exactly
git — never worse.

You can stop reading here, get real value, and never pay anything. That is deliberate. A free
tier that is crippled on purpose is a lie; this one is the actual engine.

---

## 4. What a "room" is

A room is **your project folder, shared live**. Not a copy, not a branch — the same folder,
synced continuously between everyone in it. Humans sit in their editors. Agents connect
through tool calls.

Three things are true inside a room that are not true anywhere else:

**Agents claim files before they write.** An agent calls `hive_claim("auth.js", "adding rate
limiting")`. If another agent already holds it, the claim comes back `false`, and that agent
goes and does something else. There is no coordinator process arbitrating this — every agent
senses the shared claim map directly, the way Ethernet cards sense a busy wire. A crashed
agent's claim expires on its own timer instead of deadlocking the room.

**Every edit is signed with its reason.** Not just who and what, but *why*: `"add rate
limiting to login"`. Each edit becomes a cryptographic receipt over the author, the exact
state it was made from, the result, and the intent. So when something breaks you read the
intent instead of guessing at it. Author identity is the signing key's own fingerprint, so
there is no account database anywhere.

**Same-line collisions get caught instead of fused.** Two agents editing the same line do not
produce character soup. The system reconstructs both versions from the provenance chain and
surfaces a real conflict, with each side's stated intent, for someone to resolve properly.

---

## 5. Route A — agents only, no editor

The common case: one developer who wants three agents working at once.

### Once per machine

```bash
claude mcp add hivecode -- npx -y hivecode-mcp
```

Claude Desktop and Cursor read a config file instead of having a CLI:

```json
{
  "mcpServers": {
    "hivecode": { "command": "npx", "args": ["-y", "hivecode-mcp"] }
  }
}
```

Restart the client afterwards so it loads the tools. This is the only setup, and you do it
once — not per project, not per room.

### Then just talk to the first agent

> Join a hivecode room for this folder. Your name is Ana, I am your owner.

It calls `hive_join`. No room exists yet, so **it creates one** and hands back a link:

```
wss://livecode-xoss.onrender.com|room-Kx8fT2ehQ9
```

Note what did not happen: you did not install an editor extension, provision a server, sign
up, or write a config file for the project.

"Owner" matters more than it looks. The owner is the human accountable for that agent — only
you can approve work another participant directs at it. That is the safety gate that stops one
agent from ordering another around unsupervised.

### Bring in the others

Same sentence to agent two and three, different names, plus the link:

> Join this hivecode room: `wss://…|room-Kx8fT2ehQ9`. Your name is Ben, I am your owner.

Three agents now share one folder. Agents starting in the same directory find the room
automatically from the `.hive.json` the first one wrote, so you often do not even need to
paste the link.

### Give them work and let them sort it out

> Ana, do the auth refactor. Ben, write the tests for it. Cara, update the docs.

Each announces what it is taking via `hive_say` before starting, claims the files it needs,
works, then releases them. When Ben needs a file Ana holds, his claim fails and he picks up
something else rather than clobbering her work.

A well-behaved agent's loop looks like this:

```
hive_wait      → block until there is approved work for me
hive_read_chat → what is everyone else doing?
hive_claim     → take the file I need; if false, choose another
hive_edit      → write it through the medium, with my intent stamped in
hive_release   → hand it back
hive_complete  → mark the task done
```

`hive_edit` is worth understanding: writing *through* the medium stamps the intent and the
exact change into the provenance ledger at the instant of the write, race-free, before the
merge happens. Editing the file directly on disk still syncs, but the "why" is lost.

### Watch from a browser

Open **<https://livecode-xoss.onrender.com/control>** and paste the same link.

No install, works on a phone. You get the live crew list, their chat, what each agent is
holding right now, and the ability to reassign work or roll a file back to an earlier point.

That is the whole workflow: register once, one sentence per agent, watch.

---

## 6. Route B — you and your team, in editors

The other shape, when humans are editing too.

1. **Install the extension** from the VS Code marketplace.
2. **Command Palette** (`Ctrl+Shift+P`) → **`Hivecode: Host a Secured Session`**. Your project
   folder becomes the room and you get an invite link back.
3. **Share the link.** Teammates paste it into their own editor and are in the same folder
   live. Use **`Hivecode: Invite to folders…`** to scope a link, so a contractor sees
   `/frontend` and nothing else — including read-only roles.
4. **Their agents join the same room** through MCP, exactly as in Route A.

Two humans and four agents in one folder, no branches to reconcile.

Useful commands once you are in:

| Command | What it does |
|---|---|
| `Hivecode: Open Control Room (browser / phone)` | The same dashboard, away from your desk |
| `Hivecode: Restore a file to an earlier point…` | Rewind one file, not the whole repo |
| `Hivecode: Revert an author's changes…` | Undo everything one agent did |
| `Hivecode: Manage access` | See and revoke who holds a link |
| `Hivecode: End Room (forget & start fresh)` | Tear it down |

---

## 7. When two agents collide anyway

Because they will. Three layers catch it, in order:

**Prevention.** The claim map means most collisions never happen — the second agent is told
the file is taken before it writes anything.

**Structural merge.** If two agents did edit the same file, ICR merges by keyed unit. Two
different functions in one file is not a conflict at all; it is two independent changes.

**The fork gate.** If they edited the *same line*, a character-level CRDT would normally fuse
the two edits into something neither agent wrote — `return 23` out of one agent's `return 2`
and another's `return 3`. Instead, the fork is detected, both original versions are
reconstructed from the provenance chain, and it is raised as a real conflict. An agent reads
both sides with `hive_fork` — including each side's signed intent — and submits a reconciliation
with `hive_resolve` that serves *both* intents. That proposal is validated with ICR before it
lands: if it does not parse, or leaves a dangling reference, it is refused and nothing changes.

---

## 8. What you pay for, and when

Everything above is free up to **two concurrent committers**.

A committer is anyone *writing* at that moment. Idle agents, reviewers, and browser watchers
do not count — you pay for concurrent writers, not for how many agents you have configured.

Two is enough to try it and feel it work. It is not enough to run a fleet. When you want a
third agent writing at the same time, it is **$29 per committer per month**: enter the key
once, and forget about it.

Teams whose code cannot leave their own network run the relay themselves on Enterprise — set
`HIVE_LICENSE` and `HIVE_REQUIRE_LICENSE=true` on your own host and nothing touches ours.

---

## 9. What is not wired yet

Stated plainly, because finding this out yourself would be worse.

**The seat limit is not enforced.** The relay reads a licence from the connection
(`server.js`, the `upgrade` handler) and no client currently sends one, so
`HIVE_REQUIRE_LICENSE` cannot be switched on without rejecting paying customers too. Until
that is wired, every room is effectively unlimited. The extension stores and validates a key,
but today that only lights up the Free/Pro badge.

**An agent-hosted room has no access token.** Route A rooms are open: the room id is 104 bits
of randomness so it cannot be guessed, but anyone who *has* the link can write. Secured rooms
— the `hs_…` kind, with a token — are currently only created by the editor in Route B. If you
need access control today, host from the editor.

**Seats are counted by self-chosen name.** The relay counts distinct participant names per
room, and agents name themselves. Two agents that pick the same name count as one; one agent
that renames itself counts as two.

**Relay durability.** The hosted relay snapshots room state to disk and stays awake by pinging
itself, but that disk is not persistent, so a redeploy can lose room history. Self-host with a
real volume if that matters to you.

---

## Reference

- **[JOIN_WITH_AGENT.md](JOIN_WITH_AGENT.md)** — agent setup in more detail, including
  self-registration
- **[BILLING.md](BILLING.md)** — how licences are issued, stored and checked
- **[../HIVECODE_EXPLAINED.md](../HIVECODE_EXPLAINED.md)** — the full mechanism, lecture by
  lecture, with code
