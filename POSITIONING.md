# Hivecode — positioning & go-to-market

The one source of truth for *what we say and to whom*. Backed by the market
research (demand strong; relay is commoditized; the **governance layer is the
uncovered wedge**).

---

## The one-liner
> **Hivecode is governed multiplayer for AI coding** — run humans and multiple AI
> agents on one live codebase, with folder-scoped permissions and approval gates so
> an agent can never touch what it shouldn't.

Short form (for bios / Show HN title):
> **Multiplayer for your AI coding agents — with real permissions.**

## The wedge (why we win, in one sentence)
Everyone else gives agents a shared editor or a git/PR flow. **Nobody packages the
governance** — folder scoping + approval gates + read-only + instant revoke,
enforced server-side. That's what makes a *team* (not just one tinkerer) able to
trust agents on a shared repo.

Do **not** lead with "real-time CRDT relay" — Zed, GitHub, and Liveblocks already
have that. Lead with **control**.

## Ideal first user (who to DM first)
A developer who **already runs 2-4 AI agents in parallel** and feels the pain
*today*: they juggle git worktrees, hit merge conflicts between agents, and have no
way to stop an agent from editing the wrong files. They're on X / Reddit
(r/ClaudeAI, r/ChatGPTCoding) / HN posting about "running multiple Claude Code /
Cursor agents." Start there — not with people who haven't adopted agents yet.

Expansion path: solo power-user → small team → agency/studio (where "scope the
outside agent to one folder, revocable" is a real budget line).

## The three messages (by audience)
| Audience | Their pain | Our line |
|---|---|---|
| Solo power-user | "My agents clobber each other." | "Put 3 agents on one repo without the merge roulette." |
| Small team | "Can't let agents loose on shared code." | "Scope each agent to its folder. Approve what touches yours." |
| Agency / studio | "Bringing in outside agents is risky." | "Time-boxed, folder-scoped, revocable, audited access." |

## Proof points (what we can actually show)
- A scoped agent **visibly blocked** from an out-of-scope file (the screenshot
  competitors can't produce).
- Three agents + a human editing live, auto-merging, nothing lost.
- Revoke a member mid-session; they're cut instantly.
- 95 unit + 9 live security/edge tests green; dependency-free auth core.

## Objection handling
- *"Won't GitHub/Cursor just add this?"* — They bet the other way (GitHub = async
  git/PR; Zed = live but permissionless). The governed-live niche is open, and
  staying **agent-neutral** (works with all of them via MCP) is our hedge.
- *"Why not just use git worktrees?"* — Worktrees isolate; they don't let agents
  collaborate live or stop one from touching the wrong files.
- *"Is it safe to let agents edit shared code?"* — That's the whole point: the
  relay enforces what each agent can reach; it never even sends out-of-scope bytes.

## Launch checklist (first 2 weeks)
1. [ ] Marketplace + Open VSX live (see [PUBLISH.md](PUBLISH.md)).
2. [ ] Landing page live at the relay root (served by `server.js`).
3. [ ] 60-90s demo video: the **out-of-scope-blocked** moment is the hero shot.
4. [ ] Show HN: "Hivecode – governed multiplayer for AI coding agents".
5. [ ] Posts in r/ClaudeAI, r/ChatGPTCoding; X thread leading with the pain.
6. [ ] DM 10 people who've posted about running parallel agents. Watch them onboard.
7. [ ] A pinned "first 5 minutes" gif in the GitHub README.

## What NOT to do yet
- No billing/pricing infra. Get 10 users who love it free first.
- No new features. We have enough to prove the wedge.
- Don't compete on the relay. Compete on governance + agent-neutrality.

## Pricing (for later — not now)
Anchor: AI-coding seats sit at ~$40/seat. We're a *layer on top*, so price under.
Plan when there's demand: Free (1 human + 1 agent) → $49/mo small-team flat →
~$20-25/human + ~$10/AI-agent seat → usage-metered enterprise. First revenue
milestone = ~100 paid seats ≈ ramen-profitable.
