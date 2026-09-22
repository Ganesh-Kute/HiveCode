// tests/transcript-receipts-test.mjs — TDD assertions for transcriptStateFor() (HIV-P2)
//
// Rules under test:
//   1. A read is an immutable fact about the past: absence cannot un-read a message.
//   2. A departed agent whose cursor is behind the message left without reading it (UNREACHABLE).
//   3. Silence without evidence is UNKNOWN, never UNREACHABLE (e.g. browser, Telegram bridge).
//   4. cur.at > index is strict: sitting exactly at the index is NOT read.
//   5. Forward-looking reachability (stateFor) remains unchanged: absence wins (D1).

import * as R from '../hive-receipts.js'

const {
  publishCursor,
  stateFor,
  transcriptStateFor,
  READ,
  UNREAD,
  UNKNOWN,
  UNREACHABLE,
} = R

let pass = 0, fail = 0
const T = (ruleName, cond, extra = '') => {
  if (cond) {
    console.log(`  ok   ${ruleName}${extra ? `   ${extra}` : ''}`)
    pass++
  } else {
    console.log(`  FAIL ${ruleName}${extra ? `   ${extra}` : ''}`)
    fail++
  }
}

const mkClock = (t0 = 1_700_000_000_000) => { let t = t0; return { now: () => t, advance: (ms) => (t += ms) } }

console.log('\n# HIV-P2: transcriptStateFor TDD Suite')

// Case 1: departed agent, cursor PAST the message -> transcript says READ
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 3, c.now)
  try {
    if (typeof transcriptStateFor !== 'function') throw new TypeError('transcriptStateFor is not a function (pending implementation)')
    const res = transcriptStateFor({ cursors: cur, name: 'Builder', index: 1, present: false })
    T('1. A DEPARTED AGENT WITH CURSOR PAST THE MESSAGE RENDERS READ IN TRANSCRIPT', res && res.state === READ, res ? res.state : '')
  } catch (err) {
    T('1. A DEPARTED AGENT WITH CURSOR PAST THE MESSAGE RENDERS READ IN TRANSCRIPT', false, `[${err.name}: ${err.message}]`)
  }
}

// Case 2: departed agent, cursor BEHIND -> UNREACHABLE
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 2, c.now)
  try {
    if (typeof transcriptStateFor !== 'function') throw new TypeError('transcriptStateFor is not a function (pending implementation)')
    const res = transcriptStateFor({ cursors: cur, name: 'Builder', index: 5, present: false })
    T('2. A DEPARTED AGENT WITH CURSOR BEHIND THE MESSAGE RENDERS UNREACHABLE', res && res.state === UNREACHABLE, res ? res.state : '')
  } catch (err) {
    T('2. A DEPARTED AGENT WITH CURSOR BEHIND THE MESSAGE RENDERS UNREACHABLE', false, `[${err.name}: ${err.message}]`)
  }
}

// Case 3: departed agent with NO CURSOR vs departed agent WITH CURSOR BEHIND
// 3A: No cursor -> UNKNOWN, never UNREACHABLE
{
  const cur = new Map()
  try {
    if (typeof transcriptStateFor !== 'function') throw new TypeError('transcriptStateFor is not a function (pending implementation)')
    const res = transcriptStateFor({ cursors: cur, name: 'Telegram', index: 1, present: false })
    T('3A. A DEPARTED PARTICIPANT WITH NO CURSOR IS UNKNOWN, NEVER UNREACHABLE', res && res.state === UNKNOWN, res ? res.state : '')
  } catch (err) {
    T('3A. A DEPARTED PARTICIPANT WITH NO CURSOR IS UNKNOWN, NEVER UNREACHABLE', false, `[${err.name}: ${err.message}]`)
  }
}

// 3B: With cursor behind -> UNREACHABLE (the contrast rule)
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Claude', 1, c.now)
  try {
    if (typeof transcriptStateFor !== 'function') throw new TypeError('transcriptStateFor is not a function (pending implementation)')
    const res = transcriptStateFor({ cursors: cur, name: 'Claude', index: 4, present: false })
    T('3B. A DEPARTED PARTICIPANT WITH CURSOR BEHIND IS UNREACHABLE, CONTRASTING NO-CURSOR UNKNOWN', res && res.state === UNREACHABLE, res ? res.state : '')
  } catch (err) {
    T('3B. A DEPARTED PARTICIPANT WITH CURSOR BEHIND IS UNREACHABLE, CONTRASTING NO-CURSOR UNKNOWN', false, `[${err.name}: ${err.message}]`)
  }
}

// Case 4: cursor EXACTLY AT the message index is NOT read (assert index-1, index, index+1)
{
  const cur = new Map(); const c = mkClock()
  // Cursor at 3 means messages 0, 1, 2 were consumed.
  publishCursor(cur, 'Builder', 3, c.now)
  try {
    if (typeof transcriptStateFor !== 'function') throw new TypeError('transcriptStateFor is not a function (pending implementation)')
    // index-1 (index 2): cursor(3) > 2 -> READ
    const below = transcriptStateFor({ cursors: cur, name: 'Builder', index: 2, present: true })
    // index (index 3): cursor(3) is NOT > 3 -> UNREAD (cur.at > index is strict)
    const at = transcriptStateFor({ cursors: cur, name: 'Builder', index: 3, present: true })
    // index+1 (index 4): cursor(3) < 4 -> UNREAD
    const above = transcriptStateFor({ cursors: cur, name: 'Builder', index: 4, present: true })

    const boundaryOk = below.state === READ && at.state === UNREAD && above.state === UNREAD
    T('4. CURSOR EXACTLY AT MESSAGE INDEX IS NOT READ (STRICT GREATER-THAN BOUNDARY AT INDEX-1, INDEX, INDEX+1)', boundaryOk,
      `index 2: ${below.state}, index 3: ${at.state}, index 4: ${above.state}`)
  } catch (err) {
    T('4. CURSOR EXACTLY AT MESSAGE INDEX IS NOT READ (STRICT GREATER-THAN BOUNDARY AT INDEX-1, INDEX, INDEX+1)', false, `[${err.name}: ${err.message}]`)
  }
}

// Case 5: stateFor is UNCHANGED. D1 invariant from tests/receipts-test.mjs must PASS!
{
  const cur = new Map(); const c = mkClock()
  publishCursor(cur, 'Builder', 2, c.now)
  const gone = stateFor({ cursors: cur, name: 'Builder', index: 1, present: false })
  T('5. D1 INVARIANT: STATEFOR STILL TREATS DEPARTED AGENT AS UNREACHABLE (FORWARD REACHABILITY UNCHANGED)', gone && gone.state === UNREACHABLE, gone ? gone.state : '')
}

console.log(`\n${pass}/${pass + fail} passed (${fail} failed)\n`)
if (fail > 0) {
  process.exitCode = 1
}
