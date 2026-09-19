// receipts: "sent" is not evidence, and an absent receipt is not a receipt.
//
//   node tests/receipts-test.mjs
//
// THE ASSERTION THIS SUITE EXISTS FOR is not "a read message reads as READ" -- that is the easy
// half and it would pass against a two-state design that lies. It is section C:
//
//     an agent that publishes NO cursor is UNKNOWN, and UNKNOWN never counts as delivered.
//
// A Telegram bridge, a human's browser tab and any older build all publish no cursor. A design
// with only delivered/not-delivered has to fold them into one of the two, and either choice is a
// lie that looks like a measurement: fold them into delivered and every dead agent reads as fine,
// fold them into undelivered and every human reads as broken. Agent Relay hit the same wall and
// answered it with `Unverified` -- "unverified deliveries never drive the delay down".
//
// Section E is the second load-bearing one: while this client is OFFLINE, nothing about the other
// side is knowable, and `hive_say` must stop saying "sent". That is the live defect -- verified
// today that hive_say never once consults status().connected, which is right there and free.

import {
  publishCursor, cursorOf, findIndex, stateFor, receipts, describe, countDelivered, sendWarning,
  READ, UNREAD, UNKNOWN, UNREACHABLE,
} from '../hive-receipts.js'

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const mkClock = (t0 = 1_700_000_000_000) => { let t = t0; return { now: () => t, advance: (ms) => (t += ms) } }
const msg = (by, text, at = '12:00:00') => ({ by, kind: 'ai', at, text })

// A room log shaped like a real one: some ambient, some addressed, one broadcast.
const CHAT = [
  msg('Claude', 'starting on governor.js', '12:00:00'),            // 0  ambient
  msg('Claude', '@Builder did HIV-13 change the divisor?', '12:01:00'), // 1  addressed
  msg('Builder', '@Claude looking', '12:02:00'),                   // 2
  msg('Claude', '@Tester suite please', '12:03:00'),               // 3  addressed
  msg('Claude', '@all standup in 5', '12:04:00'),                  // 4  broadcast
]

// ── A. the cursor is the echo ─────────────────────────────────────────────────
console.log('\n# A. a published cursor is what makes delivery knowable')
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 2, c.now)
  T('A1 a cursor is published', cursorOf(cur, 'Builder').at === 2)
  T('A2 and is found case-insensitively, as @mentions are', cursorOf(cur, 'builder').at === 2)
  T('A3 an agent that never published is null, not zero', cursorOf(cur, 'Tester') === null)

  // A cursor of 2 means indexes 0 and 1 were handed over.
  T('A4 a message BELOW the cursor is READ',
    stateFor({ cursors: cur, name: 'Builder', index: 1 }).state === READ)
  T('A5 a message AT the cursor is NOT yet read -- off-by-one here would report a lie',
    stateFor({ cursors: cur, name: 'Builder', index: 2 }).state === UNREAD)
  T('A6 a message above it is UNREAD',
    stateFor({ cursors: cur, name: 'Builder', index: 3 }).state === UNREAD)
  T('A7 and it says HOW far behind, which is the actionable part',
    stateFor({ cursors: cur, name: 'Builder', index: 3 }).behind === 2)
}

// ── B. cursors only move forward ──────────────────────────────────────────────
console.log('\n# B. a cursor never goes backwards')
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 9, c.now)
  // A rejoin hands the session a stale persisted cursor. Un-reading a message somebody has
  // already answered is worse than having no receipt at all.
  publishCursor(cur, 'Builder', 3, c.now)
  T('B1 A STALE CURSOR FROM A REJOIN CANNOT UN-READ ANYTHING', cursorOf(cur, 'Builder').at === 9)

  const before = cursorOf(cur, 'Builder')
  c.advance(5000)
  publishCursor(cur, 'Builder', 9, c.now)
  T('B2 republishing the same position writes nothing -- every write wakes every observer',
    cursorOf(cur, 'Builder') === before)
  publishCursor(cur, 'Builder', 10, c.now)
  T('B3 a real advance does write', cursorOf(cur, 'Builder').at === 10)
}

// ── C. UNKNOWN IS NOT DELIVERED ───────────────────────────────────────────────
console.log('\n# C. no cursor means NO EVIDENCE -- the state a two-state design cannot express')
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 5, c.now)

  const ghost = stateFor({ cursors: cur, name: 'Telegram', index: 1 })
  T('C1 AN AGENT THAT PUBLISHES NO CURSOR IS UNKNOWN, NOT READ AND NOT UNREAD',
    ghost.state === UNKNOWN, ghost.state)
  T('C2 and the reason names why, so nobody reads it as a fault',
    /means nothing either way/.test(ghost.why), ghost.why)
  T('C3 it lists the clients this actually happens for, so it is not mistaken for a bug',
    /bridge|human|older build/.test(ghost.why))

  const states = [
    stateFor({ cursors: cur, name: 'Builder', index: 1 }),   // READ
    stateFor({ cursors: cur, name: 'Telegram', index: 1 }),  // UNKNOWN
    stateFor({ cursors: cur, name: 'Builder', index: 9 }),   // UNREAD
  ]
  T('C4 COUNTDELIVERED COUNTS ONLY READ -- UNKNOWN must never be summed into the good number',
    countDelivered(states) === 1, `${countDelivered(states)} of ${states.length}`)
}

