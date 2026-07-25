# Daily X playbook — 10-15 minutes, the part only a human can do

## Every day (the reply engine — this is where followers actually come from)

Search these on X, sort by Latest. Reply to 3-5 posts where someone is
describing the pain RIGHT NOW:

- "merge conflict" / "rebase hell" / "git merge broke"
- "cursor overwrote" / "claude broke my code" / "agent deleted my"
- "multi-agent coding" / "parallel agents"

Reply rules (violating these reads as spam and kills the account):
1. Answer their actual problem first. Tool mention second, or not at all.
2. Never paste the same text twice.
3. Skip posts older than ~24h.
4. If it's a big account describing agent-collision pain: that reply is the
   most valuable marketing minute of the week. Take time on it.

Good reply shape:
> "This is a line-merge problem — git can't see that the function moved. I
> built a merge driver that parses both sides instead (auto-handles renames):
> [npm link]. Worst case it falls back to normal git behavior."

## 3x per week (build-in-public posts — Claude drafts, you paste)

Rotate these types; ask Claude for the day's draft:
- WAR STORY: the dual-Yjs silent-corruption hunt, the 1-in-40k fuzz catch,
  "dogfooding found a launch-breaking bug in 60 seconds"
- CATCH OF THE WEEK: a real merge ICR handled (screenshot)
- NUMBERS: downloads/stars milestones, test counts, new language support
- HEALTH-GATED CONVERGENCE teasers (seeds the Hivecode launch): "CRDTs
  guarantee convergence. For AI-written code that's a bug. Thread soon."

## Weekly
- Check npm downloads (npmjs.com/package/icr-merge) + GitHub stars. Reply to
  EVERY issue/mention within 24h — early responsiveness is marketing.
- One follow-up nudge on newsletter pitches that got no reply (once only).

## Success criteria (month 1) — small numbers that compound
- ~500 npm weekly downloads, ~50 GitHub stars
- 2-3 real conversations with strangers (issues, DMs, replies)
- 1 newsletter placement
If any stranger files a real bug report: celebrate — that's product-market
contact, worth more than 1000 impressions.
