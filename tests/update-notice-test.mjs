// tests/update-notice-test.mjs -- an agent on an old build must be TOLD, because nothing updates it.
//
// `hivecode-mcp setup` points agent apps at a runtime copy, so the version no longer moves on
// its own the way `npx ...@latest` did. hive-update.js asks npm once per server start and puts a
// line in hive_join and hive_status when a newer build is out. Section D proves that end to end:
// a real server process, a fake registry, a real relay, a real join -- not a unit call.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { newer, updateNotice, startUpdateCheck, _test as U } from '../hive-update.js'
import { VERSION } from '../hive-version.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let pass = 0, fail = 0
const T = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? '\n         ' + extra : ''}`) }
const tick = () => new Promise((r) => setTimeout(r, 20))

console.log('\nA. comparing versions')
T('A1 0.12.2 is newer than 0.12.1', newer('0.12.2', '0.12.1'))
T('A2 a version is not newer than itself', !newer('0.12.1', '0.12.1'))
T('A3 0.13.0 beats 0.12.9 (numeric, not string, comparison)', newer('0.13.0', '0.12.9') && newer('0.12.10', '0.12.9'))
T('A4 older is never newer', !newer('0.12.0', '0.12.1') && !newer('0.9.9', '0.10.0'))
T('A5 garbage is never newer (a broken registry answer stays silent)', !newer('garbage', '0.1.0') && !newer('', '0.1.0'))

console.log('\nB. the notice')
U.setLatest('99.0.0')
T('B1 a newer build gives a notice that names the command to run', /UPDATE AVAILABLE/.test(updateNotice()) && updateNotice().includes('npx -y hivecode-mcp@latest setup'))
U.setLatest(VERSION)
T('B2 the same build says nothing', updateNotice() === '')
U.setLatest(null)
T('B3 not knowing says nothing', updateNotice() === '')

console.log('\nC. the check')
let calls = 0
const fake = (answer) => async () => { calls++; if (answer instanceof Error) throw answer; return answer }
U.reset(); startUpdateCheck({ fetchImpl: fake({ ok: true, json: async () => ({ version: '99.0.0' }) }), env: {} }); await tick()
T('C1 a registry answer is picked up', U.latest() === '99.0.0')
U.reset(); startUpdateCheck({ fetchImpl: fake(new Error('offline')), env: {} }); await tick()
T('C2 offline stays silent', U.latest() === null && updateNotice() === '')
U.reset(); startUpdateCheck({ fetchImpl: fake({ ok: false, json: async () => ({ version: '99.0.0' }) }), env: {} }); await tick()
T('C3 an HTTP error is not believed', U.latest() === null)
calls = 0
U.reset(); startUpdateCheck({ fetchImpl: fake({ ok: true, json: async () => ({ version: '99.0.0' }) }), env: { HIVE_PRIVATE: '1' } }); await tick()
T('C4 HIVE_PRIVATE=1 makes no request at all', calls === 0 && U.latest() === null)
U.reset(); startUpdateCheck({ fetchImpl: fake({ ok: true, json: async () => ({ version: '99.0.0' }) }), env: { HIVE_NO_UPDATE_CHECK: '1' } }); await tick()
T('C5 HIVE_NO_UPDATE_CHECK=1 makes no request at all', calls === 0)

console.log('\nD. end to end: a real server, a fake registry, a real relay, a real join')
const registry = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: '99.0.0' })) })
await new Promise((r) => registry.listen(0, '127.0.0.1', r))
const REG = `http://127.0.0.1:${registry.address().port}/latest`
const PORT = 26500 + (process.pid % 4000)
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore', windowsHide: true })
const up = () => new Promise((r) => http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (x) => { x.resume(); r(true) }).on('error', () => r(false)))
for (let i = 0; i < 80 && !(await up()); i++) await new Promise((r) => setTimeout(r, 150))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-update-'))
const srv = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], {
  cwd: work, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  env: { ...process.env, HIVE_UPDATE_URL: REG, HIVE_PRIVATE: '', HIVE_NO_UPDATE_CHECK: '', HIVE_HOME: path.join(work, 'hh') },
})
let buf = ''
const replies = new Map()
srv.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id) replies.set(m.id, m) } })
const rpc = async (id, method, params) => { srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let i = 0; i < 200 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 50)); return replies.get(id) }
await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
await new Promise((r) => setTimeout(r, 800)) // the check is in the background; give it the moment it needs
const join = await rpc(2, 'tools/call', { name: 'hive_join', arguments: { link: `ws://127.0.0.1:${PORT}|room-upd`, name: 'Old' } })
const joinText = (join && join.result && join.result.content || []).map((c) => c.text).join('\n')
T('D1 the join banner of a server on an older build says UPDATE AVAILABLE', /UPDATE AVAILABLE: hivecode 99\.0\.0/.test(joinText), joinText.slice(0, 300))
const st = await rpc(3, 'tools/call', { name: 'hive_status', arguments: {} })
const stText = (st && st.result && st.result.content || []).map((c) => c.text).join('\n')
T('D2 so does hive_status', /"update": "UPDATE AVAILABLE/.test(stText), stText.slice(0, 300))
srv.stdin.end()
await new Promise((r) => { srv.on('exit', r); setTimeout(r, 3000) })
relay.kill(); registry.close()
try { fs.rmSync(work, { recursive: true, force: true }) } catch {}

console.log(`\n=== UPDATE NOTICE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
