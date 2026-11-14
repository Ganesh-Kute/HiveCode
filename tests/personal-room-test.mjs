// PERSONAL ROOMS: an agent can host a room that only the people it invites can enter.
//
//   node tests/personal-room-test.mjs
//
// On 8 Oct 2026 our own room "night" turned out to be readable by anyone who typed its name: on an
// open relay a room's name is its only key. hive_join could host only that kind of room; a room that
// checks invites (an hs_ id, tokens signed by the host's key) could be made only from VS Code. Now an
// agent hosts one with private: true, and `hivecode-mcp invite <name>` makes one person's link.
//
// The relay here is OPEN, like the public one: a personal room must keep strangers out without the
// relay being set up for it.
//
//   P1  hive_join private:true hosts a personal room: an hs_ id whose fingerprint is the host's key
//   P2  the room's key sits outside the room folder, and no file in the room folder holds it
//   P3  the host's own token is a maintainer grant, signed by that key
//   P4  the join reply says how to invite, and offers no link that would not work
//   P5  a stranger with the room's link alone is refused, and receives none of its files
//   P6  invite makes a link for one person: their name, signed by the room's key, never the host's token
//   P7  the invited agent joins with that link and gets the files; its edit reaches the host
//   P8  a reader invite sees the files, and its edit does not reach the host
//   P9  a --paths invite sees only those folders
//   P10 revoke closes the guest's live connection, refuses it from then on, and its edits stop arriving
//   P11 invite mints nothing in an open room, or for a personal room whose key is not on this machine
//   P12 private together with a link is refused, and the session in the personal room is untouched
//   P13 a host whose own token has run out rejoins: renewed from the key, not refused
//   P14 hive_status says the room is personal and that this agent hosts it
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import http from 'http'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { decodeUnsafe, verify, keyFingerprint, roomFingerprint } from '../token.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync } = await import('../sync.js')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms, step = 250) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-personal-'))
const KEYS = path.join(TMP, 'keys')
process.env.HIVE_KEYS_DIR = KEYS // for this process's own reads of the key file
const K = await import('../hive-room-key.js').catch(() => null) // absent before personal rooms: each check then fails on its own

const PORT = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '25', HIVE_ENFORCE_CLAIMS: '', HIVE_AUTH_MODE: '', HIVE_ROOM_REVOKED_FILE: path.join(TMP, 'revoked.json') },
})
const healthy = () => new Promise((res) => { const q = http.get(`http://127.0.0.1:${PORT}/health`, (r) => { r.resume(); res(r.statusCode === 200) }); q.on('error', () => res(false)) })
for (let i = 0; i < 60 && !(await healthy()); i++) await sleep(250)
const RELAY = `ws://127.0.0.1:${PORT}`
const kids = [], syncs = []
process.on('exit', () => {
  for (const k of kids) { try { k.kill() } catch { } }
  for (const s of syncs) { try { s.stop() } catch { } }
  try { relay.kill() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})
const client = (o) => { const s = startSync({ relay: RELAY, kind: 'ai', log: () => { }, ...o }); syncs.push(s); return s }
const connected = (s) => { try { return !!s.connection().connected } catch { return false } }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'hive-mcp.js'), ...args], { cwd: TMP, encoding: 'utf8', timeout: 30000, env: { ...process.env, HIVE_KEYS_DIR: KEYS, HIVE_TOKEN: '' } })
const linkIn = (out) => { const m = /setup "([^"]+)"/.exec(out || ''); return m ? m[1] : '' }

// An agent through its own MCP server. `keys` stands for that machine's ~/.hivecode/keys: the host's
// holds the room key, a guest's holds none.
const mcpAgent = (cwdName, keys) => {
  const cwd = path.join(TMP, cwdName); fs.mkdirSync(cwd, { recursive: true })
  const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], { cwd, env: { ...process.env, HIVE_HOME: path.join(TMP, 'home'), HIVE_KEYS_DIR: keys, HIVE_RELAY: RELAY, HIVE_TOKEN: '' } })
  kids.push(p)
  let buf = '', nextId = 1
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} })
    const c = r && r.result && r.result.content
    return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : JSON.stringify(r)
  }
  return { rpc, call, notify: (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') }
}
const started = async (a) => { await a.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } }); a.notify('notifications/initialized'); return a }
const agent = await started(mcpAgent('host-mcp', KEYS)) // the host's agent

