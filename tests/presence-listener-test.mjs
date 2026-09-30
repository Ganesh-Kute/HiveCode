// tests/presence-listener-test.mjs — Guard tests for Item 4:
// Presence: recognize hivecode-await listeners as WAITING, not PARKED.
//
// Shared contract with Claude's hivecode-await:
// 1. startSync with { listener: true } publishes user.listener = true in awareness.
// 2. stateOf merges connections by name.
// 3. If any connection under that name is a listener, state is WAITING, not PARKED.
// 4. line() shows "WAITING (listening via hivecode-await)" + last MCP action age.
// 5. When listener exits, presence drops and normal rules apply.

import assert from 'assert'
import * as ACT from '../hive-activity.js'

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

const now = 1_000_000_000
const MINUTE = 60 * 1000

console.log('# Item 4: Presence — recognize hivecode-await listeners')

{
  // A client connected with NO recent action is normally PARKED:
  const silentRec = { lastAction: now - 30 * MINUTE }
  T('unaccompanied silent agent is PARKED',
    ACT.stateOf(silentRec, { present: true, now }) === ACT.PARKED)

  // With listener: true, it MUST be WAITING:
  T('stateOf with listener: true is WAITING, not PARKED',
    ACT.stateOf(silentRec, { present: true, listener: true, now }) === ACT.WAITING)

  // With connections list containing listener:
  T('stateOf with connections containing listener is WAITING',
    ACT.stateOf(silentRec, {
      present: true,
      connections: [{ name: 'Agent', listener: false }, { name: 'Agent', listener: true }],
      now,
    }) === ACT.WAITING)

  // When awareness drops (process exits), it becomes GONE:
  T('when listener exits (present: false), state is GONE',
    ACT.stateOf(silentRec, { present: false, listener: true, now }) === ACT.GONE)

  // describe() includes listener flag and reachability:
  const d = ACT.describe(silentRec, { present: true, listener: true, now })
  T('describe() reports WAITING', d.state === ACT.WAITING)
  T('describe() reports listener: true', d.listener === true)
  T('describe() reports reachable: true', d.reachable === true)

  // line() renders "WAITING (listening via hivecode-await)" plus last action age:
  const l = ACT.line('Claude', silentRec, { present: true, listener: true, now })
  T('line() includes "WAITING (listening via hivecode-await)"',
    l.includes('WAITING (listening via hivecode-await)'))
  T('line() includes last action age ("last acted 30 min ago")',
    /last acted 30 min ago/i.test(l))
  T('line() says Reachable and NOT parked',
    l.includes('Reachable') && !l.includes('PARKED'))

  // A listener with NO past actions at all:
  const noActionRec = {}
  const lNoAction = ACT.line('NewAgent', noActionRec, { present: true, listener: true, now })
  T('line() with no past actions does NOT report PARKED',
    lNoAction.includes('WAITING (listening via hivecode-await)') && !lNoAction.includes('PARKED'))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
assert.strictEqual(fail, 0)
