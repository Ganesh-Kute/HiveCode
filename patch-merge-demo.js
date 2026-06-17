// Patch-apply-or-rework — the lock-free alternative to locking.
//
// Nobody stops. Two agents edit the same file in parallel. At WRITE time each
// re-checks the current code and either merges (if changes don't collide) or
// re-does its work on the fresh code (if they do). This is the model that
// scales where locking doesn't.

import { mergeEdit } from './core.js'

const base = ['function login(u, p) {', '  return check(u, p)', '}'].join('\n')

function attempt(label, mine, current, redo) {
  console.log(`\n[${label}] read base, produced my edit, now checking the board...`)
  const r = mergeEdit(base, mine, current)
  if (r.ok) {
    console.log(`[${label}] APPLIES cleanly → writing merged result:`)
    console.log(r.text.split('\n').map((l) => '   ' + l).join('\n'))
  } else {
    console.log(`[${label}] CONFLICT — my lines changed under me. Re-doing on the fresh code.`)
    const reworked = redo(current)
    console.log(`[${label}] re-worked result:`)
    console.log(reworked.split('\n').map((l) => '   ' + l).join('\n'))
  }
}

// Scenario 1: Agent A added a docstring at the TOP; meanwhile Agent B changed
// the RETURN line. Different lines → merges automatically, zero rework.
const aEdit = ['// logs the user in', 'function login(u, p) {', '  return check(u, p)', '}'].join('\n')
const bChangedItUnderA = ['function login(u, p) {', '  return verify(u, p)', '}'].join('\n')
attempt('AgentA', aEdit, bChangedItUnderA)

// Scenario 2: Both rewrote the SAME return line two different ways → conflict,
// so the second writer re-does its change on what's actually there now.
const aChangedReturn = ['function login(u, p) {', '  return check(u, p, opts)', '}'].join('\n')
const bAlsoChangedReturn = ['function login(u, p) {', '  return verify(u, p)', '}'].join('\n')
attempt('AgentA', aChangedReturn, bAlsoChangedReturn, (current) =>
  current.replace('return verify(u, p)', 'return verify(u, p, opts)')
)