const HOST = path.join(TMP, 'host')
const banner = await agent.call('hive_join', { private: true, name: 'Host', dir: HOST })
const room = (/^room: (\S+)/m.exec(banner) || [])[1] || ''
const keyFile = path.join(KEYS, `${room}.json`)
const rec = K ? K.loadRoomKey(room) : null

console.log('\n# a personal room, hosted by an agent')
T('P1 private:true hosts a personal room: an hs_ id whose fingerprint is the host\'s own key',
  /^hs_/.test(room) && !!rec && keyFingerprint(rec.publicKey) === roomFingerprint(room) && !/NOT JOINED/.test(banner), banner.slice(0, 160))
const roomFiles = []
;(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : roomFiles.push(f) } })(HOST)
// Matched on a line of the ROOM's key itself: every room folder also holds .hive-id.json, the
// client's own signing identity, which is a private key too and is never synced (sync.js ALWAYS_IGNORE).
const keyLine = rec ? rec.privateKey.split(/\r?\n/)[1] : '(no key)'
const holding = roomFiles.filter((f) => (read(f) || '').includes(keyLine))
T('P2 the room\'s key sits outside the room folder, and no file in the room folder holds it',
  fs.existsSync(keyFile) && path.relative(HOST, keyFile).startsWith('..') && !!rec && holding.length === 0, `${keyFile} | in the folder: ${holding.map((f) => path.basename(f)).join(', ') || 'nothing'}`)
// The host's token is kept in ~/.hivecode/tokens (beside the keys), not in the room folder.
const hostTok = (K && K.savedRoomToken ? K.savedRoomToken(room, 'Host') : '') || ''
const hp = decodeUnsafe(hostTok) || {}
T('P2b no file in the room folder holds the host\'s token, .hive.json included',
  !!hostTok && !('token' in JSON.parse(read(path.join(HOST, '.hive.json')) || '{}')) && roomFiles.every((f) => !(read(f) || '').includes(hostTok)),
  `in the folder: ${roomFiles.filter((f) => hostTok && (read(f) || '').includes(hostTok)).map((f) => path.basename(f)).join(', ') || 'nothing'}`)
T('P3 the host\'s own token is a maintainer grant, signed by that key',
  hp.sub === 'Host' && hp.scopes && hp.scopes[0].role === 'maintainer' && verify(hostTok, { publicKey: hp.pk, alg: 'RS256' }).ok, JSON.stringify({ sub: hp.sub, scopes: hp.scopes }).slice(0, 160))
T('P4 the join reply says how to invite, and offers no link that would not work',
  /PERSONAL ROOM/.test(banner) && /hivecode-mcp@latest invite/.test(banner) && !/forward this as is/.test(banner) && !/^invite link:/m.test(banner),
  banner.split('\n').filter((l) => /invite|PERSONAL|link/i.test(l)).join(' / ').slice(0, 300))

// What the room holds: the host writes two files, one in docs/.
fs.writeFileSync(path.join(HOST, 'app.js'), 'export const app = 1 // by Host\n')
fs.mkdirSync(path.join(HOST, 'docs'), { recursive: true })
fs.writeFileSync(path.join(HOST, 'docs', 'readme.md'), '# docs by Host\n')
await sleep(2500)

console.log('\n# a stranger with only the room\'s name')
const SDIR = path.join(TMP, 'stranger')
const stranger = client({ room, dir: SDIR, name: 'Stranger', token: '' })
await sleep(6000)
T('P5 a stranger with the room\'s link alone is refused, and receives none of its files',
  !connected(stranger) && !fs.existsSync(path.join(SDIR, 'app.js')) && !fs.existsSync(path.join(SDIR, 'docs', 'readme.md')))
try { stranger.stop() } catch { }

console.log('\n# invites, one person each')
const inv = cli('invite', 'Guest', '--dir', HOST)
const gLink = linkIn(inv.stdout)
const gTok = gLink.split('|')[2] || ''
const gp = decodeUnsafe(gTok) || {}
T('P6 invite makes a link for one person: their name, signed by the room\'s key, never the host\'s token',
  inv.status === 0 && gp.sub === 'Guest' && gp.scopes && gp.scopes[0].room === room && gp.scopes[0].role === 'writer' &&
  verify(gTok, { publicKey: gp.pk, alg: 'RS256' }).ok && keyFingerprint(gp.pk) === roomFingerprint(room) && gTok !== hostTok && !(inv.stdout || '').includes(hostTok),
  `status ${inv.status}: ${(inv.stdout || inv.stderr || '').slice(0, 200)}`)

