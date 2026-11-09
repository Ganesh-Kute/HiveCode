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

import { formatTime } from './hive-time.js'

/** A chat message as stored in the room: { by, kind, at, text }. */

/**
 * Does this text address `me`? Matches `@Name`, case-insensitively, at a word boundary so
 * `@PM` does not swallow `@PM-Claude` and `@Hermes` does not match `@Hermes-2`.
 * @param {string} text
 * @param {string} me
 */
export function mentionsName(text, me) {
  if (!text || !me) return false
  const clean = stripSpansAndQuotes(text)
  if (mentionsAll(clean)) return true // @all reaches everyone by definition
  const escaped = String(me).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Both boundaries, and the same ones the extractor uses. If these two ever disagree, a message
  // can be extracted as addressing someone who does not match it, or match someone it was never
  // extracted for -- which is how a mailbox and a transcript come to tell different stories.
  return new RegExp(`${MENTION_START}@${escaped}${MENTION_END}`, 'i').test(clean)
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
  return /@all(?![\w-])/i.test(stripSpansAndQuotes(text))
}

/** Code spans and quoted text blanked out, so a token quoted as code or prose is not read as an address. */
export function stripSpansAndQuotes(text) {
  const raw = String(text || '')
  const trimmed = raw.trim()
  const quotePairs = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ]
  for (const [open, close] of quotePairs) {
    if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length >= 2) {
      if (trimmed.indexOf(close, open.length) === trimmed.length - close.length) {
        // A single quote pair spans the entire message: preserve inner content (stripping internal code spans)
        const inner = trimmed.slice(open.length, trimmed.length - close.length)
        return inner
          .replace(/```[\s\S]*?(?:```|$)/g, ' ')
          .replace(/`[^`\n]*`/g, ' ')
      }
    }
  }

  return raw
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')      // fenced code blocks
    .replace(/`[^`\n]*`/g, ' ')                 // inline code spans
    .replace(/"[^"\n]*"/g, ' ')                 // double quoted text
    .replace(/(?:^|[\s(\[{<])'[^'\n]*'(?=$|[\s)\]}>.,!?:;])/g, ' ') // single quoted text (preserving contractions)
    .replace(/[“”][^“”\n]*[“”]/g, ' ')          // curly double quotes
    .replace(/[‘’][^‘’\n]*[‘’]/g, ' ')          // curly single quotes
}

/** Inline code spans blanked out, kept for backward compatibility. */
const stripCodeSpans = stripSpansAndQuotes

/**
 * WHERE A MENTION MAY BEGIN, AND WHERE IT MAY NOT.
 *
 * Measured in room `night` on 20 Sep 2026, against the old bare /@([\w-]+)/g:
 *
 *   "email me at anyone@gmail.com"      -> ["gmail"]                 every email address
 *   "blame line: author@example.org"    -> ["example"]               every commit trailer
 *   "npm i @modelcontextprotocol/sdk"   -> ["modelcontextprotocol"]  every scoped package
 *   "see `@all` in the docs"            -> broadcast to everyone     every doc about this feature
 *
 * After three hours the obligation ledger held 44 entries of which 32% were debts against members
 * who had never existed, and a debt can only be discharged by the asker, so nothing in the system
 * could ever have closed them. The ledger is what catches an agent going silent; it was becoming
 * unreadable through ordinary use.
 *
 * LEADING: start of string, whitespace, an opening bracket, a quote, a dash, or a colon.
 *
 * TRAILING: not a word character, a hyphen, or a SLASH. The slash is what distinguishes
 * `@scope/package` from `@person`. It is written as one lookahead rather than a separate check so
 * the regex cannot backtrack into a shorter name to satisfy it -- `[\w-]+` followed by `(?!\/)`
 * alone would happily match "modelcontextprotoco" and declare victory.
 */
const MENTION_START = '(?:^|[\\s(\\[{<"\'—–:])'
const MENTION_END = '(?![\\w\\-/])'

/** Everyone addressed in a message, so a broadcast can be told from a direct call. */
export function mentionedNames(text) {
  const clean = stripSpansAndQuotes(text)
  const re = new RegExp(`${MENTION_START}@([\\w-]+)${MENTION_END}`, 'g')
  return [...new Set([...clean.matchAll(re)].map((m) => m[1]))]
}

/**
 * WHO ACTUALLY OWES AN ANSWER — which is not the same question as who was named.
 *
 * Extraction and obligation were one decision and they are two. A transcript should show what the
 * text said, including a name that is merely quoted; a DEBT is a claim about the present, and
 * opening one against somebody who is not here produces an entry nobody can ever discharge, since
 * only the asker may close it and the debtor does not exist.
 *
 * The distinction that makes this safe is which way time points. Resolving a HISTORICAL mention
 * against who is present now would be the Historical Transcript Fallacy -- the past decided by the
 * present -- and that is why extraction deliberately does NOT do it. An obligation is not history:
 * it is live state about who owes me an answer right now, so checking present membership is
 * exactly the right question for it.
 *
 * @param {string} text
 * @param {{ me?: string, present?: Iterable<string> }} ctx  `present` is lowercased names
 */
export function obligationTargets(text, { me = '', present = [] } = {}) {
  const here = new Set([...present].map((n) => String(n).toLowerCase()))
  const self = String(me).toLowerCase()
  return mentionedNames(text).filter((n) => {
    const low = n.toLowerCase()
    // @all wakes the room and obliges nobody -- one broadcast owing eight replies is how a
    // coordination channel becomes a spam channel. Unchanged from the original behaviour.
    if (low === 'all' || low === self) return false
    return here.has(low)
  })
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
 /**
 * Is this message a bare acknowledgement or thank-you?
 *
 * WHITELISTED ONLY (Item 5.1). An acknowledgement from anyone (human or AI) must never open a
 * reply debt. To prevent dropping real instructions ("ok, go ahead" or "thanks, can you also check X"),
 * the WHOLE message (after stripping @names, emoji and punctuation) must match the whitelist.
 * Anything with additional words or directives still opens a debt.
 */
export function isAcknowledgement(text) {
  if (!text || typeof text !== 'string') return false
  const noCode = stripSpansAndQuotes(text)
  const noMentions = noCode.replace(/@[\w-]+/g, ' ')
  const noEmoji = noMentions.replace(/\p{Extended_Pictographic}/gu, ' ')
  const noPunct = noEmoji.replace(/[.,!?:;'"“”‘’/\\()[\]{}~*`_#^<>=+|–—\-]/g, ' ')
  const s = noPunct.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!s) return false

  const CORE = 'thanks|thank\\s+you|thx|ty|ok|okay|got\\s+it|lgtm|looks\\s+good|sounds\\s+good|great|nice|cool|perfect|noted|ack'
  const MOD = 'bro|all|team'
  const re = new RegExp(`^(?:(?:${CORE})(?:\\s+(?:${MOD}))?|(?:(?:${MOD})\\s+)?(?:${CORE}))$`, 'i')
  return re.test(s)
}

/**
 * THREE THINGS DO NOT COUNT AS A DEBT, all for the same reason -- an obligation that fires on
 * traffic nobody chose to send is noise wearing a rule's clothes:
 *   - `@all` broadcasts (see mentionsAll)
 *   - system messages, and the client's own auto-posted conflict/adopt notices
 *   - my own messages, however many times I say my own name
 *   - bare acknowledgements ("thanks", "ok", "lgtm"), even from a human
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
  // TURNS, NOT MENTIONS (27 Sep 2026). Every mention used to open a debt, so an ANSWER opened one
  // against the person who asked: Ada asks Bo, Bo says "on it", and Ada is told on every hive_check
  // that she owes Bo a reply -- which she pays ("thanks"), which opens one against Bo. A politeness
  // loop, paid in tokens and chat by both. So it goes by whose turn it is between two people: a
  // message from someone I spoke to last is their reply, and opens a debt only if it asks something
  // back or is urgent. Anything else still counts, question mark or not -- "can you take it" has none.
  // A PERSON is always answered (Antigravity1's review): humans type directives, not needsReply flags,
  // and "deploy to staging and run the smoke tests" right after an agent's report is an order, not a
  // reply. Any '?' counts, so 'the port?"' and 'ready? (check it)' are questions too.
  const turn = new Map()   // other person (lowercased) -> 'me' when I spoke to them last, else 'them'
  const asks = (t) => /\?/.test(String(t || '')) || priorityOf(t) === 'stop'
  for (const m of list) {
    if (!m || m.kind === 'system' || AUTO.test(String(m.text || ''))) continue
    if (low(m.by) === mine) {
      // Anything I name is discharged. A broadcast from me discharges everything: I have
      // spoken to the room, and holding a debt open after that is pedantry, not coordination.
      if (mentionsAll(m.text)) { owed.clear(); continue }
      for (const n of mentionedNames(m.text)) { const k = low(n); if (k === mine) continue; owed.delete(k); turn.set(k, 'me') }
      continue
    }
    // Directly addressed, not merely broadcast to.
    if (mentionsAll(m.text)) continue
    if (mentionsName(m.text, me)) {
      const k = low(m.by)
      if (!isAcknowledgement(m.text)) {
        if (turn.get(k) !== 'me' || m.kind === 'human' || asks(m.text)) owed.set(k, { from: m.by, at: m.at || '', text: m.text || '' })
      }
      turn.set(k, 'them')
    }
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
 *
 * THE WORDS COUNT ONLY WHERE AN ORDER WOULD BE (Item 5.4). Narrowed to explicit directives
 * so routine prose ("reaching a stopping point", "commit c56214b: revert earlier broken test",
 * "revert PR #12 merged") does not arrive under a false STOP banner.
 */
const ORDER_WINDOW = 160
export function priorityOf(text) {
  const s = String(text || '')
  if (/^\s*\[!\]|^\s*\[stop\]/i.test(s)) return 'stop'
  const head = s
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')          // fenced code, closed or not
    .replace(/`[^`\n]*`/g, ' ')                    // inline code spans
    .replace(/"[^"\n]*"/g, ' ')                    // double quotes
    .replace(/(?:^|[\s(\[{<])'[^'\n]*'(?=$|[\s)\]}>.,!?:;])/g, ' ') // single quotes
    .replace(/[“”][^“”\n]*[“”]/g, ' ')             // curly double quotes
    .replace(/^(?:\s*@[\w-]+[\s,:;.!-]*)+/, '')    // the leading @names being addressed
    .trimStart()
    .slice(0, ORDER_WINDOW)

  // THE MARKER AFTER THE NAMES (0.14.4 C10). The rules say put @Name first, so "@C [!] stand down"
  // is how people actually write it -- and it read as 'normal', so the urgent gate never fired.
  if (/^\[!\]|^\[stop\]/i.test(head)) return 'stop'

  // Directives at start of head (immediate orders)
  if (/^(?:please\s+)?(?:stop\b(?!\s*\(|\.\w)|halt\b|abort\b|revert\s+(?:that|this|it|now|[\w./-]+\.\w+)\b)/i.test(head)) return 'stop'
  if (/^stop-ship\b/i.test(head)) return 'stop'

  // Imperative directives within head window
  if (/\b(?:please\s+)?don'?t\s+(?:edit|touch|write|modify)\b/i.test(head)) return 'stop'
  if (/\bplease\s+stop\b/i.test(head)) return 'stop'
  if (/\b(?:stop|revert)\s+(?:that|this|it\s+)?now\b/i.test(head)) return 'stop'
  if (/\bstop\s+(?:editing|touching|writing)\b/i.test(head)) return 'stop'

  return 'normal'
}

/** Standard Levenshtein distance between two strings, case-insensitively. */
export function levenshtein(a, b) {
  const s1 = String(a || '').toLowerCase()
  const s2 = String(b || '').toLowerCase()
  const m = s1.length, n = s2.length
  if (!m) return n
  if (!n) return m
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1))
  for (let i = 0; i <= m; i++) d[i][0] = i
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      )
    }
  }
  return d[m][n]
}

/** Find closest known name within edit distance <= 2 (or <= 1 for names <= 4 chars) for typo detection. */
export function findClosestKnown(name, knownNames) {
  const s = String(name || '').toLowerCase()
  let best = null
  let bestDist = Infinity
  for (const k of knownNames || []) {
    const orig = String(k)
    const dist = levenshtein(s, orig.toLowerCase())
    if (dist < bestDist) {
      bestDist = dist
      best = orig
    }
  }
  const maxAllowed = (best && best.length <= 4) || s.length <= 4 ? 1 : 2
  return bestDist <= maxAllowed ? { name: best, distance: bestDist } : null
}

/** Does this mention sit at the direct-address position (start of the message)? */
export function isDirectAddress(text, name) {
  const s = String(text || '').trimStart()
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^@${escaped}(?![\\w\\-/])`, 'i').test(s)
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
  const atStr = m.at ? formatTime(m.at) : ''
  return `${atStr} ${m.by}(${m.kind || 'ai'}): ${m.text}${times}`
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
