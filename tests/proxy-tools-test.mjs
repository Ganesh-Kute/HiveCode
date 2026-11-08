// tests/proxy-tools-test.mjs -- hive-doctor.js and hive-worker.js reach the relay behind a proxy too.
//
// Both opened the relay with a raw `ws` WebSocket, which never reads HTTPS_PROXY: behind an explicit
// proxy (no outside DNS) the doctor said "could not reach the relay" and the worker waited forever
// for a sync. They now use HiveSocket, the socket every client uses (hive-transport.js): a CONNECT
// tunnel through the proxy, HTTPS long-poll where the proxy refuses the upgrade, loopback always
// direct, HIVE_PROXY=off for the old direct dial.
//
// Real relay (server.js on loopback). Real scripts, spawned. The proxy maps the unresolvable host
// relay.hive.test to the relay, so a script that gets through PROVES it did no local DNS lookup.

import http from 'http'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { fileRoom } from '../token.js'

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
const cleanEnv = (extra = {}) => { const e = { ...process.env }; for (const k of PROXY_ENV) delete e[k]; return { ...e, ...extra } }

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
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: cleanEnv({ PORT: String(port), HIVE_PERSIST_DIR: 'off' }), stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay start timeout')), 8000)
    proc.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve() } })
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`relay exited early (${c})`)) })
  })
  return { port, kill: () => { try { proc.kill('SIGKILL') } catch { } } }
}

/** CONNECT-only proxy: 'ok' tunnels relay.hive.test:<port>; 'mitm' 403s any WebSocket upgrade inside the tunnel. */
async function startProxy(relayPort, mode = 'ok') {
  const stats = { connects: 0, upgradesRefused: 0 }
  const srv = http.createServer((req, res) => { res.writeHead(405); res.end() })
  srv.on('connect', (req, sock, head) => {
    stats.connects++
    const i = req.url.lastIndexOf(':')
    if (req.url.slice(0, i) !== FAKE || Number(req.url.slice(i + 1)) !== relayPort) { sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); return }
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0)
    const pipeUp = () => {
      const up = net.connect(relayPort, '127.0.0.1', () => { if (buf.length) up.write(buf); up.pipe(sock); sock.pipe(up) })
      up.on('error', () => sock.destroy())
      sock.on('error', () => up.destroy())
    }
    if (mode !== 'mitm') { pipeUp(); return }
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      sock.off('data', onData)
      if (/^upgrade:\s*websocket/im.test(buf.subarray(0, end).toString('latin1'))) {
        stats.upgradesRefused++
        sock.end('HTTP/1.1 403 WebSocket upgrades are not allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        return
      }
      pipeUp()
    }
    sock.on('data', onData)
    if (buf.length) onData(Buffer.alloc(0))
  })
  const sockets = new Set()
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  return { port, stats, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()) }) }
}

/** Run a script; resolve { code, out, err, timedOut }. */
function run(args, env, ms = 30000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = '', timedOut = false
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    const t = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL') } catch { } }, ms)
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err, timedOut }) })
  })
}

/** Put one registered file with content into a room, directly over loopback. */
async function seed(relayPort, room, rel, text) {
  const url = `ws://127.0.0.1:${relayPort}`
  const d = new Y.Doc(), f = new Y.Doc()
  const p1 = new WebsocketProvider(url, room, d, { WebSocketPolyfill: WebSocket, disableBc: true })
  const p2 = new WebsocketProvider(url, fileRoom(room, rel), f, { WebSocketPolyfill: WebSocket, disableBc: true })
  await Promise.all([p1, p2].map((p) => new Promise((r) => p.on('sync', (s) => s && r()))))
  d.getMap('manifest').set(rel, { at: Date.now() })
  f.getText('content').insert(0, text)
  await sleep(500)
  p1.destroy(); p2.destroy()
}

const doctorJson = (r) => { try { return JSON.parse(r.out.slice(r.out.indexOf('{'))) } catch { return null } }

