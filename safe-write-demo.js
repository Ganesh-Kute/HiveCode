// The stale-read problem and its fix (optimistic concurrency control).
//
// Scenario (exactly the one described):
//   - SLOW agent reads function foo, then reasons for a long time.
//   - FAST agent changes foo THREE times while SLOW is still thinking.
//   - SLOW finally wants to write — based on code that no longer exists.
//
// The fix: every region carries a VERSION. A write is allowed ONLY IF the
// version still matches what the writer read. If it moved, the writer's work
// is stale -> it must re-read and re-reason. This is how git "rebase" and
// database compare-and-swap work. The CRDT alone does NOT do this.

import * as Y from 'yjs'

// Two machines (two agents) that exchange updates when they "talk".
const slow = new Y.Doc()
const fast = new Y.Doc()
const sync = () => {
  Y.applyUpdate(fast, Y.encodeStateAsUpdate(slow))
  Y.applyUpdate(slow, Y.encodeStateAsUpdate(fast))
}

// initial code + a version counter per region (here: the function "foo")
slow.getText('file').insert(0, 'def foo(): return 1\n')
slow.getMap('versions').set('foo', 0)
sync()

// --- SLOW agent reads foo, remembers the version it saw ---
const seenVersion = slow.getMap('versions').get('foo')
console.log(`[slow] read foo at version ${seenVersion} -> begins long reasoning (4s of thinking)...`)

// --- meanwhile FAST agent edits foo three times, bumping the version each time ---
for (let i = 1; i <= 3; i++) {
  const v = fast.getMap('versions').get('foo')
  fast.getText('file').insert(fast.getText('file').length, `# fast change ${i}\n`)
  fast.getMap('versions').set('foo', v + 1)
  console.log(`[fast] committed change ${i} -> foo is now version ${v + 1}`)
}
sync() // those changes now reach the slow agent

// --- the safe write: only commit if the version is what we based our work on ---
function safeCommit(doc, region, expected, apply) {
  const current = doc.getMap('versions').get(region)
  if (current !== expected) return { stale: true, current } // someone moved it
  apply()
  doc.getMap('versions').set(region, current + 1)
  return { ok: true, version: current + 1 }
  // NOTE: in the live system this whole check-write-bump runs while HOLDING a
  // lease (agent-lease.js), so two agents can't pass the check at the same time.
}

console.log('[slow] ...done reasoning. Attempting to commit my fix.')
let res = safeCommit(slow, 'foo', seenVersion, () =>
  slow.getText('file').insert(slow.getText('file').length, '# slow fix based on OLD code (would be WRONG)\n')
)

if (res.stale) {
  console.log(`[slow] ABORTED: I reasoned on version ${seenVersion}, but foo is now version ${res.current}.`)
  console.log('[slow] My fix is stale. Re-reading current code and re-reasoning before writing...')
  const fresh = slow.getMap('versions').get('foo')
  res = safeCommit(slow, 'foo', fresh, () =>
    slow.getText('file').insert(slow.getText('file').length, `# slow fix based on FRESH code v${fresh} (correct)\n`)
  )
  console.log(`[slow] committed safely at version ${res.version}.`)
}

sync()
console.log('\n--- final file (both agents agree, nothing clobbered) ---')
console.log(slow.getText('file').toString())
console.log('foo final version:', slow.getMap('versions').get('foo'))
console.log('identical on both machines?', slow.getText('file').toString() === fast.getText('file').toString())
