// USAGE LIMITS — what stops one misbehaving client from degrading a room for everyone
// who paid for it.
//
// Before this, the only bound anywhere in the relay was `MAX_NAME = 48`. A single agent in a
// loop could push unbounded messages, grow a document without limit, or open connections
// until the process died — and the blast radius is not that client, it is every other room
// on the same relay. That is the difference between "works on my machine" and something you
// can charge for.
//
// Four limits, each chosen because an agent can actually hit it by accident:
//
//   MESSAGES   an agent stuck in a write loop. Token bucket, so normal bursty sync (a big
//              paste, a first-join catch-up) passes and a sustained flood does not.
//   BYTES      the same loop with big payloads. Rate-limiting messages alone lets 10 msg/s
//              of 5 MB through, which is the same outage with fewer packets.
//   DOC SIZE   a file (or a room) that grows without bound. A CRDT never shrinks: every
//              insert is retained history, so "it will be garbage collected" is not true
//              here. Past the cap we refuse WRITES and keep serving reads, because dropping
//              the client would take their unsaved work with it.
//   CONNS      connection floods, per room and per relay. Separate from the committer/seat
//              limit: seats are about entitlement, this is about survival.
//
// EVERY limit is a REFUSAL WITH A REASON, never a silent drop. An agent that is told
// `Q4xx over the message rate` can back off; one whose writes vanish will retry forever and
// look like a broken product. Nothing here throttles reads.
//
// Defaults are deliberately generous — roughly 100x what the run2 four-agent session used at
// peak — so a real team never meets them and a runaway loop meets them in about a second.
// All of them are env-tunable so a self-hoster can raise them without a code change.
//
// ASCII only. Q-codes on refusals.

const num = (name, dflt) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

// ── TIERS ───────────────────────────────────────────────────────────────────────────────
// The first version of this file applied ONE set of limits to everybody, which is wrong for
// a product that charges: a free room got the same 64 MB document ceiling and the same
// message rate as a room someone is paying $29 a seat for. That is both a giveaway and a
// support problem -- the paying customer is the one who notices the shared ceiling.
//
// So limits scale with the tier the licence actually reports. `plan` comes from the licence
// record (see license-check.js, which had been dropping it), never from the key string --
// the whole reason the record is authoritative is that a key told the relay whatever it
// liked in an earlier version and granted 9,999 seats.
//
// The multiplier is per SEAT, deliberately. A 20-seat room legitimately does 10x the traffic
// of a 2-seat one, and a flat per-room ceiling would punish exactly the customers worth
// keeping. Free stays generous enough that nobody hits it while evaluating -- the tier is
// there to bound cost and abuse, not to nag someone into upgrading.
const TIERS = {
  free: {
    // PLANS.free caps at 2 seats (shared/license.js), so this is sized for two agents doing
    // real work, with headroom. A single evaluator will never see it.
    msgsPerSec: num('HIVE_FREE_MSGS_PER_SEC', 60),
    msgBurst: num('HIVE_FREE_MSG_BURST', 600),
    bytesPerSec: num('HIVE_FREE_BYTES_PER_SEC', 2 * 1024 * 1024),
    byteBurst: num('HIVE_FREE_BYTE_BURST', 8 * 1024 * 1024),
    maxDocBytes: num('HIVE_FREE_MAX_DOC_BYTES', 8 * 1024 * 1024),
    maxConnsPerRoom: num('HIVE_FREE_MAX_CONNS_PER_ROOM', 8),
  },
  pro: {
    // Per seat. A 1-seat Pro room already gets more than the whole free tier.
    msgsPerSecPerSeat: num('HIVE_PRO_MSGS_PER_SEC_PER_SEAT', 100),
    msgBurstPerSeat: num('HIVE_PRO_MSG_BURST_PER_SEAT', 1000),
    bytesPerSecPerSeat: num('HIVE_PRO_BYTES_PER_SEC_PER_SEAT', 4 * 1024 * 1024),
    byteBurstPerSeat: num('HIVE_PRO_BYTE_BURST_PER_SEAT', 16 * 1024 * 1024),
    maxDocBytesPerSeat: num('HIVE_PRO_MAX_DOC_BYTES_PER_SEAT', 32 * 1024 * 1024),
    // Connections, not committers. An agent may hold several file-rooms at once, and a
    // reader costs a socket without costing a seat.
    connsPerSeat: num('HIVE_PRO_CONNS_PER_SEAT', 8),
    // Ceilings so one licence cannot consume the relay no matter how many seats it buys.
    maxDocBytesCeiling: num('HIVE_PRO_MAX_DOC_BYTES_CEILING', 512 * 1024 * 1024),
    maxConnsCeiling: num('HIVE_PRO_MAX_CONNS_CEILING', 256),
  },
}

