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
//
// AN EXPLICIT PROXY (Claude-cloud, 8 Nov 2026). Where the only way out is a forward proxy named in
// HTTPS_PROXY (Claude Code cloud containers, CI runners, company laptops), outside host names do not
// even resolve. `ws` never reads HTTPS_PROXY, and fetch ignores it unless NODE_USE_ENV_PROXY=1 was
// set when node started, so the WebSocket died with ENOTFOUND, the long-poll probe died the same
// way, and hive_join said "the relay refused the connection" about a relay it never reached. Now:
//   - proxyFor(url) picks the proxy: HIVE_PROXY (a URL, or off), else HTTPS_PROXY for wss:/https:
//     and HTTP_PROXY for ws:/http:. NO_PROXY is honoured; loopback never goes through a proxy,
//     including where node's env-proxy mode would send it there (directFetch).
//   - Both pipes ride an HTTP CONNECT tunnel through it: the WebSocket (an agent for `ws`) and the
//     long-poll requests (fetchFor). Through a tunnel to a wss:// relay the proxy sees only
//     "CONNECT host:443"; the path and query -- where the room token rides -- stay inside TLS.
//   - A tunnel that fails says so: unreachedReason() tells "never reached the relay" (DNS, the
//     proxy refused CONNECT, the proxy itself unreachable) apart from a relay that answered and
//     refused. A proxy's 403/407 deliberately carries no `status`: statusFromError would read it as
//     the relay's own 403 and explain a proxy problem as a bad token. Proxy credentials are sent
//     and never printed.
import http from 'http'
import https from 'https'
import net from 'net'
import tls from 'tls'
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
const PROXY_OFF = /^(off|0|false|no|none|direct)$/i
const proxyConfigured = (env = process.env) => {
  const hive = String(env.HIVE_PROXY || '').trim()
  if (hive) return !PROXY_OFF.test(hive)
  return !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
}

// ---- the proxy, when there is one -----------------------------------------------------------

const bareHost = (h) => String(h || '').replace(/^\[|\]$/g, '').toLowerCase()
const isLoopback = (h) => h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0:0:0:0:0:0:0:1'

/** curl's NO_PROXY rules: "*", "host", ".suffix" / "*.suffix", "host:port", "[v6]:port"; a bare name also covers its subdomains. */
function noProxyMatches(host, port, list) {
  for (const raw of String(list).split(/[\s,]+/)) {
    const e = raw.trim().toLowerCase()
    if (!e) continue
    if (e === '*') return true
    let h = e, p = ''
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(e)
    if (v6) { h = v6[1]; p = v6[2] || '' }
    else if ((e.match(/:/g) || []).length === 1) { [h, p] = e.split(':') }
    if (p && p !== String(port)) continue
    h = h.replace(/^\*\./, '.')
    if (h.startsWith('.') ? (host === h.slice(1) || host.endsWith(h)) : (host === h || host.endsWith('.' + h))) return true
  }
  return false
}

/** The proxy to reach `target` (a ws:, wss:, http: or https: URL) through, as a URL, or null for direct. */
export function proxyFor(target, env = process.env) {
  let u
  try { u = new URL(target) } catch { return null }
  const secure = u.protocol === 'wss:' || u.protocol === 'https:'
  const host = bareHost(u.hostname)
  const port = u.port || (secure ? '443' : '80')
  if (!host || isLoopback(host)) return null
  const hive = String(env.HIVE_PROXY || '').trim()
  if (hive && PROXY_OFF.test(hive)) return null
  const raw = hive || (secure ? (env.HTTPS_PROXY || env.https_proxy) : (env.HTTP_PROXY || env.http_proxy))
  if (!raw) return null
  const np = env.NO_PROXY != null ? env.NO_PROXY : env.no_proxy
  if (np && noProxyMatches(host, port, np)) return null
  try {
    const p = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    return p.protocol === 'http:' || p.protocol === 'https:' ? p : null
  } catch { return null }
}

/** host:port of a proxy, never its user:pass. */
const proxyLabel = (p) => `${p.hostname}:${p.port || (p.protocol === 'https:' ? 443 : 80)}`

