// tests/poll-write-on-exit-test.mjs -- P0-1 of 0.14.3: a write over HTTPS long-poll must not be lost
// when the agent leaves right after it, and the agent must be told the truth about whether it was sent.
//
// The 8-9 Nov mock run: two Antigravity VM agents (their proxy 403s every WebSocket upgrade, so they
// use long-poll) edited files, hive_edit said "syncing to every peer", the process left, and the room
// never got the edit. A WebSocket hands its bytes to the OS on send(), so close() still delivers them;
// PollSocket queued them in a JS array and close() dropped the array.
//
//   W1  an existing file edited, then stop() at once: the peer still gets the edit
//   W2  a new file written, then leave(): the peer gets it, and leave() says nothing was left unsent
//   W3  the relay is slow to accept: whenSent() says NOT sent (never a bare ok), then sent once it is
//   W4  leave() when the relay never accepts: reports the unsent file instead of claiming success
//   W5  WebSocket peers unchanged: an edit then stop() still arrives (no regression)
//   W9  deterministic M3: the proxy holds the file's poll-session OPEN, so its doc is provably unsynced
//       when the edit is made. whenSent() must say not sent, leave() must name the file while the
//       open is held (W9a), and wait for it then deliver once the open goes through (W9b).

import http from 'http'
import net from 'net'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

async function startRelay() {
  const port = await freePort()
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay start timeout')), 8000)
    proc.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve() } })
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`relay exited ${c}`)) })
  })
  return { port, url: `ws://127.0.0.1:${port}`, kill: () => { try { proc.kill('SIGKILL') } catch { } } }
}

// The VM's network: every WebSocket upgrade gets the proxy's 403, plain HTTP passes through.
// `gate.holdSends` holds every long-poll send until released (a slow or stalled path to the relay).
async function vmProxy(targetPort) {
  const port = await freePort()
  const gate = { holdSends: false, holdRecv: false, held: [], heldRecv: [], holdOpen: null, heldOpen: [] }
  const forward = (req, res, body) => {
    const p = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res) })
    p.on('error', (e) => { try { res.writeHead(502); res.end(e.message) } catch { } })
    p.end(body)
  }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      // holdOpen: a file name; the open of any channel whose body names it waits until releaseOpen().
      if (gate.holdOpen && /\/_hive_poll\/open$/.test(req.url) && body.toString('utf8').includes(gate.holdOpen)) { gate.heldOpen.push(() => forward(req, res, body)); return }
      if (gate.holdSends && /\/_hive_poll\/[^/]+\/send/.test(req.url)) { gate.held.push(() => forward(req, res, body)); return }
      if (gate.holdRecv && /\/_hive_poll\/[^/]+\/recv/.test(req.url)) { gate.heldRecv.push(() => forward(req, res, body)); return }
      forward(req, res, body)
    })
  })
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 38\r\n\r\n403 WebSocket upgrades are not allowed\n')
    socket.destroy()
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { url: `ws://127.0.0.1:${port}`, gate, release: () => { gate.holdSends = false; const h = gate.held.splice(0); for (const f of h) f() }, releaseRecv: () => { gate.holdRecv = false; const h = gate.heldRecv.splice(0); for (const f of h) f() }, releaseOpen: () => { gate.holdOpen = null; const h = gate.heldOpen.splice(0); for (const f of h) f() }, close: () => { try { server.closeAllConnections && server.closeAllConnections() } catch { } server.close() } }
}

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `hive-pollexit-${tag}-`))
const join = (relay, room, dir, name) => startSync({ relay, room, dir, name, kind: 'ai', log: () => { } })
async function until(fn, ms = 10000, step = 100) {
  const end = Date.now() + ms
  while (Date.now() < end) { try { const v = fn(); if (v) return v } catch { } await sleep(step) }
  try { return fn() } catch { return false }
}
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const synced = (hive) => until(() => hive.provider.synced, 15000)
const fileReady = (hive, dir, rel, text) => until(() => readOr(path.join(dir, rel)) === text, 15000)

