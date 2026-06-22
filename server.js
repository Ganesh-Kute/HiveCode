// Relay server — the "meeting point" in the middle.
// It holds no truth of its own. It just passes CRDT updates between
// everyone connected to the same room. Humans and AI agents are equal here.
//
// Run this on any machine both teammates can reach (a cheap VPS, Railway,
// Fly.io, even a home PC with a tunnel). Everyone connects to it by URL.
//
// Two production niceties (both opt-in via env, so local dev is unchanged):
//   - KEEP-WARM: if RENDER_EXTERNAL_URL (or KEEPALIVE_URL) is set, the relay
//     pings its own public URL every ~10 min so a free-tier host never sleeps —
//     no more ~30s cold-start on the first join.
//   - PERSISTENCE: if HIVE_PERSIST_DIR is set, each room's CRDT state is saved
//     to disk (debounced) and reloaded on restart, so a session survives a relay
//     restart even if everyone was disconnected. (No native deps — plain files.)

import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import * as Y from 'yjs'
import { WebSocketServer } from 'ws'
import { setupWSConnection, setPersistence } from 'y-websocket/bin/utils'
import { verify, scopeForRoom, baseRoomOf, pathOf, pathAllowed, isSafeRelPath, decodeUnsafe, keyFingerprint, roomFingerprint } from './token.js'
import * as decoding from 'lib0/decoding'

// Enforce a read-only connection: drop the client's inbound SYNC writes (sync
// step2 + update) so they can never mutate shared state, while still letting it
// receive state (sync step1) and presence (awareness). We wrap conn.on so that
// the message handler y-websocket registers next is filtered.
function makeReadOnly(conn) {
  const realOn = conn.on.bind(conn)
  conn.on = (event, handler) => {
    if (event !== 'message') return realOn(event, handler)
    return realOn('message', (data, ...rest) => {
      try {
        const dec = decoding.createDecoder(new Uint8Array(data))
        if (decoding.readVarUint(dec) === 0) { // 0 = sync
          const syncType = decoding.readVarUint(dec)
          if (syncType === 1 || syncType === 2) return // 1=step2, 2=update -> a WRITE; drop it
        }
      } catch { /* unparseable -> let it through */ }
      return handler(data, ...rest)
    })
  }
}

const PORT = process.env.PORT || 1234

// --- access control (Phase 1: token-gated rooms; opt-in, off by default) ---
// HIVE_AUTH_MODE: 'open' (default — anyone with the room id joins, like before)
//                 'required' — every connection must present a valid token whose
//                 scopes authorize the room it is joining.
// Keys: HIVE_JWT_SECRET (HS256, self-host) and/or HIVE_JWT_PUBKEY[_FILE] (RS256,
// for a hosted issuer). Revocation: HIVE_REVOKED_FILE (JSON array of jti) and/or
// HIVE_REVOKED_JTIS (comma list). Audit: HIVE_AUDIT_FILE (JSONL) else stdout.
const AUTH_MODE = (process.env.HIVE_AUTH_MODE || 'open').toLowerCase()
const JWT_SECRET = process.env.HIVE_JWT_SECRET || ''
const JWT_PUBKEY = process.env.HIVE_JWT_PUBKEY || (process.env.HIVE_JWT_PUBKEY_FILE ? readSafe(process.env.HIVE_JWT_PUBKEY_FILE) : '')
// Pin the accepted JWT algorithm (alg-confusion defense). Explicit override via
// HIVE_JWT_ALG; otherwise auto-pin to the one type of key configured. With BOTH
// keys present we accept either (no pin) — but never an unexpected alg.
const JWT_ALG = (process.env.HIVE_JWT_ALG || '').toUpperCase() || (JWT_SECRET && JWT_PUBKEY ? '' : JWT_SECRET ? 'HS256' : JWT_PUBKEY ? 'RS256' : '')
const AUDIT_FILE = process.env.HIVE_AUDIT_FILE || ''
function readSafe(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

// Revocation list. The JSON file is re-read per connect so a revocation takes
// effect immediately. If that read/parse fails transiently (e.g. the file is
// mid-write), we KEEP the last good set rather than forgetting it — failing
// closed, so a revoked token can't slip through during a list update.
let lastGoodRevokedFile = new Set()
function revokedSet() {
  const out = new Set((process.env.HIVE_REVOKED_JTIS || '').split(',').map((s) => s.trim()).filter(Boolean))
  if (process.env.HIVE_REVOKED_FILE) {
    try { lastGoodRevokedFile = new Set(JSON.parse(fs.readFileSync(process.env.HIVE_REVOKED_FILE, 'utf8'))) }
    catch { /* mid-write/missing: fall back to last good (don't drop revocations) */ }
    for (const j of lastGoodRevokedFile) out.add(j)
  }
  return out
}

function audit(event, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields })
  if (AUDIT_FILE) { try { fs.appendFileSync(AUDIT_FILE, line + '\n') } catch { console.error('[relay] audit write failed') } }
  else console.log('[relay][audit]', line)
}

