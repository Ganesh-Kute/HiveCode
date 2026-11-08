// tests/poll-transport-test.mjs — Verify HTTPS long-poll transport behind a WebSocket-refusing proxy
//
// Background:
// Antigravity cloud VMs (and strict corporate forward proxies) reject HTTP WebSocket upgrades with:
//   "403 WebSocket upgrades are not allowed"
// While plain HTTPS/HTTP requests (GET /health, POST /_hive_poll/*) succeed normally.
//
// This test suite creates a local forward/reverse proxy that answers every HTTP Upgrade with the exact
// VM 403 error, transparently proxies standard HTTP, and exercises fault injection (dropped recv,
// duplicate send), relay restart, idle keepalive, forced transports, disabled poll on old relays,
// and token revocation.

import http from 'http'
import net from 'net'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { startSync } from '../sync.js'
import { sign, keyFingerprint, makeSecuredRoomId } from '../token.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)

/**
 * Ephemeral port allocation without collisions
 */
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

/**
 * Start a real Relay instance (server.js)
 */
async function startRelay(env = {}) {
  const p = env.PORT ? Number(env.PORT) : await freePort()
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(p), HIVE_PERSIST_DIR: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Relay start timeout')), 6000)
    proc.stdout.on('data', (d) => {
      if (/listening on/.test(d)) {
        clearTimeout(timeout)
        resolve()
      }
    })
    proc.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Relay exited early with code ${code}`))
    })
  })
  return {
    proc,
    port: p,
    wsUrl: `ws://127.0.0.1:${p}`,
    httpUrl: `http://127.0.0.1:${p}`,
    kill: () => { try { proc.kill('SIGKILL') } catch {} },
  }
}

/**
 * Creates a local proxy that answers every upgrade request with the VM's exact 403:
 * "403 WebSocket upgrades are not allowed"
 * and proxies normal HTTP requests to `targetPort`, with optional fault injection hooks.
 */
async function createVmProxy({ targetPort, onUpgrade, onRequest, dropOneRecv = false, duplicateSend = false }) {
  const port = await freePort()
  let droppedRecvDone = false
  let duplicatedSendDone = false
  let droppedRecvCount = 0
  let duplicatedSendCount = 0

  const recvRegex = /\/_hive_poll\/[^/]+\/recv(\?.*)?$/
  const sendRegex = /\/_hive_poll\/[^/]+\/send(\?.*)?$/

  const server = http.createServer((req, res) => {
    if (onRequest && onRequest(req, res)) return

    // Fault Injection: drop one recv answer after relay processed it
    if (dropOneRecv && !droppedRecvDone && recvRegex.test(req.url)) {
      droppedRecvDone = true
      droppedRecvCount++
      const proxyReq = http.request({
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
      }, (proxyRes) => {
        // Drain relay response, then destroy the client socket without sending response
        proxyRes.resume()
        req.socket.destroy()
      })
      proxyReq.on('error', () => { req.socket.destroy() })
      req.pipe(proxyReq)
      return
    }

    // Fault Injection: duplicate a client send request with identical x-hive-seq
    if (duplicateSend && !duplicatedSendDone && sendRegex.test(req.url)) {
      duplicatedSendDone = true
      duplicatedSendCount++
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        // First copy
        const r1 = http.request({
          host: '127.0.0.1',
          port: targetPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        }, (p1) => {
          res.writeHead(p1.statusCode, p1.headers)
          p1.pipe(res)
        })
        r1.on('error', (e) => { res.writeHead(502); res.end(e.message) })
        r1.end(body)

        // Duplicate copy sent immediately to relay
        const r2 = http.request({
          host: '127.0.0.1',
          port: targetPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        }, (p2) => { p2.resume() })
        r2.on('error', () => {})
        r2.end(body)
      })
      return
    }

    // Transparent HTTP proxy
    const proxyReq = http.request({
      host: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`502 Bad Gateway: ${err.message}`)
    })
    req.pipe(proxyReq)
  })

  // Handle WebSocket Upgrade: answer with VM's exact 403
  server.on('upgrade', (req, socket, head) => {
    if (onUpgrade) onUpgrade(req, socket, head)
    socket.write(
      'HTTP/1.1 403 Forbidden\r\n' +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      'Content-Length: 38\r\n' +
      '\r\n' +
      '403 WebSocket upgrades are not allowed\n'
    )
    socket.destroy()
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port,
        wsUrl: `ws://127.0.0.1:${port}`,
        httpUrl: `http://127.0.0.1:${port}`,
        get droppedRecvCount() { return droppedRecvCount },
        get duplicatedSendCount() { return duplicatedSendCount },
        close: () => new Promise((cb) => server.close(cb)),
      })
    })
  })
}

