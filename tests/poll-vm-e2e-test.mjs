// THE REAL VM PATH (HTTPS long-poll transport E2E):
//   1. A real `hive-mcp.js` child process over stdio JSON-RPC (`StdioClientTransport`) behind a proxy
//      that refuses every WebSocket upgrade with Antigravity VM's exact 403 ("WebSocket upgrades are
//      not allowed") while forwarding ordinary HTTP (`GET /health`, `POST /_hive_poll/*`).
//   2. A real `hive-await.js` OS listener process behind that same 403 proxy: reaching `listening`,
//      waking on an `@mention`, and FLUSHING its shared room cursor (`RC.publishCursor`) over an
//      in-flight `/_hive_poll/<sid>/send` (with 350 ms RTT > the 200 ms static sleep) before
//      `process.exit(0)` so `hive_delivered` says READ, `hive_check` stays quiet, and a re-armed
//      listener never livelocks on the already-delivered mention.
//
//   node tests/poll-vm-e2e-test.mjs

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { readArmed } from '../hive-listen.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MCP_PATH = path.join(ROOT, 'hive-mcp.js')
const AWAIT_PATH = path.join(ROOT, 'hive-await.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

async function waitUntil(pred, ms, step = 150) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await pred()) return true } catch {}
    await sleep(step)
  }
  return false
}

let pass = 0, fail = 0
const T = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `   ${extra}` : ''}`)
  if (ok) pass++; else fail++
}
const section = (s) => console.log(`\n# ${s}`)
const textOf = (r) => (r && r.content ? r.content.map((c) => c.text || '').join('\n') : String(r || ''))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-vm-e2e-'))
const RELAY_PORT = await freePort()
const PROXY_PORT = await freePort()
const room = 'room-vm-' + crypto.randomBytes(6).toString('hex')
const secretToken = 'tok-' + crypto.randomBytes(8).toString('hex')

// --- 1. Real Hivecode relay (`server.js`) ---
const relayProc = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(RELAY_PORT),
      HIVE_PERSIST_DIR: 'off',
    },
  })
  let said = ''
  const giveUp = setTimeout(() => {
    console.log(`  FAIL relay did not start on ${RELAY_PORT} within 20s: ${said.slice(-300)}`)
    try { p.kill() } catch {}
    process.exit(1)
  }, 20000)
  p.stdout.on('data', (d) => {
    said += d
    if (/listening on/.test(said)) { clearTimeout(giveUp); res(p) }
  })
  p.stderr.on('data', (d) => { said += d })
})

// --- 2. VM Egress Proxy: exact 403 on every WebSocket upgrade, streaming pass-through on HTTP ---
const proxyStats = {
  upgradesRefused: 0,
  upgradesAllowed: 0,
  httpRequests: 0,
  pollOpens: 0,
  pollSends: 0,
  pollRecvs: 0,
  pollCloses: 0,
  urls: [],
  sendDelayMs: 0,
}

const proxyServer = http.createServer((req, res) => {
  proxyStats.httpRequests++
  proxyStats.urls.push(req.url || '')
  if (req.url === '/_hive_poll/open') proxyStats.pollOpens++
  else if (/^\/_hive_poll\/[^/]+\/send(?:\?|$)/.test(req.url || '')) proxyStats.pollSends++
  else if (/^\/_hive_poll\/[^/]+\/recv(?:\?|$)/.test(req.url || '')) proxyStats.pollRecvs++
  else if (/^\/_hive_poll\/[^/]+\/close(?:\?|$)/.test(req.url || '')) proxyStats.pollCloses++

  // Safety check: even if Upgrade sneaks into normal request handler, refuse it identically.
  if (/websocket/i.test(String(req.headers.upgrade || ''))) {
    proxyStats.upgradesRefused++
    const body = 'WebSocket upgrades are not allowed\n'
    res.writeHead(403, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body), connection: 'close' })
    res.end(body)
    return
  }

  const isSend = /^\/_hive_poll\/[^/]+\/send(?:\?|$)/.test(req.url || '')
  const delay = isSend ? proxyStats.sendDelayMs : 0

  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks)
    const forward = () => {
      const headers = { ...req.headers, host: `127.0.0.1:${RELAY_PORT}` }
      delete headers['connection']
      const upReq = http.request(
        {
          host: '127.0.0.1',
          port: RELAY_PORT,
          method: req.method,
          path: req.url,
          headers,
          agent: false,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode || 502, upRes.headers)
          if (typeof res.flushHeaders === 'function') res.flushHeaders()
          upRes.on('data', (chunk) => res.write(chunk))
          upRes.on('end', () => res.end())
        }
      )
      upReq.on('error', (e) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        if (!res.writableEnded) res.end('proxy upstream error: ' + e.message)
      })
      res.on('close', () => { if (!res.writableFinished) upReq.destroy() })
      upReq.end(bodyBuf)
    }
    if (delay > 0) setTimeout(forward, delay)
    else forward()
  })
})

