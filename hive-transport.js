// hive-transport.js -- how a client reaches the relay: a WebSocket where the network allows one, and
// HTTPS long-poll where it does not (wire format and why: hive-poll-proto.js).
//
// HiveSocket is what every provider is given as its WebSocketPolyfill. It behaves like a WebSocket
// to y-websocket and to the mux client (readyState, binaryType, onopen/onmessage/onerror/onclose,
// send, close, terminate), so nothing above it knows or cares which pipe carries the bytes.
//
// THE DECISION, per relay, made once and remembered for the process:
//   - HIVE_TRANSPORT=ws forces WebSocket; HIVE_TRANSPORT=http forces long-poll.
//   - Otherwise a WebSocket first. Only when it fails BEFORE opening, and the failure says a network
//     is in the way (an HTTP answer instead of the upgrade -- "403 WebSocket upgrades are not
//     allowed" on Antigravity's VMs -- or any failure while an HTTP(S) proxy is configured), is the
//     relay's /health read over plain HTTPS. If it offers poll, this socket and every later one to
//     that relay use long-poll. A relay that does not offer it gets the original error, unchanged.
//   - A relay that refused for its own reasons (a bad token, a full room) refuses the poll session
//     the same way, with the same status: there is no loop and no second opinion.
//
// Plain fetch carries the requests. On Node 24 with NODE_USE_ENV_PROXY=1 -- what Antigravity's VMs
// set -- fetch goes through HTTPS_PROXY and trusts NODE_EXTRA_CA_CERTS by itself.
import { WebSocket as WS } from 'ws'
import { POLL_PREFIX, POLL_VERSION, packFrames, unpackFrames } from './hive-poll-proto.js'

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const decided = new Map()   // http origin -> 'ws' | 'poll'
const probes = new Map()    // http origin -> { at, offers: Promise<boolean> }
const reported = new Set()

export function httpOrigin(wsUrl) {
  const u = new URL(wsUrl)
  return `${u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:'}//${u.host}`
}
export function transportMode(env = process.env) {
  const m = String(env.HIVE_TRANSPORT || '').trim().toLowerCase()
  if (m === 'http' || m === 'https' || m === 'poll') return 'poll'
  if (m === 'ws' || m === 'websocket') return 'ws'
  return 'auto'
}
/** Which pipe this process uses for a relay: 'ws', 'poll', or 'ws' until something says otherwise. */
export function transportFor(relay, env = process.env) {
  try {
    const m = transportMode(env)
    if (m !== 'auto') return m
    return decided.get(httpOrigin(relay)) || 'ws'
  } catch { return 'ws' }
}
const proxyConfigured = (env = process.env) => !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
function statusOf(ev) {
  if (!ev) return null
  if (typeof ev.status === 'number') return ev.status
  const m = /Unexpected server response:\s*(\d{3})/.exec(String((ev && (ev.message || (ev.error && ev.error.message))) || ''))
  return m ? Number(m[1]) : null
}

/** Does this relay offer long-poll? Read from /health over plain HTTPS; remembered for a minute. */
export function offersPoll(origin, fetchImpl = globalThis.fetch) {
  const p = probes.get(origin)
  if (p && Date.now() - p.at < 60000) return p.offers
  const offers = (async () => {
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), 15000)
      const r = await fetchImpl(origin + '/health', { signal: ac.signal, headers: { 'cache-control': 'no-store' } }).finally(() => clearTimeout(t))
      if (!r.ok) return false
      const j = await r.json()
      return Number(j && j.poll) >= 1
    } catch { return false }
  })()
  probes.set(origin, { at: Date.now(), offers })
  return offers
}

