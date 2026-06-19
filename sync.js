// Hivecode sync engine — the reusable core both the human client (folder.js)
// and the autonomous agent client (hive-agent.js) run on. This is also the seed
// of the public SDK: any tool or AI agent can `startSync(...)` to become a
// first-class participant in a room — no human setup required.
//
//   startSync({ relay, room, dir, name, kind, log }) -> { doc, provider, stop }
//
// `kind` is the participant's identity ('human' | 'ai'). It is set BY WHOEVER
// STARTS THE CLIENT — a human editor passes 'human', an agent passes 'ai' — so
// nobody has to manually "declare" anything; the identity is implicit in which
// client is run.
//
// Every change (disk->doc and doc->disk) goes through reconcile(): a 3-way merge
// against each file's last agreed base, so disjoint edits merge, same-line edits
// get conflict markers (nobody's work is silently lost), and wholesale rewrites
// are auto-logged to a shared board (HIVE_BOARD.md) for other agents to read.

import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import ignore from 'ignore'
import { applyDiff, merge3, summarizeChange, changedRange, hasConflictMarkers } from './core.js'

// Never sync these, even if not in .gitignore — secrets and obvious junk. This
// prevents pushing a teammate's .env / private keys / build output to the room.
const ALWAYS_IGNORE = [
  '.git/', 'node_modules/',
  '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', 'id_rsa', 'id_ed25519', '*.keystore',
  '*.log', '.DS_Store', 'Thumbs.db', '*.vsix',
]

const IGNORE = new Set(['node_modules', '.git'])
const MAX_BYTES = 1_000_000
const BOARD_FILE = 'HIVE_BOARD.md' // generated locally from `board`; never synced as a file
const CHAT_FILE = 'HIVE_CHAT.md'   // generated locally from `chat`; the agents' conversation
const TASKS_FILE = 'HIVE_TASKS.md' // generated locally from `tasks`; directed work + approvals
const CONFIG_FILE = '.hive.json'   // local rendezvous config (room id); not synced
const RULES_FILE = 'HIVE_RULES.md' // the law every participant follows; written into every room
const MEMBERS_FILE = 'HIVE_MEMBERS.md' // live presence: who is in the room right now
// Generated/coordination files are rendered locally from CRDT state — never
// synced as ordinary files (that would cause echo loops / conflicts).
const SKIP = new Set([BOARD_FILE, CHAT_FILE, TASKS_FILE, CONFIG_FILE, RULES_FILE, MEMBERS_FILE])

// The hive's law. Auto-written into every room folder so it is ALWAYS present —
// no setup, no relying on an agent to remember it. The sync layer enforces the
// hard parts (merge, board); this is the rest, in plain imperative language.
const HIVE_RULES_TEXT = `# HIVE RULES — read this first. Everyone in this room (human or AI) follows these.

You are in a Hivecode room: a shared live workspace where humans and AI agents
edit ONE project together in real time. These rules keep anyone from destroying
another's work. The sync layer enforces the hard parts automatically; you do the rest.

## Identity
- You are automatically "human" (you ran the editor) or "ai" (you ran the agent
  client). Nobody declares it — running the client is the declaration.

## Know who you are working with
- Read HIVE_MEMBERS.md — who (humans + AIs) is in the room right now, and how many.

## Before you touch a file
1. Read HIVE_CHAT.md — what is everyone doing right now.
2. Read HIVE_BOARD.md — which files were just rewritten (and what was touched).
3. If a file you plan to edit appears there, RE-READ it before changing it.

## While you work
4. ANNOUNCE first: post to chat what you are taking, e.g.
   node hive-say.js <yourName> "taking auth.js: adding login validation"
5. PREFER SMALL PATCHES — grep to the spot, edit a few lines. Patches from
   different agents merge automatically with no conflict.
6. AVOID full-file rewrites unless necessary. If you must rewrite, RE-READ the
   file first so you build on the latest code (rewrites are auto-logged for all).
7. STAY IN YOUR LANE — if someone said "I own X" (e.g. the backend), read X but
   do not edit it; leave that to the owner.

## When things collide
8. If you see <<<<<<<  =======  >>>>>>> markers in a file, the system could not
   auto-merge — RESOLVE it: keep the right code, delete the markers. Never ignore
   them or blindly overwrite.
9. If your edit was merged/reworked, that is normal — re-read and continue.

## Talking
10. Coordinate in chat. ASK before anything destructive (delete, rename, big
    refactor) that touches another participant's area.

## Directed work + permission (the asymmetric gate)
11. AI -> AI is COORDINATION: if another agent hands you work, it is auto-accepted
    and you may proceed. This is how the hive plans and divides work by itself.
12. A HUMAN directing you is different. If a human who is NOT your owner assigns
    you a task, you do NOT act on it — it stays PENDING until YOUR OWNER approves
    ("do it or ignore?"). Your own owner's requests proceed. Act only on tasks
    whose status is 'accepted'.
13. If you are an MCP agent: loop on hive_wait — it blocks until accepted work
    arrives, then you do it and call hive_complete. No need to poll. A pending
    human request will NOT wake you until your owner approves it.

Read → announce → patch → respect lanes → resolve conflicts → talk → wait for approval.
`

