// THE ONE LANDING PATH (hive-land.js): every check runs before anything moves.
//
//   node tests/land-test.mjs
//
// Real relay, real git, real MCP agents. Each group is a way landing a room's work hurts somebody
// when it is wrong, and each was RED on the code before hive-land.js (5 Nov 2026):
//   K  someone still holds a claim            -> landed anyway: a half-made change on the branch
//   T  the tests fail                         -> `pr` had no tests: the failing work landed
//   N  no test command                        -> nothing said the work was untested
//   W  a workflow file changed                -> landed and pushed by `pr`: workflows run with secrets
//   R  GitHub/origin is ahead                 -> landed locally, THEN the push failed: branch moved
//   L  two landings at once                   -> no lock
//   P  a PR is already open                   -> `gh pr create` failed (Q574)
//   O  a changed file with no signed receipt  -> left out with one easy-to-miss stdout line
//   E  the relay lost the room (LAST: it restarts the relay)
//                                             -> a commit deleting every file of the branch
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = Number(process.env.HIVE_TEST_PORT) || await freePort()
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-land-test-'))
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } }
function repo(dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.email', 'dev@example.com'); g(dir, 'config', 'user.name', 'Dev'); g(dir, 'config', 'core.autocrlf', 'false')
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'init')
}
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8') } catch { return null } }
async function waitUntil(pred, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (pred()) return true } catch { } await sleep(200) }
  return false
}
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

// HIVE_HOME inside another repository, as in branch-test: git run in a room folder must never reach it.
const parent = path.join(tmp, 'parent')
repo(parent, { 'parent.txt': 'not a project\n' })
process.env.HIVE_HOME = path.join(parent, 'hivehome')

const FILES = {
  'app.js': 'export const answer = 41\n',
  'test.js': "import { answer } from './app.js'\nif (answer !== 42) { console.error('answer is ' + answer); process.exit(1) }\nconsole.log('all tests passed')\n",
  'package.json': '{ "name": "demo", "type": "module", "scripts": { "test": "node test.js" } }\n',
  'lib.js': 'export const twice = (n) => n * 2\n',
  'README.md': '# demo\n',
  'docs/a.md': 'a\n', 'docs/b.md': 'b\n', 'docs/c.md': 'c\n', 'docs/d.md': 'd\n',
}

function startRelay() {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
    p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  })
}
let relay = await startRelay()
const url = (f, q = '') => `file:///${ROOT.replace(/\\/g, '/')}/${f}${q}`
const HB = await import(url('hive-branch.js'))
const HL = await import(url('hive-land.js'))
const mcp = (tag) => import(url('hive-mcp.js', `?${tag}`))
async function cli(cwd, ...argv) {
  const out = []
  const code = await HB.main(argv, { cwd, log: (s) => out.push(String(s)), logErr: (s) => out.push(String(s)) })
  return { code, out: out.join('\n') }
}

const project = path.join(tmp, 'project')
repo(project, FILES)
const agents = []
let seq = 0
// A branch with its own room, and one agent in it. Each group gets its own, so none depends on another.
async function setup(branch, name = 'Ana') {
  const b = await cli(project, 'branch', branch, '--relay', RELAY)
  if (b.code !== 0) throw new Error(`branch ${branch}: ${b.out}`)
  const A = await mcp(`${name}-${branch}-${++seq}`); agents.push(A)
  const j = textOf(await A._test.callTool('hive_join', { branch, repo: project, name, owner: 'Dev' }))
  const dir = A._test.getSession().dir
  await waitUntil(() => read(dir, 'app.js') === FILES['app.js'], 15000)
  return { A, dir, hive: A._test.getSession().hive, join: j }
}
async function join(branch, name) {
  const X = await mcp(`${name}-${branch}-${++seq}`); agents.push(X)
  await X._test.callTool('hive_join', { branch, repo: project, name, owner: 'Dev' })
  const dir = X._test.getSession().dir
  await waitUntil(() => read(dir, 'app.js') !== null, 15000)
  return { X, dir, hive: X._test.getSession().hive }
}
// An agent's edit, and the wait until the ROOM holds it (not just the agent's disk).
async function edit(who, rel, text) {
  fs.mkdirSync(path.dirname(path.join(who.dir, ...rel.split('/'))), { recursive: true })
  fs.writeFileSync(path.join(who.dir, ...rel.split('/')), text)
  const ok = await waitUntil(() => who.hive._fileText(rel) === text, 15000)
  await sleep(1200) // the signed receipt follows the text
  return ok
}
const tipOf = (b) => g(project, 'rev-parse', `refs/heads/${b}`).out
// HIVE_LAND_GROUPS=D,C runs only those groups (to check one mutant without the whole suite).
const ONLY = (process.env.HIVE_LAND_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean)
const want = (k) => !ONLY.length || ONLY.includes(k)

