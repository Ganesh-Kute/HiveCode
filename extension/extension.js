// LiveCode VS Code extension.
//
// Commands:
//   LiveCode: Host a Session  -> share THIS folder, copy a join link to send
//   LiveCode: Join a Session  -> paste a friend's link, sync THIS folder
//   LiveCode: Leave Session
//
// Works in VS Code and any fork (Antigravity, Cursor, Windsurf). It syncs the
// open folder through the relay; the editor auto-reloads changed files, so it
// feels live. (Buffer-level cursors are the next version.)

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Y = require('yjs')
const { WebsocketProvider } = require('y-websocket')
const { WebSocket } = require('ws')

const IGNORE = new Set(['node_modules', '.git', '.vscode'])
const MAX_BYTES = 1_000_000

let session = null      // { doc, provider, root, scanTimer }
let status

function activate(context) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  setStatus('off')
  status.show()
  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('livecode.host', hostSession),
    vscode.commands.registerCommand('livecode.join', joinSession),
    vscode.commands.registerCommand('livecode.leave', leaveSession)
  )
}

function setStatus(state, people) {
  if (state === 'off') {
    status.text = '$(broadcast) LiveCode'
    status.tooltip = 'Click to host a LiveCode session'
    status.command = 'livecode.host'
  } else {
    status.text = `$(broadcast) LiveCode: ${people || 1} online`
    status.tooltip = 'In a LiveCode session. Click to leave.'
    status.command = 'livecode.leave'
  }
}

function relayUrl() {
  return vscode.workspace.getConfiguration('livecode').get('relayUrl')
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || !folders.length) {
    vscode.window.showErrorMessage('LiveCode: open a folder first (File > Open Folder).')
    return null
  }
  return folders[0].uri.fsPath
}

async function hostSession() {
  const root = workspaceRoot()
  if (!root || session) return
  const room = 'room-' + crypto.randomBytes(13).toString('base64url')
  start(root, room)
  const link = `${relayUrl()}|${room}`
  await vscode.env.clipboard.writeText(link)
  const pick = await vscode.window.showInformationMessage(
    'LiveCode session started! Join link copied — send it to your friend.',
    'Show link'
  )
  if (pick === 'Show link') vscode.window.showInformationMessage(link)
}

async function joinSession() {
  const root = workspaceRoot()
  if (!root || session) return
  const link = await vscode.window.showInputBox({
    prompt: 'Paste the LiveCode join link your friend sent you',
    placeHolder: 'wss://...onrender.com|room-xxxxxxxx',
  })
  if (!link) return
  const [relay, room] = link.includes('|') ? link.split('|') : [relayUrl(), link]
  start(root, room.trim(), relay.trim())
}

function leaveSession() {
  if (!session) return
  clearInterval(session.scanTimer)
  try { session.provider.destroy() } catch {}
  try { session.doc.destroy() } catch {}
  session = null
  setStatus('off')
  vscode.window.showInformationMessage('LiveCode: left the session.')
}

// --- the sync engine (whole-folder, disk-level, no echo loop) ---
function start(root, room, relay) {
  const doc = new Y.Doc()
  const files = doc.getMap('files')
  const provider = new WebsocketProvider(relay || relayUrl(), room, doc, { WebSocketPolyfill: WebSocket })
  const me = vscode.env.machineId.slice(0, 6)
  provider.awareness.setLocalStateField('user', { name: me, kind: 'human' })
  const known = new Set()
  const mtimes = new Map() // path -> mtimeMs, so we skip re-reading unchanged files

  // make collaboration smooth: auto-save so edits push quickly
  vscode.workspace.getConfiguration('files').update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace)

  const rel = (full) => path.relative(root, full).split(path.sep).join('/')

  function walk(dir, acc = []) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, acc)
      else if (e.isFile()) acc.push(full)
    }
    return acc
  }
  function readText(full) {
    try {
      const buf = fs.readFileSync(full)
      if (buf.length > MAX_BYTES || buf.includes(0)) return null
      return buf.toString('utf8')
    } catch { return null }
  }
  function applyDiff(yt, next) {
    const cur = yt.toString()
    if (cur === next) return
    let p = 0
    while (p < cur.length && p < next.length && cur[p] === next[p]) p++
    let s = 0
    while (s < cur.length - p && s < next.length - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++
    if (cur.length - p - s > 0) yt.delete(p, cur.length - p - s)
    const ins = next.slice(p, next.length - s)
    if (ins) yt.insert(p, ins)
  }
  function writeToDisk(r, content) {
    const full = path.join(root, r)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    known.add(r)
    try { mtimes.set(r, fs.statSync(full).mtimeMs) } catch {}
  }

  // only read files whose mtime changed -> cheap even on a big project
  function scan() {
    const fulls = walk(root)
    const onDisk = new Set(fulls.map(rel))
    const changed = []
    for (const full of fulls) {
      const r = rel(full)
      let mt
      try { mt = fs.statSync(full).mtimeMs } catch { continue }
      if (mtimes.get(r) === mt && files.has(r)) continue
      const text = readText(full)
      if (text === null) continue
      changed.push([r, text, mt])
    }
    const removed = [...known].filter((r) => !onDisk.has(r) && files.has(r))
    if (!changed.length && !removed.length) return
    doc.transact(() => {
      for (const [r, text, mt] of changed) {
        let yt = files.get(r)
        if (!yt) { yt = new Y.Text(); files.set(r, yt); yt.insert(0, text) }
        else applyDiff(yt, text)
        known.add(r); mtimes.set(r, mt)
      }
      for (const r of removed) { files.delete(r); known.delete(r); mtimes.delete(r) }
    })
  }

  files.observeDeep((events, txn) => {
    if (txn.local) return
    for (const ev of events) {
      if (ev.target === files) {
        ev.changes.keys.forEach((change, key) => {
          if (change.action === 'delete') { try { fs.rmSync(path.join(root, key)) } catch {}; known.delete(key) }
          else { const yt = files.get(key); if (yt) writeToDisk(key, yt.toString()) }
        })
      } else {
        for (const [key, yt] of files.entries()) {
          if (yt === ev.target) { writeToDisk(key, yt.toString()); break }
        }
      }
    }
  })

  provider.awareness.on('change', () => {
    setStatus('on', provider.awareness.getStates().size)
  })

  provider.on('sync', (s) => {
    if (!s) return
    for (const [key, yt] of files.entries()) {
      const full = path.join(root, key)
      if (!fs.existsSync(full)) writeToDisk(key, yt.toString())
      else known.add(key)
    }
    scan()
    const timer = setInterval(scan, 400)
    session.scanTimer = timer
  })

  session = { doc, provider, root, scanTimer: null }
  setStatus('on', 1)
}

function deactivate() { leaveSession() }

module.exports = { activate, deactivate }
