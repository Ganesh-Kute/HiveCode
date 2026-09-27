// relay-mux.js -- the relay half of ONE socket per participant (wire format: hive-mux-proto.js).
//
// A mux session owns one physical WebSocket and a VirtualConn per open file. server.js decides
// whether each OPEN is admitted -- with the SAME gates a per-file upgrade runs -- and then hands
// the VirtualConn to the SAME accept path, so installUsageLimits, makeReadOnly, installWriteGate,
// the governor and setupWSConnection all see an object indistinguishable from a ws connection.
// This module adds no enforcement of its own beyond what a shared socket needs to stay honest:
//
//   - payloads reach the gates ONLY through emit('message'), as an OWNED Buffer -- a copy, so a
//     write the gate queues to replay later never aliases a reused frame buffer, and a Buffer
//     because that is what a real ws emits, so no gate can read a field this message lacks;
//   - every VirtualConn emits 'close' EXACTLY once, asynchronously (utils' closeConn calls
//     close(), and a synchronous emit would recurse; a double emit double-decrements counters);
//   - readyState is 1 while open (utils treats anything but 0/1 as closed on its first send);
//   - a VirtualConn never emits 'error' (nothing on the relay listens for it on a conn);
//   - ping() answers itself, because liveness belongs to the PHYSICAL socket, which is pinged
//     here and terminated on a missed pong -- and that cascades a close to every channel;
//   - a dying socket closes its channels in batches, since each last-close can persist a doc
//     with writeFileSync and a thousand of those in one tick stalls every room on the relay.
import { EventEmitter } from 'events'
import { F, encodeFrame, decodeFrame } from './hive-mux-proto.js'

const OPEN = 1
const CLOSED = 3

export class VirtualConn extends EventEmitter {
  constructor(session, id, room) {
    super()
    this.setMaxListeners(50)
    this._session = session
    this._id = id
    this._room = room
    this.readyState = OPEN
    this.binaryType = 'nodebuffer'
    this.isVirtual = true
  }
  send(data, opts, cb) {
    if (typeof opts === 'function') cb = opts
    if (this.readyState !== OPEN) { if (cb) process.nextTick(cb, new Error('channel closed')); return }
    this._session.sendFrame(encodeFrame(F.MSG, this._id, data), cb)
  }
  ping() {
    if (this.readyState !== OPEN) return
    setImmediate(() => { if (this.readyState === OPEN) this.emit('pong') })
  }
  /**
   * A channel over its own rate stops the PHYSICAL socket being read (installUsageLimits in
   * server.js), since one channel cannot be paused on a shared socket. That stalls only this
   * participant, only until the channel's held frames drain -- the other way is dropping them.
   */
  pause() { this._session.hold(this, true) }
  resume() { this._session.hold(this, false) }
  close(_code, reason) { this._shut(true, reason) }
  terminate() { this._shut(true) }
  /** The relay side closed it: tell the client, which will reopen it after a back-off. */
  _shut(notifyClient, reason = '') {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    this._session.hold(this, false) // a channel closed while paused must not leave the socket paused
    this._session.forget(this._id, this)
    if (notifyClient) this._session.sendFrame(encodeFrame(F.CLOSED, this._id, reason || ''))
    setImmediate(() => this.emit('close', 1000, Buffer.alloc(0)))
  }
  _deliver(payload) {
    if (this.readyState !== OPEN) return
    this.emit('message', Buffer.from(payload), true)
  }
}

/**
 * Serve one mux socket. `openChannel(id, docName, session)` returns { ok: true } after it has
 * accepted a VirtualConn it created with session.makeConn(id, docName), or { code, reason } to
 * refuse. `onClose()` runs once when the physical socket is gone.
 */
