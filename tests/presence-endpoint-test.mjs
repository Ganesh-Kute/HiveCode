// /presence: who is connected to this relay RIGHT NOW, across every room, for the operator.
//
// /health counts sockets, and a socket is not a person: one client holds a socket per file, or one mux
// socket for hundreds of files, and a person may run three tools. /usage is history since the last
// restart. Neither answers "how many agents and how many people are on my relay now". This does, and
// like /usage it answers only to X-Hive-Admin. It must never print a room id: a room id is the room's
// password, so rooms are reported by a short one-way hash the operator can match against ids they hold.
//
//   node tests/presence-endpoint-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import WebSocket from 'ws'
import { startSync } from '../sync.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1361
const ADMIN = 'secret-' + process.pid
const ROOM_A = 'room-presenceA-' + process.pid
const ROOM_B = 'room-presenceB-' + process.pid
const ROOM_C = 'room-presenceC-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const roomTag = (id) => 'r-' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 10)

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra && !c ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const clients = []
const sockets = []
const relays = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-presence-t-'))

function boot(port, env) {
  const r = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off', HIVE_ADMIN_SECRET: '', ...env } })
  relays.push(r)
  r.stderr.on('data', () => { })
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    r.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res(r) } })
  })
}
async function get(port, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/presence`, { headers })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { }
  return { status: res.status, data, text, cache: res.headers.get('cache-control') || '' }
}
const join = (room, name, kind, extra = {}) => {
  const c = startSync({ relay: `ws://127.0.0.1:${PORT}`, room, dir: fs.mkdtempSync(path.join(tmp, name)), name, kind, syncFiles: false, log: () => { }, ...extra })
  clients.push(c)
  return c
}
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150) } return null }