try {
  // ─── K. A CLAIM IS STILL HELD ────────────────────────────────────────────────────────────────
  console.log('\n# K. nothing lands while someone still holds a claim')
  if (want('K')) {
    const a = await setup('k1')
    const bo = await join('k1', 'Bo')
    await edit(a, 'app.js', 'export const answer = 42\n')
    const claimed = textOf(await bo.X._test.callTool('hive_claim', { region: 'lib.js', intent: 'rename twice to double' }))
    const before = tipOf('k1')
    const k1 = await cli(project, 'pr', 'k1')
    T('K1 pr refuses with Q575, naming the holder, the file and the intent', k1.code !== 0 && /Q575/.test(k1.out) && /Bo/.test(k1.out) && /lib\.js/.test(k1.out) && /rename twice to double/.test(k1.out), (k1.out.match(/Q\d{3}[^\n]*/) || [k1.out.split('\n').slice(-1)[0]])[0] + ` | claim: ${claimed.split('\n')[0]}`)
    T('K2 ...and the branch did not move', tipOf('k1') === before)
    await bo.X._test.callTool('hive_release', { region: 'lib.js' })
    await sleep(1500)
    const k3 = await cli(project, 'pr', 'k1')
    T('K3 once released, the same landing goes through', k3.code === 0 && tipOf('k1') !== before && g(project, 'show', 'k1:app.js').out === 'export const answer = 42', k3.out.split('\n').slice(-1)[0])
    // An agent that joined by LINK finds this repo through the machine's registry (hive-repos.js),
    // written when the branch was bound, and the room says who holds the repo -- with no path in it.
    const reg = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.HIVE_HOME, 'repos.json'), 'utf8')) } catch { return null } })()
    const k1room = g(project, 'config', '--get', 'hivecode.k1.room').out.split('|')[1]
    const entries = reg && reg.rooms && [].concat(reg.rooms[k1room] || [])
    T('K0 binding the branch registered this repo for the room on this machine', !!entries && entries.some((e) => path.resolve(e.root) === path.resolve(project) && e.branch === 'k1'), JSON.stringify(entries))
    const holder = a.hive.doc.getMap('repo_holder').toJSON()
    T('K0b the room records who holds the repo, and no path', holder.branch === 'k1' && !!holder.holder && !JSON.stringify(holder).includes(path.basename(project)), JSON.stringify(holder))
    const r = await HL.landAndOpen({ cwd: project, branch: 'k1', dry: true })
    T('K4 landAndOpen is a dry run unless told otherwise, and says so', r && r.dry === true && r.ok === true && tipOf('k1') === g(project, 'rev-parse', 'k1').out, JSON.stringify(r).slice(0, 160))
    // Everything is on the branch now: a dry run that still promised "1 commit would land" (it did,
    // 5 Nov 2026: an agent whose files are all identical was listed) is a false plan.
    T('K5 ...and with everything landed, the dry run promises nothing', r && r.plan.length === 0 && /nothing new would land/.test(r.why), r && r.why)
  }

  // ─── T. THE TESTS DECIDE ─────────────────────────────────────────────────────────────────────
  console.log('\n# T. --test runs on the exact commit that would land, before anything moves')
  if (want('T')) {
    const a = await setup('t1')
    await edit(a, 'app.js', 'export const answer = 40\n')
    const before = tipOf('t1')
    const t1 = await cli(project, 'pr', 't1', '--test', 'node test.js')
    T('T1 failing tests refuse the landing with Q576 and show the output', t1.code !== 0 && /Q576/.test(t1.out) && /answer is 40/.test(t1.out), (t1.out.match(/Q\d{3}[^\n]*/) || [t1.out.split('\n').slice(-1)[0]])[0])
    T('T2 ...and the branch did not move', tipOf('t1') === before)
    T('T3 ...and no temporary worktree or branch is left behind', g(project, 'worktree', 'list', '--porcelain').out.split('\n').filter((l) => l.startsWith('worktree ')).length === 1 && !g(project, 'branch', '--list', 'hivecode-land/*').out)
    await edit(a, 'app.js', 'export const answer = 42\n')
    const t4 = await cli(project, 'pr', 't1', '--test', 'node test.js')
    const tip = tipOf('t1')
    T('T4 passing tests land it, and the output names the tested commit, which is the new tip', t4.code === 0 && tip !== before && new RegExp(`tests passed on ${tip.slice(0, 7)}`).test(t4.out), t4.out.split('\n').filter((l) => /tests/i.test(l)).join(' | ').slice(0, 200))
    await edit(a, 'app.js', 'export const answer = 42 // ok\n')
    const t5 = await cli(project, 'pr', 't1', '--test', 'definitely-not-a-command-xyz')
    T('T5 a test command that cannot start is "could not start", never "tests failed"; nothing moves', t5.code !== 0 && /Q576/.test(t5.out) && /could not start|not found|not recognized/i.test(t5.out) && tipOf('t1') === tip, (t5.out.match(/Q\d{3}[^\n]*/) || [''])[0])
    await edit(a, 'app.js', "export const answer = 42\nawait new Promise((r) => setTimeout(r, 60000))\n")
    const t6 = await cli(project, 'pr', 't1', '--test', 'node test.js', '--test-minutes', '0.05')
    T('T6 tests that run past the limit are stopped and refuse the landing', t6.code !== 0 && /Q576/.test(t6.out) && /ran past|time limit/i.test(t6.out) && tipOf('t1') === tip, (t6.out.match(/Q\d{3}[^\n]*/) || [''])[0])
    // THE TEST COMMAND COMES FROM CONFIGURATION, never from whoever asks (a tool argument would let
    // any caller pick a shell command for Hivecode to run): saved once by the developer, then used.
    T('T7 with nothing saved, the project\'s own npm test is the fallback (from package.json)', JSON.stringify(HL.testCommandFor(project, 't1')) === JSON.stringify({ command: 'npm test', from: 'package.json' }), JSON.stringify(HL.testCommandFor(project, 't1')))
    await edit(a, 'app.js', 'export const answer = 39\n')
    const t8 = await cli(project, 'pr', 't1', '--test', 'node test.js', '--save')
    T('T8 --save keeps the command, and that landing already runs it', t8.code !== 0 && /saved: landing t1 now runs/.test(t8.out) && /answer is 39/.test(t8.out) && tipOf('t1') === tip && g(project, 'config', '--get', 'hivecode.t1.test').out === 'node test.js', t8.out.split('\n').slice(0, 2).join(' | '))
    const t9 = await cli(project, 'pr', 't1')
    T('T9 a later pr with no --test runs the saved command and refuses the failing work', t9.code !== 0 && /saved for t1/.test(t9.out) && /Q576/.test(t9.out) && tipOf('t1') === tip, (t9.out.match(/Q\d{3}[^\n]*/) || [''])[0])
    T('T10 ...and testCommandFor now answers with the saved command', HL.testCommandFor(project, 't1').from === 'saved')
    await edit(a, 'app.js', 'export const answer = 42 // ok\n')
  }

  // ─── N. UNTESTED IS SAID ─────────────────────────────────────────────────────────────────────
  console.log('\n# N. without a test command the landing says, in words, that nothing was tested')
  if (want('N')) {
    const a = await setup('n1')
    await edit(a, 'README.md', '# demo, edited\n')
    const d0 = await HL.landAndOpen({ cwd: project, branch: 'n1' })
    T('N0 a dry run lists the agent and the file it would land', d0 && d0.ok && d0.plan.length === 1 && d0.plan[0].agent === 'Ana' && d0.plan[0].files.includes('README.md'), d0 && d0.why)
    // The room's own content hash of what would land: what a review must match (room mode, B3). A
    // fresh passive client cannot read it (file docs not synced), so it comes from the mirror.
    const { contentHash } = await import(url('substrate.js'))
    T('N0b ...with the room\'s content hash of that file, as the mirror read it', d0 && d0.hashes && d0.hashes['README.md'] === contentHash('# demo, edited\n'), JSON.stringify(d0 && d0.hashes))
    const n1 = await cli(project, 'pr', 'n1')
    T('N1 the output says tests were NOT RUN', n1.code === 0 && /tests: NOT RUN/.test(n1.out), n1.out.split('\n').slice(-2).join(' | '))
    const r = await HL.landAndOpen({ cwd: project, branch: 'n1', dry: true })
    T('N2 ...and so does the result', r && r.tests && r.tests.ran === false, JSON.stringify(r && r.tests))
  }

  // ─── W. WORKFLOW FILES ───────────────────────────────────────────────────────────────────────
  console.log('\n# W. a change to .github/workflows does not land unless allowed')
  if (want('W')) {
    const a = await setup('w1')
    await edit(a, '.github/workflows/ci.yml', 'on: push\njobs: {}\n')
    const before = tipOf('w1')
    const w1 = await cli(project, 'pr', 'w1')
    T('W1 refused with Q578, naming the workflow file', w1.code !== 0 && /Q578/.test(w1.out) && /\.github\/workflows\/ci\.yml/.test(w1.out), (w1.out.match(/Q\d{3}[^\n]*/) || [w1.out.split('\n').slice(-1)[0]])[0])
    T('W2 ...and the branch did not move', tipOf('w1') === before)
    const w3 = await cli(project, 'pr', 'w1', '--allow-workflow-changes')
    T('W3 --allow-workflow-changes lands it', w3.code === 0 && g(project, 'cat-file', '-e', 'w1:.github/workflows/ci.yml').code === 0, w3.out.split('\n').slice(-1)[0])
  }

  // ─── R. THE REMOTE IS AHEAD ──────────────────────────────────────────────────────────────────
  console.log('\n# R. origin has commits this repo does not: refused BEFORE landing, never force-pushed')
  if (want('R')) {
    const origin = path.join(tmp, 'origin.git')
    g(tmp, 'init', '-q', '--bare', origin)
    g(project, 'remote', 'add', 'origin', origin)
    const a = await setup('r1')
    g(project, 'push', '-q', 'origin', 'r1')
    const other = path.join(tmp, 'other-clone')
    g(tmp, 'clone', '-q', '-b', 'r1', origin, other)
    g(other, 'config', 'user.email', 'pal@example.com'); g(other, 'config', 'user.name', 'Pal')
    fs.writeFileSync(path.join(other, 'docs', 'a.md'), 'a, by a teammate\n'); g(other, 'commit', '-qam', 'teammate'); g(other, 'push', '-q', 'origin', 'r1')
    const remoteTip = g(origin, 'rev-parse', 'r1').out
    await edit(a, 'app.js', 'export const answer = 42\n')
    const before = tipOf('r1')
    const r1 = await cli(project, 'pr', 'r1', '--push')
    T('R1 refused with Q578 before landing: origin is ahead', r1.code !== 0 && /Q578/.test(r1.out) && /origin/.test(r1.out), (r1.out.match(/Q\d{3}[^\n]*/) || [r1.out.split('\n').slice(-1)[0]])[0])
    T('R2 ...the local branch did not move, and origin still has the teammate\'s commit', tipOf('r1') === before && g(origin, 'rev-parse', 'r1').out === remoteTip)
  }

  // ─── L. TWO LANDINGS AT ONCE ─────────────────────────────────────────────────────────────────
  console.log('\n# L. a second landing of the same branch is refused while one runs')
  if (want('L')) {
    const a = await setup('l1')
    await edit(a, 'app.js', 'export const answer = 42\n')
    process.env.HIVE_TEST_OPEN_DELAY_MS = '3000' // the first landing's mirror arrives slowly
    const first = HL.landAndOpen({ cwd: project, branch: 'l1', dry: false, by: 'first' })
    await sleep(700)
    const second = await HL.landAndOpen({ cwd: project, branch: 'l1', dry: false, by: 'second' })
    const r1 = await first
    delete process.env.HIVE_TEST_OPEN_DELAY_MS
    T('L1 the first landing succeeds', r1 && r1.ok === true && r1.landed >= 1, JSON.stringify(r1 && { ok: r1.ok, code: r1.code, why: r1.why }).slice(0, 200))
    T('L2 the second is refused with Q579 and names the first', second && second.ok === false && second.code === 'Q579' && /first/.test(second.why) && /already/.test(second.why), second && second.why)
    const lockDir = path.join(project, '.git', 'hivecode')
    T('L3 the lock is gone afterwards', !fs.existsSync(lockDir) || !fs.readdirSync(lockDir).some((f) => /^land-.*\.lock$/.test(f)))
    // A crashed landing leaves its lock behind: a dead pid on this machine does not block the next one.
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'land-l1.lock'), JSON.stringify({ pid: 2147483646, host: os.hostname(), by: 'crashed', at: Date.now() - 60000 }))
    await edit(a, 'app.js', 'export const answer = 42 // again\n')
    const r4 = await HL.landAndOpen({ cwd: project, branch: 'l1', dry: false, by: 'after-crash' })
    T('L4 a lock left by a dead process is taken over, and the result says so', r4 && r4.ok === true && /crashed/.test(JSON.stringify(r4)), JSON.stringify(r4 && { ok: r4.ok, code: r4.code, why: r4.why }).slice(0, 200))
  }

  // ─── P. A PR IS ALREADY OPEN ─────────────────────────────────────────────────────────────────
  console.log('\n# P. an open PR is updated, never duplicated')
  if (want('P')) {
    const a = await setup('p1')
    g(project, 'push', '-q', 'origin', 'main')
    await edit(a, 'app.js', 'export const answer = 42\n')
    const calls = []
    const github = {
      owner: 'o', repo: 'r',
      user: () => ({ login: 'dev' }),
      pullsFor: (b) => { calls.push(`pullsFor ${b}`); return [{ number: 7, state: 'open', html_url: 'https://github.com/o/r/pull/7', head: { ref: b } }] },
      createPull: (p) => { calls.push(`createPull ${p.head}`); throw Object.assign(new Error('a pull request already exists'), { status: 422 }) },
    }
    const r = await HL.landAndOpen({ cwd: project, branch: 'p1', dry: false, pr: true, base: 'main', github })
    T('P1 the open PR is updated: same number, updated, not created', r && r.ok === true && r.pr && r.pr.number === 7 && r.pr.updated === true && r.pr.created === false, JSON.stringify(r && { ok: r.ok, code: r.code, why: r.why, pr: r.pr }).slice(0, 220))
    T('P2 ...no PR was created', !calls.some((c) => c.startsWith('createPull')), calls.join(', '))
    T('P3 ...and origin has exactly the landed tip', g(path.join(tmp, 'origin.git'), 'rev-parse', 'p1').out === tipOf('p1'))
  }

  // ─── O. CHANGED BUT NOT SIGNED ───────────────────────────────────────────────────────────────
  console.log('\n# O. a file changed in the room without a signed receipt is reported as NOT landed')
  if (want('O')) {
    const a = await setup('o1')
    await edit(a, 'app.js', 'export const answer = 42\n')
    // A participant whose client signs nothing (an old build, or provenance off) changes lib.js.
    const { startSync, parseLink } = await import(url('sync.js'))
    const link = g(project, 'config', '--get', 'hivecode.o1.room').out
    const { relay: rl, room } = parseLink(link)
    const odir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-unsigned-'))
    const prov = process.env.HIVE_PROVENANCE
    process.env.HIVE_PROVENANCE = 'off'
    const old = startSync({ relay: rl, room, dir: odir, name: 'OldClient', kind: 'ai', log: () => {} })
    if (prov === undefined) delete process.env.HIVE_PROVENANCE; else process.env.HIVE_PROVENANCE = prov
    await waitUntil(() => read(odir, 'lib.js') !== null, 15000)
    fs.writeFileSync(path.join(odir, 'lib.js'), 'export const twice = (n) => n + n // unsigned\n')
    await waitUntil(() => a.hive._fileText('lib.js') === 'export const twice = (n) => n + n // unsigned\n', 15000)
    await sleep(1200)
    const r = await HL.landAndOpen({ cwd: project, branch: 'o1', dry: true })
    T('O1 the result lists the unsigned file in orphans', r && Array.isArray(r.orphans) && r.orphans.includes('lib.js'), JSON.stringify(r && r.orphans))
    const o2 = await cli(project, 'pr', 'o1')
    T('O2 the landing says, as its own line, that the file was NOT landed and why', o2.code === 0 && /NOT landed.*lib\.js|lib\.js.*NOT landed/i.test(o2.out) && /signed receipt/i.test(o2.out), o2.out.split('\n').filter((l) => /lib\.js/.test(l)).join(' | '))
    try { old.stop() } catch { }
  }

  // ─── D. A LANDING THAT WOULD DELETE MOST OF THE BRANCH ────────────────────────────────────────
  console.log('\n# D. deleting most of the branch needs --allow-mass-delete')
  if (want('D')) {
    const a = await setup('d1')
    const gone = ['README.md', 'docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md'] // 5 of the 9 files
    for (const rel of gone) fs.rmSync(path.join(a.dir, ...rel.split('/')))
    await waitUntil(() => gone.every((rel) => !a.hive.doc.getMap('manifest').has(rel)), 15000)
    await sleep(1500)
    const before = tipOf('d1')
    const d1 = await cli(project, 'pr', 'd1')
    T('D1 refused with Q577, naming the count and the way to confirm', d1.code !== 0 && /Q577/.test(d1.out) && /delete 5 of the 9 files/.test(d1.out) && /--allow-mass-delete/.test(d1.out), (d1.out.match(/Q\d{3}[^\n]*/) || [d1.out.split('\n').slice(-1)[0]])[0])
    T('D2 ...and the branch did not move', tipOf('d1') === before)
    const d3 = await cli(project, 'pr', 'd1', '--allow-mass-delete')
    const left = g(project, 'ls-tree', '-r', '--name-only', 'd1').out.split('\n').filter(Boolean)
    T('D3 --allow-mass-delete lands the deletions', d3.code === 0 && gone.every((rel) => !left.includes(rel)) && left.includes('app.js'), d3.out.split('\n').slice(-1)[0])
  }

  // ─── C. A CLAIM TAKEN WHILE THE LANDING RUNS ─────────────────────────────────────────────────
  console.log('\n# C. a claim taken mid-landing stops it: a change may have been caught half-made')
  if (want('C')) {
    const a = await setup('c1')
    const bo = await join('c1', 'Bo')
    await edit(a, 'app.js', 'export const answer = 42\n')
    const before = tipOf('c1')
    // Any worktree but the project's own. (Matching on "hive-land-" counted the project itself: this
    // test's temp folder is named hive-land-test-..., so the "window" opened before the landing began.)
    const worktrees = () => g(project, 'worktree', 'list', '--porcelain').out.split('\n').filter((l) => l.startsWith('worktree ') && path.resolve(l.slice(9)) !== path.resolve(project)).length
    process.env.HIVE_TEST_OPEN_DELAY_MS = '4000' // hive-pr's mirror arrives slowly: the window to claim in
    const landing = HL.landAndOpen({ cwd: project, branch: 'c1', dry: false, by: 'c-test' })
    // The temporary worktree exists only after the first claims check passed: claim exactly then.
    const inWindow = await waitUntil(() => worktrees() > 0, 20000)
    await bo.X._test.callTool('hive_claim', { region: 'lib.js', intent: 'midway edit' })
    const r = await landing
    delete process.env.HIVE_TEST_OPEN_DELAY_MS
    T('C1 refused with Q575 by the SECOND claims check, naming the claim', inWindow && r && r.ok === false && r.code === 'Q575' && /started while this landing ran/.test(r.why) && /lib\.js/.test(r.why), r && r.why)
    T('C2 ...and the branch did not move', tipOf('c1') === before)
    await bo.X._test.callTool('hive_release', { region: 'lib.js' })
  }

  // ─── G. A REMOTE THAT NEVER ANSWERS ──────────────────────────────────────────────────────────
  console.log('\n# G. a remote that never answers ends in a refusal, not a hang')
  if (want('G')) {
    const a = await setup('g1')
    await edit(a, 'app.js', 'export const answer = 42\n')
    const sockets = []
    const blackhole = net.createServer((s) => { sockets.push(s) }) // accepts, never answers
    await new Promise((res) => blackhole.listen(0, '127.0.0.1', res))
    const originWas = g(project, 'remote', 'get-url', 'origin').out
    g(project, 'remote', originWas ? 'set-url' : 'add', 'origin', `http://127.0.0.1:${blackhole.address().port}/never.git`)
    process.env.HIVE_GIT_NET_TIMEOUT_MS = '2500'
    const before = tipOf('g1')
    const t0 = Date.now()
    const g1 = await cli(project, 'pr', 'g1', '--push')
    const took = Date.now() - t0
    delete process.env.HIVE_GIT_NET_TIMEOUT_MS
    if (originWas) g(project, 'remote', 'set-url', 'origin', originWas); else g(project, 'remote', 'remove', 'origin')
    for (const s of sockets) { try { s.destroy() } catch { } }
    blackhole.close()
    T('G1 refused with Q578 after the time limit, saying the remote did not answer', g1.code !== 0 && /Q578/.test(g1.out) && /no answer from the remote/.test(g1.out) && took < 60000, `${took} ms: ${(g1.out.match(/Q\d{3}[^\n]*/) || [''])[0]}`)
    T('G2 ...and the branch did not move', tipOf('g1') === before)
  }

  // ─── J. A TEAMMATE'S CLONE, BOUND WITH --join ────────────────────────────────────────────────
  console.log('\n# J. a --join clone knows the seed commit, so the room\'s deletions land from it too')
  if (want('J')) {
    const a = await setup('j1')
    const link = g(project, 'config', '--get', 'hivecode.j1.room').out
    const clone = path.join(tmp, 'j-clone')
    g(tmp, 'clone', '-q', project, clone)
    g(clone, 'config', 'user.email', 'pal@example.com'); g(clone, 'config', 'user.name', 'Pal'); g(clone, 'config', 'core.autocrlf', 'false')
    g(clone, 'branch', '-q', 'j1', 'origin/j1')
    const j0 = await cli(clone, 'branch', 'j1', '--join', link)
    T('J1 --join records the commit the room was seeded from', j0.code === 0 && g(clone, 'config', '--get', 'hivecode.j1.base').out === g(project, 'config', '--get', 'hivecode.j1.base').out && !!g(project, 'config', '--get', 'hivecode.j1.base').out, g(clone, 'config', '--get', 'hivecode.j1.base').out)
    fs.rmSync(path.join(a.dir, 'README.md'))
    await waitUntil(() => !a.hive.doc.getMap('manifest').has('README.md'), 15000)
    await edit(a, 'app.js', 'export const answer = 42\n')
    // The binding an older --join made: no base. Nothing is deleted, and that is said, with the file.
    const base = g(clone, 'config', '--get', 'hivecode.j1.base').out
    g(clone, 'config', '--unset', 'hivecode.j1.base')
    const j2 = await cli(clone, 'pr', 'j1', '--dry-run')
    T('J2 without a seed record the landing SAYS which files it leaves alone', j2.code === 0 && /deletions NOT landed/.test(j2.out) && /README\.md/.test(j2.out), (j2.out.split('\n').find((l) => /deletions NOT landed/.test(l)) || j2.out.split('\n').slice(-1)[0]).slice(0, 200))
    g(clone, 'config', 'hivecode.j1.base', base)
    const j3 = await cli(clone, 'pr', 'j1')
    T('J3 with it, the room\'s deletion lands from the clone', j3.code === 0 && g(clone, 'cat-file', '-e', 'j1:README.md').code !== 0 && g(clone, 'show', 'j1:app.js').out === 'export const answer = 42', j3.out.split('\n').slice(-1)[0])
  }

  // ─── V. TESTS THAT NEED WHAT GIT DOES NOT HAVE ───────────────────────────────────────────────
  console.log('\n# V. a test needing an uncommitted file: said how to fix, then --test-copy / --test-setup')
  if (want('V')) {
    const a = await setup('v1')
    // The project's tests read an UNCOMMITTED .env.test (as real projects read a local env file).
    fs.writeFileSync(path.join(project, '.env.test'), 'ANSWER=42\n')
    await edit(a, 'test.js', "import fs from 'fs'\nimport { answer } from './app.js'\nconst want = Number(fs.readFileSync('.env.test', 'utf8').split('=')[1])\nif (answer !== want) { console.error('answer is ' + answer); process.exit(1) }\nconsole.log('all tests passed')\n")
    await edit(a, 'app.js', 'export const answer = 42\n')
    const before = tipOf('v1')
    const v1 = await cli(project, 'pr', 'v1', '--test', 'node test.js')
    T('V1 the clean checkout lacks .env.test: refused, and the refusal names --test-copy', v1.code !== 0 && /Q576/.test(v1.out) && /--test-copy/.test(v1.out) && tipOf('v1') === before, (v1.out.split('\n').find((l) => /--test-copy|Q576/.test(l)) || '').slice(0, 160))
    const v2 = await cli(project, 'pr', 'v1', '--test', 'node test.js', '--test-copy', '.env.test', '--save')
    T('V2 --test-copy .env.test --save: it lands, and the copy is saved for the branch', v2.code === 0 && tipOf('v1') !== before && g(project, 'config', '--get', 'hivecode.v1.testCopy').out === '.env.test' && /copied in/.test(v2.out), v2.out.split('\n').filter((l) => /saved|copied/.test(l)).join(' | ').slice(0, 200))
    T('V3 ...and the copied file never entered a commit', g(project, 'cat-file', '-e', 'v1:.env.test').code !== 0)
    await edit(a, 'app.js', 'export const answer = 42 // v4\n')
    const v4 = await cli(project, 'pr', 'v1')
    T('V4 a later plain `pr` uses the saved command and copy', v4.code === 0 && /saved for v1/.test(v4.out) && /copied in/.test(v4.out), v4.out.split('\n').filter((l) => /saved|copied|tests/.test(l)).join(' | ').slice(0, 200))
    await edit(a, 'app.js', 'export const answer = 42 // v5\n')
    const t5 = tipOf('v1')
    const v5 = await cli(project, 'pr', 'v1', '--test', 'node test.js', '--test-copy', '../outside.txt')
    T('V5 a --test-copy outside the repository is refused; nothing moves', v5.code !== 0 && /outside the repository/.test(v5.out) && tipOf('v1') === t5, (v5.out.match(/Q\d{3}[^\n]*/) || [''])[0].slice(0, 140))
    const v6 = await cli(project, 'pr', 'v1', '--test', 'node test.js', '--test-setup', 'node -e "process.exit(3)"')
    T('V6 a failing --test-setup refuses the landing, saying it was the setup', v6.code !== 0 && /test setup/.test(v6.out) && /failed \(exit 3\)/.test(v6.out) && tipOf('v1') === t5, (v6.out.match(/Q\d{3}[^\n]*/) || [''])[0].slice(0, 140))
    // Antigravity's review: a TRACKED file is the room's, and copying over it tests old code.
    await edit(a, 'app.js', 'export const answer = 42 // v7\n')
    const t7 = tipOf('v1')
    const v7 = await cli(project, 'pr', 'v1', '--test', 'node test.js', '--test-copy', 'app.js')
    T('V7 --test-copy of a file the commit contains is refused (it would test old code)', v7.code !== 0 && /part of the commit being tested/.test(v7.out) && tipOf('v1') === t7, (v7.out.match(/Q\d{3}[^\n]*/) || [''])[0].slice(0, 140))
    const v8 = await cli(project, 'pr', 'v1', '--test', 'node test.js', '--test-copy', 'C:foo.txt')
    T('V8 a drive-relative path (C:foo) is refused as outside the repository', v8.code !== 0 && /outside the repository/.test(v8.out) && tipOf('v1') === t7, (v8.out.match(/Q\d{3}[^\n]*/) || [''])[0].slice(0, 140))
    let linked = false
    try { fs.symlinkSync(path.join(tmp, 'parent', 'parent.txt'), path.join(project, 'leak.txt')); linked = true } catch { /* no symlink rights on this machine */ }
    if (linked) {
      const v9 = await cli(project, 'pr', 'v1', '--test', 'node test.js', '--test-copy', 'leak.txt')
      T('V9 a --test-copy that is a link is refused (a link can point anywhere)', v9.code !== 0 && /is a link/.test(v9.out) && tipOf('v1') === t7, (v9.out.match(/Q\d{3}[^\n]*/) || [''])[0].slice(0, 140))
      fs.rmSync(path.join(project, 'leak.txt'))
    } else console.log('  (V9 skipped: this machine cannot make symlinks without extra rights)')
  }

  // ─── E. THE RELAY LOST THE ROOM (last: restarts the relay) ───────────────────────────────────
  console.log('\n# E. an empty room after a relay restart never becomes a commit deleting the branch')
  if (want('E')) {
    const a = await setup('e1')
    await edit(a, 'app.js', 'export const answer = 42\n')
    const e0 = await cli(project, 'pr', 'e1')
    const landed = tipOf('e1')
    T('E0 (setup) the room\'s work landed', e0.code === 0 && g(project, 'show', 'e1:app.js').out === 'export const answer = 42', e0.out.split('\n').slice(-1)[0])
    for (const X of agents) { try { X._test.getSession().hive.stop() } catch { } }
    relay.kill()
    await sleep(1500)
    relay = await startRelay() // HIVE_PERSIST_DIR=off: every room is gone, as on Render's free plan
    const e1 = await cli(project, 'pr', 'e1')
    const files = g(project, 'ls-tree', '-r', '--name-only', 'e1').out.split('\n').filter(Boolean)
    T('E1 pr refuses with Q577 and says how to refill the room', e1.code !== 0 && /Q577/.test(e1.out) && /--reseed/.test(e1.out), (e1.out.match(/Q\d{3}[^\n]*/) || [e1.out.split('\n').slice(-1)[0]])[0])
    T('E2 ...the branch did not move and still has every file', tipOf('e1') === landed && Object.keys(FILES).every((f) => files.includes(f)), `files on e1: ${files.length}`)
  }
} catch (e) {
  T('the test itself crashed', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const X of agents) { try { X._test.getSession().hive.stop() } catch { } }
  try { relay.kill() } catch { }
  console.log(`\n${pass} passed, ${fail} failed`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
