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
//
// A REVOKE IS SIGNED TOO (14 Nov 2026). The relay used to remember a revoked invite in a file of its
// own, and the hosted relay loses its disk on every deploy, so a revoked invite came back to life.
// Now `revoke` signs the list of everyone this host has revoked (hive-revocations.js) with the room's
// key. The relay checks it against the room id, as it does an invite, and any member's client can
// hand it back to a relay that has forgotten. The list is kept in the key file and in this machine's
// cache BEFORE the relay is asked, so a revoke the relay never heard is still carried by the host's
// next join.
//
// AN INVITE IS KEPT OUT OF THE ROOM FOLDER. A token used to be written to <folder>/.hive.json, the
// host's maintainer token included, and a room folder is very often a git repository: one `git add
// -A` published it. Tokens now sit in ~/.hivecode/tokens/<room>/, one file per participant, and
// resolveRoomToken is the one place every tool asks for "my token for this room".
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { sign, decodeUnsafe, keyFingerprint, roomFingerprint, isSecuredRoom, makeSecuredRoomId } from './token.js'
import { validateMemberName } from './hive-mailbox.js'
import { relayFetch } from './hive-transport.js' // through the proxy, as every call to the relay
import { signList, mergeLists } from './hive-revocations.js'
import { loadLists, saveLists } from './hive-revocations-cache.js'

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

