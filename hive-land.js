// hive-land -- the ONE way a room's work leaves this machine: land, check, push, open the PR.
//
// Three callers, one path, so a check added here protects all of them:
//   - `npx -y hivecode-mcp@latest pr <branch>`   a developer, in their own clone   (hive-branch.js main)
//   - the hive_pr tool                          an agent on the repo machine, for its person
//   - the GitHub watcher                        hive-github.js (through landBranch, for now)
//
// THE ORDER IS THE SAFETY. Nothing moves until every check has passed on the exact commit that
// would move:
//   lock -> claims -> remote -> land in a temporary worktree -> claims again -> workflows -> secrets
//   -> tests on that tip -> move the branch (compare-and-swap) -> push that exact sha -> open or update
//   the PR -> unlock
//
// Each step is here because skipping it hurt somebody, or provably would (tests/land-test.mjs, red on
// the code before this file, 5 Nov 2026):
//   - an EMPTY ROOM (the relay restarted) landed "Room: delete 9 files": a branch with no files left
//   - a landing went through while an agent still held a claim: half a change on the branch
//   - `pr` ran no tests, so failing work landed, and nothing ever said the work was untested
//   - GitHub was ahead: the branch moved locally, THEN the push failed
//
// Error codes Q575-Q579 are this module's (Q560-Q574 stay hive-branch.js's, and pass through):
//   Q575 a claim is still held (or appeared during the landing)
//   Q576 the tests failed, ran past their time limit, or could not start
//   Q577 the room is empty, or the landing would delete most of the branch
//   Q578 a workflow file or a key in the change; origin ahead or unreachable; GitHub not logged in
//   Q579 another landing of this branch is running

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import * as HB from './hive-branch.js'
import { startSync, parseLink } from './sync.js'
import { findSecrets } from './hive-secrets.js'
import { makeCoordinator } from './hive-coord.js'

const HIVE_PR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hive-pr.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const git = (cwd, args, o) => HB.gitIn(cwd, args, o)
// GIT THAT TALKS TO THE NETWORK NEVER WAITS ON A PROMPT NOBODY CAN SEE. Run from an agent's tool
// call or a background watcher, a credential prompt (git's own, or Git Credential Manager's window)
// would hang the landing forever with the lock held. No prompt, and a time limit.
function gitNet(cwd, args, timeoutMs = Number(process.env.HIVE_GIT_NET_TIMEOUT_MS) || 120000) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
  const timedOut = r.error && r.error.code === 'ETIMEDOUT'
  return { code: r.status === null ? 1 : r.status, out: (r.stdout || '').trim(), err: timedOut ? `no answer from the remote in ${Math.round(timeoutMs / 1000)} s` : ((r.stderr || '') + (r.error ? ` ${r.error.message}` : '')).trim() }
}
const short = (sha) => String(sha || '').slice(0, 7)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const tailLines = (s, n) => String(s || '').replace(/\s+$/, '').split(/\r?\n/).slice(-n).join('\n')
// Hivecode's generated files in a room folder: never project work, never an "orphan".
const GENERATED = /^HIVE_[A-Z_]+\.md$/
const toLF = (s) => (typeof s === 'string' && s.indexOf('\r\n') !== -1 ? s.replace(/\r\n/g, '\n') : s)

/**
 * landAndOpen(opts) -> Promise<Result>
 *
 * opts
 *   cwd        string   any folder inside the repo (required)
 *   branch     string   the branch bound to the room (required)
 *   dry        boolean  DEFAULT TRUE: plan only. Nothing moves, no tests run, nothing is pushed.
 *   push       boolean  push the landed tip to origin. Never forced.
 *   pr         boolean  open the PR, or update the one already open (implies push)
 *   base       string   the branch the PR goes into (default: the binding's `from`)
 *   test       string   shell command run in a clean checkout of the EXACT tip that would land.
 *                       '' = no tests: the landing still happens, and the result and the PR body
 *                       say "tests: NOT RUN" in words, so untested never looks like tested.
 *   testMinutes number  time limit for the tests (default 20)
 *   title      string   PR title (default "Hivecode: <branch>")
 *   summary    string   what was done, in the caller's words; goes in the PR body
 *   by         string   who asked, e.g. "Claude for Ganesh"; shown in the lock and the PR body
 *   allowWorkflowChanges boolean   default false
 *   allowMassDelete      boolean   default false: a landing that deletes most of the branch is refused
 *   force      string   a reason; overrides hive-pr's staleness refusal, recorded in the PR body
 *   only       string   comma-separated paths: land only these
 *   claims     boolean  default true: refuse while anyone holds a claim
 *   checks     boolean  default true: the workflow and key checks (the watcher runs its own for now)
 *   github     object   a GitHub client (hive-github.js makeGitHub shape); default: through `gh`
 *   log, logErr         (line) => void
 *
 * Result. An EXPECTED refusal is a result, never a throw; a throw means a bug.
 *   ok         boolean
 *   code       ''  or the refusal code ('Q575' ...; also Q5xx passed up from hive-branch / hive-pr)
 *   why        for a person: what happened and what to do next
 *   dry        boolean
 *   plan       [{ agent, files: [rel], intents: [string] }]   what lands, one entry per commit
 *   hashes     { rel: contentHash }   the room's content of each planned file, as the mirror read it
 *              (from hive-pr --plan-json; {} with an older hive-pr)
 *   deletions  [rel]    files the room deleted that the landing deletes
 *   orphans    [rel]    changed in the room but NOT landed: no signed receipt (old client, provenance off)
 *   holders    [{ file, by, intent, leftSec }]   set when refused for claims (Q575)
 *   landed     number   commits made by this run (0 when nothing new)
 *   tip        string   the branch tip after this run
 *   tests      { ran: false } | { ran: true, command, ok, code, sha, tail, seconds }
 *   pushed     boolean
 *   pr         null | { number, url, created, updated, newCommits }
 *   notes      [string] things the caller should pass on (a lock taken over, credentials removed ...)
 */
