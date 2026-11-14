// PRIVATE ROOMS — CLIENT HARDENING, CLI TOOLS & REVOCATION CACHE:
//
//   node tests/private-room-client-test.mjs
//
// Covers the client side of making private rooms ("hs_<fp>_<rand>") trustworthy:
//   A3.1  sync.js & hive-mux.js stop reconnecting when refused (401/403) or closed (4401/4403)
//   A3.2  sync.js refreshes a host's own token from the room key instead of giving up at exp
//   A3.3  public/control.html distinguishes private-room refusal from room-full and stops retrying
//   A3.4  extension/extension.js renews ownerToken when session.keys exist and stops retrying on 4401 without keys
//   A4.1  hive-mcp.js enables listener status/commands in private rooms without putting tokens in argv
//   A4.2  hive-stop-hook.js blocks with hive-await when a private-room token is resolvable, skips when none (H8)
//   A4.3  hive-await.js connects to private rooms and never writes tokens into ARMED or AGAIN
//   A4.4  hive-agent.js / hive-say.js / hive-readchat.js / hive-stay.js / hive-claim.js work without storing tokens in .hive.json
//   A2.1  sync.js POSTs cached revocation lists to /__hive/revocations BEFORE opening WS upgrade
//   A2.2  sync.js observes Y.Doc hive_revocations, verifies signed lists, caches valid ones, ignores forged ones
import fs from 'fs'
import os from 'os'
import vm from 'vm'
import http from 'http'
import path from 'path'
import crypto from 'crypto'
import { createRequire } from 'module'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { WebSocketServer } from 'ws'
import { makeSecuredRoomId, verify, keyFingerprint, roomFingerprint } from '../token.js'
import { signList, mergeLists, isRevoked } from '../hive-revocations.js'
import { loadLists, saveLists } from '../hive-revocations-cache.js'
import { saveRoomKey, mintRoomToken } from '../hive-room-key.js'
import { createFileTransport } from '../hive-mux.js'
import { F, encodeFrame, decodeFrame, muxPath } from '../hive-mux-proto.js'
import { HiveSocket } from '../hive-transport.js'
import { armedFile } from '../hive-listen.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-priv-client-'))
const KEYS_DIR = path.join(TMP, 'keys')
process.env.HIVE_KEYS_DIR = KEYS_DIR
process.env.TEMP = TMP
process.env.TMPDIR = TMP
const { startSync } = await import('../sync.js')

let pass = 0, fail = 0
const failingLines = []
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else {
    fail++
    const line = `  FAIL ${name}${detail ? `  -- ${detail}` : ''}`
    failingLines.push(line)
    console.log(line)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms, step = 100) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await pred()) return true
    await sleep(step)
  }
  return !!(await pred())
}

