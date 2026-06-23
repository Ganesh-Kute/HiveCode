// Hivecode access tokens — a tiny, dependency-free JWT (JWS) implementation used
// by the relay (verify) and the hive-token CLI (mint). No external libs: just
// Node's crypto, so there's no supply-chain surface for the thing that guards
// access. Supports HS256 (shared secret — self-host) and RS256 (public/private
// key — a hosted control plane signs, relays verify with the public key).
//
// Token shape (claims):
//   {
//     iss, sub,                 // issuer, principal id
//     name, kind,               // display name + 'human' | 'ai'
//     owner,                    // (agents) the human who may approve its tasks
//     scopes: [                 // what this principal may reach
//       { room: "room-id" | "acme/*" | "*", role: "admin|maintainer|writer|reader|agent",
//         paths: ["src/**", "!**/*.env"] }   // path globs are enforced in a later phase
//     ],
//     iat, exp,                 // issued-at, expiry (unix seconds)
//     jti                       // unique id, for revocation
//   }

import crypto from 'crypto'
import ignore from 'ignore'

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const enc = (obj) => b64url(JSON.stringify(obj))

// --- mint ---
// signWith: { secret } -> HS256, or { privateKey } -> RS256.
export function sign(payload, signWith) {
  const useRsa = !!signWith.privateKey
  const header = { alg: useRsa ? 'RS256' : 'HS256', typ: 'JWT' }
  const data = enc(header) + '.' + enc(payload)
  let sig
  if (useRsa) sig = crypto.sign('RSA-SHA256', Buffer.from(data), signWith.privateKey)
  else sig = crypto.createHmac('sha256', signWith.secret).update(data).digest()
  return data + '.' + b64url(sig)
}

// --- verify ---
// verifyWith: { secret } and/or { publicKey }, plus optional { alg } to PIN the
// accepted algorithm (defense-in-depth against alg-confusion: a deployment that
// only issues RS256 can refuse every HS256 token outright). The token's
// header.alg selects which key is used. Returns { ok, payload } or { ok:false, error }.
export function verify(token, verifyWith = {}, now = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'no token' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, error: 'malformed token' }
  const [h, p, s] = parts
  if (!s) return { ok: false, error: 'unsigned token' } // "h.p." — empty signature segment
  let header, payload
  try { header = JSON.parse(b64urlToBuf(h).toString('utf8')); payload = JSON.parse(b64urlToBuf(p).toString('utf8')) }
  catch { return { ok: false, error: 'undecodable token' } }
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'bad payload' }
  // Optional algorithm pinning: reject anything the relay didn't opt into.
  if (verifyWith.alg && header.alg !== verifyWith.alg) return { ok: false, error: `alg ${header.alg} not allowed (pinned to ${verifyWith.alg})` }
  const data = h + '.' + p
  const sig = b64urlToBuf(s)

  if (header.alg === 'HS256') {
    if (!verifyWith.secret) return { ok: false, error: 'HS256 token but relay has no secret configured' }
    const expected = crypto.createHmac('sha256', verifyWith.secret).update(data).digest()
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return { ok: false, error: 'bad signature' }
  } else if (header.alg === 'RS256') {
    if (!verifyWith.publicKey) return { ok: false, error: 'RS256 token but relay has no public key configured' }
    let valid = false
    try { valid = crypto.verify('RSA-SHA256', Buffer.from(data), verifyWith.publicKey, sig) } catch { valid = false }
    if (!valid) return { ok: false, error: 'bad signature' }
  } else {
    return { ok: false, error: `unsupported alg: ${header.alg}` }
  }

  // exp/nbf must be NUMBERS. A non-numeric exp would make `now >= exp` false and
  // the token would never expire — fail closed and reject it instead.
  if (payload.exp != null && (typeof payload.exp !== 'number' || now >= payload.exp)) return { ok: false, error: 'token expired' }
  if (payload.nbf != null && (typeof payload.nbf !== 'number' || now < payload.nbf)) return { ok: false, error: 'token not yet valid' }
  return { ok: true, payload }
}

// --- room naming for the per-file subdoc model (Phase 2) ---
// A project is a PARENT room (manifest + coordination) plus one room per file,
// named `<baseRoom>␁<path>`. Encoding the path in the room name lets the relay
// authorize per-path (Phase 3) and lets a client connect only to the files it
// may load. FILE_SEP is a control char that never appears in room ids or paths.
export const FILE_SEP = ''
export const fileRoom = (baseRoom, relPath) => baseRoom + FILE_SEP + relPath
export const baseRoomOf = (room) => { const i = room.indexOf(FILE_SEP); return i < 0 ? room : room.slice(0, i) }
export const pathOf = (room) => { const i = room.indexOf(FILE_SEP); return i < 0 ? null : room.slice(i + 1) }

// Does a scope's room pattern authorize this room? Supports exact, "*" (all),
// and a trailing "*" prefix wildcard (e.g. "acme/*" matches "acme/api").
export function roomMatches(pattern, room) {
  if (!pattern) return false
  if (pattern === '*' || pattern === room) return true
  if (pattern.endsWith('*')) return room.startsWith(pattern.slice(0, -1))
  return false
}