/**
 * The limits that apply to one connection, from the licence verdict.
 *
 * Called with the verdict verifyLicense() returned at the handshake. An invalid or absent
 * licence is the free tier — NOT a refusal: whether an unlicensed client may connect at all
 * is HIVE_REQUIRE_LICENSE's decision, made before this, and conflating the two would mean a
 * relay running without licensing enforced silently applied nobody's limits.
 */
export function limitsFor(verdict) {
  const plan = verdict && verdict.valid ? (verdict.plan || 'pro') : 'free'
  if (plan !== 'pro') {
    const f = TIERS.free
    return {
      tier: 'free', seats: 1,
      msgsPerSec: f.msgsPerSec, msgBurst: f.msgBurst,
      bytesPerSec: f.bytesPerSec, byteBurst: f.byteBurst,
      maxFrameBytes: LIMITS.maxFrameBytes,
      maxDocBytes: f.maxDocBytes,
      maxConnsPerRoom: f.maxConnsPerRoom,
      cooloffMs: LIMITS.cooloffMs,
    }
  }
  const seats = Math.max(1, Number(verdict.seats) || 1)
  const p = TIERS.pro
  return {
    tier: 'pro', seats,
    msgsPerSec: p.msgsPerSecPerSeat * seats,
    msgBurst: p.msgBurstPerSeat * seats,
    bytesPerSec: p.bytesPerSecPerSeat * seats,
    byteBurst: p.byteBurstPerSeat * seats,
    maxFrameBytes: LIMITS.maxFrameBytes,
    maxDocBytes: Math.min(p.maxDocBytesPerSeat * seats, p.maxDocBytesCeiling),
    maxConnsPerRoom: Math.min(p.connsPerSeat * seats, p.maxConnsCeiling),
    cooloffMs: LIMITS.cooloffMs,
  }
}

export { TIERS }

export const LIMITS = {
  // Token bucket: sustained rate, with a burst allowance for legitimate spikes.
  msgsPerSec: num('HIVE_MAX_MSGS_PER_SEC', 200),
  msgBurst: num('HIVE_MAX_MSG_BURST', 2000),
  bytesPerSec: num('HIVE_MAX_BYTES_PER_SEC', 8 * 1024 * 1024),
  byteBurst: num('HIVE_MAX_BYTE_BURST', 32 * 1024 * 1024),
  // A single frame. y-websocket's first sync step can be large, so this is not tight.
  maxFrameBytes: num('HIVE_MAX_FRAME_BYTES', 16 * 1024 * 1024),
  // Retained CRDT size for one doc. A doc is one file in this design.
  maxDocBytes: num('HIVE_MAX_DOC_BYTES', 64 * 1024 * 1024),
  maxConnsPerRoom: num('HIVE_MAX_CONNS_PER_ROOM', 64),
  // The only cap that spans a whole project: a client holds one socket per open file (up to
  // HIVE_MAX_OPEN_FILES=128) plus its base room, and each file is its own room as far as the
  // per-room ceiling is concerned -- so a real team is bounded by THIS number and nothing else.
  // It was 512: three participants on a 150-file room measured 409 connections, so a fourth
  // was refused, on a relay already carrying other rooms. Measured cost 25 Sep 2026: ~56 KB of
  // relay memory per connection (400 extra sockets to the same 400 docs: +22 MB), so 2048 is
  // ~115 MB -- comfortable on a 512 MB free instance.
  maxConnsTotal: num('HIVE_MAX_CONNS_TOTAL', 2048),
  // ONE SOCKET PER PARTICIPANT (hive-mux-proto.js). A mux socket counts ONCE against
  // maxConnsTotal above; each file it opens is a CHANNEL, counted against the file's per-room
  // ceiling exactly as a per-file socket is, and against these two caps instead of the socket
  // total -- which is the whole point: a participant stops costing 129 sockets.
  //
  // Sized by MEMORY, measured 25 Sep 2026: ~25.8 KB per channel whose doc no one else holds (the
  // doc is most of it), ~2.4 KB for each further participant on the same doc. The socket cap
  // used to bound open docs as a side effect; this is what bounds them now. 8192 lone small docs
  // is ~211 MB on the 512 MB hosted instance -- raise it with the instance, not before. The per-
  // participant cap matches the client's own bound in one-socket mode, so no single participant
  // can take more than half the relay.
  maxChannelsTotal: num('HIVE_MAX_CHANNELS_TOTAL', 8192),
  maxChannelsPerSocket: num('HIVE_MUX_MAX_DOCS', 4096),
  // How many channel OPENs one participant's socket gets per event-loop turn (relay-mux.js).
  opensPerTurn: num('HIVE_MUX_OPENS_PER_TURN', 64),
  // UNUSED since 27 Sep 2026, kept so a relay configured with it still starts. It was how long
  // a client stayed refused after tripping a rate limit; a frame over the rate now waits and
  // drains at the tier's rate instead (attachRateLimit), so there is nothing to cool off from.
  cooloffMs: num('HIVE_RATE_COOLOFF_MS', 5000),
}

