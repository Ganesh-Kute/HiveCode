// Live adversarial probe of the DEPLOYED relay's provenance enforcement.
// Uses a throwaway file room (_probe.js) so it never touches the agents' app.js.
// Seeds a valid signed head+receipt, then injects (a) a FORGED receipt and (b) a
// REGRESSING head, and reports what the relay does — which reveals its mode:
//   strict -> forged receipt REMOVED, regressing head REVERTED
//   audit  -> both left in place (logged only)
//   off    -> both left, no guard at all
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'
import { genIdentity, authorChange, verifyReceipt, headOk, contentHash } from './substrate.js'

const relay = 'wss://livecode-xoss.onrender.com'
const FSEP = String.fromCharCode(1)
const room = 'room-0758W50NsPQdqmNERg' + FSEP + '_probe.js'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const doc = new Y.Doc()
const p = new WebsocketProvider(relay, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
await new Promise((r) => { let d = 0; const f = () => { if (!d) { d = 1; r() } }; p.on('sync', (s) => s && f()); setTimeout(f, 9000) })

const content = doc.getText('content'), ledger = doc.getArray('ledger'), head = doc.getMap('head')
const id = genIdentity('Prober')

// 1. seed a valid signed head + receipt
const g = authorChange({ identity: id, filename: '_probe.js', base: '', text: 'function probe() { return 1 }\n', intent: 'seed', at: Date.now() })
const gr = { ...g.prov, name: 'Prober' }
doc.transact(() => {
  if (content.length) content.delete(0, content.length)
  content.insert(0, g.text)
  ledger.push([gr])
  head.set('cur', { text: g.text, hash: g.prov.contentHash, at: g.prov.at, by: 'Prober', receipt: gr })
})
await sleep(3500)
console.log('seeded: ledger=' + ledger.length + ' head.valid=' + headOk(head.get('cur')).ok)

// 2. inject a FORGED receipt (valid receipt with a mutated field -> signature breaks)
const g2 = authorChange({ identity: id, filename: '_probe.js', base: g.text, text: 'function probe() { return 2 }\n', intent: 'legit', at: Date.now() })
const forged = { ...g2.prov, intent: 'FORGED-AFTER-SIGNING', name: 'Prober' }
console.log('forged verifies locally? ' + verifyReceipt(forged).ok + ' (should be false)')
ledger.push([forged])
await sleep(5000)
const forgedStillThere = ledger.toArray().some((r) => r.intent === 'FORGED-AFTER-SIGNING')
console.log('AFTER inject -> forged receipt still in ledger? ' + forgedStillThere)

// 3. inject a REGRESSING head: a genuinely-signed receipt over code that does NOT parse
const brokenText = 'function probe( {'
const br = authorChange({ identity: id, filename: '_probe.js', base: '', text: brokenText, intent: 'regress', at: Date.now() })
const brh = { ...br.prov, name: 'Prober' }
console.log('regressing head well-signed? ' + headOk({ text: brokenText, hash: contentHash(brokenText), receipt: brh }).ok + ' (true; only non-regression should stop it)')
head.set('cur', { text: brokenText, hash: br.prov.contentHash, at: br.prov.at, by: 'Prober', receipt: brh })
await sleep(5000)
const curHead = head.get('cur')
const headReverted = curHead && curHead.hash !== contentHash(brokenText)
console.log('AFTER inject -> head reverted away from broken? ' + headReverted + ' (head.by=' + (curHead && curHead.by) + ')')

// verdict
const mode = (!forgedStillThere && headReverted) ? 'strict (ENFORCING: removes forged + reverts regressing)'
  : (forgedStillThere && !headReverted) ? 'audit or OFF (NOT enforcing — forged + regressing both survived)'
  : 'mixed/unclear'
console.log('\n>>> DEPLOYED RELAY ENFORCEMENT: ' + mode)
p.destroy(); process.exit(0)
