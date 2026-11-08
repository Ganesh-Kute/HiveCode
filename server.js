// Relay server — the "meeting point" in the middle.
// It holds no truth of its own. It just passes CRDT updates between
// everyone connected to the same room. Humans and AI agents are equal here.
//
// Run this on any machine both teammates can reach (a cheap VPS, Railway,
// Fly.io, even a home PC with a tunnel). Everyone connects to it by URL.
//
// Two production niceties (both opt-in via env, so local dev is unchanged):
//   - KEEP-WARM: if RENDER_EXTERNAL_URL (or KEEPALIVE_URL) is set, the relay
//     pings its own public URL every ~10 min so a free-tier host never sleeps —
//     no more ~30s cold-start on the first join.
//   - PERSISTENCE: if HIVE_PERSIST_DIR is set, each room's CRDT state is saved
//     to disk (debounced) and reloaded on restart, so a session survives a relay
//     restart even if everyone was disconnected. (No native deps — plain files.)

import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { verifyLicense } from './license-check.js'
import { isMcpRequest, handleMcpRequest } from './remote-mcp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { createRequire } from 'module'
import { WebSocketServer } from 'ws'
// y-websocket v2's server half, kept in-repo: the client moved to v3, which ships no server code.
// See the header of vendor/y-websocket/utils.cjs for why it is CommonJS and why it is here.
import { setupWSConnection, setPersistence, getYDoc, docs as yDocs } from './vendor/y-websocket/utils.cjs'
import {
  LIMITS, TIERS, limitsFor, admitConnection, noteConnectionOpened, noteConnectionClosed,
  admitChannel, noteChannelOpened, noteChannelClosed,
  attachRateLimit, noteDocBytes, docOverCap, setDocBytes, forgetDoc, stats as limitStats,
  recordUsage, usageFor,
} from './limits.js'
import * as meter from './usage-meter.js'
// ONE SOCKET PER PARTICIPANT: the wire format and the session that serves it. Static imports, so
// scripts/build-relay.mjs puts both in the published relay.
import { MUX_PREFIX, MUX_VERSION } from './hive-mux-proto.js'
import { POLL_PREFIX, POLL_VERSION } from './hive-poll-proto.js'
import { makePollHandler } from './relay-poll.js'
import { VERSION, BUILD } from './hive-version.js'
import { serveMux } from './relay-mux.js'
import { STATIC, staticFile } from './relay-static.js'
// CRITICAL: use the SAME Yjs instance as y-websocket's server utils (which are CJS
// and require('yjs')). An ESM `import * as Y from 'yjs'` loads a SECOND copy of the
// library; calling that copy's applyUpdate on a doc created by the CJS copy (as the
// persistence bindState does) corrupts the doc's internal store — after a snapshot
// reload, every client update that touches the loaded structs throws inside
// integrateStructs and is silently DROPPED. Symptom in production: a room reloaded
// from a snapshot "eats" ledger receipts / edits and rolls clients back. (yjs#438)
const Y = createRequire(import.meta.url)('yjs')

// THE DOC SIZE COUNTER ONLY GROWS. limits.js noteDocBytes adds every write and nothing subtracts, so
// a doc that is rewritten reads as larger than it is: a 5 MB image saved twice is 10 MB to the
// counter, and on the free tier (8 MB a doc) its second version was refused with Q435 while the doc
// held 5 MB; a long-occupied room's chat and claims add up the same way. Before refusing, measure
// what the doc really holds and decide on that -- at most once a minute per doc, because encoding a
// large doc on every write is the cost the counter exists to avoid.
const REMEASURE_MS = process.env.HIVE_DOC_REMEASURE_MS !== undefined ? Number(process.env.HIVE_DOC_REMEASURE_MS) : 60000
const lastMeasured = new Map() // docName -> when its real size was last measured
function overCapAfterMeasuring(room, tier) {
  if (!docOverCap(room, tier)) return false
  const now = Date.now()
  if (now - (lastMeasured.get(room) || 0) < REMEASURE_MS) return true
  lastMeasured.set(room, now)
  try { setDocBytes(room, Y.encodeStateAsUpdate(getYDoc(room)).length) } catch { return true }
  return docOverCap(room, tier)
}
import { verify, scopeForRoom, baseRoomOf, pathOf, pathAllowed, writeAllowed, isSafeRelPath, decodeUnsafe, keyFingerprint, roomFingerprint } from './token.js'
import { verifyReceipt, contentHash, headOk, contentHealth } from './substrate.js'
import { makeGovernor, GOV_ORIGIN } from './governor.js'
import * as decoding from 'lib0/decoding'

// Enforce a read-only connection: drop the client's inbound SYNC writes (sync
// step2 + update) so they can never mutate shared state, while still letting it
// --- USAGE LIMITS (always on) -----------------------------------------------
// Installed FIRST, before every other gate, and for one reason: the read-only filter, the
// claim gate and the provenance guard all do real work per message (decode, map lookups,
// signature checks). If a flood reaches them, the limits have already failed. This wrapper
// runs before y-websocket's handler is registered, so a refused frame costs a length check.
//
// OVER THE RATE, A FRAME WAITS. IT IS NEVER DROPPED (27 Sep 2026). This used to drop it, and a
// dropped Yjs update is not one lost message but a GAP: every later update from that client
// builds on it, so the relay parks them all as pending and the document silently stops moving
// for that client until it reconnects. A 1,000-file first publish on the free tier froze the
// room's file list at 305 entries that way, with every socket reporting healthy. Now the frame
// waits in order, the connection stops being READ (so TCP pushes back on the sender), and the
// queue drains at the tier's rate: the same budget, nothing lost. What can pile up is what
// arrived between pause() and the socket actually stopping -- about one read -- and the
// backstop closes a connection that keeps pushing anyway, which is lossless too: the reconnect
// resyncs everything the relay lacks.
//
// A doc past its size cap keeps serving reads and refuses writes: closing the socket would
// take the client's unsaved work with it.
const HOLD_TICK_MS = 50
const HOLD_MAX_FRAMES = Number(process.env.HIVE_HOLD_MAX_FRAMES || 20000)
function installUsageLimits(conn) {
  const room = (conn._hive && conn._hive.room) || 'default'
  const who = (conn._hive && conn._hive.identity && conn._hive.identity.name) || 'a client'
  // The tier is decided at the handshake from the licence RECORD and carried on the
  // connection. A free room and a 20-seat Pro room get genuinely different ceilings; before
  // this they got identical ones, which gave the free tier away and made the paying customer
  // the first to notice a shared limit.
  const tier = (conn._hive && conn._hive.tier) || null
  const account = (conn._hive && conn._hive.account) || null
  const limiter = attachRateLimit(conn, tier)
  const told = new Map() // Q-code -> times said on this connection
  // A REFUSED WRITE IS TOLD TO THE WRITER, IN THE ROOM (27 Sep 2026). This only ever reached the
  // relay's own log, so a client whose writes were refused -- a file at its size cap (Q435), a free
  // workspace past its allowance (Q436), an oversized frame (Q433) -- learned nothing: the file just
  // stopped moving for everyone, and the one message saying what to do was printed where only the
  // operator could read it. `toRoom` posts it to the room chat addressed to the writer, so it lands
  // as their mail; a system notice opens no reply debt. A wait over the rate (Q432/Q434) loses
  // nothing, so it stays in the log.
  const tell = (reason, { toRoom = false } = {}) => {
    // At most twice per code per connection. A tight loop trips a limit hundreds of times and a
    // message per refusal would make the relay the flooder; per CODE, so a burst of waits cannot
    // use up the announcement of a refusal that follows it.
    const code = (/^Q\d{3}/.exec(reason) || ['other'])[0]
    const n = told.get(code) || 0
    if (n >= 2) return
    told.set(code, n + 1)
    try { console.warn(`[relay] ${who} in ${baseRoomOf(room)}: ${reason}`) } catch { }
    try { audit('rate-limit', { room, identity: who, reason }) } catch { }
    if (toRoom) {
      const name = conn._hive && conn._hive.identity && conn._hive.identity.name
      const at = name && name !== 'anon' && /^[\w-]+$/.test(name) ? `@${name} ` : ''
      try { postNoticeText(baseRoomOf(room), `${at}${reason}`) } catch { }
    }
  }
  const realOn = conn.on.bind(conn)
  // One queue per connection, in arrival order. Only one 'message' handler is ever registered
  // through this wrapper (y-websocket's, via the gates stacked on top of it).
  const held = []
  let heldBytes = 0
  let drainTimer = null
  let paused = false
  let dead = false
  const holdMaxBytes = 2 * ((tier && tier.maxFrameBytes) || LIMITS.maxFrameBytes)
  const pauseReads = () => {
    if (paused || typeof conn.pause !== 'function') return
    paused = true
    try { conn.pause() } catch { }
  }
  const resumeReads = () => {
    if (!paused) return
    paused = false
    try { conn.resume() } catch { }
  }
  realOn('close', () => {
    dead = true
    held.length = 0; heldBytes = 0
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
  })
  conn.on = (event, handler) => {
    if (event !== 'message') return realOn(event, handler)
    const drain = () => {
      drainTimer = null
      while (held.length && !dead) {
        const h = held[0]
        const bad = limiter.check(h.len)
        if (bad && bad.hold) { drainTimer = setTimeout(drain, Math.max(HOLD_TICK_MS, bad.retryMs)); return }
        held.shift(); heldBytes -= h.len
        if (bad) { tell(bad.reason, { toRoom: true }); continue }
        // From a timer, so a throw here would take the whole relay down, not one frame.
        try { admit(h.data, h.rest, h.len) } catch (e) { try { console.error(`[relay] a held frame failed in ${baseRoomOf(room)}: ${e && e.message}`) } catch { } }
      }
      resumeReads()
    }
    const admit = (data, rest, len) => {
      // Only WRITES are refused past the doc cap; step1/awareness must keep flowing or the
      // client cannot even see the state it is being told it may not grow.
      if (len > 0) {
        let isWrite = false
        try {
          const dec = decoding.createDecoder(new Uint8Array(data))
          if (decoding.readVarUint(dec) === 0) {
            const t = decoding.readVarUint(dec)
            isWrite = (t === 1 || t === 2)
          }
        } catch { /* unparseable -> treat as non-write; the gates below still see it */ }
        if (isWrite) {
          if (overCapAfterMeasuring(room, tier)) {
            const cap = (tier && tier.maxDocBytes) || LIMITS.maxDocBytes
            tell(`Q435 ${pathOf(room) || 'this room'} has reached the ${cap >= 1048576 ? Math.round(cap / 1048576) + " MB" : Math.ceil(cap / 1024) + " KB"} size limit${tier ? ` for the ${tier.tier} tier` : ''}; writes refused, reads still served`, { toRoom: true })
            return
          }
          // THE AUTO-LOCK. A free account past its monthly allowance stops being able to
          // write and keeps being able to read, which is the difference between "upgrade to
          // continue" and "we deleted your workspace". Paid accounts are never checked here
          // -- their ceiling is the tier's, above -- and an unreachable meter never locks
          // anyone (usage-meter.js, decision 1).
          if (tier && tier.tier === 'free' && meter.isOverQuota(account)) {
            // Points at an ADDRESS, not a page. It named hivecode.vercel.app/pricing, which was
            // both the wrong domain (the site is hivecode.getgrm.tech) and a page that has since
            // been retired -- so the one message a blocked customer reads sent them to a 404.
            // An email address cannot go stale the way a route can.
            tell(`Q436 this workspace has used its free monthly allowance (${Math.round(meter.FREE_PERIOD.writeBytes / 1048576)} MB of writes). Reads still work. Email support@getgrm.tech to lift the limit.`, { toRoom: true })
            return
          }
          noteDocBytes(room, len)
          limiter.noteWrite(len) // separates "wrote" from "read" in the per-agent usage
          meter.note(account, { writes: 1, writeBytes: len, msgs: 1, bytes: len })
          // Warn BEFORE the wall, once per account per month. A limit that arrives with no
          // notice reads as a fault, and the customer's first conclusion is "it broke".
          if (tier && tier.tier === 'free') {
            const warn = meter.warningFor(account)
            if (warn) {
              try { console.warn(`[relay] ${warn}`) } catch { }
              try { audit('usage-warning', { room: baseRoomOf(room), account, message: warn }) } catch { }
              try { postNoticeText(baseRoomOf(room), warn) } catch { }
            }
          }
        }
      }
      return handler(data, ...rest)
    }
    return realOn('message', (data, ...rest) => {
      if (dead) return
      const len = data && (data.byteLength ?? data.length) || 0
      if (!held.length) {
        const bad = limiter.check(len)
        if (!bad) return admit(data, rest, len)
        if (!bad.hold) { tell(bad.reason, { toRoom: true }); return }
        tell(`${bad.reason}; reading paused until it drains, nothing dropped`)
        drainTimer = setTimeout(drain, Math.max(HOLD_TICK_MS, bad.retryMs))
      }
      // Behind whatever is already waiting, even if this frame alone would fit: order is the
      // whole point, since a later update admitted ahead of an earlier one is the same gap.
      held.push({ data, rest, len }); heldBytes += len
      limiter.noteThrottled()
      pauseReads()
      if (held.length > HOLD_MAX_FRAMES || heldBytes > holdMaxBytes) {
        // Still pushing past a paused read: stop holding and let the client resync.
        dead = true
        held.length = 0; heldBytes = 0
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
        try { console.warn(`[relay] ${who} in ${baseRoomOf(room)}: Q432 kept sending past a paused read; closing so it resyncs`) } catch { }
        try { audit('rate-limit-close', { room, identity: who, held: HOLD_MAX_FRAMES }) } catch { }
        // terminate, not close: a close handshake needs the client's reply READ, and this
        // socket is paused, so close() would leave it half-open for ws's 30 s timeout with the
        // client neither connected nor reconnecting.
        resumeReads()
        try { if (typeof conn.terminate === 'function') conn.terminate(); else conn.close(1013, 'Q432 over the rate; reconnect to resync') } catch { }
      }
    })
  }
}

