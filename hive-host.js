#!/usr/bin/env node
// hive-host — ONE command to host a SECURED Hivecode room.
//
//   node hive-host.js
//
// It does everything that used to take ~10 manual steps:
//   1. generates a signing secret once (saved to .hive-host.json — gitignored),
//   2. starts the relay in auth-required mode (so path scoping is ENFORCED),
//   3. prints YOUR join link with a full-access owner token baked in.
//
// Then, in another terminal, invite scoped agents/teammates with one command:
//   node hive-invite.js FrontBot "frontend/**"
//
// Everyone just PASTES a link — no secret to copy, no env vars, no settings.
//
// Flags (all optional):
//   --port <n>    relay port (default 1234)
//   --name <s>    your display name (default "Owner")
//   --host <ip>   address to put in the link (default: your LAN IP, so a second
//                 laptop on the same wi-fi can join; use "localhost" for one machine)
//   --relay <url> point links at an existing relay you secured with the same secret
//   --room <id>   reuse a specific room id

import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { sign } from './token.js'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i]
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true'
}

const STORE = '.hive-host.json'
let store = {}
try { store = JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch { /* first run */ }

const secret = store.secret || crypto.randomBytes(32).toString('hex')
const room = args.room || store.room || 'room-' + crypto.randomBytes(9).toString('base64url')
const port = Number(args.port || store.port || process.env.PORT || 1234)

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) if (i.family === 'IPv4' && !i.internal) return i.address
  }
  return 'localhost'
}
const host = args.host || lanIP()
const relay = args.relay || `ws://${host}:${port}`

// persist so hive-invite.js mints links for the SAME room/secret/relay
fs.writeFileSync(STORE, JSON.stringify({ secret, room, port, relay }, null, 2))

const now = Math.floor(Date.now() / 1000)
const ownerName = args.name || 'Owner'
const ownerTok = sign({
  iss: 'hivecode', sub: ownerName, name: ownerName, kind: 'human',
  scopes: [{ room, role: 'maintainer' }], // no paths = the WHOLE repo
  iat: now, exp: now + 7 * 86400, jti: 'jti-' + crypto.randomBytes(9).toString('base64url'),
}, { secret })

// start the relay in-process, auth REQUIRED (env is read by server.js at import)
process.env.HIVE_AUTH_MODE = 'required'
process.env.HIVE_JWT_SECRET = secret
process.env.PORT = String(port)
if (!process.env.HIVE_AUDIT_FILE) process.env.HIVE_AUDIT_FILE = './hive-audit.log'
await import('./server.js')

const line = '═'.repeat(52)
console.log(`\n${line}\n  Hivecode secured room is LIVE  (auth: required)\n${line}`)
console.log(`  room:   ${room}`)
console.log(`  relay:  ${relay}`)
console.log(`  audit:  ${process.env.HIVE_AUDIT_FILE}   (watch admits/rejects here)`)
console.log(`\n  YOUR join link (full access) — paste into the extension's Join box,`)
console.log(`  or pass to the MCP hive_join({ link }):\n`)
console.log(`    ${relay}|${room}|${ownerTok}\n`)
console.log(`  Invite a scoped agent (another terminal):`)
console.log(`    node hive-invite.js FrontBot "frontend/**"`)
console.log(`    node hive-invite.js Reviewer "**" --role reader   # read-only\n`)
console.log(`  (Ctrl+C to stop the room.)\n`)