const GDIR = path.join(TMP, 'guest')
const guest = client({ room, dir: GDIR, name: 'Guest', token: gTok })
const gotFiles = await until(() => read(path.join(GDIR, 'app.js')) === read(path.join(HOST, 'app.js')), 20000)
fs.writeFileSync(path.join(GDIR, 'guest-note.js'), 'export const note = "from Guest"\n')
const reached = await until(() => /from Guest/.test(read(path.join(HOST, 'guest-note.js')) || ''), 20000)
T('P7 the invited agent joins with that link and gets the files; its edit reaches the host', gotFiles && reached, `files ${gotFiles}, edit back ${reached}`)

const vOut = cli('invite', 'Viewer', '--reader', '--dir', HOST)
const VDIR = path.join(TMP, 'viewer')
const viewer = client({ room, dir: VDIR, name: 'Viewer', token: (linkIn(vOut.stdout).split('|')[2] || '') })
const vSees = await until(() => fs.existsSync(path.join(VDIR, 'app.js')), 20000)
fs.writeFileSync(path.join(VDIR, 'app.js'), 'HACKED by Viewer\n')
await sleep(5000)
T('P8 a reader invite sees the files, and its edit does not reach the host',
  vOut.status === 0 && vSees && read(path.join(HOST, 'app.js')) === 'export const app = 1 // by Host\n', `sees ${vSees}, host app.js now ${JSON.stringify(read(path.join(HOST, 'app.js')))}`)
try { viewer.stop() } catch { }

const dOut = cli('invite', 'Docs', '--paths', 'docs', '--dir', HOST)
const DDIR = path.join(TMP, 'docsonly')
const docsOnly = client({ room, dir: DDIR, name: 'Docs', token: (linkIn(dOut.stdout).split('|')[2] || '') })
const dSees = await until(() => fs.existsSync(path.join(DDIR, 'docs', 'readme.md')), 20000)
await sleep(3000)
T('P9 a --paths invite sees only those folders', dOut.status === 0 && dSees && !fs.existsSync(path.join(DDIR, 'app.js')), `docs ${dSees}, app.js ${fs.existsSync(path.join(DDIR, 'app.js'))}`)
try { docsOnly.stop() } catch { }

console.log('\n# taking an invite back')
const rOut = cli('revoke', 'Guest', '--dir', HOST)
const cut = await until(() => !connected(guest), 10000)
await sleep(3000)
fs.writeFileSync(path.join(GDIR, 'after-revoke.js'), 'export const late = "from Guest after revoke"\n')
await sleep(6000)
const again = client({ room, dir: path.join(TMP, 'guest-again'), name: 'Guest', token: gTok })
await sleep(6000)
T('P10 revoke closes the guest\'s live connection, refuses it from then on, and its edits stop arriving',
  rOut.status === 0 && /Revoked 1 invite/.test(rOut.stdout) && /closed \d+ connection/.test(rOut.stdout) && cut && !connected(guest) &&
  !fs.existsSync(path.join(HOST, 'after-revoke.js')) && !connected(again),
  `status ${rOut.status}: ${(rOut.stdout || '').trim().slice(0, 160)} | cut ${cut} | late file at host ${fs.existsSync(path.join(HOST, 'after-revoke.js'))} | rejoined ${connected(again)}`)
try { guest.stop(); again.stop() } catch { }

console.log('\n# refusals')
const OPEN = path.join(TMP, 'open-room'); fs.mkdirSync(OPEN, { recursive: true })
fs.writeFileSync(path.join(OPEN, '.hive.json'), JSON.stringify({ relay: RELAY, room: 'room-openxyz' }))
const oOut = cli('invite', 'X', '--dir', OPEN)
const NOKEY = path.join(TMP, 'not-mine'); fs.mkdirSync(NOKEY, { recursive: true })
fs.writeFileSync(path.join(NOKEY, '.hive.json'), JSON.stringify({ relay: RELAY, room: K ? K.newPersonalRoom().room : 'hs_AAAAAAAAAAAAAAAAAAAAAA_000000000000' }))
const nOut = cli('invite', 'X', '--dir', NOKEY)
T('P11 invite mints nothing in an open room, or for a personal room whose key is not on this machine',
  oOut.status === 1 && /is open/.test(oOut.stdout) && !linkIn(oOut.stdout) && nOut.status === 1 && /does not hold its key/.test(nOut.stdout) && !linkIn(nOut.stdout),
  `${oOut.status}: ${(oOut.stdout || '').slice(0, 90)} | ${nOut.status}: ${(nOut.stdout || '').slice(0, 90)}`)

