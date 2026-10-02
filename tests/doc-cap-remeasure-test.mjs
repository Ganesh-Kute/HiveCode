// A doc is not refused for bytes it no longer holds.
//
//   node tests/doc-cap-remeasure-test.mjs
//
// The relay caps each doc's size (limits.js: 8 MB a doc on the free tier, 512 MB on pro), and it
// measures that size by ADDING the length of every write it admits. Nothing ever subtracts. Content
// that is REPLACED is gone from the doc, though -- an overwritten map value is garbage-collected --
// so until 3 Oct 2026 a replaced file read as the sum of all its versions: a binary saved six times
// was six times its size to the counter, and was refused with Q435 while the doc held one version.
// Binary sync makes whole-file replacement the normal way an image or a PDF changes.
//
// (A TEXT file is different, on purpose: its doc keeps restore points -- up to 30 earlier versions
// -- so for text the counter is close to what the doc really holds. That is not tested here.)
//
// The relay runs the free tier with a 200 KB doc cap, so a few versions cross it.
//   A  six versions of a 60 KB binary (360 KB of writes, 60 KB held) all reach the teammate
//   B  a doc that really holds more than the cap is still refused, and the room is told (Q435)

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync } = await import('../sync.js')

let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const healthy = (u) => new Promise((res) => { const q = http.get(u, (r) => { r.resume(); res(r.statusCode === 200) }); q.on('error', () => res(false)); q.setTimeout(800, () => { q.destroy(); res(false) }) })
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(step) } return pred() }

const CAP = 200 * 1024
const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  // Free tier on purpose (no HIVE_SEATS): its per-doc cap is the one a replaced file crosses first.
  env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '', HIVE_FREE_MAX_DOC_BYTES: String(CAP), HIVE_ENFORCE_CLAIMS: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' },
  stdio: ['ignore', 'ignore', 'ignore'],
})
for (let i = 0; i < 60 && !(await healthy(`http://127.0.0.1:${PORT}/health`)); i++) await sleep(250)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-doc-cap-'))
const A_DIR = path.join(TMP, 'alice'), B_DIR = path.join(TMP, 'bob')
fs.mkdirSync(A_DIR); fs.mkdirSync(B_DIR)
const room = 'cap-' + Math.random().toString(36).slice(2, 8)
const A = startSync({ relay: `ws://127.0.0.1:${PORT}`, room, dir: A_DIR, name: 'Alice', kind: 'ai', log: () => { } })
const B = startSync({ relay: `ws://127.0.0.1:${PORT}`, room, dir: B_DIR, name: 'Bob', kind: 'ai', log: () => { } })
process.on('exit', () => { try { A.stop(); B.stop() } catch { }; try { relay.kill() } catch { }; try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { } })
await until(() => { try { return A.status().connected && B.status().connected } catch { return false } }, 20000, 250)

// A PNG-like header (it carries a NUL, so it is binary), a version byte, then random bytes: every
// version replaces the whole file, and its write is the file's full size.
const version = (n, bytes) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, n]), crypto.randomBytes(bytes)])
const versionOnBob = (r) => { try { const b = fs.readFileSync(path.join(B_DIR, r)); return b.length > 5 ? b[5] : -1 } catch { return -1 } }
const q435 = () => B.doc.getArray('chat').toArray().filter((m) => /Q435/.test(String(m.text || '')))

console.log('\nA  six versions of a 60 KB binary, against a 200 KB cap')
let arrived = 0
for (let n = 1; n <= 6; n++) {
  fs.writeFileSync(path.join(A_DIR, 'logo.png'), version(n, 60 * 1024))
  if (await until(() => versionOnBob('logo.png') === n, 15000)) arrived++
  else break
}
T('A1 all six versions reach Bob, though 360 KB of writes passed the 200 KB cap at the fourth', arrived === 6, `${arrived}/6 arrived`)
T('A2 nobody was told the room is full', q435().length === 0, JSON.stringify(q435().map((m) => m.text)))

console.log('\nB  a doc that really holds more than the cap')
fs.writeFileSync(path.join(A_DIR, 'poster.png'), version(1, 220 * 1024))
T('B0 setup: the first 220 KB version arrives (the doc was empty before it)', await until(() => versionOnBob('poster.png') === 1, 15000))
await sleep(1500)
fs.writeFileSync(path.join(A_DIR, 'poster.png'), version(2, 220 * 1024))
await sleep(6000)
T('B1 a doc that really holds more than the cap is still refused, and the room is told (Q435)',
  q435().length >= 1, `${q435().length} Q435 notices`)
T('B2 ...so the version past it does not reach Bob', versionOnBob('poster.png') === 1, `Bob has version ${versionOnBob('poster.png')}`)

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
