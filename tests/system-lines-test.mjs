// tests/system-lines-test.mjs -- one system line per event in the room, not one per observer (0.14.4, C5).
//
//   node tests/system-lines-test.mjs
//
// THE DEFECT. Most system lines are said by the participant whose action caused them. But some are
// OBSERVED: every peer's own code detects the same event and posts it. A conflict in a shared file
// gave one "MERGE CONFLICT" line per agent in the room; a client on another build gave one MIXED BUILDS
// line per pair (#822 + #823 on 9 Nov, about one antigravity-VM); a local copy kept after a room write
// was announced to the whole room although only that folder had it. This drives four real clients on
// a real relay and counts the lines.
//
//   E1  one conflict in a shared file -> exactly 1 MERGE CONFLICT line (was 1 per peer)
//   E2  its resolution -> exactly 1 "resolved" line
//   E3  a client on another release -> exactly 1 MIXED BUILDS line
//   E4  the same release from another commit -> no chat line; a note in this folder's notices
//   E5  a local copy kept after a room write -> no chat line; a note in that folder's notices
//   E6  postOnce: the same event id twice -> one line; a new event -> a new line
//   E7  the same file conflicting again after its resolution -> said again

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { VERSION } from '../hive-version.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) } }
const sec = (s) => console.log(`\n# ${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }

const kids = []
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-system-lines-'))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
kids.push(relay)
let relayUp = false
relay.stdout.on('data', (d) => { if (/listening on/.test(d)) relayUp = true })
const { startSync } = await import('../sync.js')
const clients = []
// The staggered observers wait up to 1.5 s + 1 s per rank; this is comfortably past the last of four.
const SETTLE = 9000
try {
  await until(() => relayUp, 15000)
  const room = `sl-${Math.random().toString(36).slice(2, 8)}`
  const RELAY = `ws://localhost:${PORT}`
  const join = (name) => { const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true }); const c = startSync({ relay: RELAY, room, dir, name, kind: 'ai', log: () => { } }); clients.push(c); return { c, dir } }
  const A = join('Alice'), B = join('Bob'), C = join('Carol'), D = join('Dave')
  await until(() => clients.every((x) => x.provider.synced), 20000)
  await sleep(1500)
  const chat = () => A.c.doc.getArray('chat').toArray()
  const count = (re) => chat().filter((m) => re.test(String(m.text || ''))).length
  const say = (re) => chat().filter((m) => re.test(String(m.text || ''))).map((m) => `${m.by}: ${String(m.text).slice(0, 70)}`)

  sec('E1/E2 a conflict in a shared file (incident I-16: two agents edit one line at once)')
  const has = (x, f, re) => { try { return re.test(fs.readFileSync(path.join(x.dir, f), 'utf8')) } catch { return false } }
  // The real race: two agents save the same line moments apart. Measured on a local relay: 40 ms apart
  // gives conflict markers 4/4 (exactly simultaneous saves FUSE instead -- a separate defect, reported
  // on its own). Tried up to 3 times on a fresh file; then that file's lines are counted.
  let file = ''
  for (let k = 1; k <= 3 && !file; k++) {
    const f = `board-${k}.md`
    fs.writeFileSync(path.join(A.dir, f), 'plan\nship friday\nowner: team\n')
    if (!(await until(() => [A, B, C, D].every((x) => has(x, f, /friday/)), 20000))) continue
    await sleep(1200)
    fs.writeFileSync(path.join(A.dir, f), 'plan\nship monday\nowner: team\n')
    await sleep(40)
    fs.writeFileSync(path.join(B.dir, f), 'plan\nship tuesday\nowner: team\n')
    if (await until(() => [A, B, C, D].every((x) => has(x, f, /<<<<<<</)), 6000)) file = f
  }
  T('E setup: two agents saving one line moments apart left conflict markers in all four folders', !!file, file || 'no conflict in 3 tries')
  if (!file) file = 'board-none.md' // keep counting (0 lines) rather than write to the folder itself
  const esc = (f) => f.replace(/[.]/g, '\\.')
  await sleep(SETTLE)
  T('E1 one conflict -> exactly 1 MERGE CONFLICT line in the room, not one per peer', count(new RegExp(`MERGE CONFLICT in ${esc(file)}`)) === 1, JSON.stringify(say(new RegExp(`MERGE CONFLICT in ${esc(file)}`))))
  if (file !== 'board-none.md') fs.writeFileSync(path.join(A.dir, file), 'plan\nship monday\nowner: team\n')
  T('E setup: the resolution reached all four', await until(() => [A, B, C, D].every((x) => !has(x, file, /<<<<<<</)), 20000))
  await sleep(SETTLE)
  T('E2 its resolution -> exactly 1 "resolved" line', count(new RegExp(`conflict in ${esc(file)} resolved`)) === 1, JSON.stringify(say(new RegExp(`conflict in ${esc(file)} resolved`))))

  // A conflict that RECURS on the same file is a new event and must be said again: the "resolved" line
  // clears the conflict's key. Without that, dedupe would hide the second conflict -- the costly failure.
  if (file !== 'board-none.md') {
    fs.writeFileSync(path.join(A.dir, file), 'plan\nship sunday\nowner: team\n')
    await sleep(40)
    fs.writeFileSync(path.join(B.dir, file), 'plan\nship saturday\nowner: team\n')
    await until(() => [A, B, C, D].every((x) => has(x, file, /<<<<<<</)), 8000)
  }
  await sleep(SETTLE)
  T('E7 the same file conflicting AGAIN after its resolution -> said again (2 lines in all, not 1, not 8)', count(new RegExp(`MERGE CONFLICT in ${esc(file)}`)) === 2, JSON.stringify(say(new RegExp(`MERGE CONFLICT in ${esc(file)}`))))

  sec('E3/E4 builds')
  const spoof = (x, hv) => { const st = x.c.provider.awareness.getLocalState() || {}; x.c.provider.awareness.setLocalStateField('user', { ...st.user, hv }) }
  spoof(D, '0.0.1') // another release
  await sleep(SETTLE)
  T('E3 a client on another release -> exactly 1 MIXED BUILDS line naming it', count(/MIXED BUILDS:.*Dave/) === 1, JSON.stringify(say(/MIXED BUILDS/)))
  const mixedAfterE3 = count(/MIXED BUILDS/)
  spoof(C, `${VERSION}+deadbee`) // the same release, another commit
  await sleep(SETTLE)
  T('E4 the same release from another commit -> no new MIXED BUILDS line in chat', count(/MIXED BUILDS/) === mixedAfterE3 && count(/deadbee/) === 0, JSON.stringify(say(/MIXED BUILDS|deadbee/)))
  const notes = (x) => (typeof x.c.notices === 'function' ? x.c.notices() : []).map((n) => n.text || String(n))
  T('E4b ...but a note in this folder\'s notices (hive_status shows them)', [A, B].some((x) => notes(x).some((t) => /Carol/.test(t) && /deadbee/.test(t))), JSON.stringify(notes(A)).slice(0, 200))

  sec('E5 a local copy kept after a room write')
  const ICON_A = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 1)])
  const ICON_B = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 2)])
  const ICON_0 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 0)])
  fs.writeFileSync(path.join(A.dir, 'icon.bin'), ICON_0)
  T('E5 setup: icon.bin is shared', await until(() => [A, B, C, D].every((x) => { try { return fs.readFileSync(path.join(x.dir, 'icon.bin')).equals(ICON_0) } catch { return false } }), 20000))
  await sleep(1500)
  fs.writeFileSync(path.join(A.dir, 'icon.bin'), ICON_A) // two people change it at once
  fs.writeFileSync(path.join(B.dir, 'icon.bin'), ICON_B)
  const settled = () => { try { return fs.readFileSync(path.join(A.dir, 'icon.bin')).equals(fs.readFileSync(path.join(B.dir, 'icon.bin'))) } catch { return false } }
  T('E5 setup: the two writes settle on one winner', await until(settled, 20000))
  await sleep(SETTLE)
  T('E5 the loser\'s "local copy saved" is not said to the room', count(/icon\.bin updated from room/) === 0, JSON.stringify(say(/icon\.bin/)))
  T('E5b ...it is in those folders\' notices instead', [A, B, C, D].some((x) => notes(x).some((t) => /icon\.bin/.test(t) && /saved/.test(t))), JSON.stringify([notes(A), notes(B)]).slice(0, 240))

  sec('E6 postOnce')
  const hasPostOnce = typeof A.c.postOnce === 'function'
  T('E6 setup: the client exposes postOnce', hasPostOnce)
  if (hasPostOnce) {
    A.c.postOnce('test:e6:one', 'E6 marker one')
    B.c.postOnce('test:e6:one', 'E6 marker one', { observer: true })
    await sleep(SETTLE)
    T('E6a the same event id from two peers -> one line', count(/E6 marker one/) === 1, JSON.stringify(say(/E6 marker/)))
    A.c.postOnce('test:e6:two', 'E6 marker two')
    await sleep(1500)
    T('E6b a new event id -> a new line', count(/E6 marker two/) === 1)
  }
} finally {
  for (const c of clients) { try { c.stop() } catch { } }
  for (const k of kids) { try { k.kill() } catch { } }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
}
console.log(`\n=== SYSTEM LINES: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
