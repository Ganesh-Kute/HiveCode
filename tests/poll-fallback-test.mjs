// tests/poll-fallback-test.mjs -- an agent behind a proxy that refuses WebSockets still joins and
// syncs, over HTTPS long-poll (hive-transport.js, relay-poll.js).
//
// 7 Nov 2026: Antigravity's 24/7 cloud VMs route egress through a proxy that answers every
// WebSocket upgrade with "403 WebSocket upgrades are not allowed" and passes plain HTTPS. On 0.13.1 a
// client there retries the upgrade forever and never syncs (A1 below is red on 0.13.1).
//
//   node tests/poll-fallback-test.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import http from 'http'
import crypto from 'crypto'
import { spawn } from 'child_process'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const url = (f) => `file:///${ROOT.replace(/\\/g, '/')}/${f}`
const { startSync } = await import(url('sync.js'))
let T = null
try { T = await import(url('hive-transport.js')) } catch { /* 0.13.1 has no transport module */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const free = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-poll-'))
const procs = []

async function startRelay(port, env = {}) {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.push(p)
  await new Promise((r, j) => { const t = setTimeout(() => j(new Error('relay did not start')), 20000); p.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); r() } }) })
  return p
}

// The VM's proxy, as a client sees it: every upgrade refused with its exact words, every plain HTTP
// request forwarded. Faults on request: drop the first recv answer that carries frames (after the
// relay sent it), and send the first send request to the relay twice.
function startProxy(relayPort, faults = {}) {
  const seen = []
  let droppedRecv = false, duplicatedSend = false
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const forward = () => new Promise((resolve) => {
        const up = http.request({ host: '127.0.0.1', port: relayPort, method: req.method, path: req.url, headers: { ...req.headers, 'content-length': body.length } }, (r) => {
          const out = []
          r.on('data', (c) => out.push(c))
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(out) }))
        })
        up.on('error', () => resolve(null))
        up.end(body)
      })
      ;(async () => {
        let r = await forward()
        if (faults.duplicateSend && !duplicatedSend && /\/send$/.test(req.url.split('?')[0])) { duplicatedSend = true; r = await forward() }
        if (!r) { res.writeHead(502); return res.end() }
        if (faults.dropRecv && !droppedRecv && /\/recv$/.test(req.url.split('?')[0]) && r.status === 200) { droppedRecv = true; return req.socket.destroy() }
        res.writeHead(r.status, r.headers)
        res.end(r.body)
      })()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    seen.push(`UPGRADE ${req.url.split('?')[0]}`)
    if (!faults.passUpgrades) return socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nWebSocket upgrades are not allowed')
    // Pass-through: the upgrade reaches the relay, so the RELAY's own answer comes back.
    const up = net.connect(relayPort, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n')
      if (head && head.length) up.write(head)
      socket.pipe(up); up.pipe(socket)
    })
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy())
  })
  return new Promise((r) => server.listen(0, () => r({ port: server.address().port, seen, server, faults: () => ({ droppedRecv, duplicatedSend }) })))
}

const dirOf = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d }
const read = (d, rel) => { try { return fs.readFileSync(path.join(d, rel), 'utf8') } catch { return null } }
async function arrives(d, rel, text, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (read(d, rel) === text) return Date.now() - t0; await sleep(25) }
  return null
}
const clients = []
function join(relay, room, name) { const dir = dirOf(name); const c = startSync({ relay, room, dir, name, kind: 'ai', log: () => { } }); clients.push(c); return { c, dir } }

