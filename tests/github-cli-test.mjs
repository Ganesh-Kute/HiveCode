// `npx -y hivecode-mcp@latest github start|status` -- what a stranger meets first.
//
//   node tests/github-cli-test.mjs
//
// Every refusal names the problem and the command that fixes it, before anything is written. GitHub
// is a fake answering in gh's shape; nothing here touches the network.
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const HG = await import(`file:///${ROOT.replace(/\\/g, '/')}/hive-github.js`)
let pass = 0
let fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const g = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-ghcli-'))
// On some machines the home folder is itself a git repo, and the temp folder sits inside it: stop
// git's search here, so "not a repo" means the same on every machine.
process.env.GIT_CEILING_DIRECTORIES = tmp

function repo(dir, originUrl, files = 2) {
  fs.mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.email', 'd@e.f'); g(dir, 'config', 'user.name', 'D')
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`)
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'init')
  if (originUrl) g(dir, 'remote', 'add', 'origin', originUrl)
  return dir
}

/** gh, faked: `answers` maps "METHOD path-without-query" to a response; everything is recorded. */
function fakeCall(answers = {}, { down = '' } = {}) {
  const calls = []
  const call = (method, apiPath, body) => {
    calls.push({ method, path: apiPath, body })
    if (down) return { status: 0, headers: {}, body: null, text: '', error: down }
    const key = `${method} ${apiPath.split('?')[0]}`
    const a = answers[key]
    if (typeof a === 'function') return a(body)
    if (a) return a
    return { status: 404, headers: {}, body: { message: 'Not Found' }, text: '' }
  }
  return { call, calls }
}
const ok = (body, status = 200) => ({ status, headers: {}, body, text: JSON.stringify(body) })
const github = (extra = {}) => ({
  'GET user': ok({ login: 'owner' }),
  'GET repos/acme/app': ok({ default_branch: 'main', private: true, permissions: { push: true } }),
  'GET repos/acme/app/labels': ok([]),
  'POST repos/acme/app/labels': (b) => ok(b, 201),
  'GET repos/acme/app/issues': ok([]),
  ...extra,
})
async function run(cwd, argv, call) {
  const out = []
  const code = await HG.main(argv, { cwd, call, log: (s) => out.push(String(s)), logErr: (s) => out.push(String(s)) })
  return { code, out: out.join('\n') }
}
const NODE = `"${process.execPath}"`

try {
  console.log('\n# refusals: each names the problem and the fix, and writes nothing')
  const notRepo = path.join(tmp, 'plain')
  fs.mkdirSync(notRepo)
  let r = await run(notRepo, ['start', '--agent', NODE], fakeCall(github()).call)
  T('CL1 outside a git repo', r.code === 1 && /Q601 .*not inside a git repository/.test(r.out), r.out)
  {
    // A home folder kept under git (this is so on the machine this was written on): run outside a
    // project, the "repository" is the home folder, and that is what it should say.
    const home = repo(path.join(tmp, 'home'), '')
    const sub = path.join(home, 'Documents')
    fs.mkdirSync(sub)
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = home; process.env.USERPROFILE = home
    try {
      r = await run(sub, ['start', '--agent', NODE], fakeCall(github()).call)
      T('CL1b inside a home folder that is a git repo: says so, not "origin (none)"', r.code === 1 && /is inside the git repository that is your home folder/.test(r.out), r.out)
    } finally {
      for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  }
  const gitlab = repo(path.join(tmp, 'gitlab'), 'https://gitlab.com/acme/app.git')
  r = await run(gitlab, ['start', '--agent', NODE], fakeCall(github()).call)
  T('CL2 an origin that is not github.com', r.code === 1 && /Q601 origin \(https:\/\/gitlab\.com/.test(r.out), r.out)

  const app = repo(path.join(tmp, 'app'), 'https://github.com/acme/app.git')
  r = await run(app, ['start', '--agent', NODE], fakeCall({}, { down: 'gh is not installed' }).call)
  T('CL3 gh missing: says where to get it', r.code === 1 && /Q600 GitHub CLI \(gh\) is not installed.*cli\.github\.com.*gh auth login/s.test(r.out), r.out)
  r = await run(app, ['start', '--agent', NODE], fakeCall({ 'GET user': { status: 401, headers: {}, body: { message: 'Bad credentials' }, text: '' } }).call)
  T('CL4 gh logged out: says gh auth login', r.code === 1 && /Q600 .*gh auth login/.test(r.out), r.out)
  r = await run(app, ['start'], fakeCall(github()).call)
  T('CL5 no --agent: asks for one and shows the Claude Code line', r.code === 2 && /Q602 say which agent/.test(r.out) && /claude -p --output-format json/.test(r.out))
  r = await run(app, ['start', '--agent', 'no-such-agent-cli-xyz -p'], fakeCall(github()).call)
  T('CL6 an agent that is not installed', r.code === 1 && /Q602 "no-such-agent-cli-xyz" is not installed/.test(r.out), r.out)
  r = await run(app, ['start', '--agent', NODE, '--max-runs', '0'], fakeCall(github()).call)
  T('CL7 a limit that is not a positive number', r.code === 2 && /Q602 --max-runs must be a positive number/.test(r.out), r.out)
  r = await run(app, ['start', '--agent', NODE], fakeCall(github({ 'GET repos/acme/app': ok({ default_branch: 'main', private: false, permissions: { push: false } }) })).call)
  T('CL8 an account that cannot push', r.code === 1 && /Q601 .*cannot push to acme\/app/.test(r.out), r.out)
  T('CL9 none of those left a state file behind', !fs.existsSync(path.join(app, '.git', 'hivecode', 'github.json')))

  console.log('\n# a good start')
  const f = fakeCall(github())
  r = await run(app, ['start', '--agent', NODE, '--once'], f.call)
  T('CS1 a first start runs one pass and exits 0', r.code === 0, r.out.split('\n').slice(-2).join(' | '))
  const made = f.calls.filter((c) => c.method === 'POST' && c.path === 'repos/acme/app/labels').map((c) => c.body.name)
  T('CS2 it made the two labels', made.includes('hivecode') && made.includes('hivecode:needs-human') && /created the label "hivecode"/.test(r.out))
  T('CS3 a private repo on the public relay is warned about once', (r.out.match(/is private, and rooms will run on the public Hivecode relay/g) || []).length === 1)
  const st = JSON.parse(fs.readFileSync(path.join(app, '.git', 'hivecode', 'github.json'), 'utf8'))
  T('CS4 its settings are saved in .git, never committed', st.config && st.config.flags && st.config.flags.agent === NODE && !g(app, 'status', '--porcelain').stdout.trim())
  T('CS5 the lock is let go when it exits', !fs.existsSync(path.join(app, '.git', 'hivecode', 'watcher.lock')))
  const f2 = fakeCall(github({ 'GET repos/acme/app/labels': ok([{ name: 'hivecode' }, { name: 'hivecode:needs-human' }]) }))
  r = await run(app, ['start', '--once'], f2.call)
  T('CS6 the next start remembers the agent, and makes no labels twice', r.code === 0 && !f2.calls.some((c) => c.method === 'POST'))
  r = await run(app, ['start', '--once', '--relay', 'wss://relay.example.com'], fakeCall(github()).call)
  T('CS7 on your own relay there is no public-relay warning', r.code === 0 && !/public Hivecode relay/.test(r.out))

  console.log('\n# one watcher per clone')
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  fs.writeFileSync(path.join(app, '.git', 'hivecode', 'watcher.lock'), JSON.stringify({ pid: sleeper.pid, at: 'earlier' }))
  r = await run(app, ['start', '--once'], fakeCall(github()).call)
  T('CW1 a second watcher on the same clone is refused, naming the first', r.code === 1 && new RegExp(`Q605 a watcher is already running for this repo \\(process ${sleeper.pid}`).test(r.out), r.out)
  sleeper.kill()
  await new Promise((res) => sleeper.on('exit', res))
  r = await run(app, ['start', '--once'], fakeCall(github()).call)
  T('CW2 a lock whose process is gone is taken over', r.code === 0, r.out.split('\n').slice(-1)[0])

  console.log('\n# a repository too big for the public relay')
  const big = repo(path.join(tmp, 'big'), 'https://github.com/acme/app.git', 5001)
  r = await run(big, ['start', '--agent', NODE, '--once'], fakeCall(github()).call)
  T('CB1 refused on the public relay, with both ways out', r.code === 1 && /Q608 acme\/app has 5001 files/.test(r.out) && /npx hivecode-relay/.test(r.out) && /--allow-large/.test(r.out), r.out)
  r = await run(big, ['start', '--agent', NODE, '--once', '--relay', 'wss://relay.example.com'], fakeCall(github()).call)
  T('CB2 fine on your own relay', r.code === 0)

  console.log('\n# status')
  r = await run(app, ['status'], fakeCall({}).call)
  T('CT1 status reads only the local file: no call to GitHub', r.code === 0 && /Hivecode on GitHub for acme\/app/.test(r.out))
  r = await run(app, ['nonsense'], fakeCall({}).call)
  T('CT2 an unknown subcommand prints the usage', r.code === 2 && /github start --agent/.test(r.out))
} catch (err) {
  T(`no exception (${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err})`, false)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
