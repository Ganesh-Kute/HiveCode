#!/usr/bin/env node
// hive-stay -- keep an agent LISTED in a room between its listeners. The CLI's presence keeper.
//
//   npx -y -p hivecode-mcp@latest hivecode-stay "<relay|room>" <YourName> [--grace <minutes>] [--detach]
//
// WHY (Ganesh, 15 Nov 2026: "you drop the connection and leave"). An agent that drives Hivecode from
// its shell (a cloud session, no MCP engine) is in the member list only while its listener
// (hive-await.js) runs. The listener exits on every wake and on idle, so the agent drops out of the
// list until it starts the listener again, and looks gone to the people it is working with.
//
// WHAT IT IS. A presence-only connection (syncFiles: false) under the agent's name, tagged
// `keeper: true`. It is NOT `listener` and NOT `passive`, so the room keeps telling the truth with the
// code it already has (hive-activity.js stateOf): WAITING while a listener is also connected, PARKED
// when only the keeper is. A keeper must never make a deaf agent look reachable. It does not stamp
// activity when a listener wakes the app either: a wake is not proof the agent acted (the same reason
// the listener publishes HANDED and never READ, hive-await.js).
//
// IT ENDS ON ITS OWN, so a forgotten keeper never lingers:
//   - no listener for this name and room armed on this machine (hive-listen.js isArmed) for
//     `--grace` minutes (default 30);
//   - a full engine with the same name (not a listener, not a keeper) present for 30 s: presence is
//     that engine's job;
//   - a newer keeper for the same name and room started (the newest wins, as ARMED does);
//   - SIGINT / SIGTERM.
//
// `--detach` starts the keeper detached with stdio ignored, prints its pid and returns at once, so an
// agent can start it from one tool call on any OS. Nothing starts a keeper automatically.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync, parseLink } from './sync.js'
import { resolveRoomToken } from './hive-room-key.js'
import { isArmed, awaitDir } from './hive-listen.js'

const USAGE = 'usage: npx -y -p hivecode-mcp@latest hivecode-stay "<relay|room>" <YourName> [--grace <minutes>] [--detach]'
const argv = process.argv.slice(2)
const pos = []
let graceMin = 30, detach = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--detach') detach = true
  else if (a === '--grace') graceMin = Number(argv[++i])
  else if (a.startsWith('--grace=')) graceMin = Number(a.slice(8))
  else pos.push(a)
}
const [LINK = '', NAME = ''] = pos
if (!LINK || !NAME || !(graceMin > 0)) { console.error(USAGE); process.exit(2) }

if (detach) {
  const rest = argv.filter((a) => a !== '--detach')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...rest], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
  child.unref()
  console.log(`[hive-stay] "${NAME}" keeper started detached, pid ${child.pid}. It ends on its own (no listener for ${graceMin} min, a full engine under this name, a newer keeper) or on SIGTERM.`)
  process.exit(0)
}

const GRACE_MS = Number(process.env.HIVE_STAY_GRACE_MS) || graceMin * 60000
const ENGINE_MS = Number(process.env.HIVE_STAY_ENGINE_MS) || 30000
const TICK_MS = Math.min(5000, Math.max(250, Math.floor(Math.min(GRACE_MS, ENGINE_MS) / 4)))
const { relay, room } = parseLink(LINK)
const safe = (s) => String(s).replace(/[^\w.-]/g, '_')
const dir = path.join(process.env.TEMP || process.env.TMPDIR || os.tmpdir(), 'hive-presence-' + safe(NAME))
const startedAt = Date.now()

// THE NEWEST KEEPER WINS, judged by start time and never by who wrote last (the same rule as the
// listener's ARMED file, hive-await.js): a keeper yields only to one that started after it and is
// still running, and the file is written whole (a temp file renamed over it).
const KEEPER = path.join(awaitDir(NAME), `keeper-${safe(room)}.json`)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const readKeeper = () => { try { return JSON.parse(fs.readFileSync(KEEPER, 'utf8')) } catch { return null } }
const newerThanMe = (rec) => {
  const pid = Number(rec && rec.pid) || 0
  if (!pid || pid === process.pid || !alive(pid)) return false
  const at = Number(rec.at) || 0
  return at > startedAt || (at === startedAt && pid > process.pid)
}
function claim() {
  try {
    fs.mkdirSync(path.dirname(KEEPER), { recursive: true })
    const body = JSON.stringify({ pid: process.pid, name: NAME, room, at: startedAt, beat: Date.now() })
    const part = `${KEEPER}.${process.pid}.tmp`
    try { fs.writeFileSync(part, body); fs.renameSync(part, KEEPER) } catch { try { fs.rmSync(part, { force: true }) } catch { } fs.writeFileSync(KEEPER, body) }
  } catch { }
}
claim()

const hive = startSync({ relay, room, dir, name: NAME, kind: 'ai', token: resolveRoomToken({ room, name: NAME, link: LINK }), syncFiles: false, keeper: true, log: () => { } })
hive.provider.on('sync', (s) => {
  if (!s) return
  const who = hive.members().map((m) => `${m.name}(${m.kind})`).join(', ') || 'just me'
  console.log(`[hive-stay] "${NAME}" present in ${room}. In room: ${who}`)
})

let leaving = false
async function leave(why) {
  if (leaving) return
  leaving = true
  console.log(`[hive-stay] "${NAME}" leaving ${room}: ${why}`)
  try { if (Number((readKeeper() || {}).pid) === process.pid) fs.unlinkSync(KEEPER) } catch { }
  try { await hive.leave({ timeoutMs: 3000 }) } catch { try { hive.stop() } catch { } }
  process.exit(0)
}

// A full engine under this name: not this connection, not a listener, not a keeper.
const lc = NAME.toLowerCase()
const engineHere = () => {
  const me = hive.provider.awareness.clientID
  for (const [id, s] of hive.provider.awareness.getStates()) {
    const u = s && s.user
    if (id === me || !u || !u.name || String(u.name).toLowerCase() !== lc) continue
    if (u.listener || u.keeper) continue
    return true
  }
  return false
}

let lastArmed = startedAt, engineSince = 0
setInterval(() => {
  if (leaving) return
  const now = Date.now()
  if (newerThanMe(readKeeper())) return leave('a newer keeper for this name and room took over')
  claim()
  if (isArmed({ name: NAME, room })) lastArmed = now
  else if (now - lastArmed >= GRACE_MS) return leave(`no listener armed for ${NAME} on this machine for ${Math.round(GRACE_MS / 60000) || '<1'} min`)
  if (engineHere()) {
    if (!engineSince) engineSince = now
    else if (now - engineSince >= ENGINE_MS) return leave('a full engine under this name is in the room; presence is its job')
  } else engineSince = 0
}, TICK_MS)
process.on('SIGINT', () => leave('SIGINT'))
process.on('SIGTERM', () => leave('SIGTERM'))
