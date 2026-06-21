// Your idea: a LOCK + NEGOTIATION system for AI agents.
//
//   - An agent LOCKS a file before working on it (so its reasoning is never
//     wasted by an after-the-fact rejection).
//   - If another agent wants that file, it's told "locked by Agent X" and can
//     REQUEST access, sending a SUMMARY of what it intends to do.
//   - The holder sees the request + summary, finishes, and HANDS OVER.
//   - Both agents always know what the other is doing.
//
// This is "pessimistic concurrency" with a human-style negotiation layer.

import * as Y from 'yjs'

const A = new Y.Doc()
const B = new Y.Doc()
const sync = () => {
  Y.applyUpdate(B, Y.encodeStateAsUpdate(A))
  Y.applyUpdate(A, Y.encodeStateAsUpdate(B))
}

const locks = (d) => d.getMap('locks')       // file -> { owner, intent }
const requests = (d) => d.getMap('requests') // file -> { from, summary }
const file = (d) => d.getText('fileA')

file(A).insert(0, 'def login(user, pw):\n    return check(user, pw)\n')
sync()

// Try to lock a file. If someone else holds it, report who + their intent.
function lock(doc, name, owner, intent) {
  const cur = locks(doc).get(name)
  if (cur && cur.owner !== owner) return { ok: false, heldBy: cur.owner, theirIntent: cur.intent }
  locks(doc).set(name, { owner, intent })
  return { ok: true }
}
const release = (doc, name) => locks(doc).delete(name)

// 1. Agent A locks the file BEFORE working (no wasted reasoning).
lock(A, 'fileA', 'AgentA', 'add input validation to login()')
console.log('[AgentA] LOCKED fileA  — intent: "add input validation to login()"')
console.log('[AgentA] ...reasoning and editing...')
sync()

// 2. Agent B wants the same file.
let r = lock(B, 'fileA', 'AgentB', 'rename login() to signIn()')
if (!r.ok) {
  console.log(`[AgentB] fileA is LOCKED by ${r.heldBy} (currently: "${r.theirIntent}").`)
  console.log('[AgentB] Sending an access request with my plan: "rename login() to signIn()"')
  requests(B).set('fileA', { from: 'AgentB', summary: 'rename login() to signIn()' })
}
sync()

// 3. Agent A sees the request + summary, finishes, hands over.
const req = requests(A).get('fileA')
if (req) {
  console.log(`\n[AgentA] got a request from ${req.from}, who wants to: "${req.summary}"`)
  console.log('[AgentA] OK — finishing my change, then releasing the lock for them.')
  file(A).insert(file(A).length, '    # input validation added by AgentA\n')
  release(A, 'fileA')
  requests(A).delete('fileA')
  console.log('[AgentA] done + lock released. AgentB may proceed.\n')
}
sync()

// 4. Agent B now gets the lock, announces intent, edits the FRESH code.
r = lock(B, 'fileA', 'AgentB', 'rename login() to signIn()')
if (r.ok) {
  console.log('[AgentB] LOCK GRANTED. Announcing: "rename login() to signIn()" and editing.')
  file(B).insert(file(B).length, '    # renamed login -> signIn by AgentB\n')
  release(B, 'fileA')
  console.log('[AgentB] done + lock released.')
}
sync()

console.log('\n--- final fileA (both edits applied in order, nobody clobbered) ---')
console.log(file(A).toString())
console.log('locks still held:', [...locks(A).keys()])
console.log('identical on both agents?', file(A).toString() === file(B).toString())
