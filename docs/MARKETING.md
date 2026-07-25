# Hivecode — launch kit

Everything ready to fire. Copy, paste, post from **your** account. Order matters:
do the demo video first (everything links to it), then launch on a Tuesday–Thursday
morning (US time) starting with Show HN, then Reddit, then the X thread.

Positioning is fixed (see [POSITIONING.md](POSITIONING.md)): lead with the **pain**
and the **governance wedge**, never with "CRDT relay."

---

## 0. Pre-flight (do these first)
- [ ] Extension live on Marketplace + Open VSX ([PUBLISH.md](PUBLISH.md)).
- [ ] Landing page live (relay serves it at `/`).
- [ ] **Demo video recorded** (script in §5) and uploaded (YouTube unlisted + a GIF).
- [ ] GitHub README has the hero + GIF (§6).
- [ ] You're posting from accounts with some history (fresh accounts get auto-filtered).

---

## 1. Show HN

**Title** (HN strips emoji; keep it plain and specific):
```
Show HN: Hivecode – multiplayer for AI coding agents, with real permissions
```

**URL:** your landing page.

**First comment** (post immediately after submitting — this is where HN actually reads):
```
Hi HN, I built Hivecode because running more than one AI agent on a codebase is
chaos. The moment I had Claude and Cursor working the same repo, they overwrote
each other's files, rebuilt the same thing twice, and there was no way to stop one
from editing a file it had no business touching.

Hivecode is a shared live room (Yjs CRDT over a websocket relay) where humans and
agents edit one project together — but the part I care about is governance:

- You invite an agent to specific folders. The relay never sends it bytes for
  anything outside its scope, so it physically can't read or edit the rest.
- Read-only roles, instant revoke, and an approval gate (a human's request to your
  agent waits for your OK; agent-to-agent coordination flows automatically).
- Secured rooms are self-certifying: the room id embeds a fingerprint of your
  public key, tokens carry the key and are signed by it, and the relay trusts a
  token only if the fingerprint matches. So a stateless relay enforces per-folder
  access with no account system and no shared secret. The auth core is
  dependency-free (just Node crypto).

It's agent-neutral — Claude Code, Cursor, Windsurf, or your own bot via MCP.
Free and open source (MIT). Works in VS Code, Cursor, Windsurf, Antigravity.

It's early and I'd love feedback, especially on the trust model and on whether the
scoping is the right primitive. Repo: https://github.com/GSK7024/livecode

Happy to answer anything.
```

**HN survival tips:** reply to every comment in the first 3 hours; be humble and
technical; never argue; if someone finds a flaw, thank them and say how you'll fix
it. Don't ask for upvotes anywhere (instant flag).

---

## 2. Reddit

Target subs (post a few days apart, not same-day): **r/ClaudeAI**, **r/ChatGPTCoding**,
r/cursor, r/LocalLLaMA (if self-host angle), r/SideProject. Read each sub's rules
on self-promo first; some require a flair or limit links.

**Title options:**
```
I got tired of my AI agents overwriting each other, so I built a shared room with folder permissions
```
```
Running multiple coding agents? I made them share one live codebase without clobbering each other
```

**Body:**
```
I run 2–3 AI agents at once (Claude Code + Cursor) and kept hitting the same wall:
they edit the same files, undo each other's work, duplicate features, and every
agent can touch everything — including secrets and config.

So I built Hivecode: humans and agents edit ONE project live (real-time sync, no
git push/pull), but with actual access control.

What it does:
- Invite an agent to just `frontend/` (or any folders) — it never even receives
  the files outside its scope.
- Read-only roles, instant revoke mid-session, and an approval gate so a human
  can't make your agent do something without your OK.
- Built-in chat + a shared task board so the humans and agents coordinate.
- Conflict-safe: overlapping edits keep both versions instead of silently losing
  one.
- Works with Claude Code, Cursor, Windsurf, or your own bot over MCP.

It's free and open source. Here's a 90s demo: [video link]
Repo: https://github.com/GSK7024/livecode

Would genuinely love feedback from people who run multiple agents — is folder
scoping the right control, or do you want something finer?
```

**Reddit tips:** the body should read like a person sharing, not a press release.
Respond fast, drop the "buy now" energy, ask a real question at the end to spark
comments.

---

## 3. X / Twitter thread

**Tweet 1 (hook + video/GIF attached):**
```
I had Claude and Cursor editing the same codebase.

They overwrote each other, rebuilt the same feature twice, and either one could
touch my .env.

So I built multiplayer for AI agents — with real permissions.

Here's Hivecode 🧵
```
**Tweet 2:**
```
The core idea: humans + multiple AI agents edit ONE project live.

No git push/pull. Edits sync in ~1s. Everyone sees who's editing what.

But the part that matters isn't the live editing — it's the governance.
```
**Tweet 3 (the wedge — attach the "blocked" screenshot):**
```
You invite an agent to specific folders.

The relay never sends it the bytes for anything else — so it physically can't read
or edit the rest of your repo.

Out-of-scope file? Blocked. Not "asked nicely not to." Blocked.
```
**Tweet 4:**
```
Plus:
• read-only roles
• revoke access mid-session, instantly
• approval gates (a human can't make your agent act without your OK)
• built-in chat + shared task board
• both versions kept on conflict — never lose work
```
**Tweet 5:**
```
It's agent-neutral: Claude Code, Cursor, Windsurf, or your own bot via MCP.

The auth core is dependency-free (just Node crypto). Secured rooms need no account
and no shared secret — trust is anchored in the room id itself.
```
**Tweet 6 (CTA):**
```
Free and open source. Works in VS Code, Cursor, Windsurf, Antigravity.

Install + repo: https://github.com/GSK7024/livecode

If you run more than one agent, I'd love your feedback. What would you scope?
```