// Create a mock relay that enforces tokens + revocation lists on HTTP /__hive/revocations,
// standard WS rooms, and mux WS rooms, while recording request timeline for A2/A3 assertions.
function createMockRelay() {
  const docs = new Map() // roomName -> { doc, awareness, conns: Map<ws, { jti, sub, name }> }
  const revokedByRoom = new Map() // roomName -> { lists: [jws], revoked: Map, seq }
  const rejectedJtis = new Set()
  const socketsByJti = new Map() // jti -> Set<ws>
  const stats = { wsUpgrades: [], muxUpgrades: [], timeline: [], revokePosts: [] }
  const getDoc = (name) => {
    if (!docs.has(name)) {
      const doc = new Y.Doc()
      const awareness = new awarenessProtocol.Awareness(doc)
      const conns = new Map()
      doc.on('update', (upd, origin) => {
        const e = encoding.createEncoder()
        encoding.writeVarUint(e, 0)
        syncProtocol.writeUpdate(e, upd)
        const buf = encoding.toUint8Array(e)
        for (const ws of conns.keys()) if (ws !== origin && ws.readyState === 1) ws.send(buf)
      })
      awareness.on('update', ({ added, updated, removed }, origin) => {
        const changed = added.concat(updated, removed)
        const e = encoding.createEncoder()
        encoding.writeVarUint(e, 1)
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
        const buf = encoding.toUint8Array(e)
        for (const ws of conns.keys()) if (ws !== origin && ws.readyState === 1) ws.send(buf)
      })
      docs.set(name, { doc, awareness, conns })
    }
    return docs.get(name)
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && u.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, mux: 1 }))
      return
    }
    if (req.method === 'POST' && u.pathname === '/__hive/revocations') {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        let parsed = {}
        try { parsed = JSON.parse(body || '{}') } catch {}
        const room = parsed.room || ''
        stats.timeline.push(`POST /__hive/revocations ${room}`)
        stats.revokePosts.push(parsed)
        const cur = revokedByRoom.get(room) || { lists: [], revoked: new Map(), seq: -1 }
        const merged = mergeLists(room, cur.lists, Array.isArray(parsed.lists) ? parsed.lists : [])
        revokedByRoom.set(room, merged)
        let dropped = 0
        for (const [jti] of merged.revoked) {
          const set = socketsByJti.get(jti)
          if (set) for (const ws of [...set]) { try { ws.close(4401, 'token revoked'); dropped++ } catch {} }
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, lists: merged.lists, dropped }))
      })
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    const rawPath = decodeURIComponent(u.pathname.slice(1))
    const isMux = rawPath.startsWith('_hive_mux/')
    const roomId = isMux ? decodeURIComponent(rawPath.slice('_hive_mux/'.length)) : rawPath.split('\u0001')[0]
    const tok = u.searchParams.get('token') || ''
    if (isMux) stats.muxUpgrades.push({ roomId, tok })
    else stats.wsUpgrades.push({ path: rawPath, roomId, tok })
    stats.timeline.push(`${isMux ? 'MUX' : 'WS'} ${rawPath}`)

    if (/^hs_/.test(roomId)) {
      let ok = false, payload = null
      if (tok) {
        try {
          const parts = tok.split('.')
          const p0 = parts[1] ? JSON.parse(Buffer.from(parts[1], 'base64url').toString()) : null
          if (p0 && p0.pk && keyFingerprint(p0.pk) === roomFingerprint(roomId)) {
            const v = verify(tok, { publicKey: p0.pk, alg: 'RS256' })
            if (v.ok && v.payload.scopes && v.payload.scopes[0] && v.payload.scopes[0].room === roomId) {
              payload = v.payload
              const rev = revokedByRoom.get(roomId)
              if (!rejectedJtis.has(payload.jti) && !(rev && isRevoked(rev, payload.jti))) ok = true
            }
          }
        } catch {}
      }
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nX-Hive-Relay: 1\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      req._hiveAuth = payload
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const auth = req._hiveAuth || {}
      if (auth.jti) {
        if (!socketsByJti.has(auth.jti)) socketsByJti.set(auth.jti, new Set())
        socketsByJti.get(auth.jti).add(ws)
      }
      if (isMux) {
        const muxChans = new Map()
        ws.on('message', (data) => {
          const f = decodeFrame(new Uint8Array(data))
          if (f.kind === F.OPEN) {
            const name = f.docName
            muxChans.set(f.id, name)
            const entry = getDoc(name)
            ws.send(encodeFrame(F.OPENED, f.id))
            const e = encoding.createEncoder()
            encoding.writeVarUint(e, 0)
            syncProtocol.writeSyncStep1(e, entry.doc)
            ws.send(encodeFrame(F.MSG, f.id, encoding.toUint8Array(e)))
          } else if (f.kind === F.MSG) {
            const name = muxChans.get(f.id)
            if (!name) return
            const entry = getDoc(name)
            const d = decoding.createDecoder(f.payload)
            const t = decoding.readVarUint(d)
            if (t === 0) {
              const e = encoding.createEncoder()
              encoding.writeVarUint(e, 0)
              syncProtocol.readSyncMessage(d, e, entry.doc, ws)
              if (encoding.length(e) > 1) ws.send(encodeFrame(F.MSG, f.id, encoding.toUint8Array(e)))
            }
          }
        })
        ws.on('close', () => { if (auth.jti && socketsByJti.has(auth.jti)) socketsByJti.get(auth.jti).delete(ws) })
        return
      }
      const entry = getDoc(rawPath)
      entry.conns.set(ws, auth)
      const step1 = encoding.createEncoder()
      encoding.writeVarUint(step1, 0)
      syncProtocol.writeSyncStep1(step1, entry.doc)
      ws.send(encoding.toUint8Array(step1))
      ws.on('message', (data) => {
        const u8 = new Uint8Array(data)
        const d = decoding.createDecoder(u8)
        const mtype = decoding.readVarUint(d)
        if (mtype === 0) {
          const e = encoding.createEncoder()
          encoding.writeVarUint(e, 0)
          syncProtocol.readSyncMessage(d, e, entry.doc, ws)
          if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e))
        } else if (mtype === 1) {
          awarenessProtocol.applyAwarenessUpdate(entry.awareness, decoding.readVarUint8Array(d), ws)
        }
      })
      ws.on('close', () => {
        entry.conns.delete(ws)
        if (auth.jti && socketsByJti.has(auth.jti)) socketsByJti.get(auth.jti).delete(ws)
      })
    })
  })

  return {
    server,
    docs,
    stats,
    revokedByRoom,
    rejectedJtis,
    socketsByJti,
    getDoc,
    resetRevocations() { revokedByRoom.clear() },
    closeByJti(jti, code = 4401, reason = 'token revoked') {
      const set = socketsByJti.get(jti)
      if (!set) return 0
      let n = 0
      for (const ws of [...set]) { try { ws.close(code, reason); n++ } catch {} }
      return n
    },
    listen: () => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port))),
    close: () => new Promise((res) => { wss.close(); server.close(res) }),
  }
}