Take it back any time: npx -y hivecode-mcp@latest revoke ${name}${paths.length || writePaths.length ? `

What a path limit does: ${name} can open only the files named above. ${name} still sees the name of every file in the room and the whole chat, and can change the room's shared record (the file list, reviews, tasks).` : ''}`
  return { ok: true, text, link, jti }
}

const httpBase = (relay) => String(relay).replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '')

// What this host has revoked and whose invite has not yet expired: the entries of the next signed list.
function liveRevoked(rec, now) {
  const m = new Map()
  for (const e of rec.revoked || []) if (e && typeof e.jti === 'string' && e.jti && (e.exp == null || e.exp > now)) m.set(e.jti, e.exp == null ? null : e.exp)
  return m
}

/** The signed revocation lists this machine holds for a room: the host's own (from the key file)
 *  merged with what its cache has seen from the relay. What a client presents before it connects.
 *  [] for an open room. */
export function hostLists(room) {
  if (!isSecuredRoom(room)) return []
  const rec = loadRoomKey(room)
  return mergeLists(room, rec && typeof rec.list === 'string' ? [rec.list] : [], loadLists(room)).lists
}

/** Take back every live invite for a name. The host signs the list of everyone it has revoked and
 *  gives it to the relay, which refuses those invites from then on and closes any connection using
 *  them. Returns { ok, text }. */
export async function revokeInvite({ room, relay, name }) {
  const rec = loadRoomKey(room)
  if (!rec) return { ok: false, text: `This machine does not host room ${room}, so it cannot take invites back. Only the host can.` }
  const live = (rec.invites || []).filter((i) => i.name === name && !i.revokedAt)
  if (!live.length) {
    const names = [...new Set((rec.invites || []).filter((i) => !i.revokedAt).map((i) => i.name))]
    return { ok: false, text: `No live invite for "${name}" in this room.${names.length ? ` Invited: ${names.join(', ')}.` : ' Nobody has been invited yet.'}` }
  }
  // SIGNED AND KEPT BEFORE THE RELAY IS ASKED. If the relay cannot be reached, the intent is not
  // lost: the list is in the key file and in the cache this machine's client presents on its next
  // join. The invites are marked revoked only once a relay has answered, so the command can be
  // run again.
  const now = nowSec()
  const entries = liveRevoked(rec, now)
  for (const i of live) if (!(typeof i.exp === 'number' && i.exp <= now)) entries.set(i.jti, typeof i.exp === 'number' ? i.exp : null)
  rec.revoked = [...entries].map(([jti, exp]) => ({ jti, exp }))
  rec.seq = (Number.isInteger(rec.seq) && rec.seq >= 0 ? rec.seq : 0) + 1
  try { rec.list = signList(rec, { seq: rec.seq, revoked: rec.revoked }) } catch (e) { return { ok: false, text: `Could not sign the revoke (${e.message}). Nothing changed.` } }
  writeRec(rec)
  const lists = mergeLists(room, [rec.list], loadLists(room)).lists
  saveLists(room, lists)

  const base = httpBase(relay || rec.relay)
  const post = async (url, payload) => {
    const r = await relayFetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const body = await r.json().catch(() => null)
    return { r, body: body && typeof body === 'object' ? body : {} }
  }
  const kept = 'The signed revoke is kept on this machine and goes to the relay when you next join the room.'
  const mark = () => { for (const i of live) i.revokedAt = Date.now(); writeRec(rec) }
  let res
  try { res = await post('/__hive/revocations', { room, lists }) } catch (e) {
    return { ok: false, text: `Could not reach the relay to revoke ${name}'s invite (${e.message}). The relay still accepts it; run this again. ${kept}` }
  }
  if (res.r.ok && res.body.ok) {
    mark()
    if (Array.isArray(res.body.lists)) saveLists(room, mergeLists(room, lists, res.body.lists).lists)
    const dropped = Number(res.body.dropped) || 0
    // Only what this relay said of itself: `durable` is true when it keeps lists across a restart.
    const lasts = res.body.durable === true
      ? 'The revoke is signed with this room\'s key, and this relay keeps it across a restart.'
      : 'The revoke is signed with this room\'s key. This relay does not keep it across a restart by itself: every member\'s Hivecode holds a copy and hands it back when it reconnects.'
    return { ok: true, text: `Revoked ${live.length} invite(s) for ${name}. The relay refuses them from now on${dropped ? `, and closed ${dropped} connection(s) using them` : ''}.\n${lasts}` }
  }
  // A relay that knows signed lists always answers JSON with `ok` in it. One from before them has no
  // such route: it answers 404, or, as the hosted relay did, 200 with its plain "relay is up" page.
  const knowsLists = typeof res.body.ok === 'boolean' || res.r.status >= 500
  if (knowsLists) {
    return { ok: false, text: `The relay did not take the revoke for ${name} (HTTP ${res.r.status}${res.body.error ? ` ${res.body.error}` : ''}). It still accepts the invite; run this again. ${kept}` }
  }
  // A RELAY FROM BEFORE SIGNED LISTS. Tell it the old way, one id at a time, and say what that is
  // worth: it remembers until it restarts.
  const owner = mintRoomToken(rec, { name: rec.host, role: 'maintainer', ttlSec: 600 }).token
  let done = 0, dropped = 0
  const failures = []
  for (const i of live) {
    try {
      const { r, body } = await post('/__hive/revoke', { room, token: owner, jti: i.jti })
      if (r.ok && body.ok) { i.revokedAt = Date.now(); done++; dropped += Number(body.dropped) || 0 }
      else failures.push(`HTTP ${r.status}${body.error ? ` ${body.error}` : ''}`)
    } catch (e) { failures.push(e.message) }
  }
  writeRec(rec)
  if (!done) return { ok: false, text: `Could not reach the relay to revoke ${name}'s invite (${failures.join('; ')}). The relay still accepts it; run this again. ${kept}` }
  return { ok: true, text: `Revoked ${done} invite(s) for ${name}. The relay refuses them from now on${dropped ? `, and closed ${dropped} connection(s) using them` : ''}.
This relay is older than signed revokes: it will forget this one when it restarts. Update the relay to make it last. ${kept}${failures.length ? `\n${failures.length} more could not be revoked (${failures.join('; ')}); run this again.` : ''}` }
}

// ---- where a token is kept, and how every tool finds it -------------------------------------------

const dotDir = () => path.dirname(path.resolve(keysDir())) // ~/.hivecode, or wherever HIVE_KEYS_DIR put the keys
export const tokensDir = () => path.join(dotDir(), 'tokens')
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
// A room's id is a file name when it is one (every hosted room's is); a name somebody typed with
// other characters in it is hashed, so no room name can point outside the store.
const roomSeg = (room) => (/^[A-Za-z0-9_-]{1,120}$/.test(room) ? room : `r-${sha(room).slice(0, 32)}`)
const tokenFile = (room, name) => path.join(tokensDir(), roomSeg(room), `${sha(name).slice(0, 16)}.json`)
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

