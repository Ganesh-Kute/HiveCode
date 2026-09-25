// A REFUSED FILE-ROOM MUST BE VISIBLE.
//
// y-websocket retries a failed upgrade forever, with backoff, in silence. That is correct for
// a flaky network and badly wrong for a relay that is full. On 18 Sep 2026 a relay answered
// 38,011 connections with Q430 and the agents involved showed no symptom whatsoever: their
// files simply never arrived. An unsynced file-doc reads as EMPTY, and that is how the same
// evening ended with 186 files written to 0 bytes in three folders.
//
// The information existed -- it was in the relay's log and in a connections count nobody was
// comparing. Nothing carried it to the one process that could act on it.
//
// What is asserted here:
//   A. status() reports the files whose sockets were refused, distinctly from "not synced yet"
//   B. the client SAYS SO once, naming the likely cause, rather than retrying quietly
//   C. no false alarm on a healthy relay -- this must not cry wolf, or it will be ignored
//
//   node tests/refused-visible-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'
// PINNED TO THE PER-FILE TRANSPORT (HIVE_MUX=0). What this suite measures is the arithmetic of one
// socket PER FILE, which the VS Code extension, the browser panel and every older relay still
// speak. A client on one-socket mode holds 2 sockets whatever its file count; its own ceilings
// and refusals are asserted in tests/mux-test.mjs.
process.env.HIVE_MUX = '0'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

const startRelay = (port, env) => new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-refused-'))
const FILES = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']

function workdir(label) {
  const d = path.join(tmp, label); fs.mkdirSync(d, { recursive: true })
  for (const f of FILES) fs.writeFileSync(path.join(d, f), `export const n = '${f}'\n`)
  return d
}

// ── A + B: a relay too small to take the files ─────────────────────────────────────────
// Two connections total: enough for the room itself and one file, so the rest are refused.
// pid-derived: this suite runs as a room gate, so two agents may run it at the same
// moment. A fixed port means one fails to bind and the gate refuses a handoff for a
// reason that has nothing to do with the code under test.
const PORT_FULL = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const full = await startRelay(PORT_FULL, { HIVE_MAX_CONNS_TOTAL: '2' })
const logsFull = []
const dFull = workdir('full')
const S1 = startSync({
  relay: `ws://localhost:${PORT_FULL}`, room: 'full-' + crypto.randomBytes(4).toString('hex'),
  dir: dFull, name: 'Stuck', kind: 'ai', log: (m) => logsFull.push(String(m)),
})
await sleep(14000) // the warning is debounced ~4s, and the provider needs a few attempts

const st = S1.status()
console.log(`\n  status: connected=${st.connected} files=${st.files} synced=${st.filesSynced} notSyncing=${st.notSyncing}`)

T('A1 status reports files whose sockets were refused', st.notSyncing > 0)
T('A2 and names them, so the agent knows which are untrustworthy', Array.isArray(st.notSyncingFiles) && st.notSyncingFiles.length > 0)
T('A3 those files are genuinely not synced', st.filesSynced < st.files)

// The wording changed in HIV-P13 (9147158) and this matcher did not, so B1-B4 sat red outside
// test:hardening from then until 25 Sep 2026. Match the warning by what it must say.
const warned = logsFull.filter((l) => /not synced and will READ AS EMPTY/.test(l))
T('B1 the client says so rather than retrying quietly', warned.length >= 1)
T('B2 the warning names the likely cause (Q430 / relay full)', warned.some((l) => /Q430/.test(l)))
T('B3 it warns that the files will read as empty', warned.some((l) => /READ AS EMPTY/.test(l)))
T('B4 it does NOT repeat itself per file', warned.length === 1)

try { S1.stop() } catch { }
full.kill()
await sleep(1000)

// ── C: a healthy relay must produce no alarm at all ────────────────────────────────────
const PORT_OK = PORT_FULL + 1
const ok = await startRelay(PORT_OK, {})
const logsOk = []
const dOk = workdir('ok')
const S2 = startSync({
  relay: `ws://localhost:${PORT_OK}`, room: 'ok-' + crypto.randomBytes(4).toString('hex'),
  dir: dOk, name: 'Fine', kind: 'ai', log: (m) => logsOk.push(String(m)),
})
await sleep(12000)

const st2 = S2.status()
console.log(`  healthy: files=${st2.files} synced=${st2.filesSynced} notSyncing=${st2.notSyncing}\n`)
T('C1 a healthy relay reports nothing refused', st2.notSyncing === 0)
T('C2 and raises no warning (crying wolf gets it ignored)', !logsOk.some((l) => /not synced and will READ AS EMPTY/.test(l)))
T('C3 the files really did sync, so C1 means something', st2.filesSynced >= FILES.length)

try { S2.stop() } catch { }
ok.kill()
console.log(`\n=== REFUSED VISIBLE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
