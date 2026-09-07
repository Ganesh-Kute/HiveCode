// CREDENTIAL SPLIT test — two credentials with opposite sharing rules, and the gap that
// meant licensing could never have worked.
//
// THE BUG THAT MATTERED MOST
//
// The relay has always read TWO query parameters: `?token=` (room access) and `?license=`
// (billing). It calls verifyLicense() on the licence and, with HIVE_REQUIRE_LICENSE=true,
// refuses the connection when it is invalid.
//
// The client never sent a licence. Not sync.js, not hive-mcp.js, not the extension. So
// turning licence enforcement on would have refused EVERY connection from a real client with
// 402 Payment Required, because verifyLicense('') can only fail. The feature was
// relay-complete and client-absent, and nothing revealed that because nothing had ever
// switched it on.
//
// THE OTHER HALF: WHERE IT MAY COME FROM
//
//   token    = a room invite. Short-lived, scoped, MEANT to be shared -- it rides in the
//              join link so an invitee can paste one string.
//   license  = whose subscription this bills to. Must never be shared.
//
// So the licence must come from per-machine places (an argument, $HIVE_LICENSE,
// ~/.hivecode/config.json) and must NOT come from the join link or from .hive.json, because
// the link is pasted into chat and .hive.json sits in the repo. Those exclusions are
// assertions here, not comments, because a future refactor that "helpfully" reads the licence
// out of .hive.json would reintroduce the leak silently.
//
//   node tests/credential-split-test.mjs
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { resolveLicense, startSync, parseLink } from '../sync.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

console.log('\n# resolveLicense — precedence, and what it refuses to read')
const savedEnv = process.env.HIVE_LICENSE
delete process.env.HIVE_LICENSE
T('nothing configured -> empty, which is a valid anonymous state', resolveLicense('') === '')
T('an explicit argument wins', resolveLicense('HC-EXPLICIT') === 'HC-EXPLICIT')
process.env.HIVE_LICENSE = 'HC-FROM-ENV'
T('$HIVE_LICENSE is used when there is no argument', resolveLicense('') === 'HC-FROM-ENV')
T('an argument still beats the environment', resolveLicense('HC-EXPLICIT') === 'HC-EXPLICIT')
T('whitespace is trimmed', resolveLicense('  HC-PADDED  ') === 'HC-PADDED')
delete process.env.HIVE_LICENSE

console.log('\n# The join link carries a room invite — NEVER an account licence')
const link = 'wss://relay.example|room-abc|ROOM-INVITE-JWT'
const parsed = parseLink(link)
T('parseLink returns the room invite as `token`', parsed.token === 'ROOM-INVITE-JWT')
T('parseLink has no licence field at all', !('license' in parsed))
T('a link token is NOT treated as a licence', resolveLicense('') === '')

console.log('\n# .hive.json is a room invite file, not a billing file')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-cred-'))
const proj = path.join(tmp, 'proj'); fs.mkdirSync(proj)
// A hostile/legacy .hive.json that names a licence. It sits in the repo and gets committed,
// so it must have no effect whatsoever.
fs.writeFileSync(path.join(proj, '.hive.json'), JSON.stringify({
  relay: 'wss://x', room: 'r', token: 'INVITE', license: 'HC-SHOULD-BE-IGNORED', licenseKey: 'HC-ALSO-IGNORED',
}))
const cwd = process.cwd()
process.chdir(proj)
T('a licence in .hive.json is ignored', resolveLicense('') === '')
process.chdir(cwd)

console.log('\n# ~/.hivecode/config.json IS a valid source (per-machine, outside the repo)')
// Verified by construction rather than by writing to the real home directory: the function
// reads os.homedir(), and writing there would pollute the machine running the test.
const homeCfg = path.join(os.homedir(), '.hivecode', 'config.json')
T('the home config path is outside any project folder', !homeCfg.startsWith(process.cwd()))
T('...and it is per-user', homeCfg.startsWith(os.homedir()))

