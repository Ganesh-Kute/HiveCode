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
  // Asserts the MEANING, not the wording. The all-clear line legitimately changed once
  // hive_check began reporting reply debts: the message really is consumed, but someone is
  // still waiting on an answer to it, and reporting "nothing waiting" then would be a lie.
  const after = textOf(await _test.callTool('hive_check'))
  T('and it is gone afterwards', !addressed(after) && /no new mail|nothing waiting/.test(after))
  T('...but it still says who is waiting on a reply', /STILL WAITING ON A REPLY/.test(after) && /PM-Claude|Hermes/.test(after))

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

section('hive_read_chat keeps other people\'s long messages short (27 Sep 2026)')
{
  const { post } = makeRoom('Ada')
  const essay = 'x'.repeat(1000)
  post('Bo', `status report ${essay}`)
  post('Bo', `@Ada here is your review ${essay}`)
  post('Cy', 'build is red'); post('Cy', 'build is red'); post('Cy', 'build is red')
  const read = async (a) => ((await _test.callTool('hive_read_chat', a)).content || []).map((c) => c.text).join('\n')
  const out = await read({})
  T('someone else\'s long message is cut, and says how much was cut', /status report x{200,280} …\(\+\d+ chars; full:true shows it\)/.test(out))
  T('a message addressed to me stays whole', out.includes(`@Ada here is your review ${essay}`))
  T('identical consecutive lines collapse to one with a count', (out.match(/build is red/g) || []).length === 1 && /\(×3\)/.test(out))
  const full = await read({ full: true })
  T('full:true returns every message whole', full.includes(`status report ${essay}`))
}

section('hive_wait default by app (27 Sep 2026)')
{
  await _test.initialize({ protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.0' } })
  T('Claude Code waits 110s by default: under its two-minute move-to-background line', _test.waitDefaultSeconds() === 110)
  await _test.initialize({ protocolVersion: '2025-06-18', clientInfo: { name: 'cursor', version: '1.0' } })
  T('an app whose limit is unverified keeps 60s', _test.waitDefaultSeconds() === 60)
  await _test.initialize({ protocolVersion: '2025-06-18', clientInfo: { name: 'Antigravity', version: '1.0' } })
  T('Antigravity waits 110s by default (measured: 110s runs to the end there)', _test.waitPolicy().def === 110)
  T('...and never asks it for more than 170s: its tool deadline is a hard 180s', _test.waitPolicy().max === 170)
  await _test.initialize({ protocolVersion: '2025-06-18' })
  T('no clientInfo at all keeps 60s', _test.waitDefaultSeconds() === 60)
  T('...and the 300s ceiling', _test.waitPolicy().max === 300)
}

section('the line that keeps a Claude Code agent reachable after its turn (2 Oct 2026)')
{
  const fsm = await import('fs')
  // An app nobody has measured is not told to run something that may never wake it: a listener
  // that cannot wake its agent is a false "listening".
  await _test.initialize({ protocolVersion: '2025-06-18', clientInfo: { name: 'cursor', version: '1.0' } })
  makeRoom('Ada')
  const cu = textOf(await _test.callTool('hive_wait', { timeoutSeconds: 1 }))
  T('an app nobody has measured (Cursor) is not told to start a listener', !/hive-await\.js/.test(cu))
  // Antigravity DOES wake when a background command ends. Measured 2 Oct 2026: Antigravity1's turn at
  // 06:48:09Z began from its listener exiting, two seconds after a message to it, with nobody typing.
  // It sat PARKED in the KCDE run only because this line was never given to it.
  await _test.initialize({ protocolVersion: '2025-06-18', clientInfo: { name: 'Antigravity', version: '1.0' } })
  makeRoom('Ada')
  const ag = textOf(await _test.callTool('hive_wait', { timeoutSeconds: 1 }))
  const am = /"([^"]+)" "([^"]+hive-await\.js)" "([^"]+)" "Ada" 25/.exec(ag)
  T('Antigravity\'s first empty wait orders it to start the listener, in its own tool\'s words', !!am && /BEFORE YOU END THIS TURN/.test(ag) && /run_command/.test(ag) && /WaitMsBeforeAsync/.test(ag) && !/run_in_background/.test(ag), ag.slice(0, 600))
  T('...naming this room and this agent', !!am && am[3] === 'wss://test|room-test')
  T('...said once: the next empty wait does not repeat it', !/hive-await\.js/.test(textOf(await _test.callTool('hive_wait', { timeoutSeconds: 1 }))))
  _test.forget('listen') // a new process, as a second app would be
  await _test.initialize({ protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.0' } })
  makeRoom('Ada')
  const first = textOf(await _test.callTool('hive_wait', { timeoutSeconds: 1 }))
  const m = /"([^"]+)" "([^"]+hive-await\.js)" "([^"]+)" "Ada" 25/.exec(first)
  T('Claude Code\'s first empty wait orders it to start the listener in the background', !!m && /BEFORE YOU END THIS TURN/.test(first) && /run_in_background/.test(first))
  T('...naming this room and this agent, every argument quoted', !!m && m[3] === 'wss://test|room-test')
  T('...with a node and a hive-await.js that exist on this disk', !!m && fsm.existsSync(m[1]) && fsm.existsSync(m[2]))
  T('...and the paths use forward slashes, which bash and PowerShell both accept', !!m && !m[1].includes('\\') && !m[2].includes('\\'))
  const second = textOf(await _test.callTool('hive_wait', { timeoutSeconds: 1 }))
  T('...said once: the next empty wait does not repeat it', !/hive-await\.js/.test(second))
  console.log(`  (the line costs about ${Math.round((first.length - second.length) / 4)} tokens, once per session)`)
}

console.log(`\n=== MCP WAIT: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