// receive state (sync step1) and presence (awareness). We wrap conn.on so that
// the message handler y-websocket registers next is filtered.
function makeReadOnly(conn) {
  const realOn = conn.on.bind(conn)
  conn.on = (event, handler) => {
    if (event !== 'message') return realOn(event, handler)
    return realOn('message', (data, ...rest) => {
      try {
        const dec = decoding.createDecoder(new Uint8Array(data))
        if (decoding.readVarUint(dec) === 0) { // 0 = sync
          const syncType = decoding.readVarUint(dec)
          if (syncType === 1 || syncType === 2) return // 1=step2, 2=update -> a WRITE; drop it
        }
      } catch { /* unparseable -> let it through */ }
      return handler(data, ...rest)
    })
  }
}

// --- DCO / claim WRITE ENFORCEMENT (opt-in, off by default) -----------------
// The last mile of DCO: DCO locks the coordination TOOLS in the agent's own MCP
// server ("you shouldn't"); this makes the RELAY drop a file write when the writer
// is globally LOCKED or the file is claimed by someone else ("you can't"). It reads
// the live swarm_state + claims maps from the project's BASE doc and gates writes to
// per-file rooms only. Requires HIVE_AUTH_MODE=required (needs a known identity).
// HIVE_ENFORCE_CLAIMS: off (default) | warn (log only) | block (drop the write).
// NOTE: this is NOT actually gated on HIVE_AUTH_MODE anywhere -- installWriteGate is
// wired to ENFORCE_CLAIMS alone. Enforcement can therefore run on an OPEN relay, where
// identities are self-declared, which is why authorize() refuses to honour a declared
// kind of 'human' (the value this function's exemption above keys on).
const ENFORCE_CLAIMS = (process.env.HIVE_ENFORCE_CLAIMS || 'off').toLowerCase()

// --- THE GOVERNOR: relay-side stop button and spend caps ---------------------------------
// ON by default, unlike every other gate here, and that is deliberate. The others change how
// ordinary work behaves, so opting in is right. This one does nothing at all until a human
// pauses somebody or sets a budget -- and the moment either happens, it has to be real. A stop
// button that depends on an env var somebody forgot to set is the same as no stop button, and
// its absence is exactly the sort of thing nobody discovers until the night it mattered.
const GOVERNOR = (process.env.HIVE_GOVERNOR || 'on').toLowerCase()
// `strict` is per ROOM, not per relay: a secured hs_ room carries token-verified identities even
// on an otherwise open relay, so the hard guarantee is available there without locking the relay.
const gov = makeGovernor({ audit, strict: (room) => AUTH_MODE === 'required' || !!roomFingerprint(baseRoomOf(room)) })
// A `minutes` budget must fire on wall clock, not on the next write: an agent stuck in a loop
// that has stopped writing has not stopped spending.
if (GOVERNOR !== 'off') setInterval(() => { try { gov.sweep() } catch { /* never kill the relay */ } }, 15000).unref()

function isSyncWrite(data) {
  try {
    const dec = decoding.createDecoder(new Uint8Array(data))
    if (decoding.readVarUint(dec) !== 0) return false // 0 = sync message
    const t = decoding.readVarUint(dec)
    return t === 1 || t === 2 // 1=step2, 2=update  -> a WRITE
  } catch { return false }
}

// y-websocket's client handshake ALWAYS answers syncStep1 with a syncStep2, even when the client
// has nothing to send ([0, 0]) or only structs + deletions the relay's doc already holds. Note
// that Y.diffUpdate strips already-known structs but leaves the delete set untouched, so any file
// that has ever had a deletion still carries its historical delete set on reconnect. Called ONLY
// after writeBlockReason(conn) matches, so the common unclaimed write path pays zero diff cost.
function isNoopSyncWrite(data, conn) {
  try {
    const dec = decoding.createDecoder(new Uint8Array(data))
    if (decoding.readVarUint(dec) !== 0) return false
    const t = decoding.readVarUint(dec)
    if (t !== 1 && t !== 2) return false
    const u = decoding.readVarUint8Array(dec)
    if (u.length === 2 && u[0] === 0 && u[1] === 0) return true
    const room = conn && conn._hive && conn._hive.room
    const doc = room ? yDocs.get(room) : null
    if (!doc) return false
    const d = Y.diffUpdate(u, Y.encodeStateVector(doc))
    if (d.length === 2 && d[0] === 0 && d[1] === 0) return true
    const parsed = Y.decodeUpdate(d)
    if (parsed.structs.length > 0) return false
    const docDs = Y.createDeleteSetFromStructStore(doc.store)
    for (const [client, items] of parsed.ds.clients) {
      const have = docDs.clients.get(client)
      for (const it of items) {
        if (it.len <= 0) continue
        if (!have || !have.some((r) => r.clock <= it.clock && r.clock + r.len >= it.clock + it.len)) return false
      }
    }
    return true
  } catch { return false }
}

// Returns a reason string if this connection's write to its file should be blocked,
// or null to allow. Fail-OPEN on anything unknown (availability > strictness — this
// is coordination, not the access-control gate, which stays fail-closed at handshake).
// Paths the relay refuses to let ANYONE write, and why. This is the half of the path
// registry that a client cannot provide: the client-side gate in hive-mcp.js is only as
// strong as the weakest client in the room, and on 2026-07-29 that stopped being
// hypothetical — FIVE copies of hive-mcp.js were found on one machine, four of them six
// weeks old with no gate in them at all. An old build, an `npx` install, or any client
// that simply does not implement the check bypasses every flag. The relay is the only
// participant no client controls, so it is the only place these can be guarantees.
//
// PERMANENT vs TEMPORARY is the important distinction and it decides queueing:
//   a DCO lock or a claim is TEMPORARY — the write is legitimate and merely early, so
//   queue-and-replay is correct and loses nothing.
//   a restricted PATH is PERMANENT — the write must never land, so it must never be
//   queued. Replaying it later would defeat the whole point.
const PATH_BLOCK = {
  DELETED_UNWRITABLE: 'path had a delete propagate — a write here vanishes or resurrects deleted content',
  CORRUPT: 'path content is unusable in every folder that measured it — publish to a new path',
  DIVERGED: 'peers hold different content for this path — no single truth to write on top of',
  POISONED: 'path is marked poisoned (legacy flag)',
  FROZEN: 'path is frozen by the state machine',
  SUPERSEDED: 'path has been replaced — read it, do not write it',
}

// Returns { reason, permanent } if this connection's write to its file should be blocked,
// or null to allow. Fail-OPEN on anything unknown (availability > strictness — this
// is coordination, not the access-control gate, which stays fail-closed at handshake).
function writeBlockReason(conn) {
  const h = conn._hive
  if (!h || !h.identity || !h.room) return null            // unknown identity -> can't enforce
  // Humans/overseers are exempt -- but ONLY where `human` is a verified claim. On an open relay a
  // real person reads as kind 'unknown' (the relay refuses to honour a self-declared human, or
  // any client could opt out of every gate by saying so), so this exemption does not fire there
  // and a paused participant is paused whoever they are. That is the honest behaviour for a relay
  // that cannot tell a person from an agent, and it is the safe direction: they can release
  // themselves, because mayControl() lets them.
  if (h.identity.kind === 'human') return null
  const filePath = pathOf(h.room)
  if (filePath === null) return null                       // base-room writes (chat/claims/state) never gated
  // THE GOVERNOR. Deliberately AFTER the base-room exemption above: a paused agent must still be
  // able to post to chat, or an agent stopped mid-task has no way to say what state it left
  // things in, and the person who stopped it learns nothing. "Stop working" and "stop talking"
  // are different instructions and only the first one was given. (The control map itself lives in
  // that same ungated base room, which is exactly why the governor guards it separately, by
  // reverting writes from anyone who may not press the button -- see mayControl.)
  //
  // Otherwise this is first among the file checks, because being paused is a property of the
  // WRITER: no claim, unlock or path state can buy a paused agent a write.
  if (GOVERNOR !== 'off' && gov.isPaused(baseRoomOf(h.room), h.identity.name)) {
    return { reason: 'paused by mission control', permanent: false, paused: true }
  }
  let baseDoc
  try { baseDoc = getYDoc(baseRoomOf(h.room)) } catch { return null }
  if (!baseDoc) return null
  const who = h.identity.name
  try {
    const state = baseDoc.getMap('swarm_state')
    // PATH REGISTRY FIRST, and deliberately BEFORE the identity checks: this is a property
    // of the FILE, not of the writer, so being unlocked or holding the claim must not buy
    // anyone a write to a path the room has ruled unwritable.
    const ps = state.get(`path:${filePath}`)
    if (ps && ps !== 'LIVE' && ps !== 'OPEN') {
      // Fail CLOSED on a value this build does not recognise. Somebody set it deliberately,
      // and an incomplete safety registry is more dangerous than none because agents trust
      // it. Guessing "probably fine" is the one answer that cannot be right here.
      return { reason: PATH_BLOCK[ps] || `path is marked "${ps}", which this relay does not recognise`, permanent: true, path: ps }
    }
    if (state.get(`${who}_status`) === 'LOCKED' || state.get(`${who}_locked`) === 'true') return { reason: 'DCO-locked', permanent: false }
    const claim = baseDoc.getMap('claims').get(filePath)
    const live = claim && (!claim.ttl || (claim.at || 0) + claim.ttl > Date.now())
    if (live && claim.by && claim.by !== who) return { reason: `held by ${claim.by}`, permanent: false, holder: claim.by, until: claim.ttl ? (claim.at || 0) + claim.ttl : 0 }
  } catch { return null }
  return null
}

// Dynamic write-gate: like makeReadOnly, but decides per-message against the LIVE
// claims/state instead of a static role fixed at handshake.
//   block — drop a blocked write.
//   queue — HOLD it and replay it (zero-loss) the moment the block clears (claim
//           released / agent unlocked), so no edit is lost, it just lands later.
//   warn  — allow, but log.
const QUEUE_CAP = Number(process.env.HIVE_ENFORCE_QUEUE_CAP || 2000)

