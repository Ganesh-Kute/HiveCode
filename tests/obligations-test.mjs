// obligations: a question stays open until the ASKER closes it.
//
//   node tests/obligations-test.mjs
//
// THE INCIDENT THIS SUITE IS BUILT FROM. On 19 Sep 2026 Tester posted one message at 12:29
// addressed to @Reviewer -- an agent that had never been in the room -- and then said nothing for
// six hours. Every tool call succeeded. Nothing logged an error. The failure was a question that
// nobody was ever going to answer, and it was invisible until a human read the transcript.
//
// Section A replays exactly that. If the A block ever goes green without the guard, the guard is
// decoration.
//
// THE TWO ASSERTIONS THAT CARRY THE DESIGN, and they are both in section B:
//
//   1. the debtor cannot discharge its own obligation
//   2. a REPLY does not discharge it either
//
// Without (1) the mechanism measures nothing -- an agent that answers badly closes its ticket as
// cleanly as one that answers well. Without (2) it measures the wrong thing: "did words come
// back" rather than "was the asker satisfied". Both are the false-success shape that every defect
// on this project has turned out to be, so both get an explicit test rather than a comment.
//
// The store is a plain Map with an injected clock. In production it is a Y.Map -- same
// get/set/delete/entries surface -- so this suite needs no relay, no room and no sleeping, and a
// six-hour stall is exercised in a microsecond.

import {
  open, discharge, dischargeFrom, owedBy, owedTo, openList, overdue, knock,
  isStale, stale, board, describe, obligationId,
  DUE_MS, BACKOFF, MAX_DUE_MS, STALE_AFTER,
} from '../hive-obligations.js'

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// A fixed clock. Real time in a test is how you get a suite that passes on a fast machine and
// fails in CI, and every deadline here is a subtraction.
const mkClock = (t0 = 1_700_000_000_000) => { let t = t0; return { now: () => t, advance: (ms) => (t += ms) } }
const seq = () => { let i = 0; return () => ((i = (i + 0.137) % 1), i) }   // deterministic ids

// ── A. THE REAL INCIDENT ──────────────────────────────────────────────────────
console.log('\n# A. the Tester/@Reviewer stall, replayed')
{
  const store = new Map(); const c = mkClock(); const r = seq()

  // 12:29. Tester asks a question of an agent that is not here. Under the old code this was a
  // successful hive_say and nothing else.
  const ob = open(store, { from: 'Tester', to: 'Reviewer', text: 'suite is green, can you sign off?', absent: true }, c.now, r)

  T('A1 the question is recorded rather than only spoken', openList(store).length === 1)
  T('A2 it is recorded as owed BY Reviewer', owedBy(store, 'Reviewer').length === 1)
  T('A3 and owed TO Tester', owedTo(store, 'Tester').length === 1)
  T('A4 asking an agent who is not in the room is flagged AT THE MOMENT OF ASKING',
    ob.absent === true)
  T('A5 and that flag is visible in the one-line form, in words a human acts on',
    /NOBODY BY THAT NAME WAS IN THE ROOM/.test(describe(ob, c.now)))

  // Nothing happens. For six hours.
  T('A6 not overdue yet at nine minutes', (c.advance(9 * 60000), overdue(store, 'Reviewer', c.now).length === 0))
  T('A7 overdue at ten', (c.advance(2 * 60000), overdue(store, 'Reviewer', c.now).length === 1))

  c.advance(6 * 3600_000)
  const line = describe(store.get(ob.id), c.now)
  // 6h11m = 371 minutes exactly, so there is no decimal to match. An earlier version of this
  // assertion demanded one and failed on correct output -- the age must be READ out of the line
  // and compared, not pattern-matched on a shape it only sometimes has.
  T('A8 six hours later the age is reported in the line, not left to be inferred',
    Math.round(Number((line.match(/\((\d+(?:\.\d)?)m\)/) || [])[1])) === 371, line)
  T('A9 the question text is carried so the reader knows WHAT is unanswered',
    line.includes('suite is green'))

  // THE POINT OF THE WHOLE EXERCISE: one call makes the stall visible.
  const b = board(store, c.now)
  T('A10 the board reports it open', b.open === 1)
  T('A11 nothing discharged it by mere passage of time', !store.get(ob.id).done)
}

