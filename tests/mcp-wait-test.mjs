// Integration test for hive_wait / hive_check delivery.
//
// The unit tests in mailbox-test.mjs cover the delivery RULES. This drives the REAL
// waitForWork and the REAL tool dispatcher against a REAL Yjs document, with no relay and no
// stdio, because the bug was never in the rules — it was in the wiring: a cursor captured at
// call time, and two return paths that threw the mail away.
//
//   node tests/mcp-wait-test.mjs

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import process from 'process'

// The session file is resolved from cwd at import time, so move somewhere disposable BEFORE
// importing the server — otherwise the test writes a cursor file into the repo.
const sandbox = mkdtempSync(join(tmpdir(), 'hive-wait-'))
process.chdir(sandbox)

const Y = (await import('yjs')).default ?? (await import('yjs'))
const { _test } = await import('../hive-mcp.js')

let pass = 0, fail = 0
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`) }
}
const section = (s) => console.log(`\n# ${s}`)

/** A session standing in for a joined room: a real doc, no network. */
function makeRoom(me) {
  const doc = new Y.Doc()
  const chat = doc.getArray('chat')
  const hive = {
    doc,
    getState: () => ({}),
    say: (text) => chat.push([{ by: me, kind: 'ai', at: '12:00:00', text: String(text) }]),
    members: () => [],
    stop: () => {},
  }
  const session = { hive, room: 'room-test', relay: 'wss://test', dir: sandbox, name: me, owner: 'Ganesh', mailbox: null }
  _test.setSession(session)
  // Mirrors joinRoom: the mailbox starts at the current end of history, so a joiner is not
  // handed the whole backlog.
  _test.mailbox().seek(chat.length)
  return { doc, chat, session, post: (by, text) => chat.push([{ by, kind: 'ai', at: '12:00:00', text }]) }
}

const textOf = (res) => res.content.map((c) => c.text).join('\n')

// ───────────────────────────────────────────────────────────────────────────────────────
section('THE REGRESSION: mail sent while the agent was working')

