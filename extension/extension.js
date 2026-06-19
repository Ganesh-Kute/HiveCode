// Hivecode VS Code extension.
//
// Sidebar panel (activity-bar icon) with Host / Join / Leave buttons, the live
// member list, and an activity log. Commands also available via Ctrl+Shift+P:
//   Hivecode: Host a Session  -> share THIS folder, copy a join link to send
//   Hivecode: Join a Session  -> paste a friend's link, sync THIS folder
//   Hivecode: Leave Session
//
// Works in VS Code and any fork (Antigravity, Cursor, Windsurf). It syncs the
// open folder through the relay; the editor auto-reloads changed files.

const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const Y = require('yjs')
const { WebsocketProvider } = require('y-websocket')
const { WebSocket } = require('ws')
const ignore = require('ignore')

const IGNORE = new Set(['node_modules', '.git', '.vscode'])
const MAX_BYTES = 1_000_000
// Never sync these, even if not in .gitignore — secrets and obvious junk.
const ALWAYS_IGNORE = [
  '.git/', 'node_modules/',
  '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', 'id_rsa', 'id_ed25519', '*.keystore',
  '*.log', '.DS_Store', 'Thumbs.db', '*.vsix',
]
// generated/coordination files — never synced as ordinary files
const SKIP = new Set(['HIVE_BOARD.md', 'HIVE_CHAT.md', 'HIVE_TASKS.md', 'HIVE_RULES.md', 'HIVE_MEMBERS.md', '.hive.json'])
const HIVE_RULES_TEXT = `# HIVE RULES — read this first. Everyone in this room (human or AI) follows these.

You are in a Hivecode room: humans and AI agents edit ONE project together live.
These rules keep anyone from destroying another's work. The sync layer enforces
the hard parts automatically; you do the rest.

## Before you touch a file
1. Read HIVE_CHAT.md — what is everyone doing right now.
2. Read HIVE_BOARD.md — which files were just rewritten.
3. If a file you plan to edit appears there, RE-READ it before changing it.

## While you work
4. ANNOUNCE in chat what you are taking before you start.
5. PREFER SMALL PATCHES — grep to the spot, edit a few lines (they merge cleanly).
6. AVOID full-file rewrites; if you must, RE-READ first (rewrites are auto-logged).
7. STAY IN YOUR LANE — read others' areas, but leave edits to the owner.

## When things collide
8. <<<<<<< ======= >>>>>>> markers = a real conflict: keep the right code, delete
   the markers. Never ignore or blindly overwrite.
9. If your edit was merged/reworked, that is normal — re-read and continue.

## Talking
10. Coordinate in chat. ASK before anything destructive in another's area.
`

let session = null     // { doc, provider, root, scanTimer, room, relay }
let status             // status-bar item
let panel = null       // the sidebar webview provider
const activity = []    // recent activity log lines (newest first)

function activate(context) {
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  setStatus('off')
  status.show()

  panel = new HivecodeViewProvider()

  context.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider('hivecode.panel', panel),
    vscode.commands.registerCommand('hivecode.host', hostSession),
    vscode.commands.registerCommand('hivecode.join', joinSessionPrompt),
    vscode.commands.registerCommand('hivecode.leave', leaveSession)
  )
}

function setStatus(state, people) {
  if (state === 'off') {
    status.text = '$(broadcast) Hivecode'
    status.tooltip = 'Click to host a Hivecode session'
    status.command = 'hivecode.host'
  } else {
    status.text = `$(broadcast) Hivecode: ${people || 1} online`
    status.tooltip = 'In a Hivecode session. Click to leave.'
    status.command = 'hivecode.leave'
  }
}

function relayUrl() {
  return vscode.workspace.getConfiguration('hivecode').get('relayUrl')
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || !folders.length) {
    vscode.window.showErrorMessage('Hivecode: open a folder first (File > Open Folder).')
    return null
  }
  return folders[0].uri.fsPath
}

// --- activity log + state broadcast to the panel ---
function logActivity(msg) {
  const t = new Date().toLocaleTimeString()
  activity.unshift(`${t}  ${msg}`)
  if (activity.length > 100) activity.pop()
  pushState()
}

function membersList() {
  if (!session) return []
  const fresh = Date.now() - 15000
  return [...session.provider.awareness.getStates().values()]
    .map((s) => s.user)
    .filter(Boolean)
    .map((u) => ({ name: u.name, kind: u.kind || 'human', editing: u.editing && u.editing.at > fresh ? u.editing.file : null }))
}

