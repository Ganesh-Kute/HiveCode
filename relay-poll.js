// relay-poll.js -- the relay half of the HTTPS long-poll transport (wire format: hive-poll-proto.js).
//
// WHY: some networks pass ordinary HTTPS and refuse every WebSocket upgrade. On 7 Nov 2026 an agent
// on Antigravity's new 24/7 cloud VM could not join a room at all: the VM's egress proxy answered
// "403 WebSocket upgrades are not allowed", while a plain HTTPS GET of /health came back 200.
//
// HOW: a poll session is ONE connection, carried by HTTPS requests instead of a socket. server.js
// admits it with the SAME decision an upgrade gets (admitUpgrade: licence tier, room gates,
// authorization, capacity) and hands the resulting PollConn to the SAME accept path -- so
// installUsageLimits, makeReadOnly, installWriteGate, the governor, setupWSConnection and serveMux
// see an object that behaves like a ws connection. This module adds no rules of its own beyond what
// carrying a connection over requests needs to stay honest:
//
//   - a message is delivered to the gates once, in order, as an owned Buffer (emit 'message');
//     a retried send of frames already delivered is ignored, and a gap closes the session;
//   - the relay never DROPS a frame for the client: one the client has not acknowledged is sent
//     again on its next recv. A client that stops reading is CLOSED instead (past maxQueueBytes),
//     and it resyncs on reconnect -- a dropped Yjs update would wedge the document forever;
//   - pause() (the rate limiter holding a fast client) stops delivering what the client sends and
//     holds its send request open, so the client sends nothing more until the frames drain;
//   - 'close' is emitted exactly once, asynchronously, however the session ends (client close,
//     relay close, idle, overflow), so counters never double-decrement;
//   - ping() answers only while the client is still polling: a client that vanished without a
//     close stops getting pongs, and the idle reaper ends it after idleMs.
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { POLL_PREFIX, POLL_VERSION, packFrames, unpackFrames } from './hive-poll-proto.js'

const OPEN = 1
const CLOSED = 3

export class PollConn extends EventEmitter {
  constructor(session) {
    super()
    this.setMaxListeners(50)
    this._session = session
    this.readyState = OPEN
    this.binaryType = 'nodebuffer'
    this.isPoll = true
  }
  send(data, opts, cb) {
    if (typeof opts === 'function') cb = opts
    if (this.readyState !== OPEN) { if (cb) process.nextTick(cb, new Error('session closed')); return }
    this._session.enqueue(Buffer.from(data))
    if (cb) process.nextTick(cb, null)
  }
  ping() {
    if (this.readyState !== OPEN) return
    setImmediate(() => { if (this.readyState === OPEN && this._session.alive()) this.emit('pong') })
  }
  pause() { this._session.paused = true }
  resume() { this._session.paused = false; this._session.drainIn() }
  close(code, reason) { this._session.end(reason || 'closed by the relay', code) }
  terminate() { this._session.end('terminated by the relay') }
}

