// tests/same-line-very-late-test.mjs -- P0-F: a same-line save that arrives after the race window.
//
//   node tests/same-line-very-late-test.mjs
//
// Antigravity-Cloud, 10 Nov 2026, on a2afc85: Alice, Bob and Dave save one line at the same moment and
// the room resolves it to a 3-version block. Carol saved the same line at the same moment, but her save
// was delayed 15 s on the way. By then the race's intents had expired (a 15 s window then), so no client
// saw her save as part of the clash: it landed as a raw character edit made against a text the block
// had replaced, and every folder ended with `wednes<<<<<<< Bob`. Carol's version was gone but for a
// fragment, and the block's opener no longer started its line. Nothing said so. (0.14.3:
// `ship thursmonwednestuesday`.)
//
// Carol's lateness is exact: she reaches the relay through a TCP proxy that holds her traffic.
//   V1  released inside the window (8 s): one block, all four versions, nothing fused
//   V2  released after it (17 s): the same
//   V3  released long after (30 s): the same

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
delete process.env.HIVE_FORK_GATE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(p, ms) { const e = Date.now() + ms; while (Date.now() < e) { if (await p()) return true; await sleep(10) } return false }
let pass = 0, fail = 0
const T = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c || !d ? '' : '  -- ' + d}`); c ? pass++ : fail++ }
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'very-late-'))
const port = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((r) => relay.stdout.on('data', (d) => { if (/listening on/.test(d)) r() }))

// A TCP proxy in front of the relay, for one client. hold() keeps every byte, both ways, until release().
// Bytes are only delayed, never dropped or reordered, so the WebSocket stream stays intact.
function holdingProxy(target) {
  let holding = false
  const pending = []
  const socks = new Set()
  const srv = net.createServer((client) => {
    const up = net.connect(target, '127.0.0.1')
    socks.add(client); socks.add(up)
    const pipe = (from, to) => from.on('data', (d) => { if (holding) pending.push([to, d]); else to.write(d) })
    pipe(client, up); pipe(up, client)
    const end = () => { for (const s of [client, up]) { try { s.destroy() } catch { } } }
    client.on('error', end); up.on('error', end); client.on('close', end); up.on('close', end)
  })
  return {
    listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port))),
    hold: () => { holding = true },
    release: () => { holding = false; for (const [to, d] of pending.splice(0)) { try { to.write(d) } catch { } } },
    close: () => { for (const s of socks) { try { s.destroy() } catch { } } srv.close() },
  }
}
const proxy = holdingProxy(port)
const proxyPort = await proxy.listen()

const { startSync } = await import(path.join(ROOT, 'sync.js'))
const room = 'verylate-' + Math.random().toString(36).slice(2, 8)
const clients = []
const join = (n, via = port) => { const dir = path.join(TMP, n); fs.mkdirSync(dir, { recursive: true }); const c = startSync({ relay: `ws://localhost:${via}`, room, dir, name: n, kind: 'ai', log: () => { } }); const x = { c, dir, n }; clients.push(x); return x }
const A = join('Alice'), B = join('Bob'), C = join('Carol', proxyPort), D = join('Dave')
await until(() => clients.every((x) => x.c.provider.synced), 20000)
await sleep(1500)

const read = (x, f) => { try { return fs.readFileSync(path.join(x.dir, f), 'utf8') } catch { return '' } }
const write = (x, f, t) => fs.writeFileSync(path.join(x.dir, f), t)
const markers = (t) => /^<<<<<<< /m.test(t) && /^>>>>>>> /m.test(t)
const chatAbout = (f) => A.c.doc.getArray('chat').toArray().filter((m) => String(m.text || '').includes(f)).map((m) => `${m.by}: ${String(m.text).slice(0, 80)}`)
// Fused: two of the race's words run together, or a marker that does not start its line.
const FUSED = /(mon|tues|wednes|thurs)(mon|tues|wednes|thurs)|[a-z]<<<<<<<|[^\n]<<<<<<< |[^\n]>>>>>>> /
function watchDisks(f) {
  const seen = []
  const iv = setInterval(() => { for (const x of clients) { const t = read(x, f); if (FUSED.test(t) && seen.length < 3) seen.push(`${x.n}: ${JSON.stringify(t)}`) } }, 10)
  return () => { clearInterval(iv); return seen }
}
let k = 0
async function seed(text) {
  const f = `board-${++k}.md`
  write(A, f, text)
  await until(() => clients.every((x) => read(x, f) === text), 15000)
  await sleep(800)
  return f
}
const settled = async (f, ms = 15000) => { await until(() => new Set(clients.map((x) => read(x, f))).size === 1, ms); await sleep(1500) }
const BASE = 'plan\nship friday\nowner: team\nnotes\n'


async function veryLate(holdMs) {
  const f = await seed(BASE)
  const stop = watchDisks(f)
  proxy.hold()
  write(A, f, BASE.replace('friday', 'monday')); write(B, f, BASE.replace('friday', 'tuesday'))
  write(D, f, BASE.replace('friday', 'thursday')); write(C, f, BASE.replace('friday', 'wednesday'))
  const blocked = await until(() => [A, B, D].every((x) => markers(read(x, f))), 12000)
  await sleep(Math.max(0, holdMs - 5000))
  proxy.release()
  await settled(f, 30000); await sleep(4000)
  return { f, blocked, fused: stop(), texts: clients.map((x) => read(x, f)) }
}

for (const [name, ms] of [['V1', 8000], ['V2', 17000], ['V3', 30000]]) {
  console.log(`\n# ${name} Carol's same-line save released after ${ms / 1000} s`)
  const r = await veryLate(ms)
  T(`${name} setup: the on-time saves were resolved to a block first`, r.blocked)
  T(`${name} every folder holds the same text`, new Set(r.texts).size === 1, r.texts.map((s) => JSON.stringify(s)).join(' | '))
  T(`${name} all four versions, each a whole line, inside markers`, r.texts.every((s) => markers(s) && ['monday', 'tuesday', 'thursday', 'wednesday'].every((d) => s.split('\n').includes(`ship ${d}`))), `${JSON.stringify(r.texts[0])} chat ${JSON.stringify(chatAbout(r.f))}`)
  T(`${name} no disk ever held fused text`, r.fused.length === 0 && r.texts.every((s) => !FUSED.test(s)), r.fused.join('; ') || JSON.stringify(r.texts[0]))
}

console.log(`\n=== SAME-LINE VERY LATE: ${pass} passed, ${fail} failed ===`)
for (const x of clients) try { x.c.stop() } catch { }
proxy.close(); relay.kill(); fs.rmSync(TMP, { recursive: true, force: true })