// ── D. absence outranks a stale cursor ────────────────────────────────────────
console.log('\n# D. not being in the room outranks everything about cursors')
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 99, c.now)   // cursor says they read everything...
  const gone = stateFor({ cursors: cur, name: 'Builder', index: 1, present: false })
  T('D1 A DEPARTED AGENT IS UNREACHABLE EVEN WITH A CURSOR PAST THE MESSAGE',
    gone.state === UNREACHABLE, gone.state)
  T('D2 and says so in words the sender can act on', /not in the room/.test(gone.why))

  T('D3 a message that is not in the room log at all is UNKNOWN, not READ',
    stateFor({ cursors: cur, name: 'Builder', index: -1 }).state === UNKNOWN)
}

// ── E. OUR OWN SOCKET OUTRANKS EVERYTHING ─────────────────────────────────────
console.log('\n# E. offline: nothing about the other side is knowable')
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 99, c.now)
  const off = stateFor({ cursors: cur, name: 'Builder', index: 1, connected: false })
  T('E1 OFFLINE OUTRANKS A CURSOR THAT SAYS READ -- the message never left this process',
    off.state === UNREACHABLE, off.state)
  T('E2 and the reason says the bytes are still local', /has not (left this machine|reached)/.test(off.why), off.why)

  // The live defect: hive_say says "sent" with the socket down.
  const w = sendWarning({ connected: false })
  T('E3 THE SEND WARNING REFUSES THE WORD "SENT" WHILE OFFLINE', /^NOT SENT/.test(w), w.split('.')[0])
  T('E4 it tells the agent the connection heals itself', /heals/.test(w))
  T('E5 and specifically warns against the fix that destroys local edits', /do NOT call hive_join/.test(w))
  T('E6 a healthy send says nothing at all -- reassurance IS the defect',
    sendWarning({ connected: true }) === '')
  // It deliberately does NOT also report an absent recipient, even though that is knowable here:
  // describeRecipient already says it, and a second copy of one sentence is the duplicated-wire
  // -contract defect. One producer, one description.
  T('E7 it does not duplicate what describeRecipient already says about absence',
    !/NOT IN THIS ROOM|not in the room/i.test(sendWarning({ connected: true })))
}

// ── F. the board ──────────────────────────────────────────────────────────────
console.log('\n# F. what the sender reads back')
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 3, c.now)   // Builder consumed 0,1,2
  const r = receipts({ chat: CHAT, cursors: cur, me: 'Claude' })

  T('F1 only MY addressed messages are tracked', r.length === 2, `${r.length}`)
  T('F2 the ambient one is skipped -- nobody promised it would be read',
    !r.some((x) => /starting on governor/.test(x.text)))
  T('F3 @all is skipped, for the same reason a broadcast creates no reply debt',
    !r.some((x) => /standup/.test(x.text)))

  const toBuilder = r.find((x) => /divisor/.test(x.text))
  T('F4 the question Builder consumed reads READ', toBuilder.to[0].state === READ)
  const toTester = r.find((x) => /suite please/.test(x.text))
  T('F5 the one to an agent with no cursor reads UNKNOWN, not READ', toTester.to[0].state === UNKNOWN)

  T('F6 the line is scannable and carries the text', /Builder=READ/.test(describe(toBuilder)) && /divisor/.test(describe(toBuilder)))
  T('F7 newest last, so it reads like a conversation', r[r.length - 1].at === '12:03:00')
}

// ── G. identity survives a CRDT reorder ───────────────────────────────────────
console.log('\n# G. derived, not stored -- because an index can move')
{
  T('G1 a message is found by (by, at, text), not by a remembered index',
    findIndex(CHAT, CHAT[3]) === 3)
  // A concurrent push from another peer converges ahead of mine, shifting everything down. A
  // stored index would now point at somebody else's message and report a receipt for the wrong
  // thing -- silently, which is the only way this class of bug ever shows up.
  const reordered = [msg('Tester', 'late arrival', '11:59:00'), ...CHAT]
  T('G2 AND IT IS STILL FOUND AFTER A CONCURRENT INSERT SHIFTS EVERY INDEX',
    findIndex(reordered, CHAT[3]) === 4)
  T('G3 a message that is not there is -1, never 0', findIndex(CHAT, msg('X', 'never said', '00:00:00')) === -1)
  T('G4 receipts still resolve correctly against the reordered log', (() => {
    const cur = new Map(); publishCursor(cur, 'Builder', 3, mkClock().now)
    // Builder consumed 3 of the REORDERED log (0,1,2) -- the divisor question is now at index 2.
    const r = receipts({ chat: reordered, cursors: cur, me: 'Claude' })
    return r.find((x) => /divisor/.test(x.text)).to[0].state === READ
  })())
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
