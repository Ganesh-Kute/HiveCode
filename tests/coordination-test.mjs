// The four coordination pieces: @all, reply debts, busy state, and the sender-side report.
//
// The theme running through every case here is the one that decides whether a coordination
// channel survives contact with eight agents: an obligation that fires on traffic nobody chose
// to send is not coordination, it is spam with a rule attached. So most of these tests are
// about what does NOT create work.
import assert from 'assert'
import { mentionsName, mentionsAll, mentionedNames, unansweredFor } from '../hive-mailbox.js'
import { isBusy, makeBusy, busyFor, describeRecipient, DEFAULT_TTL, MAX_TTL } from '../hive-busy.js'
import { decide } from '../hive-stop-hook.js'

let pass = 0, fail = 0
const T = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name) } else { fail++; console.log('  FAIL ' + name) } }
const section = (s) => console.log('\n# ' + s)

const m = (by, text, at = '19:00:00', kind = 'ai') => ({ by, kind, at, text })

section('@all — the deliberate broadcast')
{
  T('@all reaches everyone', mentionsName('@all the suite is red', 'Ada') && mentionsName('@all the suite is red', 'Kai'))
  T('case-insensitive', mentionsName('@ALL stop', 'Ada'))
  T('mid-sentence', mentionsName('heads up @all, pricing is wrong', 'Eve'))
  // Boundary correctness matters more for @all than for a name: a false positive wakes the
  // entire room instead of one agent.
  T('@allen does NOT reach everyone', !mentionsName('@allen can you look', 'Ada'))
  T('@all-hands does NOT reach everyone', !mentionsName('@all-hands meeting', 'Ada'))
  T('...but @allen still reaches Allen', mentionsName('@allen can you look', 'allen'))
  T('an ordinary message is unaffected', !mentionsName('all of the tests pass', 'Ada'))
  T('mentionsAll is exposed for callers that must distinguish', mentionsAll('@all x') && !mentionsAll('@Ada x'))
  T('mentionedNames still sees it, so hive_say does not call it unaddressed',
    mentionedNames('@all ship it').includes('all'))
}

section('reply debts — who is still waiting on me')
{
  const chat = [m('Eve', '@Ada the suite is red, can you look'), m('Ada', 'working on it')]
  T('a direct question with no reply is a debt', unansweredFor(chat, 'Ada').length === 1)
  T('the debt names the sender', unansweredFor(chat, 'Ada')[0].from === 'Eve')
  T('...and carries the text, so the reason can quote it', /suite is red/.test(unansweredFor(chat, 'Ada')[0].text))

  T('naming them clears it',
    unansweredFor([...chat, m('Ada', '@Eve on it now')], 'Ada').length === 0)
  T('a bare reply that names nobody does NOT clear it',
    unansweredFor([...chat, m('Ada', 'fixed')], 'Ada').length === 0 ? false : true)
  T('answering the wrong person does not clear it',
    unansweredFor([...chat, m('Ada', '@Kai unrelated')], 'Ada').length === 1)
  T('a later question re-opens a settled debt',
    unansweredFor([...chat, m('Ada', '@Eve done'), m('Eve', '@Ada and the terms page?')], 'Ada').length === 1)

  // THE STORM GUARD. One broadcast to eight agents must not create eight obligations.
  T('@all creates NO debt', unansweredFor([m('PM', '@all standup in 5')], 'Ada').length === 0)
  T('a broadcast FROM me discharges everything I owe',
    unansweredFor([...chat, m('Ada', '@all here is the status')], 'Ada').length === 0)

  T('my own messages never put me in debt to myself',
    unansweredFor([m('Ada', '@Ada note to self')], 'Ada').length === 0)
  T('system messages create no debt',
    unansweredFor([m('relay', '@Ada provenance unattributed', '19:00:00', 'system')], 'Ada').length === 0)
  // These are posted by the sync client, not chosen by a participant, and they name everyone.
  T('the client\'s own conflict notices create no debt',
    unansweredFor([m('Eve', '⚠ MERGE CONFLICT in a.md — it has <<<<<<< markers. Whoever owns it: @Ada')], 'Ada').length === 0)
  T('two senders are two debts',
    unansweredFor([m('Eve', '@Ada one'), m('Sam', '@Ada two')], 'Ada').length === 2)
  T('the same sender asking twice is still one debt',
    unansweredFor([m('Eve', '@Ada one'), m('Eve', '@Ada two')], 'Ada').length === 1)
  T('empty input is safe', unansweredFor([], 'Ada').length === 0 && unansweredFor(null, '').length === 0)
}