function installWriteGate(conn) {
  const realOn = conn.on.bind(conn)
  conn.on = (event, handler) => {
    if (event !== 'message') return realOn(event, handler)
    conn._wgHandler = handler // kept so queued writes can be replayed later
    return realOn('message', (data, ...rest) => {
      if (isSyncWrite(data)) {
        const block = writeBlockReason(conn)
        if (!block) {
          // ACCEPTED. Meter it, and if that was the write that blew the budget, the governor
          // pauses this participant right here -- so the cap is enforced by the same mechanism
          // as the stop button rather than by a second one that could disagree with it.
          if (GOVERNOR !== 'off' && conn._hive && conn._hive.identity) {
            try { gov.note(baseRoomOf(conn._hive.room), conn._hive.identity.name, data.length || data.byteLength || 0) } catch { /* metering must never drop a legal write */ }
          }
        } else if (!isNoopSyncWrite(data, conn)) {
          audit('write-blocked', { room: conn._hive.room, who: conn._hive.identity.name, file: pathOf(conn._hive.room), reason: block.reason, permanent: !!block.permanent, mode: ENFORCE_CLAIMS })
          // A GOVERNOR PAUSE IGNORES THE CLAIM-ENFORCEMENT MODE, AND IT ALWAYS QUEUES.
          //
          // It ignores the mode because `warn` is a defensible setting for claims -- you may want
          // to watch collisions before refusing them -- but there is no reading of "stop that
          // agent" that means "log that it did not stop".
          //
          // It queues rather than drops because these are CRDT ops, not HTTP requests. Dropping
          // one does not refuse an edit; it removes an op that the agent's LATER updates are
          // causally built on, and those arrive referencing something the relay never saw and sit
          // unintegrated forever. The room would silently stop accepting that agent's work even
          // after you resumed it. Holding and replaying is the only way to refuse a write
          // TEMPORARILY without corrupting the history -- and it is also the better promise:
          // being stopped for a minute costs the agent nothing once you let it go.
          const mode = block.paused ? 'queue' : ENFORCE_CLAIMS
          if (mode === 'block') { refusedNotice(conn, block); return } // drop the write
          // A PERMANENT block is never queued. Queueing exists so a legitimate write that
          // arrived early is not lost; a write to an unwritable path is not early, it is
          // wrong, and replaying it when the queue flushes would land exactly the damage the
          // flag exists to prevent. Drop it even in queue mode, and say so in the audit.
          if (mode === 'queue') {
            if (block.permanent) { audit('write-dropped-permanent', { room: conn._hive.room, who: conn._hive.identity.name, file: pathOf(conn._hive.room), reason: block.reason }); refusedNotice(conn, block); return }
            queueWrite(conn, data, rest, block); return // hold + replay later
          }
          // 'warn' falls through (allowed, logged only)
        }
      }
      return handler(data, ...rest)
    })
  }
}

// A HELD OR REFUSED WRITE IS SAID IN THE ROOM. It used to be known only to this process's audit
// log: the writer's own client said "synced" while its edit sat here, the claim holder never heard
// someone was waiting, and on 26 Oct 2026 an agent wrote into another's claimed files for fifteen
// minutes with the first sign being the wrong name on a commit. Names are @-mentioned so the
// writer (and the holder) are woken, not just logged. Said once per hold, not once per keystroke.
function heldSay(conn, text) {
  try {
    const bd = getYDoc(baseRoomOf(conn._hive.room))
    if (bd) bd.getArray('chat').push([{ by: 'relay', kind: 'system', at: new Date().toTimeString().slice(0, 8), text }])
  } catch { /* a notice is never worth failing a write over; the audit line is still written */ }
}
const whyHeld = (block) => (block.holder ? `@${block.holder} holds it` : block.reason)

// A dropped write (block mode, or a path the room has ruled unwritable) is said once per file per
// connection: the writer keeps editing a copy the room will never take, so it has to be told.
function refusedNotice(conn, block) {
  const file = pathOf(conn._hive.room)
  if (!conn._refusedSaid) conn._refusedSaid = new Set()
  if (conn._refusedSaid.has(file)) return
  conn._refusedSaid.add(file)
  heldSay(conn, `⛔ @${conn._hive.identity.name}: your edit to ${file} was refused (${whyHeld(block)}). The room does not have it; your folder does.`)
}

// When the hold is a claim with a ttl, its expiry changes no map, so nothing would ever call
// flushQueue: the edit was held forever. Wake up when it is due instead.
function armExpiry(conn, block) {
  if (conn._wqTimer) { clearTimeout(conn._wqTimer); conn._wqTimer = null }
  if (!block || !block.until) return
  conn._wqTimer = setTimeout(() => { conn._wqTimer = null; flushQueue(conn) }, Math.max(0, block.until - Date.now()) + 250)
  if (conn._wqTimer.unref) conn._wqTimer.unref()
}

// Buffer a blocked write and start watching for the block to clear.
function queueWrite(conn, data, rest, block = {}) {
  if (!conn._wq) { conn._wq = []; attachFlush(conn) }
  const who = conn._hive.identity.name
  const file = pathOf(conn._hive.room)
  if (conn._wq.length >= QUEUE_CAP) {
    audit('write-queue-overflow', { room: conn._hive.room, who, cap: QUEUE_CAP }) // safety valve: drop past the cap
    if (!conn._wqOverflowSaid) { conn._wqOverflowSaid = true; heldSay(conn, `⚠ @${who}: more than ${QUEUE_CAP} edits to ${file} were held, and the ones past that were DROPPED. Your folder still has them.`) }
    return
  }
  conn._wq.push({ data, rest })
  if (conn._wq.length === 1) heldSay(conn, `⏸ @${who}: your edit to ${file} is held: ${whyHeld(block)}. It lands by itself when that clears; keep your copy until then.`)
  armExpiry(conn, block)
}

// Observe the base doc's claims + swarm_state; when either changes, try to flush.
function attachFlush(conn) {
  let baseDoc; try { baseDoc = getYDoc(baseRoomOf(conn._hive.room)) } catch { return }
  if (!baseDoc) return
  const claims = baseDoc.getMap('claims'), state = baseDoc.getMap('swarm_state')
  // `controls` too: a resume must replay the writes held while the agent was paused, or being
  // stopped for a minute silently costs an agent whatever it was in the middle of writing.
  const controls = baseDoc.getMap('controls')
  const onChange = () => flushQueue(conn)
  claims.observe(onChange); state.observe(onChange); controls.observe(onChange)
  conn._wgDetach = () => { try { claims.unobserve(onChange); state.unobserve(onChange); controls.unobserve(onChange) } catch {} }
  if (conn._wqCloseHooked) return
  conn._wqCloseHooked = true
  conn.on('close', () => {
    if (conn._wgDetach) conn._wgDetach()
    if (conn._wqTimer) { clearTimeout(conn._wqTimer); conn._wqTimer = null }
    // Held edits live only on this connection; when it goes, the room never gets them.
    if (conn._wq && conn._wq.length) {
      const who = conn._hive.identity.name
      audit('write-queue-discarded', { room: conn._hive.room, who, count: conn._wq.length })
      heldSay(conn, `⚠ @${who} left before ${pathOf(conn._hive.room)} was free: ${conn._wq.length} held edit(s) were NOT applied to the room. ${who}'s own folder still has them.`)
      conn._wq = []
    }
  })
}

// If the connection is no longer blocked, replay its held writes in order.
function flushQueue(conn) {
  if (!conn._wq || !conn._wq.length) return
  const block = writeBlockReason(conn)
  if (block) { armExpiry(conn, block); return } // still blocked (a renewed claim moves its expiry) — keep holding
  if (conn._wqTimer) { clearTimeout(conn._wqTimer); conn._wqTimer = null }
  // null, not []: the observers are detached below, so the NEXT hold on this connection must
  // attach them again. Left as [] (truthy), a second hold was never flushed by a release.
  const q = conn._wq; conn._wq = null
  const who = conn._hive.identity.name
  audit('write-queue-flush', { room: conn._hive.room, who, count: q.length })
  for (const { data, rest } of q) { try { conn._wgHandler(data, ...rest) } catch {} }
  heldSay(conn, `▶ ${who}'s held edit(s) to ${pathOf(conn._hive.room)} landed (${q.length}).`)
  if (conn._wgDetach) conn._wgDetach()
}

// --- SUBSTRATE PROVENANCE ENFORCEMENT (opt-in, off by default) ---------------
// The relay is the one place every write converges and no client controls it — so
// it is where provenance (invariant I1) becomes enforced rather than advisory. Each
// file's own doc carries a `ledger` (append-only signed receipts) written by clients.
// The relay verifies them SERVER-SIDE:
//   audit  — verify every receipt; LOG any that fail (forged/tampered) + surface it.
//   strict — additionally REMOVE invalid receipts from the shared ledger, so forged
//            provenance physically cannot persist in the medium. (Sound: the relay
//            owns the doc; a provably-bad signature is deleted, not arbitrated.)
// Content with no backing verified receipt is reported (best-effort, debounced) but
// NOT rolled back — that would fight the CRDT; detection is surfaced to the Control
// Room instead. HIVE_PROVENANCE: off (default) | audit | strict.
// ── service notice ────────────────────────────────────────────────────────────────────
// One message into the base room's chat when somebody joins. This is the only place that
// reaches every client at once: the browser control room, the VS Code extension and the
// MCP agents all read the same `chat` array, so a notice posted here lands wherever the
// user actually is instead of in one client nobody has open.
//
// The text lives in HIVE_NOTICE so it can be set, changed or cleared on the host without
// a redeploy. Unset means nothing is posted, which is the correct default -- a relay that
// announces something on every connection is a relay people mute.
const NOTICE = (process.env.HIVE_NOTICE || '').trim()
const noticedRooms = new Set()

function postNotice(room) {
  if (!NOTICE) return
  const base = baseRoomOf(room)
  if (noticedRooms.has(base)) return          // once per room per process, not once per socket
  noticedRooms.add(base)
  try {
    const bd = getYDoc(base)
    if (!bd) return
    const chat = bd.getArray('chat')
    // Never repeat a notice the room already carries. The relay restarts (a free host
    // sleeps and wakes), and without this a user who reconnects after each restart
    // collects the same message over and over -- which reads as a broken product.
    const recent = chat.toArray().slice(-50)
    if (recent.some((m) => m && m.by === 'relay' && m.text === NOTICE)) return
    chat.push([{ by: 'relay', kind: 'system', at: new Date().toTimeString().slice(0, 8), text: NOTICE }])
    audit('notice-posted', { room: base })
  } catch { /* base doc unavailable -- a notice is never worth failing a connection over */ }
}

/**
 * Post one arbitrary system line into a room's chat, deduplicated against what is already
 * there. Separate from postNotice() above, which serves a single configured NOTICE string
 * and short-circuits when none is set.
 *
 * The dedup is the important part, and it is the same lesson postNotice already carries: a
 * free host sleeps and wakes, and without this a customer who reconnects collects the same
 * message again and again -- which reads as a broken product rather than a helpful warning.
 */
function postNoticeText(baseRoom, textLine) {
  if (!textLine) return
  try {
    const bd = getYDoc(baseRoom)
    if (!bd) return
    const chat = bd.getArray('chat')
    const recent = chat.toArray().slice(-50)
    if (recent.some((m) => m && m.by === 'relay' && m.text === textLine)) return
    chat.push([{ by: 'relay', kind: 'system', at: new Date().toTimeString().slice(0, 8), text: textLine }])
  } catch { /* a notice is never worth failing a write over */ }
}

const PROVENANCE = (process.env.HIVE_PROVENANCE || 'off').toLowerCase()

