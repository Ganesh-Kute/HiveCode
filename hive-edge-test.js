// EDGE-CASE / ADVERSARIAL live test. Proves the hardening added after the RBAC
// phases actually holds end-to-end, against a MALICIOUS participant — not just
// in unit isolation:
//
//   1. PATH TRAVERSAL — a peer injects manifest paths like "../escaped.txt" and
//      "/abs.txt"; a victim client must NEVER write them outside its project root.
//   2. BINARY/LARGE CLOBBER — if a tracked text file is replaced locally by a
//      binary, an incoming remote text edit must NOT overwrite (destroy) it.
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
import { startSync } from './sync.js'
import { sign, fileRoom } from './token.js'

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
console.log('\n# 2. BINARY CLOBBER — a remote text edit must not destroy a locally-replaced binary file')
const ROOM2 = 'edge-binary'
{
  const dirA = path.join(ROOT, 'binA'), dirB = path.join(ROOT, 'binB')
  fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })
  fs.writeFileSync(path.join(dirA, 'asset.dat'), 'TEXTVERSION')
  const A = startSync({ relay: RELAY_OPEN, room: ROOM2, dir: dirA, name: 'A', log: () => {} })
  await sleep(1800)
  const B = startSync({ relay: RELAY_OPEN, room: ROOM2, dir: dirB, name: 'B', log: () => {} })
  await sleep(2800)
  assert('B received asset.dat as text', readStr(path.join(dirB, 'asset.dat')) === 'TEXTVERSION')
  // A replaces its local copy with a BINARY file (contains NUL bytes)
  const binBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff, 0x10])
  fs.writeFileSync(path.join(dirA, 'asset.dat'), binBuf)
  await sleep(2000)
  // B edits the text version -> a remote update lands on A's file-doc
  fs.writeFileSync(path.join(dirB, 'asset.dat'), 'TEXTVERSION2')
  await sleep(3000)
  const aNow = readBuf(path.join(dirA, 'asset.dat'))
  assert('A\'s binary file was NOT clobbered by the remote text edit', aNow !== null && aNow.includes(0))
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