// ── token bucket ────────────────────────────────────────────────────────────────────────
// Chosen over a fixed window because a fixed window has an edge: 2x the limit can pass
// across a boundary, which is exactly when a sync storm happens.
class Bucket {
  constructor(ratePerSec, capacity) {
    this.rate = ratePerSec
    this.cap = capacity
    this.tokens = capacity
    this.last = Date.now()
  }
  refill(now) {
    const elapsed = (now - this.last) / 1000
    if (elapsed > 0) {
      this.tokens = Math.min(this.cap, this.tokens + elapsed * this.rate)
      this.last = now
    }
  }
  take(n, now = Date.now()) {
    this.refill(now)
    // A request bigger than the whole burst could never be covered, so it passes when the
    // bucket is FULL and leaves a debt the rate repays. Needed now that an over-budget frame
    // waits instead of being dropped: a frame between the byte burst and the frame cap would
    // otherwise wait forever.
    if (this.tokens >= n || (n > this.cap && this.tokens >= this.cap)) { this.tokens -= n; return true }
    return false
  }
  give(n) { this.tokens = Math.min(this.cap, this.tokens + n) }
  /** Milliseconds until take(n) could succeed. */
  msUntil(n, now = Date.now()) {
    this.refill(now)
    const need = Math.min(n, this.cap) - this.tokens
    return need <= 0 ? 0 : Math.ceil((need / this.rate) * 1000)
  }
}

// ── per-relay and per-room connection counts ────────────────────────────────────────────
let totalConns = 0
const roomConns = new Map() // room -> count

/**
 * Called at the HTTP upgrade, BEFORE the websocket handshake completes, so a rejected
 * connection costs one socket and no doc state. Returns null to admit, or {code, reason}.
 */
export function admitConnection(room, tier = null) {
  if (totalConns >= LIMITS.maxConnsTotal) {
    return { code: 503, reason: `Q430 relay at capacity (${LIMITS.maxConnsTotal} connections)` }
  }
  // The per-room ceiling is the TIER's, so a free room cannot hold as many sockets as a
  // 20-seat Pro room. Falls back to the flat value when no tier is supplied, which is what
  // happens on a relay running with licensing disabled.
  const cap = (tier && tier.maxConnsPerRoom) || LIMITS.maxConnsPerRoom
  const n = roomConns.get(room) || 0
  if (n >= cap) {
    const which = tier ? `${tier.tier} tier` : 'this relay'
    return { code: 429, reason: `Q431 room at capacity (${cap} connections on ${which})` }
  }
  return null
}

export function noteConnectionOpened(room) {
  totalConns++
  roomConns.set(room, (roomConns.get(room) || 0) + 1)
}