Tag relevant accounts only if natural. Pin the thread. Repost with the demo a day
later if it gets traction.

---

## 4. Product Hunt (for later, once you have ~10 happy users)

- **Tagline:** Governed multiplayer for AI coding agents
- **Description:** Run humans and multiple AI agents on one live codebase — with
  folder-scoped permissions, approval gates, and instant revoke, so an agent can
  never touch what it shouldn't. Agent-neutral, open source.
- First comment: the same maker story as Show HN, trimmed.
- Line up 5–10 people to genuinely try it that morning. Launch 12:01am PT.

---

## 5. Demo video script (60–90s) — RECORD THIS FIRST

Tone: calm, real screen, no music needed. The hero moment is the **blocked agent**.

| Time | On screen | Say (voiceover or captions) |
|---|---|---|
| 0–8s | Your editor, a real repo open | "If you run more than one AI agent, you've seen this: they fight over the same files." |
| 8–18s | Run **Hivecode: Host a Secured Session**; link copied | "Hivecode puts everyone in one live room. I host — no terminal, no server." |
| 18–30s | **Invite to folders…** → pick `src/api`, role = edit | "I invite an agent and pick exactly which folders it can touch. This one only gets src/api." |
| 30–45s | Two agents + you editing different files; cursors/labels move live | "Now we're all editing live. Claude's in the API, Cursor's in tests, I'm here. Everything merges in real time." |
| 45–60s | The scoped agent tries an out-of-scope file → **blocked toast** | "And when an agent reaches for something out of scope — like the production env file — it's blocked. Not asked nicely. Blocked, at the server." |
| 60–75s | Quick pan: chat, task board, revoke a member | "There's chat, a shared task board, and I can revoke anyone instantly." |
| 75–90s | Landing page / install button | "It's free and open source. Link below. If you run multiple agents, try it and tell me what to fix." |

Export a 6–10s **GIF of just the 45–60s blocked moment** — that's your hero image
for X, Reddit, and the README.

### 5b. Voiceover — just read this aloud while recording
Speak naturally, slightly slower than feels normal. Pause at each line break. No
need to memorize — read it.

> If you run more than one AI agent on the same codebase, you've seen the mess —
> they overwrite each other's files and fight over the same code.
>
> Hivecode fixes that. I open my project and start a session — no terminal, no
> server. A join link is copied, ready to share.
>
> Now I invite an agent. And here's the part that matters: I pick exactly which
> folders it can touch. This one only gets the API folder.
>
> We're all editing live now. Claude's working the API, Cursor's in the tests, I'm
> right here. Every change merges in real time — and nobody's work gets lost.
>
> Now watch. The agent reaches for the production environment file — something
> outside its scope. And it's blocked. Not asked nicely to stay away. Blocked, at
> the server. It never even receives the file.
>
> There's built-in chat, a shared task board, and I can revoke anyone's access
> instantly.
>
> It's free and open source, and it works with Claude Code, Cursor, Windsurf, or
> your own agent. Link's below — if you run multiple agents, give it a try and tell
> me what to fix.

Total read time ≈ 70–80 seconds at a calm pace.

---

## 6. GitHub README hero (top of repo README.md)

```
<h1>Hivecode</h1>
<p><b>Multiplayer for your AI coding agents — with real permissions.</b><br>
Run humans and multiple AI agents on one live codebase. Folder-scoped access,
approval gates, instant revoke. No git push/pull. Open source.</p>

[ Install for VS Code ] · [ 90s demo ] · [ Website ]

![demo](docs/demo.gif)
```
Then: Why → Quickstart → Add an agent (MCP) → How the security model works →
Contributing. Keep the security model section — it's your credibility.

---

## 7. First-10-users DM template

Find people who've **posted about running multiple agents / worktrees** (X, Reddit,
HN). Personalize the first line to their actual post. Never mass-paste.

```
Hey [name] — saw your post about running [Claude/Cursor/multiple agents in
worktrees]. I hit the exact pain you described (agents clobbering each other) and
built a thing for it: a live shared room where you scope each agent to specific
folders so they can't touch the rest.

Not selling anything — it's free/OSS and I'm looking for ~10 people who actually
run multiple agents to try it and tell me where it breaks. 90s demo: [link].
Worth a look?
```

Goal: not installs, **conversations**. Watch them onboard. Every confusion = a fix.

---

## 8. The one-line answers (keep handy for replies)
- *What is it?* "Multiplayer for AI coding agents, with real folder permissions."
- *How is it different from Zed/Cursor multiplayer?* "They let agents edit together;
  we let you control what each agent can reach — scoping, approval, revoke."
- *Is it safe?* "The relay enforces scope; an out-of-scope agent never receives the
  bytes. Auth core is dependency-free."
- *Does it work with X?* "Any agent that speaks MCP — Claude Code, Cursor, Windsurf,
  your own bot."
```

## What's mine vs yours (recap)
- ✅ I wrote all of the above and will revise any of it on request.
- 🫵 You: record the video, post from your accounts, DM real people, reply to them.
- I will **not** post on your behalf or take any account credentials.
