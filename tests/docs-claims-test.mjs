// What the docs say about private rooms, checked against a real relay.
//
// WHY. docs/OPERATIONS.md said: without HIVE_PERSIST_DIR or a configured store,
// /__hive/revocations reports `durable: false`. The relay on Render contradicted it: it writes to a
// default folder there (.hive-relay-data), reported `durable: true`, and told hosts a revoke would
// survive a restart. Render's free plan wipes that folder on every restart, and the revoke was gone.
// Found live on the hosted relay (14-15 Nov 2026), fixed in relay-revocations.js (persistLasts).
// This test turns the sentence into a check, so the docs and the code cannot drift apart again.
//
//   D1  the sentence is still in the docs (if it changes, change this test with it)
//   D2  a relay on Render with no HIVE_PERSIST_DIR reports durable: false
//   D3  a relay with HIVE_PERSIST_DIR set reports durable: true
//   D4  a relay with persistence off reports durable: false
//
//   node tests/docs-claims-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-docs-claims-'))
process.env.HIVE_KEYS_DIR = path.join(tmp, 'keys')
const RK = await import('../hive-room-key.js')
const { signList } = await import('../hive-revocations.js')

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra && !c ? `   ${String(extra).slice(0, 300)}` : ''}`); c ? pass++ : fail++ }
const PORT = 1399
// server.js is started from a temp cwd (.mjs and a file: URL, so it also starts on Windows and Node 20)
fs.writeFileSync(path.join(tmp, 'server.mjs'), `import ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server.js')).href)}\n`)

async function durableWith(envOverrides) {
  const env = { ...process.env, PORT: String(PORT), ...envOverrides }
  for (const [k, v] of Object.entries(envOverrides)) if (v === undefined) delete env[k]
  const r = spawn(process.execPath, ['server.mjs'], { cwd: tmp, env })
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
      r.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
      r.once('exit', (c) => rej(new Error(`relay exited (${c})`)))
    })
    const k = RK.newPersonalRoom()
    const list = signList(k, { seq: 1, revoked: [{ jti: 'docs-claims', exp: Math.floor(Date.now() / 1000) + 3600 }] })
    const res = await fetch(`http://127.0.0.1:${PORT}/__hive/revocations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: k.room, lists: [list] }) })
    const body = await res.json()
    return { durable: body.durable, room: k.room }
  } finally {
    r.kill()
    await new Promise((res) => (r.exitCode !== null ? res() : r.once('exit', res)))
  }
}

// On Render the relay writes into <repo>/.hive-relay-data (gitignored). Only what this test writes is removed.
const renderDir = path.join(ROOT, '.hive-relay-data')
const renderDirExisted = fs.existsSync(renderDir)

try {
  console.log('\n# what docs/OPERATIONS.md says')
  const ops = fs.readFileSync(path.join(ROOT, 'docs', 'OPERATIONS.md'), 'utf8').replace(/\s+/g, ' ')
  T('D1 the docs still say a relay without HIVE_PERSIST_DIR or a store reports durable: false',
    /without `HIVE_PERSIST_DIR` or a configured store, `\/__hive\/revocations` reports `durable: false`/.test(ops))

  console.log('\n# what the relay does')
  const render = await durableWith({ RENDER: 'true', HIVE_PERSIST_DIR: undefined })
  try { fs.rmSync(path.join(renderDir, 'revocations', `${render.room}.json`), { force: true }) } catch { }
  T('D2 on Render with no HIVE_PERSIST_DIR (a folder a restart wipes): durable is false', render.durable === false, `durable=${render.durable}`)
  const disk = await durableWith({ HIVE_PERSIST_DIR: path.join(tmp, 'disk'), RENDER: undefined })
  T('D3 with HIVE_PERSIST_DIR set (a disk someone mounted): durable is true', disk.durable === true, `durable=${disk.durable}`)
  const off = await durableWith({ HIVE_PERSIST_DIR: 'off', RENDER: undefined })
  T('D4 with persistence off: durable is false', off.durable === false, `durable=${off.durable}`)
} catch (e) {
  T('no exception', false, e && e.stack)
} finally {
  if (!renderDirExisted) { try { fs.rmSync(renderDir, { recursive: true, force: true }) } catch { } }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
