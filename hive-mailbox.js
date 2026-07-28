// The room mailbox: what has this participant actually read?
//
// WHY THIS EXISTS. `hive_wait` used to capture `baseChatLen = chat.length` at the moment it
// was CALLED, and only ever returned `chat.slice(baseChatLen)`. So anything posted between one
// wait returning and the next one starting — which is precisely the window where an agent is
// doing its work — sat below the cursor and was returned by NO code path. Not delayed:
// unreachable. Two further holes finished the job: a wait that had queued work returned
// `newChat: []` hardcoded, so the busiest agent in the room saw no messages at all; and
// mention detection existed only for PAUSED agents, so a working agent could not tell "stop,
// you are editing the wrong file" from two other agents chatting.
//
// Measured on a real four-agent build (JARVIS, 2026-07-28): 345 @mentions in the room log, 13
// acknowledgements. The PM agent ended up replacing delivery with a bash script that tails
// HIVE_CHAT.md, which is the verdict on the old design.
//
// So the cursor is now a persistent per-participant position that only advances over messages
// that were actually handed to the agent. This module is deliberately pure — plain arrays in,
// plain objects out, no Yjs and no I/O — so the delivery rules are unit-testable without a
// relay, a room, or a network.

/** A chat message as stored in the room: { by, kind, at, text }. */

/**
 * Does this text address `me`? Matches `@Name`, case-insensitively, at a word boundary so
 * `@PM` does not swallow `@PM-Claude` and `@Hermes` does not match `@Hermes-2`.
 * @param {string} text
 * @param {string} me
 */
export function mentionsName(text, me) {
  if (!text || !me) return false
  const escaped = String(me).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Trailing boundary: end of string, or anything that cannot continue a name.
  return new RegExp(`@${escaped}(?![\\w-])`, 'i').test(String(text))
}

/** Everyone addressed in a message, so a broadcast can be told from a direct call. */
export function mentionedNames(text) {
  return [...new Set([...String(text || '').matchAll(/@([\w-]+)/g)].map((m) => m[1]))]
}

/**
 * How urgently does this message want attention?
 *
 *   'stop'   — act on it before finishing what you are doing
 *   'normal' — read it at your next boundary
 *
 * A marker is an explicit prefix so it is unambiguous, plus a small set of words that mean
 * stop in every room whether or not the sender knew about markers. An agent about to
 * overwrite someone's work is not going to be helped by correct syntax.
 */
export function priorityOf(text) {
  const s = String(text || '')
  if (/^\s*\[!\]|^\s*\[stop\]/i.test(s)) return 'stop'
  if (/\b(stop|halt|abort|don'?t\s+(?:edit|touch|write)|revert)\b/i.test(s)) return 'stop'
  return 'normal'
}

/**
 * Collapse runs of the identical message into one entry with a count.
 *
 * Not cosmetic. A conflict-notification feedback loop in the same live build put 56 copies of
 * one "⚠ MERGE CONFLICT in Shell.jsx" line into the room in seconds, and 306 of the room's
 * 2,314 chat lines were that loop. Handing an agent 56 identical lines costs it the context it
 * needs to fix the actual problem, and buries the one message that mattered.
 * @param {Array<{text?: string, by?: string}>} messages
 */
export function collapseRepeats(messages) {
  const out = []
  for (const m of messages || []) {
    const last = out[out.length - 1]
    if (last && last.by === m.by && last.text === m.text) {
      last.repeated = (last.repeated || 1) + 1
      last.at = m.at ?? last.at // keep the most recent timestamp
      continue
    }
    out.push({ ...m })
  }
  return out
}

/**
 * A read cursor over the room chat.
 *
 * @param {{me: string, startAt?: number}} options
 *   me      this participant's display name
 *   startAt where to begin. On a first join this is the current chat length, so an agent is
 *           not handed the room's entire history; on a resume it is the persisted cursor, so
 *           nothing posted while the process was down is lost.
 */
export function createMailbox({ me, startAt = 0 }) {
  let cursor = Math.max(0, Number(startAt) || 0)

  /** Read without consuming. `advance` is what `take` does; kept separate so a peek is safe. */
  function collect(all, { advance }) {
    const list = Array.isArray(all) ? all : []
    // A cursor past the end means this position belongs to a different document — a room
    // rebuilt from scratch, which the recovery procedure for a poisoned room requires. Reset
    // to the beginning rather than clamping to the end: clamping would deliver nothing, for
    // ever, silently. Re-reading a short fresh chat costs an agent a few lines; going
    // permanently deaf costs it the room.
    if (cursor > list.length) cursor = 0

    const fresh = list.slice(cursor)
    const end = list.length

    // An agent's own messages are not mail. It used to be woken by its own hive_say, and in a
    // notification storm most of the flood was self-authored — an agent filling its own inbox.
    const incoming = fresh.filter((m) => m && m.by !== me)
    const messages = collapseRepeats(incoming)
    const mentions = messages.filter((m) => mentionsName(m.text, me))
    const urgent = mentions.filter((m) => priorityOf(m.text) === 'stop')

    if (advance) cursor = end

    return {
      messages,
      mentions,
      mentioned: mentions.length > 0,
      priority: urgent.length ? 'stop' : 'normal',
      unreadCount: incoming.length,
      cursor,
    }
  }

  return {
    /** Current position, for persisting across process restarts. */
    get cursor() { return cursor },
    /** Move the cursor without delivering anything (used at join). */
    seek(n) { cursor = Math.max(0, Number(n) || 0); return cursor },
    /** Deliver everything unread and mark it read. Every return path must go through this. */
    take(all) { return collect(all, { advance: true }) },
    /** Look at what is unread without marking it read. */
    peek(all) { return collect(all, { advance: false }) },
    /** Is there anything at all? Cheap enough to call in a wake predicate. */
    hasUnread(all) { return collect(all, { advance: false }).unreadCount > 0 },
  }
}

/** One-line rendering used in tool output, with the repeat count when a run was collapsed. */
export function formatMessage(m) {
  const times = m.repeated > 1 ? `  (×${m.repeated})` : ''
  return `${m.at || ''} ${m.by}(${m.kind || 'ai'}): ${m.text}${times}`
}
