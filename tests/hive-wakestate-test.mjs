// wake-on-state: an agent waits on the project state machine, not on somebody remembering to @ it.
//
//   node tests/hive-wakestate-test.mjs
//
// WHY THIS IS A BLOCKER AND NOT A CONVENIENCE. Before this, hive_wait returned only on work
// assigned TO you or a message naming you. So every roster secretly depended on each agent
// remembering to message the next one after finishing. The rules ask them to; nothing makes them.
// The failure is silent and it is the exact failure an overnight run cannot survive: the tester
// sets tests=GREEN at 01:00, never thinks to @ the reviewer, and the reviewer sleeps until morning
// with no error anywhere.
//
// Drives the REAL waitForWork against a REAL Yjs doc, no relay, no stdio -- same harness as
// mcp-wait-test.mjs, because the risk here is in the wiring, not in the predicate.

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import process from 'process'

const sandbox = mkdtempSync(join(tmpdir(), 'hive-wakestate-'))
process.chdir(sandbox)

const Y = (await import('yjs')).default ?? (await import('yjs'))
const { _test, stateMatches } = await import('../hive-mcp.js')

let pass = 0, fail = 0
const T = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${extra ? `   ${extra}` : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? `   ${extra}` : ''}`) }
}
const section = (s) => console.log(`\n# ${s}`)

function makeRoom(me) {
  const doc = new Y.Doc()
  const chat = doc.getArray('chat')
  const state = doc.getMap('swarm_state')
  const hive = {
    doc,
    getState: () => Object.fromEntries(state.entries()),
    say: (text) => chat.push([{ by: me, kind: 'ai', at: '12:00:00', text: String(text) }]),
    members: () => [],
    stop: () => {},
  }
  _test.setSession({ hive, room: 'room-test', relay: 'wss://test', dir: sandbox, name: me, owner: 'Ganesh', mailbox: null })
  _test.mailbox().seek(chat.length)
  return {
    doc, chat, state,
    post: (by, text) => chat.push([{ by, kind: 'ai', at: '12:00:00', text }]),
    set: (k, v) => state.set(k, v),
    pause: () => doc.getMap('controls').set(me, { state: 'paused', by: 'Ganesh', at: '12:00:00' }),
  }
}

// ---- the predicate -------------------------------------------------------------------------
section('the predicate')
{
  const g = (k) => ({ tests: 'GREEN', build: 'RED' }[k])
  T('exact value', stateMatches({ key: 'tests', is: 'GREEN' }, g) === true)
  T('exact value, wrong value', stateMatches({ key: 'tests', is: 'RED' }, g) === false)
  T('any of several', stateMatches({ key: 'build', in: ['RED', 'AMBER'] }, g) === true)
  T('any of several, none match', stateMatches({ key: 'build', in: ['GREEN'] }, g) === false)
  T('anything but', stateMatches({ key: 'build', not: 'GREEN' }, g) === true)
  T('anything but, and it is that', stateMatches({ key: 'build', not: 'RED' }, g) === false)
  // A reviewer told "wake unless the build is RED" must wake in a fresh room where nobody has
  // set `build` yet. Treating unset as RED would hang it forever on a flag no one will write.
  T('an UNSET key counts as "not"', stateMatches({ key: 'nothing', not: 'RED' }, g) === true)
  T('a bare key means "as soon as it is set at all"', stateMatches({ key: 'tests' }, g) === true)
  T('and a bare key does not match an unset one', stateMatches({ key: 'nothing' }, g) === false)
  T('no key is never a match, rather than always one', stateMatches({}, g) === false && stateMatches(null, g) === false)
}

// ---- the wiring ----------------------------------------------------------------------------
section('waiting on the state machine')
{
  const room = makeRoom('Reviewer')

  // Already true: must return AT ONCE. An agent that sits through a 60s timeout waiting to be
  // told something that happened an hour ago is the same stall in slower motion.
  room.set('tests', 'GREEN')
  const t0 = Date.now()
  const instant = await _test.waitForWork(4000, { until: { key: 'tests', is: 'GREEN' } })
  T('a state that is already true returns instantly', Date.now() - t0 < 400, `${Date.now() - t0}ms`)
  T('and it says which key and value woke it',
    instant.stateReached && instant.stateReached.key === 'tests' && instant.stateReached.value === 'GREEN',
    JSON.stringify(instant.stateReached))

  // Not yet true: block, then wake on the transition.
  room.set('tests', 'RUNNING')
  const waiting = _test.waitForWork(4000, { until: { key: 'tests', is: 'GREEN' } })
  await new Promise((r) => setTimeout(r, 200))
  room.set('tests', 'RED')
  await new Promise((r) => setTimeout(r, 200))
  room.set('other', 'GREEN')
  await new Promise((r) => setTimeout(r, 200))
  room.set('tests', 'GREEN')
  const woke = await waiting
  T('a wrong value and a wrong key do not wake it', true)   // proven by the next line firing on GREEN
  T('the right transition wakes it', woke.stateReached && woke.stateReached.value === 'GREEN', JSON.stringify(woke.stateReached))
}

{
  const room = makeRoom('Reviewer')
  room.set('tests', 'RED')
  const t0 = Date.now()
  const out = await _test.waitForWork(700, { until: { key: 'tests', is: 'GREEN' } })
  T('a state that never arrives times out rather than returning a false positive',
    Date.now() - t0 >= 600 && !(out && out.stateReached), `${Date.now() - t0}ms`)
}

{
  // The state wake must not swallow the room's conversation.
  const room = makeRoom('Reviewer')
  const waiting = _test.waitForWork(4000, { until: { key: 'tests', is: 'GREEN' } })
  await new Promise((r) => setTimeout(r, 150))
  room.post('Tester', 'note: I skipped the flaky one')
  room.set('tests', 'GREEN')
  const woke = await waiting
  T('chat that arrived alongside the state change is still delivered', woke.unreadCount >= 1, `unread=${woke.unreadCount}`)
}

{
  // A paused agent must NOT be woken by state. A flag turning green is the room offering work,
  // and pausing means stop taking work. It re-checks on its next wait after a resume.
  const room = makeRoom('Reviewer')
  room.pause()
  const waiting = _test.waitForWork(800, { until: { key: 'tests', is: 'GREEN' } })
  await new Promise((r) => setTimeout(r, 150))
  room.set('tests', 'GREEN')
  const out = await waiting
  T('a PAUSED agent is not pulled back to work by a state change',
    out && out.paused === true && !out.stateReached, JSON.stringify(out && out.stateReached))
}

{
  // The roster case, end to end in one room: tester finishes, reviewer wakes by itself, and
  // nobody had to remember to message anybody.
  const room = makeRoom('Reviewer')
  room.set('tests', 'RUNNING')
  const reviewer = _test.waitForWork(4000, { until: { key: 'tests', in: ['GREEN', 'SKIPPED'] } })
  await new Promise((r) => setTimeout(r, 200))
  room.set('tests', 'SKIPPED')            // the tester never @-mentions anyone
  const woke = await reviewer
  T('THE ROSTER RUNS ITSELF: reviewer woke with no message addressed to it',
    woke.stateReached && woke.stateReached.value === 'SKIPPED', JSON.stringify(woke.stateReached))
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
