// JOIN / EMPTY-DOC CLOBBER — the worst data-loss bug found so far, caught live on
// 18 Sep 2026 during the first real second-shift run. Three agent folders (builder,
// tester, claude) each lost 186 files to 0 bytes within seconds of joining.
//
// WHY IT HAPPENS. A file's NAME and a file's CONTENT live in two different Yjs docs
// on two different WebSocket connections:
//
//   manifest  -> the PARENT doc      (one connection, tiny payload, flushes fast)
//   content   -> the FILE's own doc  (one connection PER FILE, large, flushes slow)
//
// reconcile() sets both in the same pass, but there is no atomicity across two docs.
// A client that joins a 246-file project and dies five seconds later gets all 246
// manifest keys up and only ~60 file bodies. The room is then permanently left
// asserting "these 186 paths exist" while their docs are empty.
//
// Every later joiner believes the manifest. openFile() connects to the empty doc,
// reports synced, and reconcile() reads docText === ''. The "publish ours" branch is
// skipped (manifest.has is true), FIRST-CONTACT ADOPT is skipped (guarded on
// docText !== ''), so it falls through to the merge with no base and writes '' to
// disk. No conflict markers. No chat message. The file is simply gone.
//
// THE RULE THIS TEST LOCKS IN:
//   an empty shared doc is only authoritative if we have some HISTORY for that path.
//   With no ancestor and real bytes on disk, an empty doc means the publisher never
//   finished — so publish ours instead of adopting the emptiness.
//
// Both directions must hold, and they pull against each other:
//   A. manifest entry + empty doc + no ancestor -> local content MUST survive
//   B. a file genuinely emptied by a peer we HAVE synced -> emptiness MUST still land
// A fix that only satisfies A ("never adopt empty") silently breaks real deletions,
// which is why B is here.
//
//   node tests/join-empty-doc-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { startSync } from '../sync.js'

// pid-derived: this suite runs as a room gate, so two agents may run it at the same
// moment. A fixed port means one fails to bind and the gate refuses a handoff for a
// reason that has nothing to do with the code under test.
const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = () => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p)))
}

const relay = await startRelay()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-emptydoc-'))
const room = 'emptydoc-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

const PKG = '{\n  "name": "real-project",\n  "version": "1.0.0"\n}\n'
const APP = 'export function alpha() {\n  return 1\n}\n'
const GONE = 'export function doomed() {\n  return 2\n}\n'

// ── the corrupt room: manifest keys with NO file doc behind them ───────────────────────
// This is exactly what an interrupted join leaves behind. The witness stays connected so
// the relay keeps the room alive for the client under test.
const wdoc = new Y.Doc()
const wprov = new WebsocketProvider(wsUrl, room, wdoc, { WebSocketPolyfill: WebSocket, connect: true })
await new Promise((res) => { const t = setTimeout(res, 4000); wprov.on('sync', (s) => { if (s) { clearTimeout(t); res() } }) })
wdoc.getMap('manifest').set('package.json', 1)
wdoc.getMap('manifest').set('app.js', 1)
await sleep(1500)
T('setup: room asserts 2 paths exist with no content behind them', wdoc.getMap('manifest').size === 2)

// ── the victim: a client whose disk already holds the real files ───────────────────────
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
fs.writeFileSync(path.join(dB, 'package.json'), PKG)
fs.writeFileSync(path.join(dB, 'app.js'), APP)

const B = startSync({ relay: wsUrl, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
await sleep(7000)

// ── A: local content must survive an empty doc it has no history for ───────────────────
const pkgAfter = read(path.join(dB, 'package.json'))
const appAfter = read(path.join(dB, 'app.js'))
T('A1 package.json is NOT zeroed by joining', pkgAfter === PKG)
T('A2 app.js is NOT zeroed by joining', appAfter === APP)
T('A3 nothing was written as an empty file', pkgAfter !== '' && appAfter !== '')

// and the content should now be PUBLISHED, so the next joiner gets real bytes
const dC = path.join(tmp, 'c'); fs.mkdirSync(dC)
const C = startSync({ relay: wsUrl, room, dir: dC, name: 'C', kind: 'ai', log: () => {} })
await sleep(7000)
T('A4 a later joiner receives the real content, not the emptiness', read(path.join(dC, 'package.json')) === PKG)

// ── B: a GENUINE emptying must still propagate ─────────────────────────────────────────
// C authors a file, B receives it (so B now has an ancestor for that path), C empties it.
fs.writeFileSync(path.join(dC, 'gone.js'), GONE)
await sleep(6000)
const bGotIt = read(path.join(dB, 'gone.js'))
T('B1 setup: B synced gone.js, so it HAS history for that path', bGotIt === GONE)

fs.writeFileSync(path.join(dC, 'gone.js'), '')
await sleep(6000)
T('B2 a real emptying still reaches B (the fix did not break deletion)', read(path.join(dB, 'gone.js')) === '')

try { B.stop() } catch {}
try { C.stop() } catch {}
try { wprov.destroy() } catch {}
relay.kill()
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
