// tests/loopback-direct-fetch-test.mjs -- when Hivecode decides a call goes DIRECT, it goes direct,
// even where node itself applies the environment's proxy.
//
// proxyFor() decides the route: loopback, a NO_PROXY match and HIVE_PROXY=off mean "direct". fetchFor
// then handed those calls to the built-in fetch. With node's env-proxy mode on (NODE_USE_ENV_PROXY=1,
// or --use-env-proxy, which Antigravity VMs set) the built-in fetch AND http's global agent send every
// request through http(s)_proxy themselves, unless node's own NO_PROXY exempts it. So "loopback never
// goes through a proxy" was false there: a self-hosted relay on localhost could not be reached for an
// invite revoke or the /health probe, while its WebSockets worked (proxy-fetch-test 10/2 on
// antigravity-VM, 9 Nov 2026; reproduced by Opus-Cloud on node 22.23 and 24.22).
//
// node reads its env-proxy settings at startup, so every row runs in a CHILD process started with the
// environment under test. A local proxy counts what reaches it, and answers 502 "via-proxy" to a plain
// proxied request, so a call that went through it is visible both ways.
//
//   L1  env-proxy on, loopback: direct; the proxy sees nothing
//   L2  env-proxy on, HIVE_PROXY=off, a host that is not loopback: direct (node ignores HIVE_PROXY)
//   L3  env-proxy on, POST with a body (revoke-shaped): the body reaches the relay, direct
//   L4  env-proxy on, AbortSignal.timeout on a relay that never answers: rejects with TimeoutError
//   L5  env-proxy on, a host the proxy SHOULD carry: it still goes through the proxy (no over-reach)
//   L6  env-proxy off: fetchFor still returns the built-in fetch itself (nothing changes for others)
//   L7  node started in env-proxy mode, the variable cleared before the call: still direct

import http from 'http'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TRANSPORT = pathToFileURL(path.join(ROOT, 'hive-transport.js')).href
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `  -- ${extra}` : ''}`); c ? pass++ : fail++ }
const sec = (s) => console.log(`\n# ${s}`)

// The "relay": answers GET /health, echoes a POST body, and never answers /hang.
const hits = { relay: 0, body: '' }
const relay = http.createServer((q, s) => {
  hits.relay++
  if (q.url === '/hang') return // never answers
  let b = ''
  q.on('data', (c) => { b += c })
  q.on('end', () => { if (q.method === 'POST') hits.body = b; s.writeHead(200, { 'content-type': 'text/plain' }); s.end(q.method === 'POST' ? `got:${b}` : 'direct-ok') })
})
await new Promise((r) => relay.listen(0, '127.0.0.1', r))
const RP = relay.address().port

// The proxy: counts. A plain proxied request is answered 502 "via-proxy"; a CONNECT to relay.hive.test
// (the host only the proxy can resolve) is tunnelled to the relay, so L5 can prove the proxy carried it.
const seen = { plain: 0, connect: 0 }
const proxy = http.createServer((q, s) => { seen.plain++; s.writeHead(502); s.end('via-proxy') })
proxy.on('connect', (q, sock, head) => {
  seen.connect++
  const [host] = String(q.url).split(':')
  if (host !== 'relay.hive.test') { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
  const up = net.connect(RP, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up) })
  up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
})
await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
const PROXY = `http://127.0.0.1:${proxy.address().port}`

