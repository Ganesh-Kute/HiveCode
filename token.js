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
// verifyWith: { secret } and/or { publicKey }. The token's header.alg selects
// which key is used. Returns { ok, payload } or { ok:false, error }.
export function verify(token, verifyWith = {}, now = Math.floor(Date.now() / 1000)) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'no token' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, error: 'malformed token' }
  const [h, p, s] = parts
  let header, payload
  try { header = JSON.parse(b64urlToBuf(h).toString('utf8')); payload = JSON.parse(b64urlToBuf(p).toString('utf8')) }
  catch { return { ok: false, error: 'undecodable token' } }
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

  if (payload.exp != null && now >= payload.exp) return { ok: false, error: 'token expired' }
  if (payload.nbf != null && now < payload.nbf) return { ok: false, error: 'token not yet valid' }
  return { ok: true, payload }
}

// Does a scope's room pattern authorize this room? Supports exact, "*" (all),
// and a trailing "*" prefix wildcard (e.g. "acme/*" matches "acme/api").
export function roomMatches(pattern, room) {
  if (!pattern) return false
  if (pattern === '*' || pattern === room) return true
  if (pattern.endsWith('*')) return room.startsWith(pattern.slice(0, -1))
  return false
}

// Find the scope (and role) that authorizes `room`, or null.
export function scopeForRoom(payload, room) {
  const scopes = Array.isArray(payload && payload.scopes) ? payload.scopes : []
  return scopes.find((sc) => roomMatches(sc.room, room)) || null
}