class Session {
  constructor(id, { holdMs, idleMs, maxQueueBytes, maxResponseBytes, onEnd }) {
    this.id = id
    this.holdMs = holdMs
    this.idleMs = idleMs
    this.maxQueueBytes = maxQueueBytes
    this.maxResponseBytes = maxResponseBytes
    this.onEnd = onEnd
    this.conn = new PollConn(this)
    this.out = []            // relay -> client: [{ seq, buf }], kept until the client acknowledges them
    this.outBytes = 0
    this.nextOut = 1
    this.nextIn = 1          // client -> relay: the next frame number expected
    this.inbox = []          // frames received while paused, in order
    this.inBytes = 0
    this.sendWaiters = []    // send requests answered only once their frames have drained
    this.waiter = null       // the held recv: { res, timer }
    this.paused = false
    this.ended = false
    this.lastSeen = Date.now()
  }
  touch() { this.lastSeen = Date.now() }
  alive() { return !this.ended && (this.waiter !== null || Date.now() - this.lastSeen < this.idleMs) }
  enqueue(buf) {
    if (this.ended) return
    this.out.push({ seq: this.nextOut++, buf })
    this.outBytes += buf.length
    if (this.outBytes > this.maxQueueBytes) {
      // Never drop a frame: end the session, and the client resyncs from scratch on reconnect.
      return this.end(`Q441 the client stopped reading (${Math.round(this.outBytes / 1048576)} MB waiting); it will reconnect and resync`)
    }
    this.answerWaiter()
  }
  ack(n) {
    while (this.out.length && this.out[0].seq <= n) this.outBytes -= this.out.shift().buf.length
  }
  answerWaiter() {
    if (!this.waiter || !this.out.length) return
    const { res, timer } = this.waiter
    this.waiter = null
    clearTimeout(timer)
    this.touch()
    this.respondFrames(res)
  }
  respondFrames(res) {
    const frames = []
    let bytes = 0
    for (const f of this.out) {
      if (frames.length && bytes + f.buf.length > this.maxResponseBytes) break
      frames.push(f.buf); bytes += f.buf.length
    }
    const body = packFrames(frames)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no', 'x-hive-seq': String(this.out[0].seq), 'x-hive-count': String(frames.length), 'content-length': body.length })
    res.end(body)
  }
  recv(res, ack, hold) {
    this.touch()
    this.ack(ack)
    if (this.waiter) { // a newer recv replaces an older one, which answers "nothing" at once
      const old = this.waiter; this.waiter = null; clearTimeout(old.timer)
      empty(old.res)
    }
    if (this.ended) return gone(res)
    if (this.out.length) return this.respondFrames(res)
    const timer = setTimeout(() => {
      if (this.waiter && this.waiter.res === res) { this.waiter = null; this.touch(); empty(res) }
    }, Math.max(1000, Math.min(hold || this.holdMs, this.holdMs)))
    this.waiter = { res, timer }
    res.on('close', () => { if (this.waiter && this.waiter.res === res) { clearTimeout(timer); this.waiter = null } })
  }
  send(res, first, frames) {
    this.touch()
    if (this.ended) return gone(res)
    for (let i = 0; i < frames.length; i++) {
      const seq = first + i
      if (seq < this.nextIn) continue // a retry of what was already delivered
      if (seq > this.nextIn) {
        json(res, 409, { gap: true, expected: this.nextIn, got: seq })
        return this.end(`a gap in the client's messages (expected ${this.nextIn}, got ${seq})`)
      }
      this.inbox.push(Buffer.from(frames[i]))
      this.inBytes += frames[i].length
      this.nextIn++
    }
    this.sendWaiters.push(res)
    // Bounded like the frames waiting FOR the client (Antigravity's review): a client pipelining sends
    // while paused is closed, never buffered without limit. It resyncs on reconnect.
    if (this.inBytes > this.maxQueueBytes) return this.end('Q432 kept sending past a paused read; it will reconnect and resync', 1013)
    this.drainIn()
  }
  drainIn() {
    while (!this.ended && !this.paused && this.inbox.length) { const b = this.inbox.shift(); this.inBytes -= b.length; this.conn.emit('message', b, true) }
    if (!this.paused && !this.inbox.length) {
      const waiting = this.sendWaiters; this.sendWaiters = []
      for (const res of waiting) empty(res)
    }
  }
  end(reason, code = 1000) {
    if (this.ended) return
    this.ended = true
    this.endCode = Number(code) || 1000
    this.endReason = String(reason || '')
    this.conn.readyState = CLOSED
    const why = { code: this.endCode, reason: this.endReason.slice(0, 200) }
    if (this.waiter) { const { res, timer } = this.waiter; this.waiter = null; clearTimeout(timer); gone(res, why) }
    for (const res of this.sendWaiters) gone(res, why)
    this.sendWaiters = []
    this.out = []; this.outBytes = 0; this.inbox = []; this.inBytes = 0
    this.onEnd(this, reason)
    setImmediate(() => this.conn.emit('close', this.endCode, Buffer.from(this.endReason).subarray(0, 120)))
  }
}

function json(res, code, obj) {
  if (res.headersSent) return
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-hive-relay': '1' })
  res.end(body)
}
function empty(res) { if (!res.headersSent) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end() } }
// Gone, with WHY when the relay knows it (a revoked token, a deleted room): the client says that, not "gone".
function gone(res, why) { json(res, 404, { gone: true, ...(why || {}) }) }

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * The poll endpoint. `admit(req)` is server.js's admitUpgrade: it resolves to { accept(conn) } or
 * to { line } -- the exact status line an upgrade would have been refused with.
 */