export async function landAndOpen(opts = {}) {
  const o = opts || {}
  const log = o.log || (() => {}), logErr = o.logErr || (() => {})
  const dry = o.dry !== false
  const wantPr = !!o.pr
  const push = !!(o.push || o.pr)
  const by = String(o.by || os.userInfo().username || 'someone').slice(0, 80)
  const res = { ok: false, code: '', why: '', dry, plan: [], hashes: {}, deletions: [], orphans: [], holders: [], landed: 0, tip: '', tests: { ran: false }, pushed: false, pr: null, notes: [] }
  const refuse = (code, why, extra = {}) => {
    const text = String(why || '').trim()
    return Object.assign(res, extra, { ok: false, code, why: text.startsWith(code) ? text : `${code} ${text}` })
  }

  let lock = null
  let tmp = '', temp = '', root = '', junction = ''
  const cleanup = () => {
    if (!root || !tmp) return
    // The junction to the developer's node_modules goes FIRST, by itself: removing the worktree
    // with it in place could walk through it into the developer's own dependencies.
    if (junction) { try { fs.unlinkSync(junction) } catch { try { fs.rmdirSync(junction) } catch { } } }
    git(root, ['worktree', 'remove', '--force', tmp])
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
    git(root, ['worktree', 'prune'])
    if (temp && HB.revParse(root, `refs/heads/${temp}`)) git(root, ['branch', '-D', temp])
  }

  try {
    root = HB.projectRoot(o.cwd || process.cwd())
    const name = HB.validBranch(root, String(o.branch || ''))
    const b = HB.readBinding(root, name)
    if (!b) return refuse('Q562', `branch "${name}" has no Hivecode room here. Create one with: npx -y hivecode-mcp@latest branch ${name}`)
    const tip = HB.revParse(root, `refs/heads/${name}`)
    if (!tip) return refuse('Q563', `branch "${name}" does not exist in ${root}. Fetch it first: git fetch origin ${name}:${name}`)
    res.tip = tip

    // ── 1. ONE LANDING PER BRANCH ────────────────────────────────────────────────────────────
    if (!dry) {
      lock = takeLock(root, name, by)
      if (!lock.ok) return refuse('Q579', lock.why)
      if (lock.note) { res.notes.push(lock.note); log(lock.note) }
    }

    // ── 2. THE ROOM AS IT IS: its files and its live claims, from one passive look ─────────────
    const snap = await roomSnapshot(b.link)
    if (!snap) return refuse('Q565', `could not reach the relay behind this room, so nothing about it can be checked. Nothing was changed.`)
    if (o.claims !== false && snap.holders.length) {
      return refuse('Q575', `not landed: ${describeHolders(snap.holders)}. A claim means someone is still editing; landing now would put half a change on ${name}. When they release, run this again. Nothing was changed.`, { holders: snap.holders })
    }

    // ── 3. THE REMOTE: refused BEFORE anything moves, never force-pushed ──────────────────────
    let github = null, into = ''
    if (push && !dry) {
      if (git(root, ['remote', 'get-url', 'origin']).code !== 0) return refuse('Q578', `there is no remote named origin in ${root}, so there is nothing to push to. Land without --push/--pr, or add the remote. Nothing was changed.`)
      const f = gitNet(root, ['fetch', '--quiet', 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`])
      const absent = f.code !== 0 && /couldn't find remote ref|could not find remote ref|no such ref/i.test(f.err)
      if (f.code !== 0 && !absent) return refuse('Q578', `could not reach origin to check ${name} before landing: ${oneLine(f.err)}${loginHint(f.err)} Nothing was changed.`)
      const remote = absent ? '' : HB.revParse(root, `refs/remotes/origin/${name}`)
      if (remote && git(root, ['merge-base', '--is-ancestor', remote, tip]).code !== 0) {
        const n = git(root, ['rev-list', '--count', `${tip}..${remote}`]).out
        const last = git(root, ['log', '-1', '--format=%h %an: %s', remote]).out
        return refuse('Q578', `origin has ${n} commit(s) on ${name} that this repo does not have (latest: ${last}). Bring them in first (git pull on ${name}), then land again. Nothing was changed; Hivecode never force-pushes.`)
      }
      if (wantPr) {
        into = o.base || b.from
        if (!into) return refuse('Q574', `there is no branch to open the PR into; pass --base <branch>. Nothing was changed.`)
        try { github = o.github || await defaultGitHub(root) } catch (e) { return refuse('Q578', `${e.message} Nothing was changed.`) }
        try { github.user() } catch (e) { return refuse('Q578', `GitHub login check failed: ${e.message} Nothing was changed.`) }
      }
    }

    // ── 4. LAND IN A TEMPORARY WORKTREE (the developer's checkout is never switched) ──────────
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-land-'))
    temp = `hivecode-land/${HB.safeSegment(name)}-${process.pid}-${Date.now()}`
    const wt = git(root, HB.noHooks(['worktree', 'add', '--detach', tmp, tip]))
    if (wt.code !== 0) return refuse('Q563', `could not make a temporary worktree: ${wt.err}`)

    // The room's deletions, accounted for BEFORE anything is written. An empty room is not a room
    // whose agents deleted everything: it is a room the relay lost.
    const atTip = HB.treeFiles(root, tip)
    const carries = HB.roomCarries(atTip)
    const carried = atTip.filter(carries).filter((f) => !HB.isOwnFile(f.rel))
    if (carried.length && snap.paths.size === 0) {
      return refuse('Q577', `the room for ${name} holds no files, but the branch has ${carried.length} that a room carries. The relay most likely lost the room (a restart or a deploy wipes rooms on some hosts); landing now would delete every one of them. Nothing was changed.\nAgents that still have their folders bring the work back by joining again. If none does, refill the room from the branch:\n  npx -y hivecode-mcp@latest branch ${name} --reseed`)
    }
    if (b.base && !HB.revParse(root, `${b.base}^{commit}`)) {
      return refuse('Q563', `the commit this room was seeded from (${short(b.base)}) is not in this clone, so the room's deletions cannot be accounted for. Fetch it (git fetch origin), then land again. Nothing was changed.`)
    }
    // THE SEED THIS CLONE RECORDED MUST BE THE ONE THE ROOM RECORDED (0.14.3 P0-3-H). --seed tells
    // hive-pr that a branch file still equal to the seed's copy is one the room started from. If this
    // clone's record (git config, written when the room was made or joined here) names another commit
    // -- the room was reseeded from another clone, or the record was edited -- a file a person changed
    // on the branch after the room's real seed could match it and be landed over without a word.
    // Two records that disagree are not resolved by guessing which is right.
    if (b.base && snap.seed && snap.seed !== b.base) {
      return refuse('Q587', `this clone records that the room for ${name} was seeded from ${short(b.base)}, but the room records ${short(snap.seed)}. Landing trusts that record to tell an untouched file from one changed outside the room, so it will not guess which is right. Nothing was changed.\nIf the room was reseeded elsewhere, record the room's seed here, then land again:\n  npx -y hivecode-mcp@latest branch ${name} --join "<the room link>"`)
    }
    if (!b.base) {
      // A binding with no seed record (a `--join` made before 0.13.1, or a room seeded before it):
      // deletions cannot be told from files added to the branch later, so none are landed -- and
      // that is SAID, with the files, instead of the silent skip it used to be.
      const absent = carried.filter((f) => !snap.paths.has(f.rel)).map((f) => f.rel)
      if (absent.length) {
        const note = `deletions NOT landed: this clone has no record of the commit the room was seeded from, so ${absent.length} file(s) on ${name} that are not in the room were left as they are (${absent.slice(0, 5).join(', ')}${absent.length > 5 ? ', ...' : ''}). Run \`npx -y hivecode-mcp@latest branch ${name} --join "<link>"\` again to record it.`
        res.notes.push(note); log(note)
      }
    }
    const deletions = roomDeletions({ root, room: parseLink(b.link).room, base: b.base, tip, paths: snap.paths, atTip, carries })
    res.deletions = deletions
    if (deletions.length > 3 && deletions.length * 2 > carried.length && !o.allowMassDelete) {
      return refuse('Q577', `this landing would delete ${deletions.length} of the ${carried.length} files on ${name} (${deletions.slice(0, 5).join(', ')}${deletions.length > 5 ? ', ...' : ''}). That is what a room the relay partly lost looks like. If the agents really deleted them, run again with --allow-mass-delete. Nothing was changed.`)
    }

    const planFile = path.join(tmp, '..', `${path.basename(tmp)}-plan.json`)
    const args = [HIVE_PR, b.link, 'hive-pr', '--repo', tmp, '--branch', temp, '--base', 'HEAD', '--plan-json', planFile]
    if (dry) args.push('--dry-run')
    if (o.force) args.push('--force', String(o.force))
    if (o.only) args.push('--only', String(o.only))
    if (b.base) args.push('--seed', String(b.base)) // a file unchanged since the seed is one the room started from (0.14.3 P0-3)
    // ASYNC, not spawnSync: inside the hive_pr tool this runs in the agent's MCP server, and a landing
    // that blocked its event loop for minutes would freeze that agent's own room connection too.
    const r = await runNode(args, { cwd: tmp, env: HB.noHooksEnv({ ...process.env, HIVE_PROVENANCE: 'on' }) })
    readPlan(planFile, r.stdout, res)
    try { fs.rmSync(planFile, { force: true }) } catch { }
    if (r.stdout) log(r.stdout.replace(/\s+$/, ''))
    // Q501 is hive-pr saying no file in the room carries an agent's receipt: nothing was changed or
    // added. For a branch room that is an answer, not a failure -- and deletions may still land.
    const nothingChanged = r.status !== 0 && /^Q501 /m.test(r.stderr || '')
    if (r.status !== 0 && !nothingChanged) {
      const msg = String(r.stderr || r.error || `hive-pr exited ${r.status}`).replace(/\s+$/, '')
      const code = (msg.match(/\b(Q5\d\d)\b/) || [])[1] || 'Q563'
      return refuse(code, msg)
    }
    if (res.orphans.length) {
      const line = `NOT landed (no signed receipt): ${res.orphans.join(', ')} -- changed in the room by a client that signs nothing (an older Hivecode, or provenance off). Whoever changed it should save it again with Hivecode 0.13 or later.`
      res.notes.push(line); log(line)
    }
    if (dry) {
      if (deletions.length) log(`would delete ${deletions.length} file(s) the room deleted: ${deletions.join(', ')}`)
      log(o.test ? `tests: would run \`${o.test}\` before anything moves` : 'tests: NOT RUN (no test command; pass --test "<command>")')
      return Object.assign(res, { ok: true, why: dryWhy(name, res) })
    }

    if (deletions.length) {
      // hive-pr left the temporary worktree on its branch when it committed; when it had nothing to
      // commit it never made one, so make it here, at the same tip.
      if (!HB.revParse(root, `refs/heads/${temp}`)) git(tmp, HB.noHooks(['checkout', '-q', '-b', temp]))
      const rm = git(tmp, ['rm', '-q', '--', ...deletions])
      if (rm.code !== 0) return refuse('Q563', `could not stage the room's deletions: ${rm.err}`)
      const msg = [`Room: delete ${deletions.length === 1 ? deletions[0] : `${deletions.length} files`}`, '', ...deletions.map((d) => `  - ${d}`), '', `Room: ${parseLink(b.link).room}`].join('\n')
      const c = git(tmp, HB.noHooks(['commit', '-q', '-m', msg, '--author', 'hivecode-room <room@agents.hivecode.local>']))
      if (c.code !== 0) return refuse('Q563', `could not commit the room's deletions: ${c.err || c.out}`)
    }

    // NOTHING NEW TO LAND IS NOT "DONE" WHEN A PUSH OR A PR WAS ASKED FOR (1 Nov 2026): push and
    // open what is already there.
    let nothingNew = false
    if (nothingChanged && !deletions.length) { log(`nothing to land yet: no agent has changed a file in the room for ${name}.`); nothingNew = true }
    const newTip = nothingNew ? tip : HB.revParse(root, `refs/heads/${temp}`)
    if (!nothingNew && (!newTip || newTip === tip)) { log(`nothing to land: ${name} already has everything the room holds.`); nothingNew = true }

    if (!nothingNew) {
      // ── 5. CLAIMS AGAIN: a claim taken while this ran means a change was caught half-made ─────
      if (o.claims !== false) {
        const again = await roomSnapshot(b.link)
        if (again && again.holders.length) return refuse('Q575', `not landed: ${describeHolders(again.holders)} -- started while this landing ran, so a change may have been caught half-made. Run this again when they release. Nothing was changed.`, { holders: again.holders })
      }
      const changed = git(root, ['diff', '--name-only', '-z', tip, newTip]).out.split('\0').filter(Boolean)
      // ── 6. WHAT MAY NOT LEAVE THIS MACHINE ─────────────────────────────────────────────────────
      if (o.checks !== false) {
        const workflows = o.allowWorkflowChanges ? [] : changed.filter((p) => /^\.github\/workflows\//i.test(p))
        if (workflows.length) return refuse('Q578', `not landed: the change touches ${workflows.join(', ')}. A workflow runs with the repository's secrets, so it lands only when asked for explicitly: run again with --allow-workflow-changes. Nothing was changed.`)
        const leaked = secretsIn(root, newTip, changed)
        if (leaked.length) return refuse('Q578', `not landed: the change has ${leaked.join(', ')}. Remove it from the room's copy, then land again. Nothing was changed.`)
      }
      // ── 7. THE TESTS, on the exact commit that would move ──────────────────────────────────────
      if (o.test) {
        const at = git(tmp, ['rev-parse', 'HEAD']).out
        let cwdTests = tmp
        // A CAN'T-HAPPEN INVARIANT, kept on purpose: hive-pr commits in this worktree, so its HEAD is
        // the new tip. No test reaches this line (antigravity's mutant 3, 5 Nov 2026); if it ever
        // fired, a pass would be a pass on a different commit than the one that moves.
        if (at !== newTip) {
          return refuse('Q576', `the test checkout is at ${short(at)}, not at the commit that would land (${short(newTip)}). Nothing was changed.`)
        }
        junction = linkDependencies(root, cwdTests, newTip, res)
        const env = scrubbedEnv(process.env, res)
        const minutes = Number(o.testMinutes) > 0 ? Number(o.testMinutes) : 20
        // TESTS THAT NEED WHAT GIT DOES NOT HAVE (debate #3: all three agents ranked it a stranger's
        // top-2 wall). Files the developer NAMED are copied from their checkout into the clean one;
        // a setup command runs first. Both come from the caller or from what the developer saved for
        // this branch -- never guessed, and never a whole .env by default.
        const saved = testConfigFor(root, name)
        const copyList = (Array.isArray(o.testCopy) ? o.testCopy : saved.copy).filter(Boolean)
        const setup = typeof o.testSetup === 'string' ? o.testSetup : saved.setup
        for (const rel of copyList) {
          const src = path.resolve(root, rel), dest = path.resolve(cwdTests, rel)
          const inside = (base, p) => p === base || p.startsWith(base + path.sep)
          // `C:foo` is not absolute to Node on Windows and resolves INSIDE the repo lexically; a
          // .git path would write into git's own data (Antigravity's review).
          if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /(^|[\\/])\.git([\\/]|$)/i.test(rel) || !inside(path.resolve(root), src) || !inside(path.resolve(cwdTests), dest)) return refuse('Q576', `--test-copy names ${rel}, which is outside the repository. Only files inside ${root} can be copied for the tests. Nothing was changed.`)
          if (!fs.existsSync(src) || !fs.lstatSync(src).isFile()) return refuse('Q576', `--test-copy names ${rel}, but there is no such regular file in ${root}${fs.existsSync(src) && fs.lstatSync(src).isSymbolicLink() ? ' (it is a link, and a link can point anywhere on this machine)' : ''}. Nothing was changed.`)
          // A TRACKED FILE IS THE ROOM'S: copying the developer's copy over it would test old code
          // and land the room's untested edit -- green, and wrong (Antigravity's review).
          if (git(root, ['cat-file', '-e', `${newTip}:${rel.replace(/\\/g, '/')}`]).code === 0) return refuse('Q576', `--test-copy names ${rel}, which is part of the commit being tested. --test-copy is only for files git does not have (an .env.test, a local config); copying your copy over it would test something other than what lands. Nothing was changed.`)
          if (!inside(fs.realpathSync(root), fs.realpathSync(src))) return refuse('Q576', `--test-copy names ${rel}, which resolves outside the repository. Nothing was changed.`)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          if (!inside(fs.realpathSync(cwdTests), fs.realpathSync(path.dirname(dest))) || (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink())) return refuse('Q576', `--test-copy cannot write ${rel}: in the commit being tested that path is (or is under) a link that points outside the checkout. Nothing was changed.`)
          fs.copyFileSync(src, dest)
        }
        if (copyList.length) { const note = `the tests had ${copyList.length} uncommitted file(s) copied in from your checkout: ${copyList.join(', ')}.`; res.notes.push(note); log(note) }
        if (setup) {
          log(`tests: setup \`${setup}\` ...`)
          const s = await runTests({ cwd: cwdTests, command: setup, minutes, env })
          if (!s.ok) return refuse('Q576', `not landed: the test setup \`${setup}\` ${!s.started ? 'could not start' : s.timedOut ? 'ran past the time limit' : `failed (exit ${s.code})`}.\n${s.tail}\nNothing was changed.`)
        }
        log(`tests: running \`${o.test}\` on ${short(newTip)} ...`)
        const t = await runTests({ cwd: cwdTests, command: o.test, minutes, env })
        res.tests = { ran: true, command: o.test, ok: t.ok, code: t.code, sha: newTip, tail: t.tail, seconds: t.seconds }
        if (!t.ok) {
          const why = !t.started ? `the test command could not start (\`${o.test}\`); check that it is installed on this machine`
            : t.timedOut ? `the tests ran past the ${minutes}-minute time limit and were stopped`
            : `the tests failed (exit ${t.code}) on ${short(newTip)}`
          const deps = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(t.tail) && !junction
            ? '\nThe tests ran in a clean checkout without installed dependencies; add the install step: --test-setup "npm ci" --save.' : ''
          const files = /ENOENT|no such file|not found|cannot open/i.test(t.tail) && !copyList.length
            ? `\nThe tests ran in a clean checkout, which has only what git has. If they need a file you keep uncommitted (an .env.test, a local config), name it: --test-copy <file>[,<file>] --save.` : ''
          return refuse('Q576', `not landed: ${why}.\n${t.tail}${deps}${files}\nNothing was changed.`)
        }
        log(`tests passed on ${short(newTip)} (\`${o.test}\`, ${t.seconds}s)`)
      } else {
        log('tests: NOT RUN (no test command; pass --test "<command>")')
      }

      // ── 8. MOVE THE BRANCH ─────────────────────────────────────────────────────────────────────
      // Checked out somewhere: only a clean fast-forward of that checkout, which is what `git pull`
      // would do; with local changes it is refused, because moving the branch under a dirty checkout
      // makes its edits look like reversals of the landed work.
      const on = worktreesOn(root, name).filter((p) => p !== path.resolve(tmp))
      if (on.length) {
        const where = on[0]
        const dirty = git(where, ['status', '--porcelain', '--untracked-files=no'])
        if (dirty.out) return refuse('Q571', `${name} is checked out in ${where} with uncommitted changes. Commit or stash them there (or switch that checkout to another branch), then run pr again. Nothing was changed.`)
        const ff = git(where, ['merge', '--ff-only', '--quiet', newTip])
        if (ff.code !== 0) return refuse('Q570', `could not fast-forward ${name} in ${where}: ${ff.err || 'git refused'}. Nothing was changed; if the branch moved there, run pr again.`)
      } else {
        const cas = git(root, ['update-ref', '-m', 'hivecode: land room work', `refs/heads/${name}`, newTip, tip])
        if (cas.code !== 0) return refuse('Q570', `${name} moved while this was landing (it is no longer ${short(tip)}). Nothing was changed; run pr again so the new commits are accounted for.`)
      }
      const made = git(root, ['log', '--format=  %h  %an  %s', `${tip}..${newTip}`]).out
      res.landed = made.split('\n').filter(Boolean).length
      res.tip = newTip
      log(`\nlanded on ${name}:\n${made}`)
    } else if (!o.test) {
      log('tests: NOT RUN (nothing new landed)')
    }

    // ── 9. PUSH THE EXACT SHA, never forced ──────────────────────────────────────────────────────
    if (push) {
      const sha = res.tip
      const p = gitNet(root, ['push', '--quiet', 'origin', `${sha}:refs/heads/${name}`], Number(process.env.HIVE_GIT_NET_TIMEOUT_MS) || 300000)
      if (p.code !== 0) return refuse('Q573', `the work ${res.landed ? 'landed' : 'is'} on ${name} locally (${short(sha)}), but the push failed: ${oneLine(p.err)}${loginHint(p.err)}`)
      git(root, ['branch', '--quiet', `--set-upstream-to=origin/${name}`, name])
      res.pushed = true
      log(`pushed ${name} (${short(sha)})`)
    }

    // ── 10. THE PR: update the open one, never a second ─────────────────────────────────────────
    if (wantPr) {
      const prs = (github.pullsFor(name) || []).filter((p) => !p.head || !p.head.ref || p.head.ref === name)
      const open = prs.find((p) => p.state === 'open')
      if (open) {
        res.pr = { number: open.number, url: open.html_url || '', created: false, updated: true, newCommits: res.landed }
        log(`Updated PR #${open.number} (${res.landed} new commit(s)): ${open.html_url || ''}`)
      } else {
        const intoRef = HB.revParse(root, `refs/remotes/origin/${into}`) ? `origin/${into}` : into
        const ahead = Number(git(root, ['rev-list', '--count', `${intoRef}..${res.tip}`]).out) || 0
        if (!ahead) {
          const note = `no PR opened: ${name} has no commits beyond ${into}.`
          res.notes.push(note); log(note)
        } else {
          const body = prBody({ name, into: intoRef, root, summary: o.summary, by, res, force: o.force })
          let pr = null
          try { pr = github.createPull({ title: o.title || `Hivecode: ${name}`, head: name, base: into, body }) } catch (e) {
            const again = e && e.status === 422 ? (github.pullsFor(name) || []).find((p) => p.state === 'open') : null
            // onBranch: origin has the work and only the pull request is missing. A caller that speaks for
            // the landing (the GitHub Action) must not say "nothing was pushed", and tries the PR again.
            if (!again) return refuse('Q574', `the work is pushed to ${name}, but opening the PR failed: ${e.message}`, { onBranch: true })
            pr = again
          }
          const closed = prs.filter((p) => p.state !== 'open').map((p) => `#${p.number}`)
          if (closed.length) { const note = `the earlier PR for ${name} (${closed.join(', ')}) was closed or merged; this is a new one.`; res.notes.push(note); log(note) }
          res.pr = { number: pr.number, url: pr.html_url || '', created: true, updated: false, newCommits: res.landed }
          log(`Opened PR #${pr.number}: ${pr.html_url || ''}`)
        }
      }
    }

    res.ok = true
    res.why = doneWhy(name, res)
    return res
  } catch (e) {
    if (e && typeof e.code === 'string' && /^Q\d{3}$/.test(e.code)) return refuse(e.code, e.message)
    throw e
  } finally {
    cleanup()
    if (lock && lock.ok) lock.release()
  }
}

/**
 * THE TEST COMMAND FOR A BRANCH, from configuration and never from whoever is asking: what the
 * developer saved (`pr <branch> --test "<cmd>" --save`), else the project's own `npm test` when
 * package.json at the branch tip has a real test script (not npm's "no test specified"), else ''.
 * A tool argument would let any caller choose a shell command for Hivecode to run on this machine.
 */
export function testCommandFor(cwd, branch) {
  let root
  try { root = HB.projectRoot(cwd) } catch { return { command: '', from: '' } }
  const saved = git(root, ['config', '--local', '--get', `hivecode.${branch}.test`])
  if (saved.code === 0 && saved.out) return { command: saved.out, from: 'saved' }
  const pj = git(root, ['cat-file', 'blob', `refs/heads/${branch}:package.json`])
  try {
    const t = JSON.parse(pj.out || '{}').scripts?.test
    if (typeof t === 'string' && t.trim() && !/no test specified/i.test(t)) return { command: 'npm test', from: 'package.json' }
  } catch { /* not JSON: no project test script */ }
  return { command: '', from: '' }
}

export function saveTestCommand(cwd, branch, command, { copy = null, setup = null } = {}) {
  const root = HB.projectRoot(cwd)
  const set = (k, v) => {
    const r = git(root, ['config', '--local', `hivecode.${branch}.${k}`, String(v)])
    if (r.code !== 0) throw HB.coded('Q576', `could not save ${k} in git config: ${r.err}`)
  }
  set('test', command)
  if (Array.isArray(copy)) { if (copy.length) set('testCopy', copy.join(',')); else git(root, ['config', '--local', '--unset', `hivecode.${branch}.testCopy`]) }
  if (typeof setup === 'string') { if (setup) set('testSetup', setup); else git(root, ['config', '--local', '--unset', `hivecode.${branch}.testSetup`]) }
  return root
}

/** What the developer saved for the tests besides the command: files to copy in, a setup step. */
export function testConfigFor(cwdOrRoot, branch) {
  let root
  try { root = HB.projectRoot(cwdOrRoot) } catch { return { copy: [], setup: '' } }
  const get = (k) => { const r = git(root, ['config', '--local', '--get', `hivecode.${branch}.${k}`]); return r.code === 0 ? r.out : '' }
  return { copy: get('testCopy').split(',').map((s) => s.trim()).filter(Boolean), setup: get('testSetup') }
}

// ── the pieces ─────────────────────────────────────────────────────────────────────────────────

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 400)
function loginHint(err) {
  return /auth|denied|permission|403|401|credential|could not read Username/i.test(String(err || ''))
    ? ' The login on this machine was refused: run gh auth login (or fix your git credentials), then try again.' : ''
}

function describeHolders(holders) {
  return holders.map((h) => `${h.by} holds ${h.file} (${h.intent || 'edit'}; ${h.leftSec}s left on the claim)`).join('; ')
}

/** The room's file list and live claims, from a passive look that syncs no files. null: unreachable. */
async function roomSnapshot(link) {
  const { relay, room } = parseLink(link)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-land-peek-'))
  const peek = startSync({ relay, room, dir, name: 'hive-land-peek', kind: 'ai', passive: true, syncFiles: false, log: () => {} })
  try {
    let synced = false
    peek.provider.on('sync', (s) => { if (s) synced = true })
    if (!(await HB.waitFor(() => synced, 15000))) return null
    await sleep(300)
    const now = Date.now()
    const holders = makeCoordinator(peek.doc.getMap('claims'), 'hive-land-peek').board()
      .filter((c) => c && c.by)
      .map((c) => ({ file: c.region, by: c.by, intent: c.intent || 'edit', leftSec: Math.max(0, Math.round(((Number(c.at) || 0) + (Number(c.ttl) || 0) - now) / 1000)) }))
    // The commit the room records it was seeded from (hive-branch seedRoom writes it): checked against
    // this clone's binding before --seed is trusted (0.14.3 P0-3-H).
    const sc = peek.doc.getMap('seed').get('commit')
    const seed = typeof sc === 'string' && /^[0-9a-f]{40}$/i.test(sc) ? sc : ''
    return { paths: new Set(peek.doc.getMap('manifest').keys()), holders, seed }
  } finally {
    try { peek.stop() } catch { }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
  }
}

/**
 * THE ROOM'S DELETIONS, which hive-pr does not land: it copies the files a room holds, so a file an
 * agent deleted would simply stay on the branch. A room bound to a branch starts as the whole branch,
 * so "on the branch but no longer in the room" is a deletion -- but only when the room provably held
 * THAT version of the file:
 *   - last changed on the branch by a landing from this room (its commit says "Room: <id>") -> delete
 *   - unchanged since the seed commit                                                  -> delete
 *   - in the seed, but changed on the branch since by someone else                     -> REFUSE (Q572)
 *   - not in the seed and not landed from this room: added to the branch outside the room -> keep
 */
function roomDeletions({ root, room, base, tip, paths, atTip, carries }) {
  if (!base) return []
  const baseSha = new Map(HB.treeFiles(root, base).map((f) => [f.rel, f.sha]))
  const gone = [], diverged = []
  for (const f of atTip) {
    if (!carries(f) || paths.has(f.rel) || HB.isOwnFile(f.rel)) continue
    const last = git(root, ['log', '-1', '--format=%B', tip, '--', f.rel]).out
    if (new RegExp(`^Room: ${reEsc(room)}$`, 'm').test(last)) gone.push(f.rel)
    else if (baseSha.get(f.rel) === f.sha) gone.push(f.rel)
    else if (baseSha.has(f.rel)) diverged.push(f.rel)
  }
  if (diverged.length) {
    const who = (rel) => git(root, ['log', '-1', '--format=%h %an %ad %s', '--date=short', tip, '--', rel]).out
    throw HB.coded('Q572', `the room deleted ${diverged.length} file(s) that were changed on the branch since it was seeded, by a change the room never saw:\n${diverged.map((r) => `  ${r}   last changed by: ${who(r)}`).join('\n')}\nDeleting them would erase that change. Nothing was changed. Restore the file in the room (or delete it on the branch yourself), then run pr again.`)
  }
  return gone
}

function worktreesOn(root, branch) {
  const r = git(root, ['worktree', 'list', '--porcelain'])
  const out = []
  let cur = null
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice(9)
    else if (line === `branch refs/heads/${branch}` && cur) out.push(path.resolve(cur))
  }
  return out
}

