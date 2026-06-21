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
const PROTOCOL_VERSION = 2 // bump on incompatible wire changes; broadcast so peers can warn on mismatch
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

## Mission control
- If a human PAUSES you, finish your current step and STOP — start no new work
  until resumed. A human may reassign your focus anytime; their directive wins.

## When you get a ping mid-task (interruptions)
11. Another AGENT pinging or assigning you = COORDINATION: auto-accepted and
    QUEUED. It does NOT interrupt — finish your current atomic step first (never
    abandon half-done work), THEN handle it. If it's urgent (build broken,
    blocking others), do it now.
12. ACKNOWLEDGE the moment you see a ping so the sender isn't left hanging, e.g.
    "got it — finishing X (~2 min), then on your auth.js fix".
13. YOU triage: say whether you'll do it now or after your current step. Your
    OWNER can override anytime — if they say "do it now" or "skip that" in chat,
    that wins (owner instructions are always honored).
14. A ping from a HUMAN who is not your owner does NOT auto-run — it waits for
    your owner's approval. Keep working; your owner decides.
`

let session = null     // { doc, provider, root, scanTimer, room, relay }
let status             // status-bar item
let panel = null       // the sidebar webview provider
let secrets = null     // vscode.SecretStorage — holds room private keys invisibly
let store = null       // vscode.Memento (workspaceState) — durable invite list per room
const activity = []    // recent activity log lines (newest first)

function activate(context) {
  secrets = context.secrets
  store = context.workspaceState
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  setStatus('off')
  status.show()

  panel = new HivecodeViewProvider()

  context.subscriptions.push(
    status,
    vscode.window.registerWebviewViewProvider('hivecode.panel', panel),
    vscode.commands.registerCommand('hivecode.host', hostSession),
    vscode.commands.registerCommand('hivecode.hostSecured', hostSecuredSession),
    vscode.commands.registerCommand('hivecode.join', joinSessionPrompt),
    vscode.commands.registerCommand('hivecode.invite', inviteCommand),
    vscode.commands.registerCommand('hivecode.manage', manageCommand),
    vscode.commands.registerCommand('hivecode.leave', leaveSession),
    vscode.commands.registerCommand('hivecode.endRoom', endRoom)
  )

  // Auto-resume the LAST room for this folder, so closing/reopening the IDE drops
  // you back into the SAME room — same id, same key — and every invite link you
  // already sent keeps working. No re-hosting, no re-inviting.
  tryAutoResume()
}

// --- room persistence: <root>/.hive.json remembers the room across restarts ---
function roomCfgPath(root) { return path.join(root, '.hive.json') }
function saveRoomCfg(root, cfg) { try { fs.writeFileSync(roomCfgPath(root), JSON.stringify(cfg, null, 2)) } catch {} }
function loadRoomCfg(root) { try { return JSON.parse(fs.readFileSync(roomCfgPath(root), 'utf8')) } catch { return null } }

async function tryAutoResume() {
  if (session) return
  const folders = vscode.workspace.workspaceFolders
  if (!folders || !folders.length) return
  const root = folders[0].uri.fsPath
  const cfg = loadRoomCfg(root)
  if (!cfg || !cfg.room) return
  const relay = cfg.relay || relayUrl()
  if (cfg.secured) {
    // resume as the OWNER: reload the room's private key and re-mint a fresh owner
    // token. The room id (and its key fingerprint) are unchanged, so old invites stay valid.
    let keys = null
    try { keys = JSON.parse(await secrets.get('hive.key.' + cfg.room) || 'null') } catch {}
    if (keys && keys.privateKey) {
      const me = (vscode.workspace.getConfiguration('hivecode').get('displayName') || '').trim() || 'Owner'
      const { token: ownerTok } = mintToken(keys, cfg.room, { name: me, kind: 'human', role: 'maintainer' })
      start(root, cfg.room, relay, ownerTok)
      session.keys = keys; session.ownerToken = ownerTok; session.secured = true
      seedInvitesFromStore(cfg.room)
      logActivity('Resumed your secured room — existing invite links still work')
      pushState()
      return
    }
    // secured room but no key here (e.g. a different machine) — fall back to token if present
  }
  if (cfg.token || !cfg.secured) {
    start(root, cfg.room, relay, cfg.token || '')
    logActivity('Resumed the room')
    pushState()
  }
}

// End the room for this folder: disconnect AND forget it (so the next Host makes a
// fresh one). Leaving (hivecode.leave) only disconnects — it keeps the room so you
// can resume. This is the explicit "start over" / "kick everyone for good" action.
async function endRoom() {
  const folders = vscode.workspace.workspaceFolders
  const root = folders && folders.length ? folders[0].uri.fsPath : null
  const wasRoom = session && session.room
  leaveSession()
  if (root) {
    const cfg = loadRoomCfg(root)
    try { fs.rmSync(roomCfgPath(root)) } catch {}
    if (cfg && cfg.room) { try { await secrets.delete('hive.key.' + cfg.room) } catch {}; try { await store.update('hiveInvites:' + cfg.room, undefined) } catch {} }
  }
  if (wasRoom) vscode.window.showInformationMessage('Hivecode: room ended and forgotten. The next "Host" creates a fresh one.')
}

// Durable invite list (per room) so the Manage panel survives a restart even if the
// relay dropped the room doc while everyone was away.
function loadInvites(room) { try { return store.get('hiveInvites:' + room) || [] } catch { return [] } }
function saveInvite(room, rec) { try { store.update('hiveInvites:' + room, [...loadInvites(room), rec]) } catch {} }
function updateInvite(room, jti, patch) { try { store.update('hiveInvites:' + room, loadInvites(room).map((e) => e.jti === jti ? { ...e, ...patch } : e)) } catch {} }
function seedInvitesFromStore(room) { if (!session) return; for (const e of loadInvites(room)) { if (e.jti && !session.invites.has(e.jti)) { try { session.invites.set(e.jti, e) } catch {} } } }

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
  // One entry PER NAME, not per connection: the same user open in two windows
  // (editor + browser Control Room, both "user-1") is ONE member. `editing` may be
  // an object {file,at} (editor) or a plain string (browser) — normalize both.
  const seen = new Map()
  for (const s of session.provider.awareness.getStates().values()) {
    const u = s.user
    if (!u || !u.name) continue
    const ef = u.editing && typeof u.editing === 'object' ? (u.editing.at > fresh ? u.editing.file : null) : (u.editing || null)
    const prev = seen.get(u.name)
    seen.set(u.name, { name: u.name, kind: u.kind || (prev && prev.kind) || 'human', editing: ef || (prev && prev.editing) || null })
  }
  return [...seen.values()]
}

function pushState() {
  const baseMembers = membersList()
  setStatus(session ? 'on' : 'off', baseMembers.length)
  if (!panel) return
  const chat = session ? session.chat.toArray().slice(-50) : []
  const tasks = session ? [...session.tasks.values()].sort((a, b) => (a.at < b.at ? 1 : -1)) : []
  const owners = session ? Object.fromEntries(session.owners.entries()) : {}
  // Mission-control enrichment: each member's pause state + current task.
  const members = baseMembers.map((m) => {
    const c = session && session.controls.get(m.name)
    const mine = tasks.filter((t) => t.to === m.name)
    const active = mine.find((t) => t.status === 'accepted') || mine.find((t) => t.status === 'pending')
    return { ...m, paused: !!(c && c.state === 'paused'), task: active ? { text: active.text, status: active.status } : null }
  })
  panel.post({
    type: 'state',
    connected: !!session,
    room: session ? session.room : null,
    link: session ? `${session.relay}|${session.room}` : null,
    // The owner's own full-access link (carries the maintainer token). Used to open
    // the Control Room or rejoin; for inviting OTHERS use the scoped "Invite" flow.
    ownerLink: session && session.secured && session.ownerToken ? `${session.relay}|${session.room}|${session.ownerToken}` : null,
    me: session ? session.me : null,
    canInvite: !!(session && session.keys), // this window hosts a secured room -> can invite/manage
    secured: !!(session && session.secured),
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
  // reuse this folder's existing OPEN room if one was saved (so reopening keeps the
  // same link); only make a fresh one if there's none.
  const prev = loadRoomCfg(root)
  const room = (prev && prev.room && !prev.secured) ? prev.room : 'room-' + crypto.randomBytes(13).toString('base64url')
  const relay = relayUrl()
  start(root, room, relay)
  saveRoomCfg(root, { relay, room })
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
  // link shapes: "relay|room" (open) or "relay|room|token" (secured — token baked in).
  const [relay, room, token] = link.includes('|') ? link.split('|') : [relayUrl(), link, '']
  const r = room.trim(), rl = relay.trim(), tk = (token || '').trim()
  start(root, r, rl, tk)
  // remember it so reopening the IDE rejoins automatically (no re-pasting the link)
  saveRoomCfg(root, { relay: rl, room: r, ...(tk ? { token: tk } : {}) })
  logActivity(`Joining room ${r}`)
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

// --- SECURED hosting + folder-scoped invites (no terminal, no secret files) ---
// Host a room whose access YOU control. A keypair is generated; the private key
// lives in the editor's secure storage (never a file, never shown). The room id
// is a fingerprint of the public key, so the relay can enforce access with no
// server state. You then invite people to specific folders with one command.
async function hostSecuredSession() {
  const root = workspaceRoot()
  if (!root) return
  if (session) { vscode.window.showInformationMessage('Hivecode: already in a session — leave it first.'); return }
  // Reuse this folder's existing secured room + key if we have one (so re-hosting
  // after a close/leave keeps the SAME room — all previously-sent invite links stay
  // valid). Only generate a fresh keypair when there's none.
  const prev = loadRoomCfg(root)
  let keys = null, room = null, resumed = false
  if (prev && prev.secured && prev.room) {
    try { keys = JSON.parse(await secrets.get('hive.key.' + prev.room) || 'null') } catch {}
    if (keys && keys.privateKey) { room = prev.room; resumed = true }
  }
  if (!keys) {
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    keys = { publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }), privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) }
    room = makeSecuredRoomId(keys.publicKey, crypto.randomBytes(6).toString('hex'))
    try { await secrets.store('hive.key.' + room, JSON.stringify(keys)) } catch { /* secure store unavailable */ }
  }
  const relay = relayUrl()
  const me = (vscode.workspace.getConfiguration('hivecode').get('displayName') || '').trim() || 'Owner'
  const { token: ownerTok } = mintToken(keys, room, { name: me, kind: 'human', role: 'maintainer' }) // full access
  start(root, room, relay, ownerTok)
  session.keys = keys; session.ownerToken = ownerTok; session.secured = true // re-attach after start() rebuilt session
  seedInvitesFromStore(room)
  saveRoomCfg(root, { relay, room, secured: true })
  await vscode.env.clipboard.writeText(`${relay}|${room}|${ownerTok}`)
  logActivity(resumed ? 'Resumed your secured room — existing invite links still work' : 'Hosting a SECURED room — your full-access link is copied')
  if (resumed) vscode.window.showInformationMessage('Hivecode: resumed your secured room. Everyone\'s existing links still work.')
  else vscode.window.showInformationMessage('Hivecode: secured room is live. Use "Invite to folders…" to add people/AIs with chosen access.', 'Invite to folders…').then((c) => { if (c) inviteCommand() })
  pushState()
}

// List folders under the workspace root (relative, "/"-joined), ignoring junk and
// .gitignored dirs, capped in depth so the picker stays readable.
function listFolders(root, maxDepth = 4) {
  const out = []
  const ig = ignore().add(ALWAYS_IGNORE); try { ig.add(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')) } catch {}
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || IGNORE.has(e.name) || e.name.startsWith('.')) continue
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/')
      if (ig.ignores(rel + '/')) continue
      out.push(rel)
      walk(path.join(dir, e.name), depth + 1)
    }
  }
  walk(root, 1)
  return out.sort()
}

// Ask which folders + access level. Returns { paths, viewOnly, role } or null.
async function pickFolderAccess(kind, preselect) {
  const folders = listFolders(session.root)
  const sel = new Set((preselect || []).map((p) => p.replace(/\/\*\*$/, '')))
  const picks = await vscode.window.showQuickPick(
    [{ label: '$(globe) Whole project', v: '__all__', picked: !preselect }, ...folders.map((f) => ({ label: '$(folder) ' + f, v: f, picked: sel.has(f) }))],
    { canPickMany: true, placeHolder: 'Pick the folder(s) they may see and work in (none = whole project)' }
  )
  if (!picks) return null
  const accessPick = await vscode.window.showQuickPick([{ label: '$(edit) Can edit', v: false }, { label: '$(eye) View only', v: true }], { placeHolder: 'Access level' })
  if (!accessPick) return null
  const viewOnly = accessPick.v
  const wholeRepo = picks.length === 0 || picks.some((p) => p.v === '__all__')
  const paths = wholeRepo ? undefined : picks.filter((p) => p.v !== '__all__').map((p) => `${p.v}/**`)
  const role = viewOnly ? 'reader' : (kind === 'human' ? 'writer' : 'agent')
  return { paths, viewOnly, role }
}

// Mint + record an invite, copy its link, and announce. Returns the record.
async function issueInvite(name, kind, { paths, viewOnly, role }) {
  const { token, jti } = mintToken(session.keys, session.room, { name, kind, role, paths, owner: session.me })
  const rec = { jti, name, kind, role, paths: paths || null, viewOnly, by: session.me, at: new Date().toTimeString().slice(0, 8) }
  try { session.invites.set(jti, rec) } catch {} // live, for others
  saveInvite(session.room, rec)                  // durable for the Manage panel
  await vscode.env.clipboard.writeText(`${session.relay}|${session.room}|${token}`)
  const scopeMsg = paths ? paths.join(', ') : 'the whole project'
  logActivity(`Invite for ${name} (${role}) — ${scopeMsg}`)
  vscode.window.showInformationMessage(`Hivecode: link for ${name} copied (${viewOnly ? 'view only' : 'can edit'} — ${scopeMsg}). Send it; they paste it into Join.`)
  return rec
}

// Invite a person or AI to THIS secured room, scoped to chosen folders.
async function inviteCommand() {
  if (!session || !session.keys) { vscode.window.showWarningMessage('Hivecode: host a secured session first ("Host a Secured Session").'); return }
  const name = (await vscode.window.showInputBox({ prompt: 'Name for the invitee (person or AI)', placeHolder: 'e.g. FrontBot or Alex' }) || '').trim()
  if (!name) return
  const kindPick = await vscode.window.showQuickPick([{ label: 'AI agent', v: 'ai' }, { label: 'Human teammate', v: 'human' }], { placeHolder: 'What are you inviting?' })
  if (!kindPick) return
  const scope = await pickFolderAccess(kindPick.v)
  if (!scope) return
  await issueInvite(name, kindPick.v, scope)
}

// View who has access; revoke or RE-SCOPE anyone, anytime.
async function manageCommand() {
  if (!session || !session.keys) { vscode.window.showWarningMessage('Hivecode: only the room host can manage access.'); return }
  const entries = loadInvites(session.room) // durable list (survives restarts)
  if (!entries.length) { vscode.window.showInformationMessage('Hivecode: no invites yet. Use "Invite to folders…".'); return }
  const pick = await vscode.window.showQuickPick(
    entries.filter((e) => !e.supersededBy).map((e) => ({
      label: `${e.revoked ? '$(circle-slash) ' : ''}${e.name} — ${e.viewOnly ? 'view only' : 'can edit'}`,
      description: (e.paths ? e.paths.join(', ') : 'whole project') + (e.revoked ? '  (REVOKED)' : ''),
      e,
    })),
    { placeHolder: 'Pick someone to manage' }
  )
  if (!pick) return
  const e = pick.e
  if (e.revoked) { vscode.window.showInformationMessage(`${e.name} is already revoked.`); return }
  const action = await vscode.window.showQuickPick(
    [{ label: '$(folder) Change folders / access', v: 'rescope' }, { label: '$(trash) Revoke access', v: 'revoke' }, { label: 'Cancel', v: 'cancel' }],
    { placeHolder: `Manage ${e.name} (${e.paths ? e.paths.join(', ') : 'whole project'})` }
  )
  if (!action || action.v === 'cancel') return

  // Both revoke and re-scope first cut off the OLD grant on the relay.
  const revoke = await relayHttpPost('__hive/revoke', { room: session.room, token: session.ownerToken, jti: e.jti })
  if (!revoke.ok) { vscode.window.showErrorMessage(`Hivecode: relay didn't accept the change (${revoke.status || 'no response'}). Is the relay updated?`); return }
  try { session.invites.set(e.jti, { ...e, revoked: true }) } catch {}

  if (action.v === 'revoke') {
    updateInvite(session.room, e.jti, { revoked: true })
    logActivity(`Revoked ${e.name}`)
    vscode.window.showInformationMessage(`Hivecode: ${e.name}'s access revoked. They can no longer connect.`)
    return
  }
  // re-scope: pick new folders, issue a FRESH link (old one is now dead)
  const scope = await pickFolderAccess(e.kind, e.paths || undefined)
  if (!scope) return // they backed out — note the old grant is already revoked; they can re-invite
  updateInvite(session.room, e.jti, { revoked: true })
  const fresh = await issueInvite(e.name, e.kind, scope)
  updateInvite(session.room, e.jti, { revoked: true, supersededBy: fresh.jti })
  vscode.window.showInformationMessage(`Hivecode: ${e.name} re-scoped. Send them the NEW link (copied) — their old link no longer works.`)
}

// --- per-file-doc model + access helpers (mirrors token.js / sync.js) ---
const FILE_SEP = ''
const fileRoom = (baseRoom, relPath) => baseRoom + FILE_SEP + relPath
function decodeUnsafe(tok) {
  try { return JSON.parse(Buffer.from(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) } catch { return null }
}
function roomMatches(pattern, rm) { if (!pattern) return false; if (pattern === '*' || pattern === rm) return true; return pattern.endsWith('*') && rm.startsWith(pattern.slice(0, -1)) }
function scopeForRoom(payload, rm) {
  const s = (payload && payload.scopes) || []
  let best = null, bestScore = -1 // most specific wins: exact > longer prefix > "*"
  for (const sc of s) { if (!sc || !roomMatches(sc.room, rm)) continue; const score = sc.room === rm ? Infinity : sc.room === '*' ? 0 : sc.room.length; if (score > bestScore) { bestScore = score; best = sc } }
  return best
}
function pathAllowed(globs, relPath) {
  if (!Array.isArray(globs) || globs.length === 0) return true
  const pos = [], neg = []
  for (const g of globs) { if (typeof g !== 'string' || !g) continue; if (g[0] === '!') neg.push(g.slice(1)); else pos.push(g) }
  const matches = (pats) => pats.length > 0 && ignore().add(pats).ignores(relPath)
  return (pos.length === 0 || matches(pos)) && !matches(neg)
}
// Remote-supplied path safe to write to disk? Rejects "../" traversal, absolute
// paths, drive letters, UNC, control-char injection — so a malicious manifest
// entry can't make this window write outside its project root. (Mirrors token.js.)
function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1024) return false
  if (/[\u0000-\u001f]/.test(relPath)) return false
  const p = relPath.replace(/\\/g, '/')
  if (p.startsWith('/') || p.startsWith('//') || /^[a-zA-Z]:/.test(p)) return false
  return !p.split('/').some((seg) => seg === '..')
}
// --- secured-room minting (mirrors token.js: RS256 self-certifying rooms) ---
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function signRS256(payload, privateKeyPem) {
  const data = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(payload))
  const sig = crypto.sign('RSA-SHA256', Buffer.from(data), privateKeyPem)
  return data + '.' + b64url(sig)
}
function keyFingerprint(publicKeyPem) {
  try { return crypto.createHash('sha256').update(crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })).digest('base64url').slice(0, 22) } catch { return null }
}
const makeSecuredRoomId = (publicKeyPem, rand) => { const fp = keyFingerprint(publicKeyPem); return fp ? `hs_${fp}_${rand}` : null }
// Mint a scoped token for a secured room, signed by its private key.
function mintToken(keys, room, { name, kind, role, paths, owner, ttlSec = 7 * 86400 }) {
  const now = Math.floor(Date.now() / 1000)
  const jti = 'jti-' + crypto.randomBytes(9).toString('base64url')
  const payload = {
    iss: 'hivecode', sub: name, name, kind, ...(owner ? { owner } : {}),
    pk: keys.publicKey, // self-certifying: the relay binds this to the room id
    scopes: [{ room, role, ...(paths && paths.length ? { paths } : {}) }],
    iat: now, exp: now + ttlSec, jti,
  }
  return { token: signRS256(payload, keys.privateKey), jti }
}
// POST to the relay's control endpoint (ws(s):// -> http(s)://), for revocation.
function relayHttpPost(routePath, body) {
  return new Promise((resolve) => {
    try {
      const base = (session.relay || '').replace(/^ws/, 'http')
      const u = new URL(routePath, base.endsWith('/') ? base : base + '/')
      const lib = u.protocol === 'https:' ? require('https') : require('http')
      const data = JSON.stringify(body)
      const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { let b = ''; res.on('data', (d) => b += d); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: b })) })
      req.on('error', () => resolve({ ok: false, status: 0 }))
      req.write(data); req.end()
    } catch { resolve({ ok: false, status: 0 }) }
  })
}

// --- the sync engine (whole-folder, disk-level, mtime-optimized) ---
function start(root, room, relay, linkToken) {
  const doc = new Y.Doc()
  const manifest = doc.getMap('manifest') // relPath -> 1 (file registry); each file is its own subdoc
  const board = doc.getMap('board') // relPath -> { by, at, churn, symbols } (auto-logged rewrites)
  const chat = doc.getArray('chat') // ordered messages { by, kind, at, text }
  const tasks = doc.getMap('tasks') // id -> { id, to, by, text, status, decidedBy, at }
  const owners = doc.getMap('owners') // aiName -> ownerHumanName
  const invites = doc.getMap('invites') // jti -> { name, kind, role, paths, viewOnly, by, at, revoked } (for the Manage panel)
  const controls = doc.getMap('controls') // participantName -> { state:'running'|'paused', by, at } (mission control)
  const BOARD_FILE = 'HIVE_BOARD.md' // generated locally from `board`; never synced as a file
  const useRelay = relay || relayUrl()
  // token from the join link wins; else the hivecode.token setting (for people who
  // configure it once). A pasted secured link needs zero settings.
  const tokenCfg = (linkToken || vscode.workspace.getConfiguration('hivecode').get('token') || '').trim()
  // disableBc: relay is the ONLY sync path (else same-machine peers would bypass
  // the relay's access control via BroadcastChannel).
  const wsOpts = { WebSocketPolyfill: WebSocket, disableBc: true, params: tokenCfg ? { token: tokenCfg } : undefined }
  const provider = new WebsocketProvider(useRelay, room, doc, wsOpts)
  // Unique per window: doc.clientID is distinct even for two windows on one
  // machine (machineId was identical → both showed the same id). A configured
  // displayName wins so members read as "Jeevan"/"Friend" instead of an id.
  const cfg = vscode.workspace.getConfiguration('hivecode')
  const me = (cfg.get('displayName') || '').trim() || `user-${String(doc.clientID).slice(-4)}`
  const kind = cfg.get('participantKind') === 'ai' ? 'ai' : 'human'
  provider.awareness.setLocalStateField('user', { name: me, kind, v: PROTOCOL_VERSION })
  const known = new Set()
  const mtimes = new Map()
  const bases = new Map()  // path -> last AGREED text (common ancestor for 3-way merge)
  const forkBases = new Map() // path -> FORK POINT: what THIS author last saw/authored.
  // Advances only on local authorship / first adoption — NOT when a remote change
  // lands on disk. Stops a stale local rewrite from silently deleting another's work.

  // One sub-provider + Y.Doc per file (synced at "<room>␁<path>"), created on demand.
  const fileDocs = new Map() // relPath -> { doc, provider, text }
  function openFile(r) {
    let e = fileDocs.get(r)
    if (e) return e
    const fdoc = new Y.Doc()
    const fprovider = new WebsocketProvider(useRelay, fileRoom(room, r), fdoc, wsOpts)
    const text = fdoc.getText('content')
    // synced flips true after the first relay sync — until then an empty doc means
    // "not pulled yet", not "new file"; we must not re-seed from disk (would fork
    // the CRDT history and garble the file on rejoin).
    e = { doc: fdoc, provider: fprovider, text, synced: false }
    fileDocs.set(r, e)
    text.observe((_ev, txn) => { if (!txn.local) reconcile(r, 'remote') })
    fprovider.on('sync', (s) => { if (s) { e.synced = true; reconcile(r, 'remote') } })
    return e
  }
  function closeFile(r) { const e = fileDocs.get(r); if (!e) return; try { e.provider.destroy() } catch {} try { e.doc.destroy() } catch {} fileDocs.delete(r) }
  const fileText = (r) => { const e = fileDocs.get(r); return e ? e.text : null }
  // This window's own path scope (from its token), so it only opens files it may.
  let myPaths
  if (tokenCfg) { const pl = decodeUnsafe(tokenCfg); const sc = pl && scopeForRoom(pl, room); myPaths = sc ? sc.paths : undefined }
  // gates BOTH scope (am I granted this path?) and safety (no traversal/control-char
  // path a malicious participant slipped into the shared manifest).
  const canOpen = (r) => isSafeRelPath(r) && pathAllowed(myPaths, r)

  const seenMembers = new Set()
  // --- live activity: broadcast which file this window is editing + warn on co-editing ---
  const EDIT_FRESH_MS = 15000
  let myEditing = null, editingClearTimer = null
  const warnedAt = new Map()
  const setUserState = () => { try { provider.awareness.setLocalStateField('user', { name: me, kind, editing: myEditing || undefined, v: PROTOCOL_VERSION }) } catch {} }
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
    if (!canOpen(r)) return // out-of-scope OR unsafe path (traversal/control char) — never materialize it
    const full = path.join(root, r)
    const exists = fs.existsSync(full)
    const disk = exists ? readText(full) : null
    if (exists && disk === null) return // present but binary/too-large — leave it untouched (never clobber with stale doc text)
    // Per-file gating: know the RELAY's content before touching disk. Until the
    // file-doc has synced, an empty Y.Text means "not pulled yet", not "empty file"
    // — acting now would re-seed from disk and fork the CRDT history (garbled
    // content on rejoin). Open if needed, defer until 'sync' re-runs us; once
    // synced, "" genuinely means empty.
    let fe = fileDocs.get(r)
    if (!fe) { if (disk === null) return; openFile(r); return }
    if (!fe.synced) return
    const docText = fe.text.toString()
    if (docText === '' && !manifest.has(r)) {
      if (disk === null) return
      fe.doc.transact(() => applyDiff(fe.text, disk))
      manifest.set(r, 1)
      known.add(r); bases.set(r, disk); forkBases.set(r, disk)
      try { mtimes.set(r, fs.statSync(full).mtimeMs) } catch {}
      return
    }
    const yt = fe.text
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
    fileDocs.get(r).doc.transact(() => applyDiff(yt, res.text)) // file-doc txn -> its observer ignores
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
  // mission control: pause/resume an agent (cooperative — honored via hive_wait + rules)
  function control(target, state) {
    if (!target) return
    controls.set(target, { state: state === 'paused' ? 'paused' : 'running', by: me, at: fmtTime() })
    say(`${me} ${state === 'paused' ? '⏸ paused' : '▶ resumed'} ${target}`)
  }
  controls.observe(() => pushState())
  function renderTasks() {
    const all = [...tasks.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
    const out = ['# Hive Tasks — directed work + approvals.', '']
    if (!all.length) out.push('(no tasks)')
    for (const t of all) out.push(`- [${t.status}] ${t.id}  ${t.by} -> ${t.to}: ${t.text}${t.decidedBy ? ` (by ${t.decidedBy})` : ''}`)
    writeToDisk('HIVE_TASKS.md', out.join('\n') + '\n')
  }
  // --- ping notifications: surface @mentions + approvals so a busy human notices ---
  // Pings never interrupt the AI (it triages between steps per HIVE_RULES); this is
  // just so YOU see one mid-task without opening a file. Armed AFTER the first sync
  // so joining a room doesn't replay old history as fresh pings.
  let pingsArmed = false
  let chatSeen = 0
  const taskNotified = new Set()
  const mentionRe = new RegExp('(^|[^\\w])@' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w])', 'i')
  const openPanel = (c) => { if (c) vscode.commands.executeCommand('hivecode.panel.focus') }
  function notifyChat() {
    const msgs = chat.toArray()
    if (pingsArmed) {
      for (let i = chatSeen; i < msgs.length; i++) {
        const m = msgs[i]
        if (!m || m.by === me) continue
        if (mentionRe.test(m.text || '')) vscode.window.showInformationMessage(`Hivecode 🔔 ${m.by}: ${m.text}`, 'Open Hivecode').then(openPanel)
      }
    }
    chatSeen = msgs.length
  }
  function notifyTasks() {
    for (const t of tasks.values()) {
      if (taskNotified.has(t.id)) continue
      taskNotified.add(t.id)
      if (!pingsArmed) continue
      if (t.to === me && t.status !== 'done') vscode.window.showInformationMessage(`Hivecode 🔔 ${t.by} asked you: ${t.text}`, 'Open Hivecode').then(openPanel)
      else if (owners.get(t.to) === me && t.status === 'pending') vscode.window.showWarningMessage(`Hivecode 🔔 ${t.by} wants ${t.to} to: ${t.text} — approve?`, 'Open Hivecode').then(openPanel)
    }
  }
  chat.observe(() => { renderChat(); notifyChat(); pushState() })
  tasks.observe(() => { renderTasks(); notifyTasks(); pushState() })

  function writeToDisk(r, content) {
    if (!isSafeRelPath(r)) return // never write a path that could escape root (defense in depth)
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
      if (mtimes.get(r) === mt && manifest.has(r)) continue
      if (readText(full) === null) continue
      mtimes.set(r, mt)
      reconcile(r, 'local') // 3-way merge instead of blind overwrite
    }
    const removed = [...known].filter((r) => !onDisk.has(r) && manifest.has(r))
    if (removed.length) {
      doc.transact(() => { for (const r of removed) manifest.delete(r) })
      for (const r of removed) { closeFile(r); known.delete(r); mtimes.delete(r); bases.delete(r); forkBases.delete(r) }
    }
  }

  // Manifest changes from OTHERS: new path -> open its file-room (if in scope);
  // removed path -> tear down + delete locally.
  manifest.observe((ev, txn) => {
    if (txn.local) return
    ev.changes.keys.forEach((change, key) => {
      if (change.action === 'delete') {
        closeFile(key); try { fs.rmSync(path.join(root, key)) } catch {}
        known.delete(key); bases.delete(key); forkBases.delete(key); mtimes.delete(key)
        logActivity(`deleted ${key}`)
      } else if (canOpen(key)) {
        openFile(key)
      }
    })
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
  const versionWarned = new Set()
  provider.awareness.on('change', () => {
    for (const s of provider.awareness.getStates().values()) {
      const u = s.user
      const n = u && u.name
      if (n && !seenMembers.has(n)) { seenMembers.add(n); logActivity(`${n} joined`) }
      // warn once if a peer is on an incompatible build (else they'd silently not sync)
      if (u && n && n !== me && u.v !== PROTOCOL_VERSION && !versionWarned.has(n)) {
        versionWarned.add(n)
        vscode.window.showWarningMessage(`Hivecode: ${n} is on an incompatible version (${u.v ? 'v' + u.v : 'older build'}). Files won't sync with them until everyone updates to the latest extension.`)
      }
    }
    renderMembers()
    pushState()
  })

  provider.on('sync', (s) => {
    if (!s) return
    writeToDisk('HIVE_RULES.md', HIVE_RULES_TEXT) // the law is always present in the room
    for (const key of manifest.keys()) if (canOpen(key)) openFile(key) // connect to every file I'm granted
    if (board.size) renderBoard() // surface rewrites logged before we joined
    if (chat.length) renderChat()
    if (tasks.size) renderTasks()
    // baseline: treat everything already here as "seen", then arm pings for new ones
    chatSeen = chat.length
    for (const t of tasks.values()) taskNotified.add(t.id)
    pingsArmed = true
    scan()
    session.scanTimer = setInterval(scan, 400)
    logActivity('Synced')
    pushState()
  })

  // expose chat/task actions to the panel handler
  session = { doc, provider, root, scanTimer: null, room, relay: useRelay, me, chat, tasks, owners, invites, controls, say, assign, decide, control, stopActivity: () => { if (editingClearTimer) clearTimeout(editingClearTimer); for (const r of [...fileDocs.keys()]) closeFile(r) } }
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
      else if (m.type === 'hostSecured') hostSecuredSession()
      else if (m.type === 'invite') inviteCommand()
      else if (m.type === 'manage') manageCommand()
      else if (m.type === 'join') joinSessionWithLink(m.link || '')
      else if (m.type === 'leave') leaveSession()
      else if (m.type === 'endRoom') endRoom()
      else if (m.type === 'pause' && session) session.control(m.name, 'paused')
      else if (m.type === 'resume' && session) session.control(m.name, 'running')
      else if (m.type === 'reassign' && session) {
        vscode.window.showInputBox({ prompt: `New task for ${m.name}`, placeHolder: 'e.g. switch to fixing the login bug' }).then((txt) => { if (txt && session) session.assign(m.name, txt) })
      }
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
  :root{
    --bg:#0c0e13;--panel:#141823;--panel2:#1a1f2b;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);
    --ink:#eef1f6;--mut:#8b94a7;--dim:#5b6470;--acc:#ffb224;--acc2:#ff8a3d;--accdim:rgba(255,178,36,.14);
    --good:#3fd99a;--blue:#5b9dff;--bad:#ff6b6b;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:12px;background:var(--bg);color:var(--ink);font-size:13px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",var(--vscode-font-family),sans-serif;line-height:1.45}
  ::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--line2);border-radius:8px}
  .brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;letter-spacing:-.01em;margin:0 0 12px}
  .brand svg{width:20px;height:20px}
  h3{margin:18px 0 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;color:var(--dim);font-weight:700;display:flex;align-items:center;gap:7px}
  h3 .ct{margin-left:auto;background:rgba(255,255,255,.06);color:var(--mut);border-radius:20px;padding:0 7px;font-size:10px;letter-spacing:0}
  button{width:100%;padding:9px 12px;margin:5px 0;border:1px solid transparent;border-radius:9px;cursor:pointer;
    font-family:inherit;font-size:12.5px;font-weight:600;transition:.15s;color:var(--ink);background:rgba(255,255,255,.04);border-color:var(--line2)}
  button:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.22)}
  button.primary{background:linear-gradient(180deg,#ffc24d,var(--acc2));color:#241400;border-color:transparent;
    box-shadow:0 1px 0 rgba(255,255,255,.3) inset}
  button.primary:hover{filter:brightness(1.06)}
  button.danger{color:var(--mut)}button.danger:hover{border-color:var(--bad);color:#ffb3b3;background:rgba(255,107,107,.08)}
  input{width:100%;padding:9px 11px;margin:5px 0;background:#0a0c10;color:var(--ink);font-size:12.5px;
    border:1px solid var(--line2);border-radius:9px;font-family:inherit}
  input:focus{outline:none;border-color:var(--acc)}
  input.mono{font-family:var(--mono);font-size:11.5px}

  .status{display:flex;align-items:center;gap:8px;padding:9px 12px;border-radius:10px;font-size:12.5px;font-weight:600;
    background:var(--panel);border:1px solid var(--line)}
  .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
  .on{background:var(--good);box-shadow:0 0 8px var(--good)}.off{background:var(--dim)}
  .status .rm{color:var(--mut);font-weight:400;font-family:var(--mono);font-size:11px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%}

  .linkbox{display:flex;gap:6px;align-items:center}
  .link{flex:1;word-break:break-all;font-size:10.5px;font-family:var(--mono);padding:8px 10px;background:#0a0c10;
    border:1px solid var(--line);border-radius:9px;color:var(--mut);max-height:60px;overflow:auto}
  .icp{width:auto;padding:8px 10px;margin:0;flex:0 0 auto}

  .card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:11px;margin-bottom:8px}
  .mtop{display:flex;align-items:center;gap:9px}
  .av{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;font-weight:700;font-size:11px;color:#0a0c10;flex:0 0 auto}
  .mname{font-weight:650;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .kind{font-size:9px;font-weight:700;padding:1px 6px;border-radius:5px;text-transform:uppercase;letter-spacing:.04em}
  .kind.ai{background:var(--accdim);color:var(--acc)}.kind.human{background:rgba(63,217,154,.14);color:var(--good)}
  .pz{font-size:9px;font-weight:700;color:var(--acc);background:var(--accdim);padding:1px 6px;border-radius:5px}
  .editing{font-size:10.5px;color:var(--dim);font-family:var(--mono);margin-top:3px}
  .editing b{color:var(--blue);font-weight:600}
  .sub{font-size:11px;color:var(--mut);margin-top:5px}
  .ctl{display:flex;gap:6px;margin-top:9px}
  .ctl button{margin:0;padding:5px 8px;font-size:11px}

  .task .tflow{font-size:10px;color:var(--dim);margin-bottom:4px}.task .tflow b{color:var(--mut)}
  .tst{font-size:9px;font-weight:700;padding:2px 7px;border-radius:6px;text-transform:uppercase;letter-spacing:.04em;display:inline-block;margin-top:7px}
  .tst.pending{background:var(--accdim);color:var(--acc)}.tst.accepted,.tst.done{background:rgba(63,217,154,.14);color:var(--good)}.tst.denied{background:rgba(255,107,107,.14);color:#ff9a9a}
  .tact{display:flex;gap:6px;margin-top:8px}.tact button{margin:0;padding:5px 8px;font-size:11px}
  .tact .ok{color:var(--good)}.tact .ok:hover{border-color:var(--good)}
  .await{font-size:10.5px;color:var(--dim);margin-top:7px}

  .chat{max-height:200px;overflow:auto}
  .cmsg{padding:6px 0;border-bottom:1px solid var(--line);font-size:12.5px}
  .cmsg:last-child{border:0}
  .cby{font-weight:650;font-size:11.5px}.ctext{color:var(--mut);margin-top:1px;word-break:break-word}
  .log{font-size:11px;font-family:var(--mono);line-height:1.6;max-height:160px;overflow:auto;color:var(--mut)}
  .log div{padding:2px 0;border-bottom:1px solid var(--line)}
  .empty{color:var(--dim);font-size:11.5px;text-align:center;padding:14px 8px}
  .note{font-size:10.5px;color:var(--dim);margin:6px 2px 0;line-height:1.5}
  .note b{color:var(--acc)}
  .hidden{display:none}
</style></head><body>
  <div class="brand">
    <svg viewBox="0 0 24 24" fill="none"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc24d"/><stop offset="1" stop-color="#ff8a3d"/></linearGradient></defs><path d="M12 2.6l8.2 4.75v9.3L12 21.4 3.8 16.65v-9.3z" stroke="url(#lg)" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 7.4l4 2.3v4.6L12 16.6 8 14.3V9.7z" fill="url(#lg)" fill-opacity=".25" stroke="url(#lg)" stroke-width="1.4" stroke-linejoin="round"/></svg>
    Hivecode
  </div>
  <div class="status"><span id="dot" class="dot off"></span><span id="statustext">Not in a session</span><span id="roomlbl" class="rm"></span></div>

  <div id="offControls">
    <button id="hostSecured" class="primary" style="margin-top:12px">Host a Secured Session</button>
    <button id="host">Host an Open Session</button>
    <h3>Join a session</h3>
    <input id="link" class="mono" placeholder="paste join link here" />
    <button id="join">Join room</button>
  </div>

  <div id="onControls" class="hidden">
    <div id="inviteControls" class="hidden">
      <h3>People &amp; access</h3>
      <button id="invite" class="primary">Invite to folders…</button>
      <button id="manage">Manage access</button>
    </div>
    <h3 id="linklbl">Your join link</h3>
    <div class="linkbox"><div id="hostlink" class="link"></div><button id="copy" class="icp" title="Copy">Copy</button></div>
    <div id="linknote" class="note hidden"></div>
    <button id="leave" style="margin-top:8px">Leave (keeps the room)</button>
    <button id="endRoom" class="danger">End room &amp; forget</button>
  </div>

  <h3>Members <span id="count" class="ct">0</span></h3>
  <div id="members"></div>

  <div id="coord" class="hidden">
    <h3>Tasks <span id="taskct" class="ct">0</span></h3>
    <div id="tasks"></div>

    <h3>Chat <span id="chatct" class="ct">0</span></h3>
    <div id="chat" class="chat"></div>
    <input id="msg" placeholder="message… or @Name do X to assign" />
    <button id="sendmsg" class="primary">Send</button>
  </div>

  <h3>Activity</h3>
  <div id="log" class="log"></div>

<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const send = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
  const COLORS = ['#3fd99a','#ffb224','#5b9dff','#a78bfa','#ff6fae','#ff8a3d','#4dd0e1','#f06292'];
  const colorFor = (s) => { let h=0; for (const c of String(s||'')) h=(h*31+c.charCodeAt(0))>>>0; return COLORS[h%COLORS.length]; };
  const initials = (s) => String(s||'?').replace(/[^a-zA-Z0-9]/g,'').slice(0,2).toUpperCase() || '?';
  $('host').onclick = () => send('host');
  $('hostSecured').onclick = () => send('hostSecured');
  $('invite').onclick = () => send('invite');
  $('manage').onclick = () => send('manage');
  $('leave').onclick = () => send('leave');
  $('endRoom').onclick = () => send('endRoom');
  $('join').onclick = () => send('join', { link: $('link').value });
  $('copy').onclick = () => send('copy', { text: $('hostlink').textContent });
  const sendMsg = () => { const v = $('msg').value.trim(); if (v) { send('say', { text: v }); $('msg').value = ''; } };
  $('sendmsg').onclick = sendMsg;
  $('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });

  window.addEventListener('message', (e) => {
    const s = e.data;
    if (!s || s.type !== 'state') return;
    $('dot').className = 'dot ' + (s.connected ? 'on' : 'off');
    $('statustext').textContent = s.connected ? 'Connected' : 'Not in a session';
    $('roomlbl').textContent = s.connected ? (s.room || '') : '';
    $('offControls').className = s.connected ? 'hidden' : '';
    $('onControls').className = s.connected ? '' : 'hidden';
    $('inviteControls').className = s.canInvite ? '' : 'hidden';
    $('coord').className = s.connected ? '' : 'hidden';
    // Secured rooms need a token in the link; show the owner's full-access link so
    // Copy always yields a WORKING link. Open rooms use the plain relay|room link.
    if (s.secured && s.ownerLink) {
      $('hostlink').textContent = s.ownerLink;
      $('linklbl').textContent = 'Your owner link (full access)';
      $('linknote').className = 'note';
      $('linknote').innerHTML = 'Use this to open the <b>Control Room</b> or rejoin. Don\\'t share it — invite others with scoped access via “Invite to folders…”.';
    } else {
      $('hostlink').textContent = s.link || '';
      $('linklbl').textContent = 'Your join link';
      $('linknote').className = 'note hidden';
    }
    $('count').textContent = (s.members || []).length;
    $('members').innerHTML = (s.members || []).map((m) => {
      const isAI = m.kind === 'ai', me = s.me;
      let row = '<div class="card"><div class="mtop">'
        + '<div class="av" style="background:' + colorFor(m.name) + '">' + initials(m.name) + '</div>'
        + '<div style="min-width:0"><div class="mname">' + escapeHtml(m.name)
        + '<span class="kind ' + (isAI?'ai':'human') + '">' + (isAI?'AI':'human') + '</span>'
        + (m.paused ? '<span class="pz">paused</span>' : '') + '</div>'
        + (m.editing ? '<div class="editing">editing <b>' + escapeHtml(m.editing) + '</b></div>' : '<div class="editing">idle</div>')
        + '</div></div>';
      if (m.task) row += '<div class="sub">' + (m.task.status === 'pending' ? '⌛ ' : '▸ ') + escapeHtml(m.task.text) + '</div>';
      if (isAI && m.name !== me) {
        row += '<div class="ctl">'
          + (m.paused
            ? '<button data-mact="resume" data-name="' + escapeHtml(m.name) + '">▸ Resume</button>'
            : '<button data-mact="pause" data-name="' + escapeHtml(m.name) + '">⏸ Pause</button>')
          + '<button data-mact="reassign" data-name="' + escapeHtml(m.name) + '">Reassign</button>'
          + '</div>';
      }
      return row + '</div>';
    }).join('') || '<div class="empty">No one connected yet.</div>';

    $('chatct').textContent = (s.chat || []).length;
    $('chat').innerHTML = (s.chat || []).map((m) =>
      '<div class="cmsg"><span class="cby" style="color:' + colorFor(m.by) + '">' + escapeHtml(m.by) + '</span> '
      + '<span class="kind ' + (m.kind==='ai'?'ai':'human') + '">' + (m.kind==='ai'?'AI':'human') + '</span>'
      + '<div class="ctext">' + escapeHtml(m.text) + '</div></div>'
    ).join('') || '<div class="empty">No messages yet.</div>';
    $('chat').scrollTop = $('chat').scrollHeight;

    const owners = s.owners || {};
    $('taskct').textContent = (s.tasks || []).length;
    $('tasks').innerHTML = (s.tasks || []).map((t) => {
      const st = (t.status||'pending').toLowerCase();
      const approver = owners[t.to] || t.to;
      const iMayApprove = s.me && s.me === approver;
      let row = '<div class="card task"><div class="tflow"><b>' + escapeHtml(t.by) + '</b> → <b>' + escapeHtml(t.to) + '</b></div>'
        + '<div>' + escapeHtml(t.text) + '</div><span class="tst ' + st + '">' + escapeHtml(st) + '</span>';
      if (st === 'pending') {
        if (iMayApprove) row += '<div class="tact"><button class="ok" data-act="approve" data-id="' + escapeHtml(t.id) + '">Approve</button>'
          + '<button class="danger" data-act="deny" data-id="' + escapeHtml(t.id) + '">Deny</button></div>';
        else row += '<div class="await">awaiting ' + escapeHtml(approver) + '</div>';
      }
      return row + '</div>';
    }).join('') || '<div class="empty">No tasks yet.</div>';

    $('log').innerHTML = (s.activity || []).map((l) => '<div>' + escapeHtml(l) + '</div>').join('') || '<div class="empty">No activity yet.</div>';
  });
  $('tasks').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    send(b.dataset.act, { id: b.dataset.id });
  });
  $('members').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mact]'); if (!b) return;
    send(b.dataset.mact, { name: b.dataset.name });
  });
  function escapeHtml(x){ return String(x).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  send('ready');
</script>
</body></html>`
}

function deactivate() { leaveSession() }

module.exports = { activate, deactivate }
