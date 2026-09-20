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
  if (mentionsAll(text)) return true // @all reaches everyone by definition
  const escaped = String(me).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Trailing boundary: end of string, or anything that cannot continue a name.
  return new RegExp(`@${escaped}(?![\\w-])`, 'i').test(String(text))
}

/**
 * `@all` — the deliberate broadcast.
 *
 * Before this there was no way to reach the whole room on purpose. An unaddressed message goes
 * into every agent's ambient digest, where the rules tell them to skip it -- correct for
 * chatter, useless for "everyone stop, the suite is red". So the only two options were name
 * eight agents by hand or be ignored.
 *
 * It wakes everyone. It deliberately does NOT create a reply debt (see unansweredFor): one
 * broadcast obliging eight replies is how a coordination channel becomes a spam channel, and
 * that is the exact failure this room already had once.
 */
export function mentionsAll(text) {
  return /@all(?![\w-])/i.test(String(text || ''))
}

/** Everyone addressed in a message, so a broadcast can be told from a direct call. */
export function mentionedNames(text) {
  return [...new Set([...String(text || '').matchAll(/@([\w-]+)/g)].map((m) => m[1]))]
}

/**
 * A NAME THAT CANNOT BE ADDRESSED IS NOT A NAME. Refuse it at the door.
 *
 * On 20 Sep 2026 an agent joined room `night` as "antigravity 1". `mentionedNames` above splits
 * on /@([\w-]+)/g, so "@antigravity 1" reads as "@antigravity", and no such member existed. Its
 * mail, its obligations and its wake-on-mention were all silently dead for an hour. It saw
 * messages only because it happened to be tailing the chat log. Nothing errored; the room said
 * "@antigravity is NOT in the room", which was true and useless, because the member WAS present
 * under a name this parser cannot produce.
 *
 * WHY REFUSE RATHER THAN NORMALISE. Silently rewriting "coder 1" to "coder-1" collides with a
 * real "coder-1" and merges two processes into one participant — one awareness entry, one cursor,
 * one mailbox — with neither told. And the agent's own prompt still says its name is the original,
 * so it stops recognising messages about itself.
 *
 * WHY REFUSE RATHER THAN RESOLVE @mentions AGAINST THE MEMBER LIST. That would make a departed
 * member break the historical record: a fact about the past decided by who happens to be present
 * now. Same defect as the receipts work in HIV-P2.
 *
 * WHY THIS CHARSET AND NOT A NICER ONE. It is not taste, it is arithmetic. The extractor above
 * only recognises [\w-]. A name outside that set CANNOT be produced by it, however carefully the
 * sender types. Constraining names to the charset the parser already uses makes the two
 * consistent by construction instead of by coincidence.
 *
 * KNOWN LIMIT, stated because it is a product decision and not an oversight: `\w` is ASCII, so a
 * name in Devanagari, Han or Cyrillic is refused. That is honest rather than good — those names
 * are equally unaddressable today, and refusing at least says so out loud. Widening it means
 * widening the extractor first; the two move together or not at all.
 *
 * @param {any} name
 * @returns {{ ok: boolean, error?: string, suggested?: string }}
 */
export function validateMemberName(name) {
  if (name == null || typeof name !== 'string' || name.length === 0) {
    return {
      ok: false,
      error: 'Member name must be a non-empty string so that the participant can be addressed via @mentions.',
      suggested: 'agent-1',
    }
  }
  // Whitespace is checked BEFORE the charset so the message names the actual problem. "contains
  // whitespace" tells you what to do; "contains invalid characters" makes you hunt for which one.
  if (/\s/.test(name)) {
    return {
      ok: false,
      error: `Member name "${name}" contains whitespace. Names with spaces cannot be addressed via @mentions, breaking message routing, mailboxes, and delivery receipts.`,
      suggested: suggestMemberName(name),
    }
  }
  if (!/^[\w-]+$/.test(name)) {
    return {
      ok: false,
      error: `Member name "${name}" contains invalid characters. Names must contain only letters, numbers, underscores, and hyphens so that @mentions can route mail to you.`,
      suggested: suggestMemberName(name),
    }
  }
  return { ok: true }
}

