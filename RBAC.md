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
`paths` is stored now and **enforced in Phase 3** (see roadmap). In Phase 1 a token
grants room-level access.

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

## What Phase 1 does and does NOT do (honest scope)
**Does:** authenticate every connection on a secured relay; admit only valid,
unexpired, unrevoked tokens whose scope authorizes the room; reject everything else
at the upgrade; record an audit trail; revoke; expire; verify identity from the
token (not just self-asserted awareness). Backward compatible (open mode default).

**Does NOT yet:** enforce path globs (a token holder reaches the **whole room** it's
granted), enforce read-only vs write, or provide a management UI. Those are below.

## Roadmap to per-path scoping
1. **Phase 2 — subdocuments.** Re-architect `sync.js` so a project is a *manifest*
   (path → subdoc id) plus one Yjs **subdoc per file**, behind today's API. This is
   the prerequisite for per-path access: a client can load only the subdocs it's
   allowed to. (Yjs replicates a whole doc to every client, so isolation must be by
   partitioning into subdocs — not by filtering one shared doc.)
3. **Phase 3 — glob authorization.** The relay authorizes each subdoc load against
   the token's `paths` globs, and **filters the manifest** so a scoped agent doesn't
   even see the names of files outside its scope. *This is the full "don't expose
   the whole codebase" guarantee.*
4. **Phase 4 — enforcement + control plane.** Drop writes from `reader`s; per-scope
   write; a web UI/API for orgs/repos/grants; SSO/SCIM; hosted RS256 issuer; audit
   export.

RBAC composes with the task gate: **RBAC decides whether an agent may see/touch a
scope; the owner-approval gate decides whether a specific task runs.**
