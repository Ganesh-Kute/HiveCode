// tests/gh-action-workflow-test.mjs -- Issue #22 follow-up, Fix 1:
//   1. installStepsFor(dir) detects lockfiles / manifests accurately (and returns empty on non-JS repos).
//   2. workflowFile() and `github action --workflow` emit the detected install step(s) after setup-node
//      and before the Hivecode step, or a commented placeholder containing "add the install step here".
//   3. Missing-dependency Q576 failures (even past the 600-char quote) comment "Add an install step"
//      and ".github/workflows/hivecode.yml" with mark `deps=1 at=<sha>`, retry on a new `runAt` SHA,
//      and keep skipping on the same `runAt` SHA (while non-dep Q576 failures stay skipped across SHAs).
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as A from '../hive-gh-action.js'

let pass = 0
let fail = 0
function T(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? `   (${String(extra).slice(0, 300)})` : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-wf-test-'))
const makeProject = (name, files = {}) => {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), body)
  }
  return dir
}

const markFields = (body, kind) => {
  const m = String(body || '').match(new RegExp(`<!-- hivecode:room kind=${kind}((?: [a-z0-9_]+=[^ ]*)*) -->`))
  if (!m) return null
  const out = {}
  for (const part of m[1].trim().split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf('=')
    out[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return out
}

function makeFakeGitHub() {
  let clock = Date.parse('2026-11-12T00:00:00Z')
  const tick = () => new Date((clock += 1000)).toISOString()
  let ids = 100
  const comments = [
    { id: ++ids, body: 'Sent to the room.\n\n<!-- hivecode:room kind=sent task=t1 -->', created_at: tick(), user: { login: 'github-actions[bot]', type: 'Bot' } },
  ]
  const pulls = []
  return {
    owner: 'acme',
    repo: 'app',
    commentsList: comments,
    pulls,
    pullsFor: () => pulls,
    labeledIssues: () => [{ number: 7, title: 'Fix widgets', body: 'desc', state: 'open', labels: [{ name: 'hivecode' }] }],
    issueEvents: () => [{ event: 'labeled', label: { name: 'hivecode' }, actor: { login: 'ganesh' }, created_at: '2026-11-11T23:59:00Z' }],
    comments: () => comments,
    comment: (_n, body) => { const c = { id: ++ids, body, created_at: tick(), user: { login: 'github-actions[bot]', type: 'Bot' } }; comments.push(c); return c },
    permission: () => 'admin',
    checkRuns: () => [],
    statuses: () => [],
    createPull: (p) => { const pr = { number: 10, state: 'open', head: { ref: p.head, sha: 'sha-pr' }, base: { ref: p.base }, title: p.title, body: p.body, html_url: 'https://github.test/acme/app/pull/10' }; pulls.push(pr); return pr },
  }
}

function makeDeps(onLand) {
  return {
    tasks: async () => [{ id: 't1', by: 'GitHub', text: 'Issue #7: Fix widgets', status: 'done', createdAt: 1 }],
    assignFix: async () => {},
    say: async () => {},
    postIssue: async () => ({ ok: true }),
    bind: async () => {},
    landIssue: async (o) => onLand(o),
    prFeedback: async () => ({ ok: true, items: [] }),
  }
}

console.log('# Fix 1: workflow template installs dependencies & Q576 missing-deps handling')
try {
  // ── 1. installStepsFor(dir) ────────────────────────────────────────────────────────────────────
  const hasFn = typeof A.installStepsFor === 'function'
  T('W1 installStepsFor is exported', hasFn)

  const lockCases = [
    ['npm-lock', { 'package.json': '{}', 'package-lock.json': '{}' }, 'package-lock.json', ['npm ci']],
    ['npm-shrinkwrap', { 'package.json': '{}', 'npm-shrinkwrap.json': '{}' }, 'npm-shrinkwrap.json', ['npm ci']],
    ['pnpm-lock', { 'package.json': '{}', 'pnpm-lock.yaml': '' }, 'pnpm-lock.yaml', ['corepack enable && pnpm install --frozen-lockfile']],
    ['yarn-lock', { 'package.json': '{}', 'yarn.lock': '' }, 'yarn.lock', ['yarn install --frozen-lockfile']],
    ['npm-nolock', { 'package.json': '{}' }, 'package.json', ['npm install']],
    ['empty-repo', {}, '', []],
  ]

  for (const [name, files, wantFound, wantCmds] of lockCases) {
    const dir = makeProject(name, files)
    const got = hasFn ? A.installStepsFor(dir) : null
    const ok = !!got && got.found === wantFound && JSON.stringify(got.commands) === JSON.stringify(wantCmds)
    T(`W2 installStepsFor(${name}) -> found="${wantFound}" commands=${JSON.stringify(wantCmds)}`, ok, got && JSON.stringify(got))
  }

  // ── 2. workflowFile({ branch, version, install }) & main --workflow ────────────────────────────
  if (hasFn) {
    const npmWf = A.workflowFile({ branch: 'feat', install: A.installStepsFor(path.join(TMP, 'npm-lock')) })
    T(
      'W3 workflowFile puts "- run: npm ci" after setup-node and before Hivecode step',
      /actions\/setup-node@[\s\S]*- run: npm ci[\s\S]*npx -y hivecode-mcp@/.test(npmWf),
      npmWf
    )

    const multiWf = A.workflowFile({ branch: 'feat', install: { found: 'custom', commands: ['step one', 'step two'] } })
    T(
      'W4 workflowFile emits one "- run:" per command in order',
      /actions\/setup-node@[\s\S]*- run: step one[\s\S]*- run: step two[\s\S]*npx -y hivecode-mcp@/.test(multiWf),
      multiWf
    )

    const emptyWf = A.workflowFile({ branch: 'feat', install: A.installStepsFor(path.join(TMP, 'empty-repo')) })
    T(
      'W5 workflowFile with no commands emits commented placeholder mentioning "add the install step here"',
      /#.*add the install step here/i.test(emptyWf) && /actions\/setup-node@[\s\S]*add the install step here[\s\S]*npx -y hivecode-mcp@/i.test(emptyWf),
      emptyWf
    )

    const defaultWf = A.workflowFile({ branch: 'feat' })
    T('W6 workflowFile without install option falls back cleanly with placeholder', /#.*add the install step here/i.test(defaultWf), defaultWf)
  } else {
    T('W3 workflowFile puts "- run: npm ci" after setup-node and before Hivecode step', false, 'installStepsFor missing')
    T('W4 workflowFile emits one "- run:" per command in order', false, 'installStepsFor missing')
    T('W5 workflowFile with no commands emits commented placeholder mentioning "add the install step here"', false, 'installStepsFor missing')
    T('W6 workflowFile without install option falls back cleanly with placeholder', false, 'installStepsFor missing')
  }

  // CLI: `github action --workflow` auto-detects from cwd
  {
    const outNpm = []
    const codeNpm = await A.main(['--workflow', '--branch', 'feat'], { cwd: path.join(TMP, 'npm-lock'), log: (m) => outNpm.push(String(m)), logErr: () => {} })
    T(
      'W7 main --workflow detects package-lock.json in cwd and prints "- run: npm ci"',
      codeNpm === 0 && /HIVE_BRANCH: feat/.test(outNpm.join('\n')) && /- run: npm ci/.test(outNpm.join('\n')),
      outNpm.join('\n')
    )

    const outEmpty = []
    const codeEmpty = await A.main(['--workflow', '--branch', 'feat'], { cwd: path.join(TMP, 'empty-repo'), log: (m) => outEmpty.push(String(m)), logErr: () => {} })
    T(
      'W8 main --workflow in empty repo prints placeholder instead of npm ci',
      codeEmpty === 0 && !/^\s*- run: npm ci/m.test(outEmpty.join('\n')) && /#.*add the install step here/i.test(outEmpty.join('\n')),
      outEmpty.join('\n')
    )
  }

  // ── 3. Q576 missing-deps comment, >600 chars, deps=1 at=<sha>, retry on new runAt SHA ──────────
  const needPatterns = [
    'Cannot find module',
    'Cannot find package',
    'ERR_MODULE_NOT_FOUND',
    'MODULE_NOT_FOUND',
    'No module named',
  ]
  for (const needle of needPatterns) {
    const gh = makeFakeGitHub()
    const longWhy = `not landed: the tests failed (exit 1) on deadbeef.\n${'line '.repeat(140)}\n${needle} 'some-pkg'\nNothing was changed.`
    const landCalls = []
    const deps = makeDeps((o) => {
      landCalls.push(o)
      if (o.state && o.state.lastFailedFingerprint === 'fp-deps') return { ok: false, skipped: true }
      return { ok: false, code: 'Q576', fingerprint: 'fp-deps', why: longWhy }
    })

    await A.runAction({ gh, deps, eventName: 'schedule', branch: 'feat', base: 'main', runAt: 'sha111' })
    const c1 = gh.commentsList.slice().reverse().find((c) => markFields(c.body, 'land'))
    const mark = c1 && markFields(c1.body, 'land')
    T(
      `W9 Q576 "${needle}" (>600 chars) comments Add an install step + .github/workflows/hivecode.yml + mark deps=1 at=sha111`,
      !!c1 && /Add an install step/.test(c1.body) && /\.github\/workflows\/hivecode\.yml/.test(c1.body) && mark && mark.code === 'Q576' && mark.deps === '1' && mark.at === 'sha111',
      c1 && c1.body
    )

    if (needle === 'Cannot find module') {
      // Same runAt SHA -> stays skipped (passes lastFailedFingerprint)
      await A.runAction({ gh, deps, eventName: 'schedule', branch: 'feat', base: 'main', runAt: 'sha111' })
      T(
        'W10 same runAt SHA passes lastFailedFingerprint and skips landing',
        landCalls.length === 2 && landCalls[1].state && landCalls[1].state.lastFailedFingerprint === 'fp-deps',
        landCalls[1] && JSON.stringify(landCalls[1].state)
      )

      // Workflow fixed on default branch -> new runAt SHA -> clears lastFailedFingerprint and lands!
      const depsFixed = makeDeps((o) => {
        landCalls.push(o)
        if (o.state && o.state.lastFailedFingerprint === 'fp-deps') return { ok: false, skipped: true }
        return { ok: true, pr: { number: 10, url: 'https://github.test/acme/app/pull/10', created: true }, tests: { ran: true, command: 'npm test' }, fingerprint: 'fp-deps' }
      })
      await A.runAction({ gh, deps: depsFixed, eventName: 'schedule', branch: 'feat', base: 'main', runAt: 'sha222' })
      const okComment = gh.commentsList.slice().reverse().find((c) => /Pull request #10 is open for review/.test(c.body))
      T(
        'W11 changed runAt SHA clears lastFailedFingerprint and opens PR without room changes',
        landCalls.length === 3 && !landCalls[2].state.lastFailedFingerprint && !!okComment,
        `calls=${landCalls.length} fp=${landCalls[2] && landCalls[2].state && landCalls[2].state.lastFailedFingerprint}`
      )
    }
  }

  // Ordinary (non-dependency) Q576 failure: no install-step hint, no deps=1, and changed runAt still skips
  {
    const gh = makeFakeGitHub()
    const landCalls = []
    const deps = makeDeps((o) => {
      landCalls.push(o)
      if (o.state && o.state.lastFailedFingerprint === 'fp-logic') return { ok: false, skipped: true }
      return { ok: false, code: 'Q576', fingerprint: 'fp-logic', why: 'not landed: the tests failed (exit 1).\nAssertionError: 1 !== 2\nNothing was changed.' }
    })
    await A.runAction({ gh, deps, eventName: 'schedule', branch: 'feat', base: 'main', runAt: 'sha111' })
    const c1 = gh.commentsList.slice().reverse().find((c) => markFields(c.body, 'land'))
    const mark = c1 && markFields(c1.body, 'land')
    await A.runAction({ gh, deps, eventName: 'schedule', branch: 'feat', base: 'main', runAt: 'sha222' })
    T(
      'W12 non-dependency Q576 has no deps=1/install-step hint and still skips across changed runAt SHA',
      !!c1 && !/Add an install step/.test(c1.body) && mark && mark.deps !== '1' && landCalls.length === 2 && landCalls[1].state.lastFailedFingerprint === 'fp-logic',
      `${c1 && c1.body} | nextFp=${landCalls[1] && landCalls[1].state && landCalls[1].state.lastFailedFingerprint}`
    )
  }
} catch (e) {
  T('test suite finished without throwing', false, e && e.stack)
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== GH ACTION WORKFLOW: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