export function serveMux(ws, { baseRoom, openChannel, onClose, audit = () => { }, limits = {} }) {
  const channels = new Map() // id -> VirtualConn
  const maxChannels = limits.maxChannelsPerSocket || 4096
  // Aggregate budget across every channel of this socket. Each channel still has its own
  // per-connection limiter; this stops 8,192 channels x a per-channel rate from being a flood.
  const msgBucket = bucket(limits.msgsPerSec || 4000, limits.msgBurst || 40000)
  const openBucket = bucket(limits.opensPerSec || 1000, limits.openBurst || 10000)
  let alive = true
  let closed = false
  let throttled = 0
  let paused = false
  // Everything currently asking for the socket not to be read: the aggregate budget below and
  // any channel over its own rate. Reading resumes only when NONE of them still holds it, so
  // one holder's resume can never undo another's pause.
  const holders = new Set()
  const AGGREGATE = 'aggregate'
  // ONE WRITE PER TURN, NOT PER FRAME (27 Sep 2026). Every channel of a participant rides this one
  // socket, so a burst -- a first sync, a fan-out of many files' updates -- cost one socket write per
  // frame; a relay profile under 5,000 edits put 30% of its CPU in writev. The socket is corked for
  // the rest of the current event-loop turn and uncorked on the next tick, so everything queued in
  // one turn leaves as one write. Node counts cork() calls, so ws's own per-frame cork nests inside.
  let corked = false
  const uncork = () => { corked = false; try { if (ws._socket) ws._socket.uncork() } catch { } }

  const session = {
    baseRoom,
    get size() { return channels.size },
    sendFrame(bytes, cb) {
      if (ws.readyState !== 1) { if (cb) process.nextTick(cb, new Error('socket closed')); return }
      const sock = ws._socket
      if (sock && !corked) { corked = true; sock.cork(); process.nextTick(uncork) }
      try { ws.send(bytes, { binary: true }, cb) } catch (e) { if (cb) process.nextTick(cb, e) }
    },
    makeConn(id, docName) {
      const vc = new VirtualConn(session, id, docName)
      channels.set(id, vc)
      return vc
    },
    forget(id, vc) { if (channels.get(id) === vc) channels.delete(id) },
    /** Sent BEFORE the accept path runs, so OPENED reaches the client ahead of the relay's step 1. */
    opened(id) { session.sendFrame(encodeFrame(F.OPENED, id)) },
    hold(who, on) {
      const before = holders.size
      if (on) holders.add(who); else holders.delete(who)
      if (!before && holders.size) { try { ws.pause() } catch { } }
      else if (before && !holders.size) { try { ws.resume() } catch { } }
    },
    get holding() { return holders.size },
  }

  ws.on('error', (e) => { audit('mux-socket-error', { baseRoom, reason: e && e.message }) })
  ws.on('pong', () => { alive = true })
  const beat = setInterval(() => {
    if (!alive) { try { ws.terminate() } catch { } return }
    alive = false
    try { ws.ping() } catch { }
    session.sendFrame(encodeFrame(F.BEAT, 0))
  }, 20000)
  if (beat.unref) beat.unref()

  ws.on('message', (data) => {
    let f
    try { f = decodeFrame(data) } catch {
      audit('mux-bad-frame', { baseRoom })
      try { ws.close(1003, 'bad mux frame') } catch { }
      return
    }
    if (f.kind === F.MSG) {
      const vc = channels.get(f.id)
      if (!vc) return // a frame racing its own CLOSE; nothing to deliver it to
      // Over the socket's budget: stop READING it for a moment rather than drop the frame. A
      // dropped Yjs update is a gap that every later update to that file builds on, so the file
      // would wedge silently; backpressure loses nothing and slows a flood down to the budget.
      // (Each channel's own limiter still applies, and still announces itself, as on a socket.)
      if (!msgBucket.take(1) && !paused) {
        paused = true
        if (throttled++ < 2) audit('mux-rate-limit', { baseRoom, reason: 'Q432 aggregate message rate on one participant socket; reading paused' })
        session.hold(AGGREGATE, true)
        const t = setTimeout(() => { paused = false; session.hold(AGGREGATE, false) }, 250)
        if (t.unref) t.unref()
      }
      vc._deliver(f.payload)
    } else if (f.kind === F.OPEN) {
      if (channels.has(f.id)) return session.sendFrame(encodeFrame(F.REFUSED, f.id, 409, 'Q439 channel id already open on this socket'))
      if (channels.size >= maxChannels) return session.sendFrame(encodeFrame(F.REFUSED, f.id, 503, `Q439 this participant already has ${maxChannels} files open (HIVE_MUX_MAX_DOCS)`))
      if (!openBucket.take(1)) return session.sendFrame(encodeFrame(F.REFUSED, f.id, 503, 'Q432 opening files too fast on one socket; backing off'))
      let r
      try { r = openChannel(f.id, f.docName, session) } catch (e) { r = { code: 500, reason: `open failed: ${e && e.message}` } }
      if (!r || !r.ok) {
        // A throw can land AFTER makeConn: the channel would stay registered while the client is
        // told REFUSED, and its retry under the same id would then meet 409 forever. Shut whatever
        // was made (it emits close once, so any counter it took is given back) before refusing.
        const made = channels.get(f.id)
        if (made) { try { made._shut(false) } catch { } }
        session.sendFrame(encodeFrame(F.REFUSED, f.id, (r && r.code) || 500, (r && r.reason) || 'refused'))
      }
    } else if (f.kind === F.CLOSE) {
      const vc = channels.get(f.id)
      if (vc) vc._shut(false)
    }
  })

  ws.on('close', () => {
    if (closed) return
    closed = true
    clearInterval(beat)
    const all = [...channels.values()]
    channels.clear()
    // In batches: see the header.
    const step = () => {
      for (const vc of all.splice(0, 64)) { try { vc._shut(false) } catch { } }
      if (all.length) setImmediate(step)
    }
    step()
    try { onClose && onClose() } catch { }
  })
  return session
}

function bucket(rate, burst) {
  let tokens = burst
  let last = Date.now()
  return {
    take(n) {
      const now = Date.now()
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate)
      last = now
      if (tokens < n) return false
      tokens -= n
      return true
    },
  }
}
