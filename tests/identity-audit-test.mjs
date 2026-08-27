// Proves the relay can now answer "WHO is in this room, and how many at once" -- the three
// questions its connect-only, always-`anon` audit log could not answer:
//   1. a client that declares a name is logged under it (and one that does not stays anon)
//   2. `inRoom` counts concurrent clients, so two agents in one room is visible
//   3. `disconnect` fires with how long the session was held
// Plus the security property: a client may NOT declare itself `human`, because
// writeBlockReason() exempts kind === 'human' from claim/DCO write enforcement.
//   node tests/identity-audit-test.mjs
import { spawn } from 'child_process'
import { WebSocket } from 'ws'
import { fileURLToPath } from 'url'
import path from 'path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const PORT = 45677
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lines = []
const relay = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
})
relay.stdout.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && lines.push(l)))
relay.stderr.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && lines.push(l)))
// Wait for the real "listening" line rather than guessing at a sleep -- a fixed delay is
// what made the first run of this test fail with ECONNREFUSED.
const ready = new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('relay never printed "listening on"')), 15000)
  relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
})

const audits = () => lines.filter((l) => l.includes('[relay][audit]'))
  .map((l) => { try { return JSON.parse(l.slice(l.indexOf('{'))) } catch { return null } })
  .filter(Boolean)

const open = (room, qs) => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${encodeURIComponent(room)}${qs || ''}`)
  ws.on('open', () => res(ws))
  ws.on('error', rej)
})

try {
  await ready
  await sleep(200)

  // 1. a declared name reaches the audit log
  const a = await open('room-test', '?name=Ganesh&kind=human')
  await sleep(250)
  const c1 = audits().filter((e) => e.event === 'connect').pop()
  T('a declared name is recorded (was always "anon")', c1 && c1.identity.name === 'Ganesh')
  T('the raw claim is kept for the operator', c1 && c1.identity.declaredKind === 'human')

  // SECURITY: 'human' must not become the ENFORCED kind -- writeBlockReason() exempts it.
  T('a client cannot declare itself human for enforcement', c1 && c1.identity.kind !== 'human')

  // 2. concurrency: a SECOND client in the SAME room must be visible
  const b = await open('room-test', '?name=Aider&kind=ai')
  await sleep(250)
  const c2 = audits().filter((e) => e.event === 'connect').pop()
  T('a second client in the same room is counted', c2 && c2.inRoom === 2)
  T('an agent may declare kind=ai (it only adds restrictions)', c2 && c2.identity.kind === 'ai')

  // 3. no name at all -> still anonymous, exactly as before
  const anon = await open('room-other')
  await sleep(250)
  const c3 = audits().filter((e) => e.event === 'connect').pop()
  T('no name sent -> still anonymous (opt-in preserved)', c3 && c3.identity.name === 'anon' && c3.identity.kind === 'unknown')

  // 4. disconnect fires, with duration and who is left
  b.close()
  await sleep(400)
  const d = audits().filter((e) => e.event === 'disconnect').pop()
  T('disconnect is logged at all (it never was)', !!d)
  T('disconnect says who left', d && d.identity.name === 'Aider')
  T('disconnect carries how long it was held', d && typeof d.heldMs === 'number' && d.heldMs >= 0)
  T('disconnect says who is still in the room', d && d.stillInRoom === 1)

  // 5. a control character in a name cannot break the one-line JSON audit record
  const evil = await open('room-test', '?name=' + encodeURIComponent('bad\nname'))
  await sleep(250)
  const c5 = audits().filter((e) => e.event === 'connect').pop()
  T('control chars are stripped from a declared name', c5 && c5.identity.name === 'badname')

  a.close(); anon.close(); evil.close()
  await sleep(300)
} catch (e) {
  console.error('  FAIL  threw:', e && e.message); fail++
} finally {
  relay.kill()
}

console.log(`\n=== IDENTITY-AUDIT: ${pass} passed, ${fail} failed ===`)
process.exit(fail === 0 ? 0 : 1)
