// hive-branch -- a Hivecode room bound to a git branch.
//
//   npx -y hivecode-mcp@latest branch <name> [--from <ref>] [--name <you>] [--relay <url>]
//   npx -y hivecode-mcp@latest branch <name> --join "<link>"         (a teammate, in their own clone)
//   npx -y hivecode-mcp@latest branch <name> --reseed                (the relay lost the room)
//   npx -y hivecode-mcp@latest pr <name> [--dry-run] [--push] [--pr] [--base <b>] [--force "<reason>"]
//
// Agents join it with hive_join { branch: "<name>" } from the repo (or { branch, repo }).
//
// WHY. Developers already know branches. "Everyone on fix-x, people and agents, in one live
// workspace" needs no new words, and the work arrives as an ordinary PR on fix-x, so a team does
// not adopt anything to receive it. Git stays the record; the room is where the work happens.
//
// THE FOUR RULES, each a way this hurts somebody when it is wrong:
//   1. THE ROOM ID IS RANDOM. A room named after its branch would put every repo's
//      `feature/login` into one room, and on an open relay anyone could guess it and read the code.
//   2. A ROOM FOLDER IS NEVER A GIT CHECKOUT. Each holds a `.git` FILE naming a git directory that
//      does not exist, so git refuses to run inside it: no checkout, pull, rebase, stash, reset or
//      clean run there can rewrite the room's files. Git in the developer's own repo never reaches
//      the room either, because nobody works in that checkout. A branch that moved underneath the
//      room is caught when the work lands (hive-pr's staleness check, then a compare-and-swap).
//   3. ONE FOLDER PER PARTICIPANT, ~/hivecode/<room>/<name>. Two participants in one folder cannot
//      be told apart, and claims and per-agent commits both depend on telling them apart.
//   4. NOBODY COMMITS INSIDE THE ROOM. Work leaves once, through `pr`, which builds the commits in a
//      temporary worktree so the developer's own checkout is never switched or written.
//
// Error codes Q560-Q574 are this module's: Q560-Q569 binding and seeding, Q570-Q574 landing.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import ignore from 'ignore'
import { startSync, parseLink, ALWAYS_IGNORE, SKIP } from './sync.js'
import { PUBLIC_DEFAULT_RELAY, currentRelayFor } from './hive-privacy.js'
import { findSecrets } from './hive-secrets.js'
import { validateMemberName, suggestMemberName } from './hive-mailbox.js'
import { isSafeRelPath } from './token.js'

const TEXT_MAX = 1_000_000 // sync.js MAX_BYTES: a larger file never crosses the relay

// For hive-land.js, the one landing path. Declared below; exported here so the landing reads the
// binding, the branch and the room with exactly the rules this module binds and seeds with.
export { projectRoot, validBranch, revParse, coded, safeSegment, isOwnFile, git as gitIn, waitFor }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const coded = (code, msg) => Object.assign(new Error(`${code} ${msg}`), { code })
const toLF = (s) => (typeof s === 'string' && s.indexOf('\r\n') !== -1 ? s.replace(/\r\n/g, '\n') : s)

// ---- where things live --------------------------------------------------------------------

// Read at call time, not import time, so a caller (or a test) that sets HIVE_HOME is honoured.
export const hiveHome = () => process.env.HIVE_HOME || path.join(os.homedir(), 'hivecode')
// The same folder rule as hive-mcp.js, so a branch room's folders sit beside every other room's.
function safeSegment(s) {
  const t = String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[.]+/, '_').slice(0, 64) || '_'
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t) ? '_' + t : t
}
export function roomFolder(link, name) {
  return path.join(hiveHome(), safeSegment(parseLink(link).room), safeSegment(name))
}

// ---- git ----------------------------------------------------------------------------------

