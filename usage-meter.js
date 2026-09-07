// USAGE METER, relay side — the half that makes "auto-lock when it crosses" work across
// restarts and across relay instances.
//
// The relay already counts every byte (limits.js). What it could not do was REMEMBER: those
// counters lived in memory, so a restart reset them and nothing accumulated over a month.
// This flushes deltas to /api/usage and reads the period total back, so the meter survives
// the process and several relays can meter the same account.
//
// THREE DECISIONS THAT MATTER MORE THAN THE CODE
//
// 1. FAIL OPEN. If the meter is unreachable, nobody is locked. A false lock on a paying
//    customer is far worse than a few unmetered megabytes, and it is the same posture
//    license-check.js takes with its grace window: "we could not check" must never be
//    delivered to a customer as "you have exceeded your plan". Every failure path here
//    returns "allowed".
//
// 2. DELTAS, NOT TOTALS, and under-counting is the safe direction. A relay that dies before
//    flushing loses one batch. A relay that retries adds one twice. We accept losing a batch
//    and avoid double-charging, because the cost of over-counting is locking someone out of
//    work they paid for.
//
// 3. THE QUOTA IS CACHED. A room full of agents must not produce a request per message. The
//    cached verdict is refreshed on an interval, which means an account can overshoot its
//    limit by up to one interval's traffic. That is deliberate: a hard real-time quota would
//    mean a network round trip in the write path, which is the one place latency is visible.
//
// Env:
//   HIVE_USAGE_API        default https://hivecode.vercel.app/api/usage
//   HIVE_USAGE_SECRET     shared with the endpoint; metering is OFF unless this is set
//   HIVE_USAGE_FLUSH_MS   how often deltas are sent, default 60000
//   HIVE_USAGE_TTL_MS     how long a quota verdict is trusted, default 120000
//   HIVE_FREE_PERIOD_WRITE_BYTES / _WRITES   the free monthly allowance

const API = process.env.HIVE_USAGE_API || 'https://hivecode.vercel.app/api/usage'
const SECRET = (process.env.HIVE_USAGE_SECRET || '').trim()
const FLUSH_MS = Number(process.env.HIVE_USAGE_FLUSH_MS) || 60_000
const TTL_MS = Number(process.env.HIVE_USAGE_TTL_MS) || 120_000
const TIMEOUT_MS = Number(process.env.HIVE_USAGE_TIMEOUT_MS) || 4000

// The free monthly allowance. Generous on purpose: it exists to bound cost and to make the
// paid tier obviously better, not to interrupt someone who is still deciding whether the
// product works. A team doing real work for a month lands well under it.
export const FREE_PERIOD = {
  writeBytes: Number(process.env.HIVE_FREE_PERIOD_WRITE_BYTES) || 512 * 1024 * 1024,
  writes: Number(process.env.HIVE_FREE_PERIOD_WRITES) || 200_000,
}

export const meteringEnabled = () => Boolean(SECRET)

/** Calendar month, UTC — must match api/usage.js exactly or the rows will not line up. */
export function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * The account a room meters against: the licence key when there is one, else the base room.
 * A paid account therefore accumulates across all of its rooms; an anonymous room
 * accumulates alone. Keys are truncated to their tail so a full licence key never lands in
 * a log line or an error message.
 */
export function accountFor(license, baseRoom) {
  const k = (license || '').trim()
  if (k) return 'lic:' + k.slice(-12)
  return 'room:' + String(baseRoom || 'default').slice(0, 180)
}

// ── pending deltas ──────────────────────────────────────────────────────────────────────
const pending = new Map()  // account -> {writes, writeBytes, msgs, bytes, rooms, agents}
// Keyed `account|period`, NOT by account alone. Keying by account meant an account locked in
// March stayed locked into April until the TTL expired -- self-healing in two minutes, but
// the two minutes fall on the 1st of the month, in front of a customer whose allowance has
// just reset. The period is part of the identity of the verdict, so it belongs in the key.
const quota = new Map()    // `${account}|${period}` -> {over, at, usage}
let timer = null

const qkey = (account, period = currentPeriod()) => `${account}|${period}`

export function note(account, delta) {
  if (!SECRET || !account) return
  let p = pending.get(account)
  if (!p) { p = { writes: 0, writeBytes: 0, msgs: 0, bytes: 0, rooms: 0, agents: 0 }; pending.set(account, p) }
  p.writes += delta.writes || 0
  p.writeBytes += delta.writeBytes || 0
  p.msgs += delta.msgs || 0
  p.bytes += delta.bytes || 0
  p.rooms = Math.max(p.rooms, delta.rooms || 0)
  p.agents = Math.max(p.agents, delta.agents || 0)
}

async function post(account, body) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hive-Usage': SECRET },
      body: JSON.stringify({ account, period: currentPeriod(), ...body }),
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`usage api ${res.status}`)
    return await res.json()
  } finally { clearTimeout(t) }
}

