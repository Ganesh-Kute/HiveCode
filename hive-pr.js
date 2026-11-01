// hive-pr — turn a room's landed work into a pull request, with per-agent attribution intact.
//
//   node hive-pr.js "<relay|room>" <YourName> --repo <path> [options]
//
//     --repo <path>      the git working copy the PR is opened against   (required)
//     --branch <name>    branch to create            (default: hivecode/<room>-<stamp>)
//     --base <name>      branch to cut from          (default: the repo's current HEAD)
//     --title <text>     PR title                    (default: derived from the room)
//     --only <a,b,c>     only these files
//     --dry-run          print the plan, touch nothing
//     --push             push the branch to origin
//     --pr               push and open a PR with `gh`  (implies --push)
//
// WHY THIS EXISTS. A room is where the work happens; a pull request is where a team already
// trusts work to arrive. Asking a team to abandon pull requests is an enormous ask -- they are
// how review, compliance and audit happen, and in many companies they are mandatory for reasons
// nobody on the team controls. So we do not ask. The room's OUTPUT is a PR, and everything about
// the team's existing pipeline (CI, required reviewers, protected branches, deploy) keeps working
// exactly as it did.
//
// THE PART THAT IS NOT PLUMBING. Every change in a room is signed per participant, so we know
// which agent landed which file -- and that survives into git as ONE COMMIT PER AGENT, each with
// its real author and the full signed author id in a trailer. A reviewer opening the PR sees, in
// `git log`, exactly which agent wrote what. No orchestration framework can produce that: they
// run every agent inside one process under one identity, so the attribution never existed to
// carry across.
//
// Attribution is per FILE, not per line. The ledger records who landed each version of a file, so
// a file is credited to whoever landed its FINAL state, and everyone else who touched it rides
// along as a Co-authored-by trailer. Claiming line-level authorship would be a stronger statement
// than the data supports.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync, parseLink } from './sync.js'
import { accountFor, verdict, explain, DIVERGED } from './hive-pr-staleness.js'
import { contentHash } from './substrate.js'

const argv = process.argv.slice(2)
const [LINK = '', NAME = 'hive-pr'] = argv.filter((a) => !a.startsWith('--'))
const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || '') }
const has = (k) => argv.includes('--' + k)
// --force takes a REASON, not a bare switch. A switch is typed once and never explained; a
// required reason has to be written down, ends up in the PR body, and is the thing somebody asks
// about later. hive_release already works this way for exactly the same argument.
const FORCE = flag('force')

const REPO = flag('repo')
const DRY = has('dry-run')
const DO_PUSH = has('push') || has('pr')
const DO_PR = has('pr')
const ONLY = flag('only') ? flag('only').split(',').map((s) => s.trim()).filter(Boolean) : null

function die(code, msg) { console.error(`${code} ${msg}`); process.exit(1) }

/** Run git in the target repo. Never throws on a non-zero exit -- the caller decides. */
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', ...opts })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

/** The same, WITHOUT trimming. For reading file CONTENT, where a trailing newline is part of the
 *  file and not whitespace around an answer.
 *
 *  `git()` above trims, which is right for `rev-parse` and `log` and wrong for `cat-file blob` --
 *  and wrong in the worst way: it strips the final newline, so the content hash of a healthy file
 *  never matches the room's chain, every file reads DIVERGED, and the staleness check refuses
 *  every run. Caught by the end-to-end suite on its FIRST assertion; the unit suite could not
 *  have seen it, because it passes text straight in and never goes near git. */
function gitRaw(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', ...opts })
  return { code: r.status, out: r.stdout == null ? '' : r.stdout, err: (r.stderr || '').trim() }
}

/** The authors of a file, newest-landed first, from VERIFIED receipts only.
 *  An unverifiable receipt is not evidence of authorship, so it is dropped rather than trusted. */
// `roomText`, when given: the author of what the room HOLDS, not of the newest receipt. After a
// control-room revert the room holds an older version, restored without a receipt, so "newest" named
// the reverted agent as the author of the code it had just been reverted out of (antigravity-3, 1 Nov).
export function authorsOf(receipts, verify, roomText) {
  const ok = receipts.filter((r) => r && r.author && (!verify || verify(r)))
  if (!ok.length) return { last: null, contributors: [], first: 0 }
  // Receipts newer than the one the room holds are work that was reverted out: not co-authors either.
  // Content no receipt matches (a merge, or a revert to a merged state) keeps the old rule, newest
  // lander, a known limit until merged states are stamped into the ledger (antigravity-3, 1 Nov).
  const want = typeof roomText === 'string' ? contentHash(roomText) : null
  let idx = -1
  if (want) for (let i = ok.length - 1; i >= 0; i--) if (ok[i].contentHash === want) { idx = i; break }
  const held = idx >= 0 ? ok.slice(0, idx + 1) : ok
  const last = held[held.length - 1]
  const seen = new Map()
  for (const r of held) if (!seen.has(r.author)) seen.set(r.author, { author: r.author, name: r.name || 'agent', at: r.at || 0 })
  return {
    last: { author: last.author, name: last.name || 'agent', at: last.at || 0 },
    contributors: [...seen.values()],
    first: Math.min(...ok.map((r) => r.at || 0)),
  }
}

