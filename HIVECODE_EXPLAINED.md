# Hivecode — The Complete Course

> This is the full explainer of Hivecode, rewritten as a course: every mechanism is
> motivated first (*why does this need to exist?*), then explained (*how does it work?*),
> then shown with a **worked example and real code**. Each lecture ends with a
> **"Say it back"** box — one or two sentences you should be able to produce from memory.
> If you can say every "Say it back" box in your own words, you can survive any
> interview on this system.
>
> How to study: read one lecture at a time. Don't move on until the "Say it back" box
> feels obvious, not memorized.

---

## Lecture 0 — The map of the whole course

Hivecode is built like an onion. Each layer exists because the layer below it has a
specific, provable failure. Learn the failures and the layers explain themselves:

| Layer | What it gives you | The failure it fixes |
|---|---|---|
| 1. **Yjs CRDT sync** | everyone sees the same bytes, live, no git | git push/pull is too slow for agents; but CRDTs alone produce `return 23` |
| 2. **ICR** (merge by meaning) | overlapping edits merge by *structure and intent*, never ship broken code | character-level merging fuses code nobody wrote |
| 3. **Hive coordination** | agents avoid touching the same file at once, with no boss | even good merges waste work; prevention beats cure |
| 4. **Provenance substrate** | every byte is signed with author + intent | the CRDT *destroys the evidence* of what each author meant |
| 5. **Oversight & control** | humans watch, fence, approve, undo agents live | you cannot trust agents blindly, and worktrees just defer the mess |

One sentence for the whole system:

**Hivecode is a live shared workspace where many AI agents and humans edit the same
codebase in real time — synced by CRDTs, kept safe by a meaning-aware merge engine
(ICR), kept collision-free by a decentralized claim layer, kept honest by cryptographic
provenance, and kept under human control by live oversight.**

---

## Lecture 1 — The problem, from first principles

**The question this lecture answers:** why does anyone need this at all?

### 1.1 One agent: the trust problem

An AI agent edits code faster than you can read it. The faster it goes, the more of
your time goes into *checking* it. The bottleneck is no longer writing code — it's
**oversight**.

### 1.2 Many agents: the collision problem

Now run three agents on one codebase. Three new failure modes appear immediately:

1. **They touch files they shouldn't.** Nothing fences an agent to "just the frontend."
2. **They overwrite each other.** Agent A's fix vanishes because agent B saved a stale
   copy of the same file ten seconds later.
3. **You lose attribution.** When something breaks, you cannot say *which agent* wrote
   the breaking line, or *why*.

### 1.3 The industry's answer, and why it's a deferral

The standard answer today is: give each agent its own **git worktree** (an isolated
copy), let them work blind, and merge at the end. This has a name in the literature —
and a measured cost. The **CooperBench** benchmark (Stanford, 2026) gave pairs of
agents two independent features to build on the same repo and found that agent teams
lose roughly **half** their value to coordination failures. On the benchmark's own gold
implementations — *professional* human patches, not agent output — merging the two
features with git produces a conflict in **76.5% of pairs** (499/652). Isolation
doesn't solve the problem; it stores it up and hands it back to you as merge hell.

### 1.4 Hivecode's bet

The missing layer is **live oversight + safe convergence**, not deferred isolation:

- Agents and humans edit the **same live workspace** — everyone sees everyone's edits
  in ~1 second.
- A human can **watch** every edit, **fence** each agent to allowed folders, **approve**
  risky moves, and **undo** any agent instantly.
- When two edits genuinely overlap, the system merges them **by meaning** — or raises a
  precise, named conflict — instead of producing garbage.

> **Say it back:** One agent creates a trust problem; many agents create a collision
> problem. Git worktrees don't solve collisions, they defer them (76.5% of CooperBench's
> gold feature pairs conflict at merge time). Hivecode's bet is live oversight plus
> safe convergence instead of isolation plus prayer.

---

## Lecture 2 — Architecture: three pieces, one of them hosted

**The question this lecture answers:** what actually runs, and where?

```
   ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
   │  VS Code      │          │    RELAY      │          │  AI agent     │
   │  extension    │◄────────►│  server.js    │◄────────►│  (MCP)        │
   │  (human)      │   wss    │  "dumb pipe"  │   wss    │  hive-mcp.js  │
   └──────┬───────┘          └──────────────┘          └──────┬───────┘
          │ mirrors                                            │ mirrors
      local files                                          local files
```