/** hive-pr's plan (--plan-json), or what its stdout says when it is an older hive-pr without one. */
function readPlan(file, stdout, res) {
  let plan = null
  try { plan = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* an older hive-pr */ }
  if (plan) {
    // A group whose files are all already on the branch commits nothing: listing it would make a dry
    // run promise "1 commit would land" when nothing would (measured: K4, 5 Nov 2026).
    res.plan = (plan.groups || []).map((g) => ({ agent: g.name, files: g.files || [], intents: g.intents || [] })).filter((g) => g.files.length)
    res.orphans = (plan.orphans || []).filter((rel) => !GENERATED.test(path.posix.basename(rel)) && !HB.isOwnFile(rel))
    // The room's content hash per file, as the mirror read it: what a review must match, and what
    // tells "the room changed since the last refused landing" apart from "same names, same failure".
    if (plan.hashes && typeof plan.hashes === 'object') res.hashes = { ...plan.hashes }
    return
  }
  const m = String(stdout || '').match(/\(\d+ file\(s\) with no verified receipt -- not committed: ([^)]*)\)/)
  if (m) res.orphans = m[1].split(', ').map((s) => s.trim()).filter((rel) => rel && !GENERATED.test(path.posix.basename(rel)) && !HB.isOwnFile(rel))
}

