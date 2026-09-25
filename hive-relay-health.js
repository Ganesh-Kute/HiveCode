// WHY FILES ARE NOT SYNCING — asked of the relay, not guessed from the symptom.
//
// THE DEFECT THIS REPLACES.
// Two places told an operator why their files were not arriving: sync.js, when file docs went
// quiet, and hive-mcp.js, when hive_join failed to sync. Both carried the same three faults.
//
//   1. Both printed the literal string "<relay-http>/health" -- a placeholder, never
//      substituted, while the relay URL sat in scope a few lines away.
//   2. Both named only Q430 and only limits.maxConnsTotal. limits.js:176 ALSO refuses with
//      Q431 on a PER-ROOM cap, and the two need different fixes: HIVE_MAX_CONNS_TOTAL for the
//      first, HIVE_SEATS for the second. An operator hitting Q431 and following that advice
//      raises a limit that was never the constraint, sees no change, and is entitled to
//      conclude the product is broken.
//   3. Both told a HUMAN to go read /health. The client can read it itself, in the same
//      breath, and say which cause it actually is.
//
// MEASURED, 21 Sep 2026. A third agent joined room `night` and announced that 49 files could
// not connect, "the usual cause is the relay being full (Q430)". At that moment the relay
// reported 56 connections of 512. limits.js keys its per-room counter on the FILE-room, and
// each file held three connections against a cap of 64. Q430 needed 512 and had 56. Q431 needed
// 64 and had 3. NEITHER REFUSAL COULD HAVE FIRED.
//
// What had actually happened: /health went rooms 44 -> 0 -> 29 -> 31 -> 44 over a few minutes.
// The relay dropped its room state and every client began reconnecting, one socket per file.
//
// "The relay is full" and "the relay just dropped everyone and we are all reconnecting" produce
// an IDENTICAL local symptom -- N file docs with synced=false -- and need opposite responses: a
// config change, or thirty seconds of patience. The difference is a number only the relay has.
// So ask it.
//
// ONE PRODUCER, ON PURPOSE. learnings/repair-the-class-not-the-copy.md exists in this repo
// because a fix landed on one instance and the class survived into two more tickets. Two
// hand-written copies of a diagnosis is that state exactly: they had already drifted (the
// hive-mcp.js copy listed three candidate causes, the sync.js copy asserted one). This module is
// the only place the wording lives, and tests/relay-diagnosis-test.mjs COUNTS the producers so a
// third copy fails a test rather than shipping.

/** A free-tier per-room cap. At or below this, Q431 is the likely refusal and seats are the fix. */
export const FREE_TIER_ROOM_CAP = 8

/** Fraction of maxConnsTotal at which "the relay is effectively full" is the right reading. */
export const NEAR_CAPACITY = 0.9

/**
 * Turn a websocket relay URL into its /health URL.
 * Exported because a caller that cannot fetch still wants to NAME the URL correctly, which is
 * the whole of defect (1) above.
 */
export function healthUrlFor(relay) {
  const base = String(relay || '')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:')
    .replace(/\/+$/, '')
  return /^https?:/i.test(base) ? `${base}/health` : null
}

/**
 * Ask the relay for its own numbers.
 *
 * NEVER THROWS, AND NEVER BLOCKS FOR LONG. This runs inside a diagnostic, and a diagnostic that
 * can hang is a diagnostic that withholds the warning it exists to deliver. The warning matters
 * more than the detail: a failed probe still produces a message, with the failure named.
 *
 * `ok` means "the probe worked", NOT "the relay is healthy". Conflating those is how a monitor
 * reports the absence of an answer as a clean bill of health.
 */
export async function probeRelayHealth(relay, { timeoutMs = 2500, fetchImpl } = {}) {
  const url = healthUrlFor(relay)
  if (!url) return { ok: false, url: null, error: 'no usable relay URL' }
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  if (!f) return { ok: false, url, error: 'no fetch available in this runtime' }
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    if (t && t.unref) t.unref()
    let res
    try { res = await f(url, { signal: ac.signal }) } finally { clearTimeout(t) }
    if (!res || !res.ok) return { ok: false, url, error: `HTTP ${res ? res.status : 'no response'}` }
    const j = await res.json()
    return { ok: true, url, health: j }
  } catch (e) {
    const name = e && e.name
    const why = name === 'AbortError' ? `no response in ${timeoutMs}ms` : ((e && e.message) || 'unreachable')
    return { ok: false, url, error: why }
  }
}