const makeKeys = () => {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKey = kp.publicKey.export({ type: 'spki', format: 'pem' })
  const privateKey = kp.privateKey.export({ type: 'pkcs8', format: 'pem' })
  return { publicKey, privateKey, room: makeSecuredRoomId(publicKey, crypto.randomBytes(6).toString('hex')) }
}

const relay = createMockRelay()
const PORT = await relay.listen()
const RELAY = `ws://127.0.0.1:${PORT}`
process.env.HIVE_RELAY = RELAY
const cleanupSyncs = []
const cleanupKids = []
process.on('exit', () => {
  for (const s of cleanupSyncs) try { s.stop() } catch {}
  for (const k of cleanupKids) try { k.kill() } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
})

// =====================================================================
console.log('# A3-client  stop retrying on 401/4401; host auto-refreshes')
// =====================================================================
{
  const k = makeKeys()
  saveRoomKey(k, { relay: RELAY, host: 'HostUser' })

  // A3.1a: HTTP 401 upgrade refusal stops sync.js retries
  const beforeUp = relay.stats.wsUpgrades.length
  const badDir = path.join(TMP, 'a3-bad')
  const logs = []
  const badSync = startSync({
    relay: RELAY, room: k.room, dir: badDir, name: 'Stranger', kind: 'ai',
    token: 'bogus.jwt.token', syncFiles: false, log: (m) => logs.push(m),
  })
  cleanupSyncs.push(badSync)
  await until(() => !!badSync.status().authStopped, 4000)
  const dialsAtStop = relay.stats.wsUpgrades.length - beforeUp
  await sleep(1200)
  const dialsAfterWait = relay.stats.wsUpgrades.length - beforeUp
  T('A3.1a non-host 401 stops sync.js retrying',
    Boolean(badSync.status().authStopped) && dialsAfterWait <= dialsAtStop && dialsAfterWait <= 2,
    `authStopped=${JSON.stringify(badSync.status().authStopped)}, dialsAtStop=${dialsAtStop}, dialsAfter=${dialsAfterWait}`)
  badSync.stop()

  // A3.1b: Live socket closed with 4401 (revoked mid-session) stops retrying
  const guestInv = mintRoomToken(k, { name: 'Guest1', kind: 'ai', role: 'writer' })
  const guestDir = path.join(TMP, 'a3-guest')
  const guest = startSync({
    relay: RELAY, room: k.room, dir: guestDir, name: 'Guest1', kind: 'ai',
    token: guestInv.token, syncFiles: false, log: () => {},
  })
  cleanupSyncs.push(guest)
  const synced1 = await until(() => guest.connection().connected, 6000)
  relay.rejectedJtis.add(guestInv.jti)
  const countBeforeClose = relay.stats.wsUpgrades.length
  relay.closeByJti(guestInv.jti, 4401, 'token revoked')
  const stopped4401 = await until(() => !guest.connection().connected && !!guest.status().authStopped, 4000)
  await sleep(1200)
  const dialsAfter4401 = relay.stats.wsUpgrades.length - countBeforeClose
  T('A3.1b live 4401 close stops sync.js retrying for non-host',
    synced1 && stopped4401 && dialsAfter4401 <= 1,
    `synced1=${synced1}, authStopped=${JSON.stringify(guest.status().authStopped)}, extraDials=${dialsAfter4401}`)
  guest.stop()

  // A3.1c: hive-mux.js MuxConnection stops reconnecting on 4401 / 401
  const muxInv = mintRoomToken(k, { name: 'MuxUser', kind: 'ai', role: 'writer' })
  const muxLogs = []
  let authFailed = false
  const ft = createFileTransport({
    relay: RELAY, room: k.room, env: { ...process.env, HIVE_MUX: '1' },
    wsOpts: { WebSocketPolyfill: HiveSocket, params: { token: muxInv.token, name: 'MuxUser', kind: 'ai' } },
    log: (m) => muxLogs.push(m),
    onAuthFailure: () => { authFailed = true; return false },
  })
  const fdoc = new Y.Doc()
  const fp = ft.provide(`${k.room}\u0001a.js`, fdoc)
  const muxUp = await until(() => fp.synced, 6000)
  const muxBefore = relay.stats.muxUpgrades.length
  relay.rejectedJtis.add(muxInv.jti)
  relay.closeByJti(muxInv.jti, 4401, 'token revoked')
  await sleep(1200)
  const muxAfter = relay.stats.muxUpgrades.length - muxBefore
  T('A3.1c hive-mux stops reconnecting on 4401 close',
    muxUp && authFailed && muxAfter === 0 && !ft.stats().muxConnected,
    `muxUp=${muxUp}, authFailed=${authFailed}, extraMuxDials=${muxAfter}, stats=${JSON.stringify(ft.stats())}`)
  ft.stop()

  // A3.2: Host's short token closed with 4401 at expiry auto-refreshes via hostToken and stays live
  const shortHost = mintRoomToken(k, { name: 'HostUser', kind: 'ai', role: 'maintainer', ttlSec: 5 })
  const hostDir = path.join(TMP, 'a3-host')
  const hostSync = startSync({
    relay: RELAY, room: k.room, dir: hostDir, name: 'HostUser', kind: 'ai',
    token: shortHost.token, syncFiles: false, log: () => {},
  })
  cleanupSyncs.push(hostSync)
  const hostConn1 = await until(() => hostSync.connection().connected, 6000)
  relay.rejectedJtis.add(shortHost.jti)
  relay.closeByJti(shortHost.jti, 4401, 'token expired')
  const hostReconn = await until(() => {
    const ups = relay.stats.wsUpgrades.filter((u) => u.roomId === k.room)
    const last = ups[ups.length - 1]
    return last && last.tok !== shortHost.token && hostSync.connection().connected
  }, 7000)
  T('A3.2 host auto-refreshes token on 4401 expiry and reconnects',
    hostConn1 && hostReconn && !hostSync.status().authStopped,
    `hostConn1=${hostConn1}, hostReconn=${hostReconn}, authStopped=${JSON.stringify(hostSync.status().authStopped)}`)
  hostSync.stop()
}

