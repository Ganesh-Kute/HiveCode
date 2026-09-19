// throttle: repeat a block only when the agent can no longer see it.
//
//   node tests/throttle-test.mjs
//
// THE ASSERTION THIS SUITE EXISTS FOR is section C:
//
//     a CHANGED block is sent immediately, whatever the throttle says.
//
// Everything else here saves tokens. C is the one that stops the saving from becoming a bug. A
// throttle that suppresses a state change does not cost tokens, it gives a wrong answer -- the
// agent acts on `tests=RUNNING` while the room has said `tests=RED` -- and it does it silently,
// which is the failure shape every defect on this project has had. Correctness outranks economy,
// and the priority order in should() is what encodes that.
//
// Section B is the second one: BOTH gates must pass for a repeat. Either alone is wrong in a way
// that looks fine in a demo -- time alone nags an idle agent that still has the text on screen,
// bytes alone fires mid-burst on an agent that read it ninety seconds ago.

import { makeThrottle, COOLDOWN_MS, OUTPUT_BYTES, RULES_NUDGE } from '../hive-throttle.js'

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const mk = (t0 = 1_700_000_000_000) => {
  let t = t0
  return { th: makeThrottle({ now: () => t }), advance: (ms) => (t += ms) }
}

// ── A. the first one is always free ───────────────────────────────────────────
console.log('\n# A. never sent means send')
{
  const { th } = mk()
  T('A1 a block never sent is sent', th.should('state', 'x').send === true)
  T('A2 and the reason says so', th.should('state', 'x').why === 'first')
  th.sent('state', 'x')
  T('A3 immediately after, the identical block is suppressed', th.should('state', 'x').send === false)
  T('A4 because it is recent, not because it is unchanged -- the reasons are distinct',
    th.should('state', 'x').why === 'recent')
}

// ── B. BOTH GATES ─────────────────────────────────────────────────────────────
console.log('\n# B. a repeat needs time AND work -- either alone is wrong')
{
  const { th, advance } = mk()
  th.sent('state', 'x')

  advance(COOLDOWN_MS + 1)
  T('B1 TIME ALONE IS NOT ENOUGH -- an idle agent still has the text in front of it',
    th.should('state', 'x').send === false, th.should('state', 'x').why)
  T('B2 and it says the agent has been quiet, not that it is too soon',
    th.should('state', 'x').why === 'quiet')

  th.note(OUTPUT_BYTES)
  T('B3 with both gates passed it is sent', th.should('state', 'x').send === true)
  T('B4 and the reason names the actual judgement being made',
    th.should('state', 'x').why === 'likely-compacted')
}
{
  const { th, advance } = mk()
  th.sent('state', 'x')
  th.note(OUTPUT_BYTES * 10)
  advance(COOLDOWN_MS - 1000)
  T('B5 BYTES ALONE IS NOT ENOUGH -- do not fire mid-burst on something read 90 seconds ago',
    th.should('state', 'x').send === false, th.should('state', 'x').why)
  T('B6 and the reason is recency', th.should('state', 'x').why === 'recent')
  advance(2000)
  T('B7 one second past the cooldown, with the bytes already spent, it fires',
    th.should('state', 'x').send === true)
}

// ── C. A CHANGE ALWAYS WINS ───────────────────────────────────────────────────
console.log('\n# C. correctness outranks economy')
{
  const { th } = mk()
  th.sent('state', '{"tests":"RUNNING"}')
  T('C1 A CHANGED BLOCK IS SENT IMMEDIATELY, INSIDE THE COOLDOWN, WITH ZERO BYTES SPENT',
    th.should('state', '{"tests":"RED"}').send === true)
  T('C2 and the reason is the change, not the clock',
    th.should('state', '{"tests":"RED"}').why === 'changed')

  // The failure this prevents: an agent acting on RUNNING while the room has said RED, with
  // nothing anywhere reporting that a message was withheld.
  th.sent('state', '{"tests":"RED"}')
  T('C3 changing back is also a change -- it is not "already seen at some point"',
    th.should('state', '{"tests":"RUNNING"}').send === true)

  T('C4 objects compare by value, so an equal object rebuilt each call is not a change',
    (() => { const { th: t2 } = mk(); t2.sent('s', { a: 1 }); return t2.should('s', { a: 1 }).send === false })())
  T('C5 but a real field change in an object IS one',
    (() => { const { th: t2 } = mk(); t2.sent('s', { a: 1 }); return t2.should('s', { a: 2 }).send === true })())
  T('C6 undefined and null are one value, not a spurious change',
    (() => { const { th: t2 } = mk(); t2.sent('s', undefined); return t2.should('s', null).send === false })())
}

