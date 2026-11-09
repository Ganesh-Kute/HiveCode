// A command from the room runs on a machine only with that machine's consent (0.14.4 S-1).
//
//   node tests/gate-consent-test.mjs
//
// THE HOLE. `gate:cmd` is shared room state that any member (or anyone holding an open room's link)
// can write, and release() ran it with a shell in the RELEASING agent's folder, with that agent's
// tokens in its environment. On 0.14.3 G1 and G2 below create the marker in Kai's folder: code that
// somebody else chose, run on Kai's machine. After the fix it runs only where it was approved.
//
// The gate command here is a harmless marker: it writes GATE_RAN in the folder it runs in. Each agent
// gets its own approvals folder (gatesDir), the way two machines would.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { gateApproved, writeApproval, readApproval, revokeApproval, scrubEnv, runGate, notApprovedMessage, main as gateMain, GATE_NOT_APPROVED } from '../hive-gate.js'
import { startSync } from '../sync.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.HIVE_TEST_PORT) || (21000 + Math.floor(Math.random() * 8000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `  -- ${detail}` : ''}`) }
const section = (s) => console.log(`\n## ${s}`)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-consent-'))
process.env.HIVE_GATES_DIR = path.join(tmp, 'default-gates') // nothing here may touch the real ~/.hivecode

// ── unit ─────────────────────────────────────────────────────────────────────────────────────────
section('gateApproved: exact command, from this machine only')
const U = path.join(tmp, 'unit-gates')
T('U1 nothing approved: not approved', gateApproved({ room: 'r', cmd: 'npm test', dir: U, env: {} }) === '')
writeApproval('r', 'npm test', 'test', U)
T('U2 the exact command is approved', gateApproved({ room: 'r', cmd: 'npm test', dir: U, env: {} }) === 'test')
T('U3 a longer command that STARTS with it is not', gateApproved({ room: 'r', cmd: 'npm test; touch X', dir: U, env: {} }) === '')
T('U4 a shorter one is not', gateApproved({ room: 'r', cmd: 'npm', dir: U, env: {} }) === '')
T('U5 another room is not', gateApproved({ room: 'other', cmd: 'npm test', dir: U, env: {} }) === '')
T('U6 an empty or blank command is never approved', gateApproved({ room: 'r', cmd: '  ', dir: U, env: { HIVE_GATE: 'trust-room' } }) === '')
T('U7 HIVE_GATE_ALLOW approves exact lines', gateApproved({ room: 'x', cmd: 'node t.js', dir: U, env: { HIVE_GATE_ALLOW: 'npm run lint\nnode t.js' } }) === 'HIVE_GATE_ALLOW')
T('U8 …and nothing else', gateApproved({ room: 'x', cmd: 'node t.js && rm -rf /tmp/x', dir: U, env: { HIVE_GATE_ALLOW: 'node t.js' } }) === '')
T('U9 HIVE_GATE=trust-room is the explicit opt-in', gateApproved({ room: 'x', cmd: 'anything', dir: U, env: { HIVE_GATE: 'trust-room' } }) === 'HIVE_GATE=trust-room')
fs.writeFileSync(path.join(U, 'broken.json'), '{not json')
T('U10 a corrupt approval approves nothing', gateApproved({ room: 'broken', cmd: 'npm test', dir: U, env: {} }) === '')
T('U11 revoke removes it', revokeApproval('r', U) === true && gateApproved({ room: 'r', cmd: 'npm test', dir: U, env: {} }) === '')
T('U12 the message names the code, the command, and how a PERSON approves it', (() => { const m = notApprovedMessage({ region: 'a.js', cmd: 'npm test', dir: '/w' }); return m.includes(GATE_NOT_APPROVED) && m.includes('npm test') && m.includes('gate allow') && /Do not approve it yourself/.test(m) })())