// ── B. ONLY THE ASKER DISCHARGES ──────────────────────────────────────────────
console.log('\n# B. only the asker discharges -- the load-bearing rule')
{
  const store = new Map(); const c = mkClock(); const r = seq()
  const ob = open(store, { from: 'Claude', to: 'Builder', text: 'did HIV-13 change the divisor?' }, c.now, r)

  const self = discharge(store, { id: ob.id, by: 'Builder' }, c.now)
  T('B1 THE DEBTOR CANNOT CLOSE ITS OWN OBLIGATION', self.ok === false)
  T('B2 and is told why in a sentence naming who can', /only the asker/.test(self.reason || ''), self.reason)
  T('B3 the refusal tells the debtor what to do instead of just saying no',
    /answer it in chat/.test(self.reason || ''))
  T('B4 the record is untouched by a refused discharge', store.get(ob.id).done === false)

  const bystander = discharge(store, { id: ob.id, by: 'Tester' }, c.now)
  T('B5 nor can an uninvolved third agent close it', bystander.ok === false)

  // A REPLY IS NOT AN ANSWER. This is the assertion that separates this mechanism from a
  // read-receipt: Builder can say anything it likes, and the obligation does not move.
  T('B6 A REPLY DOES NOT DISCHARGE IT -- only an explicit call by the asker does',
    owedBy(store, 'Builder').length === 1)

  const asker = discharge(store, { id: ob.id, by: 'Claude' }, c.now)
  T('B7 the asker CAN close it', asker.ok === true)
  T('B8 it leaves the open list', openList(store).length === 0)
  T('B9 who closed it and when are both kept', asker.rec.doneBy === 'Claude' && asker.rec.doneAt === c.now())
  T('B10 closing twice is not an error -- retries must not look like failures',
    discharge(store, { id: ob.id, by: 'Claude' }, c.now).ok === true)
  T('B11 an unknown id refuses with a reason rather than throwing',
    discharge(store, { id: 'ob_nope', by: 'Claude' }, c.now).ok === false)

  // Case matters nowhere in this room: @builder and @Builder are one agent.
  const ob2 = open(store, { from: 'Claude', to: 'Builder', text: 'and the tests?' }, c.now, r)
  T('B12 names compare case-insensitively, as @mentions do',
    discharge(store, { id: ob2.id, by: 'claude' }, c.now).ok === true)
}

// ── C. ESCALATION BACKS OFF IN TIME AND UP IN AUDIENCE ────────────────────────
console.log('\n# C. knocks back off; visibility goes up')
{
  const store = new Map(); const c = mkClock(); const r = seq()
  const ob = open(store, { from: 'Claude', to: 'Builder', text: 'status?' }, c.now, r)

  T('C1 the first knock is due after the default window', ob.due === ob.at + DUE_MS)

  c.advance(DUE_MS)
  const k1 = knock(store, ob.id, c.now)
  T('C2 a delivered knock is counted', k1.knocks === 1)
  T('C3 and the next one is pushed out by the backoff, not repeated immediately',
    k1.due === c.now() + DUE_MS * BACKOFF, `${k1.due - c.now()}`)
  T('C4 one knock is not yet stale', !isStale(k1))

  c.advance(DUE_MS * BACKOFF); knock(store, ob.id, c.now)
  c.advance(DUE_MS * BACKOFF * BACKOFF)
  const k3 = knock(store, ob.id, c.now)
  T(`C5 after ${STALE_AFTER} knocks it is STALE -- the room's problem now, not one agent's`,
    isStale(k3) && stale(store).length === 1)
  T('C6 and the staleness says so in the line', /STALE after 3 reminders/.test(describe(k3, c.now)))

  // The cap. Without it the fourth doubling is 80 minutes and the sixth is over five hours, which
  // is a forgotten question dressed up as patience.
  let cur = k3
  for (let i = 0; i < 8; i++) { c.advance(cur.due - c.now()); cur = knock(store, ob.id, c.now) }
  T('C7 backoff is capped, so a question can never go quiet for a whole shift',
    cur.dueMs === MAX_DUE_MS, `${cur.dueMs}ms`)

  T('C8 a discharged obligation cannot be knocked',
    (discharge(store, { id: ob.id, by: 'Claude' }, c.now), knock(store, ob.id, c.now) === null))
  T('C9 and it is gone from the stale list', stale(store).length === 0)
}

