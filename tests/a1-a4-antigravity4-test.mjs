// Red-first test suite for antigravity-4's Phase 4 deliverables:
//   A1-CLI (hive-slack-connect.js, hive-slack.js): private hs_ token in /slack/prepare, /slack/list,
//          host /slack/disconnect without signingSecret, open rooms stay { room }.
//   A4     (hive-room-mode.js, hive-room-watcher.js, hive-doctor.js, hive-slack-agent.js,
//           hive-mcp-http.js, hive-instructions.js, hive-mcp.js:1185):
//          forward token on ws/HTTP, mask hs_ in logs/paths, drop `&& uid` on hive_pause,
//          name `invite` command instead of `(hivecode-token)` alone.
//
//   node tests/a1-a4-antigravity4-test.mjs

import crypto from 'crypto'
import { EventEmitter } from 'events'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { sign, makeSecuredRoomId } from '../token.js'
import { startSync } from '../sync.js'
import * as SC from '../hive-slack-connect.js'
import { main as slackMain } from '../hive-slack.js'
import { validateRoomLink, checkRoomModeStart } from '../hive-room-mode.js'
import { roomSay, peekRoom } from '../hive-room-watcher.js'
import { serve as serveMcpHttp, resolveConfig as resolveMcpHttpConfig, main as mcpHttpMain } from '../hive-mcp-http.js'
import { AGENT_MANUAL } from '../hive-instructions.js'
import { saveRoomToken } from '../hive-room-key.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
async function until(pred, ms = 12000, step = 150) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await pred()) return true } catch {} await sleep(step) }
  try { return !!(await pred()) } catch { return false }
}

