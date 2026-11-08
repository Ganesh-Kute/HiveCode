// A HELD WRITE MUST BE VISIBLE -- to the writer, to whoever holds the claim, and to the room.
//
//   node tests/held-write-visible-test.mjs
//
// MEASURED 26 Oct 2026 (antigravity-2, then server.js:388-465 read): with HIVE_ENFORCE_CLAIMS=queue,
// the hosted relay's mode, a write to a file someone else has claimed is held in relay memory and
// replayed on release. Nobody was told: the writer's own status said "synced", the holder and the
// room saw nothing, and only the relay's audit log knew. That day an agent wrote for fifteen
// minutes into files another agent had claimed, and the first sign was the wrong name on a commit.
// Two more holes in the same code:
//   - a claim that EXPIRES (its ttl runs out) changed no map, so nothing flushed: held forever;
//   - a writer that left while held lost the held edits from the room, without a word.
//
//   H1  the first held write says so in the room: the writer (@-named, so it wakes), the file,
//       and who holds it (@-named, so the holder knows someone is waiting)
//   H2  one notice per hold, not one per keystroke
//   H3  when the claim is released the edit lands, and the room is told it landed
//   H4  a claim that EXPIRES releases the hold by itself: the edit lands with nobody releasing
//   H5  a writer that leaves while held: the room is told those edits were NOT applied
//   H6  a write nobody blocks says nothing (no false alarm)

import { spawn } from 'child_process'
import path from 'path'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { WebSocket } from 'ws'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const { sign, fileRoom } = await import(`file:///${ROOT.replace(/\\/g, '/')}/token.js`)

const PORT = 1281
const SECRET = 'held-visible-secret'
const BASE = 'heldproj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let pass = 0
let fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

let jti = 0
const mint = (name, over = {}) => sign({
  iss: 'test', sub: name, name, kind: 'ai',
  scopes: [{ room: BASE, role: 'agent', paths: ['**'] }],
  iat: now(), exp: now() + 3600, jti: 'j' + (++jti), ...over,
}, { secret: SECRET })

const open = []
function connect(room, token) {
  const doc = new Y.Doc()
  // disableBc: every update goes through the relay, as a real client's does.
  const provider = new WebsocketProvider(`ws://localhost:${PORT}`, room, doc, { WebSocketPolyfill: WebSocket, disableBc: true, params: { token } })
  open.push(provider)
  return { doc, provider }
}

const relay = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HIVE_AUTH_MODE: 'required', HIVE_JWT_SECRET: SECRET, HIVE_ENFORCE_CLAIMS: 'queue', HIVE_PERSIST_DIR: '' },
})
relay.stderr.on('data', (d) => { if (process.env.HIVE_TEST_DEBUG) process.stderr.write(d) })
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('relay did not start')), 20000)
  relay.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); res() } })
})

const relayLines = (doc) => doc.getArray('chat').toArray().filter((m) => m && m.by === 'relay').map((m) => String(m.text || ''))
const claim = (doc, file, by, ttl = 300000) => doc.getMap('claims').set(file, { by, intent: 'editing', at: Date.now(), ttl })

