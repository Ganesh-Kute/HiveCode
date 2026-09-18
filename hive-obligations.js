// hive-obligations.js — a question you asked stays open until YOU say it was answered.
//
// THE PROBLEM THIS EXISTS FOR, observed live on 19 Sep 2026.
//
// Tester posted one message at 12:29 addressed to @Reviewer, an agent that was never in the
// room, and then went silent for six hours. Nothing failed. No tool returned an error, no
// process died, no log line said anything was wrong. The room simply had a question in it that
// nobody would ever answer, and the only way to find that out was for a human to read the
// transcript and notice.
//
// Hivecode already carries the RULE -- the MCP instructions say "ANSWER EVERY QUESTION AIMED AT
// YOU: silence is the one thing the asker cannot act on". A rule an agent read once is a rule it
// forgets the moment its context fills. So the rule moves here, where it is a data structure
// instead of a paragraph.
//
// THE ONE LOAD-BEARING DECISION: ONLY THE ASKER DISCHARGES.
//
// The obvious design lets the answerer mark it answered. That design measures nothing. An agent
// that replies "I'll look into it" would clear its own obligation, and a question answered wrongly
// clears just as cleanly as one answered well. Both are exactly the failure -- everything green,
// the result wrong -- that every defect on this project has turned out to be.
//
// So: `from` opened it, and only `from` can close it. The debtor cannot mark its own homework.
// (Agent Relay reached the same conclusion independently in crates/broker/src/obligation.rs:
// "only the author can discharge an obligation... the broker checks reactor == author". Their
// broker re-injects a knock on a timer, which costs tokens on every knock. Ours rides hive_wait,
// which is already blocked and already free.)
//
// ESCALATION IS TO AN AUDIENCE, NOT A FREQUENCY. A knock that repeats every minute forever is
// noise, and a room learns to ignore noise. So the interval backs OFF (10min, 20min, 40min...)
// while the visibility goes UP: after `STALE_AFTER` knocks the record is stale, and a stale
// obligation is the room's problem rather than one agent's.
//
// PURE ON PURPOSE. Every function here takes the store and the clock. The store needs only
// get/set/delete/entries, which a Y.Map and a plain Map both satisfy -- so the tests run against
// a Map with an injected clock and no relay, and the production path passes the Y.Map. That is
// the same shape as governor.js, and it is what let the governor's 10x minutes bug be caught by
// a test instead of by a customer.

/** Default time before the first knock. Ten minutes: long enough that an agent mid-task is not
 *  nagged for thinking, short enough that a stall is caught inside one working stretch. */
export const DUE_MS = 10 * 60000

/** Each knock doubles the wait, so a genuinely long job is not pestered... */
export const BACKOFF = 2

/** ...but never past this, or a forgotten question goes quiet for a whole shift. */
export const MAX_DUE_MS = 60 * 60000

/** Knocks before the room is told. Three because two is a coincidence and four is too late. */
export const STALE_AFTER = 3

/** Chat text is a whole message; an obligation is an index entry. Keep it short enough that
 *  `hive_owed` on a busy room stays readable rather than becoming a second transcript. */
export const TEXT_MAX = 140

const clip = (s) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX - 1) + '…' : t
}

/** Ids must not collide across peers. Two agents opening an obligation in the same millisecond is
 *  not hypothetical in a CRDT room -- every write lands, and a shared key would silently make one
 *  of the two questions disappear. Name + time + entropy: the name alone makes it readable in a
 *  log, which the entropy alone would not.
 *
 *  THE TAG IS TWO DRAWS, NOT ONE, and that is not belt-and-braces. A single `rand() * 1e6` gives
 *  about 2^20 of space, and by the birthday bound 500 ids drawn from it collide roughly 12% of the
 *  time -- which is exactly how this was found: the suite passed, then failed, then passed again on
 *  unchanged code. A flaky test here is not test flakiness, it is the defect reporting itself. Two
 *  draws give ~2^40, where the same 500 ids collide about one run in five million. */
export function obligationId(from, at, rand = Math.random) {
  const draw = () => Math.floor(rand() * 1e6).toString(36).padStart(4, '0')
  return `ob_${String(from || '?').toLowerCase().replace(/[^a-z0-9]+/g, '')}_${at.toString(36)}_${draw()}${draw()}`
}

/**
 * Open an obligation: `from` asked `to` something and is owed an answer.
 *
 * `absent` is recorded at OPEN time and never recomputed. That is deliberate -- it is the answer
 * to "was anyone even there when this was asked", which is a fact about the past. Recomputing it
 * later would let a question asked into an empty room look fine the moment someone walks in.
 */
