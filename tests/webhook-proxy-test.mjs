// tests/webhook-proxy-test.mjs -- User webhook notifications (Slack/Discord) behind forward proxies
//
// Background:
// When running in an environment behind an HTTP/HTTPS forward proxy (corporate proxy, CI runner,
// Claude Code cloud sandbox) with NODE_USE_ENV_PROXY unset, built-in globalThis.fetch ignores
// HTTP(S)_PROXY and fails on external webhook domains (ENOTFOUND / ETIMEDOUT).
// Routing makeNotifier and hive-notify.js through hive-transport's relayFetch ensures:
//   1. Tunnels through HTTP(S)_PROXY or HIVE_PROXY via HTTP CONNECT.
//   2. Respects NO_PROXY (intranet webhooks stay direct).
//   3. Respects HIVE_PROXY=off (forces direct connection).
//   4. Loopback (localhost / 127.0.0.1) stays direct.

import http from 'http'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { makeNotifier } from '../hive-webhook.js'
import { relayFetch } from '../hive-transport.js'
import { main as notifyMain } from '../hive-notify.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)

const FAKE = 'webhook.hive.test'
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'HIVE_PROXY', 'NODE_USE_ENV_PROXY']
const savedEnv = Object.fromEntries(PROXY_ENV.map((k) => [k, process.env[k]]))
const setEnv = (vars) => {
  for (const k of PROXY_ENV) delete process.env[k]
  Object.assign(process.env, vars)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

// Mock webhook receiver (simulates Slack or Discord webhook endpoint)
async function startWebhookReceiver() {
  const port = await freePort()
  const received = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const bodyStr = Buffer.concat(chunks).toString('utf8')
      let json = null
      try { json = JSON.parse(bodyStr) } catch {}
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyStr,
        json,
      })
      if (req.url && req.url.includes('/status/')) {
        const m = /\/status\/(\d+)/.exec(req.url)
        const code = m ? Number(m[1]) : 500
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'upstream_error' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    port,
    received,
    close: () => new Promise((r) => server.close(r)),
  }
}