function installProvenanceGuard(room) {
  if (PROVENANCE === 'off') return
  const filePath = pathOf(room)
  if (filePath === null) return                     // only per-file rooms carry content + ledger
  let fdoc; try { fdoc = getYDoc(room) } catch { return }
  if (!fdoc || fdoc._hiveProv) return               // one guard per file doc
  fdoc._hiveProv = true
  const ledger = fdoc.getArray('ledger')
  const content = fdoc.getText('content')
  const baseRoom = baseRoomOf(room)
  let lastNote = ''

  const note = (kind, detail = {}) => {
    audit('provenance-' + kind, { room, file: filePath, ...detail })
    const sig = kind + ':' + (detail.hash || detail.count || '')
    if (sig === lastNote) return                     // dedupe repeated notes for the same violation
    lastNote = sig
    try {
      const bd = getYDoc(baseRoom)
      if (bd) bd.getArray('chat').push([{ by: 'relay', kind: 'system', at: new Date().toTimeString().slice(0, 8),
        text: `⛔ provenance ${kind} on ${filePath}${detail.author ? ` — author ${String(detail.author).slice(0, 10)}…` : ''}${PROVENANCE === 'strict' && kind === 'forged-receipt' ? ' (removed)' : ''}` }])
    } catch { /* base doc unavailable — the audit log still has it */ }
  }

  // Verify every receipt; in strict mode delete the invalid ones (highest index first
  // so earlier positions stay valid during deletion).
  const checkLedger = () => {
    const rs = ledger.toArray()
    const bad = []
    for (let i = 0; i < rs.length; i++) if (!verifyReceipt(rs[i]).ok) bad.push(i)
    if (!bad.length) return
    note('forged-receipt', { count: bad.length, author: rs[bad[0]] && rs[bad[0]].author })
    if (PROVENANCE === 'strict') fdoc.transact(() => { for (let j = bad.length - 1; j >= 0; j--) ledger.delete(bad[j], 1) })
  }

  // Best-effort: after edits settle, flag content that no verified receipt covers.
  // Debounced (edits and their receipts arrive as separate updates) and detection-only.
  let t = null
  const checkContent = () => {
    if (t) return
    t = setTimeout(() => {
      t = null
      const text = content.toString()
      if (!text) return
      if (!ledger.length) return  // this room isn't using provenance (no receipts) — stay silent, don't flag normal rooms
      const h = contentHash(text)
      const covered = ledger.toArray().some((r) => r.contentHash === h && verifyReceipt(r).ok)
      if (!covered) note('unattributed-content', { hash: h.slice(0, 12) })
    }, 4000)
  }

  // CONTENT AUTHORITY: the file's authoritative `head` (its attested current content)
  // must always be a VERIFIED, NON-REGRESSING attestation. The relay holds the last
  // head it accepted; if a new head is forged, doesn't attest its own text, or parses
  // WORSE than the last good one, strict mode reverts to the last good head — so the
  // official current version of a file can never be forged or made more broken.
  const head = fdoc.getMap('head')
  let lastGood = null
  const checkHead = () => {
    const h = head.get('cur')
    if (!h) return
    const struct = headOk(h)
    const prevHealth = lastGood ? contentHealth(lastGood.text, filePath) : 0
    const regresses = struct.ok && contentHealth(h.text, filePath) > prevHealth
    if (struct.ok && !regresses) { lastGood = h; return }             // accept: verified + no worse
    note(struct.ok ? 'head-regression' : 'head-forged', { author: h.receipt && h.receipt.author })
    if (PROVENANCE === 'strict' && lastGood) fdoc.transact(() => head.set('cur', lastGood)) // restore last verified head
  }

  ledger.observe(checkLedger)
  content.observe(checkContent)
  head.observe(checkHead)
  checkLedger()
  checkHead()
}

// --- RELAY-SIDE CLAIM DELETE BACKSTOP -----------------------------------------
// If a client bypasses settleLocalDeletes (e.g. an older client, extension, or script)
// and deletes a manifest key for a file held by someone else, the relay restores the key
// via compensating write, audits the event, and announces to the room.
export const CLAIM_ORIGIN = 'relay-claim-enforce'

function installManifestDeleteGuard(baseRoom) {
  if (ENFORCE_CLAIMS === 'off') return
  let baseDoc
  try { baseDoc = getYDoc(baseRoom) } catch { return }
  if (!baseDoc || baseDoc._hiveManifestGuard) return
  baseDoc._hiveManifestGuard = true

  const manifest = baseDoc.getMap('manifest')
  const claims = baseDoc.getMap('claims')

  const txnClaimsChanges = new WeakMap()
  const txnManifestDeletes = new WeakMap()

  claims.observe((event, tr) => {
    if (tr && (tr.origin === CLAIM_ORIGIN || tr.origin === GOV_ORIGIN)) return
    txnClaimsChanges.set(tr, event.changes.keys)
  })

  manifest.observe((event, tr) => {
    if (tr && (tr.origin === CLAIM_ORIGIN || tr.origin === GOV_ORIGIN)) return
    const deletes = []
    for (const [key, change] of event.changes.keys) {
      if (change.action === 'delete') {
        deletes.push({ key, oldValue: change.oldValue })
      }
    }
    if (deletes.length > 0) {
      txnManifestDeletes.set(tr, deletes)
    }
  })

  baseDoc.on('afterTransaction', (tr) => {
    if (tr && (tr.origin === CLAIM_ORIGIN || tr.origin === GOV_ORIGIN)) return
    const deletes = txnManifestDeletes.get(tr)
    const claimsChanges = txnClaimsChanges.get(tr)
    if (tr) {
      txnManifestDeletes.delete(tr)
      txnClaimsChanges.delete(tr)
    }

    if (!deletes || deletes.length === 0) return

    const conn = tr ? tr.origin : null

    // Sender attribution:
    // 1. Verified identity (in required auth mode, secured hs_ room, or with token sub)
    // 2. Open mode: awareness state controlled by this connection
    // 3. Fallback to declared name if not 'anon'
    let senderName = null
    if (conn && typeof conn === 'object') {
      const isStrict = AUTH_MODE === 'required' || !!roomFingerprint(baseRoom)
      if (conn._hive && conn._hive.identity && (isStrict || conn._hive.identity.sub)) {
        senderName = conn._hive.identity.name
      } else if (baseDoc.conns && baseDoc.awareness) {
        const controlled = baseDoc.conns.get(conn)
        if (controlled) {
          for (const cid of controlled) {
            const state = baseDoc.awareness.states.get(cid)
            if (state && state.user && state.user.name) {
              senderName = state.user.name
              break
            }
          }
        }
      }
      if (!senderName && conn._hive && conn._hive.identity && conn._hive.identity.name && conn._hive.identity.name !== 'anon') {
        senderName = conn._hive.identity.name
      }
    }

    const now = Date.now()
    const restores = []

    for (const { key, oldValue } of deletes) {
      let claim = null
      if (claimsChanges && claimsChanges.has(key)) {
        claim = claimsChanges.get(key).oldValue
      } else {
        claim = claims.get(key)
      }

      const live = claim && (!claim.ttl || ((claim.at || 0) + claim.ttl > now))
      if (live && claim.by) {
        if (!senderName || senderName !== claim.by) {
          restores.push({ key, oldValue, claim, heldBy: claim.by })
        }
      }
    }

    if (restores.length > 0) {
      if (ENFORCE_CLAIMS === 'warn') {
        for (const { key, heldBy } of restores) {
          audit('manifest-delete-warn', { room: baseRoom, who: senderName || 'unknown', file: key, heldBy })
        }
        return
      }

      // SYNCHRONOUS, HERE, ON PURPOSE. Yjs encodes a transaction's broadcast from the live store and
      // emits it only after afterTransaction has run, so this restore rides inside the delete's own
      // update: peers see one 'update' and never a delete. Deferred (setImmediate, a timer), peers get
      // delete-then-restore, and the holder's file is moved to .hive-deleted and rewritten from the
      // room, taking any edit not yet pushed with it. relay-claim-delete A3/A4/A6 fail if this moves.
      try {
        baseDoc.transact(() => {
          for (const { key, oldValue, claim } of restores) {
            manifest.set(key, oldValue != null ? oldValue : 1)
            if (claimsChanges && claimsChanges.has(key) && !claims.has(key)) {
              claims.set(key, claim)
            }
          }
        }, CLAIM_ORIGIN)
      } catch { /* best effort */ }

      for (const { key, heldBy } of restores) {
        audit('manifest-delete-blocked', { room: baseRoom, who: senderName || 'unknown', file: key, heldBy })
      }
      const what = restores.slice(0, 3).map(({ key, heldBy }) => `${key} (held by ${heldBy})`).join(', ') + (restores.length > 3 ? ` (+${restores.length - 3} more)` : '')
      try {
        postNoticeText(baseRoom, `⛔ ${senderName || 'a client'} deleted ${what}, but a file someone else holds is not deleted under them, so that delete was refused and the file is back. Ask the holder to release it first.`)
      } catch { }
    }
  })
}

const PORT = process.env.PORT || 1234

// --- access control (Phase 1: token-gated rooms; opt-in, off by default) ---
// HIVE_AUTH_MODE: 'open' (default — anyone with the room id joins, like before)
//                 'required' — every connection must present a valid token whose
//                 scopes authorize the room it is joining.
// Keys: HIVE_JWT_SECRET (HS256, self-host) and/or HIVE_JWT_PUBKEY[_FILE] (RS256,
// for a hosted issuer). Revocation: HIVE_REVOKED_FILE (JSON array of jti) and/or
// HIVE_REVOKED_JTIS (comma list). Audit: HIVE_AUDIT_FILE (JSONL) else stdout.
const AUTH_MODE = (process.env.HIVE_AUTH_MODE || 'open').toLowerCase()
const JWT_SECRET = process.env.HIVE_JWT_SECRET || ''
const JWT_PUBKEY = process.env.HIVE_JWT_PUBKEY || (process.env.HIVE_JWT_PUBKEY_FILE ? readSafe(process.env.HIVE_JWT_PUBKEY_FILE) : '')
// Pin the accepted JWT algorithm (alg-confusion defense). Explicit override via
// HIVE_JWT_ALG; otherwise auto-pin to the one type of key configured. With BOTH
// keys present we accept either (no pin) — but never an unexpected alg.
const JWT_ALG = (process.env.HIVE_JWT_ALG || '').toUpperCase() || (JWT_SECRET && JWT_PUBKEY ? '' : JWT_SECRET ? 'HS256' : JWT_PUBKEY ? 'RS256' : '')
const AUDIT_FILE = process.env.HIVE_AUDIT_FILE || ''
function readSafe(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

// Revocation list. The JSON file is re-read per connect so a revocation takes
// effect immediately. If that read/parse fails transiently (e.g. the file is
// mid-write), we KEEP the last good set rather than forgetting it — failing
// closed, so a revoked token can't slip through during a list update.
let lastGoodRevokedFile = new Set()
function revokedSet() {
  const out = new Set((process.env.HIVE_REVOKED_JTIS || '').split(',').map((s) => s.trim()).filter(Boolean))
  if (process.env.HIVE_REVOKED_FILE) {
    try { lastGoodRevokedFile = new Set(JSON.parse(fs.readFileSync(process.env.HIVE_REVOKED_FILE, 'utf8'))) }
    catch { /* mid-write/missing: fall back to last good (don't drop revocations) */ }
    for (const j of lastGoodRevokedFile) out.add(j)
  }
  return out
}

function audit(event, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields })
  if (AUDIT_FILE) { try { fs.appendFileSync(AUDIT_FILE, line + '\n') } catch { console.error('[relay] audit write failed') } }
  else console.log('[relay][audit]', line)
}

