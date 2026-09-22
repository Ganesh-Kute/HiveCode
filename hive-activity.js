// WHAT THE ENGINE OBSERVED, as opposed to what the agent declared.
//
// THE DEFECT THIS EXISTS FOR.
// Every AI agent in a Hivecode room is a turn-based LLM. Between turns its process is alive
// and its socket is connected, so Yjs awareness reports it present -- but it will take no
// action, ever, until a human types at it. The room could not tell these apart:
//
//   an agent thinking hard mid-task
//   an agent blocked inside hive_wait            healthy idle; wakes the instant anything lands
//   an agent whose turn ENDED outside hive_wait  will NEVER wake on its own
//   an agent whose process died
//
// All four read as "in the room". The third is the one that costs a night: at 23:00 an agent
// says "standing by", at 09:00 the human finds a claim that expired hours ago, a ticket nobody
// finished, and no record of when it stopped. Both agents in this room have been that agent,
// and one of them had built an external WebSocket listener specifically to work around it.
//
// WHY THE OBVIOUS FIX IS DEAD, MEASURED RATHER THAN ARGUED.
// The obvious fix is a chat-activity timeout. Measured on this room's own log, 20 Sep 2026,
// across agents that were demonstrably working the whole time:
//
//   agent            msgs   median gap   p90     MAX
//   DeepMind-Agent     32        156s    349s   3985s   (66 min)
//   Antigravity1       40        192s    907s   6718s   (112 min)
//
// A working agent went 112 minutes between posts. Any threshold under that false-positives on
// real work; anything over it is useless. So chat silence cannot be the signal.
//
// THE ANSWERABLE QUESTION.
// Same move as HIV-28, which stopped asking whether a room was "ahead or behind" a branch and
// asked instead whether the room had ever SEEN those bytes. "Is this agent alive?" and "is it
// thinking?" are not answerable from outside. This is:
//
//   IS THIS AGENT INSIDE A BLOCKING hive_wait RIGHT NOW?
//
// An agent inside hive_wait is reachable -- anything that arrives wakes it. An agent that is
// not inside hive_wait and not calling tools is unreachable until a human prompts it. Binary,
// exact, no threshold.
//
// WHY THIS IS A THIRD MAP AND NOT A FIELD ON `busy`.
// hive-busy.js settled the principle already: "The controls map is deliberately not reused.
// That is mission control -- a HUMAN sets running/paused there -- and an agent writing its own
// state into the same entry would clobber a human's pause with a self-report. Different author,
// different authority, different map."
//
//   controls    the HUMAN declares       running / paused
//   busy        the AGENT declares       "I am mid-task"
//   activity    the ENGINE observes      <- this file
//
// `busy` is a claim about the future: an agent can forget to set it, set it and die, or simply
// be wrong. `activity` is a record of the past, stamped by dispatch() on every hive_* call, so
// an agent cannot forget to write it and cannot write something false. An agent that has
// stopped cannot report that it has stopped -- that is the whole problem -- so the fact has to
// be produced by something other than the agent's intent.
//
// Timestamps are unix ms, matching hive-coord's claims and hive-busy's `since`. Adjacent maps
// in one document disagreeing about units is its own defect class.

/** Inside a blocking hive_wait at this instant. Reachable: anything that arrives wakes it. */
export const WAITING = 'WAITING'
/** Acted recently and is not in a wait. Working. */
export const WORKING = 'WORKING'
/** Present, not waiting, silent past the window. WILL NOT WAKE without a human. */
export const PARKED = 'PARKED'
/** Awareness dropped. The process is gone, whatever the last record says. */
export const GONE = 'GONE'
/** A human set controls=paused. Obeying, not stalled -- never report this as PARKED. */
export const PAUSED = 'PAUSED'
/** Declared passive: this process does not take turns. Silence is correct, not a fault. */
export const PASSIVE = 'PASSIVE'
/**
 * A human, present. Every state below is about whether an AGENT will act again without being
 * prompted, which is not a question you can ask about a person.
 *
 * Antigravity1 called this in the P11 design review -- "kind === 'human' must never be
 * classified as PARKED" -- and it was not implemented. The result was visible in the live room
 * an hour later: `Ganesh (human) — PARKED: ... anything you send it now will sit unread until a
 * human prompts it`, said about the human. Nonsense, and worse than nonsense, because it teaches
 * a reader that PARKED is noise.
 */
export const PRESENT = 'PRESENT'