export function open(store, { from, to, text, dueMs = DUE_MS, absent = false }, now = Date.now, rand = Math.random) {
  const at = now()
  const rec = {
    id: obligationId(from, at, rand),
    from: String(from),
    to: String(to),
    text: clip(text),
    at,
    due: at + Math.max(1, dueMs),
    dueMs: Math.max(1, dueMs),
    knocks: 0,
    absent: !!absent,
    done: false,
  }
  store.set(rec.id, rec)
  return rec
}

const all = (store) => [...store.entries()].map(([, v]) => v).filter(Boolean)

/** Everything still open. */
export const openList = (store) => all(store).filter((r) => !r.done)

/** What `name` OWES: questions aimed at them that their asker has not signed off. */
export const owedBy = (store, name) =>
  openList(store).filter((r) => String(r.to).toLowerCase() === String(name).toLowerCase())

/** What `name` IS OWED: questions they asked that they have not signed off. */
export const owedTo = (store, name) =>
  openList(store).filter((r) => String(r.from).toLowerCase() === String(name).toLowerCase())

/**
 * Discharge. Returns `{ ok, reason }` and NEVER throws, because the interesting cases are all
 * refusals and a refusal has to be readable by the agent that hit it.
 *
 * The `by !== from` refusal is the whole mechanism. It is phrased as instruction rather than
 * error, because the agent reading it is usually the debtor trying to close its own ticket and
 * the useful next action is "answer, then ask them to close it".
 */
export function discharge(store, { id, by }, now = Date.now) {
  const rec = store.get(id)
  if (!rec) return { ok: false, reason: `no obligation ${id} -- it may already be discharged` }
  if (rec.done) return { ok: true, already: true, rec }
  if (String(rec.by || rec.from).toLowerCase() !== String(by).toLowerCase()) {
    return {
      ok: false,
      reason: `${by} cannot discharge this: ${rec.from} asked it, and only the asker can say it ` +
        `was answered. If you are ${rec.to}, answer it in chat and ${rec.from} will close it -- ` +
        `marking your own answer sufficient is exactly the check this exists to make.`,
    }
  }
  const done = { ...rec, done: true, doneAt: now(), doneBy: String(by) }
  store.set(id, done)
  return { ok: true, rec: done }
}

/** Close everything `by` is owed from one agent. An asker who got a long reply covering four
 *  questions should not have to look up four ids to say so. */
export function dischargeFrom(store, { by, to }, now = Date.now) {
  const hit = owedTo(store, by).filter((r) => String(r.to).toLowerCase() === String(to).toLowerCase())
  for (const r of hit) discharge(store, { id: r.id, by }, now)
  return hit
}

/** Open obligations whose knock time has passed. */
export const overdue = (store, name, now = Date.now) =>
  owedBy(store, name).filter((r) => now() >= r.due)

/**
 * Record that a knock was delivered, and push the next one out.
 *
 * Called only when the knock actually reached somebody -- if we advanced `due` on merely NOTICING
 * an overdue record, a debtor that never calls hive_wait would have its deadline extended forever
 * by an observer, which is precisely backwards.
 */
export function knock(store, id, now = Date.now) {
  const rec = store.get(id)
  if (!rec || rec.done) return null
  const nextDueMs = Math.min(MAX_DUE_MS, Math.max(1, rec.dueMs) * BACKOFF)
  const next = { ...rec, knocks: rec.knocks + 1, dueMs: nextDueMs, due: now() + nextDueMs, lastKnockAt: now() }
  store.set(id, next)
  return next
}

/** Knocked enough times that this is the room's problem now, not one agent's. */
export const isStale = (r) => !r.done && r.knocks >= STALE_AFTER

/** Every stale obligation in the room, for the board and for the human. */
export const stale = (store) => openList(store).filter(isStale)

const mins = (ms) => Math.round(ms / 6000) / 10

/** One line, for chat and for tool output. Age is what makes it actionable: "Tester owes Claude
 *  an answer" is a fact, "for 361 minutes" is a decision. */
export function describe(r, now = Date.now) {
  const age = mins(now() - r.at)
  const flags = [
    r.absent ? 'NOBODY BY THAT NAME WAS IN THE ROOM' : '',
    isStale(r) ? `STALE after ${r.knocks} reminders` : '',
  ].filter(Boolean)
  return `${r.id}  ${r.to} owes ${r.from}  (${age}m)  "${r.text}"${flags.length ? '  [' + flags.join('; ') + ']' : ''}`
}

/** The whole board, newest question last so it reads like a conversation. */
export function board(store, now = Date.now) {
  const list = openList(store).sort((a, b) => a.at - b.at)
  return { open: list.length, stale: list.filter(isStale).length, lines: list.map((r) => describe(r, now)) }
}
