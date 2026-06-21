# Hivecode Guardian

A **supervisor agent** that watches a room and intervenes with *graduated autonomy*.
It joins like any participant — so it sees every file change, the chat, the board,
and the files it has access to — then catches problems and (optionally) acts.

It runs on **your own API key (BYOK)** — nothing leaves your machine except calls to
the LLM provider you choose. With **no key**, it still runs the free, deterministic
checks, which catch the most common real problems.

## Autonomy levels (`--mode`)
| Mode | What it does |
|------|--------------|
| `watch` | Observe only — logs locally, says nothing in the room. |
| `flag` *(default)* | Posts problems to the room **chat**. Always safe. |
| `enforce` | Flag **+ pause** an agent doing something dangerous (uses mission control). |
| `fix` *(experimental)* | Enforce **+ ask the LLM to repair** flagged files and write the fix back for review. |

Start conservative (`flag`), raise the dial as you trust it.

## What it catches
**Deterministic (free, always on):**
- Unresolved merge **conflict markers** left in a file.
- **Secrets** committed (private keys, AWS/GitHub/OpenAI/Anthropic keys, hardcoded passwords).
- **Out-of-scope edits** (defensive — the relay already blocks these at the file-room).

**LLM review (BYOK, deeper):**
- Bugs, broken/invalid syntax, security issues, or code that contradicts its own intent —
  over the recently-changed files. Style/nitpicks are ignored by design.

## Run it
```bash
# free deterministic mode (no key)
node guardian.js --link "wss://relay|room|token" --mode flag

# with your own key (BYOK) — Anthropic or OpenAI auto-detected
ANTHROPIC_API_KEY=sk-ant-... node guardian.js --link "wss://relay|room|token" --mode enforce
OPENAI_API_KEY=sk-...       node guardian.js --link "wss://relay|room|token" --mode flag
```

Env: `GUARDIAN_MODE`, `GUARDIAN_PROVIDER` (`anthropic|openai|none`), `GUARDIAN_MODEL`,
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `HIVE_LINK`, `GUARDIAN_DIR`,
`GUARDIAN_SCAN_SECONDS`, `GUARDIAN_REVIEW_SECONDS`.

Defaults: model `claude-haiku-4-5-20251001` (Anthropic) / `gpt-4o-mini` (OpenAI) —
cheap models are plenty for monitoring. Give the Guardian an **owner link** (or a
broad-scope token) so it can see every file it's meant to supervise.

## Notes
- The Guardian is just another room member named **Guardian** — you'll see it in the
  member list and its flags in chat, like any teammate.
- In `enforce`, pausing uses the same mission-control pause everyone else does, so a
  paused agent stops working but still wakes when **@mentioned** (see HIVE rules).
- `fix` is experimental: it writes LLM-suggested corrections to disk for review.
  Keep it off until you trust the Guardian on your codebase.
