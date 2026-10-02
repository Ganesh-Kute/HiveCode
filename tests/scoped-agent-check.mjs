// tests/scoped-agent-check.mjs
// Verifies scoped outside agent access control against the built dist/relay package.
//
// 1. Unauthenticated connection is refused at the upgrade (HTTP 401)
// 2. Scoped agent writes inside its allowed path (src/stripe/**) -> syncs to owner
// 3. Out-of-scope access (src/core/auth.js) never reaches the agent's disk, and a direct connect to
//    that file's room is refused at the upgrade (HTTP 403)

import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { startSync } from '../sync.js'
import { fileRoom } from '../token.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RELAY_DIR = path.join(ROOT, 'dist', 'relay')
const PORT = 31899
const RELAY_URL = `ws://127.0.0.1:${PORT}`
const ROOM = 'project-alpha'
const SECRET = 'test-stripe-secret-key-123'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
function T(name, ok, note = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `   ${note}` : ''}`)
  if (ok) pass++; else fail++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-scope-check-'))
const dirOwner = path.join(tmp, 'owner')
const dirAgent = path.join(tmp, 'agent')
fs.mkdirSync(dirOwner, { recursive: true })
fs.mkdirSync(dirAgent, { recursive: true })

// Helper to mint token using the CLI
function mintToken({ name, role = 'agent', paths = '' }) {
  const args = ['hive-token.js', '--secret', SECRET, '--name', name, '--room', ROOM, '--role', role]
  if (paths) args.push('--paths', paths)
  const r = spawnSync(process.execPath, args, { cwd: RELAY_DIR, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`mintToken failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

console.log('# Starting built relay from dist/relay with HIVE_AUTH_MODE=required...')
const relayProc = spawn(process.execPath, ['server.js'], {
  cwd: RELAY_DIR,
  env: { ...process.env, PORT: String(PORT), HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_PERSIST_DIR: 'off' },
  stdio: ['ignore', 'pipe', 'pipe']
})

let relayOutput = ''
relayProc.stdout.on('data', (d) => { relayOutput += d.toString() })
relayProc.stderr.on('data', (d) => { relayOutput += d.toString() })

await new Promise((resolve, reject) => {
  const t0 = Date.now()
  const iv = setInterval(() => {
    if (/listening on/i.test(relayOutput)) { clearInterval(iv); resolve() }
    else if (Date.now() - t0 > 10000) { clearInterval(iv); reject(new Error(`Relay start timeout:\n${relayOutput}`)) }
  }, 100)
})

try {
  // ─── 1. UNAUTHENTICATED CONNECTION REFUSED ──────────────────────────────────────────────────
  console.log('\n# 1. Unauthenticated connection is refused')
  // The relay refuses at the HTTP UPGRADE (server.js refuseUpgrade: "401 Unauthorized"), so the
  // socket never opens and there is no WebSocket close code to read: the client sees the status.
  const upgradeStatus = (url) => new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on('open', () => { ws.close(); resolve({ open: true }) })
    ws.on('unexpected-response', (_req, res) => resolve({ open: false, status: res.statusCode, message: res.statusMessage }))
    ws.on('error', (err) => resolve({ open: false, error: err.message }))
    setTimeout(() => resolve({ open: false, timeout: true }), 3000)
  })
  const unauthResult = await upgradeStatus(`${RELAY_URL}/${ROOM}`)
  T('unauthenticated join is refused by the relay with HTTP 401', !unauthResult.open && unauthResult.status === 401, JSON.stringify(unauthResult))

  // ─── 2. SCOPED TOKEN MINTING ───────────────────────────────────────────────────────────────
  console.log('\n# 2. Minting scoped token via hive-token.js CLI')
  const ownerToken = mintToken({ name: 'Owner', role: 'maintainer' })
  const stripeToken = mintToken({ name: 'StripeAgent', role: 'agent', paths: 'src/stripe/**' })
  T('tokens minted via CLI', typeof ownerToken === 'string' && typeof stripeToken === 'string' && ownerToken.split('.').length === 3)

  // Start sync for both
  const ownerSync = startSync({ relay: RELAY_URL, room: ROOM, dir: dirOwner, name: 'Owner', kind: 'human', token: ownerToken, log: () => {} })
  const agentSync = startSync({ relay: RELAY_URL, room: ROOM, dir: dirAgent, name: 'StripeAgent', kind: 'ai', token: stripeToken, log: () => {} })
  await sleep(3000)

  // ─── 3. IN-SCOPE WRITE SUCCEEDS ────────────────────────────────────────────────────────────
  console.log('\n# 3. In-scope write inside src/stripe/** succeeds')
  const stripeFileRel = 'src/stripe/charge.js'
  const stripeFileAgent = path.join(dirAgent, 'src', 'stripe', 'charge.js')
  const stripeFileOwner = path.join(dirOwner, 'src', 'stripe', 'charge.js')
  fs.mkdirSync(path.dirname(stripeFileAgent), { recursive: true })
  fs.writeFileSync(stripeFileAgent, 'export function chargeCustomer(amount) { return { status: "paid", amount }; }\n')

  // Wait for sync to owner
  let ownerGotStripe = false
  for (let i = 0; i < 25; i++) {
    await sleep(200)
    if (fs.existsSync(stripeFileOwner) && fs.readFileSync(stripeFileOwner, 'utf8').includes('chargeCustomer')) {
      ownerGotStripe = true
      break
    }
  }
  T('agent write inside src/stripe/ propagated to owner', ownerGotStripe)

  // ─── 4. OUT-OF-SCOPE ACCESS REFUSED AT THE WIRE ────────────────────────────────────────────
  console.log('\n# 4. Out-of-scope access (src/core/auth.js) is refused at the wire')
  // Owner creates core auth file
  const authFileRel = 'src/core/auth.js'
  const authFileOwner = path.join(dirOwner, 'src', 'core', 'auth.js')
  const authFileAgent = path.join(dirAgent, 'src', 'core', 'auth.js')
  fs.mkdirSync(path.dirname(authFileOwner), { recursive: true })
  fs.writeFileSync(authFileOwner, 'export const JWT_SECRET = "super-secret-key-never-leak";\n')

  await sleep(2500)
  // Agent disk MUST NOT receive src/core/auth.js
  T('agent disk never receives out-of-scope src/core/auth.js', !fs.existsSync(authFileAgent))

  // A direct connect to the out-of-scope file room, with the scoped token, is refused at the upgrade
  // with 403. The reason ("path ... not in scope") goes to the relay's audit log, not the wire; what
  // an AGENT reads is its tool's refusal, asserted in tests/scoped-mcp-check.mjs.
  const outOfScopeRoom = fileRoom(ROOM, authFileRel)
  const directResult = await upgradeStatus(`${RELAY_URL}/${encodeURIComponent(outOfScopeRoom)}?token=${encodeURIComponent(stripeToken)}`)
  T('a direct connect to the out-of-scope file room is refused by the relay with HTTP 403',
    !directResult.open && directResult.status === 403, JSON.stringify(directResult))

  ownerSync.stop()
  agentSync.stop()
} finally {
  relayProc.kill()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== SCOPED OUTSIDE AGENT CHECK: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
