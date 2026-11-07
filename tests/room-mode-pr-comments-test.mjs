// tests/room-mode-pr-comments-test.mjs -- B4: PR Review Comments & /hivecode <text> Comments in Room Mode
//
//   node tests/room-mode-pr-comments-test.mjs
//
// Real relay (server.js), real git repository with an origin bare repo, makeGitHub from hive-github.js
// backed by fakeGitHub (matching tests/github-watcher-test.mjs), and room-mode PR feedback functions
// in hive-room-mode.js.
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { makeGitHub } from '../hive-github.js'
import * as RM from '../hive-room-mode.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let pass = 0
let fail = 0
const T = (desc, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${desc}${extra ? `   (${extra})` : ''}`)
  ok ? pass++ : fail++
}

const freePort = () => new Promise((res) => {
  const s = net.createServer()
  s.listen(0, () => {
    const p = s.address().port
    s.close(() => res(p))
  })
})

const PORT = await freePort()
const RELAY = `ws://127.0.0.1:${PORT}`
const ROOM = `room-b4-test-${process.pid}`
const LINK = `${RELAY}|${ROOM}`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-b4-'))
const g = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// ── 1. Real git origin + developer clone with multi-author commits ───────────────────────────────
const originDir = path.join(tmp, 'origin.git')
g(tmp, 'init', '-q', '--bare', '-b', 'main', originDir)
const project = path.join(tmp, 'project')
g(tmp, 'clone', '-q', originDir, project)
g(project, 'config', 'user.email', 'dev@example.com')
g(project, 'config', 'user.name', 'Dev')
g(project, 'config', 'core.autocrlf', 'false')

fs.writeFileSync(path.join(project, 'README.md'), '# app\n')
fs.writeFileSync(path.join(project, 'calc.js'), 'export const add = (a, b) => a + b\nexport const mul = (a, b) => a * b\n')
g(project, 'add', '-A')
g(project, 'commit', '-qm', 'initial commit')
g(project, 'push', '-q', '-u', 'origin', 'main')

const originSha = (ref) => {
  const r = g(tmp, '--git-dir', originDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${ref}`)
  return r.code === 0 ? r.out : ''
}

// Create feature branch hivecode/7-fix-calc where Alice writes line 1 and Bob writes line 2
const BRANCH = 'hivecode/7-fix-calc'
g(project, 'checkout', '-q', '-b', BRANCH)
fs.writeFileSync(path.join(project, 'calc.js'), 'export const add = (a, b) => a + b + 1 // Alice bug\nexport const mul = (a, b) => a * b\n')
g(project, 'add', 'calc.js')
g(project, '-c', 'user.name=Alice', '-c', 'user.email=alice@hivecode.local', 'commit', '-qm', 'Alice changes line 1')

fs.writeFileSync(path.join(project, 'calc.js'), 'export const add = (a, b) => a + b + 1 // Alice bug\nexport const mul = (a, b) => a * b * 2 // Bob change\n')
g(project, 'add', 'calc.js')
g(project, '-c', 'user.name=Bob', '-c', 'user.email=bob@hivecode.local', 'commit', '-qm', 'Bob changes line 2')
g(project, 'push', '-q', '-u', 'origin', BRANCH)

const prHeadSha = g(project, 'rev-parse', 'HEAD').out

// Advance local branch by inserting 3 lines at the top of calc.js (simulating a new commit where line 2 is Charlie!)
fs.writeFileSync(
  path.join(project, 'calc.js'),
  '// header line 1\n// header line 2\n// header line 3\nexport const add = (a, b) => a + b + 1 // Alice bug\nexport const mul = (a, b) => a * b * 2 // Bob change\n'
)
g(project, 'add', 'calc.js')
g(project, '-c', 'user.name=Charlie', '-c', 'user.email=charlie@hivecode.local', 'commit', '-qm', 'Charlie prepends 3 header lines locally')
const newHeadSha = g(project, 'rev-parse', 'HEAD').out

// ── 2. fakeGitHub (from tests/github-watcher-test.mjs) ───────────────────────────────────────────
function fakeGitHub({ owner, repo }) {
  const S = {
    issues: new Map(),
    comments: [],
    events: [],
    pulls: new Map(),
    reviews: [],
    reviewComments: [],
    checkRuns: new Map(),
    jobLogs: new Map(),
    labels: [{ name: 'hivecode' }],
    id: 1000,
    num: 0,
    calls: [],
  }
  const ASSOC = { owner: 'OWNER', dev: 'COLLABORATOR', rev2: 'MEMBER', reader: 'COLLABORATOR', stranger: 'NONE' }
  const PERM = { owner: 'admin', dev: 'write', rev2: 'maintain', reader: 'read', stranger: 'none' }
  const user = (login) => ({ login, type: /\[bot\]$/.test(login) ? 'Bot' : 'User' })
  const ok = (body, status = 200) => ({
    status,
    headers: {},
    body: body === undefined ? null : body,
    text: body === undefined ? '' : JSON.stringify(body),
  })
  const no = (status, message) => ({ status, headers: {}, body: { message }, text: JSON.stringify({ message }) })
  const issueView = (i) => ({ ...i, labels: i.labels.map((name) => ({ name })) })
  const pullView = (pr) => ({ ...pr, head: { ...pr.head, sha: pr.head.sha || originSha(pr.head.ref) } })
  const page = (list, q) => {
    const per = Number(q.get('per_page') || 30)
    const p = Number(q.get('page') || 1)
    return list.slice((p - 1) * per, p * per)
  }
  const base = `repos/${owner}/${repo}`
  const R = (s) => new RegExp(`^${base}${s}$`)
  function call(method, apiPath, body) {
    S.calls.push(`${method} ${apiPath}`)
    const [p, qs] = apiPath.split('?')
    const q = new URLSearchParams(qs || '')
    let m
    if (p === 'user') return ok({ login: 'owner' })
    if (p === base) return ok({ default_branch: 'main', private: true, permissions: { push: true } })
    if ((m = p.match(R('/issues/(\\d+)')))) {
      const i = S.issues.get(Number(m[1]))
      return i ? ok(issueView(i)) : no(404, 'Not Found')
    }
    if ((m = p.match(R('/collaborators/([^/]+)/permission')))) {
      const perm = PERM[decodeURIComponent(m[1])]
      return perm ? ok({ permission: perm }) : no(404, 'Not Found')
    }
    if ((m = p.match(R('/issues/(\\d+)/comments')))) {
      const n = Number(m[1])
      if (method === 'POST') {
        const c = { id: ++S.id, issue: n, body: body.body, user: user('owner'), author_association: 'OWNER' }
        S.comments.push(c)
        return ok(c, 201)
      }
      return ok(page(S.comments.filter((c) => c.issue === n), q))
    }
    if ((m = p.match(R('/pulls/(\\d+)')))) {
      const pr = S.pulls.get(Number(m[1]))
      return pr ? ok(pullView(pr)) : no(404, 'Not Found')
    }
    if ((m = p.match(R('/pulls/(\\d+)/reviews')))) return ok(page(S.reviews.filter((r) => r.pr === Number(m[1])), q))
    if ((m = p.match(R('/pulls/(\\d+)/comments')))) return ok(page(S.reviewComments.filter((r) => r.pr === Number(m[1])), q))
    return no(404, `no route for ${method} ${p}`)
  }
  return {
    S,
    call,
    openPr({ issueNumber, branch, sha, title }) {
      const n = ++S.num
      S.issues.set(issueNumber, { number: issueNumber, title, body: '', state: 'open', labels: ['hivecode'], user: user('dev'), updated_at: 'u1' })
      const pr = {
        number: n,
        title,
        body: `Closes #${issueNumber}`,
        state: 'open',
        merged: false,
        merged_at: null,
        head: { ref: branch, sha },
        base: { ref: 'main' },
        html_url: `https://github.com/${owner}/${repo}/pull/${n}`,
      }
      S.pulls.set(n, pr)
      S.issues.set(n, { number: n, title, body: pr.body, state: 'open', labels: [], pull_request: { url: '' }, user: user('owner'), updated_at: 'u2' })
      return n
    },
    comment(n, body, by = 'dev') {
      const c = { id: ++S.id, issue: n, body, user: user(by), author_association: ASSOC[by] || 'NONE' }
      S.comments.push(c)
      return c
    },
    reviewComment(pr, { path: p, line = 1, original_line, commit_id, original_commit_id, body, by = 'dev' }) {
      const r = {
        id: ++S.id,
        pr,
        path: p,
        line,
        ...(original_line !== undefined ? { original_line } : {}),
        commit_id: commit_id || prHeadSha,
        original_commit_id: original_commit_id || commit_id || prHeadSha,
        body,
        user: user(by),
        author_association: ASSOC[by] || 'NONE',
      }
      S.reviewComments.push(r)
      return r
    },
    review(pr, { state = 'COMMENTED', body = '', by = 'dev' }) {
      const r = { id: ++S.id, pr, state, body, user: user(by), author_association: ASSOC[by] || 'NONE' }
      S.reviews.push(r)
      return r
    },
  }
}

