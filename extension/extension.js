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

const IGNORE = new Set(['node_modules', '.git', '.vscode'])
const MAX_BYTES = 1_000_000
// generated/coordination files — never synced as ordinary files
const SKIP = new Set(['HIVE_BOARD.md', 'HIVE_CHAT.md', 'HIVE_RULES.md', '.hive.json'])
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
  return [...session.provider.awareness.getStates().values()]
    .map((s) => s.user)
    .filter(Boolean)
    .map((u) => ({ name: u.name, kind: u.kind || 'human' }))
}

function pushState() {
  const members = membersList()
  setStatus(session ? 'on' : 'off', members.length)
  if (!panel) return
  panel.post({
    type: 'state',
    connected: !!session,
    room: session ? session.room : null,
    link: session ? `${session.relay}|${session.room}` : null,
    members,
    activity,
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
  const seenMembers = new Set()

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
  // Bring one file's disk copy and shared-doc copy into agreement via 3-way
  // merge against its last agreed base. Safe from either direction.
  function reconcile(r, origin = 'local') {
    if (SKIP.has(r)) return // generated/coordination files are never synced
    const full = path.join(root, r)
    const yt = files.get(r)
    const disk = fs.existsSync(full) ? readText(full) : null
    const docText = yt ? yt.toString() : null
    if (disk === null && docText === null) return
    if (docText === null) {
      const t = new Y.Text(); files.set(r, t); t.insert(0, disk)
      known.add(r); bases.set(r, disk)
      try { mtimes.set(r, fs.statSync(full).mtimeMs) } catch {}
      return
    }
    if (disk === null) { writeToDisk(r, docText); bases.set(r, docText); return }
    if (disk === docText) { known.add(r); bases.set(r, disk); return }
    const base = bases.has(r) ? bases.get(r) : disk
    if (origin === 'local') noteIfRewrite(r, base, disk) // auto-log big rewrites
    const res = merge3(base, disk, docText)
    doc.transact(() => applyDiff(yt, res.text)) // local txn -> observer ignores
    if (res.text !== disk) writeToDisk(r, res.text)
    known.add(r); bases.set(r, res.text)
    logActivity(res.conflict ? `merge conflict in ${r} — kept BOTH (resolve <<<<<<< markers)` : `merged ${r} (both edits kept)`)
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
        for (const r of removed) { files.delete(r); known.delete(r); mtimes.delete(r); bases.delete(r) }
      })
    }
  }

  files.observeDeep((events, txn) => {
    if (txn.local) return
    for (const ev of events) {
      if (ev.target === files) {
        ev.changes.keys.forEach((change, key) => {
          if (change.action === 'delete') { try { fs.rmSync(path.join(root, key)) } catch {}; known.delete(key); bases.delete(key); logActivity(`deleted ${key}`) }
          else reconcile(key, 'remote') // merge remote change with any local edits
        })
      } else {
        for (const [key, yt] of files.entries()) {
          if (yt === ev.target) { reconcile(key, 'remote'); break }
        }
      }
    }
  })

  provider.awareness.on('change', () => {
    for (const s of provider.awareness.getStates().values()) {
      const n = s.user && s.user.name
      if (n && !seenMembers.has(n)) { seenMembers.add(n); logActivity(`${n} joined`) }
    }
    pushState()
  })

  provider.on('sync', (s) => {
    if (!s) return
    writeToDisk('HIVE_RULES.md', HIVE_RULES_TEXT) // the law is always present in the room
    for (const [key] of files.entries()) reconcile(key, 'remote') // pull + merge against local
    if (board.size) renderBoard() // surface rewrites logged before we joined
    scan()
    session.scanTimer = setInterval(scan, 400)
    logActivity('Synced')
  })

  session = { doc, provider, root, scanTimer: null, room, relay: useRelay }
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
      } else if (m.type === 'ready') pushState()
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
  .link { word-break: break-all; font-size: 11px; padding: 6px; background: var(--vscode-textBlockQuote-background); border-radius: 4px; }
  .log { font-size: 11px; line-height: 1.5; max-height: 220px; overflow:auto; opacity:.85; }
  .log div { padding: 1px 0; border-bottom: 1px solid var(--vscode-editorWidget-border, transparent); }
  .hidden { display: none; }
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

  window.addEventListener('message', (e) => {
    const s = e.data;
    if (!s || s.type !== 'state') return;
    $('dot').className = 'dot ' + (s.connected ? 'on' : 'off');
    $('statustext').textContent = s.connected ? ('In room ' + (s.room || '')) : 'Not in a session';
    $('offControls').className = s.connected ? 'hidden' : '';
    $('onControls').className = s.connected ? '' : 'hidden';
    $('hostlink').textContent = s.link || '';
    $('count').textContent = (s.members || []).length;
    $('members').innerHTML = (s.members || []).map((m) =>
      '<div class="member">' + escapeHtml(m.name) + '<span class="badge">' + (m.kind === 'ai' ? 'AI' : 'human') + '</span></div>'
    ).join('') || '<div style="opacity:.5">no one yet</div>';
    $('log').innerHTML = (s.activity || []).map((l) => '<div>' + escapeHtml(l) + '</div>').join('');
  });
  function escapeHtml(x){ return String(x).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  send('ready');
</script>
</body></html>`
}

function deactivate() { leaveSession() }

module.exports = { activate, deactivate }
