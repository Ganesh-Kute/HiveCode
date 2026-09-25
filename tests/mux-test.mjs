// ONE SOCKET PER PARTICIPANT (hive-mux.js / relay-mux.js).
//
// A participant used to hold one WebSocket for the room plus one PER FILE, so a relay's socket
// budget was spent on files, not people: 889 files against a 512 cap refused 38,011 connections
// in one evening and zeroed 186 files a folder. Now every file doc rides one physical socket as
// a CHANNEL, and each channel is admitted by the same gates a per-file socket passes.
//
// What "wrong but green" would look like, and so what is asserted here:
//   A. the socket count really is per participant, the files really arrive, edits flow both ways,
//      and a participant on the OLD transport converges with ones on the new -- in one room
//   B. no gate got lost in the move: a claim, a read-only role, a path-scoped token, another
//      room's file, another room's token -- each refused over a channel exactly as before; and
//      a malformed frame costs one socket, never the relay
//   C. the transport degrades instead of stranding anyone: a relay without mux gets sockets, a
//      relay that turns mux off MID-SESSION pushes live clients back to sockets, and a relay
//      restart resyncs what was written while it was down
//   D. the accounting closes every channel exactly once (a double close would under-count)
//
//   node tests/mux-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'; import net from 'net'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { sign, fileRoom } from '../token.js'
import { startSync } from '../sync.js'
import { createFileTransport } from '../hive-mux.js'
import { F, encodeFrame, decodeFrame, muxPath } from '../hive-mux-proto.js'

process.setMaxListeners(100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${!c && extra !== undefined ? '  :: ' + extra : ''}`); c ? pass++ : fail++ }
const waitFor = async (pred, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await pred()) return true } catch { } await sleep(150) } return false }

const PORT = Number(process.env.HIVE_TEST_PORT) || (21000 + (process.pid % 20000))
const RELAY = `ws://localhost:${PORT}`
const SECRET = 'mux-test-secret'
const BASE = 'muxroom'
const now = () => Math.floor(Date.now() / 1000)
let jti = 0
const mint = (name, over = {}, scope = {}) => sign({
  iss: 't', sub: name, name, kind: 'ai',
  scopes: [{ room: BASE, role: 'agent', paths: ['**'], ...scope }],
  iat: now(), exp: now() + 3600, jti: 'j' + (++jti), ...over,
}, { secret: SECRET })

const ENV = { HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'block', HIVE_PERSIST_DIR: 'off' }
let relay = null
function startRelay(extra = {}) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), ...ENV, ...extra } })
    let up = false
    p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
    // Drained for the relay's whole life: an unread stdout pipe fills and blocks the relay.
    p.stdout.on('data', (d) => { if (!up && /listening on/.test(d)) { up = true; res(p) } })
    p.on('exit', (code) => { if (!up) rej(new Error('relay exited ' + code)) })
  })
}
async function stopRelay() {
  if (!relay) return
  const p = relay; relay = null
  const gone = new Promise((r) => p.once('exit', r))
  p.kill(); await gone
}
const health = async () => (await fetch(`http://localhost:${PORT}/health`)).json()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mux-'))
const FILES = Array.from({ length: 12 }, (_, i) => `src/f${i}.js`)
function workdir(label, withFiles) {
  const d = path.join(tmp, label); fs.mkdirSync(path.join(d, 'src'), { recursive: true })
  if (withFiles) for (const f of FILES) fs.writeFileSync(path.join(d, f), `export const v = '${f}'\n`)
  return d
}
const read = (d, f) => { try { return fs.readFileSync(path.join(d, f), 'utf8') } catch { return null } }
const clients = []
function join(label, name, { withFiles = false, mux } = {}) {
  const dir = workdir(label, withFiles)
  const logs = []
  const had = process.env.HIVE_MUX
  if (mux === undefined) delete process.env.HIVE_MUX; else process.env.HIVE_MUX = mux
  // HIVE_MUX is read once, synchronously, inside startSync -- so it can be scoped to one client.
  const s = startSync({ relay: RELAY, room: BASE, dir, name, kind: 'ai', token: mint(name), log: (m) => logs.push(String(m)) })
  if (had === undefined) delete process.env.HIVE_MUX; else process.env.HIVE_MUX = had
  const c = { s, dir, logs, name }
  clients.push(c)
  return c
}
const allSynced = (c) => { const st = c.s.status(); return st.files > 0 && st.filesSynced === st.files }
const leave = (c) => { try { c.s.stop() } catch { } }

