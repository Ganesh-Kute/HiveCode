# Newsletter submissions (email) — send these the same day as the X thread

Each is ready to send. Personalize nothing except [Your name]. Attach or link
the demo GIF where possible. Submission routes:

| Outlet | How to submit | Notes |
|---|---|---|
| JavaScript Weekly / Node Weekly | mailto:hello@cooperpress.com (or the "Suggest a link" link in any issue) | The big one for npm tools. Short pitch below. |
| Console.dev | https://console.dev/submit (form/email) | Devtools-discovery newsletter; exactly our audience. |
| Bytes.dev | hello@bytes.dev / site contact | Casual tone; the "git merges lines" one-liner fits. |
| TLDR Web Dev | https://tldr.tech (suggest-a-link) | High volume; worth the 2 minutes. |
| Changelog News | submit@changelog.com / news.changelog.com | Also auto-surfaces trending repos — a GitHub star spike helps here. |

---

## Pitch (JavaScript Weekly / Node Weekly)

Subject: icr-merge — a git merge driver that understands code, not lines

Hi,

I just released icr-merge (MIT): a 3-way merge for git that parses both sides
and merges declaration-by-declaration instead of line-by-line.

What that means in practice:
- rename a function while a teammate adds calls to the old name → merges
  clean, their call sites are rewritten automatically
- teammate deletes a helper you just started using → plain git merges that
  SILENTLY (broken code, no markers); icr-merge raises a real conflict
- output is guaranteed to parse, and anything it can't merge safely falls
  back to git's normal line merge — the floor is exactly today's behavior

Setup is two commands (npx installer + one .gitattributes line). JS gets full
AST treatment; TS/Go/Rust/Java/Python get structural merging. Tested with a
12k-assertion suite, multi-language fuzzing, and end-to-end through real
`git merge` — and the repo merges itself with it.

npm: https://www.npmjs.com/package/icr-merge
15-sec demo: [GIF link]

Built it because AI coding agents merge at machine speed and line merges
silently fuse their edits — but it turned out humans want it just as much.

Thanks for reading!
[Your name] — https://x.com/[handle]

---

## Pitch (Console.dev — shorter, their format)

Name: icr-merge
What: A git merge driver that merges code structurally (AST/declaration level)
instead of by lines. Renames auto-resolve with call sites rewritten;
semantically-broken-but-line-clean merges become real conflicts; output is
parse-guaranteed; falls back to git's default when unsure.
Why it's interesting: merge conflicts are the most-hated part of git and the
merge algorithm hasn't really changed in decades. Also increasingly relevant
as AI agents author code concurrently.
Install: npx --package icr-merge@latest icr-merge-install
Link: https://www.npmjs.com/package/icr-merge

---

## Direct-outreach template (agent-framework authors, devtool YouTubers)

Subject: two agents, one file, silent code corruption — built a fix

Hi [name],

Saw your work on [specific project/video — one sentence why it's relevant].

When two AI agents (or an agent + a human) edit the same file concurrently,
line-based merging silently fuses their edits into code neither of them wrote
— valid syntax, wrong meaning, no conflict raised. I hit this constantly
building multi-agent infra, so I fixed it at the merge layer:

icr-merge — structural 3-way merge (parses both sides, merges by declaration,
auto-applies renames, refuses unparseable output, surfaces semantic conflicts
a line merge can't even represent). Drop-in git merge driver or a pure
library function.

https://www.npmjs.com/package/icr-merge — 15-sec demo: [link]

If it's useful for [their project], happy to help wire it in. And if you can
break it, I genuinely want the failing case.

[Your name]