// Per-room revocation, set live by the owner via POST /__hive/revoke. Persisted to
// a JSON file (HIVE_ROOM_REVOKED_FILE, default ./hive-room-revoked.json) so a
// revoked agent stays cut off across a relay restart — not just for the session.
const ROOM_REVOKED_FILE = process.env.HIVE_ROOM_REVOKED_FILE || './hive-room-revoked.json'
const roomRevoked = new Map() // baseRoom -> Set(jti)
;(function loadRoomRevoked() {
  try { const o = JSON.parse(fs.readFileSync(ROOM_REVOKED_FILE, 'utf8')); for (const k of Object.keys(o)) roomRevoked.set(k, new Set(o[k])) } catch { /* none yet */ }
})()
function persistRoomRevoked() {
  try { const o = {}; for (const [k, set] of roomRevoked) o[k] = [...set]; fs.writeFileSync(ROOM_REVOKED_FILE, JSON.stringify(o)) }
  catch (e) { console.error('[relay] room-revoked persist failed', e.message) }
}
function isRevoked(base, jti) {
  if (!jti) return false
  if (revokedSet().has(jti)) return true
  const s = roomRevoked.get(base)
  return !!(s && s.has(jti))
}

// Shared scope + path enforcement once a token's signature is verified. A project
// is a base room plus per-file rooms ("<base>␁<path>"). Authorize on the BASE
// room, and — for a file-room — also require the path to match the scope's globs.
// This is the guarantee: a scoped agent's connect to an out-of-scope file is
// rejected here, so that file's bytes never reach it.
function scopeCheck(p, room) {
  const base = baseRoomOf(room)
  if (isRevoked(base, p.jti)) return { ok: false, code: 401, reason: 'token revoked' }
  const sc = scopeForRoom(p, base)
  if (!sc) return { ok: false, code: 403, reason: 'room not in token scope' }
  const filePath = pathOf(room)
  if (filePath !== null) {
    if (!isSafeRelPath(filePath)) return { ok: false, code: 403, reason: 'malformed file path' }
    if (!pathAllowed(sc.paths, filePath)) return { ok: false, code: 403, reason: `path "${filePath}" not in scope` }
  }
  return { ok: true, identity: { sub: p.sub, name: p.name, kind: p.kind, owner: p.owner }, role: sc.role || 'writer', path: filePath }
}

