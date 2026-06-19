#!/usr/bin/env node
// hive-token — mint a Hivecode access token (self-host). Sign with a shared
// secret (HS256) or an RSA private key (RS256). Give it to an agent/teammate so
// they can join only the rooms (and, later, paths) you grant, until it expires.
//
// Examples:
//   HIVE_JWT_SECRET=… node hive-token.js \
//     --name FrontendBot --kind ai --owner jeevan \
//     --room room-abc --role agent --paths "src/ui/**,!**/*.env" --ttl 7d
//
//   node hive-token.js --key ./private.pem --name CI --room "acme/*" --role reader --ttl 24h
//
// Flags:
//   --name   display name           --kind  human|ai (default ai)
//   --owner  approving human (agents)
//   --room   room id or pattern ("acme/*", "*"); repeat or comma-separate
//   --role   admin|maintainer|writer|reader|agent (default agent)
//   --paths  comma globs for path scoping (stored now, enforced in a later phase)
//   --ttl    lifetime: 3600, 90m, 24h, 7d (default 24h)
//   --sub    principal id (default = name)   --jti  token id (default random)
//   --secret HS256 secret (else $HIVE_JWT_SECRET)   --key  RSA private key file (RS256)
//   --iss    issuer (default "hivecode")

import fs from 'fs'
import crypto from 'crypto'
import { sign } from './token.js'

function parseArgs(argv) {
  const a = {}
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k.startsWith('--')) { const key = k.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; a[key] = v }
  }
  return a
}
function ttlToSeconds(ttl) {
  if (!ttl) return 24 * 3600
  const m = String(ttl).match(/^(\d+)\s*([smhd]?)$/)
  if (!m) { console.error(`bad --ttl "${ttl}" (use 3600, 90m, 24h, 7d)`); process.exit(1) }
  const n = Number(m[1]); const mult = { s: 1, m: 60, h: 3600, d: 86400, '': 1 }[m[2]]
  return n * mult
}

const a = parseArgs(process.argv)
const name = a.name || a.sub
if (!name) { console.error('need --name (or --sub)'); process.exit(1) }
const rooms = (a.room || '').split(',').map((s) => s.trim()).filter(Boolean)
if (!rooms.length) { console.error('need at least one --room (id, "acme/*", or "*")'); process.exit(1) }

const secret = a.secret || process.env.HIVE_JWT_SECRET || ''
const keyFile = a.key
if (!secret && !keyFile) { console.error('need a signing key: --secret, $HIVE_JWT_SECRET, or --key <private.pem>'); process.exit(1) }

const role = a.role || 'agent'
const paths = a.paths ? a.paths.split(',').map((s) => s.trim()).filter(Boolean) : undefined
const scopes = rooms.map((room) => ({ room, role, ...(paths ? { paths } : {}) }))

const now = Math.floor(Date.now() / 1000)
const payload = {
  iss: a.iss || 'hivecode',
  sub: a.sub || name,
  name,
  kind: a.kind || 'ai',
  ...(a.owner ? { owner: a.owner } : {}),
  scopes,
  iat: now,
  exp: now + ttlToSeconds(a.ttl),
  jti: a.jti || 'jti-' + crypto.randomBytes(9).toString('base64url'),
}

const signWith = keyFile ? { privateKey: fs.readFileSync(keyFile, 'utf8') } : { secret }
const token = sign(payload, signWith)

// Token to stdout (pipeable); human-readable summary to stderr.
process.stderr.write(`minted ${payload.kind} token for "${name}" (jti ${payload.jti})\n  rooms: ${rooms.join(', ')}\n  role:  ${role}${paths ? `\n  paths: ${paths.join(', ')}` : ''}\n  exp:   ${new Date(payload.exp * 1000).toISOString()}\n\n`)
process.stdout.write(token + '\n')