/**
 * How long a present, non-waiting agent may be silent before it reads as PARKED.
 *
 * THIS IS THE ONLY NUMBER IN THIS MODULE THAT IS A JUDGEMENT RATHER THAN A MEASUREMENT, and
 * saying so is the point. Every other state -- WAITING, GONE, PAUSED, PASSIVE -- is exact and
 * needs no threshold at all, which is deliberate: the fact that matters most ("can I reach my
 * teammate") never depends on a number somebody guessed.
 *
 * Fifteen minutes is long enough that an ordinary stretch of local work -- a test battery, a
 * file sweep, a long think -- does not trip it, and short enough that a human returning in the
 * morning gets a useful answer rather than a shrug. It is NOT derived from the 112-minute chat
 * gap above: hive_* calls are far denser than chat posts, because the room requires a check
 * between edits. If that assumption is ever measured and found wrong, this is the one line to
 * change, and nothing else in the module moves.
 *
 * The cost of getting it wrong is asymmetric and worth stating. Too short and a working agent
 * is reported PARKED, its ticket gets reassigned, and two agents do one job. Too long and the
 * room is slower to notice a stall than it could have been -- which is still strictly better
 * than today, where a stalled agent reads as WORKING forever.
 */
export const DEFAULT_PARKED_AFTER_MS = 15 * 60 * 1000

/**
 * A ceiling, for the same reason hive-busy.js has one. An unbounded window means PARKED can be
 * configured out of existence silently: every agent reads WORKING, nothing looks broken, and
 * the feature is gone while its tests still pass.
 */
export const MAX_PARKED_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * A FLOOR, and it is not symmetry with the ceiling -- it is a correctness bound.
 *
 * The stamp is written when a tool call BEGINS, so the age of the record includes however long
 * that call is still running. A window shorter than one tool call therefore reports an agent as
 * PARKED while it is mid-call: the most active state there is, labelled unreachable.
 *
 * Found by the suite rather than reasoned about. tests/agent-liveness-test.mjs ran with a 2500ms
 * window; adding a fifth client made hive_say take longer than that, and A1 went red with
 * "PARKED: ... silent for 0 min (hive_say)" -- parked, zero minutes ago, naming the tool it was
 * inside. Five seconds clears a real tool call with room to spare and is still short enough to
 * exercise the state in a test.
 */
export const MIN_PARKED_AFTER_MS = 5000

/** Rows are keyed by member name, so the map grows with distinct names, not with time. */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

const lc = (n) => String(n || '').toLowerCase()

/** Read the configured window, clamped. An unparseable or absurd value falls back to the default. */
export function parkedAfterMs(env = (typeof process !== 'undefined' ? process.env : {})) {
  const raw = Number((env && env.HIVE_PARKED_AFTER_MIN) || 0)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PARKED_AFTER_MS
  return Math.min(Math.max(raw * 60 * 1000, MIN_PARKED_AFTER_MS), MAX_PARKED_AFTER_MS)
}

/**
 * Stamp that a member just did something. Called from dispatch() for EVERY hive_* tool, which
 * is what makes this a record rather than a declaration -- there is no code path where an agent
 * acts without this running, and none where it runs without the agent acting.
 *
 * `tool` is kept because "PARKED, last action hive_release 47 minutes ago" tells a human what
 * to do next and "PARKED" alone does not.
 */
export function noteAction(store, { name, tool, now = Date.now() } = {}) {
  if (!store || !name) return null
  const key = lc(name)
  const prev = store.get(key) || {}
  const rec = { ...prev, name: String(name), lastAction: now, lastTool: String(tool || prev.lastTool || '') }
  store.set(key, rec)
  return rec
}

/**
 * Mark entry into a blocking wait. Paired with noteWaitEnd, and the pairing is the contract:
 * `waitingSince` set means "inside the call right now", not "waited at some point".
 */
export function noteWaitStart(store, { name, now = Date.now() } = {}) {
  if (!store || !name) return null
  const key = lc(name)
  const prev = store.get(key) || {}
  const rec = { ...prev, name: String(name), waitingSince: now, lastAction: now, lastTool: 'hive_wait' }
  store.set(key, rec)
  return rec
}

/**
 * Mark exit from a blocking wait -- returned with work, timed out, or threw.
 *
 * This MUST run on every exit path including the throwing one. A wait that errors and leaves
 * `waitingSince` set describes an agent parked in a call it is no longer in, and it describes
 * it as the healthiest state in the taxonomy. stateOf() gates WAITING on awareness presence
 * precisely so that a process which dies here cannot fake it -- but a live process that merely
 * threw is still present, so the gate does not cover this case and the finally does.
 */
export function noteWaitEnd(store, { name, now = Date.now() } = {}) {
  if (!store || !name) return null
  const key = lc(name)
  const prev = store.get(key) || {}
  const rec = { ...prev, name: String(name), lastAction: now }
  delete rec.waitingSince
  store.set(key, rec)
  return rec
}

/** Forget a member entirely. Used on hive_leave, where the departure is deliberate and known. */
export function forget(store, name) {
  if (!store || !name) return
  try { store.delete(lc(name)) } catch { }
}