// OUR SCRATCH WORKTREES RUN WITHOUT THE DEVELOPER'S GIT HOOKS. A post-checkout hook that exits 1
// made `pr` fail with Q563 although git had made the worktree (measured 25 Oct 2026, a vexp hook);
// others run npm install or rewrite files in what is a scratch folder about to be deleted. Only
// commands inside our own temporary worktrees: the developer's checkout and every push keep their
// hooks. A hooks path that is never created means "no hooks" on every platform git runs on.
export const NO_HOOKS_DIR = path.join(os.tmpdir(), 'hivecode-no-hooks-never-created')
export const noHooks = (args) => ['-c', `core.hooksPath=${NO_HOOKS_DIR}`, ...args]
/** The same for a child process that runs git itself. Appends to any GIT_CONFIG_* already set. */
export function noHooksEnv(env = process.env) {
  const n = Number(env.GIT_CONFIG_COUNT) > 0 ? Number(env.GIT_CONFIG_COUNT) : 0
  return { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${n}`]: NO_HOOKS_DIR }
}

function git(cwd, args, { input, raw = false, trim = true } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: raw ? undefined : 'utf8', maxBuffer: 1024 * 1024 * 1024, windowsHide: true })
  if (r.error) return { code: -1, out: raw ? Buffer.alloc(0) : '', err: r.error.message }
  let out = r.stdout == null ? (raw ? Buffer.alloc(0) : '') : r.stdout
  if (!raw && trim) out = out.replace(/\s+$/, '')
  return { code: r.status, out, err: String(r.stderr || '').trim() }
}
const revParse = (root, ref) => { const r = git(root, ['rev-parse', '--verify', '--quiet', ref]); return r.code === 0 ? r.out : '' }

/** The top of the git working tree containing `dir`, or null. A room folder answers null: git refuses there. */
export function repoRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null
  const r = git(dir, ['rev-parse', '--show-toplevel'])
  return r.code === 0 && r.out ? path.resolve(r.out) : null
}

// Links are resolved on both sides: git names a repository's top with them resolved, while the home
// directory comes as written, and on macOS the temp folders sit behind one (6 Oct 2026).
const sameDir = (a, b) => {
  const n = (p) => {
    let r = path.resolve(p)
    try { r = fs.realpathSync.native(r) } catch { /* a path that cannot be resolved is compared as written */ }
    return r.replace(/[\\/]+$/, '')
  }
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b)
}

/**
 * The repository a branch room is for. NOT THE HOME DIRECTORY: a folder that is not a repository of
 * its own sits inside an enclosing one if there is one, and a home directory kept under git is the
 * usual enclosing one -- so "the repo" silently becomes $HOME and its committed files would be
 * published to a room. Measured on the development machine, whose home directory is a git repo: a
 * test's "outside any repo" folder under the temp directory bound, branched and seeded the home repo.
 */
function projectRoot(cwd) {
  const root = repoRoot(cwd)
  if (!root) throw coded('Q560', `${cwd} is not inside a git repository. Run this in the repo whose branch the room is for.`)
  if (sameDir(root, os.homedir())) throw coded('Q560', `the git repository around ${cwd} is your home directory (${root}), which is not a project: ${cwd} is not a repository of its own. Run this in the project's own repository.`)
  return root
}

function validBranch(root, name) {
  // A leading '-' would be read as an option by every git command it is later passed to.
  const r = !name || name.startsWith('-') ? { code: 1 } : git(root, ['check-ref-format', '--branch', name])
  if (r.code !== 0) throw coded('Q561', `"${name}" is not a valid branch name.`)
  return r.out
}

// The binding lives in the repo's own git config (shared by all its worktrees, never committed,
// never pushed), under hivecode.<branch>.*: room = the join link, from = the branch a PR goes
// into, base = the commit the room was seeded from, seed = the developer's own room folder.
const KEY = (branch, k) => `hivecode.${branch}.${k}`
export function readBinding(root, branch) {
  const get = (k) => { const r = git(root, ['config', '--local', '--get', KEY(branch, k)]); return r.code === 0 ? r.out : '' }
  const link = get('room')
  return link ? { link, from: get('from'), base: get('base'), seed: get('seed'), files: get('files') } : null
}
function writeBinding(root, branch, b) {
  for (const [k, v] of Object.entries(b)) {
    if (!v) continue
    const r = git(root, ['config', '--local', KEY(branch, k), v])
    if (r.code !== 0) throw coded('Q569', `could not record the room in git config: ${r.err}`)
  }
}

/** Every regular file in `commit`, with its bytes. Symlinks and submodules are not files a room holds. */
export function treeFiles(root, commit) {
  const ls = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit], { trim: false })
  if (ls.code !== 0) throw coded('Q563', `could not read the files of ${commit}: ${ls.err}`)
  const entries = []
  for (const rec of ls.out.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, sha] = rec.slice(0, tab).split(' ')
    const rel = rec.slice(tab + 1)
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !isSafeRelPath(rel)) continue
    entries.push({ rel, mode, sha })
  }
  const blobs = readBlobs(root, [...new Set(entries.map((e) => e.sha))])
  return entries.filter((e) => blobs.has(e.sha)).map((e) => ({ ...e, buf: blobs.get(e.sha) }))
}

/** `git cat-file --batch`, parsed: sha -> Buffer, exactly the bytes git stored (no smudge, no CRLF). */
function readBlobs(root, shas) {
  const out = new Map()
  if (!shas.length) return out
  const r = git(root, ['cat-file', '--batch'], { input: shas.join('\n') + '\n', raw: true })
  if (r.code !== 0) throw coded('Q563', `could not read file contents from git: ${r.err}`)
  const buf = r.out
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf(10, i)
    if (nl < 0) break
    const [sha, type, size] = buf.subarray(i, nl).toString('utf8').split(' ')
    if (type === 'missing' || size === undefined) { i = nl + 1; continue }
    const n = Number(size)
    out.set(sha, buf.subarray(nl + 1, nl + 1 + n))
    i = nl + 1 + n + 1
  }
  return out
}

/**
 * Would a sync client publish this file? The same tests the sync applies -- text, at most 1 MB,
 * not always-ignored, not ignored by a .gitignore in the tree, not one of Hivecode's own files --
 * so the seed can say exactly what the room will hold, and a joiner can be given the rest from git.
 */
