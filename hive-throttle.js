// hive-throttle.js — say it again only if they can no longer see it.
//
// TWO OPPOSITE WASTES, ONE CAUSE. Hivecode repeats some blocks to an agent that still has them
// verbatim, and never repeats others to an agent that lost them hours ago. Both are the same
// missing question: *is this still in their context?*
//
//   [GLOBAL PROJECT STATE]   rebuilt and returned on EVERY hive_wait, unchanged, forever.
//                            An agent waiting in a loop is handed the same JSON hundreds of
//                            times, and pays for it hundreds of times.
//
//   HIVE_RULES.md            6,288 bytes handed over ONCE, in the hive_join tool result. It sits
//                            in the transcript, so it is exactly what compaction throws away
//                            first -- and it is the ROOM-specific half of the rules: lanes, gate
//                            commands, who owns what. Six hours in, it is simply gone.
//
// WHAT IS *NOT* IN SCOPE, AND THIS WAS WORTH CHECKING BEFORE WRITING ANYTHING. `INSTRUCTIONS`
// (2,477 chars) is passed to `new Server(..., { instructions })`, which puts it in the agent's
// SYSTEM PROMPT. A system prompt is not part of the compactable transcript, so those rules are
// present on every single turn and re-sending them would be the precise waste this file exists
// to remove. Half of an earlier draft of this module did exactly that.
//
// THE PROXY, AND ITS HONEST LIMIT. There is no way to ask an agent what is still in its context.
// Agent Relay's broker faces the same wall and answers it with a measurement it *does* have --
// bytes of PTY output since the last reminder:
//
//     "Output volume is the proxy for 'the agent actually worked and may have compacted the
//      earlier reminder out of its context'. An agent that only sat at the prompt receiving
//      messages still has the previous reminder verbatim in context, so repeating it only
//      burns tokens."                     -- crates/broker/src/broker/injection_format.rs
//
// There is no PTY here. The equivalent measurement is the one thing this server controls exactly:
// BYTES IT HAS HANDED THE AGENT since the last send. Every tool result goes out through one
// `text()`, so the count is precise rather than sampled.
//
// This is a proxy and nothing more. It does not detect compaction; it estimates that enough has
// happened for compaction to be plausible. It will sometimes repeat something still in context,
// and sometimes stay quiet about something already gone. Both failures are cheap. Pretending the
// number means more than it does would not be.
//
// THREE RULES, IN PRIORITY ORDER, AND THE ORDER IS THE DESIGN:
//
//   1. never sent      -> SEND. They have not seen it.
//   2. content changed -> SEND. Correctness outranks economy: a suppressed state change is a
//                         wrong answer, while a repeated one is only a cost.
//   3. otherwise       -> send only if BOTH the cooldown has elapsed AND enough bytes have gone
//                         out. Either gate alone is wrong. Time alone nags an idle agent that
//                         still has the text. Bytes alone fires mid-burst on an agent that read
//                         it ninety seconds ago.

/** Long enough that a burst of work does not trigger a repeat, short enough to catch a stall. */
export const COOLDOWN_MS = 5 * 60000

/** Agent Relay's number, and a reasonable one: ~16k tokens of traffic since they last saw it. */
export const OUTPUT_BYTES = 64 * 1024

/** Cheap, order-insensitive change detection. Not a hash -- a hash would be more code for a
 *  comparison that is already exact on the strings these callers pass. */
const norm = (c) => (typeof c === 'string' ? c : JSON.stringify(c === undefined ? null : c))

export function makeThrottle({ now = Date.now, cooldownMs = COOLDOWN_MS, bytes = OUTPUT_BYTES } = {}) {
  // key -> { at, content, bytesSince, sends }
  const seen = new Map()
  let noted = 0        // total bytes handed to the agent, for reporting only

  /**
   * Record output handed to the agent.
   *
   * Counting for a key starts only once that key has been sent at least once -- the volume only
   * means anything relative to "since you last saw this". Agent Relay makes the same choice and
   * for the same reason; a counter running before the first send would make the first repeat fire
   * immediately on a busy agent.
   */
  function note(n) {
    const add = Math.max(0, Number(n) || 0)
    noted += add
    for (const e of seen.values()) e.bytesSince += add
  }

  function should(key, content) {
    const e = seen.get(key)
    if (!e) return { send: true, why: 'first' }
    if (norm(content) !== e.content) return { send: true, why: 'changed' }
    const waited = now() - e.at
    if (waited < cooldownMs) return { send: false, why: 'recent', waited }
    if (e.bytesSince < bytes) return { send: false, why: 'quiet', bytesSince: e.bytesSince }
    return { send: true, why: 'likely-compacted', waited, bytesSince: e.bytesSince }
  }

  function sent(key, content) {
    const prev = seen.get(key)
    seen.set(key, { at: now(), content: norm(content), bytesSince: 0, sends: (prev ? prev.sends : 0) + 1 })
  }

  /** should() and sent() in one call, for the common site: `if (send(k, c)) include(c)`. */
  function send(key, content) {
    const d = should(key, content)
    if (d.send) sent(key, content)
    return d.send
  }

  /** What was actually saved, so the claim is measured rather than asserted. */
  function stats() {
    const out = { keys: {}, bytesHandled: noted }
    for (const [k, e] of seen.entries()) out.keys[k] = { sends: e.sends, bytesSince: e.bytesSince }
    return out
  }

  return { note, should, sent, send, stats }
}

/** Cheap enough to be worth repeating; says nothing an agent's system prompt already carries.
 *  Deliberately a POINTER, not a copy: the file is on the agent's own disk, and a second
 *  hand-written summary of it here would be one more description to drift. */
export const RULES_NUDGE =
  '[ROOM RULES] You have been working a while — the room rules you were handed when you joined ' +
  'are probably out of your context by now. They are ROOM-specific (lanes, gate command, who ' +
  'owns what), so the general rules you still have do not cover them. Re-read HIVE_RULES.md in ' +
  'your own folder before your next claim.'
