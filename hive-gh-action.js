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
// Test output that means "the runner has no installed dependencies", in Node and in Python. The fix
// is a step in the workflow file, which nobody in the room can add, so the issue comment names it.
const MISSING_DEPS = /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|No module named/
const PR_NOT_ALLOWED = /not permitted to create or approve pull requests/i
const PR_SETTING = 'Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"'

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
    // THE JOB'S TOKEN CANNOT READ /user (GitHub answers 403 "Resource not accessible by integration"),
    // and the landing asks it as its login check. The token is the job's; there is no person to check.
    landIssue: (o) => RM.landIssue({ link, root, branch, ...(github ? { github: { ...github, user: () => ({ login: 'github-actions[bot]' }) } } : {}), ...o }),
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
export async function runAction({ gh, deps, eventName = '', event = {}, branch, label = LABEL, base = '', runAt = '', log = () => { }, notify = async () => false }) {
  // runAt: the commit this run's checkout is at (the default branch, where the workflow file lives).
  // A landing refused for something the workflow has to fix is tried again when it changes.
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
  let openPr = pulls.find((p) => p.state === 'open' && closesOf(p.body) === n) || null
  const lands = commentsOf(n).map((c) => markOf(c.body, 'land')).filter(Boolean)
  const lastLand = lands[lands.length - 1] || null
  // The issue's work is on the branch on origin once a landing pushed it: one that opened or updated
  // a pull request (ok=1), or one that pushed and could not open the pull request (pushed=1).
  const workOnBranch = lands.some((l) => l.ok === '1' || l.pushed === '1')
  // "Closes #N" goes in first, so merging the pull request closes the issue and the next run sees
  // it as the issue's.
  const link = async (pr) => {
    try {
      gh.updatePull(pr.number, { body: `Closes #${n}\n\n${String(pr.body || '')}` })
      pr.body = `Closes #${n}\n\n${String(pr.body || '')}`
      comment(n, `#${pr.number} is this issue's pull request: it is on the room's branch and holds this issue's work, so Hivecode linked it.\n\n${MARK('adopted', { pr: pr.number })}`)
      await deps.say(`@all PR #${pr.number} on the room's branch is now issue #${n}'s pull request (it closes #${n} when merged).`)
      await tell(`PR #${pr.number} is now the pull request for issue #${n}.`)
      note(`#${n}: linked PR #${pr.number}`)
      return true
    } catch (e) { note(`#${n}: could not link PR #${pr.number}: ${oneLine(e.message, 160)}`); return false }
  }
  // A PULL REQUEST ON THE BRANCH THAT SOMEONE ELSE OPENED (an agent, a person) is this issue's ONLY
  // ONCE IT HOLDS THIS ISSUE'S WORK (11 Nov 2026). A pull request head is the branch, so it holds the
  // work from the landing's push on. Before that it is somebody's own change that happens to sit on
  // the room's branch: linking it made merging a setup fix close issue #22 with nothing landed.
  if (!openPr) {
    const other = pulls.find((p) => p.state === 'open' && !closesOf(p.body))
    if (other && workOnBranch) { if (await link(other)) openPr = other }
    else if (other) note(`#${n}: PR #${other.number} is open on ${branch} but holds none of this issue's work yet; left alone`)
  }
  const prOnlyBefore = !!lastLand && lastLand.code === 'Q574' && lastLand.pushed === '1'
  const tryAgain = prOnlyBefore || (!!lastLand && lastLand.deps === '1' && !!runAt && lastLand.at !== runAt)
  if (task.status === 'done') {
    await deps.bind()
    const r = await deps.landIssue({
      taskId: task.id,
      issue: { number: n, title: active.title },
      // The same plan, branch and room as the last landing, ok or not, is not run again. Two refusals
      // are, because what fixes them changes none of the three: the pull request GitHub would not
      // let the job open (a repository setting; nothing new lands, so no tests run again), and tests
      // that found no installed dependencies, once the workflow file has changed.
      state: { lastFailedFingerprint: lastLand && !tryAgain ? lastLand.fp : '' },
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
      // The landing went onto a pull request that was already open on the branch and is not yet the
      // issue's: it holds the issue's work now, so it is linked in this run.
      if (!openPr) {
        const landedOn = pulls.find((p) => p.state === 'open' && p.number === r.pr.number && !closesOf(p.body))
        if (landedOn && await link(landedOn)) openPr = landedOn
      }
    } else if (r && r.code) {
      // A refusal with a code is said once per landing (its fingerprint), on the issue and in the room.
      const fp = r.fingerprint || ''
      const why = String(r.why || '')
      // PUSHED, BUT NO PULL REQUEST (11 Nov 2026): the commits were on the branch and the comment
      // said "Nothing was pushed". Said once however often it is tried again.
      const prOnly = r.code === 'Q574' && !!r.onBranch
      const noDeps = r.code === 'Q576' && MISSING_DEPS.test(why)
      const repeat = prOnly ? prOnlyBefore
        : !!lastLand && lastLand.fp === fp && lastLand.code === r.code && (!noDeps || !runAt || lastLand.at === runAt)
      if (prOnly && !repeat) {
        const reason = oneLine(why.replace(/^[\s\S]*?opening the PR failed:\s*/, ''), 400)
        const setting = PR_NOT_ALLOWED.test(why)
        comment(n, `The work for this issue is pushed to \`${branch}\`, but Hivecode could not open the pull request (Q574): ${reason}\n` +
          (setting ? `GitHub does not let Actions open pull requests in this repository. Turn it on: ${PR_SETTING} (in an organization, an owner may have to allow it first). The next run then opens the pull request: Actions → Hivecode → Run workflow, or the 10-minute timer.\n`
            : 'The next run tries to open it again.\n') +
          `Or open a pull request from \`${branch}\` by hand: Hivecode links it to this issue.\n\n${MARK('land', { fp, code: r.code, pushed: 1 })}`)
        await tell(`issue #${n}: the work is pushed to ${branch}, but the pull request could not be opened (Q574). ${setting ? 'Turn on "Allow GitHub Actions to create and approve pull requests" in the repository\'s Actions settings, or open it by hand.' : 'Open it by hand, or wait for the next run.'}`)
        await deps.say(`@all issue #${n} is done and its work is pushed to ${branch}, but the pull request could not be opened (Q574): ${reason}. A person has to ${setting ? 'change a repository setting' : 'look at it'} or open the pull request by hand; there is nothing to fix in the room.`)
      } else if (!repeat) {
        const hint = noDeps ? `The tests did not find the project's dependencies on the runner. Add an install step before the Hivecode step in \`.github/workflows/hivecode.yml\` (for npm: \`- run: npm ci\`); the landing is tried again once that change is on the default branch.\n` : ''
        comment(n, `Hivecode could not land this (${r.code}): ${oneLine(why, 600)}\nNothing ${workOnBranch ? 'new ' : ''}was pushed. ${hint}It is tried again when the room's files or the branch change.\n\n${MARK('land', { fp, code: r.code, ...(noDeps ? { deps: 1, ...(runAt ? { at: runAt } : {}) } : {}) })}`)
        await tell(`issue #${n}: the landing was refused (${r.code}). Nothing was pushed; the room was told.${noDeps ? ' The workflow file needs an install step.' : ''}`)
        if (r.code !== 'Q576') await deps.say(`@all issue #${n} is done, but its landing was refused (${r.code}): ${oneLine(why, 400)} Nothing was pushed.`)
      }
      note(`#${n}: landing refused (${r.code})`)
    } else note(`#${n}: not ready to land: ${oneLine(r && r.why, 200)}`)
  } else note(`#${n}: task ${task.id} is ${task.status}; waiting for the room`)

  // ── 6. comments back to the room: every comment on the issue from someone who can push, and
  //       once its pull request is open, the reviews and comments there too; failed checks ──────
  {
    const fb = await deps.prFeedback({ gh, issueNumber: n, prNumber: openPr ? openPr.number : 0, state: { seen: seenFromTasks(tasks), allComments: true } })
    const where = openPr ? `PR #${openPr.number} and issue #${n}` : `issue #${n}`
    if (fb && fb.ok && fb.items && fb.items.length && !fb.already) { note(`${where}: ${fb.items.length} comment(s) sent to the room`); await tell(`${fb.items.length} comment(s) on ${where} went to the room.`) }
  }
  if (openPr) {
    const sha = openPr.head && openPr.head.sha
    if (sha) {
      const GH = await import('./hive-github.js')
      // The job's own run is not a check on the pull request; the rest are.
      // A check that cannot be read (an older workflow file without `statuses: read`) is said in the
      // log, never a failed run: everything before it already happened.
      let v = { state: 'none', failed: [] }
      try { v = GH.ciVerdict(gh.checkRuns(sha), gh.statuses(sha)) } catch (e) { note(`PR #${openPr.number}: the checks could not be read (${oneLine(e.message, 160)}); add "statuses: read" and "checks: read" to the workflow's permissions`) }
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
/** How this repository installs what its tests need, from the lockfile it keeps: { found, commands }.
 *  Nothing recognised is found '' and no commands; the workflow then says where the step goes. */
export function installStepsFor(dir) {
  const has = (f) => { try { return fs.statSync(path.join(dir, f)).isFile() } catch { return false } }
  for (const [file, command] of [
    ['package-lock.json', 'npm ci'],
    ['npm-shrinkwrap.json', 'npm ci'],
    ['pnpm-lock.yaml', 'corepack enable && pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
    ['package.json', 'npm install'],
  ]) if (has(file)) return { found: file, commands: [command] }
  return { found: '', commands: [] }
}

export function workflowFile({ branch = '<branch>', version = 'latest', install = [] } = {}) {
  // THE LANDING RUNS THE REPOSITORY'S TESTS ON THE RUNNER, which starts with no dependencies: without
  // this step every first landing on a project with dependencies failed (11 Nov 2026).
  // `install` is what installStepsFor answers, or just its list of commands.
  const steps = (Array.isArray(install) ? install : (install && Array.isArray(install.commands) ? install.commands : [])).map((c) => String(c || '').replace(/[\r\n]+/g, ' ').trim()).filter(Boolean)
  const installBlock = steps.length
    ? `      # The landing runs your tests on this runner, so what they need is installed first.\n${steps.map((c) => `      - run: ${c}`).join('\n')}\n`
    : `      # The landing runs your tests on this runner. No package.json or lockfile was found, so nothing
      # is installed. If your tests need dependencies, add the install step here, for example:
      #   - run: pip install -r requirements.txt
`
  return `# Hivecode: GitHub issues go to the agents in a room, and their work comes back as a pull request.
# Needs one repository secret, HIVE_ROOM: the room's link (Settings -> Secrets and variables -> Actions).
# And one setting, so the job may open the pull request: Settings -> Actions -> General ->
# Workflow permissions -> "Allow GitHub Actions to create and approve pull requests".
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
  statuses: read

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
${installBlock}      - run: npx -y hivecode-mcp@${version} github action
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
    // What to install is read from the repository this is run in (its top level, when it is one).
    const here = git(cwd, ['rev-parse', '--show-toplevel'])
    const found = installStepsFor(here.code === 0 && here.out ? path.resolve(here.out) : cwd)
    log(workflowFile({ branch: bi !== -1 && argv[bi + 1] ? argv[bi + 1] : '<branch>', install: found.commands }))
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
  const deps = await roomDeps({ link, root, branch, github: gh })
  try {
    const W = await import('./hive-webhook.js')
    const notify = W.makeNotifier(String(env.HIVE_NOTIFY_WEBHOOK || '').trim(), { log })
    const runAt = git(root, ['rev-parse', 'HEAD']).out.slice(0, 12)
    const r = await runAction({ gh, deps, eventName: env.GITHUB_EVENT_NAME || '', event, branch, label, base, runAt, log, notify })
    if (!r.did.length) log('nothing to do')
    return 0
  } catch (e) {
    logErr(`hivecode: ${GH.scrub ? GH.scrub(e.message) : e.message}`)
    return 1
  }
}