// ONE LINE PER PARTICIPANT PER BURST, NOT ONE PER FILE (27 Sep 2026). A mux channel is a file, so a
// 1,000-file join logged 1,000 'connect' lines, each a synchronous console write: in a relay CPU
// profile of that join, 7.7 s of the main thread -- a third of it -- was console.log from here,
// and every room on the relay waited behind it. Channel opens and closes are now tallied per
// (workspace, participant) and written as one 'channels' line 2 s after a burst begins: counts,
// three sample paths, and the workspace census as it stood last. An operator who set
// HIVE_AUDIT_FILE asked for a full trail, so there every channel still gets its own line.
const channelTallies = new Map() // `${baseRoom}\0${name}` -> tally
function auditChannel(kind, baseRoom, identity, file, census) {
  if (AUDIT_FILE) return audit(kind === 'opened' ? 'connect' : 'disconnect', { baseRoom, file, identity, via: 'mux', ...census })
  const k = `${baseRoom}\u0000${(identity && identity.name) || 'anon'}`
  let t = channelTallies.get(k)
  if (!t) {
    t = { baseRoom, identity, opened: 0, closed: 0, files: [], census: null, timer: null }
    channelTallies.set(k, t)
    t.timer = setTimeout(() => flushChannelTally(k), 2000)
    if (t.timer.unref) t.timer.unref()
  }
  t[kind]++
  if (file && t.files.length < 3) t.files.push(file)
  t.census = census
}
function flushChannelTally(k) {
  const t = channelTallies.get(k)
  if (!t) return
  channelTallies.delete(k)
  clearTimeout(t.timer)
  audit('channels', { baseRoom: t.baseRoom, identity: t.identity, opened: t.opened, closed: t.closed, files: t.files, via: 'mux', ...t.census })
}

// Per-room revocation, set live by the owner via POST /__hive/revoke. Persisted to
// a JSON file (HIVE_ROOM_REVOKED_FILE, default ./hive-room-revoked.json) so a
// revoked agent stays cut off across a relay restart — not just for the session.
const ROOM_REVOKED_FILE = process.env.HIVE_ROOM_REVOKED_FILE || './hive-room-revoked.json'
const roomRevoked = new Map() // baseRoom -> Set(jti)
;(function loadRoomRevoked() {
  try { const o = JSON.parse(fs.readFileSync(ROOM_REVOKED_FILE, 'utf8')); for (const k of Object.keys(o)) roomRevoked.set(k, new Set(o[k])) } catch { /* none yet */ }
})()
function persistRoomRevoked() {
  try { const o = {}; for (const [k, set] of roomRevoked) o[k] = [...set]; fs.writeFileSync(ROOM_REVOKED_FILE, JSON.stringify(o)) }
  catch (e) { console.error('[relay] room-revoked persist failed', e.message) }
}
function isRevoked(base, jti) {
  if (!jti) return false
  if (revokedSet().has(jti)) return true
  const s = roomRevoked.get(base)
  return !!(s && s.has(jti))
}

// Shared scope + path enforcement once a token's signature is verified. A project
// is a base room plus per-file rooms ("<base>␁<path>"). Authorize on the BASE
// room, and — for a file-room — also require the path to match the scope's globs.
// This is the guarantee: a scoped agent's connect to an out-of-scope file is
// rejected here, so that file's bytes never reach it.
function scopeCheck(p, room) {
  const base = baseRoomOf(room)
  if (isRevoked(base, p.jti)) return { ok: false, code: 401, reason: 'token revoked' }
  const sc = scopeForRoom(p, base)
  if (!sc) return { ok: false, code: 403, reason: 'room not in token scope' }
  const filePath = pathOf(room)
  let role = sc.role || 'writer'
  if (filePath !== null) {
    if (!isSafeRelPath(filePath)) return { ok: false, code: 403, reason: 'malformed file path' }
    if (!pathAllowed(sc.paths, filePath)) return { ok: false, code: 403, reason: `path "${filePath}" not in scope` }
    // Per-file write control: a file this scope can SEE but not edit connects as a
    // reader, so makeReadOnly() drops its update messages. (The base/parent room is
    // left at the scope's role so coordination — chat/board/tasks — still works.)
    if (role !== 'reader' && !writeAllowed(sc, filePath)) role = 'reader'
  }
  // jti rides along so a revoke can find and close the connections that token opened (handleRevoke).
  return { ok: true, identity: { sub: p.sub, name: p.name, kind: p.kind, owner: p.owner, jti: p.jti }, role, path: filePath }
}

// A SELF-DECLARED NAME IS NOT A CREDENTIAL, AND IS NEVER TREATED AS ONE.
// On an open relay there is nothing to verify it against, so it is only ever used for
// the audit line and the members list. Every authorization decision below ignores it.
// It is optional at both ends: the extension sends it only if the person set one, so
// the default remains a genuinely anonymous connection.
const MAX_NAME = 48
function cleanName(raw) {
  if (!raw) return null
  let s = ''
  for (const ch of String(raw)) {
    const c = ch.codePointAt(0)
    if (c >= 32 && c !== 127) s += ch   // drop control chars: they would break the one-line JSON audit record
    if (s.length >= MAX_NAME) break     // and cap it: this string is attacker-controlled and lands in a log
  }
  return s.trim() || null
}


// Decide whether a connection to `room` carrying `token` is allowed.
// `declaredName` is unverified and affects logging only -- never access.
// Returns { ok, identity?, role?, code?, reason? }.
function authorize(room, token, declaredName, declaredKind) {
  // SELF-CERTIFYING SECURED ROOM (always enforced, even on an "open" relay): the
  // room id embeds a fingerprint of the owner's public key. The token carries that
  // public key (claim `pk`) and is signed by the matching private key. We trust it
  // only if fingerprint(pk) === the room's fingerprint — so no server-side key
  // store is needed, and only the owner (private-key holder) can mint valid tokens.
  const fp = roomFingerprint(baseRoomOf(room))
  if (fp) {
    if (!token) return { ok: false, code: 401, reason: 'secured room requires a token' }
    const pre = decodeUnsafe(token)
    const pk = pre && pre.pk
    if (!pk) return { ok: false, code: 401, reason: 'token missing room key' }
    if (keyFingerprint(pk) !== fp) return { ok: false, code: 403, reason: 'token key does not match this room' }
    const res = verify(token, { publicKey: pk, alg: 'RS256' })
    if (!res.ok) return { ok: false, code: 401, reason: res.error }
    return scopeCheck(res.payload, room)
  }

  // NON-SECURED ROOMS: the relay-wide policy (open by default; or a self-host
  // locked relay via HIVE_AUTH_MODE=required + a configured key).
  if (AUTH_MODE !== 'required') {
    // Carry the self-declared name through instead of discarding it. Without this the
    // operator has no way to know who any of their users are: the name exists, but it
    // travels inside the Yjs document between peers and never reaches the relay, so
    // every audit line read `anon`/`unknown` no matter who connected.
    const nm = cleanName(declaredName)
    // Only the two values the rest of the relay reasons about are accepted. Anything else
    // becomes 'unknown' rather than being echoed into the log, because writeBlockReason()
    // exempts kind === 'human' -- so a free-text kind would be a way to ask for that
    // exemption by simply claiming it. On an open relay nothing is enforced anyway, but
    // the field must not become a lever the moment HIVE_ENFORCE_CLAIMS is turned on.
    // A CLIENT MAY NOT DECLARE ITSELF HUMAN. writeBlockReason() exempts
    // identity.kind === 'human' from claim/DCO enforcement, and installWriteGate is
    // wired to ENFORCE_CLAIMS alone -- the "requires HIVE_AUTH_MODE=required" note above
    // it is a comment, not a check. So on an open relay with enforcement switched on,
    // honouring a declared 'human' would let any client opt out of every write gate by
    // saying so. Declaring 'ai' is safe because it only ever adds restrictions.
    // The raw claim is still recorded for the operator, just not as the enforced kind.
    const claimed = (declaredKind === 'ai' || declaredKind === 'human') ? declaredKind : null
    return {
      ok: true,
      identity: {
        name: nm || 'anon',
        kind: claimed === 'ai' ? 'ai' : 'unknown',   // enforcement reads this
        declaredKind: claimed,                        // audit/display only, never trusted
        declared: !!(nm || claimed),
      },
      role: 'open',
    }
  }
  if (!JWT_SECRET && !JWT_PUBKEY) return { ok: false, code: 503, reason: 'auth required but relay has no keys configured' }
  if (!token) return { ok: false, code: 401, reason: 'no token' }
  const res = verify(token, { secret: JWT_SECRET || undefined, publicKey: JWT_PUBKEY || undefined, alg: JWT_ALG || undefined })
  if (!res.ok) return { ok: false, code: 401, reason: res.error }
  return scopeCheck(res.payload, room)
}

// Owner-driven revocation endpoint. Body: { room, token, jti }. The token must be
// an admin/maintainer token for that secured room (proven self-certifying), so
// only the room owner can cut someone off. In-memory + audited.
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy() }); req.on('end', () => resolve(b)) }) }
async function handleRevoke(req, res) {
  const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  try {
    const { room, token, jti } = JSON.parse((await readBody(req)) || '{}')
    const base = baseRoomOf(room || '')
    const fp = roomFingerprint(base)
    const p = decodeUnsafe(token)
    if (!fp || !p || !p.pk || keyFingerprint(p.pk) !== fp) return reply(403, { error: 'not authorized for this room' })
    const v = verify(token, { publicKey: p.pk, alg: 'RS256' })
    if (!v.ok) return reply(401, { error: v.error })
    const sc = scopeForRoom(v.payload, base)
    if (!sc || !['admin', 'maintainer'].includes(sc.role)) return reply(403, { error: 'need an admin/maintainer token' })
    if (!jti) return reply(400, { error: 'need a jti to revoke' })
    if (!roomRevoked.has(base)) roomRevoked.set(base, new Set())
    roomRevoked.get(base).add(jti)
    persistRoomRevoked() // survive a relay restart
    // TAKEN BACK MEANS GONE NOW (8 Oct 2026). Refusing the token only at its next connect left a
    // removed guest reading every change for as long as its socket stayed up -- which, for an agent
    // that never disconnects, is forever. Close what it has open; its reconnect is then refused above.
    let dropped = 0
    for (const c of wss.clients) {
      const g = c._hiveGrant || (c._hive && c._hive.identity ? { base: baseRoomOf(c._hive.room), jti: c._hive.identity.jti } : null)
      if (g && g.jti === jti && g.base === base) { try { c.close(4401, 'token revoked') } catch { /* already closing */ } dropped++ }
    }
    audit('revoke', { room: base, jti, by: v.payload.name, dropped })
    return reply(200, { ok: true, dropped })
  } catch { return reply(400, { error: 'bad request' }) }
}

// --- persistence (plain-file snapshots per room) ---
// Keeps a room's code available even when NO editor is online — this is what lets
// you view/control a project from a browser (or phone) while you're away.
// Resolution: explicit HIVE_PERSIST_DIR wins; "off" force-disables; otherwise it
// auto-enables on the deployed relay (Render sets RENDER=true) and stays OFF for
// local runs/tests so they're deterministic and RAM-only.
const PERSIST_DIR = process.env.HIVE_PERSIST_DIR === 'off'
  ? null
  : (process.env.HIVE_PERSIST_DIR || (process.env.RENDER ? path.join(__dirname, '.hive-relay-data') : null))
