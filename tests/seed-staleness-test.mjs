// tests/seed-staleness-test.mjs -- P0-3 of 0.14.3: no false Q506 on a branch nobody touched.
//
// 8-9 Nov mock run, room demo-3 of hivecode-test: `pr demo-3` refused test.js with Q506, "the branch
// holds content this room has never seen", although demo-3 was still exactly the commit the room was
// seeded from. test.js's chain had lost its link to the seed: one edit had reached the room without
// a receipt (the poll transport dropped it), and the next, signed, edit named that unsigned state as
// its parent. The staleness check only looks for the branch's hash in the chain, so it read an
// untouched branch as one that had moved.
//
// The room records the commit it was seeded from. A file whose branch copy is still the seeded copy
// is one the room provably started from: writing over it deletes nothing the room has not seen.
//
//   S1  an unsigned edit, then a signed one, on an untouched branch: the REAL landing lands (0.14.2:
//       Q506), and the branch gets the room's copy
//   S2  the branch really moved under the file: the DRY run refuses with Q506 like the real one
//       (0.14.2: the dry run said "would land", which is how the watcher's dry pass went green)
//   S3  ...and the real landing is still refused, the outside change still on the branch

import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-seedstale-'))
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } }
function repo(dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.email', 'dev@example.com'); g(dir, 'config', 'user.name', 'Dev'); g(dir, 'config', 'core.autocrlf', 'false')
  for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), content)
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'init')
}
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8') } catch { return null } }
const waitUntil = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (pred()) return true } catch { } await sleep(200) } return false }

const parent = path.join(tmp, 'parent')
repo(parent, { 'parent.txt': 'not a project\n' })
process.env.HIVE_HOME = path.join(parent, 'hivehome')
const FILES = {
  'test.js': "console.log('tests')\n",
  'app.js': 'export const a = 1\n',
  'package.json': '{ "name": "demo", "type": "module", "scripts": { "test": "node test.js" } }\n',
}
const relayProc = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
const url = (f, q = '') => pathToFileURL(path.join(ROOT, f)).href + q
const HB = await import(url('hive-branch.js'))
const HL = await import(url('hive-land.js'))
const { startSync } = await import(url('sync.js'))
const mcp = (tag) => import(url('hive-mcp.js', `?${tag}`))
const cli = async (cwd, ...argv) => { const out = []; const code = await HB.main(argv, { cwd, log: (s) => out.push(String(s)), logErr: (s) => out.push(String(s)) }); return { code, out: out.join('\n') } }

const project = path.join(tmp, 'project')
repo(project, FILES)
const closers = []
async function scenario(branch) {
  const b = await cli(project, 'branch', branch, '--relay', RELAY)
  if (b.code !== 0) throw new Error(`branch ${branch}: ${b.out}`)
  const link = HB.readBinding(project, branch).link
  const [relay, room] = link.split('|')
  // An edit that reaches the room WITHOUT a receipt -- what a dropped poll write left behind.
  const saved = process.env.HIVE_PROVENANCE
  process.env.HIVE_PROVENANCE = 'off'
  const dU = path.join(tmp, `unsigned-${branch}`); fs.mkdirSync(dU, { recursive: true })
  const U = startSync({ relay, room, dir: dU, name: 'Unsigned', kind: 'ai', log: () => { } }); closers.push(() => U.stop())
  if (saved === undefined) delete process.env.HIVE_PROVENANCE; else process.env.HIVE_PROVENANCE = saved
  await waitUntil(() => read(dU, 'test.js') === FILES['test.js'], 15000)
  await sleep(800)
  fs.writeFileSync(path.join(dU, 'test.js'), "console.log('tests')\nconsole.log('unsigned step')\n")
  // ...then an ordinary agent (hive-mcp turns provenance on) signs the next edit, on top of it.
  const A = await mcp(`Ana-${branch}`)
  closers.push(() => A._test.callTool('hive_leave', {}).catch(() => { }))
  await A._test.callTool('hive_join', { branch, repo: project, name: 'Ana', owner: 'Dev' })
  const dir = A._test.getSession().dir
  await waitUntil(() => /unsigned step/.test(read(dir, 'test.js') || ''), 15000)
  await sleep(1500)
  const signedText = "console.log('tests')\nconsole.log('unsigned step')\nconsole.log('signed step')\n"
  fs.writeFileSync(path.join(dir, 'test.js'), signedText)
  await waitUntil(() => A._test.getSession().hive._fileText('test.js') === signedText, 15000)
  await sleep(2000)
  if (process.env.SEED_DEBUG) {
    const { contentHash } = await import(url('substrate.js'))
    const rc = A._test.getSession().hive.provenanceOf('test.js') || []
    console.log('    receipts:', rc.map((r) => `${r.name}:${String(r.parent).slice(0, 6)}->${String(r.contentHash).slice(0, 6)}`).join(' '), '| seed', contentHash(FILES['test.js']).slice(0, 6), '| room', contentHash(read(dir, 'test.js') || '').slice(0, 6))
  }
  try { U.stop() } catch { }
  return { A, dir }
}