function pushState() {
  const members = membersList()
  setStatus(session ? 'on' : 'off', members.length)
  if (!panel) return
  const chat = session ? session.chat.toArray().slice(-50) : []
  const tasks = session ? [...session.tasks.values()].sort((a, b) => (a.at < b.at ? 1 : -1)) : []
  const owners = session ? Object.fromEntries(session.owners.entries()) : {}
  panel.post({
    type: 'state',
    connected: !!session,
    room: session ? session.room : null,
    link: session ? `${session.relay}|${session.room}` : null,
    me: session ? session.me : null,
    members,
    activity,
    chat,
    tasks,
    owners,
  })
}

// --- session actions ---
async function hostSession() {
  const root = workspaceRoot()
  if (!root || session) return
  const room = 'room-' + crypto.randomBytes(13).toString('base64url')
  const relay = relayUrl()
  start(root, room, relay)
  await vscode.env.clipboard.writeText(`${relay}|${room}`)
  logActivity('Hosting — join link copied to clipboard')
  vscode.window.showInformationMessage('Hivecode: hosting. Join link copied — send it to your friend.')
}

async function joinSessionPrompt() {
  const link = await vscode.window.showInputBox({
    prompt: 'Paste the Hivecode join link your friend sent you',
    placeHolder: 'wss://...|room-xxxxxxxx',
  })
  if (link) joinSessionWithLink(link)
}

function joinSessionWithLink(link) {
  const root = workspaceRoot()
  if (!root || session || !link) return
  const [relay, room] = link.includes('|') ? link.split('|') : [relayUrl(), link]
  start(root, room.trim(), relay.trim())
  logActivity(`Joining room ${room.trim()}`)
}

function leaveSession() {
  if (!session) return
  clearInterval(session.scanTimer)
  try { session.stopActivity && session.stopActivity() } catch {}
  try { session.provider.destroy() } catch {}
  try { session.doc.destroy() } catch {}
  session = null
  logActivity('Left the session')
  pushState()
}

