// tests/proxy-connect-test.mjs -- a client behind an explicit HTTPS_PROXY reaches the relay through
// an HTTP CONNECT tunnel, and says so honestly when it cannot.
//
// Background (Claude-cloud, 8 Nov 2026): in a sandbox whose only way out is an egress proxy (Claude
// Code cloud containers, CI runners, company laptops) outside host names do not even resolve. The
// `ws` library never reads HTTPS_PROXY, so the relay WebSocket died with `getaddrinfo ENOTFOUND`,
// and hive_join reported "the relay refused the connection" -- although the relay was never reached.
// 0.14.0's long-poll fallback could not save it either: plain fetch also ignores HTTPS_PROXY unless
// NODE_USE_ENV_PROXY=1 was set when node started.
//
// The relay here is real (server.js on loopback). The proxy is a local CONNECT proxy that maps the
// synthetic host relay.hive.test to that relay. Nothing resolves relay.hive.test, so a socket that
// opens to it PROVES the client did no local DNS lookup and went through the tunnel.

import http from 'http'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as HT from '../hive-transport.js'
import { statusFromError } from '../hive-relay-health.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)
const FAKE = 'relay.hive.test'
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'HIVE_PROXY', 'HIVE_TRANSPORT', 'NODE_USE_ENV_PROXY']
const saved = Object.fromEntries(PROXY_ENV.map((k) => [k, process.env[k]]))
function setEnv(vars) {
  for (const k of PROXY_ENV) delete process.env[k]
  Object.assign(process.env, vars)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

async function startRelay() {
  const port = await freePort()
  const env = { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off' }
  for (const k of PROXY_ENV) delete env[k]
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay start timeout')), 8000)
    proc.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve() } })
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`relay exited early (${c})`)) })
  })
  return { port, kill: () => { try { proc.kill('SIGKILL') } catch { } } }
}

/**
 * A forward proxy that only speaks CONNECT (what HTTPS_PROXY means to every client). mode:
 *   'ok'   tunnel relay.hive.test:<relay port> to the relay
 *   'auth' same, but demands Proxy-Authorization: Basic <user:pass> first (407 without it)
 *   '403'  refuse every CONNECT
 *   'mitm' a TLS-INSPECTING proxy (Antigravity's VM): answers CONNECT 200, then reads each request
 *          inside the tunnel; a WebSocket upgrade gets "403 WebSocket upgrades are not allowed" with
 *          NO x-hive-relay header, anything else is passed through to the relay
 * It records every request line and header block it sees, to check what a proxy could log.
 */
async function startProxy(relayPort, mode = 'ok', creds = 'hive:p@ss word') {
  const seen = []       // { line, headers } for every CONNECT and every plain request
  const mitm = { upgradesRefused: 0 }
  const srv = http.createServer((req, res) => {
    seen.push({ line: `${req.method} ${req.url}`, headers: JSON.stringify(req.headers) })
    res.writeHead(405); res.end('this proxy only does CONNECT')
  })
  srv.on('connect', (req, sock, head) => {
    seen.push({ line: `CONNECT ${req.url}`, headers: JSON.stringify(req.headers) })
    if (mode === '403') { sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return }
    if (mode === 'auth') {
      const want = 'Basic ' + Buffer.from(creds).toString('base64')
      if (req.headers['proxy-authorization'] !== want) {
        sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\nContent-Length: 0\r\n\r\n')
        return
      }
    }
    const [host, port] = [req.url.slice(0, req.url.lastIndexOf(':')), Number(req.url.slice(req.url.lastIndexOf(':') + 1))]
    if (host !== FAKE || port !== relayPort) { sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); return }
    if (mode === 'mitm') {
      // Inspect the first request in the tunnel (a ws tunnel carries exactly one: the upgrade).
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
      const onData = (d) => {
        buf = Buffer.concat([buf, d])
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        sock.off('data', onData)
        const reqHead = buf.subarray(0, end).toString('latin1')
        seen.push({ line: `TUNNEL ${reqHead.split('\r\n')[0]}`, headers: reqHead })
        if (/^upgrade:\s*websocket/im.test(reqHead)) {
          mitm.upgradesRefused++
          sock.end('HTTP/1.1 403 WebSocket upgrades are not allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
          return
        }
        const up = net.connect(relayPort, '127.0.0.1', () => { up.write(buf); up.pipe(sock); sock.pipe(up) })
        up.on('error', () => sock.destroy())
        sock.on('error', () => up.destroy())
      }
      sock.on('data', onData)
      if (buf.length) onData(Buffer.alloc(0))
      return
    }
    const up = net.connect(relayPort, '127.0.0.1', () => {
      // An extra byte-free answer plus whatever the client already sent: the tunnel must be clean.
      sock.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: hive-test\r\n\r\n')
      if (head && head.length) up.write(head)
      up.pipe(sock); sock.pipe(up)
    })
    up.on('error', () => sock.destroy())
    sock.on('error', () => up.destroy())
  })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  const sockets = new Set()
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  return {
    port, seen, mitm,
    connects: () => seen.filter((s) => s.line.startsWith('CONNECT ')),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()) }),
  }
}

