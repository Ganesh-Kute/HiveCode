// Deletes are the one edit that cannot be merged back, so they get guarantees of their own.
//
//   node tests/delete-safety-test.mjs
//
// Measured 3 Oct 2026 on a local relay, before the fix:
//   - one agent's `rm -rf src` took 30 files out of its teammate's folder within seconds, and
//     nothing kept them: a delete from the room was a bare rmSync. The deleter was told nothing.
//   - deleting an agent's WHOLE room folder crashed its process on Windows (fs.watch EPERM, no
//     handler), and wherever the watcher survives, the next scan read every file as deleted and
//     emptied the room for everyone: 12 of 12 files gone from the teammate's folder.
//
// Sections:
//   A  a room folder deleted under a running session: the process survives, nothing is deleted
//      for anyone, the session says Q580, and a teammate's later edit does not recreate the folder
//   B  every file in a folder vanishes at once (the folder stays): read as an emptied folder, not N deletes
//   C  a real bulk delete (rm -rf src, other files left): it reaches the teammate, who keeps a
//      byte-identical copy of each file; the deleter and the room are told
//   D  one deleted file still reaches the teammate, who keeps a copy (deletes did not stop working)
//   E  an editor's delete-then-write inside the settle window never takes the file from the teammate
//   F  .hive-deleted/ never reaches the room
//   G  pruning: week-old stamp folders go; recent ones, and anything that is not ours, stay
//   H  a file someone else holds is not deleted under them; it goes back, and the room is told why

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import http from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync } = await import('../sync.js')

let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}
const sec = (s) => console.log(`\n${s}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const healthy = (url) => new Promise((res) => { const q = http.get(url, (r) => { r.resume(); res(r.statusCode === 200) }); q.on('error', () => res(false)); q.setTimeout(800, () => { q.destroy(); res(false) }) })
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(step) } return pred() }

process.setMaxListeners(64) // every session adds an exit hook; fifteen of them is this file, not a leak
// A crash in the engine must fail an assertion here, not end the run before one is made.
const uncaught = []
process.on('uncaughtException', (e) => { uncaught.push(`${e.code || ''} ${e.syscall || ''} ${e.message}`.trim()) })

const PORT = await freePort()
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: '', HIVE_SEATS: '25', HIVE_ENFORCE_CLAIMS: '', HIVE_JWT_SECRET: '', HIVE_AUTH_MODE: '' },
  stdio: ['ignore', 'ignore', 'ignore'],
})
for (let i = 0; i < 60 && !(await healthy(`http://127.0.0.1:${PORT}/health`)); i++) await sleep(250)
const RELAY = `ws://127.0.0.1:${PORT}`
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-delete-safety-'))
const sessions = []
process.on('exit', () => {
  for (const s of sessions) { try { s.stop() } catch { } }
  try { relay.kill() } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { }
})

function filesUnder(d) {
  const out = []
  const walk = (x) => { let es = []; try { es = fs.readdirSync(x, { withFileTypes: true }) } catch { return } for (const e of es) { const f = path.join(x, e.name); if (e.isDirectory()) walk(f); else out.push(path.relative(d, f).replace(/\\/g, '/')) } }
  walk(d)
  return out
}
const roomFiles = (d) => filesUnder(d).filter((r) => !/^(HIVE_|\.hive)/.test(r) && !r.includes('/.hive') && !r.startsWith('.hive-deleted/'))
const keptCopies = (d) => filesUnder(path.join(d, '.hive-deleted')).map((r) => r.split('/').slice(1).join('/'))

/** Alice and Bob in a fresh room; Alice writes `files`, and this returns once Bob has every one. */
async function pair(label, files) {
  const A_DIR = path.join(TMP, label, 'alice'), B_DIR = path.join(TMP, label, 'bob')
  fs.mkdirSync(A_DIR, { recursive: true }); fs.mkdirSync(B_DIR, { recursive: true })
  const room = `del-${label}-${Math.random().toString(36).slice(2, 8)}`
  const logsA = [], logsB = []
  const A = startSync({ relay: RELAY, room, dir: A_DIR, name: 'Alice', kind: 'ai', owner: 'Ana', log: (m) => logsA.push(String(m)) })
  const B = startSync({ relay: RELAY, room, dir: B_DIR, name: 'Bob', kind: 'ai', owner: 'Ben', log: (m) => logsB.push(String(m)) })
  sessions.push(A, B)
  await until(() => { try { return A.status().connected && B.status().connected } catch { return false } }, 20000, 250)
  for (const [r, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(A_DIR, r)), { recursive: true }); fs.writeFileSync(path.join(A_DIR, r), body) }
  const want = Object.keys(files).length
  const arrived = await until(() => Object.keys(files).every((r) => fs.existsSync(path.join(B_DIR, r))), 30000, 200)
  return { A, B, A_DIR, B_DIR, logsA, logsB, arrived, want }
}
const many = (prefix, n, tag) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}f${i}.js`, `export const v${i} = ${i} // ${tag}\n`]))
const WAIT = 1500 + 4000 // the settle window, then time for anything that was going to leave to arrive

