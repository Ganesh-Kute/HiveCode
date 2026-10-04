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

let pass = 0, fail = 0
function T(name, ok, note = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `   ${note}` : ''}`)
  if (ok) pass++; else fail++
}

try {
  // Fact 1: Joining with NO token
  console.log('\n# Fact 1: Joining with NO token to required-auth relay')
  const clientUnauth = await mcp('unauth')
  const unauthJoin = await clientUnauth._test.callTool('hive_join', { link: LINK, dir: dirUnauth, name: 'UnauthAgent' })
  const unauthText = (unauthJoin && unauthJoin.content && unauthJoin.content[0] && unauthJoin.content[0].text) || ''
  T('Fact 1 unauth join refused 401', /NOT JOINED -- the relay refused the connection \(401\)/.test(unauthText))
  T('Fact 1 unauth join says "this room needs a token"', /this room needs a token of your own\. Ask the room owner to mint you one\./.test(unauthText))

  // Fact 1b: Joining with bad/expired token
  const badTokenJoin = await clientUnauth._test.callTool('hive_join', { link: LINK, dir: dirUnauth, name: 'BadTokenAgent', token: 'bad.token' })
  const badTokenText = (badTokenJoin && badTokenJoin.content && badTokenJoin.content[0] && badTokenJoin.content[0].text) || ''
  T('Fact 1b bad token says "the relay rejected your token"', /the relay rejected your token\. It may have expired -- ask the room owner for a new invite\./.test(badTokenText))

  // Mint tokens via CLI
  console.log('\n# Minting tokens via hive-token.js CLI (reading $env:HIVE_JWT_SECRET)')
  const ownerToken = mintCli({ name: 'Owner', role: 'maintainer' })
  const stripeToken = mintCli({ name: 'StripeAgent', role: 'agent', paths: 'src/stripe/**' })
  T('Owner token minted', !!ownerToken && ownerToken.length > 20)
  T('Stripe token minted', !!stripeToken && stripeToken.length > 20)

  // Host joins
  const clientOwner = await mcp('owner')
  await clientOwner._test.callTool('hive_join', { link: LINK, dir: dirOwner, name: 'Owner', token: ownerToken })

  // Outside agent joins with scoped token
  console.log('\n# Fact 2: Scoped agent joins and writes inside src/stripe/**')
  const clientStripe = await mcp('stripe')
  const stripeJoin = await clientStripe._test.callTool('hive_join', { link: LINK, dir: dirStripe, name: 'StripeAgent', token: stripeToken })
  const stripeJoinText = (stripeJoin && stripeJoin.content && stripeJoin.content[0] && stripeJoin.content[0].text) || String(stripeJoin)
  T('Fact 2 Stripe agent joined', /^joined/i.test(stripeJoinText))

  // Claim and edit inside src/stripe/charge.js
  const claimStripe = await clientStripe._test.callTool('hive_claim', { region: 'src/stripe/charge.js' })
  const claimStripeText = (claimStripe && claimStripe.content && claimStripe.content[0] && claimStripe.content[0].text) || ''
  T('Fact 2 Claim in-scope succeeds', claimStripeText.includes("claimed src/stripe/charge.js — it's yours."))

  const editStripe = await clientStripe._test.callTool('hive_edit', {
    file: 'src/stripe/charge.js',
    content: 'export function chargeCustomer(amt) { return { ok: true, amt }; }\n',
    intent: 'implement customer charge'
  })
  const editStripeText = (editStripe && editStripe.content && editStripe.content[0] && editStripe.content[0].text) || ''
  T('Fact 2 Edit in-scope succeeds', editStripeText.includes("✓ wrote src/stripe/charge.js through the medium — your intent is signed into its provenance ledger"))

  // Fact 3: Out-of-scope claim and edit (src/core/auth.js)
  console.log('\n# Fact 3: Out-of-scope access (src/core/auth.js)')
  const claimAuth = await clientStripe._test.callTool('hive_claim', { region: 'src/core/auth.js' })
  const claimAuthText = (claimAuth && claimAuth.content && claimAuth.content[0] && claimAuth.content[0].text) || ''
  T('Fact 3 Claim out-of-scope refused', claimAuthText.includes("refusing to claim src/core/auth.js — your access token's scope does not cover src/core/auth.js, so its bytes stay in this folder"))
  T('Fact 3 Claim isError is true', claimAuth.isError === true)

  const editAuth = await clientStripe._test.callTool('hive_edit', {
    file: 'src/core/auth.js',
    content: 'export const HACKED = true;\n',
    intent: 'tamper with core auth'
  })
  const editAuthText = (editAuth && editAuth.content && editAuth.content[0] && editAuth.content[0].text) || ''
  T('Fact 3 Edit out-of-scope refused', editAuthText.includes("refusing to write src/core/auth.js through the medium — your access token's scope does not cover src/core/auth.js, so its bytes stay in this folder"))
  T('Fact 3 Edit isError is true', editAuth.isError === true)

  try { clientOwner._test.getSession().hive.stop() } catch {}
  try { clientStripe._test.getSession().hive.stop() } catch {}
} finally {
  relayProc.kill()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== SCOPED MCP CHECK: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)

