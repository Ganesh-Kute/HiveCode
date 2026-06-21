# Hivecode — edge-case & threat audit

A pass over "what could go wrong" across the sync engine, the access-control
layer (RBAC), and the relay. Each row is a concrete scenario with its **status**:

- **FIXED** — was a real bug/vuln; closed in this pass, with a test.
- **SAFE** — checked; the existing code already handles it (test added where useful).
- **LIMIT** — a known, accepted limitation, documented so it isn't a surprise.

Tests: `node test.js` (90 unit), `node hive-edge-test.js` (11 adversarial live),
plus the per-feature live tests (`hive-scope`, `hive-secure`, `hive-readonly`,
`hive-auth`, …).

---

## A. Path handling / arbitrary file write  (most serious)

| # | Scenario | Status | Where |
|---|----------|--------|-------|
| A1 | A peer puts `../../etc/cron.d/x` in the shared **manifest**; every client writes it **outside** its project root → remote code execution / arbitrary write. | **FIXED** | `isSafeRelPath` gates `canOpen` + `reconcile` + `writeToDisk` in `sync.js`/`extension.js`. `hive-edge-test` #1 |
| A2 | Absolute path `/etc/passwd` or `C:\Windows\…` in the manifest. | **FIXED** | `isSafeRelPath` rejects POSIX-absolute, drive-letter, UNC. unit + live |
| A3 | `FILE_SEP` (U+0001) smuggled **into a path** to confuse `baseRoomOf`/`pathOf` room parsing. | **FIXED** | `isSafeRelPath` rejects all control chars (U+0000–U+001F). unit test |
| A4 | Malformed file-**room** `<base>␁../../etc/x` connected to directly, bypassing the client. | **FIXED** | relay `authorize()` rejects with 403 before the WS handshake. `hive-edge-test` #4 |
| A5 | A `..` segment that *normalizes* back inside root (`a/../b`). | **FIXED** | conservatively rejected (any `..` segment), even if "harmless". unit test |
| A6 | Symlink in the tree followed during `walk()` (read-side traversal). | **SAFE** | `walk` only recurses `isDirectory()`/`isFile()`; symlinks are neither, so they're skipped. |

## B. Access tokens (JWT) / RBAC

| # | Scenario | Status | Where |
|---|----------|--------|-------|
| B1 | `alg: "none"` — drop the signature and walk in. | **SAFE** (now tested) | unknown alg → rejected. `test.js` token-attacks |
| B2 | **Algorithm confusion**: forge an HS256 token using the RSA **public** key as the HMAC secret, against an RS256-only relay. | **SAFE** (now tested) | HS256 path needs a configured `secret`; RS256-only relay has none → rejected. + new **alg pinning**. |
| B3 | Relay configured RS256-only still accidentally accepting HS256 (or vice-versa). | **FIXED** | relay auto-pins `alg` to the one key type configured (`HIVE_JWT_ALG` to override). |
| B4 | Non-numeric `exp` (`"9999999999"`) makes `now >= exp` false → token **never expires**. | **FIXED** | `verify` requires `exp`/`nbf` to be numbers; non-numeric → fail closed. unit test |
| B5 | Unsigned `h.p.` (empty 3rd segment) / 2-part / empty token. | **FIXED** | explicit `unsigned token` reject + shape checks. unit tests |
| B6 | Tampered payload or wrong secret. | **SAFE** | `timingSafeEqual` (HS256) / `crypto.verify` (RS256). existing tests |
| B7 | A broad `"*"` scope listed **before** a tighter scope for the same room silently over-grants. | **FIXED** | `scopeForRoom` now picks the **most specific** match (exact > prefix > `*`). unit test |
| B8 | `exp`/`nbf` boundary, revoked `jti`. | **SAFE** | expiry + `revokedSet` checked on every connect. `hive-auth-test` |
| B9 | Revocation list file read **mid-write** → JSON parse fails → revocations momentarily forgotten. | **FIXED** | relay keeps the **last good** revoked set on a transient read failure (fail-closed). |
| B10 | `required` mode with **no keys** configured. | **SAFE** | fail-closed: rejects everything (503). `hive-auth-test` |
| B11 | Client reads its **own** grant via `decodeUnsafe` (unverified) and trusts it for access. | **SAFE** | `decodeUnsafe` is UX-only; the **relay** is the sole enforcer (verifies signature). documented |

