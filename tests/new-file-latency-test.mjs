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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-latency-'))
async function client(name, mux) {
  const home = path.join(tmp, `${name}-${mux}-home`), dir = path.join(tmp, `${name}-${mux}-dir`)
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(dir, { recursive: true })
  const t = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'hive-mcp.js')], cwd: ROOT, stderr: 'pipe',
    env: mux === 'auto+proxy' ? cleanEnv({ HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: '1', HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }) : clientEnv({ HOME: home, USERPROFILE: home, HIVE_MUX: mux, NODE_NO_WARNINGS: '1' }),
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
  const MODES = process.env.LATENCY_MODES ? process.env.LATENCY_MODES.split(',') : (LIVE ? ['1', '0'] : ['1', '0', 'auto+proxy'])
  if (MODES.includes('auto+proxy')) proxy = await startProxy(relay.port)
  for (const mux of MODES) {
    const room = `${process.env.LATENCY_ROOM_PREFIX || "latency-"}${mux.replace('+', '-')}-${Date.now()}`
    // auto+proxy: an explicit-proxy machine (no outside DNS) with HIVE_MUX unset, as a real user runs
    const link = LIVE ? `${LIVE}|${room}` : mux === 'auto+proxy' ? `ws://${FAKE}:${relay.port}|${room}` : `ws://127.0.0.1:${relay.port}|${room}`
    const A = await client('A', mux), B = await client('B', mux)
    try {
      const ja = await A.call('hive_join', { link, dir: A.dir, name: 'A', owner: 'test' })
      const jb = await B.call('hive_join', { link, dir: B.dir, name: 'B', owner: 'test' })
      if (!/^joined/.test(ja) || !/^joined/.test(jb)) throw new Error(`join failed: ${ja.split('\n')[0]} / ${jb.split('\n')[0]}`)
      await sleep(Number(process.env.LATENCY_SETTLE_MS ?? 1500)) // 0 = write the moment both joins return

      // (1) hive_edit: claim -> edit -> release, the path an agent takes
      const rel1 = `edit-${mux}.txt`, text1 = `created by hive_edit, mux=${mux}\n`
      await A.call('hive_claim', { region: rel1, intent: 'latency test' })
      const t1 = Date.now()
      await A.call('hive_edit', { file: rel1, content: text1, intent: 'latency test' })
      await A.call('hive_release', { region: rel1 })
      const ms1 = await arrival(path.join(B.dir, rel1), text1, t1)
      results.push({ mux, how: 'hive_edit', ms: ms1 })
      T(`${mux === "auto+proxy" ? "HIVE_MUX unset, behind a proxy" : "HIVE_MUX=" + mux}: a new file made with hive_edit reaches the other disk within ${BAR_MS / 1000} s`, ms1 != null && ms1 <= BAR_MS, ms1 == null ? `never arrived in ${WAIT_MS / 1000} s` : `${(ms1 / 1000).toFixed(1)} s`)

      // (2) a plain disk write: a person saving a new file in their editor
      const rel2 = `disk-${mux}.txt`, text2 = `created on disk, mux=${mux}\n`
      const t2 = Date.now()
      fs.writeFileSync(path.join(A.dir, rel2), text2)
      const ms2 = await arrival(path.join(B.dir, rel2), text2, t2)
      results.push({ mux, how: 'disk write', ms: ms2 })
      T(`${mux === "auto+proxy" ? "HIVE_MUX unset, behind a proxy" : "HIVE_MUX=" + mux}: a new file saved on disk reaches the other disk within ${BAR_MS / 1000} s`, ms2 != null && ms2 <= BAR_MS, ms2 == null ? `never arrived in ${WAIT_MS / 1000} s` : `${(ms2 / 1000).toFixed(1)} s`)
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