// Channels share roomConns with sockets on purpose: the per-room ceiling means "how many
// participants hold this file", and it must mean that whichever transport each one uses.
let totalChannels = 0
export function admitChannel(room, tier = null) {
  if (totalChannels >= LIMITS.maxChannelsTotal) {
    return { code: 503, reason: `Q438 relay at capacity (${LIMITS.maxChannelsTotal} open files across all participants)` }
  }
  const cap = (tier && tier.maxConnsPerRoom) || LIMITS.maxConnsPerRoom
  const n = roomConns.get(room) || 0
  if (n >= cap) {
    const which = tier ? `${tier.tier} tier` : 'this relay'
    return { code: 429, reason: `Q431 room at capacity (${cap} connections on ${which})` }
  }
  return null
}
export function noteChannelOpened(room) {
  totalChannels++
  roomConns.set(room, (roomConns.get(room) || 0) + 1)
}
export function noteChannelClosed(room) {
  totalChannels = Math.max(0, totalChannels - 1)
  const n = (roomConns.get(room) || 1) - 1
  if (n <= 0) roomConns.delete(room)
  else roomConns.set(room, n)
}

export function noteConnectionClosed(room) {
  totalConns = Math.max(0, totalConns - 1)
  const n = (roomConns.get(room) || 1) - 1
  if (n <= 0) roomConns.delete(room) // never leak a zero entry per room
  else roomConns.set(room, n)
}

// ── document size ───────────────────────────────────────────────────────────────────────
// Measured from the encoded update size we have already seen, accumulated per doc. Asking
// Yjs to encode the whole state on every message would itself be the performance problem.
const docBytes = new Map() // docName -> approximate retained bytes

export function noteDocBytes(docName, n) {
  docBytes.set(docName, (docBytes.get(docName) || 0) + n)
}

export function docOverCap(docName, tier = null) {
  const cap = (tier && tier.maxDocBytes) || LIMITS.maxDocBytes
  return (docBytes.get(docName) || 0) >= cap
}

export function docSize(docName) { return docBytes.get(docName) || 0 }

/** Seed a doc's counter from its real encoded size, e.g. after loading a snapshot. */
export function setDocBytes(docName, n) { docBytes.set(docName, Math.max(0, Number(n) || 0)) }

export function forgetDoc(docName) { docBytes.delete(docName) }

// ── per-connection rate limiting ────────────────────────────────────────────────────────
/**
 * Attach buckets to one connection. Returns a `check(byteLength)` the message handler calls
 * for every inbound frame: null to allow (the budget is charged), {reason, hold:true, retryMs}
 * when the frame is over the rate and must WAIT (nothing is charged, so the retry is charged
 * once), or {reason} to refuse it outright -- only an oversized frame, which no wait can fix.
 *
 * Over the rate means wait, never drop: a dropped Yjs update is a gap that every later update
 * from the same client builds on, so the document freezes for that client (server.js,
 * installUsageLimits). There is no cooloff any more; a held frame drains at the tier's rate.
 *
 * State lives on the connection object, so it is freed with the socket and there is no map
 * to leak or sweep.
 */
