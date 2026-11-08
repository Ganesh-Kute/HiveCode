// BRANCH ROOMS (hive-branch.js): a Hivecode room bound to a git branch.
//
//   node tests/branch-test.mjs
//
// Real relay, real git, real MCP agents. Each group is a way the feature hurts somebody when it is
// wrong. HIVE_HOME sits INSIDE ANOTHER REPOSITORY on purpose: that is the case where a git command
// run in a room folder would otherwise reach a real repo (a home directory under git, a monorepo).
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (25200 + (process.pid % 16000))
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-branch-'))
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
const bin = (dir, rel) => { try { return fs.readFileSync(path.join(dir, ...rel.split('/'))) } catch { return Buffer.alloc(0) } }
async function waitUntil(pred, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (pred()) return true } catch { } await sleep(200) }
  return false
}
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

const parent = path.join(tmp, 'parent')
repo(parent, { 'parent.txt': 'the repository a room folder must never reach\n' })
process.env.HIVE_HOME = path.join(parent, 'hivehome')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), crypto.randomBytes(64)])
const BIG = 'x'.repeat(1_100_000) + '\n'
const FILES = {
  'app.js': 'export const answer = 41\n',
  'lib/util.js': 'export const twice = (n) => n * 2\n',
  'README.md': '# demo\n',
  '.gitignore': 'dist/\n',
  'logo.png': PNG,            // binary: the room never carries it
  'big.txt': BIG,             // over 1 MB: the room never carries it
  '.env.example': 'API_KEY=\n', // always-ignored ('.env.*'): the room never carries it
  // A key committed in a text file: the room never carries it either (hive-secrets.js). Made here,
  // at run time, so this test file holds no key for a scanner to find.
  'config/keys.js': `export const stripe = '${'sk' + '_live_' + crypto.randomBytes(18).toString('base64url').replace(/[-_]/g, 'q')}'\n`,
}
const TEXT = ['app.js', 'lib/util.js', 'README.md', '.gitignore']

function startRelay() {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
    p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  })
}
let relay = await startRelay()
const url = (f, q = '') => `file:///${ROOT.replace(/\\/g, '/')}/${f}${q}`
const HB = await import(url('hive-branch.js'))
const mcp = (tag) => import(url('hive-mcp.js', `?${tag}`))
async function cli(cwd, ...argv) {
  const out = []
  const code = await HB.main(argv, { cwd, log: (s) => out.push(String(s)), logErr: (s) => out.push(String(s)) })
  return { code, out: out.join('\n') }
}