const relay = await startRelay()
const proxy = await vmProxy(relay.port)
const live = []
try {
  // ---- W1: existing file, edit, stop() at once --------------------------------------------------
  console.log('\n# W1 existing file edited over long-poll, then stop() at once')
  {
    const room = 'room-pollexit-w1', dB = tmp('w1b'), dA = tmp('w1a')
    fs.writeFileSync(path.join(dB, 'shared.txt'), 'v0\n')
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    const A = join(proxy.url, room, dA, 'vm-agent'); live.push(A)
    await synced(A)
    T('W1 setup: the VM agent got the file over long-poll', !!(await fileReady(A, dA, 'shared.txt', 'v0\n')))
    await sleep(500)
    const r = A.edit('shared.txt', 'v1 from the VM\n', 'P0-1 W1')
    T('W1 the edit was accepted locally', r && r.ok === true, JSON.stringify(r))
    A.stop()
    const got = await fileReady(B, dB, 'shared.txt', 'v1 from the VM\n')
    T('W1 the peer got the edit although the VM agent left right after it', !!got, `peer has ${JSON.stringify(readOr(path.join(dB, 'shared.txt')))}`)
  }

  // ---- W2: new file, leave() ---------------------------------------------------------------------
  console.log('\n# W2 new file written over long-poll, then leave()')
  {
    const room = 'room-pollexit-w2', dB = tmp('w2b'), dA = tmp('w2a')
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    const A = join(proxy.url, room, dA, 'vm-agent'); live.push(A)
    await synced(A)
    await sleep(500)
    const r = A.edit('brand-new.txt', 'made on the VM\n', 'P0-1 W2')
    T('W2 the write was accepted locally', r && r.ok === true, JSON.stringify(r))
    T('W2 sync exposes an async leave()', typeof A.leave === 'function')
    let left = null
    if (typeof A.leave === 'function') left = await A.leave({ timeoutMs: 10000 })
    else A.stop()
    T('W2 leave() reports nothing unsent', !!left && Array.isArray(left.unsent) && left.unsent.length === 0, JSON.stringify(left))
    const got = await fileReady(B, dB, 'brand-new.txt', 'made on the VM\n')
    T('W2 the peer got the new file', !!got, `peer has ${JSON.stringify(readOr(path.join(dB, 'brand-new.txt')))}`)
  }

  // ---- W3: slow relay path: whenSent() tells the truth ---------------------------------------------
  console.log('\n# W3 the path to the relay is slow: is the edit sent yet?')
  {
    const room = 'room-pollexit-w3', dB = tmp('w3b'), dA = tmp('w3a')
    fs.writeFileSync(path.join(dB, 'slow.txt'), 'v0\n')
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    const A = join(proxy.url, room, dA, 'vm-agent'); live.push(A)
    await synced(A)
    await fileReady(A, dA, 'slow.txt', 'v0\n')
    await sleep(500)
    T('W3 sync exposes whenSent()', typeof A.whenSent === 'function')
    proxy.gate.holdSends = true
    A.edit('slow.txt', 'v1 slow\n', 'P0-1 W3')
    const early = typeof A.whenSent === 'function' ? await A.whenSent('slow.txt', 800) : null
    T('W3 while the relay has not accepted it, whenSent() says NOT sent', early === false, `got ${early}`)
    proxy.release()
    const later = typeof A.whenSent === 'function' ? await A.whenSent('slow.txt', 8000) : null
    T('W3 once the relay accepts it, whenSent() says sent', later === true, `got ${later}`)
    T('W3 and the peer has it', !!(await fileReady(B, dB, 'slow.txt', 'v1 slow\n')))
    try { A.stop() } catch { }
  }

  // ---- W4: relay never accepts: leave() reports the unsent file -----------------------------------
  console.log('\n# W4 the relay never accepts the send: leave() must say so')
  {
    const room = 'room-pollexit-w4', dB = tmp('w4b'), dA = tmp('w4a')
    fs.writeFileSync(path.join(dB, 'stuck.txt'), 'v0\n')
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    const A = join(proxy.url, room, dA, 'vm-agent'); live.push(A)
    await synced(A)
    await fileReady(A, dA, 'stuck.txt', 'v0\n')
    await sleep(500)
    proxy.gate.holdSends = true
    A.edit('stuck.txt', 'v1 never sent\n', 'P0-1 W4')
    let left = null
    if (typeof A.leave === 'function') left = await A.leave({ timeoutMs: 1500 })
    else A.stop()
    T('W4 leave() names the file that never reached the relay', !!left && Array.isArray(left.unsent) && left.unsent.includes('stuck.txt'), JSON.stringify(left))
    proxy.gate.held.length = 0 // drop them: the relay never accepted these
    proxy.gate.holdSends = false
  }

  // ---- W6: the VM's real sequence (antigravity-VM, 9 Nov): join, edit before the file synced, leave ----
  console.log('\n# W6 edit made before the file finished syncing, then leave() within a second')
  {
    const room = 'room-pollexit-w6', dB = tmp('w6b'), dA = tmp('w6a')
    fs.writeFileSync(path.join(dB, 'early.txt'), 'v0\n')
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    fs.writeFileSync(path.join(dA, 'early.txt'), 'v0\n') // the agent's folder already holds the file
    const A = join(proxy.url, room, dA, 'vm-agent'); live.push(A)
    await synced(A)
    const r = A.edit('early.txt', 'v1 written before sync\n', 'P0-1 W6')
    T('W6 the edit was accepted locally', r && r.ok === true, JSON.stringify(r))
    const left = typeof A.leave === 'function' ? await A.leave({ timeoutMs: 10000 }) : (A.stop(), null)
    T('W6 leave() reports nothing unsent', !!left && left.unsent.length === 0, JSON.stringify(left))
    T('W6 the peer got the edit', !!(await fileReady(B, dB, 'early.txt', 'v1 written before sync\n')), `peer has ${JSON.stringify(readOr(path.join(dB, 'early.txt')))}, agent disk has ${JSON.stringify(readOr(path.join(dA, 'early.txt')))}`)
  }

  // ---- W7: the file's doc is open but has not synced yet (VM-ANTI-G-1's surviving mutant M3) --------
  for (const [tag, prepopulated] of [['W7a', true], ['W7b', false]]) {
    console.log(`\n# ${tag} edit while the file is open but not yet synced (agent folder ${prepopulated ? 'already holds the room copy' : 'empty'}), then leave()`)
    const room = `room-pollexit-${tag.toLowerCase()}`, dB = tmp(`${tag}b`), dA = tmp(`${tag}a`)
    fs.writeFileSync(path.join(dB, 'late.txt'), 'v0\n')
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    if (prepopulated) fs.writeFileSync(path.join(dA, 'late.txt'), 'v0\n')
    const A = join(proxy.url, room, dA, 'vm-agent'); live.push(A)
    await synced(A)
    // Nothing more from the relay reaches A: its file channel is opened but not answered yet.
    proxy.gate.holdRecv = true
    const opened = await until(() => A.status && A.status().filesHeld >= 1, 8000, 20)
    T(`${tag} setup: the file's doc is open and not yet synced when the edit is made`, opened && readOr(path.join(dA, 'late.txt')) !== 'never', '')
    const r = A.edit('late.txt', 'v1 before its doc synced\n', `P0-1 ${tag}`)
    T(`${tag} the edit was accepted locally`, r && r.ok === true, JSON.stringify(r))
    setTimeout(() => proxy.releaseRecv(), 1500) // the relay answers a moment later, as a slow VM link does
    const left = typeof A.leave === 'function' ? await A.leave({ timeoutMs: 6000 }) : (A.stop(), null)
    proxy.releaseRecv()
    const got = await fileReady(B, dB, 'late.txt', 'v1 before its doc synced\n')
    if (prepopulated) {
      T(`${tag} leave() waited for it and reports nothing unsent`, !!left && left.unsent.length === 0, JSON.stringify(left))
      T(`${tag} the peer got the edit`, !!got, `peer has ${JSON.stringify(readOr(path.join(dB, 'late.txt')))}, agent disk has ${JSON.stringify(readOr(path.join(dA, 'late.txt')))}`)
    } else {
      // A file written blind into an empty folder that the room already holds is kept local on first
      // contact (by design: the room cannot tell newer from older). Whatever the outcome, leave()
      // must never claim the room has it when the room does not.
      T(`${tag} leave() never claims a write the room does not hold`, got || (!!left && left.unsent.includes('late.txt')), JSON.stringify({ left, peer: readOr(path.join(dB, 'late.txt')), agentDisk: readOr(path.join(dA, 'late.txt')) }))
    }
  }

  // ---- W9: deterministic M3. The file's channel cannot open, so its doc is unsynced for certain. -----
  // W7 could not pin that state (the doc often synced before the edit), so mutant M3 -- drop
  // `unsentLocal.add` for an edit to an open, unsynced file -- survived it (VM-ANTI-G-1, 9 Nov).
  for (const [tag, releaseAfterMs] of [['W9a', null], ['W9b', 1500]]) {
    console.log(`\n# ${tag} edit while the file's channel is held at OPEN, then leave() ${releaseAfterMs ? 'after the open goes through' : 'while it is still held'}`)
    const room = `room-pollexit-${tag.toLowerCase()}`, dB = tmp(`${tag}b`), dA = tmp(`${tag}a`)
    fs.writeFileSync(path.join(dB, 'm3.txt'), 'v0\n')
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    fs.writeFileSync(path.join(dA, 'm3.txt'), 'v0\n') // the agent's folder already holds the room's copy
    proxy.gate.holdOpen = 'm3.txt'
    // A socket per file (HIVE_MUX=0) for this agent only: the relay offers mux, and over mux every
    // file rides one stream, so there is no per-file OPEN for the proxy to hold (antigravity-VM, 9 Nov:
    // "held opens: 0"). The transport is decided inside startSync, so W1-W8 stay on the default mux.
    const muxWas = process.env.HIVE_MUX
    process.env.HIVE_MUX = '0'
    let A
    try { A = join(proxy.url, room, dA, 'vm-agent') } finally { if (muxWas === undefined) delete process.env.HIVE_MUX; else process.env.HIVE_MUX = muxWas }
    live.push(A)
    await synced(A)
    const held = await until(() => proxy.gate.heldOpen.length >= 1, 10000, 20)
    T(`${tag} setup: the file's channel is open-pending (its doc cannot have synced)`, !!held, `held opens: ${proxy.gate.heldOpen.length}`)
    const r = A.edit('m3.txt', 'v1 while the channel was opening\n', `P0-1 ${tag}`)
    T(`${tag} the edit was accepted locally, with no room copy claimed`, r && r.ok === true && r.landed == null, JSON.stringify(r))
    T(`${tag} whenSent() says NOT sent while the file cannot reach the relay`, (await A.whenSent('m3.txt', 0)) === false)
    let left
    if (releaseAfterMs == null) {
      left = await A.leave({ timeoutMs: 800 })
      proxy.releaseOpen()
      T(`${tag} leave() names the file it could not send`, !!left && Array.isArray(left.unsent) && left.unsent.includes('m3.txt'), JSON.stringify(left))
    } else {
      setTimeout(() => proxy.releaseOpen(), releaseAfterMs)
      left = await A.leave({ timeoutMs: 10000 })
      proxy.releaseOpen()
      T(`${tag} leave() waited for the file and reports nothing unsent`, !!left && Array.isArray(left.unsent) && left.unsent.length === 0, JSON.stringify(left))
      T(`${tag} the peer got the edit`, !!(await fileReady(B, dB, 'm3.txt', 'v1 while the channel was opening\n')), `peer has ${JSON.stringify(readOr(path.join(dB, 'm3.txt')))}`)
    }
  }

  // ---- W8: eviction never closes a file whose edit the relay has not accepted (surviving mutant M6) ---
  console.log('\n# W8 a full working set: the oldest open file holds an unsent edit')
  {
    const room = 'room-pollexit-w8', dB = tmp('w8b'), dA = tmp('w8a')
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dB, `f${i}.txt`), `f${i} v0\n`)
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    const saved = { cap: process.env.HIVE_MAX_OPEN_FILES, grace: process.env.HIVE_EVICT_GRACE_MS }
    process.env.HIVE_MAX_OPEN_FILES = '8'; process.env.HIVE_EVICT_GRACE_MS = '200'
    const A = join(proxy.url, room, dA, 'vm-agent'); live.push(A)
    for (const [k, v] of [['HIVE_MAX_OPEN_FILES', saved.cap], ['HIVE_EVICT_GRACE_MS', saved.grace]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    await synced(A)
    for (let i = 0; i < 8; i++) await fileReady(A, dA, `f${i}.txt`, `f${i} v0\n`)
    await sleep(500)
    proxy.gate.holdSends = true // the relay stops accepting: every edit from here on waits in A
    A.edit('f0.txt', 'f0 v1 unsent\n', 'P0-1 W8')
    await sleep(400) // past the grace: f0 is now the least recently used file
    for (let i = 1; i < 8; i++) { A.edit(`f${i}.txt`, `f${i} v1\n`, 'P0-1 W8 touch'); await sleep(20) }
    for (let i = 0; i < 3; i++) { A.edit(`new${i}.txt`, `new ${i}\n`, 'P0-1 W8 overflow'); await sleep(150) } // over the cap: eviction runs
    await sleep(500)
    proxy.release()
    const left = typeof A.leave === 'function' ? await A.leave({ timeoutMs: 10000 }) : (A.stop(), null)
    T('W8 leave() reports nothing unsent (f0 was kept open until the relay had it)', !!left && left.unsent.length === 0, JSON.stringify(left))
    T('W8 the peer got the oldest file\'s edit', !!(await fileReady(B, dB, 'f0.txt', 'f0 v1 unsent\n')), `peer has ${JSON.stringify(readOr(path.join(dB, 'f0.txt')))}`)
  }

  // ---- W5: WebSocket path unchanged ---------------------------------------------------------------
  console.log('\n# W5 WebSocket agent: edit then stop() still arrives')
  {
    const room = 'room-pollexit-w5', dB = tmp('w5b'), dA = tmp('w5a')
    fs.writeFileSync(path.join(dB, 'ws.txt'), 'v0\n')
    const B = join(relay.url, room, dB, 'peer-ws'); live.push(B)
    await synced(B)
    const A = join(relay.url, room, dA, 'ws-agent'); live.push(A)
    await synced(A)
    await fileReady(A, dA, 'ws.txt', 'v0\n')
    await sleep(500)
    A.edit('ws.txt', 'v1 over ws\n', 'P0-1 W5')
    A.stop()
    T('W5 the peer got the WebSocket agent\'s edit', !!(await fileReady(B, dB, 'ws.txt', 'v1 over ws\n')))
  }
} catch (e) {
  fail++
  console.log('  FAIL threw: ' + (e && e.stack || e))
} finally {
  for (const h of live) { try { h.stop() } catch { } }
  proxy.close()
  relay.kill()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
