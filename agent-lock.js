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
import { lockHeldByOther, lockOrder, negotiate } from './core.js'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', NAME = 'AI', FILE = 'fileA', INTENT = 'edit'] = process.argv
const TTL = 6000        // a lock dies if not renewed within 6s (crash safety)
const HEARTBEAT = 2000  // renew my lock every 2s while working
const SETTLE = 700      // wait for the relay to settle before confirming a claim
const WORK_MS = 2500    // pretend this is the agent's reasoning + edit time

const doc = new Y.Doc()
const text = doc.getText('file')
const locks = doc.getMap('locks')         // file -> { owner, intent, exp }
const requests = doc.getMap('requests')   // file -> { [requesterName]: summary }
const responses = doc.getMap('responses') // "file:requester" -> { from, decision, reason }
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })
const ME = NAME
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'ai' })

const now = () => Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const heldByOther = (file) => lockHeldByOther(locks, file, ME, now())
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
    // If the current holder denied my request, stop waiting and back off.
    const resp = responses.get(`${file}:${ME}`)
    if (resp && resp.decision === 'deny') {
      console.log(`[${NAME}] my request for "${file}" was DENIED: ${resp.reason}. Backing off.`)
      return 'denied'
    }
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
      return 'acquired'
    }
    await sleep(300) // lost the race, try again
  }
}

// Take SEVERAL files for one task without risk of deadlock: always acquire in
// the same sorted order, so two agents can never each hold what the other needs.
async function acquireAll(filesList, intent) {
  for (const f of lockOrder(filesList)) await acquire(f, intent)
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

  const status = await acquire(FILE, INTENT)
  if (status === 'denied') { provider.destroy(); process.exit(0) }
  console.log(`[${NAME}] LOCKED "${FILE}" — intent: "${INTENT}". Working...`)
  startHeartbeat(FILE, INTENT)
  provider.awareness.setLocalStateField('activity', `editing ${FILE}: ${INTENT}`)

  // While I hold the lock, answer any request with grant / counter / deny.
  let working = true
  const answer = () => {
    if (!working) return
    const reqs = requests.get(FILE) || {}
    for (const [who, summary] of Object.entries(reqs)) {
      if (who === ME || responses.get(`${FILE}:${who}`)) continue
      const r = negotiate({ intent: INTENT, done: false }, { from: who, summary })
      console.log(`[${NAME}] ${who} asks ("${summary}") → ${r.decision.toUpperCase()}: ${r.reason}`)
      responses.set(`${FILE}:${who}`, { from: ME, decision: r.decision, reason: r.reason })
    }
  }
  requests.observe(answer)
  answer()

  await sleep(WORK_MS)                       // reasoning + edit
  text.insert(text.length, `# [${NAME}] ${INTENT}\n`)
  working = false

  release(FILE)
  provider.awareness.setLocalStateField('activity', 'idle')
  console.log(`[${NAME}] done + released "${FILE}".`)
  await sleep(1500)                          // let the release propagate
  provider.destroy()
  process.exit(0)
}

main()