function unreachedError(proxy, detail, extra = {}) {
  // No `status` here, on purpose (see the header): this is the proxy talking, not the relay.
  return Object.assign(new Error(`never reached the relay: proxy ${proxyLabel(proxy)} ${detail}`), { hiveUnreached: true, proxy: proxyLabel(proxy) }, extra)
}

/** An HTTP CONNECT tunnel to host:port through `proxy`: resolves with the raw socket at the far end. */
function openTunnel(proxy, host, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const target = `${net.isIPv6(host) ? `[${host}]` : host}:${port}`
    const headers = { host: target }
    if (proxy.username || proxy.password) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(cred).toString('base64')
    }
    const secureProxy = proxy.protocol === 'https:'
    const req = (secureProxy ? https : http).request({
      host: bareHost(proxy.hostname), port: proxy.port || (secureProxy ? 443 : 80),
      method: 'CONNECT', path: target, headers, agent: false,
    })
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v) } }
    const timer = setTimeout(() => {
      req.destroy()
      done(reject, unreachedError(proxy, `did not answer CONNECT ${target} within ${Math.round(timeoutMs / 1000)}s`, { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    req.once('connect', (res, sock, head) => {
      if (res.statusCode !== 200) {
        sock.destroy()
        const hint = res.statusCode === 407 ? ' (it wants credentials: put user:pass in the proxy URL)' : ''
        return done(reject, unreachedError(proxy, `refused CONNECT ${target} with HTTP ${res.statusCode}${hint}`, { proxyStatus: res.statusCode }))
      }
      // Bytes the far end already sent after the proxy's 200 belong to the tunnelled stream.
      if (head && head.length) sock.unshift(head)
      done(resolve, sock)
    })
    req.once('error', (e) => done(reject, unreachedError(proxy, `could not be reached: ${(e && (e.code || e.message)) || e}`, { code: e && e.code })))
    req.end()
  })
}

const TLS_KEYS = ['ca', 'cert', 'key', 'pfx', 'passphrase', 'rejectUnauthorized', 'ciphers', 'ALPNProtocols', 'minVersion', 'maxVersion', 'secureContext', 'checkServerIdentity', 'session']
const agents = new Map()
/**
 * An http(s).Agent whose every connection is a CONNECT tunnel through `proxy` (TLS on top for wss:/https:).
 * kind 'fetch' keeps tunnels alive for the long-poll requests; kind 'ws' never reuses one, so a
 * WebSocket upgrade always gets a tunnel of its own and never rides one a poll request opened.
 */
function tunnelAgent(proxy, secure, kind = 'fetch') {
  const key = `${kind}|${secure ? 's' : 'p'}|${proxy.href}`
  let a = agents.get(key)
  if (a) return a
  a = new (secure ? https.Agent : http.Agent)(kind === 'fetch' ? { keepAlive: true, maxFreeSockets: 4 } : { keepAlive: false })
  a.createConnection = (opts, cb) => {
    const host = bareHost(opts.host || opts.hostname)
    const port = Number(opts.port) || (secure ? 443 : 80)
    openTunnel(proxy, host, port).then((sock) => {
      if (!secure) return cb(null, sock)
      const t = { socket: sock, host, servername: opts.servername || (net.isIP(host) ? undefined : host) }
      for (const k of TLS_KEYS) if (opts[k] !== undefined) t[k] = opts[k]
      cb(null, tls.connect(t))
    }, (e) => cb(e))
  }
  agents.set(key, a)
  return a
}

/** A fetch-shaped call carried over the tunnel agent: just what offersPoll and PollSocket use. */
function proxyFetch(proxy, url, init = {}) {
  return agentFetch(url, init, (secure) => tunnelAgent(proxy, secure))
}

// DIRECT MEANS DIRECT, EVEN WHERE NODE APPLIES THE ENV PROXY ITSELF. With env-proxy mode on
// (NODE_USE_ENV_PROXY=1 or --use-env-proxy, what Antigravity's VMs run), the built-in fetch AND http's
// global agent send every request through http(s)_proxy unless node's own NO_PROXY exempts it. So a
// call proxyFor() had decided was direct -- loopback, a NO_PROXY match, HIVE_PROXY=off -- went to the
// proxy anyway: a self-hosted relay on localhost was "unreachable" for an invite revoke or the /health
// probe while its WebSockets worked (antigravity-VM, 9 Nov 2026; tests/loopback-direct-fetch-test.mjs).
// Measured on node 22.23 and 24.22: an agent of our own is never proxied. Used only in env-proxy mode,
// so everywhere else a direct call is still the built-in fetch, exactly as before.
// Node fixes the mode ONCE, AT STARTUP: clearing NODE_USE_ENV_PROXY later does not turn it off (a
// first version read it per call, and proxy-fetch-test, which clears it mid-run, still went to the
// proxy). So the mode is read when this module loads -- the nearest point to node's own decision --
// and a per-call env can only add it, never take it away.
const envProxyIn = (env) => {
  if (/^(1|true|yes|on)$/i.test(String((env && env.NODE_USE_ENV_PROXY) || '').trim())) return true
  return /(^|\s)--use-env-proxy(\s|=|$)/.test(String((env && env.NODE_OPTIONS) || ''))
}
const ENV_PROXY_AT_START = envProxyIn(process.env) || process.execArgv.includes('--use-env-proxy')
const envProxyMode = (env = process.env) => ENV_PROXY_AT_START || envProxyIn(env)
const directAgents = new Map()
function directAgent(secure) {
  let a = directAgents.get(secure)
  if (!a) { a = new (secure ? https.Agent : http.Agent)({ keepAlive: true, maxFreeSockets: 4 }); directAgents.set(secure, a) }
  return a
}
function directFetch(url, init = {}) {
  return agentFetch(url, init, directAgent)
}

/** The request behind proxyFetch and directFetch: `agentFor(secure)` picks the agent that carries it. */
function agentFetch(url, init, agentFor) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const secure = u.protocol === 'https:'
    const body = init.body == null ? null : Buffer.from(init.body)
    const headers = { ...(init.headers || {}) }
    if (body) headers['content-length'] = String(body.length)
    const req = (secure ? https : http).request(u, { method: init.method || 'GET', headers, agent: agentFor(secure) }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('error', reject)
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v) } },
          json: async () => JSON.parse(buf.toString('utf8')),
          text: async () => buf.toString('utf8'),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        })
      })
    })
    req.on('error', reject)
    const sig = init.signal
    if (sig) {
      // Like the built-in fetch: reject with the signal's reason (AbortSignal.timeout gives a
      // TimeoutError, which callers such as hive-setup's wakeRelay test for by name).
      const abort = () => req.destroy(sig.reason instanceof Error ? sig.reason : Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      if (sig.aborted) abort(); else sig.addEventListener('abort', abort, { once: true })
    }
    req.end(body || undefined)
  })
}

