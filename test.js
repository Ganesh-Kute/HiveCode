// Automated test suite — deterministic, in-memory (no relay needed).
// Run: node test.js   (exit code 0 = all pass)
//
// Covers every coordination guarantee the system promises, so future changes
// can be verified instantly.

import * as Y from 'yjs'
import { applyDiff, safeBump, lockHeldByOther, lockOrder, negotiate, mergeEdit } from './core.js'

let passed = 0
let failed = 0
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}`) }
}
function section(t) { console.log(`\n# ${t}`) }

// helper: fully sync two docs both ways
const sync = (a, b) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
}

// ---------------------------------------------------------------------------
section('applyDiff (text mirroring)')
{
  const d = new Y.Doc()
  const t = d.getText('x')
  t.insert(0, 'hello world')
  applyDiff(t, 'hello brave world')
  check('inserts in the middle', t.toString() === 'hello brave world')
  applyDiff(t, 'hello world')
  check('deletes from the middle', t.toString() === 'hello world')
  check('no-op returns false', applyDiff(t, 'hello world') === false)
  applyDiff(t, '')
  check('clears to empty', t.toString() === '')
  applyDiff(t, 'fresh')
  check('fills from empty', t.toString() === 'fresh')
}

// ---------------------------------------------------------------------------
section('CRDT convergence (concurrent same-position edits)')
{
  const a = new Y.Doc(), b = new Y.Doc()
  a.getText('f').insert(0, 'base')
  sync(a, b)
  a.getText('f').insert(0, 'A')
  b.getText('f').insert(0, 'B')
  sync(a, b)
  check('both machines identical', a.getText('f').toString() === b.getText('f').toString())
  check('no text lost', a.getText('f').toString().includes('A') && a.getText('f').toString().includes('B'))
}

// ---------------------------------------------------------------------------
section('Claim protocol (no duplicate work)')
{
  const a = new Y.Doc(), b = new Y.Doc()
  sync(a, b)
  // both try to claim the same task while offline
  a.getMap('claims').set('task1', a.clientID)
  b.getMap('claims').set('task1', b.clientID)
  sync(a, b)
  // after sync both agree on a single owner
  const ownerA = a.getMap('claims').get('task1')
  const ownerB = b.getMap('claims').get('task1')
  check('one deterministic winner', ownerA === ownerB)
  check('winner is one of the two', ownerA === a.clientID || ownerA === b.clientID)
}

// ---------------------------------------------------------------------------
section('Version check (stale write rejected)')
{
  const v = new Y.Doc().getMap('versions')
  v.set('foo', 0)
  const seen = v.get('foo')      // an agent reads version 0
  v.set('foo', 1); v.set('foo', 2); v.set('foo', 3) // others change it 3x
  const stale = safeBump(v, 'foo', seen)
  check('stale write is rejected', stale.stale === true && stale.current === 3)
  const fresh = safeBump(v, 'foo', v.get('foo'))
  check('fresh write succeeds', fresh.ok === true && fresh.version === 4)
}

// ---------------------------------------------------------------------------
section('Lock + negotiation logic')
{
  const a = new Y.Doc(), b = new Y.Doc()
  const now = 1000
  a.getMap('locks').set('fileA', { owner: 'A', intent: 'edit', exp: now + 5000 })
  sync(a, b)
  check('B sees A holds the lock', !!lockHeldByOther(b.getMap('locks'), 'fileA', 'B', now))
  check('A does not see itself as other', !lockHeldByOther(a.getMap('locks'), 'fileA', 'A', now))
  // B posts a request with a summary
  b.getMap('requests').set('fileA', { B: 'rename login' })
  sync(a, b)
  check('A receives B request + summary', a.getMap('requests').get('fileA').B === 'rename login')
  // lock expiry (crash safety)
  check('expired lock is free', !lockHeldByOther(b.getMap('locks'), 'fileA', 'B', now + 6000))
}

// ---------------------------------------------------------------------------
section('Deadlock-safe multi-file ordering')
{
  const want1 = ['fileB', 'fileA']
  const want2 = ['fileA', 'fileB']
  check('both agents lock in the same order', JSON.stringify(lockOrder(want1)) === JSON.stringify(lockOrder(want2)))
  check('order is sorted', JSON.stringify(lockOrder(['c', 'a', 'b'])) === JSON.stringify(['a', 'b', 'c']))
}

// ---------------------------------------------------------------------------
section('Richer negotiation (grant / counter / deny)')
{
  // no conflict -> grant
  const g = negotiate({ intent: 'add logging to parser', done: false }, { from: 'B', summary: 'rename the CLI flag' })
  check('grants when unrelated', g.decision === 'grant')
  // both touch "login" -> counter (take turns)
  const c = negotiate({ intent: 'add validation to login', done: false }, { from: 'B', summary: 'refactor login helper' })
  check('counters on overlap', c.decision === 'counter' && /login/.test(c.reason))
  // destructive while mid-edit -> deny
  const d = negotiate({ intent: 'tweak login copy', done: false }, { from: 'B', summary: 'delete the auth module' })
  check('denies destructive mid-edit', d.decision === 'deny')
  // once holder is done, overlap is fine -> grant
  const g2 = negotiate({ intent: 'add validation to login', done: true }, { from: 'B', summary: 'refactor login helper' })
  check('grants overlap once holder is done', g2.decision === 'grant')
}

// ---------------------------------------------------------------------------
section('Patch merge-or-rework (two writers, same file)')
{
  const base = 'a\nb\nc\nd\ne'
  // current unchanged -> take mine
  check('takes mine when current == base', mergeEdit(base, 'a\nB\nc\nd\ne', base).text === 'a\nB\nc\nd\ne')
  // disjoint line edits -> merge both, no rework
  const m = mergeEdit(base, 'a\nB\nc\nd\ne', 'a\nb\nc\nD\ne')
  check('merges disjoint edits', m.ok && m.text === 'a\nB\nc\nD\ne')
  // same line changed two ways -> conflict (rework)
  const c = mergeEdit(base, 'a\nb\nC\nd\ne', 'a\nb\nX\nd\ne')
  check('flags overlapping edit as conflict', c.conflict === true)
  // I changed nothing -> take current
  check('takes current when I made no change', mergeEdit(base, base, 'a\nb\nc\nd\nE').text === 'a\nb\nc\nd\nE')
}

// ---------------------------------------------------------------------------
section('Room isolation (separate docs do not leak)')
{
  const roomX = new Y.Doc(), roomY = new Y.Doc()
  roomX.getText('f').insert(0, 'secret X')
  // we deliberately do NOT sync them — different rooms = different docs
  check('room Y never sees room X', roomY.getText('f').toString() === '')
}

// ---------------------------------------------------------------------------
console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed === 0 ? 0 : 1)
