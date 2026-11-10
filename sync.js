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
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { createFileTransport } from './hive-mux.js' // ONE SOCKET PER PARTICIPANT: every file doc on one physical socket when the relay offers it
import { HiveSocket, transportFor } from './hive-transport.js' // a WebSocket, or HTTPS long-poll where WebSockets are refused
import ignore from 'ignore'
import { applyDiff, summarizeChange, changedRange, hasConflictMarkers, merge3, lineHunks, blockVersions } from './core.js'
import { icrMerge3 } from './icr-merge.js' // structure/intent-aware merge; falls back to line merge3
import { makeCoordinator } from './hive-coord.js' // decentralized claim layer (collision PREVENTION)
import { RULES_MD, AGENT_MANUAL } from './hive-instructions.js'
import { gateConfig, runGate, verdictRecord, refusalMessage, forcedMessage, gateApproved, gatesDir, writeApproval, notApprovedMessage, notApprovedLine, GATE_CMD, GATE_NOT_APPROVED } from './hive-gate.js' // the HANDOFF gate: a claim you cannot give back while your own check fails
import { fileRoom, decodeUnsafe, scopeForRoom, pathAllowed, writeAllowed, isSafeRelPath } from './token.js'
import { validateMemberName } from './hive-mailbox.js' // a name the mention parser cannot produce is not a name
import { genIdentity, authorChange, verifyReceipt, contentHash } from './substrate.js' // convergent-substrate: signed provenance for every landed change
import { authorsOf } from './hive-authors.js'
// `languageFor` belongs in this list and was missing: reconcile() calls it on the
// clean-rewrite path, so a local whole-file rewrite of a supported file threw
// ReferenceError and killed the sync process outright. Nothing caught it -- the client
// simply died mid-session, which reads to a user as "sync stopped working". Rewriting a
// whole file is the most common thing an agent does, so this fired constantly.
import { createRequire } from 'module'
import { VERSION, VERSION_LABEL } from './hive-version.js' // which build this client is, carried in presence
// ROOM MEMORY LINK (29 Sep 2026). An optional local add-on that is not in the published package. A
// checkout that has the file links the room; an npm install simply has no room-memory link, and
// nothing else changes. Loaded, not imported, because a static import of an unshipped file fails at boot.
let grmLink = null
try { grmLink = createRequire(import.meta.url)('./grm-link.cjs') } catch { /* not shipped: no room memory link */ }
import { structuralMerge, supports, languageFor } from './icr.js' // validates a judged fork resolution before it may land (parse + dangling refs)
import { accountFor, sameText, DESCENDS, IDENTICAL, DIVERGED, UNPROVEN } from './hive-pr-staleness.js' // room-versus-branch provenance staleness checks (HIV-P9)
// HIV-P8. The map key MUST be the string 'obligations' — hive-mcp.js:656 reads that exact key, and
// a debt written anywhere else would be invisible to hive_owed: a warning nobody can see, which is
// the defect this ticket is about, one level down.
import * as RH from './hive-relay-health.js' // HIV-P13; the ONLY producer of the not-syncing diagnosis
import { checkRelay, currentRelayFor } from './hive-privacy.js' // HIV-P20; which relay is this, and did anybody choose it
import { newSecrets, describeSecret } from './hive-secrets.js' // a credential inside a file is held here, not sent to the room
import * as OB from './hive-obligations.js'
import { formatTime } from './hive-time.js'

// Wire-format/protocol version. Bump when a change makes clients incompatible
// (e.g. the v2 per-file-subdoc model). Broadcast via awareness so peers can warn
// when someone joins on an incompatible build instead of silently failing to sync.
const PROTOCOL_VERSION = 2

// Never sync these, even if not in .gitignore — secrets and obvious junk. This
// prevents pushing a teammate's .env / private keys / build output to the room.
// Exported so hive-branch.js can tell, before seeding a room from a git tree, which tracked
// files the room will never carry.
export const ALWAYS_IGNORE = [
  '.git/', 'node_modules/',
  // `.git` as a FILE too. '.git/' matches only a directory, and in a git worktree (or a submodule,
  // or a branch-room folder, which holds a `.git` file that makes git refuse to run there) `.git`
  // is a one-line file naming THIS machine's git directory. The walk skips it by name, but a
  // watcher event does not. Measured 30 Sep 2026 with '.git/' alone: an edit to A's sub/.git was
  // published, then retracted as "deleted" by A's next safety-net scan (whose walk skips it) --
  // and in between, peer B's OWN sub/.git, a submodule pointer to B's git directory, was first
  // overwritten with conflict markers and then deleted. tests/branch-test.mjs pins it (D1, D2).
  '.git',
  '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', 'id_rsa', 'id_ed25519', '*.keystore',
  // Files that are credentials by name, whatever is in them on a given day: direnv's exports, the
  // login stores of curl/git/pip, and the other private key formats.
  '.envrc', '.netrc', '_netrc', '.git-credentials', '.pypirc', 'id_ecdsa', 'id_dsa', '*.ppk', '*.p8', '*.jks',
  '.hive-id.json', // this client's substrate signing identity (holds a PRIVATE key) — never sync it
  // This client's own session + chat read cursor. Syncing it would push one agent's identity
  // and read position into every other agent's folder, and a shared cursor means one agent
  // consuming another's unread mail.
  '.hive-mcp-session.json',
  // The Stop hook's record of what it already held this agent's turn open for: per agent, like the session.
  '.hive-stop-hook.json',
  // This client's record of what IT last wrote to each file — the common ancestor it uses
  // to tell an authored edit from its own write after a restart (see SHADOW_FILE). It is
  // per-client by definition: syncing it would hand every peer a false ancestor.
  '.hive-shadow.json',
  // ...and its write-then-rename temp, which exists for an instant but is the same file.
  '.hive-shadow.json.tmp',
  // Names a PID on THIS machine. Syncing it would tell every peer their folder is locked by
  // a process that does not exist for them.
  '.hive-lock.json',
  // Copies of files a teammate's delete removed from THIS folder (see keepDeletedCopy). They
  // are this machine's safety net; syncing them would undo every delete in the room.
  '.hive-deleted/',
  '.hive-case-*',
  '*.log', '.DS_Store', 'Thumbs.db', '*.vsix',

  // MOBILE AND CLOUD SECRETS. These are the files a mobile project keeps OUT of git via
  // a NESTED .gitignore (android/.gitignore, ios/.gitignore) -- which is exactly the case
  // this client used to miss, so a real user's `android/key.properties` (Android release
  // signing: storePassword, keyPassword, keyAlias) went through the relay. Nested
  // .gitignore files are read now, but these are listed here as well: the belt-and-braces
  // is cheap, and a leaked signing password is not recoverable by fixing the bug later.
  'key.properties', 'local.properties', 'secrets.properties',
  '*.jks', '*.mobileprovision', '*.p8',
  'google-services.json', 'GoogleService-Info.plist',
  'credentials.json', 'service-account*.json',
  '.npmrc', 'terraform.tfvars', '*.tfstate', '*.tfstate.backup',

  // BUILD OUTPUT that is regenerated from source and has no business crossing a network.
  // Only the unambiguous ones: `build/` and `dist/` are deliberately left to .gitignore,
  // because a handful of real projects keep hand-written files in them.
  '.gradle/', '.dart_tool/', 'ios/Flutter/ephemeral/', 'Pods/', 'DerivedData/',
  '__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.venv/',
]

// Is this "merge" actually a FUSION — output neither author wrote? Returns the reason, or ''.
//
// Exported and pure so it can be tested against crafted inputs. Forcing a real fusion is
// timing-dependent (it needs concurrent writes landing inside the sync window), and a guard
// this important should not be covered only by a test that is inherently flaky.
//
// The two signals, and why each is here:
//   - BROKE IT: both versions parsed and the merged output does not. There is no reading of
//     that which is correct — whatever it produced, neither author wrote it.
//   - DUPLICATION: distinctive lines appear MORE often in the output than in the side they
//     came from. That is content copied rather than merged, and it is what a union of two
//     near-identical versions looks like — the live corruption had `const MAX_OPEN` and
//     `function evictIfOverCap` three times each.
//
// LENGTH IS DELIBERATELY NOT A SIGNAL, and the first version of this got that wrong. "The
// output is about as long as both inputs combined" describes a fusion, but it equally
// describes two authors who each added two hundred lines in different places — a perfectly
// good merge. The test caught it firing on exactly that. Duplication separates them: a
// genuine disjoint merge repeats nothing.
export function fusionReason(merged, mine, theirs, lang) {
  if (!merged || !mine || !theirs || mine === theirs) return ''
  // If a side was ALREADY broken, the merge did not break it — blaming the merge would make
  // every merge on a half-written file look like corruption.
  if (lang && lang.parses(mine) && lang.parses(theirs) && !lang.parses(merged)) {
    return 'the merged result does not parse, although BOTH versions did'
  }
  // Only distinctive lines: a closing brace or a blank line legitimately repeats, and
  // counting those would make every file look duplicated.
  const sig = (s) => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 24)
  const tally = (arr) => { const m = new Map(); for (const l of arr) m.set(l, (m.get(l) || 0) + 1); return m }
  const M = tally(sig(merged)), A = tally(sig(mine)), B = tally(sig(theirs))
  let dup = 0, seen = 0
  for (const [line, n] of M) {
    const expected = Math.max(A.get(line) || 0, B.get(line) || 0)
    if (expected === 0) continue // content in neither side — new, and not our business here
    seen++
    if (n > expected) dup++
  }
  // Needs enough lines to mean anything, and enough of them repeated to be structural rather
  // than one unlucky duplicated statement.
  if (seen >= 10 && dup / seen >= 0.25) {
    return `${dup} of ${seen} distinctive lines appear more often in the result than in either version — that is content duplicated, not merged`
  }
  return ''
}

const endNl = (s) => (s === '' || s.endsWith('\n') ? s : s + '\n')

// SAME-LINE RACE (P0-F, docs/rules-rewrite/p0f-design.md). Two saves of one line made before either
// client saw the other reach the shared Y.Text as concurrent character edits, and the CRDT keeps both:
// "ship friday" saved as "ship monday" and "ship tuesday" became "ship montuesday" in every folder, and
// the same change twice became "ship monmonday". Every version from 0.6.0 to 0.14.3 did it. So each save
// also records its INTENT -- the line hunks it changed and a hash of the text it was made from -- in the
// same transaction, and these pure functions decide from the intents what the file should say.
//
// An intent: { b: contentHash(base), h: [[baseStart, baseEnd, newLines]...] }. Null when the diff is too
// big to describe (lineHunks gave up) or the hunks are larger than INTENT_MAX_LINES: no detection then,
// exactly as before.
const INTENT_MAX_LINES = 400
export function intentHunks(base, next) {
  const a = base.split('\n'), b = next.split('\n')
  const hs = lineHunks(a, b)
  if (!hs) return null
  let n = 0
  const out = hs.map(([bs, be, ss, se]) => { n += se - ss; return [bs, be, b.slice(ss, se)] })
  return n > INTENT_MAX_LINES ? null : out
}
// The base text with one intent's hunks applied: that author's whole version.
export function applyIntent(base, h) {
  const lines = base.split('\n')
  for (const [bs, be, nl] of [...h].sort((x, y) => y[0] - x[0])) lines.splice(bs, be - bs, ...nl)
  return lines.join('\n')
}
// Can two saves made from the same text damage each other in the character CRDT? (Opus-Cloud's rule,
// fuzzed at 0 bad over about 78k pairs.) applyDiff sends ONE character span per save, from its first
// changed line to its last, so a save's footprint is [first hunk start, last hunk end), not its hunks:
// A editing lines 1 and 5 while B edits line 3 lost B's line under a per-hunk rule (8,439 of 49,748
// "no clash" pairs fused or lost an edit). Footprints that overlap clash. Footprints that only touch
// clash too, because a pure insertion or deletion slides along repeated text into its neighbour, except
// two same-size line replacements side by side: that is the W1 shape, and the CRDT merges it correctly
// (0 of 915 fused), so it must not become a conflict as the fork gate makes it.
const footprint = (h) => (h.length ? [h[0][0], h[h.length - 1][1], h.length === 1 ? h[0][2] : null] : null)
export function hunksClash(h1, h2) {
  const a = footprint(h1), b = footprint(h2)
  if (!a || !b) return false
  if (Math.max(a[0], b[0]) < Math.min(a[1], b[1])) return true
  const rep = (f) => f[2] !== null && f[1] > f[0] && f[1] - f[0] === f[2].length
  const touch = a[1] === b[0] || b[1] === a[0] || (a[0] === a[1] && a[0] >= b[0] && a[0] <= b[1]) || (b[0] === b[1] && b[0] >= a[0] && b[0] <= a[1])
  return touch && !(rep(a) && rep(b))
}
// Do two saves change the same base LINE? The finer question, asked inside a clash: when no two saves
// do, they can all be applied cleanly and the result needs no markers.
export function linesOverlap(h1, h2) {
  for (const [a0, a1] of h1) for (const [b0, b1] of h2) {
    if (Math.max(a0, b0) < Math.min(a1, b1)) return true
    if (a0 === a1 && b0 < a0 && a0 < b1) return true
    if (b0 === b1 && a0 < b0 && b0 < a1) return true
  }
  return false
}
// Two hunks share a base line: spans that overlap, or a line inserted strictly inside the other's span.
function spansMeet([a0, a1], [b0, b1]) {
  if (Math.max(a0, b0) < Math.min(a1, b1)) return true
  if (a0 === a1 && b0 < a0 && a0 < b1) return true
  if (b0 === b1 && a0 < b0 && b0 < a1) return true
  return false
}
// The clash region and everything around it, for intents (Map clientID -> h) all made from `base`.
// [rs, re) spans every base line that two intents both changed. Outside it the intents' hunks are
// disjoint, so the lines before and after are the base's with those hunks applied, the same for every
// author; inside it each author has their own version. Null when nothing clashes.
export function clashRegion(base, intents) {
  let rs = Infinity, re = -Infinity
  const all = [...intents.values()]
  for (let i = 0; i < all.length; i++) for (let j = 0; j < all.length; j++) {
    if (i === j) continue
    for (const hi of all[i]) if (hunksClash([hi], all[j])) { rs = Math.min(rs, hi[0]); re = Math.max(re, hi[1]) }
  }
  if (rs === Infinity) return null
  const b = base.split('\n')
  // Before the region, inside it, or after. An insertion AT either edge is inside: it touches the clash.
  const where = ([bs, be]) => (be < rs || (be === rs && bs < rs) ? 'pre' : bs > re || (bs === re && be > re) ? 'post' : 'in')
  const hs = tagged(intents)
  const pre = applyTagged(b.slice(0, rs), hs.filter((x) => where(x) === 'pre'))
  const post = applyTagged(b.slice(re), hs.filter((x) => where(x) === 'post'), re)
  const inside = hs.filter((x) => where(x) === 'in')
  const sides = new Map()
  for (const id of [...intents.keys()].sort((x, y) => x - y)) sides.set(id, applyTagged(b.slice(rs, re), inside.filter((x) => x[3] === id), rs))
  return { rs, re, pre, post, sides, inside }
}
// Every hunk tagged with its author, in the one order every peer applies them: from the bottom up; at one
// start line a span before an insertion there (inserting first let the span delete the inserted line);
// insertions at one point higher client first, so the lower client's lines come first. Never arrival order.
function tagged(intents) {
  return [...intents].flatMap(([id, h]) => h.map((x) => [x[0], x[1], x[2], id])).sort((x, y) => y[0] - x[0] || (y[1] - y[0]) - (x[1] - x[0]) || y[3] - x[3])
}
function applyTagged(lines, hs, off = 0) { for (const [bs, be, nl] of hs) lines.splice(bs - off, be - bs, ...nl); return lines }
// What the file should say once these intents (every save made from `base` at that moment) are folded in.
// Every peer computes the same text:
//  - no two authors changed the same line: every change applied cleanly (the merge the CRDT got wrong);
//  - otherwise one marker block over the region where they did, holding each distinct version once, in
//    client order; an author who left that region as it was is not a version. Changes elsewhere, by
//    anyone, are applied around the block. (merge3 cannot fold a third version in: it strips existing
//    markers so blocks never nest, and the third author's line was lost that way, R6.)
export function clashFinal(base, intents, names = new Map()) {
  const r = clashRegion(base, intents)
  if (!r) return applyTagged(base.split('\n'), tagged(intents)).join('\n')
  const reg = base.split('\n').slice(r.rs, r.re)
  const changed = [...r.sides].filter(([, l]) => J(l) !== J(reg))
  const meet = r.inside.some((p, i) => r.inside.some((q, j) => j > i && p[3] !== q[3] && J(p.slice(0, 3)) !== J(q.slice(0, 3)) && spansMeet(p, q)))
  let mid
  if (!changed.length) mid = reg
  else if (!meet) {
    const seen = new Set()
    mid = applyTagged(reg.slice(), r.inside.filter((x) => { const k = J(x.slice(0, 3)); if (seen.has(k)) return false; seen.add(k); return true }), r.rs)
  } else {
    const distinct = []
    for (const [id, lines] of changed) if (!distinct.some((d) => J(d.lines) === J(lines))) distinct.push({ id, lines })
    const label = (id) => String(names.get(id) || `client ${id}`).replace(/[\r\n]/g, ' ')
    if (distinct.length === 1) mid = distinct[0].lines
    else if (distinct.length === 2) mid = [`<<<<<<< ${label(distinct[0].id)}`, ...distinct[0].lines, '=======', ...distinct[1].lines, `>>>>>>> ${label(distinct[1].id)}`]
    else {
      // Plain separators: a labelled one ("======= Bob") is not one any merge reads, and a late save
      // merged against such a block lost every version in it (late-save-merge-test L2).
      mid = [`<<<<<<< ${label(distinct[0].id)}`, ...distinct[0].lines]
      for (const d of distinct.slice(1)) mid.push('=======', ...d.lines)
      mid.push(`>>>>>>> ${distinct.slice(1).map((d) => label(d.id)).join(', ')} (${distinct.length} versions)`)
    }
  }
  return [...r.pre, ...mid, ...r.post].join('\n')
}
const J = (x) => JSON.stringify(x)
// The text every folder holds once these saves (Map clientID -> hunks, all made from `base`) have crossed:
// their character union. It depends only on the base text, each author's text and their client ids, not on
// the history that built the base (tests/same-line-intent-unit-test.mjs, CU rows), so every peer can
// rebuild it exactly from the intents alone.
export function clashUnion(base, intents, laters = []) {
  const root = new Y.Doc(); root.clientID = 0; root.getText('t').insert(0, base)
  const seed = Y.encodeStateAsUpdate(root)
  const docs = new Map()
  for (const [id, h] of [...intents].sort((x, y) => x[0] - y[0])) { const d = new Y.Doc(); d.clientID = id; Y.applyUpdate(d, seed); applyDiff(d.getText('t'), applyIntent(base, h)); docs.set(id, d) }
  // A later save (F5): made by `id` on a text that already held the saves in `after`, so its doc had their
  // updates (and its own earlier ones, if `id` saved before) when it applied its hunks.
  for (const L of laters) {
    let d = docs.get(L.id)
    if (!d) { d = new Y.Doc(); d.clientID = L.id; Y.applyUpdate(d, seed); docs.set(L.id, d) }
    for (const a of L.after) if (a !== L.id && docs.has(a)) Y.applyUpdate(d, Y.encodeStateAsUpdate(docs.get(a)))
    const t = d.getText('t')
    applyDiff(t, applyIntent(t.toString(), L.h))
  }
  const all = [...docs.values()]
  if (!all.length) { root.destroy(); return base }
  const ups = all.map((d) => Y.encodeStateAsUpdate(d))
  for (const u of ups) Y.applyUpdate(all[0], u)
  const out = all[0].getText('t').toString()
  for (const d of all) d.destroy(); root.destroy()
  return out
}
// F5: which text was a later save made from? A save that arrives while a race from `base` is pending, but
// was made from another text, was usually made from what its author held: one side of the race, or the
// clean merge of several sides that do not clash. Returns { after, text } -- the saves that text held and
// the text itself -- when `bHash` is the hash of such a text, else null. Never a FUSED union: a version made
// from fused text would carry the fused line into the resolution as if someone had written it.
// A SAME-LINE SAVE THAT ARRIVES AFTER THE RACE WAS RESOLVED (P0-F-12). `base` is the text the save was made
// from and `side` the author's file. The save reached the shared text as a character edit made against
// `base`, but the room had already replaced that line with a conflict block, so the CRDT put what the save
// inserted next to the characters it was anchored on, which the block had deleted: `wednes<<<<<<< Bob`.
// Returns the room's text before the save -- `current` with the save's inserted text taken out -- when
// that is a well-formed block whose versions are other edits of the lines this save changed. Null
// otherwise: not this shape, so not ours to repair.
export function lateOverBlock(base, side, current) {
  let p = 0
  while (p < base.length && p < side.length && base[p] === side[p]) p++
  let s = 0
  while (s < base.length - p && s < side.length - p && base[base.length - 1 - s] === side[side.length - 1 - s]) s++
  const ins = side.slice(p, side.length - s)
  // (Not hasConflictMarkers: the opener this repairs no longer starts its line.)
  if (!ins || !/<<<<<<< |>>>>>>> /.test(current) || current.includes(side)) return null
  // Already a version of a block in the room: nothing to repair.
  const cv = blockVersions(current)
  if (cv && cv.versions.includes(side)) return null
  const mine = intentHunks(base, side)
  if (!mine || !mine.length) return null
  const lo = mine[0][0], hi = mine[mine.length - 1][1]
  for (let i = current.indexOf(ins); i >= 0; i = current.indexOf(ins, i + 1)) {
    // The CRDT can only have put it where its anchor characters were, and the block deleted those: at an
    // edge of the block, just before its opener or at the end of its closing line. Anywhere else (inside a
    // version, say) it is someone's text, not a stray.
    const before = current.slice(0, i), after = current.slice(i + ins.length)
    const lineStart = before.lastIndexOf('\n') + 1
    const atOpen = after.startsWith('<<<<<<< ') && lineStart === i
    const atClose = /^>>>>>>> /.test(current.slice(lineStart, i)) && (after === '' || after[0] === '\n')
    if (!atOpen && !atClose) continue
    const x = before + after
    if (!hasConflictMarkers(x) || /[^\n](<<<<<<< |>>>>>>> )/.test(x)) continue
    const bv = blockVersions(x)
    if (!bv || bv.versions.length < 2) continue
    // Every version the block holds is an edit of this save's lines, from `base`. It may differ from
    // `base` elsewhere too: someone changed another line since (a far line, in same-line-soak-test seed
    // 3, and the repair was refused). The late-save merge carries that change into every version.
    const ok = bv.versions.every((v) => {
      const h = intentHunks(base, v)
      return h && h.some(([bs, be]) => be >= lo && bs <= hi)
    })
    if (ok) return x
  }
  return null
}
export function explainBase(base, firsts, bHash) {
  const ids = [...firsts.keys()].sort((x, y) => x - y).slice(0, 6)
  const pick = (k, from = 0) => (k === 0 ? [[]] : ids.slice(from).flatMap((id, i) => pick(k - 1, from + i + 1).map((r) => [id, ...r])))
  for (let k = 1; k <= ids.length; k++) for (const sub of pick(k)) {
    const m = new Map(sub.map((i) => [i, firsts.get(i)]))
    const t = clashUnion(base, m)
    if (contentHash(t) === bHash && t === clashFinal(base, m)) return { after: sub, text: t }
  }
  return null
}
export function clashOnlyRegion(base, intents, final, current, laters = []) {
  if (final === current) return true
  if (!clashRegion(base, intents)) return false
  return current === clashUnion(base, intents, laters)
}

// HIV-P17. Why a creation race of relPath must NOT land, '' when it may: 'CONFLICT' when two whole
// files collide in a file with a language, else fusionReason's answer when a clean-looking union
// broke code both sides could parse. No language (Markdown) is never refused.
export function creationRaceVerdict(r0, mine, theirs, relPath) {
  const code = supports(relPath)
  return r0.conflict ? (code ? 'CONFLICT' : '') : fusionReason(r0.text, endNl(mine), endNl(theirs), code ? languageFor(relPath) : null)
}

// HIV-P17 dead heat: several clients published one file into an empty doc before any saw another, and
// the CRDT unioned them. textsByClient = each creator's live text, keyed by Yjs client id. The winner
// is the lowest id -- every peer holds the same union, so every peer picks the same one. The creators
// are folded in ONE BY ONE and each step is judged, because the union is what would land: with three
// creators, two can each merge cleanly with the winner and still fuse with each other.
export function deadHeatVerdict(textsByClient, relPath) {
  const [winner, ...others] = [...textsByClient.keys()].sort((a, b) => a - b)
  const winnerText = textsByClient.get(winner) || ''
  let acc = winnerText
  for (const c of others) {
    const t = textsByClient.get(c) || ''
    const r = icrMerge3('', endNl(acc), endNl(t), relPath)
    const why = creationRaceVerdict(r, acc, t, relPath)
    if (why) return { winner, winnerText, why }
    acc = r.text
  }
  return { winner, winnerText, why: '' }
}

const IGNORE = new Set(['node_modules', '.git'])
const MAX_BYTES = 1_000_000
const MAX_BINARY_BYTES = Number(process.env.HIVE_MAX_BINARY_BYTES) || (5 * 1024 * 1024)
const BOARD_FILE = 'HIVE_BOARD.md' // generated locally from `board`; never synced as a file
const CHAT_FILE = 'HIVE_CHAT.md'   // generated locally from `chat`; the agents' conversation
const TASKS_FILE = 'HIVE_TASKS.md' // generated locally from `tasks`; directed work + approvals
const CONFIG_FILE = '.hive.json'   // local rendezvous config (room id); not synced
const SHADOW_FILE = '.hive-shadow.json' // what THIS client last wrote per file; the cross-restart ancestor
const LOCK_FILE = '.hive-lock.json'     // one sync client per folder; see acquireFolderLock
const DELETED_DIR = '.hive-deleted'     // copies of files a teammate's delete removed here; see keepDeletedCopy
const DELETED_KEEP_MS = 7 * 24 * 3600 * 1000 // ...pruned at start once they are a week old
// Local deletes wait this long for the deleting to stop, then leave as one batch. See settleLocalDeletes.
const DELETE_SETTLE_MS = Number(process.env.HIVE_DELETE_SETTLE_MS) || 1500
const BULK_DELETE = 5 // a batch this big is announced in the room, not just logged
const ID_FILE = '.hive-id.json'    // this client's substrate signing identity (private); never synced
const RULES_FILE = 'HIVE_RULES.md' // the law every participant follows; written into every room
const MEMBERS_FILE = 'HIVE_MEMBERS.md' // live presence: who is in the room right now
// The claim map is the stigmergic trace agents SENSE before editing (see `claims` below), but it
// was the one part of the room that never reached disk — so an agent could only learn it by
// remembering to call a tool, and a trace nobody can see coordinates nothing. Rendered here for
// the same reason HIVE_CHAT.md is: a file in the working folder needs no tool call and no memory.
const CLAIMS_FILE = 'HIVE_CLAIMS.md'
const AGENTS_FILE = 'HIVE_FOR_AGENTS.md' // how an AI agent opening this folder joins (via .hive.json) + behaves
// Generated/coordination files are rendered locally from CRDT state — never
// synced as ordinary files (that would cause echo loops / conflicts).
// Exported for hive-branch.js: a tracked file with one of these names never reaches the room.
export const SKIP = new Set([BOARD_FILE, CHAT_FILE, TASKS_FILE, CONFIG_FILE, ID_FILE, RULES_FILE, MEMBERS_FILE, CLAIMS_FILE, AGENTS_FILE])
// Files a client writes into its folder for ITSELF. They are ignored on purpose, so the "created
// here but is ignored" notice must never name them: on 27 Sep 2026 every agent joining a live room
// told the whole team about .hive-shadow.json, a file none of them had made.
const OWN_LOCAL = new Set([SHADOW_FILE, SHADOW_FILE + '.tmp', LOCK_FILE, '.hive-mcp-session.json', '.hive-stop-hook.json', '.hive-id.json'])

// Written into every room folder on sync (like the rules). An AI agent that opens
// this project reads it to learn it's a Hivecode room and how to JOIN — via the
// .hive.json already in the folder, so no human has to paste a link.
const AGENT_MANUAL_TEXT = AGENT_MANUAL // hive-instructions.js: one source for every agent-facing text (0.14.4)

// The hive's law. Auto-written into every room folder so it is ALWAYS present —
// no setup, no relying on an agent to remember it. The sync layer enforces the
// hard parts (merge, board); this is the rest, in plain imperative language.
const HIVE_RULES_TEXT = RULES_MD // hive-instructions.js (0.14.4); HIVE_RULES.md in the package is generated from it

/**
 * Where an account licence may come from, in precedence order — and where it may NOT.
 *
 *   1. an explicit argument (the extension reads it from SecretStorage and passes it here)
 *   2. $HIVE_LICENSE            (the MCP config's env block: per-machine, not in the repo)
 *   3. ~/.hivecode/config.json  (the CLI's home, for anyone not going through MCP)
 *
 * NOT from the join link, and not from `.hive.json` in the project folder. Both of those are
 * shared or committed: `.hive.json` sits in the repo, and the link is pasted into chat and
 * written into HIVE_FOR_AGENTS.md, which is itself synced to every participant. A billing
 * credential that travels with an invitation is a credential that bills you for strangers.
 */
export function resolveLicense(explicit) {
  const e = (explicit || '').trim()
  if (e) return e
  const env = (process.env.HIVE_LICENSE || '').trim()
  if (env) return env
  try {
    const p = path.join(os.homedir(), '.hivecode', 'config.json')
    const c = JSON.parse(fs.readFileSync(p, 'utf8'))
    const k = (c && (c.license || c.licenseKey) || '').trim()
    if (k) return k
  } catch { /* absent or unreadable -> anonymous, which is a valid state */ }
  return ''
}

/**
 * ONE CLIENT PER FOLDER. Refuses a second sync process on the same directory.
 *
 * Nothing prevented this before, and the identical mistake once cost another tool most of a journal:
 * nothing refused a second watcher on one graph, two processes appended concurrently, their
 * writes interleaved, and 99% of the journal became unreadable -- while the watermark went
 * on claiming the files were indexed. The failure is silent, and it is discovered much later
 * by someone trying to read the data.
 *
 * Here the damage would be two clients with two shadow files, two fork bases and two views
 * of the same disk, racing to reconcile the same paths. The CRDT would converge; the local
 * files would not.
 *
 * Returns a release function. A lock whose PID is gone is stale and is taken over -- a
 * crashed process must not lock a folder forever, which is the failure mode that makes
 * people delete lock files by hand and lose the protection entirely.
 */
export function acquireFolderLock(root, room, log = console.log) {
  const lockPath = path.join(root, LOCK_FILE)
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const prev = JSON.parse(raw)
    if (prev && typeof prev.pid === 'number' && prev.pid !== process.pid) {
      let alive = false
      // Signal 0 checks existence without delivering anything, and works on Windows.
      try { process.kill(prev.pid, 0); alive = true } catch { alive = false }
      if (alive) {
        const err = new Error(
          `Q470 this folder is already synced by process ${prev.pid}` +
          (prev.room && prev.room !== room ? ` (in room ${prev.room})` : '') +
          `. Two clients on one folder corrupt each other's view of the files. ` +
          `Stop that process, or use a different folder.`,
        )
        err.code = 'EHIVELOCKED'
        err.pid = prev.pid
        throw err
      }
      log(`[hive] taking over a stale lock from process ${prev.pid} (no longer running)`)
    }
  } catch (e) {
    if (e && e.code === 'EHIVELOCKED') throw e
    // Absent or unparseable: nothing to respect. An unreadable lock is not a reason to
    // refuse to start, or a corrupted byte would brick the folder.
  }
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, room, at: Date.now() }))
  } catch { /* read-only dir: proceed unlocked rather than refuse to run */ }
  let released = false
  const release = () => {
    if (released) return
    released = true
    // Only remove OUR lock. Removing someone else's would hand the folder to a third
    // process while the second is still writing to it.
    try {
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      if (cur && cur.pid === process.pid) fs.unlinkSync(lockPath)
    } catch { /* already gone */ }
  }
  return release
}