export function roomCarries(files) {
  const ig = ignore().add(ALWAYS_IGNORE)
  const rootIgnore = files.find((f) => f.rel === '.gitignore')
  if (rootIgnore) ig.add(rootIgnore.buf.toString('utf8'))
  const nested = files.filter((f) => f.rel.endsWith('/.gitignore'))
    .map((f) => ({ prefix: f.rel.slice(0, -'.gitignore'.length), ig: ignore().add(f.buf.toString('utf8')) }))
  const ignored = (rel) => {
    if (ig.ignores(rel)) return true
    for (const n of nested) {
      if (!rel.startsWith(n.prefix)) continue
      const sub = rel.slice(n.prefix.length)
      if (sub && n.ig.ignores(sub)) return true
    }
    return false
  }
  // A file holding a key is held at home by every client (sync.js heldForSecret), so a room that
  // promised to carry it would never finish seeding (measured 3 Oct 2026: Q565, "4 of 5 files",
  // nothing bound). It is not carried, and each participant gets it from git like a binary.
  const holdsKey = (f) => process.env.HIVE_SHARE_SECRETS !== '1' && findSecrets(f.buf.toString('utf8')).length > 0
  return (f) => f.buf.length <= TEXT_MAX && !f.buf.includes(0) && !SKIP.has(f.rel) && !ignored(f.rel) && !holdsKey(f)
}

// Hivecode's own bookkeeping (.hive.json, .hive-shadow.json, .hive-lock.json, ...). If a repo happens
// to track one, it is never written into a room folder: a foreign .hive-lock.json would make the
// folder look held by some other process, and a foreign shadow is somebody else's ancestry.
// By exact name: a project's own `.hiverc` is its business. All of these are already never carried
// (always-ignored, or rendered locally), so the seed and a fresh joiner agree on what the room holds.
const OWN_FILES = new Set(['.hive.json', '.hive-shadow.json', '.hive-shadow.json.tmp', '.hive-lock.json', '.hive-id.json', '.hive-mcp-session.json', '.hive-stop-hook.json'])
const isOwnFile = (rel) => OWN_FILES.has(path.posix.basename(rel))

function writeFiles(dir, files) {
  for (const f of files) {
    if (isOwnFile(f.rel)) continue
    const full = path.join(dir, ...f.rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, f.buf)
    if (f.mode === '100755' && process.platform !== 'win32') { try { fs.chmodSync(full, 0o755) } catch { /* best effort */ } }
  }
}

// ---- rule 2: a room folder is never a git checkout ------------------------------------------

// One line, because git reads a `.git` file's first line as the path to the repository. The path
// does not exist, so every git command run in the folder stops with "not a git repository" and the
// path it prints says why. An EMPTY `.git` directory would not do this: git skips an invalid one
// and walks on up to the nearest real repository (measured: `git stash -u` run inside the folder
// then stashed the room's files away through the parent repo, which deletes them).
export const NOT_A_CHECKOUT = 'gitdir: ./.hivecode-live-room-not-a-git-checkout\n'

export function markNotACheckout(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, '.git')
  let st = null
  try { st = fs.lstatSync(p) } catch { /* absent: ours to create */ }
  if (st) {
    if (st.isFile() && toLF(fs.readFileSync(p, 'utf8')) === NOT_A_CHECKOUT) return { ok: true }
    return { ok: false, why: `${dir} is a git checkout (it has its own .git). A branch room's folders never are: git run there could rewrite the room's files. Leave \`dir\` out and the folder is chosen for you.` }
  }
  fs.writeFileSync(p, NOT_A_CHECKOUT)
  return { ok: true }
}

/**
 * The files the room cannot carry (binary, over 1 MB, always-ignored), written into a joiner's
 * folder from the branch. ONLY those: a file the room does carry but that is missing here was
 * deleted in the room, and writing it back would publish the deletion's undo to everyone.
 */
export function fillFromGit({ root, commit, dir }) {
  const files = treeFiles(root, commit)
  const carries = roomCarries(files)
  const missing = files.filter((f) => !carries(f) && !SKIP.has(f.rel) && !isOwnFile(f.rel) && !fs.existsSync(path.join(dir, ...f.rel.split('/'))))
  writeFiles(dir, missing)
  return missing.length
}

/**
 * What hive_join needs for { branch }: the room link, and the commit to fill non-text files from.
 * Returns { ok:false, message } with the next step instead of throwing -- an agent acts on text.
 */
export function resolveForJoin({ branch, repo }) {
  let root
  try { root = projectRoot(repo) } catch (e) {
    return { ok: false, message: `${e.message} It has no branch room "${branch}". Pass repo: "<path to the repo>" -- or join with the room's link instead.` }
  }
  let name
  try { name = validBranch(root, branch) } catch (e) { return { ok: false, message: e.message } }
  const b = readBinding(root, name)
  if (!b) return { ok: false, message: `Q562 branch "${name}" has no Hivecode room in directory ${root}. If your repository is elsewhere, pass repo: "/path/to/repo" in hive_join. Otherwise create one with:\n  npx -y hivecode-mcp@latest branch ${name}\nor, if a teammate already made it, records it with:\n  npx -y hivecode-mcp@latest branch ${name} --join "<link>"` }
  // A teammate's clone usually has the branch only as origin/<name>; that is as good a source for
  // the files the room does not carry. With neither, those files are simply not filled.
  const commit = revParse(root, `refs/heads/${name}`) || revParse(root, `refs/remotes/origin/${name}`) || b.base
  return { ok: true, root, branch: name, link: b.link, commit }
}