const agents = []
try {
  const project = path.join(tmp, 'project')
  repo(project, FILES)
  const mainTip = g(project, 'rev-parse', 'HEAD').out

  // ─── A. BINDING: a random room, the checkout untouched, a verified seed ───────────────────
  console.log('\n# A. branch <name> binds a room to the branch')
  const a1 = await cli(project, 'branch', 'feat', '--relay', RELAY)
  T('A1 branch creates, seeds and binds a room', a1.code === 0 && /Room ready for branch feat/.test(a1.out), a1.out.split('\n').slice(0, 2).join(' | '))
  const link = g(project, 'config', '--get', 'hivecode.feat.room').out
  const roomId = link.split('|')[1] || ''
  T('A2 the checkout was not switched and nothing in it changed', g(project, 'symbolic-ref', '--short', 'HEAD').out === 'main' && g(project, 'status', '--porcelain').out === '')
  T('A3 the branch exists, at the commit it was cut from', g(project, 'rev-parse', 'refs/heads/feat').out === mainTip)
  T('A4 the room id is random, never the branch name', /^room-[A-Za-z0-9_-]{17,}$/.test(roomId) && !/feat/i.test(roomId), roomId)
  T('A5 the room holds the text files; binary, large, ignored and key-holding ones are named as filled from git', /4 file\(s\) in the room/.test(a1.out) && /4 more/.test(a1.out), a1.out.slice(-240))
  const a6 = await cli(project, 'branch', 'feat', '--relay', RELAY)
  T('A6 running it again is idempotent: the same room, and it says what is in it', a6.code === 0 && a6.out.includes(link) && /already has a room/.test(a6.out) && /4 file\(s\) in it/.test(a6.out), a6.out.split('\n')[0])
  const project2 = path.join(tmp, 'project2')
  repo(project2, { 'x.js': 'x\n' })
  await cli(project2, 'branch', 'feat', '--relay', RELAY)
  const link2 = g(project2, 'config', '--get', 'hivecode.feat.room').out
  T('A7 the same branch name in another repo gets a different room', !!link2 && link2 !== link)
  // GIT_CEILING_DIRECTORIES makes "outside any repo" true on every machine: without it, a temp
  // directory under a home directory that is itself a git repo is INSIDE that repo.
  const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain)
  const ceilingWas = process.env.GIT_CEILING_DIRECTORIES
  process.env.GIT_CEILING_DIRECTORIES = tmp
  const a8 = await cli(plain, 'branch', 'feat', '--relay', RELAY)
  if (ceilingWas === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = ceilingWas
  T('A8 outside a git repo it refuses with Q560', a8.code === 1 && /Q560/.test(a8.out) && /not inside a git repository/.test(a8.out), a8.out.slice(0, 100))
  // ...and a folder whose enclosing repository is the HOME DIRECTORY is refused, not bound: its
  // files would be published. Simulated by pointing the home directory at a repo.
  const homeWas = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.USERPROFILE = project2; process.env.HOME = project2
  const inside = path.join(project2, 'not-a-repo'); fs.mkdirSync(inside)
  const a8b = await cli(inside, 'branch', 'homebound', '--relay', RELAY)
  for (const [k, v] of Object.entries(homeWas)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  T('A8b a folder inside a home-directory repo is refused (Q560), and nothing is created', a8b.code === 1 && /home directory/.test(a8b.out) && g(project2, 'rev-parse', '--verify', '--quiet', 'refs/heads/homebound').code !== 0 && g(project2, 'config', '--get', 'hivecode.homebound.room').code !== 0, a8b.out.slice(0, 100))
  // ...and when the home directory is reached through a link (macOS, 6 Oct 2026: git names the
  // repository's top with links resolved, the home directory comes as written).
  const linkedHome = path.join(tmp, 'home-link')
  fs.symlinkSync(project2, linkedHome, 'junction')
  process.env.USERPROFILE = linkedHome; process.env.HOME = linkedHome
  const a8c = await cli(path.join(linkedHome, 'not-a-repo'), 'branch', 'homebound2', '--relay', RELAY)
  for (const [k, v] of Object.entries(homeWas)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  T('A8c ...also when the home directory is reached through a link', a8c.code === 1 && /home directory/.test(a8c.out) && g(project2, 'rev-parse', '--verify', '--quiet', 'refs/heads/homebound2').code !== 0 && g(project2, 'config', '--get', 'hivecode.homebound2.room').code !== 0, a8c.out.slice(0, 100))
  const seedDir = g(project, 'config', '--get', 'hivecode.feat.seed').out
  const seedGit = g(seedDir, 'status')
  T('A9 the seed folder is marked: git refuses to run in it', !!seedDir && seedGit.code !== 0 && /(not a git repository|gitfile does not point to a valid repository)/i.test(seedGit.err), seedGit.err.slice(0, 90))

  // ─── B. AGENTS JOIN BY BRANCH: own folder each, whole tree, git refused ────────────────────
  console.log('\n# B. hive_join { branch }')
  const A = await mcp('builder'), B = await mcp('tester')
  agents.push(A, B)
  const ja = textOf(await A._test.callTool('hive_join', { branch: 'feat', repo: project, name: 'Builder', owner: 'Dev' }))
  const jb = textOf(await B._test.callTool('hive_join', { branch: 'feat', repo: project, name: 'Tester', owner: 'Dev' }))
  const dirA = A._test.getSession().dir, dirB = B._test.getSession().dir
  T('B1 the join says it is a branch room and where to edit', /BRANCH ROOM/.test(ja) && ja.includes(dirA) && /BRANCH ROOM/.test(jb), ja.split('\n')[0])
  T('B2 each agent has its own folder, side by side in the room', path.resolve(dirA) !== path.resolve(dirB) && path.dirname(path.resolve(dirA)) === path.dirname(path.resolve(dirB)))
  await waitUntil(() => TEXT.every((f) => read(dirA, f) === FILES[f] && read(dirB, f) === FILES[f]), 15000)
  T('B3 every text file of the branch arrived byte-exact', TEXT.every((f) => read(dirA, f) === FILES[f] && read(dirB, f) === FILES[f]))
  T('B4 binary, over-1MB, always-ignored and key-holding files were filled from git', bin(dirA, 'logo.png').equals(PNG) && read(dirA, 'big.txt') === BIG && read(dirA, '.env.example') === FILES['.env.example'] && read(dirA, 'config/keys.js') === FILES['config/keys.js'] && /Filled from git: 4/.test(ja))
  const roomA = A._test.getSession().hive
  T('B4b the key-holding file never reached the room, and nobody announced it there',
    !roomA.doc.getMap('manifest').has('config/keys.js') && !roomA.doc.getArray('chat').toArray().some((m) => /config\/keys\.js/.test(String(m.text || ''))),
    JSON.stringify({ inRoom: roomA.doc.getMap('manifest').has('config/keys.js'), said: roomA.doc.getArray('chat').toArray().map((m) => String(m.text || '')).filter((t) => /keys\.js/.test(t)) }))
  const inA = g(dirA, 'status')
  T('B5 git refuses inside an agent folder, although it sits inside another repo', inA.code !== 0 && /(not a git repository|gitfile does not point to a valid repository)/i.test(inA.err), inA.err.slice(0, 90))
  const jn = textOf(await A._test.callTool('hive_join', { branch: 'nobound', repo: project, name: 'Builder' }))
  T('B6 a branch with no room is refused with the next step, and the session is untouched', /Q562/.test(jn) && /npx -y hivecode-mcp@latest branch nobound/.test(jn) && /session is untouched/.test(jn) && A._test.getSession().dir === dirA)
  const jl = textOf(await A._test.callTool('hive_join', { branch: 'feat', link, repo: project, name: 'Builder' }))
  T('B7 branch and link together are refused, and the session is untouched', /not both/.test(jl) && A._test.getSession().dir === dirA)

  // ─── C. GIT CANNOT REACH THE ROOM ─────────────────────────────────────────────────────────
  console.log('\n# C. no git command reaches the room')
  const manA = A._test.getSession().hive.doc.getMap('manifest')
  const room0 = [...manA.keys()].sort().join(',')
  const s1 = g(dirA, 'stash', '-u'), s2 = g(dirA, 'clean', '-fdx'), s3 = g(dirA, 'checkout', '--', '.')
  T('C1 stash -u, clean -fdx and checkout run inside an agent folder all refuse', [s1, s2, s3].every((r) => r.code !== 0),
    [s1, s2, s3].map((r) => `${r.code}:${(r.err || r.out).split('\n')[0].slice(0, 70)}`).join(' | '))
  g(project, 'checkout', '-q', '-b', 'other')
  fs.writeFileSync(path.join(project, 'app.js'), 'export const answer = 0 // other\n'); g(project, 'commit', '-qam', 'other')
  fs.writeFileSync(path.join(project, 'lib', 'util.js'), 'dirty\n'); g(project, 'stash', '-q'); g(project, 'stash', 'drop', '-q')
  g(project, 'reset', '-q', '--hard'); g(project, 'checkout', '-q', 'main'); g(project, 'branch', '-q', '-D', 'other')
  await sleep(2500)
  T('C2 git in the developer\'s repo (checkout, commit, stash, reset) changed nothing in the room',
    TEXT.every((f) => read(dirA, f) === FILES[f] && read(dirB, f) === FILES[f]) && [...manA.keys()].sort().join(',') === room0)

  // ─── D. A `.git` FILE IS NEVER PUBLISHED ───────────────────────────────────────────────────
  console.log('\n# D. .git files stay local')
  // Watched for the whole window, not checked at the end: before the fix the file was published and
  // then retracted by the next safety-net scan, so an end-state check saw nothing wrong.
  const sawGit = []
  const watchGit = (m) => m.observe((ev) => { for (const [k, c] of ev.changes.keys) if (/(^|\/)\.git$/.test(k)) sawGit.push(`${k}:${c.action}`) })
  watchGit(manA); watchGit(B._test.getSession().hive.doc.getMap('manifest'))
  fs.mkdirSync(path.join(dirA, 'vendor', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dirA, 'vendor', 'sub', 'lib.js'), 'module.exports = 1\n')
  await waitUntil(() => read(dirB, 'vendor/sub/lib.js') === 'module.exports = 1\n', 10000)
  // B's folder holds a submodule here: vendor/sub/.git is B's OWN pointer to B's git directory.
  const OWN = 'gitdir: /only/on/the/machine/of/B\n'
  fs.writeFileSync(path.join(dirB, 'vendor', 'sub', '.git'), OWN)
  await sleep(1000)
  // Written AFTER the directory is known, so each is one plain watcher event (not a folder rescan).
  fs.writeFileSync(path.join(dirA, 'vendor', 'sub', '.git'), 'gitdir: /only/on/the/machine/of/A\n')
  fs.writeFileSync(path.join(dirA, '.git'), HB.NOT_A_CHECKOUT) // the root marker, touched
  await sleep(1500)
  fs.appendFileSync(path.join(dirA, 'vendor', 'sub', '.git'), '\n') // and changed again
  await sleep(3000)
  T('D1 a .git FILE never enters the room, not even briefly', sawGit.length === 0, sawGit.join(' '))
  T('D2 a peer\'s own .git file (a submodule pointer) is left exactly as it was', read(dirB, 'vendor/sub/.git') === OWN, JSON.stringify(read(dirB, 'vendor/sub/.git')))

  // ─── H. A DELETION IN THE ROOM IS NOT UNDONE FROM GIT ─────────────────────────────────────
  console.log('\n# H. a joiner is not handed back what the room deleted')
  fs.rmSync(path.join(dirA, 'README.md'))
  await waitUntil(() => read(dirB, 'README.md') === null, 10000)
  const C = await mcp('late'); agents.push(C)
  await C._test.callTool('hive_join', { branch: 'feat', repo: project, name: 'Late', owner: 'Dev' })
  const dirC = C._test.getSession().dir
  await waitUntil(() => read(dirC, 'app.js') === FILES['app.js'], 15000)
  await sleep(2000)
  T('H1 README.md, deleted in the room, is not recreated by a later joiner', read(dirC, 'README.md') === null && !manA.has('README.md'))
  T('H2 ...which still gets what the room cannot carry', bin(dirC, 'logo.png').equals(PNG))
  try { C._test.getSession().hive.stop() } catch { }

  // ─── E. LANDING: one commit per agent, deletions too, the checkout never touched ──────────
  console.log('\n# E. pr <name> lands the room on the branch')
  fs.writeFileSync(path.join(dirA, 'app.js'), 'export const answer = 42\n')
  fs.mkdirSync(path.join(dirB, 'tests'), { recursive: true })
  fs.writeFileSync(path.join(dirB, 'tests', 'answer.test.js'), 'import { answer } from "../app.js"\nconsole.assert(answer === 42)\n')
  fs.writeFileSync(path.join(dirB, '.gitignore'), 'dist/\ncoverage/\n') // a dotfile edit must land too
  await waitUntil(() => read(dirB, 'app.js') === 'export const answer = 42\n' && read(dirA, 'tests/answer.test.js') && read(dirA, '.gitignore') === 'dist/\ncoverage/\n', 10000)
  await sleep(1500)
  // THE DEVELOPER'S OWN GIT HOOKS, all failing. Measured 25 Oct 2026: a post-checkout hook that
  // exits 1 (vexp's) made `pr` fail with Q563 although git had made the worktree. Landing works in
  // our scratch worktree, where their hooks have no business; in their checkout the hooks stay.
  const hooksDir = g(project, 'rev-parse', '--git-path', 'hooks').out
  const hookDir = path.isAbsolute(hooksDir) ? hooksDir : path.join(project, hooksDir)
  const HOOKS = ['post-checkout', 'pre-commit', 'commit-msg']
  fs.mkdirSync(hookDir, { recursive: true })
  for (const h of HOOKS) { fs.writeFileSync(path.join(hookDir, h), '#!/bin/sh\necho "the developer hook ran" >&2\nexit 1\n'); fs.chmodSync(path.join(hookDir, h), 0o755) }
  const featBefore = g(project, 'rev-parse', 'feat').out
  const e1 = await cli(project, 'pr', 'feat', '--dry-run')
  T('E1 --dry-run plans, names the deletion, and changes nothing', e1.code === 0 && g(project, 'rev-parse', 'feat').out === featBefore && /would delete 1 file\(s\) the room deleted: README\.md/.test(e1.out), e1.out.split('\n').slice(-1)[0])
  // The mirror's files arrive late on purpose: the landing must wait for the WHOLE room.
  process.env.HIVE_TEST_OPEN_DELAY_MS = '4000'
  const e2 = await cli(project, 'pr', 'feat')
  delete process.env.HIVE_TEST_OPEN_DELAY_MS
  const log2 = g(project, 'log', '--format=%an|%s', `${featBefore}..feat`).out.split('\n').filter(Boolean)
  T('E2 pr lands one commit per agent, plus the room\'s deletion', e2.code === 0 && log2.some((l) => l.startsWith('Builder|')) && log2.some((l) => l.startsWith('Tester|')) && log2.some((l) => /^hivecode-room\|Room: delete README\.md/.test(l)), log2.join(' ; ') || e2.out.slice(-200))
  T('E3 the branch holds the room\'s work: the edit, the new file, the dotfile, the deletion',
    g(project, 'show', 'feat:app.js').out === 'export const answer = 42' && g(project, 'cat-file', '-e', 'feat:tests/answer.test.js').code === 0 &&
    g(project, 'show', 'feat:.gitignore').out === 'dist/\ncoverage/' && g(project, 'cat-file', '-e', 'feat:README.md').code !== 0)
  T('E4 the developer\'s checkout was never touched', g(project, 'symbolic-ref', '--short', 'HEAD').out === 'main' && g(project, 'status', '--porcelain').out === '' && g(project, 'rev-parse', 'main').out === mainTip)
  T('E5 no temporary worktree or branch is left behind', g(project, 'worktree', 'list', '--porcelain').out.split('\n').filter((l) => l.startsWith('worktree ')).length === 1 && !g(project, 'branch', '--list', 'hivecode-land/*').out)
  const own = g(project, 'commit', '--allow-empty', '-m', 'the developer commits')
  T('E5b the developer\'s failing git hooks did not stop the landing, and still run on their own commits', e2.code === 0 &&
    HOOKS.every((h) => fs.existsSync(path.join(hookDir, h))) && own.code !== 0 && /the developer hook ran/.test(own.err) && g(project, 'config', '--get', 'core.hooksPath').code !== 0, own.err.slice(0, 120))
  for (const h of HOOKS) fs.rmSync(path.join(hookDir, h))

  // THE SECOND RUN IS THE ONE THAT PUSHES. Measured 1 Nov 2026 (antigravity-3): the branch output
  // suggests `pr <name>` to look first, then `--pr` to push and open the PR. After a plain `pr` has
  // landed everything, `pr --push` found nothing new to land and returned 0 BEFORE pushing: success
  // printed, nothing pushed. A local bare origin, so nothing leaves this machine.
  const origin = path.join(tmp, 'origin.git')
  g(tmp, 'init', '-q', '--bare', origin)
  g(project, 'remote', 'add', 'origin', origin)
  const e5c = await cli(project, 'pr', 'feat', '--push')
  T('E5c pr --push after a plain pr really pushes: the origin has the branch at its tip', e5c.code === 0 && g(origin, 'rev-parse', 'feat').out === g(project, 'rev-parse', 'feat').out, e5c.out.split('\n').slice(-2).join(' | '))

  const wtFeat = path.join(tmp, 'feat-wt')
  g(project, 'worktree', 'add', '-q', wtFeat, 'feat')
  fs.writeFileSync(path.join(dirA, 'app.js'), 'export const answer = 43\n')
  await waitUntil(() => read(dirB, 'app.js') === 'export const answer = 43\n', 10000); await sleep(1500)
  const e6 = await cli(project, 'pr', 'feat')
  T('E6 a branch checked out in a clean worktree is fast-forwarded there', e6.code === 0 && read(wtFeat, 'app.js') === 'export const answer = 43\n' && g(wtFeat, 'status', '--porcelain').out === '', e6.out.slice(-160))
  fs.writeFileSync(path.join(wtFeat, 'app.js'), 'uncommitted work\n')
  fs.writeFileSync(path.join(dirA, 'app.js'), 'export const answer = 44\n')
  await waitUntil(() => read(dirB, 'app.js') === 'export const answer = 44\n', 10000); await sleep(1500)
  const tip7 = g(project, 'rev-parse', 'feat').out
  const e7 = await cli(project, 'pr', 'feat')
  T('E7 ...and refused (Q571) when that worktree has uncommitted changes; nothing moves', e7.code !== 0 && /Q571/.test(e7.out) && g(project, 'rev-parse', 'feat').out === tip7 && read(wtFeat, 'app.js') === 'uncommitted work\n')
  g(project, 'worktree', 'remove', '--force', wtFeat)

  const human = path.join(tmp, 'human-wt')
  g(project, 'worktree', 'add', '-q', human, 'feat')
  fs.writeFileSync(path.join(human, 'lib', 'util.js'), 'export const twice = (n) => n + n // human\n'); g(human, 'commit', '-qam', 'human edit')
  g(project, 'worktree', 'remove', '--force', human)
  const tipH = g(project, 'rev-parse', 'feat').out
  fs.writeFileSync(path.join(dirA, 'lib', 'util.js'), 'export const twice = (n) => 2 * n\n')
  await waitUntil(() => read(dirB, 'lib/util.js') === 'export const twice = (n) => 2 * n\n', 10000); await sleep(1500)
  const e8 = await cli(project, 'pr', 'feat')
  T('E8 a file the branch changed outside the room is not written over (Q506); nothing moves', e8.code !== 0 && /Q506/.test(e8.out) && g(project, 'rev-parse', 'feat').out === tipH, (e8.out.match(/Q\d{3}[^\n]*/) || [''])[0])
  fs.rmSync(path.join(dirA, 'lib', 'util.js'))
  await waitUntil(() => read(dirB, 'lib/util.js') === null, 10000); await sleep(1500)
  const e9 = await cli(project, 'pr', 'feat')
  T('E9 deleting a file the branch changed outside the room is refused (Q572); nothing moves', e9.code !== 0 && /Q572/.test(e9.out) && /human edit/.test(e9.out) && g(project, 'rev-parse', 'feat').out === tipH, (e9.out.match(/Q\d{3}[^\n]*/) || [''])[0])

  // ─── G. A TEAMMATE, IN THEIR OWN CLONE ─────────────────────────────────────────────────────
  console.log('\n# G. --join in a clone')
  const clone = path.join(tmp, 'clone')
  g(tmp, 'clone', '-q', project, clone)
  const j1 = await cli(clone, 'branch', 'feat', '--join', link)
  T('G1 a teammate records the room in their clone', j1.code === 0 && g(clone, 'config', '--get', 'hivecode.feat.room').out === link)
  const j2 = await cli(clone, 'branch', 'feat', '--join', link2)
  T('G2 ...and cannot silently rebind it to another room (Q567)', j2.code !== 0 && /Q567/.test(j2.out) && g(clone, 'config', '--get', 'hivecode.feat.room').out === link)
  const M = await mcp('mate'); agents.push(M)
  await M._test.callTool('hive_join', { branch: 'feat', repo: clone, name: 'Mate', owner: 'Pal' })
  const dirM = M._test.getSession().dir
  await waitUntil(() => read(dirM, 'app.js') === 'export const answer = 44\n', 15000)
  T('G3 the teammate\'s agent gets the room, and binary files from origin/feat', read(dirM, 'app.js') === 'export const answer = 44\n' && bin(dirM, 'logo.png').equals(PNG))
  try { M._test.getSession().hive.stop() } catch { }

  // ─── F. THE RELAY LOSES THE ROOM ───────────────────────────────────────────────────────────
  console.log('\n# F. an empty room after a relay wipe')
  const f1 = await cli(project, 'branch', 'feat', '--reseed')
  T('F1 --reseed refuses while the room still holds files (Q568)', f1.code !== 0 && /Q568/.test(f1.out))
  for (const X of [A, B]) { try { X._test.getSession().hive.stop() } catch { } }
  relay.kill()
  await sleep(1500)
  relay = await startRelay()
  const f2 = await cli(project, 'branch', 'feat')
  T('F2 a re-run notices the relay lost the room and says how to recover', f2.code === 0 && /THE ROOM IS EMPTY/.test(f2.out), f2.out.split('\n')[0])
  const f3 = await cli(project, 'branch', 'feat', '--reseed')
  T('F3 --reseed refills the empty room from the branch', f3.code === 0 && /Room refilled/.test(f3.out), f3.out.split('\n')[0])
  const D = await mcp('after'); agents.push(D)
  await D._test.callTool('hive_join', { branch: 'feat', repo: project, name: 'After', owner: 'Dev' })
  const dirD = D._test.getSession().dir
  const tipApp = g(project, 'show', 'feat:app.js').out + '\n'
  await waitUntil(() => read(dirD, 'app.js') === tipApp, 15000)
  T('F4 a joiner after the refill gets the branch as it is now', read(dirD, 'app.js') === tipApp && read(dirD, 'README.md') === null && read(dirD, 'lib/util.js') === 'export const twice = (n) => n + n // human\n')

  // ─── I. BRANCH OUTPUT POLISH & ONBOARDING EDGE CASES ───────────────────────────────────────
  console.log('\n# I. branch output polish & onboarding edge cases')
  // I1: Zero-commit repository gives clear, actionable error
  const emptyRepo = path.join(tmp, 'empty-repo')
  fs.mkdirSync(emptyRepo)
  g(emptyRepo, 'init', '-q')
  const i1 = await cli(emptyRepo, 'branch', 'feat', '--relay', RELAY)
  T('I1 zero-commit repo refuses with helpful Q562', i1.code === 1 && /Q562/.test(i1.out) && /has no commits yet, so there's nothing to put in a room/.test(i1.out), i1.out.slice(0, 140))

  // I2: Uncommitted dirty checkout warning lists files
  const dirtyRepo = path.join(tmp, 'dirty-repo')
  repo(dirtyRepo, { 'clean.js': 'clean\n' })
  fs.writeFileSync(path.join(dirtyRepo, 'dirty1.js'), 'dirty\n')
  fs.writeFileSync(path.join(dirtyRepo, 'dirty2.js'), 'dirty\n')
  const i2 = await cli(dirtyRepo, 'branch', 'feat', '--relay', RELAY)
  T('I2 uncommitted changes are named in branch output', i2.code === 0 && /2 file\(s\) with uncommitted changes are not in the room: dirty1\.js, dirty2\.js/.test(i2.out), (i2.out.match(/.*uncommitted changes.*/) || [''])[0])

  // I3: Dual-folder mental model is explicitly stated in branch output
  const linkFeat = g(project, 'config', '--get', 'hivecode.feat.room').out
  const roomFeat = linkFeat.split('|')[1]
  T('I3 branch output names ~/hivecode/<room>/ and untouched checkout', a1.code === 0 && a1.out.includes(`~/hivecode/${roomFeat}/`) && /Your checkout here doesn't change until you run pr/.test(a1.out))

  // I4: CWD mismatch in resolveForJoin gives repo hint
  const otherRepo = path.join(tmp, 'other-repo')
  repo(otherRepo, { 'clean.js': 'clean\n' })
  const i4 = HB.resolveForJoin({ branch: 'feat', repo: otherRepo })
  T('I4 resolveForJoin Q562 hints to pass repo path', !i4.ok && /Q562/.test(i4.message) && /If your repository is elsewhere, pass repo: "\/path\/to\/repo" in hive_join/.test(i4.message), i4.message)

  // I5: Stale --paths comment in hive-token.js
  const tokenHelp = fs.readFileSync(path.join(ROOT, 'hive-token.js'), 'utf8')
  T('I5 hive-token.js --paths comment says enforced by relay scopeCheck', /--paths\s+comma globs for path scoping \(enforced by relay scopeCheck in token-gated rooms\)/.test(tokenHelp))

  // I6: agentLine tells each agent to pick a name of its own without angle brackets
  T('I6 agentLine instructs each agent to pick a name of its own', a1.code === 0 && a1.out.includes('as a name of your own (each agent picks a different one)') && !a1.out.includes('<a name of its own>'))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const X of agents) { try { X._test.getSession() && X._test.getSession().hive.stop() } catch { } }
  try { relay.kill() } catch { }
  await sleep(500)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n=== BRANCH ROOMS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
