// SELF-DECLARED BUSY: "I am mid-task, do not expect an answer this second."
//
// WHY THIS IS STATE AND NOT A MESSAGE. The obvious design is an auto-reply: someone @s you
// while you are working, you post "busy, will get back to you". Eight agents and one broadcast
// is eight of those, each of which is itself a message in the room; if the acknowledgements are
// addressed they wake the sender, who is also busy, who acknowledges back. That is a spam
// channel with extra steps, and this room has already been through it once -- a conflict
// notification loop put 56 copies of one line into chat and 306 of 2,314 lines were that loop.
//
// So nobody announces anything. The busy agent sets a flag and keeps working, and the
// INFORMATION IS HANDED TO THE SENDER AT SEND TIME instead: hive_say reports the recipient's
// state in its own return value. Same fact, delivered faster than a reply could arrive, and it
// adds zero messages to the room. The interrupted agent is never made to interrupt itself in
// order to be polite.
//
// The `controls` map is deliberately not reused. That is mission control -- a HUMAN sets
// running/paused there -- and an agent writing its own state into the same entry would clobber
// a human's pause with a self-report. Different author, different authority, different map.
//
// TTL, for the same reason claims have one: an agent that dies mid-task must not leave a
// permanent "busy" flag behind that quietly teaches the whole room to stop talking to it. A
// stale flag is worse than no flag, because everyone believes it.

/** Default life of a busy flag. Long enough for real work, short enough that a crash clears. */
export const DEFAULT_TTL = 10 * 60 * 1000

/**
 * The ceiling, and it is the load-bearing one.
 *
 * The whole point of a TTL here is that a crashed agent cannot leave the room believing it is
 * permanently busy. Without a cap, `ttl: Infinity` -- or a caller passing milliseconds where it
 * meant minutes -- reinstates exactly the failure the TTL exists to prevent, and it fails
 * silently: everyone simply stops expecting an answer, forever, and nothing looks broken.
 *
 * An hour is past the point where "busy" is still true. Beyond that the agent is stuck, and the
 * room is better off treating it as free and finding out.
 */
export const MAX_TTL = 60 * 60 * 1000

/** An entry as stored: { what, since, ttl }. `since` is unix ms, matching hive-coord's claims. */

/** Live, or expired/absent? Pure, so the TTL is testable on a virtual clock. */
export function isBusy(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return false
  const since = Number(entry.since) || 0
  // Clamped on READ as well as on write, and this is the side that matters: the entry arrives
  // over the wire from another client, which may be an older build, a different version, or
  // simply wrong. Trusting a ttl we did not create is how one peer gets to pin the whole room.
  const ttl = Math.min(MAX_TTL, Math.max(1000, Number(entry.ttl) || DEFAULT_TTL))
  return since > 0 && now - since < ttl
}

/** Build an entry. `what` is free text -- what they are doing, for the sender to read. */
export function makeBusy(what, { ttl = DEFAULT_TTL, now = Date.now() } = {}) {
  // Clamped at BOTH ends. 0/NaN/absent falls back to the default; anything above the ceiling is
  // brought down to it, so no caller -- and no bad arithmetic in a caller -- can mint a flag
  // that outlives the work it describes.
  const want = Number(ttl) || DEFAULT_TTL
  return { what: String(what || 'working').slice(0, 200), since: now, ttl: Math.min(MAX_TTL, Math.max(1000, want)) }
}

/** How long they have been at it, in words a sender can act on. */
export function busyFor(entry, now = Date.now()) {
  const ms = Math.max(0, now - (Number(entry && entry.since) || now))
  const s = Math.round(ms / 1000)
  if (s < 90) return s + 's'
  const m = Math.round(s / 60)
  return m < 90 ? m + 'm' : Math.round(m / 60) + 'h'
}

/**
 * The line hive_say hands back to a sender about one recipient.
 *
 * Returns '' when there is nothing worth saying, so callers can drop it with a falsy check --
 * silence is the right output for "they are here and free", which is the common case and does
 * not need a sentence.
 *
 * @param {string} name        the recipient
 * @param {object|null} entry  their busy entry, if any
 * @param {boolean} present    are they actually in the room right now
 */
export function describeRecipient(name, entry, present, now = Date.now()) {
  // ABSENCE OUTRANKS BUSY, and it is the more useful of the two: a message to someone who left
  // is not delayed, it is unread forever, and the sender is the only one who can notice.
  if (!present) return `@${name} is NOT in the room — nobody will read that. hive_members lists who is here.`
  if (isBusy(entry, now)) return `@${name} has been busy ${busyFor(entry, now)} (${entry.what}) — expect a delay, they are not idle waiting on you.`
  return ''
}
