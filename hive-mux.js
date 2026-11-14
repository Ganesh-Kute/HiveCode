// hive-mux.js -- the client half of ONE socket per participant (wire format: hive-mux-proto.js).
//
// sync.js asks this module for a provider per file doc and gets back an object with the surface
// it already used from y-websocket's WebsocketProvider: `synced`, the 'sync' / 'status' /
// 'connection-error' / 'connection-close' events, and destroy(). Behind it is EITHER a channel
// on the participant's one mux socket, or -- when the relay does not advertise mux in /health,
// or HIVE_MUX=0 -- a plain per-file WebsocketProvider exactly as before. An old relay therefore
// keeps working with a new client, and the choice is made once per session, before any file
// socket exists, so a room never ends up half on one transport by accident.
//
// Inside a channel the y-protocols exchange is the one y-websocket performs: on admission send
// sync step 1, answer the relay's step 1, count the session synced when step 2 arrives, forward
// local updates, never echo an update this provider applied. A refused OPEN is reported as a
// 'connection-error' carrying the same HTTP status a refused per-file upgrade carried, so every
// piece of refusal reporting in sync.js (Q430/Q431 counts, notSyncing, explain()) works unchanged.
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { ObservableV2 } from 'lib0/observable'
import { WebsocketProvider } from 'y-websocket'
import { F, encodeFrame, decodeFrame, muxPath, MUX_VERSION } from './hive-mux-proto.js'
import { relayFetch } from './hive-transport.js' // /health through the proxy, as the sockets go

const messageSync = 0

export const httpBase = (relay) => String(relay).replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '')

/** The provider sync.js holds per file. Delegates to a mux channel or a legacy provider. */
class FileProvider extends ObservableV2 {
  constructor(docName, doc) {
    super()
    this.docName = docName
    this.doc = doc
    this.destroyed = false
    this._impl = null
  }
  get synced() { return !!(this._impl && this._impl.synced) }
  get wsconnected() { return !!(this._impl && this._impl.wsconnected) }
  /** Bytes handed to this file's socket that the relay has not accepted yet (0.14.3 P0-1). */
  get bufferedAmount() { return (this._impl && this._impl.bufferedAmount) || 0 }
  get transport() { return this._impl ? this._impl.transport : 'pending' }
  _bindLegacy(relay, wsOpts, onAuthFailure) {
    const p = new WebsocketProvider(relay, this.docName, this.doc, wsOpts)
    for (const ev of ['sync', 'status', 'connection-error', 'connection-close']) p.on(ev, (...args) => this.emit(ev, args))
    p.on('connection-close', (ev) => {
      if (ev && (ev.code === 4401 || ev.code === 4403)) {
        const refreshed = onAuthFailure ? onAuthFailure(ev.code, ev.reason || 'token revoked or expired') : false
        if (!refreshed) {
          p.shouldConnect = false
          queueMicrotask(() => { try { p.disconnect() } catch { } })
        } else {
          queueMicrotask(() => { if (!this.destroyed && !p.shouldConnect) { try { p.connect() } catch { } } })
        }
      }
    })
    this._impl = {
      transport: 'socket',
      get synced() { return p.synced },
      get wsconnected() { return p.wsconnected },
      get bufferedAmount() { return (p.ws && p.ws.bufferedAmount) || 0 },
      setToken: (tok) => {
        if (!p.params) p.params = {}
        if (tok) p.params.token = tok
        else delete p.params.token
        if (!this.destroyed && !p.shouldConnect) {
          try { p.connect() } catch { }
        }
      },
      destroy: () => p.destroy(),
    }
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    try { if (this._impl) this._impl.destroy() } catch { }
    super.destroy()
  }
}