/** Keep a participant's token for a room, outside every room folder. One file per (room, name), so
 *  two participants on one machine keep their own invites. Returns whether it was written. */
export function saveRoomToken({ room, name = '', token }) {
  if (!room || !token || typeof token !== 'string') return false
  const p = decodeUnsafe(token)
  const who = name || (p && (p.name || p.sub)) || ''
  const f = tokenFile(room, who)
  const tmp = `${f}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmp, JSON.stringify({ room, name: who, token, at: Date.now() }), { mode: 0o600 })
    fs.renameSync(tmp, f)
    return true
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing to clean */ }
    return false
  }
}

/** The token saved for (room, name); with no name, the one saved last for the room. '' when none. */
export function savedRoomToken(room, name = '') {
  if (name) { const j = readJson(tokenFile(room, name)); return j && j.room === room && typeof j.token === 'string' ? j.token : '' }
  let best = null
  try {
    const dir = path.join(tokensDir(), roomSeg(room))
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const j = readJson(path.join(dir, f))
      if (j && j.room === room && typeof j.token === 'string' && (!best || (j.at || 0) > (best.at || 0))) best = j
    }
  } catch { /* nothing saved for this room */ }
  return best ? best.token : ''
}

/** The token to use for a room: the one place every tool asks. In order:
 *    1. `explicit`: a token passed in by hand, used exactly as given
 *    2. the token in `link` ("relay|room|token")
 *    3. $HIVE_TOKEN
 *    4. the one saved in ~/.hivecode/tokens for this room and `name` (no name: the one saved last)
 *    5. an old <dir>/.hive.json that still holds one; it is copied to the store, and with
 *       `migrate` (a join) taken out of that file
 *    6. this machine hosts the room under `name` (or no name was given): the host's own token,
 *       minted from the key and renewed before it runs out
 *  For a private room, a token made for another room is passed over at 2 to 5 rather than sent to
 *  a relay that would refuse it. Returns '' when there is none. Never prints or logs a token. */
export function resolveRoomToken({ room, name = '', dir = '', explicit = '', link = '', migrate = false, kind = 'ai', owner = '' } = {}) {
  if (explicit) return String(explicit)
  if (!room) return ''
  const secured = isSecuredRoom(room)
  const fits = (t) => {
    if (!t || typeof t !== 'string') return false
    if (!secured) return true
    const p = decodeUnsafe(t)
    return !!(p && p.pk && keyFingerprint(p.pk) === roomFingerprint(room))
  }
  const fromLink = String(link || '').split('|')[2] || ''
  const given = fits(fromLink) ? fromLink : fits(process.env.HIVE_TOKEN) ? process.env.HIVE_TOKEN : ''

  let found = savedRoomToken(room, name)
  if (!fits(found)) found = ''
  if (dir) {
    const cfgPath = path.join(path.resolve(dir), '.hive.json')
    const cfg = readJson(cfgPath)
    if (cfg && typeof cfg === 'object' && 'token' in cfg) {
      if (cfg.room === room && fits(cfg.token)) {
        // The newer of the two: an older Hivecode in this folder may have written a fresh invite
        // here after the store was filled.
        const a = decodeUnsafe(found), b = decodeUnsafe(cfg.token)
        if (!found || ((b && b.iat) || 0) > ((a && a.iat) || 0)) { found = cfg.token; saveRoomToken({ room, name, token: found }) }
      }
      if (migrate) {
        const { token: _gone, ...rest } = cfg
        try { fs.writeFileSync(cfgPath, JSON.stringify(rest, null, 2)) } catch { /* read-only folder: the join rewrites it anyway */ }
      }
    }
  }
  const use = given || found
  if (!secured) return use
  const rec = loadRoomKey(room)
  if (!rec) return use
  // With no name there is no telling whose saved invite is meant, and this machine holds the key:
  // the host's token is the one that can do whatever the tool is about to ask.
  if (!name) return given || hostToken(room, rec.host, savedRoomToken(room, rec.host), { kind, owner })
  // The host under its own name: whatever it came with is renewed from the key when it is missing
  // or about to run out, so the host is never locked out of its own room.
  return hostToken(room, name, use, { kind, owner })
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
