// BUILD IDENTITY: which commit is this, not just which version.
//
//   node tests/build-identity-test.mjs
//
// A mixed-build room corrupts files silently, and the "joined on hivecode X" announcement is the only
// detector. On 28-29 Sep 2026 release-gate HEAD and the published tarball both said "0.12.2", and the
// hosted relay's /health said nothing, so "is the fix deployed?" was answered from its uptime. Each
// case below is one way buildOf() could name the wrong build -- or throw, which it must never do.
import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildOf, BUILD, VERSION, VERSION_LABEL } from '../hive-version.js'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-build-'))
const H1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', H2 = 'ffeeddccbbaa99887766554433221100ffeeddcc'
const mk = (rel, text) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const NOENV = {}

console.log('# a checkout knows its commit')
mk('plain/.git/HEAD', 'ref: refs/heads/main\n'); mk('plain/.git/refs/heads/main', H1 + '\n')
T('a branch ref', buildOf(path.join(tmp, 'plain'), NOENV) === H1.slice(0, 7))
mk('detached/.git/HEAD', H2 + '\n')
T('a detached HEAD', buildOf(path.join(tmp, 'detached'), NOENV) === H2.slice(0, 7))
mk('packed/.git/HEAD', 'ref: refs/heads/release-gate\n'); mk('packed/.git/packed-refs', `# pack-refs with: peeled fully-peeled sorted\n${H2} refs/heads/release-gate\n${H1} refs/tags/v1\n`)
T('a ref that lives only in packed-refs', buildOf(path.join(tmp, 'packed'), NOENV) === H2.slice(0, 7))
// a worktree: ".git" is a FILE; its branch lives in the main repo's common dir
mk('main/.git/refs/heads/claude-prod', H1 + '\n')
mk('main/.git/worktrees/wt/HEAD', 'ref: refs/heads/claude-prod\n'); mk('main/.git/worktrees/wt/commondir', '../..\n')
mk('wt/.git', `gitdir: ${path.join(tmp, 'main', '.git', 'worktrees', 'wt')}\n`)
T("a worktree (.git is a gitdir: file, the ref is in the common dir)", buildOf(path.join(tmp, 'wt'), NOENV) === H1.slice(0, 7))

console.log('# an npm install has no commit -- and must not borrow one')
fs.mkdirSync(path.join(tmp, 'npm'), { recursive: true })
T('no .git: no build', buildOf(path.join(tmp, 'npm'), NOENV) === '')
mk('userrepo/.git/HEAD', 'ref: refs/heads/main\n'); mk('userrepo/.git/refs/heads/main', H2 + '\n')
fs.mkdirSync(path.join(tmp, 'userrepo', 'node_modules', 'hivecode-mcp'), { recursive: true })
T("installed inside someone's repo: NOT that repo's commit (never walks up)",
  buildOf(path.join(tmp, 'userrepo', 'node_modules', 'hivecode-mcp'), NOENV) === '')

console.log('# broken input never throws')
mk('corrupt/.git/HEAD', 'garbage that is not a ref\n')
T('a corrupt HEAD', buildOf(path.join(tmp, 'corrupt'), NOENV) === '')
mk('dangling/.git/HEAD', 'ref: refs/heads/gone\n')
T('a ref that resolves nowhere', buildOf(path.join(tmp, 'dangling'), NOENV) === '')
mk('badwt/.git', 'not a gitdir line\n')
T('a .git file with no gitdir', buildOf(path.join(tmp, 'badwt'), NOENV) === '')

console.log('# a deployed relay')
T("Render's RENDER_GIT_COMMIT wins", buildOf(path.join(tmp, 'npm'), { RENDER_GIT_COMMIT: H1 }) === H1.slice(0, 7))
T('a RENDER_GIT_COMMIT that is not a hash is ignored', buildOf(path.join(tmp, 'plain'), { RENDER_GIT_COMMIT: 'main; rm -rf /' }) === H1.slice(0, 7))

console.log('# this checkout')
let head = ''
try { head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch { }
if (head) T('BUILD is this checkout\'s HEAD', BUILD === head, `BUILD=${BUILD} git=${head}`)
T('VERSION is untouched (the update notice compares it with the registry)', !VERSION.includes('+') && VERSION === JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version)
T('VERSION_LABEL carries the commit when there is one', VERSION_LABEL === (BUILD ? `${VERSION}+${BUILD}` : VERSION), VERSION_LABEL)
T('the join reply announces the LABEL, not the bare version',
  /joined on hivecode \$\{VERSION_LABEL\}/.test(fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8')))

console.log('# the relay says which build it is')
async function health(env) {
  const port = 24300 + Math.floor(Math.random() * 3000)
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...env, PORT: String(port), HIVE_PERSIST_DIR: 'off' } })
  await new Promise((res) => p.stdout.on('data', (d) => { if (/listening on/.test(d)) res() }))
  try { return await (await fetch(`http://127.0.0.1:${port}/health`)).json() } finally { p.kill() }
}
{
  const h = await health({ RENDER_GIT_COMMIT: H2 })
  T('/health reports version and the deployed commit', h.version === VERSION && h.build === H2.slice(0, 7), JSON.stringify({ version: h.version, build: h.build }))
}
{
  const h = await health({ RENDER_GIT_COMMIT: '' })
  T('/health from a checkout reports its HEAD', h.build === (BUILD || null), `build=${h.build}`)
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
console.log(`\n=== BUILD IDENTITY: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