// Decide whether a connection to `room` carrying `token` is allowed.
// Returns { ok, identity?, role?, code?, reason? }.
function authorize(room, token) {
  // SELF-CERTIFYING SECURED ROOM (always enforced, even on an "open" relay): the
  // room id embeds a fingerprint of the owner's public key. The token carries that
  // public key (claim `pk`) and is signed by the matching private key. We trust it
  // only if fingerprint(pk) === the room's fingerprint — so no server-side key
  // store is needed, and only the owner (private-key holder) can mint valid tokens.
  const fp = roomFingerprint(baseRoomOf(room))
  if (fp) {
    if (!token) return { ok: false, code: 401, reason: 'secured room requires a token' }
    const pre = decodeUnsafe(token)
    const pk = pre && pre.pk
    if (!pk) return { ok: false, code: 401, reason: 'token missing room key' }
    if (keyFingerprint(pk) !== fp) return { ok: false, code: 403, reason: 'token key does not match this room' }
    const res = verify(token, { publicKey: pk, alg: 'RS256' })
    if (!res.ok) return { ok: false, code: 401, reason: res.error }
    return scopeCheck(res.payload, room)
  }

  // NON-SECURED ROOMS: the relay-wide policy (open by default; or a self-host
  // locked relay via HIVE_AUTH_MODE=required + a configured key).
  if (AUTH_MODE !== 'required') return { ok: true, identity: { name: 'anon', kind: 'unknown' }, role: 'open' }
  if (!JWT_SECRET && !JWT_PUBKEY) return { ok: false, code: 503, reason: 'auth required but relay has no keys configured' }
  if (!token) return { ok: false, code: 401, reason: 'no token' }
  const res = verify(token, { secret: JWT_SECRET || undefined, publicKey: JWT_PUBKEY || undefined, alg: JWT_ALG || undefined })
  if (!res.ok) return { ok: false, code: 401, reason: res.error }
  return scopeCheck(res.payload, room)
}

// Owner-driven revocation endpoint. Body: { room, token, jti }. The token must be
// an admin/maintainer token for that secured room (proven self-certifying), so
// only the room owner can cut someone off. In-memory + audited.
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy() }); req.on('end', () => resolve(b)) }) }
async function handleRevoke(req, res) {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  try {
    const { room, token, jti } = JSON.parse((await readBody(req)) || '{}')
    const base = baseRoomOf(room || '')
    const fp = roomFingerprint(base)
    const p = decodeUnsafe(token)
    if (!fp || !p || !p.pk || keyFingerprint(p.pk) !== fp) return reply(403, { error: 'not authorized for this room' })
    const v = verify(token, { publicKey: p.pk, alg: 'RS256' })
    if (!v.ok) return reply(401, { error: v.error })
    const sc = scopeForRoom(v.payload, base)
    if (!sc || !['admin', 'maintainer'].includes(sc.role)) return reply(403, { error: 'need an admin/maintainer token' })
    if (!jti) return reply(400, { error: 'need a jti to revoke' })
    if (!roomRevoked.has(base)) roomRevoked.set(base, new Set())
    roomRevoked.get(base).add(jti)
    persistRoomRevoked() // survive a relay restart
    audit('revoke', { room: base, jti, by: v.payload.name })
    return reply(200, { ok: true })
  } catch { return reply(400, { error: 'bad request' }) }
}

// --- persistence (plain-file snapshots per room) ---
// Keeps a room's code available even when NO editor is online — this is what lets
// you view/control a project from a browser (or phone) while you're away.
// Resolution: explicit HIVE_PERSIST_DIR wins; "off" force-disables; otherwise it
// auto-enables on the deployed relay (Render sets RENDER=true) and stays OFF for
// local runs/tests so they're deterministic and RAM-only.
const PERSIST_DIR = process.env.HIVE_PERSIST_DIR === 'off'
  ? null
  : (process.env.HIVE_PERSIST_DIR || (process.env.RENDER ? path.join(__dirname, '.hive-relay-data') : null))
if (PERSIST_DIR) {
  fs.mkdirSync(PERSIST_DIR, { recursive: true })
  const fileFor = (docName) => path.join(PERSIST_DIR, encodeURIComponent(docName) + '.bin')
  const flush = (docName, ydoc) => { try { fs.writeFileSync(fileFor(docName), Buffer.from(Y.encodeStateAsUpdate(ydoc))) } catch (e) { console.error('[relay] persist write failed', e.message) } }
  setPersistence({
    bindState: async (docName, ydoc) => {
      try { const buf = fs.readFileSync(fileFor(docName)); Y.applyUpdate(ydoc, new Uint8Array(buf)) } catch { /* no prior state */ }
      let pending = null
      ydoc.on('update', () => { if (pending) return; pending = setTimeout(() => { pending = null; flush(docName, ydoc) }, 1000) })
    },
    writeState: async (docName, ydoc) => flush(docName, ydoc),
  })
  console.log(`[relay] persistence ON -> ${PERSIST_DIR}`)
}