section('busy — state, not an announcement')
{
  const t0 = 1_000_000
  const e = makeBusy('rewriting ratelimit.py', { now: t0 })
  T('is busy immediately', isBusy(e, t0))
  T('still busy a minute in', isBusy(e, t0 + 60_000))
  // A crashed agent must not leave a permanent flag: everyone would believe it forever.
  T('EXPIRES on its own', !isBusy(e, t0 + DEFAULT_TTL + 1))
  T('a custom window is honoured', isBusy(makeBusy('x', { ttl: 60_000, now: t0 }), t0 + 59_000))
  T('...and expires', !isBusy(makeBusy('x', { ttl: 60_000, now: t0 }), t0 + 61_000))
  T('absent means free', !isBusy(null) && !isBusy(undefined) && !isBusy({}))
  // A ttl of 0 harmlessly falls back to the default. The real way to pin the room is the other
  // end — an unbounded ttl, which reinstates the exact failure the TTL exists to prevent, and
  // does it silently: everyone just stops expecting an answer, forever.
  T('a zero/absent ttl falls back to the default', isBusy(makeBusy('x', { ttl: 0, now: t0 }), t0 + 5000))
  T('an INFINITE ttl is capped, not honoured', !isBusy(makeBusy('x', { ttl: Infinity, now: t0 }), t0 + MAX_TTL + 1))
  T('a wildly long ttl is capped', !isBusy(makeBusy('x', { ttl: 999 * 60 * 60 * 1000, now: t0 }), t0 + MAX_TTL + 1))
  // The read side is the one that matters: this entry came from another client's build.
  T('a hostile entry off the wire is capped on READ',
    !isBusy({ what: 'x', since: t0, ttl: Number.MAX_SAFE_INTEGER }, t0 + MAX_TTL + 1))
  T('what is kept and capped', makeBusy('x'.repeat(500)).what.length === 200)

  T('duration reads in seconds early', busyFor(e, t0 + 30_000) === '30s')
  T('...and minutes later', busyFor(e, t0 + 600_000) === '10m')
}

section('what the SENDER is told, at send time')
{
  const t0 = 1_000_000
  const busy = makeBusy('rewriting ratelimit.py', { now: t0 })
  T('a free agent produces no noise', describeRecipient('Kai', null, true, t0) === '')
  T('an expired flag produces no noise', describeRecipient('Kai', busy, true, t0 + DEFAULT_TTL + 1) === '')

  const d = describeRecipient('Ada', busy, true, t0 + 120_000)
  T('a busy agent is reported', /busy 2m/.test(d))
  T('...with what they are doing', /rewriting ratelimit\.py/.test(d))
  T('...and says not to wait on them', /not idle waiting on you/.test(d))

  // Absence is the more useful of the two and must win: a message to someone who left is not
  // delayed, it is unread forever, and only the sender can notice.
  const gone = describeRecipient('Ada', busy, false, t0)
  T('ABSENCE outranks busy', /NOT in the room/.test(gone) && !/busy/.test(gone))
  T('...and says nobody will read it', /nobody will read that/.test(gone))
}

section('the Stop gate refuses to end a turn on an unanswered question')
{
  const chat = ['# Hive Chat', '', '- 19:07:27  Eve (ai): @Ada the suite is red, can you look'].join('\n')
  // seen:1 means the message was already delivered — so this is NOT unread mail, it is a debt.
  // That distinction is the entire reason this branch exists.
  const d = decide({ chat, tasks: '', me: 'Ada', seen: 1, taskBlocks: 0 })
  T('read-but-unanswered still blocks the stop', d.block === true)
  T('the reason quotes the question', /suite is red/.test(d.reason))
  T('...and says a holding reply counts', /Not yet/.test(d.reason))

  const answered = chat + '\n- 19:08:00  Ada (ai): @Eve on it, give me ten minutes'
  T('answering releases the gate',
    decide({ chat: answered, tasks: '', me: 'Ada', seen: 2, taskBlocks: 0 }).block === false)

  // ONE NUDGE, EVER. A debt persists until it is answered, so without this it would block every
  // single turn — and a gate that nags is a gate the user switches off. State threaded exactly
  // as the hook threads it.
  let st = { seen: 1, taskBlocks: 0, nudged: [] }
  const blocks = []
  for (let i = 0; i < 5; i++) {
    const r = decide({ chat, tasks: '', me: 'Ada', ...st })
    blocks.push(r.block); st = { seen: r.seen, taskBlocks: r.taskBlocks, nudged: r.nudged }
  }
  T('nudges once', blocks[0] === true)
  T('and never again for the same question', blocks.slice(1).every((b) => b === false))

  // ...but a NEW question from the same sender gets its own single nudge, or an agent could
  // silence itself permanently by ignoring one message.
  const later = chat + '\n- 19:20:00  Eve (ai): @Ada and what about the terms page?'
  T('a new question from the same sender still nudges',
    decide({ chat: later, tasks: '', me: 'Ada', seen: 2, taskBlocks: 0, nudged: st.nudged }).block === true)

  T('a broadcast leaves no debt to block on',
    decide({ chat: '- 19:07:27  PM (ai): @all standup', tasks: '', me: 'Ada', seen: 1, taskBlocks: 0 }).block === false)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
assert.strictEqual(fail, 0)