// A legacy per-file connection, for watching what the relay really holds.
function watch(room, token) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(RELAY, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token } })
  return { doc, provider, text: () => doc.getText('content').toString(), close: () => { try { provider.destroy() } catch { } } }
}
// The real client module, one channel.
function channel(docName, token) {
  const doc = new Y.Doc()
  const t = createFileTransport({ relay: RELAY, room: BASE, wsOpts: { WebSocketPolyfill: WebSocket, params: { token } }, env: { HIVE_MUX: '1' } })
  const fp = t.provide(docName, doc)
  const errs = []
  fp.on('connection-error', (ev) => errs.push(ev))
  return { doc, fp, t, errs, close: () => { try { fp.destroy() } catch { } try { t.stop() } catch { } } }
}
// A raw mux socket, to say things an honest client never would.
function raw(token, room = BASE) {
  const frames = []
  const ws = new WebSocket(`${RELAY}/${muxPath(room)}?token=${encodeURIComponent(token)}&mux=1`)
  ws.binaryType = 'arraybuffer'
  const out = { ws, frames, closed: null, refusedUpgrade: null }
  ws.on('message', (d) => { try { frames.push(decodeFrame(new Uint8Array(d))) } catch { } })
  ws.on('close', (code) => { out.closed = code })
  ws.on('unexpected-response', (_req, res) => { out.refusedUpgrade = res.statusCode; try { ws.terminate() } catch { } })
  ws.on('error', () => { })
  out.open = new Promise((r) => { ws.on('open', () => r(true)); ws.on('close', () => r(false)) })
  return out
}