## C. Sync / merge correctness (data loss)

| # | Scenario | Status | Where |
|---|----------|--------|-------|
| C1 | A stale full-file rewrite silently deletes another agent's just-arrived work. | **FIXED** (prior) | fork-point 3-way merge. `merge-clobber-test` |
| C2 | A tracked text file is replaced **locally by a binary/oversized file**; an incoming remote text edit overwrites (destroys) it. | **FIXED** | `reconcile` detects "exists but unreadable" and leaves it untouched (never clobbers). `hive-edge-test` #2 |
| C3 | A scoped agent creates a file **outside** its scope locally → pollutes the manifest / leaks. | **FIXED** | `reconcile` `canOpen` guard: out-of-scope local files are never published. `hive-edge-test` #3 |
| C4 | A file/README that merely **mentions** `<<<<<<<` markers triggers a phantom conflict. | **SAFE** | line-anchored `hasConflictMarkers`. unit test |
| C5 | Overlapping same-line edits. | **SAFE** | git-style conflict markers; both versions survive. `merge-live-test` |
| C6 | Coarse mtime resolution misses a fast second edit. | **SAFE** | `fs.watch` is the fast path; periodic `scan` is the safety net. |
| C7 | Read-only role still mutates shared state. | **SAFE** | relay drops a reader's sync step2/update messages. `hive-readonly-test` |
| C8 | Two same-machine clients sync **peer-to-peer** over BroadcastChannel, bypassing the relay's auth/scope/read-only. | **FIXED** (prior) | `disableBc: true` on every provider — relay is the only path. `hive-readonly-test` |

## D. Coordination / task gate

| # | Scenario | Status | Where |
|---|----------|--------|-------|
| D1 | A non-owner human makes someone else's agent act without approval. | **SAFE** | asymmetric gate: stays PENDING until the AI's owner decides. `hive-task-test` |
| D2 | AI→AI coordination should flow without a human. | **SAFE** | auto-accepted. `hive-task-test` |
| D3 | An agent with **no owner** auto-accepts every human request. | **LIMIT** | by design (no owner = no gate). An agent that wants the gate must declare an `owner`. documented |
| D4 | A client spoofs another participant's display name in presence. | **LIMIT** | awareness is self-asserted; presence is advisory, not an access decision. |

## F. Self-certifying secured rooms (in-extension hosting, no secret files)

The owner hosts a room whose id embeds a fingerprint of their public key; the
private key lives in the editor's secure storage (never a file). Tokens carry the
public key and are signed by the private key; the relay trusts a token only if the
key's fingerprint matches the room id — so the **hosted, stateless relay enforces
folder access with no registration and no shared secret**.

