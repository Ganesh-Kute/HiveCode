#!/usr/bin/env node
// hive-await — block until someone speaks to you, then exit. The CLI's `hive_wait`.
//
//   npx -y -p hivecode-mcp@latest hivecode-await "<relay|room>" <YourName> [idleMinutes]
//
// Run it in the BACKGROUND and let its exit wake you. Exits 0 in both cases; read `reason` on stdout:
//   {"reason":"mention","messages":[...]}   someone said @YourName or @all -> read, reply, run it again
//   {"reason":"idle","note":"..."}          nothing in N minutes -> run it again
//
// WHY THIS EXISTS. An agent driving Hivecode from the shell has no way to be interrupted. The
// only pattern available was a timer:
//
//     for i in 1 2 3 4 5; do hive-readchat.js ...; sleep 30; done
//
// which is deaf by construction. A sleeping process cannot be woken by a message, so the agent
// is blind for the whole window — and the window is exactly when people are talking to it.
// Measured on 11 Sep 2026: Ganesh messaged the Director and got no answer for minutes, not
// because the Director was ignoring him but because it was mid-`sleep`. The agents were alive
// and deaf, which from the outside is indistinguishable from broken.
//
// A timer also makes you choose between two bad things: sleep long and be unresponsive, or
// sleep short and burn a tool call every few seconds for nothing. This waits on the EVENT.
// Blocked costs nothing — it is a CRDT observer, not a poll — and it returns the instant your
// name is said.
//
// SHIPPED, 29 Sep 2026. Until then this file lived untracked in one developer's folder, and every
// agent in a four-machine room got it by path or by paste — the listener the whole product's
// "stay reachable" rule depends on was not in the package.
//
// It joins under YOUR name, beside your MCP connection, tagged `listener`, so the room can say
// "listening" instead of "parked". It is NOT `passive`: passive means "never answers", and presence
// is merged by name, so a passive listener would mark the agent itself as one nobody may wait on.

import fs from 'fs'
import path from 'path'
import { startSync, parseLink } from './sync.js'
import * as RC from './hive-receipts.js'
import { awaitDir, armedFile, BEAT_MS } from './hive-listen.js'

const [, , LINK = '', NAME = '', IDLE_MIN = '10'] = process.argv
if (!LINK || !NAME) {
  console.error('usage: npx -y -p hivecode-mcp@latest hivecode-await "<relay|room>" <YourName> [idleMinutes]')
  process.exit(2)
}
const { relay, room } = parseLink(LINK)
const dir = awaitDir(NAME)

const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, listener: true, log: () => {} })

