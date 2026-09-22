// Tests for the anti-idle Stop gate (hive-stop-hook.js) and the system-prompt text.
//
// Every case here is a way this hook could hurt someone. A gate that blocks an agent forever is
// strictly worse than no gate -- it burns the user's tokens and they cannot get their agent back
// -- so the loop guards get more tests than the blocking does.
import assert from 'assert'
import { decide, parseChat, openTasksFor } from '../hive-stop-hook.js'
import { INSTRUCTIONS, ONE_LINER } from '../hive-instructions.js'

let pass = 0, fail = 0
const T = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name) } else { fail++; console.log('  FAIL ' + name) } }
const section = (s) => console.log('\n# ' + s)

const chat = (...lines) => ['# Hive Chat — header', '', ...lines].join('\n')
const line = (by, text, kind = 'ai', at = '19:07:27') => `- ${at}  ${by} (${kind}): ${text}`

// A fresh state: nothing seen, no task blocks spent.
const S0 = { seen: 0, taskBlocks: 0 }
const run = (o) => decide({ tasks: '', me: 'Ada', ...S0, ...o })

section('parsing the mirrored room files')
{
  const c = chat(line('Eve', 'first'), line('Sam', 'second'))
  T('counts one entry per message', parseChat(c).length === 2)
  T('reads the author', parseChat(c)[0].by === 'Eve')

  // A message containing newlines must count ONCE, or the watermark drifts by one per multi-line
  // post and eventually every message looks unread.
  const multi = chat(line('Eve', 'line one'), 'line two of the same message', line('Sam', 'next'))
  T('folds continuation lines into their message', parseChat(multi).length === 3 - 1)
  T('continuation text is kept', parseChat(multi)[0].text.includes('line two'))
  T('header comments are not messages', parseChat(chat()).length === 0)
}

section('blocking on unread mail')
{
  const c = chat(line('Eve', '@Ada the suite is red, can you look'))
  const d = run({ chat: c })
  T('an @mention blocks the stop', d.block === true)
  T('the reason quotes the actual message', d.reason.includes('the suite is red'))
  T('the reason names the fix', d.reason.includes('hive_wait'))

  T('an unaddressed message does NOT block', run({ chat: chat(line('Eve', 'general chatter')) }).block === false)
  T('my own message does not block me', run({ chat: chat(line('Ada', '@Ada note to self')) }).block === false)
  T('my own name in a different case still does not block me',
    run({ chat: chat(line('ada', '@Ada note to self')) }).block === false)

  // The relay posts conflict warnings naming everyone. Those are not someone waiting on a reply,
  // and blocking on them would make every merge conflict trap every agent in the room.
  T('a system message does not block',
    run({ chat: chat(line('relay', '@Ada MERGE CONFLICT in a.md', 'system')) }).block === false)

  // Name-boundary correctness matters more here than in chat: a false positive means a wrongly
  // trapped agent, and PM / PM-Claude style collisions are real.
  T('@PM does not block PM-Claude',
    decide({ chat: chat(line('Eve', '@PM ping')), tasks: '', me: 'PM-Claude', ...S0 }).block === false)
  T('@PM-Claude does block PM-Claude',
    decide({ chat: chat(line('Eve', '@PM-Claude ping')), tasks: '', me: 'PM-Claude', ...S0 }).block === true)
}

section('GUARD: the watermark makes each message block at most once')
{
  const c = chat(line('Eve', '@Ada please look'))
  const first = run({ chat: c })
  T('blocks the first time', first.block === true)
  T('advances the watermark past it', first.seen === 1)

  // State must be threaded exactly as the hook threads it — `nudged` is what stops the same
  // message being charged twice, once as unread mail and again as an unanswered question.
  const second = decide({ chat: c, tasks: '', me: 'Ada', seen: first.seen, taskBlocks: first.taskBlocks, nudged: first.nudged })
  T('does NOT block the second time on the same message', second.block === false)
  T('...not even via the unanswered-question branch', second.block === false && !second.reason)

  const c2 = c + '\n' + line('Sam', '@Ada and another thing')
  const third = decide({ chat: c2, tasks: '', me: 'Ada', seen: first.seen, taskBlocks: 0, nudged: first.nudged })
  T('a genuinely new message blocks again', third.block === true)
  T('and only quotes the new one', !third.reason.includes('please look'))
}

