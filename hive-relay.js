#!/usr/bin/env node
// `npx hivecode-relay` — run the relay yourself, so your team's source never reaches a
// machine you do not own.
//
// WHY THIS EXISTS AS A COMMAND rather than a paragraph in a document.
//
// Self-hosting was already possible and already documented: clone the repo, npm install,
// node server.js. Every one of those steps works. The problem is that the document is an
// untested API surface -- it told you to run a file the npm package does not ship, and the
// three settings that make the relay actually private (persistence, auth, and pointing the
// clients at it) were a table you were trusted to read and get right. A team that reads it
// carelessly ends up with a relay that loses every room overnight, accepts anyone who
// guesses a room id, and has half its members still on the public default. Nothing errors.
//
// So this file does not reimplement anything. It sets the environment server.js already
// reads, starts THAT server, and then prints the exact lines each teammate needs to paste.
// There is exactly one relay implementation and this is not it -- a second copy of the
// relay would drift from the first, and this project has already paid for that lesson once.
//
//   npx hivecode-relay                      private relay on :1234, persistence on
//   npx hivecode-relay --port 8080          somewhere else
//   npx hivecode-relay --secret <s>         auth-required: only holders of a minted token
//   npx hivecode-relay --room my-project    print the join link for a named room
//   npx hivecode-relay --data ./hive-data   where rooms are persisted (default ./hive-data)

import os from 'os'
import path from 'path'
import fs from 'fs'
import http from 'http'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Poll the relay's own /health until it answers. This is the only evidence that the
 *  process below is actually serving, as opposed to having started and then thrown. */
function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve(true)
        retry()
      })
      req.on('error', retry)
      req.setTimeout(1000, () => { req.destroy(); retry() })
    }
    const retry = () => { if (Date.now() > deadline) resolve(false); else setTimeout(tick, 200) }
    tick()
  })
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) return true
  return v
}

const PORT = String(arg('port', process.env.PORT || '1234'))
const DATA = path.resolve(String(arg('data', './hive-data')))
const SECRET = arg('secret', process.env.HIVE_JWT_SECRET || null)
const ROOM = String(arg('room', '') || '')
const SEATS = arg('seats', null)

// PERSISTENCE IS ON BY DEFAULT HERE, and that is the single most important difference
// between this command and `node server.js`.
//
// Without HIVE_PERSIST_DIR a room exists only in the memory of the clients connected to it.
// The day works perfectly; everyone goes home; the last client disconnects and the room is
// gone. Nobody is told. The next morning the folder is empty and the obvious conclusion is
// that the product lost the work -- which it did, because the default was to hold nothing.
// A relay you run for a team must survive the team going to sleep, so the default is on and
// the operator has to go out of their way to turn it off.
if (!process.env.HIVE_PERSIST_DIR) process.env.HIVE_PERSIST_DIR = DATA
fs.mkdirSync(process.env.HIVE_PERSIST_DIR, { recursive: true })

process.env.PORT = PORT
if (SECRET && SECRET !== true) {
  process.env.HIVE_JWT_SECRET = String(SECRET)
  process.env.HIVE_AUTH_MODE = 'required'
}
if (SEATS && SEATS !== true) process.env.HIVE_SEATS = String(SEATS)

// A relay run for a team is not the hosted relay's free tier, and defaulting it to one is
// how five people discover the eighth connection is refused (Q431). Each participant holds
// one base-room socket plus one per open file, so the per-room ceiling is not a headcount.
if (!process.env.HIVE_SEATS && !SEATS) process.env.HIVE_SEATS = '25'

function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' && ni.family !== 4) continue
      if (ni.internal) continue
      out.push(ni.address)
    }
  }
  return out
}

const room = ROOM || 'room-' + crypto.randomBytes(9).toString('base64url')
const lan = lanAddresses()
const host = lan[0] || '127.0.0.1'
const relayUrl = `ws://${host}:${PORT}`