let relay, proxy
try {
  relay = await startRelay()
  const room = 'proxy-tools-' + Date.now()
  await seed(relay.port, room, 'a.txt', 'hello')

  sec('1. hive-doctor through an explicit CONNECT proxy (unresolvable relay host)')
  proxy = await startProxy(relay.port, 'ok')
  const r1 = await run(['hive-doctor.js', `ws://${FAKE}:${relay.port}|${room}`, '--json'], cleanEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }))
  const j1 = doctorJson(r1)
  T('doctor exits 0 (safe to join)', r1.code === 0, `code=${r1.code} err=${r1.err.trim().slice(0, 200)}`)
  T('doctor read the seeded file through the proxy (contentBytes 5, verdict OK)', j1 && j1.contentBytes === 5 && j1.verdict === 'OK', JSON.stringify(j1))
  T('the proxy carried it (CONNECTs seen)', proxy.stats.connects >= 2, `connects=${proxy.stats.connects}`)
  await proxy.close()

  sec('2. hive-doctor behind a TLS-inspecting proxy that refuses the upgrade: falls back to long-poll')
  proxy = await startProxy(relay.port, 'mitm')
  const r2 = await run(['hive-doctor.js', `ws://${FAKE}:${relay.port}|${room}`, '--json'], cleanEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }), 60000)
  const j2 = doctorJson(r2)
  T('the proxy really refused WebSocket upgrades', proxy.stats.upgradesRefused >= 1, `refused=${proxy.stats.upgradesRefused}`)
  T('doctor still exits 0 with contentBytes 5', r2.code === 0 && j2 && j2.contentBytes === 5, `code=${r2.code} ${JSON.stringify(j2)} err=${r2.err.trim().slice(0, 200)}`)
  await proxy.close()

  sec('3. loopback never goes through the proxy; HIVE_PROXY=off restores the direct dial')
  proxy = await startProxy(relay.port, 'ok')
  const r3 = await run(['hive-doctor.js', `ws://127.0.0.1:${relay.port}|${room}`, '--json'], cleanEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }))
  T('doctor on ws://127.0.0.1 exits 0 and the proxy saw nothing', r3.code === 0 && proxy.stats.connects === 0, `code=${r3.code} connects=${proxy.stats.connects}`)
  const r4 = await run(['hive-doctor.js', `ws://${FAKE}:${relay.port}|${room}`, '--json'], cleanEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, HIVE_PROXY: 'off' }), 40000)
  T('HIVE_PROXY=off: doctor fails (exit 2) and sends no CONNECT', r4.code === 2 && proxy.stats.connects === 0, `code=${r4.code} connects=${proxy.stats.connects}`)
  T('...and says it never reached the relay (DNS), not just "could not reach"', /never reached the relay/i.test(r4.err) && /DNS|resolve/i.test(r4.err), r4.err.trim().slice(0, 300))
  await proxy.close()

  sec('4. hive-worker through an explicit CONNECT proxy')
  proxy = await startProxy(relay.port, 'ok')
  const r5 = await run(['hive-worker.js', `ws://${FAKE}:${relay.port}`, room + '-w', 'w1', '2', '3'], cleanEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }), 25000)
  T('worker syncs, runs and exits 0 (prints INTERVALS)', r5.code === 0 && /^INTERVALS /m.test(r5.out), `code=${r5.code} timedOut=${r5.timedOut} err=${r5.err.trim().slice(0, 200)}`)
  T('the proxy carried the worker', proxy.stats.connects >= 1, `connects=${proxy.stats.connects}`)
  await proxy.close()

  sec('5. hive-worker on loopback is untouched by a configured proxy')
  proxy = await startProxy(relay.port, 'ok')
  const r6 = await run(['hive-worker.js', `ws://127.0.0.1:${relay.port}`, room + '-w2', 'w1', '2', '3'], cleanEnv({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }), 25000)
  T('worker on ws://127.0.0.1 exits 0 and the proxy saw nothing', r6.code === 0 && /^INTERVALS /m.test(r6.out) && proxy.stats.connects === 0, `code=${r6.code} connects=${proxy.stats.connects}`)
  await proxy.close()
  proxy = null
} catch (e) {
  fail++
  console.log(`  FAIL harness crashed: ${(e && e.stack) || e}`)
} finally {
  try { if (proxy) await proxy.close() } catch { }
  if (relay) relay.kill()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
