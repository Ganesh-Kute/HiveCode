// tests/same-line-later-save-test.mjs -- P0-F F5: a save made AFTER seeing one side of a same-line race.
//
//   node tests/same-line-later-save-test.mjs
//
// docs/rules-rewrite/p0f-design.md. Alice and Bob save one line at the same moment. Bob's save is slow
// to arrive. Carol already holds Alice's version and saves the file again before Bob's arrives: her save
// was made from Alice's text, not from the text the race started from. Before this fix, the resolution
// saw her save as "a later edit", gave up, and the fused text landed in every folder ("tues<<<<<<< local
// (yours)" in tests/same-line-race-test.mjs R6, about 1 run in 10, when Carol was the third saver).
//
// Bob's lateness is made exact, not hoped for: Bob reaches the relay through a small TCP proxy that can
// hold his traffic. While it holds, Bob's save sits in the proxy, and nobody has seen it.
//
//   R10  Carol saves the SAME line (from Alice's text) before Bob's save arrives
//        -> one block, Bob's and Carol's versions both in it, nothing fused on any disk
//   R11  Carol saves ANOTHER line (from Alice's text) before Bob's save arrives
//        -> the race resolved (both of its versions, markers), Carol's edit kept, nothing fused
//   R12  the control: Carol's save comes AFTER the race was resolved -> an ordinary edit of the
//        resolved file, nothing lost
//   R13  Carol saves another line WHILE the race is being resolved (her disk is held) -> her save waits
//        for the resolution instead of merging against the fused shared text: nothing fused on any disk

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'later-save-'))
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
const room = 'latersave-' + Math.random().toString(36).slice(2, 8)
const clients = []
const join = (n, via = port) => { const dir = path.join(TMP, n); fs.mkdirSync(dir, { recursive: true }); const c = startSync({ relay: `ws://localhost:${via}`, room, dir, name: n, kind: 'ai', log: () => { } }); const x = { c, dir, n }; clients.push(x); return x }
const A = join('Alice'), B = join('Bob', proxyPort), C = join('Carol'); join('Dave')
await until(() => clients.every((x) => x.c.provider.synced), 20000)
await sleep(1500)

const read = (x, f) => { try { return fs.readFileSync(path.join(x.dir, f), 'utf8') } catch { return '' } }
const write = (x, f, t) => fs.writeFileSync(path.join(x.dir, f), t)
const markers = (t) => /^<<<<<<< /m.test(t) && /^>>>>>>> /m.test(t)
const chatAbout = (f) => A.c.doc.getArray('chat').toArray().filter((m) => String(m.text || '').includes(f)).map((m) => `${m.by}: ${String(m.text).slice(0, 80)}`)
// Fused: two of the race's words run together, or a marker that does not start its line.
const FUSED = /(mon|tues|wednes)(mon|tues|wednes)|[^\n]<<<<<<< |[^\n]>>>>>>> /
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

// Alice and Bob save at the same moment; Bob's save is held. Carol waits until she holds Alice's version,
// then does `carol(text)`. Then Bob's save is released.
async function lateRace(carol) {
  const f = await seed(BASE)
  const stop = watchDisks(f)
  proxy.hold()
  write(A, f, BASE.replace('friday', 'monday')); write(B, f, BASE.replace('friday', 'tuesday'))
  const sawAlice = await until(() => read(C, f).includes('ship monday'), 10000)
  await sleep(300)
  if (sawAlice) write(C, f, carol(read(C, f)))
  await sleep(700)
  proxy.release()
  await settled(f); await sleep(3000)
  return { f, sawAlice, fused: stop(), texts: clients.map((x) => read(x, f)) }
}