// ARMED, AND THE NEWEST LISTENER WINS (4 Oct 2026; see hive-listen.js). This file is how the Stop
// hook and the MCP server know, with no network call, that the agent will hear the room after its
// turn ends. It is written at start, not on the first sync: a listener still connecting delivers
// every mention once it does (check() runs on every resync), and calling it unarmed would only make
// the agent start a second one. Two listeners for one agent wake it twice for one message, so a
// listener that finds the file naming another process leaves: that one was started after it.
const ARMED = armedFile(NAME, room)
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || process.env.ANTIGRAVITY_CONVERSATION_ID || ''
const AGAIN = `"${process.execPath.replace(/\\/g, '/')}" "${path.resolve(process.argv[1]).replace(/\\/g, '/')}" "${LINK}" "${NAME}" ${IDLE_MIN}`
const startedAt = Date.now()
let synced = false
const readArmed = () => { try { return JSON.parse(fs.readFileSync(ARMED, 'utf8')) } catch { return null } }
const ownerPid = () => Number((readArmed() || {}).pid) || 0
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
// THE NEWEST BY START TIME WINS, NOT THE LAST ONE TO WRITE (6 Oct 2026, the first macOS run). Every
// listener reads the file and then rewrites it on each beat. An older listener that read it just
// before a newer one wrote it put its own claim back on top, and the NEWER one then left as
// "superseded" while the older stayed: N1 and N3 failed on macOS, never on Windows. So a claim is
// judged by when its listener started. A listener yields only to one that started after it and is
// still running; a newer one that finds an older claim on top takes the file back on its next beat.
// The file is also written whole (a temp file renamed over it), so a reader never sees half of one.
const newerThanMe = (rec) => {
  const pid = Number(rec && rec.pid) || 0
  if (!pid || pid === process.pid || !alive(pid)) return false
  const at = Number(rec.at) || 0
  return at > startedAt || (at === startedAt && pid > process.pid)
}
function beat() {
  try {
    fs.mkdirSync(path.dirname(ARMED), { recursive: true })
    const body = JSON.stringify({ pid: process.pid, name: NAME, room, link: LINK, session: SESSION, at: startedAt, beat: Date.now(), synced })
    const part = `${ARMED}.${process.pid}.tmp`
    try { fs.writeFileSync(part, body); fs.renameSync(part, ARMED) } catch {
      try { fs.rmSync(part, { force: true }) } catch {}
      fs.writeFileSync(ARMED, body)
    }
  } catch { /* unarmed is the safe reading: the hook asks for a fresh listener, and it replaces this one */ }
}
const superseded = () => {
  const rec = readArmed()
  if (!newerThanMe(rec)) return false
  finish('superseded', { note: `a newer listener for ${NAME} in ${room} took over (pid ${rec.pid}). Do not start this one again.` })
  return true
}
beat()
setInterval(() => { if (!superseded()) beat() }, BEAT_MS).unref()
process.on('exit', () => { try { if (ownerPid() === process.pid) fs.unlinkSync(ARMED) } catch { } })
const chat = hive.doc.getArray('chat')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// `@all` wakes everyone — it is how the room is addressed deliberately. `\b` is NOT enough: "-" is a
// word boundary, so `@Claude\b` fired on `@Claude-2`, a different participant. A name ends where no
// name character follows. `@all` must not match `@allen` either.
const rx = new RegExp(`@(${esc(NAME)}|all)(?![\\w-])`, 'i')
let armed = false
let finishing = false

// `flushMs`: when this exit just moved the room's read cursor, give that update time to leave the
// socket. Exiting at once can drop it, and the MCP side would announce the same mail again.
async function finish(reason, payload, flushMs = 0) {
  if (finishing) return
  finishing = true
  if (flushMs) {
    const ws = hive.provider && hive.provider.ws
    const end = Date.now() + flushMs
    while (Date.now() < end && ws && ws.readyState === 1 && ws.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 25))
    await new Promise((r) => setTimeout(r, 200))
  }
  console.log(JSON.stringify({ reason, ...payload }))
  try { hive.stop() } catch {}
  process.exit(0)
}

// THE ROOM'S CURSOR IS THE SHARED ONE (3 Oct 2026). This process and the agent's MCP server each
// kept their own: a message delivered here was still unread there, so the next tool call announced
// it again as "UNREAD MAIL ... Handle before continuing" (19 old messages in one session), and mail
// the agent read through hive_check could wake a fresh listener a second time. Both now meet at the
// room's per-member cursor (hive-receipts.js), which only moves forward. Publishing it here is also
// what lets a sender's hive_delivered say READ for mail this listener handed over.
const cursors = hive.doc.getMap('cursors')
const roomCursor = (len) => {
  try { const c = RC.cursorOf(cursors, NAME); const at = (c && Number(c.at)) || 0; return at <= len ? at : 0 } catch { return 0 }
}
const publish = (n) => { try { RC.publishCursor(cursors, NAME, n) } catch { /* a room that predates receipts */ } }