/** The four readings this can produce. Named so a test can assert on the verdict, not the prose. */
export const RELAY_FULL = 'RELAY_FULL'
export const ROOM_CAP = 'ROOM_CAP'
export const NOT_CAPACITY = 'NOT_CAPACITY'
export const UNREACHABLE = 'UNREACHABLE'

/**
 * Decide what the numbers mean, and say it in a way an operator can act on.
 *
 * Returns { verdict, text }. The verdict is for tests and for callers that want to branch; the
 * text is what a human reads. Keeping them separate is what lets the test pin the DECISION
 * rather than the wording, so rephrasing the advice does not break the suite and changing the
 * advice does.
 *
 * @param {object} probe   the result of probeRelayHealth()
 * @param {object} opts
 * @param {number} opts.stuck   how many files are not synced
 * @param {string} opts.what    'files' (sync.js) or 'join' (hive-mcp.js) -- changes the lead only
 */
export function diagnose(probe, { stuck = 0, what = 'files' } = {}) {
  const h = (probe && probe.ok && probe.health) || null
  const url = (probe && probe.url) || 'the relay'

  const lead = what === 'join'
    ? 'The relay did not sync this folder.'
    : `${stuck} file(s) are not synced and will READ AS EMPTY until this clears.`

  if (!h) {
    // A probe that failed is MORE specific than any guess, not less: the relay is unreachable
    // over HTTP from this machine, so capacity is not the question and no limit needs changing.
    return {
      verdict: UNREACHABLE,
      text: [
        lead,
        `I could not reach ${url}${probe && probe.error ? ` (${probe.error})` : ''}, so the relay may be down,`,
        `restarting, or blocked from this machine. THAT IS NOT A CAPACITY PROBLEM and no limit needs raising.`,
        `Check that the relay is running and that this host can reach it.`,
      ].join(' '),
    }
  }

  const total = Number(h.limits && h.limits.maxConnsTotal) || 0
  const conns = Number(h.connections) || 0
  const perRoom = Number(h.connsPerRoom) || Number(h.limits && h.limits.maxConnsPerRoom) || 0
  const seats = h.seats ? ` (${h.seats} seats)` : ''
  const facts = `I asked ${url}: ${conns} of ${total} connections in use, ${h.rooms || 0} rooms, per-room cap ${perRoom}${seats}.`

  // ONE SOCKET PER PARTICIPANT has its own ceiling: the files open across every participant's
  // shared socket (Q438). Checked first, because at that ceiling the socket count looks healthy.
  const chanCap = Number(h.limits && h.limits.maxChannelsTotal) || 0
  const chans = Number(h.channels) || 0
  if (Number(h.mux) >= 1 && chanCap && chans >= chanCap * NEAR_CAPACITY) {
    return {
      verdict: RELAY_FULL,
      text: [lead, `I asked ${url}: ${chans} of ${chanCap} open files in use across all participants.`,
        `THE RELAY IS AT ITS OPEN-FILE CAPACITY — this is Q438. Raise HIVE_MAX_CHANNELS_TOTAL on the relay,`,
        `or narrow what syncs.`].join(' '),
    }
  }

  if (total && conns >= total * NEAR_CAPACITY) {
    // Who spends the sockets depends on the transport. A relay offering one-socket mode charges
    // those clients 2 each; the older transport, still spoken by the VS Code extension, the browser
    // panel and HIVE_MUX=0, charges one PER FILE -- and that is what exhausts a relay.
    const who = Number(h.mux) >= 1
      ? `This relay carries each participant's files on one socket (2 sockets a participant), but clients`
        + ` on the older transport -- the VS Code extension, the browser panel, HIVE_MUX=0 -- still open one`
        + ` socket PER FILE, and one large folder on those can exhaust it alone.`
      : `Hivecode opens one socket PER FILE, so a single large folder can exhaust it alone.`
    return {
      verdict: RELAY_FULL,
      text: [lead, facts,
        `THE RELAY IS AT OR NEAR CAPACITY — this is Q430.`, who,
        `Raise HIVE_MAX_CONNS_TOTAL on the relay, or narrow what syncs.`].join(' '),
    }
  }

  if (perRoom && perRoom <= FREE_TIER_ROOM_CAP) {
    // The case the old message could not express at all, and the one where its advice was
    // actively harmful: total headroom is fine, so raising the total changes nothing.
    return {
      verdict: ROOM_CAP,
      text: [lead, facts,
        `The relay has total headroom, but its PER-ROOM cap is ${perRoom} and it refuses past that with Q431.`,
        `That is a free-tier default. Set HIVE_SEATS on the relay — raising HIVE_MAX_CONNS_TOTAL will NOT help,`,
        `because the total is not the constraint.`].join(' '),
    }
  }

  return {
    verdict: NOT_CAPACITY,
    text: [lead, facts,
      `CAPACITY IS NOT THE CAUSE: ${Math.max(0, total - conns)} of ${total} connections are free and the per-room`,
      `cap is ${perRoom}. These sockets are most likely still reconnecting — the relay drops room state on`,
      `restart and every file reconnects separately, which looks exactly like this for a minute or two.`,
      `Wait and re-check before changing any limit. If it persists, the room may be secured and this client`,
      `may carry no token, or the relay may be failing its licence check closed.`].join(' '),
  }
}