/** The fetch to reach `url` with: through the proxy tunnel when one applies, else direct (see directFetch). */
export function fetchFor(url, env = process.env) {
  const p = proxyFor(url, env)
  if (p) return (u, init) => proxyFetch(p, u, init)
  return envProxyMode(env) ? directFetch : globalThis.fetch
}

/**
 * fetch(url, init) for ANY call to the relay: the route (proxy tunnel, or direct) is chosen per call
 * from the environment at that moment. Every plain HTTP call to the relay goes through this; the
 * built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 was set when node started
 * (Claude-cloud, 8 Nov 2026: hive-mux's /health probe failing behind a proxy held every file ~75 s).
 */
export function relayFetch(url, init) {
  const f = fetchFor(String(url))
  if (typeof f !== 'function') return Promise.reject(new Error('no fetch available in this runtime'))
  return f(url, init)
}

const UNREACHED_CODES = {
  ENOTFOUND: 'its host name did not resolve (DNS)',
  EAI_AGAIN: 'its host name did not resolve (DNS, temporary failure)',
  ECONNREFUSED: 'nothing accepted the connection',
  ETIMEDOUT: 'the connection timed out',
  EHOSTUNREACH: 'there is no route to its host',
  ENETUNREACH: 'there is no route to its network',
}
/**
 * If a connection error means the relay was NEVER REACHED -- DNS, no route, the proxy refused or was
 * itself unreachable -- say so in one line; null when the relay answered (or it cannot be told).
 * Takes an Error or the event a socket's onerror got.
 */
