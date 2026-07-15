# icr-merge

**ICR — Intent-aware Code Replication.** A 3-way merge that understands code structure and author intent, not just lines. Built for the age of AI-authored code; useful to anyone who has ever lost an hour to a dumb merge conflict.

```
        line merge (diff3/git)          icr-merge
        ─────────────────────           ─────────────────────
        merges TEXT                     merges DECLARATIONS
        conflicts on adjacency          conflicts on MEANING
        happily outputs broken code     output GUARANTEED to parse
        rename = a wall of conflicts    rename auto-applied to call sites
        deleted-but-still-used = ships  deleted-but-still-used = flagged
```

## Why

Two authors (humans, AI agents, or one of each) edit the same file concurrently. `git merge` sees lines:

- Move a function while someone edits it → **false conflict**.
- Rename `helper()` to `fetchData()` while someone adds a call to `helper()` → **merges "cleanly"**, code is broken.
- Two agents change the same function two different ways → sometimes merges "cleanly" into code **neither author wrote**.

ICR sees code. It parses both sides, merges declaration-by-declaration with formatting preserved, detects renames and rewrites stale call sites (scope-aware), refuses to output anything that doesn't parse, and reports *semantic* conflicts — the same function changed both sides, a deleted declaration still referenced — that a line merge can't even represent.

When ICR can't act safely (unparseable input, unsupported language), it falls back to a git-style line merge. **The floor is never worse than git. No edit is ever lost.**

## Install

```bash
npm install icr-merge
```

## Use as a library

```js
import { merge } from 'icr-merge'

const r = merge(base, ours, theirs, { filename: 'src/auth.js' })

r.text      // merged content — always present
r.clean     // true = no conflict markers
r.method    // 'structural' | 'rename' | 'lines'
r.renames   // e.g. ['helper->fetchData'] — call sites were rewritten
r.warning   // e.g. "both sides changed function login" — a meaning-level
            //   conflict a line merge would have shipped silently
```

One call, three outcomes:

1. **`method: 'structural' | 'rename'`** — clean intent-aware merge, output parse-guaranteed.
2. **`clean: false`** — a real conflict, both versions preserved in git-style markers, `warning` says what it *means*.
3. **`method: 'lines'`, `clean: true`** — ICR declined (e.g. non-code file), line merge was clean anyway.

Lower-level API if you want the pieces: `structuralMerge`, `merge3`, `supports`, `languageFor`, `registerLanguage`, `parses`, `hasConflictMarkers`.

## Use from the command line (no git required)

```bash
npx icr-merge base.js ours.js theirs.js            # merged text -> stdout
npx icr-merge base.js ours.js theirs.js -o out.js  # -> file
npx icr-merge base.js ours.js theirs.js --json     # machine-readable envelope (for agents/CI)
```

Exit `0` = clean merge, `1` = conflict (output still produced: markers, or a semantic
warning on stderr), `2` = usage error. `--filename name.py` picks the language when
your temp files aren't named like the real one.

## Intent-aware autonomous resolution (for agents)

Every other merge tool merges **dead text** — two finished files, no author present, no idea *why* either change was made. When two changes truly conflict, all any of them can do is dump markers and wait for a human.

But when the authors are **AI agents**, they're alive and they know *why* they made a change. `resolveMerge` uses that: on a real conflict it hands the conflicting declaration — base, both versions, and each side's **intent** — to a `judge` you provide (an LLM call, or the authoring agents themselves), and reconciles automatically. The critical part: **the judge's answer is fed back through the full engine** — re-parsed, dangling-checked, everything — so a hallucinated or broken reconciliation is *rejected*, not shipped. The AI proposes; ICR verifies.

```js
import { resolveMerge } from 'icr-merge'

const r = await resolveMerge(base, ours, theirs, {
  filename: 'auth.js',
  intents: { ours: 'raise the limit for production', theirs: 'raise it for a load test' },
  judge: async (unit) => callYourLLM(unit),   // unit: { key, base, ours, theirs, oursIntent, theirsIntent }
})

r.resolved   // true = the conflict was reconciled AND re-validated as parseable, dangling-free code
r.method     // 'resolved' when it was
r.text       // the reconciled file — or, if the judge failed validation, a safe conflict (never broken)
```

If no `judge` is supplied, or the judge declines or returns code that doesn't survive re-validation, `resolveMerge` degrades to exactly what `merge()` returns — a safe conflict. **Broken code can never ship, even when an AI does the resolving.** This is the piece built specifically for multi-agent code, and nothing else on the market does it.