let relayProc = null
let aliceSync = null
let bobSync = null
let revSync = null
let aliceDir = null
let bobDir = null
let revDir = null

try {
  // ── 3. Start real relay and connect room participants Alice, Bob, and Reviewer ──────────────────
  relayProc = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    p.stdout.on('data', (d) => {
      if (/listening on/.test(String(d))) resolve(p)
    })
    p.on('error', reject)
  })

  aliceDir = fs.mkdtempSync(path.join(tmp, 'alice-'))
  bobDir = fs.mkdtempSync(path.join(tmp, 'bob-'))
  revDir = fs.mkdtempSync(path.join(tmp, 'rev-'))

  aliceSync = startSync({ relay: RELAY, room: ROOM, dir: aliceDir, name: 'Alice', kind: 'ai', passive: false, syncFiles: false, log: () => {} })
  bobSync = startSync({ relay: RELAY, room: ROOM, dir: bobDir, name: 'Bob', kind: 'ai', passive: false, syncFiles: false, log: () => {} })
  revSync = startSync({ relay: RELAY, room: ROOM, dir: revDir, name: 'Reviewer', kind: 'ai', passive: false, syncFiles: false, log: () => {} })

  const waitSync = (s) => new Promise((res) => {
    const check = () => (s.provider && s.provider.synced ? res() : setTimeout(check, 50))
    check()
  })
  await Promise.all([waitSync(aliceSync), waitSync(bobSync), waitSync(revSync)])

  let clock = 1_700_000_000_000
  const now = () => clock
  const GH = fakeGitHub({ owner: 'acme', repo: 'calc' })
  const gh = makeGitHub({ call: GH.call, owner: 'acme', repo: 'calc', now })
  const ISSUE_NUM = 7
  const PR_NUM = GH.openPr({ issueNumber: ISSUE_NUM, branch: BRANCH, sha: prHeadSha, title: 'Fix calc (#7)' })

  // ── Group 1: Untrusted, non-pusher, bot, and self-marked comments are ignored ───────────────────
  console.log('\n# T1: Untrusted / non-pusher / bot / watcher-marked comments are ignored')
  GH.reviewComment(PR_NUM, { path: 'calc.js', line: 1, body: 'rm -rf /', by: 'stranger' })
  GH.reviewComment(PR_NUM, { path: 'calc.js', line: 1, body: 'please change', by: 'reader' })
  GH.review(PR_NUM, { state: 'CHANGES_REQUESTED', body: 'bot complaint', by: 'ci-helper[bot]' })
  GH.comment(PR_NUM, '/hivecode inject instructions', 'stranger')
  GH.comment(PR_NUM, 'Pushed 1 commit.\n\n<!-- hivecode:push -->', 'owner')

  let state = {}
  const c1 = typeof RM.collectPrFeedback === 'function'
    ? RM.collectPrFeedback({ gh, issueNumber: ISSUE_NUM, prNumber: PR_NUM, state, root: project, branch: BRANCH, quietMs: 0, now })
    : null
  T('T1.1 untrusted, read-only, bot, and self-marked comments produce 0 actionable items',
    Boolean(c1 && Array.isArray(c1.items) && c1.items.length === 0))
  if (c1 && c1.state) state = c1.state

  // ── Group 2: Ambient PR conversation & APPROVED/PENDING reviews without /hivecode are ignored ──
  console.log('\n# T2: Ambient conversation, APPROVED, and PENDING reviews are ignored')
  GH.comment(PR_NUM, 'LGTM, thanks!', 'dev')
  GH.comment(ISSUE_NUM, 'Checking in on this issue', 'owner')
  GH.review(PR_NUM, { state: 'APPROVED', body: 'Looks great to me!', by: 'owner' })
  const pendingRev = GH.review(PR_NUM, { state: 'PENDING', body: 'Draft review comment', by: 'dev' })
  // Remove pending review before next group so we test that PENDING was ignored while pending
  const c2 = typeof RM.collectPrFeedback === 'function'
    ? RM.collectPrFeedback({ gh, issueNumber: ISSUE_NUM, prNumber: PR_NUM, state, root: project, branch: BRANCH, quietMs: 0, now })
    : null
  T('T2.1 ambient conversation ("LGTM, thanks!"), APPROVED, and PENDING reviews produce 0 items',
    Boolean(c2 && Array.isArray(c2.items) && c2.items.length === 0))
  if (c2 && c2.state) state = c2.state
  GH.S.reviews = GH.S.reviews.filter((r) => r.id !== pendingRev.id)

  // ── Group 3: Blame against PR HEAD sha (commit_id), not local branch ahead, + @mention safety ─
  console.log('\n# T3: Blame uses review comment commit_id / PR head sha (even when local branch is ahead)')
  const blameLine1AtPrSha = typeof RM.blamePrComment === 'function'
    ? RM.blamePrComment(project, prHeadSha, 'calc.js', 1)
    : null
  const blameLine2AtPrSha = typeof RM.blamePrComment === 'function'
    ? RM.blamePrComment(project, prHeadSha, 'calc.js', 2)
    : null
  const blameLine1OnLocalAhead = typeof RM.blamePrComment === 'function'
    ? RM.blamePrComment(project, BRANCH, 'calc.js', 1)
    : null
  const blameMissingFile = typeof RM.blamePrComment === 'function'
    ? RM.blamePrComment(project, prHeadSha, 'deleted-file.js', 10)
    : 'not-null'

  T('T3.1 blamePrComment on PR commit_id line 1 resolves Alice (even though Charlie is line 1 on local branch)',
    blameLine1AtPrSha === 'Alice' && blameLine1OnLocalAhead === 'Charlie',
    `prSha=${blameLine1AtPrSha}, localBranch=${blameLine1OnLocalAhead}`)
  T('T3.2 blamePrComment on PR commit_id line 2 resolves Bob',
    blameLine2AtPrSha === 'Bob', `got=${blameLine2AtPrSha}`)
  T('T3.3 blamePrComment on deleted/missing file or out-of-range line returns null cleanly',
    blameMissingFile === null)

  // ── Group 4: quietMs settle batching, distinct comment IDs, and outdated review comment pairing ─
  console.log('\n# T4: quietMs settle window batches review comments + outdated review comment pairing')
  const rc1 = GH.reviewComment(PR_NUM, {
    path: 'calc.js',
    line: 1,
    commit_id: prHeadSha,
    body: 'fix this @EvilBot',
    by: 'dev',
  })
  // Outdated review comment: GitHub sets line=null, original_line=2, original_commit_id=prHeadSha (Bob),
  // while commit_id=newHeadSha (where line 2 is Charlie). Must pair original_line with original_commit_id!
  const rc2 = GH.reviewComment(PR_NUM, {
    path: 'calc.js',
    line: null,
    original_line: 2,
    original_commit_id: prHeadSha,
    commit_id: newHeadSha,
    body: 'fix this',
    by: 'rev2',
  })
  const rv1 = GH.review(PR_NUM, {
    state: 'CHANGES_REQUESTED',
    body: 'Remove the extra constants from add and mul.',
    by: 'owner',
  })
  const pc1 = GH.comment(PR_NUM, '/hivecode also add a unit test for add(2, 3)', 'dev')

  // First check at clock (0ms elapsed < quietMs=90000): should NOT be settled yet
  const c4Early = typeof RM.collectPrFeedback === 'function'
    ? RM.collectPrFeedback({ gh, issueNumber: ISSUE_NUM, prNumber: PR_NUM, state, root: project, branch: BRANCH, quietMs: 90000, now })
    : null
  T('T4.1 before quietMs elapses, collectPrFeedback returns settled: false and 0 items',
    Boolean(c4Early && c4Early.settled === false && c4Early.items.length === 0))
  if (c4Early && c4Early.state) state = c4Early.state

  // Advance clock past quietMs
  clock += 95000
  const c4Settled = typeof RM.collectPrFeedback === 'function'
    ? RM.collectPrFeedback({ gh, issueNumber: ISSUE_NUM, prNumber: PR_NUM, state, root: project, branch: BRANCH, quietMs: 90000, now })
    : null
  T('T4.2 after quietMs elapses, all 4 comments settle into 1 batch',
    Boolean(c4Settled && c4Settled.settled === true && c4Settled.items.length === 4),
    c4Settled ? `items=${c4Settled.items.length}` : 'no collectPrFeedback')
  T('T4.3 batch signature includes comment IDs (rc, rv, pc) and preserves two reviewers writing "fix this"',
    Boolean(
      c4Settled &&
      c4Settled.sig &&
      c4Settled.sig.includes(String(rc1.id)) &&
      c4Settled.sig.includes(String(rc2.id)) &&
      c4Settled.sig.includes(String(rv1.id)) &&
      c4Settled.sig.includes(String(pc1.id))
    ),
    c4Settled ? c4Settled.sig : '')
  T('T4.4 current inline review comment (line=1) blames commit_id -> Alice',
    Boolean(c4Settled && c4Settled.items[0] && c4Settled.items[0].lineAuthor === 'Alice'))
  T('T4.5 outdated review comment (line=null, original_line=2) pairs original_line with original_commit_id -> Bob (not Charlie at commit_id)',
    Boolean(
      c4Settled &&
      c4Settled.items[1] &&
      c4Settled.items[1].line === 2 &&
      c4Settled.items[1].commitId === prHeadSha &&
      c4Settled.items[1].lineAuthor === 'Bob'
    ),
    c4Settled && c4Settled.items[1] ? `lineAuthor=${c4Settled.items[1].lineAuthor} commitId=${c4Settled.items[1].commitId}` : 'missing item[1]')

  // ── Group 5: postPrFeedback assigns @all task, @mentions line authors in chat, neutralises body @ ─
  console.log('\n# T5: postPrFeedback delivery, @all task + @<lineAuthor> chat, and idempotency')
  // First test Q657 when verification fails (using an isolated mock syncRunner so nothing is written to the live room yet):
  const pFail = typeof RM.postPrFeedback === 'function'
    ? await RM.postPrFeedback({
        link: LINK,
        gh,
        issueNumber: ISSUE_NUM,
        prNumber: PR_NUM,
        root: project,
        branch: BRANCH,
        state,
        quietMs: 90000,
        now,
        syncRunner: async () => ({
          tasks: new Map(),
          assign: () => 't-dropped',
          say: () => {},
          stop: () => {},
        }),
        verifierRunner: async () => false,
      })
    : null
  T('T5.1 when delivery verification fails (Q657), state.seen does NOT advance so next poll retries',
    Boolean(pFail && pFail.ok === false && pFail.code === 'Q657' && (!pFail.state || (pFail.state.seen && pFail.state.seen.rc < rc2.id))))

  // Now post to the real relay with real verification!
  const pOk = typeof RM.postPrFeedback === 'function'
    ? await RM.postPrFeedback({
        link: LINK,
        gh,
        issueNumber: ISSUE_NUM,
        prNumber: PR_NUM,
        root: project,
        branch: BRANCH,
        state,
        quietMs: 90000,
        now,
      })
    : null
  T('T5.2 postPrFeedback succeeds and verifies delivery on real relay',
    Boolean(pOk && pOk.ok === true && pOk.verified === true && pOk.taskId))
  if (pOk && pOk.state) state = pOk.state

  await new Promise((r) => setTimeout(r, 300))
  const tasksMap = aliceSync.doc.getMap('tasks')
  const postedTask = pOk && pOk.taskId ? tasksMap.get(pOk.taskId) : null
  const chatArr = aliceSync.doc.getArray('chat').toArray()
  const prChat = chatArr.find((m) => m && m.text && m.text.includes(`PR #${PR_NUM} review feedback`))

  T('T5.3 task is assigned to "all" (never locked to a single agent who might be GONE) and starts with Fix for PR #<pr>',
    Boolean(postedTask && postedTask.to === 'all' && /^Fix for PR #\d+:/.test(postedTask.text)),
    postedTask ? `to=${postedTask.to} text=${postedTask.text}` : 'missing task')
  T('T5.4 chat message @mentions @all AND line authors (@Alice, @Bob), while neutralising @EvilBot inside body',
    Boolean(
      prChat &&
      prChat.text.includes('@all') &&
      prChat.text.includes('@Alice') &&
      prChat.text.includes('@Bob') &&
      !prChat.text.includes('@EvilBot') &&
      prChat.text.includes('@\u200BEvilBot')
    ),
    prChat ? prChat.text.slice(0, 160) : 'missing chat')

  // Re-poll with same state -> nothing new
  const pAgainSameState = typeof RM.postPrFeedback === 'function'
    ? await RM.postPrFeedback({
        link: LINK,
        gh,
        issueNumber: ISSUE_NUM,
        prNumber: PR_NUM,
        root: project,
        branch: BRANCH,
        state,
        quietMs: 0,
        now,
      })
    : null
  T('T5.5 subsequent poll with updated state.seen does not create a duplicate task',
    Boolean(pAgainSameState && pAgainSameState.ok === true && pAgainSameState.noop === true))

  // Simulate watcher restart with empty state={} -> room task idempotency catches it by batch sig!
  const taskCountBefore = tasksMap.size
  const pRestartedWatcher = typeof RM.postPrFeedback === 'function'
    ? await RM.postPrFeedback({
        link: LINK,
        gh,
        issueNumber: ISSUE_NUM,
        prNumber: PR_NUM,
        root: project,
        branch: BRANCH,
        state: {},
        quietMs: 0,
        now,
      })
    : null
  T('T5.6 watcher restart with wiped state detects existing task in room by batch sig (already: true)',
    Boolean(pRestartedWatcher && pRestartedWatcher.ok === true && pRestartedWatcher.already === true && tasksMap.size === taskCountBefore))

  // ── Group 6: End-to-end flow: any live teammate can complete the @all task & land updates SAME PR
  console.log('\n# T6: End-to-end room fix -> non-writer review -> landIssue updates existing PR')
  // Suppose Alice disconnects (is GONE), and Bob fixes calc.js, completes the @all task, and Reviewer reviews
  if (postedTask) {
    await bobSync.edit('calc.js', 'export const add = (a, b) => a + b\nexport const mul = (a, b) => a * b\n', 'Fix calc per PR review')
    bobSync.complete(postedTask.id, 'Fixed add and mul per review comments')
  }
  await new Promise((r) => setTimeout(r, 400))
  const revOut = await revSync.review(['calc.js'], 'pass', 'Verified PR feedback fix')
  await new Promise((r) => setTimeout(r, 300))
  const reviewedHash = (revSync.reviews('calc.js')[0] || {}).hash || ''

  const landRes = postedTask && typeof RM.landIssue === 'function'
    ? await RM.landIssue({
        link: LINK,
        taskId: postedTask.id,
        issue: { number: ISSUE_NUM, title: 'Fix calc' },
        root: project,
        branch: BRANCH,
        syncRunner: async () => bobSync,
        landRunner: async (opts) => {
          if (opts.dry) {
            return {
              ok: true,
              plan: [{ agent: 'Bob', files: ['calc.js'] }],
              hashes: { 'calc.js': reviewedHash },
              deletions: [],
            }
          }
          return {
            ok: true,
            tip: 'deadbeef',
            plan: [{ agent: 'Bob', files: ['calc.js'] }],
            pr: { number: PR_NUM, url: `https://github.com/acme/calc/pull/${PR_NUM}`, created: false, updated: true },
          }
        },
      })
    : null
  T('T6.1 Bob (even if Alice is away) completes the @all PR feedback task and landIssue updates the SAME PR',
    Boolean(landRes && landRes.ok === true && landRes.pr && landRes.pr.number === PR_NUM && landRes.pr.updated === true && landRes.pr.created === false),
    landRes ? landRes.why || JSON.stringify(revOut) : 'null')

} finally {
  if (revSync) try { revSync.stop() } catch {}
  if (aliceSync) try { aliceSync.stop() } catch {}
  if (bobSync) try { bobSync.stop() } catch {}
  if (relayProc) try { relayProc.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
