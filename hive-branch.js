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
import { fileURLToPath } from 'url'
import ignore from 'ignore'
import { startSync, parseLink, ALWAYS_IGNORE, SKIP } from './sync.js'
import { PUBLIC_DEFAULT_RELAY, currentRelayFor } from './hive-privacy.js'
import { findSecrets } from './hive-secrets.js'
import { validateMemberName, suggestMemberName } from './hive-mailbox.js'
import { isSafeRelPath } from './token.js'

const TEXT_MAX = 1_000_000 // sync.js MAX_BYTES: a larger file never crosses the relay
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const coded = (code, msg) => Object.assign(new Error(`${code} ${msg}`), { code })

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
    if (st.isFile() && fs.readFileSync(p, 'utf8') === NOT_A_CHECKOUT) return { ok: true }
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
  const expected = new Map(files.filter(carries).map((f) => [f.rel, f.buf.toString('utf8')]))
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
    const read = (r) => { try { return fs.readFileSync(path.join(vdir, ...r.split('/')), 'utf8') } catch { return null } }
    const got = await waitFor(() => [...expected].every(([r, t]) => read(r) === t), budget, 300)
    if (!got) {
      const missing = [...expected.keys()].filter((r) => read(r) !== expected.get(r))
      throw coded('Q566', `a fresh joiner did not receive the whole branch: ${missing.length} of ${expected.size} files are missing or different (first: ${missing.slice(0, 5).join(', ')}). Nothing was bound; agents would have built on a partial tree.`)
    }
    const short = commit.slice(0, 7)
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
      fs.readFileSync(path.join(abs, '.git'), 'utf8') === NOT_A_CHECKOUT &&
      JSON.parse(fs.readFileSync(path.join(abs, '.hive.json'), 'utf8')).room === room
  } catch { ours = false }
  if (!fs.existsSync(abs)) return
  if (!ours) throw coded('Q568', `refusing to delete ${abs}: it is not a room folder this tool made for ${room}. Move it aside yourself, then run --reseed again.`)
  fs.rmSync(abs, { recursive: true, force: true })
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
    writeBinding(root, name, { room: join })
    return { root, branch: name, link: join, you: me, joined: true }
  }

  if (existing && !reseed) {
    const n = await roomFileCount(existing.link, me)
    // Empty is only news when the seed was not: a branch with nothing a room can carry seeds nothing.
    const lost = n === 0 && Number(existing.files || 1) > 0
    return { root, branch: name, link: existing.link, you: me, from: existing.from, existing: true, roomFiles: n, lost }
  }

  const relayUrl = currentRelayFor(relay || process.env.HIVE_RELAY || PUBLIC_DEFAULT_RELAY).relay
  let created = false
  let tip = revParse(root, `refs/heads/${name}`)
  // The PR's base is a BRANCH NAME for `gh`: a sha names no branch, and origin/main means main.
  let fromName = from && !/^[0-9a-f]{7,40}$/i.test(from) ? from.replace(/^origin\//, '') : ''
  if (!tip) {
    const src = from || 'HEAD'
    const sha = revParse(root, `${src}^{commit}`)
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
  return { root, branch: name, link, you: me, from: fromName, commit: tip, created, reseeded: reseed, files: seeded.count, total: seeded.total, seedDir: seeded.dir }
}

// ---- landing: the room's work becomes commits on the branch ---------------------------------

const HIVE_PR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hive-pr.js')
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * THE ROOM'S DELETIONS, which hive-pr does not land: it copies the files a room holds, so a file an
 * agent deleted would simply stay on the branch, in a PR that looks complete. A room bound to a
 * branch starts as the whole branch, so "on the branch but no longer in the room" is a deletion --
 * but only when the room provably held THAT version of the file. For each such path:
 *   - last changed on the branch by a landing from this room (its commit says "Room: <id>") -> delete
 *   - unchanged since the seed commit                                                  -> delete
 *   - in the seed, but changed on the branch since by someone else                     -> REFUSE (Q572):
 *     deleting it would erase a change the room never saw
 *   - not in the seed and not landed from this room: added to the branch outside the room -> keep
 */
async function roomDeletions({ root, link, base, tip }) {
  if (!base) return []
  const paths = await roomPaths(link, 'hive-land')
  if (!paths) throw coded('Q565', `could not reach the relay to read the room's file list, so its deletions cannot be accounted for. Nothing was changed.`)
  const room = parseLink(link).room
  const atTip = treeFiles(root, tip)
  const carries = roomCarries(atTip)
  const baseSha = new Map(treeFiles(root, base).map((f) => [f.rel, f.sha]))
  const gone = [], diverged = []
  for (const f of atTip) {
    if (!carries(f) || paths.has(f.rel)) continue
    const last = git(root, ['log', '-1', '--format=%B', tip, '--', f.rel]).out
    if (new RegExp(`^Room: ${reEsc(room)}$`, 'm').test(last)) gone.push(f.rel)
    else if (baseSha.get(f.rel) === f.sha) gone.push(f.rel)
    else if (baseSha.has(f.rel)) diverged.push(f.rel)
  }
  if (diverged.length) {
    const who = (rel) => git(root, ['log', '-1', '--format=%h %an %ad %s', '--date=short', tip, '--', rel]).out
    throw coded('Q572', `the room deleted ${diverged.length} file(s) that were changed on the branch since it was seeded, by a change the room never saw:\n${diverged.map((r) => `  ${r}   last changed by: ${who(r)}`).join('\n')}\nDeleting them would erase that change. Nothing was changed. Restore the file in the room (or delete it on the branch yourself), then run pr again.`)
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

/**
 * `pr <name>`: land the room's work on the bound branch as one commit per agent.
 *
 * hive-pr writes the commits (attribution and the staleness check are all its own), but it runs in
 * a TEMPORARY WORKTREE detached at the branch tip, because hive-pr switches the checkout it is given
 * and the developer's must never be switched. The branch then moves by compare-and-swap from the tip
 * the worktree was cut from, so a commit that reached the branch meanwhile is refused, never lost.
 */
export async function landBranch({ cwd, branch, dry = false, push = false, pr = false, base = '', force = '', only = '', title = '', log = console.log, logErr = console.error }) {
  const root = projectRoot(cwd)
  const name = validBranch(root, branch)
  const b = readBinding(root, name)
  if (!b) throw coded('Q562', `branch "${name}" has no Hivecode room here. Create one with: npx -y hivecode-mcp@latest branch ${name}`)
  const tip = revParse(root, `refs/heads/${name}`)
  if (!tip) throw coded('Q563', `branch "${name}" does not exist in ${root}. Fetch it first: git fetch origin ${name}:${name}`)

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-land-'))
  const temp = `hivecode-land/${safeSegment(name)}-${process.pid}-${Date.now()}`
  const cleanup = () => {
    git(root, ['worktree', 'remove', '--force', tmp])
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
    git(root, ['worktree', 'prune'])
    if (revParse(root, `refs/heads/${temp}`)) git(root, ['branch', '-D', temp])
  }
  const wt = git(root, noHooks(['worktree', 'add', '--detach', tmp, tip]))
  if (wt.code !== 0) { cleanup(); throw coded('Q563', `could not make a temporary worktree: ${wt.err}`) }

  try {
    // Accounted for BEFORE anything is written, so a refusal (Q572) leaves the branch as it was.
    const deletions = await roomDeletions({ root, link: b.link, base: b.base, tip })

    const args = [HIVE_PR, b.link, 'hive-pr', '--repo', tmp, '--branch', temp, '--base', 'HEAD']
    if (dry) args.push('--dry-run')
    if (force) args.push('--force', force)
    if (only) args.push('--only', only)
    const r = spawnSync(process.execPath, args, { cwd: tmp, encoding: 'utf8', env: noHooksEnv({ ...process.env, HIVE_PROVENANCE: 'on' }), maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    if (r.stdout) log(r.stdout.replace(/\s+$/, ''))
    // Q501 is hive-pr saying no file in the room carries an agent's receipt: nothing was changed or
    // added. For a branch room that is an answer, not a failure -- and deletions may still land.
    const nothingChanged = r.status !== 0 && /^Q501 /m.test(r.stderr || '')
    if (r.stderr && !nothingChanged) logErr(r.stderr.replace(/\s+$/, ''))
    if (r.status !== 0 && !nothingChanged) return { ok: false, code: r.status || 1 }
    if (dry) {
      if (deletions.length) log(`would delete ${deletions.length} file(s) the room deleted: ${deletions.join(', ')}`)
      return { ok: true, dry: true, deletions }
    }

    if (deletions.length) {
      // hive-pr left the temporary worktree on its branch when it committed; when it had nothing to
      // commit it never made one, so make it here, at the same tip.
      if (!revParse(root, `refs/heads/${temp}`)) git(tmp, noHooks(['checkout', '-q', '-b', temp]))
      const rm = git(tmp, ['rm', '-q', '--', ...deletions])
      if (rm.code !== 0) throw coded('Q563', `could not stage the room's deletions: ${rm.err}`)
      const msg = [`Room: delete ${deletions.length === 1 ? deletions[0] : `${deletions.length} files`}`, '', ...deletions.map((d) => `  - ${d}`), '', `Room: ${parseLink(b.link).room}`].join('\n')
      const c = git(tmp, noHooks(['commit', '-q', '-m', msg, '--author', 'hivecode-room <room@agents.hivecode.local>']))
      if (c.code !== 0) throw coded('Q563', `could not commit the room's deletions: ${c.err || c.out}`)
    }
    if (nothingChanged && !deletions.length) { log(`nothing to land yet: no agent has changed a file in the room for ${name}.`); return { ok: true, landed: 0 } }

    const newTip = revParse(root, `refs/heads/${temp}`)
    if (!newTip || newTip === tip) { log(`nothing to land: ${name} already has everything the room holds.`); return { ok: true, landed: 0 } }

    // Move the branch. Checked out somewhere: only a clean fast-forward of that checkout, which is
    // what `git pull` would do; with local changes it is refused, because moving the branch under a
    // dirty checkout makes its edits look like reversals of the landed work.
    const on = worktreesOn(root, name).filter((p) => p !== path.resolve(tmp))
    if (on.length) {
      const where = on[0]
      const dirty = git(where, ['status', '--porcelain', '--untracked-files=no'])
      if (dirty.out) throw coded('Q571', `${name} is checked out in ${where} with uncommitted changes. Commit or stash them there (or switch that checkout to another branch), then run pr again. Nothing was changed.`)
      const ff = git(where, ['merge', '--ff-only', '--quiet', newTip])
      if (ff.code !== 0) throw coded('Q570', `could not fast-forward ${name} in ${where}: ${ff.err || 'git refused'}. Nothing was changed; if the branch moved there, run pr again.`)
    } else {
      const cas = git(root, ['update-ref', '-m', 'hivecode: land room work', `refs/heads/${name}`, newTip, tip])
      if (cas.code !== 0) throw coded('Q570', `${name} moved while this was landing (it is no longer ${tip.slice(0, 7)}). Nothing was changed; run pr again so the new commits are accounted for.`)
    }
    const made = git(root, ['log', '--format=  %h  %an  %s', `${tip}..${newTip}`]).out
    log(`\nlanded on ${name}:\n${made}`)

    if (push) {
      const p = git(root, ['push', '-u', 'origin', name])
      if (p.code !== 0) throw coded('Q573', `the work landed on ${name} locally, but the push failed: ${p.err}`)
      log(`pushed ${name}`)
    }
    if (pr) {
      const into = base || b.from
      if (!into) throw coded('Q574', `the work landed on ${name}, but there is no branch to open the PR into; pass --base <branch>.`)
      const body = [`Opened by Hivecode from the room bound to \`${name}\`.`, '', 'Each commit carries its agent as the git author and the signed author id as a `Hivecode-Author` trailer.', '', '```', made, '```'].join('\n')
      const g = spawnSync('gh', ['pr', 'create', '--base', into, '--head', name, '--title', title || `Hivecode: ${name}`, '--body', body], { cwd: root, encoding: 'utf8', windowsHide: true })
      if (g.status !== 0) throw coded('Q574', `the work landed on ${name}, but gh pr create failed: ${(g.stderr || (g.error && g.error.message) || '').toString().trim()}`)
      log((g.stdout || '').trim())
    }
    return { ok: true, landed: made.split('\n').filter(Boolean).length, tip: newTip, deletions }
  } finally {
    cleanup()
  }
}

// ---- CLI ----------------------------------------------------------------------------------

function flags(argv) {
  const pos = []
  const f = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const k = a.slice(2)
    if (['dry-run', 'push', 'pr', 'reseed'].includes(k)) f[k] = true
    else f[k] = argv[++i] || ''
  }
  return { pos, f }
}

const USAGE = `usage:
  npx -y hivecode-mcp@latest branch <name> [--from <ref>] [--name <you>] [--relay <url>]
  npx -y hivecode-mcp@latest branch <name> --join "<link>"
  npx -y hivecode-mcp@latest branch <name> --reseed
  npx -y hivecode-mcp@latest pr <name> [--dry-run] [--push] [--pr] [--base <branch>] [--force "<reason>"]`

/** `argv` starts at the subcommand: ['branch', 'fix-x', ...] or ['pr', 'fix-x', ...]. Returns an exit code. */
export async function main(argv, { cwd = process.cwd(), log = console.log, logErr = console.error } = {}) {
  const [cmd, ...rest] = argv
  const { pos, f } = flags(rest)
  const name = pos[0]
  if (!name || (cmd !== 'branch' && cmd !== 'pr')) { logErr(USAGE); return 2 }
  try {
    if (cmd === 'pr') {
      const r = await landBranch({ cwd, branch: name, dry: !!f['dry-run'], push: !!(f.push || f.pr), pr: !!f.pr, base: f.base || '', force: f.force || '', only: f.only || '', title: f.title || '', log, logErr })
      return r.ok ? 0 : r.code || 1
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
