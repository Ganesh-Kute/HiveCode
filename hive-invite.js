#!/usr/bin/env node
// hive-invite — mint a join link for an agent or teammate, scoped to specific
// paths. Reads the room + secret created by `hive-host.js` (.hive-host.json), so
// you don't touch secrets. The access token is baked INTO the link — the invitee
// just pastes it. No settings, no env, no JWT copy-paste.
//
//   node hive-invite.js FrontBot "frontend/**"          # AI agent, frontend only
//   node hive-invite.js FrontBot "frontend/**,!**/*.env" # ...but never .env files
//   node hive-invite.js Reviewer "**" --role reader      # read-only, whole repo
//   node hive-invite.js Bob --kind human --role writer    # a human teammate, full repo
//
// Usage: node hive-invite.js <name> [paths]
//   --role  agent|reader|writer|maintainer   (default agent)
//   --kind  ai|human                          (default ai)
//   --owner <human>   the human who may approve this agent's tasks
//   --ttl   24h|7d|3600 ...                    (default 7d)
//   --room <id> --relay <url> --secret <s>     (override .hive-host.json)

import fs from 'fs'
import crypto from 'crypto'
import { sign } from './token.js'

const pos = []
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i]
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true'
  else pos.push(k)
}

let store = {}
try { store = JSON.parse(fs.readFileSync('.hive-host.json', 'utf8')) } catch { /* none */ }
const secret = args.secret || store.secret || process.env.HIVE_JWT_SECRET
const room = args.room || store.room
const relay = args.relay || store.relay
if (!secret || !room || !relay) {
  console.error('No secured room found. Run `node hive-host.js` first (it creates .hive-host.json).')
  process.exit(1)
}

const name = pos[0]
if (!name) {
  console.error('Usage: node hive-invite.js <name> [paths]\n  e.g.  node hive-invite.js FrontBot "frontend/**"')
  process.exit(1)
}
const pathsArg = pos[1] || args.paths || ''
const paths = pathsArg && pathsArg !== '**' ? pathsArg.split(',').map((s) => s.trim()).filter(Boolean) : undefined
const role = args.role || 'agent'
const kind = args.kind || 'ai'
const ttl = String(args.ttl || '7d')
const m = ttl.match(/^(\d+)([smhd]?)$/)
const ttlSec = m ? Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, '': 1 }[m[2]]) : 7 * 86400

const now = Math.floor(Date.now() / 1000)
const tok = sign({
  iss: 'hivecode', sub: name, name, kind,
  ...(args.owner ? { owner: args.owner } : {}),
  scopes: [{ room, role, ...(paths ? { paths } : {}) }],
  iat: now, exp: now + ttlSec, jti: 'jti-' + crypto.randomBytes(9).toString('base64url'),
}, { secret })

console.error(`invite for "${name}" (${kind}/${role}) — ${paths ? 'scoped to: ' + paths.join(', ') : 'WHOLE repo'}; expires ${new Date((now + ttlSec) * 1000).toISOString()}`)
console.error('paste this link into the extension Join box, or pass to hive_join({ link }):\n')
console.log(`${relay}|${room}|${tok}`)
