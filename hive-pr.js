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
import path from 'path'
import { spawnSync } from 'child_process'
import { startSync, parseLink } from './sync.js'

const argv = process.argv.slice(2)
const [LINK = '', NAME = 'hive-pr'] = argv.filter((a) => !a.startsWith('--'))
const flag = (k, d = '') => { const i = argv.indexOf('--' + k); return i === -1 ? d : (argv[i + 1] || '') }
const has = (k) => argv.includes('--' + k)

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

/** The authors of a file, newest-landed first, from VERIFIED receipts only.
 *  An unverifiable receipt is not evidence of authorship, so it is dropped rather than trusted. */
export function authorsOf(receipts, verify) {
  const ok = receipts.filter((r) => r && r.author && (!verify || verify(r)))
  if (!ok.length) return { last: null, contributors: [], first: 0 }
  const last = ok[ok.length - 1]
  const seen = new Map()
  for (const r of ok) if (!seen.has(r.author)) seen.set(r.author, { author: r.author, name: r.name || 'agent', at: r.at || 0 })
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
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  if (!LINK || !REPO) {
    console.error('usage: node hive-pr.js "<relay|room>" <YourName> --repo <path> [--branch b] [--dry-run] [--push] [--pr]')
    process.exit(2)
  }
  if (!fs.existsSync(path.join(REPO, '.git'))) die('Q500', `${REPO} is not a git repository`)

  const { relay, room } = parseLink(LINK)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)
  const BRANCH = flag('branch') || `hivecode/${room}-${stamp}`
  const TITLE = flag('title') || `Hivecode: work from room ${room}`

  // A scratch mirror of the room, so nothing here can disturb anyone's working folder.
  const dir = path.join(process.env.TEMP || '.', `hive-pr-${room}-${process.pid}`)
  fs.mkdirSync(dir, { recursive: true })

  // Provenance is what this whole tool reads. Without it the ledger is empty and every
  // commit would collapse to one anonymous blob -- which is exactly the thing we are here
  // to avoid, so turn it on for this client rather than failing later with an empty plan.
  process.env.HIVE_PROVENANCE = process.env.HIVE_PROVENANCE || 'on'

  const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: true, log: () => {} })

  let done = false
  hive.provider.on('sync', (s) => {
    if (!s || done) return
    done = true
    // The file sub-docs arrive after the room doc, so give the ledgers a moment to land.
    // Reading immediately yields files with no receipts and a plan with nothing in it.
    setTimeout(run, 2500)
  })
  setTimeout(() => die('Q470', `could not reach the relay at ${relay}`), 20000)

  function walk(root, base = '') {
    const out = []
    for (const e of fs.readdirSync(path.join(root, base), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
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
      const a = authorsOf(receipts, (r) => !badIdx.has(receipts.indexOf(r)))
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
    const co = git(['checkout', '-b', BRANCH, base])
    if (co.code !== 0) { console.error(`Q502 could not create branch ${BRANCH}: ${co.err}`); return finish(1) }

    let made = 0
    for (const g of groups) {
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
      const body = [`Opened by Hivecode from room \`${room}\`.`, '', '| agent | files |', '|---|---|',
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
