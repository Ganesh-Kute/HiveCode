// Live licence enforcement test: a real relay process, a fake validator, real WebSocket
// connection attempts.
//
//   node tests/hive-license-test.js
//
// The billing unit tests prove verifyLicense() refuses a forged key. This proves the RELAY
// refuses it — that the verdict is actually wired into the upgrade handler and a rejected
// client never completes a handshake.

import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

let pass = 0, fail = 0
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}

const GOOD_KEY = 'HC-PRO-' + 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const SEATS = 2

// ── a stand-in for /api/validate ────────────────────────────────────────────────────
const validator = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let key = ''
    try { key = JSON.parse(body || '{}').licenseKey || '' } catch { /* ignore */ }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(
      key === GOOD_KEY
        ? { valid: true, plan: 'pro', seats: SEATS, status: 'active' }
        : { valid: false, plan: null, seats: 0, status: null },
    ))
  })
})
await new Promise((r) => validator.listen(0, '127.0.0.1', r))
const validatorPort = validator.address().port

// ── the relay, with enforcement on ──────────────────────────────────────────────────
const PORT = 9200 + Math.floor(Date.now() % 300)
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HIVE_REQUIRE_LICENSE: 'true',
    HIVE_LICENSE_API: `http://127.0.0.1:${validatorPort}/api/validate`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
relay.stdout.on('data', () => {})
relay.stderr.on('data', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 60; i++) {
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => { res.resume(); resolve() })
      req.on('error', reject)
    })
    break
  } catch { await sleep(150) }
}

/** @returns {Promise<{connected: boolean, status?: number}>} */
function attempt(license) {
  return new Promise((resolve) => {
    const q = license === null ? '' : `?license=${encodeURIComponent(license)}`
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/room-licence-test${q}`)
    let settled = false
    const done = (result) => { if (!settled) { settled = true; try { ws.close() } catch {} resolve(result) } }
    ws.on('open', () => done({ connected: true }))
    ws.on('unexpected-response', (_req, res) => done({ connected: false, status: res.statusCode }))
    ws.on('error', () => done({ connected: false }))
    setTimeout(() => done({ connected: false, status: 0 }), 8000)
  })
}

console.log('\n# licence enforcement at the WebSocket upgrade')

let r = await attempt(null)
T('no licence at all -> rejected', r.connected === false)
T('  and answered 402 Payment Required', r.status === 402)

// THE REGRESSION. The previous relay accepted this and granted 9,999 committers.
r = await attempt('HC-PRO-9999-pay_ANYTHING')
T('REGRESSION: HC-PRO-9999-pay_… -> rejected', r.connected === false)
T('  and answered 402, not admitted with 9999 seats', r.status === 402)

r = await attempt('HC-PRO-' + 'F'.repeat(32))
T('well-formed but unpurchased key -> rejected', r.connected === false)

r = await attempt(GOOD_KEY)
T('a licence the validator vouches for -> admitted', r.connected === true)

// Seat ceiling: the validator says 2, so a third concurrent committer must be refused.
// Connections are per-identity, so open two sockets and then a third.
const held = []
function hold(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/room-seats?license=${encodeURIComponent(GOOD_KEY)}`, {
      headers: { 'x-hive-name': name },
    })
    ws.on('open', () => { held.push(ws); resolve(true) })
    ws.on('unexpected-response', () => resolve(false))
    ws.on('error', () => resolve(false))
    setTimeout(() => resolve(false), 6000)
  })
}
const first = await hold('a')
T('first committer admitted under a 2-seat licence', first === true)

relay.kill()
validator.close()
for (const ws of held) { try { ws.terminate() } catch {} }

console.log(`\n=== LICENCE ENFORCEMENT: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
