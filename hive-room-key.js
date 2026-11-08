// PERSONAL ROOMS (8 Oct 2026): a room that only the people its host invites can enter.
//
// The relay already enforces this for any room whose id is "hs_<fp>_<rand>". fp is a fingerprint of
// the host's public key, every token for the room carries that key, and only the matching private
// key can sign one (server.js authorize). So a stranger holding the room's name gets nothing, even
// on the open public relay. What was missing was a way for an AGENT to make such a room: until now
// only the VS Code extension could, holding the key in the editor's secret storage.
//
// THE KEY NEVER LIVES IN A ROOM FOLDER. It sits in ~/.hivecode/keys/<room>.json, outside every
// folder the sync engine shares, so no client -- old, new or misconfigured -- can publish it.
// Whoever holds that file owns the room: lose it and nobody can invite again; copy it and the copy
// can invite too.
//
// INVITES ARE A COMMAND, NOT A TOOL. Every tool definition is paid on every request by every agent
// (tests/token-budget-test.mjs holds that to 3,500 tokens), so inviting -- something a host does a
// few times a week -- is `hivecode-mcp invite <name>`, run by the person or by an agent that has a
// shell. One link per person, carrying a token minted for them alone: an invite IS that person,
// which is why it is never pasted into the room chat (hive_say refuses tokens).
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { sign, decodeUnsafe, keyFingerprint, roomFingerprint, isSecuredRoom, makeSecuredRoomId } from './token.js'
import { validateMemberName } from './hive-mailbox.js'

export const keysDir = () => process.env.HIVE_KEYS_DIR || path.join(os.homedir(), '.hivecode', 'keys')
const keyFile = (room) => path.join(keysDir(), `${room}.json`)
const DAY = 86400
const nowSec = () => Math.floor(Date.now() / 1000)

/** A new personal room, in memory only: nothing is written until the join is allowed to go ahead. */
export function newPersonalRoom() {
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKey = kp.publicKey.export({ type: 'spki', format: 'pem' })
  const privateKey = kp.privateKey.export({ type: 'pkcs8', format: 'pem' })
  return { room: makeSecuredRoomId(publicKey, crypto.randomBytes(6).toString('hex')), publicKey, privateKey }
}

export function saveRoomKey(k, { relay, host }) {
  fs.mkdirSync(keysDir(), { recursive: true, mode: 0o700 })
  const rec = { room: k.room, relay, host, publicKey: k.publicKey, privateKey: k.privateKey, created: Date.now(), invites: [] }
  // 'wx': a fresh room never overwrites a key that exists, which would orphan the room it opened.
  fs.writeFileSync(keyFile(k.room), JSON.stringify(rec, null, 2), { mode: 0o600, flag: 'wx' })
  return rec
}

/** The key record for a personal room this machine hosts, or null. A file whose key does not match
 *  the room's fingerprint is treated as absent: it would only mint tokens the relay refuses. */
export function loadRoomKey(room) {
  if (!isSecuredRoom(room)) return null
  try {
    const rec = JSON.parse(fs.readFileSync(keyFile(room), 'utf8'))
    return rec && rec.privateKey && keyFingerprint(rec.publicKey) === roomFingerprint(room) ? rec : null
  } catch { return null }
}
const writeRec = (rec) => fs.writeFileSync(keyFile(rec.room), JSON.stringify(rec, null, 2), { mode: 0o600 })

/** The same claims the extension mints (extension.js mintToken), so either can host and the relay
 *  cannot tell them apart. paths = what they may SEE; writePaths = the part of it they may EDIT. */
export function mintRoomToken(rec, { name, kind = 'ai', role = 'writer', paths, writePaths, owner, ttlSec = 7 * DAY }) {
  const now = nowSec()
  const jti = 'jti-' + crypto.randomBytes(9).toString('base64url')
  const payload = {
    iss: 'hivecode', sub: name, name, kind, ...(owner ? { owner } : {}),
    pk: rec.publicKey, // self-certifying: the relay binds this key to the room id
    scopes: [{ room: rec.room, role, ...(paths && paths.length ? { paths } : {}), ...(writePaths && writePaths.length ? { writePaths } : {}) }],
    iat: now, exp: now + ttlSec, jti,
  }
  return { token: sign(payload, { privateKey: rec.privateKey }), jti, exp: payload.exp }
}

