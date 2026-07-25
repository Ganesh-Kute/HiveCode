# Hivecode access control (RBAC)

Goal: let a team **securely invite specific AI agents into specific repositories
without exposing the entire codebase** — and revoke that access at any time.

This document describes **Phase 1 (shipped): token-gated rooms.** The roadmap to
true per-path scoping is at the bottom.

---

## The model
- **Principals** — humans and AI agents. Agents have an `owner` (the human who may
  approve tasks directed at them; see HIVE_RULES).
- **Roles** (per scope): `admin`, `maintainer`, `writer`, `reader`, `agent`.
  *(Phase 1 records the role; read-only/write **enforcement** lands in a later phase.)*
- **Scope** — which rooms (and, later, which path globs) a principal may reach.
- **Grant** = `principal × scope × role × expiry`, expressed as a signed **token**.

A token is a compact JWT (JWS). Claims:
```jsonc
{
  "iss": "hivecode", "sub": "frontend-bot", "name": "FrontendBot", "kind": "ai",
  "owner": "jeevan",
  "scopes": [{ "room": "acme/web", "role": "agent", "paths": ["src/ui/**", "!**/*.env"] }],
  "iat": 1710000000, "exp": 1710600000, "jti": "jti-…"   // jti enables revocation
}
```
`paths` are **enforced**: the relay rejects a connection to any file outside the
scope's globs (see Status below). Omit `paths` to grant the whole room.

## Running a secured relay
Auth is **opt-in**. By default the relay is `open` (anyone with the room id joins —
unchanged). To require tokens:

```bash
# self-host: HS256 shared secret
HIVE_AUTH_MODE=required HIVE_JWT_SECRET="$(openssl rand -hex 32)" node server.js

# hosted issuer: RS256 — relay verifies with the public key only
HIVE_AUTH_MODE=required HIVE_JWT_PUBKEY_FILE=./issuer.pub.pem node server.js
```
Relay env:
| Var | Meaning |
|-----|---------|
| `HIVE_AUTH_MODE` | `open` (default) or `required` |
| `HIVE_JWT_SECRET` | HS256 shared secret (self-host) |
| `HIVE_JWT_PUBKEY` / `HIVE_JWT_PUBKEY_FILE` | RS256 public key (hosted issuer) |
| `HIVE_REVOKED_FILE` | path to a JSON array of revoked `jti`s (re-read per connect) |
| `HIVE_REVOKED_JTIS` | comma-separated revoked `jti`s |
| `HIVE_AUDIT_FILE` | append-only JSONL audit log (else stdout) |

**Fail-closed:** `required` mode with no key configured rejects everything.
Unauthorized connections are denied **at the WebSocket upgrade** — no socket is
established, so a rejected client never receives a single CRDT byte for the room.

## Minting a token (self-host)
```bash
HIVE_JWT_SECRET="…" node hive-token.js \
  --name FrontendBot --kind ai --owner jeevan \
  --room acme/web --role agent --paths "src/ui/**,!**/*.env" --ttl 7d
```
Prints the token to stdout (a summary to stderr). Flags: `--name --kind --owner
--room (comma/repeat) --role --paths --ttl (3600|90m|24h|7d) --sub --jti --secret
--key <private.pem for RS256> --iss`.

## Using a token (clients)
- **VS Code extension:** set `hivecode.token` in settings.
- **MCP agent:** pass `token` to `hive_join`, or set `$HIVE_TOKEN` in the server env.
- **CLI** (`folder.js`, `hive-agent.js`): set `$HIVE_TOKEN`.

Open rooms need no token; existing setups keep working.

## Revocation & audit
- Revoke a grant before expiry by adding its `jti` to `HIVE_REVOKED_FILE` /
  `HIVE_REVOKED_JTIS`. The relay re-reads the file on each connect.
- Every admit/reject is audited (`{ts, event, room, identity, role|reason}`).

## Status by phase
- **Phase 1 — auth'd relay ✅** authenticate every connection; admit only valid,
  unexpired, unrevoked tokens whose scope authorizes the room; reject at the
  upgrade; audit; revoke; expire; identity from the token. Open mode default.
- **Phase 2 — subdocuments ✅** a project is a *manifest* (path registry) in the
  parent room plus one Yjs doc **per file**, synced at its own room `<room>␁<path>`,
  behind the same `startSync` API. (Yjs replicates a whole doc to every client, so
  isolation must be by partitioning into per-file docs, not by filtering one doc.)
- **Phase 3 — glob authorization ✅** the relay authorizes each file-room against
  the token scope's `paths` globs; a scoped client only connects to (and only
  writes to disk) the files it's granted. **This is the "don't expose the whole
  codebase" guarantee** — proven in `hive-scope-test.js`: a `frontend/**` agent
  never receives `backend/secrets.js`, and the relay rejects that file-room.
- **Phase 4 — enforcement ✅ (core) / control plane ▢ (remaining)**
  - ✅ **read-only roles** — the relay drops a `reader`'s write messages (sync
    step2/update); reads still flow (`hive-readonly-test.js`).
  - ✅ **relay is the only path** — `disableBc` stops same-machine clients from
    syncing peer-to-peer over BroadcastChannel and bypassing access control.
  - ▢ **remaining:** a web UI/API for orgs/repos/grants, SSO/SCIM, hosted RS256
    issuer, audit export. (Tokens are minted by the `hive-token` CLI today.)
- **Phase 5 — per-file write scope ✅** one principal can **see** some folders but
  only **edit** a subset. A scope adds an optional `writePaths` (a subset of
  `paths`): a file you can see is read-only unless it also matches `writePaths`.
  The relay enforces it by connecting an out-of-write-scope file-room **as a
  reader** (so Phase-4 read-only enforcement drops its writes) while the parent
  room stays writable for coordination; clients additionally never *push* changes
  to view-only files (so they can't even register a new file there). Proven in
  `hive-writescope-test.js`: an agent with `paths=[backend,frontend]`,
  `writePaths=[backend]` edits backend, sees frontend, and its frontend
  writes/creates are dropped. Minted via the extension's "Invite to folders…"
  (pick edit folders, then optional view-only folders) or
  `hive-invite.js <name> "backend/**" --read "frontend/**"`.

### Known limits (honest)
- **Filenames, not contents, can leak:** the parent `manifest` lists every path, so
  a scoped client could read the *names* of out-of-scope files (never their
  **contents** — those live in per-file rooms it can't open, and are never written
  to its disk). Per-scope manifest filtering is a future refinement.
- A `reader`'s local edits stay on its own disk (they just never reach the relay).
- One WebSocket connection per open file — fine for typical projects; connection
  multiplexing is a future optimization for very large trees.

RBAC composes with the task gate: **RBAC decides whether an agent may see/touch a
scope; the owner-approval gate decides whether a specific task runs.**