section('scrubEnv: secrets stay out of a check')
const scrubbed = scrubEnv({ PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'g', GH_TOKEN: 'g', SLACK_BOT_TOKEN: 's', NPM_TOKEN: 'n', ANTHROPIC_API_KEY: 'a', AWS_SECRET_ACCESS_KEY: 'k', HIVE_TOKEN: 'h', MY_PASSWORD: 'p', NODE_ENV: 'test' })
T('S1 PATH, HOME and ordinary vars stay', scrubbed.PATH === '/bin' && scrubbed.HOME === '/h' && scrubbed.NODE_ENV === 'test')
T('S2 every credential-named var is gone', ['GITHUB_TOKEN', 'GH_TOKEN', 'SLACK_BOT_TOKEN', 'NPM_TOKEN', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'HIVE_TOKEN', 'MY_PASSWORD'].every((k) => !(k in scrubbed)))
process.env.GITHUB_TOKEN_FOR_TEST = 'leak-me'
const envDump = path.join(tmp, 'env.txt')
runGate({ cmd: `node -e "require('fs').writeFileSync('env.txt', Object.keys(process.env).join(','))"`, cwd: tmp })
const seen = fs.existsSync(envDump) ? fs.readFileSync(envDump, 'utf8').split(',') : []
T('S3 a real gate run does not see a token from this process', seen.length > 0 && !seen.includes('GITHUB_TOKEN_FOR_TEST') && seen.includes('PATH'), `saw ${seen.length} vars`)
delete process.env.GITHUB_TOKEN_FOR_TEST

section('gate allow / show / revoke: the person\'s command')
const folder = path.join(tmp, 'joined'); fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(path.join(folder, '.hive.json'), JSON.stringify({ relay: 'ws://x', room: 'room-cli' }))
const out = []; const log = (s) => out.push(String(s)); const env = { HIVE_GATES_DIR: path.join(tmp, 'cli-gates') }
T('C1 allow needs --cmd', await gateMain(['gate', 'allow', '--dir', folder], { log, logErr: log, env }) === 2 && /Q594/.test(out.join('\n')))
T('C2 allow pins the exact command', await gateMain(['gate', 'allow', '--dir', folder, '--cmd', 'npm test'], { log, logErr: log, env }) === 0 && (readApproval('room-cli', env.HIVE_GATES_DIR) || {}).cmd === 'npm test')
T('C3 show says what is approved', await gateMain(['gate', 'show', '--dir', folder], { log, logErr: log, env }) === 0 && /npm test/.test(out[out.length - 1]))
T('C4 revoke removes it', await gateMain(['gate', 'revoke', '--dir', folder], { log, logErr: log, env }) === 0 && readApproval('room-cli', env.HIVE_GATES_DIR) === null)
T('C5 a folder that is not a room is refused', await gateMain(['gate', 'show', '--dir', tmp], { log, logErr: log, env }) === 2 && /Q593/.test(out[out.length - 1]))

// ── live ─────────────────────────────────────────────────────────────────────────────────────────
section('live: a real relay, a gate set by one agent, released by another')
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_SEATS: '6' }, stdio: ['ignore', 'ignore', 'pipe'] })
await sleep(2500)
const ROOM = 'gate-consent-' + process.pid
const mk = (name) => {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true })
  const gates = path.join(tmp, `gates-${name}`)
  return { dir, gates, s: startSync({ relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir, name, kind: 'ai', syncFiles: false, gatesDir: gates, log: () => {} }) }
}
const ada = mk('Ada'), kai = mk('Kai'), eve = mk('Eve')
await sleep(3000)
const MARK = `node -e "require('fs').writeFileSync('GATE_RAN', process.argv[1] || 'x')" consent`
const ran = (who) => fs.existsSync(path.join(who.dir, 'GATE_RAN'))
const chatLines = () => kai.s.doc.getArray('chat').toArray().map((m) => String(m && m.text || ''))

ada.s.setState('gate:cmd', MARK)
await sleep(1500)
T('G0 every member sees the room\'s gate', (kai.s.gate() || {}).cmd === MARK)