class Channel {
  constructor(mux, id, docName, doc, facade) {
    this.mux = mux
    this.id = id
    this.docName = docName
    this.doc = doc
    this.facade = facade
    this.transport = 'mux'
    this.opened = false
    this.synced = false
    this.retries = 0
    this.retryTimer = null
    this.destroyed = false
    this._onUpdate = (update, origin) => {
      if (origin === this.facade || !this.opened) return // gaps are closed by the next step1/step2
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, messageSync)
      syncProtocol.writeUpdate(e, update)
      this.mux.send(encodeFrame(F.MSG, this.id, encoding.toUint8Array(e)))
    }
    doc.on('update', this._onUpdate)
  }
  get wsconnected() { return this.opened && this.mux.connected }
  get bufferedAmount() { return (this.mux.ws && this.mux.ws.bufferedAmount) || 0 }
  sendOpen() {
    if (this.destroyed || !this.mux.connected) return
    clearTimeout(this.retryTimer); this.retryTimer = null
    this.mux.send(encodeFrame(F.OPEN, this.id, this.docName))
  }
  retryLater() {
    if (this.destroyed || this.retryTimer) return
    // Refused or closed by the relay: back off, like the per-file provider did, but further --
    // an OPEN is cheap to send and a relay at capacity should not be asked 40 times a second.
    const ms = Math.min(15000, 500 * 2 ** Math.min(this.retries++, 5))
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.sendOpen() }, ms)
    if (this.retryTimer.unref) this.retryTimer.unref()
  }
  onFrame(f) {
    if (this.destroyed) return
    if (f.kind === F.OPENED) {
      this.opened = true
      this.retries = 0
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, messageSync)
      syncProtocol.writeSyncStep1(e, this.doc)
      this.mux.send(encodeFrame(F.MSG, this.id, encoding.toUint8Array(e)))
      this.facade.emit('status', [{ status: 'connected' }])
    } else if (f.kind === F.MSG) {
      try { this.onMessage(f.payload) } catch (e) {
        // A message this doc could not apply. Skipping it would leave a gap that every later
        // update builds on, silently; reopening makes the relay run the sync exchange again,
        // and that carries whatever was missed.
        this.mux.log(`[hive] could not apply a relay message for ${JSON.stringify(this.docName)} (${e && e.message}); resyncing it`)
        this.reopen()
      }
    } else if (f.kind === F.REFUSED) {
      this.opened = false
      this.facade.emit('connection-error', [{ code: f.code, status: f.code, reason: f.reason, message: `Unexpected server response: ${f.code} ${f.reason}` }])
      if (f.code === 401 || f.code === 403) {
        const refreshed = this.mux.onAuthFailure ? this.mux.onAuthFailure(f.code, f.reason || 'refused') : false
        if (!refreshed) return
      }
      this.retryLater()
    } else if (f.kind === F.CLOSED) {
      this.lost({ code: 4000, reason: f.reason })
      this.retryLater()
    }
  }
  onMessage(payload) {
    let d
    try { d = decoding.createDecoder(payload) } catch { return }
    const type = decoding.readVarUint(d)
    if (type !== messageSync) return // awareness/auth/query: file docs carry no presence
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, messageSync)
    const t = syncProtocol.readSyncMessage(d, e, this.doc, this.facade)
    if (t === syncProtocol.messageYjsSyncStep2 && !this.synced) {
      this.synced = true
      this.facade.emit('sync', [true])
    }
    if (encoding.length(e) > 1) this.mux.send(encodeFrame(F.MSG, this.id, encoding.toUint8Array(e)))
  }
  reopen() {
    if (this.destroyed) return
    if (this.mux.connected) this.mux.send(encodeFrame(F.CLOSE, this.id))
    this.lost({ code: 4001, reason: 'resync' })
    this.retryLater()
  }
  /** The channel is gone (socket dropped, or the relay closed it); a reconnect will reopen it. */
  lost(ev = null) {
    const wasOpen = this.opened
    this.opened = false
    if (this.synced) { this.synced = false; this.facade.emit('sync', [false]) }
    if (wasOpen) {
      this.facade.emit('connection-close', [ev])
      this.facade.emit('status', [{ status: 'disconnected' }])
    }
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    clearTimeout(this.retryTimer)
    try { this.doc.off('update', this._onUpdate) } catch { }
    if (this.mux.connected) this.mux.send(encodeFrame(F.CLOSE, this.id))
    this.mux.channels.delete(this.id)
  }
}