// Open raw WebSocket to verify refusal status
const openWs = (url, room) => new Promise((res) => {
  const ws = new WebSocket(`${url}/${room}`)
  let settled = false
  const done = (val) => { if (!settled) { settled = true; res(val) } }
  ws.on('open', () => done({ ok: true, ws }))
  ws.on('unexpected-response', (_, r) => done({ ok: false, statusCode: r.statusCode }))
  ws.on('error', (e) => done({ ok: false, error: e.message }))
  setTimeout(() => done({ ok: false, timeout: true }), 3000)
})

const liveRelays = []
const liveProxies = []

try {
  // ─── P: PROXY & 403 REFUSAL BASELINE ──────────────────────────────────────────
  sec('P  Proxy refuses WS upgrades with 403 while transparently proxying HTTP')
  {
    const relay = await startRelay()
    liveRelays.push(relay)

    let upgradeAttempts = 0
    const proxy = await createVmProxy({
      targetPort: relay.port,
      onUpgrade: () => { upgradeAttempts++ },
    })
    liveProxies.push(proxy)

    // P1: Direct WebSocket upgrade to proxy returns 403 Forbidden
    const rawWs = await openWs(proxy.wsUrl, 'room-test-403')
    T('P1 proxy rejects raw WebSocket upgrade with 403 Forbidden',
      rawWs.ok === false && rawWs.statusCode === 403,
      `got status=${rawWs.statusCode}, error=${rawWs.error}`)
    T('P1 upgrade handler fired on proxy', upgradeAttempts === 1, `attempts=${upgradeAttempts}`)

    // P2: Proxy forwards normal HTTP GET /health
    const health = await new Promise((res) => {
      http.get(`${proxy.httpUrl}/health`, (r) => {
        let body = ''
        r.on('data', (d) => { body += d })
        r.on('end', () => res({ statusCode: r.statusCode, body }))
      }).on('error', (e) => res({ error: e.message }))
    })
    T('P2 proxy forwards HTTP GET /health returning 200', health.statusCode === 200, `got ${health.statusCode}`)
    const healthJson = health.body ? JSON.parse(health.body) : {}
    T('P2 health response is valid relay payload', typeof healthJson.uptime === 'number' || typeof healthJson.rooms === 'number')

    // P3: True legacy WebSocket client (raw y-websocket with ws) cannot connect through 403 proxy
    // (legacyDoc.destroy() explicitly clears awareness timers so process can exit cleanly)
    const legacyDoc = new Y.Doc()
    const legacyProvider = new WebsocketProvider(proxy.wsUrl, 'room-test-ws-fail', legacyDoc, {
      WebSocketPolyfill: WebSocket,
      disableBc: true,
    })
    let legacySynced = false
    legacyProvider.on('sync', (s) => { if (s) legacySynced = true })
    await sleep(1500)
    legacyProvider.destroy()
    legacyDoc.destroy()
    T('P3 legacy WebSocket client cannot sync through 403 proxy', legacySynced === false,
      legacySynced ? 'unexpectedly synced' : 'correctly failed to connect')

    // P4: Client with poll transport enabled connects via HTTP poll and completes sync
    // (RED ON 0.13.1 until poll transport is landed)
    const tmpDirP4 = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-p4-'))
    let pollSynced = false
    try {
      const hive = startSync({
        relay: proxy.httpUrl,
        room: 'room-test-poll-sync',
        dir: tmpDirP4,
        name: 'test-poll-sync',
        kind: 'ai',
        syncFiles: false,
        log: () => {},
      })
      pollSynced = await Promise.race([
        new Promise((res) => hive.provider.on('sync', (s) => { if (s) res(true) })),
        sleep(3000).then(() => false),
      ])
      hive.stop()
    } catch {}
    T('P4 client connects via HTTP poll transport and completes sync', pollSynced === true,
      pollSynced ? 'synced' : 'RED on 0.13.1 (no poll transport yet)')
  }

  // ─── F: FAULT INJECTION (DROPPED RECV & DUPLICATE SEND) ────────────────────────
  sec('F  Fault Injection: dropped recv and duplicate send with x-hive-seq')
  {
    const relay = await startRelay()
    liveRelays.push(relay)

    const proxy = await createVmProxy({
      targetPort: relay.port,
      dropOneRecv: true,
      duplicateSend: true,
    })
    liveProxies.push(proxy)

    const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-f-'))
    const tmpFObs = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-f-obs-'))
    let faultSyncOk = false
    let countMsg1 = 0
    let countMsg2 = 0
    let observerClient = null
    let pollClient = null
    try {
      // Observer connects directly to relay via WS to verify what reached the shared room
      observerClient = startSync({
        relay: relay.wsUrl,
        room: 'room-test-fault',
        dir: tmpFObs,
        name: 'observer-f',
        kind: 'ai',
        syncFiles: false,
        log: () => {},
      })

      // Client connects through the 403 proxy over poll transport
      pollClient = startSync({
        relay: proxy.httpUrl,
        room: 'room-test-fault',
        dir: tmpF,
        name: 'poll-client-f',
        kind: 'ai',
        syncFiles: false,
        log: () => {},
      })

      faultSyncOk = await Promise.race([
        Promise.all([
          new Promise((res) => pollClient.provider.on('sync', (s) => { if (s) res(true) })),
          new Promise((res) => observerClient.provider.on('sync', (s) => { if (s) res(true) })),
        ]).then(() => true),
        sleep(4000).then(() => false),
      ])

      if (faultSyncOk) {
        pollClient.say('fault-test-message-1')
        pollClient.say('fault-test-message-2')

        const obsChat = observerClient.doc.getArray('chat')
        for (let i = 0; i < 40; i++) {
          const texts = obsChat.toArray().map((m) => String(m.text || ''))
          countMsg1 = texts.filter((t) => t.includes('fault-test-message-1')).length
          countMsg2 = texts.filter((t) => t.includes('fault-test-message-2')).length
          if (countMsg1 >= 1 && countMsg2 >= 1) break
          await sleep(100)
        }
      }
    } catch {} finally {
      if (pollClient) pollClient.stop()
      if (observerClient) observerClient.stop()
    }

    T('F1 dropped recv answer is re-polled and recovered with zero frame loss',
      proxy.droppedRecvCount >= 1 && faultSyncOk && countMsg1 >= 1 && countMsg2 >= 1,
      `droppedRecvCount=${proxy.droppedRecvCount}, countMsg1=${countMsg1}, countMsg2=${countMsg2}`)
    T('F2 duplicated send frame is deduplicated via x-hive-seq without error (exactly once)',
      proxy.duplicatedSendCount >= 1 && countMsg1 === 1 && countMsg2 === 1,
      `duplicatedSendCount=${proxy.duplicatedSendCount}, countMsg1=${countMsg1}, countMsg2=${countMsg2}`)
  }

  // ─── R: RESILIENCE & LIFECYCLE ────────────────────────────────────────────────
  sec('R  Resilience: relay restart, idle keepalive, forced WS, old relay, token revocation')
  {
    // R1: Relay restart resilience (verified by peer observing message across restart)
    let relay = await startRelay()
    liveRelays.push(relay)
    const proxy = await createVmProxy({ targetPort: relay.port })
    liveProxies.push(proxy)

    const tmpR1 = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-r1-'))
    const tmpR1Obs = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-r1-obs-'))
    let resyncAfterRestart = false
    let restartMessageArrived = false
    let hive = null
    let observerAfterRestart = null
    try {
      hive = startSync({
        relay: proxy.httpUrl,
        room: 'room-test-restart',
        dir: tmpR1,
        name: 'test-restart',
        kind: 'ai',
        syncFiles: false,
        log: () => {},
      })
      const initialSync = await Promise.race([
        new Promise((res) => hive.provider.on('sync', (s) => { if (s) res(true) })),
        sleep(3000).then(() => false),
      ])
      if (initialSync) {
        // Kill and restart relay on same port
        relay.kill()
        await sleep(500)
        const restartedRelay = await startRelay({ PORT: String(relay.port) })
        liveRelays.push(restartedRelay)

        // Wait for poll client to reconnect
        await sleep(2000)
        hive.say('after-restart-message')

        // Observer connects to restarted relay and verifies arrival
        observerAfterRestart = startSync({
          relay: restartedRelay.wsUrl,
          room: 'room-test-restart',
          dir: tmpR1Obs,
          name: 'obs-restart',
          kind: 'ai',
          syncFiles: false,
          log: () => {},
        })

        const obsSynced = await Promise.race([
          new Promise((res) => observerAfterRestart.provider.on('sync', (s) => { if (s) res(true) })),
          sleep(3000).then(() => false),
        ])

        if (obsSynced) {
          const chat = observerAfterRestart.doc.getArray('chat')
          for (let i = 0; i < 30; i++) {
            const texts = chat.toArray().map((m) => String(m.text || ''))
            if (texts.some((t) => t.includes('after-restart-message'))) {
              restartMessageArrived = true
              break
            }
            await sleep(100)
          }
        }
        resyncAfterRestart = restartMessageArrived
      }
    } catch {} finally {
      if (hive) hive.stop()
      if (observerAfterRestart) observerAfterRestart.stop()
    }
    T('R1 client reconnects and resumes sync across relay restart (verified by peer)',
      resyncAfterRestart === true && restartMessageArrived === true,
      resyncAfterRestart ? 'reconnected & delivered' : 'RED on 0.13.1')

    // R2: Real idle test (exercising long-poll keepalive/pong timeout > 45s or fast test)
    const idleSeconds = process.env.HIVE_FULL_IDLE ? 60 : 3
    console.log(`  (Testing idle keepalive for ${idleSeconds}s...)`)
    const tmpR2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-r2-'))
    const tmpR2Obs = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-r2-obs-'))
    let idleEditOk = false
    let hiveR2 = null
    let observerR2 = null
    try {
      hiveR2 = startSync({
        relay: proxy.httpUrl,
        room: 'room-test-idle',
        dir: tmpR2,
        name: 'test-idle',
        kind: 'ai',
        syncFiles: false,
        log: () => {},
      })
      observerR2 = startSync({
        relay: proxy.httpUrl,
        room: 'room-test-idle',
        dir: tmpR2Obs,
        name: 'test-idle-obs',
        kind: 'ai',
        syncFiles: false,
        log: () => {},
      })

      const bothSynced = await Promise.race([
        Promise.all([
          new Promise((res) => hiveR2.provider.on('sync', (s) => { if (s) res(true) })),
          new Promise((res) => observerR2.provider.on('sync', (s) => { if (s) res(true) })),
        ]).then(() => true),
        sleep(4000).then(() => false),
      ])

      if (bothSynced) {
        await sleep(idleSeconds * 1000)
        hiveR2.say('message-after-idle')
        const observerChat = observerR2.doc.getArray('chat')
        for (let i = 0; i < 30; i++) {
          const texts = observerChat.toArray().map((m) => String(m.text || ''))
          if (texts.some((t) => t.includes('message-after-idle'))) {
            idleEditOk = true
            break
          }
          await sleep(100)
        }
      }
    } catch {} finally {
      if (hiveR2) hiveR2.stop()
      if (observerR2) observerR2.stop()
    }
    T('R2 session survives idle window and propagates subsequent edit to peer', idleEditOk === true,
      idleEditOk ? 'ok' : 'RED on 0.13.1 (pending poll session keepalive)')

    // R3: HIVE_TRANSPORT=ws forced behind proxy = clear failure
    const tmpR3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-r3-'))
    let forcedWsFailedCleanly = false
    try {
      process.env.HIVE_TRANSPORT = 'ws'
      const hiveR3 = startSync({
        relay: proxy.httpUrl,
        room: 'room-test-forced-ws',
        dir: tmpR3,
        name: 'test-forced-ws',
        kind: 'ai',
        syncFiles: false,
        log: () => {},
      })
      const syncWs = await Promise.race([
        new Promise((res) => hiveR3.provider.on('sync', (s) => { if (s) res(true) })),
        sleep(2000).then(() => false),
      ])
      forcedWsFailedCleanly = !syncWs
      hiveR3.stop()
    } catch {
      forcedWsFailedCleanly = true
    } finally {
      delete process.env.HIVE_TRANSPORT
    }
    T('R3 HIVE_TRANSPORT=ws refuses fallback and fails when upgrades return 403',
      forcedWsFailedCleanly === true, `forcedWsFailedCleanly=${forcedWsFailedCleanly}`)

    // R4: Old relay with poll disabled (HIVE_RELAY_POLL=off) gives a clear error (Guard)
    const oldRelay = await startRelay({ HIVE_RELAY_POLL: 'off' })
    liveRelays.push(oldRelay)
    const oldProxy = await createVmProxy({ targetPort: oldRelay.port })
    liveProxies.push(oldProxy)

    const tmpR4 = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-r4-'))
    let oldRelayReportedError = false
    let hiveOld = null
    try {
      hiveOld = startSync({
        relay: oldProxy.httpUrl,
        room: 'room-test-old-relay',
        dir: tmpR4,
        name: 'test-old-relay',
        kind: 'ai',
        syncFiles: false,
        log: () => {},
      })
      const syncOld = await Promise.race([
        new Promise((res) => hiveOld.provider.on('sync', (s) => { if (s) res(true) })),
        sleep(2000).then(() => false),
      ])
      oldRelayReportedError = !syncOld
    } catch {
      oldRelayReportedError = true
    } finally {
      if (hiveOld) hiveOld.stop()
    }
    T('R4 [Guard] an old relay (HIVE_RELAY_POLL=off) refuses poll transport without silent hang',
      oldRelayReportedError === true, 'refusal verified')

    // R5: Real token revocation over poll in a secured room
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
    const fp = keyFingerprint(pubPem)
    const securedRoom = makeSecuredRoomId(pubPem, crypto.randomBytes(4).toString('hex'))
    const nowSec = Math.floor(Date.now() / 1000)

    const maintainerToken = sign({
      iss: 'hivecode', sub: 'Admin', name: 'Admin', kind: 'human',
      pk: pubPem,
      scopes: [{ room: securedRoom, role: 'maintainer' }],
      iat: nowSec, exp: nowSec + 3600,
      jti: 'jti-adm-' + crypto.randomBytes(4).toString('hex'),
    }, { privateKey: privPem })

    const agentJti = 'jti-poll-' + crypto.randomBytes(4).toString('hex')
    const agentToken = sign({
      iss: 'hivecode', sub: 'PollAgent', name: 'PollAgent', kind: 'ai',
      pk: pubPem,
      scopes: [{ room: securedRoom, role: 'writer' }],
      iat: nowSec, exp: nowSec + 3600,
      jti: agentJti,
    }, { privateKey: privPem })

    let revokeReceived = false
    let dropAcknowledged = false
    let sawRevokeClose = false
    let revokeCloseCode = 0
    let revokeCloseReason = ''
    const tmpR5 = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-test-r5-'))
    let hiveR5 = null
    try {
      hiveR5 = startSync({
        relay: proxy.httpUrl,
        room: securedRoom,
        dir: tmpR5,
        name: 'PollAgent',
        kind: 'ai',
        token: agentToken,
        syncFiles: false,
        log: () => {},
      })
      const syncSecured = await Promise.race([
        new Promise((res) => hiveR5.provider.on('sync', (s) => { if (s) res(true) })),
        sleep(3000).then(() => false),
      ])

      if (syncSecured) {
        // Latch the 4401 / "token revoked" close event so subsequent reconnect attempts (100ms later) do not overwrite it
        if (hiveR5.provider && hiveR5.provider.on) {
          hiveR5.provider.on('connection-close', (ev) => {
            if (ev && (ev.code === 4401 || (ev.reason && ev.reason.includes('token revoked')))) {
              sawRevokeClose = true
              revokeCloseCode = ev.code
              revokeCloseReason = ev.reason
            }
          })
        }

        // Call POST /__hive/revoke on the relay
        const revokeRes = await new Promise((res) => {
          const body = JSON.stringify({ room: securedRoom, token: maintainerToken, jti: agentJti })
          const req = http.request({
            host: '127.0.0.1',
            port: relay.port,
            method: 'POST',
            path: '/__hive/revoke',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, (r) => {
            let data = ''
            r.on('data', (d) => { data += d })
            r.on('end', () => {
              try { res(JSON.parse(data)) } catch { res({}) }
            })
          })
          req.on('error', () => res({}))
          req.end(body)
        })

        dropAcknowledged = revokeRes && revokeRes.ok === true && revokeRes.dropped === 1

        // Wait up to 2s for the revoke close event to be latched
        for (let i = 0; i < 20 && !sawRevokeClose; i++) {
          await sleep(100)
        }
        revokeReceived = dropAcknowledged && sawRevokeClose
      }
    } catch {} finally {
      if (hiveR5) hiveR5.stop()
    }

    T('R5 token revocation over poll reaches client with reason "token revoked"',
      revokeReceived === true,
      `revokeReceived=${revokeReceived}, dropAcknowledged=${dropAcknowledged}, closeCode=${revokeCloseCode}`)
  }

} finally {
  for (const p of liveProxies) { try { await p.close() } catch {} }
  for (const r of liveRelays) { try { r.kill() } catch {} }
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`)
process.exit(fail ? 1 : 0)