// Everything persistence still owes the disk, for the shutdown handler below. A no-op without it.
let persistFlushAll = async () => { }
if (PERSIST_DIR) {
  fs.mkdirSync(PERSIST_DIR, { recursive: true })
  const fileFor = (docName) => path.join(PERSIST_DIR, encodeURIComponent(docName) + '.bin')
  // IN SMALL TURNS, AND NEVER HALF-WRITTEN (27 Sep 2026). Every flush was a writeFileSync straight
  // onto the snapshot, straight from its debounce timer. A first publish of 1,000 files arms 1,000
  // timers that fire about a second later, so the relay did 1,001 synchronous writes in a row and
  // answered no room in the meantime (1,000 such writes: 4.9 s on the dev machine; in a relay
  // profile, open/write/close were 28% of the main thread across a publish). And a relay killed
  // mid-write -- a deploy, an OOM -- left a truncated snapshot, which bindState reads as "no prior
  // state". Now a due flush joins a queue drained PERSIST_BATCH docs per event-loop turn, so other
  // rooms are served between batches; every write goes to a temp file renamed over the snapshot.
  // Writes stay synchronous on purpose: fs.promises moved the work to a 4-thread pool that fell
  // behind (303 of 1,001 snapshots written six seconds after a publish), which is the durability
  // this exists for.
  const PERSIST_BATCH = 16
  // Which docs have a snapshot at all, read once. bindState used to try a readFileSync for every
  // doc it created, and on a first publish every one of those is a miss: 1,000 failed reads, all
  // inside the burst of 1,000 channel opens.
  const persisted = new Set()
  try { for (const f of fs.readdirSync(PERSIST_DIR)) if (f.endsWith('.bin')) persisted.add(f) } catch { }
  const writeSync = (docName, ydoc) => {
    const f = fileFor(docName), tmp = f + '.tmp'
    try { fs.writeFileSync(tmp, Buffer.from(Y.encodeStateAsUpdate(ydoc))); fs.renameSync(tmp, f); persisted.add(path.basename(f)) }
    catch (e) { console.error('[relay] persist write failed', e.message) }
  }
  const due = new Map() // docName -> ydoc, oldest first; a doc already waiting keeps its place
  let draining = false
  const drain = () => {
    draining = false
    let n = 0
    for (const [docName, ydoc] of due) {
      due.delete(docName)
      writeSync(docName, ydoc)
      if (++n >= PERSIST_BATCH && due.size) { draining = true; setImmediate(drain); return }
    }
  }
  const enqueue = (docName, ydoc) => {
    due.set(docName, ydoc)
    if (!draining) { draining = true; setImmediate(drain) }
  }
  const pendingTimers = new Map() // docName -> { timer, ydoc }
  // Now, synchronously, for one doc: its timer and its place in the queue are both spent.
  const flushNow = (docName, ydoc) => {
    const p = pendingTimers.get(docName)
    if (p) { clearTimeout(p.timer); pendingTimers.delete(docName) }
    due.delete(docName)
    writeSync(docName, ydoc)
  }
  persistFlushAll = async () => {
    for (const [docName, p] of [...pendingTimers]) flushNow(docName, p.ydoc)
    for (const [docName, ydoc] of [...due]) flushNow(docName, ydoc)
  }
  setPersistence({
    bindState: async (docName, ydoc) => {
      try {
        if (!persisted.has(path.basename(fileFor(docName)))) throw new Error('no snapshot')
        const buf = fs.readFileSync(fileFor(docName))
        Y.applyUpdate(ydoc, new Uint8Array(buf))
        // Seed the size counter from what we just loaded. Without this a restart resets
        // every doc to "0 bytes used", so a room already at the cap would be allowed to
        // grow again -- the limit would only ever hold until the next deploy.
        setDocBytes(docName, buf.length)
      } catch { /* no prior state */ }
      ydoc.on('update', () => {
        if (pendingTimers.has(docName)) return
        const timer = setTimeout(() => { pendingTimers.delete(docName); enqueue(docName, ydoc) }, 1000)
        pendingTimers.set(docName, { timer, ydoc })
      })
    },
    // The last connection leaving: now, as it always was -- the doc is destroyed right after.
    writeState: async (docName, ydoc) => flushNow(docName, ydoc),
  })
  console.log(`[relay] persistence ON -> ${PERSIST_DIR}`)
}

const server = http.createServer((req, res) => {
  // A room connection carried over HTTPS requests (relay-poll.js), for networks that refuse upgrades.
  if (req.url && req.url.startsWith(POLL_PREFIX)) {
    if (!RELAY_POLL) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('long-poll is off on this relay') }
    return poll.handle(req, res)
  }
  // Remote Model Context Protocol (MCP) Streamable HTTP & SSE endpoint for cloud AI agents
  try {
    if (isMcpRequest(req)) {
      return handleMcpRequest(req, res, { port: PORT })
    }
  } catch (mcpErr) {
    console.error('[relay] MCP handler threw:', mcpErr)
  }

  // Health and capacity. A paid relay needs an answer to "is it up, and how close to its
  // limits" that does not require reading the logs -- it is what an uptime check polls and
  // what you look at first when someone says the room is slow. No identities, no room
  // names, no document contents: it is unauthenticated on purpose, so it must leak nothing.
  if (req.url === '/health' || req.url === '/healthz') {
    const s = limitStats()
    // Any page may read it: it leaks nothing by design (above), and the status page on the website
    // (public/status.html) reads it from another origin. Without this, a browser hides the answer
    // and that page can say only "reachable", never which build is up.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    return res.end(JSON.stringify({
      ok: true,
      // WHICH BUILD is answering. On 29 Sep 2026 a night of relay fixes had been pushed and the hosted
      // relay was still the old build, and the only evidence was its uptime. build is the commit
      // (Render's RENDER_GIT_COMMIT, or a checkout's HEAD); null when the relay cannot know it.
      version: VERSION,
      build: BUILD || null,
      uptimeSec: Math.round(process.uptime()),
      connections: s.connections,
      // Files open over mux sockets. `connections` counts physical sockets; a mux participant is
      // ONE of those however many files it holds, and those files are counted here instead.
      channels: s.channels,
      // Clients read this to decide whether to carry all their files on one socket (mux) or open
      // one socket per file. An absent field is what every older relay answers: "one per file".
      mux: RELAY_MUX ? MUX_VERSION : 0,
      // HTTPS long-poll for networks that refuse WebSocket upgrades. Clients read this, never guess.
      poll: RELAY_POLL ? POLL_VERSION : 0,
      rooms: s.rooms,
      docsTracked: s.docsTracked,
      largestDocBytes: s.largestDocBytes,
      authMode: AUTH_MODE,
      licenseRequired: process.env.HIVE_REQUIRE_LICENSE === 'true',
      persistence: !!PERSIST_DIR,
      // The two settings that decide whether this relay does the thing the product claims,
      // reported so an operator can read them from outside instead of inferring them from a
      // failed test. Both are env-gated and both default to the useless value, and on
      // 2026-09-05 a deploy went out with neither set: /health said "ok", the startup log
      // was the only place that knew, and the way it was actually discovered was a 12-agent
      // run quietly seating 8. A health endpoint that omits the settings most likely to be
      // wrong is answering the easy half of the question.
      enforceClaims: ENFORCE_CLAIMS,
      seats: Math.max(0, parseInt(process.env.HIVE_SEATS || '0', 10) || 0) || null,
      connsPerRoom: (() => {
        const s = Math.max(0, parseInt(process.env.HIVE_SEATS || '0', 10) || 0)
        return s > 0 ? Math.min(TIERS.pro.connsPerSeat * s, TIERS.pro.maxConnsCeiling) : TIERS.free.maxConnsPerRoom
      })(),
      limits: s.limits,
      tiers: TIERS,
      metering: meter.snapshot(),
    }))
  }

  // PER-AGENT ACTIVITY. Answers "which agent is writing, how much, to how many files" —
  // the question a customer running five agents actually asks when a room feels wrong.
  //
  // NOT token spend, and it must never be presented as such: an agent's LLM calls go
  // straight to its provider and never pass through this relay, so a token figure here
  // would be fabricated. This is what the relay genuinely observed.
  //
  // Unlike /health, this carries room and agent names, so it is NOT public: it requires the
  // same admin secret as revocation. Leaking who is working on which file is a real
  // disclosure for a customer with private repositories.
  if (req.url === '/usage' || (req.url || '').startsWith('/usage?')) {
    const want = process.env.HIVE_ADMIN_SECRET || ''
    const got = req.headers['x-hive-admin'] || ''
    if (!want || got !== want) {
      res.writeHead(403, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        error: want ? 'Q441 bad or missing X-Hive-Admin header' : 'Q442 /usage is disabled: set HIVE_ADMIN_SECRET to enable it',
      }))
    }
    let room = null
    try { room = new URL(req.url, 'http://x').searchParams.get('room') } catch { }
    const rows = usageFor(room)
    const govData = room ? { [room]: gov.snapshot(room) } : gov.snapshot()
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    return res.end(JSON.stringify({
      note: 'relay-observed activity. NOT LLM token spend — agent model calls do not pass through this relay.',
      agents: rows.length,
      usage: rows,
      governor: govData,
    }))
  }

  if (req.url === '/__hive/revoke') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }); return res.end() }
    if (req.method === 'POST') return void handleRevoke(req, res)
  }
  
  // SaaS Billing Endpoint: check a Hivecode Pro licence. This used to be a mock that
  // returned valid:true for anything starting with "HC-PRO-", with the seat count coming
  // from MOCK_MAX_COMMITTERS. It now defers to the real validator (see license-check.js),
  // which reads the seat count from the stored record rather than from the key.
  if (req.url === '/api/validate-license') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }); return res.end() }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => body += chunk.toString())
      req.on('end', async () => {
        let license_key
        try { ({ license_key } = JSON.parse(body)) }
        catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'bad request' }))
        }
        const verdict = await verifyLicense(license_key || '')
        if (verdict.valid) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ valid: true, max_committers: verdict.seats, status: verdict.status }))
        }
        // 503 when we could not reach the validator: "unknown" must not be reported as
        // "unpaid", or a billing outage reads as an expired licence.
        const unavailable = verdict.source === 'unavailable'
        res.writeHead(unavailable ? 503 : 402, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({
          valid: false,
          error: unavailable ? 'Licence check temporarily unavailable' : 'Payment Required: invalid or missing licence.',
          reason: verdict.reason,
        }))
      })
      return
    }
  }
  // Static pages: the relay doubles as the website + the browser control room, so
  // one deploy serves everything. Map a small allowlist of paths to public/ files.
  if (req.method === 'GET') {
    const TYPES = { '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.js': 'text/javascript; charset=utf-8' }
    const file = STATIC[(req.url || '').split('?')[0]]
    if (file) {
      try {
        const filePath = staticFile(file, __dirname)
        const body = fs.readFileSync(filePath)
        const ext = file.slice(file.lastIndexOf('.'))
        // HTML is the app shell — keep it fresh (60s) so deploys land fast; static
        // image assets can cache longer.
        const maxAge = ext === '.html' ? 60 : 86400
        res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': `public, max-age=${maxAge}` })
        return res.end(body)
      } catch { /* fall through to the plain status text */ }
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('hivecode relay is up. Connect a client to ws://<this-host>:' + PORT + '/<room>\n')
})

// noServer: we authorize at the HTTP upgrade BEFORE completing the WS handshake,
// so an unauthorized client never establishes a socket and never receives any
// CRDT bytes for the room.
const wss = new WebSocketServer({ noServer: true })
const roomAgents = new Map() // Tracks active committers: room -> Set(agent_id)

// WHO PAYS FOR A ROOM: baseRoom -> {account, tier}
//
// The account used to be decided by the CONNECTING client's key, and that broke the team
// case in a way a customer could never diagnose. Three people share one workspace; one has
// the key in their MCP config and two do not. The first billed to `lic:…` on paid ceilings,
// the other two billed to `room:…` on FREE ceilings -- so two of them eventually could not
// write in a workspace their colleague was paying for, while nothing anywhere explained why.
//
// A workspace has ONE payer. The first licensed client to join claims it, and everyone else
// in that base room inherits that account and its ceilings. This is how Figma and Notion
// work: the credential proves you may join, the WORKSPACE decides who is billed.
//
// Why inheriting is safe: a room id is 72 bits of randomness, and production runs
// HIVE_AUTH_MODE=required so joining needs a scoped token as well. Access control is the
// invite; this map only answers "whose meter does this write land on".
//
// In memory only, deliberately. It is a cache of a fact the licence record already holds, so
// a restart costs one re-claim by the next licensed client rather than a stale wrong answer.
const roomAccount = new Map()

function claimRoomAccount(baseRoom, license, tier) {
  if (!license) return null
  const account = meter.accountFor(license, baseRoom)
  // Refresh on every licensed connect so a plan change (or a seat increase) propagates to
  // the whole room, rather than the room being stuck on whatever the first joiner had.
  roomAccount.set(baseRoom, { account, tier })
  return account
}

/** The account and tier an unlicensed connection inherits, or null to fall back to free. */
function inheritedRoomAccount(baseRoom) {
  return roomAccount.get(baseRoom) || null
}

