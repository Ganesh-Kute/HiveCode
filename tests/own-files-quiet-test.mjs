// OWN FILES STAY QUIET (27 Sep 2026). The "created here but is ignored" notice exists so that a file
// an agent makes, which a .gitignore hides from the room, is announced instead of silently staying
// local. It fired for .hive-shadow.json -- the client's OWN ancestor store -- so every agent joining
// the live room told the whole team about a file none of them had made. Both halves are pinned:
// Hivecode's own files never trigger it, and a real ignored file still does (anti-vacuity).
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.HIVE_TEST_PORT) || (21000 + (process.pid % 19000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`) }
async function until(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await pred()) return true } catch { } await sleep(250) } return false }

const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
relay.stderr.on('data', () => { })
await new Promise((res, rej) => { relay.stdout.on('data', (d) => { if (/listening on/.test(d)) res() }); relay.on('exit', (c) => rej(new Error('relay exited ' + c))) })

const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-own-quiet-'))
fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.txt\n')
fs.writeFileSync(path.join(dir, 'app.js'), 'export const a = 1\n')
const hive = startSync({ relay: `ws://localhost:${PORT}`, room: `own-quiet-${process.pid}`, dir, name: 'Quiet-A', kind: 'ai', log: () => { } })
const chat = hive.doc.getArray('chat')
const lines = () => chat.toArray().map((m) => String((m && m.text) || ''))
const OWN = ['.hive-shadow.json', '.hive-shadow.json.tmp', '.hive-lock.json', '.hive-mcp-session.json', '.hive-id.json']

console.log('\n=== OWN FILES STAY QUIET ===')
const shadow = await until(() => fs.existsSync(path.join(dir, '.hive-shadow.json')), 20000)
T('the client wrote its own .hive-shadow.json into the folder (so the check below is not vacuous)', shadow)

// A file the agent makes AFTER joining, hidden by the .gitignore: exactly what the notice is for.
fs.writeFileSync(path.join(dir, 'secret.txt'), 'local only\n')
const real = await until(() => lines().some((l) => l.includes('secret.txt was created here but is ignored')), 30000)
T('a real ignored file the agent created is still announced', real)

const noisy = lines().filter((l) => OWN.some((f) => l.includes(f)))
T('no chat line names a file Hivecode keeps for itself', noisy.length === 0, noisy.slice(0, 2).join(' | '))

try { hive.stop() } catch { }
relay.kill()
try { fs.rmSync(dir, { recursive: true, force: true }) } catch { }
console.log(`\n=== OWN FILES STAY QUIET: ${pass} passed, ${fail} failed ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 300)
