// tests/same-line-soak-test.mjs -- P0-F soak: random saves at random lateness, and no line nobody wrote.
//
//   node tests/same-line-soak-test.mjs            ROUNDS=6 SEED=1 by default; ROUNDS=100 for a soak
//
// The other fuzzers check that each author's text is somewhere in the file, which a fused line
// (`ship montuesday`) also satisfies. This one checks the thing itself: every line of every file, on
// every disk, during the round and after it, is a line of the base, a line one author wrote, or a
// marker. Four clients on a local relay, each behind its own holding proxy. Per round, six files
// (.js through the structural merge, .md through the line merge); each client rolls, per file, the
// shared line, the line next to it, a line of its own, or nothing; and rolls how long its traffic is
// held (not at all, or 0.3 to 25 s: inside the settle time, the race window, and past both). Every
// save is made at the same moment, against the same base.
//   CONVERGE   every disk holds the same text
//   INVENTED   no line that nobody wrote (sampled every 25 ms, and at the end)
//   LOSS       every author's line is there, whole
//   UNFLAGGED  a line two authors changed is inside markers
//   FALSE      no markers when no line had two authors
// One outcome is allowed and counted apart, as a known limit: a race the clients could not resolve
// because the file changed again first (two races in one file, both with late saves). Its line may
// stay fused, but never silently: the room is told to check that file by hand.
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
delete process.env.HIVE_FORK_GATE
const ROUNDS = Number(process.env.ROUNDS || 6), FILES = 6
let s = Number(process.env.SEED || 1) >>> 0
const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(p, ms) { const e = Date.now() + ms; while (Date.now() < e) { if (await p()) return true; await sleep(25) } return false }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'))
const port = await new Promise((res) => { const x = net.createServer(); x.listen(0, () => { const p = x.address().port; x.close(() => res(p)) }) })
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((r) => relay.stdout.on('data', (d) => { if (/listening on/.test(d)) r() }))