// ---- seeding: the room starts as the branch ------------------------------------------------

async function waitFor(pred, ms, every = 200) {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try { v = pred() } catch { /* not ready */ }
    if (v) return true
    if (Date.now() - t0 > ms) return false
    await sleep(every)
  }
}

/**
 * Publish `commit` into the (empty) room from the developer's own room folder, and report success
 * only after a FRESH JOINER has received every file the room should hold, byte for byte. A seed
 * that is merely "sent" is the false success this refuses: agents would build on a partial tree.
 */
async function seedRoom({ root, branch, commit, link, you, log }) {
  const { relay, room } = parseLink(link)
  const files = treeFiles(root, commit)
  const carries = roomCarries(files)
  const expected = new Map(files.filter(carries).map((f) => [f.rel, toLF(f.buf.toString('utf8'))]))
  const dir = roomFolder(link, you)
  const mark = markNotACheckout(dir)
  if (!mark.ok) throw coded('Q564', mark.why)
  writeFiles(dir, files)
  fs.writeFileSync(path.join(dir, '.hive.json'), JSON.stringify({ relay, room }, null, 2))

  // PROVENANCE OFF FOR THE SEED. The seed is the branch exactly as it already is; a receipt for it
  // would name the developer as a co-author of every file an agent later changes. Agents' first
  // receipts still chain from it, because a receipt's `parent` is the hash of what it built on.
  const prov = process.env.HIVE_PROVENANCE
  process.env.HIVE_PROVENANCE = 'off'
  let seeder
  try { seeder = startSync({ relay, room, dir, name: you, kind: 'human', log: () => {} }) }
  finally { if (prov === undefined) delete process.env.HIVE_PROVENANCE; else process.env.HIVE_PROVENANCE = prov }

  const budget = 30000 + 40 * expected.size
  let verifier = null
  const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-seed-check-'))
  try {
    const up = await waitFor(() => seeder.connection().connected && [...expected].every(([r, t]) => seeder._fileText(r) === t), budget)
    if (!up) {
      const st = seeder.status()
      throw coded('Q565', `the seed did not finish publishing: the room holds ${st.roomFiles} of ${expected.size} files after ${Math.round(budget / 1000)} s. ${st.notSyncing ? `${st.notSyncing} file(s) were refused by the relay. ` : ''}Nothing was bound; run the same command again.`)
    }
    verifier = startSync({ relay, room, dir: vdir, name: `${you}-check`, kind: 'ai', passive: true, log: () => {} })
    const read = (r) => { try { return toLF(fs.readFileSync(path.join(vdir, ...r.split('/')), 'utf8')) } catch { return null } }
    const got = await waitFor(() => [...expected].every(([r, t]) => read(r) === t), budget, 300)
    if (!got) {
      const missing = [...expected.keys()].filter((r) => read(r) !== expected.get(r))
      throw coded('Q566', `a fresh joiner did not receive the whole branch: ${missing.length} of ${expected.size} files are missing or different (first: ${missing.slice(0, 5).join(', ')}). Nothing was bound; agents would have built on a partial tree.`)
    }
    const short = commit.slice(0, 7)
    // Who holds this room's repo, for display only: an agent on another machine asked to open a PR
    // is told whom to ask. Never a path; what lands is decided on the landing machine alone.
    try { const R = await import('./hive-repos.js'); R.writeRepoHolder(seeder.doc, { branch, holder: you, host: os.hostname() }) } catch { /* display only */ }
    // THE COMMIT THE ROOM STARTS FROM, for a teammate's `--join`: without it their clone cannot tell
    // a file the room deleted from one added to the branch later, and landing from there skipped the
    // room's deletions -- and the Q572 guard -- without a word (antigravity, 5 Nov 2026).
    try { seeder.doc.getMap('seed').set('commit', commit); seeder.doc.getMap('seed').set('branch', branch) } catch { /* older relay docs */ }
    seeder.say(`Room for git branch \`${branch}\` @ ${short}, seeded by ${you} with ${expected.size} file(s). Work here lands on \`${branch}\` as one commit per agent via \`npx -y hivecode-mcp@latest pr ${branch}\`. Room folders are not git checkouts on purpose: edit files, do not commit.`)
    await sleep(600) // let the announcement leave before the socket closes
    return { dir, count: expected.size, total: files.length }
  } finally {
    try { verifier && verifier.stop() } catch { /* going away */ }
    try { seeder.stop() } catch { /* going away */ }
    try { fs.rmSync(vdir, { recursive: true, force: true }) } catch { /* temp */ }
  }
}

/** The paths the room lists right now, from a passive look that syncs no files (null if unreachable). */
async function roomPaths(link, you) {
  const { relay, room } = parseLink(link)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-peek-'))
  const peek = startSync({ relay, room, dir, name: `${you}-peek`, kind: 'ai', passive: true, syncFiles: false, log: () => {} })
  try {
    let synced = false
    peek.provider.on('sync', (s) => { if (s) synced = true })
    if (!(await waitFor(() => synced, 15000))) return null
    await sleep(300)
    return new Set(peek.doc.getMap('manifest').keys())
  } finally {
    try { peek.stop() } catch { }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
  }
}
const roomFileCount = async (link, you) => { const p = await roomPaths(link, you); return p ? p.size : null }

