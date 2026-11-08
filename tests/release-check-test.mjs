// THE RELEASE CHECK (hive-mcp.js): an agent is told, at hive_release, when its work did not reach
// the room.
//
//   node tests/release-check-test.mjs
//
// 5 Nov 2026: an agent reported "done, 164/164 green, fully synced" and none of it was in the room. It
// had edited a copy the server does not sync. Real relay, a real MCP agent; each case is one way the
// work goes missing while everything says it worked.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)
async function waitUntil(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (pred()) return true } catch { } await sleep(200) } return false }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-release-check-'))
process.env.HIVE_HOME = path.join(tmp, 'home')
const startRelay = () => new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
let relay = await startRelay()
const url = (f, q = '') => `file:///${ROOT.replace(/\\/g, '/')}/${f}${q}`
const A = await import(url('hive-mcp.js', '?rc-a'))
const B = await import(url('hive-mcp.js', '?rc-b'))
const call = async (M, tool, args) => textOf(await M._test.callTool(tool, args))
const room = `room-rc${Date.now().toString(36)}xxxxxxxx`
const LINK = `ws://localhost:${PORT}|${room}`

try {
  await call(A, 'hive_join', { link: LINK, name: 'Ana' })
  await call(B, 'hive_join', { link: LINK, name: 'Bo' })
  const dirA = A._test.getSession().dir, dirB = B._test.getSession().dir
  fs.writeFileSync(path.join(dirA, 'a.js'), 'export const a = 1\n')
  fs.writeFileSync(path.join(dirA, 'b.js'), 'export const b = 1\n')
  await waitUntil(() => fs.existsSync(path.join(dirB, 'a.js')) && fs.existsSync(path.join(dirB, 'b.js')), 15000)
  await sleep(1000)

  console.log('\n# R. what a release says about where the work went')
  // R1: the normal case -- edited in the synced folder, it arrived. Nothing extra is said.
  await call(A, 'hive_claim', { region: 'a.js', intent: 'bump a' })
  fs.writeFileSync(path.join(dirA, 'a.js'), 'export const a = 2\n')
  await waitUntil(() => fs.readFileSync(path.join(dirB, 'a.js'), 'utf8') === 'export const a = 2\n', 15000)
  const r1 = await call(A, 'hive_release', { region: 'a.js' })
  T('R1 edited in the synced folder: a plain release, no warning', /^released a\.js/.test(r1) && !/!!|Note:/.test(r1), r1)

  // R1b: CRLF file on disk (Windows checkout): edited in the synced folder, it arrived.
  // Must not hang for 3 s or warn about false divergence.
  fs.writeFileSync(path.join(dirA, 'crlf.txt'), 'export const c = 1\r\nexport const d = 2\r\n')
  await waitUntil(() => fs.existsSync(path.join(dirB, 'crlf.txt')), 15000)
  await call(A, 'hive_claim', { region: 'crlf.txt', intent: 'bump crlf' })
  fs.writeFileSync(path.join(dirA, 'crlf.txt'), 'export const c = 1\r\nexport const d = 3\r\n')
  await waitUntil(() => {
    try { return fs.readFileSync(path.join(dirB, 'crlf.txt'), 'utf8').includes('d = 3') } catch { return false }
  }, 15000)
  const t0_crlf = Date.now()
  const r1b = await call(A, 'hive_release', { region: 'crlf.txt' })
  const elapsed_crlf = Date.now() - t0_crlf
  T('R1b CRLF file in synced folder: a plain release, no warning', /^released crlf\.txt/.test(r1b) && !/!!|Note:/.test(r1b), r1b)
  T('R1b CRLF file in synced folder: releases immediately (< 1500ms, not stuck for 3s)', elapsed_crlf < 1500, `took ${elapsed_crlf}ms`)

  // R2: claimed, then edited a COPY elsewhere (a scratch folder; another window's folder).
  await call(A, 'hive_claim', { region: 'b.js', intent: 'bump b' })
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-'))
  fs.writeFileSync(path.join(scratch, 'b.js'), 'export const b = 2\n')
  await sleep(1500)
  const r2 = await call(A, 'hive_release', { region: 'b.js' })
  T('R2 edited a copy somewhere else: the release says the room is UNCHANGED and which folder is synced', /UNCHANGED in the room/.test(r2) && r2.includes(dirA), r2.split('\n').slice(-1)[0].slice(0, 200))

  // R3: the agent's own folder copy never reached the room (here: the room has moved on without it,
  // which is what a stuck folder watcher looks like from the release).
  await call(A, 'hive_claim', { region: 'a.js', intent: 'bump a again' })
  const hive = A._test.getSession().hive
  const realFileText = hive._fileText
  hive._fileText = (r) => (r === 'a.js' ? 'export const a = 2\n' : realFileText(r)) // the room's copy, stuck
  fs.writeFileSync(path.join(dirA, 'a.js'), 'export const a = 3\n')
  const r3 = await call(A, 'hive_release', { region: 'a.js' })
  hive._fileText = realFileText
  T('R3 the folder\'s copy differs from the room after the wait: it says the change has NOT reached the room', /DIFFERENT from the room's copy/.test(r3) && /has not reached the room/.test(r3), r3.split('\n').slice(-1)[0].slice(0, 200))

  // R4: offline -- the change is local only, whatever the local replica says.
  await call(A, 'hive_claim', { region: 'b.js', intent: 'offline edit' })
  relay.kill()
  await waitUntil(() => { const c = hive.connection ? hive.connection() : hive.status(); return c && c.connected === false }, 15000)
  fs.writeFileSync(path.join(dirA, 'b.js'), 'export const b = 4\n')
  await sleep(800)
  const r4 = await call(A, 'hive_release', { region: 'b.js' })
  T('R4 offline at release: it says the change is local only, and not to call it done', /OFFLINE/.test(r4) && /do not tell anyone it is done/.test(r4), r4.split('\n').slice(-1)[0].slice(0, 200))
} catch (e) {
  T('the test itself crashed', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const M of [A, B]) { try { M._test.getSession().hive.stop() } catch { } }
  try { relay.kill() } catch { }
  console.log(`\n${pass} passed, ${fail} failed`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
