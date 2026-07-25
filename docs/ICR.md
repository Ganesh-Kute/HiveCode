# ICR — Intent-aware Code Replication

> CRDTs merge **characters**. ICR merges **meaning**.

ICR is a 3-way code merge built for the AI era — when several agents (and people) edit
the same file at once. It parses the code, merges at the level of *declarations* and
*intent*, and makes one hard promise: **it never emits code more broken than its inputs.**

This is the foundational primitive growing out of [Hivecode](./README.md). Hivecode
proves the need (governed multiplayer for agents); ICR is the merge layer that need
demands.

---

## Why not just CRDTs (Yjs) or git?

A CRDT guarantees the same final *text* on every peer. It has no idea what the text
*means*, so it will happily interleave two edits into syntactically valid garbage, or
leave a call to a function another agent just deleted. Git's line merge has the same
blind spot — it reasons about lines, not code.

That's fine when humans type slowly and review every change. It is not fine when several
agents rewrite whole files in seconds. ICR closes the gap by understanding structure,
references, and scope.

---

## What ICR does

```js
import { structuralMerge } from './icr.js'

const r = structuralMerge(base, mine, theirs, { filename: 'src/auth.js' })
// r.status   : 'auto' | 'semantic-conflict' | 'fallback'
// r.text     : merged source (when 'auto')
// r.conflicts: e.g. ['fn:login'] or ['ref:helper']  (when 'semantic-conflict')
// r.renames  : e.g. ['login->signIn']               (renames it auto-applied)
// r.provenance: [{ unit, author }]                  (who authored each kept unit)
```

### The guarantee
Every `auto` result is **valid, parseable code**. If a structural merge would produce
something that doesn't parse, ICR refuses it and returns `fallback` (keep both / let a
line merge handle it). Verified by a fuzz test over 4,000 random merges per run — the
guarantee has held across every case.

### Structure-aware merge
Two agents editing **different** declarations merge cleanly. Two agents editing the
**same** declaration are flagged as a real `semantic-conflict` (named, e.g. `fn:login`)
instead of being silently fused.

### Finer granularity
If two agents edited the same function/method/object but touched **different lines
inside it**, ICR descends in and merges the inside — functions, class methods (and their
bodies), object literals, and `const` arrow/function expressions. Only a genuine
same-line clash becomes a conflict.

### Intent layer
- **Rename detection** — if one agent renames `login → signIn` (the declaration is gone,
  an identical-bodied one appears) while another adds fresh calls to the old name, ICR
  recognizes the rename and **rewrites the stale call sites** so both agents' work
  survives. Nothing else does this.
- **Dangling reference** — a declaration removed/renamed but still referenced is flagged
  as a `semantic-conflict` even though the code *parses*. CRDTs, git, and a naive
  structural merge all miss it.
- **Scope awareness** — references are resolved through real JS scopes (functions,
  blocks, catch, loops, params, imports, hoisting). So a local variable that merely
  shares a deleted name is **not** mistaken for a reference to it, and renames never
  rewrite an unrelated local.

### Import-aware merge
Two agents adding imports from **different** modules never collide; adding different
specifiers from the **same** module unions them into one statement
(`import { a } … ` + `import { b } …` → `import { a, b } …`).

### Provenance
Every surviving unit is attributed to the author whose version was kept — the third
pillar of ICR (structure + intent + **provenance**).

---

## Language-agnostic by design

`icr.js` is the engine; it knows nothing about any specific language. Everything
language-specific lives behind a **provider** (see `lang-js.js`, the JavaScript provider
built on the tiny `acorn` parser). Adding a language = writing a provider and registering
it — the merge logic never changes:

```js
import { registerLanguage } from './icr.js'
registerLanguage(myPythonProvider) // { id, exts, parses, units, declaredNames, … }
```

This is proven by `icr-lang-test.js`, which registers a brand-new toy language at runtime
and merges it through the same engine. Real Python/Go/Rust/TypeScript support is a matter
of writing tree-sitter-backed providers behind this interface.

---

## Convergence (why it's safe in a live multi-peer sync)

Hivecode syncs many peers, so the merge must be **convergent**: every peer must reach the
same bytes and stay there. ICR's merge is:

- **Symmetric** — `merge(base, a, b)` equals `merge(base, b, a)`, so two peers that see the
  same edits compute the same result.
- **Fixed-point** — once peers agree on a text `T`, re-merging returns `T` unchanged.
- **Format-preserving** — the merged file is rebuilt by splicing changed units back into
  the base at their original byte ranges; unchanged code and the whitespace between units
  survive verbatim, so ICR doesn't reformat code it merges (reformatting would otherwise
  cause endless re-merges across peers).

All three are checked by `icr-converge-test.js` (fixed-point, symmetry, absorption, and a
1,000+ case random two-peer simulation); `icr-fuzz-test.js` also asserts symmetry on every
random case. An earlier version lacking these *did* diverge in the live relay (duplicated /
dropped lines) — these properties are what fixed it.

## How it plugs into Hivecode

`icr-merge.js` bridges ICR into Hivecode's `reconcile()`. For files ICR understands, a
clean ICR merge supplies the merged bytes (**auto-merge** — finer granularity and automatic
rename fix-ups); merge3 covers conflicts, fallbacks, and other languages. ICR can never
throw a sync (any error → merge3). When ICR detects a meaning-level problem a line merge
can't (a dangling reference, a same-declaration clash), it keeps the safe text and
**surfaces a warning** in the activity feed so the issue isn't shipped silently. Verified
end-to-end by the live `merge-clobber-test.js` over the real relay.

---

## Status (honest)

A working proof-of-concept, JavaScript only (via `acorn`). The library is convergent and
its auto-merge runs in the live product. Reference analysis is scope-aware but approximate
at the edges (pattern default-value expressions, `with`/eval not modeled); inner merges of
both-edited functions/objects normalize separators (e.g. no trailing comma on an appended
property). Open work: real tree-sitter providers for more languages, deeper scope modeling,
and threading provenance through the live relay.

---

## Files & tests

| File | What |
|---|---|
| `icr.js` | the language-agnostic merge engine + language registry |
| `lang-js.js` | the JavaScript provider (parse, units, scope, rename, split, imports) |
| `icr-merge.js` | the Hivecode bridge (`icrMerge3`: auto-merge for supported files, merge3 otherwise) |
| `icr-test.js` | core behavior (structure, finer-grain, rename, dangling, scope, classes, imports, provenance) |
| `icr-merge-test.js` | the bridge: auto-merge, warnings, fallback safety |
| `icr-lang-test.js` | proves the engine is genuinely language-pluggable |
| `icr-fuzz-test.js` | property test: the guarantee + symmetry hold across thousands of random merges |
| `icr-converge-test.js` | convergence: fixed-point, symmetry, absorption, multi-peer simulation |

```
node icr-test.js && node icr-merge-test.js && node icr-lang-test.js && node icr-fuzz-test.js && node icr-converge-test.js
```
