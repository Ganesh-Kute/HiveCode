// hive-listen.js -- how an agent stays reachable after its turn ends, in one place.
//
// THE PROBLEM (Ganesh, 4 Oct 2026): agents join a room, answer once, and go deaf. The room already
// had the answer, a background listener (hive-await.js): it blocks on the room's chat at no token
// cost and EXITS when the agent is addressed, and Claude Code and Antigravity both start a new turn
// when a background task ends. But it only works while one is running, and nothing made sure one
// was. The agent was told the command once, on its first quiet hive_wait, and had to remember to
// start it again after every wake. Agents forget, and a forgotten listener is invisible: the agent
// still looks present.
//
// ARMED is the fact the rest of the system can now check instead of trusting memory: this machine
// has a hive-await process for <name> in <room>, alive now, in the agent's own session. The listener
// writes it to a file and refreshes it; it is never a network question, because the Stop hook that
// reads it has a hard timeout and must work with the relay down.
//
// "CAN'T TELL" READS AS NOT ARMED. A false "armed" is a deaf agent nobody knows is deaf. A false
// "not armed" costs one extra start, and the newest listener replaces the old one (hive-await.js),
// so it never becomes two.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

// Claude Code stops a background task after about 30 minutes (measured 2 Oct: started 03:46,
// killed 04:16) and then tells the agent not to restart it; a listener that ends itself on idle
// can be restarted.
export const LISTEN_IDLE_MIN = 25
export const AWAIT_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hive-await.js').replace(/\\/g, '/')

// TEMP on Windows, TMPDIR on macOS. On Linux usually NEITHER is set, and the listener used to fall
// back to '.', the folder it was started in: its cursor landed in the agent's project folder, and a
// hook started from a different folder could never find it. os.tmpdir() is the same for both.
export function awaitDir(name, env = process.env) {
  return (env.TEMP || env.TMPDIR || os.tmpdir()) + '/hive-await-' + name
}
const safe = (s) => String(s).replace(/[^\w.-]/g, '_')
export function armedFile(name, room, env = process.env) {
  return path.join(awaitDir(name, env), `armed-${safe(room)}.json`)
}

// The listener refreshes the file every BEAT_MS and deletes it when it exits. A process killed
// outright cannot delete it, so a file older than FRESH_MS is not believed either. A listener that
// has not reached the relay within SYNC_GRACE_MS is not believed: one refused for want of a token
// is alive, refreshed, and hears nothing.
export const BEAT_MS = Number(process.env.HIVE_AWAIT_BEAT_MS) || 10000
export const FRESH_MS = Math.max(45000, BEAT_MS * 4)
export const SYNC_GRACE_MS = 30000

export function readArmed(name, room, env = process.env) {
  try { return JSON.parse(fs.readFileSync(armedFile(name, room, env), 'utf8')) } catch { return null }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** Is a listener for `name` in `room` running for this agent? Pass `session` when the caller knows
 *  its app's session id: a listener started in another session wakes that session, not this one. */
export function isArmed({ name, room, session = '' }, { env = process.env, now = Date.now() } = {}) {
  const a = readArmed(name, room, env)
  if (!a || !Number(a.pid)) return false
  if (now - (Number(a.beat) || 0) > FRESH_MS) return false
  if (!a.synced && now - (Number(a.at) || 0) > SYNC_GRACE_MS) return false
  if (session && a.session && a.session !== session) return false
  return alive(Number(a.pid))
}

/** The exact command an agent runs to listen. Forward slashes: bash and PowerShell both accept them. */
export function listenCommand({ relay, room, name, idleMin = LISTEN_IDLE_MIN, app = '', node = process.execPath, awaitJs = AWAIT_JS }) {
  return `"${String(node).replace(/\\/g, '/')}" "${awaitJs}" "${relay}|${room}" "${name}" ${idleMin}${app ? ` "${app}"` : ''}`
}

// Each app is told in its own tool's words; an app nobody has measured gets no order, because an
// order it cannot carry out is a false "listening".
export function listenHow(app) {
  if (/claude-code/i.test(app)) return 'Call your Bash tool now, with run_in_background: true, on this command.'
  if (/antigravity/i.test(app)) return 'Call your run_command tool now on this command, with WaitMsBeforeAsync: 1000, so it runs in the background.'
  return ''
}

export function listenOrder(how, cmd, idleMin = LISTEN_IDLE_MIN) {
  return `[BEFORE YOU END THIS TURN] Ending it stops you hearing this room. ${how} It ends, and that wakes you, when someone addresses you or after ${idleMin} quiet minutes; when it ends, run it again:\n${cmd}`
}