export function makePollHandler({ admit, track = () => { }, audit = () => { }, holdMs = 20000, idleMs = 45000, maxSessions = 4096, maxFrameBytes = 16 * 1048576, maxQueueBytes = 64 * 1048576 } = {}) {
  const sessions = new Map()
  // Ended sessions for two minutes, so a client's next request learns WHY it ended.
  const ended = new Map()
  const reaper = setInterval(() => {
    const now = Date.now()
    for (const s of sessions.values()) if (!s.waiter && now - s.lastSeen > idleMs) s.end('idle: the client stopped polling')
    for (const [id, e] of ended) if (now - e.at > 120000) ended.delete(id)
  }, 5000)
  reaper.unref()
  const onEnd = (s, reason) => { sessions.delete(s.id); ended.set(s.id, { code: s.endCode, reason: String(reason || '').slice(0, 200), at: Date.now() }); audit('poll-close', { reason: String(reason || '').slice(0, 160) }) }

  async function handle(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    const rest = req.url.slice(POLL_PREFIX.length).split('?')[0]
    try {
      if (rest === 'open') {
        if (sessions.size >= maxSessions) return json(res, 503, { line: '503 Q438 the relay is at its connection limit; try again shortly' })
        let body
        try { body = JSON.parse((await readBody(req, 16384)).toString('utf8') || '{}') } catch { return json(res, 400, { line: '400 Bad Request' }) }
        const p = typeof body.path === 'string' ? body.path : ''
        if (!p.startsWith('/') || p.length > 8192) return json(res, 400, { line: '400 Bad Request' })
        // The upgrade's request, as the gates expect it: its URL is the one a WebSocket would have
        // used; the headers and the peer address are this request's own.
        const fake = { url: p, method: 'GET', headers: { ...req.headers }, socket: req.socket, connection: req.socket }
        const a = await admit(fake)
        if (!a || !a.accept) {
          const line = (a && a.line) || '403 Forbidden'
          return json(res, parseInt(line, 10) || 403, { line })
        }
        const id = crypto.randomBytes(18).toString('base64url')
        const s = new Session(id, { holdMs, idleMs, maxQueueBytes, maxResponseBytes: 4 * 1048576, onEnd })
        sessions.set(id, s)
        audit('poll-open', {})
        // In wss.clients like any socket, so whatever walks the live connections (revoking a token,
        // closing a deleted room) reaches this one too.
        track(s.conn)
        a.accept(s.conn)
        return json(res, 200, { sid: id, holdMs, idleMs, v: POLL_VERSION })
      }
      const [sid, op] = rest.split('/')
      const s = sessions.get(sid)
      if (!s) { const e = ended.get(sid); return gone(res, e && { code: e.code, reason: e.reason }) }
      if (op === 'recv') {
        await readBody(req, 1024)
        return s.recv(res, Number(req.headers['x-hive-ack']) || 0, Number(req.headers['x-hive-hold']) || holdMs)
      }
      if (op === 'send') {
        const first = Number(req.headers['x-hive-seq'])
        if (!Number.isInteger(first) || first < 1) return json(res, 400, { error: 'x-hive-seq' })
        const body = await readBody(req, Math.max(maxFrameBytes, 4 * 1048576) + 65536) // a batch, not one frame: frames are capped per frame by the gates
        let frames
        try { frames = unpackFrames(body) } catch { return json(res, 400, { error: 'malformed frames' }) }
        return s.send(res, first, frames)
      }
      if (op === 'close') {
        await readBody(req, 1024)
        s.end('the client closed')
        return empty(res)
      }
      return json(res, 404, { error: 'unknown' })
    } catch (e) {
      return json(res, e && e.status === 413 ? 413 : 500, { error: e && e.status === 413 ? 'too large' : 'poll error' })
    }
  }
  return { handle, sessions, stop: () => { clearInterval(reaper); for (const s of [...sessions.values()]) s.end('relay shutting down') } }
}
