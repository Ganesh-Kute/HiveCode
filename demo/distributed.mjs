#!/usr/bin/env node
/**
 * THE DISTRIBUTED RUN -- N agents, N real OS processes, one relay, one claimed file.
 *
 *   node demo/distributed.mjs                       # 12 peers, local relay, enforcement queue
 *   node demo/distributed.mjs --peers 4             # faster while iterating
 *   node demo/distributed.mjs --enforce off         # the control condition: watch it fail
 *   node demo/distributed.mjs --relay wss://livecode-xoss.onrender.com   # over the real network
 *
 * WHAT THIS ADDS THAT NOTHING ELSE HERE HAS
 *
 * The refusal is already proven (demo-refusal.mjs, 6/6) and the twelve-agent room is already
 * filmed (swarm.mjs). But both run their participants inside ONE node process, and swarm.mjs
 * prints that fact itself: "this whole swarm is ~1 node process". Three claims therefore have
 * never actually been tested, only asserted:
 *
 *   1. SEPARATE PROCESSES. Twelve pids, twelve heaps, twelve sockets. Not twelve functions
 *      in a loop that a reader is invited to take on trust.
 *   2. A CLIENT WITH NO GATE. Every peer here is a plain startSync() client from sync.js,
 *      which has no client-side write gate at all -- that lives in hive-mcp.js. So the illegal
 *      write is genuinely attempted, by code with nothing in it to stop the attempt. This is
 *      the case server.js's own comment calls out as no longer hypothetical: five copies of
 *      hive-mcp.js on one machine, four with no gate in them.
 *   3. CONVERGENCE AT THE EDGES. Every peer's copy is read off ITS OWN DISK at the end and
 *      the hashes compared. Not the relay's copy, not a log line.
 *
 * HOW THE VERDICT IS MEASURED, AND WHY IT IS MEASURED THERE
 *
 * The refusal is read from the HOLDER'S DISK, never from the rogue's report. A rogue that says
 * "my write failed" proves nothing -- it might be wrong, or its local file might have been
 * written while the update was dropped in flight. The only question that matters is whether the
 * claim owner's bytes changed underneath them, so that is the only thing checked.
 *
 * This repo has been bitten repeatedly by checks that measured the wrong quantity: scale=1:1
 * read as a mean when it is a point sample, file existence read as a successful encode, a 0.30s
 * gate used to verify a 0.26s beat, and a cached browser tab read as evidence about a served
 * file. A green run here has to mean the relay held, so nothing softer is accepted.
 *
 * The run also asks the rogue to SENSE the claim before it defects. If the rogue never saw the
 * claim, a clean result would prove only that the message was slow -- and that passes for
 * enforcement while testing nothing. The distinction is printed either way.
 *
 * Exits non-zero if any check fails, so a broken run is obvious immediately.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { sign } from '../token.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PEER_JS = path.join(HERE, 'peer.mjs')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d }
const has = (k) => process.argv.includes(k)

const PEERS = Math.max(2, Number(arg('--peers', '12')))
const REMOTE = arg('--relay', null)
const ENFORCE = arg('--enforce', 'queue')
const FILE = arg('--file', 'routes.js')
// --auth open reproduces a relay that is NOT running HIVE_AUTH_MODE=required, which is what a
// default deployment looks like. It exists to separate two explanations of the same symptom:
// when a remote relay lets the rogue write through, is enforcement switched off there, or does
// the mechanism itself not hold when identities are self-declared? server.js says the gate is
// wired to ENFORCE_CLAIMS alone and can run on an open relay -- this flag checks that claim
// instead of trusting the comment.
const AUTH = arg('--auth', 'required')
const PORT = Number(arg('--port', '1462'))
const KEEP = has('--keep')
// SEATS, and why this is not optional. A relay with no licence runs the FREE tier, and the
// free tier's maxConnsPerRoom is 8 (limits.js: HIVE_FREE_MAX_CONNS_PER_ROOM). Every peer holds
// a base-room socket, so a 12-peer room needs more than a free relay will admit: the first
// run of this script got 8 of 12 connected and the other 4 sat there with no error, because
// admitConnection() refuses at the HTTP upgrade with Q431 and y-websocket just retries in
// silence. HIVE_SEATS grants the pro tier directly with the same per-seat arithmetic a paying
// customer gets (8 conns per seat), which is exactly what swarm.mjs:543 already does.
const SEATS = Number(arg('--seats', String(Math.max(2, Math.ceil((PEERS + 2) / 8)))))
const SECRET = 'dist-' + crypto.randomBytes(6).toString('hex')
const ROOM = 'dist-' + crypto.randomBytes(6).toString('base64url')
// A remote relay on a free tier sleeps and can take the best part of a minute to wake; a local
// one is up in a second. Waiting the long time locally just makes a failed run slow to discover.
const CONNECT_MS = REMOTE ? 90000 : 30000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
const W = 78
const line = (c = '-') => console.log(c.repeat(W))
const act = (who, what) => console.log('\n  ' + who + ' :: ' + what)
const note = (t) => console.log('      ... ' + t)
const hit = (t) => console.log('      >>> ' + t)

let failures = 0
const check = (ok, msg) => { if (!ok) failures++; console.log('\n  [' + (ok ? ' OK ' : 'FAIL') + ']  ' + msg) }

const HOLDER_MARK = 'adaRefundHandler'
const ROGUE_MARK = 'rogueRefundHandler'

// -- relay ---------------------------------------------------------------------------------
function startRelay() {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HIVE_AUTH_MODE: AUTH,            // 'required' verifies tokens; 'open' takes the declared name
      HIVE_JWT_SECRET: SECRET,
      HIVE_JWT_ALG: 'HS256',
      HIVE_SEATS: String(SEATS),       // room capacity; see the SEATS note above
      // queue, not block: both refuse the write, but block DROPS it and queue HOLDS and
      // replays it when the claim clears. A gate that discards work has only moved the data
      // loss, so queue is the mode a customer should run and therefore the one to test.
      HIVE_ENFORCE_CLAIMS: ENFORCE,
      // WITHOUT THIS, --peers 12 QUIETLY TESTS NOTHING. An unlicensed relay caps a room at 8
      // connections (limits.js, free tier) and refuses the rest at the upgrade with a 429 the
      // client cannot see -- y-websocket retries forever, no error. A 12-peer run then has 8
      // peers in the room and 4 dangling, which does not look like a failure, it looks like a
      // quieter room. Sized to the cast so the cap is never what this harness measures.
      HIVE_SEATS: String(Math.max(4, Math.ceil(PEERS / 2))),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  p.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write('[relay] ' + d) })
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not report listening within 15s')), 15000)
    p.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); res(p) } })
    p.on('exit', (c) => { clearTimeout(t); rej(new Error('relay exited with code ' + c)) })
  })
}

// -- peers ---------------------------------------------------------------------------------
// scope room '*' with paths ['**']: startSync opens the base room AND one room per file
// (fileRoom joins them with U+0001), and the relay authorizes each separately. A '*' scope
// matches all of them unambiguously, so a peer that fails to connect fails for a real reason
// rather than because the harness under-scoped its own token.
const mint = (name) => sign({
  iss: 'distributed', sub: name, name, kind: 'ai',
  scopes: [{ room: '*', role: 'agent', paths: ['**'] }],
  iat: now(), exp: now() + 7200, jti: 'd' + name,
}, { secret: SECRET })

let seq = 0
const peers = []

function makePeer(name, role, relay, tmp) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  const p = { name, role, dir, waits: new Map(), connected: false, pid: null }
  p.proc = spawn(process.execPath, [PEER_JS], {
    cwd: HERE,
    env: {
      ...process.env,
      HIVE_RELAY: relay, PEER_ROOM: ROOM, PEER_NAME: name,
      PEER_DIR: dir, PEER_TOKEN: mint(name), PEER_ROLE: role, PEER_FILE: FILE,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  p.proc.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!raw) continue
      let m; try { m = JSON.parse(raw) } catch { continue }
      if (m.pid) p.pid = m.pid
      if (m.ev === 'connected') { p.connected = true; if (p._onConn) p._onConn() }
      if (m.ev === 'error' && m.id == null) console.log('      !   ' + name + ': ' + m.message)
      if (m.id != null && p.waits.has(m.id)) { const r = p.waits.get(m.id); p.waits.delete(m.id); r(m) }
    }
  })
  p.proc.stderr.on('data', (d) => { if (process.env.DEBUG) process.stderr.write('[' + name + '] ' + d) })
  peers.push(p)
  return p
}

const ask = (p, cmd, extra = {}, ms = 25000) => new Promise((res, rej) => {
  const id = ++seq
  const t = setTimeout(() => { p.waits.delete(id); rej(new Error(p.name + ' did not answer ' + cmd + ' within ' + ms + 'ms')) }, ms)
  p.waits.set(id, (m) => { clearTimeout(t); res(m) })
  p.proc.stdin.write(JSON.stringify({ cmd, id, ...extra }) + '\n')
})

const waitConnected = (p, ms) => p.connected ? Promise.resolve(true) : new Promise((res) => {
  const t = setTimeout(() => res(false), ms)
  p._onConn = () => { clearTimeout(t); res(true) }
})

async function shutdown(code) {
  for (const p of peers) { try { await ask(p, 'stop', {}, 3000) } catch { } }
  await sleep(400)
  for (const p of peers) { try { p.proc.kill() } catch { } }
  if (relayProc) { try { relayProc.kill() } catch { } }
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { } }
  else console.log('  peer workdirs kept at ' + tmp + '\n')
  process.exit(code)
}

// -- run -----------------------------------------------------------------------------------
console.log('')
line('=')
console.log('  HIVECODE -- ' + PEERS + ' AGENTS, ' + PEERS + ' PROCESSES, ONE CLAIMED FILE')
line('=')

let relayProc = null
const relay = REMOTE || ('ws://127.0.0.1:' + PORT)
if (!REMOTE) {
  relayProc = await startRelay()
  console.log('\n  relay      local pid ' + relayProc.pid + ' on :' + PORT +
    '   enforcement: ' + ENFORCE.toUpperCase() + '   auth: ' + AUTH)
  console.log('  capacity   ' + SEATS + ' seats = ' + SEATS * 8 + ' conns/room' +
    '   (free tier would cap this room at 8 and silently refuse the rest)')
} else {
  console.log('\n  relay      ' + REMOTE + '   (remote -- its enforcement setting is not ours to read)')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-dist-'))
console.log('  workdirs   ' + tmp + path.sep + '<name>' + path.sep + '   (one per peer, nothing shared)')
console.log('  room       ' + ROOM)
console.log('  file       ' + FILE + '\n')

// Peer 0 holds, peer 1 defects, the rest are real load on the same rooms: every one of them
// syncs the same file and re-renders it to disk, so the refusal has to hold while N-2 other
// clients are pushing awareness and manifest traffic through the relay.
const NAMES = ['Ada', 'Rogue', 'Blake', 'Cleo', 'Dane', 'Esme', 'Finn', 'Gus', 'Hana', 'Iris', 'Jae', 'Kit',
  'Lux', 'Mira', 'Noor', 'Otto', 'Pia', 'Quin', 'Rhys', 'Sol']
const roleOf = (i) => i === 0 ? 'holder' : i === 1 ? 'rogue' : 'bystander'
for (let i = 0; i < PEERS; i++) makePeer(NAMES[i % NAMES.length] + (i >= NAMES.length ? i : ''), roleOf(i), relay, tmp)

const holder = peers[0]
const rogue = peers[1]

console.log('  spawning ' + PEERS + ' peer processes ...')
const connected = await Promise.all(peers.map((p) => waitConnected(p, CONNECT_MS)))
const up = connected.filter(Boolean).length
const pids = [...new Set(peers.map((p) => p.pid).filter(Boolean))]

console.log('')
for (const p of peers) {
  console.log('    pid ' + String(p.pid || '-').padStart(7) + '  ' + p.name.padEnd(7) + ' ' +
    p.role.padEnd(10) + ' ' + (p.connected ? 'connected' : 'NOT CONNECTED'))
}

check(up === PEERS, 'all ' + PEERS + ' peers connected (' + up + '/' + PEERS + ')')
check(pids.length === PEERS, pids.length + ' distinct OS processes, one per agent -- not one process pretending')
if (up < PEERS) {
  // Name the most likely cause instead of leaving a bare count. A refused upgrade is invisible
  // on the client -- the peer simply never syncs -- so a run that stops here with no diagnosis
  // sends the reader to go read limits.js, which is where this script already went once.
  console.log('\n  ' + (PEERS - up) + ' peer(s) never synced. The usual cause is room capacity:')
  console.log('  admitConnection() in limits.js refuses the HTTP upgrade with "Q431 room at')
  console.log('  capacity (N connections)" and y-websocket retries silently, so the client')
  console.log('  shows nothing at all. This run allowed ' + (REMOTE ? 'whatever the remote relay allows' : SEATS * 8 + ' conns/room (' + SEATS + ' seats)') + '.')
  console.log('  Locally: --seats ' + (SEATS + 1) + '.  Remotely: the relay needs HIVE_SEATS set on ITS host.')
  console.log('  DEBUG=1 shows the relay\'s own stderr.\n')
  await shutdown(1)
}
await sleep(2000)

// -- 1. the holder claims and writes -------------------------------------------------------
line()
console.log('  1.  THE OWNER CLAIMS THE FILE AND WRITES TO IT')
line()

act(holder.name, 'claims ' + FILE + ' -- "add the /refund route"')
const claimed = await ask(holder, 'claim', { intent: 'add the /refund route' })
check(claimed.got === true, holder.name + ' holds the claim on ' + FILE)
await sleep(2500)

act(holder.name, 'writes the route')
await ask(holder, 'write', { text: 'app.post("/refund", ' + HOLDER_MARK + ')\n' })
await sleep(4000)

const h1 = await ask(holder, 'read')
check(!!h1.text && h1.text.includes(HOLDER_MARK), "the owner's own write landed on the owner's disk")

// -- 2. the rogue sees the claim and writes anyway ------------------------------------------
line()
console.log('  2.  A CLIENT WITH NO GATE IN IT WRITES TO THE FILE ANYWAY')
line()

const sensed = await ask(rogue, 'sense')
act(rogue.name, 'reads the claim board and sees: ' +
  (sensed.claim ? sensed.claim.by + ' holds it ("' + sensed.claim.intent + '")' : 'NOTHING'))
const sawIt = !!(sensed.claim && sensed.claim.by === holder.name)
check(sawIt, rogue.name + ' could see the claim before defecting -- so a clean result means refused, not merely slow')

act(rogue.name, 'has no client-side gate (plain sync.js) and writes to ' + FILE + ' regardless')
await ask(rogue, 'write', { text: 'app.post("/refund", ' + ROGUE_MARK + ')\n' })
await sleep(5000)

const h2 = await ask(holder, 'read')
const leaked = !!(h2.text && h2.text.includes(ROGUE_MARK))
// Read on the HOLDER's disk. The rogue's own opinion of whether its write succeeded is not
// evidence -- the only thing that matters is whether the claim owner's bytes moved.
if (leaked) hit("the rogue's write REACHED " + FILE + ' on ' + holder.name + "'s disk")
else hit('relay: write to ' + FILE + ' REFUSED -- held by ' + holder.name)
check(!leaked, "the rogue's write never reached the owner's copy (measured on " + holder.name +
  "'s disk, not the rogue's log)")
check(!!h2.text && h2.text.includes(HOLDER_MARK), "and the owner's own content is still intact")

// -- 3. zero loss --------------------------------------------------------------------------
line()
console.log('  3.  AND THE REFUSED WRITE IS NOT THROWN AWAY')
line()

act(holder.name, 'releases ' + FILE)
await ask(holder, 'release')
await sleep(6000)

const h3 = await ask(holder, 'read')
const replayed = !!(h3.text && h3.text.includes(ROGUE_MARK))
if (replayed) note('relay: held write from ' + rogue.name + ' REPLAYED into ' + FILE)
if (ENFORCE === 'queue' && !REMOTE) {
  check(replayed, rogue.name + "'s refused write arrived the moment the file was free -- zero loss, no retry")
} else {
  console.log('\n  [ -- ]  replay not asserted: it is a property of enforce=queue, and this run is ' +
    (REMOTE ? 'against a remote relay' : 'enforce=' + ENFORCE))
}

// -- 4. convergence across every real process ----------------------------------------------
line()
console.log('  4.  EVERY PROCESS ENDS WITH THE SAME BYTES')
line()
await sleep(4000)

const reads = []
for (const p of peers) {
  try { reads.push({ p, r: await ask(p, 'read', {}, 15000) }) }
  catch (e) { reads.push({ p, r: { exists: false, sha: null, err: e.message } }) }
}
const present = reads.filter((x) => x.r && x.r.exists)
const shas = [...new Set(present.map((x) => x.r.sha))]
console.log('')
for (const x of reads) {
  console.log('    ' + x.p.name.padEnd(7) + ' ' + (x.r && x.r.exists
    ? x.r.sha + '  ' + String(x.r.text.length).padStart(4) + ' bytes'
    : 'no file'))
}

check(present.length === PEERS, 'all ' + PEERS + ' peers materialised ' + FILE +
  ' on their own disk (' + present.length + '/' + PEERS + ')')
check(shas.length === 1, shas.length === 1
  ? 'all ' + present.length + ' copies are byte-identical (' + shas[0] + ') -- converged across ' + pids.length + ' processes'
  : 'copies DIVERGED into ' + shas.length + ' distinct versions: ' + shas.join(', '))
const anyMarkers = present.some((x) => x.r.text.includes('<<<<<<<'))
check(!anyMarkers, "no conflict markers left in anyone's copy")

// -- what this run did and did not prove ---------------------------------------------------
console.log('')
line('=')
console.log('  CONDITIONS THIS RUN ACTUALLY MET')
line('=')
const cond = (ok, label, detail) => console.log('   ' +
  (ok === true ? '[yes]' : ok === false ? '[no ]' : '[ ? ]') + '  ' + label.padEnd(34) + ' ' + detail)
cond(pids.length === PEERS, 'separate OS processes', pids.length + ' pids, one per agent')
cond(true, 'no client-side write gate', 'plain sync.js peers; the gate in hive-mcp.js is absent by construction')
cond(!!REMOTE, 'real network', REMOTE
  ? 'over the internet to ' + REMOTE
  : 'loopback only -- no WAN latency, loss or reordering')
cond(REMOTE ? null : ENFORCE !== 'off', 'relay enforcement', REMOTE
  ? "UNKNOWN -- a remote relay's HIVE_ENFORCE_CLAIMS is not readable from here"
  : 'HIVE_ENFORCE_CLAIMS=' + ENFORCE + ' (set by this script)')
cond(false, 'agents doing real work', 'these peers sync and write on command; they call no model')
if (REMOTE) {
  // How to tell the two explanations apart, because the first run against a remote relay hit
  // exactly this and the answer was neither obvious nor a guess. Run the SAME scenario against
  // a local relay built from the current source with auth left open -- the remote's own
  // configuration. If the local run refuses and the remote one does not, the mechanism is fine
  // and the remote is the problem (stale build, or HIVE_ENFORCE_CLAIMS unset on its host).
  console.log('\n   NOTE: a step-2 failure here means enforcement is off on that relay, its build is' +
    '\n         stale, or the mechanism is broken. Discriminate with the local equivalent:' +
    '\n           node demo/distributed.mjs --peers ' + PEERS + ' --auth open --enforce queue' +
    '\n         If the local run refuses and the remote one does not, the mechanism is sound and' +
    '\n         the relay is the variable: either HIVE_ENFORCE_CLAIMS is unset on its host, or it' +
    '\n         is running an older build. Its /health tells you which -- a relay that answers the' +
    '\n         catch-all there predates that route, so it predates whatever else shipped with it.')
}

console.log('')
line('=')
if (failures === 0) console.log('  ' + PEERS + ' processes, one file, one claim. Every refusal came from the relay.')
else console.log('  ' + failures + ' check(s) failed.')
line('=')
console.log('')

await shutdown(failures ? 1 : 0)
