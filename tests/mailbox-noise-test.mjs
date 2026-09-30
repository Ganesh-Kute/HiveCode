// tests/mailbox-noise-test.mjs — Guard tests for Item 5:
// Noise reduction, mention stripping, acknowledgements, and urgent directives.
//
// Every case here was seen in live multi-agent sessions:
// 1. A human saying "thanks" or "ok" triggering an endless reply debt.
// 2. Mentioning @mentions or quoting "@Name" in prose waking unintended agents.
// 3. Typo catches (@Antigravty1) vs prose (@mentions).
// 4. "NOT IN THIS ROOM" repeated 3-line paragraph on every message.
// 5. Routine status reports containing "stop" or "revert" labeled as URGENT MAIL.

import assert from 'assert'
import {
  mentionsName,
  mentionsAll,
  mentionedNames,
  unansweredFor,
  priorityOf,
  isAcknowledgement,
  levenshtein,
  findClosestKnown,
  isDirectAddress,
} from '../hive-mailbox.js'

const isAck = isAcknowledgement

let pass = 0, fail = 0
const T = (name, cond) => {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}`)
  }
}
const section = (s) => console.log(`\n# ${s}`)

const m = (by, text, at = '19:00:00', kind = 'ai') => ({ by, kind, at, text })

// ───────────────────────────────────────────────────────────────────────────────────────
section('5.1 Acknowledgements & Reply Debts')

T('isAcknowledgement is exported and detects bare thanks',
  typeof isAcknowledgement === 'function' && isAck('thanks') && isAck('@Ada thank you!'))

T('isAcknowledgement recognizes short whitelist',
  isAck('ok') &&
  isAck('okay') &&
  isAck('got it') &&
  isAck('lgtm') &&
  isAck('looks good') &&
  isAck('sounds good') &&
  isAck('great') &&
  isAck('nice') &&
  isAck('cool') &&
  isAck('perfect') &&
  isAck('noted') &&
  isAck('ack') &&
  isAck('thx') &&
  isAck('ty'))

T('isAcknowledgement allows optional bro / all / team',
  isAck('@Claude thanks bro') &&
  isAck('@Antigravity1 thank you team') &&
  isAck('looks good all') &&
  isAck('ok bro') &&
  isAck('team noted') &&
  isAck('bro thanks'))

T('isAcknowledgement strips emoji and punctuation',
  isAck('@Claude 👍 thanks!!') &&
  isAck('🎉 looks good, team.') &&
  isAck('ok...'))

T('isAcknowledgement rejects messages with instructions or extra prose',
  !isAck('ok, go ahead') &&
  !isAck('thanks, can you also check X?') &&
  !isAck('thanks for fixing that bug in auth') &&
  !isAck('deploy to staging and run the smoke tests'))

T('human acknowledgement does NOT open a reply debt',
  unansweredFor([
    m('Antigravity1', '@Ganesh finished step 1, ready for review'),
    m('Ganesh', '@Antigravity1 thanks bro', '19:01:00', 'human'),
  ], 'Antigravity1').length === 0)

T('human "ok" does NOT open a reply debt',
  unansweredFor([
    m('Antigravity1', '@Ganesh updated PR'),
    m('Ganesh', '@Antigravity1 ok', '19:01:00', 'human'),
  ], 'Antigravity1').length === 0)

T('human "👍 lgtm team" does NOT open a reply debt',
  unansweredFor([
    m('Antigravity1', '@Ganesh ready'),
    m('Ganesh', '@Antigravity1 👍 lgtm team', '19:01:00', 'human'),
  ], 'Antigravity1').length === 0)

T('human instruction STILL opens a reply debt',
  unansweredFor([
    m('Antigravity1', '@Ganesh finished step 1, ready for review'),
    m('Ganesh', '@Antigravity1 ok, go ahead with step 2', '19:01:00', 'human'),
  ], 'Antigravity1').length === 1)

T('human "thanks, can you also check X" STILL opens a reply debt',
  unansweredFor([
    m('Antigravity1', '@Ganesh fixed the typo'),
    m('Ganesh', '@Antigravity1 thanks, can you also check the login test?', '19:01:00', 'human'),
  ], 'Antigravity1').length === 1)

// ───────────────────────────────────────────────────────────────────────────────────────
section('5.5 Addressee isolation — debts belong only to the recipient')

T('Ganesh asking Maritime-1 does NOT open a debt for Claude',
  unansweredFor([
    m('Ganesh', '@Maritime-1: r u there', '19:01:00', 'human'),
  ], 'Claude').length === 0)

T('Ganesh asking Maritime-1 does NOT open a debt for Antigravity1',
  unansweredFor([
    m('Ganesh', '@Maritime-1: r u there', '19:01:00', 'human'),
  ], 'Antigravity1').length === 0)