// -------------------------------------------------------------- A: the folder itself goes
sec('A  a room folder deleted under a running session')
{
  const p = await pair('A', many('src/', 12, 'A'))
  T('A0 setup: Bob has all 12 files', p.arrived)
  fs.rmSync(p.A_DIR, { recursive: true, force: true })
  await sleep(WAIT)
  T('A1 the process survives its room folder being deleted (no uncaught watcher error)',
    uncaught.length === 0, uncaught.join(' | '))
  T('A2 Bob keeps every file: a vanished folder is not 12 deletes',
    roomFiles(p.B_DIR).length === 12, `Bob has ${roomFiles(p.B_DIR).length}/12`)
  const lost = (() => { try { return p.A.connection().folderLost || '' } catch { return '' } })()
  T('A3 the session says what happened where the agent looks: connection().folderLost carries Q580',
    /^Q580: this room's folder is gone/.test(lost), JSON.stringify(lost.slice(0, 80)))
  T('A4 ...and status() carries it too', /Q580/.test((p.A.status() || {}).folderLost || ''))
  // A remote write must not recreate the folder holding one file: the next pass would read the
  // other eleven as deleted, which is the wipe all over again.
  fs.writeFileSync(path.join(p.B_DIR, 'src/f0.js'), 'export const v0 = "edited by Bob after Alice lost her folder"\n')
  await sleep(3000)
  T('A5 Bob\'s later edit does not recreate Alice\'s folder', !fs.existsSync(p.A_DIR))
  T('A6 ...and Bob still has all 12', roomFiles(p.B_DIR).length === 12, `Bob has ${roomFiles(p.B_DIR).length}/12`)
}

// -------------------------------------------------- B: every file goes, the folder stays
sec('B  every file in the folder vanishes at once')
{
  const p = await pair('B', many('', 8, 'B'))
  T('B0 setup: Bob has all 8 files', p.arrived)
  for (const r of Object.keys(many('', 8, 'B'))) fs.rmSync(path.join(p.A_DIR, r))
  await sleep(WAIT)
  T('B1 Bob keeps all 8: an emptied folder is not 8 deliberate deletes',
    roomFiles(p.B_DIR).length === 8, `Bob has ${roomFiles(p.B_DIR).length}/8`)
  const lost = (() => { try { return p.A.connection().folderLost || '' } catch { return '' } })()
  T('B2 the session says the folder was emptied (Q580)', /^Q580: this room's folder was emptied: all 8 of its files/.test(lost), JSON.stringify(lost.slice(0, 90)))
}

// ------------------------------------------------------------- C: a real bulk delete
sec('C  a real bulk delete (rm -rf src, other files left)')
const C = await (async () => {
  const files = { ...many('src/', 30, 'C'), ...many('keep/', 3, 'C') }
  const p = await pair('C', files)
  T('C0 setup: Bob has all 33 files', p.arrived)
  const chatBefore = p.B.doc.getArray('chat').length
  fs.rmSync(path.join(p.A_DIR, 'src'), { recursive: true, force: true })
  const left = () => roomFiles(p.B_DIR).filter((r) => r.startsWith('src/')).length
  await until(() => left() === 0, 15000, 200)
  T('C1 a deliberate bulk delete still reaches Bob', left() === 0, `${left()} of 30 still there`)
  const kept = keptCopies(p.B_DIR).filter((r) => r.startsWith('src/'))
  const identical = kept.filter((r) => {
    const stamp = fs.readdirSync(path.join(p.B_DIR, '.hive-deleted')).find((s) => fs.existsSync(path.join(p.B_DIR, '.hive-deleted', s, r)))
    return stamp && fs.readFileSync(path.join(p.B_DIR, '.hive-deleted', stamp, r), 'utf8') === files[r]
  })
  T('C2 Bob keeps a byte-identical copy of each of the 30 in .hive-deleted/', identical.length === 30, `${identical.length}/30 identical, ${kept.length} kept`)
  T('C3 ...all from one batch, in one stamp folder', (() => { try { return fs.readdirSync(path.join(p.B_DIR, '.hive-deleted')).length === 1 } catch { return false } })())
  T('C4 files the delete did not touch are untouched', roomFiles(p.B_DIR).filter((r) => r.startsWith('keep/')).length === 3)
  T('C5 the deleter is told what went', p.logsA.some((l) => /-> deleted for everyone: src\/f/.test(l)), JSON.stringify(p.logsA.slice(-3)))
  await sleep(1000)
  const lines = p.B.doc.getArray('chat').toArray().slice(chatBefore).map((m) => String(m.text || ''))
  const told = lines.filter((t) => /Alice deleted 30 files for everyone/.test(t))
  T('C6 the room is told once, with the count and where the copies are', told.length === 1 && /\.hive-deleted\//.test(told[0] || ''), JSON.stringify(lines.slice(0, 3)))
  T('C7 Alice\'s session is still syncing (a partial delete is not a lost folder)', !(p.A.connection().folderLost))
  return p
})()

// ------------------------------------------------------------------ D: one file
sec('D  one deleted file')
{
  const p = await pair('D', { 'a.js': 'export const a = 1\n', 'b.js': 'export const b = 2\n' })
  T('D0 setup: Bob has both files', p.arrived)
  fs.rmSync(path.join(p.A_DIR, 'a.js'))
  const gone = await until(() => !fs.existsSync(path.join(p.B_DIR, 'a.js')), 8000)
  T('D1 one deleted file still reaches Bob within 8 s', gone)
  T('D2 ...and Bob keeps a copy of it', keptCopies(p.B_DIR).includes('a.js'), JSON.stringify(keptCopies(p.B_DIR)))
  T('D3 the other file is untouched', fs.existsSync(path.join(p.B_DIR, 'b.js')))
}

// ------------------------------------------------------ E: an editor's delete-then-write
sec('E  delete-then-write inside the settle window (an editor saving)')
{
  const p = await pair('E', { 'e.js': 'export const e = "v1"\n', 'other.js': 'export const o = 1\n' })
  T('E0 setup: Bob has e.js', p.arrived)
  let missingSeen = 0
  const watch = setInterval(() => { if (!fs.existsSync(path.join(p.B_DIR, 'e.js'))) missingSeen++ }, 20)
  fs.rmSync(path.join(p.A_DIR, 'e.js'))
  await sleep(250)
  fs.writeFileSync(path.join(p.A_DIR, 'e.js'), 'export const e = "v2"\n')
  await until(() => { try { return fs.readFileSync(path.join(p.B_DIR, 'e.js'), 'utf8').includes('v2') } catch { return false } }, 8000)
  await sleep(2500)
  clearInterval(watch)
  T('E1 Bob never lost e.js while Alice\'s editor deleted and rewrote it', missingSeen === 0, `missing on ${missingSeen} polls`)
  T('E2 ...and Bob has the new content', (() => { try { return fs.readFileSync(path.join(p.B_DIR, 'e.js'), 'utf8').includes('v2') } catch { return false } })())
}

// ---------------------------------------------------------- F: the copies stay local
sec('F  .hive-deleted/ never reaches the room')
{
  const keys = [...C.B.doc.getMap('manifest').keys()]
  T('F1 no .hive-deleted/ path is in the room after section C\'s 30 copies were made',
    keys.length > 0 && !keys.some((k) => k.startsWith('.hive-deleted')), `${keys.length} keys`)
  T('F2 ...and none appeared in Alice\'s folder', !fs.existsSync(path.join(C.A_DIR, '.hive-deleted')))
}

// ------------------------------------------------- H: a held file is not deleted under its holder
sec('H  a file someone else holds is not deleted under them')
{
  const p = await pair('H', { 'held.js': 'export const h = 1\n', 'free.js': 'export const f = 1\n', 'other.js': 'export const o = 1\n' })
  T('H0 setup: Bob has all three files', p.arrived)
  T('H0b setup: Bob holds held.js', p.B.claim('held.js', 'refactoring held.js') === true)
  await sleep(1500)
  fs.writeFileSync(path.join(p.B_DIR, 'held.js'), 'export const h = 1\n// Bob mid-edit, holding the claim\n')
  await until(() => { try { return fs.readFileSync(path.join(p.A_DIR, 'held.js'), 'utf8').includes('Bob mid-edit') } catch { return false } }, 8000)
  const chatBefore = p.B.doc.getArray('chat').length
  fs.rmSync(path.join(p.A_DIR, 'held.js'))
  fs.rmSync(path.join(p.A_DIR, 'free.js'))
  await sleep(WAIT)
  const read = (d, r) => { try { return fs.readFileSync(path.join(d, r), 'utf8') } catch { return '' } }
  const refusals = () => p.B.doc.getArray('chat').toArray().slice(chatBefore).map((m) => String(m.text || '')).filter((t) => /⛔ Alice deleted held\.js \(held by Bob\)/.test(t))
  T('H1 Bob keeps the file he holds, with his edit in it', read(p.B_DIR, 'held.js').includes('Bob mid-edit'))
  T('H2 ...and it is still in the room', p.B.doc.getMap('manifest').has('held.js'))
  T('H3 it is back in Alice\'s folder, with the room\'s content', read(p.A_DIR, 'held.js').includes('Bob mid-edit'))
  T('H4 the room is told why, once', refusals().length === 1, JSON.stringify(p.B.doc.getArray('chat').toArray().slice(chatBefore).map((m) => m.text).slice(0, 3)))
  T('H5 the unclaimed file deleted in the same batch still went', !fs.existsSync(path.join(p.B_DIR, 'free.js')))
  await sleep(5000) // several scans: a refused delete must not be retried, or re-announced
  T('H6 the refused delete is not retried on later scans', refusals().length === 1 && fs.existsSync(path.join(p.A_DIR, 'held.js')), `${refusals().length} refusal lines`)
  p.B.release('held.js')
  await sleep(1500)
  fs.rmSync(path.join(p.A_DIR, 'held.js'))
  T('H7 once Bob releases it, Alice\'s delete goes through', await until(() => !fs.existsSync(path.join(p.B_DIR, 'held.js')), 10000))
}

// --------------------------------------------------------------------- G: pruning
sec('G  week-old copies are pruned at start; nothing else is')
{
  const dir = path.join(TMP, 'G', 'solo')
  const stamp = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/[:.]/g, '-')
  const old = stamp(8 * 24 * 3600 * 1000), recent = stamp(2 * 24 * 3600 * 1000)
  for (const d of [old, recent, 'mine']) { fs.mkdirSync(path.join(dir, '.hive-deleted', d), { recursive: true }); fs.writeFileSync(path.join(dir, '.hive-deleted', d, 'x.js'), 'x\n') }
  const S = startSync({ relay: RELAY, room: 'del-G-' + Math.random().toString(36).slice(2, 8), dir, name: 'Solo', kind: 'ai', log: () => { } })
  sessions.push(S)
  await sleep(500)
  T('G1 a copy folder older than 7 days is removed at start', !fs.existsSync(path.join(dir, '.hive-deleted', old)))
  T('G2 a 2-day-old one stays', fs.existsSync(path.join(dir, '.hive-deleted', recent, 'x.js')))
  T('G3 a folder this code did not name stays', fs.existsSync(path.join(dir, '.hive-deleted', 'mine', 'x.js')))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
