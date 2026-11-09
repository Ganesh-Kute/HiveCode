// tests/delete-resurrect-test.mjs -- a file a teammate deleted must never come back into the room.
//
// Written 8 Nov 2026 (Claude-cloud) to challenge one hunk: reconcile re-registering a path in the
// manifest whenever disk === the file doc's text and the path is not in the manifest. The file doc of
// a deleted path lives on at the relay, so any client that still holds an UNCHANGED copy can reach
// exactly that state. Cases, each with two real hive-mcp clients against a local server.js:
//   R1 live:     A deletes X while B is online with X open and synced.
//   R2 offline:  B leaves; A deletes X; B rejoins the same folder with its unchanged copy of X.
//   R3 rename:   the case the hunk exists for: Readme.md -> README.md -> Readme.md still ends with
//                Readme.md in the room (so a fix that drops the hunk must keep this green).
// "Comes back" = X is in the room again: on A's disk (A deleted it) after the settle.

import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SETTLE_MS = Number(process.env.RESURRECT_SETTLE_MS || 12000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'HIVE_PROXY', 'NODE_USE_ENV_PROXY']
const cleanEnv = (extra = {}) => { const e = { ...process.env }; for (const k of PROXY_ENV) delete e[k]; return { ...e, ...extra } }

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}
async function startRelay() {
  const port = await freePort()
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: cleanEnv({ PORT: String(port), HIVE_PERSIST_DIR: 'off', HIVE_ENFORCE_CLAIMS: 'queue' }), stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay start timeout')), 8000)
    proc.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve() } })
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`relay exited early (${c})`)) })
  })
  return { port, kill: () => { try { proc.kill('SIGKILL') } catch { } } }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-resurrect-'))
async function client(name, dir, home) {
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(dir, { recursive: true })
  const t = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'hive-mcp.js')], cwd: ROOT, stderr: 'pipe', env: cleanEnv({ HOME: home, USERPROFILE: home, NODE_NO_WARNINGS: '1' }) })
  t.stderr?.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(`[${name}] ${d}`) })
  const c = new Client({ name: 'resurrect-' + name, version: '1' })
  await c.connect(t)
  const call = async (tool, args = {}) => (await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 120000 })).content.map((x) => x.text).join('\n')
  return { name, dir, call, close: async () => { try { await call('hive_leave') } catch { } try { await c.close() } catch { } } }
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(100) } return false }
const has = (dir, rel) => fs.existsSync(path.join(dir, rel))