// WORKSPACE occupancy, which is NOT the same number as room occupancy and was the
// reason a log full of `inRoom:1` looked like "nobody ever has company". Every file
// is its own room, so `roomAgents` answers "who has THIS FILE open" -- almost always
// one person, even in a busy workspace. Keyed on the BASE room, this answers the
// question anyone actually asks of the log: how many distinct clients, and how many
// of them are agents, are in this project right now.
//
// Counted per identity, not per socket: one client holds hundreds of sockets (one per
// file), so a set of connection ids would report a single user as hundreds. The refcount
// is what lets an identity leave only when its LAST socket in the workspace closes.
const workspacePeers = new Map() // baseRoom -> Map(name -> { kind, declaredKind, socks })

function joinWorkspace(baseRoom, identity) {
  let m = workspacePeers.get(baseRoom)
  if (!m) { m = new Map(); workspacePeers.set(baseRoom, m) }
  const cur = m.get(identity.name)
  if (cur) { cur.socks++; return }
  m.set(identity.name, { kind: identity.kind, declaredKind: identity.declaredKind, socks: 1 })
}

function leaveWorkspace(baseRoom, name) {
  const m = workspacePeers.get(baseRoom)
  if (!m) return
  const cur = m.get(name)
  if (!cur) return
  if (--cur.socks <= 0) m.delete(name)
  if (m.size === 0) workspacePeers.delete(baseRoom)
}

// `kind` is the TOKEN's claim and is trusted; `declaredKind` is what the client said
// about itself and is not. Both are reported, separately and labelled, so a reader of
// the log can tell an attested agent from one that merely says it is a person.
function census(baseRoom) {
  const m = workspacePeers.get(baseRoom) || new Map()
  let ai = 0, human = 0, unattested = 0
  for (const v of m.values()) {
    if (v.kind === 'ai') ai++
    else if (v.kind === 'human') human++
    else unattested++
  }
  return { peers: m.size, ai, human, unattested, names: [...m.keys()] }
}

// THE UPGRADE PATH, as reusable steps. It used to be one inline handler, which meant the only
// way to reach these gates was a real HTTP upgrade. ONE SOCKET PER PARTICIPANT needs every file a
// mux client opens to pass exactly the same gates a per-file upgrade passes, so they are lifted out
// verbatim: resolveTier (licence/seats, once per physical socket), gateRoom (authorize, committer
// limit, capacity -- per file), acceptConnection (account, counters, audit, then the 'connection'
// handler that installs every per-connection gate and setupWSConnection). The per-file path below
// calls the same three, in the same order, with the same audit events and status lines as before.
const RELAY_MUX = !/^(off|0|false)$/i.test(process.env.HIVE_RELAY_MUX || '')
const MUX_KEY = (baseRoom) => `${baseRoom}\u0002mux` // a mux socket's slot in the per-room/total counts

function parseUpgrade(url) {
  let room = 'default', token = '', license = '', declaredName = '', declaredKind = ''
  try {
    const u = new URL(url, 'http://localhost')
    room = decodeURIComponent(u.pathname.slice(1)) || 'default'
    token = u.searchParams.get('token') || ''
    license = u.searchParams.get('license') || ''
    // Optional and unverified -- see cleanName(). Absent unless the person set a name.
    declaredName = u.searchParams.get('name') || ''
    declaredKind = u.searchParams.get('kind') || ''
  } catch { /* keep defaults */ }
  return { room, token, license, declaredName, declaredKind }
}

