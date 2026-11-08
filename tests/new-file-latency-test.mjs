// tests/new-file-latency-test.mjs -- a NEW file one peer creates reaches the other peer's disk fast.
//
// Measured 8 Nov 2026 by Claude-cloud on the live relay (0.14.0, enforceClaims=queue, mux:1), two
// hive-mcp clients in a fresh room: A created pp-a.txt (claim, hive_edit, release) and it reached B
// after 74 s; B's pp-b.txt reached A after 26 s, and both landed within 1 s of each other. A founder
// whose agent creates a file and hears 30 s later "it isn't there" believes the product is broken.
//
// Two REAL hive-mcp.js clients against a LOCAL server.js with HIVE_ENFORCE_CLAIMS=queue (as hosted).
// Each case creates a new file on A and times its arrival on B's disk, against a 5 s bar:
//   hive_edit (claim -> edit -> release) and a plain disk write, each with HIVE_MUX=1 and HIVE_MUX=0.
// Diagnosis only: this file must go RED on the bug and GREEN once it is fixed.

import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BAR_MS = Number(process.env.LATENCY_BAR_MS || 5000)
const WAIT_MS = Number(process.env.LATENCY_WAIT_MS || 90000) // measure past the bar, so red has a number
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'HIVE_PROXY', 'NODE_USE_ENV_PROXY']
const cleanEnv = (extra = {}) => { const e = { ...process.env }; for (const k of PROXY_ENV) delete e[k]; return { ...e, ...extra } }
// LATENCY_RELAY=wss://... measures against a real relay instead (clients then keep this machine's proxy env).
const LIVE = process.env.LATENCY_RELAY || ''
const clientEnv = (extra) => LIVE ? { ...process.env, ...extra } : cleanEnv(extra)

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}
async function startRelay() {
  const port = await freePort()
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: cleanEnv({ PORT: String(port), HIVE_PERSIST_DIR: 'off', HIVE_ENFORCE_CLAIMS: 'queue' }), stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay start timeout')), 8000)
    proc.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve() } })
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`relay exited early (${c})`)) })
  })
  return { port, kill: () => { try { proc.kill('SIGKILL') } catch { } } }
}

import http from 'http'
const FAKE = 'relay.hive.test'
const label = (m) => m === 'auto+proxy' ? 'HIVE_MUX unset, behind a proxy' : isCap(m) ? `room past the bound (${FILL} files, HIVE_MAX_OPEN_FILES=${CAP}${m.startsWith('capgrace') ? ', everything inside a 10 min grace' : ''}), HIVE_MUX=${muxOf(m)}` : 'HIVE_MUX=' + m
async function startProxy(relayPort) {
  const srv = http.createServer((req, res) => { res.writeHead(405); res.end() })
  srv.on('connect', (req, sock, head) => {
    const i = req.url.lastIndexOf(':')
    if (req.url.slice(0, i) !== FAKE) { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return }
    const up = net.connect(relayPort, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head && head.length) up.write(head); up.pipe(sock); sock.pipe(up) })
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
  })
  const socks = new Set(); srv.on('connection', (x) => { socks.add(x); x.on('close', () => socks.delete(x)) })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  return { port, close: () => new Promise((r) => { for (const x of socks) x.destroy(); srv.close(() => r()) }) }
}
let proxy = null
// cap+1 / cap+0: a room ALREADY FULLER than the working-set bound (HIVE_MAX_OPEN_FILES), mux / per-file.
// Found 8 Nov 2026: a new file did not reach a client in a 641-file room (sync.js drops the open queue at the cap).
const CAP = 8, FILL = 12, GRACE = 2000, BULK = 5, BURST = 50, BURST_BAR_MS = 15000
// capgrace+N: the same, but every open file stays inside a 10-minute grace window (nothing old to evict)
const isCap = (m) => /^cap(grace)?\+/.test(m)
const muxOf = (m) => m.slice(m.indexOf('+') + 1)
const graceOf = (m) => (m.startsWith('capgrace+') ? 600000 : GRACE)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-latency-'))
async function client(name, mux) {
  const home = path.join(tmp, `${name}-${mux}-home`), dir = path.join(tmp, `${name}-${mux}-dir`)
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(dir, { recursive: true })
  const t = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'hive-mcp.js')], cwd: ROOT, stderr: 'pipe',
    env: isCap(mux) ? cleanEnv({ HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: '1', HIVE_MUX: muxOf(mux), HIVE_MAX_OPEN_FILES: String(CAP), HIVE_EVICT_GRACE_MS: String(graceOf(mux)) })
      : mux === 'auto+proxy' ? cleanEnv({ HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }) : clientEnv({ HOME: home, USERPROFILE: home, HIVE_MUX: mux, NODE_NO_WARNINGS: '1' }),
  })
  t.stderr?.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(`[${name}] ${d}`) })
  const c = new Client({ name: 'latency-' + name, version: '1' })
  await c.connect(t)
  const call = async (tool, args = {}) => (await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120000 })).content.map((x) => x.text).join('\n')
  return { name, dir, call, close: async () => { try { await call('hive_leave') } catch { } try { await c.close() } catch { } } }
}
/** ms until `file` holds exactly `want`, or null if it never does within WAIT_MS. */
async function arrival(file, want, t0) {
  while (Date.now() - t0 < WAIT_MS) {
    try { if (fs.readFileSync(file, 'utf8') === want) return Date.now() - t0 } catch { }
    await sleep(100)
  }
  return null
}