// ── D. MUST NOT FIRE ──────────────────────────────────────────────────────────
console.log('\n# D. the cases where it must stay quiet')
{
  const store = new Map(); const c = mkClock(); const r = seq()
  open(store, { from: 'Claude', to: 'Builder', text: 'q1' }, c.now, r)
  open(store, { from: 'Builder', to: 'Tester', text: 'q2' }, c.now, r)

  T('D1 an agent owes only what was aimed at IT', owedBy(store, 'Builder').length === 1)
  T('D2 an agent is owed only what IT asked', owedTo(store, 'Builder').length === 1)
  T('D3 an agent with no traffic owes nothing', owedBy(store, 'Nobody').length === 0)
  T('D4 nothing is overdue before its window', overdue(store, 'Builder', c.now).length === 0)

  // MERELY NOTICING AN OVERDUE RECORD MUST NOT MOVE ITS DEADLINE. If `overdue()` advanced `due`,
  // a debtor that never calls hive_wait would have its deadline extended forever by whoever
  // happened to read the board -- which is exactly backwards.
  c.advance(DUE_MS + 1)
  const before = openList(store).map((o) => o.due).join(',')
  overdue(store, 'Builder', c.now); board(store, c.now); owedBy(store, 'Builder')
  T('D5 READING the board does not reschedule anything -- only a delivered knock does',
    openList(store).map((o) => o.due).join(',') === before)

  // An id collision would make one of two simultaneous questions silently vanish. In a CRDT room
  // "at the same millisecond" is not hypothetical.
  const fixed = mkClock()
  const ids = new Set()
  for (let i = 0; i < 500; i++) ids.add(obligationId('Claude', fixed.now()))
  T('D6 500 ids minted in the same millisecond do not collide', ids.size === 500, `${ids.size}/500`)

  T('D7 long text is clipped so the board stays a board, not a second transcript',
    open(store, { from: 'A', to: 'B', text: 'x'.repeat(400) }, c.now, r).text.length <= 141)
}

// ── E. BULK CLOSE ─────────────────────────────────────────────────────────────
console.log('\n# E. closing several at once')
{
  const store = new Map(); const c = mkClock(); const r = seq()
  open(store, { from: 'Claude', to: 'Builder', text: 'q1' }, c.now, r)
  open(store, { from: 'Claude', to: 'Builder', text: 'q2' }, c.now, r)
  open(store, { from: 'Claude', to: 'Tester', text: 'q3' }, c.now, r)
  open(store, { from: 'Tester', to: 'Builder', text: 'q4' }, c.now, r)

  const closed = dischargeFrom(store, { by: 'Claude', to: 'Builder' }, c.now)
  T('E1 one reply covering two questions closes both', closed.length === 2)
  T('E2 it does not touch what the same agent asked SOMEBODY ELSE',
    owedTo(store, 'Claude').length === 1)
  T('E3 and it does not touch what ANOTHER agent asked the same debtor',
    owedBy(store, 'Builder').length === 1 && owedBy(store, 'Builder')[0].from === 'Tester')
  T('E4 bulk close obeys the same rule -- it can only close your OWN questions',
    dischargeFrom(store, { by: 'Builder', to: 'Builder' }, c.now).length === 0)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
