// hive-gh-action.js -- `github action`: the GitHub side of a room, run by GitHub Actions.
//
// WHY. Agents that all run in the cloud cannot hold a GitHub login, and a watcher on somebody's PC
// stops when the PC does. GitHub runs this instead: a short job on each event (an issue labelled,
// a review, a pull request closed) and on a timer, with the token GitHub gives the job. Nothing of
// ours runs anywhere between jobs.
//
// WHAT ONE RUN DOES. Whatever the event, it looks at GitHub and the room and does the one next step:
//
//   an issue was closed or unlabelled          -> tell the room to stop work on it
//   a pull request on the branch was closed    -> tell the room; take the label off its issue
//   no issue is in work                        -> post the oldest labelled issue into the room
//   an issue is in work and its task is done   -> land it: tests, push, open or update its PR
//   its pull request is open                   -> new review comments and failed checks to the room
//
// NO STATE FILE. A job starts on a fresh machine. What a watcher kept in .git/hivecode is read from
// where it already is: which issue is in work from Hivecode's marker comment on the issue, its task
// from the room, the last landing from a marker comment, the review comments already sent from the
// room's tasks. Every step can run twice without doing anything twice.
//
// THE ROOM LINK is a repository secret (HIVE_ROOM). It is never printed and never written to GitHub:
// anyone holding it can read the code in the room.
//
// Codes: Q613 setup (no room link, no branch, not a checkout), Q614 the branch is not on origin.

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { parseLink } from './sync.js'

export const LABEL = 'hivecode'
const MARK = (kind, fields = {}) => `<!-- hivecode:room kind=${kind}${Object.entries(fields).map(([k, v]) => ` ${k}=${v}`).join('')} -->`
const markOf = (body, kind) => {
  const m = String(body || '').match(new RegExp(`<!-- hivecode:room kind=${kind}((?: [a-z]+=[^ ]*)*) -->`))
  if (!m) return null
  const out = {}
  for (const p of m[1].trim().split(/\s+/).filter(Boolean)) { const i = p.indexOf('='); out[p.slice(0, i)] = p.slice(i + 1) }
  return out
}
const oneLine = (s, n = 300) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n)
const PUSHERS = new Set(['admin', 'maintain', 'write'])
const ISSUE_TASK = (n) => new RegExp(`^Issue #${n}(?: \\(attempt \\d+\\))?:`)