/** The host's own token, minted afresh when it is missing or within an hour of running out: the host
 *  holds the key, so its own access must never lapse. Only for the name the room was hosted under --
 *  another participant on this machine, joining with its own invite, keeps its own narrower grant. */
export function hostToken(room, name, current, { kind = 'ai', owner = '' } = {}) {
  const rec = loadRoomKey(room)
  if (!rec || rec.host !== name) return current
  const p = current ? decodeUnsafe(current) : null
  const fresh = !!(p && p.sub === name && p.exp > nowSec() + 3600 && p.pk && keyFingerprint(p.pk) === roomFingerprint(room))
  return fresh ? current : mintRoomToken(rec, { name, kind, role: 'maintainer', owner, ttlSec: 30 * DAY }).token
}

// A path a token may name: relative, no "..", no drive or root. Globs are fine ("src/**", "!**/*.env").
function badPath(g) {
  const s = String(g).replace(/^!/, '')
  return !s || s.length > 200 || /^([A-Za-z]:|[\\/])/.test(s) || /(^|[\\/])\.\.([\\/]|$)/.test(s) || /[\x00-\x1f]/.test(s)
}
const list = (v) => (v == null || v === true ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean))
const when = (sec) => new Date(sec * 1000).toISOString().slice(0, 10)

function whatTheyGet(i) {
  const see = i.paths && i.paths.length ? i.paths.join(', ') : 'every file in the room'
  const edit = i.role === 'reader' ? 'read only' : i.writePaths && i.writePaths.length ? `may edit ${i.writePaths.join(', ')}` : 'may edit what they see'
  return `${i.kind}, ${i.role}: sees ${see}; ${edit}`
}

/** Make one person's invite. Returns { ok, text, link?, jti? }. */
export function makeInvite({ room, relay, name, kind = 'ai', reader = false, paths = [], writePaths = [], days = 7, owner = '' }) {
  const rec = loadRoomKey(room)
  if (!rec) {
    return { ok: false, text: isSecuredRoom(room)
      ? `Only the machine that hosted this personal room can invite people to it, and this one does not hold its key (${keysDir()}). Ask the host.`
      : `Room ${room} is open: anyone with its link can join, so there is nothing to invite into. For a room only invited people can enter, host one with hive_join and private: true.` }
  }
  const nc = validateMemberName(name)
  if (!nc.ok) return { ok: false, text: `${nc.error}\nNothing was minted.` }
  if (name === rec.host) return { ok: false, text: `"${name}" is the host of this room. Pick the invitee's own name.\nNothing was minted.` }
  const bad = [...paths, ...writePaths].filter(badPath)
  if (bad.length) return { ok: false, text: `These paths cannot go in an invite (they must be relative, with no ".."): ${bad.join(', ')}\nNothing was minted.` }
  const d = Number(days)
  if (!Number.isFinite(d) || d <= 0 || d > 30) return { ok: false, text: `--days must be between 1 and 30 (got ${days}). A short invite is one you never have to remember to take back.\nNothing was minted.` }
  const k = kind === 'human' ? 'human' : 'ai'
  const role = reader ? 'reader' : 'writer'
  const { token, jti, exp } = mintRoomToken(rec, { name, kind: k, role, paths, writePaths, owner, ttlSec: Math.round(d * DAY) })
  const inv = { jti, name, kind: k, role, paths: paths.length ? paths : null, writePaths: writePaths.length ? writePaths : null, exp, at: Date.now() }
  rec.invites = [...(rec.invites || []), inv]
  writeRec(rec)
  const link = `${relay || rec.relay}|${room}|${token}`
  const text = `INVITE for ${name} (${whatTheyGet(inv)}), until ${when(exp)}.
Send it to ${name} directly, never in the room chat: whoever holds this link joins as ${name}.

  Join my Hivecode room. In a terminal, run this once (needs Node.js 18+), then do what it prints:
    npx -y hivecode-mcp@latest setup "${link}"

Take it back any time: npx -y hivecode-mcp@latest revoke ${name}`
  return { ok: true, text, link, jti }
}

const httpBase = (relay) => String(relay).replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '')

/** Take back every live invite for a name. The relay refuses those tokens from then on and closes any
 *  connection using them. Returns { ok, text }. */