const mixed = await agent.call('hive_join', { private: true, link: `${RELAY}|room-elsewhere` })
const st1 = JSON.parse(await agent.call('hive_status', {}))
T('P12 private together with a link is refused, and the session in the personal room is untouched',
  /cannot be combined/.test(mixed) && /untouched/.test(mixed) && st1.room === room, `${mixed.slice(0, 100)} | still in ${String(st1.room).slice(0, 20)}`)

console.log('\n# the host comes back after its own token ran out')
await agent.call('hive_leave', {})
const cfg = JSON.parse(read(path.join(HOST, '.hive.json')))
cfg.token = K && rec ? K.mintRoomToken(rec, { name: 'Host', role: 'maintainer', ttlSec: -60 }).token : 'expired'
fs.writeFileSync(path.join(HOST, '.hive.json'), JSON.stringify(cfg, null, 2))
const back = await agent.call('hive_join', { dir: HOST, name: 'Host' })
const renewed = decodeUnsafe(K && K.savedRoomToken ? K.savedRoomToken(room, 'Host') : '') || {}
T('P13b the old token is taken out of .hive.json by that join', !('token' in JSON.parse(read(path.join(HOST, '.hive.json')))))
const st2 = JSON.parse(await agent.call('hive_status', {}))
T('P13 a host whose own token has run out rejoins: renewed from the key, not refused',
  !/NOT JOINED/.test(back) && renewed.exp > Math.floor(Date.now() / 1000) + 86400 && st2.connected === true, `${back.split('\n')[0]} | exp ${renewed.exp} | connected ${st2.connected}`)
T('P14 hive_status says the room is personal and that this agent hosts it', /^personal/.test(st2.access || '') && /you host it/.test(st2.access || ''), st2.access)

console.log('\n# an invited agent comes back without its link')
{
  // P15: the invite used to be written into the guest's room folder (.hive.json), which is how a
  // re-join found it, and how a `git add -A` published it. It is kept in ~/.hivecode/tokens now.
  const GKEYS = path.join(TMP, 'visitor-home', 'keys') // another machine: no room key here
  const VDIR = path.join(TMP, 'visitor')
  const vLink = linkIn(cli('invite', 'Visitor', '--dir', HOST).stdout)
  const vTok = vLink.split('|')[2] || ''
  const visitor = await started(mcpAgent('visitor-mcp', GKEYS))
  const first = await visitor.call('hive_join', { link: vLink, name: 'Visitor', dir: VDIR })
  const gotIn = !/NOT JOINED/.test(first) && await until(() => read(path.join(VDIR, 'app.js')) === read(path.join(HOST, 'app.js')), 20000)
  const vFiles = []
  ;(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : vFiles.push(f) } })(VDIR)
  const leaks = vFiles.filter((f) => vTok && (read(f) || '').includes(vTok))
  T('P15 the invited agent joins, and no file in its room folder holds its invite', gotIn && !!vTok && leaks.length === 0, `joined ${gotIn} | in the folder: ${leaks.map((f) => path.basename(f)).join(', ') || 'nothing'}`)
  T('P15 the invite is kept beside that machine\'s keys folder', fs.existsSync(path.join(TMP, 'visitor-home', 'tokens', room)))
  await visitor.call('hive_leave', {})
  const again = await visitor.call('hive_join', { dir: VDIR, name: 'Visitor' })
  const st = JSON.parse(await visitor.call('hive_status', {}))
  T('P15 it comes back with no link: the saved invite lets it in', !/NOT JOINED/.test(again) && st.connected === true && st.room === room, `${again.split('\n')[0]} | connected ${st.connected}`)
  const hostFile = path.join(HOST, 'after-rejoin.js')
  fs.writeFileSync(hostFile, 'export const after = "rejoin"\n')
  T('P15 and it is really in: a file the host writes now reaches it', await until(() => read(path.join(VDIR, 'after-rejoin.js')) === read(hostFile), 20000))
}

console.log(`\n=== PERSONAL ROOMS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