/** Keys in the files a change touched, at `tip`. Rooms never carry a file with a key in it, so this
 *  should never fire; it is the check on what leaves this machine, not on what the room did. */
function secretsIn(root, tip, changed) {
  const found = []
  for (const rel of changed) {
    const size = Number(git(root, ['cat-file', '-s', `${tip}:${rel}`]).out || 0)
    if (!size || size > 1_000_000) continue
    const r = spawnSync('git', ['cat-file', 'blob', `${tip}:${rel}`], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    const text = r.stdout || ''
    if (text.includes('\0')) continue
    for (const f of findSecrets(text)) found.push(`${f.kind} in ${rel} (line ${f.line})`)
  }
  return found
}

// ── one landing per branch ──────────────────────────────────────────────────────────────────────

function takeLock(root, branch, by) {
  const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).out || '.git')
  const dir = path.join(common, 'hivecode')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `land-${HB.safeSegment(branch)}.lock`)
  const me = { pid: process.pid, host: os.hostname(), by, at: Date.now() }
  let note = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(me), { flag: 'wx' })
      return {
        ok: true, note,
        release: () => { try { const cur = JSON.parse(fs.readFileSync(file, 'utf8')); if (cur.pid === me.pid && cur.at === me.at) fs.unlinkSync(file) } catch { } },
      }
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, why: `could not take the landing lock (${file}): ${e.message}` }
      let rec = null
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* half-written: treat as stale below */ }
      const when = rec && rec.at ? new Date(rec.at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'an unknown time'
      const dead = !rec || (rec.host === os.hostname() && !alive(Number(rec.pid))) || Date.now() - (Number(rec.at) || 0) > 6 * 3600000
      if (!dead) return { ok: false, why: `a landing of ${branch} is already running, started by ${rec.by || 'someone'} at ${when} (pid ${rec.pid} on ${rec.host}). Wait for it to finish, then run this again. Nothing was changed.` }
      try { fs.unlinkSync(file) } catch { }
      note = `took over the landing lock of ${branch} left by ${(rec && rec.by) || 'an unknown landing'} (pid ${rec && rec.pid}, ${when}), which is no longer running.`
    }
  }
  return { ok: false, why: `could not take the landing lock of ${branch}; another landing keeps taking it. Nothing was changed.` }
}