try {
  // Started first: its pipes keep this process alive. Section F's retry timers are unref'd -- right
  // for a client, whose live socket keeps it running -- and with nothing else alive, Node would
  // exit mid-await (code 13) and report nothing at all.
  relay = await startRelay()

  // ── F. detection: only an answer decides ────────────────────────────────────────────
  // A free Render instance says nothing for 30-60s while it wakes. Reading that silence as "no
  // mux" pinned a whole session to a socket per file, so silence is asked again; any real answer
  // -- including an old relay's plain-text /health -- decides at once.
  console.log('\n# F  transport detection waits for an answer, and trusts only an answer')
  const fake = (script) => { let n = 0; const f = async () => { const s = script[Math.min(n++, script.length - 1)]; if (s === 'down') throw new Error('ECONNREFUSED'); return { ok: s.status < 400, status: s.status, text: async () => s.body } }; f.calls = () => n; return f }
  const detect = async (script, extra = {}) => { const f = fake(script); const t = createFileTransport({ relay: 'ws://sleeping.invalid', room: 'r', env: {}, fetchImpl: f, retryMs: 10, ...extra }); const mode = await t.ready; t.stop(); return { mode, calls: f.calls() } }
  let d = await detect(['down', 'down', { status: 200, body: '{"ok":true,"mux":1}' }])
  T('F1 a relay still waking (no answer, twice) is asked again, and then mux is used', d.mode === 'mux' && d.calls === 3, JSON.stringify(d))
  d = await detect([{ status: 503, body: 'booting' }, { status: 200, body: '{"mux":1}' }])
  T('F2 a proxy\'s 503 for a booting service is silence too, not an answer', d.mode === 'mux' && d.calls === 2, JSON.stringify(d))
  d = await detect([{ status: 200, body: 'ok' }, { status: 200, body: '{"mux":1}' }])
  T('F3 an old relay\'s plain-text /health decides at once: a socket per file', d.mode === 'socket' && d.calls === 1, JSON.stringify(d))
  d = await detect([{ status: 200, body: '{"ok":true}' }])
  T('F4 a JSON /health without mux decides at once: a socket per file', d.mode === 'socket' && d.calls === 1, JSON.stringify(d))
  d = await detect(['down'], { detectForMs: 150 })
  T('F5 a relay that never answers gets the transport every relay speaks, in bounded time', d.mode === 'socket' && d.calls >= 2, JSON.stringify(d))

  // ── A. the transport ────────────────────────────────────────────────────────────────
  console.log('\n# A  one socket per participant, files arrive, edits flow, old and new converge')
  const h0 = await health()
  T('A1 the relay advertises one-socket mode in /health', h0.mux === 1, JSON.stringify(h0.mux))

  const A = join('a', 'Alice', { withFiles: true })
  T('A2 a participant syncs its 12 files', await waitFor(() => allSynced(A) && A.s.status().files >= 12), JSON.stringify(A.s.status()))
  T('A3 ...over the shared socket (transport=mux)', A.s.status().transport === 'mux', A.s.status().transport)
  let h = await health()
  T('A4 it costs the relay 2 sockets (room + mux), not 1 + one per file', h.connections === 2, `connections=${h.connections}`)
  T('A5 every open file is a channel instead', h.channels === A.s.status().files, `channels=${h.channels} files=${A.s.status().files}`)

  const B = join('b', 'Bob')
  T('A6 a joiner with an empty folder receives every file', await waitFor(() => FILES.every((f) => read(B.dir, f) === read(A.dir, f))),
    FILES.filter((f) => read(B.dir, f) !== read(A.dir, f)).join(','))
  h = await health()
  T('A7 two participants, 4 sockets -- the file count does not enter into it', h.connections === 4, `connections=${h.connections}`)

  fs.writeFileSync(path.join(A.dir, 'src/f3.js'), "export const v = 'edited by Alice'\n")
  T('A8 an edit on one disk reaches the other', await waitFor(() => /edited by Alice/.test(read(B.dir, 'src/f3.js') || '')))
  fs.writeFileSync(path.join(B.dir, 'src/f5.js'), "export const v = 'edited by Bob'\n")
  T('A9 ...and back', await waitFor(() => /edited by Bob/.test(read(A.dir, 'src/f5.js') || '')))

  const C = join('c', 'Carol', { mux: '0' })
  T('A10 HIVE_MUX=0 keeps the old transport (a socket per file)', C.s.status().transport === 'socket', C.s.status().transport)
  T('A11 the old-transport joiner receives every file, including both edits', await waitFor(() => FILES.every((f) => read(C.dir, f) === read(A.dir, f))))
  fs.writeFileSync(path.join(C.dir, 'src/f7.js'), "export const v = 'edited by Carol'\n")
  T('A12 an edit from the old transport reaches both new-transport participants',
    await waitFor(() => /edited by Carol/.test(read(A.dir, 'src/f7.js') || '') && /edited by Carol/.test(read(B.dir, 'src/f7.js') || '')))
  h = await health()
  T('A13 the old-transport participant still costs 1 + one per file', h.connections === 4 + 1 + C.s.status().files, `connections=${h.connections}`)

  // ── D. accounting ───────────────────────────────────────────────────────────────────
  console.log('\n# D  every channel is closed exactly once')
  leave(C)
  T('D1 the old-transport participant leaves: back to 4 sockets', await waitFor(async () => (await health()).connections === 4), `connections=${(await health()).connections}`)
  leave(B)
  T('D2 one participant leaves: 2 sockets, and the channel count is EXACTLY the other\'s files',
    await waitFor(async () => { const x = await health(); return x.connections === 2 && x.channels === A.s.status().files }), JSON.stringify(await health()))
  leave(A)
  T('D3 everyone gone: 0 sockets, 0 channels', await waitFor(async () => { const x = await health(); return x.connections === 0 && x.channels === 0 }), JSON.stringify(await health()))

  // ── B. the gates, over a channel ────────────────────────────────────────────────────
  console.log('\n# B  every gate a per-file socket passes, a channel passes too')
  const base = watch(BASE, mint('Owner'))
  await waitFor(() => base.provider.synced)

  // B1-B2: a claim held by someone else refuses the write; the holder's own write lands.
  base.doc.getMap('claims').set('claimed.txt', { by: 'Holder', intent: 'edit', at: Date.now(), ttl: 300000 })
  await sleep(800)
  const w1 = watch(fileRoom(BASE, 'claimed.txt'), mint('Watcher', { kind: 'human' }))
  const rogue = channel(fileRoom(BASE, 'claimed.txt'), mint('Rogue'))
  // Synced first, or the write never leaves and "refused" is vacuous.
  const rogueUp = await waitFor(() => rogue.fp.synced && w1.provider.synced)
  rogue.doc.getText('content').insert(0, 'ROGUE-WRITE')
  await sleep(1500)
  T('B1 a write to a file someone else has claimed is refused over a channel', rogueUp && !w1.text().includes('ROGUE-WRITE'), `synced=${rogueUp} text=${w1.text()}`)
  const holder = channel(fileRoom(BASE, 'claimed.txt'), mint('Holder'))
  await waitFor(() => holder.fp.synced)
  holder.doc.getText('content').insert(0, 'HOLDER-WRITE')
  T('B2 ...while the holder\'s write over a channel lands (the gate is not just closed)', await waitFor(() => w1.text().includes('HOLDER-WRITE'), 5000), w1.text())
  rogue.close(); holder.close(); w1.close()

  // B3-B4: a read-only role reads, and cannot write.
  const w2 = watch(fileRoom(BASE, 'ro.txt'), mint('Watcher2', { kind: 'human' }))
  const writer = channel(fileRoom(BASE, 'ro.txt'), mint('Writer'))
  await waitFor(() => writer.fp.synced && w2.provider.synced)
  writer.doc.getText('content').insert(0, 'SEED')
  await waitFor(() => w2.text().includes('SEED'), 5000)
  const reader = channel(fileRoom(BASE, 'ro.txt'), mint('Reader', {}, { role: 'reader' }))
  T('B3 a read-only channel receives the file', await waitFor(() => reader.doc.getText('content').toString().includes('SEED'), 8000), reader.doc.getText('content').toString())
  reader.doc.getText('content').insert(0, 'READER-WRITE')
  await sleep(1500)
  T('B4 ...and its write never reaches the room', !w2.text().includes('READER-WRITE'), w2.text())
  reader.close(); writer.close(); w2.close()

  // B5-B6: a path-scoped token opens what it is granted and nothing else.
  const scoped = mint('Scoped', {}, { paths: ['src/**'] })
  const inScope = channel(fileRoom(BASE, 'src/ok.js'), scoped)
  const outScope = channel(fileRoom(BASE, 'docs/secret.md'), scoped)
  T('B5 a path-scoped token opens a file inside its scope', await waitFor(() => inScope.fp.synced, 8000))
  await waitFor(() => outScope.errs.length > 0, 8000)
  T('B6 ...and is refused one outside it, with a status code', outScope.errs.length > 0 && !outScope.fp.synced && [401, 403].includes(outScope.errs[0].code),
    JSON.stringify(outScope.errs[0] || null))
  inScope.close(); outScope.close()

  // B7-B10: things only a hostile client would send.
  const r1 = raw(mint('Hostile'))
  await r1.open
  r1.ws.send(encodeFrame(F.OPEN, 1, fileRoom('someoneelse', 'a.js')))
  await waitFor(() => r1.frames.some((f) => f.id === 1), 5000)
  const cross = r1.frames.find((f) => f.id === 1)
  T('B7 a channel for ANOTHER room\'s file is refused (Q437)', cross && cross.kind === F.REFUSED && cross.code === 403 && /Q437/.test(cross.reason), JSON.stringify(cross))
  r1.ws.send(encodeFrame(F.OPEN, 2, fileRoom(BASE, 'dup.txt')))
  await waitFor(() => r1.frames.some((f) => f.id === 2 && f.kind === F.OPENED), 5000)
  r1.ws.send(encodeFrame(F.OPEN, 2, fileRoom(BASE, 'dup.txt')))
  T('B8 reusing an open channel id is refused (409)', await waitFor(() => r1.frames.some((f) => f.id === 2 && f.kind === F.REFUSED && f.code === 409), 5000))
  r1.ws.send(Buffer.from([0x63, 0x01, 0x02]))
  T('B9 an unparseable frame closes that socket (1003)...', await waitFor(() => r1.closed === 1003, 5000), String(r1.closed))
  T('B10 ...and only that socket: the relay still answers', (await health()).ok !== false && relay && relay.exitCode === null)

  const otherRoomToken = sign({ iss: 't', sub: 'X', name: 'X', kind: 'ai', scopes: [{ room: 'otherroom', role: 'agent', paths: ['**'] }], iat: now(), exp: now() + 3600, jti: 'jx' }, { secret: SECRET })
  const r2 = raw(otherRoomToken)
  await r2.open
  T('B11 a token for another room cannot open this room\'s mux socket', [401, 403].includes(r2.refusedUpgrade), String(r2.refusedUpgrade))

  // B12: the crash this refactor fixed on the way. A per-file socket with no 'error' listener
  // threw on the first malformed WebSocket frame and took every room on the relay with it.
  // Mutation-checked 25 Sep 2026: with the listener removed this exact frame exits the relay (1).
  const sock = net.connect(PORT, 'localhost')
  sock.on('error', () => { }) // the relay drops this socket, as it should; that is not the test failing
  await new Promise((r) => sock.once('connect', r))
  const tok = mint('Framebreaker')
  sock.write(`GET /${encodeURIComponent(fileRoom(BASE, 'x.txt'))}?token=${tok} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`)
  const upgraded = await new Promise((r) => { sock.once('data', (d) => r(/101/.test(String(d)))); setTimeout(() => r(false), 4000) })
  sock.write(Buffer.from([0x83, 0x80, 1, 2, 3, 4])) // FIN + reserved opcode 3, masked, empty
  await sleep(800)
  let alive = false
  try { alive = !!(await health()) } catch { }
  T('B12 a malformed frame on a per-file socket no longer kills the relay', upgraded && alive && relay.exitCode === null, `upgraded=${upgraded} alive=${alive}`)
  sock.destroy()
  base.close()
  await sleep(500)

  // ── E. the one-socket ceiling, refused out loud ─────────────────────────────────────
  // The counterpart of refused-visible and ceiling-no-data-loss, which are pinned to the per-file
  // transport: on mux the socket count never runs out, so the ceiling that can is open files.
  console.log('\n# E  the open-file ceiling: refused visibly, named correctly, nothing zeroed')
  await stopRelay()
  relay = await startRelay({ HIVE_MAX_CHANNELS_TOTAL: '3' })
  const X = join('x', 'Xena', { withFiles: true })
  const before = Object.fromEntries(FILES.map((f) => [f, read(X.dir, f)]))
  T('E1 the relay admits exactly its ceiling of open files', await waitFor(async () => (await health()).channels === 3, 8000), JSON.stringify(await health()))
  T('E2 status reports the refused files', await waitFor(() => X.s.status().notSyncing >= 2, 10000), JSON.stringify(X.s.status()))
  const warned = await waitFor(() => X.logs.some((l) => /READ AS EMPTY/.test(l)), 15000)
  const w = X.logs.find((l) => /READ AS EMPTY/.test(l)) || ''
  T('E3 the client says so, once, rather than retrying quietly', warned && X.logs.filter((l) => /READ AS EMPTY/.test(l)).length === 1, w.slice(0, 200))
  T('E4 ...naming the ceiling the relay actually hit (Q438, in its own words), not the socket one', /Q438/.test(w), w.slice(0, 300))
  const Y2 = join('y', 'Yuri')
  await sleep(5000)
  T('E5 nothing on the full participant\'s disk was zeroed', FILES.every((f) => read(X.dir, f) === before[f]))
  const zeroed = FILES.filter((f) => read(Y2.dir, f) === '')
  T('E6 a joiner refused by the ceiling writes no file as empty', zeroed.length === 0, zeroed.join(','))
  leave(X); leave(Y2)
  await sleep(500)

  // ── C. degrade, never strand ────────────────────────────────────────────────────────
  console.log('\n# C  no mux on the relay, mux switched off mid-session, a relay restart')
  await stopRelay()
  relay = await startRelay({ HIVE_RELAY_MUX: 'off' })
  T('C1 a relay with mux off says so in /health', (await health()).mux === 0)
  const D = join('d', 'Dora', { withFiles: true })
  T('C2 a client against it uses a socket per file, and syncs', await waitFor(() => allSynced(D)) && D.s.status().transport === 'socket', D.s.status().transport)
  leave(D)
  await sleep(500)

  await stopRelay()
  relay = await startRelay()
  const E = join('e', 'Eve', { withFiles: true })
  const G = join('g', 'Gus')
  T('C3 two participants on mux', await waitFor(() => allSynced(E) && FILES.every((f) => read(G.dir, f) === read(E.dir, f))) && E.s.status().transport === 'mux')

  // The relay restarts while Eve edits: the edit must reach Gus once it is back.
  await stopRelay()
  fs.writeFileSync(path.join(E.dir, 'src/f1.js'), "export const v = 'written while the relay was down'\n")
  await sleep(1200)
  relay = await startRelay()
  T('C4 a write made while the relay was down arrives after it restarts', await waitFor(() => /while the relay was down/.test(read(G.dir, 'src/f1.js') || ''), 25000))

  // THE KILL SWITCH: mux turned off under live clients must push them back to sockets.
  await stopRelay()
  relay = await startRelay({ HIVE_RELAY_MUX: 'off' })
  T('C5 mux switched off mid-session: live clients fall back to a socket per file',
    await waitFor(() => E.s.status().transport === 'socket' && G.s.status().transport === 'socket', 25000),
    `${E.s.status().transport}/${G.s.status().transport}`)
  T('C6 ...and say why, once', E.logs.filter((l) => /falling back to a socket per file/.test(l)).length === 1, E.logs.filter((l) => /falling back/.test(l)).join(' | '))
  fs.writeFileSync(path.join(G.dir, 'src/f9.js'), "export const v = 'after the fallback'\n")
  T('C7 ...and keep syncing', await waitFor(() => /after the fallback/.test(read(E.dir, 'src/f9.js') || ''), 25000))
  leave(E); leave(G)
} catch (e) {
  console.log('  FAIL harness error: ' + (e && e.stack || e))
  fail++
} finally {
  for (const c of clients) leave(c)
  await stopRelay().catch(() => { })
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