try {
  const RP = await free()
  await startRelay(RP)
  const proxy = await startProxy(RP, { dropRecv: true, duplicateSend: true })
  const room = 'poll-' + Date.now()

  console.log('\n# A. behind a proxy that refuses WebSockets, an agent joins and syncs both ways')
  const A = join(`ws://localhost:${RP}`, room, 'Ada')
  await sleep(1500)
  const B = join(`ws://127.0.0.1:${proxy.port}`, room, 'Ben')
  await sleep(2500)
  fs.writeFileSync(path.join(A.dir, 'a.js'), 'export const a = 1\n')
  const t1 = await arrives(B.dir, 'a.js', 'export const a = 1\n')
  ok('A1 a file written by a direct client reaches the client behind the proxy', t1 !== null, `${t1} ms`)
  fs.writeFileSync(path.join(B.dir, 'b.js'), 'export const b = 1\n')
  const t2 = await arrives(A.dir, 'b.js', 'export const b = 1\n')
  ok('A2 a file written behind the proxy reaches the direct client', t2 !== null, `${t2} ms`)
  let lost = 0
  for (let i = 2; i <= 6; i++) {
    fs.writeFileSync(path.join(B.dir, 'b.js'), `export const b = ${i}\n`)
    if (await arrives(A.dir, 'b.js', `export const b = ${i}\n`) === null) lost++
    fs.writeFileSync(path.join(A.dir, 'a.js'), `export const a = ${i}\n`)
    if (await arrives(B.dir, 'a.js', `export const a = ${i}\n`) === null) lost++
  }
  ok('A3 ten more edits, alternating, all arrive', lost === 0, `${lost} lost`)
  ok('A4 the client behind the proxy uses long-poll, the direct one a WebSocket', !!T && T.transportFor(`ws://127.0.0.1:${proxy.port}`) === 'poll' && T.transportFor(`ws://localhost:${RP}`) === 'ws')
  const upgrades = proxy.seen.filter((l) => l.startsWith('UPGRADE')).length
  ok('A5 one refused upgrade, then no more attempts (the switch is remembered)', upgrades === 1, `${upgrades} refused upgrades`)
  const pollUrls = proxy.seen.filter((l) => l.includes('/_hive_poll/'))
  ok('A6 no long-poll request carries the room id or a token in its URL (proxies log URLs)', pollUrls.length > 0 && !pollUrls.some((l) => l.includes(room) || /token=/.test(l)), `${pollUrls.length} poll requests`)
  const f = proxy.faults()
  ok('A7 a recv answer lost after the relay sent it, and a send delivered twice, both happened', f.droppedRecv && f.duplicatedSend)
  ok('A8 ...and still no edit was lost or doubled (see A3; a.js and b.js hold exactly the last values)', read(B.dir, 'a.js') === 'export const a = 6\n' && read(A.dir, 'b.js') === 'export const b = 6\n')

  console.log('\n# B. quiet for a whole hold, then an edit still arrives')
  await sleep(23000)
  fs.writeFileSync(path.join(A.dir, 'a.js'), 'export const a = 7\n')
  const t3 = await arrives(B.dir, 'a.js', 'export const a = 7\n')
  ok('B1 after 23 s of silence (longer than one 20 s hold), the next edit arrives', t3 !== null, `${t3} ms`)

  console.log('\n# C. forced, and a relay that does not offer long-poll')
  process.env.HIVE_TRANSPORT = 'ws'
  const proxyC = await startProxy(RP)
  const C = join(`ws://127.0.0.1:${proxyC.port}`, room, 'Cy')
  await sleep(6000)
  ok('C1 HIVE_TRANSPORT=ws: no long-poll is tried behind the proxy', !proxyC.seen.some((l) => l.includes('/_hive_poll/')) && read(C.dir, 'a.js') === null)
  delete process.env.HIVE_TRANSPORT
  const RP2 = await free()
  await startRelay(RP2, { HIVE_RELAY_POLL: 'off' })
  const proxyD = await startProxy(RP2)
  const errors = []
  const D = startSync({ relay: `ws://127.0.0.1:${proxyD.port}`, room: room + '-d', dir: dirOf('Di'), name: 'Di', kind: 'ai', log: (s) => errors.push(String(s)) })
  clients.push(D)
  await sleep(6000)
  ok('C2 a relay without long-poll: nothing is opened over it (no /_hive_poll/ requests)', !proxyD.seen.some((l) => l.includes('/_hive_poll/')))
  ok('C3 ...and the client is not connected (it does not pretend)', !D.status || D.status().connected === false)
  const RP3 = await free()
  await startRelay(RP3)
  process.env.HIVE_TRANSPORT = 'http'
  const E = join(`ws://localhost:${RP3}`, room + '-e', 'Ed')
  const F = join(`ws://localhost:${RP3}`, room + '-e', 'Flo')
  await sleep(2500)
  fs.writeFileSync(path.join(E.dir, 'e.js'), 'export const e = 1\n')
  const t4 = await arrives(F.dir, 'e.js', 'export const e = 1\n')
  ok('C4 HIVE_TRANSPORT=http: two clients on long-poll with no proxy at all still sync', t4 !== null, `${t4} ms`)
  delete process.env.HIVE_TRANSPORT

  console.log('\n# D. the relay\'s own refusal, and closing mid-switch (Antigravity\'s review)')
  const RP4 = await free()
  await startRelay(RP4, { HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: crypto.randomBytes(24).toString('hex') })
  const proxyE = await startProxy(RP4, { passUpgrades: true })
  const said = []
  const origErr = console.error
  console.error = (...a) => { said.push(a.join(' ')); origErr(...a) }
  const G = startSync({ relay: `ws://127.0.0.1:${proxyE.port}`, room: room + '-g', dir: dirOf('Gus'), name: 'Gus', kind: 'ai', log: () => { } })
  clients.push(G)
  await sleep(6000)
  console.error = origErr
  const upg = proxyE.seen.filter((l) => l.startsWith('UPGRADE')).length, pq = proxyE.seen.filter((l) => l.includes('/_hive_poll/')).length
  ok('D1 the relay refusing an upgrade itself (no token): no long-poll session is tried', upg > 0 && pq === 0, `${upg} upgrades, ${pq} poll requests`)
  ok('D2 ...and nothing claims the network refused WebSockets', !said.some((l) => /this network refused/.test(l)))
  if (T) {
    const RP5 = await free()
    await startRelay(RP5)
    const proxyF = await startProxy(RP5)
    const realFetch = globalThis.fetch
    globalThis.fetch = (u, o) => new Promise((r) => setTimeout(r, 1500)).then(() => realFetch(u, o)) // a slow /health
    const closes = []
    const sock = new T.HiveSocket(`ws://127.0.0.1:${proxyF.port}/${room}-h`)
    sock.onclose = (ev) => closes.push(ev)
    const t0 = Date.now()
    while (!sock._probing && Date.now() - t0 < 5000) await sleep(10)
    const probing = !!sock._probing
    sock.close()
    await sleep(2500)
    globalThis.fetch = realFetch
    ok('D3 close() while it checks /health: CLOSED at once, one close event, no poll session opened', probing && sock.readyState === 3 && closes.length === 1 && !proxyF.seen.some((l) => l.includes('/_hive_poll/open')), `probing=${probing} readyState=${sock.readyState} closes=${closes.length}`)
  }
} catch (e) {
  ok('no exception', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const c of clients) { try { c.stop() } catch { } }
  for (const p of procs) { try { p.kill() } catch { } }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