/** Open one HiveSocket and report how it ended: { opened, error, closeCode, transport }. */
function tryOpen(url, ms = 8000) {
  return new Promise((resolve) => {
    let s
    try { s = new HT.HiveSocket(url) } catch (e) { resolve({ opened: false, error: e, threw: true }); return }
    const out = { opened: false, error: null, errorEvent: null, closeCode: null, transport: null }
    const t = setTimeout(() => { try { s.close() } catch { } resolve({ ...out, timedOut: true }) }, ms)
    s.onopen = () => { out.opened = true; out.transport = s.transport; clearTimeout(t); s.close(); resolve(out) }
    s.onerror = (ev) => { out.errorEvent = ev; out.error = (ev && ev.error) || ev }
    s.onclose = (ev) => { out.closeCode = ev && ev.code; if (!out.opened) { clearTimeout(t); resolve(out) } }
  })
}

/** Two y-websocket peers on the same room: does an edit on one arrive on the other? */
async function syncsThrough(serverUrl, room, ms = 10000) {
  const a = new Y.Doc(), b = new Y.Doc()
  const opts = { WebSocketPolyfill: HT.HiveSocket, disableBc: true, params: { name: 'proxy-test' } }
  const pa = new WebsocketProvider(serverUrl, room, a, opts)
  const pb = new WebsocketProvider(serverUrl, room, b, opts)
  try {
    const word = 'through-the-tunnel-' + Date.now()
    a.getText('t').insert(0, word)
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (b.getText('t').toString() === word) return true
      await sleep(100)
    }
    return false
  } finally { pa.destroy(); pb.destroy() }
}

const msgOf = (r) => String((r && r.error && (r.error.message || r.error)) || (r && r.errorEvent && r.errorEvent.message) || '')

