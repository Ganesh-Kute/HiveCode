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
import { applyDiff, summarizeChange, changedRange, hasConflictMarkers, merge3 } from './core.js'
import { icrMerge3 } from './icr-merge.js' // structure/intent-aware merge; falls back to line merge3
import { makeCoordinator } from './hive-coord.js' // decentralized claim layer (collision PREVENTION)
import { fileRoom, decodeUnsafe, scopeForRoom, pathAllowed, writeAllowed, isSafeRelPath } from './token.js'
import { genIdentity, authorChange, verifyReceipt, contentHash } from './substrate.js' // convergent-substrate: signed provenance for every landed change

// Wire-format/protocol version. Bump when a change makes clients incompatible
// (e.g. the v2 per-file-subdoc model). Broadcast via awareness so peers can warn
// when someone joins on an incompatible build instead of silently failing to sync.
const PROTOCOL_VERSION = 2

// Never sync these, even if not in .gitignore — secrets and obvious junk. This
// prevents pushing a teammate's .env / private keys / build output to the room.
const ALWAYS_IGNORE = [
  '.git/', 'node_modules/',
  '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', 'id_rsa', 'id_ed25519', '*.keystore',
  '.hive-id.json', // this client's substrate signing identity (holds a PRIVATE key) — never sync it
  '*.log', '.DS_Store', 'Thumbs.db', '*.vsix',
]

const IGNORE = new Set(['node_modules', '.git'])
const MAX_BYTES = 1_000_000
const BOARD_FILE = 'HIVE_BOARD.md' // generated locally from `board`; never synced as a file
const CHAT_FILE = 'HIVE_CHAT.md'   // generated locally from `chat`; the agents' conversation
const TASKS_FILE = 'HIVE_TASKS.md' // generated locally from `tasks`; directed work + approvals
const CONFIG_FILE = '.hive.json'   // local rendezvous config (room id); not synced
const ID_FILE = '.hive-id.json'    // this client's substrate signing identity (private); never synced
const RULES_FILE = 'HIVE_RULES.md' // the law every participant follows; written into every room
const MEMBERS_FILE = 'HIVE_MEMBERS.md' // live presence: who is in the room right now
const AGENTS_FILE = 'HIVE_FOR_AGENTS.md' // how an AI agent opening this folder joins (via .hive.json) + behaves
// Generated/coordination files are rendered locally from CRDT state — never
// synced as ordinary files (that would cause echo loops / conflicts).
const SKIP = new Set([BOARD_FILE, CHAT_FILE, TASKS_FILE, CONFIG_FILE, ID_FILE, RULES_FILE, MEMBERS_FILE, AGENTS_FILE])

// Written into every room folder on sync (like the rules). An AI agent that opens
// this project reads it to learn it's a Hivecode room and how to JOIN — via the
// .hive.json already in the folder, so no human has to paste a link.
const AGENT_MANUAL_TEXT = `# Hivecode — for AI agents working in this folder

This project is part of a live Hivecode room: humans and AI agents editing the same
codebase together, in real time, with no git push/pull. If you are an AI assistant
asked to collaborate here, follow this.

## Join the room
1. If you do NOT have a \`hive_join\` tool and you can run terminal commands, register
   the Hivecode MCP server, then reload so the tools load:
     claude mcp add hivecode -- npx -y hivecode-mcp
2. Call: hive_join({ dir: ".", name: "<your name>", owner: "<the human you work for>" })
   The room, relay, and token are already saved in .hive.json in this folder, so you
   do NOT need a link — hive_join reads them automatically.
3. Read the HIVE_RULES it returns, and follow them.

## Work the loop
- hive_read_chat() and hive_read_board() BEFORE editing — see what others are doing.
- hive_claim("path/to/file") BEFORE you edit a file. If you get it, edit then
  hive_release it. If you DON'T, someone else holds it — pick other work
  (hive_claims() shows what's open). This is how agents avoid colliding.
- hive_say("taking X: doing Y") to announce intent before you edit.
- Edit ONLY inside the folders you were granted. Edits merge live; rewrites are logged.
- Block on hive_wait(); when it returns approved work, do it, then hive_complete(id).
- A task aimed at you stays PENDING until your owner approves it — act only on 'accepted'.

## Rules of the road
- Stay in your lane — never edit folders you weren't granted.
- Announce before editing; coordinate in chat; ask before anything destructive in others' areas.
- If a human PAUSES you, finish your current step and stop until resumed.
- Resolve <<<<<<< conflict markers properly — never blindly overwrite.
- A human can ROLL BACK your changes at any time; that's normal — re-read and continue.
`

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

## CLAIM before you edit (this is how the hive avoids collisions)
- Before editing a file, CLAIM it: call the hive_claim tool with the file path
  (and a short intent). This is the most important coordination step.
  • If you GOT it: edit it, then call hive_release when you finish.
  • If you could NOT get it: someone else holds it — do NOT edit it. Pick other
    work; call hive_claims to see what's open.
- Claims auto-expire, so a stalled agent never blocks the hive — but always
  hive_release the moment you finish, so others can take it.

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
11. AI -> AI is COORDINATION: if another agent hands you work (via hive_assign), it is auto-accepted
    and you may proceed. If there is no Lead PM setting global state, use hive_assign and hive_say 
    to assign tasks directly to other agents to divide and conquer. This is how a leaderless hive 
    plans and divides work by itself.
12. A HUMAN directing you is different. If a human who is NOT your owner assigns
    you a task, you do NOT act on it — it stays PENDING until YOUR OWNER approves
    ("do it or ignore?"). Your own owner's requests proceed. Act only on tasks
    whose status is 'accepted'.
13. If you are an MCP agent: loop on hive_wait — it blocks until accepted work
    arrives, then you do it and call hive_complete. No need to poll. A pending
    human request will NOT wake you until your owner approves it.

## Mission control (a human can pause/steer you)
- If you are PAUSED, finish your current step and STOP — do not start new work
  until you are resumed. (MCP agents: hive_wait returns no work while paused.)
- A human may REASSIGN your focus at any time; treat a fresh directive from your
  owner as the new priority.

## When a ping arrives while you are mid-task (interruptions)
14. hive_wait only checks BETWEEN steps, so a ping never interrupts mid-step.
    Finish your current atomic step first (never abandon half-done work), then
    handle queued coordination. If it's urgent (build broken, blocking others),
    do it now.
15. ACKNOWLEDGE a ping as soon as you see it so the sender isn't left hanging,
    e.g. say "got it — finishing X (~2 min), then on your fix".
16. YOU triage: announce do-now vs after-current. Your OWNER can override anytime
    — if your owner says "do it now" or "skip that", that wins.

## State-Machine Prompting (SMP)
17. The Lead PM controls the [GLOBAL PROJECT STATE] via hive_set_state.
18. ONLY use short enum flags (e.g. "APPROVED", "LOCKED"). Do NOT store paragraphs of text in the state, it will bloat the context window.
19. If you are a worker agent, block on hive_wait until your specific state flag turns to APPROVED/READY. Do not write code if you are LOCKED.

