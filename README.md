# Task-List — a live Hivecode collaboration

A tiny task-list web app, built **live** by multiple agents in one Hivecode room:
a backend agent and a frontend agent editing the same project at the same time,
over the internet, with no git push/pull. This file is the **onboarding doc** —
if you are an AI (or human) who just joined this room, read it first.

---

## 1. What we're building
A task list: add tasks, mark them done, delete them. Plain Node.js backend (no
deps) + a static HTML/CSS/JS frontend. Small on purpose, so two agents can build
the two halves in parallel and we can see Hivecode coordinate them.

## 2. Who owns what (LANES — stay in yours)
| Area | Files | Owner |
|------|-------|-------|
| Backend / API | `server.js` | **ClaudeBackend** (AI) |
| Frontend / UI | `public/index.html`, `public/app.js`, `public/style.css` | **frontend agent** |
| Shared contract | `README.md` (this file) | edit by agreement, announce first |

Read any file you like; **only edit files in your lane.** If you must touch
another lane, say so in chat and wait.

## 3. The API contract (frontend builds against THIS)
Backend serves the frontend from `public/` and exposes a JSON API under `/api`.
All bodies and responses are JSON. A task is `{ id: string, title: string, done: boolean, createdAt: number }`.

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET`  | `/api/tasks` | — | `{ tasks: Task[] }` |
| `POST` | `/api/tasks` | `{ title: string }` | `201 { task: Task }` · `400 { error }` if title empty |
| `POST` | `/api/tasks/:id/toggle` | — | `{ task: Task }` · `404 { error }` |
| `DELETE` | `/api/tasks/:id` | — | `{ ok: true }` · `404 { error }` |

Run it: `node server.js` → http://localhost:4000 . Data is in-memory (resets on
restart) — that's fine for the demo.

## 4. How to work here (Hivecode rules, short version)
1. **Read `HIVE_MEMBERS.md`** — who is here and what each is editing right now.
2. **Read `HIVE_CHAT.md`** — what everyone is doing. **Announce** before you start.
3. **Prefer small patches** — edit the spot, not the whole file. Disjoint edits
   from different agents auto-merge. Whole-file rewrites are risky; if you must,
   RE-READ the file first.
4. If you see `<<<<<<<` markers, the system kept BOTH versions — **resolve** them.
5. If two of you touch the same file, you'll get a chat heads-up — coordinate.
6. The sync layer guarantees **nobody's work is silently lost** (a stale rewrite
   that drops another's lines is re-added or flagged as a conflict, never deleted).

## 5. Status
- [x] Backend API (`server.js`) — by ClaudeBackend
- [ ] Frontend UI (`public/`) — by the frontend agent
- [ ] Wire-up verified end-to-end (add/toggle/delete in the browser)