let relay, proxy
try {
  relay = await startRelay()
  const fakeWs = `ws://${FAKE}:${relay.port}`
  const fakeHttp = `http://${FAKE}:${relay.port}`

  sec('0. the API this file tests exists')
  T('hive-transport exports proxyFor(target)', typeof HT.proxyFor === 'function')
  T('hive-transport exports unreachedReason(errorOrEvent)', typeof HT.unreachedReason === 'function')

  sec('1. a WebSocket to an unresolvable host opens through the CONNECT tunnel')
  proxy = await startProxy(relay.port, 'ok')
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HIVE_TRANSPORT: 'ws' })
  const marker = 'MARKER' + Date.now()
  const r1 = await tryOpen(`${fakeWs}/proxy-room-1?name=${marker}`)
  T('socket opened (no local DNS lookup happened)', r1.opened, msgOf(r1))
  T('it is a WebSocket, not long-poll', r1.transport === 'ws', String(r1.transport))
  T('the proxy saw exactly CONNECT relay.hive.test:<port>', proxy.connects().length === 1 && proxy.connects()[0].line === `CONNECT ${FAKE}:${relay.port}`, JSON.stringify(proxy.connects().map((c) => c.line)))
  T('the query string (where the room token rides) never reached the proxy as a request line or header',
    !proxy.seen.some((s) => s.line.includes(marker) || s.headers.includes(marker)))

  sec('2. real document sync rides the tunnel end to end')
  T('an edit on one y-websocket peer arrives on the other via the proxy', await syncsThrough(fakeWs, 'proxy-room-2'))

  sec('3. long-poll goes through the same tunnel (fetch ignores HTTPS_PROXY on Node 22 without NODE_USE_ENV_PROXY)')
  T('offersPoll() reads /health through the proxy', await HT.offersPoll(fakeHttp) === true)
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HIVE_TRANSPORT: 'http' })
  const r3 = await tryOpen(`${fakeWs}/proxy-room-3`)
  T('a forced long-poll socket opens through the proxy', r3.opened && r3.transport === 'poll', msgOf(r3))
  T('long-poll document sync works through the proxy', await syncsThrough(fakeWs, 'proxy-room-3b'))
  await proxy.close()

  sec('4. loopback always bypasses the proxy; NO_PROXY and HIVE_PROXY=off are honoured')
  proxy = await startProxy(relay.port, 'ok')
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, HIVE_TRANSPORT: 'ws' })
  const r4a = await tryOpen(`ws://127.0.0.1:${relay.port}/proxy-room-4`)
  T('ws://127.0.0.1 opens directly, proxy untouched', r4a.opened && proxy.seen.length === 0, `${msgOf(r4a)} seen=${proxy.seen.length}`)
  const r4b = await tryOpen(`ws://localhost:${relay.port}/proxy-room-4`)
  T('ws://localhost opens directly, proxy untouched', r4b.opened && proxy.seen.length === 0, `${msgOf(r4b)} seen=${proxy.seen.length}`)
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: 'example.com, .hive.test', HIVE_TRANSPORT: 'ws' })
  T('proxyFor() is null for a NO_PROXY suffix match', HT.proxyFor && HT.proxyFor(fakeWs) === null)
  const r4c = await tryOpen(`${fakeWs}/proxy-room-4`)
  T('NO_PROXY=.hive.test: no CONNECT sent (dials direct, and so fails to resolve)', !r4c.opened && proxy.connects().length === 0, `seen=${proxy.connects().length}`)
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '*', HIVE_TRANSPORT: 'ws' })
  T('NO_PROXY=* turns the proxy off', HT.proxyFor && HT.proxyFor(fakeWs) === null)
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HIVE_PROXY: 'off', HIVE_TRANSPORT: 'ws' })
  const r4d = await tryOpen(`${fakeWs}/proxy-room-4`)
  T('HIVE_PROXY=off: no CONNECT sent', !r4d.opened && proxy.connects().length === 0, `seen=${proxy.connects().length}`)
  T('a direct DNS failure is named as never reaching the relay', HT.unreachedReason && /never reached the relay/i.test(HT.unreachedReason(r4d.errorEvent) || '') && /resolve|DNS/i.test(HT.unreachedReason(r4d.errorEvent) || ''), HT.unreachedReason && HT.unreachedReason(r4d.errorEvent))
  setEnv({ HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, HIVE_TRANSPORT: 'ws' })
  T('wss:// picks HTTPS_PROXY, ws:// picks HTTP_PROXY',
    HT.proxyFor && String(HT.proxyFor(`wss://${FAKE}`) && HT.proxyFor(`wss://${FAKE}`).port) === String(proxy.port) && String(HT.proxyFor(fakeWs) && HT.proxyFor(fakeWs).port) === '1')
  setEnv({ HIVE_PROXY: `http://127.0.0.1:${proxy.port}`, HIVE_TRANSPORT: 'ws' })
  T('HIVE_PROXY=<url> sets the proxy explicitly', HT.proxyFor && String(HT.proxyFor(fakeWs) && HT.proxyFor(fakeWs).port) === String(proxy.port))
  await proxy.close()

  sec('5. a proxy that wants credentials gets them from the proxy URL, and they are never printed')
  proxy = await startProxy(relay.port, 'auth', 'hive:p@ss word')
  setEnv({ HTTP_PROXY: `http://hive:p%40ss%20word@127.0.0.1:${proxy.port}`, HIVE_TRANSPORT: 'ws' })
  const r5a = await tryOpen(`${fakeWs}/proxy-room-5`)
  T('user:pass in the proxy URL authenticates the CONNECT', r5a.opened, msgOf(r5a))
  setEnv({ HTTP_PROXY: `http://hive:wrong-secret@127.0.0.1:${proxy.port}`, HIVE_TRANSPORT: 'ws' })
  const r5b = await tryOpen(`${fakeWs}/proxy-room-5`)
  const why5 = (HT.unreachedReason && HT.unreachedReason(r5b.errorEvent)) || ''
  T('a 407 is reported as the proxy refusing, naming the proxy and the 407', !r5b.opened && /never reached the relay/i.test(why5) && why5.includes(`127.0.0.1:${proxy.port}`) && /407/.test(why5), why5 || msgOf(r5b))
  T('the proxy password is in neither the error nor the explanation', !msgOf(r5b).includes('wrong-secret') && !why5.includes('wrong-secret'))
  await proxy.close()

  sec('6. a proxy that refuses CONNECT is not mistaken for the relay refusing')
  proxy = await startProxy(relay.port, '403')
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` })
  const r6 = await tryOpen(`${fakeWs}/proxy-room-6`, 25000)
  const why6 = (HT.unreachedReason && HT.unreachedReason(r6.errorEvent)) || ''
  T('the socket fails', !r6.opened)
  T('statusFromError() sees no relay status (else hive_join explains a 403 as a bad token)', statusFromError(r6.errorEvent) == null && statusFromError(r6.error) == null, String(statusFromError(r6.errorEvent)))
  T('the explanation says the proxy refused, names it, and gives the 403', /never reached the relay/i.test(why6) && why6.includes(`127.0.0.1:${proxy.port}`) && /403/.test(why6), why6 || msgOf(r6))
  T('a relay that answered and refused is NOT called unreached', HT.unreachedReason && HT.unreachedReason({ error: Object.assign(new Error('Unexpected server response: 401'), {}) }) == null)
  await proxy.close()

  sec('7. a TLS-inspecting proxy: CONNECT 200, then 403 on the upgrade INSIDE the tunnel (Antigravity\'s VM)')
  proxy = await startProxy(relay.port, 'mitm')
  setEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }) // AUTO transport, as real clients run
  const r7 = await tryOpen(`${fakeWs}/proxy-room-7`, 25000)
  T('the proxy really refused a WebSocket upgrade inside the tunnel', proxy.mitm.upgradesRefused >= 1, `refused=${proxy.mitm.upgradesRefused}`)
  T('the socket still opens, on long-poll (the 403 has no x-hive-relay, so it is the network, not the relay)', r7.opened && r7.transport === 'poll', `${msgOf(r7)} transport=${r7.transport}`)
  T('no error was surfaced for the refused upgrade (it was not read as a relay token refusal)', !r7.error, msgOf(r7))
  T('long-poll document sync works through the inspecting proxy', await syncsThrough(fakeWs, 'proxy-room-7b', 15000))
  await proxy.close()
} catch (e) {
  fail++
  console.log(`  FAIL harness crashed: ${(e && e.stack) || e}`)
} finally {
  setEnv(Object.fromEntries(Object.entries(saved).filter(([, v]) => v != null)))
  try { if (proxy) await proxy.close() } catch { }
  if (relay) relay.kill()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
