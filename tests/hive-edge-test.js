// EDGE-CASE / ADVERSARIAL live test. Proves the hardening added after the RBAC
// phases actually holds end-to-end, against a MALICIOUS participant — not just
// in unit isolation:
//
//   1. PATH TRAVERSAL — a peer injects manifest paths like "../escaped.txt" and
//      "/abs.txt"; a victim client must NEVER write them outside its project root.
//   2. BINARY vs TEXT — a text file replaced by a binary while a peer edits it: the
//      binary survives the race, every losing version is kept in .hive-deleted/.
//   3. OUT-OF-SCOPE PUBLISH — a path-scoped agent must not be able to publish a
//      file OUTSIDE its scope (the relay + client both refuse).
//   4. RELAY TRAVERSAL REJECT — the relay refuses a "<base>␁../../etc/x" file-room
//      even for a valid whole-repo token.
//
//   node hive-edge-test.js
//
// Two relays: an OPEN one (1264) for the client-guard tests, a REQUIRED one (1265)
// for the scope/relay tests.

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { startSync } from '../sync.js'
import { sign, fileRoom } from '../token.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }
const now = () => Math.floor(Date.now() / 1000)
const ROOT = path.resolve('.edge-test')
const readBuf = (p) => { try { return fs.readFileSync(p) } catch { return null } }
const readStr = (p) => { const b = readBuf(p); return b === null ? null : b.toString('utf8') }

fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

const OPEN_PORT = 1264, REQ_PORT = 1265
const RELAY_OPEN = `ws://localhost:${OPEN_PORT}`
const RELAY_REQ = `ws://localhost:${REQ_PORT}`
const SECRET = 'edge-secret'

const spawnRelay = (port, env) => spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } })
const waitListen = (proc) => new Promise((res) => proc.stdout.on('data', (d) => /listening on/.test(d) && res()))

const relayOpen = spawnRelay(OPEN_PORT, { HIVE_AUTH_MODE: 'open' })
const relayReq = spawnRelay(REQ_PORT, { HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET })
await Promise.all([waitListen(relayOpen), waitListen(relayReq)])

// raw (un-guarded) join — the "attacker" uses this to bypass the client guards
// and inject straight into the shared CRDT, exactly what a malicious peer could do.
function rawJoin(relay, room) {
  const d = new Y.Doc()
  const p = new WebsocketProvider(relay, room, d, { WebSocketPolyfill: WebSocket, disableBc: true })
  return new Promise((res) => { p.on('sync', (s) => s && res({ d, p })); setTimeout(() => res({ d, p }), 2500) })
}
const openProviders = []

// =====================================================================
console.log('# 1. PATH TRAVERSAL — a malicious peer cannot make a victim write outside its root')
const ROOM1 = 'edge-traversal'
{
  const { d: adoc, p: aprov } = await rawJoin(RELAY_OPEN, ROOM1)
  openProviders.push(aprov)
  const man = adoc.getMap('manifest')
  // seed file-room content for each path (legit + malicious), then register in manifest
  const seed = async (rel, content) => {
    const { d, p } = await rawJoin(RELAY_OPEN, fileRoom(ROOM1, rel))
    d.getText('content').insert(0, content); openProviders.push(p)
  }
  await seed('safe.js', 'console.log("ok")')
  await seed('../escaped.txt', 'PWNED-RELATIVE')
  await seed('nested/../../escaped2.txt', 'PWNED-NESTED')
  adoc.transact(() => { man.set('safe.js', 1); man.set('../escaped.txt', 1); man.set('nested/../../escaped2.txt', 1) })
  await sleep(600)

  const victimDir = path.join(ROOT, 'victim')
  fs.mkdirSync(victimDir, { recursive: true })
  const victim = startSync({ relay: RELAY_OPEN, room: ROOM1, dir: victimDir, name: 'Victim', kind: 'human', log: () => {} })
  await sleep(3500)

  assert('victim received the safe in-root file', readStr(path.join(victimDir, 'safe.js')) !== null)
  assert('"../escaped.txt" was NOT written above the root', readBuf(path.join(ROOT, 'escaped.txt')) === null)
  assert('"nested/../../escaped2.txt" was NOT written above the root', readBuf(path.join(ROOT, 'escaped2.txt')) === null)
  assert('no escaped file landed inside the victim root either', readBuf(path.join(victimDir, 'escaped.txt')) === null)
  victim.stop()
}