// A PERSISTED CURSOR, not just "my last message".
//
// The first version anchored only on the last thing I said. That is fine for an agent that
// replies to everything, and a livelock for one that listens without speaking: `lastMine` stays
// -1, so every call returns the SAME old messages, the caller loops, and it never advances.
// Measured 11 Sep 2026 — Builder's watch loop ran 420 iterations over ~42 minutes re-reading the
// same two messages, and the respawning that caused left orphaned processes holding room
// presence after the agent itself had died.
//
// So the cursor is written to disk and advanced on every exit. `lastMine` is still used, as a
// FLOOR: anything I have already replied to is handled by definition, even if a stale cursor
// says otherwise. Whichever is further along wins.
// AN ORPHAN MUST NOT KEEP SAYING "LISTENING" (2 Oct 2026). When the app that started this listener
// closes, the listener can outlive it: on macOS and Linux it is reparented, and on any OS a detached
// start escapes the parent's job. It then keeps its agent marked LISTENING, reachable, in every
// teammate's hive_members, and wakes nobody when they call. So it watches the process that started
// it and leaves the room once that process is gone. HIVE_AWAIT_KEEP_ALIVE=1 opts out, for a listener
// that is detached on purpose. (tests/hive-await-test.mjs, "an orphaned listener")
const PARENT = process.ppid
const parentGone = () => {
  if (process.ppid !== PARENT) return true // reparented: the parent exited
  try { process.kill(PARENT, 0); return false } catch (e) { return e.code !== 'EPERM' }
}
if (process.env.HIVE_AWAIT_KEEP_ALIVE !== '1' && PARENT > 1 && !parentGone()) {
  setInterval(() => {
    if (parentGone()) finish('parent-gone', { note: `the process that started this listener exited, so ${NAME} left the room` })
  }, Number(process.env.HIVE_AWAIT_PARENT_CHECK_MS) || 15000).unref()
}

const cursorFile = path.join(dir, `.await-cursor-${room}.json`)
const readCursor = () => { try { return Number(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).at) || 0 } catch { return 0 } }
const writeCursor = (n) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cursorFile, JSON.stringify({ at: n }), 'utf8') } catch { /* a cursor we cannot persist must not break the wait */ } }

function check() {
  if (superseded()) return // the newer listener delivers it; consuming it here would hide it from that one
  const msgs = chat.toArray()
  let lastMine = -1
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].by === NAME) { lastMine = i; break } }
  const from = Math.max(readCursor(), lastMine + 1, roomCursor(msgs.length))
  const hits = []
  for (let i = from; i < msgs.length; i++) {
    const m = msgs[i]
    if (rx.test(String(m.text || '')) && m.by !== NAME) hits.push(m)
  }
  // Advance past everything READ, not just everything matched — an unaddressed message I have
  // already seen must not be re-scanned on the next call either.
  if (hits.length) {
    writeCursor(msgs.length)
    publish(msgs.length)
    // THE ORDER TO START AGAIN RIDES ON EVERY WAKE. It used to be said once, on the agent's first
    // quiet hive_wait, and an agent had to remember it after every wake; agents forget (4 Oct 2026).
    finish('mention', { messages: hits.map((m) => `${m.by}(${m.kind}): ${m.text}`), next: `When you have answered, start this listener again in the background, the same way you started it, or you stop hearing the room when your turn ends: ${AGAIN}` }, 1500)
  }
}

hive.provider.on('sync', (s) => {
  if (!s) return
  if (!synced) { synced = true; beat() }
  if (!armed) {
    armed = true
    console.error(`[await] ${NAME} listening in ${room}. In room: ${hive.members().map((m) => m.name).join(', ')}`)
    chat.observe(check)
  }
  check() // also on every resync — mentions may have landed while the socket was down
})

// An idle timeout also advances the cursor. Without this, a quiet window followed by a loud one
// would re-deliver everything that arrived during the quiet window too.
setTimeout(() => {
  try { writeCursor(chat.length) } catch {}
  publish(chat.length) // nothing in the window named us, so nothing in it is mail the MCP should raise
  finish('idle', { note: `nothing addressed to ${NAME} in ${IDLE_MIN} min. Run this same command again in the background to keep listening: ${AGAIN}` }, 1500)
}, Number(IDLE_MIN) * 60 * 1000)
process.on('SIGINT', () => { try { hive.stop() } catch {}; process.exit(0) })