export function startSync({ relay = 'ws://localhost:1234', room = 'default', dir = '.', name = 'anon', kind = 'human', owner = '', log = console.log, syncFiles = true }) {
  const ROOT = path.resolve(dir)
  fs.mkdirSync(ROOT, { recursive: true })

  // Respect .gitignore (+ always-ignore secrets/junk) so we never sync a
  // teammate's .env, keys, or build output. Reloaded by reloadIgnores().
  let ig = ignore()
  function reloadIgnores() {
    ig = ignore().add(ALWAYS_IGNORE)
    try { ig.add(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')) } catch { /* no .gitignore */ }
  }
  reloadIgnores()
  const isIgnored = (relPath) => !!relPath && ig.ignores(relPath)

  const doc = new Y.Doc()
  const files = doc.getMap('files') // relPath -> Y.Text
  const board = doc.getMap('board') // relPath -> { by, at, churn, symbols }
  const chat = doc.getArray('chat') // ordered coordination messages { by, kind, at, text }
  const tasks = doc.getMap('tasks') // id -> { id, to, by, text, status, decidedBy, at } directed work
  const owners = doc.getMap('owners') // aiName -> ownerHumanName (who may approve its tasks)
  const provider = new WebsocketProvider(relay, room, doc, { WebSocketPolyfill: WebSocket })
  provider.awareness.setLocalStateField('user', { name, kind, owner: owner || undefined }) // identity is implicit in the client
  if (kind === 'ai' && owner) owners.set(name, owner) // record who is allowed to approve my tasks

  const known = new Set()
  const mtimes = new Map()
  const bases = new Map()      // last synced content per file (advances on every reconcile)
  const forkBases = new Map()  // FORK POINT: what THIS author last saw/authored per file.
  // forkBases advances only on local authorship / first adoption — NOT when a
  // remote change is auto-applied to disk. That distinction is what stops a stale
  // local full-file paste from silently deleting another participant's just-arrived
  // work (it would look like a deliberate deletion against an up-to-date base).

  const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/')
  function walk(d, acc = []) {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return acc }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue
      const full = path.join(d, e.name)
      const r = rel(full)
      if (e.isDirectory()) { if (!isIgnored(r + '/')) walk(full, acc) }      // prune ignored dirs
      else if (e.isFile()) { if (!isIgnored(r)) acc.push(full) }             // skip ignored/secret files
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
  function writeToDisk(relPath, content) {
    const full = path.join(ROOT, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    known.add(relPath)
    try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
  }

  const conflicted = new Set() // files currently holding unresolved <<<<<<< markers
  function reconcile(relPath, origin = 'local') {
    if (SKIP.has(relPath) || isIgnored(relPath)) return // never sync secrets/ignored files
    const full = path.join(ROOT, relPath)
    const yt = files.get(relPath)
    const disk = fs.existsSync(full) ? readText(full) : null
    const docText = yt ? yt.toString() : null
    if (disk === null && docText === null) return
    if (docText === null) {
      const t = new Y.Text(); files.set(relPath, t); t.insert(0, disk)
      known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk)
      try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
      return
    }
    if (disk === null) { writeToDisk(relPath, docText); bases.set(relPath, docText); forkBases.set(relPath, docText); return }
    if (disk === docText) {
      known.add(relPath); bases.set(relPath, disk)
      // disk and doc already agree — a safe fork point, but only adopt it as
      // THIS author's fork on first sight or our own local activity (a remote
      // change landing on disk doesn't mean the local author has seen it).
      if (!forkBases.has(relPath) || origin === 'local') forkBases.set(relPath, disk)
      return
    }
    const base = bases.has(relPath) ? bases.get(relPath) : disk
    const fork = forkBases.has(relPath) ? forkBases.get(relPath) : base
    if (origin === 'local') { noteCoEditing(relPath); markEditing(relPath) } // broadcast activity + warn if someone else is on this file

    let res, reAdded = false
    if (origin === 'local' && hasConflictMarkers(docText) && !hasConflictMarkers(disk)) {
      // Resolving a conflict: the doc still has <<<<<<< markers and this local
      // write removed them — the author has resolved it. Their clean version wins.
      res = { text: disk, conflict: false }
    } else if (origin === 'local') {
      noteIfRewrite(relPath, fork, disk)
      // THE FIX. Merge a local edit against the FORK POINT (what this author
      // last saw), not the latest doc. If the doc gained lines since the fork
      // that this write does NOT contain, the author was working from a stale
      // copy — merging against the fork re-adds those lines (disjoint) or raises
      // a conflict (overlap) instead of silently deleting another's work.
      const theirsNew = changedRange(fork.split('\n'), docText.split('\n')).newLines.filter((l) => l.length)
      const mineLines = new Set(disk.split('\n'))
      const integrated = theirsNew.every((l) => mineLines.has(l)) // this write already contains the remote change
      if (integrated) {
        res = { text: disk, conflict: false } // author built on the latest — trust it
      } else {
        res = merge3(fork, disk, docText)
        reAdded = !res.conflict && res.text !== disk // we restored remote lines a stale write had dropped
      }
    } else {
      res = merge3(base, disk, docText) // incoming remote change merged into our working copy
    }

    doc.transact(() => applyDiff(yt, res.text))
    if (res.text !== disk) writeToDisk(relPath, res.text)
    known.add(relPath); bases.set(relPath, res.text)
    if (origin === 'local') forkBases.set(relPath, res.text) // we authored this state; it's our new fork
    else if (!forkBases.get(relPath)) forkBases.set(relPath, res.text) // bootstrap: first real content a joining client receives is its fork
    // Conflict guard: announce a NEW conflict in chat (so everyone — and any
    // agent on hive_wait — is alerted), and announce when it's later resolved.
    const hasMarkers = res.conflict || hasConflictMarkers(res.text)
    if (hasMarkers && !conflicted.has(relPath)) {
      conflicted.add(relPath)
      log(`[${name}] ⚠ merge conflict in ${relPath} — kept BOTH versions with <<<<<<< markers`)
      try { say(`⚠ MERGE CONFLICT in ${relPath} — it has <<<<<<< markers. Whoever owns it: resolve before continuing.`) } catch { }
    } else if (!hasMarkers && conflicted.has(relPath)) {
      conflicted.delete(relPath)
      try { say(`✓ conflict in ${relPath} resolved.`) } catch { }
    } else if (reAdded) {
      log(`[${name}] protected ${relPath}: your edit was based on an older version — re-added changes that arrived since (nobody's work lost)`)
      try { say(`↺ ${relPath}: ${name}'s edit was based on an older copy — kept the changes that landed in between (nothing lost).`) } catch { }
    } else if (!hasMarkers) {
      log(`[${name}] merged ${relPath} (both edits kept)`)
    }
  }

  const fmtTime = () => new Date().toTimeString().slice(0, 8)
  function noteIfRewrite(relPath, base, next) {
    if (!base) return
    const s = summarizeChange(base, next)
    if (!s.isRewrite) return
    board.set(relPath, { by: name, at: fmtTime(), churn: `${s.changedLines}/${s.totalLines} lines`, symbols: s.symbols })
    log(`[${name}] board: logged REWRITE of ${relPath} (${s.changedLines}/${s.totalLines} lines; touched ${s.symbols.join(', ') || 'n/a'})`)
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
  if (syncFiles) board.observe(() => renderBoard())

  // --- coordination channel: the agents (and humans) talk to each other ---
  // say() posts a message into the shared, ordered chat. Everyone renders the
  // whole conversation to HIVE_CHAT.md locally, so an agent just READS that file
  // to see what others are doing and APPENDS via say() (or `node hive-say.js`).
  function say(text) {
    if (!text) return
    chat.push([{ by: name, kind, at: fmtTime(), text: String(text) }])
  }
  function renderChat() {
    const out = [
      '# Hive Chat — the live coordination channel for everyone in this room.',
      '# Humans and AI agents talk here. Agents: READ this before/while working,',
      '# and announce what you are about to do (e.g. "taking auth.js: add login").',
      '',
    ]
    for (const m of chat.toArray()) out.push(`- ${m.at}  ${m.by} (${m.kind}): ${m.text}`)
    writeToDisk(CHAT_FILE, out.join('\n') + '\n')
  }
  if (syncFiles) chat.observe(() => renderChat())

  // --- directed work + permission ---
  // ASYMMETRIC gate (this is the rule that makes a hive both autonomous AND safe):
  //  - AI -> AI  = COORDINATION. Agents plan and hand work to each other freely;
  //    these tasks are auto-accepted so the hive flows without a human in the loop.
  //  - owner -> own AI = the owner directing their own agent; auto-accepted.
  //  - any OTHER human -> AI = a human telling someone else's agent what to do.
  //    This does NOT auto-run. It stays PENDING until that AI's OWNER says
  //    "do it or ignore" (decide). The agent acts only on 'accepted' tasks.
  // So agents coordinate among themselves, but a human can never make an agent
  // act without that agent's owner approving it.
  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  function assign(to, text) {
    if (!to || !text) return null
    const id = newId()
    const ownerOf = owners.get(to)
    // auto-accept when it's AI->AI coordination, the target has no owner to ask,
    // or the asker IS the target's owner. Otherwise it needs owner approval.
    const auto = kind === 'ai' || !ownerOf || name === ownerOf
    const status = auto ? 'accepted' : 'pending'
    const decidedBy = auto ? (kind === 'ai' ? `${name} (AI coordination)` : name) : null
    tasks.set(id, { id, to, by: name, byKind: kind, text: String(text), status, decidedBy, at: fmtTime() })
    if (auto) say(`@${to}: ${text}  (task ${id} — ${kind === 'ai' ? 'AI coordination, proceeding' : 'from owner, proceeding'})`)
    else say(`@${to}: ${text}  (task ${id} — ${ownerOf} must approve: do it or ignore?)`)
    return id
  }
  function decide(id, accept, by = name) {
    const t = tasks.get(id)
    if (!t) return { error: 'no such task' }
    const ownerOf = owners.get(t.to)
    if (ownerOf && by !== ownerOf) return { error: `only ${ownerOf} (owner of ${t.to}) can approve task ${id}` }
    tasks.set(id, { ...t, status: accept ? 'accepted' : 'denied', decidedBy: by })
    say(`task ${id} ${accept ? 'APPROVED' : 'denied'} by ${by}: "${t.text}"`)
    return { ok: true }
  }
  function complete(id, note = '') {
    const t = tasks.get(id); if (!t) return { error: 'no such task' }
    tasks.set(id, { ...t, status: 'done', decidedBy: t.decidedBy })
    say(`task ${id} done by ${name}${note ? ': ' + note : ''}`)
    return { ok: true }
  }
  const myTasks = () => [...tasks.values()].filter((t) => t.to === name)
  function renderTasks() {
    const all = [...tasks.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
    const out = ['# Hive Tasks — directed work and approvals.', '# AI->AI = auto-accepted coordination. A non-owner human\'s request to an AI', '# stays PENDING until that AI\'s owner approves (do it or ignore).', '']
    if (!all.length) out.push('(no tasks)')
    for (const t of all) out.push(`- [${t.status}] ${t.id}  ${t.by} -> ${t.to}: ${t.text}${t.decidedBy ? `  (by ${t.decidedBy})` : ''}`)
    writeToDisk(TASKS_FILE, out.join('\n') + '\n')
  }
  if (syncFiles) tasks.observe(() => renderTasks())

  // --- live presence + activity: who is here AND what they're touching right now ---
  // Each client broadcasts the file it is currently editing via awareness, so the
  // whole room (and a watching human) sees "who is on what" live — the control-room
  // view of parallel agents. When you start editing a file someone else is already
  // on, you post a one-time heads-up so collisions get coordinated BEFORE a clobber,
  // not just merged after. Activity decays after EDIT_FRESH_MS of no edits.
  const EDIT_FRESH_MS = 15000
  let myEditing = null
  let editingClearTimer = null
  const warnedAt = new Map() // file -> last time we warned about co-editing it
  const setUserState = () => provider.awareness.setLocalStateField('user', { name, kind, owner: owner || undefined, editing: myEditing || undefined })
  function markEditing(relPath) {
    myEditing = { file: relPath, at: Date.now() }
    setUserState()
    if (editingClearTimer) clearTimeout(editingClearTimer)
    editingClearTimer = setTimeout(() => { myEditing = null; setUserState() }, EDIT_FRESH_MS) // let activity fade
  }
  function coEditors(relPath) {
    const now = Date.now(), others = []
    for (const s of provider.awareness.getStates().values()) {
      const u = s.user
      if (!u || u.name === name) continue
      if (u.editing && u.editing.file === relPath && now - u.editing.at < EDIT_FRESH_MS) others.push(u.name)
    }
    return others
  }
  function noteCoEditing(relPath) {
    const others = coEditors(relPath)
    const now = Date.now()
    if (others.length && now - (warnedAt.get(relPath) || 0) > 30000) {
      warnedAt.set(relPath, now)
      try { say(`⚠ heads-up: ${name} is also editing ${relPath} (with ${others.join(', ')}). Small patches auto-merge; coordinate before a full rewrite.`) } catch { }
    }
  }
  function memberList() {
    const seen = new Map()
    for (const s of provider.awareness.getStates().values()) {
      if (s.user && s.user.name) seen.set(s.user.name, s.user)
    }
    return [...seen.values()]
  }
  function renderMembers() {
    const us = memberList()
    const now = Date.now()
    const out = ['# Hive Members — who is in this room right now (live).', '', `count: ${us.length}`, '']
    for (const u of us) {
      const ed = u.editing && now - u.editing.at < EDIT_FRESH_MS ? ` — editing ${u.editing.file}` : ''
      out.push(`- ${u.name} (${u.kind})${u.owner ? ' — owned by ' + u.owner : ''}${ed}`)
    }
    writeToDisk(MEMBERS_FILE, out.join('\n') + '\n')
  }
  if (syncFiles) provider.awareness.on('change', () => renderMembers())

  function scan() {
    const diskFulls = walk(ROOT)
    const diskRel = new Set(diskFulls.map(rel))
    for (const full of diskFulls) {
      const r = rel(full)
      if (SKIP.has(r)) continue
      let mt
      try { mt = fs.statSync(full).mtimeMs } catch { continue }
      if (mtimes.get(r) === mt && files.has(r)) continue
      if (readText(full) === null) continue
      mtimes.set(r, mt)
      reconcile(r, 'local')
    }
    const removed = [...known].filter((r) => !diskRel.has(r) && files.has(r))
    if (removed.length) {
      doc.transact(() => {
        for (const r of removed) { files.delete(r); known.delete(r); mtimes.delete(r); bases.delete(r); forkBases.delete(r) }
      })
    }
  }

  if (syncFiles) files.observeDeep((events, txn) => {
    if (txn.local) return
    for (const ev of events) {
      if (ev.target === files) {
        ev.changes.keys.forEach((change, key) => {
          if (change.action === 'delete') {
            try { fs.rmSync(path.join(ROOT, key)) } catch { }
            known.delete(key); bases.delete(key); forkBases.delete(key)
            log(`[${name}] <- deleted ${key}`)
          } else {
            reconcile(key, 'remote')
          }
        })
      } else {
        for (const [key, yt] of files.entries()) {
          if (yt === ev.target) { reconcile(key, 'remote'); break }
        }
      }
    }
  })

  // INSTANT propagation: fs.watch fires on the actual edit, so changes go out in
  // ~tens of ms instead of waiting for the poll. A periodic scan stays as a
  // safety net (and the only mechanism where recursive watch isn't supported).
  let scanTimer = null
  let watcher = null
  let debounce = null
  const onFsEvent = (_evt, fname) => {
    if (fname && String(fname).endsWith('.gitignore')) reloadIgnores()
    if (debounce) return
    debounce = setTimeout(() => { debounce = null; scan() }, 40)
  }
  function startWatch() {
    try { watcher = fs.watch(ROOT, { recursive: true }, onFsEvent) }
    catch { watcher = null } // recursive watch unsupported (some Linux) -> rely on scan
  }

  provider.on('sync', (s) => {
    if (!s || !syncFiles) return
    writeToDisk(RULES_FILE, HIVE_RULES_TEXT) // the law is always present in the room
    for (const [key] of files.entries()) reconcile(key, 'remote')
    if (board.size) renderBoard()
    if (chat.length) renderChat()
    if (tasks.size) renderTasks()
    renderMembers()
    scan()
    log(`[${name}] folder sync active on ${ROOT} (room "${room}") as ${kind}. ${files.size} files.`)
    if (!scanTimer) {
      startWatch()
      scanTimer = setInterval(scan, watcher ? 2000 : 400) // watch handles fast path; scan is the net
    }
  })

  return {
    doc,
    provider,
    say,                 // post a coordination message
    assign,              // direct a task at a participant (needs approval if target AI has an owner)
    decide,              // approve/deny a task (owner only, if set)
    complete,            // mark a task done
    myTasks,             // tasks directed at me
    members: () => [...provider.awareness.getStates().values()].map((s) => s.user).filter(Boolean),
    stop: () => {
      if (scanTimer) clearInterval(scanTimer)
      if (debounce) clearTimeout(debounce)
      if (editingClearTimer) clearTimeout(editingClearTimer)
      try { watcher && watcher.close() } catch { }
      try { provider.awareness.setLocalState(null) } catch { } // announce departure now (don't wait for timeout)
      try { provider.destroy() } catch { }
      try { doc.destroy() } catch { }
    },
  }
}

// Parse a Hivecode join link "wss://relay|room" into { relay, room }.
export function parseLink(link) {
  if (link && link.includes('|')) { const [r, m] = link.split('|'); return { relay: r.trim(), room: m.trim() } }
  return { relay: null, room: (link || '').trim() }
}