/** Send everything pending. Deltas are cleared BEFORE the request — see decision 2. */
export async function flush() {
  if (!SECRET || !pending.size) return { flushed: 0 }
  const batch = [...pending.entries()]
  pending.clear()
  let ok = 0
  for (const [account, delta] of batch) {
    try {
      const merged = await post(account, delta)
      // The response is the authoritative period total, so refresh the verdict from it for
      // free: no extra GET, and the number that decides the lock is the number the store holds.
      if (merged && merged.ok) {
        quota.set(qkey(account), {
          over: overFree({ writeBytes: merged.write_bytes, writes: merged.writes }),
          at: Date.now(),
          usage: { writeBytes: merged.write_bytes, writes: merged.writes, msgs: merged.msgs, bytes: merged.bytes },
        })
      }
      ok++
    } catch (e) {
      // Dropped, not retried. A retry queue that grows during an outage is how a telemetry
      // path takes down the thing it was measuring.
      console.warn(`[relay] usage flush failed for ${account}: ${e && e.message} (delta dropped)`)
    }
  }
  return { flushed: ok, of: batch.length }
}

export function overFree(u) {
  if (!u) return false
  return (u.writeBytes || 0) >= FREE_PERIOD.writeBytes || (u.writes || 0) >= FREE_PERIOD.writes
}

// How far through the free allowance, 0..1+, on whichever counter is furthest along. A limit
// that arrives with no warning reads as a fault rather than a plan boundary -- the customer's
// first thought is "it broke", and by then they are already annoyed.
const WARN_AT = Number(process.env.HIVE_USAGE_WARN_AT) || 0.8

export function fractionUsed(u) {
  if (!u) return 0
  const byBytes = FREE_PERIOD.writeBytes > 0 ? (u.writeBytes || 0) / FREE_PERIOD.writeBytes : 0
  const byWrites = FREE_PERIOD.writes > 0 ? (u.writes || 0) / FREE_PERIOD.writes : 0
  return Math.max(byBytes, byWrites)
}

// Warned once per account per period. Once, because a room full of agents would otherwise
// carry the same notice on every flush, and a relay that repeats itself is a relay people
// learn to ignore -- which costs exactly the warning that mattered.
const warned = new Set()

/**
 * Returns a message to show ONCE when an account crosses the warning threshold, else null.
 * Never returns anything for an account that is already over -- at that point the refusal
 * itself is the message, and two notices about the same thing is noise.
 */
export function warningFor(account) {
  if (!SECRET || !account) return null
  const q = quota.get(qkey(account))
  if (!q || !q.usage || q.over) return null
  const f = fractionUsed(q.usage)
  if (f < WARN_AT) return null
  const k = qkey(account)
  if (warned.has(k)) return null
  warned.add(k)
  const usedMb = Math.round((q.usage.writeBytes || 0) / 1048576)
  const capMb = Math.round(FREE_PERIOD.writeBytes / 1048576)
  // An address, not a route. This said hivecode.vercel.app/pricing -- the wrong domain, and a
  // page that has since been retired -- so the warning that exists to prevent a surprise was
  // itself pointing at a 404. Same fix as the two in server.js.
  return `${Math.round(f * 100)}% of this workspace's free monthly allowance is used ` +
    `(${usedMb} MB of ${capMb} MB of writes). Writes stop at the limit; reads keep working. ` +
    `Email support@getgrm.tech to lift the limit.`
}

/**
 * Is this account over its free allowance? Cached, and ALWAYS false when unknown.
 *
 * Returns a synchronous verdict on purpose: this is consulted in the write path, and an
 * await there would put a network round trip between an agent's edit and its peers.
 */
export function isOverQuota(account) {
  if (!SECRET || !account) return false
  const q = quota.get(qkey(account))
  if (!q) { void refresh(account); return false }   // never lock on a cache miss
  if (Date.now() - q.at > TTL_MS) void refresh(account) // refresh behind the current answer
  return q.over
}

async function refresh(account) {
  if (!SECRET || !account) return
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const url = `${API}?account=${encodeURIComponent(account)}&period=${currentPeriod()}`
    const res = await fetch(url, { headers: { 'X-Hive-Usage': SECRET }, signal: ctl.signal })
    if (!res.ok) throw new Error(`usage api ${res.status}`)
    const u = await res.json()
    quota.set(qkey(account), { over: overFree(u), at: Date.now(), usage: u })
  } catch (e) {
    // Stamp the failure so we do not hammer a dead endpoint once per message, and leave the
    // verdict permissive. Fail open — decision 1.
    const prev = quota.get(qkey(account))
    quota.set(qkey(account), { over: prev ? prev.over : false, at: Date.now(), usage: prev ? prev.usage : null })
  } finally { clearTimeout(t) }
}

export function start() {
  if (!SECRET || timer) return false
  timer = setInterval(() => { void flush() }, FLUSH_MS)
  if (timer.unref) timer.unref() // metering must never be the reason the process stays up
  return true
}

export function stop() { if (timer) { clearInterval(timer); timer = null } }

export function snapshot() {
  return {
    enabled: Boolean(SECRET),
    pendingAccounts: pending.size,
    cachedAccounts: quota.size,
    overQuota: [...quota.values()].filter((q) => q.over).length,
    warned: warned.size,
    warnAt: WARN_AT,
    freeAllowance: FREE_PERIOD,
    flushMs: FLUSH_MS,
  }
}

/** Test-only. */
export function _reset() { pending.clear(); quota.clear(); warned.clear() }
export function _setQuota(account, over, usage = null) { quota.set(qkey(account), { over, at: Date.now(), usage }) }

/**
 * Drop a cached verdict so the next check re-reads the store. Called when a subscription
 * activates: a customer who has just paid must not wait out the TTL to be unlocked.
 */
export function invalidate(account) {
  for (const k of [...quota.keys()]) if (k.startsWith(account + '|')) quota.delete(k)
  for (const k of [...warned]) if (k.startsWith(account + '|')) warned.delete(k)
}