// ── the tests ───────────────────────────────────────────────────────────────────────────────────

// THE TESTS RUN THE AGENTS' CODE WITH THIS MACHINE'S ENVIRONMENT. Credentials are removed first: a
// test (or a prompt-injected agent's test) must not be able to read the GitHub token that pushes.
const CREDENTIAL = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)|^AWS_|^GH_|^GITHUB_|^HIVE_LICENSE$/i
function scrubbedEnv(env, res) {
  const out = {}
  let removed = 0
  for (const [k, v] of Object.entries(env)) { if (CREDENTIAL.test(k)) removed++; else out[k] = v }
  if (removed) res.notes.push(`the tests ran with ${removed} credential variable(s) removed from their environment.`)
  return out
}

/**
 * A clean checkout has no node_modules, so a project's `npm test` fails there with "Cannot find
 * module" -- on real repositories the likeliest failure of all. When the lockfiles at the landing
 * commit are exactly the ones this checkout installed from, its node_modules is linked in (a
 * junction on Windows); otherwise the command runs as given.
 */
export function linkDependencies(root, dir, sha, res) {
  const nm = path.join(root, 'node_modules')
  if (!fs.existsSync(nm) || fs.existsSync(path.join(dir, 'node_modules'))) return ''
  const LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']
  let any = false
  for (const f of LOCKS) {
    let mine = null
    try { mine = fs.readFileSync(path.join(root, f)) } catch { }
    const at = spawnSync('git', ['cat-file', 'blob', `${sha}:${f}`], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    const theirs = at.status === 0 ? at.stdout : null
    if ((mine === null) !== (theirs === null)) return ''
    if (mine !== null) {
      const match = mine.equals(theirs) || (!f.endsWith('.lockb') && toLF(mine.toString('utf8')) === toLF(theirs.toString('utf8')))
      if (!match) return ''
      any = true
    }
  }
  if (!any) return ''
  const link = path.join(dir, 'node_modules')
  try { fs.symlinkSync(nm, link, 'junction') } catch { return '' }
  res.notes.push('the tests used this checkout\'s node_modules (the lockfile at the landing commit is identical).')
  return link
}

function runNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = ''
    let child
    try { child = spawn(process.execPath, args, { cwd, env, windowsHide: true }) } catch (e) { return resolve({ status: 1, stdout: '', stderr: '', error: e }) }
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => { stderr += `\n${e.message}` })
    child.on('close', (code) => resolve({ status: code === null ? 1 : code, stdout, stderr }))
  })
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  else { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { } } }
}