export function unreachedReason(x) {
  const e = x && (x.error instanceof Error ? x.error : x)
  if (!e || typeof e !== 'object') return null
  if (e.hiveUnreached) return String(e.message)
  const code = e.code || (e.cause && e.cause.code)
  const why = typeof code === 'string' && UNREACHED_CODES[code]
  if (!why) return null
  const host = e.hostname || (e.cause && e.cause.hostname) || e.address
  let s = `never reached the relay: ${why}${host ? ` (${host})` : ''} [${code}]`
  if ((code === 'ENOTFOUND' || code === 'EAI_AGAIN') && !proxyConfigured()) s += '. If this machine reaches the internet only through a proxy, set HTTPS_PROXY (or HIVE_PROXY) to it.'
  return s
}
function statusOf(ev) {
  if (!ev) return null
  if (typeof ev.status === 'number') return ev.status
  const m = /Unexpected server response:\s*(\d{3})/.exec(String((ev && (ev.message || (ev.error && ev.error.message))) || ''))
  return m ? Number(m[1]) : null
}

/** Does this relay offer long-poll? Read from /health over plain HTTPS; remembered for a minute. */
export function offersPoll(origin, fetchImpl = fetchFor(origin)) {
  // Keyed by the route too: an answer read through one proxy (or directly) says nothing about another.
  const via = proxyFor(origin)
  const key = `${via ? via.href : 'direct'}|${origin}`
  const p = probes.get(key)
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
  probes.set(key, { at: Date.now(), offers })
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
    this._fetch = opts.fetch || fetchFor(url)
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
    catch (e) {
      // The tunnel said why the relay was never reached: keep that, so unreachedReason() still can.
      if (e && e.hiveUnreached) return this._fail(e.message, undefined, { hiveUnreached: true, proxy: e.proxy, proxyStatus: e.proxyStatus, code: e.code })
      return this._fail(`could not reach the relay over HTTPS: ${(e && e.cause && e.cause.code) || (e && e.message) || e}`, undefined, e && e.cause && e.cause.code ? { code: e.cause.code, hostname: e.cause.hostname } : null)
    }
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
  _fail(message, status, extra = null) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    const error = Object.assign(new Error(message), extra || {}, status ? { status } : {})
    fire(this, 'error', { type: 'error', message, error, status, target: this })
    fire(this, 'close', { type: 'close', code: 1006, reason: message, wasClean: false, target: this })
  }
  _lost(reason, code = 1006) {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSED
    clearTimeout(this._closeTimer)
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
    return this.readyState === OPEN || this.readyState === CLOSING
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
    const live = () => this.readyState === OPEN || this.readyState === CLOSING
    if (this._sending || !this._outbox.length || !live()) { this._closeIfDrained(); return }
    this._sending = true
    try {
      while (this._outbox.length && live()) {
        let n = 0, bytes = 0
        while (n < this._outbox.length && n < 512 && (n === 0 || bytes + this._outbox[n].length <= 4 * 1048576)) { bytes += this._outbox[n].length; n++ }
        const batch = this._outbox.slice(0, n)
        const first = this._outSeq
        const body = packFrames(batch)
        for (;;) {
          if (!live()) return
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
    } finally { this._sending = false; this._closeIfDrained() }
  }
  // CLOSE DELIVERS WHAT WAS SENT FIRST, as a WebSocket's does (0.14.3 P0-1). A WebSocket hands its
  // bytes to the OS on send(), so ws.close() still delivers them; this socket keeps them in _outbox
  // until the relay accepts them, and close() used to drop that array: an edit made just before the
  // agent left never reached the room while hive_edit had already said it was syncing (8-9 Nov mock
  // run, both Antigravity VM agents). Now close() keeps sending for up to CLOSE_DRAIN_MS, then ends
  // the session. The pending request keeps the process alive meanwhile, so an exit waits for it.
  close(code = 1000, reason = '') {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return
    if (this.readyState === OPEN && (this._outbox.length || this._sending)) {
      this.readyState = CLOSING
      this._closeWith = { code, reason }
      this._closeTimer = setTimeout(() => this._endClose(false), PollSocket.CLOSE_DRAIN_MS)
      this._flush()
      return
    }
    this._closeWith = { code, reason }
    this._endClose(true)
  }
  _closeIfDrained() {
    if (this.readyState === CLOSING && !this._sending && !this._outbox.length) this._endClose(true)
  }
  _endClose(drained) {
    if (this.readyState === CLOSED) return
    clearTimeout(this._closeTimer)
    const had = !!this._sid
    const { code, reason } = this._closeWith || { code: 1000, reason: '' }
    this.readyState = CLOSED
    if (had) this._req('close', undefined, {}, 5000).catch(() => { })
    setImmediate(() => fire(this, 'close', { type: 'close', code, reason, wasClean: drained, target: this }))
  }
  /** Resolves once nothing is waiting to reach the relay (or the socket is gone): the drain, observable. */
  drained(timeoutMs = PollSocket.CLOSE_DRAIN_MS) {
    const end = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const tick = () => {
        if (this.readyState === CLOSED || (!this._outbox.length && !this._sending)) return resolve(!this._outbox.length)
        if (Date.now() >= end) return resolve(false)
        setTimeout(tick, 25)
      }
      tick()
    })
  }
  // terminate is for a dead link (the liveness check): nothing can be delivered on it, so no drain.
  terminate() { this._closeWith = { code: 1006, reason: 'terminated' }; this._endClose(false) }
}
PollSocket.CLOSE_DRAIN_MS = 10000

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
    this._attach(pick === 'poll' ? new PollSocket(url, protocols) : this._makeWS(url, protocols), pick)
  }
  /**
   * A WebSocket that remembers whether a refusal came from the RELAY (it marks its own with
   * X-Hive-Relay) or from something in the way. Antigravity's review, 7 Nov: without this, a bad token
   * or a full room printed "this network refused a WebSocket" and opened a poll session to be refused
   * again. The error and close that follow are the ones ws itself would emit.
   */
  _makeWS(url, protocols) {
    // Behind an explicit proxy the socket rides a CONNECT tunnel (an agent wins over ws's own dialer).
    const proxy = proxyFor(url)
    const ws = proxy ? new WS(url, protocols, { agent: tunnelAgent(proxy, /^wss:/i.test(url), 'ws') }) : new WS(url, protocols)
    ws.on('unexpected-response', (req, res) => {
      this._relayRefused = !!(res.headers && res.headers['x-hive-relay'])
      res.resume()
      req.destroy(new Error(`Unexpected server response: ${res.statusCode}`))
    })
    return ws
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
    const networkInTheWay = !this._relayRefused && (status != null || proxyConfigured())
    let offers = false
    if (networkInTheWay && this._origin && !this._closedByUser) {
      this._probing = true
      try { offers = await offersPoll(this._origin) } finally { this._probing = false }
    }
    if (this._closedByUser) return // close() already settled it (below)
    if (offers) {
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
  close(code = 1000, reason = '') {
    this._closedByUser = true
    if (this._probing || (this.readyState === CONNECTING && !this._inner)) {
      // Mid-switch the WebSocket is already gone and no poll socket exists yet: settle it here,
      // once, as a WebSocket closed while connecting would.
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      setImmediate(() => fire(this, 'close', { type: 'close', code, reason, wasClean: true, target: this }))
      return
    }
    try { this._inner.close(code, reason) } catch { }
  }
  terminate() {
    if (this._probing) return this.close(1006, 'terminated')
    this._closedByUser = true
    try { this._inner.terminate ? this._inner.terminate() : this._inner.close() } catch { }
  }
}