try {
  // The holder, and a human who watches the room and the files (reads are never gated).
  const holder = connect(BASE, mint('AgentB'))
  const room = connect(BASE, mint('Watcher', { kind: 'human' }))
  await sleep(1500)

  console.log('\n# a write into a file someone else holds')
  claim(holder.doc, 'f.txt', 'AgentB')
  await sleep(1200)
  const watchF = connect(fileRoom(BASE, 'f.txt'), mint('Watcher', { kind: 'human' }))
  const writer = connect(fileRoom(BASE, 'f.txt'), mint('AgentA'))
  await sleep(1200)
  writer.doc.getText('content').insert(0, 'A1 ')
  await sleep(300)
  writer.doc.getText('content').insert(3, 'A2 ')
  await sleep(300)
  writer.doc.getText('content').insert(6, 'A3')
  await sleep(2500)
  T('(control) the held edit did not reach the file yet', watchF.doc.getText('content').toString() === '', JSON.stringify(watchF.doc.getText('content').toString()))
  const held = relayLines(room.doc).filter((t) => /f\.txt/.test(t) && /held/i.test(t))
  T('H1 the room is told: the writer (@AgentA), the file, and who holds it (@AgentB)', held.length >= 1 && /@AgentA/.test(held[0]) && /@AgentB/.test(held[0]), held[0] || relayLines(room.doc).join(' | '))
  T('H2 one notice for the hold, not one per write', held.length === 1, `${held.length} notices`)

  console.log('\n# the holder releases')
  holder.doc.getMap('claims').delete('f.txt')
  await sleep(2500)
  T('H3a the held edits land when the claim is released', watchF.doc.getText('content').toString() === 'A1 A2 A3', JSON.stringify(watchF.doc.getText('content').toString()))
  const landed = relayLines(room.doc).filter((t) => /f\.txt/.test(t) && /landed/i.test(t))
  T('H3b and the room is told they landed', landed.length === 1 && /AgentA/.test(landed[0]), landed[0] || '')

  console.log('\n# a second hold on the same connection')
  claim(holder.doc, 'f.txt', 'AgentB')
  await sleep(1200)
  writer.doc.getText('content').insert(writer.doc.getText('content').length, ' A4')
  await sleep(2000)
  T('(control) the second held edit did not land yet', watchF.doc.getText('content').toString() === 'A1 A2 A3', JSON.stringify(watchF.doc.getText('content').toString()))
  holder.doc.getMap('claims').delete('f.txt')
  await sleep(2500)
  T('H7 a second hold on the same connection also lands on release', watchF.doc.getText('content').toString() === 'A1 A2 A3 A4', JSON.stringify(watchF.doc.getText('content').toString()))
  T('H7b and it was announced as a hold of its own', relayLines(room.doc).filter((t) => /f\.txt/.test(t) && /held:/.test(t)).length === 2)

  console.log('\n# a claim that expires, with nobody releasing it')
  claim(holder.doc, 'g.txt', 'AgentB', 3000)
  await sleep(800)
  const watchG = connect(fileRoom(BASE, 'g.txt'), mint('Watcher', { kind: 'human' }))
  const writerG = connect(fileRoom(BASE, 'g.txt'), mint('AgentA'))
  await sleep(1000)
  writerG.doc.getText('content').insert(0, 'after-expiry')
  await sleep(6000)
  T('H4 the claim expired, so the held edit landed by itself', watchG.doc.getText('content').toString() === 'after-expiry', JSON.stringify(watchG.doc.getText('content').toString()))

  console.log('\n# a writer that leaves while its edits are held')
  claim(holder.doc, 'h.txt', 'AgentB')
  await sleep(800)
  const leaver = connect(fileRoom(BASE, 'h.txt'), mint('AgentC'))
  await sleep(1000)
  leaver.doc.getText('content').insert(0, 'C was here')
  await sleep(1500)
  leaver.provider.destroy()
  await sleep(2000)
  const left = relayLines(room.doc).filter((t) => /h\.txt/.test(t) && /@AgentC/.test(t) && /NOT applied/.test(t))
  T('H5 the room is told the leaver\'s held edits were NOT applied', left.length === 1, relayLines(room.doc).filter((t) => /h\.txt/.test(t)).join(' | '))

  console.log('\n# a write nobody blocks')
  const before = relayLines(room.doc).length
  const free = connect(fileRoom(BASE, 'free.txt'), mint('AgentA'))
  await sleep(1000)
  free.doc.getText('content').insert(0, 'free')
  await sleep(2000)
  T('H6 an unblocked write posts nothing', relayLines(room.doc).length === before, relayLines(room.doc).slice(before).join(' | '))
} catch (err) {
  T(`no exception (${err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err})`, false)
} finally {
  for (const p of open) { try { p.destroy() } catch { } }
  try { relay.kill() } catch { }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