let pass = 0
let fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? `   -- ${detail}` : ''}`) }
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const pkPem = publicKey.export({ type: 'spki', format: 'pem' })
const skPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const HS_ROOM = makeSecuredRoomId(pkPem, crypto.randomBytes(8).toString('hex'))
const now = Math.floor(Date.now() / 1000)
const mint = (name, role) => sign({
  iss: 'hivecode',
  sub: name,
  name,
  kind: 'ai',
  pk: pkPem,
  scopes: [{ room: HS_ROOM, role }],
  iat: now,
  exp: now + 3600,
  jti: 'jti-' + crypto.randomBytes(6).toString('hex'),
}, { privateKey: skPem })
const HOST_TOK = mint('Host', 'maintainer')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-a1a4-'))
const kids = []
const handles = []
let relayProc = null

process.on('exit', () => {
  for (const h of handles) { try { h.stop ? h.stop() : h.close && h.close() } catch {} }
  for (const k of kids) { try { k.kill() } catch {} }
  try { relayProc && relayProc.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
})

try {
  // ── 1. A1-CLI: hive-slack-connect.js + hive-slack.js ─────────────────────────────────────────
  console.log('\n# 1. A1-CLI: hive-slack-connect.js + hive-slack.js')
  {
    const homeOpen = path.join(tmp, 'home-open')
    const homePriv = path.join(tmp, 'home-priv')
    const calls = []
    const fetchMock = (opts = {}) => async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : {}
      const route = new URL(url).pathname
      calls.push({ url, route, body })
      if (route === '/slack/prepare') {
        if (String(body.room || '').startsWith('hs_') && !body.token) {
          return { status: 401, ok: false, json: async () => ({ ok: false, code: 'Q674', why: 'Q674 invite token required' }) }
        }
        return { status: 200, ok: true, json: async () => ({ ok: true, id: 'conn-1', eventsUrl: 'https://relay.example/slack/events/conn-1', installUrl: 'https://relay.example/slack/install/conn-1' }) }
      }
      if (route === '/slack/status') {
        return { status: 200, ok: true, json: async () => ({ ok: true, connected: true, channel: 'ops' }) }
      }
      if (route === '/slack/list') {
        if (!body.token) return { status: 401, ok: false, json: async () => ({ ok: false, code: 'Q674', why: 'Q674 token required' }) }
        return {
          status: 200,
          ok: true,
          json: async () => ({
            ok: true,
            connections: opts.list ?? [{ id: 'conn-1', channel: 'ops', team: 'Acme', by: 'Host', connectedAt: 1700000000000, shared: true }],
          }),
        }
      }
      if (route === '/slack/disconnect') {
        if (String(body.room || '').startsWith('hs_') && body.token) {
          return { status: 200, ok: true, json: async () => ({ ok: true, ended: 1 }) }
        }
        return { status: 401, ok: false, json: async () => ({ ok: false, code: 'Q663', why: 'Q663 bad signing secret' }) }
      }
      return { status: 404, ok: false, json: async () => ({ ok: false, code: 'http_404', why: 'not found' }) }
    }

    const outOpen = []
    const cOpen = await SC.runSlackConnect({
      link: 'wss://relay.example|room-open123',
      fetchImpl: fetchMock(),
      pollMs: 1, waitMs: 100, sleep,
      log: (s) => outOpen.push(s), logErr: (s) => outOpen.push(s),
      home: homeOpen,
    })
    const openPrep = calls.find((c) => c.route === '/slack/prepare' && c.body.room === 'room-open123')
    T('A1.1a open room /slack/prepare still sends { room } with no token property',
      cOpen === 0 && openPrep && !('token' in openPrep.body),
      openPrep ? JSON.stringify(openPrep.body) : outOpen.join(' | '))

    calls.length = 0
    const outPriv = []
    const cPriv = await SC.runSlackConnect({
      link: `wss://relay.example|${HS_ROOM}|${HOST_TOK}`,
      fetchImpl: fetchMock(),
      pollMs: 1, waitMs: 100, sleep,
      log: (s) => outPriv.push(s), logErr: (s) => outPriv.push(s),
      home: homePriv,
    })
    const privPrep = calls.find((c) => c.route === '/slack/prepare')
    T('A1.1b private hs_ room /slack/prepare sends { room, token } and succeeds without leaking token in output',
      cPriv === 0 && privPrep && privPrep.body.room === HS_ROOM && privPrep.body.token === HOST_TOK
      && !outPriv.join('\n').includes(HOST_TOK),
      privPrep ? JSON.stringify({ keys: Object.keys(privPrep.body), out: outPriv.join(' | ').slice(0, 120) }) : 'no call')

    T('A1.2a hive-slack-connect.js exports runSlackList', typeof SC.runSlackList === 'function')
    if (typeof SC.runSlackList === 'function') {
      calls.length = 0
      const outList = []
      const cList = await SC.runSlackList({
        link: `wss://relay.example|${HS_ROOM}|${HOST_TOK}`,
        fetchImpl: fetchMock(),
        log: (s) => outList.push(s), logErr: (s) => outList.push(s),
      })
      const listCall = calls.find((c) => c.route === '/slack/list')
      T('A1.2b runSlackList posts { room, token } and prints #channel / team / by cleanly',
        cList === 0 && listCall && listCall.body.token === HOST_TOK && /ops/.test(outList.join('\n')) && !outList.join('\n').includes(HOST_TOK),
        outList.join(' | '))
    }

    calls.length = 0
    const outCliList = []
    const cCliList = await slackMain(['list', `wss://relay.example|${HS_ROOM}|${HOST_TOK}`], {
      fetchImpl: fetchMock(),
      log: (s) => outCliList.push(s),
      logErr: (s) => outCliList.push(s),
    })
    T('A1.2c hive-slack.js routes `slack list` CLI cleanly',
      cCliList === 0 && /ops/.test(outCliList.join('\n')),
      outCliList.join(' | '))

    calls.length = 0
    const outDisc = []
    const cDisc = await SC.runSlackDisconnect({
      link: `wss://relay.example|${HS_ROOM}|${HOST_TOK}`,
      env: {}, interactive: false,
      fetchImpl: fetchMock(),
      log: (s) => outDisc.push(s), logErr: (s) => outDisc.push(s),
      home: path.join(tmp, 'home-fresh'),
    })
    const discCall = calls.find((c) => c.route === '/slack/disconnect')
    T('A1.3 host disconnect on hs_ room sends { room, token } without SLACK_SIGNING_SECRET or remembered id',
      cDisc === 0 && discCall && discCall.body.room === HS_ROOM && discCall.body.token === HOST_TOK,
      outDisc.join(' | '))

    calls.length = 0
    const outSt = []
    const cSt = await SC.runSlackStatus({
      link: `wss://relay.example|${HS_ROOM}|${HOST_TOK}`,
      env: {}, fetchImpl: fetchMock(),
      log: (s) => outSt.push(s), logErr: (s) => outSt.push(s),
      home: path.join(tmp, 'home-fresh-2'),
    })
    T('A1.4 host status on hs_ room without remembered id checks /slack/list with token',
      cSt === 0 && /ops/.test(outSt.join('\n')),
      outSt.join(' | '))
  }

  // ── Spin up real relay for live A4 checks ──────────────────────────────────────────────────
  const PORT = await freePort()
  const RELAY = `ws://127.0.0.1:${PORT}`
  relayProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_SEATS: '25' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let relayReady = false
  relayProc.stdout.on('data', (d) => { if (/listening on/.test(String(d))) relayReady = true })
  await until(() => relayReady, 15000, 100)
  if (!relayReady) throw new Error('relay failed to start')

  // Seed one file in HS_ROOM as Host
  const seedDir = path.join(tmp, 'seed-host')
  fs.mkdirSync(seedDir, { recursive: true })
  fs.writeFileSync(path.join(seedDir, 'hello.txt'), 'hello', 'utf8')
  const seeder = startSync({ relay: RELAY, room: HS_ROOM, dir: seedDir, name: 'HostSeed', kind: 'ai', token: HOST_TOK, log: () => {} })
  handles.push(seeder)
  await until(() => seeder.provider && seeder.provider.synced && seeder.doc.getMap('manifest').has('hello.txt'), 12000)
  await sleep(500)

  // ── 2. A4: hive-room-mode.js ───────────────────────────────────────────────────────────────
  console.log('\n# 2. A4: hive-room-mode.js')
  {
    const linkWithTok = `${RELAY}|${HS_ROOM}|${HOST_TOK}`
    const parsed = validateRoomLink(linkWithTok)
    T('M1 validateRoomLink preserves token from link',
      parsed && parsed.ok === true && parsed.token === HOST_TOK,
      JSON.stringify(parsed))

    const repoDir = path.join(tmp, 'repo-rm')
    fs.mkdirSync(repoDir, { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: repoDir })
    spawnSync('git', ['config', '--local', 'hivecode.main.room', `${RELAY}|${HS_ROOM}`], { cwd: repoDir })
    const startRes = await checkRoomModeStart({
      link: linkWithTok,
      repo: repoDir,
      timeoutMs: 4000,
      ghRunner: () => ({ status: 0, stdout: 'Logged in' }),
    })
    if (startRes && startRes.release) startRes.release()
    T('M2 checkRoomModeStart forwards link token into live checkRoomConnection (passes auth)',
      Boolean(startRes && startRes.ok === true),
      startRes ? `${startRes.code || ''} ${startRes.why || ''}` : 'null')
  }

  // ── 3. A4: hive-room-watcher.js ────────────────────────────────────────────────────────────
  console.log('\n# 3. A4: hive-room-watcher.js')
  {
    const linkWithTok = `${RELAY}|${HS_ROOM}|${HOST_TOK}`
    const sayRes = await roomSay({ link: linkWithTok, text: 'hello private room', timeoutMs: 4000 })
    T('W1 roomSay forwards link token to private hs_ room', Boolean(sayRes && sayRes.ok), sayRes ? `${sayRes.code} ${sayRes.why}` : 'null')
    const peekRes = await peekRoom({ link: linkWithTok, issueNumber: 1, taskId: 't1', timeoutMs: 4000 })
    T('W2 peekRoom forwards link token to private hs_ room', Boolean(peekRes && peekRes.ok), peekRes ? peekRes.why : 'null')
  }

  // ── 4. A4: hive-doctor.js ──────────────────────────────────────────────────────────────────
  console.log('\n# 4. A4: hive-doctor.js')
  {
    const runDoc = spawnSync(process.execPath, [path.join(ROOT, 'hive-doctor.js'), `${RELAY}|${HS_ROOM}|${HOST_TOK}`, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 22000,
    })
    let j = null
    try { const i = runDoc.stdout.indexOf('{'); if (i >= 0) j = JSON.parse(runDoc.stdout.slice(i)) } catch {}
    T('D1 hive-doctor connects to private hs_ room using link token, verdict OK, never prints token',
      runDoc.status === 0 && j && j.verdict === 'OK' && j.contentBytes === 5 && !runDoc.stdout.includes(HOST_TOK) && !runDoc.stderr.includes(HOST_TOK),
      `code=${runDoc.status} err=${String(runDoc.stderr || '').slice(0, 180)} out=${String(runDoc.stdout || '').slice(0, 180)}`)
  }

  // ── 5. A4: hive-slack-agent.js ─────────────────────────────────────────────────────────────
  console.log('\n# 5. A4: hive-slack-agent.js')
  {
    const agentTemp = path.join(tmp, 'agent-temp')
    fs.mkdirSync(agentTemp, { recursive: true })
    const httpSrv = http.createServer((req, res) => {
      if (req.url === '/api/auth.test') {
        res.writeHead(200, { 'x-oauth-scopes': 'chat:write,assistant:write,im:history,im:read,im:write,users:read', 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, user: 'hive', user_id: 'U_BOT', team_id: 'T1' }))
      } else if (req.url === '/api/apps.connections.open') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, url: 'ws://127.0.0.1:1' }))
      }
    })
    await new Promise((r) => httpSrv.listen(0, r))
    const slackApi = `http://127.0.0.1:${httpSrv.address().port}/api`

    class FakeSlackWS extends EventEmitter {
      constructor() {
        super()
        this.readyState = 1
        setTimeout(() => {
          this.emit('open')
          this.emit('message', JSON.stringify({ type: 'hello', num_connections: 1 }))
        }, 20)
      }
      send() {}
      ping() {}
      close() { this.emit('close', 1000, Buffer.from('')) }
      terminate() { this.emit('close', 1006, Buffer.from('')) }
    }
    FakeSlackWS.OPEN = 1

    const logs = []
    const errs = []
    const mod = await import('../hive-slack-agent.js')
    const p = mod.main([`${RELAY}|${HS_ROOM}|${HOST_TOK}`, '--channel', 'D-TEST', '--name', 'SlackAgentTest'], {
      env: { ...process.env, SLACK_BOT_TOKEN: 'xoxb-dummy', SLACK_APP_TOKEN: 'xapp-dummy', TEMP: agentTemp },
      log: (s) => logs.push(s),
      logErr: (s) => errs.push(s),
      fetchImpl: (url, init) => {
        const u = String(url)
        if (u.includes('/auth.test')) return fetch(`${slackApi}/auth.test`, init)
        if (u.includes('/apps.connections.open')) return fetch(`${slackApi}/apps.connections.open`, init)
        return fetch(url, init)
      },
      WebSocketImpl: FakeSlackWS,
    })
    await until(() => logs.some((l) => /READY:/.test(l)) && seeder.members().some((m) => m.name === 'SlackAgentTest'), 5000, 100)
    const joined = seeder.members().some((m) => m.name === 'SlackAgentTest')
    process.emit('SIGINT')
    await Promise.race([p, sleep(1000)])
    httpSrv.close()
    const tempNames = fs.readdirSync(agentTemp)
    const readyLine = logs.find((l) => /READY:/.test(l)) || ''
    T('SA1 hive-slack-agent authenticates into hs_ room, masks hs_ ID in READY log and temp dir',
      joined && readyLine !== '' && !readyLine.includes(HS_ROOM) && !tempNames.some((n) => n.includes(HS_ROOM)),
      `joined=${joined} ready="${readyLine}" dirs=${tempNames.join(',')}`)
  }

  // ── 6. A4 + #7: hive-mcp-http.js ───────────────────────────────────────────────────────────
  console.log('\n# 6. A4 + #7: hive-mcp-http.js')
  {
    const dirA = path.join(tmp, 'mh-agent')
    const dirPanel = path.join(tmp, 'mh-panel')
    fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirPanel, { recursive: true })
    const agent = startSync({ relay: RELAY, room: HS_ROOM, dir: dirA, name: 'AgentMcp', kind: 'ai', token: HOST_TOK, syncFiles: false, log: () => {} })
    const panel = startSync({ relay: RELAY, room: HS_ROOM, dir: dirPanel, name: 'Panel', kind: 'human', token: HOST_TOK, syncFiles: false, log: () => {} })
    handles.push(agent, panel)
    await until(() => agent.provider.synced && panel.provider.synced && panel.members().some((m) => m.name === 'AgentMcp'), 12000)

    const port = await freePort()
    const SECRET = 'slack-secret-test-123'
    const srv = await serveMcpHttp({
      hive: panel,
      room: HS_ROOM,
      port,
      auth: 'slack',
      signingSecret: SECRET,
      token: 'xoxb-dummy',
      allow: ['U0HOST'],
      teamId: 'T1',
      lookupUser: async (uid) => ({ ok: true, user: { id: uid, name: 'host', team_id: 'T1' } }),
    })
    handles.push({ stop: () => srv.close() })

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hive_pause', arguments: { who: 'all' } } })
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = 'v0=' + crypto.createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig },
    })
    const txt = await res.text()
    await sleep(600)
    T('MH1 hive_pause with --auth slack and missing _meta.slack.user_id is REFUSED and does not pause AgentMcp',
      /Refused/i.test(txt) && agent.isPaused() === false,
      `resp=${txt.slice(0, 160)} paused=${agent.isPaused()}`)
    srv.close()

    const cfg = resolveMcpHttpConfig([`${RELAY}|${HS_ROOM}|${HOST_TOK}`], {})
    T('MH2 resolveConfig preserves link token', cfg.hiveToken === HOST_TOK, `got="${cfg.hiveToken}"`)

    const mTemp = path.join(tmp, 'mh-temp')
    fs.mkdirSync(mTemp, { recursive: true })
    const mhLogs = []
    const mhPort = await freePort()
    const mP = mcpHttpMain([`${RELAY}|${HS_ROOM}|${HOST_TOK}`, '--auth', 'none', '--port', String(mhPort)], {
      env: { ...process.env, TEMP: mTemp },
      log: (s) => mhLogs.push(s),
      logErr: (s) => mhLogs.push(s),
    })
    await until(() => mhLogs.some((l) => /\[hive-mcp-http\]/.test(l)), 5000, 50)
    process.emit('SIGINT')
    await Promise.race([mP, sleep(1000)])
    const mhDirNames = fs.readdirSync(mTemp)
    T('MH3 hive-mcp-http main masks bare hs_ room ID in startup log and temp dir',
      mhLogs.some((l) => /\[hive-mcp-http\]/.test(l))
      && !mhLogs.some((l) => l.includes(HS_ROOM))
      && !mhDirNames.some((d) => d.includes(HS_ROOM)),
      `logs=${mhLogs.join(' | ')} dirs=${mhDirNames.join(',')}`)
  }

  // ── 7. #7 + #6: hive-mcp.js:1185 & hive-instructions.js:117 ────────────────────────────────
  console.log('\n# 7. #7 hive-mcp.js:1185 & #6 hive-instructions.js:117')
  {
    const mcpCwd = path.join(tmp, 'mcp-cwd')
    fs.mkdirSync(mcpCwd, { recursive: true })
    const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], {
      cwd: mcpCwd,
      env: { ...process.env, HIVE_HOME: path.join(tmp, 'mcp-home') },
    })
    kids.push(p)
    let buf = '', nid = 1
    const pend = new Map()
    p.stdout.on('data', (d) => {
      buf += d.toString()
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1)
        let msg; try { msg = JSON.parse(line) } catch { continue }
        if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id) }
      }
    })
    const rpc = (method, params) => new Promise((r) => { const i = nid++; pend.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n') })
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    await rpc('tools/call', { name: 'hive_join', arguments: { link: `${RELAY}|${HS_ROOM}`, token: HOST_TOK, dir: path.join(tmp, 'mcp-room'), name: 'SayTester' } })
    const sayBlock = await rpc('tools/call', { name: 'hive_say', arguments: { text: `token is ${HOST_TOK}` } })
    const sayText = (sayBlock && sayBlock.result && sayBlock.result.content && sayBlock.result.content[0] && sayBlock.result.content[0].text) || JSON.stringify(sayBlock)
    try { p.kill() } catch {}
    T('MC1 hive_say token refusal names the `invite <name>` command',
      /NOT SENT/.test(sayText) && /hivecode-mcp[^\n]*invite/i.test(sayText),
      sayText.slice(0, 400))

    T('IN1 AGENT_MANUAL reflects that .hive.json does not carry private invite tokens',
      !/The room's link is already in \.hive\.json in this folder\./.test(AGENT_MANUAL),
      AGENT_MANUAL.split('\n').filter((l) => /\.hive\.json|token/i.test(l)).join(' | '))

    // ── 8. A5 store integration (bare <relay>|<hs_room> via resolveRoomToken / ~/.hivecode/tokens) ──
    console.log('\n# 8. resolveRoomToken store lookup with bare <relay>|<hs_room>')
    const prevKeysDir = process.env.HIVE_KEYS_DIR
    process.env.HIVE_KEYS_DIR = path.join(tmp, 'hive-keys')
    try {
      saveRoomToken({ room: HS_ROOM, name: 'Host', token: HOST_TOK })

      const storeListOut = []
      let seenTok = ''
      const storeFetch = async (url, init = {}) => {
        const b = init.body ? JSON.parse(init.body) : {}
        seenTok = b.token || ''
        return { status: 200, ok: true, json: async () => ({ ok: true, connections: [{ id: 'c-store', channel: 'ops', team: 'Acme', by: 'Host', shared: true }] }) }
      }
      const cStore = await SC.runSlackList({ link: `wss://relay.example|${HS_ROOM}`, fetchImpl: storeFetch, log: (s) => storeListOut.push(s), logErr: (s) => storeListOut.push(s) })
      T('A1.5 runSlackList resolves saved token from ~/.hivecode/tokens for bare <relay>|<hs_room>',
        cStore === 0 && seenTok === HOST_TOK && /ops/.test(storeListOut.join('\n')),
        `code=${cStore} out=${storeListOut.join(' | ')}`)

      const docStore = spawnSync(process.execPath, [path.join(ROOT, 'hive-doctor.js'), `${RELAY}|${HS_ROOM}`, '--json'], {
        cwd: ROOT,
        env: { ...process.env, HIVE_KEYS_DIR: process.env.HIVE_KEYS_DIR },
        encoding: 'utf8',
        timeout: 22000,
      })
      let jStore = null
      try { const i = docStore.stdout.indexOf('{'); if (i >= 0) jStore = JSON.parse(docStore.stdout.slice(i)) } catch {}
      T('D2 hive-doctor resolves saved token for bare <relay>|<hs_room> (never needs inline token)',
        docStore.status === 0 && jStore && jStore.verdict === 'OK' && jStore.contentBytes === 5 && !docStore.stdout.includes(HOST_TOK),
        `code=${docStore.status} err=${String(docStore.stderr || '').slice(0, 180)}`)

      const storeCfg = resolveMcpHttpConfig([`${RELAY}|${HS_ROOM}`], {})
      T('MH4 hive-mcp-http resolveConfig resolves saved token for bare <relay>|<hs_room>',
        storeCfg.hiveToken === HOST_TOK,
        `got="${storeCfg.hiveToken ? 'non-empty-mismatch' : ''}"`)

      const sayStoreRes = await roomSay({ link: `${RELAY}|${HS_ROOM}`, text: 'stored token say', timeoutMs: 4000 })
      T('W3 roomSay resolves saved token for bare <relay>|<hs_room>',
        Boolean(sayStoreRes && sayStoreRes.ok),
        sayStoreRes ? `${sayStoreRes.code} ${sayStoreRes.why}` : 'null')
    } finally {
      if (prevKeysDir === undefined) delete process.env.HIVE_KEYS_DIR
      else process.env.HIVE_KEYS_DIR = prevKeysDir
    }
  }
} finally {
  for (const h of handles) { try { h.stop ? h.stop() : h.close && h.close() } catch {} }
  for (const k of kids) { try { k.kill() } catch {} }
  try { relayProc && relayProc.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