// Find the scope (and role) that authorizes `room`, or null. When several scopes
// match, the MOST SPECIFIC wins (exact room > longer prefix > "*"). This stops a
// broad "*" scope listed first from shadowing a tighter, intentionally-narrower
// scope for the same room (which would silently over-grant). Ties keep the first.
export function scopeForRoom(payload, room) {
  const scopes = Array.isArray(payload && payload.scopes) ? payload.scopes : []
  let best = null, bestScore = -1
  for (const sc of scopes) {
    if (!sc || !roomMatches(sc.room, room)) continue
    const score = sc.room === room ? Infinity : sc.room === '*' ? 0 : sc.room.length // exact > longer prefix > "*"
    if (score > bestScore) { bestScore = score; best = sc }
  }
  return best
}

// Is a remote-supplied path safe to materialize on this client's disk? A room
// participant controls the manifest (and thus file paths); without this, a
// malicious entry like "../../etc/cron.d/x", "/etc/passwd", or "C:\\Windows\\..."
// would be written OUTSIDE the project root by every client that syncs it. We
// reject absolute paths, drive letters, UNC, any ".." segment, control chars
// (incl. the FILE_SEP separator and NULs), and absurd lengths. Enforced on the
// client (before writing) AND the relay (rejects the file-room) — defense in depth.
export function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1024) return false
  if (/[\u0000-\u001f]/.test(relPath)) return false        // control chars: NUL, FILE_SEP (U+0001), etc.
  const p = relPath.replace(/\\/g, '/')                    // normalize Windows separators
  if (p.startsWith('/')) return false                      // POSIX absolute
  if (p.startsWith('//')) return false                     // UNC-ish
  if (/^[a-zA-Z]:/.test(p)) return false                   // Windows drive letter (C:...)
  if (p.split('/').some((seg) => seg === '..')) return false // traversal
  return true
}

// Phase 3: is a file path allowed by a scope's path globs? Gitignore-style globs
// (via the `ignore` lib): positive patterns grant subtrees, "!"-prefixed patterns
// deny. No globs (or none given) = the whole room is allowed (Phase-2 behavior).
//   pathAllowed(["src/**", "!**/*.env"], "src/app.js") -> true
//   pathAllowed(["src/**"],            "secrets/k.txt") -> false
export function pathAllowed(globs, relPath) {
  if (!Array.isArray(globs) || globs.length === 0) return true
  // The `ignore` lib throws on a "./"-prefixed path; normalize it away. And guard
  // every match call so a malformed input can NEVER throw into the relay's auth
  // gate (a throw there must fail closed, not crash the process).
  const p = String(relPath).replace(/^(\.\/)+/, '')
  const pos = [], neg = []
  for (const g of globs) { if (typeof g !== 'string' || !g) continue; if (g[0] === '!') neg.push(g.slice(1)); else pos.push(g) }
  const matches = (pats) => { try { return pats.length > 0 && ignore().add(pats).ignores(p) } catch { return false } }
  const inAllow = pos.length === 0 ? true : matches(pos)
  return inAllow && !matches(neg)
}

// Phase 5: within a scope, which VISIBLE paths are also WRITABLE. `writePaths` is
// an optional subset of `paths`: a file the scope can see is read-only unless it
// ALSO matches writePaths. This is what lets one agent read frontend/ for context
// but only edit backend/. Semantics, chosen to fail safe:
//   - role 'reader'        -> never writable (whole grant is view-only)
//   - no writePaths key     -> every visible path is writable (back-compat: a plain
//                              writer/agent edits everything it can see)
//   - writePaths: []        -> nothing writable (explicit view-only everywhere)
//   - writePaths: [globs]   -> writable IFF the path matches the globs
// The relay enforces this by connecting an out-of-write-scope file-room as a
// reader (so makeReadOnly drops its writes); clients use it for read-only UX.
export function writeAllowed(scope, relPath) {
  if (!scope) return false
  if ((scope.role || 'writer') === 'reader') return false
  const wp = scope.writePaths
  if (wp == null) return true
  if (!Array.isArray(wp) || wp.length === 0) return false
  return pathAllowed(wp, relPath)
}

// --- self-certifying secured rooms (no server-side key registry, no secret files) ---
// A secured room's id embeds a fingerprint of the OWNER's public key:
//     hs_<fp>_<rand>        fp = base64url(sha256(spki-DER)).slice(0, 22)
// Every token for the room carries the owner's public key (claim `pk`) and is
// signed by the matching private key (RS256). The relay trusts a token IFF the
// embedded key's fingerprint equals the one in the room id — so trust is anchored
// in the room id itself and the relay needs to store nothing. Only the owner (who
// holds the private key, kept in the editor's secure storage) can mint valid
// tokens. This is what lets the hosted, stateless, free-tier relay enforce
// per-folder access with no registration step and no secret handed to anyone.
export function keyFingerprint(publicKeyPem) {
  try {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
    return crypto.createHash('sha256').update(der).digest('base64url').slice(0, 22)
  } catch { return null }
}
export function roomFingerprint(room) {
  const m = /^hs_([A-Za-z0-9_-]{22})_/.exec(room || '')
  return m ? m[1] : null
}
export const isSecuredRoom = (room) => roomFingerprint(room) != null
export function makeSecuredRoomId(publicKeyPem, rand) {
  const fp = keyFingerprint(publicKeyPem)
  return fp ? `hs_${fp}_${rand}` : null
}

// Read a token's payload WITHOUT verifying — for a client to inspect its OWN grant
// (e.g. which paths it may open) for UX. NEVER use for access decisions; the relay
// is the enforcer (it verifies the signature).
export function decodeUnsafe(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) }
  catch { return null }
}
