// Whole-folder live sync — share an entire project directory with one command.
//
//   node folder.js <relay-url> <room> <dir> [name]
//   e.g. node folder.js ws://localhost:1234 myroom ./my-project Jeevan
//
// Syncs every text file in the folder (recursively): creates, edits, AND
// deletes. Nested folders are handled. node_modules/.git are skipped.
//
// Model: a shared Y.Map "files" maps each relative path -> a Y.Text of its
// contents. Both directions go through reconcile(), a 3-way merge against the
// last agreed version of each file (its "base"):
//   - only one side changed       -> take that side
//   - both changed disjoint lines -> MERGE both (nobody's work is lost)
//   - both changed the same lines -> write git-style conflict markers so BOTH
//     versions survive and a human/AI resolves them (still never silently lost)
// This is what stops "the second agent's full rewrite wiped the first's work."

import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { applyDiff, merge3 } from './core.js'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', DIR = '.', NAME = 'anon'] = process.argv
const ROOT = path.resolve(DIR)
fs.mkdirSync(ROOT, { recursive: true }) // make sure the shared folder exists
const IGNORE = new Set(['node_modules', '.git'])
const MAX_BYTES = 1_000_000

const doc = new Y.Doc()
const files = doc.getMap('files') // relPath -> Y.Text
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'human' })

const known = new Set()  // paths we've synced (tells a local delete from a not-yet-written remote file)
const mtimes = new Map() // path -> last-seen mtimeMs, so we only re-read files that actually changed
const bases = new Map()  // path -> last AGREED text (the common ancestor for 3-way merge)

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.isFile()) acc.push(full)
  }
  return acc
}
const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/')

function readText(full) {
  try {
    const buf = fs.readFileSync(full)
    if (buf.length > MAX_BYTES || buf.includes(0)) return null // skip huge / binary
    return buf.toString('utf8')
  } catch {
    return null
  }
}

function writeToDisk(relPath, content) {
  const full = path.join(ROOT, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
  known.add(relPath)
  try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch {} // don't re-read our own write
}

// The heart of it. Bring one file's disk copy and shared-doc copy into agreement
// via a 3-way merge against its last agreed base, writing the result to whichever
// side is behind. Safe to call from either direction (scan or remote observer).
function reconcile(relPath) {
  const full = path.join(ROOT, relPath)
  const yt = files.get(relPath)
  const disk = fs.existsSync(full) ? readText(full) : null
  const docText = yt ? yt.toString() : null
  if (disk === null && docText === null) return

  // Only one side has the file yet -> just copy it across.
  if (docText === null) {
    const t = new Y.Text(); files.set(relPath, t); t.insert(0, disk)
    known.add(relPath); bases.set(relPath, disk)
    try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch {}
    return
  }
  if (disk === null) { writeToDisk(relPath, docText); bases.set(relPath, docText); return }
  if (disk === docText) { known.add(relPath); bases.set(relPath, disk); return } // already agree

  // Both sides exist and differ -> 3-way merge against the last agreed base.
  const base = bases.has(relPath) ? bases.get(relPath) : disk
  const res = merge3(base, disk, docText)
  doc.transact(() => applyDiff(yt, res.text)) // local txn -> observer ignores it
  if (res.text !== disk) writeToDisk(relPath, res.text)
  known.add(relPath); bases.set(relPath, res.text)
  if (res.conflict) console.log(`[${NAME}] ⚠ merge conflict in ${relPath} — kept BOTH versions with <<<<<<< markers; resolve when ready`)
  else console.log(`[${NAME}] merged ${relPath} (both edits kept)`)
}

// DISK -> reconcile: scan the folder; reconcile any file whose mtime changed.
// Unchanged files are skipped entirely, so a large project costs ~nothing/tick.
function scan() {
  const diskFulls = walk(ROOT)
  const diskRel = new Set(diskFulls.map(rel))
  let touched = false
  for (const full of diskFulls) {
    const r = rel(full)
    let mt
    try { mt = fs.statSync(full).mtimeMs } catch { continue }
    if (mtimes.get(r) === mt && files.has(r)) continue // unchanged -> skip read
    if (readText(full) === null) continue              // binary/huge -> skip
    mtimes.set(r, mt)
    reconcile(r)
    touched = true
  }
  const removed = [...known].filter((r) => !diskRel.has(r) && files.has(r))
  if (removed.length) {
    doc.transact(() => {
      for (const r of removed) { files.delete(r); known.delete(r); mtimes.delete(r); bases.delete(r) }
    })
  }
  return touched
}

// DOC -> reconcile: react ONLY to remote changes (transaction.local tells ours
// apart), then reconcile so a remote update merges with local edits instead of
// overwriting them.
files.observeDeep((events, txn) => {
  if (txn.local) return
  for (const ev of events) {
    if (ev.target === files) {
      ev.changes.keys.forEach((change, key) => {
        if (change.action === 'delete') {
          try { fs.rmSync(path.join(ROOT, key)) } catch {}
          known.delete(key); bases.delete(key)
          console.log(`[${NAME}] <- deleted ${key}`)
        } else {
          reconcile(key)
        }
      })
    } else {
      for (const [key, yt] of files.entries()) {
        if (yt === ev.target) { reconcile(key); break }
      }
    }
  }
})

provider.on('sync', (s) => {
  if (!s) return
  // pull any files the room already has, reconciling against our local copies...
  for (const [key] of files.entries()) reconcile(key)
  scan() // ...then push/reconcile our local files
  console.log(`[${NAME}] folder sync active on ${ROOT} (room "${ROOM}"). ${files.size} files.`)
  setInterval(scan, 400)
})
