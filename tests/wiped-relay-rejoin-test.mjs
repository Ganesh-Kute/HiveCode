// THE MORNING AFTER (27 Sep 2026). The hosted relay's disk is erased by every deploy and restart --
// on 27 Sep one deploy took it from 168 stored documents to 0 -- which leaves the participants'
// folders as the only copy of the room. An agent that restarts and rejoins that empty relay holds a
// .hive-shadow.json recording what it last wrote, so every file has an ANCESTOR while its room doc
// is EMPTY: the exact shape of the 18 Sep failure (an empty doc adopted over real bytes, 186 files
// zeroed). Pinned: nothing is zeroed or altered, an edit made while offline survives, the room is
// re-seeded from the folder so a newcomer receives every file, and a teammate returning later with
// the old copy picks up the newer one instead of pushing the old one back.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.HIVE_TEST_PORT) || (22000 + (process.pid % 18000))
const RELAY = `ws://localhost:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }
async function until(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await pred()) return true } catch { } await sleep(250) } return false }

function startRelay() {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.on('data', () => { })
  return new Promise((res, rej) => { p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) }); p.on('exit', (c) => rej(new Error('relay exited ' + c))) })
}
const stopRelay = (p) => new Promise((res) => { p.once('exit', res); p.kill() })

const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
const room = `wiped-${process.pid}`
const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `hive-wiped-${tag}-`))
const dirSeed = mk('seed'), dirA = mk('a'), dirB = mk('b')
const FILES = { 'src/one.js': 'export const one = 1\n', 'src/two.js': 'export const two = 2\n', 'README.md': '# wiped relay\n' }
for (const [f, s] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(dirSeed, f)), { recursive: true }); fs.writeFileSync(path.join(dirSeed, f), s) }
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch { return null } }
const has = (dir, want) => Object.entries(want).every(([f, s]) => read(dir, f) === s)
const show = (dir, want) => Object.keys(want).map((f) => `${f}=${JSON.stringify(read(dir, f))}`).join(' ')
const join = (dir, name) => startSync({ relay: RELAY, room, dir, name, kind: 'ai', log: () => { } })

console.log('\n=== THE MORNING AFTER: a wiped relay, a restarted agent ===')
let relay = await startRelay()
const seed = join(dirSeed, 'Wipe-Seed')
let a = join(dirA, 'Wipe-A')
T('day one: the agent receives every file through the room', await until(() => has(dirA, FILES), 30000), show(dirA, FILES))
const shadowed = await until(() => { const s = read(dirA, '.hive-shadow.json') || ''; return Object.keys(FILES).every((f) => s.includes(f)) }, 15000)
T('its .hive-shadow.json holds an ancestor for every file (so the empty-doc case is really exercised)', shadowed)

// Night: everyone goes home, then the relay is wiped (a deploy, a restart, a free-plan recycle).
try { a.stop() } catch { }
try { seed.stop() } catch { }
await sleep(800)
await stopRelay(relay)
const EDITED = 'export const two = 22 // edited while the relay was gone\n'
fs.writeFileSync(path.join(dirA, 'src/two.js'), EDITED)
const EXPECT = { ...FILES, 'src/two.js': EDITED }

// Morning: an empty relay, and only the agent comes back.
relay = await startRelay()
a = join(dirA, 'Wipe-A')
await sleep(4000)
const zeroed = Object.keys(EXPECT).filter((f) => read(dirA, f) === '')
T('rejoining the empty relay zeroed nothing', zeroed.length === 0, zeroed.join(', '))
T("and left every file in the agent's folder exactly as it was, offline edit included", has(dirA, EXPECT), show(dirA, EXPECT))

const b = join(dirB, 'Wipe-B')
T('a newcomer receives every file, offline edit included (the room was re-seeded from the folder)', await until(() => has(dirB, EXPECT), 30000), show(dirB, EXPECT))
T("the agent's folder is still intact after the newcomer synced", has(dirA, EXPECT), show(dirA, EXPECT))

// Later: the teammate who seeded day one returns with the OLD copy of two.js and its own ancestors.
const seed2 = join(dirSeed, 'Wipe-Seed')
T('the returning teammate picks up the newer two.js instead of pushing the old one back', await until(() => has(dirSeed, EXPECT), 30000), show(dirSeed, EXPECT))
await sleep(2500)
T('and nobody was rolled back once everyone was in', has(dirA, EXPECT) && has(dirB, EXPECT) && has(dirSeed, EXPECT), `A: ${show(dirA, { 'src/two.js': 1 })}  B: ${show(dirB, { 'src/two.js': 1 })}`)

for (const c of [a, b, seed2]) { try { c.stop() } catch { } }
await stopRelay(relay)
for (const d of [dirSeed, dirA, dirB]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { } }
console.log(`\n=== THE MORNING AFTER: ${pass} passed, ${fail} failed ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 300)