// A3.3: public/control.html handles 4401 / expired private room
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'control.html'), 'utf8')
  const m = /<script type="module">([\s\S]*)<\/script>/.exec(html)
  const scriptSrc = (m ? m[1] : '')
    .replace(/import\s+\{[^}]+\}\s+from\s+['"]\.\/hive-time\.js['"];?/, 'const ago = () => "now";')
    .replace(/await\s+import\(['"]\.\/hive-crdt\.js['"]\)/, '({ Y: __Y, WebsocketProvider: __WS })')
  const elems = new Map()
  const el = (id) => {
    if (!elems.has(id)) {
      const classes = new Set()
      elems.set(id, {
        id, textContent: '', title: '', innerHTML: '', value: '', hidden: false,
        style: {}, dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 100,
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          contains: (c) => classes.has(c),
          toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
        },
        addEventListener: () => {}, focus: () => {},
      })
    }
    return elems.get(id)
  }
  const store = new Map()
  let lastProvider = null
  class FakeWS {
    constructor(relayUrl, roomName, doc, opts) {
      this.serverUrl = relayUrl
      this.roomname = roomName
      this.doc = doc
      this.params = (opts && opts.params) || {}
      this.shouldConnect = opts ? opts.connect !== false : true
      this.wsconnected = false
      this.synced = false
      this.wsUnsuccessfulReconnects = 0
      this.ws = null
      this._h = new Map()
      this.awareness = {
        setLocalStateField: () => {},
        on: () => {},
        getStates: () => new Map(),
      }
      lastProvider = this
    }
    on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, []); this._h.get(ev).push(fn) }
    emit(ev, a) { for (const fn of (this._h.get(ev) || [])) fn(a) }
    disconnect() { this.shouldConnect = false; this.wsconnected = false; this.synced = false }
    connect() { this.shouldConnect = true }
    destroy() { this.disconnect() }
  }
  const timers = []
  const win = { _prov: null, _h: null, _conn: null, _dead: 0, _tick: null }
  const ctx = {
    window: win,
    location: { hash: '', origin: 'http://127.0.0.1', pathname: '/control.html', search: '', reload: () => {} },
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, String(v)) },
    document: {
      getElementById: el,
      body: { classList: { toggle: () => {} } },
      addEventListener: () => {},
    },
    URLSearchParams,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    TextEncoder,
    crypto: crypto.webcrypto,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t },
    clearInterval,
    alert: () => {},
    confirm: () => false,
    prompt: () => '',
    escape: globalThis.escape || ((s) => s),
    __Y: Y,
    __WS: FakeWS,
  }
  ctx.globalThis = ctx
  vm.createContext(ctx)
  vm.runInContext(scriptSrc, ctx)
  const k = makeKeys()
  const inv = mintRoomToken(k, { name: 'BrowserUser', kind: 'human', role: 'writer' })
  el('uname').value = 'BrowserUser'
  await vm.runInContext(`connect(${JSON.stringify(`${RELAY}|${k.room}|${inv.token}`)})`, ctx)
  await sleep(30)
  for (const t of timers) { clearTimeout(t); clearInterval(t) }
  if (lastProvider) {
    lastProvider.emit('connection-close', { code: 4401, reason: 'token revoked' })
    lastProvider.wsUnsuccessfulReconnects = 4
    lastProvider.emit('status', { status: 'disconnected' })
    ctx.window._dead = 10
    await vm.runInContext('reviveIfDead()', ctx)
  }
  const stateTxt = el('connState').textContent
  T('A3.3 control.html shows revoked/expired refusal and stops reconnecting on 4401',
    !!lastProvider && /revoked|expired/i.test(stateTxt) && !/room may be full/i.test(stateTxt) && lastProvider.shouldConnect === false,
    `connState=${JSON.stringify(stateTxt)}, shouldConnect=${lastProvider && lastProvider.shouldConnect}`)
}

