// ONE PRESENCE SWEEP FOR THE WHOLE RELAY (27 Sep 2026). y-protocols gives every Awareness its own
// 3-second interval, so the relay ran one timer per open document: at idle, 20 ms of CPU per second
// with 4,000 open files vs 7.4 ms/s after (same machine, back to back), on a free Render instance that
// has 0.1 CPU in total. vendor/y-websocket/utils.cjs now clears each document's timer and runs one
// sweep. Pinned: the sweep still does the timer's job -- a remote presence not renewed for 30 s is
// dropped, a fresh one is kept -- and a document no longer owns a timer.
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { WSSharedDoc, sweepPresence } = require('../vendor/y-websocket/utils.cjs')
const awarenessProtocol = require('y-protocols/awareness')
const Y = require('yjs')

let pass = 0, fail = 0
const T = (name, ok) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`) }

console.log('\n=== RELAY PRESENCE SWEEP ===')
T('the relay exports its one sweep', typeof sweepPresence === 'function')
const doc = new WSSharedDoc('sweep-test\u0001src/a.js')
const remoteDoc = new Y.Doc()
const remote = new awarenessProtocol.Awareness(remoteDoc)
remote.setLocalState({ user: { name: 'Bo', kind: 'ai' } })
awarenessProtocol.applyAwarenessUpdate(doc.awareness, awarenessProtocol.encodeAwarenessUpdate(remote, [remote.clientID]), 'test')
T('a remote presence reaches the relay document', doc.awareness.states.has(remote.clientID))
sweepPresence(Date.now())
T('a fresh presence survives the sweep', doc.awareness.states.has(remote.clientID))
sweepPresence(Date.now() + awarenessProtocol.outdatedTimeout + 1000)
T('a presence not renewed for 30s is dropped by the relay-wide sweep, as the per-doc timer did', !doc.awareness.states.has(remote.clientID))
const own = doc.awareness._checkInterval
T('the document owns no running timer of its own', !!own && own._destroyed === true)

try { remote.destroy(); remoteDoc.destroy(); doc.destroy() } catch { }
console.log(`\n=== RELAY PRESENCE SWEEP: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