// Local forward proxy with HTTP CONNECT tunneling
async function startConnectProxy(targetPort, { refuseStatus = null } = {}) {
  const port = await freePort()
  const stats = { connects: 0, bytes: 0, requestedUrls: [] }
  const server = http.createServer((req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, sock, head) => {
    stats.connects++
    stats.requestedUrls.push(req.url)
    if (refuseStatus) {
      sock.end(`HTTP/1.1 ${refuseStatus} Forbidden\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const i = req.url.lastIndexOf(':')
    const host = req.url.slice(0, i)
    const p = Number(req.url.slice(i + 1))
    if (host !== FAKE || p !== targetPort) {
      sock.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(sock)
      sock.pipe(upstream)
    })
    sock.on('data', (d) => { stats.bytes += d.length })
    upstream.on('error', () => { sock.destroy() })
    sock.on('error', () => { upstream.destroy() })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    port,
    stats,
    close: () => new Promise((r) => server.close(r)),
  }
}

const receiver = await startWebhookReceiver()
const proxy = await startConnectProxy(receiver.port)
const webhookUrl = `http://${FAKE}:${receiver.port}/services/hooks/T000/B000/XXXX`

try {
  // =========================================================================
  sec('1. Without proxy: unresolvable host fails')
  // =========================================================================
  setEnv({})
  const logs1 = []
  const notifierDirect = makeNotifier(webhookUrl, { log: (m) => logs1.push(m) })
  const resDirect = await notifierDirect('Hello from direct')
  T('Direct fetch to unresolvable webhook host fails (send returns false)', resDirect === false)
  T('Failure logged with sanitized webhook URL', logs1.some((l) => l.includes('notification not delivered')), `logs: ${logs1}`)
  T('Proxy saw 0 connects for direct call', proxy.stats.connects === 0, `connects=${proxy.stats.connects}`)

  // =========================================================================
  sec('2. With proxy configured & NODE_USE_ENV_PROXY unset: built-in fetch fails, relayFetch succeeds')
  // =========================================================================
  setEnv({
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
  })

  // 2a. Built-in globalThis.fetch ignores HTTP_PROXY when NODE_USE_ENV_PROXY is unset:
  const logsBuiltin = []
  const notifierBuiltin = makeNotifier(webhookUrl, { fetchImpl: globalThis.fetch, log: (m) => logsBuiltin.push(m) })
  const resBuiltin = await notifierBuiltin('Hello from builtin')
  T('Built-in fetch fails behind proxy without NODE_USE_ENV_PROXY', resBuiltin === false)
  T('Proxy saw 0 connects from built-in fetch', proxy.stats.connects === 0, `connects=${proxy.stats.connects}`)

  // 2b. Default notifier with relayFetch tunnels cleanly through proxy:
  const connectsBefore = proxy.stats.connects
  const logsProxied = []
  const notifierProxied = makeNotifier(webhookUrl, { log: (m) => logsProxied.push(m) })
  const resProxied = await notifierProxied('Task approved: release 0.14.2 ready')
  T('makeNotifier default with relayFetch succeeds through proxy tunnel (send returns true)', resProxied === true)
  T('Proxy CONNECT tunnel was used', proxy.stats.connects > connectsBefore, `connects: ${connectsBefore} -> ${proxy.stats.connects}`)
  T('Webhook receiver got scrubbed payload', receiver.received.some((r) => r.json && r.json.text === 'Task approved: release 0.14.2 ready'))

  // =========================================================================
  sec('3. NO_PROXY honors intranet bypass')
  // =========================================================================
  setEnv({
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    NO_PROXY: FAKE,
  })
  const connectsNoProxy = proxy.stats.connects
  const notifierNoProxy = makeNotifier(webhookUrl)
  const resNoProxy = await notifierNoProxy('Should bypass proxy and fail on unresolvable DNS')
  T('NO_PROXY causes webhook request to bypass proxy (returns false on unresolvable DNS)', resNoProxy === false)
  T('Proxy saw no new connects due to NO_PROXY match', proxy.stats.connects === connectsNoProxy)

  // =========================================================================
  sec('4. HIVE_PROXY=off disables proxying')
  // =========================================================================
  setEnv({
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    HIVE_PROXY: 'off',
  })
  const connectsOff = proxy.stats.connects
  const notifierOff = makeNotifier(webhookUrl)
  const resOff = await notifierOff('Should bypass proxy because HIVE_PROXY=off')
  T('HIVE_PROXY=off causes webhook request to bypass proxy', resOff === false)
  T('Proxy saw no new connects due to HIVE_PROXY=off', proxy.stats.connects === connectsOff)

  // =========================================================================
  sec('5. hive-notify.js CLI main() default fetchImpl routes through proxy')
  // =========================================================================
  setEnv({
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
  })
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-notify-test-'))
  try {
    const notifyLogs = []
    const notifyErrLogs = []
    const bytesBeforeCli = proxy.stats.bytes
    const receivedBeforeCli = receiver.received.length
    // Pass fake link: notifyMain tests webhook delivery first at lines 203-207.
    // If webhook delivers, it returns 0 (with dry-run/once) or attempts sync; if webhook fails, it exits with 1 (Q643).
    const cliResult = await notifyMain(
      ['wss://127.0.0.1:9999|room-notify-test', '--webhook', webhookUrl, '--for', 'Ganesh', '--dry-run'],
      { log: (m) => notifyLogs.push(m), logErr: (m) => notifyErrLogs.push(m), home: tmpHome }
    )
    T('hive-notify main() initial proof post does NOT fail with Q643 when proxy is active',
      !notifyErrLogs.some((l) => l.includes('Q643 the webhook refused the first post')),
      `errLogs: ${notifyErrLogs}`)
    T('Proxy tunneled notifyMain initial webhook proof (data transferred via proxy)',
      proxy.stats.bytes > bytesBeforeCli,
      `bytes: ${bytesBeforeCli} -> ${proxy.stats.bytes}`)
    T('Webhook receiver got notify proof post text',
      receiver.received.some((r) => r.json && typeof r.json.text === 'string' && r.json.text.includes('Hivecode will post here when an agent in room')))
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }

  // =========================================================================
  sec('6. Proxy refusal (403/407): logged error names proxy and strips webhook URL')
  // =========================================================================
  const refusingProxy = await startConnectProxy(receiver.port, { refuseStatus: 403 })
  try {
    setEnv({
      HTTP_PROXY: `http://127.0.0.1:${refusingProxy.port}`,
      HTTPS_PROXY: `http://127.0.0.1:${refusingProxy.port}`,
    })
    const logs6 = []
    const secretPath = '/services/hooks/T0001/B0002/SECRET_TOKEN_VALUE_403'
    const secretUrl = `http://${FAKE}:${receiver.port}${secretPath}`
    const notifierRefused = makeNotifier(secretUrl, { log: (m) => logs6.push(m) })
    const resRefused = await notifierRefused('Should fail on 403 proxy connect')
    T('Proxy refusal causes send to return false', resRefused === false)
    const errLog = logs6[0] || ''
    T('Error log names the proxy', errLog.includes(`proxy 127.0.0.1:${refusingProxy.port}`), `log: ${errLog}`)
    T('Error log specifies HTTP 403 status', errLog.includes('403'), `log: ${errLog}`)
    T('Error log strips the webhook token and path', !errLog.includes('SECRET_TOKEN_VALUE_403') && !errLog.includes(secretPath), `log: ${errLog}`)
    T('Error log does not contain full secret webhook URL', !errLog.includes(secretUrl), `log: ${errLog}`)
  } finally {
    await refusingProxy.close()
  }

  // =========================================================================
  sec('7. Target answers 4xx/5xx: logs status and never counts proxy 200 as delivery')
  // =========================================================================
  setEnv({
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
  })
  const logs7 = []
  const upstreamFailUrl = `http://${FAKE}:${receiver.port}/status/500/SECRET_FAIL_TOKEN`
  const notifierFail = makeNotifier(upstreamFailUrl, { log: (m) => logs7.push(m) })
  const resFail = await notifierFail('Should fail on upstream 500')
  T('Upstream 500 returns false despite successful proxy CONNECT', resFail === false)
  const errLog7 = logs7[0] || ''
  T('Error log mentions HTTP 500 status', errLog7.includes('HTTP 500'), `log: ${errLog7}`)
  T('Error log strips upstream fail URL / secret token', !errLog7.includes('SECRET_FAIL_TOKEN'), `log: ${errLog7}`)

  // =========================================================================
  sec('8. Proxy CONNECT request line privacy: proxy only sees host:port, never path/token')
  // =========================================================================
  T('Proxy requested URLs are strictly host:port without path or secrets',
    proxy.stats.requestedUrls.length > 0 &&
    proxy.stats.requestedUrls.every((u) => u === `${FAKE}:${receiver.port}` && !u.includes('/')),
    `urls: ${JSON.stringify(proxy.stats.requestedUrls)}`)

} finally {
  setEnv(savedEnv)
  await receiver.close()
  await proxy.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