// One call in a fresh node, with exactly the environment under test.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-loopback-direct-'))
function inChild(code, envOver) {
  const file = path.join(tmp, `c${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(file, `import { relayFetch, fetchFor } from ${JSON.stringify(TRANSPORT)}\n` +
    `const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0) }\n` +
    `try { ${code} } catch (e) { out({ err: (e && e.name) + ': ' + ((e && e.cause && e.cause.code) || (e && e.message)) }) }\n`)
  const env = { ...process.env }
  for (const k of ['NO_PROXY', 'no_proxy', 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'HIVE_PROXY', 'NODE_USE_ENV_PROXY']) delete env[k]
  Object.assign(env, envOver)
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', file], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let o = '', e = ''
    p.stdout.on('data', (d) => { o += d }); p.stderr.on('data', (d) => { e += d })
    const kill = setTimeout(() => p.kill('SIGKILL'), 20000)
    p.on('close', () => { clearTimeout(kill); try { resolve(JSON.parse(o)) } catch { resolve({ err: `no JSON from child: ${o} ${e}`.slice(0, 300) }) } })
  })
}
const ENV_PROXY = { NODE_USE_ENV_PROXY: '1', http_proxy: PROXY, HTTP_PROXY: PROXY, https_proxy: PROXY, HTTPS_PROXY: PROXY }
const reset = () => { hits.relay = 0; hits.body = ''; seen.plain = 0; seen.connect = 0 }
const getText = (url, init = '{}') => `const r = await relayFetch(${JSON.stringify(url)}, ${init}); out({ status: r.status, text: await r.text() })`

try {
  sec('L1 env-proxy on, loopback: direct')
  reset()
  let r = await inChild(getText(`http://127.0.0.1:${RP}/health`), ENV_PROXY)
  T('L1 the relay answered the call itself', r.status === 200 && r.text === 'direct-ok', JSON.stringify(r))
  T('L1 ...and the proxy saw nothing', seen.plain === 0 && seen.connect === 0, `plain=${seen.plain} connect=${seen.connect}`)
  reset()
  r = await inChild(getText(`http://localhost:${RP}/health`), ENV_PROXY)
  T('L1 the same for "localhost"', r.status === 200 && r.text === 'direct-ok' && seen.plain + seen.connect === 0, JSON.stringify(r))

  sec('L2 env-proxy on, HIVE_PROXY=off, a host that is not loopback: direct')
  // 0.0.0.0 reaches this machine on Linux and macOS, and is not loopback to proxyFor: only HIVE_PROXY=off makes it direct.
  reset()
  r = await inChild(getText(`http://0.0.0.0:${RP}/health`), { ...ENV_PROXY, HIVE_PROXY: 'off' })
  T('L2 HIVE_PROXY=off is honoured even though node would use the proxy', r.status === 200 && r.text === 'direct-ok' && seen.plain + seen.connect === 0, `${JSON.stringify(r)} plain=${seen.plain} connect=${seen.connect}`)

  sec('L3 env-proxy on, POST with a body (the revoke call): direct, body intact')
  reset()
  r = await inChild(getText(`http://127.0.0.1:${RP}/__hive/revoke`, `{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jti: 'j-1' }) }`), ENV_PROXY)
  T('L3 the relay got the body and answered', r.status === 200 && hits.body === '{"jti":"j-1"}' && seen.plain + seen.connect === 0, `${JSON.stringify(r)} body=${hits.body}`)

  sec('L4 env-proxy on, a relay that never answers: the caller\'s timeout still applies')
  reset()
  r = await inChild(`const t0 = Date.now(); try { await relayFetch(${JSON.stringify(`http://127.0.0.1:${RP}/hang`)}, { signal: AbortSignal.timeout(400) }); out({ resolved: true }) } catch (e) { out({ name: e && e.name, ms: Date.now() - t0 }) }`, ENV_PROXY)
  T('L4 rejects with TimeoutError (hive-setup tests the name), within the timeout', r.name === 'TimeoutError' && r.ms < 5000, JSON.stringify(r))
  T('L4 ...having reached the relay, not the proxy', hits.relay >= 1 && seen.plain + seen.connect === 0, `relay=${hits.relay} plain=${seen.plain} connect=${seen.connect}`)

  sec('L5 env-proxy on, a host only the proxy can reach: it still goes through the proxy')
  reset()
  r = await inChild(getText(`http://relay.hive.test:${RP}/health`), ENV_PROXY)
  T('L5 answered through the proxy tunnel', r.status === 200 && r.text === 'direct-ok' && seen.connect >= 1, `${JSON.stringify(r)} connect=${seen.connect}`)

  sec('L7 node started in env-proxy mode, NODE_USE_ENV_PROXY cleared before the call: still direct')
  // node fixes the mode at startup; clearing the variable later does not turn it off. A check read per
  // call says "off" here and hands the call to the built-in fetch, which still goes to the proxy.
  reset()
  r = await inChild(`delete process.env.NODE_USE_ENV_PROXY; ${getText(`http://127.0.0.1:${RP}/health`)}`, ENV_PROXY)
  T('L7 direct, as node is still in env-proxy mode', r.status === 200 && r.text === 'direct-ok' && seen.plain + seen.connect === 0, `${JSON.stringify(r)} plain=${seen.plain} connect=${seen.connect}`)

  sec('L6 env-proxy off: nothing changes')
  reset()
  r = await inChild(`out({ same: fetchFor(${JSON.stringify(`http://127.0.0.1:${RP}/health`)}) === globalThis.fetch })`, { http_proxy: PROXY, HTTP_PROXY: PROXY })
  T('L6 fetchFor gives the built-in fetch itself when env-proxy mode is off', r.same === true, JSON.stringify(r))
  reset()
  r = await inChild(getText(`http://127.0.0.1:${RP}/health`), { http_proxy: PROXY, HTTP_PROXY: PROXY })
  T('L6 ...and a loopback call is direct, as before', r.status === 200 && r.text === 'direct-ok' && seen.plain + seen.connect === 0, JSON.stringify(r))
} finally {
  relay.close(); proxy.close()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