/**
 * The whole diagnosis in one call, for the two callers that want it.
 * `trailer` is appended verbatim -- sync.js needs "do not trust this folder's contents", a
 * failed join needs its own instructions, and neither belongs in the capacity reasoning.
 */
export async function explainNotSyncing(relay, { stuck = 0, what = 'files', trailer = '', timeoutMs = 2500, fetchImpl } = {}) {
  const probe = await probeRelayHealth(relay, { timeoutMs, fetchImpl })
  const d = diagnose(probe, { stuck, what })
  return { ...d, probe, text: trailer ? `${d.text} ${trailer}` : d.text }
}

/**
 * Extract HTTP status code from a WebSocket or upgrade error, if present.
 */
export function statusFromError(e) {
  if (!e) return null
  if (typeof e === 'number') return e
  if (e.status && typeof e.status === 'number') return e.status
  if (e.code && typeof e.code === 'number') return e.code
  if (e.statusCode && typeof e.statusCode === 'number') return e.statusCode
  const m = /Unexpected server response:\s*(\d{3})/.exec((e.message || e.reason || String(e)))
  return m ? Number(m[1]) : null
}

/**
 * Authoritative explanations for HTTP status codes returned by the relay on connection upgrade.
 */
export function explainStatus(code, relay = '') {
  const c = Number(code)
  if (c === 401) return 'the relay rejected your token. It may have expired -- ask the room owner for a new invite.'
  if (c === 402) return 'this room is over its plan limit. Contact support@getgrm.tech and we will sort it out.'
  if (c === 403) return 'the relay refused this room or path for your token. You are outside the folders you were given.'
  if (c === 429) return 'this room is FULL, so you were not let in (Q431). A relay admits a limited number of connections per room -- 8 on the free tier -- and this room is at that ceiling. Note it counts CONNECTIONS, not people: one agent holding several files holds several. If you run the relay, raise it with HIVE_SEATS; otherwise ask whoever does, or contact support@getgrm.tech.'
  if (c === 503) return 'the relay is not serving this connection. Either the whole relay is at capacity (Q430 sockets, Q438 open files, or Q439 files held by one participant) or it could not check your licence and is failing closed rather than guessing. It may also be restarting -- if this lasts, contact support@getgrm.tech.'
  if (c) return `the relay answered ${c} instead of accepting the connection. Contact support@getgrm.tech.`
  return `the relay at ${relay || 'the relay'} cannot be reached. It may be down, asleep, or blocked by a network. Contact support@getgrm.tech if this continues.`
}