export function startSync({ relay = 'ws://localhost:1234', room = 'default', dir = '.', name = 'anon', kind = 'human', owner = '', token = '', license = '', log = console.log, syncFiles = true, passive = false, listener = false, app = '', gatesDir: gatesDirOpt = '' }) {
  // Where this machine keeps its gate approvals (0.14.4 S-1): outside the synced folder, so no peer can write one.
  const GATES_DIR = gatesDirOpt || gatesDir()
  const gateSkipSaid = new Set() // (agent, command) pairs already announced as unchecked
  // BEFORE ANY DISK OR SOCKET WORK. A name outside the mention grammar joins successfully and is
  // then unreachable: its mail, its obligations and its wake-on-mention are all silently dead,
  // and the only symptom is other people being told "@X is NOT in the room" about someone who is
  // sitting right there. Refusing here costs the caller one clear error; allowing it cost an hour
  // on 20 Sep 2026 and was only found because a human noticed the routing failures by eye.
  // This throws rather than returning, because startSync has no failure channel and a half-joined
  // client is worse than no client.
  const nameCheck = validateMemberName(name)
  if (!nameCheck.ok) {
    const e = new Error(`${nameCheck.error} Try "${nameCheck.suggested}".`)
    e.code = 'EHIVEINVALIDNAME'
    e.suggested = nameCheck.suggested
    throw e
  }
  // THE SAME PRIVACY GATE hive-mcp.js applies at join, repeated here because this is the
  // real choke point. Every client in the product -- the MCP server, hive-agent.js, the
  // CLIs, every demo script -- reaches the network through this one function, and a guard
  // that lives only in the MCP layer protects only agents that went through the MCP layer.
  // An operator who sets HIVE_RELAY_PIN is entitled to expect it means "this machine",
  // not "this machine, except for the seven scripts that call startSync directly".
  //
  // It throws for the reason the name check above throws: startSync has no failure channel,
  // and a client that half-connects to a relay nobody authorised is the failure this exists
  // to prevent. Refusing here means no socket was opened and no file was published.
  // A retired public relay is followed to its replacement here too, because every node client
  // (hive-agent.js, hive-say.js, the demos) reaches the network through this function and not
  // through hive-mcp.js's resolveRoom. The privacy check below then judges the relay actually
  // dialled, not the one that was asked for.
  const moved = currentRelayFor(relay)
  if (moved.migratedFrom) {
    relay = moved.relay
    try { log(`relay ${moved.migratedFrom} has been retired; using ${relay}`) } catch { /* log is optional */ }
  }
  const priv = checkRelay({ relay, env: process.env, dir: path.resolve(dir), fs })
  if (!priv.ok) {
    const e = new Error(`${priv.headline}\n\n${priv.detail}`)
    e.code = 'EHIVERELAYPIN'
    e.qcode = priv.code
    throw e
  }
  const ROOT = path.resolve(dir)
  fs.mkdirSync(ROOT, { recursive: true })
  // FIRST, before any socket or file work: if another client already holds this folder,
  const releaseLock = syncFiles ? acquireFolderLock(ROOT, room, log) : () => {}
  // Set once this folder stops existing under a running session (see loseFolder). From then on
  // nothing in it is written, moved or deleted, and no local absence is sent to the room as a delete.
  let folderLost = null
  if (syncFiles) pruneDeletedCopies()

  // Respect .gitignore (+ always-ignore secrets/junk) so we never sync a
  // teammate's .env, keys, or build output. Reloaded by reloadIgnores().
  //
  // GIT HONOURS A .gitignore IN EVERY DIRECTORY, not just the repository root, and reading
  // only the root one is how a real user's `android/key.properties` reached the relay: it
  // is ignored by `android/.gitignore`, which this never opened. Flutter, Android, iOS,
  // Gradle and most monorepos all put their real ignore rules in nested files, so the root
  // file alone is close to no filter at all for exactly the projects that carry secrets.
  //
  // Rules are scoped to the directory that declared them, which is what git does: a
  // pattern in `android/.gitignore` may only ever match paths under `android/`. A single
  // flattened ignore list would be wrong in the dangerous direction -- `build/` written in
  // one subproject would silently stop syncing another subproject's source.
  let ig = ignore()
  let nested = [] // [{ prefix: 'android/', ig }] -- one entry per nested .gitignore found

  function collectGitignores(dir, rel, out, depth) {
    if (depth > 12) return // pathological trees; a .gitignore 12 levels down is not real
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || IGNORE.has(e.name)) continue
      const sub = path.join(dir, e.name)
      const subRel = rel ? rel + '/' + e.name : e.name
      try {
        out.push({ prefix: subRel + '/', ig: ignore().add(fs.readFileSync(path.join(sub, '.gitignore'), 'utf8')) })
      } catch { /* no .gitignore in this directory */ }
      collectGitignores(sub, subRel, out, depth + 1)
    }
  }

  function reloadIgnores() {
    ig = ignore().add(ALWAYS_IGNORE)
    try { ig.add(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')) } catch { /* no .gitignore */ }
    nested = []
    collectGitignores(ROOT, '', nested, 0)
  }
  reloadIgnores()

  const isIgnored = (relPath) => {
    if (!relPath) return false
    if (ig.ignores(relPath)) return true
    for (const n of nested) {
      if (!relPath.startsWith(n.prefix)) continue
      const sub = relPath.slice(n.prefix.length)   // path relative to the declaring directory
      if (sub && n.ig.ignores(sub)) return true
    }
    return false
  }

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
  const reviews = doc.getMap('reviews') // relPath -> Array of { by, at, verdict: 'pass'|'fail', note, hash }
  // ATTESTATION LEDGER — path -> { <peerName>: { bytes, lines, at } }.
  //
  // The one thing a four-agent build could not do without a human relaying numbers by hand: tell
  // whether two folders actually hold the same file. Measured on the JARVIS run (2026-07-29):
  // engine/brain/llm.js was 178 lines and parsing in one folder and 22,312 lines with 73 conflict
  // markers in two others, and the agent with the clean copy reported a green suite in good faith
  // for hours. Nothing in the product could have told any of them.
  //
  // Why bytes per PEER rather than a single value: a CRDT map keyed by peer name MERGES instead of
  // last-writer-wins, so two peers attesting different byte counts both survive and the
  // DISAGREEMENT becomes the signal. One shared "size" field would have silently converged on
  // whichever peer wrote last, which is precisely the failure it exists to catch.
  const swarmAttest = doc.getMap('swarm_attest')
  const swarmVersions = doc.getMap('swarm_versions')

  function bumpAttestVersion(relPath, newText) {
    if (!swarmAttest.has(relPath)) return // only bump files that already have attestations
    const prev = swarmVersions.get(relPath) || { n: 1, hash: '' }
    const newHash = contentHash(newText)
    if (prev.hash !== newHash) {
      swarmVersions.set(relPath, { n: (prev.n || 1) + 1, hash: newHash })
    }
  }
  // GATE VERDICTS — `<region>|<peerName>` -> the result of that peer running the room's check in
  // ITS OWN folder before handing the file back. Keyed per peer for the same reason swarmAttest
  // is: "the tests pass" is a fact about one folder's bytes, and storing it as a single shared
  // value would converge on whoever released last, silently erasing the disagreement that is the
  // entire signal. Two agents reporting different verdicts for one path both survive here.
  const gateResults = doc.getMap('gate_results')

  // --- BATCHED ROOM-DOC MUTATIONS (manifest + historyMeta) ---
  // A seeder publishing N files previously sent N manifest.set() updates and N historyMeta.set()
  // updates — 2N distinct Yjs updates on the base-room socket. On the free tier (burst 600, 60/s)
  // this throttled the base room at file ~300.
  // We batch pending operations into a single doc.transact() flushed on setImmediate (or synchronously on stop()).
  const pendingManifestOps = new Map() // relPath -> 'set' | 'delete'
  const pendingHistoryMeta = new Map() // id -> { op: 'set' | 'delete', record?: any }
  let roomFlushTimer = null

  function inManifest(relPath) {
    if (pendingManifestOps.has(relPath)) {
      return pendingManifestOps.get(relPath) === 'set'
    }
    return manifest.has(relPath)
  }

  function flushRoomDoc() {
    if (roomFlushTimer) {
      clearImmediate(roomFlushTimer)
      roomFlushTimer = null
    }
    if (!pendingManifestOps.size && !pendingHistoryMeta.size) return
    doc.transact(() => {
      for (const [r, op] of pendingManifestOps) {
        if (op === 'set') manifest.set(r, 1)
        else manifest.delete(r)
      }
      pendingManifestOps.clear()

      for (const [id, item] of pendingHistoryMeta) {
        if (item.op === 'set') historyMeta.set(id, item.record)
        else historyMeta.delete(id)
      }
      pendingHistoryMeta.clear()
      pruneMeta()
    })
  }

  function scheduleRoomFlush() {
    if (stopped) { flushRoomDoc(); return }
    if (!roomFlushTimer) {
      roomFlushTimer = setImmediate(flushRoomDoc)
    }
  }

  function queueManifestSet(relPath) {
    pendingManifestOps.set(relPath, 'set')
    scheduleRoomFlush()
  }

  function queueManifestDelete(relPath) {
    if (!manifest.has(relPath)) {
      pendingManifestOps.delete(relPath)
    } else {
      pendingManifestOps.set(relPath, 'delete')
    }
    scheduleRoomFlush()
  }

  // CLAIM LEASE. Expiry is evaluated lazily on read, so the moment a lease passes its TTL the
  // next agent that tries simply gets the file -- that is what stops a stalled agent
  // deadlocking the room.
  //
  // The 5-minute default is unchanged, but it is now overridable, because 5 minutes is longer
  // than some agents work at all: on a 300s run the lease is exactly as long as the whole run,
  // so the protection can never fire and a held file stays held to the end. Measured on a real
  // take -- one file drew 17 claim attempts and 3 releases while eight messages asked who had it.
  const CLAIM_TTL_MS = Number(process.env.HIVE_CLAIM_TTL_MS) || 300000
  // How long anyone may hold a file IN TOTAL, across renewals. The ttl alone only catches a
  // holder that goes SILENT; a holder that keeps working renews forever, which is how one agent
  // held two files for an entire 300s run while six others waited. Default is 3x the ttl so
  // existing behaviour is unchanged for anyone who does not set it.
  const CLAIM_MAXHOLD_MS = Number(process.env.HIVE_CLAIM_MAXHOLD_MS) || CLAIM_TTL_MS * 3
  const coordinator = makeCoordinator(claims, name, { ttl: CLAIM_TTL_MS, maxHold: CLAIM_MAXHOLD_MS })
  // MY declared intent per region — recorded on every claim ATTEMPT, kept locally.
  // The provenance stamp reads this (not the shared claim map) so an agent always signs
  // ITS OWN intent: under a true concurrent collision the shared claim converges to ONE
  // winner, and reading it would misattribute the loser's receipt with the winner's WHY.
  const myIntents = new Map()

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
      const intent = myIntents.get(relPath) || (c && c.by === name && c.intent) || 'edit'
      const ch = authorChange({ identity, filename: relPath, base: base == null ? '' : base, text: next, intent, at: Date.now() })
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
  // NOTHING THIS CLIENT PUBLISHES ENTERS THE ROOM UNSIGNED (0.14.3 P0-3). With the fork gate on, a
  // local edit is signed by captureLocal, which needs a baseline (`shadow`) to diff against. An edit
  // made before the file first synced on a fresh join has none, and the rejoin and creation-race
  // merges publish without passing through it at all. The content still landed, so the file's chain
  // broke: `pr` then refused with a false Q506 ("the branch holds content this room has never seen")
  // on a branch nobody had touched, and credited the file to the last agent that HAD signed (8-9 Nov
  // mock run, test.js in demo-3). So after any local publish: if no receipt yields exactly what was
  // published, sign it now, from the room's copy it replaced -- the state the room provably held.
  // Only when THIS client's own edit went out unsigned: if captureLocal signed the authored text (or
  // anyone signed what was published), nothing is added, so the fork gate sees exactly what it saw
  // before. A receipt for a merged result is never added beside a signed edit: detectFork stops at a
  // current text that has a receipt, and that must not hide a real fork.
  function signPublished(relPath, roomBefore, published, authored = published) {
    if (!PROVENANCE || !identity || published == null || published === roomBefore) return
    const fe = fileDocs.get(relPath); if (!fe || !fe.ledger) return
    const hp = contentHash(published), ha = authored == null ? null : contentHash(authored)
    const rc = fe.ledger.toArray()
    if (rc.some((r) => r && (r.contentHash === hp || (ha && r.author === identity.id && r.contentHash === ha)))) return
    stampIntent(relPath, roomBefore == null ? '' : roomBefore, published)
  }
  function attestHead(relPath, landed, base) {
    if (!PROVENANCE || !identity || landed == null) return
    const fe = fileDocs.get(relPath); if (!fe || !fe.head) return
    try {
      const cur = fe.head.get('cur')
      if (cur && cur.hash === contentHash(landed)) return // head already attests this content
      const c = coordinator.sense(relPath)
      const at = Date.now()
      const intent = myIntents.get(relPath) || (c && c.by === name && c.intent) || 'edit'
      const ch = authorChange({ identity, filename: relPath, base: base == null ? '' : base, text: landed, intent, at })
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
    let disk = null; try { disk = readDiskText(path.join(ROOT, relPath)) } catch { return false }
    const base = shadow.get(relPath)
    if (base == null || disk === base) return false // no baseline yet, or nothing new on disk
    if (hasConflictMarkers(disk)) return false      // half-edited conflict block — not an authored state
    if (!SHARE_SECRETS && newSecrets(disk, fe.text.toString()).length) return false // the ledger is shared: a key stays out of it
    stampIntent(relPath, base, disk)                // into the provenance DAG NOW — clobber-proof
    // What this edit was made against, kept as a short HISTORY, not just the last one: a second edit
    // while the first is still held would otherwise record the first (which the room never had) as
    // the base, and a rejoin merging against it reverts the first edit. The rejoin picks the newest
    // base the room's receipts prove it held.
    const hist = capturedFrom.get(relPath) || []
    if (hist[hist.length - 1] !== base) hist.push(base)
    // Drop from the middle, never the oldest: while the room is refusing every write, the oldest is
    // the only base the room actually held (antigravity-3: nine saves while held evicted it).
    while (hist.length > FROM_KEEP) hist.splice(1, 1)
    capturedFrom.set(relPath, hist)
    shadow.set(relPath, disk)                       // the captured state is the new baseline
    saveShadowSoon()
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
          const m = merge3(base, arr[i].text, arr[j].text, { sideBySide: true }) // the sync rule (#17)
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
    let disk = null; try { disk = readDiskText(path.join(ROOT, relPath)) } catch { }
    forkBases.set(relPath, block) // this peer has now SEEN the markers — a later clean edit from here is a resolution
    if (disk === block) return
    writeToDisk(relPath, block)
    if (!conflicted.has(relPath)) {
      conflicted.add(relPath)
      const who = rec.versions.map((v) => v.name).join(', ')
      log(`[${name}] ⚠ SILENT FORK in ${relPath} — ${who} changed the same region at once; provenance caught it. Surfaced ALL ${rec.versions.length} versions with <<<<<<< markers (rendered locally, not into the shared text).`)
      // Carry each side's SIGNED intent into the announcement: the WHY is what lets any
      // agent in the room reconcile the fork (via hive_resolve) instead of picking a winner.
      const why = rec.versions.map((v) => `${v.name}: "${versionIntent(fe, rec, v.hash) || 'no stated intent'}"`).join(' | ')
      try { postOnce(`fork:${relPath}:${contentHash(rec.versions.map((v) => v.hash).sort().join(',')).slice(0, 16)}`, `⚠ SILENT FORK in ${relPath}: ${who} changed the same region concurrently. Signed intents — ${why}. Surfaced ALL ${rec.versions.length} versions with <<<<<<< markers. ANY agent may reconcile BOTH intents: call hive_resolve with the full resolved file — it is validated (parses, no dangling refs) before it lands.`, { observer: true }) } catch { }
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
  // The VERIFIED signed intent behind one fork version: the receipt that produced this
  // content from the fork's parent, signature-checked — so the WHY a judge reconciles is
  // cryptographically the author's own declaration, not something another peer typed.
  function versionIntent(fe, rec, hash) {
    const r = fe.ledger.toArray().find((r) => r && r.contentHash === hash && r.parent === rec.parent && verifyReceipt(r).ok)
    return (r && r.intent) || ''
  }
  // The active fork as a machine-RESOLVABLE object: the common base plus every divergent
  // version with its author and verified intent. This is what an agent judge reads before
  // proposing a reconciliation — the conflict is data, not just markers on a disk.
  function forkInfo(relPath) {
    const fe = fileDocs.get(relPath); if (!fe) return null
    const rec = forkRecord(fe); if (!rec) return null
    return {
      file: relPath,
      base: rec.base,
      versions: rec.versions.map((v) => ({ name: v.name, author: v.author, intent: versionIntent(fe, rec, v.hash), text: fe.versions.get(v.hash) })),
    }
  }
  // INTENT-AWARE FORK RESOLUTION — the judged path out of a surfaced silent fork.
  // Any participant (typically an AI agent that has read both sides' signed intents via
  // forkInfo / the chat announcement) proposes the FULL reconciled file; the MEDIUM
  // validates it before it may land:
  //   - no conflict markers left behind,
  //   - (supported language) judged as a one-sided change from the fork's base through
  //     ICR structuralMerge: it must PARSE and must not leave a DANGLING reference —
  //     the same guarantee the icr-merge library's resolveMerge gives a judge, so broken
  //     judge output physically cannot ship. (A rename in the proposal even gets its
  //     stale call sites rewritten, same as any merge.)
  // A landed resolution takes the exact convergent path a human resolution takes: it is
  // signed by the resolver, folds the fork versions, clears the record on every peer,
  // and is announced. A refused proposal changes NOTHING — the fork stays surfaced.
  function resolveFork(relPath, proposal) {
    const fe = fileDocs.get(relPath)
    if (!fe || !fe.synced || !fe.conflict) return { ok: false, reason: `no active fork on ${relPath}` }
    const rec = forkRecord(fe)
    if (!rec) return { ok: false, reason: `no active fork on ${relPath}` }
    if (!canWrite(relPath)) return { ok: false, reason: `${relPath} is read-only for you` }
    if (typeof proposal !== 'string' || !proposal.trim()) return { ok: false, reason: 'empty resolution' }
    if (hasConflictMarkers(proposal)) return { ok: false, reason: 'resolution still contains <<<<<<< conflict markers — send the final clean file' }
    if (!SHARE_SECRETS) {
      const key = newSecrets(proposal, fe.text.toString())[0]
      if (key) return { ok: false, reason: `the resolution contains ${describeSecret(key)}, and a resolution is sent to everyone in the room. Read the key from the environment (.env is never shared) and resolve again` }
    }
    let landed = proposal
    if (supports(relPath) && rec.base != null) {
      const v = structuralMerge(rec.base, proposal, rec.base, { filename: relPath })
      if (v.status !== 'auto') return { ok: false, reason: `resolution refused by ICR validation: ${v.reason || (v.conflicts || []).join(', ') || v.status}` }
      landed = v.text
    }
    // INTENT COVERAGE (informational, deterministic): did each side's TOKEN-level
    // changes survive into the landed text? Token granularity is what makes a genuine
    // reconciliation count for both sides (a merged ternary contains both sides' new
    // tokens) while a lazy single-winner judgment shows one side's tokens dropped.
    // A resolution may legitimately pick one side — but that becomes VISIBLE to the
    // room instead of silently passing as a reconciliation. Never refuses.
    const tokSet = (s) => new Set(String(s).match(/[A-Za-z_$]\w*|\d[\w.]*/g) || [])
    const baseToks = tokSet(rec.base || ''), landedToks = tokSet(landed)
    const coverage = rec.versions.map((v) => {
      const vt = fe.versions.get(v.hash)
      const changed = vt == null ? [] : [...tokSet(vt)].filter((t) => !baseToks.has(t))
      const missing = changed.filter((t) => !landedToks.has(t))
      return { name: v.name, covered: missing.length === 0, missing }
    })
    const dropped = coverage.filter((c) => !c.covered)
    const block = forkBlock(fe, rec)
    fe.doc.transact(() => {
      applyDiff(fe.text, landed)
      for (const vv of rec.versions) fe.forkmark.set(vv.hash, 1)
      for (const key of [...fe.conflict.keys()]) fe.conflict.delete(key)
    })
    stampProvenance(relPath, block || rec.base || '', landed)
    writeToDisk(relPath, landed)
    conflicted.delete(relPath)
    known.add(relPath); bases.set(relPath, landed); forkBases.set(relPath, landed)
    const covNote = dropped.length
      ? ` ⚠ Coverage: ${dropped.map((c) => `${c.name}'s changes (${c.missing.slice(0, 5).join(', ')}) did NOT survive`).join('; ')} — the room should sanity-check this judgment.`
      : ' Full intent coverage: every side\'s changes survived token-level.'
    try { say(`⚖ FORK RESOLVED by ${name} (intent-aware): reconciled ${rec.versions.map((v) => v.name).join(' + ')} in ${relPath}. Validated by ICR (parses, no dangling refs) before landing.${covNote}`) } catch { }
    return { ok: true, file: relPath, text: landed, coverage }
  }
  // FIRST-CLASS AUTHORED WRITE — an agent writes THROUGH the medium instead of via
  // disk + a debounced watcher. This closes the capture race COMPLETELY for the write:
  // the author's declared intent is recorded and the (base -> text) transition is
  // stamped into the provenance ledger synchronously, before any concurrent merge or
  // conflict render could contaminate the disk (the fs.watch model's residual window
  // does not exist on this path). The content then lands through the SAME reconcile
  // pipeline as any local edit — merging, fork detection, and conflicts behave
  // identically; only the capture is race-free.
  function editFile(relPath, content, intent) {
    relPath = String(relPath || '').replace(/\\/g, '/')
    if (!relPath || typeof content !== 'string') return { error: 'need a file path and string content' }
    if (!isSafeRelPath(relPath)) return { error: 'unsafe path' }
    if (folderLost) return { error: folderLost.message }
    if (SKIP.has(relPath) || isIgnored(relPath)) return { error: `${relPath} is not a syncable file` }
    if (!canOpen(relPath)) return { error: `${relPath} is out of your scope` }
    if (!canWrite(relPath)) return { error: `${relPath} is read-only for you` }
    if (intent) myIntents.set(relPath, String(intent)) // my declared WHY — what my receipt will sign
    const full = path.join(ROOT, relPath)
    // Written before this file synced: remember what it replaced, the edit's real ancestor (P0-1b).
    // The OLDEST text this folder had since the file started waiting (diskAtOpen) when there is one: an
    // earlier edit with the agent's own file tool sits between it and this write, and the room can only
    // have held the older text (0.14.3 P0-1b-R3).
    { const fe0 = fileDocs.get(relPath); if (!(fe0 && fe0.synced) && !preSyncBase.has(relPath)) { try { preSyncBase.set(relPath, fe0 && typeof fe0.diskAtOpen === 'string' ? fe0.diskAtOpen : readDiskText(full)) } catch { } } }
    // An authored write keeps this disk's ending for the file, like every engine write (readText).
    try { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, crlfSet().has(relPath) ? toLF(content).replace(/\n/g, '\r\n') : content) }
    catch (e) { return { error: 'write failed: ' + e.message } }
    // Deliberately NOT via writeToDisk (which records engine writes in `shadow`):
    // this write is AUTHORED, so disk-vs-shadow divergence is exactly what captureLocal
    // stamps. Run the pass NOW — no debounce window at all.
    if (FORK_GATE) captureLocal(relPath)
    reconcile(relPath, 'local')
    const fe = fileDocs.get(relPath)
    // The room's copy is known only once the file synced; before that, say nothing about it rather
    // than echo the content back as if it had landed (0.14.3 P0-1). hive_edit asks whenSent().
    const landed = fe && fe.synced ? fe.text.toString() : null
    let disk = content; try { disk = readDiskText(full) } catch { }
    // A new file's doc has not synced yet when this returns, so the gate in reconcile has not run:
    // judge the content here too, or the answer would be "syncing to every peer" for a file that
    // the gate is about to hold.
    const held = withheld.get(relPath) || (SHARE_SECRETS ? null : newSecrets(content, fe && fe.synced ? fe.text.toString() : '')[0])
    return { ok: true, file: relPath, landed, conflicted: hasConflictMarkers(disk), ...(held ? { withheld: describeSecret(held) } : {}) }
  }
  // hive_edit old/new: the agent STATES the lines it edited, so nothing has to guess its base.
  //
  // A disk write cannot say which version it was made from, and from the texts alone "B replaced
  // A's change" and "B wrote from a copy older than A's change" can be identical: four rules that
  // guessed each deleted work silently (1 Nov 2026), so a plain write still merges against the fork.
  // Here `old` must be whole lines that appear exactly once in the room's copy. The room's copy is
  // then the base by construction: B's lines land as written and every other line is untouched. A
  // stale reader's `old` no longer matches the lines that changed under it, so it is refused, and the
  // refusal shows the lines as they are now.
  function editLines(relPath, oldText, newText, intent) {
    relPath = String(relPath || '').replace(/\\/g, '/')
    const NOTHING = 'Nothing was written.'
    if (typeof oldText !== 'string' || typeof newText !== 'string') return { error: `need both old and new. ${NOTHING}` }
    if (!oldText.trim()) return { error: `old is empty: pass the whole lines you are replacing, exactly as they are now. ${NOTHING}` }
    if (!relPath || !isSafeRelPath(relPath)) return { error: `unsafe path. ${NOTHING}` }
    if (folderLost) return { error: folderLost.message }
    if (SKIP.has(relPath) || isIgnored(relPath)) return { error: `${relPath} is not a syncable file. ${NOTHING}` }
    if (!canOpen(relPath)) return { error: `${relPath} is out of your scope. ${NOTHING}` }
    if (!canWrite(relPath)) return { error: `${relPath} is read-only for you. ${NOTHING}` }
    // The room's copy is only a base while it IS the room's copy: not offline, and not while someone
    // else holds the file and can change it underneath (antigravity-3, 1 Nov).
    if (!provider.wsconnected) return { error: `you are not connected to the room, so its copy of ${relPath} cannot be checked. ${NOTHING}` }
    const holder = coordinator.sense(relPath)
    if (holder && holder.by && holder.by !== name) return { error: `${holder.by} holds ${relPath}${holder.intent ? ` (${holder.intent})` : ''}, so its lines can change under you. Claim it once they release it. ${NOTHING}` }
    const fe = fileDocs.get(relPath)
    if (!fe || !fe.synced) {
      // In the room but not loaded here (outside the open set, or still arriving): never send the
      // agent to content mode, which would replace a file it has not read (antigravity-3, 1 Nov).
      if (inManifest(relPath)) {
        if (!fe) { try { openFile(relPath) } catch { } }
        return { loading: true, error: `${relPath} is in the room but not loaded here yet; it is loading now, retry in a few seconds. Do not write it with content: that would replace the room's copy without reading it. ${NOTHING}` }
      }
      return { error: `${relPath} is not in the room, so there are no lines to replace. Create it with content instead. ${NOTHING}` }
    }
    // The file's own channel, not just the room's: `fe.synced` latches at the first sync, so while
    // this file's channel is down or catching up its copy can be stale with the room connected, and a
    // stale match fuses with the newer edit on reconnect (antigravity-3, 1 Nov: "applyTax(subtotal)20").
    if (!fe.provider || !fe.provider.wsconnected || !fe.provider.synced) return { error: `${relPath}'s own channel is reconnecting, so its current lines cannot be checked; retry in a moment. ${NOTHING}` }
    // Through the LF view, like every engine read: the room holds LF, and a CRLF disk (a Windows checkout)
    // compared raw differs on every line, so every old/new edit there was refused (handover-edit H16).
    let disk = null; try { disk = readDiskText(path.join(ROOT, relPath)) } catch { }
    const cur = fe.text.toString()
    // Nothing is sent first: a refused edit sends nothing at all (antigravity-3, 1 Nov). Whatever makes
    // this disk differ from the room (an unsent save, a key held back, a frozen kept edit, markers) would
    // be written over by replacing lines in the room's copy, so it is refused.
    if (disk !== cur) {
      const why = disk === null ? 'it is missing from your folder'
        : withheld.has(relPath) ? 'it holds a key that is kept out of the room'
        : keptUnsent.has(relPath) ? 'it holds an edit that never reached the room, frozen until you save the file again'
        : hasConflictMarkers(disk) ? 'it carries conflict markers'
        : 'it has changes the room has not taken yet; if you just saved it, retry in a moment'
      return { error: `your copy of ${relPath} differs from the room's (${why}). Replacing lines in the room's copy would write over that. ${NOTHING}` }
    }
    if (keptUnsent.has(relPath)) keptUnsent.delete(relPath) // identical to the room: nothing left to keep
    const eol = cur.includes('\r\n') ? '\r\n' : '\n'
    // One trailing line break is not part of the lines: "b\n" and "b" both mean the line b, so a break
    // dropped or added on one side can never join two lines or leave a blank one (antigravity-3, 1 Nov).
    const asLines = (s) => s.replace(/\r?\n$/, '').replace(/\r?\n/g, eol)
    const o = asLines(oldText), n = asLines(newText)
    if (!o.trim()) return { error: `old is empty: pass the whole lines you are replacing, exactly as they are now. ${NOTHING}` }
    const atStart = (i) => i === 0 || cur[i - 1] === '\n'
    // A match ending in a line break ("b\n" left after stripping "b\n\n") means a blank line follows,
    // so it may not end at the end of the file; and never between the \r and \n of one line end
    // (antigravity-3, 1 Nov).
    const atEnd = (j) => (j === cur.length && !o.endsWith('\n')) || (cur[j] === '\n' && cur[j - 1] !== '\r') || cur.startsWith('\r\n', j)
    const at = [], whole = []
    for (let i = cur.indexOf(o); i !== -1; i = cur.indexOf(o, i + 1)) { at.push(i); if (atStart(i) && atEnd(i + o.length)) whole.push(i) }
    const lineAt = (i) => { const s = cur.lastIndexOf('\n', i - 1) + 1; let e = cur.indexOf('\n', i + o.length); if (e === -1) e = cur.length; return cur.slice(s, e).replace(/\r$/, '') }
    const last = (() => { try { const rs = fe.ledger ? fe.ledger.toArray() : []; const r = rs[rs.length - 1]; return r && r.name ? ` It was last changed by ${r.name}.` : '' } catch { return '' } })()
    if (whole.length > 1) return { error: `old appears ${whole.length} times in ${relPath}; add the lines around it so it matches once. ${NOTHING}` }
    if (!whole.length && at.length) {
      return { error: `old must be whole lines. In the room's copy it is part of ${at.length === 1 ? 'this line' : 'these lines'}, as ${at.length === 1 ? 'it is' : 'they are'} now:\n${[...new Set(at.map(lineAt))].slice(0, 3).join('\n')}\nIf that is what you edited, pass the whole line.${last} ${NOTHING}` }
    }
    if (!whole.length) {
      // Show the line that looks most like the first line of `old`, so the agent sees what changed.
      const first = o.split(/\r?\n/).find((l) => l.trim()) || ''
      const pre = (a, b) => { let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++; return k }
      let best = '', score = 0
      for (const l of cur.split(/\r?\n/)) { const k = pre(l.trim(), first.trim()); if (k > score) { score = k; best = l } }
      return { error: `old is not in the room's copy of ${relPath}: it changed since you read it.${last}${score >= 6 ? ` The closest line now is:\n${best}\n` : ' '}Read the file again and pass the lines as they are now. ${NOTHING}` }
    }
    if (o === n) return { ok: true, noop: true, file: relPath }
    let s = whole[0], e = s + o.length
    // An EMPTY new deletes the lines together with one line break, so no blank line is left behind.
    // new "\n" is a blank line, not a delete (antigravity-3, 1 Nov).
    if (!newText) { if (cur.startsWith('\r\n', e)) e += 2; else if (cur[e] === '\n') e += 1; else if (s > 0) s -= (s > 1 && cur[s - 2] === '\r') ? 2 : 1 }
    const next = cur.slice(0, s) + n + cur.slice(e)
    // The declared base: this edit was made against the room's copy, by construction.
    forkBases.set(relPath, cur); shadow.set(relPath, cur)
    return { ...editFile(relPath, next, intent), via: 'lines' }
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
  // Tell the relay who is connecting. Unlike the editor, a name here is always explicit --
  // the caller passed it on the command line or in the MCP config -- so there is nothing to
  // opt into. `kind` is the valuable half: it is the only way the relay can distinguish an
  // AI agent from a human, which is otherwise invisible to it and to the operator.
  const wsParams = {}
  if (token) wsParams.token = token
  // THE ACCOUNT CREDENTIAL, and it is NOT the same thing as `token` above.
  //
  // `token` is a room invite: it says which folders this client may write, it is short-lived,
  // and it is MEANT to be shared -- it rides in the join link so an invitee can just paste a
  // link. `license` says whose subscription this connection bills to, and must never be
  // shared: a link pasted into a chat would bill to whoever created it, forever.
  //
  // They were already two separate query parameters on the relay side, and the relay has
  // always read both. THE CLIENT NEVER SENT A LICENCE AT ALL -- so with
  // HIVE_REQUIRE_LICENSE=true every connection from a real client was refused 402, because
  // verifyLicense('') can only fail. This is the line that closes that gap.
  //
  // Read from the environment or an explicit argument, and DELIBERATELY not from the join
  // link: see resolveLicense() for where it may come from.
  const lic = resolveLicense(license)
  if (lic) wsParams.license = lic
  if (name) wsParams.name = String(name).slice(0, 48)
  if (kind) wsParams.kind = kind
  if (passive) wsParams.passive = 'true'
  // HiveSocket: a WebSocket where the network allows one, HTTPS long-poll where it refuses the upgrade
  // (Antigravity's cloud VMs, many company proxies). Same bytes, same relay gates, either way.
  const wsOpts = { WebSocketPolyfill: HiveSocket, disableBc: true, params: Object.keys(wsParams).length ? wsParams : undefined }
  // ONE SOCKET PER PARTICIPANT. When the relay offers it (it says so in /health), file docs stop
  // costing a socket each: they ride one physical socket as channels, and the relay admits each
  // one through the same gates a per-file socket passes. Against a relay that does not offer it,
  // or with HIVE_MUX=0, every file gets its own WebsocketProvider exactly as before. Decided once,
  // before the first file opens, so a session never straddles the two transports.
  // onFallback: the relay stopped offering it mid-session, so trim to the per-file bound before
  // each remaining file gets a socket of its own (trimForSockets, below).
  const fileTransport = createFileTransport({ relay, room, wsOpts, log, onFallback: () => trimForSockets() })
  let stopped = false
  const provider = new WebsocketProvider(relay, room, doc, wsOpts)
  // WHICH COPY OF AN AGENT THIS IS: this machine plus this folder, hashed. Everything in a room is
  // keyed by NAME (claims, mail, presence), so two different agents under one name are one identity
  // to everybody; this is what lets a join tell another agent with the same name (refused, see
  // sameNameElsewhere) from this agent a moment ago, restarting in the same folder (allowed).
  const IID = crypto.createHash('sha256').update(`${os.hostname()}|${ROOT}`).digest('hex').slice(0, 12)
  const joinedAt = Date.now()
  provider.awareness.setLocalStateField('user', { name, kind, owner: owner || undefined, v: PROTOCOL_VERSION, hv: VERSION_LABEL, passive: !!passive, listener: listener || undefined, app: app || undefined, iid: IID, joined: joinedAt }) // identity is implicit in the client

  // ---- relay reachability, said out loud exactly once -------------------------------
  // y-websocket retries forever and silently. That is the right RECOVERY behaviour and
  // the wrong REPORTING behaviour: if the relay dies mid-session the editor keeps
  // accepting edits, the file keeps saving, and nothing anywhere says the work has
  // stopped leaving the machine. A user cannot tell "synced" from "alone", which is a
  // worse failure than an outage -- an outage you can see.
  //
  // Only the BASE provider reports. Every file is its own socket, so reporting per
  // provider would print the same outage once per file: a 161-file project would emit
  // 161 identical errors and the real one would be unfindable.
  const SUPPORT = process.env.HIVE_SUPPORT || 'support@getgrm.tech'
  let relayFails = 0
  let relayReported = false

  // `ws` puts the HTTP status in the error message for any non-101 response
  // ("Unexpected server response: 402"), and that status is the only way to tell
  // "refused you" from "not there". Browsers withhold it, hence the null case.
  function statusFromError(e) {
    const m = /Unexpected server response:\s*(\d{3})/.exec((e && (e.message || e.reason)) || '')
    return m ? Number(m[1]) : null
  }

  function explain(code) {
    if (code === 401) {
      return token
        ? 'the relay rejected your token. It may have expired -- ask the room owner for a new invite.'
        : 'this room needs a token of your own. Ask the room owner to mint you one.'
    }
    if (code === 402) return `this room is over its plan limit. Contact ${SUPPORT} and we will sort it out.`
    if (code === 403) return 'the relay refused this room or path for your token. You are outside the folders you were given.'
    // 429 at the UPGRADE is always Q431 "room at capacity" -- never rate limiting. The rate
    // limiter works on frames after the socket is up and announces itself over the room chat,
    // so it cannot produce this. Saying "rate-limited, wait a minute" here was wrong twice
    // over: it named the wrong cause and it told the user to wait for something that never
    // clears. This one is worth getting right -- a silently-refused connection is invisible
    // (y-websocket retries forever with no error), and on 2026-09-05 that cost an hour and
    // put a wrong root cause into public/control.html: five of thirteen clients never joined
    // a room, and the missing messages were read as a relay bug that does not exist.
    if (code === 429) return `this room is FULL, so you were not let in (Q431). A relay admits a limited ` +
      `number of connections per room -- 8 on the free tier -- and this room is at that ceiling. Note it ` +
      `counts CONNECTIONS, not people: one agent holding several files holds several. If you run the relay, ` +
      `raise it with HIVE_SEATS; otherwise ask whoever does, or contact ${SUPPORT}.`
    if (code === 503) return `the relay is not serving this connection. Either the whole relay is at capacity ` +
      `(Q430 sockets, Q438 open files, or Q439 files held by one participant) or it could not check your licence and is failing closed rather than guessing. It may also be ` +
      `restarting -- if this lasts, contact ${SUPPORT}.`
    if (code) return `the relay answered ${code} instead of accepting the connection. Contact ${SUPPORT}.`
    return `the relay at ${relay} cannot be reached. It may be down, asleep, or blocked by a network. ` +
           `Your edits are still saved on disk but are NOT being shared. Contact ${SUPPORT} if this continues.`
  }

  // Three consecutive failures (~15s) before speaking. One dropped frame on a train is
  // not an outage, and crying about every reconnect trains people to ignore the message
  // that matters.
  function relayTrouble(e) {
    if (++relayFails < 3 || relayReported) return
    relayReported = true
    const code = statusFromError(e)
    log(`[hive] NOT SYNCING -- ${explain(code)}`)
    log(`[hive] still retrying in the background; this will say so when it reconnects.`)
  }

  // ---- the FIRST connection, which the code above cannot cover -----------------------
  // relayTrouble waits for three consecutive FAILURES. A sleeping relay does not fail: the
  // socket is simply slow to be accepted, so no error event fires and nothing is reported.
  // On a free-tier host that is a 30-second cold start, and the user's first ever experience
  // of the product is a command that appears to hang. That is the single likeliest reason a
  // first run is abandoned, and it is not an error at all -- it just needed saying.
  let everConnected = false
  const firstWait = setTimeout(() => {
    if (everConnected) return
    log(`[hive] waiting for the relay at ${relay} ...`)
    log('[hive] a sleeping relay can take up to 30s to wake on the first connection.')
  }, 4000)
  if (firstWait.unref) firstWait.unref()
  const stillWaiting = setTimeout(() => {
    if (everConnected) return
    log('[hive] still waiting. If this does not clear in a minute the relay may be down --')
    log(`[hive] your files are safe on disk either way. ${SUPPORT} if it persists.`)
  }, 35000)
  if (stillWaiting.unref) stillWaiting.unref()

  provider.on('connection-error', relayTrouble)
  provider.on('connection-close', relayTrouble)
  provider.on('status', ({ status }) => {
    if (status !== 'connected') return
    if (!everConnected) {
      everConnected = true
      clearTimeout(firstWait); clearTimeout(stillWaiting)
    }
    if (relayReported) log('[hive] relay reachable again -- syncing resumed.')
    relayFails = 0
    relayReported = false
  })
  if (kind === 'ai' && owner) owners.set(name, owner) // record who is allowed to approve my tasks

  // One sub-provider + Y.Doc per file, created on demand. `text` is its content.
  // `synced` flips true after the first relay sync — until then an empty doc means
  // "not pulled yet", NOT "new file", so we must not re-seed it from disk (that
  // would create a second CRDT history and duplicate/garble content on rejoin).
  const fileDocs = new Map() // relPath -> { doc, provider, text, synced }
  // EDITS NOT YET ACCEPTED BY THE RELAY (0.14.3 P0-1). A file enters on any local change to its doc
  // and leaves once its channel is connected, synced and its socket holds no unsent bytes. Synced
  // means the sync exchange ran after the change (it carries anything the socket missed), so
  // "connected + synced + nothing buffered" is "the relay has it". Over HTTPS long-poll the bytes sit
  // in the client until the relay accepts them; an agent that left in that window lost the edit while
  // hive_edit said it was syncing (8-9 Nov mock run). leave() waits on this set, hive_edit reports it,
  // and eviction never closes a file that is still in it.
  const unsentLocal = new Set()

  // REFUSED FILE-ROOMS. y-websocket retries a failed upgrade forever, with backoff and in
  // silence. That is right for a flaky network and badly wrong for a relay that is full: on
  // 18 Sep 2026 a relay answered 38,011 connections with Q430 while the agents involved
  // showed no symptom at all. Their files simply never arrived, and an unsynced file-doc
  // reads as EMPTY, which is how the same evening ended with 186 files written to 0 bytes.
  //
  // So count refusals for docs that have NEVER synced, and say it once. The condition is
  // usually a whole-relay problem rather than a per-file one, so one message naming the
  // count is the useful shape -- one per file would be 800 lines of chat.
  const refusedFiles = new Map() // relPath -> consecutive connection errors, cleared on sync
  const refusedCodes = new Map() // relPath -> the HTTP status the relay refused with, when it gave one
  const refusedReasons = new Map() // relPath -> the relay's own words (a mux refusal carries its Q-code line)
  let refusalSaidAt = 0
  let refusalTimer = null

  function noteRefusals() {
    if (refusalTimer) return
    // Debounced: a full relay refuses every file at once, and we want the total, not the first.
    refusalTimer = setTimeout(async () => {
      refusalTimer = null
      const stuck = [...refusedFiles.keys()].filter((r) => { const e = fileDocs.get(r); return e && !e.synced })
      // One transient error on one file is a blip, not an outage. Two or more files stuck, or
      // repeated failures on one, is the shape of a relay that will not take us.
      const repeated = stuck.some((r) => (refusedFiles.get(r) || 0) >= 3)
      if (stuck.length < 2 && !repeated) return
      const now = Date.now()
      if (now - refusalSaidAt < 300000) return // at most once every 5 minutes
      refusalSaidAt = now
      // HIV-P13. THIS MESSAGE USED TO NAME A CAUSE IT HAD NOT MEASURED.
      //
      // It said "the usual cause is the relay being full (Q430)" on the strength of having
      // observed only that N file docs have synced=false. Measured 21 Sep 2026, at the moment a
      // third agent printed it for 49 files: the relay reported 56 connections of 512, and
      // limits.js keys its per-room count on the FILE-room, so any one file held three
      // connections against a cap of 64. Q430 needed 512 and had 56; Q431 needed 64 and had 3.
      // Neither refusal could have fired. The real event was the relay dropping its room state
      // -- /health went rooms 44 -> 0 -> 29 -> 44 over a few minutes -- and every client
      // reconnecting one socket per file.
      //
      // "The relay is full" and "the relay just dropped everyone and we are all reconnecting"
      // produce an identical symptom and need OPPOSITE responses: a config change, or thirty
      // seconds of patience. Telling an operator to raise a limit that is 89% free is worse
      // than saying nothing, because they will do it, see no change, and conclude the product
      // is broken -- correctly, on the evidence they were given.
      //
      // So the client asks the relay instead of guessing, and reports what came back. It also
      // stops printing the literal string "<relay-http>", which it did for three weeks while
      // holding the relay URL in scope.
      // EVIDENCE BEFORE INFERENCE. If the relay actually refused us it said so with a status,
      // and explain() maps those to the right cause and the right knob -- Q431 to HIVE_SEATS,
      // Q430 to capacity, 401/403 to the token, 402 to the plan. That is a fact from the relay.
      // Only when nothing refused us -- the sockets simply never came up, which is what a
      // dropped-and-reconnecting relay looks like -- is there anything left to infer, and then
      // we go and ASK rather than assert.
      const coded = stuck.map((r) => refusedCodes.get(r)).filter(Boolean)
      const code = coded.length ? coded.sort((a, b) => coded.filter((c) => c === b).length - coded.filter((c) => c === a).length)[0] : null
      const msg = code
        ? `${stuck.length} file(s) are not synced and will READ AS EMPTY until this clears. ` +
          `The relay refused ${coded.length} of them with ${code}` +
          // The relay's own reason outranks any mapping of the bare number: one code covers
          // several ceilings, and only the relay knows which one it hit.
          (() => { const why = stuck.map((r) => refusedCodes.get(r) === code && refusedReasons.get(r)).find(Boolean); return why ? ` ("${String(why).slice(0, 160)}")` : '' })() +
          `: ${explain(code)} ` +
          `Do not trust this folder's contents meanwhile.`
        : (await RH.explainNotSyncing(relay, {
            stuck: stuck.length, what: 'files',
            trailer: `Nothing refused these connections with a status code, so the cause above is ` +
              `inferred from the relay's own counters rather than reported by it. ` +
              `Do not trust this folder's contents meanwhile.`,
          })).text
      log(`[${name}] !! ${msg}`)
      try { postOnce(`notsyncing:${code || 'stuck'}`, `[!] @all ${msg}`, { observer: true, ttlMs: 10 * 60 * 1000 }) } catch { /* chat may itself be unreachable — the log still carries it */ }
    }, 4000)
    if (refusalTimer.unref) refusalTimer.unref()
  }
  // HIV-P18. THE DOCUMENTED REMEDY DID NOT EXIST.
  //
  // The README told every user: "A file outside the working set is not on your disk yet. It
  // exists in the room. Reading or claiming the path fetches it." Measured 21 Sep 2026 against
  // a client holding 8 of a room's 41 files, on a path that WAS in the manifest:
  //
  //   whyNotShared(mod024.js) -> ""      (in scope; edits would reach the room)
  //   claim(mod024.js)        -> true    ("it's yours")
  //   after claim + 9s        -> on disk = false
  //   after release + 9s      -> on disk = false
  //   provenanceOf            -> 0 receipts,  headOf -> null   (doc never opened)
  //   public fetch/read/open  -> undefined
  //
  // Nothing brought the bytes down. The cause is one line in reconcile: `if (disk === null)
  // return` before openFile, plus a warm-up that only opens files already on local disk. A
  // manifest entry with no local copy was never opened, so it could never arrive.
  //
  // The only thing that DID work was writing to the path -- which is precisely the blind
  // recreate HIV-P14b guards. So the sole recovery route was the one dangerous action, reached
  // by an agent that had been told "it's yours" and then saw an empty directory. That is
  // HIV-P3's class arriving inbound: a claim granted over bytes that cannot move.
  //
  // This makes the sentence true. `fetch` opens the doc and RESOLVES WHEN THE CONTENT HAS
  // LANDED, because an un-awaited open is the same false success one layer down: the caller
  // reads the directory, sees nothing, and concludes the file is absent.
  function fetchFile(relPath, { timeoutMs = 15000 } = {}) {
    arrivedNew.delete(relPath) // asked for by name here: in use, so the full grace window applies
    const r = String(relPath)
    if (!canOpen(r)) return Promise.resolve({ ok: false, reason: `${r} is out of your scope` })
    if (collided.has(r)) {
      return Promise.resolve({
        ok: false,
        collided: true,
        file: r,
        reason: `${r} collides in case with ${collided.get(r).with} already on disk. A case-insensitive disk cannot hold both.`,
      })
    }
    const full = path.join(ROOT, r)
    // Already here: report it, and say so rather than implying we went and got it.
    if (fs.existsSync(full)) return Promise.resolve({ ok: true, alreadyLocal: true, file: r })
    // Not in the room either. This is the case @Hermes hit, and it is NOT the working-set
    // case: nothing will ever arrive, so saying "fetching" would be a lie. The two look
    // identical from an empty directory and have opposite remedies, so they get different
    // answers here.
    if (!manifest.has(r)) {
      return Promise.resolve({
        ok: false, notInRoom: true, file: r,
        reason: `${r} is not in this room at all — no client has ever published it, so nothing ` +
          `can fetch it. This is not a working-set miss. Check the room's .gitignore allow-list ` +
          `covers the path, then have whoever holds the file write it into their synced folder.`,
      })
    }
    const e = openFile(r)
    if (!e) return Promise.resolve({ ok: false, reason: `could not open ${r}` })
    return new Promise((resolve) => {
      let done = false
      const finish = (res) => { if (done) return; done = true; clearInterval(iv); clearTimeout(to); resolve(res) }
      const check = () => {
        if (!e.synced) return
        // reconcile() runs on the provider's own sync event and writes to disk. Wait for the
        // BYTES, not for the flag -- the flag says the socket settled, which is not the claim
        // being made to the caller.
        if (fs.existsSync(full)) return finish({ ok: true, file: r, bytes: fs.statSync(full).size })
        // Synced and still nothing: the room holds this path with empty content. Real, and a
        // different answer from "not fetched yet".
        if (e.text.toString() === '') return finish({ ok: true, file: r, empty: true, bytes: 0 })
      }
      const iv = setInterval(check, 250)
      if (iv.unref) iv.unref()
      const to = setTimeout(() => finish({
        ok: false, file: r, timedOut: true,
        reason: `${r} is in the room but did not arrive within ${timeoutMs}ms. The file's own ` +
          `socket may be refused — hive_status reports filesHeld of roomFiles, and a refused ` +
          `file doc is indistinguishable from an empty file.`,
      }), timeoutMs)
      if (to.unref) to.unref()
      check()
    })
  }

  // ---- SAME-LINE RACE (P0-F; docs/rules-rewrite/p0f-design.md) ----
  // A save held on the way for less than LATE_OWN_MS is still part of its race; longer is an offline edit (F4).
  const LATE_OWN_MS = 2 * 60 * 1000, CLASH_SETTLE_MS = Number(process.env.HIVE_CLASH_SETTLE_MS) || 750, CLASH_HOLD_MS = 8000, RECENT_TEXTS = 8
  // The last few texts this folder held for a file, by hash: a peer's intent names the text it was made
  // from, and this is how we know it.
  function rememberText(fe, t) {
    const h = contentHash(t)
    if (fe.recent.has(h)) fe.recent.delete(h)
    fe.recent.set(h, t)
    while (fe.recent.size > RECENT_TEXTS) fe.recent.delete(fe.recent.keys().next().value)
    return h
  }
  // Called inside the transaction that sends a change from `from` to `to`.
  function recordIntent(relPath, fe, from, to, mine = null) {
    // A text holding conflict markers is a merge's verdict, not one author's edit, and the room has been
    // told about it already. As an intent it made a neighbour's edit look like a clash (bigproject W1), so
    // it never starts one (m). But it is still recorded (F5): a race resolved after it must know this
    // change is in the shared text, and what the author's own version was (v: from -> their file).
    const marked = hasConflictMarkers(to)
    if (marked && (mine == null || hasConflictMarkers(mine))) return
    const h = intentHunks(from, to)
    if (!h) return
    const vh = marked ? intentHunks(from, mine) : null
    if (marked && !vh) return
    const b = rememberText(fe, from)
    rememberText(fe, to)
    const me = fe.doc.clientID
    const v = marked ? { b, h, n: name, m: 1, v: vh } : { b, h, n: name }
    // Our own last save, for P0-F-12: if it reaches the room after a race on its line was resolved, this
    // client is the one that repairs it. Kept apart from `intents`, which forgets after the window.
    if (!marked) fe.lastOwn = { base: from, side: to, at: Date.now() }
    fe.intent.set(String(me), v)
    fe.intents.set(me, { ...v, at: Date.now() })
    // An intent only matters while a race could still be arriving. Left in place it stays in the file's
    // history forever, and a client gets a new id on every start (review F3), so take ours out after the
    // window, unless a later save has replaced it. The window is LATE_OWN_MS, not 15 s: a client whose
    // connection dropped for longer than that resyncs in ONE update, where an intent set and deleted is
    // not there at all. Nobody saw the race, and the fused line stayed, unmarked (soak, a 25 s hold).
    const t = setTimeout(() => {
      if (stopped || !fileDocs.has(relPath) || fe.intent.get(String(me)) !== v) return
      try { fe.doc.transact(() => fe.intent.delete(String(me))) } catch { }
    }, LATE_OWN_MS + 1000)
    if (t.unref) t.unref()
  }
  // P0-F-12: A SAME-LINE SAVE THAT ARRIVES AFTER ITS RACE WAS RESOLVED (same-line-very-late-test). It was
  // made at the same moment as the race's saves, but reached the room only after the room had written
  // the race's block, and the CRDT put what it inserted beside the block (`wednes<<<<<<< Bob`). Any
  // client that can explain the text that way (lateOverBlock) knows the repair: the late author's
  // version added to the block (merge3's late-save merge). The late author's own client writes it -- it
  // is online, its save just arrived -- and every other client holds its disk until it lands. Returns the
  // bases it took over, so the race path leaves them alone.
  function checkLate(relPath, txn) {
    const fe = fileDocs.get(relPath)
    const taken = new Set()
    if (!fe || !fe.intent) return taken
    const current = fe.text.toString()
    const now = Date.now()
    // Only against a race's resolution: its block names its authors. A block a merge raised ("local
    // (yours)" / "incoming (theirs)") is an author's save, and the race path decides how it joins (F5
    // builds the block from what each author saved, same-line-later-save-test R10).
    const repair = (base, side, who) => {
      const x = lateOverBlock(base, side, current)
      if (x == null || /^(<<<<<<<|>>>>>>>) .*(local \(yours\)|incoming \(theirs\))/m.test(x)) return null
      return merge3(base, side, x, { lateName: who }).text
    }
    const own = fe.lastOwn
    if (own && (now - own.at >= LATE_OWN_MS || current === own.side || (blockVersions(current) || { versions: [] }).versions.includes(own.side))) fe.lastOwn = null
    else if (own) {
      const final = repair(own.base, own.side, name)
      if (final != null && final !== current) {
        taken.add(contentHash(own.base))
        fe.clashHold = { final, until: now + CLASH_HOLD_MS, late: true }
        log(`[${name}] ${relPath}: this save of a line reached the room after a race on that line was resolved; adding it to the block`)
        setTimeout(() => {
          // The text moved on (another change arrived in the same burst): that change's own check has
          // already taken this save up again, against the newer text. lastOwn stays until a repair lands.
          if (stopped || fe.text.toString() !== current) { if (fe.clashHold && fe.clashHold.final === final) releaseHold(relPath, fe); return }
          fe.lastOwn = null
          fe.doc.transact(() => applyDiff(fe.text, final))
          rememberText(fe, final)
          try { postOnce(`late:${relPath}:${contentHash(final)}`, `[!] ${relPath}: ${name} saved the same line as the others at the same moment, but the save arrived after their conflict was written. ${name}'s version is now one more version in the conflict block.`) } catch { }
          releaseHold(relPath, fe)
        }, 0)
        return taken
      }
    }
    const keys = txn.changed && txn.changed.get(fe.intent)
    if (!keys) return taken
    for (const k of keys) {
      const v = fe.intent.get(k)
      if (!v || v.m || !Array.isArray(v.h) || typeof v.b !== 'string' || Number(k) === fe.doc.clientID) continue
      const base = fe.recent.get(v.b)
      if (base == null) continue
      const final = repair(base, applyIntent(base, v.h), v.n || `client ${k}`)
      if (final == null || final === current) continue
      taken.add(v.b)
      fe.clashHold = { final, until: now + CLASH_HOLD_MS, late: true }
      log(`[${name}] ${relPath}: ${v.n || k}'s save of a line arrived after the race on it was resolved; waiting for it to be added to the block`)
      const t = setTimeout(() => {
        if (stopped || fe.clashHold == null || fe.clashHold.final !== final) return
        if (fe.text.toString() !== final) try { postOnce(`late:${relPath}:${k}:${v.b}`, `[!] ${relPath}: ${v.n || k}'s save of a line arrived after the conflict on it was written, and it was not added to the block in ${CLASH_HOLD_MS / 1000} s. The block may hold a fragment of that save. Check it by hand.`, { observer: true }) } catch { }
        releaseHold(relPath, fe)
      }, CLASH_HOLD_MS + 50)
      if (t.unref) t.unref()
    }
    return taken
  }
  // A remote transaction arrived. If it carries an intent made from the same text as another recent
  // intent, and the two changed the same line, the shared text now holds their character union.
  //
  // WHY THE WAIT. Saves made "at the same moment" are saves made before any of them reached the others,
  // so they arrive within about one round trip of each other, in different orders on different peers.
  // Resolving on the second arrival let two peers each see a different pair, each be the lowest of its
  // pair, and both write: three saves became two, and one author's line was lost (R6). So every peer
  // first holds its disk, waits CLASH_SETTLE_MS for the rest of the race to arrive, and then decides from
  // everything made from that text: the same group, the same text, and one writer, the lowest client.
  function checkClash(relPath, txn, taken = new Set()) {
    const fe = fileDocs.get(relPath)
    if (!fe || !fe.intent) return
    const keys = txn.changed && txn.changed.get(fe.intent)
    if (!keys || !keys.size) return
    const now = Date.now()
    // Kept as long as a held save still counts as a race (LATE_OWN_MS), not just the race window: a
    // save 18 s late met a line one other author had changed, and only those two clients still knew of
    // both saves, so every other disk took the fused line until the block landed (same-line-soak-test).
    for (const [c, v] of fe.intents) if (now - v.at > LATE_OWN_MS) fe.intents.delete(c)
    // Our own last save stays in the race until it has been seen (P0-F-12): when it was held on the way,
    // the others' saves reach us long after the window, and without it here their union went to this disk.
    const own = fe.lastOwn, me = fe.doc.clientID
    if (own && now - own.at < LATE_OWN_MS && !fe.intents.has(me)) {
      const h = intentHunks(own.base, own.side)
      if (h) fe.intents.set(me, { b: contentHash(own.base), h, n: name, at: own.at })
    }
    const bases = new Set()
    for (const k of keys) {
      const v = fe.intent.get(k)
      const c = Number(k)
      if (!v || !Array.isArray(v.h) || typeof v.b !== 'string' || c === fe.doc.clientID) continue
      fe.intents.set(c, { b: v.b, h: v.h, n: v.n, at: now, ...(v.m ? { m: 1, v: Array.isArray(v.v) ? v.v : v.h } : {}) })
      if (!v.m) bases.add(v.b)
    }
    for (const b of bases) {
      if (taken.has(b) || (fe.clashHold && fe.clashHold.late)) continue
      if (fe.recent.get(b) == null || !clashGroup(fe, b)) continue
      // Hold this disk now: the shared text may already be the union.
      fe.clashHold = { final: null, until: now + CLASH_SETTLE_MS + CLASH_HOLD_MS }
      if (fe.clashTimers.has(b)) continue
      const t = setTimeout(() => { fe.clashTimers.delete(b); if (!stopped) resolveClash(relPath, fe, b) }, CLASH_SETTLE_MS)
      if (t.unref) t.unref()
      fe.clashTimers.set(b, t)
    }
  }
  // The intents made from text b that clash with another one, as clientID -> hunks; null if none do.
  function clashGroup(fe, b) {
    const same = [...fe.intents].filter(([, v]) => v.b === b && !v.m)
    const group = new Map()
    for (const [c, v] of same) for (const [d, w] of same) if (c !== d && hunksClash(v.h, w.h)) { group.set(c, v.h); break }
    return group.size >= 2 ? group : null
  }
  function releaseHold(relPath, fe) {
    fe.clashHold = null
    if (fe.pendingLocal) runDeferred(relPath, fe)
    else reconcile(relPath, 'remote')
  }
  // The save that waited (deferLocal) goes out now. It was made from what this disk held -- the last
  // synced text -- and the resolution has landed since. When its lines and the resolution's do not
  // overlap, both are applied to that text, line by line: exact, no character CRDT and no merge3 (which
  // strips markers, and dropped Bob's version of the resolved block, R13). When they overlap, the ordinary
  // merge decides, against that same text.
  function runDeferred(relPath, fe) {
    fe.pendingLocal = false
    let disk = null
    try { disk = readText(path.join(ROOT, relPath)) } catch { }
    const base = bases.get(relPath), doc = fe.text.toString()
    if (disk == null || base == null || disk === base || disk === doc) { reconcile(relPath, 'remote'); return }
    const mine = intentHunks(base, disk), theirs = intentHunks(base, doc)
    if (mine && theirs && !linesOverlap(mine, theirs)) {
      const merged = applyTagged(base.split('\n'), tagged(new Map([[0, theirs], [1, mine]]))).join('\n')
      log(`[${name}] ${relPath}: the save made while a race was resolved goes out on top of the resolution`)
      fe.doc.transact(() => { applyDiff(fe.text, merged); if (!FORK_GATE) recordIntent(relPath, fe, doc, merged, merged) })
      if (merged !== disk) writeToDisk(relPath, merged)
      known.add(relPath); bases.set(relPath, merged); forkBases.set(relPath, merged)
      return
    }
    fe.deferredMerge = true
    try { reconcile(relPath, 'local') } finally { fe.deferredMerge = false }
  }
  function deferLocal(relPath, fe) {
    unsentLocal.add(relPath)
    if (fe.pendingLocal) return
    fe.pendingLocal = true
    const t = setTimeout(() => { if (!stopped && fe.pendingLocal) runDeferred(relPath, fe) }, Math.max(0, fe.clashHold.until - Date.now()) + 20)
    if (t.unref) t.unref()
  }
  function resolveClash(relPath, fe, b) {
    if (fe.clashHold && fe.clashHold.late) return // P0-F-12 has this file: its own timer ends the hold
    const base = fe.recent.get(b)
    const group = base == null ? null : clashGroup(fe, b)
    if (!group) { releaseHold(relPath, fe); return }
    const ids = [...group.keys()].sort((x, y) => x - y)
    const key = `${b}|${ids.join(',')}`
    // Every save made from this text at the same moment is in the shared text's union, the ones that
    // clash and the ones that do not: the resolution is computed from all of them, or it would delete a
    // non-clashing author's edit (and be refused, since the union would not match: R9).
    const all = new Map([...fe.intents].filter(([, v]) => v.b === b && !v.m).map(([c, v]) => [c, v.h]))
    // F5. A save made from another text after the race began. When that text was what its author held --
    // one side, or a clean merge of sides -- the save is that author's version of the file from `base`,
    // and it joins the resolution (its hunks rebased onto `base`). Any other is someone's later edit that
    // the resolution would overwrite: then do not resolve, and say so.
    const since = Math.min(...ids.map((i) => (fe.intents.get(i) || {}).at || Infinity))
    const members = new Map(all), laters = []
    let unexplained = false
    // Whether a save came after the race is decided by what it was made from, not by when this peer heard
    // of it: arrival times are local, and a side's time here can be later than a save built on that side
    // (R9, 1 run in 40). Only a save nobody can explain is judged by time: older ones predate the race.
    for (const [c, v] of [...fe.intents].filter(([, v]) => v.b !== b).sort((x, y) => x[1].at - y[1].at)) {
      const ex = explainBase(base, all, v.b)
      // The author's own version: for a merge that raised markers, the file they saved, not the markers.
      const rebased = ex && intentHunks(base, applyIntent(ex.text, v.m ? v.v : v.h))
      if (!rebased) { if (v.at > since) { unexplained = true; break } continue }
      members.set(c, rebased)
      laters.push({ id: c, after: ex.after, h: v.h })
    }
    const final = clashFinal(base, members, new Map([...members.keys()].map((i) => [i, (fe.intents.get(i) || {}).n])))
    const current = fe.text.toString()
    const who = ids.map((i) => (fe.intents.get(i) || {}).n || String(i)).join(', ')
    if (fe.clashDone.has(key) || current === final) { releaseHold(relPath, fe); return }
    fe.clashDone.add(key)
    if (unexplained || !clashOnlyRegion(base, all, final, current, laters)) {
      // The file changed outside the clash since: writing the resolution would delete that change.
      log(`[${name}] same-line race in ${relPath} (${who}) not resolved: the file changed since`)
      // Markers already in the file: a merge has flagged it and said so. A second line is noise --
      // unless the file also holds a line nobody wrote: the markers are then another race's, on other
      // lines, and this one's fused line would stay with nothing said (same-line-soak-test, seed 2).
      const wrote = new Set(base.split('\n'))
      for (const [, v] of fe.intents) { const t = fe.recent.get(v.b); if (t != null) for (const l of applyIntent(t, v.m ? v.v : v.h).split('\n')) wrote.add(l) }
      const fused = current.split('\n').some((l) => !wrote.has(l) && !/^(<<<<<<<|>>>>>>>)( |$)|^=======$/.test(l))
      if (fused || /[^\n](<<<<<<< |>>>>>>> )/.test(current)) try { postOnce(`race:${relPath}:${key}`, `[!] ${relPath}: ${who} saved the same line at the same moment, and the file changed again before it could be resolved, so the line may hold a mix of their text. Check it by hand.`, { observer: ids[0] !== fe.doc.clientID }) } catch { }
      releaseHold(relPath, fe); return
    }
    const writer = ids[0] === fe.doc.clientID
    log(`[${name}] same-line race in ${relPath}: ${who} saved one line at the same moment; ${writer ? 'writing' : 'waiting for'} the resolution`)
    if (writer) {
      fe.doc.transact(() => applyDiff(fe.text, final))
      rememberText(fe, final)
      releaseHold(relPath, fe)
      return
    }
    // Everyone else holds the disk until the resolution lands. If the writer never delivers it, a client
    // in the race writes it itself, and a bystander lets the shared text through.
    const participant = group.has(fe.doc.clientID)
    fe.clashHold = { final, until: Date.now() + CLASH_HOLD_MS }
    const t = setTimeout(() => {
      if (stopped || fe.clashHold == null || fe.clashHold.final !== final) return
      const cur = fe.text.toString()
      if (cur !== final && participant && clashOnlyRegion(base, all, final, cur, laters)) {
        log(`[${name}] same-line race in ${relPath}: no resolution arrived in ${CLASH_HOLD_MS / 1000} s, writing it`)
        fe.doc.transact(() => applyDiff(fe.text, final))
      }
      releaseHold(relPath, fe)
    }, CLASH_HOLD_MS + 50)
    if (t.unref) t.unref()
  }

  function openFile(relPath) {
    let e = fileDocs.get(relPath)
    if (e) return e
    if (newRemote.delete(relPath)) arrivedNew.add(relPath)
    const fdoc = new Y.Doc()
    const fprovider = fileTransport.provide(fileRoom(room, relPath), fdoc)
    const text = fdoc.getText('content')
    const bin = fdoc.getMap('bin')
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
    // intent: clientID -> { b, h, n }, what this client's last save changed and from which text (P0-F).
    const intent = fdoc.getMap('intent')
    const undo = new Y.UndoManager(text, { captureTimeout: 350 }) // default tracks local-origin txns
    // diskAtOpen: this folder's copy when the file started waiting for the room. An edit made before
    // the file syncs -- through hive_edit OR the agent's own file tool -- was made on top of it, so it
    // is that edit's ancestor at first contact, if the room held it (0.14.3 P0-1b-R3). Dropped once synced.
    let diskAtOpen
    try { const f0 = path.join(ROOT, relPath); if (fs.statSync(f0).size <= MAX_BYTES) diskAtOpen = readDiskText(f0) } catch { diskAtOpen = undefined }
    e = { doc: fdoc, provider: fprovider, text, bin, snap, ledger, head, versions, forkmark, conflict, undo, synced: false, diskAtOpen, intent, recent: new Map(), intents: new Map(), clashDone: new Set(), clashHold: null, clashTimers: new Map() }
    fileDocs.set(relPath, e)
    // A local transaction is one this client made; a peer's arrives through applyUpdate (local false).
    fdoc.on('update', (_u, _origin, _doc, txn) => { if (!txn || txn.local) unsentLocal.add(relPath) })
    // From the mtime scan() already took, not two more syscalls per open: a 1,000-file join opens
    // 1,000 files, and fileCreationTs() still falls back to a stat for any file this missed.
    if (!createdTimes.has(relPath) && mtimes.has(relPath)) createdTimes.set(relPath, mtimes.get(relPath))
    // Every text this client itself puts in the room is remembered, however it got there: a file's
    // first publish records no intent, so its author did not know the text two later saves were made
    // from, saw no race, and wrote their fused line to its disk (same-line-soak-test, seed 2).
    text.observe((_ev, txn) => { if (txn.local) rememberText(e, text.toString()) })
    text.observe((_ev, txn) => { if (!txn.local) { if (!FORK_GATE) checkClash(relPath, txn, checkLate(relPath, txn)); reconcile(relPath, 'remote') } }) // remote content edits
    bin.observe((_ev, txn) => { if (!txn.local) reconcileBinary(relPath, 'remote') }) // remote binary edits
    // A divergent receipt can arrive slightly after (or before) the fused content — so
    // re-run the fork check whenever the provenance ledger changes too, not only on edits.
    ledger.observe((_ev, txn) => { if (!txn.local) detectFork(relPath) })
    // The fork record arrived/changed from a peer: render it locally, or — if it was
    // cleared (resolved elsewhere) — adopt the now-clean shared text to disk.
    conflict.observe((_ev, txn) => { if (txn.local) return; if (e.conflict.has('meta')) renderConflict(relPath); else adoptResolved(relPath) })
    fprovider.on('sync', (s) => {
      if (s) {
        e.synced = true
        refusedFiles.delete(relPath)
        if (e.bin.has('data')) {
          reconcileBinary(relPath, 'remote')
        } else {
          reconcile(relPath, 'remote')
          detectFork(relPath)
        }
        preSyncBase.delete(relPath) // used by the first reconcile or not at all, never by a later reopen (review R4)
        e.diskAtOpen = undefined
        // A new file that has just landed on disk frees its place for the next one (a burst of new
        // files moves at sync speed, not at the 30 s grace), and lets waiting new files in.
        if (arrivedNew.has(relPath)) {
          const t = setTimeout(() => {
            if (stopped) return
            if (fileDocs.size > maxOpen()) evictIfOverCap(null)
            if (openQueue.length && !openTimer) openTimer = setImmediate(drainOpenQueue)
          }, 50)
          if (t.unref) t.unref()
        }
      }
    })
    // A refused upgrade lands here. The provider will keep retrying by itself, which is the
    // right behaviour and exactly why nothing surfaces it — so count it and let noteRefusals
    // decide whether this is a blip or a relay that will not take us.
    fprovider.on('connection-error', (ev) => {
      if (e.synced) return // already have the content; a later blip is the provider's business
      refusedFiles.set(relPath, (refusedFiles.get(relPath) || 0) + 1)
      // HIV-P13. THE STATUS CODE WAS THROWN AWAY HERE, and it is the only authoritative evidence
      // in the whole path. joinRoom in hive-mcp.js already captured it from this same event; this
      // handler took no argument at all, so noteRefusals had nothing but "N files are quiet" and
      // had to INFER a cause -- which is how it came to announce Q430 on 21 Sep while the relay
      // sat at 56 of 512. explain() above maps these codes correctly and has done since 5 Sep.
      // A mux refusal carries the code; a per-file socket's ErrorEvent carries it only in its
      // message, which is why this read nothing at all on the socket path.
      const code = RH.statusFromError(ev)
      if (code) refusedCodes.set(relPath, code)
      if (ev && typeof ev.reason === 'string' && ev.reason) refusedReasons.set(relPath, ev.reason)
      noteRefusals()
    })
    // Newly opened counts as used, and opening is the moment the working set can go over
    // its bound — so this is where the least-recently-used ones are let go.
    touched.set(relPath, Date.now())
    evictIfOverCap(relPath)
    scheduleEvictRecheck()
    return e
  }
  // `await await f()` THAT NOBODY WROTE (0.14.3 P0-5-3). Two peers making the same sync -> async change
  // at once each insert `await ` before the same call (each merge is right on its own), and the shared
  // text keeps both inserts. Remove the outer one, here, before the room's copy reaches the disk:
  // pure deletes of the spans lang.stackedAwaits finds (AST-level, whitespace-only between, so a
  // comment or a string that says "await await" is never touched). On the same converged text every
  // peer deletes the same characters, so two peers doing it at once remove them once. Never a
  // whole-text diff: that would delete and re-insert everything between two such spots, and two
  // peers re-inserting the same middle is the fusion this engine exists to prevent. Skipped when
  // this folder's own copy has one (its author wrote it) and for a file this member cannot write.
  function dropStackedAwaits(relPath, fe, disk) {
    try {
      if (!supports(relPath) || !canWrite(relPath)) return false
      const lang = languageFor(relPath)
      if (!lang || typeof lang.stackedAwaits !== 'function') return false
      const t = fe.text.toString()
      if (!/\bawait\s+await\b/.test(t)) return false
      if (typeof disk === 'string' && /\bawait\s+await\b/.test(disk) && lang.stackedAwaits(disk).length) return false
      const spans = lang.stackedAwaits(t)
      if (!spans.length) return false
      fe.doc.transact(() => { for (let i = spans.length - 1; i >= 0; i--) fe.text.delete(spans[i][0], spans[i][1] - spans[i][0]) })
      log(`[${name}] ${relPath}: removed ${spans.length} stacked \`await\` left by two peers making the same change at once`)
      return true
    } catch { return false }
  }
  /** Has the relay accepted every local change to this file? (See unsentLocal.) */
  function isSentNow(relPath) {
    if (!unsentLocal.has(relPath)) return true
    const fe = fileDocs.get(relPath)
    if (!fe) return false
    const p = fe.provider
    if (!(p && p.wsconnected && p.synced && !(p.bufferedAmount > 0))) return false
    // Delivered is not enough: the room must HOLD what this folder has. On first contact a local edit
    // the room cannot prove it has seen is kept here and deliberately NOT published (and a refused
    // fused merge publishes nothing); calling that "sent" told an agent its work was in the room when
    // the room still had the old copy. A deleted file, or one this side cannot read as text, is judged
    // on delivery alone.
    // A BINARY file's content is in fe.bin, not fe.text (which is "" for it): compared as text it never
    // matched, so a binary this member added was never "sent" -- leave() waited its full timeout and
    // named it as lost, and eviction never closed it (Opus-Cloud's review of 0.14.3). The room holds
    // what this folder has when the bytes' sha256 is the one the room records, as reconcileBinary writes it.
    if (fe.bin && fe.bin.has('data')) {
      let bytes = null
      try { bytes = fs.readFileSync(path.join(ROOT, relPath)) } catch { }
      if (bytes && crypto.createHash('sha256').update(bytes).digest('hex') !== fe.bin.get('sha')) return false
      unsentLocal.delete(relPath)
      return true
    }
    let disk = null
    try { disk = readDiskText(path.join(ROOT, relPath)) } catch { }
    if (disk != null && !hasConflictMarkers(disk) && toLF(disk) !== toLF(fe.text.toString())) return false
    unsentLocal.delete(relPath)
    return true
  }
  /** Resolves true once the relay has this file's local changes, false if not within timeoutMs. */
  async function whenSent(relPath, timeoutMs = 3000) {
    relPath = String(relPath || '').replace(/\\/g, '/')
    const end = Date.now() + Math.max(0, Number(timeoutMs) || 0)
    for (;;) {
      if (isSentNow(relPath)) return true
      if (stopped || Date.now() >= end) return false
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  const roomBuffered = () => { try { return (provider.ws && provider.ws.bufferedAmount) || 0 } catch { return 0 } }
  // LEAVE WITHOUT LOSING WHAT WAS JUST WRITTEN. stop() tears everything down at once; leave() first
  // hands the pending work over (debounced disk edits, deletes, the room doc), waits until the relay
  // has accepted every local change -- files and chat/claims alike -- and only then stops. Whatever
  // did not make it within timeoutMs is NAMED in the answer instead of vanishing (0.14.3 P0-1).
  async function leave({ timeoutMs = 10000 } = {}) {
    if (stopped) return { unsent: [], roomUnsent: false }
    try { if (debounce) { clearTimeout(debounce); flushFsEvents() } } catch { }
    try { flushFirstContact() } catch { }
    try { settleLocalDeletes() } catch { }
    try { flushRoomDoc() } catch { }
    const end = Date.now() + Math.max(0, Number(timeoutMs) || 0)
    const pendingNow = () => [...unsentLocal].filter((r) => !isSentNow(r))
    while (Date.now() < end && (pendingNow().length || roomBuffered() > 0)) await new Promise((r) => setTimeout(r, 50))
    const unsent = pendingNow()
    const roomUnsent = roomBuffered() > 0
    stopAll()
    return { unsent, roomUnsent }
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

  // HIV-18: BOUND HOW MANY FILE SOCKETS THIS CLIENT HOLDS.
  //
  // Hivecode opens one WebSocket per FILE. A relay allows 512 connections in total by
  // default, and a normal project has more files than that, so a single client could
  // exhaust the whole relay by itself. Measured 18 Sep 2026: 889 files, 38,011 Q430
  // refusals in one evening, three agents locked out — and because a file-doc that never
  // syncs reads as EMPTY, 186 files per folder were written to 0 bytes.
  //
  // Holding every file open forever is what made that possible. A client now keeps a
  // BOUNDED working set: the most recently used MAX_OPEN files stay connected, the rest
  // are closed and reopened on demand. Closing a file doc costs nothing on disk — the
  // bytes stay where they are, the room keeps the content, and touching the file reopens
  // it and pulls the current copy.
  //
  // THE TRADE, stated plainly: a file outside the working set does not receive remote
  // edits until something touches it. That is a real semantic change, and it is strictly
  // better than the alternative it replaces, which was not receiving them either AND
  // believing the file was empty. The default is high enough that ordinary projects never
  // notice; size it as MAX_OPEN x agents < the relay's maxConnsTotal.
  //
  // NEVER EVICT, because these lose work rather than merely adding latency:
  //   - a doc that has not synced (its content has not reached the relay yet)
  //   - a file in an unresolved conflict (its fork record is live and local-only)
  //   - a file anyone currently holds a claim on (they are mid-edit)
  //   - anything used within the grace window
  //
  // THE BOUND DEPENDS ON THE TRANSPORT. With a socket per file it is what keeps one client from
  // filling the relay, and the rule above applies. In one-socket mode a file costs a channel, not
  // a socket, so the bound only caps memory -- set high enough that an ordinary repo is held
  // whole, which is what ends "this folder is incomplete on purpose". HIVE_MAX_OPEN_FILES wins
  // either way. A function, not a constant: the transport is known only once /health answers.
  const MAX_OPEN_SET = Number(process.env.HIVE_MAX_OPEN_FILES) || 0
  const maxOpen = () => Math.max(8, MAX_OPEN_SET || (fileTransport.mode === 'mux' ? 4096 : 128))
  // Configurable because the grace window is what makes eviction untestable otherwise: in a
  // short run every file was touched seconds ago, so nothing is ever eligible.
  const EVICT_GRACE_MS = Number(process.env.HIVE_EVICT_GRACE_MS) || 30000
  const touched = new Map() // relPath -> last use (ms)
  const touchFile = (relPath) => { if (fileDocs.has(relPath)) touched.set(relPath, Date.now()) }
  let evicted = 0
  // NEW FILES GET IN EVEN AT THE BOUND (Claude-cloud, 8 Nov 2026). A file a teammate creates AFTER
  // this client joined, with no copy on this disk, used to be skipped outright once the working set
  // was full: the manifest observer queued it, queueOpenFile returned at the bound, and nothing ever
  // came back for it -- measured: never arrived in 180 s, mux or per-file, in any room fuller than
  // HIVE_MAX_OPEN_FILES (and a 640-file room is fuller than the per-file 128). Such a key now opens
  // anyway, and evictIfOverCap makes room by letting go of the least recently used. Bounded: at
  // most NEW_HEADROOM over the bound at once, so a burst of hundreds of new files cannot open
  // hundreds of sockets; the rest WAIT in the queue (never dropped) until the re-check frees room.
  // Files that were in the room at join keep the old trade ("the rest sync when touched").
  const newRemote = new Set() // keys added to the room after join, not on this disk, not yet opened
  // ...and the ones that were opened that way and have not been used here since. Once such a file is
  // ON DISK it may be let go without waiting out the grace window: it arrived, which is all it was
  // opened for. LRU order still decides, so older idle files go first.
  const arrivedNew = new Set()
  const NEW_HEADROOM = 32
  let evictRecheck = null
  // evictIfOverCap only runs when a file opens, and a file inside its grace window cannot be let
  // go -- so a set pushed over the bound by new files would stay over it. Look again once the
  // grace has passed, evict down to the bound, and let any waiting new files in.
  function scheduleEvictRecheck() {
    if (evictRecheck || stopped) return
    if (fileDocs.size <= maxOpen() && !newRemote.size) return
    // While new files are landing or waiting, look again every second: a landed new file is
    // evictable as soon as it is on disk, and that must not wait out a grace window that could be
    // minutes long. Otherwise (only grace-protected files over the bound) look once the grace ends.
    const ms = (newRemote.size || arrivedNew.size) ? 1000 : EVICT_GRACE_MS + 1000
    evictRecheck = setTimeout(() => {
      evictRecheck = null
      if (stopped) return
      evictIfOverCap(null)
      if (openQueue.length && !openTimer) openTimer = setImmediate(drainOpenQueue)
      scheduleEvictRecheck()
    }, ms)
    if (evictRecheck.unref) evictRecheck.unref()
  }
  function evictIfOverCap(keep) {
    if (fileDocs.size <= maxOpen()) return
    const now = Date.now()
    const isClaimed = (r) => { try { return claims.has(r) } catch { return false } }
    const cand = []
    for (const [r, e] of fileDocs) {
      if (r === keep || !e.synced) continue
      if (!isSentNow(r)) continue // closing it would drop an edit the relay has not accepted yet
      if (conflicted.has(r)) continue
      try { if (e.conflict && e.conflict.size) continue } catch { }
      if (isClaimed(r)) continue
      const t = touched.get(r) || 0
      const landedNew = arrivedNew.has(r) && fs.existsSync(path.join(ROOT, r))
      if (now - t < EVICT_GRACE_MS && !landedNew) continue
      cand.push([r, t])
    }
    cand.sort((a, b) => a[1] - b[1]) // least recently used first
    let over = fileDocs.size - maxOpen()
    for (const [r] of cand) {
      if (over-- <= 0) break
      closeFile(r); touched.delete(r); arrivedNew.delete(r); evicted++
    }
  }

  // THE FALLBACK TRIM. The relay stopped offering one-socket mode mid-session, and every file still
  // open is about to cost a socket of its own. Keep the most recently used up to the per-file bound
  // and close the rest -- UNSYNCED ones too, unlike evictIfOverCap: on this path "unsynced" means
  // "was waiting on the socket that just went away", and its bytes are on disk or still in the
  // room, so closing it costs latency, not work. Conflicted and claimed files are kept whatever
  // the count, because closing those could. Without this, a joiner mid-way through fetching 900
  // files would open 900 sockets at once -- the storm the per-file bound exists to prevent.
  function trimForSockets() {
    const cap = maxOpen()
    if (fileDocs.size <= cap) return
    const isClaimed = (r) => { try { return claims.has(r) } catch { return false } }
    const cand = []
    for (const [r, e] of fileDocs) {
      if (conflicted.has(r) || isClaimed(r)) continue
      if (unsentLocal.has(r)) continue // a local edit the relay has not accepted: closing it loses work
      try { if (e.conflict && e.conflict.size) continue } catch { }
      cand.push([r, touched.get(r) || 0])
    }
    cand.sort((a, b) => a[1] - b[1]) // least recently used first
    let over = fileDocs.size - cap
    for (const [r] of cand) {
      if (over-- <= 0) break
      closeFile(r); touched.delete(r); arrivedNew.delete(r); evicted++
    }
  }

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

  // WOULD AN EDIT TO THIS PATH ACTUALLY REACH ANYONE? '' if yes, else the reason. (HIV-27)
  //
  // A claim is a path STRING in the shared `claims` map. Whether that path's BYTES sync is
  // decided somewhere else entirely, per client, by canOpen/isIgnored. Nothing compared the
  // two, so an agent could hold an exclusive claim on a file nobody else can see, do the work,
  // pass a gate that runs in its OWN folder where the file is real, and hand back something
  // that never existed for anyone else. Every signal green, the work genuinely done, and
  // invisible. Observed live: an agent edited scripts/check-deploy.mjs, claimed it, released it
  // through the gate, and the other two folders still held the old bytes.
  //
  // This is checked at CLAIM time on purpose. Release is too late -- by then the agent has
  // built the thing it intended to write, and all we could do is tell it the work was wasted.
  //
  // THE FALSE-POSITIVE DIRECTION IS WHAT MAKES THIS USABLE, and it is easy to get wrong.
  // A claim may name a logical region rather than a file ("auth-refactor", "the parser"), and
  // under an ALLOW-LIST .gitignore -- `/*` followed by negations, which is how a room bounds
  // itself against the one-socket-per-file limit -- isIgnored() returns true for every string
  // that is not an explicitly allowed path. A naive isIgnored() check would therefore refuse
  // almost every legitimate claim in exactly the rooms that need this guard most, and it would
  // be switched off within a day. So we only judge things we have positive reason to believe
  // are FILES: known to the room, present on disk, or carrying a directory separator.
  // HIV-P3, 20 Sep 2026. THE GENESIS CASE: the five tests above are all false for a root-level
  // file that DOES NOT EXIST YET, which is the most common reason anyone claims at all -- you
  // claim `config.env` precisely because you are about to create it. Found by DeepMind-Agent.
  // So HIV-27's guard had a hole in exactly the case it was written for: claim succeeds, write
  // succeeds, the local gate passes because in YOUR folder the file is real, and the bytes never
  // leave. Born invisible, every signal green.
  //
  // THE ONLY QUESTION IS: is this bare string a FILE-TO-BE or a LOGICAL LABEL? Nothing on disk
  // and nothing in the room can answer it, so this is a guess, and the direction of the guess is
  // what matters. Guessing "file" too eagerly refuses legitimate region claims -- and under an
  // allow-list .gitignore that means refusing ALMOST ALL of them, which gets the guard switched
  // off within a day and costs more than the hole. So every rule here must be one a LABEL would
  // essentially never satisfy.
  //
  // THE DIGIT RULE IS THE LOAD-BEARING ONE and it is not obvious. A trailing dot-segment
  // containing a LETTER is an extension: .js .env .secret. One that is ALL DIGITS is a version
  // number: v1.2, release-0.11.6, HIV-P3.5. Without that distinction every ticket id and release
  // label in this room's own vocabulary gets refused as a file.
  //
  // WHAT THIS DOES NOT CLOSE, stated rather than discovered later. Extensionless root files that
  // are neither conventional nor `*file` shaped -- a bare `config`, `staging`, `hosts` -- are
  // still read as labels and still go invisible. The hole narrows; it does not close. It cannot
  // close here, because at claim time the string is all we have. The rest belongs at WRITE time,
  // where a path that appears on disk inside the room folder is a fact and needs no heuristic.
  // That is HIV-P8, and it is filed rather than quietly assumed.
  const EXTENSIONLESS_ROOT_FILES = new Set([
    'LICENSE', 'LICENCE', 'README', 'CHANGELOG', 'CHANGES', 'NOTICE', 'AUTHORS', 'CONTRIBUTORS',
    'CODEOWNERS', 'COPYING', 'INSTALL', 'CONTRIBUTING', 'VERSION', 'MAINTAINERS', 'TODO',
  ])
  const looksLikeFilename = (p) => {
    if (/\s/.test(p)) return false                       // "the parser rewrite", "P3 lane"
    if (/\.[^.]*[A-Za-z][^.]*$/.test(p)) return true     // .js .env .secret -- but NOT .2 .5 .6
    if (EXTENSIONLESS_ROOT_FILES.has(p.toUpperCase())) return true
    // Makefile, Dockerfile, Rakefile, Gemfile, Procfile, Vagrantfile, Justfile, Caddyfile.
    // Capital-initial and case-SENSITIVE on purpose: lowercase "profile" and "logfile" are
    // perfectly ordinary region names and must stay claimable.
    if (/^[A-Z][A-Za-z]+file$/.test(p)) return true
    return false
  }

  const whyNotShared = (relPath) => {
    const p = String(relPath || '')
    if (!p) return ''
    let onDisk = false
    try { onDisk = fs.existsSync(path.join(ROOT, p)) } catch { onDisk = false }
    // SKIP counts as positive evidence: those names ARE files by definition, and a control
    // file sits in the room root with no separator in its name, so the heuristics below miss it.
    const isFile = manifest.has(p) || fileDocs.has(p) || SKIP.has(p) || onDisk || p.includes('/')
      || looksLikeFilename(p)                    // HIV-P3: the genesis case -- see above
    if (!isFile) return ''                       // a label, not a path -- not ours to judge
    if (!isSafeRelPath(p)) return `"${p}" is not a safe relative path, so it can never be synced`
    if (SKIP.has(p)) return `${p} is a Hivecode control file, not shared source`
    if (!canOpen(p)) return `your access token's scope does not cover ${p}, so its bytes stay in this folder`
    if (isIgnored(p)) return `${p} is ignored by a .gitignore here, so this client never opens a sync connection for it -- anything you write stays in this folder and no other agent will ever see it`
    if (onDisk) {
      const full = path.join(ROOT, p)
      const unshared = checkUnshared(full)
      if (unshared) {
        if (unshared.reason === 'oversized') {
          return `${p} is oversized (${Math.round(unshared.size / 1024)}KB > 1MB limit), so it cannot be shared -- anything you write stays in this folder and no other agent will see it`
        }
        return `${p} contains binary data (null bytes), so it cannot be shared -- anything you write stays in this folder and no other agent will see it`
      }
    }
    return ''
  }

  const known = new Set()
  const mtimes = new Map()
  const createdTimes = new Map() // relPath -> timestamp of creation/genesis publish
  const genesisPublished = new Set() // relPath -> files THIS client genesis-published this session
  const deadHeatResolved = new Set() // relPath -> files where dead-heat creation-race detection already resolved
  // Paths that already existed on disk when this client STARTED. This is the
  // discriminator between "I cloned a repo and joined a room that already has these
  // files" (adopt the room's copy) and "this file was created during the session"
  // (a creation race -- merge, never adopt). Populated once, on the first scan.
  const preexisting = new Set()
  // HIV-P14b. Manifest keys as of our first sync: what the ROOM held before we arrived.
  // `preexisting` records our DISK, which structurally cannot distinguish "nobody had this file"
  // from "the room had it all along and we never fetched it". null until the first sync, and null
  // must never be read as "the room was empty" -- that would classify every joiner's first
  // creation as a race, which is the bug this exists to fix.
  let roomAtJoin = null
  let firstScanDone = false
  const shadow = new Map()     // relPath -> exact bytes THIS ENGINE last wrote/captured (source-level edit capture)
  const shaShadow = new Map()  // relPath -> sha256 hex string of binary bytes written/seen locally (echo suppression)
  // Per-file pre-serialized JSON fragments: relPath -> '"path": "content"'.
  // Assembled into v:1 JSON in saveShadow() without re-stringifying all files, cutting save CPU by ~6.6x.
  const shadowFragments = new Map()
  // relPath -> the bases our recent captured edits were made against, oldest first. Saved with the
  // shadow, because the shadow alone cannot tell "the room has this" from "we sent it and it never
  // arrived".
  const FROM_KEEP = 8
  const capturedFrom = new Map()
  const priorFrom = new Map()
  const keptUnsent = new Map() // relPath -> file mtime when an unsent edit was kept; frozen until saved again
  const origShadowSet = shadow.set.bind(shadow)
  const origShadowDelete = shadow.delete.bind(shadow)
  shadow.set = (k, v) => {
    origShadowSet(k, v)
    if (typeof v === 'string' && v.length <= MAX_BYTES) {
      shadowFragments.set(k, JSON.stringify(k) + ':' + JSON.stringify(v))
    } else {
      shadowFragments.delete(k)
    }
    return shadow
  }
  shadow.delete = (k) => {
    shadowFragments.delete(k)
    return origShadowDelete(k)
  }
  // THE SAME THING, FROM THE PREVIOUS SESSION, and the reason it exists:
  //
  // `shadow` in memory is enough to tell an authored edit from our own write while we are
  // running. It died with the process, so after a reconnect there was no ancestor for any
  // file — every rejoin looked like FIRST CONTACT, and the adopt branch below wrote the
  // room's copy over local disk. Observed live: after an MCP drop, a STALE room copy landed
  // on top of a newer local edit, with no conflict markers and no message. The snapshot it
  // takes made that recoverable, but nothing told anyone to go looking.
  //
  // Persisted, the ancestor exists, and the case becomes what it actually is: a three-way
  // merge. Keyed by room — the same folder rejoined against a different room must not
  // inherit an ancestor from unrelated history.
  const priorShadow = new Map()
  // relPath -> the disk text an authored write (editFile) replaced while the file had not synced yet:
  // that write's true ancestor, used by first contact (0.14.3 P0-1b).
  const preSyncBase = new Map()
  const bases = new Map()      // last synced content per file (advances on every reconcile)
  const forkBases = new Map()  // FORK POINT: what THIS author last saw/authored per file.
  // forkBases advances only on local authorship / first adoption — NOT when a
  // remote change is auto-applied to disk. That distinction is what stops a stale
  // local full-file paste from silently deleting another participant's just-arrived
  // work (it would look like a deliberate deletion against an up-to-date base).

  const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/')
  // HIV-P8: `skipped` collects the files this walk DECLINES to sync, and that second list is the
  // whole ticket. Everything in this engine is derived from "the files we sync", so every natural
  // place to notice a born-invisible file is definitionally blind to it: walk() dropped ignored
  // paths, so scan() never saw them, so reconcile() was never called for them, so the guard at the
  // top of reconcile() was unreachable for exactly the class of file it names. Hooking there would
  // have passed a unit test that called reconcile() directly and done nothing in a real session.
  //
  // DIRECTORY PRUNING IS UNCHANGED, deliberately. Descending into ignored directories to find
  // ignored files would walk vendor and build trees on every tick. Measured on a real checkout with
  // pruning kept: 7934 synced, 256 ignored files visible, 280 directories descended, 191ms for the
  // whole traversal — and that traversal already happens. We are keeping an answer isIgnored()
  // already computed instead of discarding it. An ignored file inside an ignored directory stays
  // unseen, which is the correct trade at that price.
  function walk(d, acc = [], skipped = []) {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return acc }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue
      const full = path.join(d, e.name)
      const r = rel(full)
      if (e.isDirectory()) { if (!isIgnored(r + '/')) walk(full, acc, skipped) }   // prune ignored dirs
      else if (e.isFile()) { if (isIgnored(r)) skipped.push(full); else acc.push(full) }
    }
    return acc
  }

  // LINE ENDINGS ARE NOT CONTENT (8 Nov 2026). Git for Windows ships core.autocrlf=true, so a
  // Windows checkout of an LF repo holds the same text with CRLF on every line (measured on the dev
  // PC: sync.js 4,992 CRs on disk, 0 in git). Compared byte for byte, two founders who cloned the
  // same repo disagree on EVERY line: a CRLF copy over the room's LF copy put a whole file in
  // conflict markers on every peer (both sides byte-identical), and a quieter version flipped each
  // peer's files to the other's endings, so git showed every line changed
  // (tests/eol-mixed-peers-test.mjs). So: the room holds LF only. readText() is the one way the
  // engine reads a text file, and it hands back LF while remembering how THIS disk ended that file;
  // writeToDisk() writes it back in that ending. A lone CR is content and is never touched. A file
  // new to this disk is written LF, as git stores it.
  // (Function declarations and a lazily made set: readText is hoisted and may run before this line.)
  var crlfFiles // relPaths whose copy on THIS disk uses CRLF
  function crlfSet() { return crlfFiles || (crlfFiles = new Set()) }
  function toLF(s) { return typeof s === 'string' && s.indexOf('\r\n') !== -1 ? s.replace(/\r\n/g, '\n') : s }
  function noteEol(relPath, raw) {
    const crlf = (raw.match(/\r\n/g) || []).length
    if (crlf && crlf * 2 >= (raw.match(/\n/g) || []).length) crlfSet().add(relPath)
    else crlfSet().delete(relPath)
  }
  function readText(full) {
    try {
      const st = fs.statSync(full)
      if (st.size > MAX_BYTES) return null
      const buf = fs.readFileSync(full)
      if (buf.includes(0)) return null
      const raw = buf.toString('utf8')
      noteEol(path.relative(ROOT, full).split(path.sep).join('/'), raw)
      return toLF(raw)
    } catch { return null }
  }
  // A direct read of a text file, for the few places that need one: same LF view as readText.
  function readDiskText(full) { return toLF(fs.readFileSync(full, 'utf8')) }
  // BRANCH ROOMS CARRY TEXT ONLY, BY DESIGN (hive-branch.js roomCarries): binaries are filled into
  // each folder from git, and `pr` reads a carried file missing from the room as DELETED. Binary sync
  // pushed every git-filled image into the room (tests/branch-test A6: 5 files where the seed put 4),
  // and once one was deleted there, the next joiner's fill would write it back and binary sync would
  // publish the undo to everyone. So binary sync is off in a branch-room folder, recognised by the
  // `.git` FILE hive-branch writes into it (NOT_A_CHECKOUT; not imported, hive-branch imports us).
  // A binary the room already holds (someone pushed it from a plain folder) is still received.
  const BINARY_SYNC = !process.env.HIVE_NO_BINARY_SYNC &&
    !(() => { try { return fs.readFileSync(path.join(ROOT, '.git'), 'utf8').includes('hivecode-live-room-not-a-git-checkout') } catch { return false } })()
  function isBinaryFile(full, st) {
    if (!BINARY_SYNC) return false
    try {
      const s = st || fs.statSync(full)
      if (!s.isFile()) return false
      if (s.size > MAX_BINARY_BYTES) return false
      const buf = fs.readFileSync(full)
      return buf.includes(0)
    } catch { return false }
  }
  function checkUnshared(full, st) {
    try {
      const s = st || fs.statSync(full)
      if (!s.isFile()) return null
      if (s.size > MAX_BINARY_BYTES) {
        return { reason: 'oversized', size: s.size }
      }
      const buf = fs.readFileSync(full)
      if (buf.includes(0)) {
        if (!BINARY_SYNC) {
          return { reason: 'binary', size: s.size }
        }
        return null
      }
      if (s.size > MAX_BYTES) {
        return { reason: 'oversized', size: s.size }
      }
      return null
    } catch { return null }
  }
  const ensuredDirs = new Set()
  // A CREDENTIAL INSIDE A FILE STAYS ON THIS MACHINE (3 Oct 2026). A file in a room goes to the relay
  // and to every participant's disk, so a key an agent pasted into config.js "to try something" went
  // to all of them. Now a file whose content holds a credential the room does not already have
  // (hive-secrets.js) is not sent: not its first version, not its edits, and a teammate's edits to it
  // wait too, because a merge made here would carry the key out with them. The person is told once
  // which file and what kind of key -- never the key itself -- and the file flows again the moment
  // the key is out of it. A key already in the room holds nothing back: there is nothing left to keep.
  const SHARE_SECRETS = process.env.HIVE_SHARE_SECRETS === '1' // an explicit opt-out, never a default
  const withheld = new Map() // relPath -> { kind, line, said } of the first credential found
  function heldForSecret(relPath, local, shared) {
    if (SHARE_SECRETS) return false
    const found = newSecrets(local, shared)
    if (!found.length) { if (withheld.has(relPath)) clearWithheld(relPath); return false }
    const prev = withheld.get(relPath)
    // Said in the room only for a file the room HAS: there, teammates are waiting on a change that is
    // not coming. A file the room never had leaves nobody missing anything -- and a repo with a
    // committed key would otherwise have every teammate who checks it out announce the same file.
    // The agent is told either way (hive_wait, hive_edit).
    const said = prev ? prev.said : (!SKIP.has(relPath) && inManifest(relPath))
    const f = { kind: found[0].kind, line: found[0].line, said }
    withheld.set(relPath, f)
    if (!prev) {
      log(`[${name}] holding ${relPath} on this machine: it contains ${describeSecret(f)}`)
      if (said) { try { say(`⛔ ${relPath}: ${name}'s change stays on ${name}'s machine, because it contains ${describeSecret(f)} and Hivecode does not send keys to the room. It is shared once the key is moved out of the file (into .env, which is never shared).`) } catch { } }
    }
    return true
  }
  function clearWithheld(relPath) {
    const w = withheld.get(relPath)
    withheld.delete(relPath)
    log(`[${name}] ${relPath} holds no key now: shared again`)
    if (w && w.said) { try { say(`· ${relPath} from ${name} is shared again: the key is out of it.`) } catch { } }
  }
  // Still on disk: a held file that was since deleted or moved away is no longer anybody's concern.
  function withheldNow() {
    return [...withheld].filter(([p]) => fs.existsSync(path.join(ROOT, p))).map(([p, f]) => ({ path: p, kind: f.kind, line: f.line }))
  }
  // A ROOM WRITE THAT CANNOT LAND HERE. Measured 3 Oct 2026: a teammate's edit to a file that is
  // read-only on this disk (a Perforce checkout, a generated file, a handle another program holds)
  // threw EPERM inside the Yjs observer; y-websocket printed "Caught error while handling a Yjs
  // update" to stderr, the file stayed at the old version while the room moved on, status() read
  // all green, and nothing ever tried again. Now the path is recorded, the room is told once that
  // this copy is behind, status() lists it, and every scan retries (retryUnwritable) until it lands.
  const unwritable = new Map() // relPath -> error code of the last failed write
  function noteUnwritable(relPath, e) {
    const code = (e && e.code) || 'error'
    const first = !unwritable.has(relPath)
    unwritable.set(relPath, code)
    if (!first) return
    log(`[${name}] could not write ${relPath} (${code}); this folder's copy stays behind the room's until it can be written`)
    if (SKIP.has(relPath)) return // a rendered control file: it is re-rendered on the next change anyway
    try { say(`⚠ ${relPath} could not be written on ${name}'s disk (${code}: read-only, locked, or a folder in the way), so ${name}'s copy is older than the room's. It is written as soon as the file can be.`) } catch { }
  }
  function clearUnwritable(relPath) {
    unwritable.delete(relPath)
    log(`[${name}] ${relPath} written: this folder has the room's copy again`)
    if (!SKIP.has(relPath)) { try { say(`· ${relPath} is current on ${name}'s disk again.`) } catch { } }
  }
  // Through reconcile, not a bare write: if the file was edited here while it could not be written,
  // that edit is merged with the room's version rather than overwritten by it.
  function retryUnwritable() {
    for (const r of [...unwritable.keys()]) {
      if (SKIP.has(r)) { unwritable.delete(r); continue }
      const fe = fileDocs.get(r)
      const disk = readText(path.join(ROOT, r))
      if (fe && fe.synced && disk !== null && disk === fe.text.toString()) { clearUnwritable(r); continue }
      try { reconcile(r, 'remote') } catch { }
    }
  }
  // --- CASE-INSENSITIVE PATH COLLISION GUARD ---
  // On case-insensitive file systems (Windows/macOS), two room paths that differ only
  // in case (e.g. Case.js and case.js) map to the exact same file on disk. Writing both
  // causes alternating disk writes and watcher echo loops that clobber the room doc.
  // We probe case-sensitivity at startup, keep the key already on disk (or first seen),
  // never write the collided key to disk, never let a scan push the physical file into
  // the collided key, report collided paths in status(), and announce once to the room.
  const isCaseInsensitive = (() => {
    try {
      const probeName = `.hive-case-probe-${process.pid}-${Date.now()}.tmp`
      const probePath = path.join(ROOT, probeName)
      fs.writeFileSync(probePath, '')
      const probeLower = probePath.toLowerCase()
      const probeTarget = probePath === probeLower ? probePath.toUpperCase() : probeLower
      const insensitive = fs.existsSync(probeTarget)
      try { fs.unlinkSync(probePath) } catch { }
      return insensitive
    } catch {
      return process.platform === 'win32' || process.platform === 'darwin'
    }
  })()
  const fold = (r) => isCaseInsensitive ? r.toLowerCase() : r

  const canonicalCaseKeys = new Map() // fold(r) -> canonical relPath
  const recentlyLocallyRemovedCase = new Map() // fold(r) -> { path: r, at: Date.now() }
  const collided = new Map()          // collided relPath -> { with: canonical relPath }
  const collidedWarned = new Set()    // relPath announced to room
  const collidedTimers = new Map()    // relPath -> Timeout (debounced room announcement)

  function clearCollidedTimer(r) {
    if (collidedTimers.has(r)) {
      clearTimeout(collidedTimers.get(r))
      collidedTimers.delete(r)
    }
  }

  function actualDiskPath(relPath) {
    if (!isCaseInsensitive) return fs.existsSync(path.join(ROOT, relPath)) ? relPath : null
    const full = path.join(ROOT, relPath)
    if (!fs.existsSync(full)) return null
    try {
      const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean)
      let cur = ROOT
      const matched = []
      for (const part of parts) {
        const lower = part.toLowerCase()
        const entries = fs.readdirSync(cur)
        const hit = entries.find(e => e.toLowerCase() === lower)
        if (!hit) return relPath
        matched.push(hit)
        cur = path.join(cur, hit)
      }
      return matched.join('/')
    } catch {
      return relPath
    }
  }

  function fileExistsExact(relPath) {
    if (!isCaseInsensitive) return fs.existsSync(path.join(ROOT, relPath))
    return actualDiskPath(relPath) === relPath
  }

  function ensureExactDiskCasing(relPath) {
    if (!isCaseInsensitive) return
    const onDisk = actualDiskPath(relPath)
    if (onDisk && onDisk !== relPath && fold(onDisk) === fold(relPath)) {
      const full = path.join(ROOT, relPath)
      const onDiskFull = path.join(ROOT, onDisk)
      const dir = path.dirname(full)
      const hop = path.join(dir, `.hive-case-hop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      try {
        fs.renameSync(onDiskFull, hop)
        try {
          fs.renameSync(hop, full)
        } catch {
          // If second rename failed, attempt to rename the hop back to onDiskFull
          try { fs.renameSync(hop, onDiskFull) } catch { }
        }
      } catch { }
    }
  }

  function checkCaseCollision(r) {
    if (!isCaseInsensitive) return false
    const cf = fold(r)
    const canon = canonicalCaseKeys.get(cf)
    if (canon === r) return false

    const onDisk = actualDiskPath(r)

    if (!canon) {
      if (onDisk) {
        canonicalCaseKeys.set(cf, onDisk)
        if (onDisk !== r) {
          collided.set(r, { with: onDisk })
          noteCollided(r, onDisk)
          return true
        }
        return false
      }
      canonicalCaseKeys.set(cf, r)
      return false
    }

    // We have a difference between `canon` and `r` for the same folded name.
    if (onDisk === r && onDisk !== canon) {
      canonicalCaseKeys.set(cf, r)
      collided.delete(r)
      collidedWarned.delete(r)
      clearCollidedTimer(r)

      // If `canon` is absent on disk with exact case, it was locally renamed to `r`
      if (actualDiskPath(canon) !== canon) {
        collided.delete(canon)
        collidedWarned.delete(canon)
        clearCollidedTimer(canon)
        if (!inManifest(r)) {
          queueManifestSet(r)
        }
        noteLocalDelete(canon)
        return false
      }

      collided.set(canon, { with: r })
      noteCollided(canon, r)
      return false
    }

    collided.set(r, { with: canon })
    noteCollided(r, canon)
    return true
  }

  function noteCollided(r, withKey) {
        if (collidedWarned.has(r)) return
    log(`[${name}] ${withKey} and ${r} both exist in the room; disk cannot hold both, so ${r} is not written here`)
    if (SKIP.has(r)) return
    if (collidedTimers.has(r)) return
    collidedTimers.set(r, setTimeout(() => {
      collidedTimers.delete(r)
      if (!collided.has(r) || collidedWarned.has(r)) return
      if (!inManifest(r) || !inManifest(withKey)) return
      collidedWarned.add(r)
      try {
        say(`${withKey} and ${r} both exist in the room; ${name}'s disk cannot hold both, so ${r} is not written there.`)
      } catch { }
    }, 2500))
  }

  function writeToDisk(relPath, content) {
    if (collided.has(relPath)) return
    if (!isSafeRelPath(relPath)) return // never write a path that could escape ROOT (defense in depth)
    // The mkdir below would recreate a lost folder holding one file, and the next scan would read
    // every other file as deleted -- the exact wipe loseFolder exists to prevent.
    if (folderLost) return
    ensureExactDiskCasing(relPath)
    const full = path.join(ROOT, relPath)
    // The room holds LF (readText). This disk gets the ending it already used for this file.
    content = toLF(content)
    const bytes = crlfSet().has(relPath) && typeof content === 'string' ? content.replace(/\n/g, '\r\n') : content
    try {
      // Only for a path a scan already found unshared. Every remote edit lands through here, so
      // checking every file would read each one in full before writing it -- double the disk work
      // on the hottest path, to guard a case the scan has already seen.
      if ((unsharedMtimes.has(relPath) || unsharedWarned.has(relPath)) && fs.existsSync(full)) {
        const unshared = checkUnshared(full)
        if (unshared) {
          const stamp = deletedStamp()
          const keptAs = keepDeletedCopy(relPath, stamp)
          if (keptAs) {
            log(`[${name}] local unshared file ${relPath} overwritten by room write; copy preserved in ${keptAs}`)
            try {
              note(`· ${relPath} on ${name}'s disk was ${unshared.reason} and was overwritten by a room write — local copy preserved in ${keptAs}.`)
            } catch { }
          }
        }
      }
    } catch { }
    const dir = path.dirname(full)
    try {
      if (!ensuredDirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        ensuredDirs.add(dir)
      }
      try { fs.writeFileSync(full, bytes) } catch (e) {
        // The cache only skips mkdir; it must never lose a write. A folder someone deleted or renamed
        // since we made it is simply made again.
        if (e.code !== 'ENOENT') throw e
        ensuredDirs.delete(dir)
        fs.mkdirSync(dir, { recursive: true })
        ensuredDirs.add(dir)
        fs.writeFileSync(full, bytes)
      }
    } catch (e) {
      // The disk still holds the OLD content. Callers record the new content as this file's base and
      // shadow -- some before writing, some after -- and a base the disk does not hold makes the stale
      // copy read as a local edit, merged back over the room: measured, a teammate's change reverted
      // for everyone. So the bookkeeping goes back to what the disk really holds, and the error still
      // propagates, so no caller goes on to record this write as done.
      const onDisk = readText(full)
      if (onDisk !== null) { bases.set(relPath, onDisk); forkBases.set(relPath, onDisk); shadow.set(relPath, onDisk); saveShadowSoon() }
      noteUnwritable(relPath, e)
      throw e
    }
    if (unwritable.has(relPath)) clearUnwritable(relPath)
    shadow.set(relPath, content) // record what THE ENGINE wrote — any later disk divergence is an authored edit
    saveShadowSoon()             // ...and survive a restart, or the next join has no ancestor
    known.add(relPath)
    try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
  }

  // --- the ancestor, across restarts -----------------------------------------------------
  // Written next to writeToDisk deliberately: this file is only ever correct if it is saved
  // by the one function that changes `shadow`. Debounced, because reconcile can touch many
  // files in one pass and a synchronous write per file would show up as sync latency.
  function loadPriorShadow() {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(ROOT, SHADOW_FILE), 'utf8'))
      // A mismatched room or format means we have no ancestor for these files. Returning
      // empty is the SAFE answer — it degrades to the old first-contact behaviour rather
      // than merging against someone else's history.
      if (!o || o.v !== 1 || o.room !== room) return
      for (const [k, v] of Object.entries(o.files || {})) {
        if (typeof k === 'string' && typeof v === 'string' && isSafeRelPath(k)) priorShadow.set(k, v)
      }
      // Carried forward, not just read: an edit re-sent after a rejoin can be lost the same way
      // again, and the next rejoin needs the same base.
      for (const [k, v] of Object.entries(o.from || {})) {
        const hist = (Array.isArray(v) ? v : [v]).filter((s) => typeof s === 'string').slice(-FROM_KEEP)
        if (typeof k === 'string' && hist.length && isSafeRelPath(k)) { priorFrom.set(k, hist); capturedFrom.set(k, hist.slice()) }
      }
      log(`[hive] recovered ${priorShadow.size} file ancestor(s) from the previous session`)
    } catch { /* absent or unreadable: no ancestor, same as before this existed */ }
  }
  let shadowTimer = null
  function saveShadowSoon() {
    if (shadowTimer) return
    shadowTimer = setTimeout(() => { shadowTimer = null; saveShadow() }, 1500)
    if (shadowTimer.unref) shadowTimer.unref() // never hold the process open just to save this
  }
  function saveShadow() {
    const tmp = path.join(ROOT, SHADOW_FILE + '.tmp')
    try {
      // Assemble v:1 JSON from cached fragments: avoids walking/stringifying all files
      // on every debounced flush. The resulting payload is byte-for-byte valid JSON matching
      // { v: 1, room, files }, preserving the atomic write-then-rename.
      const parts = []
      for (const frag of shadowFragments.values()) parts.push(frag)
      const from = []
      for (const [k, v] of capturedFrom) {
        const hist = v.filter((s) => typeof s === 'string' && s.length <= MAX_BYTES)
        if (hist.length) from.push(JSON.stringify(k) + ':' + JSON.stringify(hist))
      }
      const payload = `{"v":1,"room":${JSON.stringify(room)},"files":{${parts.join(',')}},"from":{${from.join(',')}}}`
      fs.writeFileSync(tmp, payload)
      fs.renameSync(tmp, path.join(ROOT, SHADOW_FILE))
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch { }
      log(`[hive] could not save the file-ancestor record: ${e.message}`)
    }
  }

  const conflicted = new Set() // files currently holding unresolved <<<<<<< markers
  const icrWarned = new Map()  // relPath -> last ICR semantic warning announced (dedupe)
  // HIV-P17: a creation race of CODE that cannot merge lands NOTHING. The doc keeps roomText, the disk
  // keeps the local draft (also saved as a manual snapshot, so it survives whatever happens next), and
  // the bases point at roomText, so the next normal edit merges against the room's copy. One function
  // for all three race paths -- first contact, a dead heat, and a dead heat the peer already resolved
  // -- so their recovery and their announcement cannot drift apart.
  // An edit the room never received, and we no longer know what it was made against: re-sending
  // it as a diff over the room's copy could revert someone else's change, so it is not sent. It is
  // kept on disk and in the file's history, and said out loud, because the alternative was silence.
  // Not "save it again": the base is now the disk, so an unchanged save is a no-op and sends nothing
  // (Antigravity, 1 Nov). hive_edit writes the copy into the room outright. Both copies go into the
  // file's history so the two can be compared before choosing.
  function keepUnsent(relPath, disk, roomText) {
    captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local edit that never reached the room (kept)' })
    if (typeof roomText === 'string' && roomText !== disk) captureSnapshot(relPath, roomText, name, { force: true, kind: 'manual', label: 'room copy when the local edit was kept' })
    bases.set(relPath, disk); forkBases.set(relPath, disk)
    let mt = 0; try { mt = fs.statSync(path.join(ROOT, relPath)).mtimeMs } catch { }
    keptUnsent.set(relPath, mt)
    try {
      say(`⚠ ${relPath}: ${name}'s last edit never reached the room — it was held while someone else had the file, and ${name}'s connection dropped. ` +
        `The room's copy was NOT applied over it: it is kept on disk, and both copies are in the file's history. Nothing more syncs for this file until ` +
        `${name} saves it again; that save sends it as it is, replacing the room's copy. Claim ${relPath} first.`)
    } catch { }
  }
  function refuseCreationRace(relPath, why, disk, roomText) {
    conflicted.add(relPath)
    captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local draft preserved (creation-race refused)' })
    bases.set(relPath, roomText); forkBases.set(relPath, roomText); shadow.set(relPath, roomText)
    if (!inManifest(relPath)) queueManifestSet(relPath)
    if (icrWarned.get(relPath) === why) return
    icrWarned.set(relPath, why)
    const conflict = why === 'CONFLICT'
    log(`[${name}] !! HIV-P17 REFUSED a ${conflict ? 'conflicting' : 'fused'} creation-race merge of ${relPath}${conflict ? '' : `: ${why}`}`)
    try {
      say(conflict
        ? `[!] @all ${relPath}: a creation-race merge was REFUSED — two participants created it with conflicting content, and landing both whole files in the room's copy would fuse them. Nothing was written: the room's copy and ${name}'s local copy are both intact. Someone must reconcile them deliberately; a plain file write will merge against the other version again, hive_edit replaces it outright.`
        : `[!] @all ${relPath}: a creation-race merge was REFUSED because it fused rather than merged — ${why}. Nothing was written: the room's copy and ${name}'s local copy are both intact. Someone must reconcile them deliberately; a plain file write will merge against the other version again, hive_edit replaces it outright.`)
    } catch { /* the log still carries it */ }
  }
  // ONE MESSAGE PER JOIN, IN PLAIN WORDS (onboarding audit, 2 Oct 2026). HIV-P9's outcomes (in
  // reconcile, below) are right, but each file used to be announced on its own chat line in engine
  // words ("UNPROVEN", "Resolve deliberately"), so a teammate a few commits behind filled the chat,
  // and a Windows checkout (CRLF, against a room seeded from git's LF) made nearly every text file
  // "differ". The outcomes are unchanged. They are collected until the join goes quiet and said
  // once; the per-file log lines stay. Line endings alone are not worth a chat line: when nothing
  // else differs, nothing is said. The window slides, so one join of a big repo stays one message.
  const firstContact = { eol: [], adopted: [], kept: [], timer: null }
  function noteFirstContact(kind, relPath) {
    firstContact[kind].push(relPath)
    if (firstContact.timer) clearTimeout(firstContact.timer)
    firstContact.timer = setTimeout(flushFirstContact, 3000)
  }
  function flushFirstContact() {
    if (firstContact.timer) { clearTimeout(firstContact.timer); firstContact.timer = null }
    const { eol, adopted, kept } = firstContact
    firstContact.eol = []; firstContact.adopted = []; firstContact.kept = []
    if (!adopted.length && !kept.length) return
    const total = eol.length + adopted.length + kept.length
    const names = (l) => l.slice(0, 5).join(', ') + (l.length > 5 ? ` and ${l.length - 5} more` : '')
    const parts = [`↓ ${name} joined with ${total === 1 ? '1 file that differs' : `${total} files that differ`} from the room's copy.`]
    if (eol.length) parts.push(`${eol.length} differed only in line endings and now match the room.`)
    if (adopted.length) {
      parts.push(`${adopted.length === 1 ? '1 was an older version' : `${adopted.length} were older versions`} the room had already moved past, so ${name} now has the room's copy (the old one is in the file's history): ${names(adopted)}.`)
    }
    if (kept.length) {
      const one = kept.length === 1
      parts.push(`${one ? '1 holds' : `${kept.length} hold`} content the room has never seen, so neither copy was changed and the room's copy was NOT adopted: ${names(kept)}. ` +
        `In ${name}'s folder ${one ? 'it still holds' : 'they still hold'} ${name}'s version, and nothing syncs for ${one ? 'it' : 'them'} until ${name} saves ${one ? 'it' : 'them'} again. To make one the room's version, claim it and hive_edit it with the full file. ` +
        `Don't delete a local copy to get the room's: a deletion syncs, and removes the file for everyone.`)
    }
    // What concerns THIS folder only (line endings, older copies it now has) is a note for hive_status; only
    // content the room has never seen is the room's business, because nobody else has it (0.14.4, C5).
    note(parts.join(' '))
    if (kept.length) { try { say([parts[0], parts[parts.length - 1]].join(' ')) } catch { } } // the kept part is pushed last
  }

  function reconcileBinary(relPath, origin = 'local') {
    if (folderLost) return
    if (SKIP.has(relPath) || isIgnored(relPath) || !canOpen(relPath)) return
    if (collided.has(relPath)) return
    const full = path.join(ROOT, relPath)
    const exists = !isCaseInsensitive ? fs.existsSync(full) : actualDiskPath(relPath) === relPath
    let fe = fileDocs.get(relPath)
    if (!fe) {
      if (!exists) return
      openFile(relPath)
      fe = fileDocs.get(relPath)
      if (!fe) return
    }
    if (!fe.synced && origin !== 'local') return
    touchFile(relPath)
    if (origin !== 'remote') arrivedNew.delete(relPath) // a local change: an ordinary file now (see reconcile)

    if (origin === 'local') {
      if (!canWrite(relPath)) {
        if (fe && fe.synced && fe.bin.has('data')) {
          const remoteData = fe.bin.get('data')
          const remoteSha = fe.bin.get('sha')
          if (remoteData && remoteSha) {
            let localSha = null
            if (exists) {
              try {
                const localBuf = fs.readFileSync(full)
                localSha = crypto.createHash('sha256').update(localBuf).digest('hex')
              } catch { }
            }
            if (localSha !== remoteSha) {
              try {
                fs.writeFileSync(full, Buffer.from(remoteData))
                shaShadow.set(relPath, remoteSha)
                mtimes.set(relPath, fs.statSync(full).mtimeMs)
              } catch { }
            }
            } else {
              ensureExactDiskCasing(relPath)
          }
        }
        return
      }
      if (!exists) return
      let st
      try { st = fs.statSync(full) } catch { return }
      if (!st.isFile()) return
      if (st.size > MAX_BINARY_BYTES) {
        noticeUnsharedOne(relPath, { reason: 'oversized', size: st.size })
        return
      }
      let buf
      try { buf = fs.readFileSync(full) } catch { return }
      const sha = crypto.createHash('sha256').update(buf).digest('hex')
      if (shaShadow.get(relPath) === sha) return // echo suppression
      shaShadow.set(relPath, sha)
      mtimes.set(relPath, st.mtimeMs)

      fe.doc.transact(() => {
        fe.bin.set('data', new Uint8Array(buf))
        fe.bin.set('sha', sha)
        fe.bin.set('size', buf.length)
        fe.bin.set('by', name)
        fe.bin.set('at', Date.now())
        if (fe.text.length > 0) fe.text.delete(0, fe.text.length)
      })
      if (!inManifest(relPath)) manifest.set(relPath, 1)
      known.add(relPath)
      dischargeUnshared(relPath)
      return
    }

    // origin === 'remote'
    if (!fe.bin.has('data')) return
    const remoteData = fe.bin.get('data')
    const remoteSha = fe.bin.get('sha')
    const remoteBy = fe.bin.get('by')
    if (!remoteData || !remoteSha) return

    let localSha = null
    if (exists) {
      try {
        const localBuf = fs.readFileSync(full)
        localSha = crypto.createHash('sha256').update(localBuf).digest('hex')
      } catch { }
    }

    if (localSha === remoteSha) {
      shaShadow.set(relPath, remoteSha)
      try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
      known.add(relPath)
      return
    }

    let keptAs = null
    if (exists) {
      const stamp = deletedStamp()
      keptAs = keepDeletedCopy(relPath, stamp)
      if (keptAs) {
        log(`[${name}] local binary ${relPath} overwritten by remote write (winner: ${remoteBy || 'teammate'}); copy preserved in ${keptAs}`)
        try {
          note(`· ${relPath} updated from room (winner: ${remoteBy || 'teammate'}). Your local copy saved to ${keptAs}.`)
        } catch { }
      }
    }

    try {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, Buffer.from(remoteData))
      shaShadow.set(relPath, remoteSha)
      mtimes.set(relPath, fs.statSync(full).mtimeMs)
      known.add(relPath)
      dischargeUnshared(relPath)
      log(`[${name}] <- binary ${relPath} (${remoteData.length} bytes${keptAs ? `, previous saved to ${keptAs}` : ''})`)
    } catch (err) {
      log(`[${name}] error writing binary ${relPath}: ${err.message}`)
    }
  }

  function reconcile(relPath, origin = 'local') {
    if (process.env.HIVE_TEST_STUCK_SYNC && relPath === process.env.HIVE_TEST_STUCK_SYNC) return
    if (SKIP.has(relPath) || isIgnored(relPath)) return // never sync secrets/ignored files
    if (!canOpen(relPath)) return // out-of-scope OR unsafe path (traversal/control char) — never materialize it
    if (collided.has(relPath)) {
      if (origin === 'local') return // never push physical file into collided key
      const fe = fileDocs.get(relPath)
      if (fe && fe.synced) {
        const dt = fe.text.toString()
        bases.set(relPath, dt)
        forkBases.set(relPath, dt)
      }
      return
    }
    const full = path.join(ROOT, relPath)
    const exists = !isCaseInsensitive ? fs.existsSync(full) : actualDiskPath(relPath) === relPath
    let fe = fileDocs.get(relPath)
    if (fe && fe.bin && fe.bin.has('data')) {
      reconcileBinary(relPath, origin)
      return
    }
    const disk = exists ? readText(full) : null
    if (exists && disk === null) {
      if (isBinaryFile(full)) {
        if (origin === 'local') {
          reconcileBinary(relPath, 'local')
          return
        }
      }
      const unshared = checkUnshared(full)
      if (unshared) noticeUnsharedOne(relPath, unshared)
      return // present on disk but binary/too-large to represent — leave it untouched (never clobber with stale doc text)
    }
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
    fe = fileDocs.get(relPath)
    // A local change waiting for its file to sync is an unsent edit too: the sync handler sends it,
    // and until then leave() must wait for it (0.14.3 P0-1: a new file written just before leaving).
    if (!fe) { if (disk === null) return; openFile(relPath); if (origin === 'local') unsentLocal.add(relPath); return }
    if (!fe.synced) { if (origin === 'local' && disk !== null) unsentLocal.add(relPath); return }
    // A detected same-line race is being resolved (P0-F): write nothing from the shared text until the
    // resolution arrives, so the fused text never reaches this disk. A local save still goes through.
    if (fe.clashHold && fe.text.toString() !== fe.clashHold.final && Date.now() < fe.clashHold.until) {
      // A local save made while a race is being resolved waits for the resolution too (F5): merged now,
      // against the shared text, it would take the fused line into this disk and publish it again. The
      // edit is safe on disk meanwhile; it goes out as soon as the hold ends.
      if (origin === 'local') deferLocal(relPath, fe)
      return
    }
    if (fe.clashHold) { fe.clashHold = null; if (fe.pendingLocal) { runDeferred(relPath, fe); return } }
    // A KEPT UNSENT EDIT IS FROZEN until its author saves the file again. Merging it against the
    // room in either direction would decide something nobody decided: the room's next change would
    // be written over it, and an unchanged save merged against itself pulled the room's old copy over
    // it (antigravity-3, 1 Nov). The next save is the decision: it sends the file as it is.
    if (keptUnsent.has(relPath)) {
      if (origin !== 'local') return
      let mt = 0; try { mt = fs.statSync(full).mtimeMs } catch { }
      if (mt === keptUnsent.get(relPath)) return
      keptUnsent.delete(relPath)
      const rt = fe.text.toString()
      captureSnapshot(relPath, rt, name, { force: true, kind: 'manual', label: 'room copy replaced by a kept edit' })
      bases.set(relPath, rt); forkBases.set(relPath, rt); shadow.set(relPath, rt)
      try { say(`↻ ${relPath}: ${name} saved the kept copy again, so it now replaces the room's copy (the room's copy is in the file's history).`) } catch { }
      // fall through: merged against the room's copy, ours goes out whole and signed like any edit
    }
    // Before anything below can publish this disk's content, merge it, or stamp it into the ledger:
    // a key on disk that the room does not have holds the whole file here (heldForSecret).
    {
      const shared0 = fe.text.toString()
      if (disk !== null && disk !== shared0) { if (heldForSecret(relPath, disk, shared0)) return }
      else if (withheld.has(relPath)) clearWithheld(relPath)
    }
    touchFile(relPath) // reconciling a file IS using it — keep it in the working set
    // ...but only a LOCAL change makes a just-arrived new file an ordinary one with the full grace.
    // A remote reconcile is the arrival itself, and must not take away its early eviction.
    if (origin !== 'remote') arrivedNew.delete(relPath)
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
    dropStackedAwaits(relPath, fe, disk) // before anything reads the room's copy (0.14.3 P0-5-3)
    const docText = fe.text.toString()
    rememberText(fe, docText)
    // An empty shared doc is authoritative ONLY if we have history for this path.
    // A file's NAME lives in the parent doc and its CONTENT in the file's own doc, on two
    // different connections — there is no atomicity across them. A client that joins a large
    // project and dies mid-join gets every manifest key up and only some file bodies, leaving
    // the room asserting that paths exist with nothing behind them. With no ancestor and real
    // bytes on disk, "" means the publisher never finished, not that the file is empty, and
    // adopting it deletes real work (measured: 186 files zeroed across three folders).
    // A genuine emptying of a file we HAVE synced still has an ancestor, so it falls through
    // to the merge below and still lands.
    const noHistory = !bases.has(relPath) && !priorShadow.has(relPath)
    // HIV-P14b tracing, env-gated. Which branch a blind recreate actually takes was guessed
    // wrong twice from reading the code; this answers it from the running product.
    if (process.env.HIVE_P14_DEBUG && new RegExp(process.env.HIVE_P14_DEBUG).test(relPath)) {
      log(`[P14] ${relPath} origin=${origin} synced=${fe.synced} docLen=${docText.length} ` +
        `diskLen=${disk === null ? 'null' : disk.length} hasBase=${bases.has(relPath)} ` +
        `priorShadow=${priorShadow.has(relPath)} inManifest=${manifest.has(relPath)} ` +
        `preexisting=${preexisting.has(relPath)}`)
    }
    if (docText === '' && (!inManifest(relPath) || (disk && noHistory))) {
      // the relay has no usable copy of this path -> publish ours (a genuinely new file,
      // or one whose registration outlived the join that promised it)
      if (disk === null) return
      const now = Date.now()
      createdTimes.set(relPath, now)
      genesisPublished.add(relPath)
      fe.doc.transact(() => {
        applyDiff(fe.text, disk)
        if (fe.head && !fe.head.has('genesis')) fe.head.set('genesis', { at: now, by: name })
      })
      stampProvenance(relPath, '', disk) // genesis: sign the file's first content (base = empty)
      queueManifestSet(relPath)
      known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk); shadow.set(relPath, disk)
      try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
      return
    }
    const yt = fe.text
    if (disk === null) {
      if (!inManifest(relPath)) return
      writeToDisk(relPath, docText); bases.set(relPath, docText); forkBases.set(relPath, docText); return
    }
    if (disk === docText) {
      ensureExactDiskCasing(relPath)
      if (!inManifest(relPath) && origin === 'local') {
        const key = fold(relPath)
        const prevCase = recentlyLocallyRemovedCase.get(key)
        if (prevCase && (Date.now() - prevCase.at < 60000)) {
          recentlyLocallyRemovedCase.delete(key)
          queueManifestSet(relPath)
        }
      }
      // CREATING a file is editing it. This branch is where a locally-authored NEW file
      // lands: scan() finds it, openFile() syncs the content up, and by the time reconcile
      // runs disk and doc already agree -- so it returns below, before the markEditing() at
      // the end of this function. Measured effect: an agent that creates a file and moves on
      // shows as plain "online", and only an agent that writes the SAME file twice ever
      // appears to be working. In a room of agents each producing a file or two, that renders
      // a busy room as an idle one.
      // Gated on FIRST SIGHT (`known` is set just below) so the 2s safety-net scan cannot
      // re-mark an untouched file, and on local origin so a remote change landing on disk is
      // not attributed to whoever received it -- the same distinction forkBases makes here.
      if (origin === 'local' && !known.has(relPath) && disk) markEditing(relPath)
      known.add(relPath); bases.set(relPath, disk); shadow.set(relPath, disk) // agreed state = capture baseline
      // disk and doc already agree — a safe fork point, but only adopt it as
      // THIS author's fork on first sight or our own local activity (a remote
      // change landing on disk doesn't mean the local author has seen it).
      if (!forkBases.has(relPath) || origin === 'local') forkBases.set(relPath, disk)
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
      // CREATION RACE, not a late join. The adopt below is correct only when our local
      // copy PRE-DATES this session (clone-then-join). If this path appeared on disk
      // after we started, then both copies were authored concurrently -- two agents
      // creating the same new file within the sync window -- and adopting the room's
      // copy silently discards work its author just wrote, with no conflict shown.
      // There is genuinely no common ancestor here, so merge from an EMPTY base:
      // disjoint additions union (the normal case -- each author added their own
      // block), and a real overlap raises conflict markers for a human to settle
      // instead of the engine quietly picking a winner on arrival order.
      // HIV-P14b, OPEN AND DELIBERATELY NOT IMPLEMENTED HERE YET.
      //
      // There is a third case this dichotomy misses: the path appeared on OUR disk after we
      // started AND the room already had it before we joined. That is not a race -- the agent
      // could not see the file (bounded working set, nothing touched it), believed it did not
      // exist, and wrote one. Measured 21 Sep 2026: agent B recreated mod039.js and agent A's
      // copy ended up with two const declarations of the same name.
      //
      // `preexisting` records our DISK, so it structurally cannot tell those apart; the manifest
      // as of first sync can. A guard on that was written and REMOVED before shipping, because
      // the probe showed it never firing -- most likely the manifest is not yet populated at the
      // instant the base provider reports sync, so the snapshot came back empty. A refusal path
      // that silently never runs is worse than none: it reads as protection in review and does
      // nothing in production, which is the defect class this repo keeps hitting.
      //
      // What ships instead is the reporting half, which is verified: status() now exposes
      // filesHeld/roomFiles/filesMissing instead of a full house, and the join announces the gap
      // with the count and the remedy. An agent told "33 files exist here that you do not have,
      // reading the path fetches it" will not recreate them. That removes the cause; the guard
      // is the belt for when it happens anyway, and it lands when it is proven to fire.
      if (process.env.HIVE_P14_DEBUG) log(`[P14] BRANCH=no-base-block ${relPath} preexisting=${preexisting.has(relPath)}`)
      // HIV-P14b. A BLIND RECREATE IS NOT A RACE, and the empty-base merge below corrupts it.
      //
      // The dichotomy above has a third case: the path appeared on OUR disk after we started AND
      // the room already had it before we joined. The working set is bounded, nothing touched
      // that file, so the agent could not see it, concluded it did not exist, and wrote one.
      //
      // Measured 21 Sep 2026, traced through the running product. Agent B, holding 8 of a room's
      // 41 files, wrote mod039.js:
      //   mod039.js origin=remote synced=true docLen=22 diskLen=39 hasBase=false
      //             inManifest=true preexisting=false   -> BRANCH=no-base-block
      // It lands exactly here, `preexisting` is false, and the empty-base merge unions two whole
      // files into agent A's copy:
      //   export const v39 = 39
      //   export const v39 = "FROM SCRATCH BY B"
      // Two const declarations of the same name. Invalid code, in someone else's folder, from B
      // doing the only thing available to it.
      //
      // The union is right for what the comment above describes -- two authors adding DIFFERENT
      // blocks to a file they both just created. It is wrong for two independent whole-file
      // creations of the same module, which is what a blind recreate always is.
      //
      // `roomAtJoin` is the discriminator `preexisting` cannot be: a path in it existed in the
      // ROOM before we did, however new it is on our disk. The `roomAtJoin &&` guard is
      // load-bearing -- before first sync it is null, and treating null as an empty room would
      // classify every joiner's first creation as a race.
      //
      // Adopt the room's copy, because it is the real file and the agent needs it to work from,
      // and snapshot the local draft so nothing the agent wrote is lost. Then say so loudly: the
      // entire failure was the agent not knowing the file was already there.
      if (roomAtJoin && roomAtJoin.has(relPath) && !preexisting.has(relPath)) {
        captureSnapshot(relPath, disk, name, {
          force: true, kind: 'manual',
          label: `local draft preserved — ${relPath} already existed in the room before this client joined`,
        })
        bases.set(relPath, docText); forkBases.set(relPath, docText); shadow.set(relPath, docText)
        if (docText !== disk) writeToDisk(relPath, docText)
        try {
          say(`⚠ ${relPath} ALREADY EXISTED IN THE ROOM before I joined — I had not fetched it, so it was ` +
            `written here from scratch. The room's copy is now on disk and my draft was snapshotted. ` +
            `This folder holds a bounded working set: a file you cannot see may still exist, so read or ` +
            `claim the path before creating it. hive_status reports filesHeld of roomFiles.`)
        } catch { }
        if (process.env.HIVE_P14_DEBUG) log(`[P14] BRANCH=blind-recreate-refused ${relPath}`)
        return
      }
      if (!preexisting.has(relPath)) {
        // Terminate both sides before merging. With an empty base there is no shared
        // trailing context, so a side whose last line lacks a newline gets its final
        // statement fused onto the other side's first one. The result still parses,
        // which is worse than failing -- it reads as corruption to whoever opens it.
        const nl = (s) => (s === '' || s.endsWith('\n') ? s : s + '\n')
        const r0 = icrMerge3('', nl(disk), nl(docText), relPath)
        // HIV-P17: SILENT COLLISION DETECTION on genesis-publish creation race.
        // The normal merge path (below, ~line 1880) runs fusionReason() to catch merges
        // that broke valid code or duplicated structure. This creation-race path skipped
        // that check entirely — a dead-heat race could silently fuse two whole-file
        // rewrites of the same module and nobody was told. Now we run the same check:
        // if both inputs parsed but the merged result does not, or if the merge duplicated
        // structure, refuse it — keep both sides intact and announce loudly.
        //
        // A CONFLICTED race is refused the same way (27 Sep 2026). Two different whole files at one
        // point used to reach this check "clean": the old one-range merge3 treated two insertions
        // at the same place as disjoint and CONCATENATED them, and fusionReason caught the result.
        // The real diff3 (d487e0e) reports them as the conflict they are -- and the lines below
        // would then have landed both whole files, with markers, in the room's copy. HIV-P17's
        // answer to a creation race of CODE that cannot merge is to land nothing; that holds
        // either way. Same scope as the parse check: a file with no language (Markdown) is not
        // refused, and keeps both versions visibly, with markers, as any other conflict does.
        {
          const why = creationRaceVerdict(r0, disk, docText, relPath)
          if (why) {
            refuseCreationRace(relPath, why, disk, docText)
            return
          }
        }
        if (r0.text !== docText) { fe.doc.transact(() => { applyDiff(yt, r0.text); if (!FORK_GATE) recordIntent(relPath, fe, docText, r0.text) }); signPublished(relPath, docText, r0.text, disk) }
        if (r0.text !== disk) writeToDisk(relPath, r0.text)
        if (r0.conflict) conflicted.add(relPath)
        bases.set(relPath, r0.text); forkBases.set(relPath, r0.text); shadow.set(relPath, r0.text)
        if (!inManifest(relPath)) queueManifestSet(relPath)
        try { postOnce(`race:${relPath}`, `⚠ ${relPath} was created by two participants at once — both versions were merged${r0.conflict ? ', and CONFLICT markers need resolving' : ''}.`, { ttlMs: 10 * 60 * 1000 }) } catch { }
        return
      }
      // REJOIN, NOT A FIRST JOIN. If a previous session of this client wrote this file in
      // this room, we DO have a common ancestor and the adopt below is simply wrong: the
      // local copy may be newer than the room's (edited while disconnected, or the room
      // came back stale). This is the data-loss case that was seen live.
      let anc = priorShadow.get(relPath)
      // An edit THIS session made through the medium before the file had synced has a known ancestor:
      // the disk text it replaced (0.14.3 P0-1b). Without it, a fresh folder's first contact had no
      // ancestor, refused to publish the edit, and a later merge wrote the room's copy back over it.
      // ONLY when the room held that text (Claude-cloud's review R1): a folder carrying a local change L
      // the room never saw, edited before sync, would otherwise merge with ancestor L, read the room as
      // "removed L", and delete L from disk and room. Not proven held -> no ancestor -> the frozen keep.
      let preSync = false
      // An edit made with the agent's OWN file tool before the file synced left no record (only hive_edit
      // writes one), so first contact had no ancestor and froze it as a kept, unsent edit (P0-1b-R3).
      // What the disk held when the file opened is that ancestor, under the same rule: only if the room
      // provably held it.
      if (anc === undefined && !preSyncBase.has(relPath) && typeof fe.diskAtOpen === 'string' && disk !== null && fe.diskAtOpen !== disk) {
        preSyncBase.set(relPath, fe.diskAtOpen)
      }
      if (anc === undefined && preSyncBase.has(relPath)) {
        const pre = preSyncBase.get(relPath)
        const held = accountFor({ rel: relPath, branchText: pre, roomText: docText, receipts: fe.ledger ? fe.ledger.toArray() : [] }).state
        if (held === DESCENDS || held === IDENTICAL) { anc = pre; preSync = true }
      }
      preSyncBase.delete(relPath)
      // ...unless the room never got it. Capturing a local edit moves the ancestor to the edited
      // bytes BEFORE the relay accepts them. A write held behind someone else's claim
      // (HIVE_ENFORCE_CLAIMS=queue) is discarded when its writer disconnects, so on rejoin
      // disk === ancestor while the room still has the old copy, and adopting it deleted the edit
      // from the room AND from disk, silently (26 Oct). Signed receipts say whether the room ever
      // held these bytes; with none (provenance off) the old behaviour stands. When it never did,
      // the real ancestor is what the edit was made against, and the merge below re-sends it.
      let unsent = false
      const rcpts = fe.ledger ? fe.ledger.toArray() : []
      if (anc !== undefined && disk !== null && disk === anc &&
          accountFor({ rel: relPath, branchText: disk, roomText: docText, receipts: rcpts }).state === DIVERGED) {
        unsent = true
        // The newest base the room provably held. An older true ancestor merges safely; a newer
        // one the room never had (an earlier held edit) would read our own edit as the room
        // deleting it.
        const hist = priorFrom.get(relPath) || []
        let from
        for (let i = hist.length - 1; i >= 0 && from === undefined; i--) {
          const st = accountFor({ rel: relPath, branchText: hist[i], roomText: docText, receipts: rcpts }).state
          if (st === DESCENDS || st === IDENTICAL) from = hist[i]
        }
        if (from === undefined || from === disk) { keepUnsent(relPath, disk, docText); return }
        anc = from
      }
      if (anc !== undefined && disk !== null) {
        if (disk === anc) {
          // Local is exactly what we last wrote — nobody touched it while we were away, so
          // the room's copy is strictly newer and adopting it loses nothing.
          writeToDisk(relPath, docText)
          bases.set(relPath, docText); forkBases.set(relPath, docText)
          return
        }
        // Divergent AND we know the ancestor: merge the two, do not pick a winner. Snapshot
        // the local side first so the pre-merge bytes are recoverable regardless of outcome.
        captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy before rejoin merge' })
        const rj = icrMerge3(anc, disk, docText, relPath)
        if (rj.text !== docText) { fe.doc.transact(() => { applyDiff(yt, rj.text); if (!FORK_GATE) recordIntent(relPath, fe, docText, rj.text) }); signPublished(relPath, docText, rj.text, disk) }
        if (rj.text !== disk) writeToDisk(relPath, rj.text)
        if (rj.conflict) conflicted.add(relPath)
        bases.set(relPath, rj.text); forkBases.set(relPath, rj.text); shadow.set(relPath, rj.text)
        if (!inManifest(relPath)) queueManifestSet(relPath)
        try {
          say(unsent
            ? `⚠ ${relPath}: ${name}'s last edit never reached the room — it was held while someone else had the file, and ${name}'s connection dropped. ` +
              `It has been sent again, merged with the room's copy${rj.conflict ? ', and CONFLICT markers need resolving' : ''}; if the file is still claimed, it waits for the release. Pre-merge local copy is in the file's history.`
            : preSync
              ? `${relPath}: ${name} edited it before the room's copy had loaded here — the edit was merged with the room's copy and sent${rj.conflict ? ', and CONFLICT markers need resolving' : ''}. Pre-merge local copy is in the file's history.`
              : `⚠ ${relPath} changed locally while ${name} was disconnected — the local edit and the room copy were merged${rj.conflict ? ', and CONFLICT markers need resolving' : ''}. Pre-merge local copy is in the file's history.`)
        } catch { }
        return
      }
      // Genuinely no ancestor (a clone-then-join, or joining with an existing checkout).
      // HIV-P9: Do NOT adopt the room's copy blindly. Check provenance!
      // Has the room ever seen what is currently on disk?
      const receipts = fe && fe.ledger ? fe.ledger.toArray() : []
      const st = accountFor({ rel: relPath, branchText: disk, roomText: docText, receipts })

      if (st.state === DESCENDS || st.state === IDENTICAL) {
        // Safe: The room has passed through our disk content, so the room's copy is a true descendant.
        captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy at join (room copy adopted)' })
        writeToDisk(relPath, docText)
        bases.set(relPath, docText); forkBases.set(relPath, docText)
        // Past the `disk === docText` return above, IDENTICAL can only mean the line endings differ.
        log(`[${name}] ↓ ${relPath} already existed in this room (${st.state}) — adopted the room's copy; the local version is in the file's history`)
        noteFirstContact(st.state === IDENTICAL ? 'eol' : 'adopted', relPath)
        return
      }

      // DIVERGED or UNPROVEN: The room has NEVER seen local disk's content, or has no proof.
      // Overwriting disk with docText would cause silent data loss (e.g. wiping out local fixes).
      // Merging from an empty base would concatenate both copies, creating invalid syntax.
      // Refuse adoption: keep local disk untouched, keep room doc untouched, snapshot local, and announce loudly.
      captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: `local copy preserved at join (${st.state}: room copy refused)` })
      bases.set(relPath, disk); forkBases.set(relPath, disk)
      // FROZEN, not merely kept (0.14.3 P0-1b). With bases = the local copy and nothing else, the NEXT
      // reconcile of this file (the watcher seeing the agent's own write, the scan, any remote change)
      // merged (base local, ours local, theirs room) = the room's copy, wrote it over the local edit
      // and told the room "kept the changes that landed in between (nothing lost)": the edit was gone
      // from the room AND the disk (5 of 8 poll runs on 0.14.2, tests/diag/presync-edit-race.mjs;
      // traced by Claude-cloud). Frozen like a kept unsent edit: nothing syncs for this file until its
      // author saves it again, and that save replaces the room's copy. The worst case is now "kept,
      // and said", never "lost".
      let keptAt = 0; try { keptAt = fs.statSync(full).mtimeMs } catch { }
      keptUnsent.set(relPath, keptAt)
      // Said in the room (review R5: the agent has to act on it), but ONCE PER JOIN, in the first-contact
      // summary below -- not one line per file in engine words. A teammate rejoining with 40 such files
      // filled the chat with 40 lines (9 Nov 2026; first-contact-summary-test, red since 0.14.3).
      log(`[${name}] ⚠ ${relPath} already existed in room with different content (${st.state}) — room copy was NOT adopted; local disk preserved and frozen until saved again`)
      noteFirstContact('kept', relPath)
      return
    }
    // DEAD-HEAT GENESIS COLLISION DETECTION & RESOLUTION.
    // When two peers publish to an empty document at genesis concurrently before either
    // sees the other, both set bases to their own genesis text. When the remote update
    // lands, bases.has(relPath) is true on both peers, so neither enters the first-contact
    // creation race branch above. The CRDT unions both inserts. Normal diff3 merge against
    // base === disk accepts docText (the union), and fusionReason is blinded because 'theirs'
    // is already the invalid union. Both peers silently write the broken union to disk.
    //
    // Detection (bounded): only runs for files THIS client genesis-published this session,
    // on remote reconciles before anything writes to disk, and at most once per file.
    if (origin === 'remote' && genesisPublished.has(relPath) && !deadHeatResolved.has(relPath)) {
      const allGenesisClients = new Set()
      const liveGenesisClients = new Set()
      const liveTexts = new Map()

      let it = fe.text._start
      while (it) {
        if (it.origin === null && it.rightOrigin === null) {
          allGenesisClients.add(it.id.client)
          if (!it.deleted) liveGenesisClients.add(it.id.client)
        }
        if (!it.deleted) {
          const c = it.id.client
          const s = typeof it.content?.str === 'string'
            ? it.content.str
            : (Array.isArray(it.content?.getContent?.()) ? it.content.getContent().join('') : '')
          liveTexts.set(c, (liveTexts.get(c) || '') + s)
        }
        it = it.right
      }

      if (liveGenesisClients.size >= 2) {
        deadHeatResolved.add(relPath)
        const { winner: winnerClient, winnerText, why } =
          deadHeatVerdict(new Map([...liveGenesisClients].map((c) => [c, liveTexts.get(c) || ''])), relPath)
        // DISJOINT = LEAVE THE UNION ALONE. The CRDT union already holds every author's work.
        if (why) {
          // Conflicting or fused: the room keeps ONE whole file, the winner's; the losers keep theirs on disk.
          fe.doc.transact(() => applyDiff(fe.text, winnerText))
          if (fe.doc.clientID === winnerClient || disk === winnerText) {
            // The winner's disk already holds winnerText. Nothing to write, nothing to refuse, and not
            // marked conflicted: its next clean edit would otherwise announce a "resolved" conflict.
            bases.set(relPath, winnerText); forkBases.set(relPath, winnerText); shadow.set(relPath, winnerText)
            if (!inManifest(relPath)) queueManifestSet(relPath)
            log(`[${name}] HIV-P17 creation-race dead heat resolved: kept local genesis as winner for ${relPath}`)
            return
          }
          refuseCreationRace(relPath, why, disk, winnerText)
          return
        }
      } else if (allGenesisClients.size >= 2 && allGenesisClients.has(fe.doc.clientID) && disk !== docText) {
        // The winner resolved before this client reconciled: this client's genesis item is already deleted.
        const why = creationRaceVerdict(icrMerge3('', endNl(disk), endNl(docText), relPath), disk, docText, relPath)
        if (why) {
          deadHeatResolved.add(relPath)
          refuseCreationRace(relPath, why, disk, docText)
          return
        }
      }
    }
    const base = bases.has(relPath) ? bases.get(relPath) : disk
    // A save that waited out a race (F5) was made from what this disk held then -- the last synced text --
    // not from the resolution that has landed since: merge it from there, and never read the markers it
    // never saw as resolved by it.
    const deferred = origin === 'local' && fe.deferredMerge
    const fork = deferred ? base : forkBases.has(relPath) ? forkBases.get(relPath) : base
    if (origin === 'local') { noteCoEditing(relPath); markEditing(relPath) } // broadcast activity + warn if someone else is on this file

    let res, reAdded = false
    if (origin === 'local' && !deferred && hasConflictMarkers(docText) && !hasConflictMarkers(disk)) {
      // Resolving a conflict: the doc still has <<<<<<< markers and this local
      // write removed them — the author has resolved it. Their clean version wins.
      res = { text: disk, conflict: false }
    } else if (origin === 'local') {
      noteIfRewrite(relPath, fork, disk)
      // Check if this write is an intentional clean rewrite
      const sc = summarizeChange(fork, disk)
      const isCleanRewrite = sc.isRewrite && supports(relPath) && languageFor(relPath).parses(disk)

      // Merge a local edit against the FORK POINT (what this author
      // last saw), not the latest doc. If the doc gained lines since the fork
      // that this write does NOT contain, the author was working from a stale
      // copy — merging against the fork re-adds those lines (disjoint) or raises
      // a conflict (overlap) instead of silently deleting another's work.
      const theirsNew = changedRange(fork.split('\n'), docText.split('\n')).newLines.filter((l) => l.length)
      const mineLines = new Set(disk.split('\n'))
      const integrated = theirsNew.every((l) => mineLines.has(l)) // this write already contains the remote change
      if (integrated || (isCleanRewrite && !hasConflictMarkers(docText))) {
        res = { text: disk, conflict: false } // author built on the latest or cleanly rewrote — trust it
      } else {
        res = icrMerge3(fork, disk, docText, relPath)
        reAdded = !res.conflict && res.text !== disk && res.text !== docText // we restored remote lines a stale write had dropped
        // ...and when the merge gives back exactly the room's copy, the local edit did NOT survive:
        // never call that "nothing lost" (review R2). Keep the local copy and say so.
        if (!res.conflict && res.text === docText && disk !== docText) {
          captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy replaced by the room\'s copy in a merge' })
          try { say(`⚠ ${relPath}: ${name}'s local change did not survive the merge with the room's copy (the room's version was taken). ${name}'s copy is in the file's history.`) } catch { }
        }
        // OPEN (1 Nov 2026): a clean handover onto the same lines still shows markers. Four rounds of
        // rules that decided it from the texts (a claim-time fork, who-holds-it, line counts, shared
        // tokens) each silently deleted someone's work in a case antigravity-3 then built: from the
        // four texts, "B replaced A's change" and "B wrote from a copy that predates it" can be
        // identical. Markers lose nothing; a wrong guess does. The sound fix needs the agent to say
        // which version it edited (hive_edit carrying its base), so nothing here guesses.
      }
    } else {
      res = icrMerge3(base, disk, docText, relPath) // incoming remote change merged into our working copy
    }

    // FUSION GUARD (HIV-26). A merge must never produce something NEITHER author wrote.
    //
    // On 18 Sep 2026 three peers wrote the same file within about a second of each other and
    // the character-CRDT UNIONED the versions instead of converging: sync.js went 144,144 ->
    // 291,750 bytes, `const MAX_OPEN` appeared three times, and the splice landed mid-token
    // (`evicted// Newly opened...`). There were NO conflict markers, every peer converged on
    // the corruption — so agreement proved nothing — and the only thing that caught it was a
    // parse failure at the handoff gate, by which point it had already reached every folder.
    //
    // Two cheap signals, each catching what the other misses:
    //   - the merge BROKE a file both sides could parse. Definitionally wrong: whatever that
    //     output is, neither author wrote it.
    //   - the result is about as long as both sides put together. That is concatenation in a
    //     merge's clothing, and it catches a fusion that happens to still parse.
    //
    // We land NOTHING. Not a conflict block either: this engine deliberately keeps markers
    // out of the shared text, because writing them into the very layer that fuses is what
    // produced marker-fusion before. So the doc keeps its version, disk keeps its version,
    // both are still intact and recoverable, and the room is TOLD. A file left visibly
    // divergent is a bad day; a file silently fused is an unrecoverable one.
    if (res && !res.conflict) {
      const why = fusionReason(res.text, disk, docText, supports(relPath) ? languageFor(relPath) : null)
      if (why) {
        conflicted.add(relPath)
        if (icrWarned.get(relPath) !== why) {
          icrWarned.set(relPath, why)
          log(`[${name}] !! REFUSED a fused merge of ${relPath}: ${why}`)
          try {
            say(`[!] @all ${relPath}: a merge was REFUSED because it fused rather than merged — ${why}. Nothing was written: the room's copy and ${name}'s local copy are both intact and unchanged. Someone must reconcile them deliberately: a plain file write, or hive_edit with content, merges against the other version again.`)
          } catch { /* the log still carries it */ }
        }
        return
      }
    }

    // Snapshot the state JUST BEFORE this author's edit lands, attributed to them —
    // captured only on local origin so each change is recorded once, by its author.
    if (origin === 'local' && res.text !== docText) {
      let hasBase = false
      for (const e of fe.snap.values()) {
        if (e.kind === 'base') { hasBase = true; break }
      }
      if (!hasBase) {
        const createTs = fileCreationTs(fe, relPath)
        captureSnapshot(relPath, docText, name, { force: true, kind: 'base', label: 'created', ts: createTs })
      }
      const sc = summarizeChange(docText, res.text)
      captureSnapshot(relPath, docText, name, { force: sc.isRewrite, churn: `${sc.changedLines}/${sc.totalLines} lines` })
      lastLocalEdit = relPath
    }
    // The save's INTENT travels in the same transaction as its characters (P0-F): what it changed, and
    // from which text, so a peer that receives two saves of one line made from the same text can tell.
    fileDocs.get(relPath).doc.transact(() => { applyDiff(yt, res.text); if (!FORK_GATE && res.text !== docText) recordIntent(relPath, fe, docText, res.text, disk) })
    // Sign this landed local change into the file's provenance ledger (I1). Stamp the
    // author's TRUE intent — the state THEY edited from (fork) -> the content THEY wrote
    // (disk) — NOT the live shared text, which under truly-concurrent edits is already
    // fusing. Recording (fork, disk) keeps every concurrent same-line edit anchored to the
    // SAME clean parent, so the fork stays detectable no matter how the char-CRDT fuses.
    if (origin === 'local') {
      if (res.text !== docText) bumpAttestVersion(relPath, res.text)
      // Gate ON: the author's INTENT was already captured at the source (captureLocal, top
      // of this pass) — here we only advance the authority head to the landed content.
      // Gate OFF (default): the proven landed-transition stamp, unchanged.
      if (FORK_GATE) { if (res.text !== docText) { signPublished(relPath, docText, res.text, disk); attestHead(relPath, res.text, docText) } }
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
      try { postOnce(`conflict:${relPath}`, `⚠ MERGE CONFLICT in ${relPath} — it has <<<<<<< markers. Whoever owns it: resolve before continuing, by saving the file without them or by passing the marked block as old to hive_edit old/new.`, { observer: !res.conflict, clear: `resolved:${relPath}` }) } catch { }
    } else if (!hasMarkers && conflicted.has(relPath)) {
      conflicted.delete(relPath)
      try { postOnce(`resolved:${relPath}`, `✓ conflict in ${relPath} resolved.`, { observer: origin !== 'local', clear: `conflict:${relPath}` }) } catch { }
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
      try { postOnce(`icr:${relPath}:${contentHash(String(res.icrWarning)).slice(0, 16)}`, `⚠ ICR flag in ${relPath}: ${res.icrWarning}. It merged, but review — this is a break a plain merge can't see.`, { observer: origin !== 'local' }) } catch { }
    } else if (!res.icrWarning && icrWarned.has(relPath)) {
      icrWarned.delete(relPath)
    }

    // Health gate on the live path: after the char-CRDT has converged, check whether the
    // current content is a SILENT FORK (a fusion nobody authored). If so, record it (the
    // record is rendered to disk locally — never written back into the shared text).
    detectFork(relPath)
  }

  const fmtTime = (d = Date.now()) => new Date(d).toTimeString().slice(0, 8)
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
  let renderBoardTimer = null
  function renderBoardSoon() {
    if (stopped) return
    if (!renderBoardTimer) {
      renderBoardTimer = setImmediate(() => {
        renderBoardTimer = null
        renderBoard()
        linkMemory()
      })
    }
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
  if (syncFiles) board.observe(renderBoardSoon)

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
  const snapId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

  function pruneMeta() {
    if (historyMeta.size <= META_KEEP) return
    const all = [...historyMeta.values()].filter((e) => e.kind === 'auto').sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const overflow = historyMeta.size - META_KEEP
    if (overflow <= 0) return
    doc.transact(() => { for (let i = 0; i < Math.min(overflow, all.length); i++) historyMeta.delete(all[i].id) })
  }

  // Find file creation timestamp from createdTimes, genesis head, provenance ledger, head cur, mtimes, or disk stat.
  function fileCreationTs(fe, relPath) {
    if (createdTimes.has(relPath)) return createdTimes.get(relPath)
    try {
      const g = fe && fe.head ? fe.head.get('genesis') : null
      if (g && typeof g.at === 'number' && !isNaN(g.at)) return g.at
    } catch { }
    try {
      const l0 = fe && fe.ledger && fe.ledger.length > 0 ? fe.ledger.get(0) : null
      if (l0 && typeof l0.at === 'number' && !isNaN(l0.at)) return l0.at
    } catch { }
    try {
      const cur = fe && fe.head ? fe.head.get('cur') : null
      if (cur && typeof cur.at === 'number' && !isNaN(cur.at)) return cur.at
    } catch { }
    if (mtimes.has(relPath)) return mtimes.get(relPath)
    try {
      const full = path.join(ROOT, relPath)
      if (fs.existsSync(full)) return fs.statSync(full).mtimeMs
    } catch { }
    return Date.now()
  }

  // Capture `content` as a restore point for relPath, attributed to `byWho`.
  // kind: 'auto' (an ordinary edit), 'base' (a file's floor), 'manual' (a named
  // checkpoint), 'restore' (the pre-restore state, kept so restore is reversible).
  function captureSnapshot(relPath, content, byWho, { force = false, churn = '', kind = 'auto', label = '', ts = null } = {}) {
    if (content == null) return null
    const fe = fileDocs.get(relPath); if (!fe) return null
    const now = (typeof ts === 'number' && !isNaN(ts)) ? ts : Date.now()
    if (kind === 'auto' && !force && now - (lastSnapAt.get(relPath) || 0) < SNAP_MIN_GAP_MS) return null
    const snap = fe.snap
    let latest = null
    for (const e of snap.values()) if (!latest || (e.ts || 0) > (latest.ts || 0)) latest = e
    if (latest && latest.content === content) return null // identical to the most recent point — nothing to keep
    const id = snapId()
    const at = fmtTime(now)
    const pruned = []
    fe.doc.transact(() => {
      snap.set(id, { id, file: relPath, by: byWho, at, ts: now, content, churn, kind, label })
      const autos = [...snap.values()].filter((e) => e.kind === 'auto').sort((a, b) => (a.ts || 0) - (b.ts || 0))
      for (let i = 0; i < autos.length - SNAP_KEEP; i++) { snap.delete(autos[i].id); pruned.push(autos[i].id) }
    })
    if (kind === 'auto') lastSnapAt.set(relPath, now)
    pendingHistoryMeta.set(id, { op: 'set', record: { id, file: relPath, by: byWho, at, ts: now, churn, kind, label } })
    for (const pid of pruned) pendingHistoryMeta.set(pid, { op: 'delete' })
    scheduleRoomFlush()
    return id
  }

  // Find which file a restore-point id belongs to (via the index, else by scanning
  // open file docs as a fallback).
  function fileOfSnap(id) {
    flushRoomDoc()
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
    if (!best) {
      if (fe.snap.size === 0) {
        const createTs = fileCreationTs(fe, relPath)
        if (typeof ts === 'number' && ts >= createTs) {
          return { ok: true, unchanged: true, file: relPath }
        }
      }
      return { error: 'no restore point at/before that time' }
    }
    return restore(best.id, by)
  }

  // Revert everything an author did since `sinceTs` (default: all of it): for each
  // file they touched, roll back to the state BEFORE their first edit in the window.
  // Honest limitation: this is checkpoint-granular, so if SOMEONE ELSE also edited
  // the same file after that point, their edits in that file are rolled back too.
  // For the dangerous case — an agent rewriting files — that's exactly right.
  function revertAuthor(who, sinceTs = 0, by = name) {
    if (!who) return { error: 'no author given' }
    flushRoomDoc()
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
    flushRoomDoc()
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
  // ONE LINE PER EVENT, NOT ONE PER OBSERVER (0.14.4, C5). Most system lines are said by whoever
  // caused them (a task, a review, a revert): one poster by nature. But an OBSERVED event -- a conflict
  // in a shared file, a client on another build, a divergence -- is detected by every peer's own code,
  // and each posted it: one conflict gave four MERGE CONFLICT lines and then four "resolved" lines
  // (incident I-16, #722-#725); one odd client gave a MIXED BUILDS line from every other (I-8, #822-#823).
  // postOnce(id, text): `id` names the event the same way on every peer. The peer that caused it posts
  // at once. An observer waits 1.5 s plus 1 s per rank among present engines (sorted by name) and posts
  // only if nobody has; the key lives in the room (`sys_events`) and expires. A peer that cannot write
  // the key still posts: a missed alarm hides a conflict, a duplicate is only noise.
  const sysEvents = doc.getMap('sys_events')
  const SYS_TTL_MS = 6 * 3600 * 1000
  const sysTimers = new Set()
  // What only THIS folder needs to know (a local copy kept, a file that differed at join) goes here, to
  // the log and hive_status, and not to the whole room (C5).
  const notices = []
  function note(text) {
    const t = String(text || '')
    if (!t) return
    log(`[${name}] ${t}`)
    notices.push({ at: Date.now(), text: t })
    if (notices.length > 50) notices.shift()
  }
  function sysRank() {
    const names = new Set([name])
    try {
      for (const st of provider.awareness.getStates().values()) {
        const u = st && st.user
        if (u && u.name && !u.listener && !u.passive && u.v === PROTOCOL_VERSION) names.add(u.name)
      }
    } catch { }
    return [...names].sort().indexOf(name)
  }
  function pruneSysEvents(now) {
    let n = 0
    for (const [k, v] of sysEvents.entries()) {
      if (++n > 500) break
      if (!v || now - (Number(v.at) || 0) > (Number(v.ttl) || SYS_TTL_MS)) sysEvents.delete(k)
    }
  }
  function postOnce(id, text, { observer = false, ttlMs = SYS_TTL_MS, clear = null } = {}) {
    if (!text) return null
    if (observer && (passive || listener)) return null // a client nobody waits on never speaks for the room
    const fire = () => {
      try {
        const prev = sysEvents.get(id)
        if (prev && Date.now() - (Number(prev.at) || 0) < (Number(prev.ttl) || SYS_TTL_MS)) return false
        doc.transact(() => {
          sysEvents.set(id, { by: name, at: Date.now(), ttl: ttlMs })
          if (clear) for (const c of [].concat(clear)) sysEvents.delete(c)
          pruneSysEvents(Date.now())
        })
      } catch { /* fail open: the line is said even if the key could not be written */ }
      say(text)
      return true
    }
    if (!observer) return fire()
    const t = setTimeout(() => { sysTimers.delete(t); if (!stopped) { try { fire() } catch { } } }, 1500 + 1000 * Math.max(0, sysRank()))
    sysTimers.add(t)
    return null
  }
  function renderChat() {
    const out = [
      '# Hive Chat — the live coordination channel for everyone in this room.',
      '# Humans and AI agents talk here. Agents: READ this before/while working,',
      '# and announce what you are about to do (e.g. "taking auth.js: add login").',
      '',
    ]
    for (const m of chat.toArray()) out.push(`- ${formatTime(m.at)}  ${m.by} (${m.kind}): ${m.text}`)
    writeToDisk(CHAT_FILE, out.join('\n') + '\n')
  }
  // Hand the room's history to the memory add-on, when present, whenever it changes, so this ROOM has a memory: an
  // agent joining tomorrow can ask what was decided here last week, including in
  // conversations it was never present for.
  //
  // Called from the writers rather than once at join, because at join these files do not
  // exist yet -- a room only has a history after something happens in it. linkRoom()
  // compares before it writes, so calling it per message costs four stat() calls and no
  // disk write, and the relay watcher never sees needless churn.
  let memoryLinked = false
  let lastLinkedFilesCount = 0
  function linkMemory() {
    if (!syncFiles) return
    let count = 0
    for (const f of ['HIVE_CHAT.md', 'HIVE_BOARD.md', 'HIVE_TASKS.md', 'HIVE_MEMBERS.md']) {
      try { if (fs.existsSync(path.join(ROOT, f))) count++ } catch { }
    }
    if (count === 0 || (memoryLinked && count === lastLinkedFilesCount)) return
    if (!grmLink) return
    const r = grmLink.linkRoom(ROOT, memoryLinked ? () => {} : log) // announce once, not per message
    if (r.linked) {
      memoryLinked = true
      lastLinkedFilesCount = (r.files && r.files.length) || count
    }
  }

  if (syncFiles) chat.observe(() => { renderChat(); linkMemory() })

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

  const getMemberNames = () => {
    const names = new Set()
    if (provider && provider.awareness) {
      for (const s of provider.awareness.getStates().values()) {
        const u = s && s.user
        if (u && u.name) names.add(u.name)
      }
    }
    // Union with durable activity map (non-gone keys)
    try {
      const act = doc.getMap('activity')
      if (act) {
        for (const [k, v] of act.entries()) {
          if (v && !v.gone && k) names.add(k)
        }
      }
    } catch { }
    // Union with recent chat senders
    try {
      const chatArr = doc.getArray('chat')
      if (chatArr) {
        for (const msg of chatArr.toArray()) {
          if (msg && msg.by) names.add(msg.by)
        }
      }
    } catch { }
    names.add(name)
    return [...names]
  }

  function assign(to, text) {
    if (!to || !text) return null
    const normTo = String(to).trim() === '@all' ? 'all' : String(to).trim()
    const id = newId()
    const ownerOf = owners.get(normTo)
    // auto-accept when it's AI->AI coordination, the target has no owner to ask,
    // or the asker IS the target's owner, or an @all task.
    const auto = kind === 'ai' || !ownerOf || name === ownerOf || normTo === 'all'
    const status = auto ? 'accepted' : 'pending'
    const decidedBy = auto ? (kind === 'ai' ? `${name} (AI coordination)` : name) : null
    const membersAt = getMemberNames()
    tasks.set(id, { id, to: normTo, by: name, byKind: kind, text: String(text), status, decidedBy, at: fmtTime(), membersAt, createdAt: Date.now() })
    if (auto) say(`@${normTo}: ${text}  (task ${id} — ${kind === 'ai' ? 'AI coordination, proceeding' : 'from owner, proceeding'})`)
    else say(`@${normTo}: ${text}  (task ${id} — ${ownerOf} must approve: do it or ignore?)`)
    return id
  }
  // A decision is about a task that is WAITING for one. Approving an accepted or done task used to
  // rewrite it to 'accepted', which hands finished work straight back to the agent to do again.
  // 'denied' stays decidable: an owner may change their mind.
  function decide(id, accept, by = name) {
    const t = tasks.get(id)
    if (!t) return { error: 'no such task' }
    const ownerOf = owners.get(t.to)
    if (ownerOf && by !== ownerOf) return { error: `only ${ownerOf} (owner of ${t.to}) can approve task ${id}` }
    if (t.status !== 'pending' && t.status !== 'denied') return { error: `task ${id} is ${t.status}, not waiting for a decision` }
    tasks.set(id, { ...t, status: accept ? 'accepted' : 'denied', decidedBy: by })
    // An approval NAMES the agent (4 Oct 2026). An agent waiting between turns is woken by its
    // listener, and the listener wakes on @Name, so an approval that named nobody left the agent
    // asleep on work it had just been cleared to do. The same line is in control.html and the extension.
    say(`${accept ? `@${t.to} ` : ''}task ${id} ${accept ? 'APPROVED' : 'denied'} by ${by}: "${t.text}"`)
    return { ok: true }
  }
  // Only the ASSIGNEE finishes a task, and only work it was cleared to do.
  // For @all tasks (Claude addition iii), any member can complete it provided they
  // were in the room when the task was created, or hold a claim / signed receipt / review on the work.
  function complete(id, note = '') {
    const t = tasks.get(id); if (!t) return { error: 'no such task' }
    const isAll = t.to === 'all' || t.to === '@all'
    if (!isAll && t.to !== name) return { error: `task ${id} is ${t.to}'s -- only ${t.to} can complete it` }
    if (t.status === 'done') return { ok: true, already: true }
    if (t.status !== 'accepted') return { error: `task ${id} is ${t.status}: only accepted work can be completed${t.status === 'pending' ? ` (it is waiting for ${owners.get(t.to) || 'its owner'} to approve)` : ''}` }

    if (isAll) {
      const wasPresent = Array.isArray(t.membersAt) ? t.membersAt.includes(name) : (t.by === name)
      const hasClaim = coordinator ? coordinator.board().some((c) => c && c.by === name) : false
      let hasReceipt = false
      for (const e of fileDocs.values()) {
        if (e && e.ledger) {
          const rs = e.ledger.toArray()
          if (rs.some((r) => r && (r.name === name || (identity && r.author === identity.id)))) {
            hasReceipt = true
            break
          }
        }
      }
      let hasReview = false
      try {
        for (const r of getReviews('')) {
          if (r && r.by === name) { hasReview = true; break }
        }
        if (!hasReview) {
          for (const [k, r] of reviews.entries()) {
            if (r && r.by === name) { hasReview = true; break }
          }
        }
      } catch { }
      if (!wasPresent && !hasClaim && !hasReceipt && !hasReview) {
        return { error: 'Refused: completing an @all task requires having been in the room when it was created, or having a claim/receipt/review on the work' }
      }
    }

    tasks.set(id, { ...t, status: 'done', completedBy: name, decidedBy: t.decidedBy })
    say(`task ${id} done by ${name}${note ? ': ' + note : ''}`)
    return { ok: true }
  }
  const myTasks = () => [...tasks.values()].filter((t) => t.to === name || t.to === 'all' || t.to === '@all')

  /**
   * Room review: record a non-writer review verdict on files in the room.
   * Stored in Y.Map 'reviews' as an append-only list per file: [{ by, at, verdict, note, hash }].
   */
  async function review(files, verdict, note = '') {
    if (!Array.isArray(files) || files.length === 0) {
      return { error: 'files must be a non-empty array' }
    }
    const v = String(verdict || '').toLowerCase()
    if (v !== 'pass' && v !== 'fail') {
      return { error: "verdict must be 'pass' or 'fail'" }
    }

    // 1. Validate manifest presence (Claude addition i)
    for (const rel of files) {
      if (!inManifest(rel)) {
        return { error: `Refused: ${rel} is not in room manifest` }
      }
    }

    // Ensure all target files are synced
    for (const rel of files) {
      const fe = openFile(rel)
      if (!fe.synced && fe.provider) {
        await new Promise((res) => {
          const t = setTimeout(res, 3000)
          fe.provider.on('sync', (isSynced) => {
            if (isSynced) {
              clearTimeout(t)
              res()
            }
          })
        })
      }
      if (!fe.synced) {
        return { error: `Refused: ${rel} has not finished syncing yet` }
      }
    }

    // 2. Validate non-contributor status
    for (const rel of files) {
      const fe = openFile(rel)
      const curText = fe.text ? fe.text.toString() : ''
      const rs = fe.ledger ? fe.ledger.toArray() : []
      const authors = authorsOf(rs, verifyReceipt, curText)
      const isContributor = authors.contributors.some(
        (c) => c && (c.name === name || (identity && c.author === identity.id))
      )
      const head = fe.head ? fe.head.get('cur') : null
      const isHeadLander = head && head.by === name && head.hash === contentHash(curText)
      const boardEntry = board.get(rel)
      const isBoardAuthor = boardEntry && boardEntry.by === name
      const claimEntry = coordinator.sense(rel)
      const isClaimant = claimEntry && claimEntry.by === name
      if (isContributor || isHeadLander || isBoardAuthor || isClaimant) {
        return { error: `Refused: @${name} contributed to ${rel}'s held content; review must come from a non-contributor` }
      }
    }

    // 3. Record review on each file
    const stamp = fmtTime()
    for (const rel of files) {
      const fe = openFile(rel)
      const curText = fe.text ? fe.text.toString() : ''
      const h = contentHash(curText)
      const entry = {
        file: rel,
        by: name,
        at: stamp,
        ts: Date.now(),
        verdict: v,
        note: String(note || ''),
        hash: h,
      }
      // ONLY per-review key to prevent concurrent clobbers under LWW
      reviews.set(`${rel}::${entry.ts}::${newId()}`, entry)
    }

    say(`review ${v.toUpperCase()} on ${files.join(', ')} by ${name}${note ? ': ' + note : ''}`)
    return { ok: true, files, verdict: v }
  }

  function getReviews(relPath) {
    const mapEntries = []
    const prefix = relPath ? relPath + '::' : ''
    for (const [k, r] of reviews.entries()) {
      if (relPath && k === relPath && Array.isArray(r)) {
        for (const item of r) if (item && typeof item === 'object') mapEntries.push(item)
      } else if (r && (!relPath || r.file === relPath || k.startsWith(prefix))) {
        mapEntries.push(r)
      }
    }
    const seen = new Set()
    const unique = []
    for (const r of mapEntries) {
      const key = `${r.file}|${r.by}|${r.ts}|${r.hash}|${r.verdict}`
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(r)
      }
    }
    return unique.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  }

  function getReviewStatus(relPath) {
    const fe = openFile(relPath)
    const curText = fe.text ? fe.text.toString() : ''
    const curHash = contentHash(curText)
    const all = getReviews(relPath)

    // Ignore reviews authored by contributors to the current held content
    const rs = fe.ledger ? fe.ledger.toArray() : []
    const authors = authorsOf(rs, verifyReceipt, curText)
    const contributorNames = new Set(authors.contributors.map((c) => c.name).filter(Boolean))
    const head = fe.head ? fe.head.get('cur') : null
    if (head && head.by && head.hash === curHash) contributorNames.add(head.by)

    const validReviews = all.filter((r) => r && !contributorNames.has(r.by))
    const matching = validReviews.filter((r) => r.hash === curHash)
    if (!matching.length) {
      return { verdict: 'unreviewed', hash: curHash, stale: validReviews.length > 0, reviews: validReviews }
    }
    let lastFail = -1
    let lastPass = -1
    for (let i = 0; i < matching.length; i++) {
      if (matching[i].verdict === 'fail') lastFail = i
      if (matching[i].verdict === 'pass') lastPass = i
    }
    const finalVerdict = (lastPass > lastFail) ? 'pass' : 'fail'
    return { verdict: finalVerdict, hash: curHash, stale: false, reviews: matching }
  }

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
  let myEditing = null, myLastEdit = null
  let editingClearTimer = null
  const warnedAt = new Map() // file -> last time we warned about co-editing it
  const setUserState = () => provider.awareness.setLocalStateField('user', { name, kind, owner: owner || undefined, editing: myEditing || undefined, lastEdit: myLastEdit || undefined, v: PROTOCOL_VERSION, hv: VERSION_LABEL, passive: !!passive, listener: listener || undefined, app: app || undefined, iid: IID, joined: joinedAt })
  function markEditing(relPath) {
    myEditing = { file: relPath, at: Date.now() }
    myLastEdit = myEditing
    setUserState()
    if (editingClearTimer) clearTimeout(editingClearTimer)
    // `editing` still goes NULL at the boundary, exactly as before -- every consumer of it
    // (coEditors, HIVE_MEMBERS.md) keeps its old semantics, and the "editing" label stays
    // event-driven rather than clock-driven. `lastEdit` is purely ADDITIVE and never
    // cleared, so a panel can say "last edit 40s ago" instead of "idle". Deriving the
    // label from a timestamp instead broke hive-activity-test.js: the members file is only
    // rewritten on an event, so a render landing just before the boundary froze forever.
    editingClearTimer = setTimeout(() => { myEditing = null; setUserState() }, EDIT_FRESH_MS)
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
      try { postOnce(`coedit:${relPath}:${[name, ...others].sort().join(',')}`, `⚠ heads-up: ${name} is also editing ${relPath} (with ${others.join(', ')}). Small patches auto-merge; coordinate before a full rewrite.`, { ttlMs: 10 * 60 * 1000 }) } catch { } // the one who just started editing is the cause: it says it at once
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
  /** The claim map as a file. Same contract as renderMembers: generated locally, never synced.
   *
   *  EXPIRY IS SHOWN, NOT HIDDEN. A claim whose TTL has run out is not a lock any more — the
   *  region is free — so rendering it as "held" would make agents queue behind a crashed peer,
   *  which is the deadlock TTLs exist to prevent. Expired rows stay visible but labelled, because
   *  "AgentX died holding this" is information, and silently dropping the row loses it. */
  function renderClaims() {
    const now = Date.now()
    const rows = []
    claims.forEach((c, region) => {
      if (!c || !c.by) return
      const ttl = Number(c.ttl) || 0
      const age = now - (Number(c.at) || 0)
      const left = ttl - age
      rows.push({ region, by: c.by, intent: c.intent || 'edit', age, left, dead: left <= 0 })
    })
    rows.sort((a, b) => a.region.localeCompare(b.region))

    const secs = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`
    const live = rows.filter((r) => !r.dead)
    const out = [
      '# Hive Claims — who holds which file right now (live).',
      '# SENSE this before you edit. A region held by someone else is not yours to write:',
      '# flow to open work instead of waiting. Claims expire on their own, so nothing deadlocks.',
      '',
      `held: ${live.length}`,
      '',
    ]
    for (const r of rows) {
      out.push(r.dead
        ? `- ${r.region} — EXPIRED (was ${r.by}, ${r.intent}, ${secs(r.age)} ago) — free to take`
        : `- ${r.region} — ${r.by} (${r.intent}) — held ${secs(r.age)}, ${secs(r.left)} left`)
    }
    if (!rows.length) out.push('- nothing claimed; every region is open')
    writeToDisk(CLAIMS_FILE, out.join('\n') + '\n')
  }
  if (syncFiles) claims.observe(() => renderClaims())

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
      try { postOnce(`proto:${u.name}:${u.v || '-'}`, `⚠ ${u.name} is on an incompatible version — files won't sync with them until everyone updates Hivecode.`, { observer: true }) } catch { }
    }
    checkBuilds()
  }
  // MIXED BUILDS, SEEN BY THE ROOM ITSELF (29 Sep 2026). The same protocol does not mean the same
  // engine: two builds that merge differently corrupt each other's files with every write green.
  // Until now the only detector was each agent remembering to say "joined on hivecode X". Every
  // engine client now carries its build in presence (hv), so the room can see a mismatch without
  // anyone announcing it. Rules, each against a false alarm:
  //   - only clients that report a build are compared, EXCEPT an AI on this protocol reporting none:
  //     that is an engine older than build reporting, the rollout case, and it cannot warn itself
  //   - humans are not flagged: the extension and the browser panel carry no engine build
  //   - one side of each pair speaks (the name that sorts first), once per build it sees
  const buildWarned = new Set()
  // ONE ALARM PER ROOM, AND ONLY FOR ANOTHER RELEASE (0.14.4, C5). The rule used to be "one side of
  // each pair speaks", which is still one line per PAIR: two clients on 0.14.2 each posted about the one
  // on 0.14.3 (#822 + #823), and a client on the same release from another commit raised the same alarm
  // (I-8). Now the event is the set of releases in the room: it is said once, by whoever sees it first,
  // naming who runs what. The same release from another commit is a note for this folder (hive_status).
  function checkBuilds() {
    // Per CONNECTION, not per name: one participant with two engines open on different builds is its own
    // alarm (0.14.3 Q-2: "an older connection is still open"), and a map keyed by name would hide it.
    const labelsOf = new Map() // name -> Set of what its engines run
    const add = (n, label) => { if (!labelsOf.has(n)) labelsOf.set(n, new Set()); labelsOf.get(n).add(label) }
    add(name, VERSION_LABEL)
    for (const st of provider.awareness.getStates().values()) {
      const u = st && st.user
      if (!u || !u.name || u.name === name || u.v !== PROTOCOL_VERSION || u.listener) continue
      if (u.hv) add(u.name, String(u.hv))
      // An AI on this protocol reporting no build is an engine older than build reporting: the rollout
      // case, and it cannot warn itself. Humans carry no engine build (the extension, the browser panel).
      else if (String(u.kind || '').toLowerCase() !== 'human') add(u.name, `a build older than build reporting (before ${VERSION})`)
    }
    const older = (label) => /^a build older/.test(label)
    const releaseOf = (label) => (older(label) ? label : String(label).split('+')[0])
    const on = (label) => (older(label) ? `on ${label}` : `on hivecode ${label}`)
    // The same release from another commit: a note for this folder, not a room alarm.
    for (const [n, labels] of labelsOf) {
      if (n === name) continue
      for (const label of labels) {
        if (label === VERSION_LABEL || releaseOf(label) !== VERSION) continue
        const key = `note|${n}|${label}`
        if (buildWarned.has(key)) continue
        buildWarned.add(key)
        note(`${n} runs hivecode ${label}: the same release as this client (${VERSION_LABEL}), from another commit.`)
      }
    }
    // One name, two engines on different builds: they write over each other's files.
    for (const [n, labels] of labelsOf) {
      if (n === name || labels.size < 2) continue
      const all = [...labels].sort()
      const id = `dual:${n}:${all.join('|')}`
      if (buildWarned.has(id)) continue
      buildWarned.add(id)
      log(`[${name}] ⚠ MIXED BUILDS: ${n} has engines ${all.map(on).join(' and ')}`)
      try { postOnce(id, `⚠ MIXED BUILDS: ${n} has two engines open, ${all.map(on).join(' and ')} (an older connection from ${n} is still open). Two engines under one name can lose file content with no error on either side -- close the older one.`, { observer: true }) } catch { }
    }
    // An OLDER RELEASE in the room: one alarm per participant and build, for the whole room. The event
    // is "X runs B, older than the newest release here": every observer sees the same newest release, so
    // they name the same event, and presence churn (an agent's state re-published) never re-raises it.
    const parts = (r) => (older(r) ? [-1] : String(r).split('.').map((x) => parseInt(x, 10) || 0))
    const cmp = (a, b) => { const x = parts(a), y = parts(b); for (let k = 0; k < Math.max(x.length, y.length); k++) { const d = (x[k] || 0) - (y[k] || 0); if (d) return d } return 0 }
    const releases = new Set()
    for (const labels of labelsOf.values()) for (const label of labels) releases.add(releaseOf(label))
    if (releases.size < 2) return
    const newest = [...releases].sort(cmp).pop()
    const current = []
    for (const [n, labels] of labelsOf) for (const label of labels) if (releaseOf(label) === newest) current.push(`${n} ${on(label)}`)
    for (const [n, labels] of labelsOf) {
      for (const label of labels) {
        if (releaseOf(label) === newest) continue
        const id = `builds:${n}:${label}`
        if (buildWarned.has(id)) continue
        buildWarned.add(id)
        log(`[${name}] ⚠ MIXED BUILDS: ${n} runs ${older(label) ? label : `hivecode ${label}`}`)
        try { postOnce(id, `⚠ MIXED BUILDS: ${n} runs ${older(label) ? label : `hivecode ${label}`}, older than the room's newest release (${current.sort().join(', ')}). Two releases in one room can lose file content with no error on either side -- ${n} should update (npx -y hivecode-mcp@latest setup, then restart).`, { observer: true }) } catch { }
      }
    }
  }
  if (syncFiles) provider.awareness.on('change', () => { renderMembers(); renderClaims(); checkVersions() })

  // HIV-P8: A FILE THAT WILL NEVER LEAVE THIS FOLDER, SAID OUT LOUD.
  //
  // HIV-P3 closed the genesis-claim hole at CLAIM time by classifying the claim string, and it
  // could only ever be a classifier: at claim time a bare string is all there is, and `config`,
  // `hosts` and `staging` are indistinguishable from ticket labels. At WRITE time there is no
  // ambiguity left — the file is on disk and isIgnored() is exact. So this is the backstop for
  // everything the classifier could not decide.
  //
  // IT CANNOT REFUSE. The bytes are already written by the time anyone knows, so this is
  // structurally a warning — and a warning is exactly what every born-invisible incident has
  // already scrolled past. That is why the claimed case opens an OBLIGATION instead of logging:
  // an obligation rides hive_wait, backs off, escalates to STALE and shows on the board. It is
  // un-ignorable by construction and costs nothing while nobody is idle.
  //
  // THE TWO GATES ARE THE WHOLE DESIGN, and the numbers are why. On a real checkout there are 256
  // ignored files. Warning about all of them would open 256 debts on join, each closable only by
  // its author, and the ledger would be unusable inside one join — the same flooding we spent this
  // morning clearing forty entries of. So:
  //   CLAIMED     the author declared they were working on this path. That is their own stated
  //               intent, already in the CRDT — not a guess about the filename.
  //   NOT PREEXISTING   it appeared during this session, rather than having sat there for a week.
  // Neither alone is sufficient: without the claim gate, 256; without the other, every long-lived
  // ignored file re-fires on every join.
  //
  // THE UNCLAIMED CASE GETS ONE LINE AND NO LEDGER ENTRY. The room rule is CLAIM BEFORE YOU WRITE,
  // so an unclaimed write is outside the protocol and does not get to consume the ledger. I am not
  // confident this tier earns its place — a chat line is precisely the signal these incidents
  // scroll past — but deleting the case entirely is worse than announcing it cheaply.
  const ENGINE_ID = 'hivecode'
  const invisibleWarned = new Map()  // relPath -> obligation id, or null for the ambient case
  const unsharedWarned = new Map()   // relPath -> { id: obligation id | null, reason: 'binary' | 'oversized', size: number }
  const unsharedMtimes = new Map()   // relPath -> mtimeMs (for CPU skip in scan)

  function noticeUnshared(currentUnshared) {
    for (const r of [...unsharedWarned.keys()]) if (!currentUnshared.has(r)) dischargeUnshared(r)
    for (const [r, info] of currentUnshared) noticeUnsharedOne(r, info)
  }

  function dischargeUnshared(r) {
    if (!unsharedWarned.has(r) && !unsharedMtimes.has(r)) return
    const entry = unsharedWarned.get(r)
    if (entry && entry.id) {
      try { OB.discharge(doc.getMap('obligations'), { id: entry.id, by: ENGINE_ID }) } catch { }
    }
    unsharedWarned.delete(r)
    unsharedMtimes.delete(r)
  }

  function noticeUnsharedOne(r, info) {
    if (SKIP.has(r) || OWN_LOCAL.has(r)) return
    const holder = coordinator.sense(r)
    const existing = unsharedWarned.get(r)
    if (existing && (existing.id || !holder || !holder.by)) return

    const reasonText = info.reason === 'oversized'
      ? `oversized (${Math.round(info.size / 1024)}KB > 1MB limit)`
      : 'binary (contains null bytes)'
    const inRoom = inManifest(r)
    const contextPrefix = inRoom
      ? `${r} is in the room as text, but local file is ${reasonText}`
      : `${r} is ${reasonText}`

    if (holder && holder.by) {
      const guidance = `stays on ${holder.by}'s machine only: teammates will not get it from the room. Share it another way (commit it).`
      let id = null
      try {
        const rec = OB.open(doc.getMap('obligations'), {
          from: ENGINE_ID,
          to: holder.by,
          text: `⛔ ${r} is on disk and claimed by you, but cannot be shared because it is ${reasonText} — it ${guidance}`,
          absent: false,
          neverSeen: false,
        })
        id = rec && rec.id
      } catch { }
      unsharedWarned.set(r, { id, reason: info.reason, size: info.size })
      try {
        say(`⛔ ${contextPrefix} and claimed by ${holder.by} — it ${guidance}`)
      } catch { }
    } else {
      const guidance = `stays on ${name}'s machine only: teammates will not get it from the room. Share it another way (commit it).`
      unsharedWarned.set(r, { id: null, reason: info.reason, size: info.size })
      if (!preexisting.has(r) || inRoom) {
        try {
          say(`· ${contextPrefix} — it ${guidance}`)
        } catch { }
      }
    }
  }

  function noticeBornInvisible(ignoredRel) {
    // DISCHARGE FIRST. A file that has gone away takes its debt with it: the question "this will
    // never sync" stops being a question when there is nothing left to sync. Left open, the ledger
    // fills with debts about paths that no longer exist, which is the noise the three-state
    // lifecycle exists to prevent. Its expiry cannot help here — that only covers names never seen
    // in the room, and this path was seen, on disk, by us.
    for (const r of [...invisibleWarned.keys()]) if (!ignoredRel.has(r)) dischargeInvisible(r)
    for (const r of ignoredRel) noticeInvisibleOne(r)
  }
  function dischargeInvisible(r) {
    if (!invisibleWarned.has(r)) return
    const id = invisibleWarned.get(r)
    if (id) { try { OB.discharge(doc.getMap('obligations'), { id, by: ENGINE_ID }) } catch { } }
    invisibleWarned.delete(r)
  }
  // Would walk() list this path as an ignored FILE -- the only kind noticeBornInvisible speaks
  // about? Not when a directory above it is pruned, as node_modules/ and .git/ are: an npm install
  // must not become ten thousand chat lines because a watcher event named each file.
  function walkSkipsAsIgnoredFile(r) {
    const segs = r.split('/')
    for (let i = 0; i < segs.length - 1; i++) {
      if (IGNORE.has(segs[i]) || isIgnored(segs.slice(0, i + 1).join('/') + '/')) return false
    }
    return !IGNORE.has(segs[segs.length - 1]) && isIgnored(r)
  }
  function noticeInvisibleOne(r) {
    if (SKIP.has(r) || OWN_LOCAL.has(r)) return // control files are ours and are supposed to be invisible
    if (preexisting.has(r)) return    // it was already here; nobody did this during the session
    if (invisibleWarned.has(r)) return // once per path, not once per scan tick
    const holder = coordinator.sense(r)
    if (holder && holder.by) {
      let id = null
      try {
        const rec = OB.open(doc.getMap('obligations'), {
          from: ENGINE_ID,
          to: holder.by,
          text: `${r} is on disk and claimed by you, but it is ignored by a .gitignore here — ` +
            `no sync connection is opened for it, so nothing written to it will ever reach the room. ` +
            `Add it to the allow-list, or confirm the work is deliberately local.`,
          absent: false,
          neverSeen: false,
        })
        id = rec && rec.id
      } catch { }
      invisibleWarned.set(r, id)
      try {
        say(`⛔ ${r} is claimed and on disk, but it is ignored by a .gitignore here — its bytes will never leave this folder.`)
      } catch { }
    } else {
      invisibleWarned.set(r, null)
      try {
        say(`· ${r} was created here but is ignored by a .gitignore — it stays local, and no other agent will see it.`)
      } catch { }
    }
  }

  // ---- deletes: a missing folder is not a deletion, and a delete from the room keeps a copy ----
  //
  // Measured 3 Oct 2026 on a local relay, before any of this existed: one agent's `rm -rf src`
  // took 30 files out of its teammate's folder within seconds, and nothing kept them -- a delete
  // from the room was a bare rmSync. Deleting the agent's WHOLE room folder was worse: on Windows
  // fs.watch threw EPERM with no handler and the agent's hivecode server died, and wherever the
  // watcher survives, the next scan walked a folder that was not there, read every file as
  // deleted, and emptied the room for everyone (12 of 12 files gone from the teammate's folder).
  function rootIsDir() { try { return fs.statSync(ROOT).isDirectory() } catch { return false } }

  // LOCAL DELETES SETTLE, THEN LEAVE AS ONE BATCH. `rm -rf` removes the files first and the folder
  // last, and each removal used to reach the room 40 ms after its watcher event -- so on a big
  // folder most of the deletes were already out while the folder still existed, and no check of
  // the folder could catch it. Nobody needs a delete in 40 ms. Waiting for the deleting to stop
  // lets the batch be judged whole: the folder gone, or every file in it gone at once, reads as a
  // lost folder (loseFolder), never as N deliberate deletes. It also stops an editor that saves by
  // delete-then-write from sending a delete and a re-create of the same file.
  const pendingLocalDeletes = new Set()
  let deleteTimer = null
  function noteLocalDelete(r) {
        if (pendingLocalDeletes.has(r)) return // a rescan of the same absence must not keep postponing it
    pendingLocalDeletes.add(r)
    if (deleteTimer) clearTimeout(deleteTimer)
    deleteTimer = setTimeout(settleLocalDeletes, DELETE_SETTLE_MS)
  }
  function settleLocalDeletes() {
        if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null }
    if (!pendingLocalDeletes.size) return
    const pending = [...pendingLocalDeletes]
    pendingLocalDeletes.clear()
    if (folderLost) return
    if (!rootIsDir()) { loseFolder('is gone'); return }
    // Gone now = still absent, or ignored since (walk() skips both, and both always retracted the
    // file from the room). Anything that came back during the wait is an edit, not a delete.
    const fileExistsExact = (r) => (!isCaseInsensitive ? fs.existsSync(path.join(ROOT, r)) : actualDiskPath(r) === r)
    const gone = pending.filter((r) => known.has(r) && inManifest(r) && (!fileExistsExact(r) || isIgnored(r)))
    if (!gone.length) return
    const held = [...known].filter((r) => inManifest(r)).length
    if (held >= 5 && gone.length >= held) { loseFolder(`was emptied: all ${held} of its files vanished at once`); return }
    // A FILE SOMEONE ELSE HOLDS IS NOT DELETED UNDER THEM. Measured 3 Oct 2026, with claims enforced
    // as queue and as block alike: Bob claimed a.js and was editing it, Alice deleted it, and it left
    // the room and Bob's folder -- a claim stopped every write except the largest one. Such a delete is
    // not sent; the file goes back into this folder from the room, so the folder matches the room
    // and the next scan does not try again; and the room is told why, once.
    const refused = []
    const send = []
    for (const r of gone) {
      const h = coordinator.sense(r)
      if (h && h.by && h.by !== name) refused.push([r, h.by]); else send.push(r)
    }
    for (const [r] of refused) {
      if (fileExistsExact(r)) continue // ignored since, not absent: nothing to put back
      const e = fileDocs.get(r)
      if (e) writeToDisk(r, e.text.toString())
      else { known.delete(r); mtimes.delete(r); queueOpenFile(r) } // reopened, it arrives like any room file
    }
    if (refused.length) {
      const what = refused.slice(0, 3).map(([r, by]) => `${r} (held by ${by})`).join(', ') + (refused.length > 3 ? ` (+${refused.length - 3} more)` : '')
      log(`[${name}] delete not sent, the file is held by someone else: ${what}`)
      try { say(`⛔ ${name} deleted ${what}, but a file someone else holds is not deleted under them, so that delete was not sent and the file is back in ${name}'s folder. Ask the holder to release it first.`) } catch { }
    }
    if (!send.length) return
    for (const r of send) queueManifestDelete(r)
    flushRoomDoc()
    const now = Date.now()
    for (const [k, v] of recentlyLocallyRemovedCase) { if (now - v.at > 60000) recentlyLocallyRemovedCase.delete(k) }
    for (const r of send) {
      recentlyLocallyRemovedCase.set(fold(r), { path: r, at: now })
      closeFile(r); known.delete(r); mtimes.delete(r); bases.delete(r); forkBases.delete(r); shadow.delete(r)
      if (isCaseInsensitive) {
        const cf = fold(r)
        collided.delete(r)
        collidedWarned.delete(r)
        clearCollidedTimer(r)
        if (canonicalCaseKeys.get(cf) === r) {
          canonicalCaseKeys.delete(cf)
          for (const [colKey, info] of collided.entries()) {
            if (info.with === r && inManifest(colKey)) {
              collided.delete(colKey)
              collidedWarned.delete(colKey)
              clearCollidedTimer(colKey)
              canonicalCaseKeys.set(cf, colKey)
              break
            }
          }
        }
      }
    }
    const list = send.slice(0, 3).join(', ') + (send.length > 3 ? ` (+${send.length - 3} more)` : '')
    log(`[${name}] -> deleted for everyone: ${list}`)
    if (send.length >= BULK_DELETE) {
      try { say(`· ${name} deleted ${send.length} files for everyone: ${list}. Teammates' folders keep a copy of what they held, in ${DELETED_DIR}/, for 7 days.`) } catch { }
    }
  }

  // A DELETE FROM THE ROOM KEEPS A COPY. The file moves to .hive-deleted/<when>/<path> in this
  // folder (ALWAYS_IGNORE, so it never syncs back). If the move fails -- an editor holding the file
  // on Windows -- it is copied, then removed. If even the copy fails it is still removed, as
  // before: a file left in place would be read as new by the next scan and resurrected for everyone.
  function deletedStamp() { return new Date().toISOString().replace(/[:.]/g, '-') }
  function keepDeletedCopy(relPath, stamp) {
    if (!isSafeRelPath(relPath)) return null
    const from = path.join(ROOT, relPath)
    let st
    try { st = fs.statSync(from) } catch { return null } // never reached this disk: nothing to keep
    if (!st.isFile()) return null
    const keptAs = `${DELETED_DIR}/${stamp}/${relPath}`
    const to = path.join(ROOT, keptAs)
    try { fs.mkdirSync(path.dirname(to), { recursive: true }) } catch { }
    try { fs.renameSync(from, to); return keptAs } catch { }
    let copied = false
    try { fs.copyFileSync(from, to); copied = true } catch { }
    try { fs.rmSync(from) } catch { }
    return copied ? keptAs : null
  }
  // Only folders this code named (an ISO stamp) and only once they are a week old: anything else a
  // person put in .hive-deleted/ is theirs.
  function pruneDeletedCopies() {
    const base = path.join(ROOT, DELETED_DIR)
    let names = []
    try { names = fs.readdirSync(base) } catch { return }
    const cutoff = Date.now() - DELETED_KEEP_MS
    for (const n of names) {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(n)
      if (!m) continue
      const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)
      if (t < cutoff) { try { fs.rmSync(path.join(base, n), { recursive: true, force: true }) } catch { } }
    }
  }

  let scanCount = 0
  function scan() {
    scanCount++
    if (folderLost) return 0
    // walk() of a missing folder returns nothing, which used to read as "every file was deleted".
    if (!rootIsDir()) { loseFolder('is gone'); return 0 }
    if (unwritable.size) retryUnwritable()
    const skippedFulls = []
    const diskFulls = walk(ROOT, [], skippedFulls)
    const diskRel = new Set(diskFulls.map(rel))
    const ignoredRel = new Set(skippedFulls.map(rel))
    // Snapshot the starting file set BEFORE the first reconcile pass touches anything.
    // Everything here pre-dates our participation; anything that shows up later was
    // authored while we were connected. See `preexisting`.
    // The ancestor must be loaded BEFORE any path can reach reconcile(), and this is the
    // one place guaranteed to run first exactly once. Loading it later would mean the first
    // scan's reconciles see no ancestor — precisely the bug this is here to close.
    //
    // HIV-P8: THE UNION IS NOT A DETAIL. `preexisting` used to be seeded from diskRel alone, and
    // diskRel comes from walk(), which dropped ignored files — so `preexisting.has(r)` was
    // permanently FALSE for every ignored path, whether it was created a second ago or had been
    // sitting there for a week. Any check phrased as "ignored AND not preexisting" therefore
    // reduced to "ignored", and a client joining a real checkout would have opened an obligation
    // for each of its 256 ignored files, about files nobody touched. Seeding the union is what
    // makes "not preexisting" mean what it says: authored during this session.
    if (!firstScanDone) {
      loadPriorShadow()
      for (const r of diskRel) preexisting.add(r)
      for (const r of ignoredRel) preexisting.add(r)
      firstScanDone = true
    }
    noticeBornInvisible(ignoredRel)
    const currentUnshared = new Map()
    let changes = 0
    for (const full of diskFulls) {
      const r = rel(full)
      if (SKIP.has(r)) continue
      checkCaseCollision(r)
      if (collided.has(r)) continue
      let mt
      try { mt = fs.statSync(full).mtimeMs } catch { continue }

      // 1. If previously known unshared and mtime hasn't changed, skip re-reading buffer!
      if (unsharedMtimes.get(r) === mt && unsharedWarned.has(r)) {
        currentUnshared.set(r, unsharedWarned.get(r))
        continue
      }

      // 2. If known shareable and mtime hasn't changed, skip!
      if (mtimes.get(r) === mt && inManifest(r)) continue

      // 3. mtime changed or new file: check unshared
      const unshared = checkUnshared(full)
      if (unshared) {
        unsharedMtimes.set(r, mt)
        currentUnshared.set(r, unshared)
        continue
      } else {
        unsharedMtimes.delete(r)
      }

      if (readText(full) === null) {
        if (isBinaryFile(full)) {
          mtimes.set(r, mt)
          reconcileBinary(r, 'local')
          changes++
          continue
        }
        continue
      }
      mtimes.set(r, mt)
      reconcile(r, 'local')
      changes++
    }
    noticeUnshared(currentUnshared)
    const removed = [...known].filter((r) => !diskRel.has(r) && inManifest(r) && !pendingLocalDeletes.has(r) && !collided.has(r))
    if (removed.length) {
      changes += removed.length
      for (const r of removed) {
        dischargeUnshared(r)
        noteLocalDelete(r) // leaves with its batch; see settleLocalDeletes
      }
    }
    return changes
  }

  // Non-blocking chunked file opening:
  // When an existing room doc syncs on join, 150-900 files arrive in manifest at once.
  // Opening them all synchronously inside Y.applyUpdate froze the Node event loop for
  // 5-8+ seconds, blowing past hive_join's 8s sync timeout and causing false join failures.
  // Chunking opens via setImmediate drains the batch smoothly in 32-file slices, firing
  // provider.on('sync') within milliseconds while keeping single-file live edits instant.
  const openQueue = []
  const openQueueSet = new Set()
  let openTimer = null
  // Test-only: hold the first drain this long, so a test can land a peer's delete while a key waits.
  const OPEN_DELAY_MS = Number(process.env.HIVE_TEST_OPEN_DELAY_MS) || 0
  let openTurns = 0 // drains run; tests/join-scale-test.mjs pins how few a big join takes
  function drainOpenQueue() {
    openTimer = null
    openTurns++
    // 256 A TURN ON ONE SOCKET, 32 ON A SOCKET PER FILE (27 Sep 2026). Each turn boundary waits
    // behind whatever else the loop runs in between, and during a big join that is a lot: measured
    // on a 1,000-file room arriving in one manifest event, every 32-file turn ran 1.1-1.4 s after
    // the last, so the joiner took ~49 s to have the files on disk; 256 a turn, 25 s. On the mux
    // transport an OPEN is one frame on a socket that already exists; on per-file sockets each is
    // a new connection, so that path keeps 32. The 100 ms ceiling keeps a slow machine from
    // holding the loop through a turn -- past the first 32, a turn stops when it runs out of time.
    const BATCH = fileTransport.mode === 'mux' ? 256 : 32
    const t0 = Date.now()
    let openedCount = 0
    while (openQueue.length && openedCount < BATCH && !stopped && (openedCount < 32 || Date.now() - t0 < 100)) {
      const key = openQueue.shift()
      openQueueSet.delete(key)
      if (fileDocs.size >= maxOpen()) {
        // At the bound a key from the join sweep waits for a touch, as before -- but a NEW file is
        // never dropped: it opens within the headroom, or goes back to the head of the queue for
        // the re-check (scheduleEvictRecheck) to let in once room is made.
        if (!newRemote.has(key)) continue
        if (fileDocs.size >= maxOpen() + NEW_HEADROOM) {
          openQueue.unshift(key); openQueueSet.add(key)
          scheduleEvictRecheck()
          break
        }
      }
      // STILL WANTED? A key can wait here while a peer deletes the file. Its document still exists on
      // the relay, so opening it would bring the deleted file back to this disk and publish it again
      // for everyone. Wanted = still in the room, or on this disk (a new local file not yet published).
      const wanted = inManifest(key) || fs.existsSync(path.join(ROOT, key))
      if (!wanted) newRemote.delete(key)
      if (wanted && canOpen(key) && !SKIP.has(key) && !isIgnored(key) && !fileDocs.has(key)) {
        openFile(key)
        openedCount++
      }
    }
    if (openQueue.length && !stopped && (fileDocs.size < maxOpen() || (newRemote.size && fileDocs.size < maxOpen() + NEW_HEADROOM))) {
      openTimer = setImmediate(drainOpenQueue)
    }
  }

  function queueOpenFile(key) {
    if (fileDocs.has(key) || (fileDocs.size >= maxOpen() && !newRemote.has(key)) || openQueueSet.has(key)) return
    openQueueSet.add(key)
    if (fs.existsSync(path.join(ROOT, key))) openQueue.unshift(key)
    else openQueue.push(key)
    if (!openTimer && !stopped) {
      openTimer = OPEN_DELAY_MS ? setTimeout(drainOpenQueue, OPEN_DELAY_MS) : setImmediate(drainOpenQueue)
    }
  }

  // Manifest changes from OTHERS: a new path -> open its file-room (its sync pulls
  // the content); a removed path -> tear down, and move the local file into .hive-deleted/.
  if (syncFiles) manifest.observe((ev, txn) => {
    if (txn.local) return
    if (folderLost) return // nothing in a lost folder is written, moved or recreated
    let stamp = null
    let kept = 0
    // Process deletions BEFORE additions so that renames (delete old + add new)
    // retire the old path and free canonicalCaseKeys before the new casing is checked.
    const deletes = []
    const others = []
    ev.changes.keys.forEach((change, key) => {
      if (change.action === 'delete') deletes.push([key, change])
      else others.push([key, change])
    })

    for (const [key, change] of deletes) {
      let promotedKey = null
      if (isCaseInsensitive) {
        const cf = fold(key)
        clearCollidedTimer(key)
        if (collided.has(key)) {
          collided.delete(key)
          collidedWarned.delete(key)
        } else if (canonicalCaseKeys.get(cf) === key) {
          canonicalCaseKeys.delete(cf)
          for (const [colKey, info] of collided.entries()) {
            if (info.with === key && inManifest(colKey)) {
              collided.delete(colKey)
              collidedWarned.delete(colKey)
              clearCollidedTimer(colKey)
              canonicalCaseKeys.set(cf, colKey)
              promotedKey = colKey
              break
            }
          }
        }
      }
      recentlyLocallyRemovedCase.delete(fold(key))
      pendingManifestOps.delete(key)
      newRemote.delete(key); arrivedNew.delete(key) // deleted while new or queued: nothing to wait for
      closeFile(key)
      { const qi = openQueue.indexOf(key); if (qi >= 0) { openQueue.splice(qi, 1); openQueueSet.delete(key) } } // deleted while queued
      if (!stamp) stamp = deletedStamp() // one folder per batch, so a bulk delete comes back together
      const keptAs = keepDeletedCopy(key, stamp)
      if (keptAs) kept++
      known.delete(key); bases.delete(key); forkBases.delete(key); mtimes.delete(key); shadow.delete(key); shaShadow.delete(key); unwritable.delete(key)
      log(`[${name}] <- deleted ${key}${keptAs ? ` (copy kept: ${keptAs})` : ''}`)
      if (promotedKey) {
        reconcile(promotedKey, 'remote')
      }
    }

    for (const [key, change] of others) {
      if (canOpen(key) && !SKIP.has(key) && !isIgnored(key)) {
        checkCaseCollision(key)
        // NEW = created after this client joined (roomAtJoin is the room at the first sync) and not
        // on this disk. The join's own manifest arrives before roomAtJoin exists, so it is never new.
        const isNew = !!roomAtJoin && change.action === 'add' && !roomAtJoin.has(key) && !fs.existsSync(path.join(ROOT, key))
        if (isNew) newRemote.add(key)
        if (ev.changes.keys.size <= 2 && (fileDocs.size < maxOpen() || (isNew && fileDocs.size < maxOpen() + NEW_HEADROOM))) {
          openFile(key)
        } else {
          queueOpenFile(key)
        }
      }
    }
    if (kept > 1) log(`[${name}] <- ${kept} files deleted by a teammate; copies kept in ${DELETED_DIR}/${stamp}/`)
  })

  // INSTANT propagation: fs.watch fires on the actual edit, so changes go out in
  // ~tens of ms instead of waiting for the poll. A periodic scan stays as a
  // safety net (and the only mechanism where recursive watch isn't supported).
  //
  // ADAPTIVE SAFETY NET:
  // When fs.watch is healthy, scanning untouched files every 2s wastes ~37ms of CPU
  // on a 900-file folder (1,108ms/min). If a scan detects ZERO changes that fs.watch
  // hadn't already reconciled, we double the interval: 2s -> 4s -> 8s -> 16s.
  // The instant a scan catches an unobserved disk change (e.g. editor atomic save
  // or network drive missing watcher events), interval snaps back to 2s immediately.
  // When recursive watch is unsupported (!watcher), interval stays fixed at 400ms.
  const SCAN_MIN_MS = 2000
  const SCAN_MAX_MS = 16000
  const SCAN_NO_WATCHER_MS = 400
  let scanInterval = SCAN_MIN_MS
  let scanTimer = null
  let watcher = null
  let debounce = null

  function scheduleNextScan(ms) {
    if (stopped || folderLost) return
    if (scanTimer) clearTimeout(scanTimer)
    // Ref'd, like the setInterval it replaced: a headless client whose socket is down may have
    // nothing else holding the process open, and an unref'd net would let it exit silently.
    scanTimer = setTimeout(runAdaptiveScan, ms)
  }

  const pendingFsEvents = new Map() // relPath -> Set<'change'|'rename'>
  let pendingFsFullScan = false

  function flushFsEvents() {
    debounce = null
    if (stopped || folderLost) return
    if (!rootIsDir()) { pendingFsEvents.clear(); loseFolder('is gone'); return }
    if (!firstScanDone || pendingFsFullScan || pendingFsEvents.size > 256) {
      pendingFsEvents.clear()
      pendingFsFullScan = false
      scan()
      return
    }

    const entries = [...pendingFsEvents.entries()]
    pendingFsEvents.clear()
    pendingFsFullScan = false

    let changes = 0
    for (const [r, evts] of entries) {
      if (SKIP.has(r) || OWN_LOCAL.has(r)) continue
      if (isIgnored(r)) {
        // Never reconciled -- but HIV-P8's born-invisible notice must not wait for the next full
        // scan (up to 16 s away), and a deleted one takes its debt with it, exactly as scan() does.
        if (walkSkipsAsIgnoredFile(r)) {
          let isFile = false
          try { isFile = fs.statSync(path.join(ROOT, r)).isFile() } catch { }
          if (isFile) noticeInvisibleOne(r); else dischargeInvisible(r)
        }
        continue
      }
      const full = path.join(ROOT, r)
      let st
      try {
        st = fs.statSync(full)
      } catch {
        // Path does not exist on disk (deleted file or directory)
        dischargeUnshared(r)
        if (known.has(r) && inManifest(r)) {
          changes++
          noteLocalDelete(r) // leaves with its batch; see settleLocalDeletes
          continue
        }
        // Check if r might have been a directory containing tracked files
        const dirPrefix = r + '/'
        let wasKnownDir = false
        for (const k of known) {
          if (k.startsWith(dirPrefix)) { wasKnownDir = true; break }
        }
        if (wasKnownDir) {
          scan()
          return
        }
        continue
      }

      // On case-insensitive filesystems, statSync('Readme.md') succeeds even if the file on disk
      // was renamed to 'README.md'. Verify exact disk path matches r:
      if (isCaseInsensitive && actualDiskPath(r) !== r) {
        dischargeUnshared(r)
        if (known.has(r) && inManifest(r)) {
          changes++
          noteLocalDelete(r)
          const diskTarget = actualDiskPath(r)
          if (diskTarget && fold(diskTarget) === fold(r)) {
            checkCaseCollision(diskTarget)
            queueManifestSet(diskTarget)
          }
          continue
        }
      }

      if (st.isDirectory()) {
        // If a directory was created/renamed or received a 'rename' event, fall back to full scan
        if (evts.has('rename')) {
          scan()
          return
        }
        // On Windows (and some other OSes), writing to a file inside a directory also emits 'change' on the directory.
        // Ignore the directory 'change' event; the file itself is processed in this batch.
        continue
      }

      if (!st.isFile()) continue
      if (unsharedMtimes.get(r) === st.mtimeMs && unsharedWarned.has(r)) continue
      if (mtimes.get(r) === st.mtimeMs && inManifest(r)) continue
      checkCaseCollision(r)
      if (collided.has(r)) continue
      const unshared = checkUnshared(full, st)
      if (unshared) {
        unsharedMtimes.set(r, st.mtimeMs)
        noticeUnsharedOne(r, unshared)
        continue
      } else {
        unsharedMtimes.delete(r)
        dischargeUnshared(r)
      }
      if (readText(full) === null) {
        if (isBinaryFile(full, st)) {
          mtimes.set(r, st.mtimeMs)
          reconcileBinary(r, 'local')
          changes++
          continue
        }
        continue
      }
      mtimes.set(r, st.mtimeMs)
      reconcile(r, 'local')
      changes++
    }
  }

  function runAdaptiveScan() {
    scanTimer = null
    if (debounce) { clearTimeout(debounce); debounce = null }
    pendingFsEvents.clear()
    pendingFsFullScan = false
    const changes = scan()
    if (!watcher) {
      scanInterval = SCAN_NO_WATCHER_MS
      scheduleNextScan(scanInterval)
      return
    }
    if (changes > 0) {
      // Caught a change fs.watch missed! Snap back to minimum interval.
      scanInterval = SCAN_MIN_MS
    } else {
      // Nothing missed: back off by doubling interval up to 16s cap.
      scanInterval = Math.min(SCAN_MAX_MS, scanInterval * 2)
    }
    scheduleNextScan(scanInterval)
  }

  const onFsEvent = (evt, fname) => {
    if (fname && String(fname).endsWith('.gitignore')) reloadIgnores()
    if (!fname) {
      pendingFsFullScan = true
    } else {
      const norm = String(fname).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
      if (!norm || norm === '.') {
        pendingFsFullScan = true
      } else {
        let set = pendingFsEvents.get(norm)
        if (!set) {
          set = new Set()
          pendingFsEvents.set(norm, set)
        }
        set.add(evt)
        if (pendingFsEvents.size > 256) pendingFsFullScan = true
      }
    }
    if (debounce) return
    debounce = setTimeout(flushFsEvents, 40)
  }
  function startWatch() {
    try { watcher = fs.watch(ROOT, { recursive: true }, onFsEvent) }
    catch { watcher = null } // recursive watch unsupported (some Linux) -> rely on scan
    // A watcher error used to be an uncaught 'error' event: deleting the room folder on Windows
    // (EPERM) killed the whole process, and with it the agent's hivecode server.
    if (watcher) watcher.on('error', onWatchError)
  }
  function onWatchError(e) {
    try { watcher && watcher.close() } catch { }
    watcher = null
    if (stopped || folderLost) return
    if (!rootIsDir()) { loseFolder('is gone'); return }
    log(`[${name}] the folder watcher failed (${(e && e.code) || e}); checking the folder every ${SCAN_NO_WATCHER_MS} ms instead`)
    scheduleNextScan(SCAN_NO_WATCHER_MS)
  }

  // THE FOLDER IS GONE: say so once, and stop touching the disk. Every way back is a fresh join,
  // which compares the folder with the room the same way a first join does, so nothing a person
  // put back is overwritten. Stopping, rather than carrying on, is deliberate: a remote write would
  // recreate the folder holding one file, and the next pass would read the rest as deleted.
  function loseFolder(why) {
    if (folderLost || stopped) return
    folderLost = {
      at: Date.now(),
      message: `Q580: this room's folder ${why} (${ROOT}). Nothing was deleted for anyone: ` +
        `file sync stopped here, so the room keeps every file. Chat and claims still work. To get the ` +
        `room's files back, call hive_join again with the same link: an empty folder is filled from ` +
        `the room. If the folder was moved on purpose, join from its new place.`,
    }
    try { watcher && watcher.close() } catch { }
    watcher = null
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null }
    if (debounce) { clearTimeout(debounce); debounce = null }
    if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null }
    pendingFsEvents.clear()
    pendingLocalDeletes.clear()
    log(`[${name}] ${folderLost.message}`)
  }

  provider.on('sync', (s) => {
    if (!s || !syncFiles) return
    // HIV-P14b. Snapshot what the room already had, once. Measured: the manifest IS populated at
    // this point -- a fresh joiner's observer fires with 13 of 13 entries before the sync event,
    // so reading it here is sound. (That was checked because the first version of this guard was
    // wrongly assumed to be failing for this reason.)
    if (!roomAtJoin) {
      roomAtJoin = new Set()
      try { for (const k of manifest.keys()) roomAtJoin.add(k) } catch { }
    }
    writeToDisk(RULES_FILE, HIVE_RULES_TEXT) // the law is always present in the room
    writeToDisk(AGENTS_FILE, AGENT_MANUAL_TEXT) // so an agent opening this folder learns how to join + behave
    // Connect to every file I'm granted AND have not excluded; each file-room's sync pulls
    // its content. `canOpen` is the TOKEN's scope -- what the relay would let me see. It is
    // not the same question as "do I want this file", and using it alone meant a participant
    // could not bound its own footprint: on 18 Sep 2026 two agents kept opening demo/** file
    // rooms after their .gitignore had been narrowed to 35 paths, and between them consumed
    // the relay's entire 512-connection budget. Since one socket is opened PER FILE, an
    // ignore rule that does not stop the connection is not a containment tool at all.
    // Same predicate reconcile() uses, so a file is never open but unreconcilable.
    // BOUND THE INITIAL SWEEP, not just the steady state. This burst is precisely when the
    // budget blows: a client with 889 files used to try to open 889 sockets at once against
    // a 512-connection relay. LRU eviction cannot help here — during a burst every file was
    // touched seconds ago, so nothing is eligible to evict. The only thing that works is to
    // not open them all.
    //
    // Files that exist on THIS client's disk come first: they are the ones that need
    // reconciling, and a path we have no local copy of can wait until something asks for it.
    //
    // If /health has not said yet which transport this relay speaks, the sweep opens what is safe
    // on either (the per-file bound) now and the rest the moment it answers -- holding every file
    // back on one HTTP round trip would delay the join for nothing.
    const sweep = (final) => {
      const openable = [...manifest.keys()].filter((k) => canOpen(k) && !SKIP.has(k) && !isIgnored(k))
      const localFirst = openable.sort((a, b) => {
        const la = fs.existsSync(path.join(ROOT, a)) ? 0 : 1
        const lb = fs.existsSync(path.join(ROOT, b)) ? 0 : 1
        return la - lb
      })
      const cap = maxOpen()
      for (const k of localFirst) checkCaseCollision(k)
      for (const key of localFirst.slice(0, cap)) queueOpenFile(key)
      if (final && localFirst.length > cap) {
        log(`[${name}] ${localFirst.length} files in this room, holding ${cap} open (HIVE_MAX_OPEN_FILES). The rest sync when touched.`)
      }
    }
    const decided = fileTransport.mode !== 'detecting'
    sweep(decided)
    if (!decided) fileTransport.ready.then(() => { if (!stopped) sweep(true) })
    if (board.size) renderBoard()
    if (chat.length) renderChat()
    if (tasks.size) renderTasks()
    renderMembers()
    renderClaims() // unconditional: "nothing is claimed" is the answer an arriving agent needs most
    scan()
    log(`[${name}] folder sync active on ${ROOT} (room "${room}") as ${kind}. ${manifest.size} files.`)
    // HIV-P14. SAY THE GAP OUT LOUD, ONCE, AT JOIN.
    //
    // The working set is bounded on purpose, and the documented trade is that "a file outside it
    // does not arrive until something touches it". For a human reading a folder that is fine. For
    // an AI agent it is not, because an agent decides what exists by listing its directory: a
    // file it cannot see is a file it believes does not exist, and it writes one. Measured 21 Sep
    // 2026, a 40-file room and MAX_OPEN=8: the joiner held 7 files, reported "filesSynced 8/8",
    // said nothing, and its agent recreated a file the room already had.
    //
    // Nothing here changes the cap. It tells the agent the number it needs in order to ASK,
    // which is the one thing that makes "until something touches it" true.
    //
    // Said only when the bound really leaves files out. Below it a missing file is in flight (or
    // refused, which noteRefusals reports with the relay's reason) -- not missing on purpose -- and
    // one-socket mode holds 4096 files, so an ordinary room never hears this. Timed from the
    // moment the transport is known, because the bound is not known before that.
    fileTransport.ready.then(() => setTimeout(() => {
      try {
        const want = [...manifest.keys()].filter((r) => canOpen(r) && !SKIP.has(r))
        if (want.length <= maxOpen() || stopped) return // the bound leaves nothing out: no need to stat every file
        const have = want.filter((r) => fs.existsSync(path.join(ROOT, r)))
        const short = want.length - have.length
        if (short <= 0) return
        log(`[${name}] !! THIS FOLDER IS INCOMPLETE ON PURPOSE. The room has ${want.length} files; ` +
          `${have.length} are on disk here and ${short} are NOT. The working set is bounded to ` +
          `${maxOpen()} open files (HIVE_MAX_OPEN_FILES), because ` +
          (fileTransport.mode === 'mux' ? `every open file costs relay memory. ` : `one socket is opened per file and a relay admits a limited number. `) +
          `A missing file EXISTS — it simply has not been fetched. ` +
          `Do not treat it as absent and do not create it: reading or claiming the path fetches it. ` +
          `hive_status reports filesHeld of roomFiles, and hive_read_board lists what the room holds.`)
      } catch { }
    }, 4000).unref?.())
    if (!scanTimer) {
      startWatch()
      scanInterval = watcher ? SCAN_MIN_MS : SCAN_NO_WATCHER_MS
      scheduleNextScan(scanInterval)
    }
  })

  // Evaluates consensus across peer measurements for a path and version.
  function evaluateAttestations(rec, curVer, roomDocHash) {
    const currentPeers = []
    const formattedPeers = {}
    for (const [peerName, v] of Object.entries(rec || {})) {
      if (!v) continue
      const isCurrent = (v.version || 1) === (curVer.n || 1)
      if (isCurrent) {
        currentPeers.push({ peer: peerName, ...v })
        let note = ''
        if (v.stuckLagging) {
          note = ` (${v.stuckReason || 'stuck lagging'})`
        } else if (v.lagging) {
          note = ` (${v.lagNotice || 'your folder has not caught up yet'})`
        }
        formattedPeers[peerName] = { ...v, stale: false, note }
      } else {
        formattedPeers[peerName] = {
          ...v,
          stale: true,
          staleReason: `stale: attested version ${v.version || 0}, room is at ${curVer.n}`
        }
      }
    }

    // Peers that are present, have a hash, and are NOT lagging (stuck peers are kept out of quorum too)
    const presentValid = currentPeers.filter((v) => !v.absent && v.hash && !v.lagging && !v.stuckLagging)
    const validHashes = [...new Set(presentValid.map((v) => v.hash))]
    const validSizes = [...new Set(presentValid.map((v) => v.bytes))]

    // Peers that count toward comparison:
    // A peer lagging inside the grace period counts toward NEITHER quorum NOR divergence!
    // Compare hashes over non-lagging peers plus stuck peers only.
    const comparisonPeers = currentPeers.filter((v) => !v.absent && v.hash && (!v.lagging || v.stuckLagging))
    const comparisonHashes = [...new Set(comparisonPeers.map((v) => v.hash))]
    const comparisonSizes = [...new Set(comparisonPeers.map((v) => v.bytes))]
    const anyAbsent = currentPeers.some((v) => v.absent)
    const anyStuck = currentPeers.some((v) => v.stuckLagging)

    // Quorum: requires at least 2 non-lagging peers of current version with identical hash, no absent, no stuck
    let quorum = presentValid.length >= 2 && validHashes.length === 1 && !anyAbsent && !anyStuck

    // Divergence:
    // 1. Two comparison peers (non-lagging or stuck) disagree on disk hash
    // 2. OR one comparison peer is absent while another is present
    // 3. OR any peer is stuck lagging (>grace period passed without catching up)
    const split = comparisonHashes.length > 1 || (anyAbsent && comparisonPeers.length > 0) || anyStuck

    let quorumOnOlder = false
    if (quorum && roomDocHash && validHashes[0] && roomDocHash !== validHashes[0]) {
      quorum = false
      quorumOnOlder = true
    }

    return {
      peers: formattedPeers,
      currentPeers,
      count: currentPeers.length,
      totalCount: Object.keys(rec || {}).length,
      sizes: comparisonSizes.length ? comparisonSizes : [...new Set(currentPeers.filter(v => !v.absent && v.hash).map(v => v.bytes))],
      diverged: split,
      quorum,
      quorumOnOlder,
      version: curVer.n || 1
    }
  }

  function stopAll() {
    try { flushFirstContact() } catch { } // before `stopped`: a join cut short still says what it kept
    try { settleLocalDeletes() } catch { } // a delete made just before leaving still leaves, judged like any other
    stopped = true
    for (const t of sysTimers) clearTimeout(t)
    sysTimers.clear()
    try { flushRoomDoc() } catch { }
    if (openTimer) { clearImmediate(openTimer); clearTimeout(openTimer); openTimer = null }
    if (renderBoardTimer) { clearImmediate(renderBoardTimer); renderBoardTimer = null }
    openQueue.length = 0
    openQueueSet.clear()
    if (scanTimer) clearTimeout(scanTimer)
    if (debounce) { clearTimeout(debounce); debounce = null }
    for (const tm of collidedTimers.values()) clearTimeout(tm)
    collidedTimers.clear()
    pendingFsEvents.clear()
    pendingFsFullScan = false
    if (editingClearTimer) clearTimeout(editingClearTimer)
    try { watcher && watcher.close() } catch { }
    // The shared socket first: closing it ends every channel at once on the relay, instead of
    // one CLOSE frame per file down a socket that is about to go anyway.
    try { fileTransport.stop() } catch { }
    for (const r of [...fileDocs.keys()]) closeFile(r) // tear down every per-file provider
    try { provider.awareness.setLocalState(null) } catch { } // announce departure now (don't wait for timeout)
    try { provider.destroy() } catch { }
    try { doc.destroy() } catch { }
    // A room you have left should stop colouring what your agents recall.
    if (memoryLinked && grmLink) try { grmLink.unlinkRoom(ROOT, log) } catch { }
    // Last, so a crash anywhere above still frees the folder on the next run via the
    // stale-PID path rather than leaving it locked.
    try { releaseLock() } catch { }
    // A final flush of the ancestor record. The debounced save may still be pending, and
    // losing it would make the next join see no common ancestor -- the exact condition
    // that produced the rejoin clobber.
    try { if (shadowTimer) { clearTimeout(shadowTimer); shadowTimer = null } saveShadow() } catch { }
  }

  return {
    doc,
    provider,
    // A STATE MACHINE, not a validated variable.
    //
    // `enum` alone makes this a notepad with spellcheck: it stops a typo and permits any value at any
    // time, so APPROVED can slide back to LOCKED and a release gate can be opened by an agent that
    // simply set the flag. Two additions turn it into a machine, and both exist because a live
    // four-agent build (JARVIS, 2026-07-29) was governed entirely by rules written in prose that four
    // capable agents read and then broke:
    //
    //   transitions: { FROM: [TO, ...] }   which moves are legal AT ALL
    //   requires:    { TO: { key: val } }  what must already be true to arrive at TO
    //
    // `requires` is the important one. It makes a contract EXECUTABLE. "Nobody sends email until the
    // suppression UI exists and the unsubscribe URL is real" held for nine hours only because a PM
    // kept repeating it; expressed as
    //   requires: { LIVE: { suppression_ui: 'APPROVED', unsubscribe_url: 'SET' } }
    // it holds because the transition cannot be made. That is the whole point of this layer: the
    // place where a rule stops being advice.
    setState: (key, val) => {
      const rules = swarmSchema.get(key)
      const cur = swarmState.get(key)
      // PARAMETERISED VALUES. `PUBLISH:2` must satisfy an enum containing `PUBLISH` — otherwise the
      // two features collide: a leased grant is a PUBLISH carrying a count, and schema-ing the status
      // key would make every lease illegal. So a value of the form BASE:arg validates on BASE.
      // Found by trying to use both at once on a live room, which is the only way this surfaces.
      const base = String(val).includes(':') ? String(val).slice(0, String(val).indexOf(':')) : val
      if (rules && rules.enum && !rules.enum.includes(val) && !rules.enum.includes(base)) {
        throw new Error(`[Schema Error] Invalid state for [${key}]. Allowed values: ${rules.enum.join(', ')}${base !== val ? ` (parameterised values like ${base}:<n> are allowed when ${base} is listed)` : ''}`);
      }
      // Transitions are checked only when the key ALREADY has a value — the first write to a key is
      // initialisation, not a move, and demanding a `from` entry for it would make every schema
      // carry a synthetic start state.
      // Transitions compare on the BASE too, for the same reason as the enum above: a lease counting
      // down PUBLISH:2 -> PUBLISH:1 is one state decrementing its own parameter, not a move between
      // states, and demanding a transition entry per count would be absurd.
      const curBase = cur !== undefined && String(cur).includes(':') ? String(cur).slice(0, String(cur).indexOf(':')) : cur
      if (rules && rules.transitions && cur !== undefined && curBase !== base) {
        const allowed = rules.transitions[curBase] || rules.transitions[cur]
        if (!Array.isArray(allowed) || !(allowed.includes(val) || allowed.includes(base))) {
          throw new Error(`[Transition Error] [${key}] cannot go ${cur} -> ${val}. Legal from ${curBase}: ${Array.isArray(allowed) && allowed.length ? allowed.join(', ') : '(nothing — terminal state)'}`)
        }
      }
      if (rules && rules.requires && rules.requires[val]) {
        const unmet = Object.entries(rules.requires[val])
          .filter(([k, want]) => String(swarmState.get(k)) !== String(want))
          .map(([k, want]) => `${k}=${want} (is ${swarmState.get(k) === undefined ? 'unset' : swarmState.get(k)})`)
        if (unmet.length) {
          throw new Error(`[Guard Error] [${key}] cannot become ${val} until: ${unmet.join('; ')}`)
        }
      }
      swarmState.set(key, val)
      // The session that sets a gate has chosen to run that command, so its own machine approves it
      // (0.14.4 S-1). Nobody else's does: a gate set here runs elsewhere only after that person approves.
      if (key === GATE_CMD && String(val == null ? '' : val).trim()) {
        try { writeApproval(room, String(val), `set by ${name} on this machine`, GATES_DIR) } catch { /* no approval, so it simply does not run here */ }
      }
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
    // --- attestation: does another folder actually hold the same bytes? ---
    // Records THIS peer's measurement of a path. Returns the merged picture including, crucially,
    // whether the peers DISAGREE — see the swarm_attest declaration for why it is keyed per peer.
    attest: (relPath, bytes, lines) => {
      const p = String(relPath)
      const full = path.join(ROOT, p)
      let measuredHash = null
      let measuredBytes = null
      let diskBytes = null // this disk's own count, when its line endings make it differ
      let measuredLines = null
      let absent = false
      let mismatch = null
      let diskContent = null

      if (fs.existsSync(full)) {
        try {
          const rawDisk = fs.readFileSync(full, 'utf8')
          // Hash AND size are of the text in the room's form (LF), so a Windows and a Mac copy of the
          // same file attest as one content at one size. Recording each disk's own byte count printed
          // "confirmed by 2+ peers at the same size" over two different numbers. A STATED count is
          // whatever some agent measured on some disk, so it matches if it is any form of this text:
          // this disk's bytes, the LF form, or the CRLF form (a Windows peer's number read on a Mac).
          diskContent = toLF(rawDisk)
          measuredHash = contentHash(diskContent)
          measuredBytes = Buffer.byteLength(diskContent, 'utf8')
          diskBytes = Buffer.byteLength(rawDisk, 'utf8')
          const normalized = diskContent.endsWith('\n') ? diskContent.slice(0, -1) : diskContent
          measuredLines = diskContent.length === 0 ? 0 : normalized.split(/\r?\n/).length
          const statedBytes = Number(bytes)
          const crlfBytes = measuredBytes + (diskContent.match(/\n/g) || []).length
          if (Number.isFinite(statedBytes) && statedBytes > 0 && ![measuredBytes, diskBytes, crlfBytes].includes(statedBytes)) {
            mismatch = { stated: statedBytes, measured: measuredBytes }
          }
        } catch {
          absent = true
        }
      } else {
        absent = true
      }

      // Check if room doc exists and whether disk differs from room doc
      const fe = fileDocs.get(p)
      let roomDocHash = null
      let roomDocBytes = null
      let lagging = false
      let lagDirection = null
      let lagNotice = null

      if (fe && fe.text && fe.text.length > 0 && measuredHash) {
        const docText = fe.text.toString()
        roomDocHash = contentHash(docText)
        roomDocBytes = Buffer.byteLength(docText, 'utf8')
        if (measuredHash !== roomDocHash) {
          lagging = true
          const base = bases.get(p)
          if (base !== undefined && base === docText) {
            lagDirection = 'ahead'
            lagNotice = 'disk ahead of room doc: local edit not published to room yet (your folder has not caught up yet)'
          } else if (base !== undefined && base === diskContent) {
            lagDirection = 'behind'
            lagNotice = 'disk behind room doc: your folder has not caught up yet'
          } else {
            lagDirection = 'lagging'
            lagNotice = 'disk out of step with the room\'s copy (your folder has not caught up yet)'
          }
        }
      }

      let curVer = swarmVersions.get(p)
      if (!curVer) {
        curVer = { n: 1, hash: measuredHash || '' }
        swarmVersions.set(p, curVer)
      }

      const GRACE_MS = Number(process.env.HIVE_ATTEST_GRACE_MS) || 10000
      const prev = swarmAttest.get(p) || {}
      const prevAttest = prev[name]

      let stuckLagging = false
      let stuckReason = null
      if (lagging && prevAttest && (prevAttest.lagging || prevAttest.stuckLagging) && prevAttest.laggingDocHash === roomDocHash) {
        const prevAt = prevAttest.at ? new Date(prevAttest.at).getTime() : 0
        const elapsedMs = Date.now() - prevAt
        if (elapsedMs >= GRACE_MS) {
          stuckLagging = true
          stuckReason = `not catching up to room doc after ${Math.round(elapsedMs / 1000)}s: disk ${measuredBytes}b vs doc ${roomDocBytes}b (${lagDirection || 'lagging'})`
        }
      }

      const next = {
        ...prev,
        [name]: {
          bytes: measuredBytes,
          lines: measuredLines,
          hash: measuredHash,
          absent,
          mismatch,
          lagging: lagging && !stuckLagging,
          lagDirection: lagDirection || undefined,
          lagNotice: lagNotice || undefined,
          laggingDocHash: lagging ? roomDocHash : undefined,
          stuckLagging,
          stuckReason: stuckReason || undefined,
          version: curVer.n,
          at: (lagging && prevAttest && (prevAttest.lagging || prevAttest.stuckLagging) && prevAttest.laggingDocHash === roomDocHash)
            ? prevAttest.at
            : new Date().toISOString()
        }
      }
      swarmAttest.set(p, next)

      const evaluated = evaluateAttestations(next, curVer, roomDocHash)
      if (evaluated.diverged) {
        const detail = evaluated.currentPeers.map((v) => {
          if (v.absent) return `${v.peer}:ABSENT`
          if (v.stuckLagging) return `${v.peer}:${v.bytes}b/${v.lines}L[STUCK:${v.stuckReason || 'not catching up'}]`
          return `${v.peer}:${v.bytes}b/${v.lines}L`
        }).join('  ')
        postOnce(`diverge:${p}:${contentHash(detail).slice(0, 16)}`, `[!] DIVERGENCE on ${p} — peers hold DIFFERENT content: ${detail}. Nobody may write this path until it is reconciled; mark it path:${p}=POISONED if it cannot be.`)
      }

      return {
        path: p,
        mismatch,
        measuredBytes,
        diskBytes,
        measuredLines,
        measuredHash,
        lagging: lagging && !stuckLagging,
        lagNotice,
        stuckLagging,
        stuckReason,
        ...evaluated
      }
    },
    verified: (relPath) => {
      const p = String(relPath)
      const curVer = swarmVersions.get(p) || { n: 1, hash: '' }
      const rec = swarmAttest.get(p) || {}
      const fe = fileDocs.get(p)
      let roomDocHash = null
      if (fe && fe.text && fe.text.length > 0) {
        roomDocHash = contentHash(fe.text.toString())
      }
      const evaluated = evaluateAttestations(rec, curVer, roomDocHash)
      return {
        path: p,
        ...evaluated
      }
    },
    say,                 // post a coordination message
    postOnce,            // a system line said once per event in the room, whoever sees it (0.14.4, C5)
    notices: () => notices.slice(), // what only this folder needs to know (hive_status shows it)
    assign,              // direct a task at a participant (needs approval if target AI has an owner)
    decide,              // approve/deny a task (owner only, if set)
    complete,            // mark a task done
    myTasks,             // tasks directed at me
    control,             // pause/resume an agent (mission control)
    isPaused,            // is a participant currently paused?
    controls,            // the live control map
    // --- hive coordination: claim a region BEFORE editing (collision prevention) ---
    // HIV-P18: a claim is a promise about BYTES, so granting one over bytes the claimer cannot
    // see is the same false success we shut in the outbound direction (HIV-27: a claim whose
    // writes could never leave). The claim itself is unchanged -- callers and every existing
    // suite still get the same boolean -- but it now also starts the fetch the README has been
    // promising, so an agent that claims a path it does not hold actually receives it instead of
    // finding an empty directory and creating the file from scratch.
    claim: (region, intent) => {
      const r = String(region), i = String(intent || 'edit')
      myIntents.set(r, i)
      const held = coordinator.acquire(r, i)
      // Fire-and-forget on purpose: claim's contract is synchronous and changing that would
      // break every caller. Use fetch(path) directly when you need to WAIT for the bytes.
      if (held) {
        try { fetchFile(r).catch(() => {}) } catch { }
        try {
          const full = path.join(ROOT, r)
          const unshared = checkUnshared(full)
          if (unshared) noticeUnsharedOne(r, unshared)
        } catch { }
      }
      return held
    }, // true iff you hold it (my intent recorded either way — it's what my receipts sign)
    // HIV-P18: bring a file the room has but this folder does not. Resolves when the BYTES have
    // landed, and distinguishes "outside the working set" (fetchable) from "not in the room at
    // all" (nothing will ever arrive) -- two states that look identical from an empty directory
    // and have opposite remedies.
    fetch: fetchFile,
    // RELEASE IS A HANDOFF, AND A HANDOFF CAN BE REFUSED.
    //
    // Until the room sets `gate:cmd`, this behaves exactly as it always did and returns
    // {ok:true} — no configured gate means no new failure mode for existing rooms.
    //
    // With a gate set, the check runs in THIS agent's folder and a non-zero exit keeps the claim.
    // That is the whole idea: the file stays visibly yours, so the next agent cannot quietly
    // inherit something that looked finished. It does NOT unsend the bytes — the CRDT syncs
    // continuously and they are already everywhere — it refuses the "I am done, it is yours".
    //
    // `force` exists because abandoning work is legitimate, and it is never silent: it releases,
    // records that it was forced, and says so in the room.
    release: (region, opts = {}) => {
      const r = String(region)
      const g = gateConfig((k) => swarmState.get(k))
      const letGo = () => { myIntents.delete(r); coordinator.release(r) }
      if (!g) { letGo(); return { ok: true, gated: false } }

      if (opts.force) {
        const rec = verdictRecord({ region: r, by: name, cmd: g.cmd, result: null, forced: true, why: opts.why })
        gateResults.set(`${r}|${name}`, rec)
        letGo()
        try { say(forcedMessage({ region: r, by: name, why: opts.why })) } catch { /* chat is not the point */ }
        return { ok: true, gated: true, forced: true }
      }

      // A COMMAND FROM THE ROOM IS DATA (0.14.4 S-1). It runs here only if this machine's person
      // approved this exact command; otherwise the hand-back goes through UNCHECKED -- never refused,
      // or setting a gate would be a way to stop everyone -- and that is recorded and said once.
      const approvedBy = gateApproved({ room, cmd: g.cmd, dir: GATES_DIR })
      if (!approvedBy) {
        gateResults.set(`${r}|${name}`, { ...verdictRecord({ region: r, by: name, cmd: g.cmd, result: null }), skipped: 'not-approved' })
        letGo()
        const said = `${name}|${g.cmd}`
        if (!gateSkipSaid.has(said)) { gateSkipSaid.add(said); try { say(notApprovedLine(name)) } catch { /* chat is not the point */ } }
        return { ok: true, gated: false, gateSkipped: 'not-approved', code: GATE_NOT_APPROVED, cmd: g.cmd, message: notApprovedMessage({ region: r, cmd: g.cmd, dir: ROOT }) }
      }
      const result = runGate({ cmd: g.cmd, cwd: ROOT, timeoutMs: g.timeoutMs })
      gateResults.set(`${r}|${name}`, verdictRecord({ region: r, by: name, cmd: g.cmd, result }))
      if (!result.ok) {
        // The claim is NOT dropped. Saying so in the room is what makes the refusal visible to
        // everyone rather than a private error the holder can ignore.
        try { say(`@all ${name} could not hand back ${r}: the gate failed (exit ${result.code}). Still held.`) } catch { /* ignore */ }
        return { ok: false, gated: true, code: result.timedOut ? 'Q491' : 'Q490', result, message: refusalMessage({ region: r, cmd: g.cmd, result }) }
      }
      letGo()
      return { ok: true, gated: true, result }
    },
    /** The verdicts recorded for a path, by peer. Read this before building on someone's file. */
    gateVerdicts: (region) => {
      const out = {}
      const pre = String(region) + '|'
      gateResults.forEach((v, k) => { if (k.startsWith(pre)) out[k.slice(pre.length)] = v })
      return out
    },
    /** The room's gate, or null. Exposed so a client can say what it is about to be judged by. */
    gate: () => gateConfig((k) => swarmState.get(k)),
    // THE LOCK YOU MAY WRITE BEHIND. `claim()` answers from this replica alone, so under real
    // concurrency it says yes to everyone (see hive-coord.js). This waits for the claim to
    // round-trip through the relay -- the only place the room is actually serialised -- and then
    // asks who the converged map says holds it. Exactly one caller gets true.
    //
    // The loser has nothing to release: the winner's entry replaced its own under last-writer-
    // wins on the same key, so conceding is just returning false.
    claimSettled: async (region, intent, waitMs = 900) => {
      const r = String(region), i = String(intent || 'edit')
      myIntents.set(r, i)
      if (!coordinator.acquire(r, i)) return false          // someone already visibly holds it
      await new Promise((res) => setTimeout(res, Math.max(200, waitMs)))
      const holder = coordinator.sense(r)
      if (holder && holder.by === name) return true
      myIntents.delete(r)
      return false
    },
    senseClaim: (region) => coordinator.sense(String(region)), // the live claim on a region, or null
    whyNotShared,        // '' if edits to this path reach the room, else why they would not (HIV-27)
    claimsBoard: () => coordinator.board(),                     // everything currently claimed
    // --- intent-aware fork resolution: any agent may judge; the medium validates ---
    forkInfo,            // the active fork on a file as a resolvable object (base + versions + signed intents), or null
    resolveFork,         // propose the reconciled file; ICR-validated (parse + dangling) before it lands, refused otherwise
    edit: editFile,      // first-class authored write: intent + transition stamped race-free, then normal reconcile
    editLines,           // hive_edit old/new: whole lines found once in the room's copy, which is then the base
    // --- non-writer review & approval ---
    review,
    reviews: getReviews,
    reviewStatus: getReviewStatus,
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
        const hv = (prev.hv === VERSION_LABEL || u.hv === VERSION_LABEL)
          ? VERSION_LABEL
          : ((prev.listener && !u.listener && u.hv) || (!prev.listener && u.listener && prev.hv) || u.hv || prev.hv)
        seen.set(u.name, {
          ...prev,
          ...u,
          hv,
          editing: u.editing || prev.editing,
          owner: u.owner || prev.owner,
          passive: !!(u.passive || prev.passive),
          listener: !!(u.listener || prev.listener) || undefined,
          app: u.app || prev.app || undefined
        })
      }
      return [...seen.values()]
    },
    // ANOTHER PARTICIPANT ALREADY USING THIS NAME. Measured 3 Oct 2026: a second agent joined as
    // "Claude" beside the first, was told "others here: none yet", and BOTH were then told
    // "claimed x.js -- it's yours"; the second one's write landed in the first one's folder while
    // the first held the file. hive_members showed a single Claude. (The same thing once fused a
    // file to 32,038 lines between two agents called Hermes.) Not counted: this connection, a
    // listener (it runs under its agent's name on purpose), this same agent a moment ago in this
    // same folder (same iid), and a person in a second window when this is a person too. A state
    // with no iid is an older build that cannot say, so it counts.
    sameNameElsewhere: () => {
      const me = provider.awareness.clientID
      const lc = String(name).toLowerCase()
      const out = []
      for (const [id, s] of provider.awareness.getStates()) {
        const u = s && s.user
        if (id === me || !u || !u.name || String(u.name).toLowerCase() !== lc) continue
        if (u.listener || u.iid === IID) continue
        if (kind === 'human' && u.kind === 'human') continue
        out.push({ name: u.name, kind: u.kind, owner: u.owner, app: u.app, joined: u.joined, clientID: id })
      }
      return out
    },
    // Live connection state. An agent parked on hive_wait has no way to tell a quiet
    // room from a dead socket, so it guesses -- and the guess it reaches for is
    // hive_join, which tears the session down and rebuilds it (see hive-mcp.js: join
    // calls stop() first). That turns one recoverable blip into a real detach, and it
    // runs the rejoin path that can clobber local edits. The provider already
    // reconnects on its own with backoff, so the agent never needs to act; it just
    // needs to be told. `connected` is the room socket; `files` counts per-file
    // sockets, which are the ones that actually carry content.
    status: () => {
      let synced = 0
      for (const e of fileDocs.values()) if (e.synced) synced++
      // `notSyncing` is the number the caller actually needs when something is wrong: files
      // whose own socket the relay refused. They are not slow, they are not arriving, and
      // until they do they read as empty. filesSynced alone shows a shortfall but not a cause.
      const notSyncing = [...refusedFiles.keys()].filter((r) => { const e = fileDocs.get(r); return e && !e.synced })
      // HIV-P14. THE FULL-HOUSE LIE.
      //
      // `files` and `filesSynced` both counted OPEN docs, so a client holding eight of the
      // room's forty files reported "filesSynced 8/8" -- a complete set. Measured 21 Sep 2026:
      // a second agent joined a 40-file room, received 7, stayed at 7 for a full minute, and
      // reported 8/8. Its manifest listed all forty the whole time.
      //
      // The bounded working set is deliberate and correct -- one socket per file against a 512
      // ceiling is the wall, and tests/open-file-cap-test.mjs documents the trade rather than
      // hiding it: "a file outside the working set does not arrive until something touches it."
      // What that header does not cover is that FOR AN AGENT, NOTHING EVER TOUCHES IT. An agent
      // decides what exists by reading its folder; a file it cannot see is a file it believes
      // does not exist, so it writes one from scratch. Measured consequence, same probe: agent B
      // created mod039.js, and agent A's copy ended up holding two const declarations of the
      // same name -- invalid code, in someone else's folder, from B doing the only reasonable
      // thing available to it.
      //
      // So the trade stays and the reporting changes. `files` keeps meaning open docs, because
      // tests/open-file-cap-test.mjs:71 pins it as the proof the cap is respected. What is added
      // is the pair that was missing: what the ROOM has, and what this client actually HOLDS.
      flushRoomDoc()
      const roomFiles = (() => { try { return [...manifest.keys()].filter((r) => canOpen(r)).length } catch { return 0 } })()
      // One directory walk, not one existsSync per file: that loop cost 292 ms a call in a
      // 1,000-file room (dev machine) and blocked the loop throughout. walk() reads a directory
      // per call; only a path the walk did not list (not on disk yet, or ignored since it was
      // added) is still checked on its own, so the count means exactly what it meant before.
      const held = (() => {
        let n = 0
        try {
          const onDisk = new Set(walk(ROOT).map(rel))
          for (const r of manifest.keys()) { if (canOpen(r) && !collided.has(r) && (onDisk.has(r) || fs.existsSync(path.join(ROOT, r)))) n++ }
        } catch { }
        return n
      })()
      return {
        connected: !!provider.wsconnected,
        connecting: !!provider.wsconnecting,
        files: fileDocs.size,
        filesSynced: synced,
        // The honest pair. `filesHeld` of `roomFiles` is the number a joiner needs, and the one
        // that says 7 of 40 where filesSynced said 8 of 8.
        roomFiles,
        filesHeld: held,
        filesMissing: Math.max(0, roomFiles - held),
        notSyncing: notSyncing.length,
        notSyncingFiles: notSyncing.slice(0, 20),
        unsharedFiles: [...unsharedWarned.entries()].map(([p, info]) => ({
          path: p,
          reason: info.reason,
          size: info.size,
        })),
        // The working set and its bound. `openCap` x agents must stay under the relay's
        // maxConnsTotal, and `evicted` climbing steadily means the cap is too small for
        // how this room actually works — both are things an operator can only act on if
        // they can see them.
        openCap: maxOpen(),
        newWaiting: newRemote.size,
        // 'mux' = every file on this client's one socket; 'socket' = a socket per file.
        transport: fileTransport.mode,
        evicted,
        scanInterval,
        ...(folderLost ? { folderLost: folderLost.message } : {}),
        ...(unwritable.size ? { unwritable: [...unwritable].map(([p, code]) => ({ path: p, code })) } : {}),
        ...(withheldNow().length ? { withheld: withheldNow() } : {}),
        ...(collided.size ? { collided: [...collided.entries()].map(([p, info]) => ({ path: p, with: info.with })) } : {}),
      }
    },
    unshared: () => [...unsharedWarned.entries()].map(([p, info]) => ({ path: p, reason: info.reason, size: info.size })),
    // The room is told when a change cannot be written here, but in this participant's own name, and
    // an agent is never handed its own lines. This is how its tools tell it instead.
    unwritable: () => [...unwritable].map(([p, code]) => ({ path: p, code })),
    // Files held here because they contain a key: path, kind, line. Never the key.
    withheld: () => withheldNow(),
    collided: () => [...collided.entries()].map(([p, info]) => ({ path: p, with: info.with })),
    _fileSnapSize: (r) => fileDocs.get(r)?.snap?.size || 0,
    _fileSnaps: (r) => [...(fileDocs.get(r)?.snap?.values() || [])],
    _fileDoc: (r) => fileDocs.get(r),
    _fileText: (r) => fileDocs.get(r)?.text?.toString() || '',
    _watcher: () => watcher,
    _scanInterval: () => scanInterval,
    // Just the two booleans hive_say, hive_check/hive_wait and hive_delivered need on every call.
    // status() also counts filesHeld, one existsSync per file in the room -- 1,000 on a 1,000-file
    // room, every call; in one profile 0.8 s of a 12 s publish went to polling status() alone.
    // ...plus folderLost, because the agent learns its folder is gone only where it is looking.
    connection: () => ({ connected: !!provider.wsconnected, connecting: !!provider.wsconnecting, ...(folderLost ? { folderLost: folderLost.message } : {}) }),
    _openTurns: () => openTurns,
    _scanCount: () => scanCount,
    stop: stopAll,
    leave,     // async: hand pending work over, wait for the relay to accept it, then stop (0.14.3 P0-1)
    whenSent,  // async (file, ms): has the relay accepted this file's local changes yet?
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
