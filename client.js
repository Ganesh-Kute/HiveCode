// Client — binds ONE local file to the shared document in a room.
//
//   node client.js <relay-url> <room> <file> [name]
//   e.g. node client.js ws://localhost:1234 my-project ./main.py Jeevan
//
// Edit the file locally -> change rides to everyone in the room instantly.
// Someone else (or an AI agent) edits -> your file updates on disk live.
// No commit, no push, no pull. The document IS the source of truth.

import fs from 'fs'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', FILE = './shared.txt', NAME = 'anon'] = process.argv

// 1. The shared document and the text inside it that mirrors our file.
const doc = new Y.Doc()
const ytext = doc.getText('file')

// 2. Connect to the relay room. (y-websocket needs a WebSocket impl in Node.)
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })

// 3. Presence — announce who we are so the team sees a live roster.
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'human' })

let applyingRemote = false   // guard: don't echo remote edits back to the doc
let applyingLocal = false    // guard: don't echo our own disk writes as new edits

// 4. Remote -> disk. When the shared text changes, write it to our file.
ytext.observe(() => {
  if (applyingLocal) return
  applyingRemote = true
  fs.writeFileSync(FILE, ytext.toString())
  applyingRemote = false
})

// 5. Disk -> remote. When our file changes, push a minimal diff into the doc.
function pushFileToDoc() {
  if (applyingRemote) return
  const onDisk = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : ''
  const inDoc = ytext.toString()
  if (onDisk === inDoc) return
  applyingLocal = true
  // Minimal diff: keep the common prefix/suffix, replace only the middle.
  let p = 0
  while (p < onDisk.length && p < inDoc.length && onDisk[p] === inDoc[p]) p++
  let s = 0
  while (
    s < onDisk.length - p &&
    s < inDoc.length - p &&
    onDisk[onDisk.length - 1 - s] === inDoc[inDoc.length - 1 - s]
  ) s++
  doc.transact(() => {
    if (inDoc.length - p - s > 0) ytext.delete(p, inDoc.length - p - s)
    const inserted = onDisk.slice(p, onDisk.length - s)
    if (inserted) ytext.insert(p, inserted)
  })
  applyingLocal = false
}

// 6. On first sync: if the doc is empty but our file has content, seed it.
//    Otherwise the doc wins and overwrites our local file.
provider.on('sync', (isSynced) => {
  if (!isSynced) return
  const onDisk = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : ''
  if (ytext.length === 0 && onDisk.length > 0) {
    pushFileToDoc()
  } else {
    applyingRemote = true
    fs.writeFileSync(FILE, ytext.toString())
    applyingRemote = false
  }
  console.log(`[${NAME}] synced. Watching ${FILE} in room "${ROOM}".`)
})

// 7. Watch the file for local edits.
fs.watchFile(FILE, { interval: 200 }, pushFileToDoc)

// 8. Show the live roster whenever it changes.
provider.awareness.on('change', () => {
  const people = [...provider.awareness.getStates().values()]
    .map((s) => s.user?.name)
    .filter(Boolean)
  console.log(`[room] online: ${people.join(', ')}`)
})

console.log(`[${NAME}] connecting to ${RELAY} room "${ROOM}"...`)