// A3.4: extension/extension.js refreshes ownerToken when session.keys exist; disconnects on 4401 without keys
{
  const req = createRequire(import.meta.url)
  const Module = req('module')
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keys = { publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
  const secRoom = makeSecuredRoomId(keys.publicKey, 'aabbccddeeff')
  const extDir = path.join(TMP, 'ext-proj')
  fs.mkdirSync(extDir, { recursive: true })
  const cfgMap = new Map([['displayName', 'OwnerExt'], ['relayUrl', RELAY]])
  const providers = []
  class ExtFakeWS {
    constructor(relayUrl, roomName, doc, opts) {
      this.serverUrl = relayUrl
      this.roomname = roomName
      this.doc = doc
      this.params = (opts && opts.params) || {}
      this.shouldReconnect = (opts && opts.shouldReconnect) || ((ev) => !(ev && ev.code >= 4400 && ev.code < 4500))
      this.shouldConnect = true
      this._h = new Map()
      this.awareness = { setLocalStateField: () => {}, setLocalState: () => {}, on: () => {}, getStates: () => new Map() }
      providers.push(this)
    }
    on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, []); this._h.get(ev).push(fn) }
    emit(ev, a) {
      for (const fn of (this._h.get(ev) || [])) fn(a)
      if (ev === 'connection-close' && !this.shouldReconnect(a, this)) {
        this.shouldConnect = false
        for (const fn of (this._h.get('closed') || [])) fn(a)
      }
    }
    connect() { this.shouldConnect = true }
    disconnect() { this.shouldConnect = false }
    destroy() { this.disconnect() }
  }
  const cmds = new Map()
  const secStore = new Map([[`hive.key.${secRoom}`, JSON.stringify(keys)]])
  const wsState = new Map()
  const fakeVscode = {
    commands: { registerCommand: (k, fn) => cmds.set(k, fn), executeCommand: () => {} },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    env: { clipboard: { writeText: async () => {} }, openExternal: () => {} },
    StatusBarAlignment: { Left: 1 },
    Uri: { parse: (s) => s },
    window: {
      createStatusBarItem: () => ({ show: () => {}, text: '', tooltip: '' }),
      registerWebviewViewProvider: () => ({ dispose: () => {} }),
      showInformationMessage: async () => {},
      showWarningMessage: async () => {},
      showErrorMessage: async () => {},
      showInputBox: async () => '',
      showQuickPick: async () => null,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: extDir } }],
      getConfiguration: () => ({
        get: (k) => cfgMap.get(k),
        update: async (k, v) => { cfgMap.set(k, v) },
      }),
    },
  }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return fakeVscode
    if (request === 'y-websocket') return { WebsocketProvider: ExtFakeWS }
    return origLoad.call(this, request, parent, isMain)
  }
  let extMod
  try {
    delete req.cache[req.resolve('../extension/extension.js')]
    extMod = req('../extension/extension.js')
    extMod.activate({
      subscriptions: [],
      secrets: { get: async (k) => secStore.get(k) || null, store: async (k, v) => secStore.set(k, v), delete: async (k) => secStore.delete(k) },
      workspaceState: { get: (k, d) => (wsState.has(k) ? wsState.get(k) : d), update: async (k, v) => wsState.set(k, v) },
    })
    // Host secured session
    await cmds.get('hivecode.hostSecured')()
    const hostProv = providers[providers.length - 1]
    const firstTok = hostProv && hostProv.params && hostProv.params.token
    await sleep(1100) // iat moves by 1s so minted JWT differs
    if (hostProv) hostProv.emit('connection-close', { code: 4401, reason: 'token expired' })
    await sleep(20)
    const refreshedTok = hostProv && hostProv.params && hostProv.params.token
    const hostShouldConnect = hostProv && hostProv.shouldConnect
    // Guest join (no keys)
    await cmds.get('hivecode.leave')()
    const gInv = mintRoomToken({ ...keys, room: secRoom }, { name: 'GuestExt', kind: 'human', role: 'writer' })
    wsState.set('hive.lastSession', null)
    fakeVscode.window.showInputBox = async () => `${RELAY}|${secRoom}|${gInv.token}`
    await cmds.get('hivecode.join')()
    const guestProv = providers[providers.length - 1]
    if (guestProv) guestProv.emit('connection-close', { code: 4401, reason: 'token revoked' })
    T('A3.4 extension refreshes host token on 4401 with keys, disconnects without keys',
      Boolean(firstTok) && Boolean(refreshedTok) && refreshedTok !== firstTok && hostShouldConnect === true &&
      Boolean(guestProv) && guestProv.shouldConnect === false,
      `hostSame=${firstTok === refreshedTok}, hostShouldConnect=${hostShouldConnect}, guestShouldConnect=${guestProv && guestProv.shouldConnect}`)
    extMod.deactivate()
  } finally {
    Module._load = origLoad
  }
}

