// OFFLINE dissection of the snapshot path — no websockets, just Y.Docs.
// Mirrors exactly what the relay does: server doc built from client updates,
// flush = encodeStateAsUpdate(server), restart = fresh doc + applyUpdate(snapshot),
// then an incremental client update arrives. Where does it park?
import * as Y from 'yjs'

const sv = (d) => JSON.stringify([...Y.decodeStateVector(Y.encodeStateVector(d)).entries()])

// live phase: client -> server
const docC = new Y.Doc()
const docS1 = new Y.Doc()
docC.on('update', (u) => Y.applyUpdate(docS1, u))
const arr = docC.getArray('ledger'); const txt = docC.getText('content')
arr.push([{ n: 1 }]); arr.push([{ n: 2 }]); txt.insert(0, 'hello ')
console.log('client SV      :', sv(docC))
console.log('server1 SV     :', sv(docS1), 'array', JSON.stringify(docS1.getArray('ledger').toArray().map((x) => x.n)))

// flush + restart
const snapshot = Y.encodeStateAsUpdate(docS1)
const docS2 = new Y.Doc()
Y.applyUpdate(docS2, snapshot)
console.log('server2 SV     :', sv(docS2), 'array', JSON.stringify(docS2.getArray('ledger').toArray().map((x) => x.n)))

// post-restart incremental: capture the exact update the provider would send
let inc = null
docC.on('update', (u) => { inc = u })
arr.push([{ n: 3 }]); txt.insert(0, 'again ')
// (two transactions -> two updates; collect both)
const incs = []
const docC2 = new Y.Doc() // replay trick: gather all missing-from-S2 as one diff, like syncStep2 would
const diff = Y.encodeStateAsUpdate(docC, Y.encodeStateVector(docS2))
Y.applyUpdate(docS2, diff)
console.log('after diff     :', sv(docS2), 'array', JSON.stringify(docS2.getArray('ledger').toArray().map((x) => x.n)), 'text', JSON.stringify(docS2.getText('content').toString()))
console.log('pendingStructs :', docS2.store.pendingStructs ? 'YES — updates parked' : 'none')
