// Coordinated AI agent — solves the "two AIs do the same work" problem.
//
//   node agent-coord.js <relay-url> <room> <name>
//
// The fix is a CLAIM PROTOCOL, carried in a shared ledger that is itself a
// CRDT (a Y.Map). The rule every agent follows:
//
//   1. Look at the task list.
//   2. Find a task nobody has claimed and nobody has finished.
//   3. Claim it (write my id into claims[task]).
//   4. Wait a beat for sync, then RE-READ the claim.
//        - If I still own it -> it's mine, do the work.
//        - If someone else owns it -> I lost the race, pick another task.
//   5. Mark it done so no one repeats it.
//
// Why this is safe: when two agents claim the same task at the same instant,
// the Y.Map resolves to ONE winner deterministically on every machine. There
// is no central lock server and no corruption — the data structure arbitrates.

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', NAME = 'AI'] = process.argv

// The shared work, known to every agent (in a real system this list itself
// lives in the doc; fixed here to keep the demo readable).
const TASKS = ['add-logging', 'fix-imports', 'write-test', 'add-docstring']

const doc = new Y.Doc()
const ytext = doc.getText('file')     // the code everyone edits
const claims = doc.getMap('claims')   // task -> owner clientID
const done = doc.getMap('done')       // task -> true

const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
const ME = doc.clientID
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'ai' })

const pending = new Set()  // tasks I've claimed but not yet confirmed

// Fair load-balancing: each agent starts scanning from a different offset
// derived from its name, so two agents prefer opposite ends of the list and
// the work splits evenly instead of one agent grabbing everything.
const OFFSET = [...NAME].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % TASKS.length
const MY_ORDER = TASKS.map((_, i) => TASKS[(i + OFFSET) % TASKS.length])

function doWork(task) {
  // The actual edit. In a real agent this is a Claude/LLM call.
  ytext.insert(ytext.length, `# [${NAME}] completed: ${task}\n`)
  done.set(task, true)
  console.log(`[${NAME}] DID "${task}"`)
}

function tick() {
  if (TASKS.every((t) => done.get(t))) {
    console.log(`[${NAME}] all tasks done — nothing left to do.`)
    clearInterval(timer)
    return
  }
  for (const task of MY_ORDER) {
    if (done.get(task)) continue
    const owner = claims.get(task)

    if (owner === undefined && !pending.has(task)) {
      // step 3: claim it, then verify after sync settles.
      claims.set(task, ME)
      pending.add(task)
      setTimeout(() => {
        pending.delete(task)
        if (done.get(task)) return
        if (claims.get(task) === ME) {
          doWork(task)                 // I won the claim
        } else {
          console.log(`[${NAME}] yielded "${task}" (owned by another agent)`)
        }
      }, 700)
      return // one claim attempt per tick — keep it calm and observable
    }

    if (owner === ME && !done.get(task) && !pending.has(task)) {
      doWork(task)
      return
    }
  }
}

let timer
provider.on('sync', (s) => {
  if (!s) return
  console.log(`[${NAME}] joined room "${ROOM}" — coordinating on ${TASKS.length} tasks.`)
  timer = setInterval(tick, 500)
})