let relay
const results = []
try {
  if (!LIVE) relay = await startRelay()
  const MODES = process.env.LATENCY_MODES ? process.env.LATENCY_MODES.split(',') : (LIVE ? ['1', '0'] : ['1', '0', 'auto+proxy', 'cap+1', 'cap+0', 'capgrace+0'])
  if (MODES.includes('auto+proxy')) proxy = await startProxy(relay.port)
  for (const mux of MODES) {
    const room = `${process.env.LATENCY_ROOM_PREFIX || "latency-"}${mux.replace('+', '-')}-${Date.now()}`
    // auto+proxy: an explicit-proxy machine (no outside DNS) with HIVE_MUX unset, as a real user runs
    const link = LIVE ? `${LIVE}|${room}` : mux === 'auto+proxy' ? `ws://${FAKE}:${relay.port}|${room}` : `ws://127.0.0.1:${relay.port}|${room}`
    const A = await client('A', mux), B = await client('B', mux)
    try {
      const ja = await A.call('hive_join', { link, dir: A.dir, name: 'A', owner: 'test' })
      if (isCap(mux)) {
        // B JOINS A ROOM ALREADY PAST ITS BOUND -- the live case (a 640-file room, 128 per-file).
        // Those files were in the room at join, so B holding only CAP of them is the documented trade.
        for (let i = 1; i <= FILL; i++) fs.writeFileSync(path.join(A.dir, `fill-${i}.txt`), `fill ${i}\n`)
        await sleep(3000)
      }
      const jb = await B.call('hive_join', { link, dir: B.dir, name: 'B', owner: 'test' })
      if (!/^joined/.test(ja) || !/^joined/.test(jb)) throw new Error(`join failed: ${ja.split('\n')[0]} / ${jb.split('\n')[0]}`)
      await sleep(Number(process.env.LATENCY_SETTLE_MS ?? 1500)) // 0 = write the moment both joins return
      if (isCap(mux)) {
        // Let B's working set fill to its bound with the files that were there when it joined.
        const until = Date.now() + 20000
        const onB = () => [...Array(FILL).keys()].filter((i) => fs.existsSync(path.join(B.dir, `fill-${i + 1}.txt`))).length
        while (Date.now() < until && onB() < CAP) await sleep(200)
        console.log(`  (${mux}: ${FILL} files in the room before B joined, ${onB()} on B's disk, bound ${CAP})`)
        T(`B joined a room past its bound and holds at most ${CAP} of its ${FILL} files (the documented trade, unchanged)`, onB() <= CAP, `on B: ${onB()}`)
        await sleep(2000)
      }

      // (1) hive_edit: claim -> edit -> release, the path an agent takes
      const rel1 = `edit-${mux}.txt`, text1 = `created by hive_edit, mux=${mux}\n`
      await A.call('hive_claim', { region: rel1, intent: 'latency test' })
      const t1 = Date.now()
      await A.call('hive_edit', { file: rel1, content: text1, intent: 'latency test' })
      await A.call('hive_release', { region: rel1 })
      const ms1 = await arrival(path.join(B.dir, rel1), text1, t1)
      results.push({ mux, how: 'hive_edit', ms: ms1 })
      T(`${label(mux)}: a new file made with hive_edit reaches the other disk within ${BAR_MS / 1000} s`, ms1 != null && ms1 <= BAR_MS, ms1 == null ? `never arrived in ${WAIT_MS / 1000} s` : `${(ms1 / 1000).toFixed(1)} s`)

      // (2) a plain disk write: a person saving a new file in their editor
      const rel2 = `disk-${mux}.txt`, text2 = `created on disk, mux=${mux}\n`
      const t2 = Date.now()
      fs.writeFileSync(path.join(A.dir, rel2), text2)
      const ms2 = await arrival(path.join(B.dir, rel2), text2, t2)
      results.push({ mux, how: 'disk write', ms: ms2 })
      T(`${label(mux)}: a new file saved on disk reaches the other disk within ${BAR_MS / 1000} s`, ms2 != null && ms2 <= BAR_MS, ms2 == null ? `never arrived in ${WAIT_MS / 1000} s` : `${(ms2 / 1000).toFixed(1)} s`)

      if (isCap(mux)) {
        // (3) a burst: several new files at once (a scaffold, a checkout) all arrive, not just one
        const t3 = Date.now()
        const bulk = [...Array(BULK).keys()].map((i) => [`bulk-${mux.replace('+', '-')}-${i}.txt`, `bulk ${i}\n`])
        for (const [r, t] of bulk) fs.writeFileSync(path.join(A.dir, r), t)
        const ms3 = await Promise.all(bulk.map(([r, t]) => arrival(path.join(B.dir, r), t, t3)))
        const worst = ms3.some((m) => m == null) ? null : Math.max(...ms3)
        results.push({ mux, how: `burst of ${BULK}`, ms: worst })
        T(`${label(mux)}: a burst of ${BULK} new files all reach the other disk within ${BAR_MS / 1000} s`, worst != null && worst <= BAR_MS, worst == null ? `${ms3.filter((m) => m == null).length} of ${BULK} never arrived` : `${(worst / 1000).toFixed(1)} s`)

        // (4) hive_status says how full the working set is
        const st = JSON.parse(await B.call('hive_status'))
        const m = /^(\d+)\/(\d+)/.exec(String(st.workingSet || ''))
        T('hive_status reports workingSet "open/bound"', !!m && Number(m[2]) === CAP, `workingSet=${JSON.stringify(st.workingSet)}`)

        // (5) once the grace window has passed, the set comes back down to the bound by itself
        const until = Date.now() + GRACE + 15000
        let open = m ? Number(m[1]) : null
        while (Date.now() < until) {
          const s2 = JSON.parse(await B.call('hive_status'))
          const m2 = /^(\d+)\//.exec(String(s2.workingSet || ''))
          open = m2 ? Number(m2[1]) : null
          if (open != null && open <= CAP) break
          await sleep(500)
        }
        T(`after the grace the working set is back within the bound (${CAP})`, open != null && open <= CAP, `open=${open}`)

        // (6) a big burst: more new files at once than the headroom over the bound
        const t6 = Date.now()
        const burst = [...Array(BURST).keys()].map((i) => [`burst-${mux.replace('+', '-')}-${i}.txt`, `burst ${i}\n`])
        for (const [r, t] of burst) fs.writeFileSync(path.join(A.dir, r), t)
        const ms6 = await Promise.all(burst.map(([r, t]) => arrival(path.join(B.dir, r), t, t6)))
        const worst6 = ms6.some((m) => m == null) ? null : Math.max(...ms6)
        results.push({ mux, how: `burst of ${BURST}`, ms: worst6 })
        T(`${label(mux)}: a burst of ${BURST} new files all arrive within ${BURST_BAR_MS / 1000} s`, worst6 != null && worst6 <= BURST_BAR_MS, worst6 == null ? `${ms6.filter((m) => m == null).length} of ${BURST} never arrived` : `${(worst6 / 1000).toFixed(1)} s`)

        // (7) a new file deleted while B still has it queued: it must not come back, and nothing waits for it
        const doomed = [...Array(40).keys()].map((i) => `doomed-${mux.replace('+', '-')}-${i}.txt`)
        for (const r of doomed) fs.writeFileSync(path.join(A.dir, r), 'short-lived\n')
        await sleep(150)
        for (const r of doomed) { try { fs.unlinkSync(path.join(A.dir, r)) } catch { } }
        await sleep(8000)
        const back = doomed.filter((r) => fs.existsSync(path.join(B.dir, r)))
        T('new files deleted while queued do not come back on the other disk', back.length === 0, `${back.length} came back: ${back.slice(0, 3).join(', ')}`)
        const st7 = JSON.parse(await B.call('hive_status'))
        T('...and no new file is left waiting', !/new waiting/.test(String(st7.workingSet || '')), `workingSet=${JSON.stringify(st7.workingSet)}`)
      }
    } finally { await A.close(); await B.close() }
  }
} catch (e) {
  fail++
  console.log(`  FAIL harness crashed: ${(e && e.stack) || e}`)
} finally {
  if (relay) relay.kill()
  if (proxy) await proxy.close()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log('\nmeasured (ms to the other disk):', JSON.stringify(results))
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