/** The participant's one physical socket, carrying a channel per open file doc. */
class MuxConnection {
  constructor({ relay, room, params, WebSocketPolyfill, log, onRefused, onAuthFailure }) {
    this.relay = relay
    this.room = room
    this.params = { ...(params || {}) }
    this.url = this._buildUrl()
    this.WS = WebSocketPolyfill
    this.log = log || (() => { })
    this.onRefused = onRefused || (() => { })
    this.onAuthFailure = onAuthFailure || null
    this.authStopped = false
    this.channels = new Map()
    this.nextId = 1
    this.ws = null
    this.connected = false
    this.connecting = false
    this.destroyed = false
    this.failures = 0
    this.lastHeard = 0
    this.reconnectTimer = null
    // The relay sends a BEAT every 20s; 45s of silence means the socket is dead even if the OS
    // has not said so, which is exactly the half-open state a laptop lid produces.
    this.liveness = setInterval(() => {
      // terminate, not close: a close handshake cannot complete on a dead link, and ws waits 30s more for it
      if (this.connected && Date.now() - this.lastHeard > 45000) { try { this.ws.terminate ? this.ws.terminate() : this.ws.close() } catch { } }
    }, 5000)
    if (this.liveness.unref) this.liveness.unref()
  }
  channel(docName, doc, facade) {
    const ch = new Channel(this, this.nextId++, docName, doc, facade)
    this.channels.set(ch.id, ch)
    if (this.connected) ch.sendOpen()
    else this.connect()
    return ch
  }
  send(bytes) {
    if (!this.connected || !this.ws) return
    try { this.ws.send(bytes) } catch { /* the close handler takes it from here */ }
  }
  _buildUrl() {
    const q = new URLSearchParams({ ...(this.params || {}), mux: String(MUX_VERSION) })
    return `${String(this.relay).replace(/\/+$/, '')}/${muxPath(this.room)}?${q}`
  }
  setToken(tok) {
    if (tok) this.params.token = tok
    else delete this.params.token
    this.url = this._buildUrl()
    this.authStopped = false
  }
  connect() {
    if (this.destroyed || this.authStopped || this.connected || this.connecting) return
    this.url = this._buildUrl()
    this.connecting = true
    let ws
    try { ws = new this.WS(this.url) } catch (e) { this.connecting = false; this.scheduleReconnect(); return }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.connecting = false
      this.connected = true
      this.failures = 0
      this.lastHeard = Date.now()
      for (const ch of this.channels.values()) ch.sendOpen()
    }
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      this.lastHeard = Date.now()
      let f
      try { f = decodeFrame(new Uint8Array(ev.data)) } catch { return }
      if (f.kind === F.BEAT) return
      const ch = this.channels.get(f.id)
      if (ch) ch.onFrame(f)
    }
    ws.onerror = (ev) => {
      if (this.ws !== ws) return
      // A refused UPGRADE of the mux socket itself (401/402/403/429/503) refuses every file on it.
      // Hand each unsynced channel the same event a refused per-file socket produced.
      const m = /Unexpected server response:\s*(\d{3})/.exec((ev && (ev.message || (ev.error && ev.error.message))) || '')
      const code = (m ? Number(m[1]) : null) || (ev && ev.status) || null
      for (const ch of this.channels.values()) {
        if (!ch.synced) ch.facade.emit('connection-error', [{ code, status: code, message: (ev && ev.message) || 'mux socket error' }])
      }
      if (code === 401 || code === 403) {
        const refreshed = this.onAuthFailure ? this.onAuthFailure(code, `HTTP ${code}`) : false
        if (!refreshed) {
          this.authStopped = true
          this.destroyed = true
          return
        }
      }
      if (code) this.onRefused(code)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.connected = false
      this.connecting = false
      for (const ch of this.channels.values()) ch.lost(ev)
      if (ev && (ev.code === 4401 || ev.code === 4403)) {
        const refreshed = this.onAuthFailure ? this.onAuthFailure(ev.code, ev.reason || 'token revoked or expired') : false
        if (!refreshed) {
          this.authStopped = true
          this.destroyed = true
          return
        }
      }
      if (!this.destroyed && !this.authStopped) this.scheduleReconnect()
    }
  }
  scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer || !this.channels.size) return
    const ms = Math.min(5000, 100 * 2 ** Math.min(this.failures++, 6))
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, ms)
    if (this.reconnectTimer.unref) this.reconnectTimer.unref()
  }
  destroy() {
    this.destroyed = true
    clearInterval(this.liveness)
    clearTimeout(this.reconnectTimer)
    const ws = this.ws
    this.ws = null
    // Disconnected FIRST: closing the socket ends every channel on the relay at once, so no
    // channel sends a CLOSE frame of its own down a socket that is about to go.
    this.connected = false
    for (const ch of [...this.channels.values()]) { try { ch.destroy() } catch { } }
    try { if (ws) ws.close() } catch { }
  }
}

/**
 * One per startSync. provide(docName, doc) returns the provider for a file doc; the transport is
 * decided once -- HIVE_MUX=1 forces mux, HIVE_MUX=0 forces a socket per file, anything else asks
 * the relay's /health -- and file providers created before the answer are bound when it comes.
 */
