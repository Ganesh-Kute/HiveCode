// Whole-folder live sync — share an entire project directory with one command.
//
//   node folder.js <relay-url> <room> <dir> [name]
//   e.g. node folder.js ws://localhost:1234 myroom ./my-project Jeevan
//
// Syncs every text file in the folder (recursively): creates, edits, AND
// deletes. Nested folders are handled. node_modules/.git are skipped.
//
// Model: a shared Y.Map "files" maps each relative path -> a Y.Text of its
// contents. Disk->doc happens on a periodic scan; doc->disk happens via an
// observer that fires ONLY for remote changes (transaction.local tells them
// apart), so there is no echo loop.

import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { applyDiff } from './core.js'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', DIR = '.', NAME = 'anon'] = process.argv
const ROOT = path.resolve(DIR)
fs.mkdirSync(ROOT, { recursive: true }) // make sure the shared folder exists
const IGNORE = new Set(['node_modules', '.git'])
const MAX_BYTES = 1_000_000

const doc = new Y.Doc()
const files = doc.getMap('files') // relPath -> Y.Text
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'human' })

const known = new Set() // paths we've synced (lets us tell a local delete from a not-yet-written remote file)
const mtimes = new Map() // path -> last-seen mtimeMs, so we only re-read files that actually changed

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

// DISK -> DOC: scan the folder and fold changes into the shared doc.
// Optimization: only READ a file's contents when its mtime changed; unchanged
// files are skipped entirely, so a large project costs almost nothing per tick.
function scan() {
  const diskFulls = walk(ROOT)
  const diskRel = new Set(diskFulls.map(rel))
  const changed = []
  for (const full of diskFulls) {
    const r = rel(full)
    let mt
    try { mt = fs.statSync(full).mtimeMs } catch { continue }
    if (mtimes.get(r) === mt && files.has(r)) continue // unchanged -> skip read
    const text = readText(full)
    if (text === null) continue
    changed.push([r, text, mt])
  }
  const removed = [...known].filter((r) => !diskRel.has(r) && files.has(r))
  if (!changed.length && !removed.length) return
  doc.transact(() => {
    for (const [r, text, mt] of changed) {
      let yt = files.get(r)
      if (!yt) { yt = new Y.Text(); files.set(r, yt); yt.insert(0, text) }
      else applyDiff(yt, text)
      known.add(r)
      mtimes.set(r, mt)
    }
    for (const r of removed) {
      files.delete(r) // file vanished from disk -> propagate the delete
      known.delete(r)
      mtimes.delete(r)
    }
  }) // local transaction -> the observer below ignores it
}

// DOC -> DISK: react ONLY to remote changes.
files.observeDeep((events, txn) => {
  if (txn.local) return
  for (const ev of events) {
    if (ev.target === files) {
      ev.changes.keys.forEach((change, key) => {
        if (change.action === 'delete') {
          try { fs.rmSync(path.join(ROOT, key)) } catch {}
          known.delete(key)
          console.log(`[${NAME}] <- deleted ${key}`)
        } else {
          const yt = files.get(key)
          if (yt) { writeToDisk(key, yt.toString()); console.log(`[${NAME}] <- received ${key}`) }
        }
      })
    } else {
      for (const [key, yt] of files.entries()) {
        if (yt === ev.target) { writeToDisk(key, yt.toString()); break }
      }
    }
  }
})

provider.on('sync', (s) => {
  if (!s) return
  // pull any files the room already has that we lack...
  for (const [key, yt] of files.entries()) {
    const full = path.join(ROOT, key)
    if (!fs.existsSync(full)) writeToDisk(key, yt.toString())
    else known.add(key)
  }
  scan() // ...then push our local files
  console.log(`[${NAME}] folder sync active on ${ROOT} (room "${ROOM}"). ${files.size} files.`)
  setInterval(scan, 400)
})