function fire(target, type, ev) {
  const h = target['on' + type]
  if (typeof h === 'function') { try { h.call(target, ev) } catch (e) { if (process.env.HIVE_DEBUG) console.error('[hive-transport] handler threw:', e) } }
  const ls = target._listeners && target._listeners[type]
  if (ls) for (const fn of [...ls]) { try { fn.call(target, ev) } catch { } }
}
class SocketShape {
  constructor() {
    this.CONNECTING = CONNECTING; this.OPEN = OPEN; this.CLOSING = CLOSING; this.CLOSED = CLOSED
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null
    this._listeners = {}
  }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn) }
  removeEventListener(type, fn) { const l = this._listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) } }
}

/**
 * One connection to the relay over HTTPS requests. A held recv brings the relay's frames the moment
 * they exist; send posts the client's frames in order, numbered so a retry is never applied twice.
 */
export class PollSocket extends SocketShape {
  static CONNECTING = CONNECTING
  static OPEN = OPEN
  static CLOSING = CLOSING
  static CLOSED = CLOSED
  constructor(url, _protocols, opts = {}) {
    super()
    this.url = url
    this.readyState = CONNECTING
    this.binaryType = 'nodebuffer'
    this._fetch = opts.fetch || globalThis.fetch
    const u = new URL(url)
    this._base = httpOrigin(url) + POLL_PREFIX
    this._path = u.pathname + u.search
    this._sid = null
    this._ack = 0          // the last relay frame received
    this._outSeq = 1       // the number of the next frame this client sends
    this._outbox = []
    this._sending = false
    this._hold = 20000
    this._troubleSince = 0
    this._flushQueued = false
    setImmediate(() => { this._open() })
  }
  _req(op, body, headers = {}, timeoutMs = 30000) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const url = this._base + (op === 'open' ? 'open' : `${this._sid}/${op}`)
    return this._fetch(url, { method: 'POST', headers: { 'cache-control': 'no-store', ...headers }, body, signal: ac.signal }).finally(() => clearTimeout(t))
  }
  async _open() {
    if (this.readyState !== CONNECTING) return
    let r
    try { r = await this._req('open', JSON.stringify({ path: this._path, v: POLL_VERSION }), { 'content-type': 'application/json' }, 30000) }
    catch (e) { return this._fail(`could not reach the relay over HTTPS: ${(e && e.cause && e.cause.code) || (e && e.message) || e}`) }
    let j = null
    try { j = await r.json() } catch { }
    if (r.status !== 200 || !j || !j.sid) {
      // Worded like the ws library's handshake error, so statusFromError and every message built on
      // it read a refused session exactly as they read a refused upgrade.
      return this._fail(`Unexpected server response: ${r.status}${j && j.line ? ` (${j.line})` : ''}`, r.status)
    }
    this._sid = j.sid
    this._hold = Math.max(2000, Math.min(Number(j.holdMs) || 20000, 25000))
    if (this.readyState !== CONNECTING) { this._req('close', undefined, {}, 5000).catch(() => { }); return }
    this.readyState = OPEN
    fire(this, 'open', { type: 'open', target: this })
    this._recvLoop()
    this._flush()
  }
  _fail(message, status) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    const error = Object.assign(new Error(message), status ? { status } : {})
    fire(this, 'error', { type: 'error', message, error, status, target: this })
    fire(this, 'close', { type: 'close', code: 1006, reason: message, wasClean: false, target: this })
  }
  _lost(reason, code = 1006) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    if (this._sid) this._req('close', undefined, {}, 5000).catch(() => { })
    fire(this, 'close', { type: 'close', code, reason, wasClean: false, target: this })
  }
  /** The relay ended the session: say why, when it said (a revoked token, a deleted room). */
  async _gone(r) {
    let j = null
    try { j = await r.json() } catch { }
    return this._lost((j && j.reason) || 'the relay ended this session', (j && Number(j.code)) || 1006)
  }
  /** Bytes not yet accepted by the relay, the in-flight batch included (as a WebSocket counts them). */
  get bufferedAmount() { let n = 0; for (const b of this._outbox) n += b.length; return n }
  /** A request failed. Keep trying for 45 s (the relay keeps the session that long), then give up. */
  async _trouble(e, startedAt) {
    const now = Date.now()
    if (!this._troubleSince) this._troubleSince = now
    if (now - this._troubleSince > 45000) { this._lost(`the relay stopped answering over HTTPS: ${(e && e.message) || e}`); return false }
    // A proxy that cuts long requests shows up as a failure after a long wait: hold shorter.
    if (startedAt && now - startedAt > 5000 && this._hold > 4000) this._hold = Math.max(4000, Math.floor(this._hold / 2))
    await sleep(Math.min(2000, 250 * 2 ** Math.min(3, Math.floor((now - this._troubleSince) / 5000))))
    return this.readyState === OPEN
  }
  _ok() { this._troubleSince = 0 }
  async _recvLoop() {
    while (this.readyState === OPEN) {
      const started = Date.now()
      let r
      try { r = await this._req('recv', undefined, { 'x-hive-ack': String(this._ack), 'x-hive-hold': String(this._hold) }, this._hold + 15000) }
      catch (e) { if (!(await this._trouble(e, started))) return; continue }
      if (this.readyState !== OPEN) return
      if (r.status === 404 || r.status === 410) return this._gone(r)
      if (r.status === 204) { this._ok(); continue }
      if (r.status !== 200) { await r.arrayBuffer().catch(() => { }); if (!(await this._trouble(new Error(`HTTP ${r.status}`), started))) return; continue }
      let frames, first
      try { first = Number(r.headers.get('x-hive-seq')); frames = unpackFrames(Buffer.from(await r.arrayBuffer())) }
      catch (e) { if (!(await this._trouble(e, started))) return; continue } // asked again: unacked frames come back
      this._ok()
      for (let i = 0; i < frames.length; i++) {
        const seq = first + i
        if (seq <= this._ack) continue          // already delivered (a resend after a lost answer)
        if (seq !== this._ack + 1) return this._lost(`a gap in the relay's messages (${this._ack}, then ${seq})`)
        this._ack = seq
        const f = frames[i]
        const data = this.binaryType === 'arraybuffer' ? f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) : Buffer.from(f)
        fire(this, 'message', { type: 'message', data, target: this })
        if (this.readyState !== OPEN) return
      }
    }
  }
  send(data) {
    if (this.readyState === CONNECTING) throw new Error('WebSocket is not open: readyState 0 (CONNECTING)')
    if (this.readyState !== OPEN) return
    const b = data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data.buffer ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : data)
    this._outbox.push(Buffer.from(b)) // owned: the caller may reuse its buffer
    if (!this._flushQueued) { this._flushQueued = true; setImmediate(() => { this._flushQueued = false; this._flush() }) }
  }
  async _flush() {
    if (this._sending || !this._outbox.length || this.readyState !== OPEN) return
    this._sending = true
    try {
      while (this._outbox.length && this.readyState === OPEN) {
        let n = 0, bytes = 0
        while (n < this._outbox.length && n < 512 && (n === 0 || bytes + this._outbox[n].length <= 4 * 1048576)) { bytes += this._outbox[n].length; n++ }
        const batch = this._outbox.slice(0, n)
        const first = this._outSeq
        const body = packFrames(batch)
        for (;;) {
          if (this.readyState !== OPEN) return
          const started = Date.now()
          let r
          try { r = await this._req('send', body, { 'content-type': 'application/octet-stream', 'x-hive-seq': String(first) }, 60000) }
          catch (e) { if (!(await this._trouble(e, 0))) return; continue } // the same numbers again: never applied twice
          if (r.status === 404 || r.status === 410) return this._gone(r)
          await r.arrayBuffer().catch(() => { })
          if (r.status === 204 || r.status === 200) break
          if (r.status === 409) return this._lost("the relay saw a gap in this client's messages")
          if (r.status === 400 || r.status === 413) return this._lost(`the relay refused a message (HTTP ${r.status})`)
          if (!(await this._trouble(new Error(`HTTP ${r.status}`), started))) return
        }
        this._ok()
        this._outbox.splice(0, n)
        this._outSeq = first + n
      }
    } finally { this._sending = false }
  }
  close(code = 1000, reason = '') {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return
    const had = !!this._sid
    this.readyState = CLOSED
    if (had) this._req('close', undefined, {}, 5000).catch(() => { })
    setImmediate(() => fire(this, 'close', { type: 'close', code, reason, wasClean: true, target: this }))
  }
  terminate() { this.close(1006, 'terminated') }
}

