#!/usr/bin/env node
// hive-await — block until someone speaks to you, then exit. The CLI's `hive_wait`.
//
//   npx -p hivecode-mcp hivecode-await "<relay|room>" <YourName> [idleMinutes]
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

const [, , LINK = '', NAME = '', IDLE_MIN = '10'] = process.argv
if (!LINK || !NAME) {
  console.error('usage: npx -p hivecode-mcp hivecode-await "<relay|room>" <YourName> [idleMinutes]')
  process.exit(2)
}
const { relay, room } = parseLink(LINK)
const dir = (process.env.TEMP || process.env.TMPDIR || '.') + '/hive-await-' + NAME

const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: process.env.HIVE_TOKEN || '', syncFiles: false, listener: true, log: () => {} })
const chat = hive.doc.getArray('chat')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// `@all` wakes everyone — it is how the room is addressed deliberately. `\b` is NOT enough: "-" is a
// word boundary, so `@Claude\b` fired on `@Claude-2`, a different participant. A name ends where no
// name character follows. `@all` must not match `@allen` either.
const rx = new RegExp(`@(${esc(NAME)}|all)(?![\\w-])`, 'i')
let armed = false

function finish(reason, payload) {
  console.log(JSON.stringify({ reason, ...payload }))
  try { hive.stop() } catch {}
  process.exit(0)
}

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
const cursorFile = path.join(dir, `.await-cursor-${room}.json`)
const readCursor = () => { try { return Number(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).at) || 0 } catch { return 0 } }
const writeCursor = (n) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(cursorFile, JSON.stringify({ at: n }), 'utf8') } catch { /* a cursor we cannot persist must not break the wait */ } }

function check() {
  const msgs = chat.toArray()
  let lastMine = -1
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].by === NAME) { lastMine = i; break } }
  const from = Math.max(readCursor(), lastMine + 1)
  const hits = []
  for (let i = from; i < msgs.length; i++) {
    const m = msgs[i]
    if (rx.test(String(m.text || '')) && m.by !== NAME) hits.push(m)
  }
  // Advance past everything READ, not just everything matched — an unaddressed message I have
  // already seen must not be re-scanned on the next call either.
  if (hits.length) { writeCursor(msgs.length); finish('mention', { messages: hits.map((m) => `${m.by}(${m.kind}): ${m.text}`) }) }
}

hive.provider.on('sync', (s) => {
  if (!s) return
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
  finish('idle', { note: `nothing addressed to ${NAME} in ${IDLE_MIN} min` })
}, Number(IDLE_MIN) * 60 * 1000)
process.on('SIGINT', () => { try { hive.stop() } catch {}; process.exit(0) })