const server = http.createServer((req, res) => {
  if (req.url === '/__hive/revoke') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }); return res.end() }
    if (req.method === 'POST') return void handleRevoke(req, res)
  }
  // Static pages: the relay doubles as the website + the browser control room, so
  // one deploy serves everything. Map a small allowlist of paths to public/ files.
  if (req.method === 'GET') {
    const STATIC = {
      '/': 'index.html', '/index.html': 'index.html',
      '/control': 'control.html', '/control.html': 'control.html',
      '/favicon.ico': 'favicon.ico',
      '/favicon-32.png': 'favicon-32.png',
      '/apple-touch-icon.png': 'apple-touch-icon.png',
    }
    const TYPES = { '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' }
    const file = STATIC[(req.url || '').split('?')[0]]
    if (file) {
      try {
        const body = fs.readFileSync(path.join(__dirname, 'public', file))
        const ext = file.slice(file.lastIndexOf('.'))
        res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' })
        return res.end(body)
      } catch { /* fall through to the plain status text */ }
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('hivecode relay is up. Connect a client to ws://<this-host>:' + PORT + '/<room>\n')
})

// noServer: we authorize at the HTTP upgrade BEFORE completing the WS handshake,
// so an unauthorized client never establishes a socket and never receives any
// CRDT bytes for the room.
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  let room = 'default', token = ''
  try {
    const u = new URL(req.url, 'http://localhost')
    room = decodeURIComponent(u.pathname.slice(1)) || 'default'
    token = u.searchParams.get('token') || ''
  } catch { /* keep defaults */ }

  // Fail CLOSED on any unexpected error in authorization — a thrown exception here
  // must reject the connection, never crash the relay process (which would take down
  // every room). authorize() is the only trust gate, so a throw = deny.
  let auth
  try { auth = authorize(room, token) }
  catch (e) { auth = { ok: false, code: 401, reason: 'authorization error' }; console.error('[relay] authorize threw:', e && e.message) }
  if (!auth.ok) {
    audit('reject', { room, reason: auth.reason })
    const code = auth.code || 401
    const msg = code === 403 ? 'Forbidden' : code === 503 ? 'Service Unavailable' : 'Unauthorized'
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (conn) => {
    conn._hive = { room, identity: auth.identity, role: auth.role }
    audit('connect', { room, identity: auth.identity, role: auth.role })
    wss.emit('connection', conn, req)
  })
})

wss.on('connection', (conn, req) => {
  const room = (conn._hive && conn._hive.room) || (req.url || '/').slice(1).split('?')[0] || 'default'
  console.log(`[relay] a client joined room "${room}"${conn._hive ? ` as ${conn._hive.identity.name} (${conn._hive.role})` : ''}`)
  if (conn._hive && conn._hive.role === 'reader') makeReadOnly(conn) // enforce read-only BEFORE y-websocket wires its handler
  setupWSConnection(conn, req, { docName: room })
})

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`)
  console.log(`[relay] room URL pattern: ws://localhost:${PORT}/<room-name>`)
  console.log(`[relay] auth mode: ${AUTH_MODE}${AUTH_MODE === 'required' ? ` (keys: ${JWT_SECRET ? 'HS256 ' : ''}${JWT_PUBKEY ? 'RS256' : ''})` : ''}`)
})

// --- optional keep-warm (free-tier hosts sleep after ~15 min idle) ---
const KEEP_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL
if (KEEP_URL) {
  const url = KEEP_URL.startsWith('http') ? KEEP_URL : 'https://' + KEEP_URL
  const get = url.startsWith('https') ? https.get : http.get
  setInterval(() => { try { get(url, (r) => r.resume()).on('error', () => {}) } catch {} }, 10 * 60 * 1000)
  console.log(`[relay] keep-warm ON -> pinging ${url} every 10 min`)
}