// START THE RELAY FIRST, THEN CLAIM IT IS LISTENING.
//
// The first version of this file printed the banner and then imported server.js. With the
// port already taken it printed a confident "listening on ws://0.0.0.0:1234", a join link
// and setup instructions for the whole team -- and then died of EADDRINUSE three lines
// later. Anyone scrolled past the stack trace would have handed out a link to nothing.
// Announcing a thing before doing it is the defect this project keeps finding in itself,
// and a banner is no more exempt from it than a test is.
// A RELATIVE specifier, deliberately, and it has now been wrong twice in two different ways.
// `import(path.join(HERE, 'server.js'))` throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows,
// because an absolute path is not a URL. `import(pathToFileURL(...).href)` fixes that and is
// then invisible to scripts/build-relay.mjs, which computes the package's file list by
// PARSING imports and refuses to guess at a computed one -- so the published relay shipped
// one file and failed its own smoke test. A relative specifier resolves against this module's
// URL on every platform and is statically readable, which is what both callers need.
await import('./server.js')

const listening = await waitForHealth(`http://127.0.0.1:${PORT}/health`, 15000)
if (!listening) {
  console.error(`\n  !! The relay did not come up on port ${PORT} within 15s.`)
  console.error('     Nothing below would be true, so it is not printed. Check the error above:')
  console.error('     a port already in use is the usual cause — try --port <something-else>.\n')
  process.exit(1)
}

const banner = [
  '',
  '  ┌──────────────────────────────────────────────────────────────────────┐',
  '  │  HIVECODE RELAY — yours                                              │',
  '  └──────────────────────────────────────────────────────────────────────┘',
  '',
  `  listening on   ws://0.0.0.0:${PORT}`,
  `  rooms saved to ${process.env.HIVE_PERSIST_DIR}`,
  `  access         ${process.env.HIVE_AUTH_MODE === 'required'
    ? 'TOKEN REQUIRED (mint with: npx hivecode-token --room <room> --name <who> --ttl 7d)'
    : 'OPEN — anyone who can reach this port and knows a room id can join'}`,
  `  seats          ${process.env.HIVE_SEATS}`,
  '',
  '  ── give these to each teammate ───────────────────────────────────────',
  '',
  `  join link            ${relayUrl}|${room}`,
  '',
  '  VS Code (each human):',
  `    setting  hivecode.relayUrl  =  ${relayUrl}`,
  '',
  '  AI agents (each agent\'s MCP server config, in its "env" block):',
  `    HIVE_RELAY      = ${relayUrl}`,
  `    HIVE_RELAY_PIN  = ${relayUrl}`,
  '',
  '  HIVE_RELAY_PIN is the half people skip, and it is the half that makes this private.',
  '  HIVE_RELAY alone is a default: if a teammate pastes a link from somewhere else, or a',
  '  script forgets the variable, that client falls back to the PUBLIC relay, joins happily,',
  '  and publishes your files there. Every status reads green. The pin makes that a refusal',
  '  (Q550) instead of a silent upload.',
  '',
].join('\n')

if (!lan.length) {
  console.log(banner)
  console.log('  !! No LAN address found — this relay is reachable only from this machine.')
  console.log('     Teammates on other machines cannot connect to 127.0.0.1. Run it on a box')
  console.log('     they can reach, or put it behind a tunnel/reverse proxy.\n')
} else {
  console.log(banner)
}

if (process.env.HIVE_AUTH_MODE !== 'required') {
  console.log('  !! OPEN MODE. Anyone who can reach this port and guesses a room id can read')
  console.log('     and write your files. Fine on a laptop or a private LAN; not fine on a')
  console.log('     public IP. Restart with --secret <a-long-random-string> to require tokens.\n')
}
if (host !== '127.0.0.1') {
  console.log('  !! ws:// is NOT encrypted. On a trusted LAN that is a reasonable choice. Across')
  console.log('     the internet, put TLS in front of this (a reverse proxy that upgrades')
  console.log('     WebSockets) and hand out the wss:// address instead.\n')
}
