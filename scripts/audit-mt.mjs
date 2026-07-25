// Raw audit of the multi-file test rooms in room-clean-run-9 (prod relay).
import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import { WebSocket } from 'ws'
import { verifyReceipt } from './substrate.js'
const FSEP = String.fromCharCode(1)
const RELAY = 'wss://livecode-xoss.onrender.com', ROOM = 'room-clean-run-9'
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : ['src/app.js', 'lib/util.js', 'src/api/users.js']
const opens = (t) => (t.match(/^<<<<<<< /gm) || []).length
for (const f of FILES) {
  const doc = new Y.Doc()
  const pr = new WebsocketProvider(RELAY, ROOM + FSEP + f, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
  await new Promise((r) => { let d = 0; const fin = () => { if (!d) { d = 1; r() } }; pr.on('sync', (s) => s && setTimeout(fin, 1500)); setTimeout(fin, 12000) })
  const content = doc.getText('content').toString()
  const ledger = doc.getArray('ledger').toArray()
  const ok = ledger.filter((r) => verifyReceipt(r).ok)
  console.log(`${f}: ${content.length} chars, markers=${opens(content)}, ledger=${ledger.length} (verified=${ok.length}) authors=[${[...new Set(ok.map((r) => r.name))].join(',')}]`)
  const key = (s) => { const m = content.match(new RegExp(s + '.*')); return m ? m[0] : '(line missing)' }
  console.log(`   ${key('function \\w+Main')} | ${key('function \\w+Shared')}`)
  try { pr.destroy() } catch {}
  doc.destroy()
}
process.exit(0)