// A TCP proxy in front of the relay for one client: bytes are delayed, never dropped or reordered.
async function holdingProxy() {
  let holding = false
  const pending = [], socks = new Set()
  const srv = net.createServer((client) => {
    const up = net.connect(port, '127.0.0.1')
    socks.add(client); socks.add(up)
    const pipe = (from, to) => from.on('data', (d) => { if (holding) pending.push([to, d]); else to.write(d) })
    pipe(client, up); pipe(up, client)
    const end = () => { for (const x of [client, up]) { try { x.destroy() } catch { } } }
    for (const x of [client, up]) { x.on('error', end); x.on('close', end) }
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return {
    port: srv.address().port,
    hold: () => { holding = true },
    release: () => { holding = false; for (const [to, d] of pending.splice(0)) { try { to.write(d) } catch { } } },
    close: () => { for (const x of socks) { try { x.destroy() } catch { } } srv.close() },
  }
}

const { startSync } = await import(path.join(ROOT, 'sync.js'))
const room = 'soak-' + Math.random().toString(36).slice(2, 8)
const clients = []
for (const n of ['alice', 'bob', 'carol', 'dave']) {
  const dir = path.join(TMP, n), proxy = await holdingProxy()
  fs.mkdirSync(dir, { recursive: true })
  clients.push({ n, dir, proxy, c: startSync({ relay: `ws://localhost:${proxy.port}`, room, dir, name: n, kind: 'ai', log: process.env.SOAK_LOG ? (m) => console.log(`    ${Date.now() % 100000} ${m}`) : () => { } }) })
}
await until(() => clients.every((x) => x.c.provider.synced), 20000)
await sleep(1500)

const read = (x, f) => { try { return fs.readFileSync(path.join(x.dir, f), 'utf8') } catch { return '' } }
const BASE = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i}`)
const MARKER = /^(<<<<<<<|>>>>>>>)( .*)?$|^=======$/
const SHARED = 3, HOLDS = [300, 1000, 3000, 6000, 9000, 14000, 18000, 25000]
let failed = 0, cases = 0, late = 0, clashes = 0, byHand = 0
const told = (f) => clients[0].c.doc.getArray('chat').toArray().some((m) => { const t = String((m && m.text) || ''); return t.includes(f) && /by hand/i.test(t) })

for (let r = 1; r <= ROUNDS; r++) {
  const files = Array.from({ length: FILES }, (_, j) => `soak-${r}-${j}.${j % 2 ? 'md' : 'js'}`)
  for (const f of files) fs.writeFileSync(path.join(clients[0].dir, f), BASE.join('\n') + '\n')
  await until(() => files.every((f) => clients.every((x) => read(x, f) === BASE.join('\n') + '\n')), 20000)
  await sleep(800)

  // The plan: per file, which line each client changes; per client, how long its traffic is held.
  const plan = new Map(files.map((f) => [f, clients.map((x, i) => {
    const at = pick([SHARED, SHARED, SHARED, SHARED + 1, SHARED + 1, 7 + i, 7 + i, -1])
    return at < 0 ? null : { at, line: `const v${at} = "${x.n}-r${r}"` }
  })]))
  const holds = clients.map(() => (rnd() < 0.5 ? 0 : pick(HOLDS)))
  const known = new Map(files.map((f) => [f, new Set([...BASE, '', ...plan.get(f).filter(Boolean).map((e) => e.line)])]))
  const invented = (f, t) => t.split('\n').find((l, k, a) => !MARKER.test(l) && !known.get(f).has(l) &&
    !(k === a.length - 1 && [...known.get(f)].some((x) => x.startsWith(l)))) // a file caught mid-write ends in part of a line
  const seen = []
  const iv = setInterval(() => { for (const f of files) for (const x of clients) { const bad = invented(f, read(x, f)); if (bad !== undefined && seen.length < 3) seen.push(`${x.n} ${f}: ${JSON.stringify(bad)}`) } }, 25)

  clients.forEach((x, i) => { if (holds[i]) x.proxy.hold() })
  for (const f of files) plan.get(f).forEach((e, i) => { if (e) fs.writeFileSync(path.join(clients[i].dir, f), BASE.map((l, k) => (k === e.at ? e.line : l)).join('\n') + '\n') })
  clients.forEach((x, i) => { if (holds[i]) setTimeout(() => x.proxy.release(), holds[i]) })
  await sleep(Math.max(...holds) + 500)
  // Settled: every disk the same, and nothing has changed for 4 s.
  let last = '', since = Date.now()
  await until(() => {
    const now = files.map((f) => clients.map((x) => read(x, f)).join('\u0000')).join('\u0001')
    if (now !== last) { last = now; since = Date.now() }
    return Date.now() - since > 4000 && files.every((f) => new Set(clients.map((x) => read(x, f))).size === 1)
  }, 60000)
  clearInterval(iv)

  const flagged = files.filter(told)
  byHand += flagged.length
  const bad = seen.filter((x) => !flagged.some((f) => x.includes(f))).map((x) => `INVENTED (during) ${x}`)
  for (const f of files) {
    const edits = plan.get(f).filter(Boolean), texts = clients.map((x) => read(x, f))
    const clash = edits.some((e, i) => edits.some((o, j) => j !== i && o.at === e.at))
    const marked = /^<<<<<<< /m.test(texts[0])
    cases++; if (clash) clashes++
    if (new Set(texts).size !== 1) bad.push(`CONVERGE ${f}`)
    if (flagged.includes(f)) continue
    if (texts.some((t) => invented(f, t) !== undefined)) bad.push(`INVENTED ${f}: ${JSON.stringify(texts.map((t) => invented(f, t)).find((x) => x !== undefined))}`)
    if (texts.some((t) => edits.some((e) => !t.split('\n').includes(e.line)))) bad.push(`LOSS ${f}`)
    if (clash && !marked) bad.push(`UNFLAGGED ${f}`)
    if (!clash && marked) bad.push(`FALSE ${f}`)
    if (bad.some((b) => b.endsWith(f) || b.includes(f + ':'))) bad.push(`   ${f} plan ${JSON.stringify(plan.get(f).map((e) => e && e.at))} text ${JSON.stringify(texts[0])}`)
  }
  late += holds.filter(Boolean).length
  console.log(`  ${bad.length ? 'FAIL' : 'ok  '} round ${r}: held ${JSON.stringify(holds.map((h) => h / 1000))} s${bad.length ? '\n     ' + bad.join('\n     ') : ''}`)
  if (bad.length) failed++
}

console.log(`\n=== SAME-LINE SOAK (seed ${process.env.SEED || 1}): ${ROUNDS - failed} of ${ROUNDS} rounds held; ${cases} files, ${clashes} with a clash, ${late} late clients, ${byHand} left to check by hand ===`)
for (const x of clients) { try { x.c.stop() } catch { } x.proxy.close() }
relay.kill(); fs.rmSync(TMP, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