/**
 * A refusal nobody can act on gets worked around, so every refusal above carries one of these.
 *
 * It deliberately validates its own output before returning it: a suggestion that is itself
 * invalid is worse than no suggestion, because the caller retries, fails again, and now distrusts
 * the error message. Whitespace-only and non-ASCII names both collapse to nothing here, which is
 * why the fallback exists rather than being defensive padding.
 *
 * @param {string} name
 * @returns {string}
 */
export function suggestMemberName(name) {
  if (!name || typeof name !== 'string') return 'agent-1'
  let s = name.replace(/[\s]+/g, '-').replace(/[^\w-]+/g, '-')
  s = s.replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '')
  return /^[\w-]+$/.test(s) ? s : 'agent-1'
}

/**
 * Who has directly addressed `me` and not been answered since?
 *
 * "Answered" is deliberately cheap to satisfy: any later message from me that names them. It is
 * not trying to judge whether the reply was any good -- only that the room never goes silent on
 * someone who asked a direct question, which is the failure that makes agents give up on the
 * channel and start tailing files instead.
 *
 * Derived from the chat log rather than stored, so it cannot drift out of sync with what was
 * actually said, and needs no new state to persist or migrate.
 *
 * THREE THINGS DO NOT COUNT AS A DEBT, all for the same reason -- an obligation that fires on
 * traffic nobody chose to send is noise wearing a rule's clothes:
 *   - `@all` broadcasts (see mentionsAll)
 *   - system messages, and the client's own auto-posted conflict/adopt notices
 *   - my own messages, however many times I say my own name
 *
 * @param {Array<{by?: string, kind?: string, text?: string, at?: string}>} messages
 * @param {string} me
 * @returns {Array<{from: string, at: string, text: string}>} oldest first
 */
export function unansweredFor(messages, me) {
  const list = Array.isArray(messages) ? messages : []
  if (!me) return []
  const low = (s) => String(s || '').toLowerCase()
  const mine = low(me)
  const AUTO = /^(⚠ MERGE CONFLICT|✓ conflict|↓ )/ // posted by the sync client, not by a person

  const owed = new Map()   // sender (lowercased) -> the message I owe a reply to
  for (const m of list) {
    if (!m || m.kind === 'system' || AUTO.test(String(m.text || ''))) continue
    if (low(m.by) === mine) {
      // Anything I name is discharged. A broadcast from me discharges everything: I have
      // spoken to the room, and holding a debt open after that is pedantry, not coordination.
      if (mentionsAll(m.text)) { owed.clear(); continue }
      for (const n of mentionedNames(m.text)) owed.delete(low(n))
      continue
    }
    // Directly addressed, not merely broadcast to.
    if (mentionsAll(m.text)) continue
    if (mentionsName(m.text, me)) owed.set(low(m.by), { from: m.by, at: m.at || '', text: m.text || '' })
  }
  return [...owed.values()]
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

/**
 * AMBIENT DIGEST -- what to do with room chatter nobody addressed to you.
 *
 * Un-addressed messages were handed to every agent in full, on every wake. In a room of N
 * agents that means each one pays for the other N-1's conversation every single turn: O(N^2)
 * context, so TOKEN COST -- not the relay -- becomes the real ceiling on room size. Measured:
 * the relay holds 8 clients per room, converging in 1.0s on 45 MB. What actually stops a big
 * room is this block of text.
 *
 * The COUNT stays exact and the newest messages still arrive in full. Only the older bodies
 * are withheld, and the agent is told the number and how to read them, so nothing is hidden --
 * it just stops being paid for unasked. An agent that wants the whole log calls hive_read_chat.
 *
 * Returns '' when there is nothing, so a caller can drop it with a falsy check.
 */
export function ambientDigest(messages, { keep = 4 } = {}) {
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) return ''
  const shown = keep > 0 ? list.slice(-keep) : []
  const hidden = list.length - shown.length
  const head = 'room activity (' + list.length +
    (hidden ? ', newest ' + shown.length + ' shown' : '') + '):'
  const tail = hidden
    ? '\n... ' + hidden + ' earlier message(s) withheld to keep your context small'
      + ' -- hive_read_chat for the full log'
    : ''
  if (!shown.length) return head + tail
  return head + '\n' + shown.map(formatMessage).join('\n') + tail
}