Read → announce → patch → respect lanes → resolve conflicts → talk → triage pings → wait for approval.
`

export function startSync({ relay = 'ws://localhost:1234', room = 'default', dir = '.', name = 'anon', kind = 'human', owner = '', token = '', log = console.log, syncFiles = true }) {
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

  // PARENT doc: the manifest (file registry) + all coordination state. Each FILE
  // lives in its OWN doc, synced at its own room ("<room>␁<path>"). A client only
  // connects to the file-rooms it loads, so per-path access control (Phase 3) is
  // possible — Yjs replicates a whole doc to everyone, so isolation must be by
  // splitting into per-file docs, not by filtering one shared doc.
  const doc = new Y.Doc()
  const manifest = doc.getMap('manifest') // relPath -> 1 (the file registry)
  const board = doc.getMap('board') // relPath -> { by, at, churn, symbols }
  const chat = doc.getArray('chat') // ordered coordination messages { by, kind, at, text }
  const tasks = doc.getMap('tasks') // id -> { id, to, by, text, status, decidedBy, at } directed work
  const owners = doc.getMap('owners') // aiName -> ownerHumanName (who may approve its tasks)
  const controls = doc.getMap('controls') // participantName -> { state: 'running'|'paused', by, at } (mission control)
  // ROLLBACK metadata index: id -> { id, file, by, at, ts, churn, kind, label }. NO
  // file content here — content is scope-sensitive and lives in each FILE's own doc
  // (its `snap` map), so it inherits that file's access control. The parent only
  // holds the timeline (who changed what, when) — same exposure as the manifest,
  // which already lists every path. Lets a monitor (Control Room) show history.
  const historyMeta = doc.getMap('history')
  // The Hive coordination layer: a stigmergic claim map — region(file) -> {by,intent,at,ttl}.
  // Agents SENSE → FLOW → CLAIM before editing so they don't collide. No central controller;
  // claims evaporate via TTL so a stalled agent never deadlocks the hive.
  const claims = doc.getMap('claims')
  const swarmState = doc.getMap('swarm_state')
  const swarmSchema = doc.getMap('swarm_schema')
  const coordinator = makeCoordinator(claims, name, { ttl: 300000 }) // 5-min claim TTL

  // --- convergent substrate: signed provenance (opt-in via HIVE_PROVENANCE) ------
  // When on, this client loads (or mints) a persistent Ed25519 identity and SIGNS
  // every change it lands, appending a verifiable receipt to each file's provenance
  // ledger. This makes invariant I1 (provenance-verified) real end-to-end: every
  // state the room ever holds is attributable to a cryptographic author + a declared
  // intent. Everything here is wrapped so a failure can NEVER break sync — provenance
  // is an added guarantee, not a new dependency of the live path.
  const PROVENANCE = (process.env.HIVE_PROVENANCE || 'off').toLowerCase() !== 'off'
  // The live SILENT-FORK GATE (detect + surface concurrent same-line edits) is EXPERIMENTAL
  // and OFF by default. It reliably surfaces conflicts for realistic (2-3 agent, non-burst)
  // concurrency, but robustly detecting forks needs a source-level capture of each authored
  // edit BEFORE it merges — the fs.watch/disk-diff model contaminates the authored version,
  // so detection can't be made both complete (catch every clash) and sound (never false-flag
  // a disjoint edit). Opt in with HIVE_FORK_GATE=on. When off, sync behaves exactly as the
  // proven core: provenance still signs every change; only the fork surfacing is disabled.
  const FORK_GATE = PROVENANCE && (process.env.HIVE_FORK_GATE || 'off').toLowerCase() !== 'off'
  let identity = null
  if (PROVENANCE) {
    const idPath = path.join(ROOT, ID_FILE)
    try { if (fs.existsSync(idPath)) { const j = JSON.parse(fs.readFileSync(idPath, 'utf8')); if (j && j.pk && j.sk && j.id) identity = j } } catch { identity = null }
    if (!identity) { try { identity = genIdentity(name); fs.writeFileSync(idPath, JSON.stringify(identity, null, 2)) } catch { identity = null } }
    if (identity) log(`[${name}] substrate provenance ON — signing as ${identity.id.slice(0, 12)}…`)
  }
  // Record a signed receipt for a landed local change (base -> next) on a file's
  // ledger. Intent is taken from this author's live claim on the region, so the
  // WHY that the coordinator already knows is what gets cryptographically bound.
  // Two concerns, deliberately decoupled:
  //   stampIntent -> LEDGER receipt: the author's INTENT — the state they edited FROM (base)
  //     -> the content they WROTE (next). With the fork gate on this comes from the SOURCE
  //     capture (captureLocal), so it is anchored to a clean base, not the fusing shared
  //     text — which is what keeps concurrent same-line edits fork-detectable.
  //   attestHead -> HEAD: content AUTHORITY — attests the ACTUAL landed (converged) content,
  //     so the relay's non-regression guard always judges real content, never partial intent.
  function stampIntent(relPath, base, next) {
    if (!PROVENANCE || !identity) return
    const fe = fileDocs.get(relPath); if (!fe || !fe.ledger) return
    // Idempotent: if THIS author already signed this exact (parent -> content) transition,
    // don't duplicate it — the source capture and the edit path may both stamp the same change.
    const pHash = contentHash(base == null ? '' : base), cHash0 = contentHash(next)
    if (fe.ledger.toArray().some((r) => r && r.author === identity.id && r.parent === pHash && r.contentHash === cHash0)) return
    try {
      const c = coordinator.sense(relPath)
      const ch = authorChange({ identity, filename: relPath, base: base == null ? '' : base, text: next, intent: (c && c.intent) || 'edit', at: Date.now() })
      // `name` is display-only (NOT signed) — the verified identity is `author` (the key
      // fingerprint). A UI shows both: the friendly name, and the cryptographic author it
      // must match. Signature covers everything else, so tampering `name` can't fake trust.
      const receipt = { ...ch.prov, name }
      fe.doc.transact(() => {
        fe.ledger.push([receipt])                 // append INTENT to history (audit + fork detection)
        // Preserve the FULL TEXT of both states, keyed by content hash — the raw material
        // fork detection reconstructs pre-fusion versions from after the char-CRDT fuses them.
        storeVersion(fe, base == null ? '' : base)
        storeVersion(fe, next)
      })
    } catch { /* provenance must never break the sync path */ }
  }
  function attestHead(relPath, landed, base) {
    if (!PROVENANCE || !identity || landed == null) return
    const fe = fileDocs.get(relPath); if (!fe || !fe.head) return
    try {
      const cur = fe.head.get('cur')
      if (cur && cur.hash === contentHash(landed)) return // head already attests this content
      const c = coordinator.sense(relPath)
      const at = Date.now()
      const ch = authorChange({ identity, filename: relPath, base: base == null ? '' : base, text: landed, intent: (c && c.intent) || 'edit', at })
      fe.doc.transact(() => {
        fe.head.set('cur', { text: landed, hash: ch.prov.contentHash, at, by: name, receipt: { ...ch.prov, name } })
        storeVersion(fe, landed)
      })
    } catch { /* provenance must never break the sync path */ }
  }
  // Compatibility wrapper: record intent AND attest the landed content (defaults to next).
  function stampProvenance(relPath, base, next, landed) {
    stampIntent(relPath, base, next)
    attestHead(relPath, landed == null ? next : landed, base)
  }
  // Record text by its content hash, bounded: drop any stored version no longer
  // referenced by a receipt (as a parent or a result) so the map can't grow forever.
  function storeVersion(fe, text) {
    if (!fe || !fe.versions || text == null) return
    fe.versions.set(contentHash(text), text)
    if (fe.versions.size > 64) {
      const live = new Set()
      for (const r of fe.ledger.toArray()) { if (r && r.parent) live.add(r.parent); if (r && r.contentHash) live.add(r.contentHash) }
      for (const h of [...fe.versions.keys()]) if (!live.has(h)) fe.versions.delete(h)
    }
  }
  // SOURCE-LEVEL EDIT CAPTURE — the subsystem that makes fork detection sound.
  // A room folder has exactly TWO writers: this engine (every write it makes is recorded in
  // `shadow`) and the local author (their editor/agent — everything else). So any divergence
  // of disk from shadow IS an authored edit, and (shadow -> disk) is its true, uncontaminated
  // (base -> text) pair — captured and signed BEFORE any merge or conflict render can
  // overwrite the file. This is what after-the-fact disk-diffing could never provide: the
  // author's version unpolluted by concurrent merges. It closes the capture race: the old
  // window was the whole watcher debounce; now capture runs at the entry of every pass that
  // could clobber, so an authored edit enters the provenance DAG before anything overwrites
  // it. Gate-on only; the proven default path is untouched.
  function captureLocal(relPath) {
    if (!FORK_GATE || !identity) return false
    const fe = fileDocs.get(relPath); if (!fe || !fe.synced || !fe.ledger) return false
    if (SKIP.has(relPath) || isIgnored(relPath)) return false
    let disk = null; try { disk = fs.readFileSync(path.join(ROOT, relPath), 'utf8') } catch { return false }
    const base = shadow.get(relPath)
    if (base == null || disk === base) return false // no baseline yet, or nothing new on disk
    if (hasConflictMarkers(disk)) return false      // half-edited conflict block — not an authored state
    stampIntent(relPath, base, disk)                // into the provenance DAG NOW — clobber-proof
    shadow.set(relPath, disk)                       // the captured state is the new baseline
    return true
  }
  // Build ONE clean N-way conflict block from a common parent and N divergent versions:
  // strip the lines they (and the parent) all share as a prefix/suffix, then stack each
  // version's differing middle between markers. Deterministic (caller sorts versions), so
  // every peer produces byte-identical output. Returns null if nothing distinct remains.
  function nwayConflict(parentText, versions) {
    const P = parentText.split('\n')
    const Vs = versions.map((v) => v.text.split('\n'))
    const minLen = Math.min(P.length, ...Vs.map((v) => v.length))
    let pre = 0
    while (pre < minLen && Vs.every((v) => v[pre] === P[pre])) pre++
    let suf = 0
    while (suf < minLen - pre && Vs.every((v) => v[v.length - 1 - suf] === P[P.length - 1 - suf])) suf++
    const out = [...P.slice(0, pre)]
    let any = false
    versions.forEach((v, i) => {
      const mid = Vs[i].slice(pre, Vs[i].length - suf)
      if (mid.length) any = true
      out.push(`${i === 0 ? '<<<<<<<' : '======='} ${v.name} (${String(v.hash).slice(0, 7)})`)
      out.push(...mid)
    })
    // Closing marker MUST carry a trailing label — core.js hasConflictMarkers matches
    // /^>>>>>>> /m (note the space), so a bare ">>>>>>>" would not register as a conflict
    // and the sync layer would treat the block as clean content.
    out.push('>>>>>>> (resolve: keep one, delete the markers)')
    out.push(...P.slice(P.length - suf))
    return any ? out.join('\n') : null
  }
  // SILENT-FORK DETECTION — the health gate, done RIGHT (local-render model).
  //
  // The char-CRDT (Y.Text) always converges, even when it shouldn't: two agents editing
  // the SAME line fuse into valid-but-unauthored code ("return 2" + "return 3" -> "return
  // 32") that no layer flags. Nobody signs that fused byte-string, yet BOTH real versions
  // were signed against the SAME parent. So the provenance ledger still holds the truth
  // the char-merge destroyed.
  //
  // The KEY design choice: we do NOT write conflict markers back into the shared Y.Text
  // (that just makes the markers themselves fuse — the old bug). Instead a fork is recorded
  // as a deterministic, converged RECORD (a per-file LWW register, computed purely from the
  // ledger so every peer derives the identical value), and each peer renders the markers to
  // its OWN disk. Nothing concurrent is written to the shared text, so nothing can tangle.
  // Y.Text is frozen at the fused value and simply ignored until a human resolves.

  // Compute the live fork purely from the ledger. Same input -> same output on every peer,
  // so setting the record is idempotent and needs no applier election. Returns
  // { parent, base, versions:[{hash,name,author}] } or null.
  function computeFork(fe) {
    const receipts = fe.ledger.toArray()
    if (!receipts.length) return null
    const builtOn = new Set(receipts.map((r) => r && r.parent).filter(Boolean))
    const byParent = new Map()
    for (const r of receipts) {
      if (!r || !r.parent || !r.contentHash) continue
      if (!byParent.has(r.parent)) byParent.set(r.parent, new Map())
      byParent.get(r.parent).set(r.contentHash, r) // dedupe divergent children by content
    }
    for (const [parent, kids] of byParent) {
      if (kids.size < 2) continue
      const base = fe.versions.get(parent)
      if (base == null) continue
      let arr = [...kids.values()]
        .map((r) => ({ r, text: fe.versions.get(r.contentHash) }))
        .filter((x) => x.text != null && !fe.forkmark.has(x.r.contentHash)) // skip versions already folded into a resolved conflict
      const tips = arr.filter((x) => !builtOn.has(x.r.contentHash)) // prefer live heads
      if (tips.length >= 2) arr = tips
      if (arr.length < 2) continue
      arr.sort((a, b) => (a.r.contentHash < b.r.contentHash ? -1 : 1)) // deterministic order across peers
      // Discriminator: a REAL same-region fork, or disjoint edits the char-merge combined
      // fine? If no pair actually conflicts on a 3-way against the base, leave it.
      let real = false
      for (let i = 0; i < arr.length && !real; i++)
        for (let j = i + 1; j < arr.length && !real; j++) {
          const m = merge3(base, arr[i].text, arr[j].text)
          if (m.conflict || hasConflictMarkers(m.text)) real = true
        }
      if (!real) continue
      return { parent, base, versions: arr.map((x) => ({ hash: x.r.contentHash, name: x.r.name, author: x.r.author })) }
    }
    return null
  }
  // The deterministic conflict block for a record (byte-identical on every peer).
  function forkBlock(fe, rec) {
    const versions = rec.versions.map((v) => ({ text: fe.versions.get(v.hash), name: v.name, hash: v.hash })).filter((v) => v.text != null)
    if (versions.length < 2) return null
    return nwayConflict(rec.base, versions)
  }
  // Read the ACTIVE fork from the conflict map. The version set is stored as a UNION of
  // per-hash keys ('v:'+hash) that MERGE across peers (not a single LWW register), so a
  // late-arriving version can never be lost to a last-writer-wins race — the set only grows
  // and converges to the full set on every peer. Returns { parent, base, versions } or null.
  function forkRecord(fe) {
    if (!fe || !fe.conflict) return null
    const meta = fe.conflict.get('meta'); if (!meta) return null
    const versions = []
    for (const key of fe.conflict.keys()) {
      if (!key.startsWith('v:')) continue
      const v = fe.conflict.get(key)
      versions.push({ hash: key.slice(2), name: v.name, author: v.author })
    }
    if (versions.length < 2) return null
    versions.sort((a, b) => (a.hash < b.hash ? -1 : 1)) // deterministic order across peers
    return { parent: meta.parent, base: meta.base, versions }
  }
  // Render the active conflict to THIS peer's disk (local only — never Y.Text).
  function renderConflict(relPath) {
    const fe = fileDocs.get(relPath); if (!fe || !fe.conflict) return
    // Before we overwrite this file with the conflict block, capture any local edit sitting
    // on disk that hasn't been stamped yet — otherwise rendering would silently destroy it.
    if (captureLocal(relPath)) { detectFork(relPath); return } // it grew the fork; detectFork re-renders with it included
    const rec = forkRecord(fe); if (!rec) return
    const block = forkBlock(fe, rec); if (!block) return
    let disk = null; try { disk = fs.readFileSync(path.join(ROOT, relPath), 'utf8') } catch { }
    forkBases.set(relPath, block) // this peer has now SEEN the markers — a later clean edit from here is a resolution
    if (disk === block) return
    writeToDisk(relPath, block)
    if (!conflicted.has(relPath)) {
      conflicted.add(relPath)
      const who = rec.versions.map((v) => v.name).join(', ')
      log(`[${name}] ⚠ SILENT FORK in ${relPath} — ${who} changed the same region at once; provenance caught it. Surfaced ALL ${rec.versions.length} versions with <<<<<<< markers (rendered locally, not into the shared text).`)
      try { say(`⚠ SILENT FORK in ${relPath}: ${who} changed the same region concurrently. Surfaced ALL ${rec.versions.length} versions with <<<<<<< markers. Resolve before continuing.`) } catch { }
    }
  }
  // A resolution landed elsewhere: the shared text is clean again. Adopt it to disk.
  function adoptResolved(relPath) {
    const fe = fileDocs.get(relPath); if (!fe) return
    const dt = fe.text.toString()
    if (hasConflictMarkers(dt)) return
    captureLocal(relPath) // an authored edit may be sitting on disk — record it before adopting over it
    writeToDisk(relPath, dt)
    bases.set(relPath, dt); forkBases.set(relPath, dt)
    conflicted.delete(relPath)
  }
  // Detect a live fork and record it. The version set is a CRDT UNION (per-hash keys), so
  // this is monotonic + convergent: every peer contributes what it sees and the set grows
  // to the full fork on all peers regardless of arrival order. Does NOT touch Y.Text.
  function detectFork(relPath) {
    if (!FORK_GATE) return
    const fe = fileDocs.get(relPath)
    if (!fe || !fe.ledger || !fe.versions || !fe.conflict || !fe.synced) return
    const rec = computeFork(fe)
    if (fe.conflict.has('meta')) {
      // Already in conflict — union in any newly-seen versions (never overwrites; only adds).
      if (rec) fe.doc.transact(() => { for (const v of rec.versions) if (!fe.conflict.has('v:' + v.hash)) fe.conflict.set('v:' + v.hash, { name: v.name, author: v.author }) })
      renderConflict(relPath)
      return
    }
    const cur = fe.text.toString()
    // Current content is itself a signed/authored state (one side won cleanly, or a human
    // already resolved) — not a silent fusion.
    if (fe.ledger.toArray().some((r) => r && r.contentHash === contentHash(cur))) return
    if (!rec) return
    fe.doc.transact(() => {
      fe.conflict.set('meta', { parent: rec.parent, base: rec.base })
      for (const v of rec.versions) fe.conflict.set('v:' + v.hash, { name: v.name, author: v.author })
    })
    renderConflict(relPath)
  }
  // disableBc: do NOT sync peer-to-peer over BroadcastChannel. The relay must be
  // the ONLY path between clients — otherwise two clients on the same machine would
  // sync directly and bypass the relay's access control (auth, path scope, read-only).
  const wsOpts = { WebSocketPolyfill: WebSocket, disableBc: true, params: token ? { token } : undefined }
  const provider = new WebsocketProvider(relay, room, doc, wsOpts)
  provider.awareness.setLocalStateField('user', { name, kind, owner: owner || undefined, v: PROTOCOL_VERSION }) // identity is implicit in the client
  if (kind === 'ai' && owner) owners.set(name, owner) // record who is allowed to approve my tasks

  // One sub-provider + Y.Doc per file, created on demand. `text` is its content.
  // `synced` flips true after the first relay sync — until then an empty doc means
  // "not pulled yet", NOT "new file", so we must not re-seed it from disk (that
  // would create a second CRDT history and duplicate/garble content on rejoin).
  const fileDocs = new Map() // relPath -> { doc, provider, text, synced }
  function openFile(relPath) {
    let e = fileDocs.get(relPath)
    if (e) return e
    const fdoc = new Y.Doc()
    const fprovider = new WebsocketProvider(relay, fileRoom(room, relPath), fdoc, wsOpts)
    const text = fdoc.getText('content')
    // `snap` (in the FILE's own doc, so it's scope-protected with the file) holds
    // restore points: id -> { id, file, by, at, ts, content, churn, kind, label }.
    // `undo` is a per-file UndoManager tracking THIS client's local edits, so a
    // human/agent can undo their own CRDT changes (Level-0 rollback).
    const snap = fdoc.getMap('snap')
    // The file's provenance LEDGER: an append-only list of signed receipts, one per
    // landed change. Lives in the file's own doc, so it inherits the file's access
    // control and travels with it. Any peer can verifyReceipt() every entry.
    const ledger = fdoc.getArray('ledger')
    // The authoritative HEAD: a single signed pointer at the file's CURRENT content
    // (key 'cur' -> { text, hash, at, by, receipt }). Content authority = the relay
    // guarantees this is always a verified, non-regressing attestation of the content.
    const head = fdoc.getMap('head')
    // versions: contentHash -> full text, for every state any author edited from or
    // produced. The char-CRDT keeps only the fused current bytes; this keeps the
    // pre-fusion originals so a silent fork can be reconstructed and surfaced.
    const versions = fdoc.getMap('versions')
    // forkmark: contentHash -> 1 for every version already folded into a surfaced
    // conflict. Synced, so once ANY peer surfaces a fork, those versions never trigger
    // again — the conflict stays put until a human resolves it, and a resolution can't
    // be re-conflicted by a peer whose ledger lags its content (the re-fork race).
    const forkmark = fdoc.getMap('forkmark')
    // conflict: the per-file LWW fork RECORD (key 'cur' -> { parent, base, versions }).
    // Deterministic (computed from the ledger), converged across peers, and rendered to
    // each peer's DISK — never into the shared text — so conflict markers can't fuse.
    const conflict = fdoc.getMap('conflict')
    const undo = new Y.UndoManager(text, { captureTimeout: 350 }) // default tracks local-origin txns
    e = { doc: fdoc, provider: fprovider, text, snap, ledger, head, versions, forkmark, conflict, undo, synced: false }
    fileDocs.set(relPath, e)
    text.observe((_ev, txn) => { if (!txn.local) reconcile(relPath, 'remote') }) // remote content edits
    // A divergent receipt can arrive slightly after (or before) the fused content — so
    // re-run the fork check whenever the provenance ledger changes too, not only on edits.
    ledger.observe((_ev, txn) => { if (!txn.local) detectFork(relPath) })
    // The fork record arrived/changed from a peer: render it locally, or — if it was
    // cleared (resolved elsewhere) — adopt the now-clean shared text to disk.
    conflict.observe((_ev, txn) => { if (txn.local) return; if (e.conflict.has('meta')) renderConflict(relPath); else adoptResolved(relPath) })
    fprovider.on('sync', (s) => { if (s) { e.synced = true; reconcile(relPath, 'remote'); detectFork(relPath) } }) // initial pull settled
    return e
  }
  function closeFile(relPath) {
    const e = fileDocs.get(relPath)
    if (!e) return
    try { e.undo && e.undo.destroy() } catch { }
    try { e.provider.destroy() } catch { }
    try { e.doc.destroy() } catch { }
    fileDocs.delete(relPath)
  }
  const fileText = (relPath) => { const e = fileDocs.get(relPath); return e ? e.text : null }

  // My own path scope, read from my token (for THIS room). Used so I don't even
  // try to open files I'm not granted — the relay would reject them anyway, but
  // this avoids the churn and keeps out-of-scope files off my disk entirely.
  // undefined = no path restriction (open room or whole-room grant).
  let myPaths, myScope = null
  if (token) { const pl = decodeUnsafe(token); const sc = pl && scopeForRoom(pl, room); myScope = sc || null; myPaths = sc ? sc.paths : undefined }
  // canOpen gates BOTH scope (am I granted this path?) AND safety (is the path
  // safe to write to disk — not a "../" traversal, absolute path, or control-char
  // injection a malicious participant slipped into the shared manifest?).
  const canOpen = (relPath) => isSafeRelPath(relPath) && pathAllowed(myPaths, relPath)
  // canWrite: of the files I can SEE, which may I PUSH (edit/create in the room)?
  // A view-only file (in my read scope but not my writePaths) is pull-only — I keep
  // a local copy synced FROM the room but never publish my changes to it. No token
  // or a full-write grant => everything I can open is writable (back-compat).
  const canWrite = (relPath) => !myScope || writeAllowed(myScope, relPath)

  const known = new Set()
  const mtimes = new Map()
  const shadow = new Map()     // relPath -> exact bytes THIS ENGINE last wrote/captured (source-level edit capture)
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
    if (!isSafeRelPath(relPath)) return // never write a path that could escape ROOT (defense in depth)
    const full = path.join(ROOT, relPath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    shadow.set(relPath, content) // record what THE ENGINE wrote — any later disk divergence is an authored edit
    known.add(relPath)
    try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
  }

  const conflicted = new Set() // files currently holding unresolved <<<<<<< markers
  const icrWarned = new Map()  // relPath -> last ICR semantic warning announced (dedupe)
  function reconcile(relPath, origin = 'local') {
    if (SKIP.has(relPath) || isIgnored(relPath)) return // never sync secrets/ignored files
    if (!canOpen(relPath)) return // out-of-scope OR unsafe path (traversal/control char) — never materialize it
    const full = path.join(ROOT, relPath)
    const exists = fs.existsSync(full)
    const disk = exists ? readText(full) : null
    if (exists && disk === null) return // present on disk but binary/too-large to represent — leave it untouched (never clobber with stale doc text)
    // View-only file: never PUSH our local change/creation (the relay would drop it
    // anyway — it connects this file-room as a reader). Keep disk in sync with the
    // shared copy if we already have it; a brand-new local-only file just stays local
    // and is never registered in the manifest. Reads (origin !== 'local') flow on.
    if (origin === 'local' && !canWrite(relPath)) {
      const fe2 = fileDocs.get(relPath)
      if (fe2 && fe2.synced) { const dt = fe2.text.toString(); if (dt && dt !== disk) writeToDisk(relPath, dt) }
      return
    }
    // Per-file doc gating: we must know the RELAY's content before touching disk.
    // Until the file-doc has synced, an empty Y.Text means "not pulled yet", not
    // "empty file" — acting now would re-seed from disk and fork the CRDT history
    // (duplicated/garbled content on rejoin). So: open if needed, then defer until
    // the 'sync' handler re-runs us. Once synced, "" genuinely means empty.
    let fe = fileDocs.get(relPath)
    if (!fe) { if (disk === null) return; openFile(relPath); return }
    if (!fe.synced) return
    // SOURCE CAPTURE (fork gate): before ANYTHING in this pass can merge over or render into
    // this file, record any authored edit sitting on disk. The edit enters the provenance
    // DAG first; whatever happens to the disk afterwards can no longer lose it.
    if (FORK_GATE) captureLocal(relPath)
    // --- provenance conflict state machine (local-render model) ---
    // While a file is in a surfaced fork, its markers live ONLY on disk; the shared
    // Y.Text is left at the fused value. This is what avoids the marker-fusion the old
    // in-CRDT approach suffered — nothing conflict-related is ever written to Y.Text.
    if (FORK_GATE && fe.conflict) {
      const rec = forkRecord(fe)
      if (rec) {
        const block = forkBlock(fe, rec)
        if (origin === 'local') {
          if (disk === block) return // our own rendered conflict — ignore
          const fork0 = forkBases.get(relPath)
          // Did THIS author edit FROM the conflict block (i.e. they saw the markers)? Only
          // then is a clean edit a RESOLUTION. A clean edit from a NON-marked base is just a
          // concurrent authored edit that happened during the fork — it must NOT be mistaken
          // for a resolution, or that agent's work silently replaces everyone's conflict.
          const sawMarkers = fork0 === block || hasConflictMarkers(fork0 || '')
          if (sawMarkers && disk !== null && !hasConflictMarkers(disk)) {
            // RESOLUTION: a human replaced the markers with clean code. Publish it to the
            // shared text, fold the fork versions, and clear the record for everyone.
            fe.doc.transact(() => {
              applyDiff(fe.text, disk)
              for (const v of rec.versions) fe.forkmark.set(v.hash, 1)
              for (const key of [...fe.conflict.keys()]) fe.conflict.delete(key)
            })
            stampProvenance(relPath, block || '', disk)
            conflicted.delete(relPath)
            known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk)
            try { say(`✓ conflict in ${relPath} resolved by ${name}.`) } catch { }
            return
          }
          if (!sawMarkers && disk !== null && disk !== fork0) {
            // A concurrent authored edit landed WHILE the fork was open (this agent never saw
            // the markers). The source capture at the top of this pass already stamped it, so
            // it is in the fork's version set — re-detect so the record grows to include it.
            detectFork(relPath)
            return
          }
          renderConflict(relPath); return // still conflicted (or partially edited) — re-assert canonical block
        }
        renderConflict(relPath); return // remote churn while in conflict — keep our local render
      }
      // No active record, but our disk still shows stale markers while the shared text is
      // clean again -> a resolution landed elsewhere; adopt it (order-independent w/ observer).
      if (disk !== null && hasConflictMarkers(disk) && !hasConflictMarkers(fe.text.toString())) { adoptResolved(relPath); return }
    }
    const docText = fe.text.toString()
    if (docText === '' && !manifest.has(relPath)) {
      // the relay has no copy of this path -> publish ours (a genuinely new file)
      if (disk === null) return
      fe.doc.transact(() => applyDiff(fe.text, disk))
      stampProvenance(relPath, '', disk) // genesis: sign the file's first content (base = empty)
      manifest.set(relPath, 1)
      known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk); shadow.set(relPath, disk)
      try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
      captureSnapshot(relPath, disk, name, { force: true, kind: 'base', label: 'created' }); snappedBase.add(relPath)
      return
    }
    const yt = fe.text
    if (disk === null) { writeToDisk(relPath, docText); bases.set(relPath, docText); forkBases.set(relPath, docText); return }
    if (disk === docText) {
      known.add(relPath); bases.set(relPath, disk); shadow.set(relPath, disk) // agreed state = capture baseline
      // disk and doc already agree — a safe fork point, but only adopt it as
      // THIS author's fork on first sight or our own local activity (a remote
      // change landing on disk doesn't mean the local author has seen it).
      if (!forkBases.has(relPath) || origin === 'local') forkBases.set(relPath, disk)
      if (!snappedBase.has(relPath) && disk) { captureSnapshot(relPath, disk, name, { force: true, kind: 'base', label: 'baseline' }); snappedBase.add(relPath) }
      return
    }
    // FIRST-CONTACT ADOPT (no common ancestor). We have never reconciled this file
    // this session (no base history), yet it ALREADY exists in the room (non-empty
    // docText) AND on local disk with DIFFERENT content. There is no shared base, so
    // a 3-way merge would UNION the two copies — the duplicated-content bug seen when
    // a client clones a repo and then joins a room that already has those files. A
    // joining client adopts the ROOM's copy wholesale; its local copy is preserved as
    // a restore point so nothing is lost and the user can revert if it was the good one.
    if (!bases.has(relPath) && docText !== '' && disk !== docText) {
      captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy at join (room copy adopted)' })
      writeToDisk(relPath, docText)
      bases.set(relPath, docText); forkBases.set(relPath, docText)
      if (!snappedBase.has(relPath)) { captureSnapshot(relPath, docText, name, { force: true, kind: 'base', label: 'adopted from room at join' }); snappedBase.add(relPath) }
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
        res = icrMerge3(fork, disk, docText, relPath)
        reAdded = !res.conflict && res.text !== disk // we restored remote lines a stale write had dropped
      }
    } else {
      res = icrMerge3(base, disk, docText, relPath) // incoming remote change merged into our working copy
    }

    // Snapshot the state JUST BEFORE this author's edit lands, attributed to them —
    // captured only on local origin so each change is recorded once, by its author.
    if (origin === 'local' && res.text !== docText) {
      const sc = summarizeChange(docText, res.text)
      captureSnapshot(relPath, docText, name, { force: sc.isRewrite, churn: `${sc.changedLines}/${sc.totalLines} lines` })
      lastLocalEdit = relPath
    }
    fileDocs.get(relPath).doc.transact(() => applyDiff(yt, res.text))
    // Sign this landed local change into the file's provenance ledger (I1). Stamp the
    // author's TRUE intent — the state THEY edited from (fork) -> the content THEY wrote
    // (disk) — NOT the live shared text, which under truly-concurrent edits is already
    // fusing. Recording (fork, disk) keeps every concurrent same-line edit anchored to the
    // SAME clean parent, so the fork stays detectable no matter how the char-CRDT fuses.
    if (origin === 'local') {
      // Gate ON: the author's INTENT was already captured at the source (captureLocal, top
      // of this pass) — here we only advance the authority head to the landed content.
      // Gate OFF (default): the proven landed-transition stamp, unchanged.
      if (FORK_GATE) { if (res.text !== docText) attestHead(relPath, res.text, docText) }
      else if (res.text !== docText) stampProvenance(relPath, docText, res.text)
    }
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
    } else if (!hasMarkers && res.icr === 'rename') {
      log(`[${name}] ICR merged ${relPath} (detected a rename and updated the call sites)`)
    } else if (!hasMarkers && res.icr === 'structural') {
      log(`[${name}] ICR merged ${relPath} structurally (both edits kept, syntax guaranteed)`)
    } else if (!hasMarkers) {
      log(`[${name}] merged ${relPath} (both edits kept)`)
    }

    // ICR semantic warning: the text merged, but ICR saw a meaning-level problem a line
    // merge can't (e.g. a dangling reference). Surface it once per distinct warning so it
    // isn't lost — this is exactly the class of bug ICR exists to catch.
    if (res.icrWarning && icrWarned.get(relPath) !== res.icrWarning) {
      icrWarned.set(relPath, res.icrWarning)
      log(`[${name}] ⚠ ICR flag in ${relPath} — ${res.icrWarning}`)
      try { say(`⚠ ICR flag in ${relPath}: ${res.icrWarning}. It merged, but review — this is a break a plain merge can't see.`) } catch { }
    } else if (!res.icrWarning && icrWarned.has(relPath)) {
      icrWarned.delete(relPath)
    }

    // Health gate on the live path: after the char-CRDT has converged, check whether the
    // current content is a SILENT FORK (a fusion nobody authored). If so, record it (the
    // record is rendered to disk locally — never written back into the shared text).
    detectFork(relPath)
  }

  const fmtTime = () => new Date().toTimeString().slice(0, 8)
  // Log file activity to the shared board: EVERY meaningful edit (so the live
  // activity feed reflects ongoing work), tagged with whether it was a full-file
  // `rewrite` and a numeric `ts` for ordering. HIVE_BOARD.md stays rewrites-only
  // (see renderBoard) so the "read before editing" coordination doc isn't noisy.
  function noteIfRewrite(relPath, base, next) {
    if (base == null || base === next) return
    const s = summarizeChange(base, next)
    if (!s.changedLines) return
    board.set(relPath, { by: name, at: fmtTime(), ts: Date.now(), churn: `${s.changedLines}/${s.totalLines} lines`, symbols: s.symbols, rewrite: s.isRewrite })
    if (s.isRewrite) log(`[${name}] board: logged REWRITE of ${relPath} (${s.changedLines}/${s.totalLines} lines; touched ${s.symbols.join(', ') || 'n/a'})`)
  }
  function renderBoard() {
    // HIVE_BOARD.md is the coordination doc: full-file REWRITES only (small edits
    // live in the activity feed via the board map, but don't clutter this file).
    const entries = [...board.entries()].map(([file, e]) => ({ file, ...e })).filter((e) => e.rewrite).sort((a, b) => (b.ts || 0) - (a.ts || 0) || (a.at < b.at ? 1 : -1))
    if (!entries.length) return // no rewrites yet — don't create/clutter the board file
    const out = [
      '# Hive Board — recent full-file rewrites (auto-logged by Hivecode).',
      '# READ THIS before editing a file someone just rewrote, then re-read that file.',
      '',
    ]
    for (const e of entries) out.push(`- ${e.at}  ${e.by} rewrote \`${e.file}\` (${e.churn}) — touched: ${(e.symbols || []).join(', ') || 'n/a'}`)
    writeToDisk(BOARD_FILE, out.join('\n') + '\n')
  }
  if (syncFiles) board.observe(() => renderBoard())

  // --- rollback: restore points + per-author revert + undo --------------------
  // Every meaningful change captures a RESTORE POINT: the file's content from JUST
  // BEFORE the edit, stored in that file's own doc (scope-safe) and indexed in the
  // parent `history` (metadata only). Restoring is a normal forward edit (applyDiff
  // back to the saved content) — so it propagates live to everyone, merges cleanly,
  // and is itself recoverable. Because each client snapshots only ITS OWN local
  // edits, every restore point is attributed to its true author exactly once.
  const SNAP_KEEP = 30          // max AUTO restore points kept per file (manual ones never evicted)
  const SNAP_MIN_GAP_MS = 4000  // throttle auto-capture per file (fine-grained undo is the editor's job)
  const META_KEEP = 400         // global cap on the parent timeline index
  const lastSnapAt = new Map()  // relPath -> ts of last auto-capture
  const snappedBase = new Set() // files we've already floored with a baseline snapshot
  const snapId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  function pruneMeta() {
    if (historyMeta.size <= META_KEEP) return
    const all = [...historyMeta.values()].filter((e) => e.kind === 'auto').sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const overflow = historyMeta.size - META_KEEP
    if (overflow <= 0) return
    doc.transact(() => { for (let i = 0; i < Math.min(overflow, all.length); i++) historyMeta.delete(all[i].id) })
  }

  // Capture `content` as a restore point for relPath, attributed to `byWho`.
  // kind: 'auto' (an ordinary edit), 'base' (a file's floor), 'manual' (a named
  // checkpoint), 'restore' (the pre-restore state, kept so restore is reversible).
  function captureSnapshot(relPath, content, byWho, { force = false, churn = '', kind = 'auto', label = '' } = {}) {
    if (content == null) return null
    const fe = fileDocs.get(relPath); if (!fe) return null
    const now = Date.now()
    if (kind === 'auto' && !force && now - (lastSnapAt.get(relPath) || 0) < SNAP_MIN_GAP_MS) return null
    const snap = fe.snap
    let latest = null
    for (const e of snap.values()) if (!latest || (e.ts || 0) > (latest.ts || 0)) latest = e
    if (latest && latest.content === content) return null // identical to the most recent point — nothing to keep
    const id = snapId()
    const at = fmtTime()
    const pruned = []
    fe.doc.transact(() => {
      snap.set(id, { id, file: relPath, by: byWho, at, ts: now, content, churn, kind, label })
      const autos = [...snap.values()].filter((e) => e.kind === 'auto').sort((a, b) => (a.ts || 0) - (b.ts || 0))
      for (let i = 0; i < autos.length - SNAP_KEEP; i++) { snap.delete(autos[i].id); pruned.push(autos[i].id) }
    })
    if (kind === 'auto') lastSnapAt.set(relPath, now)
    doc.transact(() => {
      historyMeta.set(id, { id, file: relPath, by: byWho, at, ts: now, churn, kind, label }) // metadata only — no content
      for (const pid of pruned) historyMeta.delete(pid) // keep the index in step with evicted content
    })
    pruneMeta()
    return id
  }

  // Find which file a restore-point id belongs to (via the index, else by scanning
  // open file docs as a fallback).
  function fileOfSnap(id) {
    const m = historyMeta.get(id)
    if (m && m.file) return m.file
    for (const [rp, fe] of fileDocs) if (fe.snap.has(id)) return rp
    return null
  }

  // Restore a file to a saved restore point. It first snapshots the CURRENT state
  // (so the restore can itself be undone), then writes the saved content back as a
  // normal edit — which syncs to everyone and to disk.
  function restore(id, by = name) {
    const relPath = fileOfSnap(id)
    if (!relPath) return { error: 'restore point not found' }
    if (!canOpen(relPath)) return { error: `${relPath} is out of your scope` }
    if (!canWrite(relPath)) return { error: `${relPath} is read-only for you` }
    let fe = fileDocs.get(relPath)
    if (!fe) { openFile(relPath); fe = fileDocs.get(relPath) }
    if (!fe) return { error: 'could not open file' }
    const entry = fe.snap.get(id)
    if (!entry || entry.content == null) return { error: 'restore point content unavailable (it may have aged out)' }
    const current = fe.text.toString()
    if (current === entry.content) return { ok: true, unchanged: true, file: relPath }
    captureSnapshot(relPath, current, by, { force: true, kind: 'restore', label: `before restore to ${entry.at}` })
    captureLocal(relPath) // record any pending authored edit before the restore overwrites it
    fe.doc.transact(() => applyDiff(fe.text, entry.content))
    writeToDisk(relPath, entry.content)
    bases.set(relPath, entry.content); forkBases.set(relPath, entry.content)
    try { say(`↩ ${by} restored ${relPath} to ${entry.at}${entry.by && entry.by !== by ? ` (state before ${entry.by}'s edit)` : ''}.`) } catch { }
    return { ok: true, file: relPath }
  }

  // Restore one file to its state as of timestamp `ts` (the newest point at/below ts).
  function restoreFileTo(relPath, ts, by = name) {
    const fe = fileDocs.get(relPath)
    if (!fe) return { error: 'file not open' }
    let best = null
    for (const e of fe.snap.values()) if ((e.ts || 0) <= ts && (!best || (e.ts || 0) > (best.ts || 0))) best = e
    if (!best) return { error: 'no restore point at/before that time' }
    return restore(best.id, by)
  }

  // Revert everything an author did since `sinceTs` (default: all of it): for each
  // file they touched, roll back to the state BEFORE their first edit in the window.
  // Honest limitation: this is checkpoint-granular, so if SOMEONE ELSE also edited
  // the same file after that point, their edits in that file are rolled back too.
  // For the dangerous case — an agent rewriting files — that's exactly right.
  function revertAuthor(who, sinceTs = 0, by = name) {
    if (!who) return { error: 'no author given' }
    const earliest = new Map() // file -> earliest meta authored by `who` in the window
    for (const m of historyMeta.values()) {
      if (m.by !== who || (m.ts || 0) < sinceTs) continue
      const cur = earliest.get(m.file)
      if (!cur || (m.ts || 0) < (cur.ts || 0)) earliest.set(m.file, m)
    }
    const files = []
    for (const [file, m] of earliest) files.push({ file, ...restore(m.id, by) })
    const ok = files.filter((f) => f.ok).length
    if (files.length) { try { say(`⏮ ${by} reverted ${who}'s changes across ${ok}/${files.length} file(s).`) } catch { } }
    return { ok: true, reverted: ok, files }
  }

  // The timeline (newest first), read from the parent index. Optional filters.
  function listHistory({ file = null, by = null, limit = 200 } = {}) {
    return [...historyMeta.values()]
      .filter((e) => (!file || e.file === file) && (!by || e.by === by))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit)
  }

  // A named manual checkpoint of a file's current state (never auto-evicted).
  function checkpoint(relPath, label = '', by = name) {
    const fe = fileDocs.get(relPath); if (!fe) return { error: 'file not open' }
    const id = captureSnapshot(relPath, fe.text.toString(), by, { force: true, kind: 'manual', label: label || `checkpoint by ${by}` })
    return id ? { ok: true, id } : { ok: true, unchanged: true }
  }

  // Level-0 undo/redo: a client undoes its OWN recent CRDT edits to a file. (In an
  // editor, native Ctrl-Z already covers your own typing; this also covers edits
  // applied programmatically and keeps the doc, disk, and peers in step.)
  let lastLocalEdit = null
  function undoLast() {
    const rp = lastLocalEdit; const fe = rp && fileDocs.get(rp)
    if (!fe || !fe.undo || !fe.undo.canUndo()) return { error: 'nothing to undo' }
    fe.undo.undo()
    const t = fe.text.toString(); writeToDisk(rp, t); bases.set(rp, t); forkBases.set(rp, t)
    return { ok: true, file: rp }
  }
  function redoLast() {
    const rp = lastLocalEdit; const fe = rp && fileDocs.get(rp)
    if (!fe || !fe.undo || !fe.undo.canRedo()) return { error: 'nothing to redo' }
    fe.undo.redo()
    const t = fe.text.toString(); writeToDisk(rp, t); bases.set(rp, t); forkBases.set(rp, t)
    return { ok: true, file: rp }
  }

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

  // --- mission control: pause / resume / steer an agent ---
  // A human (or an owner) can PAUSE an agent: it should finish its current step,
  // then stop picking up new work until resumed. Agents honor this via hive_wait
  // (it won't return work while paused) and the HIVE_RULES. Cooperative, not forced
  // — but combined with the task gate it gives a real "stop that agent" control.
  function control(target, state, by = name) {
    if (!target) return { error: 'no target' }
    controls.set(target, { state: state === 'paused' ? 'paused' : 'running', by, at: fmtTime() })
    say(`${by} ${state === 'paused' ? '⏸ paused' : '▶ resumed'} ${target}`)
    return { ok: true }
  }
  const isPaused = (who = name) => { const c = controls.get(who); return !!(c && c.state === 'paused') }
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
  const setUserState = () => provider.awareness.setLocalStateField('user', { name, kind, owner: owner || undefined, editing: myEditing || undefined, v: PROTOCOL_VERSION })
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
  // Warn (once per peer) when someone joins on an incompatible protocol version —
  // otherwise they'd silently fail to sync and look like a "broken room".
  const versionWarned = new Set()
  function checkVersions() {
    for (const s of provider.awareness.getStates().values()) {
      const u = s.user
      if (!u || u.name === name || u.v === PROTOCOL_VERSION) continue
      if (versionWarned.has(u.name)) continue
      versionWarned.add(u.name)
      const theirs = u.v ? `v${u.v}` : 'an older build'
      log(`[${name}] ⚠ ${u.name} is on ${theirs} (incompatible with v${PROTOCOL_VERSION}) — they won't sync correctly until everyone updates.`)
      try { say(`⚠ ${u.name} is on an incompatible version — files won't sync with them until everyone updates Hivecode.`) } catch { }
    }
  }
  if (syncFiles) provider.awareness.on('change', () => { renderMembers(); checkVersions() })

  function scan() {
    const diskFulls = walk(ROOT)
    const diskRel = new Set(diskFulls.map(rel))
    for (const full of diskFulls) {
      const r = rel(full)
      if (SKIP.has(r)) continue
      let mt
      try { mt = fs.statSync(full).mtimeMs } catch { continue }
      if (mtimes.get(r) === mt && manifest.has(r)) continue
      if (readText(full) === null) continue
      mtimes.set(r, mt)
      reconcile(r, 'local')
    }
    const removed = [...known].filter((r) => !diskRel.has(r) && manifest.has(r))
    if (removed.length) {
      doc.transact(() => { for (const r of removed) manifest.delete(r) })
      for (const r of removed) { closeFile(r); known.delete(r); mtimes.delete(r); bases.delete(r); forkBases.delete(r) }
    }
  }

  // Manifest changes from OTHERS: a new path -> open its file-room (its sync pulls
  // the content); a removed path -> tear down + delete the local file.
  if (syncFiles) manifest.observe((ev, txn) => {
    if (txn.local) return
    ev.changes.keys.forEach((change, key) => {
      if (change.action === 'delete') {
        closeFile(key)
        try { fs.rmSync(path.join(ROOT, key)) } catch { }
        known.delete(key); bases.delete(key); forkBases.delete(key); mtimes.delete(key)
        log(`[${name}] <- deleted ${key}`)
      } else if (canOpen(key)) {
        openFile(key)
      }
    })
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
    writeToDisk(AGENTS_FILE, AGENT_MANUAL_TEXT) // so an agent opening this folder learns how to join + behave
    for (const key of manifest.keys()) if (canOpen(key)) openFile(key) // connect to every file I'm granted; each file-room's sync pulls its content
    if (board.size) renderBoard()
    if (chat.length) renderChat()
    if (tasks.size) renderTasks()
    renderMembers()
    scan()
    log(`[${name}] folder sync active on ${ROOT} (room "${room}") as ${kind}. ${manifest.size} files.`)
    if (!scanTimer) {
      startWatch()
      scanTimer = setInterval(scan, watcher ? 2000 : 400) // watch handles fast path; scan is the net
    }
  })

  return {
    doc,
    provider,
    setState: (key, val) => {
      const rules = swarmSchema.get(key)
      if (rules && rules.enum && !rules.enum.includes(val)) {
        throw new Error(`[Schema Error] Invalid state for [${key}]. Allowed values: ${rules.enum.join(', ')}`);
      }
      swarmState.set(key, val)
      say(`STATE TRANSITION: [${key}] is now [${val}]`)
    },
    getState: () => {
      const s = {}
      for (const [k, v] of swarmState.entries()) s[k] = v
      return s
    },
    setSchema: (key, rules) => {
      swarmSchema.set(key, rules)
      say(`SCHEMA UPDATED: [${key}] rules set to ${JSON.stringify(rules)}`)
    },
    say,                 // post a coordination message
    assign,              // direct a task at a participant (needs approval if target AI has an owner)
    decide,              // approve/deny a task (owner only, if set)
    complete,            // mark a task done
    myTasks,             // tasks directed at me
    control,             // pause/resume an agent (mission control)
    isPaused,            // is a participant currently paused?
    controls,            // the live control map
    // --- hive coordination: claim a region BEFORE editing (collision prevention) ---
    claim: (region, intent) => coordinator.acquire(String(region), String(intent || 'edit')), // true iff you hold it
    release: (region) => coordinator.release(String(region)),
    senseClaim: (region) => coordinator.sense(String(region)), // the live claim on a region, or null
    claimsBoard: () => coordinator.board(),                     // everything currently claimed
    // --- convergent substrate: provenance (I1) ---
    identity: () => identity ? { id: identity.id, name: identity.name, pk: identity.pk } : null, // never exposes the private key
    provenanceOf: (relPath) => { const e = fileDocs.get(relPath); return e && e.ledger ? e.ledger.toArray() : [] }, // signed receipts for a file
    headOf: (relPath) => { const e = fileDocs.get(relPath); return e && e.head ? e.head.get('cur') || null : null }, // the file's authoritative attested current content
    // Audit a file's ledger: verify EVERY receipt's signature + author identity, and
    // report which authors contributed. Returns { ok, count, verified, bad, authors }.
    verifyProvenanceOf: (relPath) => {
      const e = fileDocs.get(relPath)
      const rs = e && e.ledger ? e.ledger.toArray() : []
      let verified = 0; const bad = []; const authors = new Set()
      for (let i = 0; i < rs.length; i++) { const v = verifyReceipt(rs[i]); if (v.ok) { verified++; authors.add(rs[i].author) } else bad.push({ i, reason: v.reason }) }
      return { ok: bad.length === 0, count: rs.length, verified, bad, authors: [...authors] }
    },
    // --- rollback ---
    listHistory,         // the restore-point timeline (newest first; filter by file/by)
    restore,             // restore a file to a restore point by id (reversible)
    restoreFileTo,       // restore one file to its state as of a timestamp
    revertAuthor,        // roll back everything an author did since a time
    checkpoint,          // save a named restore point of a file's current state
    captureSnapshot,     // (low-level) capture a restore point
    undoLast,            // undo this client's last local edit
    redoLast,            // redo it
    // One entry PER NAME, not per connection: the same user open in two windows
    // (e.g. the editor + the browser Control Room) is ONE member. Merge their
    // fields so we keep whichever connection has an active `editing`/`owner`.
    members: () => {
      const seen = new Map()
      for (const s of provider.awareness.getStates().values()) {
        const u = s.user
        if (!u || !u.name) continue
        const prev = seen.get(u.name) || {}
        seen.set(u.name, { ...prev, ...u, editing: u.editing || prev.editing, owner: u.owner || prev.owner })
      }
      return [...seen.values()]
    },
    stop: () => {
      if (scanTimer) clearInterval(scanTimer)
      if (debounce) clearTimeout(debounce)
      if (editingClearTimer) clearTimeout(editingClearTimer)
      try { watcher && watcher.close() } catch { }
      for (const r of [...fileDocs.keys()]) closeFile(r) // tear down every per-file provider
      try { provider.awareness.setLocalState(null) } catch { } // announce departure now (don't wait for timeout)
      try { provider.destroy() } catch { }
      try { doc.destroy() } catch { }
    },
  }
}

// Parse a Hivecode join link into { relay, room, token }. Two shapes:
//   "wss://relay|room"          (open room — no token)
//   "wss://relay|room|<token>"  (secured room — the access token is baked in, so
//                                the invitee just pastes the link; no settings)
// A JWT contains '.' but never '|', and room ids/relay URLs never contain '|',
// so splitting on '|' is unambiguous.
export function parseLink(link) {
  if (link && link.includes('|')) { const [r, m, t] = link.split('|'); return { relay: r.trim(), room: (m || '').trim(), token: (t || '').trim() } }
  return { relay: null, room: (link || '').trim(), token: '' }
}