function refuseUpgrade(socket, line) {
  // X-Hive-Relay says the RELAY refused, not a proxy in the way: a client must not answer the relay's
  // own refusal by trying another transport.
  socket.write(`HTTP/1.1 ${line}\r\nX-Hive-Relay: 1\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

// The licence/seat decision. { ok, tier, committerLimit } or { ok:false, line }.
async function resolveTier(room, license) {
  // SaaS Enforcer: entitlement comes from the licence RECORD, never from the key string.
  // The previous version admitted anything prefixed "HC-PRO-" and read the seat count out
  // of the key, so HC-PRO-9999-anything bought nothing and granted 9,999 committers.
  let committerLimit = Infinity
  // The usage tier this connection gets. Computed from the licence verdict, not from the
  // key, and defaulted to free so a relay with licensing DISABLED still applies the free
  // ceilings rather than no ceilings at all — "we are not checking payment" must not mean
  // "we are not bounding cost".
  let tier = limitsFor(null)

  // SELF-HOSTED / ENTERPRISE. An operator running their own relay IS the licensee: there is
  // nobody to bill and no /api/validate to ask, yet the free ceiling (8 connections per room)
  // is far too small for a real team — a room of 8 agents plus one human is already 9.
  // HIVE_SEATS grants the pro tier directly, with the same per-seat arithmetic a paying
  // customer gets.
  //
  // This cannot be used to dodge payment: `server.js` is the SERVICE and is deliberately
  // absent from the npm package's files[], so the only person who can set this is whoever is
  // already paying to run the relay. A real licence still wins — the block below overwrites
  // this whenever HIVE_REQUIRE_LICENSE is on.
  const selfHostSeats = Math.max(0, parseInt(process.env.HIVE_SEATS || '0', 10) || 0)
  if (selfHostSeats > 0) {
    tier = limitsFor({ valid: true, plan: 'pro', seats: selfHostSeats })
    committerLimit = selfHostSeats
  }

  if (process.env.HIVE_REQUIRE_LICENSE === 'true') {
    let verdict
    try { verdict = await verifyLicense(license) }
    catch (e) {
      verdict = { valid: false, seats: 0, plan: null, source: 'unavailable', reason: 'verification threw' }
      console.error('[relay] verifyLicense threw:', e && e.message)
    }
    if (!verdict.valid) {
      audit('reject-license', { room, reason: verdict.reason || 'payment required', source: verdict.source })
      // 503 for "we could not check", 402 for "you have not paid" — a billing outage must
      // not tell a paying customer their licence is invalid.
      const unavailable = verdict.source === 'unavailable'
      return { ok: false, line: unavailable ? '503 Service Unavailable' : '402 Payment Required' }
    }
    committerLimit = verdict.seats > 0 ? verdict.seats : 1
    tier = limitsFor(verdict)
  }
  return { ok: true, tier, committerLimit }
}

// Authorize + committer limit + capacity, for ONE room (a file, or the base). Synchronous on
// purpose: a mux OPEN must be admitted and wired in one tick, so no frame for it can arrive
// before setupWSConnection has registered its listener.
function gateRoom(room, { token, declaredName, declaredKind, tier, committerLimit, channel }) {
  // Fail CLOSED on any unexpected error in authorization — a thrown exception here
  // must reject the connection, never crash the relay process (which would take down
  // every room). authorize() is the only trust gate, so a throw = deny.
  let auth
  try { auth = authorize(room, token, declaredName, declaredKind) }
  catch (e) { auth = { ok: false, code: 401, reason: 'authorization error' }; console.error('[relay] authorize threw:', e && e.message) }
  if (!auth.ok) {
    audit('reject', { room, reason: auth.reason })
    const code = auth.code || 401
    const msg = code === 403 ? 'Forbidden' : code === 503 ? 'Service Unavailable' : 'Unauthorized'
    return { ok: false, code, reason: auth.reason || msg, line: `${code} ${msg}` }
  }

  // Enforce Committer Limit
  const agentId = auth.identity.name
  if (process.env.HIVE_REQUIRE_LICENSE === 'true') {
    const active = roomAgents.get(room) || new Set()
    if (!active.has(agentId) && active.size >= committerLimit) {
      audit('reject-limit', { room, identity: agentId, limit: committerLimit })
      return { ok: false, code: 402, reason: 'License Limit Reached. Email support@getgrm.tech', line: '402 Payment Required: License Limit Reached. Email support@getgrm.tech' }
    }
  }

  // CAPACITY, checked last among the gates and before the handshake completes. Last because
  // a client that is unauthorized or unpaid should be told that, not "we are full"; before
  // the handshake because a rejected connection should cost one socket and no doc state.
  // This is separate from the committer/seat limit above: seats are entitlement, this is
  // survival -- one client reconnecting in a loop is not a licensing question.
  // A mux CHANNEL is counted against the file's per-room ceiling like a socket, but not
  // against the socket total -- its physical socket already paid that once.
  const full = channel ? admitChannel(room, tier) : admitConnection(room, tier)
  if (full) {
    audit('reject-capacity', { room, identity: agentId, reason: full.reason })
    return { ok: false, code: full.code, reason: full.reason, line: `${full.code} ${full.reason}` }
  }
  return { ok: true, auth, agentId }
}

// Everything that happens once a connection is admitted -- for a real ws and a mux VirtualConn
// alike. `channel` only changes which counter it occupies.
function acceptConnection(conn, req, room, { auth, tier, license, agentId, channel }) {
  // `account` is what usage meters against: the licence key when there is one, else the
  // base room. Computed here so a licensed client accumulates across every room it opens
  // and across relay restarts, which is exactly what the per-file seat counter could not do.
  // Declared HERE, before anything reads it. It used to be introduced further down, so
  // the account logic below referenced it in its temporal dead zone -- a ReferenceError on
  // every single connection, which `node --check` cannot see because it is a runtime rule,
  // not a syntax one.
  const baseRoom = baseRoomOf(room)
  // A licensed client claims the workspace for its account; an unlicensed one INHERITS
  // whatever the workspace was claimed for. That is what makes a team on one plan actually
  // work -- see roomAccount above for the failure this replaces.
  let account = claimRoomAccount(baseRoom, license, tier)
  if (!account) {
    const inherited = inheritedRoomAccount(baseRoom)
    if (inherited) {
      account = inherited.account
      tier = inherited.tier   // and the ceilings, or they would still hit the free wall
    } else {
      account = meter.accountFor('', baseRoom)  // genuinely unclaimed: an anonymous workspace
    }
  }
  conn._hive = { room, identity: auth.identity, role: auth.role, tier, account }
  if (channel) noteChannelOpened(room)
  else noteConnectionOpened(room)

  // Add agent to active committers list
  if (!roomAgents.has(room)) roomAgents.set(room, new Set())
  roomAgents.get(room).add(agentId)
  joinWorkspace(baseRoom, auth.identity)

  // Remove agent when connection drops, and SAY SO. Without a disconnect event the
  // audit log is connect-only, which makes three ordinary questions unanswerable:
  // how many clients were in a room at the same time, how long a session lasted, and
  // whether a burst of joins is several people or one client reconnecting. `held`
  // separates those last two on its own -- a reconnect storm shows up as many
  // short-lived connections, a real session as a long one.
  const openedAt = Date.now()
  conn.on('close', () => {
    if (channel) noteChannelClosed(room)
    else noteConnectionClosed(room)
    // Fold this connection's counters into the per-agent totals. Done on close because a
    // client holds one connection per FILE: accumulating on the base room with the file
    // name recorded is what makes "which agent wrote most, and to how many files"
    // answerable, which a per-socket view cannot do.
    try {
      if (conn._hiveLimit) recordUsage(baseRoom, agentId, conn._hiveLimit.usage(), pathOf(room) || null)
    } catch { /* telemetry must never break a disconnect */ }
    const active = roomAgents.get(room)
    if (active) {
      active.delete(agentId)
      if (active.size === 0) roomAgents.delete(room)   // don't leak an empty Set per room
    }
    leaveWorkspace(baseRoom, agentId)
    const c = census(baseRoom)
    if (channel) auditChannel('closed', baseRoom, auth.identity, pathOf(room), { stillInWorkspace: c.peers, workspace: c })
    else audit('disconnect', {
      room,
      baseRoom,
      file: pathOf(room),
      identity: auth.identity,
      heldMs: Date.now() - openedAt,
      stillInRoom: (roomAgents.get(room) || new Set()).size,
      stillInWorkspace: c.peers,
      workspace: c,
    })
  })

  const c = census(baseRoom)
  if (channel) auditChannel('opened', baseRoom, auth.identity, pathOf(room), { inWorkspace: c.peers, workspace: c })
  else audit('connect', {
    room,
    // Split out so the log is greppable without anyone having to know that the room
    // name is two values joined by a control character.
    baseRoom,
    file: pathOf(room),
    identity: auth.identity,
    role: auth.role,
    // How many distinct clients hold this FILE right now, counted AFTER this one was
    // added above. Near-always 1, and that is correct -- see inWorkspace for the
    // number that answers "is more than one agent in here".
    inRoom: (roomAgents.get(room) || new Set()).size,
    inWorkspace: c.peers,
    workspace: c,
  })
  wss.emit('connection', conn, req)
}

// ONE SOCKET PER PARTICIPANT. The physical socket is authorized as the BASE room -- the same
// grant the client's base-room connection already uses -- and occupies one slot of the total.
// Every file it then opens goes through gateRoom and acceptConnection above, per file.
async function admitMux(req, q) {
  if (!RELAY_MUX) return { line: '404 Not Found' }
  const baseRoom = q.room.slice(MUX_PREFIX.length)
  if (!baseRoom || baseRoomOf(baseRoom) !== baseRoom || pathOf(baseRoom)) return { line: '400 Bad Request' }
  const t = await resolveTier(q.room, q.license)
  if (!t.ok) return { line: t.line }
  let auth
  try { auth = authorize(baseRoom, q.token, q.declaredName, q.declaredKind) }
  catch (e) { auth = { ok: false, code: 401, reason: 'authorization error' }; console.error('[relay] authorize threw:', e && e.message) }
  if (!auth.ok) {
    audit('reject', { room: q.room, reason: auth.reason })
    const code = auth.code || 401
    return { line: `${code} ${code === 403 ? 'Forbidden' : code === 503 ? 'Service Unavailable' : 'Unauthorized'}` }
  }
  const key = MUX_KEY(baseRoom)
  const full = admitConnection(key, t.tier)
  if (full) {
    audit('reject-capacity', { room: q.room, identity: auth.identity.name, reason: full.reason })
    return { line: `${full.code} ${full.reason}` }
  }
  return { accept: (ws) => {
    noteConnectionOpened(key)
    const openedAt = Date.now()
    ws._hiveGrant = { base: baseRoom, jti: auth.identity && auth.identity.jti } // what a revoke matches on
    audit('mux-connect', { baseRoom, identity: auth.identity })
    serveMux(ws, {
      baseRoom,
      audit,
      limits: { maxChannelsPerSocket: LIMITS.maxChannelsPerSocket, opensPerTurn: LIMITS.opensPerTurn },
      openChannel: (id, docName, session) => {
        // Only files of THIS socket's room: a grant for one room must not open another's.
        // The name is used EXACTLY as sent. A per-file client puts it raw into a URL, where '#',
        // '?' and '%xx' are rewritten -- so for those rare names the old transport reaches a
        // different doc (usually it is refused, having lost its token to the '#' or '?'). Do not
        // "fix" that by rewriting here: it would make two different files share one doc.
        if (typeof docName !== 'string' || baseRoomOf(docName) !== baseRoom || !pathOf(docName)) {
          audit('reject', { room: String(docName).slice(0, 200), reason: 'mux channel outside its room' })
          return { code: 403, reason: 'Q437 a channel may only open a file of its own room' }
        }
        const g = gateRoom(docName, { token: q.token, declaredName: q.declaredName, declaredKind: q.declaredKind, tier: t.tier, committerLimit: t.committerLimit, channel: true })
        if (!g.ok) return { code: g.code, reason: g.reason }
        const vc = session.makeConn(id, docName)
        session.opened(id)
        acceptConnection(vc, req, docName, { auth: g.auth, tier: t.tier, license: q.license, agentId: g.agentId, channel: true })
        return { ok: true }
      },
      onClose: () => {
        noteConnectionClosed(key)
        audit('mux-disconnect', { baseRoom, identity: auth.identity, heldMs: Date.now() - openedAt })
      },
    })
  } }
}

// THE ONE ADMISSION DECISION for a connection, whatever carries it: a WebSocket upgrade below, or an
// HTTPS long-poll session (relay-poll.js) for networks that refuse upgrades. Resolves to { line }, the
// status line to refuse with, or { accept(conn) }. Both carriers call it, so a check added here
// protects both, and neither can be the way around the other.
async function admitUpgrade(req) {
  const q = parseUpgrade(req.url)
  if (q.room.startsWith(MUX_PREFIX)) return admitMux(req, q)
  const t = await resolveTier(q.room, q.license)
  if (!t.ok) return { line: t.line }
  const g = gateRoom(q.room, { token: q.token, declaredName: q.declaredName, declaredKind: q.declaredKind, tier: t.tier, committerLimit: t.committerLimit, channel: false })
  if (!g.ok) return { line: g.line }
  return { accept: (conn) => acceptConnection(conn, req, q.room, { auth: g.auth, tier: t.tier, license: q.license, agentId: g.agentId, channel: false }) }
}

server.on('upgrade', async (req, socket, head) => {
  const a = await admitUpgrade(req)
  if (!a.accept) return refuseUpgrade(socket, a.line)
  wss.handleUpgrade(req, socket, head, (conn) => a.accept(conn))
})

// HTTPS LONG-POLL, for networks that pass HTTPS but refuse every WebSocket upgrade (Antigravity's
// cloud VMs, 7 Nov 2026; many company proxies). Same admission, same accept path, same gates.
const RELAY_POLL = !/^(off|0|false)$/i.test(process.env.HIVE_RELAY_POLL || '')
const poll = makePollHandler({ admit: admitUpgrade, audit, track: (conn) => { wss.clients.add(conn); conn.once('close', () => wss.clients.delete(conn)) }, maxFrameBytes: LIMITS.maxFrameBytes || 16 * 1048576 })

wss.on('connection', (conn, req) => {
  const room = (conn._hive && conn._hive.room) || (req.url || '/').slice(1).split('?')[0] || 'default'
  // A ws with no 'error' listener THROWS on the first malformed frame (bad opcode, bad UTF-8,
  // an oversized payload) -- and nothing else catches it, so one bad client took down the
  // relay and every room on it. The socket still closes; the process no longer dies.
  if (!conn.isVirtual) conn.on('error', (e) => { try { audit('socket-error', { room, reason: e && e.message }) } catch { } })
  // One line per file, but it should at least say what is being opened and by how many people
  // -- the previous version printed the raw joined room name, control character and all, and
  // no occupancy at all. Not for a mux channel: those are one 'channels' line per burst
  // (auditChannel), because a 1,000-file join is otherwise 1,000 synchronous console writes.
  if (conn.isVirtual) {
    // counted by auditChannel
  } else if (conn._hive) {
    const c = census(baseRoomOf(room))
    const f = pathOf(room)
    console.log(`[relay] ${conn._hive.identity.name} (${conn._hive.role}) opened ${f ? `"${f}"` : 'the workspace'} in ${baseRoomOf(room)} -- ${c.peers} in workspace [${c.human}h/${c.ai}ai/${c.unattested}?]`)
  } else {
    console.log(`[relay] a client joined room "${room}"`)
  }
  installUsageLimits(conn) // FIRST: every gate below costs work per message, so bound it here
  if (conn._hive && conn._hive.role === 'reader') makeReadOnly(conn) // enforce read-only BEFORE y-websocket wires its handler
  // The gate now carries TWO jobs: the opt-in claim/DCO enforcement, and the governor's stop
  // button which is on by default. Installing it for the governor alone changes nothing until
  // somebody is actually paused -- writeBlockReason returns null for everyone else.
  else if (ENFORCE_CLAIMS !== 'off' || GOVERNOR !== 'off') installWriteGate(conn)
  if (GOVERNOR !== 'off' && conn._hive) { try { gov.attach(baseRoomOf(room), getYDoc(baseRoomOf(room))) } catch { /* room may be mid-teardown */ } }
  // Every gate above wraps conn.on. EventEmitter's addListener is the same function under another
  // name, NOT an alias of the instance property -- so a 'message' listener added by that name
  // would skip every gate. Nothing does that today; this makes sure nothing can.
  conn.addListener = conn.on
  setupWSConnection(conn, req, { docName: room })
  postNotice(room)                       // service notice, if one is set
  if (PROVENANCE !== 'off') installProvenanceGuard(room) // substrate: verify/enforce the file's provenance ledger (opt-in)
  if (ENFORCE_CLAIMS !== 'off') installManifestDeleteGuard(baseRoomOf(room))
})

server.listen(PORT, () => {
  console.log(`[relay] listening on :${PORT}`)
  console.log(`[relay] room URL pattern: ws://localhost:${PORT}/<room-name>`)
  console.log(`[relay] remote MCP endpoint: http://localhost:${PORT}/mcp (Streamable HTTP / SSE)`)
  console.log(`[relay] auth mode: ${AUTH_MODE}${AUTH_MODE === 'required' ? ` (keys: ${JWT_SECRET ? 'HS256 ' : ''}${JWT_PUBKEY ? 'RS256' : ''})` : ''}`)
  // ALWAYS PRINTED, INCLUDING WHEN OFF -- and that is the whole point. These lines used to be
  // wrapped in `if (X !== 'off')`, so a relay running with no write-enforcement said NOTHING
  // about it, and silence had to be read as "off" by someone who already suspected it. The
  // hosted relay ran that way for weeks: every agent that ever pointed at the default relay
  // had no write gate, the deploy logs looked completely normal, and "the relay refuses what
  // isn't allowed" was false in production the entire time. An operator must be able to read
  // what their relay is actually enforcing off the first screen of its own log.
  const seatsEnv = Math.max(0, parseInt(process.env.HIVE_SEATS || '0', 10) || 0)
  const roomCap = seatsEnv > 0
    ? Math.min(TIERS.pro.connsPerSeat * seatsEnv, TIERS.pro.maxConnsCeiling) + ` (pro, ${seatsEnv} seats)`
    : TIERS.free.maxConnsPerRoom + ' (FREE tier -- a 12-agent room will not fit; set HIVE_SEATS)'
  console.log(`[relay] claim/DCO write-enforcement: ${ENFORCE_CLAIMS}` +
    (ENFORCE_CLAIMS === 'off' ? '   <-- OFF: nothing refuses a write to a claimed file' : ''))
  console.log(`[relay] substrate provenance enforcement: ${PROVENANCE}`)
  console.log(`[relay] governor (stop button + spend caps): ${GOVERNOR}` +
    (GOVERNOR === 'off' ? '   <-- OFF: a paused agent can still write, and no budget is enforced' : ''))
  console.log(`[relay] connections per room: ${roomCap}`)
  // Metering is off unless HIVE_USAGE_SECRET is set, and it says which it is out loud. A
  // relay silently not metering is how you discover at the end of a month that the free tier
  // was unlimited the whole time.
  if (meter.start()) {
    const s = meter.snapshot()
    console.log(`[relay] usage metering ON -> free allowance ${Math.round(s.freeAllowance.writeBytes / 1048576)} MB writes/month, flush every ${Math.round(s.flushMs / 1000)}s`)
  } else {
    console.log('[relay] usage metering OFF (set HIVE_USAGE_SECRET to enable the free-tier auto-lock)')
  }
})

// Flush on the way out so the last minute of a shut-down relay is not lost. Best-effort and
// time-boxed: a slow meter must never hold a deploy open. The documents too: a doc edited in the
// second before a deploy's SIGTERM sat in its debounce timer and never reached the disk.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    meter.stop()
    for (const k of [...channelTallies.keys()]) flushChannelTally(k)
    Promise.race([Promise.all([meter.flush(), persistFlushAll()]), new Promise((r) => setTimeout(r, 2500))]).finally(() => process.exit(0))
  })
}

// --- optional keep-warm (free-tier hosts sleep after ~15 min idle) ---
const KEEP_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEPALIVE_URL
if (KEEP_URL) {
  const url = KEEP_URL.startsWith('http') ? KEEP_URL : 'https://' + KEEP_URL
  const get = url.startsWith('https') ? https.get : http.get
  setInterval(() => { try { get(url, (r) => r.resume()).on('error', () => {}) } catch {} }, 10 * 60 * 1000)
  console.log(`[relay] keep-warm ON -> pinging ${url} every 10 min`)
}