let relay
try {
  relay = await startRelay()
  const link = (room) => `ws://127.0.0.1:${relay.port}|${room}`

  // ---- R1 live delete --------------------------------------------------------------------------
  {
    const room = 'resurrect-live-' + Date.now()
    const A = await client('A', path.join(tmp, 'r1-A'), path.join(tmp, 'r1-hA'))
    const B = await client('B', path.join(tmp, 'r1-B'), path.join(tmp, 'r1-hB'))
    try {
      await A.call('hive_join', { link: link(room), dir: A.dir, name: 'A', owner: 't' })
      await B.call('hive_join', { link: link(room), dir: B.dir, name: 'B', owner: 't' })
      fs.writeFileSync(path.join(A.dir, 'x.txt'), 'shared text\n')
      T('R1 setup: x.txt reaches B', await until(() => has(B.dir, 'x.txt')))
      await sleep(1500)
      fs.unlinkSync(path.join(A.dir, 'x.txt'))
      T('R1 the delete reaches B', await until(() => !has(B.dir, 'x.txt')))
      await sleep(SETTLE_MS)
      T('R1 live delete: x.txt does NOT come back (A, B)', !has(A.dir, 'x.txt') && !has(B.dir, 'x.txt'), `A=${has(A.dir, 'x.txt')} B=${has(B.dir, 'x.txt')}`)
    } finally { await A.close(); await B.close() }
  }

  // ---- R2 offline delete, B returns with an unchanged copy ---------------------------------------
  {
    const room = 'resurrect-offline-' + Date.now()
    const dirB = path.join(tmp, 'r2-B'), homeB = path.join(tmp, 'r2-hB')
    const A = await client('A', path.join(tmp, 'r2-A'), path.join(tmp, 'r2-hA'))
    let B = await client('B', dirB, homeB)
    try {
      await A.call('hive_join', { link: link(room), dir: A.dir, name: 'A', owner: 't' })
      await B.call('hive_join', { link: link(room), dir: B.dir, name: 'B', owner: 't' })
      fs.writeFileSync(path.join(A.dir, 'x.txt'), 'shared text\n')
      T('R2 setup: x.txt reaches B', await until(() => has(B.dir, 'x.txt')))
      await sleep(2000)
      await B.close() // B goes away, keeping its copy
      await sleep(1000)
      fs.unlinkSync(path.join(A.dir, 'x.txt'))
      await sleep(4000) // the delete is in the room while B is away
      T('R2 B still holds its unchanged copy while away', has(dirB, 'x.txt'))
      B = await client('B2', dirB, homeB)
      await B.call('hive_join', { link: link(room), dir: dirB, name: 'B', owner: 't' })
      await sleep(SETTLE_MS)
      T('R2 offline delete: x.txt does NOT come back into the room (A\'s disk)', !has(A.dir, 'x.txt'), `A=${has(A.dir, 'x.txt')} B=${has(dirB, 'x.txt')}`)
    } finally { await A.close(); await B.close() }
  }

  // ---- R3 the round-trip rename the hunk was written for ----------------------------------------
  {
    const room = 'resurrect-rename-' + Date.now()
    const A = await client('A', path.join(tmp, 'r3-A'), path.join(tmp, 'r3-hA'))
    const B = await client('B', path.join(tmp, 'r3-B'), path.join(tmp, 'r3-hB'))
    try {
      await A.call('hive_join', { link: link(room), dir: A.dir, name: 'A', owner: 't' })
      await B.call('hive_join', { link: link(room), dir: B.dir, name: 'B', owner: 't' })
      fs.writeFileSync(path.join(A.dir, 'Readme.md'), '# hello\n')
      await until(() => has(B.dir, 'Readme.md'))
      await sleep(2000)
      fs.renameSync(path.join(A.dir, 'Readme.md'), path.join(A.dir, 'README.md'))
      await sleep(4000)
      fs.renameSync(path.join(A.dir, 'README.md'), path.join(A.dir, 'Readme.md'))
      await sleep(SETTLE_MS)
      const names = fs.readdirSync(B.dir).filter((n) => /^readme\.md$/i.test(n))
      T('R3 round-trip rename ends with Readme.md on the other disk', names.length === 1 && names[0] === 'Readme.md', JSON.stringify(names))
    } finally { await A.close(); await B.close() }
  }
  // ---- R4 a peer deletes the file within 60 s of this client's OWN case rename --------------------
  // The case-rename fix re-registers a path for 60 s after this client removed a case sibling; a
  // teammate's delete inside that window must still win.
  {
    const room = 'resurrect-r4-' + Date.now()
    const A = await client('A', path.join(tmp, 'r4-A'), path.join(tmp, 'r4-hA'))
    const B = await client('B', path.join(tmp, 'r4-B'), path.join(tmp, 'r4-hB'))
    try {
      await A.call('hive_join', { link: link(room), dir: A.dir, name: 'A', owner: 't' })
      await B.call('hive_join', { link: link(room), dir: B.dir, name: 'B', owner: 't' })
      fs.writeFileSync(path.join(A.dir, 'Readme.md'), '# hello\n')
      T('R4 setup: Readme.md reaches B', await until(() => has(B.dir, 'Readme.md')))
      await sleep(2000)
      fs.renameSync(path.join(B.dir, 'Readme.md'), path.join(B.dir, 'README.md')) // B's own case rename
      T('R4 B\'s rename reaches A', await until(() => has(A.dir, 'README.md') && !fs.readdirSync(A.dir).includes('Readme.md')))
      fs.unlinkSync(path.join(A.dir, 'README.md'))                                  // A deletes it, inside B's 60 s
      await sleep(SETTLE_MS)
      const left = (d) => fs.readdirSync(d).filter((n) => /^readme\.md$/i.test(n))
      T('R4 a teammate\'s delete inside the 60 s window wins: no readme comes back (A, B)', left(A.dir).length === 0 && left(B.dir).length === 0, `A=${JSON.stringify(left(A.dir))} B=${JSON.stringify(left(B.dir))}`)
    } finally { await A.close(); await B.close() }
  }

  // ---- R4c (informational) B renames back at the same moment A deletes ---------------------------
  {
    const room = 'resurrect-r4c-' + Date.now()
    const A = await client('A', path.join(tmp, 'r4c-A'), path.join(tmp, 'r4c-hA'))
    const B = await client('B', path.join(tmp, 'r4c-B'), path.join(tmp, 'r4c-hB'))
    try {
      await A.call('hive_join', { link: link(room), dir: A.dir, name: 'A', owner: 't' })
      await B.call('hive_join', { link: link(room), dir: B.dir, name: 'B', owner: 't' })
      fs.writeFileSync(path.join(A.dir, 'Readme.md'), '# hello\n')
      await until(() => has(B.dir, 'Readme.md')); await sleep(2000)
      fs.renameSync(path.join(B.dir, 'Readme.md'), path.join(B.dir, 'README.md'))
      await until(() => has(A.dir, 'README.md')); await sleep(1500)
      fs.unlinkSync(path.join(A.dir, 'README.md'))                                   // concurrently:
      try { fs.renameSync(path.join(B.dir, 'README.md'), path.join(B.dir, 'Readme.md')) } catch { }
      await sleep(SETTLE_MS)
      const left = (d) => fs.readdirSync(d).filter((n) => /^readme\.md$/i.test(n))
      console.log(`  info R4c concurrent delete (A) + rename back (B): A=${JSON.stringify(left(A.dir))} B=${JSON.stringify(left(B.dir))} -- both peers agree: ${JSON.stringify(left(A.dir)) === JSON.stringify(left(B.dir))}`)
      T('R4c whatever wins, both peers agree', JSON.stringify(left(A.dir)) === JSON.stringify(left(B.dir)), `A=${JSON.stringify(left(A.dir))} B=${JSON.stringify(left(B.dir))}`)
    } finally { await A.close(); await B.close() }
  }
} catch (e) {
  fail++
  console.log(`  FAIL harness crashed: ${(e && e.stack) || e}`)
} finally {
  if (relay) relay.kill()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