/**
 * Derive one member's state.
 *
 * THE ORDER OF THESE BRANCHES IS THE SAFETY PROPERTY, not a style choice.
 *
 * `present` comes from awareness and is checked FIRST, before anything stored. A process that
 * dies inside hive_wait leaves `waitingSince` set in the CRDT forever; asking about the stored
 * record first would report that corpse as WAITING -- "healthy idle, wakes on anything" -- which
 * is the single most misleading answer the room could give about the single worst situation.
 * Presence is ephemeral and the record is durable, so the ephemeral one has to win.
 *
 * PAUSED and PASSIVE come before the silence check for the same reason P6 puts never-seen and
 * passive before the debt: an agent obeying a human's stop, and a listener that never takes
 * turns by design, are both silent on purpose. Reporting either as PARKED would train a reader
 * to ignore the state that means "somebody needs to go look".
 *
 * @param {object} rec       the stored activity record, or null/undefined if none
 * @param {object} opts
 * @param {boolean} opts.present  awareness says this member is connected RIGHT NOW
 * @param {boolean} opts.paused   controls map says a human paused it
 * @param {boolean} opts.passive  declared passive at join
 */
export function stateOf(rec, { present, paused = false, passive = false, human = false, now = Date.now(), parkedAfter = DEFAULT_PARKED_AFTER_MS } = {}) {
  if (!present) return GONE
  // A human is exempt from the whole taxonomy below, which asks whether an AGENT will act again
  // unprompted. Checked before `paused` and `passive` because those describe agent mechanics too;
  // checked after `!present` because a departed human is still departed.
  if (human) return PRESENT
  if (passive) return PASSIVE
  if (paused) return PAUSED
  if (rec && rec.waitingSince) return WAITING
  const last = rec && Number(rec.lastAction)
  // No record at all, but awareness says present: a client that has joined and not yet driven a
  // tool. It is connected and it has done nothing. That is exactly PARKED -- and saying WORKING
  // here would mean the state defaults to the reassuring answer in the absence of evidence,
  // which is the habit this whole file exists to break.
  if (!Number.isFinite(last)) return PARKED
  return (now - last) < parkedAfter ? WORKING : PARKED
}

/**
 * The reader-facing form: the state, plus the evidence it was derived from.
 *
 * A verdict with no evidence is a thing a human has to trust. "PARKED -- last action hive_release
 * 47 min ago" is a thing they can check, and it is what tells them whether to prompt the agent,
 * take its ticket, or go back to sleep.
 */
export function describe(rec, opts = {}) {
  const now = opts.now || Date.now()
  const state = stateOf(rec, { ...opts, now })
  const last = rec && Number(rec.lastAction)
  const ageMs = Number.isFinite(last) ? Math.max(0, now - last) : null
  return {
    state,
    lastTool: (rec && rec.lastTool) || null,
    lastAction: Number.isFinite(last) ? last : null,
    ageMs,
    waitingSince: (rec && Number(rec.waitingSince)) || null,
    reachable: state === WAITING || state === WORKING,
  }
}

/** Minutes, rounded, for human output. Null age reads as "never", not as zero. */
const mins = (ms) => (ms == null ? null : Math.round(ms / 60000))

/**
 * One line for hive_members. The wording of PARKED is doing real work: an agent reading
 * "PARKED" alone will treat it as a synonym for idle and keep waiting on it, so the line has to
 * say the consequence -- nothing you send will be acted on -- rather than the label.
 */
export function line(name, rec, opts = {}) {
  const d = describe(rec, opts)
  const age = mins(d.ageMs)
  const tool = d.lastTool ? ` (${d.lastTool})` : ''
  switch (d.state) {
    case WAITING:
      return `${name} — WAITING: blocked in hive_wait, wakes the moment anything arrives. Reachable.`
    case WORKING:
      return `${name} — WORKING: last action ${age} min ago${tool}. Reachable.`
    case PAUSED:
      return `${name} — PAUSED by a human. It is obeying a stop, not stalled. Do not reassign its work.`
    case PASSIVE:
      return `${name} — PASSIVE LISTENER: does not take turns. Its silence is correct.`
    case PRESENT:
      return `${name} — PRESENT${age == null ? '' : `, last action ${age} min ago${tool}`}. A person; ` +
        `reachable whenever they are at the keyboard.`
    case GONE:
      return `${name} — GONE: not connected.${age == null ? '' : ` Last action ${age} min ago${tool}.`}`
    case PARKED:
    default:
      return `${name} — PARKED: connected, but NOT inside hive_wait and silent for ` +
        `${age == null ? 'its whole session' : `${age} min`}${tool}. ` +
        `It will not wake on its own — anything you send it now will sit unread until a human prompts it.`
  }
}

/**
 * Drop rows for members nobody has seen in a month. The map is keyed by name, so it grows with
 * distinct names rather than with time and this is a tidiness bound, not a correctness one.
 */
export function prune(store, { now = Date.now() } = {}) {
  if (!store) return 0
  let n = 0
  for (const [k, rec] of [...store.entries()]) {
    const last = rec && Number(rec.lastAction)
    if (Number.isFinite(last) && (now - last) > PRUNE_AFTER_MS) { store.delete(k); n++ }
  }
  return n
}

/** Every stored row, newest action first. */
export function all(store) {
  if (!store) return []
  return [...store.entries()]
    .map(([k, rec]) => ({ key: k, ...(rec || {}) }))
    .sort((a, b) => (Number(b.lastAction) || 0) - (Number(a.lastAction) || 0))
}
