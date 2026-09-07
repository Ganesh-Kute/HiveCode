// Mailbox tests — every case here is a failure that actually happened in the JARVIS
// four-agent build on 2026-07-28, not an invented edge case.
//
//   node tests/mailbox-test.mjs

import {
  createMailbox,
  mentionsName,
  mentionedNames,
  priorityOf,
  collapseRepeats,
  formatMessage,
  ambientDigest,
} from '../hive-mailbox.js'

let pass = 0, fail = 0
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}
const section = (s) => console.log(`\n# ${s}`)

const msg = (by, text, at = '12:00:00') => ({ by, kind: 'ai', at, text })

// ───────────────────────────────────────────────────────────────────────────────────────
section('mention matching')

T('plain mention matches', mentionsName('@Hermes can you look at db.js', 'Hermes'))
T('case-insensitive', mentionsName('@hermes ping', 'Hermes'))
T('mid-sentence', mentionsName('I think @Hermes owns that', 'Hermes'))
T('no mention is no mention', !mentionsName('Hermes owns that file', 'Hermes'))
// The boundary bug that would matter in this exact room: PM-Claude and Claude-Engine coexist,
// and B1 in the bug log was caused by name collisions.
T('@PM does NOT match PM-Claude', !mentionsName('@PM look at this', 'PM-Claude'))
T('@PM-Claude matches PM-Claude', mentionsName('@PM-Claude look at this', 'PM-Claude'))
T('@Hermes does NOT match Hermes-2', !mentionsName('@Hermes ping', 'Hermes-2'))
T('@Hermes-2 matches Hermes-2', mentionsName('@Hermes-2 ping', 'Hermes-2'))
T('@Hermes-2 does NOT match Hermes', !mentionsName('@Hermes-2 ping', 'Hermes'))
T('empty inputs are safe', !mentionsName('', 'Hermes') && !mentionsName('@Hermes', ''))
T('names with regex characters do not throw', !mentionsName('@a.b', 'a+b['))

T('every addressee is listed', JSON.stringify(mentionedNames('@Hermes and @PM-Claude, sync up')) === JSON.stringify(['Hermes', 'PM-Claude']))
T('duplicates collapse', mentionedNames('@Hermes @Hermes').length === 1)

// ───────────────────────────────────────────────────────────────────────────────────────
section('priority — "stop" must be distinguishable from chatter')

T('explicit [!] marker', priorityOf('[!] @Hermes stand down') === 'stop')
T('explicit [stop] marker', priorityOf('[stop] wrong file') === 'stop')
T('the word stop, without a marker', priorityOf('@Antigravity stop, you are on the wrong file') === 'stop')
T('halt', priorityOf('halt writes, the room is corrupting') === 'stop')
T("don't edit", priorityOf("@Hermes don't edit seed.js, I hold it") === 'stop')
T('dont edit, no apostrophe', priorityOf('@Hermes dont touch server/db.js') === 'stop')
T('revert', priorityOf('@Antigravity revert App.jsx, it lost the imports') === 'stop')
T('ordinary announcement is normal', priorityOf('taking auth.js: adding login') === 'normal')
T('a word containing stop is not stop', priorityOf('the stopwatch view is done') === 'normal')

// ───────────────────────────────────────────────────────────────────────────────────────
section('repeat collapsing — the conflict-notification storm')

// The real shape: Shell.jsx produced 56 identical conflict notices and 53 identical
// resolutions, alternating, within seconds.
const storm = []
for (let i = 0; i < 56; i++) {
  storm.push(msg('Antigravity', '⚠ MERGE CONFLICT in web/src/components/Shell.jsx — it has <<<<<<< markers.'))
}
const collapsed = collapseRepeats(storm)
T('56 identical lines collapse to 1', collapsed.length === 1)
T('the count is preserved, not discarded', collapsed[0].repeated === 56)
T('the rendering shows the count', formatMessage(collapsed[0]).includes('(×56)'))
T('a single message carries no count', !formatMessage(msg('Hermes', 'hi')).includes('×'))

const alternating = [
  msg('A', 'conflict'), msg('A', 'conflict'),
  msg('A', 'resolved'), msg('A', 'resolved'), msg('A', 'resolved'),
  msg('A', 'conflict'),
]
T('only CONSECUTIVE runs collapse', collapseRepeats(alternating).length === 3)
T('the same text from different authors does not merge', collapseRepeats([msg('A', 'x'), msg('B', 'x')]).length === 2)
T('empty input is safe', collapseRepeats([]).length === 0 && collapseRepeats(null).length === 0)

// ───────────────────────────────────────────────────────────────────────────────────────
section('THE BUG: the blind window between two waits')