export function createFileTransport({ relay, room, wsOpts = {}, log = () => { }, env = process.env, fetchImpl = relayFetch, onFallback = () => { }, onAuthFailure = null, retryMs = 1000, detectForMs = 90000 }) {
  const forced = env.HIVE_MUX === '0' || env.HIVE_MUX === '1'
  let mode = env.HIVE_MUX === '0' ? 'socket' : env.HIVE_MUX === '1' ? 'mux' : null
  let mux = null
  let stopped = false
  const pending = new Set()
  const allProviders = new Set()
  const health = () => Promise.resolve()
    .then(() => fetchImpl(`${httpBase(relay)}/health`, { signal: AbortSignal.timeout(20000) }))
    .then((r) => (r && r.ok ? r.json() : null))
  const offersMux = (j) => !!j && Number(j.mux) >= MUX_VERSION

  // THE KILL SWITCH HAS TO REACH CLIENTS THAT ARE ALREADY CONNECTED. A relay that stops serving
  // mux -- an operator setting HIVE_RELAY_MUX=off, or a rollback to a build that predates it --
  // refuses the mux socket from then on, and without this every file would stay refused until
  // the agent restarted. A 404 says so outright. Any other refusal is checked against /health, at
  // most once a minute, because a relay that predates mux reads the mux path as a room name and
  // refuses the token -- a 401 that looks exactly like a real one.
  let lastCheck = 0
  const onRefused = (code) => {
    if (forced || stopped || mode !== 'mux') return
    if (code === 404) return fallBack('the relay no longer serves one-socket mode (404)')
    const now = Date.now()
    if (now - lastCheck < 60000) return
    lastCheck = now
    health().then((j) => { if (j && !offersMux(j)) fallBack('the relay stopped offering one-socket mode') }, () => { })
  }
  const fallBack = (why) => {
    if (stopped || mode !== 'mux') return
    mode = 'socket'
    log(`[hive] ${why}: falling back to a socket per file`)
    // sync.js lets go of every file beyond the per-file bound FIRST. Without that, a client holding
    // 900 files on one socket would open 900 sockets at once -- the storm the bound exists to stop.
    try { onFallback() } catch { }
    const moving = mux ? [...mux.channels.values()].map((ch) => ch.facade) : []
    try { if (mux) mux.destroy() } catch { }
    mux = null
    for (const fp of moving) { if (!fp.destroyed) fp._bindLegacy(relay, wsOpts, onAuthFailure) }
  }
  const bind = (fp) => {
    if (fp.destroyed) return
    if (mode === 'mux') {
      if (!mux) mux = new MuxConnection({ relay, room, params: wsOpts.params, WebSocketPolyfill: wsOpts.WebSocketPolyfill, log, onRefused, onAuthFailure })
      fp._impl = mux.channel(fp.docName, fp.doc, fp)
    } else {
      fp._bindLegacy(relay, wsOpts, onAuthFailure)
    }
  }
  let resolveReady
  const ready = new Promise((r) => { resolveReady = r })
  const decide = (m) => {
    if (!mode) mode = m
    for (const fp of pending) bind(fp)
    pending.clear()
    resolveReady(mode)
  }
  // ONLY AN ANSWER DECIDES. A free Render instance takes 30-60s to wake and says nothing at all
  // meanwhile; reading that silence as "no mux" pinned the whole session to a socket per file.
  // So silence (a timeout, a refused connection, a 5xx from a proxy fronting a booting service) is
  // asked again for up to ~90s. Any real answer decides at once -- including an old relay's
  // plain-text /health, which is a relay that has never heard of mux. Out of time: a socket per
  // file, the transport every relay has always spoken.
  const detect = async () => {
    const deadline = Date.now() + detectForMs
    for (let wait = retryMs; ; wait = Math.min(wait * 2, 15000)) {
      try {
        const r = await fetchImpl(`${httpBase(relay)}/health`, { signal: AbortSignal.timeout(20000) })
        if (r && r.status < 500) {
          let j = null
          try { j = JSON.parse(await r.text()) } catch { /* not JSON: an old relay, or not a relay */ }
          return r.ok && offersMux(j) ? 'mux' : 'socket'
        }
      } catch { /* no answer yet */ }
      if (stopped || Date.now() + wait > deadline) return 'socket'
      await new Promise((res) => { const t = setTimeout(res, wait); if (t.unref) t.unref() })
    }
  }
  if (mode) resolveReady(mode)
  else detect().then(decide, () => decide('socket'))
  return {
    ready,
    get mode() { return mode || 'detecting' },
    provide(docName, doc) {
      const fp = new FileProvider(docName, doc)
      allProviders.add(fp)
      if (mode) bind(fp)
      else pending.add(fp)
      return fp
    },
    setToken(tok) {
      if (!wsOpts.params) wsOpts.params = {}
      if (tok) wsOpts.params.token = tok
      else delete wsOpts.params.token
      if (mux) mux.setToken(tok)
      for (const fp of allProviders) {
        if (fp.destroyed) { allProviders.delete(fp); continue }
        if (fp._impl && typeof fp._impl.setToken === 'function') fp._impl.setToken(tok)
      }
    },
    stats() { return { mode: mode || 'detecting', channels: mux ? mux.channels.size : 0, muxConnected: !!(mux && mux.connected) } },
    stop() {
      stopped = true
      try { if (mux) mux.destroy() } catch { }
      for (const fp of allProviders) { try { if (!fp.destroyed) fp.destroy() } catch { } }
      allProviders.clear()
    },
  }
}