const FILE = 'src/a.js'
T('G1a Kai takes a file', kai.s.claim(FILE, 'edit') === true)
await sleep(800)
const r1 = kai.s.release(FILE)
T('G1 THE ROOM\'S COMMAND DID NOT RUN IN KAI\'S FOLDER', !ran(kai), 'GATE_RAN exists in Kai\'s folder')
T('G1b the release went through, unchecked, with Q592', r1.ok === true && r1.gated === false && r1.gateSkipped === 'not-approved' && r1.code === GATE_NOT_APPROVED, JSON.stringify(r1).slice(0, 200))
T('G1c the message quotes the command and the person\'s way to approve it', /gate allow/.test(r1.message || '') && (r1.message || '').includes(MARK))
await sleep(1500)
T('G1d the file really is free', ada.s.claim(FILE, 'mine') === true)
ada.s.release(FILE)
await sleep(800)
T('G1e the skip is recorded where everyone can read it', (ada.s.gateVerdicts(FILE).Kai || {}).skipped === 'not-approved')
T('G8 the room is told whose hand-backs are unchecked', chatLines().filter((t) => t.includes("Kai's hand-backs are unchecked")).length === 1)
kai.s.claim(FILE, 'again'); await sleep(600); kai.s.release(FILE); await sleep(1200)
T('G8b …once, not on every release', chatLines().filter((t) => t.includes("Kai's hand-backs are unchecked")).length === 1)

section('G2: a raw write to room state (no tool, no identity) changes nothing')
const RAW = `node -e "require('fs').writeFileSync('GATE_RAN','raw')"`
eve.s.doc.getMap('swarm_state').set('gate:cmd', RAW)
await sleep(1500)
T('G2a Kai sees the raw command as the room\'s gate', (kai.s.gate() || {}).cmd === RAW)
kai.s.claim('src/b.js', 'edit'); await sleep(600)
const r2 = kai.s.release('src/b.js')
T('G2 IT DID NOT RUN IN KAI\'S FOLDER', !ran(kai) && r2.gateSkipped === 'not-approved')

section('G6: the session that sets a gate approves it for its own machine only')
ada.s.setState('gate:cmd', MARK)
await sleep(1200)
ada.s.claim('src/c.js', 'edit'); await sleep(600)
const r6 = ada.s.release('src/c.js')
T('G6 Ada set it, so it runs in Ada\'s folder', ran(ada) && r6.gated === true && r6.ok === true, JSON.stringify(r6).slice(0, 160))
T('G6b and Kai\'s machine still has no approval', gateApproved({ room: ROOM, cmd: MARK, dir: kai.gates, env: {} }) === '')

section('G3: Kai\'s person approves the exact command; G5: a changed command needs approval again')
writeApproval(ROOM, MARK, 'approved with gate allow', kai.gates)
kai.s.claim('src/d.js', 'edit'); await sleep(600)
const r3 = kai.s.release('src/d.js')
T('G3 approved, it runs in Kai\'s folder', ran(kai) && r3.gated === true && r3.ok === true, JSON.stringify(r3).slice(0, 160))
fs.rmSync(path.join(kai.dir, 'GATE_RAN'), { force: true })
const LONGER = MARK + ' && node -e "require(\'fs\').writeFileSync(\'EXTRA\',\'1\')"'
eve.s.doc.getMap('swarm_state').set('gate:cmd', LONGER)
await sleep(1500)
kai.s.claim('src/e.js', 'edit'); await sleep(600)
const r5 = kai.s.release('src/e.js')
T('G5 a command that merely STARTS with the approved one does not run', !ran(kai) && !fs.existsSync(path.join(kai.dir, 'EXTRA')) && r5.gateSkipped === 'not-approved')

ada.s.stop(); kai.s.stop(); eve.s.stop(); relay.kill()
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
console.log(`\n=== GATE CONSENT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