/**
 * The socket every provider gets: a WebSocket, or long-poll where WebSockets are refused (above).
 */
export class HiveSocket extends SocketShape {
  static CONNECTING = CONNECTING
  static OPEN = OPEN
  static CLOSING = CLOSING
  static CLOSED = CLOSED
  constructor(url, protocols) {
    super()
    this.url = url
    this.protocols = protocols
    this.readyState = CONNECTING
    this._bt = 'nodebuffer'
    this._inner = null
    this._closedByUser = false
    let origin = ''
    try { origin = httpOrigin(url) } catch { }
    this._origin = origin
    const mode = transportMode()
    const pick = mode !== 'auto' ? mode : (decided.get(origin) || 'ws')
    this._attach(pick === 'poll' ? new PollSocket(url, protocols) : new WS(url, protocols), pick)
  }
  get binaryType() { return this._bt }
  set binaryType(v) { this._bt = v; if (this._inner) this._inner.binaryType = v }
  get transport() { return this._kind }
  get bufferedAmount() { return (this._inner && this._inner.bufferedAmount) || 0 }
  _attach(inner, kind) {
    this._inner = inner
    this._kind = kind
    this._early = null
    inner.binaryType = this._bt
    inner.onopen = (ev) => {
      if (this._inner !== inner) return
      this.readyState = OPEN
      if (kind === 'poll' && this._origin && transportMode() === 'auto') decided.set(this._origin, 'poll')
      fire(this, 'open', ev)
    }
    inner.onmessage = (ev) => { if (this._inner === inner) fire(this, 'message', ev) }
    inner.onerror = (ev) => {
      if (this._inner !== inner) return
      if (this.readyState === CONNECTING && kind === 'ws' && transportMode() === 'auto') { this._early = ev; return }
      fire(this, 'error', ev)
    }
    inner.onclose = (ev) => {
      if (this._inner !== inner) return
      if (this.readyState === CONNECTING && kind === 'ws' && transportMode() === 'auto') { this._fallBackOrFail(ev); return }
      this.readyState = CLOSED
      fire(this, 'close', ev)
    }
  }
  async _fallBackOrFail(closeEv) {
    const early = this._early
    const status = statusOf(early)
    const networkInTheWay = status != null || proxyConfigured()
    if (networkInTheWay && this._origin && !this._closedByUser && await offersPoll(this._origin)) {
      if (this._closedByUser) return
      if (!reported.has(this._origin)) {
        reported.add(this._origin)
        console.error(`[hivecode] this network refused a WebSocket to ${this._origin}${status ? ` (HTTP ${status})` : ''}; using HTTPS long-poll instead. Everything works the same, a little slower.`)
      }
      this._attach(new PollSocket(this.url, this.protocols), 'poll')
      return
    }
    this.readyState = CLOSED
    if (early) fire(this, 'error', early)
    fire(this, 'close', closeEv)
  }
  send(data) { return this._inner.send(data) }
  close(code, reason) {
    this._closedByUser = true
    if (this.readyState === CONNECTING && !this._inner) { this.readyState = CLOSED; return }
    try { this._inner.close(code, reason) } catch { }
  }
  terminate() {
    this._closedByUser = true
    try { this._inner.terminate ? this._inner.terminate() : this._inner.close() } catch { }
  }
}