section('GUARD: a watermark from a different room does not replay history')
{
  // A rebuilt or switched room has fewer messages than our cursor. Treating the whole history as
  // unread would block on every message the room has ever had.
  const c = chat(line('Eve', '@Ada hello'))
  const d = decide({ chat: c, tasks: '', me: 'Ada', seen: 999, taskBlocks: 0 })
  T('a cursor past the end restarts rather than replaying', d.block === true && d.seen === 1)
}

section('GUARD: an open task cannot block forever')
{
  const tasks = ['# Hive Tasks — header', '',
    '- [accepted] abc123  Ganesh -> Ada: fix the rate limiter  (by Ganesh)'].join('\n')

  T('finds an accepted task addressed to me', openTasksFor(tasks, 'Ada').length === 1)
  T('ignores a task addressed to someone else', openTasksFor(tasks, 'Kai').length === 0)
  T('ignores a pending task',
    openTasksFor('- [pending] x  G -> Ada: later  (by G)', 'Ada').length === 0)

  let st = { seen: 0, taskBlocks: 0 }
  const blocks = []
  for (let i = 0; i < 5; i++) {
    const d = decide({ chat: chat(), tasks, me: 'Ada', ...st })
    blocks.push(d.block)
    st = { seen: d.seen, taskBlocks: d.taskBlocks }
  }
  T('an open task blocks the first three turns', blocks.slice(0, 3).every(Boolean))
  T('then stands down instead of trapping the agent', blocks[3] === false && blocks[4] === false)
  T('the reason tells it how to get out', decide({ chat: chat(), tasks, me: 'Ada', ...S0 }).reason.includes('hive_complete'))
}

section('the default is always to allow')
{
  T('no chat, no tasks: allow', run({ chat: '' }).block === false)
  T('empty room: allow', run({ chat: chat() }).block === false)
  T('a done task does not block', run({ chat: chat(), tasks: '- [done] x  G -> Ada: it  (by G)' }).block === false)
}

section('the system-prompt text')
{
  T('teaches the loop', /hive_wait/.test(INSTRUCTIONS) && /hive_complete/.test(INSTRUCTIONS))
  T('teaches @-addressing', /@Name/.test(INSTRUCTIONS))
  T('teaches claim-before-write', /hive_claim/.test(INSTRUCTIONS))
  T('says a refused write is not an error', /not an error/.test(INSTRUCTIONS))
  // This is re-sent on every turn of every agent forever, so its size is a recurring cost.
  // THE BUDGET MOVED ON PURPOSE, 19 Sep 2026: 2500 -> 2900, to pay for DESIGN BEFORE YOU WRITE.
  // That rule is ~400 chars re-sent every turn of every agent forever, and it is worth it: every
  // defect on this project has been a false success, and it is the only instruction that attacks
  // that class BEFORE the code exists rather than after. Raising a cap to make a change fit is
  // normally the defect -- so the rule it was raised for is pinned on the next line, and cannot
  // be quietly deleted to get back under.
  T('stays inside a sane system-prompt budget (<2900 chars)', INSTRUCTIONS.length < 2900,
    `${INSTRUCTIONS.length} chars`)
  T('teaches DESIGN BEFORE YOU WRITE — the rule the budget was raised for',
    /DESIGN BEFORE YOU WRITE -- MANDATORY/.test(INSTRUCTIONS) && /wrong but green/.test(INSTRUCTIONS))
  T('one-liner exists for small surfaces', ONE_LINER.length > 0 && ONE_LINER.length < 160)
}

console.log(`\n${pass} passed, ${fail} failed\n`)
assert.strictEqual(fail, 0)
