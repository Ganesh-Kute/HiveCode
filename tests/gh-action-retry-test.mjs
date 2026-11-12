// tests/gh-action-retry-test.mjs -- what the GitHub Action does on the run AFTER a first-run failure.
//
// The Action keeps no state between runs: it reads its own marks back from the issue's comments. These
// checks drive several runs in a row against a stand-in GitHub and a stand-in landing, and pin the three
// rules that only show on the second run:
//   A. a PR on the branch is linked to the issue only once the issue's work is on the branch
//      (a landing that worked, OR a push whose PR could not be opened);
//   B. after "pushed, but the PR could not be opened" (Q574) every later run tries again, and the
//      issue is told once;
//   C. after "the tests could not find a dependency" the landing is tried again when the checkout
//      moved, and a retry that still fails is recorded against the new checkout, once.
import * as A from '../hive-gh-action.js'

let pass = 0
let fail = 0
const T = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? `   (${String(extra).slice(0, 400)})` : ''}`) }
}

// One issue (#5) labelled `hivecode`, already sent to the room as task t1, on branch `feat`.
function world() {
  let clock = Date.parse('2026-11-11T10:00:00Z')
  const tick = () => new Date((clock += 1000)).toISOString()
  const list = []
  const pulls = []
  const writes = []
  const said = []
  const landCalls = []
  const issue = { number: 5, title: 'Fix it', body: 'b', state: 'open', user: { login: 'g' }, labels: [{ name: 'hivecode' }] }
  const events = [{ event: 'labeled', label: { name: 'hivecode' }, actor: { login: 'g' }, created_at: tick() }]
  const gh = {
    owner: 'a',
    repo: 'b',
    issueEvents: () => events,
    comments: () => list,
    comment: (_n, body) => { list.push({ body, created_at: tick() }) },
    labeledIssues: () => [issue],
    permission: () => 'admin',
    pullsFor: () => pulls,
    issue: () => issue,
    removeLabel: () => {},
    updatePull: (n, p) => { writes.push({ n, p }); Object.assign(pulls.find((x) => x.number === n), p) },
    checkRuns: () => [],
    statuses: () => [],
  }
  gh.comment(5, 'Sent.\n\n<!-- hivecode:room kind=sent task=t1 -->')
  const w = { gh, list, pulls, writes, said, landCalls, land: null }
  w.task = { id: 't1', by: 'GitHub', text: 'Issue #5: Fix it', status: 'done', createdAt: 1 }
  const deps = {
    tasks: async () => [w.task],
    say: async (t) => { said.push(t) },
    bind: async () => {},
    prFeedback: async () => ({ ok: true, items: [] }),
    assignFix: async () => {},
    landIssue: async (o) => { landCalls.push(o); return w.land },
  }
  w.run = (runAt = 'aaa') => A.runAction({ gh, deps, eventName: 'schedule', event: {}, branch: 'feat', base: 'main', runAt })
  w.last = () => list[list.length - 1].body
  w.adopted = () => list.filter((c) => /kind=adopted/.test(c.body)).length
  return w
}

const PR_REFUSED = 'Q574 the work is pushed to feat, but opening the PR failed: Q603 GitHub answered POST pulls with HTTP 403: GitHub Actions is not permitted to create or approve pull requests.'

console.log('# A. a PR on the branch is linked only once the issue\'s work is on the branch')
{
  const w = world()
  w.task.status = 'open'
  w.pulls.push({ number: 23, state: 'open', head: { ref: 'feat', sha: 's' }, body: 'setup fix' })
  await w.run()
  T('A1 a PR open before any landing is left alone', w.writes.length === 0 && w.adopted() === 0 && w.said.length === 0)

  w.task.status = 'done'
  w.land = { ok: false, code: 'Q576', why: 'Q576 not landed: the tests failed (exit 1)', fingerprint: 'f1' }
  await w.run()
  T('A2 still left alone after a landing that was refused', w.writes.length === 0 && w.adopted() === 0)

  w.land = { ok: true, pr: { number: 23, url: 'u', created: false, updated: true }, fingerprint: 'f2', tests: { ran: true, command: 'npm test' } }
  await w.run()
  T('A3 a landing that goes onto it links it in the same run', w.writes.length === 1 && /^Closes #5\n/.test(w.pulls[0].body) && w.adopted() === 1, w.pulls[0].body)

  await w.run()
  T('A4 and links it once', w.writes.length === 1 && w.adopted() === 1)
}
{
  // The push worked, the PR could not be opened, and a person opens the PR by hand.
  const w = world()
  w.land = { ok: false, code: 'Q574', onBranch: true, fingerprint: 'f1', why: PR_REFUSED }
  await w.run()
  w.pulls.push({ number: 24, state: 'open', head: { ref: 'feat' }, body: 'opened by hand' })
  w.land = { ok: false, skipped: true, nothing: true }
  await w.run()
  T('A5 a PR opened by hand after "pushed, PR refused" is linked', /^Closes #5\n/.test(w.pulls[0].body) && w.adopted() === 1, w.pulls[0].body)
}

console.log('# B. pushed, but the PR could not be opened: say so once, try again every run')
{
  const w = world()
  w.land = { ok: false, code: 'Q574', onBranch: true, fingerprint: 'f1', why: PR_REFUSED }
  await w.run()
  const c = w.last()
  T('B1 the comment says pushed, names the setting, and is marked pushed=1',
    /is pushed to `feat`/.test(c) && /Allow GitHub Actions to create and approve pull requests/.test(c) && /by hand/.test(c) &&
    !/Nothing was pushed/.test(c) && /kind=land fp=f1 code=Q574 pushed=1 -->/.test(c), c)
  T('B2 the room is told the work is pushed and there is nothing to fix',
    w.said.length === 1 && /is pushed to feat/.test(w.said[0]) && /nothing to fix in the room/.test(w.said[0]), w.said[0])

  const before = w.list.length
  w.land = { ...w.land, fingerprint: 'f2' }
  await w.run()
  T('B3 the next run tries the landing again', w.landCalls.length === 2 && w.landCalls[1].state.lastFailedFingerprint === '')
  T('B4 and a second refusal is not told twice', w.list.length === before && w.said.length === 1)

  w.land = { ok: true, pr: { number: 30, url: 'u', created: true }, fingerprint: 'f2' }
  await w.run()
  T('B5 once the setting is on, the next run opens the PR',
    w.landCalls.length === 3 && w.landCalls[2].state.lastFailedFingerprint === '' && /Pull request #30 is open for review/.test(w.last()), w.last())
}
{
  // Q574 with nothing pushed (no branch to open the PR into) is an ordinary refusal.
  const w = world()
  w.land = { ok: false, code: 'Q574', fingerprint: 'f1', why: 'Q574 there is no branch to open the PR into; pass --base <branch>. Nothing was changed.' }
  await w.run()
  T('B6 Q574 without a push keeps "Nothing was pushed" and no pushed=1', /Nothing was pushed/.test(w.last()) && !/pushed=1/.test(w.last()), w.last())
  await w.run()
  T('B7 and is remembered by its fingerprint', w.landCalls[1].state.lastFailedFingerprint === 'f1')
}

console.log('# C. missing dependencies: try again when the checkout moved')
{
  const w = world()
  w.land = {
    ok: false,
    code: 'Q576',
    fingerprint: 'f1',
    why: 'Q576 not landed: the tests failed (exit 1) on abc.\n' + 'x'.repeat(900) + "\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'yjs'\nNothing was changed.",
  }
  await w.run('aaa')
  T('C1 the comment names the fix and records the checkout', /Add an install step/.test(w.last()) && /deps=1 at=aaa -->/.test(w.last()), w.last().slice(-300))

  const before = w.list.length
  await w.run('aaa')
  T('C2 same checkout: skipped by fingerprint, nothing said', w.landCalls[1].state.lastFailedFingerprint === 'f1' && w.list.length === before)

  await w.run('bbb')
  T('C3 the checkout moved: the landing is tried again', w.landCalls[2].state.lastFailedFingerprint === '')
  T('C4 a retry that still fails is recorded against the new checkout, once', w.list.length === before + 1 && /deps=1 at=bbb -->/.test(w.last()), w.last().slice(-120))

  await w.run('bbb')
  T('C5 then it is skipped again on that checkout', w.landCalls[3].state.lastFailedFingerprint === 'f1' && w.list.length === before + 1)
}
{
  const w = world()
  w.land = { ok: false, code: 'Q576', fingerprint: 'f1', why: 'Q576 not landed: the tests failed (exit 1): 1 assertion failed' }
  await w.run('aaa')
  await w.run('bbb')
  T('C6 an ordinary test failure is not retried on a new checkout', w.landCalls[1].state.lastFailedFingerprint === 'f1' && !/install step/.test(w.last()))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