proxyServer.on('upgrade', (req, socket) => {
  proxyStats.upgradesRefused++
  proxyStats.urls.push(req.url || '')
  const body = 'WebSocket upgrades are not allowed\n'
  socket.end(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  )
})

await new Promise((res) => proxyServer.listen(PROXY_PORT, '127.0.0.1', res))

const DIRECT_LINK = `ws://127.0.0.1:${RELAY_PORT}|${room}`
const PROXY_LINK = `ws://127.0.0.1:${PROXY_PORT}|${room}`

/** Spawn an isolated stdio `hive-mcp.js` child process using official MCP SDK. */
async function spawnMcpAgent(label, extraEnv = {}) {
  const agentRoot = path.join(tmp, `agent-${label}`)
  const workDir = path.join(agentRoot, 'work')
  const homeDir = path.join(agentRoot, 'home')
  const tempDir = path.join(agentRoot, 'temp')
  const syncDir = path.join(agentRoot, 'room-dir')
  fs.mkdirSync(workDir, { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(tempDir, { recursive: true })
  fs.mkdirSync(syncDir, { recursive: true })

  const env = {
    ...process.env,
    HIVE_HOME: homeDir,
    TEMP: tempDir,
    TMPDIR: tempDir,
    HIVE_PROVENANCE: 'on',
    ANTIGRAVITY_AGENT: '1',
    ...extraEnv,
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_PATH],
    cwd: workDir,
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'antigravity-client', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return {
    client,
    transport,
    syncDir,
    tempDir,
    env,
    call: async (name, args = {}) => {
      try { return textOf(await client.callTool({ name, arguments: args })) }
      catch (e) { return `ERROR: ${e.message}` }
    },
    close: async () => { try { await client.close() } catch {} },
  }
}

/** Spawn `hive-await.js` as a separate OS process, mirroring background listener arming on the VM. */
function spawnListener({ link, name, idleMin = 5, app = 'antigravity', env, readyMs = 15000 }) {
  const child = spawn(process.execPath, [AWAIT_PATH, link, name, String(idleMin), app], {
    cwd: ROOT,
    env: { ...env, HIVE_AWAIT_KEEP_ALIVE: '1' },
  })
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const ready = waitUntil(() => /listening in/.test(err), readyMs, 100)
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  return {
    child,
    ready,
    stderr: () => err,
    stdout: () => out,
    waitExit: async (ms) => {
      const code = await Promise.race([exited, sleep(ms).then(() => 'running')])
      if (code === 'running') {
        try { child.kill() } catch {}
        return { running: true, code: null, out, err }
      }
      return { running: false, code, out: out.trim(), err }
    },
    kill: () => { try { child.kill() } catch {} },
  }
}

let peerWS = null
let vmAgent = null

try {
  // ---------------------------------------------------------------------------
  section('1. Proxy anti-vacuity: blocks WebSocket upgrades with 403, passes plain HTTP')

  const wsProbe = await new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}/${room}`)
    let status = null
    ws.on('unexpected-response', (_req, upRes) => {
      let body = ''
      upRes.on('data', (c) => { body += c })
      upRes.on('end', () => res({ opened: false, status: upRes.statusCode, body }))
    })
    ws.on('open', () => { proxyStats.upgradesAllowed++; ws.close(); res({ opened: true, status: 101, body: '' }) })
    ws.on('error', (e) => res({ opened: false, status, body: e.message }))
  })
  T(
    'V1 raw WebSocket upgrade through VM proxy is refused with exact 403 "WebSocket upgrades are not allowed"',
    !wsProbe.opened && wsProbe.status === 403 && /WebSocket upgrades are not allowed/.test(wsProbe.body),
    JSON.stringify(wsProbe)
  )

  const healthRes = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`)
  let healthJson = {}
  try { healthJson = await healthRes.json() } catch {}
  T(
    'V2 plain HTTP GET /health through VM proxy returns 200 ok:true from real relay',
    healthRes.status === 200 && healthJson.ok === true,
    `status=${healthRes.status} poll=${healthJson.poll}`
  )

  // V2b / Negative control (RED proof without poll fallback): WebSocket-only stdio hive-mcp.js fails to join behind 403 proxy
  const legacyWsAgent = await spawnMcpAgent('legacy-ws-only', { HIVE_TRANSPORT: 'ws' })
  const legacyJoin = await legacyWsAgent.call('hive_join', {
    link: PROXY_LINK,
    name: 'LegacyWS',
    dir: legacyWsAgent.syncDir,
    token: secretToken,
  })
  await legacyWsAgent.close()
  T(
    'V2b negative control (HIVE_TRANSPORT=ws): without poll fallback, stdio hive-mcp.js fails to join behind 403 proxy (pollOpens=0)',
    /NOT JOINED/i.test(legacyJoin) && proxyStats.pollOpens === 0 && proxyStats.upgradesRefused >= 2,
    `legacyJoin=${legacyJoin.split('\n')[0]} upgradesRefused=${proxyStats.upgradesRefused} pollOpens=${proxyStats.pollOpens}`
  )

  // ---------------------------------------------------------------------------
  section('2. Real stdio hive-mcp.js behind 403 VM proxy + mixed WS peer in same room')

  peerWS = await spawnMcpAgent('peer-ws')
  vmAgent = await spawnMcpAgent('vm-poll')

  const peerJoin = await peerWS.call('hive_join', {
    link: DIRECT_LINK,
    name: 'PeerWS',
    dir: peerWS.syncDir,
    token: secretToken,
  })
  fs.writeFileSync(path.join(peerWS.syncDir, 'seed.js'), 'export const seed = 1\n')
  await sleep(400)

  const vmJoin = await vmAgent.call('hive_join', {
    link: PROXY_LINK,
    name: 'VMAgent',
    dir: vmAgent.syncDir,
    token: secretToken,
  })
  const vmJoined = /^joined\b/.test(vmJoin)
  const vmStatusRaw = await vmAgent.call('hive_status', {})
  let vmStatus = {}
  try { vmStatus = JSON.parse(vmStatusRaw.split('\n---')[0]) } catch {}

  const seedArrived = vmJoined && await waitUntil(
    () => fs.existsSync(path.join(vmAgent.syncDir, 'seed.js')) &&
          fs.readFileSync(path.join(vmAgent.syncDir, 'seed.js'), 'utf8') === 'export const seed = 1\n',
    10000
  )

  T(
    'V3 stdio hive-mcp.js joins behind 403 proxy over poll transport and syncs room files',
    vmJoined &&
      vmStatus.connected === true &&
      seedArrived &&
      proxyStats.pollOpens > 0 &&
      proxyStats.upgradesAllowed === 0,
    `join=${vmJoin.split('\n')[0]} | opens=${proxyStats.pollOpens} sends=${proxyStats.pollSends} recvs=${proxyStats.pollRecvs}`
  )

  const leakedUrls = proxyStats.urls.filter(
    (u) => !u.startsWith('/_hive_poll') && u !== '/health' ? false : (u.includes(room) || u.includes(secretToken))
  )
  // Check ALL HTTP URLs (excluding the initial WS upgrade attempt before fallback): no /_hive_poll URL may carry room or token!
  const pollUrlsWithSecrets = proxyStats.urls.filter(
    (u) => u.startsWith('/_hive_poll') && (u.includes(room) || u.includes(secretToken) || u.includes('VMAgent'))
  )
  T(
    'V4 URL privacy: zero /_hive_poll/* proxy URLs carry room id, secret token, or agent name',
    proxyStats.pollOpens > 0 && pollUrlsWithSecrets.length === 0 && leakedUrls.length === 0,
    pollUrlsWithSecrets.length ? `LEAKED: ${pollUrlsWithSecrets.join(', ')}` : `pollOpens=${proxyStats.pollOpens} checked=${proxyStats.urls.length} URLs`
  )

  // V5: Authored write + provenance + cross-peer attestation quorum across Poll -> WS
  const contentV5 = 'export const fromVm = 42\n'
  const claimOut = await vmAgent.call('hive_claim', { region: 'vm-feature.js', intent: 'add VM feature over long-poll' })
  const editOut = await vmAgent.call('hive_edit', {
    file: 'vm-feature.js',
    content: contentV5,
    intent: 'add VM feature over long-poll',
  })
  const vmFileOnWs = /^claimed vm-feature\.js/.test(claimOut) && await waitUntil(
    () => fs.existsSync(path.join(peerWS.syncDir, 'vm-feature.js')) &&
          fs.readFileSync(path.join(peerWS.syncDir, 'vm-feature.js'), 'utf8') === contentV5,
    10000
  )
  const releaseOut = await vmAgent.call('hive_release', { region: 'vm-feature.js' })
  await vmAgent.call('hive_attest', { file: 'vm-feature.js', bytes: Buffer.byteLength(contentV5), lines: 1 })
  // Wait for VMAgent's attestation over long-poll to reach PeerWS before PeerWS attests
  // (swarmAttest stores a plain object per path, so concurrent .set(p, next) before propagation LWW-clobbers).
  await waitUntil(async () => {
    const v1 = await peerWS.call('hive_verified', { file: 'vm-feature.js' })
    return /VMAgent:\s*25 bytes/.test(v1)
  }, 5000, 80)
  if (vmFileOnWs) {
    const wsDiskBytes = fs.statSync(path.join(peerWS.syncDir, 'vm-feature.js')).size
    await peerWS.call('hive_attest', { file: 'vm-feature.js', bytes: wsDiskBytes, lines: 1 })
  }
  const verifiedOut = await peerWS.call('hive_verified', { file: 'vm-feature.js' })

  T(
    'V5 authored claim -> hive_edit -> hive_release over poll lands on WS peer with clean release check and 2-peer attestation quorum',
    /^claimed vm-feature\.js/.test(claimOut) &&
      /wrote vm-feature\.js through the medium/.test(editOut) &&
      /^released vm-feature\.js/.test(releaseOut) &&
      !/UNCHANGED in the room/.test(releaseOut) &&
      vmFileOnWs &&
      /VMAgent:\s*25 bytes/.test(verifiedOut) &&
      /QUORUM: confirmed by 2\+ peers/.test(verifiedOut),
    `release=${releaseOut.split('\n')[0]} | verified=${verifiedOut.replace(/\s+/g, ' ').slice(0, 140)}`
  )

  // V6: WS -> Poll file sync + @mention mailbox delivery
  await peerWS.call('hive_claim', { region: 'from-ws.js', intent: 'ws to poll sync' })
  await peerWS.call('hive_edit', {
    file: 'from-ws.js',
    content: 'export const fromWs = 99\n',
    intent: 'ws to poll sync',
  })
  await peerWS.call('hive_release', { region: 'from-ws.js' })
  await peerWS.call('hive_say', { text: '@VMAgent please review from-ws.js' })

  const wsFileOnVm = vmJoined && await waitUntil(
    () => fs.existsSync(path.join(vmAgent.syncDir, 'from-ws.js')) &&
          fs.readFileSync(path.join(vmAgent.syncDir, 'from-ws.js'), 'utf8') === 'export const fromWs = 99\n',
    10000
  )
  // Chat and files travel on separate long-poll sessions, so the file landing does not mean the
  // mention has: measured 116-127 ms later on Claude's machine. Wait for it without marking it read.
  if (wsFileOnVm) await waitUntil(async () => /please review from-ws.js/.test(await vmAgent.call('hive_check', { peek: true })), 10000, 100)
  const checkOut = await vmAgent.call('hive_check', {})

  T(
    'V6 WS -> Poll file edit and @VMAgent chat arrive in stdio MCP session behind 403 proxy',
    wsFileOnVm && /please review from-ws\.js/.test(checkOut),
    `wsFileOnVm=${wsFileOnVm} | check=${checkOut.split('\n')[0]}`
  )

  // ---------------------------------------------------------------------------
  section('3. Real hive-await.js OS listener behind 403 proxy: wake + mutant-killing exit cursor flush')

  // Inject 350ms RTT on POST /_hive_poll/<sid>/send (> hive-await.js's 200ms static sleep!)
  // If PollSocket.bufferedAmount did NOT count in-flight HTTP POST bytes, finish() would exit at
  // 200ms and kill the socket mid-POST, dropping the shared cursor update!
  proxyStats.sendDelayMs = 350
  const listenerWaitMs = healthJson.poll === 1 ? 15000 : 3000
  const opensBeforeListener = proxyStats.pollOpens

  const listener1 = spawnListener({
    link: PROXY_LINK,
    name: 'VMAgent',
    idleMin: 5,
    app: 'antigravity',
    env: { ...vmAgent.env, HIVE_TOKEN: secretToken },
    readyMs: listenerWaitMs,
  })
  const l1Ready = await listener1.ready
  const armedRec = readArmed('VMAgent', room, vmAgent.env)
  const membersOnWs = await peerWS.call('hive_members', {})

  await peerWS.call('hive_say', { text: '@VMAgent wake up over long-poll!' })
  const l1Exit = await listener1.waitExit(l1Ready ? 10000 : 1000)
  let wakeJson = null
  try { wakeJson = JSON.parse(l1Exit.out.split('\n').pop() || '{}') } catch {}

  T(
    'V7 hive-await.js behind 403 proxy opens poll session, syncs (armed.synced=true), shows Reachable, and wakes with exit 0 on @mention',
    l1Ready &&
      proxyStats.pollOpens > opensBeforeListener &&
      Boolean(armedRec && armedRec.synced === true) &&
      /VMAgent.*Reachable\./.test(membersOnWs) &&
      !l1Exit.running &&
      l1Exit.code === 0 &&
      wakeJson?.reason === 'mention' &&
      (wakeJson.messages || []).some((m) => /wake up over long-poll!/.test(m)),
    `ready=${l1Ready} opensDelta=${proxyStats.pollOpens - opensBeforeListener} code=${l1Exit.code} out=${l1Exit.out.slice(0, 160)}`
  )

  // Give relay 200ms after process exit to settle, then check sender's hive_delivered!
  await sleep(200)
  const deliveredOut = await peerWS.call('hive_delivered', {})
  const lines = deliveredOut.split('\n')
  const wakeDeliveryLine = lines.find((l) => /wake up over long-poll!/.test(l)) || ''

  T(
    'V8 exit cursor flush (350ms /send RTT > 200ms sleep): hive-await held exit via bufferedAmount until READ cursor committed on relay',
    /VMAgent=READ/.test(wakeDeliveryLine),
    wakeDeliveryLine || deliveredOut.slice(0, 220)
  )

  // V9: Re-arm with a FRESH temp directory (no local .await-cursor file!) to prove the SHARED room
  // cursor on the relay prevents re-firing (no 420-loop livelock), AND MCP hive_check stays quiet.
  const freshTemp = fs.mkdtempSync(path.join(tmp, 'fresh-await-temp-'))
  const listener2 = spawnListener({
    link: PROXY_LINK,
    name: 'VMAgent',
    idleMin: 5,
    app: 'antigravity',
    env: { ...vmAgent.env, TEMP: freshTemp, TMPDIR: freshTemp, HIVE_TOKEN: secretToken },
    readyMs: listenerWaitMs,
  })
  const l2Ready = await listener2.ready
  const l2After2s = await listener2.waitExit(l2Ready ? 2000 : 500)
  const mcpCheckAfter = await vmAgent.call('hive_check', {})

  T(
    'V9 anti-livelock: re-armed hive-await (even with fresh TEMP) stays blocked and MCP hive_check does not re-announce delivered mail',
    l2Ready &&
      l2After2s.running === true &&
      /(?:no new mail|nothing waiting)/.test(mcpCheckAfter) &&
      !/wake up over long-poll!/.test(mcpCheckAfter),
    `l2Ready=${l2Ready} running=${l2After2s.running} out=${l2After2s.out.slice(0, 120)} mcpCheck=${mcpCheckAfter.split('\n')[0]}`
  )
} finally {
  if (vmAgent) await vmAgent.close()
  if (peerWS) await peerWS.close()
  await new Promise((r) => proxyServer.close(() => r()))
  try { relayProc.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
