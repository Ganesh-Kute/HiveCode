// hive-rules-install.js -- `rules install | remove | show`: the few Hivecode rules an agent forgets,
// in the file its own app loads on every turn.
//
//   npx -y hivecode-mcp@latest rules install [--dir <folder>] [--file <path>]...
//   npx -y hivecode-mcp@latest rules remove  [--dir <folder>] [--file <path>]...
//   npx -y hivecode-mcp@latest rules show    [--dir <folder>]
//
// WHY (15 Nov 2026). HIVE_RULES.md is read when an agent decides to read it. AGENTS.md, CLAUDE.md
// and GEMINI.md are loaded into every turn by the agent's own app, whether or not Hivecode's tools
// are connected. That day an agent answered two mentions, did not start its listener again, and
// dropped out of the room: the rule it needed was in a file it was not reading at that moment.
//
// IT IS THE PERSON'S FILE, and usually a committed one. So:
//   - a command, never a tool and never automatic: nothing writes here unless someone runs this;
//   - only what is between the two markers is ever written, replaced or removed;
//   - `remove` gives the file back byte for byte, line endings and final newline included;
//   - a file with one marker and not the other is left alone and named: a guess could delete text.
// (tests/rules-install-test.mjs)
import fs from 'fs'
import path from 'path'
import { AGENT_FILE_BLOCK } from './hive-instructions.js'

export const START = '<!-- hivecode:start -->'
export const END = '<!-- hivecode:end -->'
// Files an agent app reads on every turn, by the name it looks for. Only ones that exist are
// touched; --file names anything else (a system prompt kept somewhere of its own).
export const KNOWN = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', '.github/copilot-instructions.md']
const CREATED = 'AGENTS.md' // when a folder has none: the name most apps read

const eolOf = (text) => (/\r\n/.test(text) ? '\r\n' : '\n')
const blockFor = (eol) => [START, ...AGENT_FILE_BLOCK.split('\n'), END].join(eol)
/** Where the block is: { a, b } covering START through END, null when absent, or { error }. */
function find(text) {
  const a = text.indexOf(START), b = text.indexOf(END)
  if (a === -1 && b === -1) return null
  // A marker that appears twice: one of them is the person's own text (a file that quotes the
  // marker, a block pasted in by hand). First-to-first would take their text for part of the block.
  if (a !== -1 && text.indexOf(START, a + START.length) !== -1) return { error: 'it has more than one hivecode:start. Delete the one that is not the block, then run this again.' }
  if (b !== -1 && text.indexOf(END, b + END.length) !== -1) return { error: 'it has more than one hivecode:end. Delete the one that is not the block, then run this again.' }
  if (a === -1 || b === -1 || b < a) return { error: `it has ${a === -1 ? 'hivecode:end without hivecode:start' : b === -1 ? 'hivecode:start without hivecode:end' : 'hivecode:end before hivecode:start'}. Put the missing marker back, or delete the leftover one, then run this again.` }
  return { a, b: b + END.length }
}

/** The text with the block added, or the block it already has brought up to date. */
export function withBlock(text) {
  const at = find(text)
  if (at && at.error) return { text, changed: false, error: at.error }
  const eol = eolOf(text), block = blockFor(eol)
  if (at) {
    const next = text.slice(0, at.a) + block + text.slice(at.b)
    return { text: next, changed: next !== text }
  }
  if (!text) return { text: block + eol, changed: true }
  // A blank line before it, and the file ends the way it ended: with a newline, or without one.
  const next = text.endsWith(eol) ? text + eol + block + eol : text + eol + eol + block
  return { text: next, changed: true }
}

/** The text with the block, and the blank line `withBlock` put before it, taken out again. */
export function withoutBlock(text) {
  const at = find(text)
  if (at && at.error) return { text, changed: false, error: at.error }
  if (!at) return { text, changed: false }
  const eol = eolOf(text)
  let pre = text.slice(0, at.a), post = text.slice(at.b)
  const strip = (n) => { for (let i = 0; i < n && pre.endsWith(eol); i++) pre = pre.slice(0, -eol.length) }
  if (post.startsWith(eol)) {
    post = post.slice(eol.length)
    if (pre.endsWith(eol + eol)) strip(1)
  } else if (!post) strip(2) // it was added to a file with no final newline
  // The block was the top of the file (a file `install` created, since added to): the blank lines
  // under it separated it from the person's text, and now separate that text from nothing.
  if (!pre) while (post.startsWith(eol)) post = post.slice(eol.length)
  return { text: pre + post, changed: true }
}

const USAGE = `usage:
  npx -y hivecode-mcp@latest rules install [--dir <folder>] [--file <path>]...
  npx -y hivecode-mcp@latest rules remove  [--dir <folder>] [--file <path>]...
  npx -y hivecode-mcp@latest rules show    [--dir <folder>]

install puts a short Hivecode block between two markers in the instruction files your agents
read on every turn (${KNOWN.join(', ')}), in every one of them that exists. With none, it
creates ${CREATED}. --file names other files instead. Nothing outside the markers is changed.`

