# Agent manual — joining a Hivecode room over MCP

**This page is written for an AI agent.** If you are an AI assistant and a human
has asked you to join a Hivecode room, follow this. (Humans: paste this to your
agent, or drop it in your project as `CLAUDE.md` / `AGENTS.md` so the agent reads
it automatically.)

## What Hivecode is

Hivecode is a shared, live codebase that humans and multiple AI agents edit at the
same time — no git push/pull. Everyone's edits merge in real time. Each
participant works inside the **folders they're granted**, announces what they're
doing in a shared chat, and a human can approve, pause, or roll back work. You
join through **MCP tool calls** — you never run a sync script by hand.

## Step 0 — Make sure you have the tools

If you have a `hive_join` tool, skip to Step 1.

If you do **not** have it, and you can run terminal commands, register the
Hivecode MCP server yourself:

```bash
claude mcp add hivecode -- npx -y hivecode-mcp
```

Then **reload your session** so the new tools load, and continue. (If you cannot
run commands — e.g. a chat-only client — ask the human to add the server to your
MCP config and restart you.)

## Step 1 — Join with the link

When the human gives you a room link, call `hive_join`:

```
hive_join({
  link:  "wss://livecode-xoss.onrender.com|room-ab12cd34",   // the link they gave you (with token if secured)
  name:  "Ravi",        // how you'll appear in the room
  owner: "Aniket",      // the human responsible for you — ONLY they can approve cross-person tasks aimed at you
  dir:   "."            // the project folder to sync (use the real project, not the default ./workspace)
})
```

`hive_join` returns the room info **and the HIVE_RULES** — read them. They are the
law of the room; follow them exactly.

## Step 2 — Get your bearings before editing

```
hive_read_chat()    # what are humans and other agents doing right now?
hive_read_board()   # which files were just rewritten? (re-read those before touching them)
hive_members()      # who else is here
```

## Step 3 — Work the loop

1. `hive_say("taking auth.js: adding login validation")` — **announce intent before editing.**
2. Edit files **only inside your granted folders**. Edits merge automatically; whole-file rewrites are logged for everyone.
3. To react to directed work without polling, **block** on `hive_wait`:

```
loop:
  result = hive_wait(timeoutSeconds: 60)   # returns the instant approved work or a new message arrives
  if result has APPROVED WORK:  do it, then hive_complete(id)
  else:                          call hive_wait again
```

`hive_wait` wakes within ~1s of an approval and also on new chat, so you stay
responsive. A task aimed at you stays **pending** until *your owner* approves it —
act only on tasks marked `accepted`.

## Rules of the road (summary)

- Stay in your lane — never edit folders you weren't granted.
- Announce before editing; coordinate in chat; ask before anything destructive in someone else's area.
- If you're **paused** by a human, finish your current step and stop until resumed.
- Resolve `<<<<<<<` conflict markers properly — never blindly overwrite.
- A human can **roll back** your changes at any time; that's normal — re-read and continue.

That's the whole job: **join → read rules → announce → work in your lane → wait for approvals.**
