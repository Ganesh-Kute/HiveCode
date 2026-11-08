// tests/proxy-fetch-test.mjs -- every plain HTTP call to the relay goes through the proxy too.
//
// 0.14.1 tunnels the relay WebSocket and the long-poll through HTTPS_PROXY, but four calls to the
// relay still used the built-in fetch, which ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 was set
// when node started (Claude-cloud, 8 Nov 2026, measured on the live relay from an explicit-proxy box):
//   - hive-mux.js createFileTransport: the "does the relay offer mux?" probe failed, was retried
//     for ~75 s, and EVERY file doc waited in `pending` meanwhile: a new file took 74 s to arrive.
//   - hive-relay-health.js probeRelayHealth: the not-syncing diagnosis read "unreachable".
//   - hive-room-key.js revokeInvite: taking an invite back failed ("could not reach the relay").
//   - hive-setup.js wakeRelay: setup reported the relay as not answering.
// Real relay (server.js, loopback) behind a local CONNECT proxy that maps the unresolvable host
// relay.hive.test to it: a call that gets an answer PROVES it went through the proxy.

import http from 'http'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)
const FAKE = 'relay.hive.test'
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'HIVE_PROXY', 'NODE_USE_ENV_PROXY']
const saved = Object.fromEntries(PROXY_ENV.map((k) => [k, process.env[k]]))
const setEnv = (vars) => { for (const k of PROXY_ENV) delete process.env[k]; Object.assign(process.env, vars) }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject)
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
async function startProxy(relayPort) {
  // bytes, not just CONNECTs: the fetch tunnel is kept alive, so a later call may ride an open one
  const stats = { connects: 0, bytes: 0 }
  const srv = http.createServer((req, res) => { res.writeHead(405); res.end() })
  srv.on('connect', (req, sock, head) => {
    stats.connects++
    const i = req.url.lastIndexOf(':')
    if (req.url.slice(0, i) !== FAKE || Number(req.url.slice(i + 1)) !== relayPort) { sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); return }
    const up = net.connect(relayPort, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) up.write(head)
      up.pipe(sock); sock.pipe(up)
    })
    sock.on('data', (d) => { stats.bytes += d.length })
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
  })
  const socks = new Set(); srv.on('connection', (x) => { socks.add(x); x.on('close', () => socks.delete(x)) })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  return { port, stats, close: () => new Promise((r) => { for (const x of socks) x.destroy(); srv.close(() => r()) }) }
}

const keys = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-proxy-fetch-keys-'))
process.env.HIVE_KEYS_DIR = keys
let relay, proxy
try {
  const { probeRelayHealth } = await import('../hive-relay-health.js')
  const { createFileTransport } = await import('../hive-mux.js')
  const RK = await import('../hive-room-key.js')
  relay = await startRelay()
  proxy = await startProxy(relay.port)
  const viaProxy = { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }
  const fakeWs = `ws://${FAKE}:${relay.port}`

  sec('1. mux detection (hive-mux.js) asks /health through the proxy, so files are not held ~75 s')
  setEnv(viaProxy)
  const t0 = Date.now()
  const ft = createFileTransport({ relay: fakeWs, room: 'proxy-fetch-mux', env: {}, log: () => { } })
  const mode = await Promise.race([ft.ready, sleep(5000).then(() => 'still detecting after 5 s')])
  try { ft.stop() } catch { }
  T('HIVE_MUX unset behind a proxy: the transport is decided within 5 s, as mux', mode === 'mux', `${mode} (${Date.now() - t0} ms)`)
  T('...and the proxy carried the probe', proxy.stats.connects >= 1, `connects=${proxy.stats.connects}`)

  sec('2. probeRelayHealth (the not-syncing diagnosis) reads /health through the proxy')
  proxy.stats.connects = 0; proxy.stats.bytes = 0
  setEnv(viaProxy)
  const p2 = await probeRelayHealth(fakeWs, { timeoutMs: 5000 })
  T('behind a proxy the probe gets the relay\'s /health', p2.ok === true && !!p2.health, JSON.stringify(p2).slice(0, 200))
  T('...through the proxy', proxy.stats.bytes > 0, `bytes=${proxy.stats.bytes}`)
  proxy.stats.connects = 0; proxy.stats.bytes = 0
  const p2b = await probeRelayHealth(`ws://127.0.0.1:${relay.port}`, { timeoutMs: 5000 })
  T('loopback is probed directly even with a proxy set', p2b.ok === true && proxy.stats.connects === 0 && proxy.stats.bytes === 0, `ok=${p2b.ok} connects=${proxy.stats.connects} bytes=${proxy.stats.bytes}`)
  setEnv({ ...viaProxy, HIVE_PROXY: 'off' })
  const p2c = await probeRelayHealth(fakeWs, { timeoutMs: 5000 })
  T('HIVE_PROXY=off: nothing through the proxy, and the probe reports it could not reach', p2c.ok === false && proxy.stats.connects === 0 && proxy.stats.bytes === 0, `ok=${p2c.ok} connects=${proxy.stats.connects} bytes=${proxy.stats.bytes}`)

  sec('3. revokeInvite (taking an invite back) reaches /__hive/revoke through the proxy')
  setEnv({})
  const control = RK.newPersonalRoom()
  RK.saveRoomKey(control, { relay: `ws://127.0.0.1:${relay.port}`, host: 'Host' })
  RK.makeInvite({ room: control.room, relay: `ws://127.0.0.1:${relay.port}`, name: 'Bob' })
  const rc = await RK.revokeInvite({ room: control.room, relay: `ws://127.0.0.1:${relay.port}`, name: 'Bob' })
  T('control: a direct revoke on loopback works (so this harness is sound)', rc.ok === true, rc.text)
  const k = RK.newPersonalRoom()
  RK.saveRoomKey(k, { relay: fakeWs, host: 'Host' })
  RK.makeInvite({ room: k.room, relay: fakeWs, name: 'Bob' })
  proxy.stats.connects = 0; proxy.stats.bytes = 0
  setEnv(viaProxy)
  const r3 = await RK.revokeInvite({ room: k.room, relay: fakeWs, name: 'Bob' })
  T('behind a proxy the revoke reaches the relay and succeeds', r3.ok === true, r3.text)
  T('...through the proxy', proxy.stats.bytes > 0, `bytes=${proxy.stats.bytes}`)

  sec('4. hivecode-mcp setup wakes the relay (hive-setup.js wakeRelay) through the proxy')
  const HS = await import('../hive-setup.js')
  T('wakeRelay is exported (so it can be checked)', typeof HS.wakeRelay === 'function')
  if (typeof HS.wakeRelay === 'function') {
    proxy.stats.bytes = 0
    setEnv(viaProxy)
    const w = await HS.wakeRelay(fakeWs)
    T('behind a proxy setup sees the relay answer /health', w.ok === true, JSON.stringify(w))
    T('...through the proxy', proxy.stats.bytes > 0, `bytes=${proxy.stats.bytes}`)
  }
} catch (e) {
  fail++
  console.log(`  FAIL harness crashed: ${(e && e.stack) || e}`)
} finally {
  setEnv(Object.fromEntries(Object.entries(saved).filter(([, v]) => v != null)))
  try { if (proxy) await proxy.close() } catch { }
  if (relay) relay.kill()
  try { fs.rmSync(keys, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
