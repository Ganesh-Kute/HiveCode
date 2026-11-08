// ROOM MODE END TO END: a GitHub issue -> the agents in the room -> one tested pull request.
//
//   node tests/room-mode-e2e-test.mjs
//
// Nothing injected but GitHub's HTTP API: a real relay, a real repo with a real (bare) origin, two
// real MCP agents (a writer and a reviewer), the real watcher state machine, the real postIssue,
// whenDone, landIssue and landAndOpen (tests included). The parts' own tests inject the room side;
// this one is what proves they fit -- on 5 Nov the injected tests were green while the real path
// could never become ready (file docs unsynced on a fresh client).
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } }
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)
const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8') } catch { return null } }
async function waitUntil(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await pred()) return true } catch { } await sleep(250) } return false }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-room-e2e-'))
const parent = path.join(tmp, 'parent')
fs.mkdirSync(parent); g(parent, 'init', '-q'); fs.writeFileSync(path.join(parent, 'x.txt'), 'x\n'); g(parent, 'add', '-A'); g(parent, '-c', 'user.email=a@b', '-c', 'user.name=A', 'commit', '-qm', 'x')
process.env.HIVE_HOME = path.join(parent, 'hivehome')

const project = path.join(tmp, 'project')
fs.mkdirSync(project)
g(project, 'init', '-q', '-b', 'main'); g(project, 'config', 'user.email', 'dev@example.com'); g(project, 'config', 'user.name', 'Dev'); g(project, 'config', 'core.autocrlf', 'false')
const FILES = {
  'app.js': 'export const answer = 41\n',
  'test.js': "import { answer } from './app.js'\nif (answer !== 42) { console.error('answer is ' + answer); process.exit(1) }\nconsole.log('all tests passed')\n",
  'package.json': '{ "name": "demo", "type": "module", "scripts": { "test": "node test.js" } }\n',
}
for (const [rel, c] of Object.entries(FILES)) fs.writeFileSync(path.join(project, rel), c)
g(project, 'add', '-A'); g(project, 'commit', '-qm', 'init')
const origin = path.join(tmp, 'origin.git')
g(tmp, 'init', '-q', '--bare', origin)
g(project, 'remote', 'add', 'origin', origin)
g(project, 'push', '-q', 'origin', 'main')

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
const url = (f, q = '') => `file:///${ROOT.replace(/\\/g, '/')}/${f}${q}`
const HB = await import(url('hive-branch.js'))
const HL = await import(url('hive-land.js'))
const RM = await import(url('hive-room-mode.js'))
const RW = await import(url('hive-room-watcher.js'))
const mcp = (tag) => import(url('hive-mcp.js', `?${tag}`))

// GitHub's API, faked; everything else is real.
const GH = { comments: [], pulls: [], labels: [] }
const issue = { number: 1, title: 'Make the answer 42', body: 'test.js expects 42.\n@Claude please hurry', state: 'open', labels: ['hivecode'], author: 'owner' }
const gh = {
  labeledIssues: () => (issue.state === 'open' && issue.labels.includes('hivecode') ? [{ number: 1, title: issue.title, body: issue.body, user: { login: 'owner' }, labels: [{ name: 'hivecode' }] }] : []),
  issueEvents: () => [{ event: 'labeled', label: { name: 'hivecode' }, actor: { login: 'owner', type: 'User' } }],
  permission: () => 'admin',
  comment: (n, body) => { GH.comments.push({ n, body, id: 1000 + GH.comments.length, user: { login: 'hivecode-bot', type: 'User' }, author_association: 'OWNER' }) },
  addLabel: (n, name) => { GH.labels.push(name) },
  pull: (n) => GH.pulls.find((p) => p.number === n) || { state: 'closed' },
  // The PR's review side (B4): what a person writes on the pull request.
  comments: (n) => GH.comments.filter((c) => c.n === n),
  reviewComments: () => GH.reviewComments || [],
  reviews: () => [],
}
const github = {
  owner: 'o', repo: 'r', user: () => ({ login: 'owner' }),
  pullsFor: (b) => GH.pulls.filter((p) => p.head.ref === b),
  createPull: (p) => { const pr = { number: 7, state: 'open', html_url: 'https://github.com/o/r/pull/7', head: { ref: p.head, sha: '' }, title: p.title, body: p.body, base: p.base }; GH.pulls.push(pr); return pr },
}

