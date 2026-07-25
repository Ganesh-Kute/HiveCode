# icr-merge launch thread v2 — expert cut

RULES BAKED IN (why this version is different):
- Tweet 1 has NO link (links throttle reach; link goes in the LAST tweet + a reply).
- The demo VIDEO is the hook, attached to tweet 1. Media 2-4x's impressions.
- One idea per tweet. Short lines. White space. No hashtags (they read 2014).
- The enemy is named: git's merge algorithm is older than most devs using it.
- Every claim is a number, a screenshot, or a dare — never an adjective.
- CTA is singular: try it. Not "star, follow, share".

---

## HOOK OPTIONS — pick one for tweet 1 (video attached). A is recommended.

**A (the enemy frame):**

git's merge algorithm doesn't read code.
It reads lines. It's been merging your functions
like grocery lists since diff3 shipped in 1979.

I taught git to actually parse what it merges.

Watch it handle a rename that would wall you
with conflicts: 👇

**B (the fear frame):**

Your scariest merge isn't the one with conflict markers.

It's the one that merges "clean" — and ships broken.

git can't detect it. By design. I fixed that: 👇

**C (the confession frame):**

I watched two AI agents edit the same line.

git's merge fused their code into `return 32` —
from a `return 2` and a `return 3`.

Valid syntax. Written by NOBODY. Shipped silently.

So I rebuilt the merge layer: 👇

---

## THE THREAD (tweets 2-7, same for any hook)

**2 — the demo narrated (screenshot of the merged file)**

What you just saw:

→ branch A renamed helper() to fetchUser()
→ branch B added new calls to helper()
→ plain git: conflict wall (or worse — "clean" + broken)

→ icr-merge: understood the rename,
   merged B's code, and REWROTE B's calls
   to the new name. Scope-aware.

One command: git merge. That's it.

**3 — the silent killer (this is the shareable tweet — make it standalone)**

The merge that should scare you:

Teammate deletes an "unused" helper.
You, on your branch, just started using it.

git merges this with ZERO conflicts.
Broken code. No markers. No warning.
You find out in prod.

icr-merge parses both sides → catches the
dangling reference → raises a REAL conflict
that tells you what's semantically wrong.

**4 — how it works (credibility for the technical reader)**

Under the hood:

• 3-way merge on DECLARATIONS, not lines
• real AST for JS — structural for TS, Go,
  Rust, Java, Python
• formatting preserved (splices into your
  bytes, never reformats)
• iron rule: output that doesn't parse
  is REFUSED
• can't merge safely? → falls back to
  plain git line-merge

The floor is exactly git. Only the ceiling moved.

**5 — receipts (dare the skeptics)**

I spent the week trying to kill it before you could:

• 12,671-assertion torture suite
• randomized 3-way fuzzing, 5 languages
  (found a 1-in-40,000 asymmetry bug. fixed.)
• e2e through REAL `git merge`, real branches
• this repo merges ITSELF with it —
  dogfooding caught 2 launch-breaking bugs

If you can produce a broken merge, I want it.
That's not marketing. File the issue.

**6 — the bigger why (seeds launch #2)**

Why I actually built this:

AI agents don't merge like humans.
They merge constantly, at machine speed,
unattended.

Line-based merging silently fuses their
edits into code no one wrote.

Humans hit this weekly. Agents hit it hourly.
The fix belongs in the merge layer —
not in a prompt.

(There's a deeper layer to this story.
Soon.)

**7 — CTA (the ONLY tweet with links)**

Try it in 30 seconds:

npx --package icr-merge@latest icr-merge-install
echo "*.js merge=icr" >> .gitattributes

Then just... git merge. Like always.

npm: npmjs.com/package/icr-merge
MIT. Zero config beyond the above.

What's the worst merge git ever did to you?
(genuinely collecting these)

---

## MECHANICS (do these, they matter as much as the copy)

1. Reply to your own tweet 1 immediately with the npm link
   ("link here 👇" pattern — keeps tweet 1 unthrottled, link still one tap away).
2. Pin the thread the moment it's posted.
3. The QUESTION at the end of tweet 7 is the engagement engine — reply to
   EVERY answer within the hour. Each reply re-lifts the thread.
4. Tweet 3 is designed to be quote-tweeted alone. If the thread stalls,
   repost tweet 3 as a standalone 2 days later with the second demo clip
   (the silent-broken-merge one from demo-script.md).
5. DM the thread to 3-5 friendly devs BEFORE posting; ask them to reply
   (not just like) in the first 30 min. Early replies decide algorithmic fate.
6. Profile before posting: pinned = this thread, bio = one line + npm link,
   header image = the comparison table from the README.
