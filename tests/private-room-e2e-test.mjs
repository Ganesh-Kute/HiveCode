// The private-room promise, end to end, with the real pieces from every side: the host's key file and
// CLI functions (hive-room-key.js), real clients (sync.js), a real relay (server.js) with NO disk.
//
//   "Only the people I invited can see my code and my chat, and the moment I revoke someone they are
//    out. Everywhere. For good."
//
//   J1  invited people get in; an outsider and a made-up token do not
//   J2  everyone sees the chat
//   J3  revoke: the guest is cut off at once, its client says why and stops retrying
//   J4  THE RELAY RESTARTS WITH NO DISK (a deploy). The members' clients reconnect by themselves.
//       A revoked guest dialing again must be refused, and must not read what is said after the restart.
//       The "attacker" is a separate process with its own home folder: it holds only the revoked
//       invite, never the revocation list.
//   J5  the same when the host is OFFLINE across the restart: a member's client alone restores the list
//
//   node tests/private-room-e2e-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1395
const RELAY = `ws://127.0.0.1:${PORT}`
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-private-e2e-'))
// Three "computers": the host's, the member's, the guest's. Each has its own ~/.hivecode.
const home = (who) => { const d = path.join(tmp, who, 'keys'); fs.mkdirSync(d, { recursive: true }); return d }
const HOST_KEYS = home('host'), MEMBER_KEYS = home('member'), GUEST_KEYS = home('guest')
process.env.HIVE_KEYS_DIR = HOST_KEYS                  // this process is the host's computer
delete process.env.HIVE_TOKEN
const RK = await import('../hive-room-key.js')
const { startSync, parseLink } = await import('../sync.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150) } return null }
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra && !c ? `   ${String(extra).slice(0, 300)}` : ''}`); c ? pass++ : fail++ }

const kids = []
let relay = null
async function bootRelay() {
  const cwd = fs.mkdtempSync(path.join(tmp, 'relay-'))          // a fresh folder every boot: no disk survives
  fs.writeFileSync(path.join(cwd, 'server.js'), `import ${JSON.stringify(path.join(ROOT, 'server.js'))}\n`)
  const r = spawn(process.execPath, ['server.js'], { cwd, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_ROOM_REVOKED_FILE: path.join(cwd, 'revoked.json') } })
  kids.push(r)
  r.stderr.on('data', () => { })
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('relay did not start')), 15000); r.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } }) })
  relay = r
}
const killRelay = async () => { relay.kill(); await new Promise((r) => relay.once('exit', r)); await sleep(300) }

/** A participant on ANOTHER computer: a child process with its own home. It joins with its invite
 *  link, prints every chat line it ever sees as "CHAT <text>", its connection state on request. */
const PEER = path.join(tmp, 'peer.mjs')
fs.writeFileSync(PEER, `
import { startSync, parseLink } from ${JSON.stringify(path.join(ROOT, 'sync.js'))}
const [, , link, name, dir] = process.argv
const { relay, room, token } = parseLink(link)
const hive = startSync({ relay, room, dir, name, kind: 'ai', token, syncFiles: false, log: () => {} })
const seen = new Set()
const dump = () => { for (const m of hive.doc.getArray('chat').toArray()) { const t = String(m.text || ''); if (!seen.has(t)) { seen.add(t); console.log('CHAT ' + t) } } }
hive.doc.getArray('chat').observe(dump)
setInterval(() => { dump(); const c = hive.connection(); console.log('STATE ' + JSON.stringify({ connected: !!c.connected, stopped: !!c.authStopped })) }, 500)
process.on('message', (m) => { if (m && m.say) hive.doc.getArray('chat').push([{ by: name, kind: 'ai', at: '', text: m.say }]) })
`)
function peer(link, name, keys) {
  const dir = fs.mkdtempSync(path.join(tmp, `${name}-dir-`))
  const p = spawn(process.execPath, [PEER, link, name, dir], { cwd: dir, env: { ...process.env, HIVE_KEYS_DIR: keys, TEMP: dir, TMPDIR: dir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  kids.push(p)
  const st = { p, chat: [], state: { connected: false, stopped: false }, err: '' }
  let buf = ''
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.startsWith('CHAT ')) st.chat.push(line.slice(5)); else if (line.startsWith('STATE ')) { try { st.state = JSON.parse(line.slice(6)) } catch { } } } })
  p.stderr.on('data', (d) => { st.err += d })
  return st
}
const dial = (room, token) => new Promise((res) => {
  const ws = new WebSocket(`${RELAY}/${room}${token ? `?token=${token}` : ''}`)
  ws.once('open', () => { res({ open: true, ws }) })
  ws.once('unexpected-response', (_q, r) => res({ open: false, status: r.statusCode }))
  ws.once('error', () => res({ open: false, status: 0 }))
})

try {
  await bootRelay()
  // ---- the host makes a private room and invites two people
  const key = RK.newPersonalRoom()
  RK.saveRoomKey(key, { relay: RELAY, host: 'Host' })
  const room = key.room
  const hostDir = fs.mkdtempSync(path.join(tmp, 'host-dir-'))
  const host = startSync({ relay: RELAY, room, dir: hostDir, name: 'Host', kind: 'human', syncFiles: false, log: () => { } })   // no token given: the host's own
  const say = (text) => host.doc.getArray('chat').push([{ by: 'Host', kind: 'human', at: '', text }])
  const invMember = RK.makeInvite({ room, relay: RELAY, name: 'Member' })
  const invGuest = RK.makeInvite({ room, relay: RELAY, name: 'Guest' })
  if (!invMember.ok || !invGuest.ok) throw new Error('invite failed: ' + (invMember.text || invGuest.text))
  const guestToken = parseLink(invGuest.link).token

  console.log('\n# J1 only invited people get in')
  T('J1a the host is in with no token of its own to paste', !!(await until(() => host.connection().connected)), JSON.stringify(host.connection()))
  const member = peer(invMember.link, 'Member', MEMBER_KEYS)
  const guest = peer(invGuest.link, 'Guest', GUEST_KEYS)
  T('J1b the member is in', !!(await until(() => member.state.connected)), member.err.slice(-200))
  T('J1c the guest is in', !!(await until(() => guest.state.connected)), guest.err.slice(-200))
  T('J1d an outsider with no invite is refused', (await dial(room, '')).status === 401)
  T('J1e a made-up token is refused', (await dial(room, 'aaa.bbb.ccc')).status === 401)

  console.log('\n# J2 everyone sees the chat')
  say('before-revoke')
  T('J2 member and guest both read it', !!(await until(() => member.chat.includes('before-revoke') && guest.chat.includes('before-revoke'))), JSON.stringify([member.chat, guest.chat]))

  console.log('\n# J3 revoke')
  const rv = await RK.revokeInvite({ room, relay: RELAY, name: 'Guest' })
  T('J3a revoke succeeds', rv.ok === true, rv.text)
  T('J3b and tells the host this relay will not remember by itself', /restart/i.test(rv.text || ''), rv.text)
  T('J3c the guest\'s client is cut off and stops retrying', !!(await until(() => guest.state.stopped && !guest.state.connected)), JSON.stringify(guest.state))
  say('after-revoke')
  await until(() => member.chat.includes('after-revoke'))
  await sleep(800)
  T('J3d the member reads what is said next; the guest does not', member.chat.includes('after-revoke') && !guest.chat.includes('after-revoke'), JSON.stringify([member.chat, guest.chat]))
  T('J3e the revoked invite is refused on a new dial', (await dial(room, guestToken)).status === 401)

  console.log('\n# J4 the relay restarts with no disk; host and member reconnect by themselves')
  await killRelay(); await bootRelay()
  T('J4a host and member are back without anyone doing anything', !!(await until(() => host.connection().connected && member.state.connected, 20000)), JSON.stringify([host.connection(), member.state]))
  const again = await dial(room, guestToken)
  T('J4b the revoked invite is refused by the restarted relay', !again.open && again.status === 401, `open=${again.open} status=${again.status}`)
  // the attacker: a fresh process, only the revoked invite, its own empty home
  const attacker = peer(invGuest.link, 'Guest', home('attacker'))
  say('after-restart')
  await until(() => member.chat.includes('after-restart'))
  await sleep(2500)
  T('J4c the member reads what is said after the restart', member.chat.includes('after-restart'), JSON.stringify(member.chat))
  T('J4d the revoked guest, dialing again from a clean machine, reads none of it', !attacker.chat.includes('after-restart') && !attacker.chat.includes('after-revoke'), JSON.stringify(attacker.chat))
  T('J4e and is not connected', !attacker.state.connected, JSON.stringify(attacker.state))
  attacker.p.kill()

  console.log('\n# J5 the host is offline across a restart: a member alone restores the list')
  host.stop()
  await sleep(500)
  await killRelay(); await bootRelay()
  T('J5a the member is back by itself', !!(await until(() => member.state.connected, 20000)), JSON.stringify(member.state))
  const again2 = await dial(room, guestToken)
  T('J5b the revoked invite is refused although the host never came back', !again2.open && again2.status === 401, `open=${again2.open} status=${again2.status}`)
  const attacker2 = peer(invGuest.link, 'Guest', home('attacker2'))
  member.p.send({ say: 'member-after-restart-2' })
  await sleep(3000)
  T('J5c and reads nothing the member says', !attacker2.chat.includes('member-after-restart-2') && !attacker2.state.connected, JSON.stringify([attacker2.chat, attacker2.state]))
} catch (e) {
  T('no exception', false, e && e.stack)
} finally {
  for (const k of kids) { try { k.kill() } catch { } }
  await sleep(200)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
