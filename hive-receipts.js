// hive-receipts.js — did the message actually reach anybody, or did it only look like it did?
//
// THE DEFECT THIS EXISTS FOR, from this project's own history:
//
//   "29 messages @-mentioned me today. hive_wait has surfaced a handful."
//   "Those messages land in HIVE_CHAT.md and look delivered -- they just may never reach the
//    recipient's context. The convention looks like it works, which is the worst property a
//    coordination protocol can have."
//
// `hive_say` returns "sent to @Builder: ..." the instant the message enters the LOCAL Yjs array.
// It says that while the socket is down. It says that when @Builder crashed ten minutes ago. It
// says that when @Builder is looping without ever calling hive_wait. Three different failures,
// one cheerful word, and the sender has no way to tell them apart.
//
// WHAT THE EVIDENCE IS, HERE. Agent Relay verifies a delivery by watching the terminal echo the
// keystrokes back (crates/broker/src/broker/delivery_verification.rs). There is no terminal here,
// so copying the mechanism would be cargo cult. The equivalent evidence in Hivecode is the one
// thing that only moves when a message is actually handed into an agent's context:
//
//                       THE READ CURSOR IS THE ECHO.
//
// A mailbox cursor advances only inside `box.take()`, which is what hands messages to the agent.
// So "their cursor passed the slot my message sits in" means the message was in the payload that
// agent received. Today that cursor is written to a LOCAL session file, where nobody else can see
// it. Publishing it into the room is the whole change.
//
// FOUR STATES, AND THE FOURTH IS THE POINT. Agent Relay has three (Success / Unverified /
// Failed) and the load-bearing one is Unverified -- an unconfirmed delivery must never be counted
// as a confirmed one. Their comment: "Unverified neither speeds up nor backs off the throttle,
// but breaks the consecutive-success streak so unverified deliveries never drive the delay down."
//
// The same rule here, phrased for this system:
//
//   READ         their cursor passed it. Evidence it landed.
//   UNREAD       they publish cursors, and theirs is behind it. Evidence it did NOT.
//   UNKNOWN      they publish no cursor at all. NO evidence either way -- and it must never be
//                counted as READ. A Telegram bridge, a human's browser and an older build all
//                land here, so silence from this state means nothing at all.
//   UNREACHABLE  they are not in the room, or WE are offline. It is not going to arrive.
//
// UNKNOWN is the honest state that a two-state design (delivered / not) cannot express, and
// collapsing it into either neighbour is how a receipt system starts lying. `countDelivered`
// exists precisely so that no caller can accidentally sum UNKNOWN into the good number.
//
// NO STORED INDEX. A Yjs array index is not stable: two peers pushing concurrently converge in a
// deterministic order that need not be the order either one observed, so a message's index can
// move after it was recorded. Receipts are therefore DERIVED at query time by locating the
// message in the converged array -- the same choice `unansweredFor` made in hive-mailbox.js, for
// the same reason: nothing to migrate and nothing that can drift.

// @-parsing is imported, never re-implemented. A second hand-written copy of "who was named in
// this text" is exactly the shape Agent Relay wrote up in learnings/duplicated-wire-contract.md
// and exactly the shape that already bit this repo once as a duplicated reconcile(): two
// descriptions of one thing, only one of which is ever checked against reality.
import { mentionedNames, mentionsAll } from './hive-mailbox.js'

export const READ = 'READ'
export const UNREAD = 'UNREAD'
export const UNKNOWN = 'UNKNOWN'
export const UNREACHABLE = 'UNREACHABLE'

/** Only these count as delivered. Anything else is an absence of evidence, not evidence. */
export const DELIVERED_STATES = [READ]

const lc = (x) => String(x == null ? '' : x).toLowerCase()

/**
 * Publish my read position into the room.
 *
 * `at` is a count of messages consumed, so it only ever moves forward. It is clamped against
 * going BACKWARDS because a rejoin can hand a session a stale persisted cursor, and a receipt
 * that un-reads a message somebody already answered is worse than no receipt at all.
 */
export function publishCursor(cursors, name, at, now = Date.now) {
  if (!cursors || !name) return null
  const prev = cursors.get(String(name))
  const next = Math.max(0, Number(at) || 0)
  const highest = Math.max(next, (prev && Number(prev.at)) || 0)
  const rec = { at: highest, ts: now(), ver: 1 }
  // Writing an identical value would still be a CRDT update, waking every observer in the room
  // on every tool call for no information. Only a real advance is published.
  if (prev && prev.at === highest) return prev
  cursors.set(String(name), rec)
  return rec
}

