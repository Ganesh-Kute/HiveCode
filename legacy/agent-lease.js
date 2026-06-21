// Region leasing — for when two agents MUST edit the same region (e.g. the
// same function) and cannot simply pick different tasks.
//
//   node agent-lease.js <relay-url> <room> <name> <region>
//
// The claim protocol said "claim a task." Leasing goes further: it grants
// TEMPORARY EXCLUSIVE access to a region, with a time limit, so agents take
// turns instead of stepping on each other.
//
//   1. Broadcast intent ("I want region X") so humans + agents see it coming.
//   2. Try to acquire a lease on X: free only if no unexpired lease exists.
//   3. Win -> edit, then RELEASE so the next agent can go.
//      Lose -> wait, then retry once the current lease expires.
//
// The time limit (TTL) is the safety net: if an agent crashes mid-edit, its
// lease expires on its own and the region frees up. No deadlock, no boss.

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', NAME = 'AI', REGION = 'main'] = process.argv
const TTL = 3000 // a lease is valid for 3s, then auto-expires

const doc = new Y.Doc()
const ytext = doc.getText('file')
const leases = doc.getMap('leases') // region -> { owner, exp }

const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
const ME = doc.clientID
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'ai' })

let didMyWork = false

function leaseHeldByOther() {
  const l = leases.get(REGION)
  return l && l.owner !== ME && l.exp > Date.now()
}

function tryAcquireAndEdit() {
  if (didMyWork) return

  // step 1: broadcast intent (visible in the live roster / cursors).
  provider.awareness.setLocalStateField('intent', `wants region "${REGION}"`)

  if (leaseHeldByOther()) {
    const l = leases.get(REGION)
    console.log(`[${NAME}] region "${REGION}" busy (held by client ${l.owner}); waiting...`)
    return // try again next tick, once it expires
  }

  // step 2: take the lease, then verify after sync settles.
  leases.set(REGION, { owner: ME, exp: Date.now() + TTL })
  setTimeout(() => {
    const l = leases.get(REGION)
    if (!l || l.owner !== ME) {
      console.log(`[${NAME}] lost the lease race for "${REGION}", will retry.`)
      return
    }
    // step 3: I hold the lease — edit exclusively.
    provider.awareness.setLocalStateField('activity', `editing region "${REGION}"`)
    ytext.insert(ytext.length, `# [${NAME}] edited inside ${REGION}()\n`)
    console.log(`[${NAME}] acquired "${REGION}", made my edit, releasing.`)
    didMyWork = true
    // release so the next agent can proceed immediately (don't wait for TTL).
    leases.delete(REGION)
    provider.awareness.setLocalStateField('intent', null)
    provider.awareness.setLocalStateField('activity', 'idle')
    clearInterval(timer)
  }, 600)
}

let timer
provider.on('sync', (s) => {
  if (!s) return
  console.log(`[${NAME}] joined room "${ROOM}", contending for region "${REGION}".`)
  timer = setInterval(tryAcquireAndEdit, 700)
})
