// Live lock + negotiation agent (runs over the real relay).
//
//   node agent-lock.js <relay> <room> <name> <file> "<intent>"
//
// Protocol:
//   1. LOCK the file before working (no wasted reasoning).
//   2. If it's held, REQUEST access and send a summary of what you'll do;
//      wait for the holder to finish and hand over.
//   3. While holding, HEARTBEAT the lock so it stays yours — but if you crash,
//      the lock's TTL lets it expire so the file never freezes forever.
//   4. Before releasing, acknowledge anyone waiting.
//
// Deadlock note: to take MULTIPLE files, always lock them in sorted order
// (see acquireAll) so two agents can't form a circular wait.

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', NAME = 'AI', FILE = 'fileA', INTENT = 'edit'] = process.argv
const TTL = 6000        // a lock dies if not renewed within 6s (crash safety)
const HEARTBEAT = 2000  // renew my lock every 2s while working
const SETTLE = 700      // wait for the relay to settle before confirming a claim
const WORK_MS = 2500    // pretend this is the agent's reasoning + edit time

const doc = new Y.Doc()
const text = doc.getText('file')
const locks = doc.getMap('locks')       // file -> { owner, intent, exp }
const requests = doc.getMap('requests') // file -> { [requesterName]: summary }
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
const ME = NAME
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'ai' })

const now = () => Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function heldByOther(file) {
  const l = locks.get(file)
  return l && l.owner !== ME && l.exp > now() ? l : null
}
function postRequest(file, summary) {
  const cur = requests.get(file) || {}
  if (cur[ME]) return
  requests.set(file, { ...cur, [ME]: summary })
}
function clearMyRequest(file) {
  const cur = requests.get(file)
  if (cur && cur[ME]) { const c = { ...cur }; delete c[ME]; requests.set(file, c) }
}

async function acquire(file, intent) {
  let requested = false
  while (true) {
    const other = heldByOther(file)
    if (other) {
      if (!requested) {
        console.log(`[${NAME}] "${file}" is LOCKED by ${other.owner} (doing: "${other.intent}").`)
        console.log(`[${NAME}] requesting access — my plan: "${intent}"`)
        postRequest(file, intent)
        requested = true
      }
      await sleep(500)
      continue
    }
    locks.set(file, { owner: ME, intent, exp: now() + TTL }) // claim with TTL
    await sleep(SETTLE)
    const l = locks.get(file)
    if (l && l.owner === ME) {
      clearMyRequest(file)
      if (requested) console.log(`[${NAME}] access GRANTED on "${file}".`)
      return
    }
    await sleep(300) // lost the race, try again
  }
}

let heartbeat
function startHeartbeat(file, intent) {
  heartbeat = setInterval(() => {
    const l = locks.get(file)
    if (l && l.owner === ME) locks.set(file, { owner: ME, intent, exp: now() + TTL })
  }, HEARTBEAT)
}
function release(file) {
  clearInterval(heartbeat)
  const l = locks.get(file)
  if (l && l.owner === ME) locks.delete(file)
}

async function main() {
  await new Promise((res) => provider.on('sync', (s) => s && res()))
  console.log(`[${NAME}] joined room "${ROOM}".`)

  await acquire(FILE, INTENT)
  console.log(`[${NAME}] LOCKED "${FILE}" — intent: "${INTENT}". Working...`)
  startHeartbeat(FILE, INTENT)
  provider.awareness.setLocalStateField('activity', `editing ${FILE}: ${INTENT}`)

  await sleep(WORK_MS)                       // reasoning + edit
  text.insert(text.length, `# [${NAME}] ${INTENT}\n`)

  const reqs = requests.get(FILE)           // be polite: acknowledge anyone waiting
  if (reqs) for (const [who, summary] of Object.entries(reqs)) {
    if (who !== ME) console.log(`[${NAME}] ${who} is waiting to: "${summary}". Handing over.`)
  }

  release(FILE)
  provider.awareness.setLocalStateField('activity', 'idle')
  console.log(`[${NAME}] done + released "${FILE}".`)
  await sleep(1500)                          // let the release propagate
  provider.destroy()
  process.exit(0)
}

main()