| # | Scenario | Status | Where |
|---|----------|--------|-------|
| F1 | Attacker brings **their own keypair** and mints an "admin" token for someone's room. | **SAFE** | relay rejects: `keyFingerprint(token.pk) !== roomFingerprint(room)`. `hive-secure-test` |
| F2 | Tokenless connect to a secured room (even on an **open** relay). | **SAFE** | secured-room branch enforced before the open early-return. `hive-secure-test` |
| F3 | Token's embedded `pk` swapped but signature kept (key/sig mismatch). | **SAFE** | `verify(token,{publicKey:pk})` fails — sig won't validate under the swapped key. |
| F4 | Owner shrinks/cuts access mid-session (**revoke**). | **SAFE** | `POST /__hive/revoke` (owner token required) → in-memory per-room jti block. `hive-secure-test` |
| F5 | A **non-owner** tries to revoke someone (or revoke the owner). | **SAFE** | revoke requires an admin/maintainer token whose key matches the room. `hive-secure-test` |
| F6 | Revocation is **in-memory** → lost if the relay restarts. | **LIMIT** | a revoked-but-unexpired token could reconnect after a relay restart; bounded by token TTL (default 7d). A durable revocation store is a future refinement. |
| F7 | Private key lost (owner's machine) → room un-administrable. | **LIMIT** | by design (owner-held key, no escrow). Re-host to rotate; old room simply expires. |

## E. Known limits (accepted, documented)

| # | Limit | Why it's acceptable |
|---|-------|---------------------|
| E1 | A scoped client can read out-of-scope **filenames** from the parent manifest (never their **contents** — those live in rooms it can't open and never hit its disk). | per-scope manifest filtering is a future refinement; no content/secret exposure today. |
| E2 | One WebSocket connection per open file. | fine for typical projects; multiplexing is a scale optimization. |
| E3 | A reader's local edits stay on its own disk (just never reach the relay). | read-only is about shared state, not the local working copy. |
| E4 | Two clients joining one room with **different/nested root folders** can cause flat-namespace path collisions / recursive nesting. | operational guidance: join a room from one consistent project root. `hive-workspace/` is gitignored. |
| E5 | CRLF vs LF line endings between OSes can widen merges. | line-based merge still converges; not data loss. (candidate for normalization later.) |
| E6 | Path-glob scope matching (`ignore` lib) is **case-insensitive**. On a case-sensitive FS (Linux), a scope `frontend/**` would also authorize a distinct `Frontend/` dir. | not a traversal/ROOT-escape (paths stay relative, `..`-free); narrow precision gap. Avoid case-only-distinct dirs in scoped trees, or normalize case in a future pass. |

## G. Security audit (2026-06-21)

Two independent adversarial passes over the access-control surface (`token.js`,
`server.js`, `sync.js`, `hive-mcp.js`, `extension.js`). **All core guarantees held**
— no auth/authorization bypass, no JWT forgery (alg-confusion / none / unsigned /
tamper), no path-traversal write, no self-certifying fingerprint bypass, no revoke
auth flaw, no read-only bypass, no webview XSS (every `innerHTML` interpolation is
`escapeHtml`'d). Findings:

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| G1 | `pathAllowed` threw on a `"./"`-prefixed file-room path; the `ignore` lib's `RangeError` propagated uncaught through the WS-upgrade handler → **relay process crash** (a single valid scoped participant could take down everyone's session). Fail-closed for auth, but an availability hole. | MEDIUM (availability) | **FIXED** — upgrade handler wraps `authorize()` in try/catch (throw ⇒ reject, never crash); `pathAllowed` normalizes leading `./` and guards every match in try/catch (deny on error). Tests: `hive-relay-robust-test.js`, unit "pathAllowed robustness". |
| G2 | Case-insensitive glob matching (E6). | LOW (scope precision, case-sensitive FS only) | Documented limit. |

---

### Summary of fixes landed this pass
1. **`isSafeRelPath`** — path-traversal / absolute / control-char guard on **both** client (write) and relay (file-room), closing an arbitrary-file-write vector (A1–A5).
2. **Binary/large-file clobber guard** in `reconcile` (C2).
3. **Out-of-scope local publish** blocked via `canOpen` in `reconcile` (C3).
4. **JWT hardening**: numeric `exp`/`nbf` (fail-closed), unsigned-token reject, **alg pinning** (B3–B5).
5. **`scopeForRoom` most-specific-wins** (B7).
6. **Revocation fail-closed** on transient list-read failure (B9).
7. **Self-certifying secured rooms** + owner-only live revocation — lets the
   hosted, stateless relay enforce folder access driven entirely from the
   extension, with no secret files and no terminal (F1–F5).