## Use as a git merge driver

```bash
npx --package icr-merge@latest icr-merge-install     # this repo   (--global for all repos)
```

then route file types to it in `.gitattributes`:

```
*.js  merge=icr
*.ts  merge=icr
*.py  merge=icr
```

From then on `git merge`, `git rebase`, and `git cherry-pick` use intent-aware merging for those files. Renames stop being conflict walls, and broken-but-"clean" merges become **real git conflicts**: when a merge would line-merge cleanly but is semantically broken (a deleted function still referenced), the driver surfaces a visible conflict block and exits non-zero instead of letting git commit it — the exact failure plain git ships silently.

## Languages

| Tier | Languages | What you get |
|---|---|---|
| Full intent (AST) | JavaScript (.js .mjs .cjs) | structural merge, **scope-aware** rename rewriting, dangling-reference detection, token-level merge |
| Structural + intent | TypeScript, JSX, Go, Rust, Java, C, C++, C#, Swift, Kotlin, Scala, PHP, Dart | declaration/statement/token merge, rename detection with call-site rewriting, dangling-reference blocking |
| Structural + intent | Python (**indentation-validated**), Ruby (def/class…end) | same as above; Python's parse gate understands indentation, so a merge that would land a statement in the wrong block is refused |
| Data (perfect) | JSON | merged as parsed **data**: value-wise 3-way keyed by path, delete-vs-change conflicts, disjoint array-region merge, style-preserving output — real parser, so the guarantee has no heuristic in it |
| Data (structural) | YAML, TOML | keyed section/key merge with nested descent (two people editing different CI jobs / different Cargo dependencies merge cleanly; the same key twice is a named conflict) |
| Line fallback | everything else | git-quality diff3 — never worse than the default |

Add your own with `registerLanguage(provider)` — the engine is language-agnostic; everything language-specific lives behind a small provider interface.

## Guarantees (what the test suite actually asserts)

- **Parse guarantee** — a structural merge that wouldn't parse is refused, never emitted.
- **No silent loss** — every conflict path preserves both versions.
- **Convergent** — the merge is symmetric and a fixed point: peers that re-merge an agreed text get it back byte-identical (this is what lets ICR run inside a live multi-peer CRDT sync).
- **Never throws into your code** — any internal failure degrades to the line tier.

Tested by: unit suites per language, directed adversarial cases (fake defs inside Python docstrings, decorators, Go raw strings and braces-in-comments, Rust CRLF, Java deep nesting, unicode names), seeded random 3-way fuzzers (including a metamorphic multilang fuzzer holding fixed-point, symmetry, parse-guarantee, no-loss, and honest-conflict invariants across Python/Java/Go/Ruby/YAML/TOML/JSON), and a convergence suite. Plus a real-world **gauntlet**: hundreds of parseable files from `node_modules` used as merge fodder with code edits located via the AST, run differentially against real `git merge-file` — **0 code-loss, 0 broken auto-merges, 0 convergence failures across 500+ cases, and ICR strictly beat git (auto-merged what git conflicted on) on files where edits were adjacent**. ICR also runs live inside [Hivecode](https://github.com/GSK7024), a governed real-time medium where multiple AI agents edit one project — which is where its assumptions got beaten on by real concurrent agents.

## Scope, honestly

- Structural understanding runs declaration → statement → **token**: two edits to the same function merge as long as they touch different statements, or different tokens within one statement (each side edits a different argument of the same call, a different element of the same array). Only genuinely overlapping edits — the same tokens changed two different ways — are surfaced as a conflict. (JS/`acorn` today; the other languages merge at declaration/statement granularity until their tree-sitter providers land.)
- TypeScript/Go/Rust/etc. use structural (brace-aware) parsing, not full ASTs yet — the provider interface is where tree-sitter parsers slot in.
- **Comment merges.** When two sides edit the *same* declaration and one side's change lives *entirely inside a comment* between statements, the comment edit **survives** (the comment-editing side's body becomes the splice basis and the other side's code edits land on top). If **both** sides edit only comments in the same declaration, that's a surfaced conflict — never a silent drop. Remaining honest edge: a side that edits a comment *and* code in the same declaration keeps its code edit but may lose the comment edit when the other side also changed code there.
- `merge()` is synchronous and pure: no I/O, no network, no state.

## License

MIT © [Ganesh Shivlal Kute](https://github.com/GSK7024)