{
  const room = makeRoom('Hermes')
  room.post('PM-Claude', 'kickoff, everyone read the contracts')

  // The agent takes its mail and goes to work.
  await _test.waitForWork(20)

  // While it works — NOT inside a wait — three things arrive.
  room.post('PM-Claude', '@Hermes the schema changed, re-read contracts/schema.sql')
  room.post('Antigravity', 'frontend routes are up')
  room.post('PM-Claude', '@Hermes did you see that')

  // The old code re-captured baseChatLen here, so all three were below the cursor and
  // returned by nothing, ever. This must return them immediately.
  const r = await _test.waitForWork(20)
  T('returns immediately rather than blocking on an empty window', r !== null)
  T('every message that arrived while working is delivered', r.unreadCount === 3)
  T('both direct mentions are separated out', r.mentions.length === 2)
  T('the mentioned flag is set on the ACTIVE path, not just when paused', r.mentioned === true)
  T('nothing is re-delivered on the next call', (await _test.waitForWork(200)) === null)
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('queued work no longer hides the mail')

{
  const room = makeRoom('Hermes')
  const tasks = room.doc.getMap('tasks')
  tasks.set('t1', { id: 't1', to: 'Hermes', by: 'PM-Claude', status: 'accepted', text: 'write the routes' })
  room.post('PM-Claude', '@Hermes also: the api contract changed')

  const r = await _test.waitForWork(20)
  T('the queued task is returned', r.tasks.length === 1)
  // This is the exact line that used to read `newChat: []`.
  T('AND the message is returned with it', r.unreadCount === 1)
  T('the mention is flagged', r.mentioned === true)
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('a task waking the agent does not discard chat')

{
  // Waking on a TASK used to return `newChat: []`, so an agent woken by an assignment lost
  // whatever had been said. To exercise that path specifically the chat has to be ambient and
  // the wait mention-only, otherwise the unread mail returns first and the task never wakes it.
  const room = makeRoom('Hermes')
  const tasks = room.doc.getMap('tasks')
  const waiting = _test.waitForWork(3000, { wakeOn: 'mention' })
  room.post('Antigravity', 'api shape changed, fyi')
  tasks.set('t9', { id: 't9', to: 'Hermes', by: 'PM-Claude', status: 'accepted', text: 'do the thing' })
  const r = await waiting
  T('the task wakes the agent', r.tasks.some((t) => t.id === 't9'))
  T('the message that preceded it is not thrown away', r.unreadCount === 1)
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('an agent is not woken by its own messages')

{
  const room = makeRoom('Antigravity')
  const waiting = _test.waitForWork(400)
  room.session.hive.say('taking Shell.jsx')
  room.session.hive.say('⚠ MERGE CONFLICT in Shell.jsx')
  const r = await waiting
  T('self-authored noise does not wake the agent', r === null)

  // ...and a real call still gets through afterwards.
  const waiting2 = _test.waitForWork(3000)
  room.post('PM-Claude', '@Antigravity stop, App.jsx lost its imports')
  const r2 = await waiting2
  T('a real message still wakes it', r2 && r2.mentioned === true)
  T('and it is marked urgent', r2.priority === 'stop')
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('wakeOn: mention — usable in a room full of notification noise')

{
  const room = makeRoom('Hermes')
  const started = Date.now()
  const waiting = _test.waitForWork(600, { wakeOn: 'mention' })
  for (let i = 0; i < 20; i++) room.post('Antigravity', '⚠ MERGE CONFLICT in Shell.jsx — it has <<<<<<< markers.')
  const r = await waiting
  T('20 lines of ambient noise do not wake it early', Date.now() - started >= 550)
  T('but the noise is still delivered when the window closes — never dropped', r !== null && r.unreadCount === 20)
  T('and 20 identical lines arrive as ONE entry with a count', r.messages.length === 1 && r.messages[0].repeated === 20)
  T('none of it is mistaken for direct address', r.mentioned === false)

  const waiting2 = _test.waitForWork(3000, { wakeOn: 'mention' })
  room.post('PM-Claude', '@Hermes are you alive')
  const r2 = await waiting2
  T('a mention wakes it immediately', r2.mentioned === true)
  T('and the noise is not repeated now it has been read', r2.unreadCount === 1)
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('a message never expires unread because the wait timed out')

{
  const room = makeRoom('Hermes')
  const waiting = _test.waitForWork(250, { wakeOn: 'mention' })
  room.post('Antigravity', 'api shape changed')  // ambient: will not wake a mention-only wait
  const r = await waiting
  T('the timeout flushes what arrived instead of dropping it', r !== null && r.unreadCount === 1)
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('hive_check — the non-blocking call an agent can make mid-task')

{
  const room = makeRoom('Hermes')
  let out = textOf(await _test.callTool('hive_check'))
  T('reports all clear when nothing is waiting', out.includes('nothing waiting'))

  const addressed = (s) => /addressed to YOU/i.test(s) && s.includes('check the api shape')

  room.post('PM-Claude', '@Hermes when you get a chance, check the api shape')
  out = textOf(await _test.callTool('hive_check', { peek: true }))
  T('peek surfaces the message', addressed(out))
  T('peek does NOT consume it', addressed(textOf(await _test.callTool('hive_check', { peek: true }))))

  out = textOf(await _test.callTool('hive_check'))
  T('a real check consumes it', addressed(out))
  T('and it is gone afterwards', textOf(await _test.callTool('hive_check')).includes('nothing waiting'))

  room.post('PM-Claude', '@Hermes STOP — you are writing to a file I hold')
  out = textOf(await _test.callTool('hive_check'))
  T('an urgent call is escalated, not listed as ordinary mail', out.includes('🛑') && /STOP/.test(out))
  T('...and it says to deal with it first', /FIRST/i.test(out))
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('hive_read_chat — backlog recovery')

{
  const room = makeRoom('PM-Claude')
  room.post('Hermes', '@PM-Claude routes are done')
  room.post('Antigravity', 'unrelated chatter')
  room.post('Claude-Engine', '@PM-Claude engine tests pass')

  let out = textOf(await _test.callTool('hive_read_chat', { mentioningMe: true }))
  T('finds every message addressed to me across the whole history', out.includes('routes are done') && out.includes('engine tests pass'))
  T('and excludes what was not addressed to me', !out.includes('unrelated chatter'))

  out = textOf(await _test.callTool('hive_read_chat', { unreadOnly: true }))
  T('unreadOnly reports the backlog', out.includes('3 unread'))
  T('unreadOnly does not consume it', textOf(await _test.callTool('hive_read_chat', { unreadOnly: true })).includes('3 unread'))
}

// ───────────────────────────────────────────────────────────────────────────────────────
section('hive_say urgency')

{
  const room = makeRoom('PM-Claude')
  await _test.callTool('hive_say', { text: '@Hermes wrong file', urgent: true })
  const last = room.chat.toArray().pop()
  T('urgent prefixes the marker into the message itself', last.text.startsWith('[!]'))
  T('so a human reading HIVE_CHAT.md sees it too', last.text.includes('@Hermes wrong file'))

  await _test.callTool('hive_say', { text: 'taking auth.js' })
  T('an ordinary message is unchanged', room.chat.toArray().pop().text === 'taking auth.js')
}

console.log(`\n=== MCP WAIT: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
