// live provenance audit of app.js in the running room
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { verifyReceipt, headOk, contentHash } from '../substrate.js'

const relay = 'wss://livecode-xoss.onrender.com'
const room = 'room-0758W50NsPQdqmNERgapp.js'
const doc = new Y.Doc()
const p = new WebsocketProvider(relay, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
await new Promise((r) => { let d = 0; const f = () => { if (!d) { d = 1; r() } }; p.on('sync', (s) => s && f()); setTimeout(f, 9000) })

const content = doc.getText('content').toString()
const ledger = doc.getArray('ledger').toArray()
const head = doc.getMap('head').get('cur')
const ch = contentHash(content)

console.log('=== app.js live audit ===')
console.log('content (' + content.length + ' bytes), hash ' + ch.slice(0, 12))
console.log('--- content ---\n' + content + '\n---------------')
console.log('ledger: ' + ledger.length + ' receipt(s)')
for (const [i, r] of ledger.entries()) {
  const v = verifyReceipt(r)
  console.log(`  #${i} ${v.ok ? 'VERIFIED' : 'BAD:' + v.reason}  by=${r.name || '?'} (${String(r.author).slice(0, 10)}…)  intent="${r.intent}"  attests=${String(r.contentHash).slice(0, 10)}`)
}
console.log('head: ' + (head ? `by=${head.by} hash=${String(head.hash).slice(0, 10)} valid=${headOk(head).ok}` : '(none)'))
console.log('head == current content? ' + (head ? (head.hash === ch) : 'n/a'))
console.log('current content covered by a VERIFIED receipt? ' + ledger.some((r) => r.contentHash === ch && verifyReceipt(r).ok))
console.log('distinct verified authors: ' + [...new Set(ledger.filter((r) => verifyReceipt(r).ok).map((r) => r.name || r.author))].join(', '))
p.destroy(); process.exit(0)