// --- the sync engine (whole-folder, disk-level, mtime-optimized) ---
function start(root, room, relay) {
  const doc = new Y.Doc()
  const files = doc.getMap('files')
  const board = doc.getMap('board') // relPath -> { by, at, churn, symbols } (auto-logged rewrites)
  const chat = doc.getArray('chat') // ordered messages { by, kind, at, text }
  const tasks = doc.getMap('tasks') // id -> { id, to, by, text, status, decidedBy, at }
  const owners = doc.getMap('owners') // aiName -> ownerHumanName
  const BOARD_FILE = 'HIVE_BOARD.md' // generated locally from `board`; never synced as a file
  const useRelay = relay || relayUrl()
  const provider = new WebsocketProvider(useRelay, room, doc, { WebSocketPolyfill: WebSocket })
  // Unique per window: doc.clientID is distinct even for two windows on one
  // machine (machineId was identical → both showed the same id). A configured
  // displayName wins so members read as "Jeevan"/"Friend" instead of an id.
  const cfg = vscode.workspace.getConfiguration('hivecode')
  const me = (cfg.get('displayName') || '').trim() || `user-${String(doc.clientID).slice(-4)}`
  const kind = cfg.get('participantKind') === 'ai' ? 'ai' : 'human'
  provider.awareness.setLocalStateField('user', { name: me, kind })
  const known = new Set()
  const mtimes = new Map()
  const bases = new Map()  // path -> last AGREED text (common ancestor for 3-way merge)
  const forkBases = new Map() // path -> FORK POINT: what THIS author last saw/authored.
  // Advances only on local authorship / first adoption — NOT when a remote change
  // lands on disk. Stops a stale local rewrite from silently deleting another's work.
  const seenMembers = new Set()
  // --- live activity: broadcast which file this window is editing + warn on co-editing ---
  const EDIT_FRESH_MS = 15000
  let myEditing = null, editingClearTimer = null
  const warnedAt = new Map()
  const setUserState = () => { try { provider.awareness.setLocalStateField('user', { name: me, kind, editing: myEditing || undefined }) } catch {} }
  function markEditing(r) {
    myEditing = { file: r, at: Date.now() }; setUserState()
    if (editingClearTimer) clearTimeout(editingClearTimer)
    editingClearTimer = setTimeout(() => { myEditing = null; setUserState() }, EDIT_FRESH_MS)
  }
  function coEditors(r) {
    const now = Date.now(), others = []
    for (const s of provider.awareness.getStates().values()) {
      const u = s.user; if (!u || u.name === me) continue
      if (u.editing && u.editing.file === r && now - u.editing.at < EDIT_FRESH_MS) others.push(u.name)
    }
    return others
  }
  function noteCoEditing(r) {
    const others = coEditors(r), now = Date.now()
    if (others.length && now - (warnedAt.get(r) || 0) > 30000) {
      warnedAt.set(r, now)
      try { say(`⚠ heads-up: ${me} is also editing ${r} (with ${others.join(', ')}). Small patches auto-merge; coordinate before a full rewrite.`) } catch {}
    }
  }

  vscode.workspace.getConfiguration('files').update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace)

  // Respect .gitignore (+ always-ignore secrets) so we never sync .env/keys/build output.
  let ig = ignore()
  function reloadIgnores() {
    ig = ignore().add(ALWAYS_IGNORE)
    try { ig.add(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')) } catch { }
  }
  reloadIgnores()
  const isIgnored = (relPath) => !!relPath && ig.ignores(relPath)

  const rel = (full) => path.relative(root, full).split(path.sep).join('/')

  function walk(dir, acc = []) {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue
      const full = path.join(dir, e.name)
      const r = rel(full)
      if (e.isDirectory()) { if (!isIgnored(r + '/')) walk(full, acc) }
      else if (e.isFile()) { if (!isIgnored(r)) acc.push(full) }
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
  // line-range an edit replaced, and the replacement lines (for 3-way merge)
  function changedRange(base, other) {
    let p = 0
    while (p < base.length && p < other.length && base[p] === other[p]) p++
    let s = 0
    while (s < base.length - p && s < other.length - p && base[base.length - 1 - s] === other[other.length - 1 - s]) s++
    return { startBase: p, endBase: base.length - s, newLines: other.slice(p, other.length - s) }
  }
  // patch vs wholesale rewrite + which symbols the new version defines (for the board)
  function symbolsIn(text) {
    const names = new Set()
    const add = (re) => { let m; while ((m = re.exec(text)) && names.size < 8) names.add(m[1]) }
    add(/\bfunction\s+(\w+)/g); add(/\bclass\s+(\w+)/g); add(/\bdef\s+(\w+)/g)
    add(/\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g)
    return [...names].slice(0, 8)
  }
  function summarizeChange(base, next) {
    const b = (base || '').split('\n'); const n = (next || '').split('\n')
    if (!base) return { isRewrite: false, changedLines: n.length, totalLines: n.length, symbols: symbolsIn(next || '') }
    const r = changedRange(b, n)
    const churn = Math.max(r.endBase - r.startBase, r.newLines.length)
    const total = Math.max(b.length, n.length)
    return { isRewrite: total > 0 && churn >= 4 && churn / total >= 0.5, changedLines: churn, totalLines: total, symbols: symbolsIn(r.newLines.join('\n')) }
  }
  // 3-way merge: disjoint edits merge cleanly; overlapping edits get git-style
  // markers so BOTH versions survive (nobody's work is silently lost).
  function merge3(base, mine, theirs) {
    if (mine === theirs) return { text: mine, conflict: false }
    if (base === theirs) return { text: mine, conflict: false }
    if (base === mine) return { text: theirs, conflict: false }
    const b = base.split('\n')
    const mr = changedRange(b, mine.split('\n'))
    const tr = changedRange(b, theirs.split('\n'))
    if (mr.endBase <= tr.startBase || tr.endBase <= mr.startBase) {
      const out = b.slice()
      for (const e of [mr, tr].sort((x, y) => y.startBase - x.startBase)) out.splice(e.startBase, e.endBase - e.startBase, ...e.newLines)
      return { text: out.join('\n'), conflict: false }
    }
    const start = Math.min(mr.startBase, tr.startBase)
    const end = Math.max(mr.endBase, tr.endBase)
    const mineBlock = [...b.slice(start, mr.startBase), ...mr.newLines, ...b.slice(mr.endBase, end)]
    const theirsBlock = [...b.slice(start, tr.startBase), ...tr.newLines, ...b.slice(tr.endBase, end)]
    const out = [...b.slice(0, start), '<<<<<<< local (yours)', ...mineBlock, '=======', ...theirsBlock, '>>>>>>> incoming (theirs)', ...b.slice(end)]
    return { text: out.join('\n'), conflict: true }
  }
  // Line-anchored detection of REAL conflict markers — NOT a substring scan, so
  // a file that merely documents the markers (e.g. a README) isn't flagged.
  function hasConflictMarkers(text) { return /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text) }
  // Bring one file's disk copy and shared-doc copy into agreement via 3-way
  // merge against its last agreed base. Safe from either direction.
  const conflicted = new Set()
  function reconcile(r, origin = 'local') {
    if (SKIP.has(r) || isIgnored(r)) return // never sync secrets/ignored/coordination files
    const full = path.join(root, r)
    const yt = files.get(r)
    const disk = fs.existsSync(full) ? readText(full) : null
    const docText = yt ? yt.toString() : null
    if (disk === null && docText === null) return
    if (docText === null) {
      const t = new Y.Text(); files.set(r, t); t.insert(0, disk)
      known.add(r); bases.set(r, disk); forkBases.set(r, disk)
      try { mtimes.set(r, fs.statSync(full).mtimeMs) } catch {}
      return
    }
    if (disk === null) { writeToDisk(r, docText); bases.set(r, docText); forkBases.set(r, docText); return }
    if (disk === docText) {
      known.add(r); bases.set(r, disk)
      if (!forkBases.has(r) || origin === 'local') forkBases.set(r, disk)
      return
    }
    const base = bases.has(r) ? bases.get(r) : disk
    const fork = forkBases.has(r) ? forkBases.get(r) : base
    if (origin === 'local') { noteCoEditing(r); markEditing(r) } // broadcast activity + warn if someone else is on this file
    let res, reAdded = false
    if (origin === 'local' && hasConflictMarkers(docText) && !hasConflictMarkers(disk)) {
      // Resolving a conflict: doc has markers, this write removed them — author resolved it.
      res = { text: disk, conflict: false }
    } else if (origin === 'local') {
      noteIfRewrite(r, fork, disk) // auto-log big rewrites
      // THE FIX: merge a local edit against the FORK POINT (what this author last
      // saw), not the latest doc — so a stale rewrite re-adds another's just-arrived
      // lines (or raises a conflict) instead of silently deleting their work.
      const theirsNew = changedRange(fork.split('\n'), docText.split('\n')).newLines.filter((l) => l.length)
      const mineLines = new Set(disk.split('\n'))
      const integrated = theirsNew.every((l) => mineLines.has(l))
      if (integrated) { res = { text: disk, conflict: false } }
      else { res = merge3(fork, disk, docText); reAdded = !res.conflict && res.text !== disk }
    } else {
      res = merge3(base, disk, docText)
    }
    doc.transact(() => applyDiff(yt, res.text)) // local txn -> observer ignores
    if (res.text !== disk) writeToDisk(r, res.text)
    known.add(r); bases.set(r, res.text)
    if (origin === 'local') forkBases.set(r, res.text)
    else if (!forkBases.get(r)) forkBases.set(r, res.text) // bootstrap fork on first real remote content
    const hasMarkers = res.conflict || hasConflictMarkers(res.text)
    if (hasMarkers && !conflicted.has(r)) {
      conflicted.add(r)
      logActivity(`⚠ merge conflict in ${r} — kept BOTH (resolve <<<<<<< markers)`)
      try { say(`⚠ MERGE CONFLICT in ${r} — it has <<<<<<< markers. Whoever owns it: resolve before continuing.`) } catch { }
    } else if (!hasMarkers && conflicted.has(r)) {
      conflicted.delete(r)
      try { say(`✓ conflict in ${r} resolved.`) } catch { }
    } else if (reAdded) {
      logActivity(`protected ${r}: edit was based on an older version — re-added changes that arrived since`)
      try { say(`↺ ${r}: an edit was based on an older copy — kept the changes that landed in between (nothing lost).`) } catch { }
    } else if (!hasMarkers) {
      logActivity(`merged ${r} (both edits kept)`)
    }
  }
  // AUTO-BOARD: a local wholesale rewrite is recorded for everyone — the agent
  // doesn't have to remember; the sync layer sees the diff and logs it.
  function noteIfRewrite(r, base, next) {
    if (!base) return
    const s = summarizeChange(base, next)
    if (!s.isRewrite) return
    board.set(r, { by: me, at: new Date().toTimeString().slice(0, 8), churn: `${s.changedLines}/${s.totalLines} lines`, symbols: s.symbols })
    logActivity(`REWRITE: ${me} rewrote ${r} (${s.changedLines}/${s.totalLines} lines; touched ${s.symbols.join(', ') || 'n/a'})`)
  }
  function renderBoard() {
    const out = [
      '# Hive Board — recent full-file rewrites (auto-logged by Hivecode).',
      '# READ THIS before editing a file someone just rewrote, then re-read that file.',
      '',
    ]
    const entries = [...board.entries()].map(([file, e]) => ({ file, ...e })).sort((a, b) => (a.at < b.at ? 1 : -1))
    if (!entries.length) out.push('(no rewrites yet — patches and small edits are not listed)')
    for (const e of entries) out.push(`- ${e.at}  ${e.by} rewrote \`${e.file}\` (${e.churn}) — touched: ${(e.symbols || []).join(', ') || 'n/a'}`)
    writeToDisk(BOARD_FILE, out.join('\n') + '\n')
  }
  board.observe(() => renderBoard())

  // --- chat + directed tasks (human <-> AI coordination) ---
  const fmtTime = () => new Date().toTimeString().slice(0, 8)
  function say(textMsg) { if (textMsg) chat.push([{ by: me, kind, at: fmtTime(), text: String(textMsg) }]) }
  function renderChat() {
    const out = ['# Hive Chat — everyone (humans + AI) talks here.', '']
    for (const m of chat.toArray()) out.push(`- ${m.at}  ${m.by} (${m.kind}): ${m.text}`)
    writeToDisk('HIVE_CHAT.md', out.join('\n') + '\n')
  }
  function assign(to, textMsg) {
    if (!to || !textMsg) return
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const ownerOf = owners.get(to)
    // Asymmetric gate: AI->AI coordination (or owner directing own AI) auto-accepts;
    // any other human directing an AI stays PENDING until that AI's owner approves.
    const auto = kind === 'ai' || !ownerOf || me === ownerOf
    const status = auto ? 'accepted' : 'pending'
    const decidedBy = auto ? (kind === 'ai' ? `${me} (AI coordination)` : me) : null
    tasks.set(id, { id, to, by: me, byKind: kind, text: String(textMsg), status, decidedBy, at: fmtTime() })
    if (auto) say(`@${to}: ${textMsg}  (task ${id} — ${kind === 'ai' ? 'AI coordination, proceeding' : 'from owner, proceeding'})`)
    else say(`@${to}: ${textMsg}  (task ${id} — ${ownerOf} must approve: do it or ignore?)`)
  }
  function decide(id, accept) {
    const t = tasks.get(id); if (!t) return
    const ownerOf = owners.get(t.to)
    if (ownerOf && me !== ownerOf) { logActivity(`only ${ownerOf} can approve task ${id}`); return }
    tasks.set(id, { ...t, status: accept ? 'accepted' : 'denied', decidedBy: me })
    say(`task ${id} ${accept ? 'APPROVED' : 'denied'} by ${me}: "${t.text}"`)
  }
  function renderTasks() {
    const all = [...tasks.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
    const out = ['# Hive Tasks — directed work + approvals.', '']
    if (!all.length) out.push('(no tasks)')
    for (const t of all) out.push(`- [${t.status}] ${t.id}  ${t.by} -> ${t.to}: ${t.text}${t.decidedBy ? ` (by ${t.decidedBy})` : ''}`)
    writeToDisk('HIVE_TASKS.md', out.join('\n') + '\n')
  }
  chat.observe(() => { renderChat(); pushState() })
  tasks.observe(() => { renderTasks(); pushState() })

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
    for (const full of fulls) {
      const r = rel(full)
      if (SKIP.has(r)) continue // generated/coordination files; don't sync
      let mt
      try { mt = fs.statSync(full).mtimeMs } catch { continue }
      if (mtimes.get(r) === mt && files.has(r)) continue
      if (readText(full) === null) continue
      mtimes.set(r, mt)
      reconcile(r, 'local') // 3-way merge instead of blind overwrite
    }
    const removed = [...known].filter((r) => !onDisk.has(r) && files.has(r))
    if (removed.length) {
      doc.transact(() => {
        for (const r of removed) { files.delete(r); known.delete(r); mtimes.delete(r); bases.delete(r); forkBases.delete(r) }
      })
    }
  }

  files.observeDeep((events, txn) => {
    if (txn.local) return
    for (const ev of events) {
      if (ev.target === files) {
        ev.changes.keys.forEach((change, key) => {
          if (change.action === 'delete') { try { fs.rmSync(path.join(root, key)) } catch {}; known.delete(key); bases.delete(key); forkBases.delete(key); logActivity(`deleted ${key}`) }
          else reconcile(key, 'remote') // merge remote change with any local edits
        })
      } else {
        for (const [key, yt] of files.entries()) {
          if (yt === ev.target) { reconcile(key, 'remote'); break }
        }
      }
    }
  })

  function renderMembers() {
    const seen = new Map()
    for (const s of provider.awareness.getStates().values()) if (s.user && s.user.name) seen.set(s.user.name, s.user)
    const us = [...seen.values()]
    const now = Date.now()
    const out = ['# Hive Members — who is in this room right now (live).', '', `count: ${us.length}`, '']
    for (const u of us) {
      const ed = u.editing && now - u.editing.at < EDIT_FRESH_MS ? ` — editing ${u.editing.file}` : ''
      out.push(`- ${u.name} (${u.kind})${u.owner ? ' — owned by ' + u.owner : ''}${ed}`)
    }
    writeToDisk('HIVE_MEMBERS.md', out.join('\n') + '\n')
  }
  provider.awareness.on('change', () => {
    for (const s of provider.awareness.getStates().values()) {
      const n = s.user && s.user.name
      if (n && !seenMembers.has(n)) { seenMembers.add(n); logActivity(`${n} joined`) }
    }
    renderMembers()
    pushState()
  })

  provider.on('sync', (s) => {
    if (!s) return
    writeToDisk('HIVE_RULES.md', HIVE_RULES_TEXT) // the law is always present in the room
    for (const [key] of files.entries()) reconcile(key, 'remote') // pull + merge against local
    if (board.size) renderBoard() // surface rewrites logged before we joined
    if (chat.length) renderChat()
    if (tasks.size) renderTasks()
    scan()
    session.scanTimer = setInterval(scan, 400)
    logActivity('Synced')
    pushState()
  })

  // expose chat/task actions to the panel handler
  session = { doc, provider, root, scanTimer: null, room, relay: useRelay, me, chat, tasks, owners, say, assign, decide, stopActivity: () => { if (editingClearTimer) clearTimeout(editingClearTimer) } }
  pushState()
}

// --- the sidebar panel ---
class HivecodeViewProvider {
  resolveWebviewView(view) {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = getHtml()
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'host') hostSession()
      else if (m.type === 'join') joinSessionWithLink(m.link || '')
      else if (m.type === 'leave') leaveSession()
      else if (m.type === 'copy') {
        vscode.env.clipboard.writeText(m.text || '')
        vscode.window.showInformationMessage('Hivecode: join link copied.')
      } else if (m.type === 'say' && session) {
        // "@Name do X" -> a directed task; anything else -> a chat message
        const mm = (m.text || '').match(/^@(\S+)\s+(.+)/)
        if (mm) session.assign(mm[1], mm[2]); else session.say(m.text || '')
      } else if (m.type === 'approve' && session) session.decide(m.id, true)
      else if (m.type === 'deny' && session) session.decide(m.id, false)
      else if (m.type === 'ready') pushState()
    })
    pushState()
  }
  post(msg) { if (this.view) this.view.webview.postMessage(msg) }
}

function getHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; font-size: 13px; }
  h3 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; opacity: .7; letter-spacing: .5px; }
  button { width: 100%; padding: 7px; margin: 4px 0; border: none; border-radius: 4px; cursor: pointer;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:hover { opacity: .9; }
  input { width: 100%; box-sizing: border-box; padding: 6px; margin: 4px 0;
          background: var(--vscode-input-background); color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  .status { padding: 6px 8px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
  .on { background:#3fb950; } .off { background:#888; }
  .member { padding: 3px 0; }
  .badge { font-size: 10px; padding: 1px 5px; border-radius: 8px; margin-left: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .editing { font-size: 10px; margin-left: 6px; opacity: 0.8; color: var(--vscode-charts-green, #3fb950); }
  .link { word-break: break-all; font-size: 11px; padding: 6px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; }
  .log { font-size: 11px; line-height: 1.5; max-height: 220px; overflow:auto; opacity:.85; }
  .log div { padding: 1px 0; border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
  .hidden { display: none; }
  .mini { width: auto; padding: 1px 7px; margin: 0 2px; display: inline-block; }
</style></head><body>
  <div class="status"><span id="dot" class="dot off"></span><span id="statustext">Not in a session</span></div>

  <div id="offControls">
    <button id="host">Host a Session</button>
    <h3>Join a session</h3>
    <input id="link" placeholder="paste join link here" />
    <button id="join" class="secondary">Join</button>
  </div>

  <div id="onControls" class="hidden">
    <h3>Your join link</h3>
    <div id="hostlink" class="link"></div>
    <button id="copy" class="secondary">Copy join link</button>
    <button id="leave">Leave Session</button>
  </div>

  <h3>Members (<span id="count">0</span>)</h3>
  <div id="members"></div>

  <div id="coord" class="hidden">
    <h3>Tasks</h3>
    <div id="tasks" class="log"></div>

    <h3>Chat</h3>
    <div id="chat" class="log"></div>
    <input id="msg" placeholder="message… or @Name do X to assign a task" />
    <button id="sendmsg" class="secondary">Send</button>
  </div>

  <h3>Activity</h3>
  <div id="log" class="log"></div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
  $('host').onclick = () => send('host');
  $('leave').onclick = () => send('leave');
  $('join').onclick = () => send('join', { link: $('link').value });
  $('copy').onclick = () => send('copy', { text: $('hostlink').textContent });
  const sendMsg = () => { const v = $('msg').value.trim(); if (v) { send('say', { text: v }); $('msg').value = ''; } };
  $('sendmsg').onclick = sendMsg;
  $('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });

  window.addEventListener('message', (e) => {
    const s = e.data;
    if (!s || s.type !== 'state') return;
    $('dot').className = 'dot ' + (s.connected ? 'on' : 'off');
    $('statustext').textContent = s.connected ? ('In room ' + (s.room || '')) : 'Not in a session';
    $('offControls').className = s.connected ? 'hidden' : '';
    $('onControls').className = s.connected ? '' : 'hidden';
    $('coord').className = s.connected ? '' : 'hidden';
    $('hostlink').textContent = s.link || '';
    $('count').textContent = (s.members || []).length;
    $('members').innerHTML = (s.members || []).map((m) =>
      '<div class="member">' + escapeHtml(m.name) + '<span class="badge">' + (m.kind === 'ai' ? 'AI' : 'human') + '</span>' + (m.editing ? '<span class="editing">editing ' + escapeHtml(m.editing) + '</span>' : '') + '</div>'
    ).join('') || '<div style="opacity:.5">no one yet</div>';
    $('chat').innerHTML = (s.chat || []).map((m) =>
      '<div><b>' + escapeHtml(m.by) + '</b> <span class="badge">' + (m.kind === 'ai' ? 'AI' : 'human') + '</span>: ' + escapeHtml(m.text) + '</div>'
    ).join('') || '<div style="opacity:.5">no messages yet</div>';
    $('chat').scrollTop = $('chat').scrollHeight;
    const owners = s.owners || {};
    $('tasks').innerHTML = (s.tasks || []).map((t) => {
      let row = '<div>[' + escapeHtml(t.status) + '] <b>' + escapeHtml(t.by) + '</b> → ' + escapeHtml(t.to) + ': ' + escapeHtml(t.text);
      // Only the OWNER of the target AI may approve. If the target has no owner
      // recorded, fall back to the target themselves (a human accepting their own task).
      const approver = owners[t.to] || t.to;
      const iMayApprove = s.me && s.me === approver;
      if (t.status === 'pending') {
        if (iMayApprove) row += ' <button class="mini" data-act="approve" data-id="' + escapeHtml(t.id) + '">approve</button>'
          + '<button class="mini secondary" data-act="deny" data-id="' + escapeHtml(t.id) + '">deny</button>';
        else row += ' <span style="opacity:.6">— awaiting ' + escapeHtml(approver) + '</span>';
      }
      return row + '</div>';
    }).join('') || '<div style="opacity:.5">no tasks</div>';
    $('log').innerHTML = (s.activity || []).map((l) => '<div>' + escapeHtml(l) + '</div>').join('');
  });
  $('tasks').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    send(b.dataset.act, { id: b.dataset.id });
  });
  function escapeHtml(x){ return String(x).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  send('ready');
</script>
</body></html>`
}

function deactivate() { leaveSession() }

module.exports = { activate, deactivate }
