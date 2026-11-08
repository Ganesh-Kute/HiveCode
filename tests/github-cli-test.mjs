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
// A mutant run points this at a changed copy beside the real one (scripts/github-mutants.mjs).
const HG = await import(`file:///${ROOT.replace(/\\/g, '/')}/${process.env.HIVE_GITHUB_MODULE || 'hive-github.js'}`)
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
  T('CL1 outside a git repo', r.code === 2 && /Q601 .*not inside a git repository/.test(r.out), r.out)
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
      T('CL1b inside a home folder that is a git repo: says so, not "origin (none)"', r.code === 2 && /is inside the git repository that is your home folder/.test(r.out), r.out)
    } finally {
      for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  }
  const gitlab = repo(path.join(tmp, 'gitlab'), 'https://gitlab.com/acme/app.git')
  r = await run(gitlab, ['start', '--agent', NODE], fakeCall(github()).call)
  T('CL2 an origin that is not github.com', r.code === 2 && /Q601 origin \(https:\/\/gitlab\.com/.test(r.out), r.out)
  {
    // A token in the remote URL (https://x-access-token:<token>@host/...) is common in CI and scripts.
    // A refusal that quotes the origin must not print it: logs and screenshots travel.
    const tokened = repo(path.join(tmp, 'tokened'), 'https://x-access-token:ghp_SECRETsecret123@gitlab.com/acme/app.git')
    r = await run(tokened, ['start', '--agent', NODE], fakeCall(github()).call)
    T('CL2b a token in the origin URL is not printed', r.code === 2 && /Q601 origin \(https:\/\/gitlab\.com\/acme\/app\.git\)/.test(r.out) && !/SECRET|x-access-token/.test(r.out), r.out)
  }

  const app = repo(path.join(tmp, 'app'), 'https://github.com/acme/app.git')
  r = await run(app, ['start', '--agent', NODE], fakeCall({}, { down: 'gh is not installed' }).call)
  T('CL3 gh missing: says where to get it', r.code === 2 && /Q600 GitHub CLI \(gh\) is not installed.*cli\.github\.com.*gh auth login/s.test(r.out), r.out)
  r = await run(app, ['start', '--agent', NODE], fakeCall({ 'GET user': { status: 401, headers: {}, body: { message: 'Bad credentials' }, text: '' } }).call)
  T('CL4 gh logged out: says gh auth login', r.code === 2 && /Q600 .*gh auth login/.test(r.out), r.out)
  {
    // What gh REALLY does with no login (gh 2.x, measured): no HTTP answer at all, this on stderr, exit 4.
    const LOGGED_OUT = 'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.'
    const codes = (s) => (s.match(/\bQ\d{3}\b/g) || []).length
    r = await run(app, ['start', '--agent', NODE], fakeCall({}, { down: LOGGED_OUT }).call)
    T('CL4b gh with no login (no HTTP answer): one Q600 that says so, not "could not reach GitHub"',
      r.code === 2 && /^Q600 gh is not logged in on this machine\. Run: gh auth login/.test(r.out) && codes(r.out) === 1 && !/could not reach/.test(r.out), r.out)
    // The running watcher reads the same answer through makeGitHub: it must be Q600, the code that
    // holds off AND tells the owner to log in. As a network outage it waited forever, saying nothing.
    let e = null
    try { HG.makeGitHub({ call: fakeCall({}, { down: LOGGED_OUT }).call, owner: 'acme', repo: 'app' }).labeledIssues('hivecode') } catch (err) { e = err }
    T('CL4c mid-run, a logged-out gh is Q600 (login notice), not a status-0 outage', e && e.code === 'Q600', e ? `${e.code}: ${e.message}` : 'no error')
    r = await run(app, ['start', '--agent', NODE], fakeCall(github({ 'GET repos/acme/app': { status: 404, headers: {}, body: { message: 'Not Found' }, text: '' } })).call)
    T('CL4d a repo GitHub cannot show this login: Q601 naming the repo and the account, not "is gh logged in?"',
      r.code === 2 && /^Q601 GitHub has no repository acme\/app that owner can see \(HTTP 404\)/.test(r.out) && codes(r.out) === 1 && !/logged in\?/.test(r.out), r.out)
    r = await run(app, ['start', '--agent', NODE], fakeCall({}, { down: 'dial tcp: lookup api.github.com: no such host' }).call)
    T('CL4e no network: one Q603, said once', r.code === 1 && /^Q603 could not reach GitHub/.test(r.out) && codes(r.out) === 1, r.out)
    // HOW IT EXITS, for whatever restarts it: 1 = try again (GitHub unreachable or busy), 2 = a
    // person must change something. A refusal above is 2; these are 1.
    r = await run(app, ['start', '--agent', NODE], fakeCall({ 'GET user': { status: 503, headers: {}, body: { message: 'Service Unavailable' }, text: '' } }).call)
    T('CL4f GitHub answering 503: exit 1 (try again), not 2', r.code === 1 && /^Q603 /.test(r.out), `code ${r.code}: ${r.out}`)
    r = await run(app, ['start', '--agent', NODE], fakeCall({ 'GET user': { status: 429, headers: { 'retry-after': '30' }, body: { message: 'rate limited' }, text: '' } }).call)
    T('CL4g GitHub rate limit at start: exit 1 (try again)', r.code === 1 && /^Q604 /.test(r.out), `code ${r.code}: ${r.out}`)
    r = await run(app, ['start', '--agent', NODE], fakeCall({ 'GET user': { status: 403, headers: {}, body: { message: 'Resource protected by organization SAML enforcement' }, text: '' } }).call)
    T('CL4h GitHub refusing (403, not a rate limit): exit 2 (a person must act)', r.code === 2 && /^Q603 .*SAML/.test(r.out), `code ${r.code}: ${r.out}`)
  }
  r = await run(app, ['start'], fakeCall(github()).call)
  T('CL5 no --agent: asks for one and shows the Claude Code line', r.code === 2 && /Q602 say which agent/.test(r.out) && /claude -p --output-format json/.test(r.out))
  r = await run(app, ['start', '--agent', 'no-such-agent-cli-xyz -p'], fakeCall(github()).call)
  T('CL6 an agent that is not installed', r.code === 2 && /Q602 "no-such-agent-cli-xyz" is not installed/.test(r.out), r.out)
  r = await run(app, ['start', '--agent', NODE, '--max-runs', '0'], fakeCall(github()).call)
  T('CL7 a limit that is not a positive number', r.code === 2 && /Q602 --max-runs must be a positive number/.test(r.out), r.out)
  r = await run(app, ['start', '--agent', NODE], fakeCall(github({ 'GET repos/acme/app': ok({ default_branch: 'main', private: false, permissions: { push: false } }) })).call)
  T('CL8 an account that cannot push', r.code === 2 && /Q601 .*cannot push to acme\/app/.test(r.out), r.out)
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
  r = await run(notRepo, ['start', '--once', '--repo', app], fakeCall(github()).call)
  T('CS8 --repo watches that clone from anywhere', r.code === 0 && /watching acme\/app/.test(r.out), r.out.split('\n').slice(-1)[0])

  console.log('\n# --notify: the webhook URL is a secret (anyone holding it posts as you)')
  {
    const SECRET = 'XXXXsecretXXXX'
    const hook = `https://hooks.slack.com/services/T000/B000/${SECRET}`
    const nf = repo(path.join(tmp, 'notify'), 'https://github.com/acme/app.git')
    const stateOf = (d) => path.join(d, '.git', 'hivecode', 'github.json')
    r = await run(nf, ['start', '--agent', NODE, '--once', '--notify', 'not a url'], fakeCall(github()).call)
    T('CN1 a --notify that is not a web address: Q609, exit 2, nothing saved', r.code === 2 && /^Q609 --notify is not a web address/m.test(r.out) && !fs.existsSync(stateOf(nf)), r.out)
    r = await run(nf, ['start', '--agent', NODE, '--once', '--notify', 'ftp://hooks.slack.com/services/T000/B000/x'], fakeCall(github()).call)
    T('CN1b a URL that parses but is not http(s): refused the same way', r.code === 2 && /^Q609 /m.test(r.out) && !fs.existsSync(stateOf(nf)), r.out)
    r = await run(nf, ['start', '--agent', NODE, '--once', '--notify', hook], fakeCall(github()).call)
    T('CN2 --notify: says where notices go by HOST only, and never prints the URL', r.code === 0 && /posted to hooks\.slack\.com\./.test(r.out) && !r.out.includes(SECRET), r.out.split('\n').filter((l) => /otif/.test(l)).join(' | '))
    // A service restarts from the saved flags, so a --notify given on the command line is kept --
    // in a file only its owner can read. (Windows has no such mode bits; checked where they exist.)
    const mode = fs.statSync(stateOf(nf)).mode & 0o777
    T('CN3 the saved flags (which hold that URL) are owner-only', process.platform === 'win32' || mode === 0o600, `mode ${mode.toString(8)} on ${process.platform}`)
    const ne = repo(path.join(tmp, 'notify-env'), 'https://github.com/acme/app.git')
    process.env.HIVE_NOTIFY_WEBHOOK = `https://discord.com/api/webhooks/1/${SECRET}`
    try { r = await run(ne, ['start', '--agent', NODE, '--once'], fakeCall(github()).call) } finally { delete process.env.HIVE_NOTIFY_WEBHOOK }
    T('CN4 HIVE_NOTIFY_WEBHOOK: used (host shown) but never saved and never printed', r.code === 0 && /posted to discord\.com\./.test(r.out) && !r.out.includes(SECRET) && !fs.readFileSync(stateOf(ne), 'utf8').includes(SECRET), r.out.split('\n').filter((l) => /otif/.test(l)).join(' | '))
  }

  console.log('\n# --dry-run: what a start would do, and nothing written')
  {
    const dryRepo = repo(path.join(tmp, 'dry'), 'https://github.com/acme/app.git')
    const user = (login) => ({ login, type: 'User' })
    const fd = fakeCall(github({
      'GET repos/acme/app/issues': ok([
        { number: 5, title: 'Fix the login', labels: [{ name: 'hivecode' }], updated_at: 'a' },
        { number: 6, title: 'From a reader', labels: [{ name: 'hivecode' }], updated_at: 'b' },
      ]),
      'GET repos/acme/app/issues/5/events': ok([{ event: 'labeled', label: { name: 'hivecode' }, actor: user('dev') }]),
      'GET repos/acme/app/issues/6/events': ok([{ event: 'labeled', label: { name: 'hivecode' }, actor: user('reader') }]),
      'GET repos/acme/app/collaborators/dev/permission': ok({ permission: 'write' }),
      'GET repos/acme/app/collaborators/reader/permission': ok({ permission: 'read' }),
      'GET repos/acme/app/issues/5/comments': ok([]),
    }))
    r = await run(dryRepo, ['start', '--dry-run', '--agent', NODE], fd.call)
    T('CD1 it says which issue would start, and which is skipped and why', r.code === 0 && /#5: would start now/.test(r.out) && /#6: skipped: labelled by reader, who cannot push/.test(r.out), r.out)
    T('CD2 missing labels are named, not made', /would create the label "hivecode"/.test(r.out) && !fd.calls.some((c) => c.method !== 'GET'))
    const writes = fd.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)
    // No write, and no run even attempted: an attempt that happens to die on a read before its first
    // write is still a dry run that is not dry.
    const attempted = r.out.match(/[^\n]*\b(run \d+ of \d+ started|not started|needs a person)\b[^\n]*/)
    T('CD3 nothing is written to GitHub, and no run is even attempted', writes.length === 0 && !attempted, writes.join(' | ') || (attempted && attempted[0]) || '')
    T('CD4 nothing is written here: no state, no lock, no watcher id, no branch', !fs.existsSync(path.join(dryRepo, '.git', 'hivecode')) &&
      g(dryRepo, 'config', '--local', '--get', 'hivecode.github.watcher').status !== 0 && g(dryRepo, 'branch', '--list', 'hivecode/*').stdout.trim() === '')
  }

  console.log('\n# --dry-run on a clone a watcher has worked in: "why is it not picking up my issue?"')
  {
    // A file that is gone must turn its row red, not throw: a crash skips every row after it.
    const readOr = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
    const used = repo(path.join(tmp, 'dry-used'), 'https://github.com/acme/app.git')
    g(used, 'config', 'hivecode.github.watcher', 'abc123abc123')
    const user = (login) => ({ login, type: 'User' })
    const claimBy = (watcher, branch) => `Hivecode is working on this.\n\n<!-- hivecode:claim watcher=${watcher} branch=${branch} -->`
    const known = (status, more = {}) => ({ status, claimed: true, runs: 1, allowedRuns: 6, failures: 0, queue: [], seen: { ic: 0, pc: 0, rc: 0, rv: 0 }, cmdSeen: [], ...more })
    const stateFile = path.join(used, '.git', 'hivecode', 'github.json')
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    const before = JSON.stringify({
      version: 1, config: {},
      day: { date: new Date().toISOString().slice(0, 10), runs: 20, capNoticed: '' },
      issues: {
        5: known('review', { pr: 12, branch: 'hivecode/5-review' }),
        6: known('needs-human', { pr: 13, branch: 'hivecode/6-asked', reason: 'it asked which database to use' }),
        10: known('running', { branch: 'hivecode/10-cut', run: { pid: 0, startedAt: 0, deadline: 0 } }),
      },
    }, null, 2)
    fs.writeFileSync(stateFile, before)
    const fu = () => fakeCall(github({
      'GET repos/acme/app/labels': ok([{ name: 'hivecode' }, { name: 'hivecode:needs-human' }]),
      'GET repos/acme/app/issues': ok([5, 6, 7, 8, 9, 10].map((number) => ({ number, title: `Issue ${number}`, labels: [{ name: 'hivecode' }], updated_at: 'u' }))),
      ...Object.fromEntries([7, 8, 9].map((n) => [`GET repos/acme/app/issues/${n}/events`, ok([{ event: 'labeled', label: { name: 'hivecode' }, actor: user('dev') }])])),
      'GET repos/acme/app/collaborators/dev/permission': ok({ permission: 'write' }),
      'GET repos/acme/app/issues/7/comments': ok([{ id: 70, user: user('owner'), body: claimBy('def456def456', 'hivecode/7-theirs') }]),
      'GET repos/acme/app/issues/8/comments': ok([{ id: 80, user: user('owner'), body: claimBy('abc123abc123', 'hivecode/8-ours') }]),
      'GET repos/acme/app/issues/9/comments': ok([]),
      'GET repos/acme/app/pulls': ok([{ number: 21, state: 'open', html_url: 'https://github.com/acme/app/pull/21' }]),
    }))
    const f1 = fu()
    r = await run(used, ['start', '--dry-run', '--agent', NODE], f1.call)
    T('CD5 what the state file knows is said as it is, never as "would start now"', r.code === 0 && /#5: in review \(pull request #12\)/.test(r.out) && /#6: needs a person \(pull request #13\): it asked which database to use/.test(r.out) && !/#[56]: would start/.test(r.out), r.out)
    T('CD6 another watcher\'s issue is a skip; our own earlier claim with an open pull request is picked up, without a run', /#7: would skip: another Hivecode watcher \(def456def456\) is on it/.test(r.out) && /#8: would pick up its pull request #21 again, without a run/.test(r.out), r.out)
    T('CD7 with today\'s runs used up, the rest would wait', /#9: would wait: today's limit of 20 runs is reached/.test(r.out), r.out)
    T('CD8 a run the file says is going, with no watcher alive, is said as cut off', /#10: cut off when the watcher stopped; a start runs it again/.test(r.out), r.out)
    T('CD9 the state file is read, never rewritten, and nothing is written to GitHub', readOr(stateFile) === before && fs.readdirSync(path.dirname(stateFile)).length === 1 && !f1.calls.some((c) => c.method !== 'GET'))
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
    const lock = path.join(used, '.git', 'hivecode', 'watcher.lock')
    fs.writeFileSync(lock, JSON.stringify({ pid: sleeper.pid, at: 'earlier' }))
    r = await run(used, ['start', '--dry-run', '--agent', NODE], fu().call)
    T('CD10 a watcher running here now is said first, the run is its own, and its lock is left alone', new RegExp(`A watcher is running on this clone now \\(process ${sleeper.pid}`).test(r.out) && /#10: running now, in the watcher on this clone/.test(r.out) && (readOr(lock) || '').includes(String(sleeper.pid)), r.out)
    sleeper.kill()
    await new Promise((res) => sleeper.on('exit', res))
    fs.unlinkSync(lock)

    const bad = repo(path.join(tmp, 'dry-bad'), 'https://github.com/acme/app.git')
    const badFile = path.join(bad, '.git', 'hivecode', 'github.json')
    fs.mkdirSync(path.dirname(badFile), { recursive: true })
    fs.writeFileSync(badFile, '{ not json')
    r = await run(bad, ['start', '--dry-run', '--agent', NODE], fakeCall(github()).call)
    T('CD11 a state file that cannot be read is left where it is, and that is said', r.code === 0 && readOr(badFile) === '{ not json' && fs.readdirSync(path.dirname(badFile)).length === 1 && /Q606 .*could not be read\. Nothing was changed/.test(r.out), r.out)
    r = await run(bad, ['status'], fakeCall({}).call)
    T('CT3 status leaves it where it is too', r.code === 0 && readOr(badFile) === '{ not json' && fs.readdirSync(path.dirname(badFile)).length === 1 && /Q606 .*Nothing was changed/.test(r.out), r.out)
    r = await run(bad, ['start', '--dry-run', '--agent', NODE], fakeCall(github({ 'GET repos/acme/app/issues': { status: 502, headers: {}, body: { message: 'Bad Gateway' }, text: '' } })).call)
    T('CD12 GitHub failing to list the issues is said, never as "no labelled issues"', r.code === 1 && /could not read the labelled issues/.test(r.out) && !/no open issue is labelled/.test(r.out), r.out)
    r = await run(bad, ['start', '--once', '--agent', NODE], fakeCall(github()).call)
    T('CS9 a real start moves an unreadable state file aside, and says where', r.code === 0 && fs.readdirSync(path.dirname(badFile)).some((x) => /^github\.json\.unreadable-/.test(x)) && /Q606 .*It was moved to/.test(r.out), r.out)
  }

  console.log('\n# the agent must be able to use Hivecode, or every run is paid for and fails')
  {
    // A fake `claude` first on PATH: answers `claude mcp get hivecode` the way the real one does.
    const bin = path.join(tmp, 'fakebin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'fake-claude.mjs'), [
      "const mode = process.env.FAKE_CLAUDE_MODE || 'ok'",
      "const a = process.argv.slice(2).join(' ')",
      "if (a !== 'mcp get hivecode') { console.log('fake claude: ' + a); process.exit(0) }",
      "if (mode === 'missing') { console.error('No MCP server named \"hivecode\". Configured servers: memory'); process.exit(1) }",
      "if (mode === 'failed') { console.log('hivecode:\\n  Scope: User config\\n  Status: \\u2718 Failed to connect\\n  Type: stdio'); process.exit(0) }",
      "if (mode === 'hang') { setTimeout(() => process.exit(0), 20000) }",
      "else { console.log('hivecode:\\n  Scope: User config\\n  Status: \\u2714 Connected\\n  Type: stdio'); process.exit(0) }",
    ].join('\n'))
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`)
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-claude.mjs" "$@"\n`, { mode: 0o755 })
    const was = { PATH: process.env.PATH, Path: process.env.Path }
    const withBin = `${bin}${path.delimiter}${process.env.PATH || process.env.Path || ''}`
    process.env.PATH = withBin
    if (was.Path !== undefined) process.env.Path = withBin
    const ag = repo(path.join(tmp, 'agentcheck'), 'https://github.com/acme/app.git')
    const nothingInAg = () => !fs.existsSync(path.join(ag, '.git', 'hivecode'))
    const CL = 'claude -p --output-format json --allowedTools Bash Edit Write Read Glob Grep mcp__hivecode'
    process.env.FAKE_CLAUDE_MODE = 'missing'
    r = await run(ag, ['start', '--once', '--agent', CL], fakeCall(github()).call)
    T('CA1 claude without the hivecode MCP server: refused before any run is paid for, with the fix', r.code === 2 && /Q602 .*claude has no hivecode MCP server/.test(r.out) && /npx -y hivecode-mcp@latest setup/.test(r.out) && nothingInAg(), r.out)
    r = await run(ag, ['start', '--dry-run', '--agent', CL], fakeCall(github()).call)
    T('CA2 a dry run says so too', r.code === 2 && /Q602 .*claude has no hivecode MCP server/.test(r.out) && nothingInAg(), r.out)
    process.env.FAKE_CLAUDE_MODE = 'failed'
    r = await run(ag, ['start', '--once', '--agent', CL], fakeCall(github()).call)
    T('CA3 configured but not connecting: refused, quoting the status', r.code === 2 && /Q602 .*hivecode MCP server .*not working/.test(r.out) && /Failed to connect/.test(r.out) && nothingInAg(), r.out)
    process.env.FAKE_CLAUDE_MODE = 'ok'
    r = await run(ag, ['start', '--once', '--agent', 'claude -p --allowedTools Bash Edit Write'], fakeCall(github()).call)
    T('CA4 --allowedTools without mcp__hivecode: refused (in -p mode the hive tools would be denied)', r.code === 2 && /Q602 .*--allowedTools .*mcp__hivecode/.test(r.out) && nothingInAg(), r.out)
    r = await run(ag, ['start', '--once', '--agent', CL], fakeCall(github()).call)
    T('CA5 connected: it says so, and starts', r.code === 0 && /claude can use Hivecode/.test(r.out) && /watching acme\/app/.test(r.out), r.out)
    process.env.FAKE_CLAUDE_MODE = 'hang'
    process.env.HIVE_AGENT_CHECK_TIMEOUT_MS = '1500'
    const ag2 = repo(path.join(tmp, 'agentcheck-hang'), 'https://github.com/acme/app.git')
    r = await run(ag2, ['start', '--once', '--agent', CL], fakeCall(github()).call)
    T('CA6 claude does not answer: "could not check" is said, never a silent pass, and it starts', r.code === 0 && /could not check/i.test(r.out) && !/claude can use Hivecode/.test(r.out), r.out)
    delete process.env.HIVE_AGENT_CHECK_TIMEOUT_MS
    process.env.FAKE_CLAUDE_MODE = 'missing'
    const ag3 = repo(path.join(tmp, 'agentcheck-skip'), 'https://github.com/acme/app.git')
    r = await run(ag3, ['start', '--once', '--skip-agent-check', '--agent', CL], fakeCall(github()).call)
    T('CA7 --skip-agent-check skips it', r.code === 0 && !/Q602/.test(r.out) && /watching acme\/app/.test(r.out), r.out)
    const ag4 = repo(path.join(tmp, 'agentcheck-other'), 'https://github.com/acme/app.git')
    r = await run(ag4, ['start', '--once', '--agent', NODE], fakeCall(github()).call)
    T('CA8 an agent we cannot ask: it says it did not check, never a silent pass', r.code === 0 && /not checked for node/i.test(r.out), r.out)
    delete process.env.FAKE_CLAUDE_MODE
    process.env.PATH = was.PATH
    if (was.Path !== undefined) process.env.Path = was.Path
  }

  console.log('\n# --slack-channel: checked against Slack before any work starts')
  {
    // Slack, faked over real HTTP: the bridge's own preflight (auth.test, conversations.info) runs.
    const http = await import('http')
    let mode = 'ok'
    // Slack says which scopes a token has in this header, on every Web API answer.
    let scopes = 'chat:write,channels:read,groups:read'
    let privateChannel = false
    // Socket Mode, faked too: a WebSocket that says hello the way Slack does. `helloCount` is the
    // num_connections it reports; `deadSocket` hands out a URL nothing listens on.
    const { WebSocketServer } = await import('ws')
    let helloCount = 1
    let deadSocket = false
    const sockSrv = http.createServer()
    const sockWss = new WebSocketServer({ server: sockSrv })
    sockWss.on('connection', (ws) => { try { ws.send(JSON.stringify({ type: 'hello', num_connections: helloCount, connection_info: { app_id: 'A1' } })) } catch { } })
    await new Promise((res) => sockSrv.listen(0, '127.0.0.1', res))
    const sockUrl = () => (deadSocket ? 'ws://127.0.0.1:9/nobody-listens' : `ws://127.0.0.1:${sockSrv.address().port}/`)
    const srv = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        const m = req.url.replace(/^\/api\//, '')
        const out = m === 'auth.test' ? (mode === 'badtoken' ? { ok: false, error: 'invalid_auth' } : { ok: true, user: 'hivecode', user_id: 'U1', team: 'Acme', team_id: 'T1' })
          : m === 'conversations.info' ? { ok: true, channel: { id: 'C1', name: 'eng', is_member: mode !== 'notmember', is_private: privateChannel } }
            : m === 'apps.connections.open' ? { ok: true, url: sockUrl() }
              : { ok: false, error: 'unknown_method' }
        res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': scopes })
        res.end(JSON.stringify(out))
      })
    })
    await new Promise((res) => srv.listen(0, '127.0.0.1', res))
    process.env.HIVE_SLACK_API = `http://127.0.0.1:${srv.address().port}/api`
    const sl = repo(path.join(tmp, 'slack'), 'https://github.com/acme/app.git')
    const slArgs = ['start', '--once', '--agent', NODE, '--slack-channel', 'C1']
    const nothingHere = () => !fs.existsSync(path.join(sl, '.git', 'hivecode'))
    delete process.env.SLACK_BOT_TOKEN
    r = await run(sl, slArgs, fakeCall(github()).call)
    T('CK1 --slack-channel without SLACK_BOT_TOKEN is refused with the fix, and nothing is written', r.code === 2 && /Q633 .*SLACK_BOT_TOKEN/.test(r.out) && nothingHere(), r.out)
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-real'
    mode = 'badtoken'
    r = await run(sl, slArgs, fakeCall(github()).call)
    T('CK2 a token Slack refuses is said before any work starts', r.code === 2 && /Q630 .*\(invalid_auth\)/.test(r.out) && nothingHere(), r.out)
    mode = 'notmember'
    r = await run(sl, slArgs, fakeCall(github()).call)
    T('CK3 a bot that is not in the channel: the /invite that fixes it', r.code === 2 && /Q631 .*\/invite @hivecode/.test(r.out) && nothingHere(), r.out)
    mode = 'ok'
    r = await run(sl, slArgs, fakeCall(github()).call)
    T('CK4 a good token and channel: it says where each issue goes, and starts', r.code === 0 && /its own thread in #eng, posted by @hivecode/.test(r.out) && /watching acme\/app/.test(r.out), r.out)
    T('CK5 the token is never saved with the flags', !/xoxb-/.test(fs.readFileSync(path.join(sl, '.git', 'hivecode', 'github.json'), 'utf8')))

    // --slack-allow that cannot work is refused at start. Each of these used to start green and then
    // never let anyone retry from Slack: the replies were not read, or no id could ever match.
    delete process.env.SLACK_APP_TOKEN
    const sa = repo(path.join(tmp, 'slack-allow'), 'https://github.com/acme/app.git')
    const nothingThere = () => !fs.existsSync(path.join(sa, '.git', 'hivecode'))
    r = await run(sa, ['start', '--once', '--agent', NODE, '--slack-channel', 'C1', '--slack-allow', 'UOWN'], fakeCall(github()).call)
    T('CK11 --slack-allow without SLACK_APP_TOKEN (replies would never be read) is refused with the fix', r.code === 2 && /Q634 .*SLACK_APP_TOKEN/.test(r.out) && nothingThere(), r.out)
    r = await run(sa, ['start', '--once', '--agent', NODE, '--slack-allow', 'UOWN'], fakeCall(github()).call)
    T('CK12 --slack-allow without --slack-channel is refused, not ignored', r.code === 2 && /Q634 .*--slack-channel/.test(r.out) && nothingThere(), r.out)
    r = await run(sa, ['start', '--once', '--agent', NODE, '--slack-channel', 'C1', '--slack-allow', '@ganesh,UOWN'], fakeCall(github()).call)
    T('CK13 a name where a member id goes is refused, and says how to find the id', r.code === 2 && /Q634 .*@ganesh/.test(r.out) && /Copy member ID/.test(r.out) && !/UOWN is not/.test(r.out) && nothingThere(), r.out)
    const slState = path.join(sl, '.git', 'hivecode', 'github.json')
    const st = JSON.parse(fs.readFileSync(slState, 'utf8'))
    st.config.flags['slack-allow'] = 'UOWN'
    fs.writeFileSync(slState, JSON.stringify(st))
    const savedText = fs.readFileSync(slState, 'utf8')
    r = await run(sl, slArgs, fakeCall(github()).call)
    T('CK14 a --slack-allow saved by the last start says so, and how to drop it', r.code === 2 && /Q634 /.test(r.out) && /last start/.test(r.out) && /--slack-allow ""/.test(r.out) && fs.readFileSync(slState, 'utf8') === savedText, r.out)
    r = await run(sl, [...slArgs, '--slack-allow', ''], fakeCall(github()).call)
    T('CK15 --slack-allow "" drops it, and the watcher starts', r.code === 0 && /watching acme\/app/.test(r.out) && !/Q634/.test(r.out), r.out)
    mode = 'notmember'
    r = await run(sl, ['start', '--once', '--agent', NODE], fakeCall(github()).call)
    T('CK15b a saved --slack-channel that Slack refuses: the error says it came from the last start', r.code === 2 && /Q631 /.test(r.out) && /saved by your last start; pass --slack-channel "" to drop it/.test(r.out), r.out)
    mode = 'ok'

    // Replies need scopes the default manifest does not ask for. Without them the start looked
    // fine: a "stop" in the thread never arrived (no history scope, so Slack sends no message
    // events), or every stop was "unverified" and every retry refused (no users:read).
    process.env.SLACK_APP_TOKEN = 'xapp-test-not-real'
    const sc = repo(path.join(tmp, 'slack-scopes'), 'https://github.com/acme/app.git')
    const nothingInSc = () => !fs.existsSync(path.join(sc, '.git', 'hivecode'))
    r = await run(sc, slArgs, fakeCall(github()).call)
    T('CK16 replies on, token without users:read and channels:history: refused, naming the inbound manifest', r.code === 2 && /Q634 .*missing required inbound scope\(s\): users:read, channels:history\./.test(r.out) && /slack-app-manifest-inbound\.json/.test(r.out) && nothingInSc(), r.out)
    privateChannel = true
    scopes = 'chat:write,channels:read,groups:read,users:read,channels:history'
    r = await run(sc, slArgs, fakeCall(github()).call)
    T('CK17 a private channel needs groups:history, and that is what it says is missing', r.code === 2 && /Q634 .*missing required inbound scope\(s\): groups:history\./.test(r.out) && nothingInSc(), r.out)
    scopes = 'chat:write,channels:read,groups:read,users:read,channels:history,groups:history'
    r = await run(sc, slArgs, fakeCall(github()).call)
    T('CK18 with the inbound scopes it starts, and says who may stop and retry', r.code === 0 && /`stop` in an issue's thread stops it/.test(r.out) && !/Q634/.test(r.out), r.out)
    // Another process on the same Slack app: Slack gives each event to ONE connection, so a "stop"
    // could go to the other one. Refused at start, once, with the lock given back -- not "watching".
    const lockGone = () => !fs.existsSync(path.join(sc, '.git', 'hivecode', 'watcher.lock'))
    process.env.HIVE_SLACK_START_RETRY_MS = '400'
    helloCount = 2
    r = await run(sc, slArgs, fakeCall(github()).call)
    T('CK19 another process on the same Slack app: Q635 at start, not "watching", lock given back',
      r.code === 2 && /Q635 /.test(r.out) && !/is watching/.test(r.out) && lockGone(), r.out.slice(0, 300))
    helloCount = 1
    deadSocket = true
    r = await run(sc, slArgs, fakeCall(github()).call)
    T('CK20 Socket Mode that cannot connect: one coded line, no stack, not "watching", lock given back',
      r.code === 1 && /^Q63\d /m.test(r.out) && !/\n\s+at /.test(r.out) && !/is watching/.test(r.out) && lockGone(), r.out.slice(0, 300))
    deadSocket = false
    // Slack not reached at all (a machine that booted before its network was up): that is no verdict
    // on the token, and a service must try again -- not be told to reinstall an app that is fine.
    const slackApi = process.env.HIVE_SLACK_API
    process.env.HIVE_SLACK_API = 'http://127.0.0.1:9/api'
    r = await run(sc, slArgs, fakeCall(github()).call)
    T('CK21 Slack unreachable at start: exit 1 (try again), and it does not say the token was rejected',
      r.code === 1 && /^Q63\d /m.test(r.out) && !/rejected|reinstall/i.test(r.out) && lockGone(), r.out.slice(-300))
    process.env.HIVE_SLACK_API = slackApi
    delete process.env.HIVE_SLACK_START_RETRY_MS
    privateChannel = false
    scopes = 'chat:write,channels:read,groups:read'
    delete process.env.SLACK_APP_TOKEN
    delete process.env.SLACK_BOT_TOKEN
    delete process.env.HIVE_SLACK_API
    srv.close()
    for (const c of sockWss.clients) { try { c.terminate() } catch { } }
    sockWss.close()
    sockSrv.close()
  }

  console.log('\n# a reply in an issue\'s Slack thread: who may do what')
  {
    // The real rules from hive-slack.js (shared with the room bridge); only users.info is faked.
    const HS = await import(`file:///${ROOT.replace(/\\/g, '/')}/hive-slack.js`)
    const users = {
      UMEM: { id: 'UMEM', name: 'member', team_id: 'T1' },
      UOWN: { id: 'UOWN', name: 'ganesh', team_id: 'T1' },
      UGST: { id: 'UGST', name: 'guest', team_id: 'T1', is_restricted: true },
      UEXT: { id: 'UEXT', name: 'outsider', team_id: 'T2' },
    }
    let lookupDown = false
    const check = HS.makeSlackActorCheck({ token: 'xoxb-test-not-real', teamId: 'T1', lookupUser: async (id) => { if (lookupDown) throw new Error('ratelimited'); return { ok: true, user: users[id] } } })
    const calls = []
    const notes = []
    const order = [] // which came first: the stop, or what Slack was told
    const w = { fromSlack: async (a) => { calls.push(a); order.push('stop'); return { ok: true, n: 7 } }, slackNote: (a) => { notes.push(a.text); order.push('note'); return true } }
    const h = HG.makeSlackReplyHandler({ w, check, allow: ['UOWN'], channel: 'C1' })
    const ev = (user, text, more = {}) => ({ type: 'message', channel: 'C1', thread_ts: '111.1', user, text, ...more })
    await h(ev('UMEM', 'stop'))
    T('CK6 a full member\'s "stop" in our thread stops that issue', calls.length === 1 && calls[0].action === 'stop' && calls[0].handle === 'member' && calls[0].threadTs === '111.1', JSON.stringify(calls))
    calls.length = 0
    notes.length = 0
    await h(ev('UGST', 'stop'))
    await h(ev('UEXT', 'stop'))
    T('CK7 a guest, or a user from another workspace, is refused and told why', calls.length === 0 && notes.length === 2 && notes.every((t) => /Refused/.test(t)), notes.join(' | '))
    notes.length = 0
    await h(ev('UMEM', 'retry'))
    const memberRefused = calls.length === 0 && notes.length === 1
    await h(ev('UOWN', 'retry'))
    T('CK8 "retry" only from --slack-allow: a member is refused, the owner is not', memberRefused && calls.length === 1 && calls[0].action === 'retry', notes.join(' | '))
    calls.length = 0
    notes.length = 0
    for (const e of [ev('UMEM', 'stop', { bot_id: 'B1' }), ev('UMEM', 'stop', { channel: 'C2' }), { type: 'message', channel: 'C1', user: 'UMEM', text: 'stop' }, ev('UMEM', 'please have a look'), ev('UMEM', 'stop', { subtype: 'message_changed' })]) await h(e)
    T('CK9 a bot, another channel, a message outside a thread, other words and edits do nothing', calls.length === 0 && notes.length === 0, notes.join(' | '))
    lookupDown = true
    order.length = 0
    await h(ev('UNEW', 'stop'))
    const stoppedUnverified = calls.length === 1 && notes.length === 1 && /could not confirm who you are/.test(notes[0]) && order.join(',') === 'stop,note'
    calls.length = 0
    notes.length = 0
    await h(ev('UNEW2', 'retry'))
    T('CK10 when Slack cannot say who replied, "stop" still stops (and says so after), "retry" is refused', stoppedUnverified && calls.length === 0 && notes.length === 1, notes.join(' | '))
  }

  console.log('\n# one watcher per clone')
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  fs.writeFileSync(path.join(app, '.git', 'hivecode', 'watcher.lock'), JSON.stringify({ pid: sleeper.pid, at: 'earlier' }))
  r = await run(app, ['start', '--once'], fakeCall(github()).call)
  T('CW1 a second watcher on the same clone is refused, naming the first', r.code === 2 && new RegExp(`Q605 a watcher is already running for this repo \\(process ${sleeper.pid}`).test(r.out), r.out)
  sleeper.kill()
  await new Promise((res) => sleeper.on('exit', res))
  r = await run(app, ['start', '--once'], fakeCall(github()).call)
  T('CW2 a lock whose process is gone is taken over', r.code === 0, r.out.split('\n').slice(-1)[0])

  console.log('\n# a repository too big for the public relay')
  const big = repo(path.join(tmp, 'big'), 'https://github.com/acme/app.git', 5001)
  r = await run(big, ['start', '--agent', NODE, '--once'], fakeCall(github()).call)
  T('CB1 refused on the public relay, with both ways out', r.code === 2 && /Q608 acme\/app has 5001 files/.test(r.out) && /npx hivecode-relay/.test(r.out) && /--allow-large/.test(r.out), r.out)
  r = await run(big, ['start', '--agent', NODE, '--once', '--relay', 'wss://relay.example.com'], fakeCall(github()).call)
  T('CB2 fine on your own relay', r.code === 0)

  console.log('\n# status')
  r = await run(app, ['status'], fakeCall({}).call)
  T('CT1 status reads only the local file: no call to GitHub', r.code === 0 && /Hivecode on GitHub for acme\/app/.test(r.out))
  r = await run(app, ['nonsense'], fakeCall({}).call)
  T('CT2 an unknown subcommand prints the usage', r.code === 2 && /github start --agent/.test(r.out))
  // Asking for help is not an error: the usage goes to stdout with exit 0 (so `| less` and `&&` work),
  // before any git or GitHub call -- here in a folder that is not a repo, with a gh that would fail.
  for (const argv of [['--help'], ['-h'], ['help'], ['start', '--help'], ['status', '-h']]) {
    const so = []; const se = []
    const code = await HG.main(argv, { cwd: notRepo, call: fakeCall({}, { down: 'should not be called' }).call, log: (s) => so.push(String(s)), logErr: (s) => se.push(String(s)) })
    T(`CT4 github ${argv.join(' ')}: usage on stdout, exit 0`, code === 0 && /github start --agent/.test(so.join('\n')) && !se.length, `code ${code}; stderr: ${se.join(' | ').slice(0, 120)}`)
  }
} catch (err) {
  T(`no exception (${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err})`, false)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