// ── D. keys are independent ───────────────────────────────────────────────────
console.log('\n# D. one throttle, many blocks')
{
  const { th, advance } = mk()
  th.sent('state', 'x')
  advance(COOLDOWN_MS + 1)
  th.note(OUTPUT_BYTES)
  T('D1 a key never sent is still "first", not swept along by another key firing',
    th.should('rules', RULES_NUDGE).why === 'first')
  th.sent('rules', RULES_NUDGE)
  T('D2 sending one key does not reset another', th.should('state', 'x').send === true)
  T('D3 a freshly sent key has its own zeroed counter', th.should('rules', RULES_NUDGE).why === 'recent')

  // The counter must not start before the first send, or the first repeat fires instantly on a
  // busy agent -- the volume only means anything relative to "since you last saw this".
  const { th: t2, advance: adv2 } = mk()
  t2.note(OUTPUT_BYTES * 100)          // a very busy agent...
  t2.sent('state', 'x')                // ...that has only now been told
  adv2(COOLDOWN_MS + 1)
  T('D4 BYTES BEFORE THE FIRST SEND DO NOT COUNT TOWARDS THE FIRST REPEAT',
    t2.should('state', 'x').send === false, t2.should('state', 'x').why)
}

// ── E. send() is should()+sent() and must not double-fire ─────────────────────
console.log('\n# E. the one-call form')
{
  const { th } = mk()
  T('E1 the first send() is true', th.send('state', 'x') === true)
  T('E2 THE SECOND IS FALSE -- should() alone would have returned true twice and sent it twice',
    th.send('state', 'x') === false)
  T('E3 a change still gets through the one-call form', th.send('state', 'y') === true)
  T('E4 sends are counted, so the saving can be measured rather than asserted',
    th.stats().keys.state.sends === 2, JSON.stringify(th.stats().keys.state))
}

// ── F. the measured saving ────────────────────────────────────────────────────
console.log('\n# F. what this is actually worth')
{
  // A realistic idle loop: an agent sitting in hive_wait with the room state unchanged. This is
  // the night-shift shape -- the single most common thing that happens in a Hivecode room.
  const STATE = JSON.stringify({ shift: 'RUNNING', tests: 'GREEN', review: 'PENDING' }, null, 2)
  const BLOCK = `\n[GLOBAL PROJECT STATE]\n${STATE}\n`
  // THE PROPERTY IS THAT SENDS SCALE WITH WORK, NOT WITH LOOP COUNT. An earlier version of this
  // assertion demanded exactly 1 send from 200 loops at 400 bytes each -- and got 2, correctly,
  // because 200 x 400 is 80 KB of output over three hours, which is not an idle agent at all. The
  // code was right and the test's premise was wrong. Both ends of the range are checked below
  // rather than tuning the input until a guessed number appears.
  const loop = (perLoop, n = 200) => {
    const { th, advance } = mk()
    let sentBytes = 0, wouldHave = 0
    for (let i = 0; i < n; i++) {
      wouldHave += BLOCK.length
      if (th.send('state', BLOCK)) sentBytes += BLOCK.length
      advance(60000)              // a 60s wait window
      th.note(perLoop)
    }
    return { sends: th.stats().keys.state.sends, sentBytes, wouldHave }
  }

  const idle = loop(100)          // genuinely idle: ~20 KB over 200 waits, under the threshold
  T('F1 a GENUINELY idle agent is told once and never again, however long it waits',
    idle.sends === 1, `${idle.sends} sends in 200 waits`)

  const light = loop(400)         // 80 KB over 200 waits -- past the threshold once
  T('F2 sends track WORK DONE, not loop count: 4x the output, one extra send',
    light.sends === 2, `${light.sends} sends`)
  T('F3 either way it is a real saving on the most common loop in the product',
    light.sentBytes < light.wouldHave / 50, `${light.sentBytes} vs ${light.wouldHave} bytes`)

  // And the other half: the same 200 waits, but the agent is doing real work, so it IS repeated.
  const { th: busy, advance: advB } = mk()
  let sends = 0
  for (let i = 0; i < 200; i++) {
    if (busy.send('state', BLOCK)) sends++
    advB(60000)
    busy.note(20000)       // a working agent: 20 KB of tool output per loop
  }
  T('F4 a WORKING agent is reminded periodically instead of never', sends > 1 && sends < 100, `${sends} sends in 200 loops`)
  T('F5 and not on every loop, which is what makes it a throttle and not a no-op', sends < 80, `${sends}`)
}

// ── G. the nudge itself ───────────────────────────────────────────────────────
console.log('\n# G. what the repeat actually says')
{
  T('G1 it points at the file rather than restating it -- one producer, one description',
    /HIVE_RULES\.md/.test(RULES_NUDGE) && RULES_NUDGE.length < 400, `${RULES_NUDGE.length} chars`)
  T('G2 it says WHY the general rules are not enough, or the agent skips it',
    /ROOM-specific/.test(RULES_NUDGE))
  T('G3 and it names the moment to act on it', /before your next claim/.test(RULES_NUDGE))
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