const mailOf = (name) => `${String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'agent'}@agents.hivecode.local`

/** Group files by the agent who landed their final state, oldest contribution first. */
export function planCommits(files) {
  const groups = new Map()
  for (const f of files) {
    if (!f.last) continue
    const g = groups.get(f.last.author) || { author: f.last.author, name: f.last.name, at: f.first, files: [], others: new Map() }
    g.files.push(f)
    g.at = Math.min(g.at, f.first)
    for (const c of f.contributors) if (c.author !== f.last.author) g.others.set(c.author, c)
    groups.set(f.last.author, g)
  }
  return [...groups.values()]
    .map((g) => ({ ...g, others: [...g.others.values()] }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
}

export function commitMessage(g, room) {
  const list = g.files.map((f) => f.rel).sort()
  const head = list.length === 1 ? `${g.name}: ${list[0]}` : `${g.name}: ${list.length} files`
  const lines = [head, '', ...list.map((x) => `  - ${x}`), '', `Room: ${room}`, `Hivecode-Author: ${g.author}`]
  for (const o of g.others) lines.push(`Co-authored-by: ${o.name} <${mailOf(o.name)}>`)
  return lines.join('\n')
}

// ---- main ---------------------------------------------------------------------------------
// COMPARED AS REAL PATHS, as hive-mcp.js does. The old test built `file:///` + argv[1], which is
// right only on Windows: on macOS and Linux argv[1] already starts with '/', the URL came out as
// `file:////...`, never matched, and the script exited 0 having done nothing at all.
const isMain = (() => {
  if (!process.argv[1]) return false
  const me = fileURLToPath(import.meta.url)
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(me) } catch { return path.resolve(process.argv[1]) === path.resolve(me) }
})()
if (isMain) {
  if (!LINK || !REPO) {
    console.error('usage: node hive-pr.js "<relay|room>" <YourName> --repo <path> [--branch b] [--dry-run] [--push] [--pr] [--force "<reason>"]')
    process.exit(2)
  }
  if (!fs.existsSync(path.join(REPO, '.git'))) die('Q500', `${REPO} is not a git repository`)

  const { relay, room } = parseLink(LINK)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)
  const BRANCH = flag('branch') || `hivecode/${room}-${stamp}`
  const TITLE = flag('title') || `Hivecode: work from room ${room}`

  // A scratch mirror of the room, so nothing here can disturb anyone's working folder.
  // os.tmpdir(), not $TEMP: TEMP is a Windows variable, and without it the mirror was made in the
  // current directory -- inside the very checkout the PR is cut from.
  const dir = path.join(os.tmpdir(), `hive-pr-${room}-${process.pid}`)
  fs.mkdirSync(dir, { recursive: true })

  // Provenance is what this whole tool reads. Without it the ledger is empty and every
  // commit would collapse to one anonymous blob -- which is exactly the thing we are here
  // to avoid, so turn it on for this client rather than failing later with an empty plan.
  process.env.HIVE_PROVENANCE = process.env.HIVE_PROVENANCE || 'on'

  const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: true, log: () => {} })

  let done = false
  // Cleared once the room answers. It used to stay armed for the whole run, so a landing that
  // took longer than 20 s was killed as "could not reach the relay" -- mid-commit, possibly.
  const unreachable = setTimeout(() => die('Q470', `could not reach the relay at ${relay}`), 20000)
  hive.provider.on('sync', (s) => {
    if (!s || done) return
    done = true
    clearTimeout(unreachable)
    whenWholeRoomArrived()
  })

  // THE WHOLE ROOM, OR NOTHING. The file sub-docs arrive after the room doc, and this used to wait
  // a flat 2.5 s for them. On a room bigger than what arrives in 2.5 s, the files still in flight
  // were simply not in the mirror: not planned, not committed, not mentioned -- a PR that looks
  // complete and silently leaves agents' work behind. Now the plan waits until every file the room
  // lists is on disk here (a file's receipts travel in its own doc, so on disk means its ledger
  // arrived too), keeps the 2.5 s floor, and refuses rather than land part of the room.
  function whenWholeRoomArrived() {
    const t0 = Date.now()
    const limit = Number(process.env.HIVE_PR_WAIT_MS) || 120000
    const tick = () => {
      let st = null
      try { st = hive.status() } catch { /* not ready yet */ }
      if (st && st.filesMissing === 0 && Date.now() - t0 >= 2500) return run()
      if (Date.now() - t0 > limit) {
        const have = st ? `${st.filesHeld} of ${st.roomFiles}` : 'an unknown number'
        console.error(`Q507 only ${have} of the room's files arrived in ${Math.round(limit / 1000)} s. Refusing to land part of the room: the missing files' work would be left out of the PR without anyone being told.`)
        return finish(1)
      }
      setTimeout(tick, 250)
    }
    tick()
  }

  function walk(root, base = '') {
    const out = []
    for (const e of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
      // Git's own and this client's bookkeeping (.hive.json, .hive-shadow.json, ...). Every other
      // dotfile is project content: this skipped ALL of them, so an agent's edit to .gitignore or
      // .github/workflows never reached the PR, and nothing said so. Only files with a verified
      // receipt are committed either way, so bookkeeping that slipped through would still be left out.
      if (e.name === '.git' || e.name.startsWith('.hive')) continue
      const rel = base ? `${base}/${e.name}` : e.name
      if (e.isDirectory()) out.push(...walk(root, rel))
      else out.push(rel)
    }
    return out
  }

  function run() {
    let rels = walk(dir)
    if (ONLY) rels = rels.filter((r) => ONLY.includes(r))
    const files = []
    for (const rel of rels) {
      const receipts = hive.provenanceOf(rel) || []
      const audit = hive.verifyProvenanceOf(rel) || { bad: [] }
      const badIdx = new Set((audit.bad || []).map((b) => b.i))
      let roomText = null
      try { roomText = fs.readFileSync(path.join(dir, rel), 'utf8') } catch { }
      const a = authorsOf(receipts, (r) => !badIdx.has(receipts.indexOf(r)), roomText)
      files.push({ rel, abs: path.join(dir, rel), ...a })
    }

    const attributed = files.filter((f) => f.last)
    const orphans = files.filter((f) => !f.last)
    const groups = planCommits(attributed)

    console.log(`room ${room}: ${files.length} files, ${attributed.length} attributed, ${groups.length} agent(s)`)
    for (const g of groups) {
      console.log(`  ${g.name}  ${g.files.length} file(s)${g.others.length ? `  (+${g.others.length} co-author)` : ''}`)
      for (const f of g.files) console.log(`      ${f.rel}`)
    }
    if (orphans.length) console.log(`  (${orphans.length} file(s) with no verified receipt -- not committed: ${orphans.map((o) => o.rel).join(', ')})`)

    if (DRY) { console.log('\n--dry-run: nothing written'); return finish(0) }
    if (!groups.length) { console.error('Q501 nothing attributed to commit'); return finish(1) }

    const base = flag('base') || git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'HEAD'

    // ── HIV-28: DO NOT WRITE OVER A BRANCH CHANGE WE CANNOT ACCOUNT FOR ──────────────────
    //
    // Measured 19 Sep 2026: this tool produced a PR with three clean per-agent commits, real git
    // authorship and signed trailers, which deleted the HIV-27 claim guard, the HIV-14 truncation
    // fix and ~200 lines of tests. It looked perfect. The cause was the copyFileSync below with
    // nothing in front of it.
    //
    // The check runs BEFORE `checkout -b`, so a refusal leaves no branch behind. Refusing after
    // creating it would hand the operator a half-made artefact to clean up, and the next thing a
    // person does with a branch that exists is push it.
    const decisions = []
    for (const g of groups) {
      for (const f of g.files) {
        // `git cat-file blob` and not `git show`: cat-file reads the object as stored, with no
        // smudge filter. With core.autocrlf on -- true in this repo -- `show` through a working
        // tree hands back bytes git never stored, and every content hash misses.
        const sha = git(['rev-parse', `${base}:${f.rel}`])
        const branchText = sha.code === 0 ? gitRaw(['cat-file', 'blob', sha.out]).out : null
        const roomText = fs.readFileSync(f.abs, 'utf8')
        decisions.push({ ...accountFor({ rel: f.rel, branchText, roomText, receipts: hive.provenanceOf(f.rel) || [] }), _f: f })
      }
    }
    const v = verdict(decisions)
    if (v.identical.length) console.log(`  (${v.identical.length} file(s) already identical on ${base} -- nothing to write)`)

    if (!v.ok) {
      const lastTouch = (rel) => git(['log', '-1', '--format=%h %an %ad %s', '--date=short', base, '--', rel]).out
      console.error('')
      console.error(explain(v.blocked, lastTouch))
      if (!FORCE) return finish(1)
      // A forced run is still reported in full, and the reason travels into the PR body. The
      // point is not to make forcing hard, it is to make it visible.
      console.error('')
      console.error(`--force given: "${FORCE}" -- overwriting ${v.blocked.length} file(s) anyway. This is recorded in the PR body.`)
    }

    const co = git(['checkout', '-b', BRANCH, base])
    if (co.code !== 0) { console.error(`Q502 could not create branch ${BRANCH}: ${co.err}`); return finish(1) }

    // IDENTICAL files are dropped rather than copied. Copying one rewrites its line endings when
    // the room and the blob differ in style -- which on this repo is most files -- producing a
    // diff of every line for a change nobody made.
    const skip = new Set(v.identical.map((d) => d.rel))
    let made = 0
    for (const g0 of groups) {
      // THE COMMIT MESSAGE MUST DESCRIBE WHAT WAS COMMITTED. Built from g0.files it said
      // "Builder: 2 files" and listed both while only one was written, because the other was
      // already identical on the branch. A message that names files a commit does not contain is
      // a small false success in the one artefact a reviewer trusts most -- and it is in `git log`
      // forever.
      const g = { ...g0, files: g0.files.filter((f) => !skip.has(f.rel)) }
      if (!g.files.length) { console.log(`  (nothing to write from ${g.name} — all already on ${base})`); continue }
      for (const f of g.files) {
        const dest = path.join(REPO, f.rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(f.abs, dest)
        git(['add', '--', f.rel])
      }
      const msg = commitMessage(g, room)
      const r = git(['commit', '-m', msg, '--author', `${g.name} <${mailOf(g.name)}>`])
      if (r.code !== 0) {
        // "nothing to commit" is not a failure: the room's copy can equal what is already
        // on the branch, and a no-op commit is the honest outcome.
        if (/nothing to commit/i.test(r.out + r.err)) { console.log(`  (no change from ${g.name})`); continue }
        console.error(`Q503 commit failed for ${g.name}: ${r.err || r.out}`); return finish(1)
      }
      made++
    }
    console.log(`\nbranch ${BRANCH}: ${made} commit(s)`)
    console.log(git(['log', '--format=  %h  %an  %s', `${base}..${BRANCH}`]).out)

    if (DO_PUSH) {
      const p = git(['push', '-u', 'origin', BRANCH])
      if (p.code !== 0) { console.error(`Q504 push failed: ${p.err}`); return finish(1) }
      console.log(`pushed ${BRANCH}`)
    }
    if (DO_PR) {
      // A forced overwrite is stated in the PR BODY, not only in the terminal of the person who
      // ran it. The reviewer is the one who needs to know that files were written over branch
      // content this room had never seen -- and a reviewer looking at three clean signed commits
      // has no other way to find that out. That is the whole shape of the 19 Sep incident.
      const forcedNote = (!v.ok && FORCE)
        ? ['',
           '> **Forced past a staleness refusal.** ' + v.blocked.length + ' file(s) were written',
           '> over branch content this room had never seen.',
           '>',
           '> Reason given: ' + JSON.stringify(FORCE),
           '>',
           '> ' + v.blocked.map((d) => d.rel).join(', ')]
        : []
      const body = [`Opened by Hivecode from room \`${room}\`.`, ...forcedNote, '', '| agent | files |', '|---|---|',
        ...groups.map((g) => `| ${g.name} | ${g.files.map((f) => '`' + f.rel + '`').join(', ')} |`),
        '', 'Each commit carries its agent as the git author and the signed author id as a `Hivecode-Author` trailer.'].join('\n')
      const r = spawnSync('gh', ['pr', 'create', '--title', TITLE, '--body', body, '--base', base, '--head', BRANCH],
        { cwd: REPO, encoding: 'utf8' })
      if (r.status !== 0) { console.error(`Q505 gh pr create failed: ${(r.stderr || '').trim()}`); return finish(1) }
      console.log((r.stdout || '').trim())
    }
    finish(0)
  }

  function finish(code) {
    setTimeout(() => {
      try { hive.stop() } catch { /* going away */ }
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
      process.exit(code)
    }, 400)
  }
}