/** The commit the room was seeded from, as its seeder recorded it ({ commit, branch }), or null. */
async function roomSeed(link, you) {
  const { relay, room } = parseLink(link)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-peek-'))
  const peek = startSync({ relay, room, dir, name: `${you}-peek`, kind: 'ai', passive: true, syncFiles: false, log: () => {} })
  try {
    let synced = false
    peek.provider.on('sync', (s) => { if (s) synced = true })
    if (!(await waitFor(() => synced, 15000))) return null
    await sleep(300)
    const m = peek.doc.getMap('seed')
    const commit = m.get('commit')
    return typeof commit === 'string' && /^[0-9a-f]{40}$/i.test(commit) ? { commit, branch: String(m.get('branch') || '') } : null
  } finally {
    try { peek.stop() } catch { }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
  }
}

// A NEW BRANCH IS CUT FROM WHAT THE TEAM HAS, NOT FROM A STALE COPY OF IT (P1-7, 9 Nov 2026).
// `branch fix-x` cuts from HEAD, and HEAD is usually a local main that was last pulled days ago: the
// room was then seeded with old files, agents worked on them, and landing met the newer main as a
// conflict (or a Q506) nobody had caused. So when the source is a LOCAL branch, its remote copy is
// fetched first, and:
//   - local strictly BEHIND remote: cut from the remote. Nothing is lost (the remote holds every
//     local commit) and the note says so, with the count.
//   - local AHEAD of remote: cut from local. Those commits are the developer's own work.
//   - DIVERGED: cut from local, and the note says how far behind and how to choose the remote.
//   - the fetch failed (offline, no access): cut from local, and the note says it could not check.
// A sha or a remote ref (`origin/main`) is taken exactly as given: whoever names one chose it, and
// the GitHub watcher fetches before it passes one. HIVE_BRANCH_FETCH=0 skips the fetch and compares
// against the remote ref as last fetched.
function fetchBranch(root, remote, rb) {
  if (process.env.HIVE_BRANCH_FETCH === '0') return { ok: false, skipped: true, err: 'HIVE_BRANCH_FETCH=0' }
  const r = spawnSync('git', ['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${rb}:refs/remotes/${remote}/${rb}`], {
    cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (r.error) return { ok: false, err: r.error.code === 'ETIMEDOUT' ? 'timed out after 30 s' : r.error.message }
  if (r.status === 0) return { ok: true }
  const err = String(r.stderr || '').trim()
  // The remote has no such branch (a main never pushed): nothing to be behind, nothing to say.
  if (/couldn't find remote ref|could not find remote ref/i.test(err)) return { ok: false, absent: true, err }
  return { ok: false, err: err.split('\n').pop() || `exit ${r.status}` }
}

/** Where a new branch is cut from: { sha, src, note }. See the comment above. */
export function freshCutPoint(root, from = '') {
  const src = from || 'HEAD'
  const sha = revParse(root, `${src}^{commit}`)
  if (!sha) return { sha: '', src, note: '' }
  let local = ''
  if (src === 'HEAD') { const c = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']); local = c.code === 0 ? c.out : '' }
  else if (!/^[0-9a-f]{7,40}$/i.test(src) && revParse(root, `refs/heads/${src}`)) local = src
  if (!local) return { sha, src, note: '' } // detached HEAD, a sha, a tag or a remote ref: exactly as given
  // Its remote copy: the configured upstream, else the same name on origin.
  let remote = '', rb = ''
  const up = git(root, ['for-each-ref', '--format=%(upstream:remotename)%09%(upstream:short)', `refs/heads/${local}`])
  const [upRemote, upShort] = (up.code === 0 ? up.out : '').split('\t')
  if (upRemote && upShort && upShort.startsWith(`${upRemote}/`)) { remote = upRemote; rb = upShort.slice(upRemote.length + 1) }
  else if (git(root, ['remote']).out.split('\n').includes('origin')) { remote = 'origin'; rb = local }
  if (!remote) return { sha, src, note: '' } // a repository with no remote: local is all there is
  const rref = `${remote}/${rb}`
  const f = fetchBranch(root, remote, rb)
  const rsha = revParse(root, `refs/remotes/${rref}^{commit}`)
  if (!rsha) {
    return { sha, src, note: f.ok || f.skipped || f.absent ? '' : `could not fetch ${rref} (${f.err}), so ${local} was not checked against it.` }
  }
  const unchecked = f.ok || f.skipped ? '' : ` (could not fetch it just now: ${f.err}; this is ${rref} as last fetched)`
  if (rsha === sha) return { sha, src, note: unchecked ? `${local} matches ${rref}${unchecked}.` : '' }
  const isAnc = (a, b) => git(root, ['merge-base', '--is-ancestor', a, b]).code === 0
  const count = (range) => Number(git(root, ['rev-list', '--count', range]).out) || 0
  if (isAnc(sha, rsha)) {
    const n = count(`${sha}..${rsha}`)
    return { sha: rsha, src: rref, behind: n, note: `your ${local} was ${n} commit(s) behind ${rref}${unchecked}, so the branch was cut from ${rref} (${rsha.slice(0, 7)}) instead. Nothing of yours is left out: ${rref} has every commit your ${local} has.` }
  }
  if (isAnc(rsha, sha)) return { sha, src, ahead: count(`${rsha}..${sha}`), note: unchecked ? `cut from your ${local}${unchecked}.` : '' }
  const behind = count(`${sha}..${rsha}`), ahead = count(`${rsha}..${sha}`)
  return { sha, src, behind, ahead, note: `your ${local} and ${rref} have diverged (${behind} behind, ${ahead} ahead)${unchecked}. The branch was cut from your ${local}; to cut from ${rref} instead, delete the branch and the room binding and run again with --from ${rref}.` }
}

/** The branch a PR from `name` goes into: the checkout's current branch, else origin's default. */
function defaultBase(root, name) {
  const cur = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (cur.code === 0 && cur.out && cur.out !== name) return cur.out
  const o = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const d = o.code === 0 && o.out ? o.out.replace(/^origin\//, '') : ''
  return d !== name ? d : ''
}

/**
 * Delete a room folder ONLY if it is one this tool made: under HIVE_HOME, carrying our `.git`
 * line, and naming this room in its .hive.json. The path comes from git config, and config is
 * editable text -- a path that fails any of these is refused, never removed.
 */
export function removeRoomFolder(dir, room) {
  const abs = path.resolve(dir)
  const home = path.resolve(hiveHome()) + path.sep
  let ours = false
  try {
    ours = abs.startsWith(home) &&
      toLF(fs.readFileSync(path.join(abs, '.git'), 'utf8')) === NOT_A_CHECKOUT &&
      JSON.parse(fs.readFileSync(path.join(abs, '.hive.json'), 'utf8')).room === room
  } catch { ours = false }
  if (!fs.existsSync(abs)) return
  if (!ours) throw coded('Q568', `refusing to delete ${abs}: it is not a room folder this tool made for ${room}. Move it aside yourself, then run --reseed again.`)
  fs.rmSync(abs, { recursive: true, force: true })
}

const projectRootOrNull = (cwd) => { try { return projectRoot(cwd) } catch { return null } }

// THIS MACHINE'S RECORD OF WHICH REPO HOLDS WHICH ROOM (hive-repos.js), so an agent that joined by
// link -- not by branch -- can still land from here with hive_pr. Imported late: hive-repos imports
// this module. Best effort: a registry that cannot be written never fails a bind, and hive_pr then
// says exactly that the room is not bound on this machine (Q583), with the command that fixes it.
async function registerLocal(root, branch, link) {
  try { const R = await import('./hive-repos.js'); return !!R.registerRepo({ root, branch, link }) } catch { return false }
}
function youFrom(root, given) {
  const raw = given || git(root, ['config', 'user.name']).out || os.userInfo().username || 'dev'
  return validateMemberName(raw).ok ? raw : suggestMemberName(raw)
}

/**
 * `branch <name>`: bind a room to a branch, creating and seeding both on first use.
 * The developer's checkout is never switched or written: the branch is made with `git branch`,
 * and the seed is read out of git objects, not out of the working tree.
 */
export async function bindBranch({ cwd, branch, from = '', relay = '', you = '', join = '', reseed = false, log = () => {} }) {
  const root = projectRoot(cwd)
  const name = validBranch(root, branch)
  const me = youFrom(root, you)
  const existing = readBinding(root, name)

  if (join) {
    const { relay: jr, room } = parseLink(join)
    if (!jr || !room) throw coded('Q567', `"${join}" is not a room link (it looks like wss://relay|room-...).`)
    if (existing && existing.link !== join) throw coded('Q567', `branch "${name}" is already bound to a different room here (${existing.link}). Remove it with: git config --remove-section "hivecode.${name}"`)
    const seed = await roomSeed(join, me)
    writeBinding(root, name, { room: join, base: seed && seed.commit ? seed.commit : '' })
    await registerLocal(root, name, join)
    return { root, branch: name, link: join, you: me, joined: true, base: seed && seed.commit ? seed.commit : '' }
  }

  if (existing && !reseed) {
    const n = await roomFileCount(existing.link, me)
    // Empty is only news when the seed was not: a branch with nothing a room can carry seeds nothing.
    const lost = n === 0 && Number(existing.files || 1) > 0
    await registerLocal(root, name, existing.link) // a binding made before the registry existed gets its entry
    return { root, branch: name, link: existing.link, you: me, from: existing.from, existing: true, roomFiles: n, lost }
  }

  const relayUrl = currentRelayFor(relay || process.env.HIVE_RELAY || PUBLIC_DEFAULT_RELAY).relay
  let created = false
  let tip = revParse(root, `refs/heads/${name}`)
  // The PR's base is a BRANCH NAME for `gh`: a sha names no branch, and origin/main means main.
  let fromName = from && !/^[0-9a-f]{7,40}$/i.test(from) ? from.replace(/^origin\//, '') : ''
  let cutNote = ''
  if (!tip) {
    const src = from || 'HEAD'
    const cut = freshCutPoint(root, from)
    const sha = cut.sha
    cutNote = cut.note || ''
    if (cutNote) log(cutNote)
    if (!sha) {
      if (src === 'HEAD' && !revParse(root, 'HEAD')) {
        throw coded('Q562', `repository "${root}" has no commits yet, so there's nothing to put in a room. Commit your files first, then run this again.`)
      }
      throw coded('Q562', `"${src}" is not a commit in ${root}.`)
    }
    const r = git(root, ['branch', '--no-track', name, sha]) // `branch`, never `checkout -b`: the checkout stays where it is
    if (r.code !== 0) throw coded('Q562', `could not create branch ${name}: ${r.err}`)
    tip = sha
    created = true
  }
  if (!fromName) fromName = defaultBase(root, name)

  let link = existing && existing.link
  if (reseed) {
    if (!existing) throw coded('Q562', `branch "${name}" has no room to reseed; run without --reseed to create one.`)
    const n = await roomFileCount(existing.link, me)
    if (n === null) throw coded('Q565', `could not reach the relay behind ${existing.link}.`)
    if (n > 0) throw coded('Q568', `the room still holds ${n} file(s). --reseed only refills an EMPTY room (after the relay lost it); reseeding a live room would put the branch's old content over the agents' work.`)
    // A fresh seed folder: the old one's record of what it last wrote belongs to the lost room.
    removeRoomFolder(existing.seed || roomFolder(existing.link, me), parseLink(existing.link).room)
    if (existing.seed && path.resolve(existing.seed) !== path.resolve(roomFolder(existing.link, me))) removeRoomFolder(roomFolder(existing.link, me), parseLink(existing.link).room)
  } else {
    link = `${relayUrl}|room-${crypto.randomBytes(13).toString('base64url')}`
  }

  let seeded
  try {
    seeded = await seedRoom({ root, branch: name, commit: tip, link, you: me, log })
  } catch (e) {
    // A refused bind leaves nothing behind: not a binding, not a branch nobody asked to keep, and
    // not a half-seeded folder for the next attempt (which gets a new room) to trip over.
    if (created && revParse(root, `refs/heads/${name}`) === tip) git(root, ['branch', '-D', name])
    try { removeRoomFolder(roomFolder(link, me), parseLink(link).room) } catch { /* not ours to remove */ }
    throw e
  }
  writeBinding(root, name, { room: link, from: fromName, base: tip, seed: seeded.dir, files: String(seeded.count) })
  await registerLocal(root, name, link)
  return { root, branch: name, link, you: me, from: fromName, commit: tip, created, cutNote, reseeded: reseed, files: seeded.count, total: seeded.total, seedDir: seeded.dir }
}

// ---- landing: the room's work becomes commits on the branch ---------------------------------

/**
 * `pr <name>` used to land here. Landing now has ONE path, hive-land.js landAndOpen, shared by the
 * `pr` command, the hive_pr tool and the GitHub watcher: every check (claims, an empty room, workflow
 * files, keys, tests, origin ahead, the lock) protects all three. Two copies of the landing had
 * already drifted once (the deletion accounting lived only here).
 *
 * landBranch keeps its old contract for the watcher, which still runs its own workflow, key and test
 * checks after landing, and whose agent has exited by the time it lands (so its claims are moot):
 * { ok:true, landed, tip, deletions } | { ok:false, code } with the reason on logErr.
 */
export async function landBranch({ cwd, branch, dry = false, push = false, pr = false, base = '', force = '', only = '', title = '', log = console.log, logErr = console.error }) {
  const { landAndOpen } = await import('./hive-land.js')
  const r = await landAndOpen({ cwd, branch, dry: !!dry, push, pr, base, force, only, title, log, logErr, claims: false, checks: false, by: 'the Hivecode GitHub watcher' })
  if (!r.ok) { logErr(r.why); return { ok: false, code: 1, refused: r.code } }
  return r.dry ? { ok: true, dry: true, deletions: r.deletions } : { ok: true, landed: r.landed, tip: r.tip, deletions: r.deletions }
}

// ---- CLI ----------------------------------------------------------------------------------

function flags(argv) {
  const pos = []
  const f = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const k = a.slice(2)
    if (['dry-run', 'push', 'pr', 'reseed', 'allow-workflow-changes', 'allow-mass-delete', 'save'].includes(k)) f[k] = true
    else f[k] = argv[++i] || ''
  }
  return { pos, f }
}

const USAGE = `usage:
  npx -y hivecode-mcp@latest branch <name> [--from <ref>] [--name <you>] [--relay <url>]
  npx -y hivecode-mcp@latest branch <name> --join "<link>"
  npx -y hivecode-mcp@latest branch <name> --reseed
  npx -y hivecode-mcp@latest pr <name> [--dry-run] [--push] [--pr] [--base <branch>] [--test "<command>" [--test-copy <file,...>] [--test-setup "<cmd>"] [--save]] [--test-minutes <n>]
                                       [--allow-workflow-changes] [--allow-mass-delete] [--title "<t>"] [--force "<reason>"]`

/** `argv` starts at the subcommand: ['branch', 'fix-x', ...] or ['pr', 'fix-x', ...]. Returns an exit code. */
export async function main(argv, { cwd = process.cwd(), log = console.log, logErr = console.error } = {}) {
  const [cmd, ...rest] = argv
  const { pos, f } = flags(rest)
  const name = pos[0]
  if (!name || (cmd !== 'branch' && cmd !== 'pr')) { logErr(USAGE); return 2 }
  try {
    if (cmd === 'pr') {
      const { landAndOpen, testCommandFor, saveTestCommand } = await import('./hive-land.js')
      let test = f.test || ''
      // --test-copy a,b  and  --test-setup "<cmd>": what the tests need beyond git (see hive-land.js).
      const testCopy = 'test-copy' in f ? String(f['test-copy'] || '').split(',').map((s) => s.trim()).filter(Boolean) : undefined
      const testSetup = 'test-setup' in f ? String(f['test-setup'] || '') : undefined
      if (f.save) {
        if (!test) { logErr(`--save keeps a test command: pass it with --test "<command>"`); return 2 }
        saveTestCommand(cwd, name, test, { copy: testCopy ?? null, setup: testSetup ?? null })
        log(`saved: landing ${name} now runs ${testSetup ? `\`${testSetup}\`, then ` : ''}\`${test}\` first${testCopy && testCopy.length ? `, with ${testCopy.join(', ')} copied in` : ''}, from any caller (pr, hive_pr, room mode). Change it the same way.`)
      }
      // No --test: the command saved for this branch, if any. (The project's own `npm test` is the
      // hive_pr tool's fallback; here the developer is present, so nothing runs they did not choose.)
      if (!test) { const t = testCommandFor(cwd, name); if (t.from === 'saved') { test = t.command; log(`tests: \`${test}\` (saved for ${name})`) } }
      const r = await landAndOpen({
        cwd, branch: name, dry: !!f['dry-run'], push: !!(f.push || f.pr), pr: !!f.pr, base: f.base || '', force: f.force || '', only: f.only || '', title: f.title || '',
        test, testMinutes: Number(f['test-minutes']) || 0, testCopy, testSetup, allowWorkflowChanges: !!f['allow-workflow-changes'], allowMassDelete: !!f['allow-mass-delete'],
        by: youFrom(projectRootOrNull(cwd) || cwd, ''), log, logErr,
      })
      if (!r.ok) { logErr(r.why); return 1 }
      return 0
    }
    const r = await bindBranch({ cwd, branch: name, from: f.from || '', relay: f.relay || '', you: f.name || '', join: f.join || '', reseed: !!f.reseed })
    const agentLine = `Use hive_join with branch "${r.branch}", repo "${r.root.replace(/\\/g, '/')}", as a name of your own (each agent picks a different one)`
    if (r.joined) {
      log(`Recorded: branch ${r.branch} in ${r.root} is the room ${r.link}\n\nTell each of your agents:\n  ${agentLine}`)
      return 0
    }
    if (r.existing) {
      log(`Branch ${r.branch} already has a room: ${r.link}${r.roomFiles == null ? '\n(the relay did not answer just now)' : `  (${r.roomFiles} file(s) in it)`}`)
      if (r.lost) log(`\nTHE ROOM IS EMPTY: the relay lost it (a restart or a deploy wipes rooms on some hosts).\nAgents that still have their folders get their work back by joining again:\n  ${agentLine}\nIf no agent has a folder any more, refill it from the branch:\n  npx -y hivecode-mcp@latest branch ${r.branch} --reseed`)
    } else {
      const dirty = git(r.root, ['status', '--porcelain'])
      const dirtyLines = dirty.out ? dirty.out.split('\n').filter(Boolean) : []
      const dirtyFiles = dirtyLines.map((l) => {
        const p = l.slice(3).trim()
        return p.includes(' -> ') ? p.split(' -> ')[1].trim() : p
      }).filter(Boolean)
      const shown = dirtyFiles.slice(0, 5).join(', ')
      const more = dirtyFiles.length > 5 ? ` (+${dirtyFiles.length - 5} more)` : ''
      const uncommittedPart = dirtyFiles.length ? `\n  ${dirtyFiles.length} file(s) with uncommitted changes are not in the room: ${shown}${more}` : ''
      if (r.cutNote) log(`Note: ${r.cutNote}`)
      log(`${r.reseeded ? 'Room refilled' : 'Room ready'} for branch ${r.branch} @ ${r.commit.slice(0, 7)}${r.created ? ` (new branch, cut from ${r.from || 'HEAD'}; your checkout was not switched)` : ''}\n  ${r.files} file(s) in the room: the branch as committed${uncommittedPart}${r.total > r.files ? `\n  ${r.total - r.files} more (binary, over 1 MB, or never synced) are filled in from git for agents on this machine` : ''}\n  room: ${r.link}`)
      if (/onrender\.com/.test(r.link)) log('  This is the public relay: anyone who has this link can read these files.')
      const roomName = parseLink(r.link).room
      log(`  Your agents work in their own folders under ~/hivecode/${roomName}/, kept in sync live.\n  Your checkout here doesn't change until you run pr.`)
    }
    log(`\nTell each of your agents:\n  ${agentLine}\n\nA teammate, in their own clone of this repo:\n  npx -y hivecode-mcp@latest branch ${r.branch} --join "${r.link}"\n\nWhen the work is done, land it on ${r.branch} (one commit per agent):\n  npx -y hivecode-mcp@latest pr ${r.branch}          add --pr to push it and open the pull request`)
    return 0
  } catch (e) {
    logErr(e && e.message ? e.message : String(e))
    return 1
  }
}
