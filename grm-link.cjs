// Gives a Hivecode room a MEMORY, by handing its history to GRM.
//
// A room already records everything worth remembering -- HIVE_CHAT.md is the participants'
// conversation, HIVE_BOARD.md is what was rewritten and by whom, HIVE_TASKS.md is the
// directed work and its approvals. All of it is written to the room folder as ordinary
// markdown. And GRM already indexes named files from `code_roots.txt`, re-read on every
// watcher pass, so a path added here takes effect without restarting anything.
//
// So the two halves need no new format, daemon or protocol between them: name those files,
// and an agent that joins the room tomorrow can ask what was decided in it last week --
// including in conversations it was never present for. Neither product can do that alone.
//
// CommonJS on purpose. sync.js is ESM and the VS Code extension is CJS; a .cjs file is the
// one shape both can load, so this exists ONCE. The duplicated reconcile()/HIVE_RULES text
// across those two files has already drifted twice and cost real bugs -- not repeating it.

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

// The room's own record. NOT the room folder: `code_roots.txt` carries a warning written
// after adding one directory appended 90,215 blocks in a single pass and had to be cut back
// out of the journal -- "a root is a whole repository unless you check". Naming four files
// gives the decision history and nothing else.
const HISTORY_FILES = ['HIVE_CHAT.md', 'HIVE_BOARD.md', 'HIVE_TASKS.md', 'HIVE_MEMBERS.md']

function grmHome() {
  const env = (process.env.GRM_HOME || '').trim()
  return env || path.join(os.homedir(), '.grm')
}

function rootsPath() {
  return path.join(grmHome(), 'code_roots.txt')
}

// Keyed on the resolved directory so the same room in two folders gets two blocks, and the
// same folder rejoined a hundred times keeps exactly one.
function tagFor(dir) {
  return 'hivecode:' + crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 12)
}

// The file is written by GRM's installer with a UTF-8 BOM. GRM's own reader strips it, but
// this must not *drop* it on the way through -- the file belongs to GRM, and a tool that
// silently reformats another tool's config is how you get a bug nobody can find.
function readRoots(p) {
  const raw = fs.readFileSync(p, 'utf8')
  return raw.charCodeAt(0) === 0xfeff ? { bom: '﻿', body: raw.slice(1) } : { bom: '', body: raw }
}

function writeRootsAtomic(p, bom, body) {
  const tmp = p + '.hivecode.tmp'
  fs.writeFileSync(tmp, bom + body, 'utf8')
  fs.renameSync(tmp, p) // the watcher re-reads on every pass; never let it see a half-written file
}

// Drop any block previously written for this room. Returns the body without it.
function stripBlock(body, tag) {
  const lines = body.split(/\r?\n/)
  const out = []
  let inside = false
  for (const line of lines) {
    if (!inside && line.startsWith('# >>> ' + tag)) { inside = true; continue }
    if (inside) { if (line.startsWith('# <<< ' + tag)) inside = false; continue }
    out.push(line)
  }
  return out.join('\n')
}

function blockFor(dir, tag, files) {
  const head = `# >>> ${tag}  Hivecode room at ${path.resolve(dir)}`
  const why = '#     Added by Hivecode so this room\'s decisions are in memory. Safe to delete.'
  const tail = `# <<< ${tag}`
  return [head, why, ...files, tail].join('\n')
}

/**
 * Point GRM at this room's history. Idempotent and cheap: it rewrites `code_roots.txt`
 * only when the set of existing history files has actually changed, so it is fine to call
 * on every join and again whenever one of those files is written.
 *
 * Returns { linked, files, reason }. Never throws -- a memory that cannot be wired up is
 * not a reason to fail somebody's join.
 */
function linkRoom(dir, log = () => {}) {
  try {
    const p = rootsPath()

    // DO NOT CREATE THIS FILE. GRM's reader has three states, and they are not two:
    // no file at all -> fall back to the default root; a file naming paths that all fail
    // to resolve -> watch NOTHING, deliberately, so a typo is visible rather than buried.
    // Creating one here containing only HIVE_*.md would therefore convert "GRM indexes my
    // projects" into "GRM indexes this room and nothing else" the moment the paths lag
    // behind the folder. Only ever append to a file GRM already owns.
    if (!fs.existsSync(p)) return { linked: false, files: [], reason: 'GRM is not installed on this machine' }

    const files = HISTORY_FILES
      .map((f) => path.resolve(dir, f))
      .filter((f) => { try { return fs.statSync(f).isFile() } catch { return false } })
    if (!files.length) return { linked: false, files: [], reason: 'room has not written its history yet' }

    const tag = tagFor(dir)
    const { bom, body } = readRoots(p)
    const stripped = stripBlock(body, tag)
    const next = stripped.trimEnd() + '\n\n' + blockFor(dir, tag, files) + '\n'

    if (bom + next === bom + body) return { linked: true, files, reason: 'already linked' } // no write, no watcher churn
    writeRootsAtomic(p, bom, next)
    log(`[hive] room history handed to GRM (${files.length} file(s)) -- agents here can now recall what this room decided before they joined.`)
    return { linked: true, files, reason: 'linked' }
  } catch (e) {
    log(`[hive] could not hand this room's history to GRM: ${e && e.message}`)
    return { linked: false, files: [], reason: String((e && e.message) || e) }
  }
}

/**
 * Remove this room from GRM's roots. Called on leave, so a room you are no longer in stops
 * contributing to what your agents recall.
 */
function unlinkRoom(dir, log = () => {}) {
  try {
    const p = rootsPath()
    if (!fs.existsSync(p)) return { unlinked: false, reason: 'GRM is not installed on this machine' }
    const tag = tagFor(dir)
    const { bom, body } = readRoots(p)
    if (!body.includes('# >>> ' + tag)) return { unlinked: false, reason: 'was not linked' }
    writeRootsAtomic(p, bom, stripBlock(body, tag).trimEnd() + '\n')
    log('[hive] room history removed from GRM.')
    return { unlinked: true, reason: 'unlinked' }
  } catch (e) {
    return { unlinked: false, reason: String((e && e.message) || e) }
  }
}

/** Whether GRM is present at all -- used to decide whether to mention memory in the UI. */
function grmPresent() {
  try { return fs.existsSync(rootsPath()) } catch { return false }
}

module.exports = { linkRoom, unlinkRoom, grmPresent, rootsPath, HISTORY_FILES }
