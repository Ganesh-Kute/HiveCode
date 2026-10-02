// tests/scoped-mcp-check.mjs
// Runs the exact MCP tool calls (hive_join, hive_claim, hive_edit) for the scoped outside agent scenario
// against the built dist/relay with HIVE_AUTH_MODE=required.

import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const RELAY_DIR = path.join(ROOT, 'dist', 'relay')
const PORT = 31922
const RELAY_URL = `ws://127.0.0.1:${PORT}`
const ROOM = 'project-alpha'
const SECRET = 'stripe-jwt-secret-key-42'
const LINK = `${RELAY_URL}|${ROOM}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-scoped-mcp-'))
const dirOwner = path.join(tmp, 'owner')
const dirUnauth = path.join(tmp, 'unauth')
const dirStripe = path.join(tmp, 'stripe')
fs.mkdirSync(dirOwner, { recursive: true })
fs.mkdirSync(dirUnauth, { recursive: true })
fs.mkdirSync(dirStripe, { recursive: true })

// Helper to mint tokens using dist/relay/hive-token.js CLI without passing secret on command line
function mintCli({ name, role = 'agent', paths = '' }) {
  const args = ['hive-token.js', '--name', name, '--room', ROOM, '--role', role]
  if (paths) args.push('--paths', paths)
  const env = { ...process.env, HIVE_JWT_SECRET: SECRET }
  const r = spawnSync(process.execPath, args, { cwd: RELAY_DIR, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`mintCli failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

console.log('# 1. Starting relay from dist/relay with HIVE_AUTH_MODE=required...')
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

const url = (f, q = '') => `file:///${ROOT.replace(/\\/g, '/')}/${f}${q}`
const mcp = (tag) => import(url('hive-mcp.js', `?${tag}`))

const results = {}

try {
  // Fact 1: Joining with NO token
  console.log('\n# Fact 1: Joining with NO token to required-auth relay')
  const clientUnauth = await mcp('unauth')
  const unauthJoin = await clientUnauth._test.callTool('hive_join', { link: LINK, dir: dirUnauth, name: 'UnauthAgent' })
  results.unauthJoin = unauthJoin
  console.log('Unauth Join Result:\n', JSON.stringify(unauthJoin, null, 2))

  // Mint tokens via CLI
  console.log('\n# Minting tokens via hive-token.js CLI (reading $env:HIVE_JWT_SECRET)')
  const ownerToken = mintCli({ name: 'Owner', role: 'maintainer' })
  const stripeToken = mintCli({ name: 'StripeAgent', role: 'agent', paths: 'src/stripe/**' })
  console.log('Stripe token minted:', stripeToken.slice(0, 30) + '...')

  // Host joins
  const clientOwner = await mcp('owner')
  await clientOwner._test.callTool('hive_join', { link: LINK, dir: dirOwner, name: 'Owner', token: ownerToken })

  // Outside agent joins with scoped token
  console.log('\n# Fact 2: Scoped agent joins and writes inside src/stripe/**')
  const clientStripe = await mcp('stripe')
  const stripeJoin = await clientStripe._test.callTool('hive_join', { link: LINK, dir: dirStripe, name: 'StripeAgent', token: stripeToken })
  console.log('Stripe join status: ok')

  // Claim and edit inside src/stripe/charge.js
  const claimStripe = await clientStripe._test.callTool('hive_claim', { region: 'src/stripe/charge.js' })
  results.claimStripe = claimStripe
  console.log('Claim in-scope (src/stripe/charge.js):\n', JSON.stringify(claimStripe, null, 2))

  const editStripe = await clientStripe._test.callTool('hive_edit', {
    file: 'src/stripe/charge.js',
    content: 'export function chargeCustomer(amt) { return { ok: true, amt }; }\n',
    intent: 'implement customer charge'
  })
  results.editStripe = editStripe
  console.log('Edit in-scope (src/stripe/charge.js):\n', JSON.stringify(editStripe, null, 2))

  // Fact 3: Out-of-scope claim and edit (src/core/auth.js)
  console.log('\n# Fact 3: Out-of-scope access (src/core/auth.js)')
  const claimAuth = await clientStripe._test.callTool('hive_claim', { region: 'src/core/auth.js' })
  results.claimAuth = claimAuth
  console.log('Claim out-of-scope (src/core/auth.js):\n', JSON.stringify(claimAuth, null, 2))

  const editAuth = await clientStripe._test.callTool('hive_edit', {
    file: 'src/core/auth.js',
    content: 'export const HACKED = true;\n',
    intent: 'tamper with core auth'
  })
  results.editAuth = editAuth
  console.log('Edit out-of-scope (src/core/auth.js):\n', JSON.stringify(editAuth, null, 2))

  try { clientOwner._test.getSession().hive.stop() } catch {}
  try { clientStripe._test.getSession().hive.stop() } catch {}
} finally {
  relayProc.kill()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

fs.writeFileSync(path.join(ROOT, 'tests', 'scoped-results.json'), JSON.stringify(results, null, 2))
console.log('\n=== SCOPED CHECK COMPLETED AND RECORDED ===')
