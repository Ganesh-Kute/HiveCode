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
import * as Y from 'yjs'
import { WebSocketServer } from 'ws'
import { setupWSConnection, setPersistence } from 'y-websocket/bin/utils'
import { verify, scopeForRoom } from './token.js'

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
const AUDIT_FILE = process.env.HIVE_AUDIT_FILE || ''
function readSafe(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

function revokedSet() {
  const out = new Set((process.env.HIVE_REVOKED_JTIS || '').split(',').map((s) => s.trim()).filter(Boolean))
  if (process.env.HIVE_REVOKED_FILE) {
    try { for (const j of JSON.parse(fs.readFileSync(process.env.HIVE_REVOKED_FILE, 'utf8'))) out.add(j) } catch { /* none */ }
  }
  return out
}

function audit(event, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields })
  if (AUDIT_FILE) { try { fs.appendFileSync(AUDIT_FILE, line + '\n') } catch { console.error('[relay] audit write failed') } }
  else console.log('[relay][audit]', line)
}

// Decide whether a connection to `room` carrying `token` is allowed.
// Returns { ok, identity?, role?, code?, reason? }.
function authorize(room, token) {
  if (AUTH_MODE !== 'required') return { ok: true, identity: { name: 'anon', kind: 'unknown' }, role: 'open' }
  // fail closed: required mode with no key configured rejects everything
  if (!JWT_SECRET && !JWT_PUBKEY) return { ok: false, code: 503, reason: 'auth required but relay has no keys configured' }
  if (!token) return { ok: false, code: 401, reason: 'no token' }
  const res = verify(token, { secret: JWT_SECRET || undefined, publicKey: JWT_PUBKEY || undefined })
  if (!res.ok) return { ok: false, code: 401, reason: res.error }
  const p = res.payload
  if (p.jti && revokedSet().has(p.jti)) return { ok: false, code: 401, reason: 'token revoked' }
  const sc = scopeForRoom(p, room)
  if (!sc) return { ok: false, code: 403, reason: 'room not in token scope' }
  return { ok: true, identity: { sub: p.sub, name: p.name, kind: p.kind, owner: p.owner }, role: sc.role || 'writer' }
}

// --- optional persistence (plain-file snapshots per room) ---
const PERSIST_DIR = process.env.HIVE_PERSIST_DIR
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

  const auth = authorize(room, token)
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
