// DELETED WHILE QUEUED (27 Sep 2026). A joiner no longer opens every file inline when the room's
// manifest arrives (822d14a): paths wait in a queue and open over the next event-loop turns. A peer can
// delete a file in that window. The file's DOCUMENT still exists on the relay, so opening it from the
// queue would write the deleted file back onto the joiner's disk and publish it to the room again --
// a deletion silently undone. Pinned: a file deleted while queued stays deleted, on the joiner's disk
// and in the room, and the joiner still receives everything else.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.HIVE_TEST_PORT) || (25000 + (process.pid % 15000))
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }
async function until(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await pred()) return true } catch { } await sleep(200) } return false }

const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
relay.stderr.on('data', () => { })
await new Promise((res, rej) => { relay.stdout.on('data', (d) => { if (/listening on/.test(d)) res() }); relay.on('exit', (c) => rej(new Error('relay exited ' + c))) })

const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
const room = `queue-delete-${process.pid}`
const mk = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `hive-qdel-${t}-`))
const dirA = mk('a'), dirB = mk('b')
const KEEP = ['a1.js', 'a2.js', 'a3.js', 'a4.js']   // more than 2, so B queues them instead of opening inline
for (const f of [...KEEP, 'gone.js']) fs.writeFileSync(path.join(dirA, f), `export const x = '${f}'\n`)
const has = (dir, f) => fs.existsSync(path.join(dir, f))

console.log('\n=== DELETED WHILE QUEUED ===')
const a = startSync({ relay: RELAY, room, dir: dirA, name: 'Queue-A', kind: 'ai', log: () => { } })
const manifestA = a.doc.getMap('manifest')
T('A has published all five files', await until(() => ['gone.js', ...KEEP].every((f) => manifestA.has(f)), 20000))

// B joins with its queue held for 2 s -- the window a real join has for a few ticks
process.env.HIVE_TEST_OPEN_DELAY_MS = '2000'
const b = startSync({ relay: RELAY, room, dir: dirB, name: 'Queue-B', kind: 'ai', log: () => { } })
delete process.env.HIVE_TEST_OPEN_DELAY_MS
const manifestB = b.doc.getMap('manifest')
T("B has the room's manifest (its files are queued, not opened)", await until(() => manifestB.has('gone.js'), 20000) && !has(dirB, 'gone.js'))

// ...and while they wait, A deletes gone.js
fs.rmSync(path.join(dirA, 'gone.js'))
T("A's delete reaches B while gone.js is still queued", await until(() => !manifestB.has('gone.js'), 1800))

T('B still receives every file that was not deleted', await until(() => KEEP.every((f) => has(dirB, f)), 20000))
await sleep(3000)
T('gone.js did NOT come back onto B\'s disk', !has(dirB, 'gone.js'))
T('...and was not published back to the room', !manifestA.has('gone.js') && !manifestB.has('gone.js'))
T("...and A's folder still does not have it", !has(dirA, 'gone.js'))

for (const c of [a, b]) { try { c.stop() } catch { } }
relay.kill()
for (const d of [dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
console.log(`\n=== DELETED WHILE QUEUED: ${pass} passed, ${fail} failed ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 300)
