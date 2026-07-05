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
| Full intent (AST) | JavaScript (.js .mjs .cjs .jsx) | structural merge, scope-aware rename rewriting, dangling-reference detection |
| Structural | TypeScript, Go, Rust, Java, C, C++, C#, Swift, Kotlin | declaration-level merge, rename detection, parse guarantee |
| Structural | Python | declaration-level merge (indentation-aware) |
| Line fallback | everything else | git-quality diff3 — never worse than the default |

Add your own with `registerLanguage(provider)` — the engine is language-agnostic; everything language-specific lives behind a small provider interface.

## Guarantees (what the test suite actually asserts)

- **Parse guarantee** — a structural merge that wouldn't parse is refused, never emitted.
- **No silent loss** — every conflict path preserves both versions.
- **Convergent** — the merge is symmetric and a fixed point: peers that re-merge an agreed text get it back byte-identical (this is what lets ICR run inside a live multi-peer CRDT sync).
- **Never throws into your code** — any internal failure degrades to the line tier.

Tested by: unit suites per language, directed adversarial cases (fake defs inside Python docstrings, decorators, Go raw strings and braces-in-comments, Rust CRLF, Java deep nesting, unicode names), a seeded random 3-way fuzzer across 5 languages, and a convergence suite. ICR also runs live inside [Hivecode](https://github.com/GSK7024), a governed real-time medium where multiple AI agents edit one project — which is where its assumptions got beaten on by real concurrent agents.

## Scope, honestly

- Structural understanding is declaration-level (top-level functions/classes/consts), not statement-level. Edits inside one declaration by both sides = a semantic conflict, surfaced as such.
- TypeScript/Go/Rust/etc. use structural (brace-aware) parsing, not full ASTs yet — the provider interface is where tree-sitter parsers slot in.
- `merge()` is synchronous and pure: no I/O, no network, no state.

## License

MIT © [Ganesh Shivlal Kute](https://github.com/GSK7024)
