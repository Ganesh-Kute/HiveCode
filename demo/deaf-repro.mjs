#!/usr/bin/env node
/**
 * THE DEAF-PANEL BUG, ISOLATED.
 *
 *   node demo/deaf-repro.mjs
 *   node demo/deaf-repro.mjs --agents 12 --enforce off --auth open
 *
 * THE SYMPTOM, as measured on the real take and recorded in public/control.html:
 * after the control panel posts its FIRST message it stops receiving other participants'
 * updates. 12 node clients posted 96 messages; with the human silent the page held 108 of
 * 108, and with the human sending one line it held 13 and never grew. Throughout,
 * provider.wsconnected and provider.synced stayed true, wsUnsuccessfulReconnects stayed 0,
 * and the doc clientID never changed -- the socket looks perfectly healthy while the relay
 * has stopped sending.
 *
 * control.html ships a MITIGATION for this (resyncAfterWrite: disconnect, reconnect 250ms
 * later, let sync step1 pull back whatever was missed). It works, and it is not a fix. The
 * comment there says the real bug is in the relay's per-connection bookkeeping, and nobody
 * has gone and found it.
 *
 * This is the smallest thing that can tell us. One "panel" client and N "agent" clients on
 * the SAME base room -- which is what the panel actually watches; chat, members, tasks and
 * the board all live in the base doc, not in any file room. The agents post in three phases
 * and we count what the panel received in each:
 *
 *   PHASE A   agents post, panel silent          -> baseline: the panel is receiving
 *   PHASE B   the panel posts ONE message
 *   PHASE C   agents post again                  -> did the panel go deaf?
 *
 * A pass means C is received as fully as A. Anything less reproduces the bug, and then the
 * flags below bisect it: --enforce off/queue, --auth open/required, --no-usage-limits.
 *
 * Every client is in THIS process but every one of them has `disableBc: true`, so nothing
 * syncs peer-to-peer through a BroadcastChannel and every byte goes through the relay. Skip
 * that and the panel would keep receiving via BC and the run would print a green pass while
 * testing nothing.
 */
import { spawn } from 'child_process'
import crypto from 'crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { sign } from '../token.js'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const has = (k) => process.argv.includes(k)

const AGENTS = Number(arg('--agents', '6'))
const BURST = Number(arg('--burst', '20'))
const ENFORCE = arg('--enforce', 'off')
const AUTH = arg('--auth', 'open')
const PORT = Number(arg('--port', '1471'))
const SECRET = 'deaf-' + crypto.randomBytes(6).toString('hex')
const ROOM = 'deaf-' + crypto.randomBytes(6).toString('base64url')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
const line = (c = '-') => console.log(c.repeat(78))

let failures = 0
const check = (ok, msg) => { if (!ok) failures++; console.log('\n  [' + (ok ? ' OK ' : 'FAIL') + ']  ' + msg) }

function startRelay() {
  const env = { ...process.env, PORT: String(PORT), HIVE_ENFORCE_CLAIMS: ENFORCE }
  // THE CAP IS A CONFOUND AND IT COST THIS INVESTIGATION AN HOUR. The free tier allows 8
  // connections per room, and a refused upgrade is INVISIBLE to the client -- y-websocket
  // retries forever with no error. At 12 agents + 1 panel, five clients silently never
  // joined, so their messages were never posted; the panel then "received 25 of 40" both
  // before AND after it spoke, which reads exactly like the deafness bug and is not it.
  // Sized to the cast by default so the cap can never masquerade as the thing under test;
  // pass --cap 8 to study the cap itself.
  env.HIVE_FREE_MAX_CONNS_PER_ROOM = arg('--cap', String((AGENTS + 1) * 4))
  if (AUTH === 'required') { env.HIVE_AUTH_MODE = 'required'; env.HIVE_JWT_SECRET = SECRET; env.HIVE_JWT_ALG = 'HS256' }
  if (has('--no-usage-limits')) { env.HIVE_MSGS_PER_SEC = '100000'; env.HIVE_BYTES_PER_SEC = String(1 << 30) }
  const p = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write('[relay] ' + d) })
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay never reported listening')), 15000)
    p.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); res(p) } })
    p.on('exit', (c) => { clearTimeout(t); rej(new Error('relay exited ' + c)) })
  })
}

const mint = (name, kind) => sign({
  iss: 'deaf-repro', sub: name, name, kind,
  scopes: [{ room: '*', role: 'agent', paths: ['**'] }],
  iat: now(), exp: now() + 3600, jti: 'j' + name,
}, { secret: SECRET })

// kind matters: writeBlockReason() exempts identity.kind === 'human' from the write gate, and
// on an open relay authorize() refuses to honour a self-declared human (it becomes 'unknown').
// The panel declares human, so if the bug were gate-related it would show up as a difference
// between these two -- worth being able to see rather than assume.
function client(name, kind) {
  const doc = new Y.Doc()
  const opts = { WebSocketPolyfill: WebSocket, disableBc: true }
  if (AUTH === 'required') opts.params = { token: mint(name, kind) }
  const provider = new WebsocketProvider('ws://127.0.0.1:' + PORT, ROOM, doc, opts)
  provider.awareness.setLocalStateField('user', { name, kind, v: 2 })
  const chat = doc.getArray('chat')
  return { name, kind, doc, provider, chat, post: (t) => chat.push([{ by: name, kind, at: new Date().toISOString(), text: t }]) }
}

const synced = (c, ms = 15000) => new Promise((res) => {
  if (c.provider.synced) return res(true)
  const t = setTimeout(() => res(false), ms)
  c.provider.on('sync', (s) => { if (s) { clearTimeout(t); res(true) } })
})