function runTests({ cwd, command, minutes, env }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let out = '', timedOut = false, child
    try {
      child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32' })
    } catch (e) {
      return resolve({ started: false, ok: false, code: -1, timedOut: false, tail: String(e.message), seconds: 0 })
    }
    const add = (d) => { out += d; if (out.length > 400000) out = out.slice(-200000) }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, Math.max(1000, minutes * 60000))
    child.on('error', (e) => add(`\n${e.message}`))
    child.on('close', (code) => {
      clearTimeout(timer)
      const notFound = !timedOut && (code === 127 || code === 9009 || /is not recognized as an internal or external command|command not found|: not found\b/i.test(out))
      resolve({ started: !notFound, ok: !timedOut && code === 0, code, timedOut, tail: tailLines(out, 30), seconds: Math.round((Date.now() - t0) / 1000) })
    })
  })
}

// ── GitHub ──────────────────────────────────────────────────────────────────────────────────────

async function defaultGitHub(root) {
  const GH = await import('./hive-github.js')
  const url = git(root, ['remote', 'get-url', 'origin']).out
  const r = GH.parseRepo(url)
  if (!r) throw HB.coded('Q578', `origin (${url}) is not a GitHub repository, so there is no pull request to open. Push without --pr.`)
  return GH.makeGitHub({ call: GH.ghCall(), owner: r.owner, repo: r.repo })
}