try {
  console.log('\n# P1 off unless the operator set HIVE_ADMIN_SECRET')
  await boot(PORT + 1, {})
  const off = await get(PORT + 1, { 'X-Hive-Admin': '' })
  T('P1a no secret configured: 403', off.status === 403, `${off.status} ${off.text.slice(0, 120)}`)
  T('P1b and it says how to turn it on (Q442)', off.data && /Q442/.test(off.data.error || ''), off.text.slice(0, 160))
  relays.pop().kill()

  await boot(PORT, { HIVE_ADMIN_SECRET: ADMIN })

  console.log('\n# P2 refuses anyone without the admin secret')
  const none = await get(PORT)
  T('P2a no header: 403 Q441', none.status === 403 && /Q441/.test((none.data || {}).error || ''), `${none.status} ${none.text.slice(0, 120)}`)
  const wrong = await get(PORT, { 'X-Hive-Admin': ADMIN + 'x' })
  T('P2b wrong secret: 403 Q441', wrong.status === 403 && /Q441/.test((wrong.data || {}).error || ''), `${wrong.status}`)
  const shorter = await get(PORT, { 'X-Hive-Admin': ADMIN.slice(0, -1) })
  T('P2c a prefix of the secret: 403', shorter.status === 403, `${shorter.status}`)

  console.log('\n# P3 an empty relay')
  const empty = await get(PORT, { 'X-Hive-Admin': ADMIN })
  T('P3a 200 with the secret', empty.status === 200, `${empty.status} ${empty.text.slice(0, 160)}`)
  T('P3b nobody: 0 agents, 0 humans, 0 rooms', empty.data && empty.data.agents === 0 && empty.data.humans === 0 && empty.data.rooms === 0, empty.text.slice(0, 200))
  T('P3c never cached', /no-store/.test(empty.cache), `cache-control=${empty.cache}`)

  console.log('\n# P4 two rooms: a person and two agents in A, one agent in B (a listener)')
  join(ROOM_A, 'Ganesh', 'human')
  join(ROOM_A, 'BuilderBot', 'ai')
  join(ROOM_A, 'ReviewBot', 'ai')
  join(ROOM_B, 'BuilderBot', 'ai', { listener: true })
  const full = await until(async () => { const r = await get(PORT, { 'X-Hive-Admin': ADMIN }); const b = r.data && (r.data.people || []).find((p) => p.name === 'BuilderBot'); return r.data && r.data.rooms === 2 && r.data.agents >= 2 && r.data.humans >= 1 && b && b.listener ? r : null })
  const d = (full || (await get(PORT, { 'X-Hive-Admin': ADMIN }))).data || {}
  T('P4a 2 rooms with someone in them', d.rooms === 2, JSON.stringify(d).slice(0, 300))
  T('P4b 2 distinct agents (BuilderBot in two rooms counts once)', d.agents === 2, `agents=${d.agents}`)
  T('P4c 1 human', d.humans === 1, `humans=${d.humans}`)
  T('P4d 4 seats: who-in-which-room pairs', d.seats === 4, `seats=${d.seats}`)
  const bb = (d.people || []).find((p) => p.name === 'BuilderBot')
  T('P4e BuilderBot is listed once, in 2 rooms', bb && bb.rooms === 2, JSON.stringify(bb))
  T('P4f on an open relay a kind is declared, never verified', bb && bb.declared === 'ai' && bb.verified === null, JSON.stringify(bb))
  const gk = (d.people || []).find((p) => p.name === 'Ganesh')
  T('P4g Ganesh is a declared human', gk && gk.declared === 'human', JSON.stringify(gk))
  T('P4h the client\'s app/version comes from its presence when it has one', bb && Array.isArray(bb.versions) && bb.versions.length >= 1, JSON.stringify(bb))
  T('P4n a client that announced itself is not silent', bb && bb.silent === false && gk && gk.silent === false, JSON.stringify([bb, gk]))
  T('P4i BuilderBot is marked as also running a listener', bb && bb.listener === true, JSON.stringify(bb))
  const ra = (d.roomList || []).find((r) => r.room === roomTag(ROOM_A))
  T('P4j room A by its hash: 2 agents, 1 human', ra && ra.agents === 2 && ra.humans === 1, JSON.stringify(d.roomList))
  T('P4k room B by its hash: 1 agent', (d.roomList || []).some((r) => r.room === roomTag(ROOM_B) && r.agents === 1 && r.humans === 0), JSON.stringify(d.roomList))
  T('P4l no room id anywhere in the answer', !full || (!full.text.includes(ROOM_A) && !full.text.includes(ROOM_B) && !full.text.includes('presenceA')), 'room id leaked')
  T('P4m sockets is the relay\'s own socket count', typeof d.sockets === 'number' && d.sockets >= 1, `sockets=${d.sockets}`)

  console.log('\n# P5 a client that never announces itself still counts (a bare socket with ?name=)')
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${ROOM_C}?name=SilentWatcher&kind=ai`)
  sockets.push(ws)
  await new Promise((r) => ws.once('open', r))
  const withSilent = await until(async () => { const r = await get(PORT, { 'X-Hive-Admin': ADMIN }); return r.data && r.data.rooms === 3 ? r.data : null })
  const sw = withSilent && withSilent.people.find((p) => p.name === 'SilentWatcher')
  T('P5a its room is counted', !!withSilent, '')
  T('P5b it is listed, with no presence (silent: true)', sw && sw.silent === true, JSON.stringify(sw))

  console.log('\n# P6 leaving is seen')
  ws.close()
  clients[2].stop()           // ReviewBot leaves room A
  const after = await until(async () => { const r = await get(PORT, { 'X-Hive-Admin': ADMIN }); return r.data && r.data.rooms === 2 && !r.data.people.some((p) => p.name === 'ReviewBot') ? r.data : null })
  T('P6a ReviewBot and the silent socket are gone', !!after, '')
  T('P6b 1 agent left (BuilderBot), still 1 human', after && after.agents === 1 && after.humans === 1, JSON.stringify(after && { a: after.agents, h: after.humans }))
  for (const c of clients) { try { c.stop() } catch { } }
  const gone = await until(async () => { const r = await get(PORT, { 'X-Hive-Admin': ADMIN }); return r.data && r.data.rooms === 0 ? r.data : null })
  T('P6c everyone gone: 0 rooms, 0 agents, 0 humans', gone && gone.agents === 0 && gone.humans === 0, JSON.stringify(gone))
} catch (e) {
  T('no exception', false, e && e.stack)
} finally {
  for (const c of clients) { try { c.stop() } catch { } }
  for (const s of sockets) { try { s.terminate() } catch { } }
  for (const r of relays) { try { r.kill() } catch { } }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