const agents = []
try {
  console.log('\n# setup: a branch room, a writer and a reviewer')
  const b = await HB.main(['branch', 'fix', '--relay', RELAY], { cwd: project, log: () => {}, logErr: () => {} })
  const link = g(project, 'config', '--get', 'hivecode.fix.room').out
  g(project, 'push', '-q', 'origin', 'fix')
  const join = async (name) => {
    const M = await mcp(name); agents.push(M)
    await M._test.callTool('hive_join', { branch: 'fix', repo: project, name, owner: 'Dev' })
    const dir = M._test.getSession().dir
    await waitUntil(() => read(dir, 'app.js') === FILES['app.js'], 20000)
    return { M, dir, call: async (tool, args) => textOf(await M._test.callTool(tool, args)) }
  }
  const ana = await join('Ana'), rev = await join('Rev')
  T('S1 the room is bound and both agents have the files', b === 0 && !!link && read(ana.dir, 'app.js') === FILES['app.js'] && read(rev.dir, 'app.js') === FILES['app.js'])

  const stateFile = path.join(tmp, 'room-state.json')
  let lastLand = null
  const deps = {
    postIssue: ({ issue: is }) => RM.postIssue({ link, issue: is, waysOfWorking: RW.WAYS_OF_WORKING, branch: 'fix' }),
    landIssue: async ({ taskId, issue: is, lastFailedFingerprint, allowUnreviewed }) => (lastLand = await RM.landIssue({
      link, taskId, issue: is, root: project, branch: 'fix', allowUnreviewed, state: { lastFailedFingerprint },
      landRunner: (o) => HL.landAndOpen({ ...o, github }),
    })),
    peek: (a) => RW.peekRoom({ link, ...a }),
    say: (text) => RW.roomSay({ link, text }),
    spawn: () => { throw new Error('no fallback in this test') },
    // quietMs 0: a real watcher waits 90 s for a review to settle; the batching has its own tests.
    prFeedback: ({ issueNumber, prNumber, state }) => RM.postPrFeedback({ link, gh, issueNumber, prNumber, root: project, branch: 'fix', state, quietMs: 0 }),
  }
  const w = RW.makeRoomWatcher({ gh, link, branch: 'fix', stateFile, deps, ackMinutes: 60, log: () => {} })

  console.log('\n# 1. the issue reaches the room')
  await w.tick()
  const taskId = w.state.active && w.state.active.taskId
  const chat = () => ana.M._test.getSession().hive.doc.getArray('chat').toArray()
  const tasks = () => ana.M._test.getSession().hive.doc.getMap('tasks')
  await waitUntil(() => taskId && tasks().get(taskId), 15000)
  T('E1 one @all task and one chat line in the room, posted by GitHub', !!taskId && tasks().get(taskId) && tasks().get(taskId).to === 'all' && chat().some((m) => m.by === 'GitHub' && /Issue #1:/.test(m.text)), taskId)
  T('E2 the issue text arrives quoted, its @mention neutralised', chat().some((m) => m.by === 'GitHub' && /> test\.js expects 42/.test(m.text) && !/(^|[^​])@Claude/.test(m.text.split('\n').slice(1).join('\n'))))
  T('E3 the issue gets one comment, without the room id', GH.comments.length === 1 && !GH.comments[0].body.includes(link.split('|')[1]), GH.comments[0] && GH.comments[0].body.slice(0, 120))

  console.log('\n# 2. the agents work: claim, build, review, complete')
  await ana.call('hive_claim', { region: 'app.js', intent: 'make the answer 42' })
  fs.writeFileSync(path.join(ana.dir, 'app.js'), 'export const answer = 42\n')
  await waitUntil(() => read(rev.dir, 'app.js') === 'export const answer = 42\n', 15000)
  await sleep(1500)
  await ana.call('hive_release', { region: 'app.js' })
  await ana.call('hive_complete', { id: taskId, note: 'answer is 42; test.js passes' })
  await sleep(1500)
  await w.tick()
  T('E4 done but not yet reviewed: nothing lands', GH.pulls.length === 0 && w.state.active && g(project, 'rev-parse', 'fix').out === g(project, 'rev-parse', 'main').out)
  const rv = await rev.call('hive_review', { files: ['app.js'], verdict: 'pass', note: 'checked: 42, test passes' })
  await sleep(1500)

  console.log('\n# 3. the watcher lands it: tests, push, one PR')
  await w.tick()
  const ok = await waitUntil(() => GH.pulls.length === 1, 5000)
  T('E5 reviewed by a non-writer: it landed, and ONE pull request was opened', ok && GH.pulls.length === 1, `review: ${rv.split('\n')[0]} | landIssue said: ${lastLand ? String(lastLand.why || JSON.stringify(lastLand)).slice(0, 300) : '(not called)'}`)
  const pr = GH.pulls[0] || {}
  T('E6 the PR is titled after the issue and says the tests ran and passed', /Make the answer 42 \(#1\)/.test(pr.title || '') && /passed on [0-9a-f]{7}, the exact commit pushed/.test(pr.body || ''), (pr.body || '').split('\n').find((l) => /Tests/.test(l)))
  T('E7 origin has the landed tip, with Ana as the author of the commit', g(origin, 'rev-parse', 'fix').out === g(project, 'rev-parse', 'fix').out && /^Ana\|/.test(g(project, 'log', '-1', '--format=%an|%s', 'fix').out), g(project, 'log', '-1', '--format=%an|%s', 'fix').out)
  T('E8 the issue gets the PR link, and the room is told', GH.comments.some((c) => /pull request #7/.test(c.body)) && chat().some((m) => m.by === 'GitHub' && /landed as PR #7/.test(m.text)))

  console.log('\n# 4. a review comment on the PR goes back to the room; the fix updates the SAME PR')
  const landedTip = g(project, 'rev-parse', 'fix').out
  GH.pulls[0].head.sha = landedTip
  GH.reviewComments = [{ id: 501, user: { login: 'owner', type: 'User' }, author_association: 'OWNER', body: 'name the magic number @Rev', path: 'app.js', line: 1, commit_id: landedTip }]
  await w.tick()
  const rTask = w.state.active && w.state.active.kind === 'review' && w.state.active.taskId
  await waitUntil(() => rTask && tasks().get(rTask), 15000)
  T('E9 the review comment became ONE @all task in the room, naming the line\'s author, with its @mention neutralised', !!rTask && tasks().get(rTask) && tasks().get(rTask).to === 'all' && chat().some((m) => m.by === 'GitHub' && /PR #7/.test(m.text) && /Ana/.test(m.text) && !/(^|[^​])@Rev/.test(m.text)), rTask)
  T('E10 ...and the PR is told it went to the agents', GH.comments.some((c) => c.n === 7 && /Sent 1 review comment/.test(c.body)))
  await ana.call('hive_claim', { region: 'app.js', intent: 'name the magic number' })
  fs.writeFileSync(path.join(ana.dir, 'app.js'), 'const ANSWER = 42\nexport const answer = ANSWER\n')
  await waitUntil(() => read(rev.dir, 'app.js') === 'const ANSWER = 42\nexport const answer = ANSWER\n', 15000)
  await sleep(1500)
  await ana.call('hive_release', { region: 'app.js' })
  await ana.call('hive_complete', { id: rTask, note: 'named it ANSWER' })
  await rev.call('hive_review', { files: ['app.js'], verdict: 'pass', note: 'named, tests pass' })
  await sleep(1500)
  await w.tick()
  T('E11 the fix landed on the SAME PR: still one PR, origin moved past the first landing', GH.pulls.length === 1 && g(origin, 'rev-parse', 'fix').out === g(project, 'rev-parse', 'fix').out && g(project, 'rev-parse', 'fix').out !== landedTip && g(project, 'show', 'fix:app.js').out.includes('ANSWER'), lastLand ? String(lastLand.why || '').slice(0, 200) : '')
  T('E12 ...and PR #7 says the fixes were pushed', GH.comments.some((c) => c.n === 7 && /fixes for the review are pushed/.test(c.body)))
} catch (e) {
  T('the test itself crashed', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const X of agents) { try { X._test.getSession().hive.stop() } catch { } }
  try { relay.kill() } catch { }
  console.log(`\n${pass} passed, ${fail} failed`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