/** The issue a pull request closes, from the "Closes #N" Hivecode writes first in its body. */
export function closesOf(body) {
  const m = String(body || '').match(/(?:^|\n)\s*(?:closes|fixes|resolves) #(\d+)\b/i)
  return m ? Number(m[1]) : 0
}

/** The room's tasks posted by Hivecode for issue n, newest first. */
export function issueTasks(tasks, n) {
  return (tasks || []).filter((t) => t && t.by === 'GitHub' && ISSUE_TASK(n).test(String(t.text || '')))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

/** Review comments already sent to the room, as the `seen` collectPrFeedback takes: per stream, the
 *  highest comment id named in a "[rc:1,rv:2]" batch tag of a task Hivecode posted. Ids only grow. */
export function seenFromTasks(tasks) {
  const seen = { ic: 0, pc: 0, rc: 0, rv: 0 }
  for (const t of tasks || []) {
    if (!t || t.by !== 'GitHub') continue
    const tag = String(t.text || '').match(/\[((?:(?:ic|pc|rc|rv):\d+,?)+)\]\s*$/)
    if (!tag) continue
    for (const part of tag[1].split(',')) {
      const [k, v] = part.split(':')
      if (k in seen) seen[k] = Math.max(seen[k], Number(v) || 0)
    }
  }
  return seen
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return { code: r.status === null ? 1 : r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
}

/** A passive client named GitHub that holds no files, synced (a relay waking from sleep can take a
 *  minute), or a throw: a run that could not read the room must not act as if the room were empty. */
async function openRoom(link) {
  const os = await import('os')
  const crypto = await import('crypto')
  const { startSync } = await import('./sync.js')
  const parsed = parseLink(link)
  const dir = path.join(os.tmpdir(), `hive-action-${crypto.randomBytes(6).toString('hex')}`)
  fs.mkdirSync(dir, { recursive: true })
  const hive = startSync({ relay: parsed.relay, room: parsed.room, dir, name: 'GitHub', kind: 'ai', passive: true, syncFiles: false, token: parsed.token || '', log: () => { } })
  const synced = await new Promise((res) => {
    if (hive.provider && hive.provider.synced) return res(true)
    const timer = setTimeout(() => res(false), 90000)
    hive.provider && hive.provider.on('sync', (ok) => { if (ok) { clearTimeout(timer); res(true) } })
  })
  const close = async (settleMs = 0) => {
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs))
    try { hive.stop() } catch { }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
  }
  if (!synced) { await close(); throw new Error('could not reach the room through its relay in 90 s; the next run tries again') }
  return { hive, close }
}

/** The real things one run reaches: the room and the landing. `github` reaches the landing (tests). */
export async function roomDeps({ link, root, branch, github }) {
  const RM = await import('./hive-room-mode.js')
  const RW = await import('./hive-room-watcher.js')
  return {
    tasks: async () => { const r = await openRoom(link); try { return [...r.hive.doc.getMap('tasks').values()] } finally { await r.close() } },
    assignFix: async (text) => { const r = await openRoom(link); try { r.hive.assign('all', text) } finally { await r.close(1500) } },
    say: (text) => RW.roomSay({ link, text }),
    postIssue: (issue) => RM.postIssue({ link, issue, waysOfWorking: RW.WAYS_OF_WORKING, branch }),
    landIssue: (o) => RM.landIssue({ link, root, branch, ...(github ? { github } : {}), ...o }),
    prFeedback: (o) => RM.postPrFeedback({ link, root, branch, quietMs: 0, ...o }),
    bind: async () => {
      const HB = await import('./hive-branch.js')
      if (HB.readBinding(root, branch)) return
      await HB.bindBranch({ cwd: root, branch, join: link, you: 'GitHub' })
    },
  }
}

/**
 * One run. `gh` is a makeGitHub client (the job's token, through `gh`); `deps` reaches the room.
 * Returns { did: [what it did, for the log] }. A refusal is a result; a throw is a failed job, which
 * GitHub shows in red and the next run retries.
 */
export async function runAction({ gh, deps, eventName = '', event = {}, branch, label = LABEL, base = '', log = () => { }, notify = async () => false }) {
  const did = []
  const note = (s) => { did.push(s); log(s) }
  // What a person follows in Slack or Discord (HIVE_NOTIFY_WEBHOOK): the issue's life, never the room link.
  const where = gh.owner && gh.repo ? `${gh.owner}/${gh.repo}` : 'the repository'
  const tell = async (s) => { try { await notify(`Hivecode, ${where}: ${s}`) } catch { } }
  const cache = new Map()
  const comment = (n, body) => { cache.delete(n); return gh.comment(n, body) }
  // Hivecode's marks count only from the latest time the label went on: labelling an issue again
  // after its pull request was closed, or after it was stopped, sends it to the room again.
  const labelAt = (n) => {
    const evs = (gh.issueEvents(n) || []).filter((e) => e && e.event === 'labeled' && e.label && String(e.label.name).toLowerCase() === label.toLowerCase())
    const last = evs[evs.length - 1]
    return { at: last ? Date.parse(last.created_at) || 0 : 0, by: last && last.actor ? last.actor.login : '' }
  }
  const commentsOf = (n) => {
    if (!cache.has(n)) {
      const since = labelAt(n)
      const all = gh.comments(n) || []
      cache.set(n, { all, now: all.filter((c) => (Date.parse(c.created_at) || 0) >= since.at), by: since.by })
    }
    return cache.get(n).now
  }
  const attemptOf = (n) => { commentsOf(n); return cache.get(n).all.filter((c) => markOf(c.body, 'sent')).length + 1 }
  const labelled = () => (gh.labeledIssues(label) || []).filter((i) => i && !i.pull_request)
    .sort((a, b) => a.number - b.number)
  const canPush = (login) => { try { return !!login && PUSHERS.has(gh.permission(login)) } catch { return false } }
  // Who put the label on: a label from someone who cannot push hands nothing to the agents.
  const labeller = (n) => { commentsOf(n); return cache.get(n).by }
  const said = (n, kind) => commentsOf(n).some((c) => markOf(c.body, kind))

  // ── 1. what the event itself says ─────────────────────────────────────────────────────────────
  const issueN = event.issue && !event.issue.pull_request ? Number(event.issue.number) : 0
  if (eventName === 'issues' && issueN && (event.action === 'closed' || (event.action === 'unlabeled' && event.label && String(event.label.name).toLowerCase() === label.toLowerCase()))) {
    if (said(issueN, 'sent') && !said(issueN, 'stopped') && !said(issueN, 'prclosed')) {
      await deps.say(`@all issue #${issueN} was ${event.action === 'closed' ? 'closed' : 'unlabelled'} on GitHub: stop work on it. Nothing more from it lands.`)
      comment(issueN, `Hivecode told the room to stop work on this issue.\n\n${MARK('stopped')}`)
      note(`#${issueN}: room told to stop (${event.action})`)
      await tell(`issue #${issueN} was ${event.action === 'closed' ? 'closed' : 'unlabelled'}; the room was told to stop.`)
    }
  }

  // ── 2. pull requests on the branch that were closed ───────────────────────────────────────────
  const pulls = (gh.pullsFor(branch) || []).filter((p) => p && (!p.head || !p.head.ref || p.head.ref === branch))
  for (const p of pulls.filter((x) => x.state === 'closed')) {
    const n = closesOf(p.body)
    if (!n) continue
    let issue = null
    try { issue = gh.issue(n) } catch { continue }
    const labels = (issue.labels || []).map((l) => String(typeof l === 'string' ? l : l.name).toLowerCase())
    // Only an issue this room worked on, and only once: the label is off when it was dealt with.
    if (!labels.includes(label.toLowerCase())) continue
    if (!said(n, 'sent')) continue
    if (said(n, 'prclosed')) { try { gh.removeLabel(n, label) } catch { } continue }
    const merged = !!p.merged_at
    await deps.say(`@all PR #${p.number} for issue #${n} was ${merged ? 'merged' : 'closed without merging'} on GitHub. ${merged ? 'That issue is finished.' : 'Nothing more lands for it.'} The next issue comes in now, if there is one.`)
    comment(n, `${merged ? `Merged in #${p.number}.` : `#${p.number} was closed without merging; label this issue \`${label}\` again to send it to the room again.`}\n\n${MARK('prclosed', { pr: p.number })}`)
    gh.removeLabel(n, label)
    note(`PR #${p.number} (issue #${n}) ${merged ? 'merged' : 'closed'}: room told`)
    await tell(`PR #${p.number} for issue #${n} was ${merged ? 'merged' : 'closed without merging'}.`)
  }

  // ── 3. the issue in work, if any: open, labelled, sent to the room, its room not told to stop ─
  const open = labelled()
  const inWork = open.filter((i) => { const cs = commentsOf(i.number); return cs.some((c) => markOf(c.body, 'sent')) && !cs.some((c) => markOf(c.body, 'stopped') || markOf(c.body, 'prclosed')) })
  let active = inWork[0] || null

  // ── 4. nothing in work: post the oldest labelled issue ────────────────────────────────────────
  if (!active) {
    for (const i of open) {
      if (inWork.includes(i)) continue
      const cs = commentsOf(i.number)
      if (cs.some((c) => markOf(c.body, 'stopped') || markOf(c.body, 'prclosed'))) continue
      const who = labeller(i.number)
      if (!canPush(who)) {
        if (!cs.some((c) => markOf(c.body, 'notpusher'))) comment(i.number, `Hivecode does not send this to the room: the \`${label}\` label was added by ${who ? `@${who.replace(/[^A-Za-z0-9-]/g, '')}` : 'someone'}, who cannot push to this repository. Someone who can push adds it.\n\n${MARK('notpusher')}`)
        continue
      }
      const p = await deps.postIssue({ number: i.number, title: i.title, body: i.body || '', author: (i.user && i.user.login) || 'unknown', labeller: who, attempt: attemptOf(i.number) })
      if (!p || !p.ok) { note(`#${i.number}: could not post to the room (${(p && p.code) || 'no answer'}); the next run tries again`); return { did } }
      comment(i.number, `${p.comment || 'Sent to the room.'}\n\n${MARK('sent', { task: p.taskId || '' })}`)
      note(`#${i.number}: sent to the room as task ${p.taskId}`)
      await tell(`issue #${i.number} "${oneLine(i.title, 120)}" is in the room. ${oneLine(p.comment || '', 200)}`)
      return { did }
    }
    if (!open.length) note('no issue is labelled; nothing to do')
    return { did }
  }

  // Others wait, and are told so once.
  for (const i of open) {
    if (i === active || inWork.includes(i)) continue
    const cs = commentsOf(i.number)
    if (cs.some((c) => markOf(c.body, 'sent') || markOf(c.body, 'queued') || markOf(c.body, 'stopped') || markOf(c.body, 'prclosed'))) continue
    comment(i.number, `Queued: the room works on one issue at a time. This comes in when the pull request for #${active.number} is merged or closed.\n\n${MARK('queued')}`)
    note(`#${i.number}: queued behind #${active.number}`)
  }

  // ── 5. the issue in work: land it when its task is done ───────────────────────────────────────
  const n = active.number
  const tasks = await deps.tasks()
  const task = issueTasks(tasks, n)[0]
  if (!task) { note(`#${n}: its task is not in the room (the relay lost the room?); nothing to land`); return { did } }
  const openPr = pulls.find((p) => p.state === 'open' && closesOf(p.body) === n) || null
  const cs = commentsOf(n)
  const lastLand = cs.map((c) => markOf(c.body, 'land')).filter(Boolean).pop() || null
  if (task.status === 'done') {
    await deps.bind()
    const r = await deps.landIssue({
      taskId: task.id,
      issue: { number: n, title: active.title },
      // The same plan, branch and room as the last landing, ok or not, is not run again.
      state: { lastFailedFingerprint: lastLand ? lastLand.fp : '' },
      by: 'GitHub Actions',
      closes: true,
      skipEmpty: !!openPr,
      ...(base ? { base } : {}),
    })
    if (r && r.skipped) note(`#${n}: ${r.nothing ? 'nothing new to land' : 'nothing changed since the last landing'}`)
    else if (r && r.ok && r.pr && r.pr.number) {
      const made = r.pr.created || !openPr
      comment(n, `${made ? `Pull request #${r.pr.number} is open for review` : `#${r.pr.number} was updated`}${r.tests && r.tests.ran ? ` (tests: \`${oneLine(r.tests.command, 80)}\` passed)` : ' (tests: not run)'}.\n\n${MARK('land', { fp: r.fingerprint || '', ok: 1, pr: r.pr.number })}`)
      await deps.say(made ? `@all issue #${n} is up for review: PR #${r.pr.number} ${r.pr.url || ''}`.trim()
        : `@all PR #${r.pr.number} for issue #${n} was updated${r.pr.newCommits ? ` with ${r.pr.newCommits} new commit(s)` : ''}.`)
      note(`#${n}: ${made ? 'opened' : 'updated'} PR #${r.pr.number}`)
      await tell(made ? `issue #${n} is up for review: ${r.pr.url || `PR #${r.pr.number}`}` : `PR #${r.pr.number} for issue #${n} was updated with the room's fixes.`)
    } else if (r && r.code) {
      // A refusal with a code is said once per landing (its fingerprint), on the issue and in the room.
      if (!lastLand || lastLand.fp !== (r.fingerprint || '') || lastLand.code !== r.code) {
        comment(n, `Hivecode could not land this (${r.code}): ${oneLine(r.why, 600)}\nNothing was pushed. It is tried again when the room's files or the branch change.\n\n${MARK('land', { fp: r.fingerprint || '', code: r.code })}`)
        await tell(`issue #${n}: the landing was refused (${r.code}). Nothing was pushed; the room was told.`)
        if (r.code !== 'Q576') await deps.say(`@all issue #${n} is done, but its landing was refused (${r.code}): ${oneLine(r.why, 400)} Nothing was pushed.`)
      }
      note(`#${n}: landing refused (${r.code})`)
    } else note(`#${n}: not ready to land: ${oneLine(r && r.why, 200)}`)
  } else note(`#${n}: task ${task.id} is ${task.status}; waiting for the room`)

  // ── 6. its open pull request: review comments and failed checks back to the room ─────────────
  if (openPr) {
    const fb = await deps.prFeedback({ gh, issueNumber: n, prNumber: openPr.number, state: { seen: seenFromTasks(tasks) } })
    if (fb && fb.ok && fb.items && fb.items.length && !fb.already) { note(`PR #${openPr.number}: ${fb.items.length} review comment(s) sent to the room`); await tell(`${fb.items.length} review comment(s) on PR #${openPr.number} went to the room.`) }
    const sha = openPr.head && openPr.head.sha
    if (sha) {
      const GH = await import('./hive-github.js')
      // The job's own run is not a check on the pull request; the rest are.
      const v = GH.ciVerdict(gh.checkRuns(sha), gh.statuses(sha))
      const short = String(sha).slice(0, 7)
      const marker = `Fix the failing checks on PR #${openPr.number} at ${short}`
      if (v.state === 'failure' && !tasks.some((t) => t && t.by === 'GitHub' && String(t.text || '').startsWith(marker))) {
        await deps.assignFix(`${marker}: ${v.failed.slice(0, 8).map((i) => oneLine(i.name, 60)).join(', ')}`)
        await deps.say(`@all the checks failed on PR #${openPr.number} at ${short}: ${v.failed.slice(0, 8).map((i) => `${oneLine(i.name, 60)}${i.url ? ` ${i.url}` : ''}`).join('; ')}. Fix them in the room; the fix goes to the same pull request.`)
        note(`PR #${openPr.number}: failed checks sent to the room`)
        await tell(`checks failed on PR #${openPr.number}; the room was told.`)
      }
    }
  }
  return { did }
}

// ── the workflow file a repository adds ──────────────────────────────────────────────────────────
export function workflowFile({ branch = '<branch>', version = 'latest' } = {}) {
  return `# Hivecode: GitHub issues go to the agents in a room, and their work comes back as a pull request.
# Needs one repository secret, HIVE_ROOM: the room's link (Settings -> Secrets and variables -> Actions).
name: Hivecode

on:
  issues:
    types: [opened, labeled, unlabeled, closed, reopened]
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  pull_request:
    types: [closed]
  workflow_dispatch: # an agent starts this when the room's task is done
  schedule:
    - cron: '*/10 * * * *'

permissions:
  contents: write
  issues: write
  pull-requests: write
  checks: read

# One run at a time: two runs never post the same issue or land twice.
concurrency:
  group: hivecode
  cancel-in-progress: false

jobs:
  room:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y hivecode-mcp@${version} github action
        env:
          HIVE_ROOM: \${{ secrets.HIVE_ROOM }}
          HIVE_BRANCH: ${branch}
          # optional: a Slack or Discord incoming webhook, to follow each issue there
          HIVE_NOTIFY_WEBHOOK: \${{ secrets.HIVE_NOTIFY_WEBHOOK }}
          GH_TOKEN: \${{ github.token }}
`
}

// ── the command ──────────────────────────────────────────────────────────────────────────────────
export async function main(argv = [], { cwd = process.cwd(), env = process.env, log = console.log, logErr = console.error, call } = {}) {
  if (argv.includes('--workflow')) {
    const bi = argv.indexOf('--branch')
    log(workflowFile({ branch: bi !== -1 && argv[bi + 1] ? argv[bi + 1] : '<branch>' }))
    return 0
  }
  const link = String(env.HIVE_ROOM || '').trim()
  const branch = String(env.HIVE_BRANCH || '').trim()
  const label = String(env.HIVE_LABEL || '').trim() || LABEL
  if (!link || !parseLink(link).room) { logErr('Q613 HIVE_ROOM is not set to a room link. Add the room\'s link as the repository secret HIVE_ROOM (Settings -> Secrets and variables -> Actions), and pass it to this step as env.'); return 2 }
  if (!branch) { logErr('Q613 HIVE_BRANCH is not set: name the branch the room is bound to, in the workflow\'s env.'); return 2 }
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) { logErr(`Q613 ${cwd} is not a git checkout. The workflow runs actions/checkout (with fetch-depth: 0) first.`); return 2 }
  const root = path.resolve(top.out)
  // The branch, as a local branch: the landing works on refs/heads/<branch>.
  if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code !== 0) {
    git(root, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
    if (git(root, ['branch', '--no-track', branch, `refs/remotes/origin/${branch}`]).code !== 0) { logErr(`Q614 there is no branch ${branch} on origin. Create it and its room once: npx -y hivecode-mcp@latest branch ${branch}, then push the branch.`); return 2 }
  }
  // Commits need a committer; a fresh runner has none.
  if (git(root, ['config', 'user.email']).code !== 0) {
    git(root, ['config', 'user.name', 'github-actions[bot]'])
    git(root, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  }
  const GH = await import('./hive-github.js')
  const id = GH.parseRepo(git(root, ['remote', 'get-url', 'origin']).out) ||
    (env.GITHUB_REPOSITORY ? { owner: env.GITHUB_REPOSITORY.split('/')[0], repo: env.GITHUB_REPOSITORY.split('/')[1] } : null)
  if (!id) { logErr('Q613 origin is not a GitHub repository.'); return 2 }
  const gh = GH.makeGitHub({ call: call || GH.ghCall(), owner: id.owner, repo: id.repo })
  let event = {}
  try { if (env.GITHUB_EVENT_PATH) event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) } catch { }
  let base = String(env.HIVE_BASE || '').trim()
  if (!base) { try { base = gh.repoInfo().default_branch || '' } catch { } }
  const deps = await roomDeps({ link, root, branch })
  try {
    const W = await import('./hive-webhook.js')
    const notify = W.makeNotifier(String(env.HIVE_NOTIFY_WEBHOOK || '').trim(), { log })
    const r = await runAction({ gh, deps, eventName: env.GITHUB_EVENT_NAME || '', event, branch, label, base, log, notify })
    if (!r.did.length) log('nothing to do')
    return 0
  } catch (e) {
    logErr(`hivecode: ${GH.scrub ? GH.scrub(e.message) : e.message}`)
    return 1
  }
}