// This is the whole reason the module exists. An agent takes its mail, goes and works for
// several minutes, and during that time three messages arrive. Under the old code the next
// wait re-captured baseChatLen at call time, so those three were below the cursor and were
// returned by nothing, ever.
{
  const chat = [msg('PM-Claude', 'kickoff')]
  const box = createMailbox({ me: 'Hermes', startAt: chat.length })

  T('a fresh mailbox does not replay history', box.take(chat).messages.length === 0)

  // ... agent works. Messages arrive meanwhile.
  chat.push(msg('PM-Claude', '@Hermes the schema changed'))
  chat.push(msg('Antigravity', 'frontend is up'))
  chat.push(msg('PM-Claude', '@Hermes did you see that'))

  const got = box.take(chat)
  T('EVERYTHING that arrived while working is delivered', got.unreadCount === 3)
  T('both direct mentions survive', got.mentions.length === 2)
  T('the mentioned flag is set', got.mentioned === true)
  T('a second take returns nothing — mail is not re-delivered', box.take(chat).unreadCount === 0)
  T('...and the flag resets with it', box.take(chat).mentioned === false)
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('an agent is never woken by its own messages')

{
  const chat = []
  const box = createMailbox({ me: 'Antigravity', startAt: 0 })
  chat.push(msg('Antigravity', 'taking Shell.jsx'))
  chat.push(msg('Antigravity', '⚠ MERGE CONFLICT in Shell.jsx'))
  const own = box.take(chat)
  T('own messages are not mail', own.unreadCount === 0)
  T('...but the cursor still moved past them', box.cursor === 2)

  chat.push(msg('PM-Claude', '@Antigravity what is happening'))
  T('a real message still arrives after self-authored noise', box.take(chat).mentioned === true)
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('peek does not consume — safe for a non-blocking check')

{
  const chat = [msg('PM-Claude', '@Hermes ping')]
  const box = createMailbox({ me: 'Hermes', startAt: 0 })
  T('peek reports the message', box.peek(chat).unreadCount === 1)
  T('peek again still reports it', box.peek(chat).unreadCount === 1)
  T('hasUnread agrees', box.hasUnread(chat) === true)
  T('take finally consumes it', box.take(chat).unreadCount === 1)
  T('and now it is empty', box.hasUnread(chat) === false)
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('priority survives delivery')

{
  const chat = []
  const box = createMailbox({ me: 'Antigravity', startAt: 0 })
  chat.push(msg('Hermes', 'deploying the api'))
  chat.push(msg('PM-Claude', '@Antigravity stop — App.jsx lost its imports'))
  const got = box.take(chat)
  T('the urgent mention raises priority to stop', got.priority === 'stop')
  T('ambient traffic is still delivered alongside it', got.unreadCount === 2)
}
{
  const chat = [msg('Hermes', '@Antigravity when you get a chance, check the api shape')]
  const box = createMailbox({ me: 'Antigravity', startAt: 0 })
  T('an ordinary mention is not urgent', box.take(chat).priority === 'normal')
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('resuming after the MCP host restarts the process')

// The host restarts the server at will; the old code lost its position entirely, so anything
// posted while it was down fell into the same unreachable gap.
{
  const chat = [msg('PM-Claude', 'a'), msg('PM-Claude', 'b')]
  const first = createMailbox({ me: 'Hermes', startAt: 0 })
  first.take(chat)
  const saved = first.cursor
  T('the cursor is a plain number, so it can be persisted', typeof saved === 'number' && saved === 2)

  chat.push(msg('PM-Claude', '@Hermes posted while you were down'))
  const resumed = createMailbox({ me: 'Hermes', startAt: saved })
  const got = resumed.take(chat)
  T('a resumed mailbox delivers what arrived during the outage', got.unreadCount === 1)
  T('...and does not replay what was already read', got.messages[0].text.includes('while you were down'))
}

// A room that was rebuilt from scratch (which the bug log says is the only recovery from a
// poisoned document) leaves a stale cursor pointing past the end of a shorter chat.
{
  const box = createMailbox({ me: 'Hermes', startAt: 500 })
  const chat = [msg('PM-Claude', '@Hermes fresh room')]
  const got = box.take(chat)
  T('a cursor past the end recovers instead of going silent forever', got.unreadCount === 1)
}


section('ambient digest -- what actually caps room size')
// Un-addressed chatter used to be handed to every agent in full on every wake: O(N^2) context
// in a room of N agents, so TOKEN COST became the ceiling on room size rather than the relay.
{
  const many = Array.from({ length: 15 }, (_, i) => msg('A' + i, 'taking file' + i + '.js'))
  const d = ambientDigest(many)
  const lines = d.split(String.fromCharCode(10))
  T('the TRUE count is reported, never the trimmed one', d.includes('room activity (15'))
  T('only the newest few bodies are included', lines.filter((l) => l.includes('taking file')).length === 4)
  T('the newest message is one of them', d.includes('taking file14.js'))
  T('the oldest is not', !d.includes('taking file0.js'))
  T('the agent is told how many were withheld', d.includes('11 earlier message(s) withheld'))
  T('...and how to read them, so nothing is hidden', d.includes('hive_read_chat'))
  T('15 messages cost 6 lines, so a big room stays cheap', lines.length === 6)
}
{
  const d = ambientDigest([msg('A', 'one'), msg('B', 'two')])
  T('a small room is untouched -- no withheld notice', !d.includes('withheld'))
  T('...and no misleading "newest N shown"', !d.includes('newest'))
  T('both bodies survive', d.includes('one') && d.includes('two'))
}
T('nothing to say returns empty, so a caller can drop it', ambientDigest([]) === '')
T('a non-array is safe', ambientDigest(null) === '' && ambientDigest(undefined) === '')
T('keep:0 still reports the count rather than going silent',
  ambientDigest([msg('A', 'x'), msg('B', 'y')], { keep: 0 }).includes('room activity (2'))
T('keep can be raised when a caller wants more',
  ambientDigest(Array.from({ length: 6 }, (_, i) => msg('A' + i, 'm' + i)), { keep: 10 })
    .split(String.fromCharCode(10)).filter((l) => l.includes('(ai)')).length === 6)

console.log(`\n=== MAILBOX: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