try {
  console.log('\n# S1 unsigned then signed edit, branch untouched since the seed')
  await scenario('seedq')
  const r1d = await HL.landAndOpen({ cwd: project, branch: 'seedq', dry: true, log: () => { }, logErr: () => { } })
  T('S1 the dry landing is not refused as stale', r1d && r1d.ok === true, JSON.stringify({ ok: r1d && r1d.ok, code: r1d && r1d.code }))
  const r1 = await HL.landAndOpen({ cwd: project, branch: 'seedq', dry: false, log: () => { }, logErr: () => { } })
  T('S1 the REAL landing is not refused as stale either (no Q506 on an untouched branch)', r1 && r1.ok === true, JSON.stringify({ ok: r1 && r1.ok, code: r1 && r1.code, why: String(r1 && r1.why || '').slice(0, 200) }))
  T('S1 and the branch now holds the room\'s signed copy', /signed step/.test(g(project, 'show', 'seedq:test.js').out))

  console.log('\n# S3 the branch really moved under the file: still refused')
  await scenario('seedm')
  const wt = path.join(tmp, 'wt-seedm')
  g(project, 'worktree', 'add', '-q', wt, 'seedm')
  fs.writeFileSync(path.join(wt, 'test.js'), "console.log('tests')\nconsole.log('changed on the branch, outside the room')\n")
  const cm = g(wt, 'commit', '-qam', 'outside change')
  if (process.env.SEED_DEBUG) console.log('    outside commit:', cm.code, cm.err.slice(0, 120), '| seedm:', g(project, 'log', '--oneline', '-2', 'seedm').out.split('\n').join(' / '))
  g(project, 'worktree', 'remove', '--force', wt)
  const r3d = await HL.landAndOpen({ cwd: project, branch: 'seedm', dry: true, log: () => { }, logErr: () => { } })
  T('S2 the DRY run says what the real one will: refused (Q506), not "would land"', r3d && r3d.ok === false && r3d.code === 'Q506', JSON.stringify({ ok: r3d && r3d.ok, code: r3d && r3d.code }))
  const r3 = await HL.landAndOpen({ cwd: project, branch: 'seedm', dry: false, log: () => { }, logErr: () => { } })
  T('S3 a real branch change under the file is still refused (Q506)', r3 && r3.ok === false && r3.code === 'Q506', JSON.stringify({ ok: r3 && r3.ok, code: r3 && r3.code }))
  T('S3 and the outside change is still on the branch', /outside the room/.test(g(project, 'show', 'seedm:test.js').out))
} catch (e) {
  fail++
  console.log('  FAIL threw: ' + (e && e.stack || e))
} finally {
  for (const c of closers.reverse()) { try { await c() } catch { } }
  try { relayProc.kill('SIGKILL') } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