console.log('\n# R10 Carol, holding Alice\'s version, saves the same line before Bob\'s save arrives')
{
  const r = await lateRace((t) => t.replace('ship monday', 'ship wednesday'))
  T('R10 setup: Carol held Alice\'s version before Bob\'s save arrived', r.sawAlice)
  T('R10 every folder holds the same text', new Set(r.texts).size === 1, r.texts.map((s) => JSON.stringify(s)).join(' | '))
  T('R10 one block with Bob\'s and Carol\'s versions', r.texts.every((s) => markers(s) && s.includes('ship tuesday') && s.includes('ship wednesday')), `${JSON.stringify(r.texts[0])} chat ${JSON.stringify(chatAbout(r.f))}`)
  const opens = (s) => (s.match(/^<<<<<<< /gm) || []).length
  T('R10 ...ONE block: Carol\'s version is the file she saved, not the markers her merge raised', r.texts.every((s) => opens(s) === 1 && !/local \(yours\)|incoming \(theirs\)/.test(s)), JSON.stringify(r.texts[0]))
  T('R10 no disk ever held fused text', r.fused.length === 0, r.fused.join('; '))
}

console.log('\n# R11 Carol, holding Alice\'s version, saves another line before Bob\'s save arrives')
{
  const r = await lateRace((t) => t.replace('notes', 'notes by Carol'))
  T('R11 setup: Carol held Alice\'s version before Bob\'s save arrived', r.sawAlice)
  T('R11 every folder holds the same text', new Set(r.texts).size === 1, r.texts.map((s) => JSON.stringify(s)).join(' | '))
  T('R11 the race resolved: one block with Alice\'s and Bob\'s versions', r.texts.every((s) => markers(s) && s.includes('ship monday') && s.includes('ship tuesday')), `${JSON.stringify(r.texts[0])} chat ${JSON.stringify(chatAbout(r.f))}`)
  T('R11 ...and Carol\'s edit is kept', r.texts.every((s) => s.includes('notes by Carol')), JSON.stringify(r.texts[0]))
  T('R11 no disk ever held fused text', r.fused.length === 0, r.fused.join('; '))
}

console.log('\n# R12 control: Carol saves after the race was resolved')
{
  const f = await seed(BASE)
  const stop = watchDisks(f)
  proxy.hold()
  write(A, f, BASE.replace('friday', 'monday')); write(B, f, BASE.replace('friday', 'tuesday'))
  await sleep(500)
  proxy.release()
  await until(() => clients.every((x) => markers(read(x, f))), 20000)
  await settled(f)
  write(C, f, read(C, f).replace('notes', 'notes by Carol'))
  await settled(f); await sleep(2000)
  const fused = stop(), texts = clients.map((x) => read(x, f))
  T('R12 the resolved block is kept, and so is Carol\'s later edit', texts.every((s) => markers(s) && s.includes('ship monday') && s.includes('ship tuesday') && s.includes('notes by Carol')), JSON.stringify(texts[0]))
  T('R12 no disk ever held fused text', fused.length === 0, fused.join('; '))
}

console.log('\n# R13 Carol saves another line while the race is being resolved')
for (let it = 0; it < 3; it++) {
  const f = await seed(BASE)
  const stop = watchDisks(f)
  proxy.hold()
  write(A, f, BASE.replace('friday', 'monday')); write(B, f, BASE.replace('friday', 'tuesday'))
  await sleep(500)
  proxy.release()
  // Inside the settle window: every peer holds its disk; Carol's copy is still what she had.
  await sleep(150)
  write(C, f, read(C, f).replace('notes', 'notes by Carol'))
  await settled(f); await sleep(3000)
  const fused = stop(), texts = clients.map((x) => read(x, f))
  T(`R13.${it} the race resolved, and Carol's edit kept, everywhere`, new Set(texts).size === 1 && texts.every((s) => markers(s) && s.includes('ship monday') && s.includes('ship tuesday') && s.includes('notes by Carol')), `${JSON.stringify(texts[0])} chat ${JSON.stringify(chatAbout(f))}`)
  T(`R13.${it} no disk ever held fused text`, fused.length === 0, fused.join('; '))
}

console.log(`\n=== SAME-LINE LATER SAVE: ${pass} passed, ${fail} failed ===`)
for (const x of clients) try { x.c.stop() } catch { }
proxy.close(); relay.kill(); fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