function parse(argv) {
  const out = { cmd: argv[0] || '', dir: process.cwd(), files: [] }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) out.dir = path.resolve(argv[++i])
    else if (argv[i] === '--file' && argv[i + 1]) out.files.push(argv[++i])
    else return null
  }
  return out
}
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const rel = (dir, p) => { const r = path.relative(dir, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : p }

/** The Hivecode room folder a file is in, or ''. The engine leaves `.hive.json` at the top of one. */
function roomFolderOf(p) {
  for (let d = path.dirname(path.resolve(p)); ; d = path.dirname(d)) {
    try { if (fs.statSync(path.join(d, '.hive.json')).isFile()) return d } catch { }
    if (path.dirname(d) === d) return ''
  }
}
// A ROOM FOLDER IS SYNCED. Measured 15 Nov 2026: this command, run in one agent's room folder,
// created AGENTS.md there, and the file arrived in every other member's folder. That may be exactly
// what a team wants for its own repository, and it may be a surprise. It cannot be told from here,
// so the command says what is happening and the person decides.
function sharedNote(paths) {
  const rooms = [...new Set(paths.map(roomFolderOf).filter(Boolean))]
  if (!rooms.length) return ''
  return `Note: ${rooms.join(', ')} ${rooms.length === 1 ? 'is a Hivecode room folder' : 'are Hivecode room folders'}. Files there are synced, so this change is shared with everyone in the room, and goes into a pull request made from it.`
}

export async function main(argv = process.argv.slice(2), { out = console.log, err = console.error } = {}) {
  const a = parse(argv)
  if (!a || !['install', 'remove', 'show'].includes(a.cmd)) { err(USAGE); return 2 }
  const named = a.files.map((f) => path.resolve(a.dir, f))
  const existing = named.length ? named : KNOWN.map((f) => path.join(a.dir, f)).filter(isFile)

  if (a.cmd === 'show') {
    out(blockFor('\n'))
    out('')
    out(existing.length ? `install would put this in: ${existing.map((p) => rel(a.dir, p)).join(', ')}` : `No agent instruction file is in ${a.dir}: install would create ${CREATED}.`)
    const note = sharedNote(existing.length ? existing : [path.join(a.dir, CREATED)])
    if (note) out(note)
    return 0
  }

  if (a.cmd === 'install') {
    const targets = existing.length ? existing : [path.join(a.dir, CREATED)]
    const created = !existing.length
    const done = [], same = [], refused = [], written = []
    for (const p of targets) {
      let text = ''
      try { text = fs.readFileSync(p, 'utf8') } catch (e) { if (e.code !== 'ENOENT') { refused.push(`${rel(a.dir, p)}: ${e.message}`); continue } }
      const r = withBlock(text)
      if (r.error) { refused.push(`${rel(a.dir, p)}: ${r.error}`); continue }
      if (!r.changed) { same.push(rel(a.dir, p)); continue }
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, r.text) } catch (e) { refused.push(`${rel(a.dir, p)}: ${e.message}`); continue }
      done.push(rel(a.dir, p)); written.push(p)
    }
    if (done.length) out(created ? `No agent instruction file was in this folder, so ${done[0]} was created with the Hivecode rules block. Claude Code reads CLAUDE.md and Gemini reads GEMINI.md: for those, run this again with --file CLAUDE.md (or GEMINI.md).` : `Hivecode rules block added to: ${done.join(', ')}. Nothing else in ${done.length === 1 ? 'that file' : 'those files'} changed.`)
    if (same.length) out(`Already up to date: ${same.join(', ')}.`)
    if (done.length) out('To take it out again: npx -y hivecode-mcp@latest rules remove')
    if (sharedNote(written)) out(sharedNote(written))
    for (const r of refused) err(`Left alone: ${r}`)
    return refused.length ? 1 : 0
  }

  // remove
  const gone = [], deleted = [], refused = [], written = []
  for (const p of existing) {
    let text
    try { text = fs.readFileSync(p, 'utf8') } catch (e) { refused.push(`${rel(a.dir, p)}: ${e.message}`); continue }
    const r = withoutBlock(text)
    if (r.error) { refused.push(`${rel(a.dir, p)}: ${r.error}`); continue }
    if (!r.changed) continue
    try {
      // A file that held nothing but the block is one `install` created.
      if (r.text === '') { fs.unlinkSync(p); deleted.push(rel(a.dir, p)) } else { fs.writeFileSync(p, r.text); gone.push(rel(a.dir, p)) }
      written.push(p)
    } catch (e) { refused.push(`${rel(a.dir, p)}: ${e.message}`) }
  }
  if (gone.length) out(`Hivecode rules block removed from: ${gone.join(', ')}.`)
  if (deleted.length) out(`Deleted ${deleted.join(', ')}: it held nothing but the block.`)
  if (!gone.length && !deleted.length && !refused.length) out('No Hivecode rules block was found.')
  if (sharedNote(written)) out(sharedNote(written))
  for (const r of refused) err(`Left alone: ${r}`)
  return refused.length ? 1 : 0
}
