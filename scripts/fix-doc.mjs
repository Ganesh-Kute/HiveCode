// Surgical doc reset: connect a raw client to ONE file-room and replace its content
// with clean canonical text in a single transaction. Authoritative convergence fix.
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const [room, file, contentFile] = process.argv.slice(2)
const relay = 'wss://livecode-xoss.onrender.com'
const FSEP = String.fromCharCode(1)
const clean = (await import('fs')).readFileSync(contentFile, 'utf8')

const doc = new Y.Doc()
const p = new WebsocketProvider(relay, room + FSEP + file, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
await new Promise((r) => { let d = 0; const f = () => { if (!d) { d = 1; r() } }; p.on('sync', (s) => s && f()); setTimeout(f, 10000) })
const t = doc.getText('content')
console.log('before: ' + t.length + ' chars')
doc.transact(() => { if (t.length) t.delete(0, t.length); t.insert(0, clean) })
await new Promise((r) => setTimeout(r, 3000))
console.log('after: ' + doc.getText('content').length + ' chars')
p.destroy(); process.exit(0)