T('Eve asking Bo does NOT open a debt for Ada',
  unansweredFor([
    m('Eve', '@Bo can you review PR #4?', '19:01:00', 'ai'),
  ], 'Ada').length === 0)

// ───────────────────────────────────────────────────────────────────────────────────────
section('5.2 Code Spans and Quotes Stripping for Mentions')

T('mentions inside inline code spans are ignored',
  !mentionsName('see `@Ada` in documentation', 'Ada') &&
  !mentionedNames('check `const x = @Ada;`').includes('Ada'))

T('mentions inside fenced code blocks are ignored',
  !mentionsName('here is the code:\n```\n@Claude.doSomething()\n```', 'Claude') &&
  !mentionedNames('here is the code:\n```\n@Claude.doSomething()\n```').includes('Claude'))

T('quoted @names are ignored in mentionsName',
  !mentionsName('my post was addressed to "@Name", "@Name-2" and the whole room', 'Name') &&
  !mentionsName('my post was addressed to "@Name", "@Name-2" and the whole room', 'Name-2'))

T('quoted @all does NOT broadcast',
  !mentionsAll('my post had "@all" inside quotes') &&
  !mentionsName('my post had "@all" inside quotes', 'Ada'))

T('quoted mentions are not returned by mentionedNames',
  !mentionedNames('he said "@Hermes will fix it"').includes('Hermes') &&
  !mentionedNames("she said '@Bo will take it'").includes('Bo') &&
  !mentionedNames('they said “@Kai is away”').includes('Kai'))

// ───────────────────────────────────────────────────────────────────────────────────────
section('5.4 Urgent Directive Tightening in priorityOf')

T('explicit directives are urgent: stop',
  priorityOf('stop') === 'stop' &&
  priorityOf('@Claude stop now') === 'stop' &&
  priorityOf('@Claude stop') === 'stop' &&
  priorityOf('@Bo please stop touching server.js') === 'stop')

T('explicit directives are urgent: don\'t edit/touch/write',
  priorityOf("don't edit sync.js") === 'stop' &&
  priorityOf("@Hermes don't touch server/db.js") === 'stop' &&
  priorityOf("dont write to main.js") === 'stop')

T('explicit directives are urgent: revert that/this now',
  priorityOf('revert that now') === 'stop' &&
  priorityOf('@Antigravity revert this now') === 'stop' &&
  priorityOf('revert that now, it broke CI') === 'stop')

T('explicit markers are urgent',
  priorityOf('[!] check this') === 'stop' &&
  priorityOf('[stop] halt') === 'stop')

T('routine report mentioning c56214b is NOT urgent',
  priorityOf('@Claude Item 3 (Stale Attestations & Divergence Soundness) is landed cleanly and committed on ag1-prod (commit c56214b).') === 'normal')

T('routine mentions of stop in prose are NOT urgent',
  priorityOf('reached safe stopping point for tonight') === 'normal' &&
  priorityOf('we can stop here') === 'normal' &&
  priorityOf('@Bo before we stop, let me run the suite') === 'normal')

T('routine mentions of revert in prose are NOT urgent',
  priorityOf('revert PR #12 was merged') === 'normal' &&
  priorityOf('commit c56214b: revert earlier broken test') === 'normal' &&
  priorityOf('@Claude I will revert that change tomorrow if needed') === 'normal')

// ───────────────────────────────────────────────────────────────────────────────────────
section('5.2 Typo Catch vs Prose (@mentions) & 5.3 Terse Not-in-Room Warning')

T('levenshtein distance is accurate',
  typeof levenshtein === 'function' &&
  levenshtein('antigravity1', 'antigravty1') === 1 &&
  levenshtein('claude', 'claud') === 1 &&
  levenshtein('claude', 'claudee') === 1 &&
  levenshtein('same', 'same') === 0 &&
  levenshtein('mentions', 'claude') > 2)

T('findClosestKnown detects typos within distance 2',
  typeof findClosestKnown === 'function' &&
  findClosestKnown('Antigravty1', ['Antigravity1', 'Claude'])?.name === 'Antigravity1' &&
  findClosestKnown('Claud', ['Antigravity1', 'Claude'])?.name === 'Claude')

T('findClosestKnown ignores words with distance > 2',
  typeof findClosestKnown === 'function' &&
  findClosestKnown('mentions', ['Antigravity1', 'Claude']) === null &&
  findClosestKnown('gmail', ['Antigravity1', 'Claude']) === null)

T('isDirectAddress identifies mention at start of message',
  typeof isDirectAddress === 'function' &&
  isDirectAddress('@Stranger hello there', 'Stranger') &&
  isDirectAddress('   @Stranger: can you help?', 'Stranger') &&
  !isDirectAddress('we discussed @mentions in docs', 'mentions'))

console.log(`\n${pass} passed, ${fail} failed\n`)
assert.strictEqual(fail, 0)
