// tests/mail-identity-test.mjs -- every chat reader reads by Yjs identity, never by position (0.14.4).
//
//   node tests/mail-identity-test.mjs
//
// THE DEFECT (9 Nov 2026). A peer that pushes while its update is still in flight integrates at its
// ORIGINAL position, behind messages others already read (Yjs orders concurrent inserts by clientID,
// not by arrival). Every count/position reader then skipped it: live, antigravity-VM's 10:22 message
// reached the relay at 11:05 and landed at #818, behind 13 messages everyone had read. hive-seen.js
// has the whole story; docs/mail-identity-design.md the design and its review.
//
// Each row drives the REAL code, never a copy of it: a test that re-implements the reader proves
// only its own copy (learnings/green-but-not-testing-it.md). And each "late" message is forced to
// integrate mid-array -- the setup row checks it did -- so every reader row fails on c5ce586f.
//
//   G   the primitive: itemsOf == toArray; a frontier is NOT a Yjs state vector; pruning is bounded
//   R1  the mailbox behind hive_wait / hive_check / the [!] gate
//   A6  handed is not read: a listener's hand-over is delivered once more, marked, never dropped
//   RC  receipts behind hive_delivered: UNREAD (never a false READ), HANDED, older peers
//   SH  the Stop hook's watermark (it reads HIVE_CHAT.md, no Yjs)
//   NF  hive-notify
//   RW  the room watcher's "an agent replied since the post"
//   SL  the room -> Slack bridge
//   AW  hive-await, end to end: a real relay, a real listener process

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import * as Y from 'yjs'
import * as SEEN from '../hive-seen.js'
import { createMailbox, formatMessage } from '../hive-mailbox.js'
import * as RC from '../hive-receipts.js'
import { decide } from '../hive-stop-hook.js'
import { makeWatch } from '../hive-notify.js'
import { agentRepliedSince } from '../hive-room-watcher.js'
import { makeChatForwarder } from '../hive-slack.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) } }
const sec = (s) => console.log(`\n# ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const mk = (id) => { const d = new Y.Doc(); d.clientID = id; return d }
const sync = (from, to) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)))
const push = (d, by, text, kind = 'ai', at = '10:00:00') => d.getArray('chat').push([{ by, kind, at, text }])
const texts = (arr) => arr.map((m) => m.text)
const frontierOfAll = (yarr) => { const f = SEEN.makeFrontier(); for (const { id } of SEEN.itemsOf(yarr)) f.add(id); return f }

// The race, deterministic. A writes on time; B (LOWER clientID) writes while its update is in flight;
// the reader R reads A's messages, then B's arrives and Yjs places it BEFORE A's later ones.
function lateRoom({ late = '[!] @C stand down on test.js (late)' } = {}) {
  const A = mk(20), B = mk(10), R = mk(30)
  push(A, 'A', 'M0 base'); sync(A, B); sync(A, R)
  return {
    A, B, R,
    beforeLate: () => { push(B, 'B', late); push(A, 'A', 'M1 work item 1'); push(A, 'A', 'M2 work item 2'); sync(A, R) },
    arrive: () => sync(B, R),
    lateIndex: () => R.getArray('chat').toArray().findIndex((m) => m.by === 'B'),
  }
}

// ======================================================================================= G
sec('G  the primitive (hive-seen.js)')
{
  let same = true
  for (let trial = 0; trial < 120 && same; trial++) {
    const docs = [mk(1 + trial * 3), mk(2 + trial * 3), mk(3 + trial * 3)]
    for (let step = 0; step < 25; step++) {
      const d = docs[(step * 7 + trial) % 3], a = d.getArray('chat')
      const op = (step * 13 + trial * 5) % 6
      if (op < 3 || a.length === 0) a.push([{ s: step, t: trial }])
      else if (op === 3) a.insert((step + trial) % (a.length + 1), [{ ins: step }])
      else if (op === 4) a.delete((step + trial) % a.length, 1)
      else sync(docs[(step + 1) % 3], d)
    }
    for (const x of docs) for (const y of docs) sync(x, y)
    for (const d of docs) {
      const a = d.getArray('chat')
      if (JSON.stringify(SEEN.itemsOf(a).map((x) => x.value)) !== JSON.stringify(a.toArray())) { same = false; break }
    }
  }
  T('G1 itemsOf yields exactly toArray(), in order, over 120 fuzzed three-writer histories (the one Yjs internal this relies on)', same)

  const d = mk(7), a = d.getArray('chat')
  a.push([{ x: 1 }]); a.push([{ x: 2 }]); a.push([{ x: 3 }])
  const sv = Y.decodeStateVector(Y.encodeStateVector(d))
  const f = frontierOfAll(a).toJSON()
  T('G2 a frontier stores the highest clock SEEN; Yjs\'s state vector stores the next one (highest + 1)', f['7'] === 2 && sv.get(7) === 3, `frontier=${JSON.stringify(f)} sv=${sv.get(7)}`)
  const wrong = SEEN.makeFrontier({ 7: sv.get(7) }) // what seeding from the state vector would do
  a.push([{ x: 4 }])
  const late4 = SEEN.itemsOf(a).at(-1).id
  T('G2b ...and seeding one from the other silently skips exactly the next message (why nothing here reads a state vector)', wrong.has(late4) && !SEEN.makeFrontier(f).has(late4))

  const reader = mk(100000), writers = []
  for (let i = 1; i <= 200; i++) { const w = mk(i); push(w, `s${i}`, `session ${i}`); writers.push(w); sync(w, reader) }
  const rf = frontierOfAll(reader.getArray('chat'))
  const chatR = reader.getArray('chat')
  const items = SEEN.itemsOf(chatR)
  reader.transact(() => { for (let k = items.length - 1; k >= 10; k--) chatR.delete(k, 1) }) // 190 sessions' lines gone
  const pruned = rf.toJSON({ prune: chatR })
  T('G3 200 writer sessions: the published frontier is pruned to the 10 that still have a line', rf.size === 200 && Object.keys(pruned).length === 10, `before=${rf.size} after=${Object.keys(pruned).length}`)
  const gone = writers[150] // its line was deleted, so its client was pruned
  sync(reader, gone); push(gone, gone.getArray('chat').get(0) ? 's151' : 's151', 'session 151 is back'); sync(gone, reader)
  const back = SEEN.itemsOf(chatR).find((x) => x.value.text === 'session 151 is back')
  T('G3b ...and a later line from a pruned client is unseen, so it is delivered: pruning can only re-read, never skip', !!back && !SEEN.makeFrontier(pruned).has(back.id))
}

// ======================================================================================= R1
sec('R1 the mailbox (hive_wait, hive_check, the [!] gate)')
{
  const r = lateRoom()
  const mb = createMailbox({ me: 'C', startAt: 0 })
  T('R1 setup: C reads M0', texts(mb.take(r.R.getArray('chat')).messages).join() === 'M0 base')
  r.beforeLate()
  T('R1 setup: C reads M1 and M2', texts(mb.take(r.R.getArray('chat')).messages).join() === 'M1 work item 1,M2 work item 2')
  r.arrive()
  T('R1 setup: B\'s late push integrated BEHIND what C read (index 1 of 4)', r.lateIndex() === 1, `index ${r.lateIndex()}`)
  const got = mb.take(r.R.getArray('chat'))
  T('R1a the late urgent message IS delivered', texts(got.messages).some((t) => /stand down/.test(t)), JSON.stringify(texts(got.messages)))
  T('R1b ...with its priority, so the [!] gate sees it', got.priority === 'stop', got.priority)
  T('R1c ...and nothing already read is handed over again (the one message is the late one, not a shifted old one)', got.messages.length === 1 && /stand down/.test(got.messages[0].text), JSON.stringify(texts(got.messages)))
  T('R1d a fourth take is empty', mb.take(r.R.getArray('chat')).messages.length === 0)

  const plain = createMailbox({ me: 'C', startAt: 1 })
  T('R1e a plain array (append-only: tests, tools) keeps the exact count semantics', texts(plain.take([{ by: 'A', text: 'x' }, { by: 'A', text: 'y' }]).messages).join() === 'y')

  const r2 = lateRoom()
  r2.beforeLate()
  const old = createMailbox({ me: 'C', startAt: 3 }) // a v1 session file: a count only
  T('R1f a resumed count (v1) is migrated once, by prefix: nothing it covered is handed over again', old.take(r2.R.getArray('chat')).messages.length === 0)
  r2.arrive()
  T('R1g ...and from then on identity rules: the late push behind it is delivered', texts(old.take(r2.R.getArray('chat')).messages).some((t) => /stand down/.test(t)))
}

// ======================================================================================= A6
sec('A6 handed is not read')
{
  const R = mk(30), A = mk(20)
  push(A, 'A', 'hello'); push(A, 'A', '@C please run group D (job-one)'); push(A, 'A', 'unrelated chatter'); sync(A, R)
  const chat = R.getArray('chat')
  const mb = createMailbox({ me: 'C', startAt: 1 })
  mb.handedBy(frontierOfAll(chat).toJSON(), '11:01') // C's listener woke on job-one
  const got = mb.take(chat)
  T('A6a a mention the listener handed over is delivered once more, not dropped (incident I-1)', texts(got.messages).some((t) => /job-one/.test(t)), JSON.stringify(texts(got.messages)))
  T('A6b ...marked as already handed, with the time', got.messages.some((m) => m.handed === '11:01') && /already handed to you at 11:01/.test(got.messages.map(formatMessage).join('\n')))
  T('A6c ...while ambient chatter the listener already scanned stays skipped, as before', !texts(got.messages).some((t) => /unrelated/.test(t)))
  T('A6d ...and it is never handed over a third time', mb.take(chat).messages.length === 0)

  const mu = createMailbox({ me: 'C', startAt: 1 })
  const A2 = mk(21); push(A2, 'A', '[!] @C stop editing test.js'); sync(A2, R)
  mu.handedBy(frontierOfAll(chat).toJSON(), '11:02')
  T('A6e an URGENT mention the listener handed over still counts for the [!] gate until it is read', mu.peek(chat).priority === 'stop')
}

// ======================================================================================= RC
sec('RC receipts (hive_delivered)')
{
  const r = lateRoom()
  r.beforeLate()
  const chat = r.R.getArray('chat')
  const cursors = r.R.getMap('cursors')
  RC.publishFrontier(cursors, 'C', { read: frontierOfAll(chat).toJSON(), at: chat.length })
  r.arrive()
  const its = SEEN.itemsOf(chat)
  const iLate = its.findIndex((x) => x.value.by === 'B')
  const st = RC.stateFor({ cursors, name: 'C', index: iLate, id: its[iLate].id })
  T('RC1 a message that integrated behind C\'s position is UNREAD, never a false READ', st.state === RC.UNREAD, `${st.state}: ${st.why}`)
  const iOld = its.findIndex((x) => x.value.text === 'M2 work item 2')
  T('RC1b ...while what C really read is READ', RC.stateFor({ cursors, name: 'C', index: iOld, id: its[iOld].id }).state === RC.READ)

  const rec = RC.publishFrontier(cursors, 'C', { read: cursors.get('C').read, at: SEEN.coveredPrefix(chat, cursors.get('C').read) })
  T('RC2 the count published beside it for older peers goes DOWN to the gap-free prefix (honest: 1, not 3)', rec.at === 1, `at=${rec.at}`)

  RC.publishFrontier(cursors, 'D', { handed: frontierOfAll(chat).toJSON(), handedAt: '11:05' })
  T('RC3 handed by the listener, not yet read: HANDED, and HANDED is not delivered', RC.stateFor({ cursors, name: 'D', index: iLate, id: its[iLate].id }).state === RC.HANDED && !RC.DELIVERED_STATES.includes(RC.HANDED))
  const dBefore = JSON.stringify(cursors.get('D').read)
  RC.publishFrontier(cursors, 'D', { handed: frontierOfAll(chat).toJSON() })
  T('RC3b a listener\'s publish never moves READ', JSON.stringify(cursors.get('D').read) === dBefore && cursors.get('D').at === 0)
  RC.publishFrontier(cursors, 'D', { read: frontierOfAll(chat).toJSON(), at: chat.length })
  T('RC3c ...the agent\'s own read does, and then it is READ', RC.stateFor({ cursors, name: 'D', index: iLate, id: its[iLate].id }).state === RC.READ)

  let writes = 0
  cursors.observe(() => { writes++ })
  RC.publishFrontier(cursors, 'D', { read: frontierOfAll(chat).toJSON(), at: chat.length })
  RC.publishFrontier(cursors, 'D', { read: frontierOfAll(chat).toJSON(), at: chat.length })
  T('RC4 publishing an unchanged frontier writes nothing (it runs on every hive_check)', writes === 0, `writes=${writes}`)

  cursors.set('E', { at: 2, ts: 1, ver: 1 })
  T('RC5 a peer on an older build (a count only) is still answered by the count rule', RC.stateFor({ cursors, name: 'E', index: 1, id: its[1].id }).state === RC.READ && RC.stateFor({ cursors, name: 'E', index: 3, id: its[3].id }).state === RC.UNREAD)
}

// ======================================================================================= SH
sec('SH the Stop hook (HIVE_CHAT.md, no Yjs)')
{
  const line = (at, by, text) => `- ${at}  ${by} (ai): ${text}`
  const before = ['# Hive Chat', '', line('10:00:00', 'A', 'hello'), line('10:00:05', 'A', 'status green')].join('\n') + '\n'
  const d1 = decide({ chat: before, tasks: '', me: 'Ag', seen: 0, handled: null, taskBlocks: 0 })
  T('SH setup: nothing to block on', !d1.block)
  const after = ['# Hive Chat', '', line('10:00:00', 'A', 'hello'), line('10:00:01', 'B', '@Ag [!] stand down (late)'), line('10:00:05', 'A', 'status green')].join('\n') + '\n'
  const d2 = decide({ chat: after, tasks: '', me: 'Ag', seen: d1.seen, handled: d1.handled, taskBlocks: 0, nudged: ['B|10:00:01'] }) // the reply nudge already fired: only the mail watermark may block
  T('SH1 a late mention rendered MID-file blocks the turn as MAIL (the count watermark started after it)', d2.block && /\d+ message/.test(d2.reason || '') && /stand down/.test(d2.reason || ''), d2.reason ? d2.reason.slice(0, 120) : 'no block')
  const d3 = decide({ chat: after, tasks: '', me: 'Ag', seen: d2.seen, handled: d2.handled, taskBlocks: 0, nudged: d2.nudged }) // the hook carries both, as its state file does
  T('SH2 ...exactly once', !d3.block)
  const d4 = decide({ chat: after, tasks: '', me: 'Ag', seen: 3, handled: null, taskBlocks: 0, nudged: ['B|10:00:01'] }) // B's question was already nudged (keyed by author|time): only the mail watermark is under test
  T('SH3 a state from an older build (a count only) is migrated once: what it covered does not block again', !d4.block)
}

// ======================================================================================= NF
sec('NF hive-notify')
{
  const r = lateRoom({ late: '@Ganesh please approve the release (late)' })
  const sent = []
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mi-nf-')), 'sent.json')
  const hive = { doc: r.R, members: () => [], connection: () => ({ connected: true }) }
  const w = makeWatch({ hive, forNames: ['Ganesh'], title: 'room', send: async (t) => { sent.push(t); return true }, every: 0, stateFile })
  r.beforeLate(); await w.check()
  r.arrive()
  T('NF setup: the late mention integrated behind what the watch had counted', r.lateIndex() === 1)
  await w.check()
  T('NF1 a late mention of someone away is notified', sent.some((t) => /approve the release/.test(t)), JSON.stringify(sent).slice(0, 160))
  const n = sent.length; await w.check()
  T('NF2 ...and only once', sent.length === n)
}

// ======================================================================================= RW
sec('RW the room watcher: an agent replied since the post')
{
  const G = mk(50), X = mk(10)
  push(G, 'GitHub', 'setup', 'ai'); sync(G, X)
  push(X, 'Builder', 'taking #42 now (task-101)')                 // in flight when the issue is posted
  push(G, 'GitHub', 'Issue #42: please investigate', 'ai')
  const postFrontier = frontierOfAll(G.getArray('chat')).toJSON()  // what postIssue returns
  sync(X, G)
  const chat = G.getArray('chat')
  T('RW setup: the reply integrated BEFORE the post', chat.toArray().findIndex((m) => m.by === 'Builder') < chat.toArray().findIndex((m) => /^Issue #42/.test(m.text)))
  T('RW1 with the post\'s frontier, that reply counts as "an agent took it"', agentRepliedSince({ chat, issueNumber: 42, taskId: 'task-101', postFrontier }) === true)
  T('RW2 a run posted by an older build (no frontier) keeps the position rule', agentRepliedSince({ chat, issueNumber: 42, taskId: 'task-101', postFrontier: null }) === false)
  const G2 = mk(51); push(G2, 'Builder', 'old note on #42'); push(G2, 'GitHub', 'Issue #42: please investigate', 'ai')
  T('RW3 a reply the poster already held when posting does not count', agentRepliedSince({ chat: G2.getArray('chat'), issueNumber: 42, postFrontier: frontierOfAll(G2.getArray('chat')).toJSON() }) === false)
}

// ======================================================================================= SL
sec('SL the room -> Slack bridge')
{
  const r = lateRoom({ late: 'Builder: the deploy is blocked (late)' })
  const chat = r.R.getArray('chat')
  const out = []
  const forwarded = r.R.getMap('slack_forwarded'), threads = r.R.getMap('slack_threads')
  const fwd = makeChatForwarder({ chat, forwarded, key: 'C123', at: chat.length, threads, onChat: (msgs) => out.push(...msgs) })
  r.beforeLate(); fwd()
  r.arrive(); fwd()
  T('SL1 a late message is forwarded to Slack', out.some((m) => /deploy is blocked/.test(m.text)), JSON.stringify(texts(out)))
  T('SL2 ...once, and nothing before the bridge started', texts(out).filter((t) => /deploy is blocked/.test(t)).length === 1 && !texts(out).includes('M0 base'))
  const again = []
  const fwd2 = makeChatForwarder({ chat, forwarded, key: 'C123', at: Number(threads.get('__cursor__')) || 0, threads, onChat: (msgs) => again.push(...msgs) })
  push(r.A, 'A', 'after restart'); sync(r.A, r.R); fwd2()
  T('SL3 a restarted bridge resumes from the saved frontier: only the new line goes out', texts(again).join() === 'after restart', JSON.stringify(texts(again)))
  T('SL4 the count older bridges read is kept honest (the gap-free prefix)', Number(threads.get('__cursor__')) === chat.length)
}

// ======================================================================================= AW
sec('AW hive-await, end to end (real relay, real listener)')
const kids = []
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mail-identity-'))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
kids.push(relay)
let relayUp = false
relay.stdout.on('data', (d) => { if (/listening on/.test(d)) relayUp = true })
const { startSync } = await import('../sync.js')
const clients = []
try {
  await until(() => relayUp, 15000)
  const link = `ws://localhost:${PORT}|mi-${Math.random().toString(36).slice(2, 8)}`
  const [relayUrl, room] = link.split('|')
  const join = (name) => { const c = startSync({ relay: relayUrl, room, dir: path.join(TMP, name), name, kind: 'ai', syncFiles: false, log: () => { } }); clients.push(c); return c }
  const X = join('Xavier'), Z = join('Zed')
  await until(() => X.provider.synced && Z.provider.synced, 15000)
  const [late, onTime] = X.doc.clientID < Z.doc.clientID ? [X, Z] : [Z, X] // the LOWER client id sorts first
  onTime.say('hello')
  await until(() => late.doc.getArray('chat').length === 1, 10000)
  late.provider.disconnect()
  await sleep(300)
  late.say('@Ag [!] stand down on test.js (late)')
  onTime.say('status green'); onTime.say('status still green')
  const ochat = onTime.doc.getArray('chat')
  // Ag's own MCP had read everything it could see: what the room records for it.
  RC.publishFrontier(onTime.doc.getMap('cursors'), 'Ag', { read: frontierOfAll(ochat).toJSON(), at: ochat.length })
  await sleep(500)
  late.provider.connect()
  await until(() => ochat.toArray().some((m) => /\(late\)/.test(m.text)), 15000)
  const li = ochat.toArray().findIndex((m) => /\(late\)/.test(m.text))
  T('AW setup: on a real relay the late mention integrated BEHIND what Ag had read', li >= 0 && li < ochat.length - 1, `index ${li} of ${ochat.length}`)
  const TEMPD = path.join(TMP, 'await-temp')
  const child = spawn(process.execPath, [path.join(ROOT, 'hive-await.js'), link, 'Ag', '1'], { cwd: ROOT, env: { ...process.env, TEMP: TEMPD, TMPDIR: TEMPD, HIVE_AWAIT_KEEP_ALIVE: '1' } })
  kids.push(child)
  let outS = '', exited = false
  child.stdout.on('data', (d) => { outS += d })
  child.on('exit', () => { exited = true })
  await until(() => exited, 20000)
  let parsed = null; try { parsed = JSON.parse(outS.trim().split('\n').pop()) } catch { }
  T('AW1 the listener wakes for it', !!parsed && parsed.reason === 'mention' && /stand down/.test(JSON.stringify(parsed.messages)), outS.slice(0, 200))
  const rec = RC.cursorOf(onTime.doc.getMap('cursors'), 'Ag')
  await until(() => { const c = RC.cursorOf(onTime.doc.getMap('cursors'), 'Ag'); return c && c.handedAt }, 5000)
  const rec2 = RC.cursorOf(onTime.doc.getMap('cursors'), 'Ag')
  const its = SEEN.itemsOf(ochat), iL = its.findIndex((x) => /\(late\)/.test(x.value.text))
  T('AW2 ...and records it HANDED, not READ: Ag itself has not read it', RC.stateFor({ cursors: onTime.doc.getMap('cursors'), name: 'Ag', index: iL, id: its[iL].id }).state === RC.HANDED, JSON.stringify(rec2 || rec))
} finally {
  for (const c of clients) { try { c.stop() } catch { } }
  for (const k of kids) { try { k.kill() } catch { } }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== MAIL IDENTITY: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
