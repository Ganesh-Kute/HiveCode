// A member's own copy of its private rooms' revocation lists (see hive-revocations.js).
//
// The relay can forget: the hosted one keeps nothing across a deploy. So every client keeps the
// signed lists it has seen and presents them before it connects, and the first member back after a
// restart gives the relay its memory again.
//
// They sit in ~/.hivecode/revocations/<room>.json, beside the keys folder and outside every room
// folder, so the sync engine never carries them and a project never commits them. They hold no
// secret (a list names revoked invite ids, signed), but they are the user's, so the file is theirs
// alone. Nothing here verifies: callers pass what they read through mergeLists, which does.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { isSecuredRoom } from './token.js'

// Beside the keys folder, so a test (or a person) that moves the keys with HIVE_KEYS_DIR moves these too.
const dotDir = () => (process.env.HIVE_KEYS_DIR ? path.dirname(path.resolve(process.env.HIVE_KEYS_DIR)) : path.join(os.homedir(), '.hivecode'))
export const revocationsDir = () => path.join(dotDir(), 'revocations')
// A private room's id is "hs_" plus base64url, so it is a safe file name; anything else is not a
// room that has lists, and is never turned into a path.
const fileFor = (room) => (isSecuredRoom(room) && /^[A-Za-z0-9_-]{1,200}$/.test(room) ? path.join(revocationsDir(), `${room}.json`) : null)

/** The lists cached for a room: [] when there are none, or the file cannot be read. Never throws. */
export function loadLists(room) {
  const f = fileFor(room)
  if (!f) return []
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return Array.isArray(j && j.lists) ? j.lists.filter((x) => typeof x === 'string') : []
  } catch { return [] }
}

/** Replace the lists cached for a room. Written to a temporary file and renamed, so a crash leaves
 *  the old cache or the new one, never half of one. Never throws: a cache that cannot be written
 *  costs a later restore, not the join. Returns whether it was written. */
export function saveLists(room, lists) {
  const f = fileFor(room)
  if (!f || !Array.isArray(lists)) return false
  const tmp = `${f}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmp, JSON.stringify({ room, lists: lists.filter((x) => typeof x === 'string') }), { mode: 0o600 })
    fs.renameSync(tmp, f)
    return true
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
    return false
  }
}