// =====================================================================
console.log('\n# 2. BINARY vs TEXT — a binary is shared since 25520fa; neither side may lose bytes')
// This section was written when a binary could not be shared: the guard was "a remote text update
// never overwrites a local binary". That guard still holds, but since binary sync (25520fa, 3 Oct)
// A's binary goes to the room, so a LATER write by someone who has it wins like any later write.
// What must never happen is bytes vanishing. Two cases:
//   2a RACE: A swaps in a binary while B, who has not seen it, edits the text. A's binary must
//      survive, B's text must be kept in B's .hive-deleted/, and both folders end equal.
//   2b LATER WRITE: B has A's binary, then saves text over it. Both end on B's text, and A's
//      binary is kept in A's .hive-deleted/: replaced in the open, never destroyed.
const ROOM2 = 'edge-binary'
const keptCopies = (dir) => {
  const d = path.join(dir, '.hive-deleted')
  try { return fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((p) => fs.statSync(p).isFile()).map((p) => fs.readFileSync(p)) } catch { return [] }
}
{
  const dirA = path.join(ROOT, 'binA'), dirB = path.join(ROOT, 'binB')
  fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })
  const fA = path.join(dirA, 'asset.dat'), fB = path.join(dirB, 'asset.dat')
  fs.writeFileSync(fA, 'TEXTVERSION')
  const A = startSync({ relay: RELAY_OPEN, room: ROOM2, dir: dirA, name: 'A', log: () => {} })
  await sleep(1800)
  const B = startSync({ relay: RELAY_OPEN, room: ROOM2, dir: dirB, name: 'B', log: () => {} })
  await sleep(2800)
  assert('B received asset.dat as text', readStr(fB) === 'TEXTVERSION')
  const binBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff, 0x10])
  // 2a: both writes land before either side can have heard the other's
  fs.writeFileSync(fB, 'TEXT-B-RACE')
  fs.writeFileSync(fA, binBuf)
  await sleep(3000)
  const a1 = readBuf(fA), b1 = readBuf(fB)
  assert('2a A\'s binary survived B\'s concurrent text edit', a1 !== null && a1.equals(binBuf))
  assert('2a both folders end on the same bytes', a1 !== null && b1 !== null && a1.equals(b1))
  assert('2a B\'s text edit is kept in B\'s .hive-deleted/', keptCopies(dirB).some((c) => c.toString() === 'TEXT-B-RACE'))
  // 2b: B has the binary now, and replaces it with text
  fs.writeFileSync(fB, 'TEXT-B-LATER')
  await sleep(3000)
  assert('2b both folders end on B\'s later text', readStr(fA) === 'TEXT-B-LATER' && readStr(fB) === 'TEXT-B-LATER')
  assert('2b A\'s binary is kept in A\'s .hive-deleted/', keptCopies(dirA).some((c) => c.equals(binBuf)))
  A.stop(); B.stop()
}

// =====================================================================
console.log('\n# 3. OUT-OF-SCOPE PUBLISH — a frontend-scoped agent cannot publish a backend file')
const ROOM3 = 'edge-scope'
const mint = (scopes) => sign({ iss: 't', sub: 's', name: 'n', kind: 'ai', scopes, iat: now(), exp: now() + 3600, jti: 'j' + Math.random() }, { secret: SECRET })
{
  const ownerDir = path.join(ROOT, 'sowner'), agentDir = path.join(ROOT, 'sagent')
  fs.mkdirSync(path.join(ownerDir, 'frontend'), { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(ownerDir, 'frontend', 'app.js'), 'export const ui = 1')
  const ownerTok = mint([{ room: ROOM3, role: 'maintainer' }]) // whole repo
  const owner = startSync({ relay: RELAY_REQ, room: ROOM3, dir: ownerDir, name: 'Owner', kind: 'human', token: ownerTok, log: () => {} })
  await sleep(2200)
  const agentTok = mint([{ room: ROOM3, role: 'agent', paths: ['frontend/**'] }])
  const agent = startSync({ relay: RELAY_REQ, room: ROOM3, dir: agentDir, name: 'FrontBot', kind: 'ai', token: agentTok, log: () => {} })
  await sleep(2500)
  // agent tries to create a file OUTSIDE its scope
  fs.mkdirSync(path.join(agentDir, 'backend'), { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'backend', 'evil.js'), 'exfiltrate()')
  await sleep(3000)
  assert('agent got its in-scope file', readStr(path.join(agentDir, 'frontend', 'app.js')) !== null)
  assert('agent\'s out-of-scope file never reached the owner', readStr(path.join(ownerDir, 'backend', 'evil.js')) === null)
  owner.stop(); agent.stop()
}

// =====================================================================
console.log('\n# 4. RELAY TRAVERSAL REJECT — the relay refuses a traversal file-room even with a valid token')
{
  const ROOM4 = 'edge-relay'
  const tok = mint([{ room: ROOM4, role: 'maintainer' }]) // whole repo, no path restriction
  const syncs = (room, ms = 2500) => {
    const d = new Y.Doc()
    const p = new WebsocketProvider(RELAY_REQ, room, d, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token: tok } })
    return new Promise((res) => { let done = false; const fin = (v) => { if (!done) { done = true; try { p.destroy() } catch {} res(v) } }; p.on('sync', (s) => s && fin(true)); setTimeout(() => fin(false), ms) })
  }
  assert('relay admits a normal file-room', await syncs(fileRoom(ROOM4, 'frontend/app.js')))
  assert('relay REJECTS a "../../etc/passwd" file-room', !(await syncs(fileRoom(ROOM4, '../../etc/passwd'))))
  assert('relay REJECTS an absolute-path file-room', !(await syncs(fileRoom(ROOM4, '/etc/shadow'))))
}

// =====================================================================
console.log(`\n=== ${failed === 0 ? 'ALL EDGE-CASE CHECKS PASSED' : failed + ' FAILED'} ===`)
for (const p of openProviders) { try { p.destroy() } catch {} }
relayOpen.kill(); relayReq.kill()
fs.rmSync(ROOT, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