export async function revokeInvite({ room, relay, name }) {
  const rec = loadRoomKey(room)
  if (!rec) return { ok: false, text: `This machine does not host room ${room}, so it cannot take invites back. Only the host can.` }
  const live = (rec.invites || []).filter((i) => i.name === name && !i.revokedAt)
  if (!live.length) {
    const names = [...new Set((rec.invites || []).filter((i) => !i.revokedAt).map((i) => i.name))]
    return { ok: false, text: `No live invite for "${name}" in this room.${names.length ? ` Invited: ${names.join(', ')}.` : ' Nobody has been invited yet.'}` }
  }
  const owner = mintRoomToken(rec, { name: rec.host, role: 'maintainer', ttlSec: 600 }).token
  let done = 0, dropped = 0
  const failures = []
  for (const i of live) {
    try {
      const r = await fetch(`${httpBase(relay || rec.relay)}/__hive/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, token: owner, jti: i.jti }) })
      const body = await r.json().catch(() => ({}))
      if (r.ok && body.ok) { i.revokedAt = Date.now(); done++; dropped += Number(body.dropped) || 0 }
      else failures.push(`HTTP ${r.status}${body.error ? ` ${body.error}` : ''}`)
    } catch (e) { failures.push(e.message) }
  }
  writeRec(rec)
  if (!done) return { ok: false, text: `Could not reach the relay to revoke ${name}'s invite (${failures.join('; ')}). Nothing changed; try again.` }
  return { ok: true, text: `Revoked ${done} invite(s) for ${name}. The relay refuses them from now on${dropped ? `, and closed ${dropped} connection(s) using them` : ''}.${failures.length ? `\n${failures.length} more could not be revoked (${failures.join('; ')}); run this again.` : ''}` }
}

// ---- the command line: hivecode-mcp invite <name> ... | hivecode-mcp revoke <name> ----

function parseArgs(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const key = a.slice(2)
    if (['reader', 'human'].includes(key)) o[key] = true
    else o[key] = argv[++i]
  }
  return o
}

// Which room: --dir's .hive.json, else this folder's, else the only room this machine hosts.
function findRoom(o) {
  const dir = path.resolve(o.dir || '.')
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, '.hive.json'), 'utf8'))
    if (c && c.room) return { room: c.room, relay: c.relay || '' }
  } catch { /* not a room folder */ }
  let mine = []
  try { mine = fs.readdirSync(keysDir()).filter((f) => f.endsWith('.json')).map((f) => loadRoomKey(f.slice(0, -5))).filter(Boolean) } catch { /* no keys yet */ }
  if (mine.length === 1) return { room: mine[0].room, relay: mine[0].relay }
  return { error: mine.length
    ? `${dir} is not a room folder, and this machine hosts ${mine.length} personal rooms. Say which with --dir <the room's folder>:\n${mine.map((r) => `  ${r.room}  (host ${r.host}, created ${new Date(r.created).toISOString().slice(0, 10)})`).join('\n')}`
    : `${dir} is not a room folder, and this machine hosts no personal room. Host one first: hive_join with private: true.` }
}

const USAGE = `Usage:
  hivecode-mcp invite <name> [--reader] [--human] [--paths a,b] [--edit a,b] [--days 7] [--owner <their human>] [--dir <room folder>]
  hivecode-mcp revoke <name> [--dir <room folder>]

  --reader   they can read but not edit       --paths  only these folders/globs are visible to them
  --human    the invitee is a person, not AI  --edit   of what they see, only these may be edited
  --days     how long the invite lasts (default 7, at most 30)`

export async function main(argv) {
  const cmd = argv[0]
  const o = parseArgs(argv.slice(1))
  const name = o._[0]
  if (!name) { console.log(USAGE); return 2 }
  const where = findRoom(o)
  if (where.error) { console.log(where.error); return 1 }
  if (cmd === 'revoke') {
    const r = await revokeInvite({ room: where.room, relay: where.relay, name })
    console.log(r.text)
    return r.ok ? 0 : 1
  }
  const r = makeInvite({ room: where.room, relay: where.relay, name, kind: o.human ? 'human' : 'ai', reader: !!o.reader, paths: list(o.paths), writePaths: list(o.edit), days: o.days == null ? 7 : o.days, owner: o.owner || '' })
  console.log(r.text)
  return r.ok ? 0 : 1
}
