// AI agent as a first-class participant.
//
//   node agent.js <relay-url> <room> [name]
//
// This is the standardizable idea: an AI agent is NOT special. It joins the
// same room as humans, over the same protocol, and edits the same shared
// document. The team sees it in the roster and watches its edits live.
//
// Here the "thinking" is a stub (it appends a line). Swap the makeEdit()
// body for a real Claude/LLM call and you have a live teammate that humans
// can watch — and interrupt — in real time.

import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const [, , RELAY = 'ws://localhost:1234', ROOM = 'default', NAME = 'AI-agent'] = process.argv

const doc = new Y.Doc()
const ytext = doc.getText('file')
const provider = new WebsocketProvider(RELAY, ROOM, doc, { WebSocketPolyfill: WebSocket })

// The agent announces itself the same way a human does — but kind: 'ai'.
// This single field is the heart of the proposed standard: it lets the UI
// show "an AI is editing here" and lets humans grant/revoke its scope.
provider.awareness.setLocalStateField('user', { name: NAME, kind: 'ai' })

async function makeEdit() {
  // Show intent first (presence), so humans see it coming before it lands.
  provider.awareness.setLocalStateField('activity', 'editing end of file')
  const line = `# ${NAME}: reviewed code at this point\n`
  ytext.insert(ytext.length, line)
  console.log(`[${NAME}] inserted a line. Doc length now ${ytext.length}.`)
  provider.awareness.setLocalStateField('activity', 'idle')
}

provider.on('sync', (isSynced) => {
  if (!isSynced) return
  console.log(`[${NAME}] joined room "${ROOM}" as an AI participant.`)
  setTimeout(makeEdit, 1000)
})