export function attachRateLimit(conn, tier = null) {
  const T = tier || LIMITS
  const msgs = new Bucket(T.msgsPerSec, T.msgBurst)
  const bytes = new Bucket(T.bytesPerSec, T.byteBurst)
  const frameCap = T.maxFrameBytes || LIMITS.maxFrameBytes
  let refusedCount = 0, throttledCount = 0
  // Usage, per connection. This is the raw material for the per-agent visibility below,
  // and it is counted here because this is the only place every inbound frame passes.
  let msgCount = 0, byteCount = 0, writeCount = 0, writeBytes = 0
  const openedAt = Date.now()

  conn._hiveLimit = {
    tier: T.tier || 'flat',
    seats: T.seats || null,
    check(byteLength) {
      const now = Date.now()
      if (byteLength > frameCap) {
        // Not a rate problem: one oversized frame is a bug in the client.
        refusedCount++
        return { reason: `Q433 frame of ${byteLength} bytes exceeds the ${frameCap}-byte limit` }
      }
      if (!msgs.take(1, now)) {
        return { hold: true, retryMs: msgs.msUntil(1, now), reason: `Q432 over the message rate (${T.msgsPerSec}/s sustained, ${T.msgBurst} burst${T.tier ? `, ${T.tier} tier` : ''})` }
      }
      if (!bytes.take(byteLength, now)) {
        msgs.give(1)
        return { hold: true, retryMs: bytes.msUntil(byteLength, now), reason: `Q434 over the byte rate (${Math.round(T.bytesPerSec / 1024)} KB/s sustained${T.tier ? `, ${T.tier} tier` : ''})` }
      }
      msgCount++; byteCount += byteLength
      return null
    },
    /** Called by the relay once it knows a passing frame was a write, not a read. */
    noteWrite(byteLength) { writeCount++; writeBytes += byteLength },
    /** Called by the relay once per frame it made wait, however many retries that took. */
    noteThrottled() { throttledCount++ },
    get refused() { return refusedCount },
    get throttled() { return throttledCount },
    usage() {
      return {
        msgs: msgCount, bytes: byteCount,
        writes: writeCount, writeBytes,
        refused: refusedCount,
        throttled: throttledCount,
        heldMs: Date.now() - openedAt,
      }
    },
  }
  return conn._hiveLimit
}

// ── PER-AGENT USAGE ─────────────────────────────────────────────────────────────────────
// "Cost visibility (per-agent token spend)" is a stated buyer requirement, and it needs one
// honest correction: THE RELAY CANNOT SEE TOKENS. An agent's LLM calls go to Anthropic or
// OpenAI directly and never touch this process, so any token number here would be invented.
//
// What the relay genuinely knows is ACTIVITY, and it is the more useful half for the problem
// people actually have: which agent is writing, how much, to which files, and who is sitting
// on a claim. That answers "why is this room slow", "which agent is hammering routes.js" and
// "what did each agent actually do" -- none of which a token count answers.
//
// Keyed by room+identity and kept in memory only. It is operational telemetry, not billing:
// billing is seats, which the licence record already decides.
const usage = new Map() // `${room} ${identity}` -> {msgs, bytes, writes, writeBytes, refused, files:Set, sessions, lastAt}
const UKEY = (room, who) => `${room} ${who}`

export function recordUsage(room, who, u, file = null) {
  if (!room || !who || !u) return
  const k = UKEY(room, who)
  let e = usage.get(k)
  if (!e) { e = { msgs: 0, bytes: 0, writes: 0, writeBytes: 0, refused: 0, throttled: 0, files: new Set(), sessions: 0, heldMs: 0, lastAt: 0 }; usage.set(k, e) }
  e.msgs += u.msgs || 0
  e.bytes += u.bytes || 0
  e.writes += u.writes || 0
  e.writeBytes += u.writeBytes || 0
  e.refused += u.refused || 0
  e.throttled += u.throttled || 0
  e.heldMs += u.heldMs || 0
  e.sessions += 1
  if (file) e.files.add(file)
  e.lastAt = Date.now()
}

/** Per-agent activity for one room, or every room when `room` is omitted. */
export function usageFor(room = null) {
  const out = []
  for (const [k, e] of usage) {
    const [r, who] = k.split(' ')
    if (room && r !== room) continue
    out.push({
      room: r, agent: who,
      msgs: e.msgs, bytes: e.bytes,
      writes: e.writes, writeBytes: e.writeBytes,
      refused: e.refused,
      throttled: e.throttled,
      files: e.files.size,
      sessions: e.sessions,
      connectedMs: e.heldMs,
      lastAt: e.lastAt,
    })
  }
  // Busiest writer first — the question this data exists to answer.
  return out.sort((a, b) => b.writeBytes - a.writeBytes || b.writes - a.writes)
}

export function stats() {
  return {
    connections: totalConns,
    channels: totalChannels,
    rooms: roomConns.size,
    largestDocBytes: docBytes.size ? Math.max(...docBytes.values()) : 0,
    docsTracked: docBytes.size,
    limits: LIMITS,
  }
}

/** Test-only: reset module state between cases. */
export function _reset() {
  totalConns = 0
  totalChannels = 0
  roomConns.clear()
  docBytes.clear()
  usage.clear()
}