console.log('')
line('=')
console.log('  DEAF PANEL -- does the panel stop receiving after it speaks?')
line('=')
console.log('\n  relay      local :' + PORT + '   enforce=' + ENFORCE + '   auth=' + AUTH)
console.log('  room       ' + ROOM)
console.log('  cast       1 panel (kind=human) + ' + AGENTS + ' agents (kind=ai), all disableBc\n')

const relay = await startRelay()

const panel = client('Panel', 'human')
const agents = Array.from({ length: AGENTS }, (_, i) => client('A' + (i + 1), 'ai'))
const all = [panel, ...agents]
const up = (await Promise.all(all.map((c) => synced(c)))).filter(Boolean).length
check(up === all.length, 'all ' + all.length + ' clients synced (' + up + '/' + all.length + ')')
// ABORT rather than measure. A run missing clients produces a deficit that looks exactly
// like the bug under test, and reporting it as a reproduction would be worse than no test
// at all -- it would send whoever reads it hunting a relay bookkeeping bug that isn't there.
if (up !== all.length) {
  console.log('\n  ' + (all.length - up) + ' client(s) never joined, so their messages were never sent.')
  console.log('  Any deficit measured now would be theirs, not the panel\'s. Refusing to measure.\n')
  for (const c of all) { try { c.provider.destroy() } catch {} }
  try { relay.kill() } catch {}
  process.exit(1)
}
await sleep(1500)

const seen = () => panel.chat.length
const post = async (n, tag) => {
  for (let i = 0; i < n; i++) { agents[i % agents.length].post(tag + ' ' + (i + 1)); await sleep(60) }
  await sleep(3500)
}

// ---- PHASE A: panel silent ------------------------------------------------------------
line()
console.log('  PHASE A -- ' + BURST + ' agent messages, panel SILENT')
line()
const a0 = seen()
await post(BURST, 'A')
const gotA = seen() - a0
console.log('\n    panel received ' + gotA + ' of ' + BURST)
check(gotA === BURST, 'baseline: a silent panel receives everything')

// ---- PHASE B: the panel speaks once ---------------------------------------------------
line()
console.log('  PHASE B -- the panel posts ONE message')
line()
panel.post('hello from the human')
await sleep(2500)
console.log('\n    socket still looks healthy: wsconnected=' + panel.provider.wsconnected +
  '  synced=' + panel.provider.synced + '  reconnects=' + panel.provider.wsUnsuccessfulReconnects)

// ---- PHASE C: agents post again -------------------------------------------------------
line()
console.log('  PHASE C -- ' + BURST + ' more agent messages, AFTER the panel spoke')
line()
const c0 = seen()
await post(BURST, 'C')
const gotC = seen() - c0
console.log('\n    panel received ' + gotC + ' of ' + BURST)

// Compare against another AGENT that also spoke, to separate "spoke" from "is the panel".
const witness = agents[0]
console.log('    (witness agent A1, which also posts, holds ' + witness.chat.length + ' total)')

check(gotC === BURST, 'a panel that has spoken still receives everything')
check(panel.chat.length === witness.chat.length,
  'panel and witness agree on the room (' + panel.chat.length + ' vs ' + witness.chat.length + ')')

// ---- PHASE D: the mitigation, in a room that is AT the cap -----------------------------
// control.html calls resyncAfterWrite() on every human message: disconnect, reconnect 250ms
// later. That is safe in an empty room and it is a trap in a full one -- the reconnect has to
// pass admitConnection() again, and if the room is at its cap the upgrade is refused with no
// error the client can see. The panel then retries forever, silently, and never receives
// another message: precisely "it goes deaf the moment you speak". Whether the freed slot is
// returned before the reconnect arrives is a race, so this measures it rather than reasoning
// about it.
line()
console.log('  PHASE D -- resyncAfterWrite() (disconnect + reconnect) in a room at its cap')
line()
const CAP_D = all.length                                  // exactly full: every client counts
console.log('\n    room holds ' + all.length + ' connections; testing a reconnect at cap ' + CAP_D)
panel.provider.disconnect()
await sleep(250)                                          // the same 250ms control.html waits
panel.provider.connect()
const back = await new Promise((res) => {
  const t = setTimeout(() => res(false), 12000)
  const f = (s) => { if (s) { clearTimeout(t); res(true) } }
  panel.provider.on('sync', f)
  if (panel.provider.synced) { clearTimeout(t); res(true) }
})
console.log('    rejoined: ' + back + '   wsconnected=' + panel.provider.wsconnected +
  '   reconnects=' + panel.provider.wsUnsuccessfulReconnects)
const d0 = panel.chat.length
await post(5, 'D')
const gotD = panel.chat.length - d0
console.log('    panel received ' + gotD + ' of 5 after the resync')
check(back && gotD === 5, 'the panel gets back in after resyncAfterWrite() and keeps receiving')

line('=')
if (failures === 0) {
  console.log('  NOT REPRODUCED at ' + AGENTS + ' agents / enforce=' + ENFORCE + ' / auth=' + AUTH + '.')
  console.log('  Try more load: --agents 12 --burst 40')
} else {
  console.log('  REPRODUCED: A=' + gotA + '/' + BURST + '  C=' + gotC + '/' + BURST +
    '  -- the panel went deaf after speaking.')
}
line('=')
console.log('')

for (const c of all) { try { c.provider.destroy() } catch {} }
try { relay.kill() } catch {}
process.exit(failures ? 1 : 0)