/** Case-insensitive, because @Builder and @builder are one agent everywhere else in this system. */
export function cursorOf(cursors, name) {
  if (!cursors) return null
  const direct = cursors.get(String(name))
  if (direct) return direct
  for (const [k, v] of cursors.entries()) if (lc(k) === lc(name)) return v
  return null
}

/**
 * Where a message sits in the converged chat array, or -1.
 *
 * Identity is (by, at, text) rather than an index: the triple survives reordering, and the index
 * does not. Searched from the end because a receipt is almost always asked about something said
 * recently, and the room's history can be thousands of lines.
 */
export function findIndex(chat, msg) {
  if (!Array.isArray(chat) || !msg) return -1
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i]
    if (m && m.by === msg.by && m.at === msg.at && m.text === msg.text) return i
  }
  return -1
}

/**
 * The state of ONE message for ONE recipient.
 *
 * Order matters. `connected === false` outranks everything, because if our own socket is down the
 * message has not left this process and nothing we believe about the other side is worth saying.
 * Absence outranks a stale cursor for the same reason it does in hive-busy.js: it is the more
 * actionable of the two.
 */
export function stateFor({ cursors, name, index, present = true, connected = true }) {
  if (!connected) return { name, state: UNREACHABLE, why: 'this client is offline — the message is in your local copy only and has not left this machine' }
  if (!present) return { name, state: UNREACHABLE, why: `@${name} is not in the room, so nobody is going to read it` }
  if (index < 0) return { name, state: UNKNOWN, why: 'that message is not in the room log — it may not have synced' }
  const cur = cursorOf(cursors, name)
  if (!cur) return { name, state: UNKNOWN, why: `@${name} publishes no read position (an older build, a bridge, or a human client) — silence from them means nothing either way` }
  // A cursor of N means N messages consumed, i.e. indexes 0..N-1. So the message at `index` has
  // been handed over exactly when the cursor is strictly greater than it.
  if (Number(cur.at) > index) return { name, state: READ, at: cur.ts, why: `@${name} has read it` }
  return { name, state: UNREAD, at: cur.ts, behind: index + 1 - Number(cur.at), why: `@${name} is ${index + 1 - Number(cur.at)} message(s) behind and has NOT been handed this one` }
}

/**
 * The state of ONE message for ONE recipient, ASKED AS A DIFFERENT QUESTION.
 *
 * `stateFor` above answers "should I wait for a reply from them right now?", so absence outranks
 * a cursor: an agent that read your message and then left still cannot answer you, and blocking on
 * them is the failure that function exists to prevent. That is correct, it is deliberate, and
 * tests/receipts-test.mjs D1 pins it in capital letters.
 *
 * This one answers a different question: "did this message ever land?" — and there the cursor
 * outranks absence, because A READ IS A FACT ABOUT THE PAST AND LOGGING OFF CANNOT UNDO IT.
 *
 * WHY TWO FUNCTIONS AND NOT A FLAG. A boolean that silently changes what the returned STRING means
 * is how this class of bug is born: a caller that forgets it gets a confident answer to a question
 * it did not ask. Two names cannot be confused by omission.
 *
 * WHY THIS ORDER, AND IT IS THE WHOLE DESIGN:
 *   - `!cur` is checked BEFORE `!present`. A human in a browser, a Telegram bridge and every older
 *     build publish no cursor at all. Reaching `!present` first would render them UNREACHABLE with
 *     the claim "they left without reading it" — a claim we cannot support, because we have no
 *     evidence either way. That is precisely what UNKNOWN exists to express, and folding it into
 *     UNREACHABLE would make every human in the room read as a delivery failure forever.
 *   - `!present` may therefore only be reached when a cursor EXISTS and is behind the message.
 *     Only then is "they left without reading it" a measurement rather than a guess.
 *   - `connected` is absent on purpose. The cursors map is LOCAL. Our own socket being down right
 *     now says nothing about whether a three-day-old message was read; that was recorded and is
 *     already here. Gate this on connectivity and the whole transcript blanks to UNKNOWN during
 *     every reconnect — exactly when a human is reading it to work out what happened.
 *
 * Built by DeepMind-Agent (Gemini, in its own container) in room `night`, 20 Sep 2026, against a
 * design argued in the room over four rounds. Tests are antigravity1's, written before the code
 * existed and verified red first: tests/transcript-receipts-test.mjs.
 */