// =====================================================================
console.log('\n# A4  CLI & listener tools work in private rooms without leaking tokens')
// =====================================================================
{
  const k = makeKeys()
  const hostRec = saveRoomKey(k, { relay: RELAY, host: 'HostA4' })
  const room = k.room
  const tokDir = path.join(path.dirname(KEYS_DIR), 'tokens', room)
  fs.mkdirSync(tokDir, { recursive: true })
  const botInv = mintRoomToken(k, { name: 'BotA4', kind: 'ai', role: 'writer' })
  const hashName = crypto.createHash('sha256').update('BotA4').digest('hex').slice(0, 16)
  fs.writeFileSync(path.join(tokDir, `${hashName}.json`), JSON.stringify({ room, name: 'BotA4', token: botInv.token }))

  // A4.1: hive-mcp listener status & commands in private room
  const { _test } = await import('../hive-mcp.js')
  await _test.initialize({ protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '2.1.0' } })
  const mcpDir = path.join(TMP, 'a4-mcp')
  fs.mkdirSync(mcpDir, { recursive: true })
  fs.writeFileSync(path.join(mcpDir, '.hive.json'), JSON.stringify({ relay: RELAY, room }))
  _test.setSession({
    room, relay: RELAY, dir: mcpDir, name: 'BotA4', owner: 'G', authed: true, passive: false,
    hive: {
      doc: new Y.Doc(), getState: () => ({}), say: () => {}, members: () => [],
      status: () => ({ connected: true, files: 0, filesSynced: 0 }), stop: () => {},
    },
  })
  const lsPriv = _test.listenerStatusFor({ name: 'BotA4', room, useToken: botInv.token, passive: false })
  const waitRes = await _test.callTool('hive_wait', { timeoutSeconds: 1 })
  const waitTxt = (waitRes && waitRes.content || []).map((c) => c.text).join('\n')
  T('A4.1 hive-mcp enables listener in private room and never puts token in argv',
    lsPriv.enabled === true && /hive-await\.js/.test(waitTxt) && !waitTxt.includes(botInv.token),
    `enabled=${lsPriv.enabled}, status=${lsPriv.status}, hasAwait=${/hive-await\.js/.test(waitTxt)}, leaksToken=${waitTxt.includes(botInv.token)}`)

  // A4.2: hive-stop-hook.js orders listener when token is resolvable (even if authed:true), skips when absent
  const hookProj = path.join(TMP, 'a4-hook-proj')
  const hookRoomDir = path.join(hookProj, 'room')
  fs.mkdirSync(hookRoomDir, { recursive: true })
  fs.writeFileSync(path.join(hookRoomDir, '.hive.json'), JSON.stringify({ relay: RELAY, room }))
  fs.writeFileSync(path.join(hookRoomDir, 'HIVE_CHAT.md'), '# Hive Chat\n')
  fs.writeFileSync(path.join(hookProj, '.hive-mcp-session.json'), JSON.stringify({ dir: hookRoomDir, name: 'BotA4', owner: 'G', room, authed: true }))
  const hookRes = spawnSync(process.execPath, [path.join(ROOT, 'hive-stop-hook.js')], {
    cwd: TMP,
    input: JSON.stringify({ cwd: hookProj, session_id: 'S-priv' }),
    env: { ...process.env, HIVE_KEYS_DIR: KEYS_DIR, TEMP: TMP, TMPDIR: TMP },
    encoding: 'utf8', timeout: 15000,
  })
  let hookJson = null
  try { hookJson = JSON.parse(hookRes.stdout) } catch {}
  T('A4.2 hive-stop-hook blocks with hive-await in private room when token resolves, without token in reason',
    hookRes.status === 0 && hookJson && hookJson.decision === 'block' && /hive-await\.js/.test(hookJson.reason) && !hookJson.reason.includes(botInv.token),
    `out=${hookRes.stdout.slice(0, 200)}`)

  // A4.3: hive-await.js connects to private room, scrubs token from ARMED & AGAIN, wakes on @mention
  const awaitEnv = { ...process.env, HIVE_KEYS_DIR: KEYS_DIR, HIVE_TOKEN: botInv.token, TEMP: TMP, TMPDIR: TMP, HIVE_AWAIT_KEEP_ALIVE: '1' }
  const af = armedFile('AwaitBot', room, awaitEnv)
  const bot2 = mintRoomToken(k, { name: 'AwaitBot', kind: 'ai', role: 'writer' })
  awaitEnv.HIVE_TOKEN = ''
  const awaitProc = spawn(process.execPath, [path.join(ROOT, 'hive-await.js'), `${RELAY}|${room}|${bot2.token}`, 'AwaitBot', '1', 'claude-code'], {
    cwd: TMP, env: awaitEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanupKids.push(awaitProc)
  let awaitOut = ''
  awaitProc.stdout.on('data', (d) => { awaitOut += d })
  const armedReady = await until(() => {
    try { const j = JSON.parse(fs.readFileSync(af, 'utf8')); return j.synced === true } catch { return false }
  }, 8000)
  const armedRaw = fs.existsSync(af) ? fs.readFileSync(af, 'utf8') : ''
  const rDoc = relay.getDoc(room).doc
  if (armedReady) rDoc.getArray('chat').push([{ by: 'HostA4', kind: 'human', at: '12:00:00', text: '@AwaitBot wake up private' }])
  const exited = await until(() => awaitProc.exitCode !== null, 6000)
  let awaitJson = null
  try { awaitJson = JSON.parse(awaitOut.trim()) } catch {}
  T('A4.3 hive-await works in private room and scrubs token from ARMED & AGAIN',
    armedReady && !armedRaw.includes(bot2.token) && exited && awaitJson && awaitJson.reason === 'mention' && !JSON.stringify(awaitJson).includes(bot2.token),
    `armedReady=${armedReady}, armedLeaks=${armedRaw.includes(bot2.token)}, exited=${exited}, out=${awaitOut.slice(0, 180)}`)
  try { awaitProc.kill() } catch {}

  // A4.4: hive-agent.js preserves pinnedRelay & never writes token to .hive.json; hive-say/readchat/claim/stay work
  const cliDir = path.join(TMP, 'a4-cli-dir')
  fs.mkdirSync(cliDir, { recursive: true })
  fs.writeFileSync(path.join(cliDir, '.hive.json'), JSON.stringify({ pinnedRelay: RELAY, relay: RELAY, room }))
  const agentInv = mintRoomToken(k, { name: 'AgentA4', kind: 'ai', role: 'writer' })
  const agentEnv = { ...process.env, HIVE_KEYS_DIR: KEYS_DIR, HIVE_TOKEN: agentInv.token, TEMP: TMP, TMPDIR: TMP }
  const agentProc = spawn(process.execPath, [path.join(ROOT, 'hive-agent.js'), '', cliDir, 'AgentA4'], {
    cwd: TMP, env: agentEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanupKids.push(agentProc)
  await until(() => relay.getDoc(room).doc.getArray('chat').toArray().some((m) => /AgentA4 joined/.test(m.text || '')), 8000)
  try { agentProc.kill() } catch {}
  const cfgAfterAgent = JSON.parse(fs.readFileSync(path.join(cliDir, '.hive.json'), 'utf8'))

  const runAsync = (args, env, timeoutMs = 10000) => new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: TMP, env, stdio: ['ignore', 'pipe', 'pipe'] })
    cleanupKids.push(p)
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { try { p.kill() } catch {}; resolve({ status: null, stdout, stderr }) }, timeoutMs)
    p.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
  const cliEnv = { ...process.env, HIVE_KEYS_DIR: KEYS_DIR, HIVE_TOKEN: '', TEMP: TMP, TMPDIR: TMP }
  const sayRes = await runAsync([path.join(ROOT, 'hive-say.js'), 'HostA4', 'hello-private-say', cliDir], cliEnv)
  const readRes = await runAsync([path.join(ROOT, 'hive-readchat.js'), `${RELAY}|${room}|${botInv.token}`, '10'], cliEnv)
  const claimRes = await runAsync([path.join(ROOT, 'hive-claim.js'), 'claim', 'app.js', 'HostA4', cliDir], cliEnv)
  const stayProc = spawn(process.execPath, [path.join(ROOT, 'hive-stay.js'), `${RELAY}|${room}|${botInv.token}`, 'KeeperA4'], {
    cwd: TMP, env: { ...process.env, HIVE_KEYS_DIR: KEYS_DIR, TEMP: TMP, TMPDIR: TMP }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanupKids.push(stayProc)
  let stayOut = ''
  stayProc.stdout.on('data', (d) => { stayOut += d })
  const stayOk = await until(() => /present in/.test(stayOut), 7000)
  try { stayProc.kill() } catch {}

  T('A4.4 hive-agent preserves pinnedRelay & never writes token; say/readchat/claim/stay work in private room',
    cfgAfterAgent.pinnedRelay === RELAY && !cfgAfterAgent.token &&
    sayRes.status === 0 && /hello-private-say/.test(readRes.stdout || '') &&
    claimRes.status === 0 && /CLAIMED app\.js/.test(claimRes.stdout || '') && stayOk,
    `cfg=${JSON.stringify(cfgAfterAgent)}, say=${sayRes.status}, read=${(readRes.stdout || '').trim().slice(0, 80)}, claim=${(claimRes.stdout || '').trim()}, stay=${stayOk}`)
}

// =====================================================================
console.log('\n# A2-client  sync.js pre-connect revocation POST + Y.Doc cache')
// =====================================================================
{
  const k = makeKeys()
  const hostRec = saveRoomKey(k, { relay: RELAY, host: 'HostRev' })
  const memberInv = mintRoomToken(k, { name: 'GoodMember', kind: 'ai', role: 'writer' })
  const badInv = mintRoomToken(k, { name: 'RevokedMember', kind: 'ai', role: 'writer' })
  const exp = Math.floor(Date.now() / 1000) + 3600
  const l1 = signList(hostRec, { seq: 1, revoked: [{ jti: badInv.jti, exp }] })

  // A2.1: Client has l1 in cache; relay has empty revocation state (simulating relay restart)
  saveLists(k.room, [l1])
  relay.resetRevocations()
  relay.stats.timeline.length = 0
  const goodSync = startSync({
    relay: RELAY, room: k.room, dir: path.join(TMP, 'a2-good'), name: 'GoodMember', kind: 'ai',
    token: memberInv.token, syncFiles: false, log: () => {},
  })
  cleanupSyncs.push(goodSync)
  const goodConnected = await until(() => goodSync.connection().connected, 6000)
  const postIdx = relay.stats.timeline.findIndex((s) => s === `POST /__hive/revocations ${k.room}`)
  const wsIdx = relay.stats.timeline.findIndex((s) => s === `WS ${k.room}`)
  const revState = relay.revokedByRoom.get(k.room)
  T('A2.1 sync.js POSTs cached revocations BEFORE opening WS upgrade, restoring relay state',
    goodConnected && postIdx >= 0 && wsIdx > postIdx && !!revState && isRevoked(revState, badInv.jti),
    `connected=${goodConnected}, postIdx=${postIdx}, wsIdx=${wsIdx}, timeline=${JSON.stringify(relay.stats.timeline.slice(0, 6))}`)

  // A2.2: While connected, Y.Doc hive_revocations receives valid signed l2 + forged list -> only valid cached
  const bad2 = mintRoomToken(k, { name: 'RevokedLater', kind: 'ai', role: 'writer' })
  const l2 = signList(hostRec, { seq: 2, revoked: [{ jti: badInv.jti, exp }, { jti: bad2.jti, exp }] })
  const otherKeys = makeKeys()
  const forged = signList(otherKeys, { seq: 99, revoked: [{ jti: 'evil-forged', exp }] })
  saveLists(k.room, []) // clear local cache to verify Y.Doc observer repopulates it
  relay.getDoc(k.room).doc.getMap('hive_revocations').set('lists', [l2, forged])
  const cachedFromDoc = await until(() => {
    const m = mergeLists(k.room, loadLists(k.room))
    return isRevoked(m, bad2.jti)
  }, 5000)
  const mergedAfterDoc = mergeLists(k.room, loadLists(k.room))
  T('A2.2 sync.js caches valid signed lists from doc hive_revocations and ignores forged lists',
    cachedFromDoc && isRevoked(mergedAfterDoc, bad2.jti) && !isRevoked(mergedAfterDoc, 'evil-forged'),
    `cached=${cachedFromDoc}, revokedKeys=${[...mergedAfterDoc.revoked.keys()].join(',')}`)
  goodSync.stop()
}

await relay.close()
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\nRED LINES:')
  for (const l of failingLines) console.log(l)
}
process.exit(fail ? 1 : 0)
