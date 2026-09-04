#!/usr/bin/env node
/**
 * ONE PEER, ONE OS PROCESS. Spawned by demo/distributed.mjs; not meant to be run by hand.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * Every multi-agent proof in this repo so far has run its participants INSIDE ONE NODE
 * PROCESS. swarm.mjs says so in its own output ("this whole swarm is ~1 node process"), and
 * demo-refusal.mjs spawns a real relay but keeps its clients in-process -- which is why it has
 * to pass `disableBc: true`, or two clients in one process would sync peer-to-peer through a
 * BroadcastChannel and bypass the write gate while appearing to work.
 *
 * That is a real limitation, not a cosmetic one. A reader who wants to disbelieve the demo
 * says "those aren't twelve agents, they're twelve functions in a loop", and they are not
 * wrong about the mechanism. This file is the answer: each peer is its own process, with its
 * own pid, its own heap, its own socket, and its own directory on disk. Nothing is shared
 * except the relay.
 *
 * AND IT IS DELIBERATELY A DUMB CLIENT.
 *
 * It calls startSync() from sync.js and nothing else. sync.js has NO client-side write gate --
 * the claim layer in hive-coord.js is advisory (claim() reports whether you got it; it does not
 * stop you writing) and the real client gate lives in hive-mcp.js. So a plain startSync peer is
 * already, with no faking required, exactly the thing server.js's own comment warns about:
 *
 *     "the client-side gate in hive-mcp.js is only as strong as the weakest client in the
 *      room, and on 2026-07-29 that stopped being hypothetical -- FIVE copies of hive-mcp.js
 *      were found on one machine, four of them six weeks old with no gate in them at all."
 *
 * A peer here can therefore attempt an illegal write for real. If it lands, the relay did not
 * stop it. There is no harness `if` anywhere in this file to give a false pass.
 *
 * PROTOCOL. sync.js's own logging is silenced, so stdout carries nothing but one JSON object
 * per line for the parent. Commands arrive the same way on stdin. Every reply echoes the
 * request's `id` so the parent can await a specific answer instead of guessing from ordering.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const NAME = process.env.PEER_NAME || 'peer'
const DIR = process.env.PEER_DIR
const ROLE = process.env.PEER_ROLE || 'bystander'
const FILE = process.env.PEER_FILE || 'routes.js'

const emit = (o) => process.stdout.write(JSON.stringify({ name: NAME, pid: process.pid, ...o }) + '\n')

if (!DIR) { emit({ ev: 'error', message: 'PEER_DIR is required' }); process.exit(1) }
fs.mkdirSync(DIR, { recursive: true })

const hive = startSync({
  relay: process.env.HIVE_RELAY,
  room: process.env.PEER_ROOM,
  dir: DIR,
  name: NAME,
  // NEVER 'human'. writeBlockReason() in server.js exempts identity.kind === 'human' from
  // every write gate, and authorize() refuses to honour a self-declared human precisely so a
  // client cannot opt out by saying so. Declaring 'ai' only ever adds restrictions, which is
  // what a test of enforcement needs.
  kind: 'ai',
  token: process.env.PEER_TOKEN || '',
  log: () => { },
})

let synced = false
hive.provider.on('sync', (s) => {
  if (!s || synced) return
  synced = true
  emit({ ev: 'connected', role: ROLE })
})
hive.provider.on('connection-close', () => emit({ ev: 'disconnected' }))

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12)

function handle(m) {
  try {
    if (m.cmd === 'claim') return emit({ ev: 'claim', id: m.id, got: hive.claim(FILE, m.intent || 'edit') })
    if (m.cmd === 'release') { hive.release(FILE); return emit({ ev: 'release', id: m.id }) }
    // Reading the claim board matters for the rogue: it proves the peer COULD SEE the claim and
    // wrote anyway. Without this the run cannot distinguish a defector from a peer that simply
    // never received the claim, and only the first case tests enforcement.
    if (m.cmd === 'sense') {
      const c = hive.senseClaim(FILE)
      return emit({ ev: 'sense', id: m.id, claim: c ? { by: c.by, intent: c.intent } : null })
    }
    if (m.cmd === 'write') {
      fs.writeFileSync(path.join(DIR, FILE), m.text)
      return emit({ ev: 'wrote', id: m.id, bytes: Buffer.byteLength(m.text) })
    }
    // Read from THIS PROCESS'S OWN DISK. The whole point of the run is that convergence is
    // measured at the edges, on the bytes a participant would actually open, not from the
    // relay's copy or from anybody's log line.
    if (m.cmd === 'read') {
      const f = path.join(DIR, FILE)
      const exists = fs.existsSync(f)
      const text = exists ? fs.readFileSync(f, 'utf8') : null
      return emit({ ev: 'read', id: m.id, exists, text, sha: text == null ? null : sha(text) })
    }
    if (m.cmd === 'stop') {
      try { hive.stop() } catch { }
      emit({ ev: 'stopped', id: m.id })
      return setTimeout(() => process.exit(0), 150)
    }
    emit({ ev: 'error', id: m.id, message: 'unknown cmd ' + m.cmd })
  } catch (e) {
    emit({ ev: 'error', id: m.id, cmd: m.cmd, message: e.message })
  }
}

let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line) { try { handle(JSON.parse(line)) } catch (e) { emit({ ev: 'error', message: 'bad command: ' + e.message }) } }
  }
})
process.on('SIGINT', () => { try { hive.stop() } catch { } ; process.exit(0) })