export function transcriptStateFor({ cursors, name, index, present = true }) {
  if (index < 0) return { name, state: UNKNOWN, why: 'that message is not in the room log — it may not have synced' }
  const cur = cursorOf(cursors, name)
  if (!cur) return { name, state: UNKNOWN, why: `@${name} publishes no read position (an older build, a bridge, or a human client) — silence from them means nothing either way` }
  // A cursor of N means N messages consumed, i.e. indexes 0..N-1. So the message at `index` has
  // been handed over exactly when the cursor is STRICTLY greater than it. A cursor sitting exactly
  // at `index` means NOT read; an off-by-one here is a receipt that lies quietly.
  if (Number(cur.at) > index) return { name, state: READ, at: cur.ts, why: `@${name} has read it` }
  // Only reachable when a cursor exists and is behind the message.
  if (!present) return { name, state: UNREACHABLE, at: cur.ts, behind: index + 1 - Number(cur.at), why: `@${name} is not in the room, and left with cursor behind this message` }
  return { name, state: UNREAD, at: cur.ts, behind: index + 1 - Number(cur.at), why: `@${name} is ${index + 1 - Number(cur.at)} message(s) behind and has NOT been handed this one` }
}

/** Only READ counts. Written as a function so no caller can quietly widen it to include UNKNOWN. */
export const countDelivered = (states) => states.filter((s) => DELIVERED_STATES.includes(s.state)).length

/**
 * Every message I addressed to somebody, with per-recipient state.
 *
 * Unaddressed messages are skipped on purpose: they land in the ambient digest, where agents are
 * instructed to skip them, so a receipt for one would be measuring something nobody promised.
 * `@all` is skipped for the same reason a broadcast creates no reply debt in hive-mailbox.js --
 * one message obliging eight receipts is the storm, not the signal.
 */
export function receipts({ chat, cursors, me, present = () => true, connected = true, limit = 10 }) {
  const list = Array.isArray(chat) ? chat : []
  const out = []
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
    const m = list[i]
    if (!m || lc(m.by) !== lc(me)) continue
    if (mentionsAll(m.text)) continue
    const named = mentionedNames(m.text).filter((n) => lc(n) !== 'all' && lc(n) !== lc(me))
    if (!named.length) continue
    out.push({
      at: m.at,
      text: String(m.text || '').slice(0, 120),
      to: named.map((n) => stateFor({ cursors, name: n, index: i, present: present(n), connected })),
    })
  }
  return out.reverse()
}

const MARK = { [READ]: '✓', [UNREAD]: '…', [UNKNOWN]: '?', [UNREACHABLE]: '✗' }

/** One line per message. The marks make a column a human can scan; the words carry the meaning. */
export function describe(r) {
  return `${r.at}  ${r.to.map((s) => `${MARK[s.state] || '?'} ${s.name}=${s.state}`).join('  ')}  "${r.text}"`
}

/**
 * What hive_say should say instead of "sent".
 *
 * ONE FAILURE ONLY, AND THAT IS DELIBERATE. At send time delivery is not knowable -- the message
 * was created a millisecond ago -- so the single thing worth saying is the one that is already
 * decided and is currently reported as success: our own socket is down.
 *
 * It says nothing about an ABSENT recipient even though that is equally decidable, because
 * `describeRecipient` in hive-busy.js already says it ("@X is NOT in the room — nobody will read
 * that") and a second hand-written copy of that sentence is precisely the defect class Agent
 * Relay wrote up in learnings/duplicated-wire-contract.md: two descriptions of one fact, only one
 * of which anybody keeps current. One producer, one description.
 *
 * On success it returns the empty string. A reassuring word at send time IS the defect.
 */
export function sendWarning({ connected }) {
  if (connected) return ''
  return 'NOT SENT — this client is OFFLINE. The message is in your local copy only; it has not ' +
    'reached the relay and no one else can see it. It will go out by itself when the connection ' +
    'heals (do NOT call hive_join, that tears down the session). Until then, treat it as unsent.'
}