- **Relay (`server.js`)** — a [`y-websocket`](https://github.com/yjs/y-websocket)
  server. Its job is deliberately dumb: forward CRDT updates between everyone in a
  room, and enforce access at the WebSocket handshake. It holds **no canonical copy of
  your code** — only transient (optionally disk-cached) shared state. That makes
  hosting cheap and self-hosting trivial.
- **Editor client (`extension/extension.js`)** — the human surface (VS Code, Cursor,
  Windsurf, Antigravity). Mirrors shared state into the user's local files and pushes
  local edits back.
- **Agent client (`hive-mcp.js`, published as `hivecode-mcp`)** — the AI surface. Runs
  the *same* sync engine as the editor, but exposes it to an agent as **MCP tools**
  (`hive_join`, `hive_claim`, `hive_say`, …).

**The design principle to remember:** the editor and the agent are **peers**. Neither
is privileged at the protocol level. "Human" vs "AI" is just an identity field set by
whichever client connected. All the *policy* (who may write where, what needs approval)
lives in tokens and relay enforcement — not in special-cased clients.

**Why is the relay a "dumb pipe"?** Because every piece of intelligence you put in the
relay is a piece you must scale, secure, and trust centrally. Hivecode pushes
intelligence to the edges (merge logic runs in every client) and keeps the center
stateless. This is the same architectural instinct as the internet itself: smart
endpoints, dumb network.

> **Say it back:** Three components — a dumb relay that forwards CRDT updates and
> checks access, an editor client for humans, an MCP client for agents. Editor and
> agent are protocol-level peers; the relay stores no code.

---

## Lecture 3 — CRDTs from zero, and the `return 23` failure

**The question this lecture answers:** what is a CRDT, why does Hivecode build on one,
and what is the precise failure that motivates everything above it?

### 3.1 The definition, honestly stated

A **CRDT** (Conflict-free Replicated Data Type) is a data structure with one contract:

> Any set of peers, applying the same set of operations **in any order**, converge to
> the **same state** — with no coordinator, no locks, no central server deciding.

That contract is exactly what a live multi-writer editor needs: peers can be offline,
messages can arrive late or reordered, and everyone still ends up with identical bytes.

### 3.2 How `Y.Text` achieves it — character identity

`Y.Text` (the Yjs type Hivecode files live in) is a **sequence CRDT**. Three rules:

1. **Every character gets a permanent unique identity** — the pair
   `(clientID, clock)` of the peer that typed it.
2. **An insert is anchored**, not positioned: it says "place me after the character
   with identity X" — never "place me at index 7" (indexes shift; identities don't).
3. **A delete is a tombstone**: the character is marked dead but its identity is never
   removed — so a late-arriving "insert after it" can still find its anchor.

Those three rules are sufficient for convergence. They are also exactly what produces
the famous failure.

### 3.3 The `return 23` failure — trace it by hand

Base file content: `return 1`. Two agents edit **concurrently** (neither has seen the
other's edit):

- **Agent A** changes it to `return 2`
- **Agent B** changes it to `return 3`

In character terms, **both** sides did the same two operations:

| | Agent A | Agent B |
|---|---|---|
| op 1 | tombstone the char `1` | tombstone the char `1` |
| op 2 | insert `2` (identity `(A, 5)`) anchored after the space | insert `3` (identity `(B, 9)`) anchored after the space |

Now merge. The two deletes target the **same** character — fine, it dies once. But the
two inserts are two **different characters with different identities**, both anchored
at the same place. A sequence CRDT keeps **both**, ordered deterministically (by
clientID). Every peer converges to:

```
return 23
```

Read that result again slowly, because it is the most important failure in this course:

- It is **perfectly convergent** — every peer has identical bytes. The CRDT kept its
  contract flawlessly.
- It is **syntactically valid** JavaScript.
- It is **code that no author ever wrote**, and it carries **zero conflict signal** —
  because at the CRDT's level of abstraction, *nothing conflicted*. Two different
  characters were inserted at nearby anchors. That's a Tuesday.

### 3.4 See it yourself — a runnable demo

```js
// node fusion-demo.mjs   (npm i yjs)
import * as Y from 'yjs'

// Seed two peers with identical history
const seed = new Y.Doc()
seed.getText('f').insert(0, 'return 1')
const seedUpdate = Y.encodeStateAsUpdate(seed)

const A = new Y.Doc(), B = new Y.Doc()
Y.applyUpdate(A, seedUpdate)
Y.applyUpdate(B, seedUpdate)

// Concurrent edits: neither peer has seen the other's change yet
A.getText('f').delete(7, 1); A.getText('f').insert(7, '2')   // A: "return 2"
B.getText('f').delete(7, 1); B.getText('f').insert(7, '3')   // B: "return 3"

// Now exchange updates (order doesn't matter — that's the CRDT contract)
Y.applyUpdate(A, Y.encodeStateAsUpdate(B))
Y.applyUpdate(B, Y.encodeStateAsUpdate(A))

console.log(JSON.stringify(A.getText('f').toString()))  // "return 23"  (or "return 32")
console.log(A.getText('f').toString() === B.getText('f').toString())  // true — converged!
```

Both peers agree perfectly — on garbage.

### 3.5 The exam trap: "last write wins"

If an interviewer asks why the CRDT produced `return 23` and you say *"last write
wins,"* you have failed the question. LWW is what a **register** CRDT does (like the
*values* in a `Y.Map`): two writes to the same key, one timestamp wins, one edit is
**dropped**. `Y.Text` is a **sequence** CRDT and never drops an edit — the fusion IS
both edits surviving. The one-liner to say instead:

> **"Yjs is a register of characters, not of meaning — it guarantees everyone sees the
> same bytes, not that the bytes make sense."**

### 3.6 What Hivecode stores in the room

A **room is one `Y.Doc`**, and everything shared lives inside it:

| Structure | What it holds |
|---|---|
| one **sub-document per file** (`Y.Text`) | the live contents of each file |
| `Y.Array('chat')` | ordered coordination messages |
| `Y.Map('claims')` | the coordination layer — who is editing what right now (Lecture 8) |
| `Y.Map('board')` | recent whole-file rewrites ("read before you edit") |
| `Y.Map('tasks')` | directed work + approval state |
| per-file snapshot maps | restore points (rollback / undo) |
| **awareness** | live presence — ephemeral, never persisted |

**Why one sub-document per file, not one big blob?** Two reasons. (1) **Security**: the
relay authorizes **per path** — files live at `<base>␁<path>`, so a client scoped to
`frontend/` literally never *receives* backend bytes; out-of-scope code never touches
its disk. (2) **Scale**: traffic shards per file instead of every keystroke fanning out
to everyone. Paths are validated against traversal, absolute paths, drive letters, and
control characters on both the client and the relay.

> **Say it back:** A sequence CRDT gives every character a permanent identity, anchors
> inserts to identities, and tombstones deletes — that's sufficient for convergence.
> But convergence is about bytes, not meaning: two concurrent replacements of `1`
> produce `return 23` — valid, convergent, authored by nobody, flagged by nothing.
> Everything above the CRDT layer exists because of this.

---

## Lecture 4 — The sync engine: how an edit travels

**The question this lecture answers:** what happens, step by step, between "an agent
saves a file" and "every other peer's disk has it"?

### 4.1 The path of an edit

```
1. A human or agent changes a file (editor buffer, or directly on disk).
2. reconcile() diffs the new text against that file's Y.Text and applies the
   difference as a CRDT update.
3. The update is broadcast through the relay to every other peer in the room.
4. Each peer merges the update into its own Y.Doc — the CRDT guarantees convergence.
5. reconcile() on each peer writes the resulting text back to that peer's disk.
```

Round-trip is **~1 second** (watcher debounce + diff + relay fan-out + peer write —
the merge itself is milliseconds). There is no git push/pull anywhere in this loop.

### 4.2 `reconcile()` — the bridge between disk and CRDT

The heart of the sync engine. It keeps three worlds in step: **disk ↔ Yjs ↔ relay**.
The subtle problem it solves: a file on disk is a **whole snapshot**, but the CRDT
wants **operations**. Naively you'd diff "disk now" against "doc now" — and that is a
data-loss bug. Watch:

```
t0   doc = disk = "A\nB"            agent's editor still shows "A\nB"
t1   teammate adds line C  →  doc = "A\nB\nC"   (arrived via relay)
t2   agent (who never saw C) saves its edit: disk = "A2\nB"
```

If you now diff disk (`A2\nB`) against doc (`A\nB\nC`), the diff says *"delete line
C"* — and the teammate's just-arrived work is silently destroyed by an agent that
never even saw it.

So `reconcile()` tracks **two reference points per file**:

- **`base`** — the last content this peer synced with the room.
- **`fork`** — what *this author* last actually saw or wrote.

A local write is merged against the **fork point**, not the latest doc. In the trace
above: the agent's edit is understood as "`A→A2` relative to `A\nB`", three-way merged
with the doc's "`+C` relative to `A\nB`" — result `A2\nB\nC`. The stale save **re-adds**
the teammate's line (or raises a real conflict) instead of deleting it.

### 4.3 First-contact adopt

Edge case: a peer joins a room that already contains `app.js`, and the peer *also* has
a local `app.js` with different content — and there is **no shared ancestor** (e.g. you
cloned the repo from GitHub, then joined a room where someone else had already been
editing). Three-way merging two unrelated versions produces duplicated content — every
line looks "added by someone." So on first contact, `reconcile()` **adopts the room's
copy** and preserves your local copy as a restore point. Deterministic, no duplication,
nothing lost.

> **Say it back:** reconcile() bridges disk snapshots to CRDT operations. It merges
> every local write against the author's fork point (what they last saw), not the
> latest doc — so a stale save re-adds a teammate's concurrent lines instead of
> deleting them. On first contact with no shared ancestor, it adopts the room copy and
> keeps yours as a restore point.

---

## Lecture 5 — ICR part 1: merging by meaning (units, keys, the keyed 3-way)

**The question this lecture answers:** if character-merging is wrong, what is the right
unit of merging — and how does a structural merge actually decide?

> **CRDTs merge characters. ICR merges meaning.**

ICR (Intent-aware Code Replication) lives in `icr.js` (the engine, language-agnostic)
plus a **provider** per language (`lang-js.js` on acorn for full-AST JavaScript;
structural+intent providers for TypeScript, Python, C-family, Ruby; JSON is merged as
parsed *data*; YAML/TOML by keyed structure — 20+ languages). It's extracted as the
standalone npm library **`icr-merge`** (library + git merge driver + CLI).

### 5.1 The API you should be able to write on a whiteboard

```js
import { merge } from 'icr-merge'

const r = merge(base, ours, theirs, { filename: 'auth.js' })
// r = {
//   text,        // the merged content — ALWAYS present, never null
//   clean,       // true = safe to ship; false = a human/judge must look
//   method,      // 'structural' | 'rename' | 'lines' | 'resolved'
//   renames,     // ['login->signIn'] when a rename was detected & applied
//   provenance,  // [{ unit, author }] — who owns each surviving declaration
//   semantic,    // named conflicts, e.g. ['fn:login']  (meaning-level)
//   warning,     // the same conflicts as a human sentence
//   resolvable,  // machine-resolvable conflict units — see Lecture 7
// }
```

### 5.2 Step 1 — the parse gate

All three versions (`base`, `ours`, `theirs`) must parse. If any doesn't, ICR refuses
the structural tier and falls back to a line merge (git-quality floor). Reason: you
cannot merge *structure* you cannot *see*. No guessing.

### 5.3 Step 2 — units and keys (identity is everything)

Each version is split into **keyed units**:

```js
// this file...
import { db } from './db.js'
function login(user) { ... }
class Auth { ... }
const LIMIT = 5

// ...becomes these units:
//   import:./db.js      (keyed by SOURCE MODULE, not by text!)
//   fn:login
//   class:Auth
//   var:LIMIT
```

The **key is identity**: it is how ICR knows "`fn:login` in base, `fn:login` in ours,
and `fn:login` in theirs are *the same function*" even if the three texts differ.
Statements that have no name get content-anchored keys. This is the move that lifts
merging from "which characters changed" to "which *declarations* changed."

### 5.4 Step 3 — the keyed 3-way decision

For every key, compare the three versions. The whole decision procedure is a table you
can memorize:

| base | ours | theirs | decision |
|---|---|---|---|
| X | X | X | unchanged — keep |
| X | **Y** | X | only ours changed — **take ours** |
| X | X | **Y** | only theirs changed — **take theirs** |
| X | **Y** | **Y** | both made the *same* change — keep it (agreement) |
| X | **Y** | **Z** | both changed, differently — **descend a tier** (Lecture 6) |
| X | *(gone)* | X | ours deleted — delete (but check references! Lecture 7) |
| — | **Y** | — | ours added — add |
| — | **Y** | **Z**, same spot | both added at the same point — conflict, *unless* union mode (Lecture 7.4) |

**Worked example — the everyday win.** Agent A rewrites `login()` to add rate
limiting. Agent B, concurrently, rewrites `logout()` to clear the session cache. A
character merge would risk fusing them if the functions are adjacent. ICR: key
`fn:login` changed only in A → take A's. Key `fn:logout` changed only in B → take B's.
**Clean merge, method `structural`, both intents intact** — and `provenance` records
that A owns the surviving `login` and B owns `logout`.

### 5.5 Splice, don't rebuild

Merged units are **spliced back into the original bytes at their original ranges** —
ICR never pretty-prints or regenerates the file. Every comment, every blank line, every
formatting quirk *between* units survives verbatim. (Format-preservation is not
cosmetic: re-generated formatting would itself show up as a spurious "edit" to every
other peer.)

### 5.6 Import awareness

Imports are keyed by **source module**, so imports of *different* modules never
collide; and two sides importing *different specifiers from the same module* union
into one statement:

```js
// ours:                              theirs:
import { hash } from './crypto.js'    import { verify } from './crypto.js'

// ICR merges to:
import { hash, verify } from './crypto.js'
```

> **Say it back:** ICR parses all three versions (refusing if any doesn't parse),
> splits them into units with identity keys (`fn:login`, `import:./db`), and runs a
> keyed 3-way: one-side-changed wins, both-changed descends a tier, same-change is
> agreement. Merged units are spliced back into the original bytes so formatting
> survives. The key insight: give code units *identity*, and merging becomes a
> per-identity decision instead of a character soup.

---

## Lecture 6 — ICR part 2: tier descent, and the hard promise

**The question this lecture answers:** what happens when both sides change the *same*
declaration — and what exactly does ICR guarantee about its output?

### 6.1 The tier ladder

"Both changed `fn:login`" does not have to mean conflict. ICR descends:

```
declaration  →  statements inside it  →  whole lines  →  tokens  →  (conflict)
```

At each tier it re-asks the same keyed-3-way question at finer grain, and it only
declares a conflict when the two edits genuinely overlap at the finest grain.

**Tier: statements.** A edited line 2 of `login`, B edited line 5. `splitUnit` breaks
the function body into statement units; the keyed 3-way now sees two *different* units
each changed on one side → both win. Clean.

**Tier: lines (`lineMerge3`).** A whole-line diff3 — lines travel with their
indentation, which matters enormously for Python, where a token-level splice can mangle
significant whitespace.

**Tier: tokens (`tokenMerge` → `tokenMerge3`).** Both sides edited the *same line*.
Tokenize; diff each side against base (Myers diff at token boundaries); if the two
edits' base character-spans are **disjoint**, splice both in. Worked example:

```js
// base:
fetch(url, { method: 'GET',  timeout: 1000 })
// ours changed the method:            theirs changed the timeout:
fetch(url, { method: 'POST', timeout: 1000 })     fetch(url, { method: 'GET', timeout: 5000 })

// ICR token tier: the two edits touch disjoint base spans → splice both:
fetch(url, { method: 'POST', timeout: 5000 })
```

If the spans **overlap** (both sides rewrote `'GET'` itself), that is a *real* conflict
— no tier can resolve two different intentions about the same tokens, and pretending
otherwise is how you get `return 23`. ICR reports it, with a name.

A guard worth knowing: the token tier refuses splices that would **fuse two "wordish"
tokens** into a new identifier (the token-level version of the `23` failure).

### 6.2 THE GUARANTEE

After all merging, the final text is **re-parsed**. If it does not parse, ICR refuses
to emit it — it falls back rather than ship broken output. Stated as the contract:

> **ICR never emits code more broken than its inputs.** If all three inputs parse, the
> output parses — or ICR declines and tells you.

Three details that make this a real guarantee and not a slogan:

1. **It's validated at every level** — even individual merged units are re-parsed
   (`parsesUnit`) before splicing, and the line tier has an *honesty gate*: if diff3
   line-merges "cleanly" but the result doesn't parse while all inputs did, `merge()`
   returns `clean: false` with a warning instead of shipping it silently. From
   `index.js`:

   ```js
   if (!lm.conflict && filename) {
     const lang = languageFor(filename)
     if (lang && !lang.parses(lm.text) && lang.parses(base) && lang.parses(ours) && lang.parses(theirs)) {
       return { text: lm.text, clean: false, method: 'lines',
                warning: 'line-merged text does not parse; a human or judge should reconcile' }
     }
   }
   ```

2. **It's fuzz-tested** — thousands of random merges per run assert the parse
   guarantee, across languages.

3. **It's oracle-hardened** — an opt-in **tree-sitter oracle** upgrades the parse gate
   with real grammars for 15 languages, *composed* with the built-in heuristics (both
   must accept — the heuristics are sometimes stricter, e.g. Python indentation).

### 6.3 Convergence — the property that lets a merge live inside a CRDT

This one is subtle and interviewers love it. Hivecode runs ICR **inside the live sync
loop** — every peer merges independently. That only works if the merge function is:

- **Symmetric:** `merge(base, a, b) == merge(base, b, a)`. Peer 1 sees "my text + their
  update"; peer 2 sees the mirror image. If the merge cared about argument order, the
  two peers would compute *different* results — divergence.
- **Fixed-point:** `merge(base, T, T) == T`. Once everyone agrees on T, re-merging must
  return T unchanged. Without this, agreed text would keep mutating on every sync pass
  — the peers ping-pong forever.

These aren't theoretical: an early version of ICR lacked them and **did diverge in the
live relay**. `icr-converge-test.js` now checks symmetry, fixed-point, absorption, and
runs a 1,000+ case two-peer simulation every run.

### 6.4 Language-agnostic by construction

`icr.js` knows no language. Everything language-specific sits behind a **provider**
interface (parse, units, keys, tokenize…). Adding a language = writing a provider —
proven by `icr-lang-test.js`, which registers a brand-new toy language *at runtime* and
merges it.

> **Say it back:** Both-changed doesn't mean conflict — ICR descends
> declaration → statement → line → token, merging wherever the edits' base spans are
> disjoint, conflicting only where intentions truly overlap. The output is re-parsed at
> every level: ICR never ships code more broken than its inputs. And because it runs
> inside a CRDT, the merge must be symmetric and fixed-point — properties an early
> version lacked, and it really did diverge live until they were enforced.

---

## Lecture 7 — ICR part 3: the intent layer (where nothing else competes)

**The question this lecture answers:** what does ICR see that git, mergiraf, and every
CRDT are structurally blind to?

Everything in Lectures 5–6 is "structural merge done carefully." This lecture is the
layer that has no competitor, because it exploits a fact unique to Hivecode's setting:
**the authors are alive**. Git merges dead text written by people who left. Hivecode
merges edits from agents who are *in the room*, who declared *why* they're editing, and
who can be *asked*.

### 7.1 Rename detection — rewriting the other author's stale code

**Scenario:** Agent A renames `login → signIn` across the codebase. Agent B,
concurrently, **adds a new call to `login()`** in a function A never touched.

Every other tool merges this "cleanly" into broken code: the definition is now
`signIn`, and B's brand-new `login()` call references nothing. It parses. It crashes at
runtime. Nobody is told.

ICR's mechanism: a base declaration *disappeared* while an **identical-bodied twin
under a new name** *appeared* → that's a rename, not a delete+add. ICR then **rewrites
B's stale call sites** to the new name:

```js
// base:                      A (renamed):                B (added a caller):
function login(u){...}       function signIn(u){...}     function login(u){...}
                              signIn(x)                   function onSubmit(){ login(form) }

// ICR result — B's new call site is rewritten to A's rename:
function signIn(u){...}
function onSubmit(){ signIn(form) }
// r.method === 'rename', r.renames === ['login->signIn']
```

Crucially, call-site rewriting goes through a **real scope analyzer** — a local
variable that merely *shares* the deleted name is not mistaken for a reference to it:

```js
function other() {
  const login = getForm()   // a LOCAL binding named 'login'
  login.submit()            // ← must NOT be rewritten to signIn.submit()
}
```

### 7.2 Dangling-reference detection — flagging code that parses

**Scenario:** A deletes `function helper()`. B, concurrently, adds a call to
`helper()`. Line-merge is textually clean (the edits don't even touch the same lines),
the result **parses** — and it is broken. This is the exact failure class that git,
mergiraf, and CRDTs all ship in silence.

ICR resolves references through scopes after the merge; a declaration that was
removed/renamed but is **still referenced** raises a named `semantic-conflict`
(`ref:helper`) even though the code parses. The result is returned `clean: false` —
**no consumer can ship it silently.**

### 7.3 Semantic conflicts are machine-resolvable objects

When both sides genuinely rewrote the same declaration, ICR doesn't emit a vague
"conflict" — it emits a **resolvable unit** carrying everything a judge needs:

```js
r.resolvable = [{
  key: 'fn:login', kind: 'both-changed',
  base:  '...base version of login...',
  ours:  '...A\'s version...',      oursIntent:  'add rate limiting to login',
  theirs:'...B\'s version...',      theirsIntent:'switch login to async/await',
  filename: 'auth.js',
}]
```

`base/ours/theirs` **plus each side's intent** — the *why*, not just the *what*. That
object is the input to the resolution flow (Lecture 7.5).

### 7.4 Union-insert mode — the multi-agent merge policy

**The newest piece, and the one CooperBench justified.** The dominant conflict shape
between two agents doing *independent tasks* is not "both rewrote the same function" —
it is "**both inserted different new code at the same point**": both added a method to
the same class, both registered an entry in the same table, both appended a test. In
CooperBench's residue, **87.5% of what plain ICR refused was this shape.**

For anonymous git authors, refusing is correct — the right *order* of two same-point
insertions is unknowable, and a wrong guess is silent corruption. But in the
multi-agent medium the context is different: the medium **knows** these edits serve
independent tasks. So there is a correct policy: **keep both, in deterministic order,
and re-validate everything** (parse gate + dangling-reference check still apply). This
is opt-in:

```js
const r = merge(base, ours, theirs, { filename: 'api.py', unionInserts: true })
```

Internally, when diff3 sees a same-point pure insertion on both sides, it keeps both
hunks ordered **by content** (not by argument order!) — which is what preserves
symmetry, the CRDT requirement from Lecture 6.3:

```js
// icr.js — the union branch inside diff3Interleave:
if (samePointInsert && opts.unionInserts) {
  const ka = ak.slice(x.os, x.oe).join('\n'), kb = bbk.slice(y.os, y.oe).join('\n')
  const [first, second] = ka <= kb ? [{h:x, side:'a'}, {h:y, side:'b'}]
                                   : [{h:y, side:'b'}, {h:x, side:'a'}]
  edits.push(first, second); i++; j++; continue
}
```

Measured effect (Lecture 12): integration of CooperBench's git-conflicted pairs jumps
**22.2% → 40.8%**, at a measured precision cost of 96.2% (down from 100%) — the two
failures being genuine *semantic interactions* between features, which is exactly what
the next layer (the judge) exists to catch.

### 7.5 `resolveMerge` — AI resolves, ICR verifies

The capstone of the intent layer. When a conflict is truly semantic (two intentions
about the same code), no algorithm can pick — but a **judge** (an LLM, an agent in the
room, any brain) can, *if* it's given both intents. The danger: judges hallucinate. The
design answer: **the judge proposes; the engine re-validates; broken resolutions
cannot ship.**

```js
import { resolveMerge } from 'icr-merge'

const r = await resolveMerge(base, ours, theirs, {
  filename: 'auth.js',
  intents: { ours: 'add rate limiting', theirs: 'make login async' },
  judge: async (unit) => {
    // unit = { key, base, ours, theirs, oursIntent, theirsIntent, filename }
    // Ask any LLM: "reconcile these two versions honoring BOTH intents."
    return await askModel(unit)   // return reconciled text, or null to decline
  },
})
// r.resolved === true  ONLY IF the judged text re-merged cleanly AND re-parsed.
// A broken/hallucinated resolution → r.resolved === false, original safe conflict returned.
```

Mechanics worth being able to recite: the judge's reconciled text is written to **both
sides**, turning the conflict into agreement; then the result goes back through the
**full engine** — re-merged, re-parsed, dangling-references re-checked. Only clean AND
parseable survives. (JSON is special-cased: its provider exposes `applyResolution` to
set the judged *value* at the conflicted path, since a rendered JSON unit may not
appear verbatim in the document.)

**The division of responsibility, stated plainly: the medium guarantees structure; the
judge owns semantics.**

### 7.6 Honest limits (know these cold — they test honesty)

- ICR guarantees **structure, not semantics**: two agents inventing two different data
  schemas merge side-by-side into runnable code with two schemas — which one is
  "right" is a product decision, not a merge decision.
- A comment and code edited on the same side can lose the comment.
- Heuristic-language providers have weaker parse oracles unless tree-sitter is on.
- A judge's resolution can be semantically wrong while structurally valid — that
  boundary is *deliberate* (the alternative is the engine pretending to understand
  product intent).

> **Say it back:** The intent layer exploits live authors: renames are detected
> (identical body, new name) and the *other* author's stale call sites are rewritten
> through a real scope analyzer; deleted-but-still-referenced code raises a named
> conflict even though it parses; true semantic conflicts become machine-resolvable
> objects carrying both intents; union mode keeps both same-point insertions
> (content-ordered, so still symmetric) because the medium knows the tasks are
> independent; and resolveMerge lets any judge reconcile — with the engine re-validating
> so a hallucinated fix can never ship.

---

## Lecture 8 — The Hive coordination layer: prevention without a boss

**The question this lecture answers:** merging collisions is the cure — what's the
prevention, and why does it have no central controller?

ICR cleans up **after** a collision. Better: don't collide. The coordination layer
(`hive-coord.js`) prevents collisions **before** the edit, using two mechanisms with
decades of proof behind them:

- **Ethernet's CSMA/CD** — carrier-sense before transmitting, detect collisions,
  back off and retry. Ethernet coordinates millions of devices with no coordinator.
- **Ant-colony stigmergy** — coordination through *traces in a shared medium* that
  evaporate over time. No ant commands another ant.

### 8.1 The protocol

The shared medium is just the CRDT `claims` map — same relay, zero extra
infrastructure:

```
SENSE   → read Y.Map('claims'): is this file already taken?
FLOW    → if taken, move to an open file  (emergent load-balancing —
          agents "flow around" each other like water)
CLAIM   → write { by, intent, at, ttl } into claims[path]
VERIFY  → re-read AFTER sync; if a concurrent claim won, back off
RELEASE → when done — and claims auto-expire via TTL, so a crashed
          agent never deadlocks the hive
```

In pseudocode:

```js
async function acquire(path, intent) {
  if (isClaimed(path)) return flowToOpenFile()          // SENSE → FLOW
  claims.set(path, { by: me, intent, at: now(), ttl: 90_000 })  // CLAIM
  await sync()                                          // let the CRDT settle
  const winner = claims.get(path)                       // VERIFY
  if (winner.by !== me) return backoffAndRetry()        // lost the race
  return true                                           // work, then RELEASE
}
```

### 8.2 Why each design choice

- **Why not locks?** Locks need a coordinator (a single point of failure), deadlock
  when a lock-holder crashes, and serialize exactly the parallelism agents exist for.
  Claims + TTL give collision *avoidance* with no boss; ICR handles the residue.
- **Why VERIFY after sync?** Two agents can claim simultaneously — the CRDT map will
  converge on one winner (map values are last-writer-wins registers — here LWW is
  *fine*, because a claim is disposable metadata, not code). Re-reading after sync is
  the collision-detect step; the loser backs off. This is CSMA/CD verbatim.
- **Why TTL expiry?** A crashed agent's claim evaporates on its own — stigmergy's
  pheromone decay. No garbage collector, no admin.

**Proven in simulation: 756 collisions → 0, with no central controller.**

### 8.3 The honest status: advisory vs enforced

In the live swarm runs (Lecture 11), this layer ran **advisory** — it *warns* but the
relay didn't *block* a rogue write. Undisciplined agents collided anyway, and ICR (the
only LLM-independent primitive in the live path) absorbed it. The lesson became the
roadmap: relay **enforcement** is built (`HIVE_ENFORCE_CLAIMS`: warn / block / queue
with zero-loss replay) — making the coordination *structural*, not behavioral.

**The two primitives together:** Hive layer **prevents** most collisions; ICR
**resolves** the rest. Prevention + safety net.

> **Say it back:** Claims are CSMA/CD over a CRDT map — sense, claim, verify after
> sync, back off if you lost — with TTL evaporation (stigmergy) so a dead agent can't
> deadlock anyone. No controller anywhere. Sim-proven 756→0. Live runs showed advisory
> isn't enough, which is why relay-side enforcement exists: prevention must be
> structural, and ICR remains the safety net.

---

## Lecture 9 — The provenance substrate: signed changes and the silent-fork gate

**The question this lecture answers:** the CRDT destroyed the *evidence* of what each
author wrote (`return 23` has no author). How do you get the truth back — 
cryptographically?

### 9.1 The unit of exchange: a signed CHANGE

Hivecode's substrate bet: the medium shouldn't carry naked bytes; it should carry
**(intent, patch, provenance)**. Every client holds an **Ed25519 keypair**, and the
author's identity *is* the fingerprint of the public key — **self-certifying**, no
account database anywhere. Every authored edit produces a signed **receipt**:

```js
receipt = {
  author:  fingerprint(publicKey),        // WHO (self-certifying identity)
  parent:  sha256(textEditedFrom),        // FROM WHERE (the exact state they saw)
  content: sha256(resultText),            // TO WHAT
  intent:  'add rate limiting to login',  // WHY — bound in at edit time
  at:      1720000000,
  sig:     ed25519.sign(privateKey, canonical(allOfTheAbove)),
}
```

Change any field — the signature breaks. Receipts append to a per-file **ledger** (a
`Y.Array` inside the file's own sub-document, so it inherits the file's access
control). A companion **`versions` map** stores the full text of every state any
author edited from or produced, keyed by content hash — *the ledger has the hashes,
`versions` has the bytes.*

Three invariants the medium enforces:

- **I1 — provenance-verified:** unattributable bytes are rejected (strict mode) or
  flagged (audit mode).
- **I2 — convergent:** ICR's symmetry/fixed-point (Lecture 6.3).
- **I3 — non-regressing:** the medium never moves to a worse-parsing state — the
  relay's content-authority check reverts forged or regressing heads.

### 9.2 The silent-fork gate — catching `return 23` after the fact

Walk the timeline; this is the single best story in the system:

```
t0  base = "return 1"       hash P.   Both agents sign edits FROM parent P:
t1  A signs (parent: P, content: hash("return 2"), intent: "handle the retry case")
t1  B signs (parent: P, content: hash("return 3"), intent: "return the fallback")
t2  the CRDT fuses the texts → "return 23" on every peer
```

The key observation: **`return 23` is unsigned.** Nobody authored it, so no receipt
attests it — while **both real versions were signed against the same parent**. The
provenance ledger preserved exactly the truth the character-CRDT destroyed.

Detection (`computeFork`): group receipts by `parent`; a parent with **two or more
different-content children** is a *candidate* fork. Then the **discriminator**: replay
a 3-way merge of the children against the parent — if the edits were disjoint and fuse
fine (the normal, healthy case!), it is NOT flagged; only children whose texts
*genuinely conflict* on the 3-way are a **silent fork**. (Without the discriminator
you'd scream on every healthy concurrent edit — precision matters.)

```js
function computeFork(ledger, versions) {
  const byParent = groupBy(ledger, r => r.parent)
  for (const [parent, receipts] of byParent) {
    const children = uniqueBy(receipts, r => r.content)
    if (children.length < 2) continue
    const base = versions.get(parent)
    const texts = children.map(c => versions.get(c.content))
    if (threeWayConflicts(base, texts))        // ← the discriminator
      yield { parent, children }               // a silent fork: surface it
  }
}
```

### 9.3 Two engineering war stories inside this gate

**The capture race (and the shadow map).** You can't rely on fs-watching to capture an
authored edit *before* a concurrent merge contaminates the same file on disk — the
watcher is too slow, and then you'd sign contaminated bytes. Fix: the engine keeps a
**shadow map** — the exact bytes IT last wrote per file. Any disk-vs-shadow divergence
is *by definition* an authored edit, and `(shadow → disk)` is its true, uncontaminated
base→text pair — captured and signed at the entry of every pass that could clobber it.
(And the `hive_edit` tool writes *through* the medium, closing even that window.)

**Marker fusion (truth vs liveness).** The original design rendered conflict markers
(`<<<<<<<`) *into the shared Y.Text* — and it failed beautifully: concurrent marker
writes **fuse just like code does** (of course they do — markers are just characters!).
The fix is an architectural principle: **truth and liveness are separated.** The
conflict record lives in a synced CRDT structure (truth); markers are rendered to each
peer's **local disk only** (liveness). The shared text never contains markers.

**Resolution:** an author who has *seen* the markers and writes clean code over them
publishes the resolution; folded fork versions are marked (`forkmark`) so a lagging
peer can't re-raise a conflict that's already been resolved.

### 9.4 Intent-aware resolution over the medium

A surfaced fork is exposed to the room as a machine-resolvable object (`hive_fork`):
common base + every version's text + each side's **cryptographically signed intent**.
(A real bug fixed here: intent must come from the author's own signed receipt — an
early version read the live claim under collision and misattributed the winner's
intent to the loser.) **Any** participant may submit a full reconciled file
(`hive_resolve`). The medium validates: no conflict markers, parses, no dangling
references, and reports token-level **intent coverage** — did each side's changed
tokens actually survive? A lazy single-winner "resolution" is announced, never silent.
A failing proposal is refused and nothing changes. Same shape as `resolveMerge`
(Lecture 7.5): **AI resolves; the medium verifies.**

> **Say it back:** Every authored edit is Ed25519-signed as (author, parent-hash,
> content-hash, intent); identity is the key fingerprint, so there's no account system.
> The fused `return 23` is unsigned, while both real versions are signed children of
> one parent — computeFork finds multi-child parents and a 3-way discriminator separates
> healthy concurrency from silent forks. Shadow map beats the capture race; markers
> render locally because shared markers fuse like code; any agent may resolve and the
> medium re-validates with intent coverage.

---

## Lecture 10 — Security: trust with no accounts, and the agent interface

**The question this lecture answers:** how do you authorize peers when the relay
stores nothing and there is no user database?

### 10.1 The room id IS the trust root

A secured room's id is `hs_<fp>_<rand>`, where `fp` is a base64url SHA-256 fingerprint
of the **owner's public key**. Every access token carries the owner's public key
(claim `pk`) and is signed by the matching private key (**RS256**). The relay's check:

```
trust the token  ⟺  fingerprint(token.pk) === the fp embedded in the room id
                     AND the RS256 signature verifies against token.pk
```

Follow what this buys you:

- Trust is anchored **in the room id itself** — any relay, anywhere, can verify a
  token for the room with zero stored state. No accounts, no shared secrets, no DB.
- **Why RS256 and not HS256?** HS256 needs a shared secret *on the relay* — the relay
  becomes the trust root and a breach mints valid tokens. RS256 keeps the private key
  with the owner; the relay only ever holds public material.
- **Why RS256 for tokens but Ed25519 for change receipts?** Tokens want JWT-ecosystem
  compatibility; receipts want small, fast signatures on *every* edit. Different jobs,
  different tools.
- Per-path authorization: a client scoped to `frontend/` never *receives* other bytes.
- Read-only roles: the relay **drops a read-only client's inbound writes at the
  protocol level** — not a UI courtesy, an enforcement.
- Instant revoke survives relay restarts; auth is fail-closed and algorithm-pinned.

### 10.2 The agent interface — MCP tools

Any MCP-capable agent joins a room through native tool calls — no scripts, no human
babysitting. Register once:

```json
{ "mcpServers": { "hivecode": { "command": "npx", "args": ["-y", "hivecode-mcp"] } } }
```

| Tool | What it does |
|------|--------------|
| `hive_join` | Join/host a room for a folder; returns room info + the HIVE_RULES. |
| `hive_say` / `hive_read_chat` | Post / read coordination messages (announce intent before editing). |
| `hive_read_board` | Recent whole-file rewrites — read before you edit. |
| `hive_claim` / `hive_release` / `hive_claims` | The coordination layer (Lecture 8). |
| `hive_members` | Who's in the room (humans + agents). |
| `hive_assign` / `hive_read_tasks` / `hive_complete` | Directed work + approval state. |
| `hive_fork` / `hive_resolve` | Inspect / resolve a surfaced silent fork (Lecture 9.4). |
| `hive_wait` | **Block** until approved work or new chat arrives (~1s reaction). The agent's main loop — no polling. |
| `hive_status` / `hive_leave` | Session info / leave. |

The canonical agent loop: `hive_wait` → do approved work → `hive_complete` →
`hive_wait`. The agent never runs a sync command; it just calls tools. **Why MCP and
not a REST API?** Agents already speak MCP natively — tools *are* an agent's UI — and
the relay stays protocol-dumb.

> **Say it back:** The room id embeds the owner's key fingerprint, so any relay can
> verify RS256 tokens statelessly — self-certifying, no accounts, fail-closed.
> Enforcement is protocol-level: scoped clients never receive out-of-scope bytes,
> read-only writes are dropped at the socket. Agents join over MCP and live in a
> hive_wait loop.

---

## Lecture 11 — What happened when we ran real swarms (the validation log)

**The question this lecture answers:** what does theory look like when five real
agents hit it?

We ran a simulated AI software company ("HiveLabs"): multiple autonomous agents
(Hermes runtime, Nemotron model) joining one Hivecode room over MCP, building real
apps, orchestrated by a Claude acting as CEO, with a human director (Ganesh).

**Run A — "FlowBoard" (Kanban app).** Roles: CEO, PM, Backend, Frontend, QA. Outcome:
completed — REST API, persistence, frontend, 13/13 tests. *First lesson:* an agent
that lacks a tool doesn't say "I can't" — it **improvises chaotically** (tries
terminal, `npx`, subprocesses). Make sure the tools are loaded, then tell it to call
them directly.

**Run B — "StreakBoard" (habit tracker) — the run that mattered.** Agents ignored
their chat-assigned lanes; PM and Agent4 both edited `server.js`; mid-conflict the
file ballooned to **~361 KB** in a merge-thrash loop. What held: **ICR absorbed every
collision** — including semantic renames (`habitForm→form`, `TEST_PORT→PORT`) across
call sites — and never lost a line; the 361 KB monster converged back to a clean,
correct ~77-line file. What fixed the thrash: burning each agent's role into its
**system prompt** (identity lock), not chat — the claim board went collision-free the
moment roles were identity-locked. *Quality finding:* the output still had scar
tissue — a duplicated block, **two divergent data models** (two agents invented two
schemas), and a test file where the real tests were `.skip`ped. ICR kept it *runnable*;
it cannot decide which schema is *right*. That is the boundary between structure and
semantics, live.

**Run C — "HelpDesk" (support tickets).** Designed around Run B's lessons: (1) a
binding **CONTRACT.md** written by the PM *before any code* — both sides build against
it, so schemas can't diverge; (2) a dedicated **Validator agent with veto power** —
runs tests (rejecting `.skip`), boots the server, reviews diffs against the contract;
nothing is "done" without its ✅; (3) a real ticket board with **acceptance criteria
per story**. Early result: contract written first ✅, criteria referenced the contract
✅ — a clear quality jump. Lane discipline still leaks on agent wake-up.

**The lessons, distilled (these four sentences are interview gold):**

1. **Role boundaries must live in the system prompt, not chat** — and be re-applied on
   reconnect; a woken agent reverts to grab-anything behavior.
2. **Advisory ≠ enforced.** The claim board warns but didn't block; undisciplined
   agents collided anyway. Coordination must be structural.
3. **ICR was the only LLM-independent primitive in the live path** — it works whether
   or not the agents behave, and it proved itself under extreme churn.
4. A swarm needs a third thing beyond don't-lose-work (ICR) and don't-collide (Hive):
   **don't-ship-bad-work** — contracts, verification gates, adversarial review.

> **Say it back:** Live swarms validated ICR under real chaos (361 KB thrash → clean
> 77 lines, renames rewritten across call sites, zero lines lost) and exposed the
> system's real frontier: prompts don't bind agents — identity does; advisory layers
> don't stop collisions — enforcement does; and merging can't pick between two
> schemas — a validator layer must.

---

## Lecture 12 — The evidence: every benchmark, and what each one proves

**The question this lecture answers:** what independent, reproducible evidence exists —
and what precisely does each result claim?

A claim per benchmark. Learn them as *claims*, not numbers.

### 12.1 Head-to-head vs mergiraf — "we can hang with the best free tool"

**mergiraf** (a tree-sitter structural git merge driver, Rust) is the strongest free
competitor. First benchmark run: ICR **lost 87–0** on adjacent same-statement edits —
which forced the token tier (Lecture 6.1). After it: ICR **ties mergiraf on core
merges and beats it on rename + dangling-reference** — mergiraf ships the broken merge
in both of those cases. Its remaining edge: language breadth via mature grammars.
*Lesson in the story: we published the loss, fixed the cause, and re-ran.*

### 12.2 The merge census — "silent breaks exist in the wild"

Replay real OSS repos' merge history (axios, express, mongoose, lodash…) and look for
merges that line-merged "cleanly" (git raised no conflict — no human ever looked) yet
carried a semantic break ICR catches. Real findings, receipts in JSON, zero engine
crashes. This is the proof-of-pain: the failure class ICR targets isn't hypothetical.

### 12.3 The ground-truth gauntlet — "we resolve like humans did"

Replay **279 real, human-resolved conflicts** from OSS history and compare each tool's
resolution against the human answer key (`git show M:file`). **ICR 87/279 vs mergiraf
64/279 — ICR out-resolves mergiraf on all 5 repos, 0 broken outputs.** This is the
strictest test: not "did it merge," but "did it merge the way the human did."

### 12.4 ConGra (public academic benchmark) — "the guarantee holds at scale"

ConGra (arXiv:2409.14121): **6,430 real Python conflicts** with `ast.parse`
verification. Result: ICR resolves **32.1% vs mergiraf's 31.8%**, with **0 crashes and
0 measured parse-guarantee violations** (running it found 17 real guarantee bugs —
Python lexer/compound-statement defects — which were fixed; the number is now
measured-zero, not assumed-zero). Claim: at 6,000+ real conflicts, THE GUARANTEE holds.

### 12.5 CooperBench — "the Hivecode thesis, measured by someone else's benchmark"

The one that matters most, because it tests the *product thesis*, not just the engine.
CooperBench (Stanford, arXiv:2601.13295): 652 pairs of independent features, written by
professionals, on 12 real libraries; success = the merged tree passes **both**
features' own test suites.

The ladder (all replayed on our harness, 30 tasks, receipts committed):

| Integration layer | Of the 505 git-conflicted pairs, integrates cleanly | Functionally verified |
|---|---|---|
| git merge | 0% (they're the conflicts) | — |
| mergiraf 0.18 | 56 → **11.1%** | — |
| **ICR (safe default)** | 112 → **22.2%** | **100%** (27/27 scoreable pass both suites) |
| **ICR union mode** | 206 → **40.8%** | **96.2%** (50/52; the 2 failures are real feature *interactions*) |

Method notes you should be able to defend: replication cross-checked against the
paper's own `gold_conflict_report.json` (git conflicts 505 vs paper's 499 — same
76.5%); validation ran both features' pytest suites on the assembled merged tree;
**solo controls** separated environmental failures (a feature whose gold tests fail on
its own *unmerged* tree is excluded) from true merge defects; 0 crashes throughout.

Claim: **the coordination tax that Stanford measured is 40% recoverable by the merge
layer alone, functionally verified** — before any agent gets smarter. The residue
(344 judge-resolvable pairs, manifest of 703 intent-carrying units prepared) is the
target of the judge tier — the staged path from 40.8% toward the ~90% ceiling.

> **Say it back:** Five bodies of evidence, five claims — we hang with the best free
> tool (and beat it where intent matters); silent breaks exist in real OSS history; we
> resolve real conflicts the way humans did more often than mergiraf; the parse
> guarantee holds at 6,430-conflict scale, measured not assumed; and on Stanford's own
> multi-agent benchmark the merge layer alone recovers 40.8% of the coordination tax
> at 96.2% verified precision.

---

## Lecture 13 — MASTERCLASS recap: the mechanisms in one page

> The old §13 condensed. Each line is a mechanism you must be able to expand into a
> full explanation (the lecture teaching it is in parentheses).

- **Sequence CRDT:** char identity `(clientID, clock)`, anchored inserts, tombstoned
  deletes → convergence of bytes, blindness to meaning → `return 23`. Never say LWW. (L3)
- **reconcile():** merge local writes against the author's **fork point**, not the
  latest doc; first-contact adopt. (L4)
- **ICR pipeline:** parse gate → keyed units → keyed 3-way → tier descent
  (decl→stmt→line→token, disjoint-span splice) → splice into original bytes → re-parse
  (THE GUARANTEE) → intent layer (rename rewrite via scope analyzer; dangling-ref flag). (L5–7)
- **Convergence:** symmetric + fixed-point, or live peers diverge — they did, once. (L6.3)
- **Union-insert mode:** same-point pure insertions both survive, content-ordered
  (symmetry preserved), opt-in — the multi-agent policy CooperBench justified. (L7.4)
- **resolveMerge:** judge proposes with both intents in hand; engine re-merges,
  re-parses, re-checks references; broken resolutions cannot ship. (L7.5)
- **Hive claims:** CSMA/CD + stigmergy over a CRDT map; TTL evaporation; VERIFY after
  sync; advisory→enforced roadmap. (L8)
- **Provenance:** Ed25519 receipts (author=key fingerprint, parent hash, content hash,
  signed intent); ledger + versions map; invariants I1/I2/I3. (L9.1)
- **Silent-fork gate:** the fused text is *unsigned*; signed same-parent children ARE
  the fork; 3-way discriminator kills false alarms; shadow map beats the capture race;
  markers render locally because shared markers fuse. (L9.2–9.3)
- **Security:** room id embeds owner-key fingerprint; RS256 tokens verified statelessly
  against it; Ed25519 for receipts; per-path scoping; protocol-level read-only. (L10)

---

## Lecture 14 — The 20 interview questions you WILL get (with model answers)

**Q1. "Explain Hivecode in 90 seconds."**
*Model answer:* "AI coding agents are fast enough that git's push-pull loop is the
bottleneck, and running several agents on one codebase silently corrupts work — CRDT
editors converge to code nobody wrote, git defers the mess to merge hell. Hivecode is a
live shared workspace for humans + agents: a Yjs relay syncs every edit in ~1s, a
decentralized claim layer prevents most collisions, and ICR — our structural merge
engine — catches the rest by merging code by *meaning*, with a hard guarantee it never
ships unparseable output. On top, every change is cryptographically signed with its
author AND intent, which makes silently-fused edits detectable and lets any agent in
the room *resolve* a conflict — with the system validating the resolution before it
lands. The hardest part was making merge convergent enough to live inside a CRDT and
catching the conflicts CRDTs are mathematically designed to hide."

**Q2. "Why does Yjs fuse `return 2` + `return 3` into `return 23`?"**
Sequence CRDT: both deletes tombstone the same char; both inserts are distinct
characters with distinct identities, so both survive, deterministically ordered.
Convergence guaranteed, meaning not. (Never say "last write wins" — that's a register.)

**Q3. "Where do the pre-fusion versions come from?"**
The provenance ledger + versions map: every authored edit was signed as
(parent-hash → content-hash) and its full text stored by hash. The fused text is
unsigned; the two signed children of one parent ARE the fork.

**Q4. "Why not just lock files?"**
Locks need a coordinator (single point of failure), deadlock on crashed agents, and
serialize the very parallelism agents are for. Claims + TTL give collision *avoidance*
without a boss; ICR handles the residue. Locks also can't help humans editing offline.

**Q5. "Why RS256 tokens instead of a user database?"**
The room id embeds the owner's public-key fingerprint, so the token is verifiable
against the room itself — self-certifying, no server-side account store, relay stores
nothing, works across any relay host. HS256 would mean a shared secret ON the relay =
the relay becomes the trust root; RS256 keeps the private key with the owner.

**Q6. "What's your merge guarantee, exactly?"**
Never emit code more broken than the inputs: every structural merge result is re-parsed
before acceptance; failure → refuse + fall to the line tier (git-quality floor). Plus
symmetry and fixed-point, which is what lets it run inside a live CRDT loop.

**Q7. "What can't ICR do?"** (they're testing honesty)
It guarantees structure, not semantics — two schema designs merged side by side is
still a product decision. Comment+code edited on the same side can lose the comment.
Heuristic languages have weaker oracles unless the tree-sitter oracle is on. And a
judge's resolution can be semantically wrong while structurally valid — that boundary
is deliberate.

**Q8. "How do you test something like this?"**
Metamorphic properties, not example tests: convergence (`M(b,x,y)==M(b,y,x)`),
fixed-point, no-loss, parse-guarantee — held under seeded random fuzz (thousands of
merges/run, multiple languages), plus differential testing against `git merge-file`,
plus replaying real OSS history three ways (census, ground-truth gauntlet, ConGra),
plus a published multi-agent benchmark (CooperBench) validated with the benchmark's own
test suites, plus live multi-agent soak runs that found bugs no unit test would (the
capture race, marker fusion, mixed-build storms).

**Q9. "Tell me about a bug that humbled you."**
The dual-Yjs-instance relay bug: ESM and CJS copies of the yjs library in one process
corrupted the doc store after snapshot reload — rooms silently ate edits ONLY if the
room had cycled through empty. Diagnosed by a discriminator ladder (strict-deletion
hypothesis → audit mode → content check → snapshot-wipe repro) down to a one-line
`createRequire` fix. Lesson: "one library, one instance" and that convergence bugs hide
behind restart boundaries.

**Q10. "Why build your own merge instead of using mergiraf?"**
We benchmarked head-to-head — first run we LOST 87–0 on adjacent edits and fixed it
with a token tier. But the reason to own the engine: mergiraf merges dead text; our
conflicts carry live authors' signed intents and are machine-resolvable — that's the
layer agents actually need and nobody else has. And on Stanford's CooperBench, that
layer integrates 3.7× more of the real multi-agent coordination tax than mergiraf,
functionally verified.

**Q11–Q20 rapid fire:**
- *Byzantine agents?* Can't forge receipts (Ed25519), can't impersonate (ID = key
  fingerprint), can spam — mitigated by scoped tokens + revocation, not solved.
- *Scale ceiling?* Relay fan-out is O(peers) per update; per-file subdocs shard
  traffic; the ledger is append-only per file with GC of unreferenced versions.
- *Why MCP not a REST API?* Agents already speak MCP natively; tools are the agent's
  UI. The relay stays protocol-dumb.
- *Offline edits?* CRDT handles reorder/replay; first-contact adopt prevents
  no-ancestor duplication.
- *Undo?* Per-client Y.UndoManager (undo YOUR ops without reverting others) +
  snapshot restore points + revert-by-author.
- *Latency budget?* ~1s = watcher debounce + diff + relay fan-out + peer write; the
  merge itself is ms-scale.
- *Why Ed25519 for changes but RS256 for tokens?* Ed25519: small fast sigs on every
  change; RS256: JWT-ecosystem compatibility for room access.
- *GDPR/private code?* Relay holds transient state only, self-hostable, per-path
  scoping keeps out-of-scope bytes off disks.
- *What would you cut for production?* Advisory layers; keep enforcement (claims,
  provenance strict mode, content authority) — the roadmap was exactly
  "advisory → structural."
- *Biggest design regret?* Building fork detection on fs-watching before source-level
  capture; the shadow map fixed it but cost weeks.

---

## Lecture 15 — What has been built, and the roadmap

### The repo

| Area | Files |
|---|---|
| **Relay** | `server.js` (y-websocket relay + auth + per-path scope + persistence + claim enforcement) |
| **Sync engine** | `sync.js`, `reconcile()` (disk ↔ Yjs ↔ relay bridge) |
| **Editor client** | `extension/` (VS Code/Cursor/Windsurf/Antigravity) |
| **Agent client** | `hive-mcp.js` → published as `hivecode-mcp` |
| **ICR** | `packages/icr-merge/` (standalone library: engine + 20+ language providers + tree-sitter oracle + git merge driver + CLI) |
| **Hive coordination** | `hive-coord.js` (SENSE→FLOW→CLAIM→VERIFY→RELEASE) |
| **Provenance substrate** | `substrate.js` (Ed25519 receipts, ledger, silent-fork gate, `hive_fork`/`hive_resolve`) |
| **Security/RBAC** | token signing, fingerprint-in-room-id, read-only enforcement |
| **Tests** | ICR: `icr-test`, `icr-merge-test`, `icr-lang-test`, `icr-fuzz-test`, `icr-converge-test`. Live/edge: `hive-edge-test`, `hive-secure-test`, `hive-scope-test`, `hive-auth-test`, `hive-readonly-test`, `hive-resume-test`, `hive-control-test`, `hive-durable-revoke-test`, `hive-relay-robust-test`, `hive-rollback-test`. Coordination: `hive-coord-test`, `hive-coord-live-test`. |
| **Benchmarks** | `gt-gauntlet.mjs`, `congra-bench.mjs`, `cooper-merge-bench.mjs`, `cooper-validate.mjs` + JSON receipts |
| **Docs** | `README.md`, `ARCHITECTURE.md`, `ICR.md`, `RBAC.md`, `MCP.md`, `EDGE-CASES.md`, `SELF_HOSTING.md`, `DEPLOY.md`, `docs/SUBSTRATE.md`, this file |

### The roadmap (each row justified by a measured failure)

| # | Primitive | Status (2026-07) | Next step |
|---|---|---|---|
| 1 | **ICR** — don't lose work | DONE beyond plan: standalone `icr-merge`, 20+ languages, 5 benchmark bodies of evidence, union mode | npm publish + adoption |
| 2 | **Hive coordination** — don't collide | Sim-proven (756→0); relay ENFORCEMENT built (`HIVE_ENFORCE_CLAIMS`: warn/block/queue, zero-loss replay) | Default-on rollout |
| 3 | **Provenance substrate** — every byte attributable | DONE: signed changes, relay-verified ledger, content authority, silent-fork gate, intent-aware resolution | — |
| 4 | **Verification layer** — don't ship bad work | Prototyped in Run C (contract + validator, prompt-level); judge tier staged (703-unit manifest) | Make it structural: gate "done" behind tests + validator approval |

The throughline of the whole roadmap in one sentence: **make coordination and quality
*structural* (enforced by the relay/session), not *behavioral* (enforced by prompts)** —
prompts get ~80% of the way; enforcement is what makes a layer foundational.

---

## Lecture 16 — TL;DR for another AI

- Hivecode = live, git-free, multi-writer code collaboration for **humans + AI agents**,
  with **oversight and control** (watch, fence, approve, undo) as the product.
- Built on **Yjs CRDTs**: a room is a `Y.Doc`, each file a sub-document, a dumb relay
  forwards updates, every peer converges and writes to its own disk in ~1s.
- CRDTs converge on **bytes, not meaning** (`return 23`) — so two primitives sit on
  top: **ICR** (merge by structure + intent, never emits worse-than-input code,
  symmetric + fixed-point so it can live inside the CRDT) and the **Hive coordination
  layer** (CSMA/CD + stigmergy claims, no controller, sim-proven 756→0).
- A **provenance substrate** signs every change (Ed25519; identity = key fingerprint)
  with parent, content, and *intent* — which makes silent fusions detectable
  (unsigned text, signed siblings) and conflicts machine-resolvable by any agent, with
  the medium re-validating every resolution.
- Security is **self-certifying**: room id embeds the owner's key fingerprint; RS256
  tokens verify against it statelessly; the relay stores nothing.
- Agents join over **MCP** (`hive_join`, `hive_claim`, `hive_wait`, …).
- Evidence: head-to-head vs mergiraf (ties core, wins intent), OSS census,
  ground-truth gauntlet (87 vs 64 of 279 human resolutions), ConGra (6,430 conflicts,
  guarantee holds, 0 crashes), **CooperBench (Stanford): the merge layer alone recovers
  40.8% of the measured multi-agent coordination tax at 96.2% test-verified precision —
  3.7× mergiraf** — plus live swarm runs whose failures defined the roadmap:
  advisory → structural.