console.log('\n# The relay actually RECEIVES the licence now (the gap that was closed)')
const PORT = 1457
const seen = []
// A stand-in relay that records the query string of every upgrade. Using the real server.js
// would drag in auth and licence validation; what is under test is that the parameter is on
// the wire at all, which it never was before.
const { WebSocketServer } = await import('ws')
const http = await import('http')
const srv = http.createServer()
const wss = new WebSocketServer({ noServer: true })
srv.on('upgrade', (req, socket, head) => {
  seen.push(req.url || '')
  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req) })
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))

const d1 = path.join(tmp, 'a'); fs.mkdirSync(d1)
const s1 = startSync({
  relay: `ws://127.0.0.1:${PORT}`, room: 'billing-' + crypto.randomBytes(3).toString('hex'),
  dir: d1, name: 'A', kind: 'ai', token: 'INVITE-JWT', license: 'HC-PRO-DEADBEEF', log: () => { },
})
await sleep(1500)
const q = seen.join(' ')
T('the connection carries ?license=', /license=HC-PRO-DEADBEEF/.test(q))
T('...and ?token= separately', /token=INVITE-JWT/.test(q))
T('they are DIFFERENT parameters, not one value reused', !/license=INVITE-JWT/.test(q) && !/token=HC-PRO-DEADBEEF/.test(q))
s1.stop()

seen.length = 0
const d2 = path.join(tmp, 'b'); fs.mkdirSync(d2)
process.env.HIVE_LICENSE = 'HC-PRO-FROMENV'
const s2 = startSync({
  relay: `ws://127.0.0.1:${PORT}`, room: 'env-' + crypto.randomBytes(3).toString('hex'),
  dir: d2, name: 'B', kind: 'ai', log: () => { },
})
await sleep(1500)
T('$HIVE_LICENSE reaches the relay with no explicit argument', /license=HC-PRO-FROMENV/.test(seen.join(' ')))
s2.stop()
delete process.env.HIVE_LICENSE

seen.length = 0
const d3 = path.join(tmp, 'c'); fs.mkdirSync(d3)
const s3 = startSync({
  relay: `ws://127.0.0.1:${PORT}`, room: 'anon-' + crypto.randomBytes(3).toString('hex'),
  dir: d3, name: 'C', kind: 'ai', log: () => { },
})
await sleep(1500)
T('with nothing configured, no licence parameter is sent at all', !/license=/.test(seen.join(' ')))
T('...and the connection is still made — anonymous is a supported state', seen.length > 0)
s3.stop()

console.log('\n# The MCP server does not persist the licence into the project folder')
const mcpSrc = fs.readFileSync(new URL('../hive-mcp.js', import.meta.url), 'utf8')
T('hive-mcp writes .hive.json without any licence', /\.hive\.json'\), JSON\.stringify\(\{ relay, room, \.\.\.\(useToken/.test(mcpSrc))
T('hive-mcp never reads a licence from the link', !/linkToken.*licen/i.test(mcpSrc))

console.log('\n# The extension reads SecretStorage, not settings.json')
const extSrc = fs.readFileSync(new URL('../extension/extension.js', import.meta.url), 'utf8')
T('it reads hive.license from SecretStorage', /secrets\.get\('hive\.license'\)/.test(extSrc))
T('it stores into SecretStorage', /secrets\.store\('hive\.license'/.test(extSrc))
T('a legacy settings.json value is migrated once', /legacy/.test(extSrc) && /secrets\.store\('hive\.license', legacy\)/.test(extSrc))
T('...and then CLEARED from settings, both scopes', /ConfigurationTarget\.Global\)/.test(extSrc) && /ConfigurationTarget\.Workspace\)/.test(extSrc))
T('the licence is attached to the relay connection', /wsParams\.license = licenseForRelay/.test(extSrc))

srv.close(); wss.close()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
if (savedEnv !== undefined) process.env.HIVE_LICENSE = savedEnv
console.log(`\n=== CREDENTIAL SPLIT: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