function prBody({ name, into, root, summary, by, res, force }) {
  const commits = git(root, ['log', '--format=  %h  %an  %s', `${into}..${name}`]).out || git(root, ['log', '-20', '--format=  %h  %an  %s', name]).out
  const tests = res.tests && res.tests.ran
    ? `Tests: \`${res.tests.command}\` passed on ${short(res.tests.sha)}, the exact commit pushed.`
    : 'Tests: **NOT RUN** -- no test command was given for this landing.'
  return [
    `Opened by Hivecode from the room bound to \`${name}\`${by ? `, landed by ${by}` : ''}.`,
    summary ? `\n${String(summary).slice(0, 4000)}` : '',
    '',
    tests,
    res.orphans.length ? `\n> **Not in this PR:** ${res.orphans.join(', ')} changed in the room without a signed receipt.` : '',
    res.deletions.length ? `\nDeleted by the room: ${res.deletions.join(', ')}` : '',
    force ? `\n> **Forced past a staleness refusal:** ${String(force).slice(0, 500)}` : '',
    '',
    'Each commit carries its agent as the git author and the signed author id as a `Hivecode-Author` trailer.',
    '', '```', commits, '```',
  ].filter((l) => l !== null).join('\n')
}

function dryWhy(name, res) {
  const n = res.plan.length
  return `dry run: ${n ? `${n} commit(s) would land on ${name} (${res.plan.map((g) => `${g.agent}: ${g.files.length} file(s)`).join(', ')})` : `nothing new would land on ${name}`}${res.deletions.length ? `, deleting ${res.deletions.length} file(s)` : ''}${res.orphans.length ? `; NOT landing ${res.orphans.length} unsigned file(s): ${res.orphans.join(', ')}` : ''}. Nothing was changed.`
}
function doneWhy(name, res) {
  const parts = [res.landed ? `landed ${res.landed} commit(s) on ${name} (${short(res.tip)})` : `nothing new to land on ${name}`]
  parts.push(res.tests.ran ? `tests passed on ${short(res.tests.sha)}` : 'tests: NOT RUN')
  if (res.pushed) parts.push('pushed')
  if (res.pr) parts.push(res.pr.updated ? `updated PR #${res.pr.number} ${res.pr.url}` : `opened PR #${res.pr.number} ${res.pr.url}`)
  if (res.orphans.length) parts.push(`NOT landed (no signed receipt): ${res.orphans.join(', ')}`)
  return parts.join('; ')
}
