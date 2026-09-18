// hive-gate — the handoff gate, unit + live.
//
//   node tests/hive-gate-test.mjs
//
// The unit half drives the pure functions with no relay. The live half is the one that matters:
// two real clients on a real relay, a real failing command, and the assertion that the claim is
// STILL HELD afterwards and the second agent still cannot take it. A gate that refuses in a
// message but drops the lock anyway would pass every unit test and be worthless.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { gateConfig, runGate, trimOutput, verdictRecord, refusalMessage, forcedMessage, DEFAULT_TIMEOUT_MS } from '../hive-gate.js'
import { startSync } from '../sync.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.HIVE_TEST_PORT) || 1251
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`) }
}
const section = (s) => console.log(`\n# ${s}`)

// ── unit ────────────────────────────────────────────────────────────────────────────────────
section('gateConfig — an unconfigured room must behave exactly as before')
T('no key at all means no gate', gateConfig({}) === null)
T('an empty string is not a gate', gateConfig({ 'gate:cmd': '' }) === null)
T('whitespace is not a gate', gateConfig({ 'gate:cmd': '   ' }) === null)
T('a command is a gate', gateConfig({ 'gate:cmd': 'npm test' }).cmd === 'npm test')
T('it defaults the timeout', gateConfig({ 'gate:cmd': 'x' }).timeoutMs === DEFAULT_TIMEOUT_MS)
T('it honours a timeout', gateConfig({ 'gate:cmd': 'x', 'gate:timeout': 5000 }).timeoutMs === 5000)
T('a timeout is capped so nobody can wedge a room for an hour', gateConfig({ 'gate:cmd': 'x', 'gate:timeout': 99999999 }).timeoutMs === 600000)
T('a nonsense timeout falls back to the default', gateConfig({ 'gate:cmd': 'x', 'gate:timeout': 'soon' }).timeoutMs === DEFAULT_TIMEOUT_MS)
T('it accepts a function getter (the CRDT map)', gateConfig((k) => ({ 'gate:cmd': 'go' })[k]).cmd === 'go')

section('runGate — exit code decides, and only exit code')
T('exit 0 passes', runGate({ cmd: 'node -e "process.exit(0)"', cwd: ROOT }).ok === true)
const bad = runGate({ cmd: 'node -e "process.exit(3)"', cwd: ROOT })
T('a non-zero exit fails', bad.ok === false)
T('it reports the exit code', bad.code === 3, `code=${bad.code}`)
const missing = runGate({ cmd: 'this-command-does-not-exist-anywhere', cwd: ROOT })
T('a command that cannot run FAILS rather than passing', missing.ok === false)
const out = runGate({ cmd: 'node -e "console.error(\'boom-marker\');process.exit(1)"', cwd: ROOT })
T('stderr is captured, not just stdout', /boom-marker/.test(out.out))
T('it measures how long the check took', out.ms >= 0 && Number.isFinite(out.ms))
// HIV-24: runGate supplies an isolated environment to the spawned gate command
const envOut = runGate({ cmd: 'node -e "console.log(process.env.HIVE_TEST_PORT)"', cwd: ROOT })
T('runGate sets an isolated HIVE_TEST_PORT in the command environment',
  /^\d+$/.test(envOut.out.trim()) && Number(envOut.out.trim()) > 1024, envOut.out.trim())
const customEnv = runGate({ cmd: 'node -e "console.log(process.env.CUSTOM_GATE_FLAG)"', cwd: ROOT, env: { CUSTOM_GATE_FLAG: 'isolated-ok' } })
T('custom env extends gate environment cleanly', customEnv.out.trim() === 'isolated-ok')

section('trimOutput — keep the END, because that is where failures are printed')
T('short output is untouched', trimOutput('all good') === 'all good')
const long = 'HEADER-BANNER\n' + 'x'.repeat(5000) + '\nFAILURE-AT-THE-END'
T('long output keeps the tail', /FAILURE-AT-THE-END/.test(trimOutput(long)))
T('long output drops the head', !/HEADER-BANNER/.test(trimOutput(long)))
T('it says how much it dropped', /chars trimmed/.test(trimOutput(long)))
T('null is handled', trimOutput(null) === '')

section('verdictRecord — per peer, micros, and the forced flag survives')
const rec = verdictRecord({ region: 'a.js', by: 'Ada', cmd: 'npm test', result: { ok: false, code: 1, timedOut: false, ms: 12, out: 'nope' } })
T('it records the peer', rec.by === 'Ada')
T('it records pass/fail', rec.pass === false)
T('it records the exit code', rec.exit === 1)
T('the timestamp is unix MICROseconds, per project rule', rec.at > 1e15 && Number.isInteger(rec.at))
const forced = verdictRecord({ region: 'a.js', by: 'Ada', cmd: 'x', result: null, forced: true, why: 'abandoning' })
T('a forced record is marked forced', forced.forced === true)
T('a forced record keeps the reason', forced.why === 'abandoning')
T('a forced record with no result does not claim to have passed', forced.pass === false)

section('refusalMessage — it must say the claim is still yours')
const msg = refusalMessage({ region: 'src/x.js', cmd: 'npm test', result: { ok: false, code: 1, timedOut: false, ms: 900, out: 'two failures' } })
T('it carries a Q code', /Q490/.test(msg))
T('it names the command', /npm test/.test(msg))
T('it says the region is STILL YOURS — otherwise the agent backs off like a collision', /STILL YOURS/.test(msg))
T('it says retrying will not help', /retrying/i.test(msg))
T('it includes the output', /two failures/.test(msg))
const tmsg = refusalMessage({ region: 'a.js', cmd: 'x', result: { ok: false, code: null, timedOut: true, ms: 120000, out: '' } })
T('a timeout gets its own code', /Q491/.test(tmsg))
T('forcedMessage names who and why', /Q492/.test(forcedMessage({ region: 'a.js', by: 'Ada', why: 'giving up' })) && /Ada/.test(forcedMessage({ region: 'a.js', by: 'Ada', why: 'giving up' })))
T('a forced release with no reason still says so', /no reason given/.test(forcedMessage({ region: 'a.js', by: 'Ada', why: '' })))

// ── live ────────────────────────────────────────────────────────────────────────────────────
section('live — a real relay, a real failing check, a claim that does not move')
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_SEATS: '4' }, stdio: ['ignore', 'ignore', 'pipe'] })
await sleep(2500)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'))
const mk = (name) => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return startSync({ relay: `ws://127.0.0.1:${PORT}`, room: 'gate-test', dir, name, kind: 'ai', syncFiles: false, log: () => {} })
}
const ada = mk('Ada'), kai = mk('Kai')
await sleep(3000)

const FILE = 'src/routes/index.js'
T('Ada takes the file', ada.claim(FILE, 'register a route') === true)
await sleep(1200)
T('Kai cannot take it while Ada holds it', kai.claim(FILE, 'register mine') === false)

// No gate yet: release behaves exactly as it always did.
const plain = ada.release(FILE)
T('with no gate configured, release succeeds', plain.ok === true && plain.gated === false)
await sleep(1200)
T('…and the file really is free', kai.claim(FILE, 'mine now') === true)
kai.release(FILE)
await sleep(1000)

// Now the room sets a gate that FAILS.
ada.setState('gate:cmd', 'node -e "console.error(\'2 tests failing\');process.exit(1)"')
ada.setState('gate:timeout', 20000)
await sleep(1500)
T('the room reports its gate', (ada.gate() || {}).cmd !== undefined)

T('Ada takes the file again', ada.claim(FILE, 'edit') === true)
await sleep(1000)
const refused = ada.release(FILE)
T('THE GATE REFUSES THE HANDOFF', refused.ok === false, JSON.stringify({ ok: refused.ok, code: refused.code }))
T('the refusal carries Q490', refused.code === 'Q490')
T('the refusal explains itself', /2 tests failing/.test(refused.message))
await sleep(1500)
T('ADA STILL HOLDS IT — the refusal is not just a message', (ada.senseClaim(FILE) || {}).by === 'Ada')
T('AND KAI STILL CANNOT TAKE IT', kai.claim(FILE, 'let me try') === false)
const verdicts = kai.gateVerdicts(FILE)
T('the failure is visible to the OTHER agent, by name', verdicts.Ada && verdicts.Ada.pass === false)
T('…and is recorded per peer, not as room truth', Object.keys(verdicts).length === 1 && verdicts.Ada.by === 'Ada')

// Ada fixes it: the gate passes and the handoff completes.
ada.setState('gate:cmd', 'node -e "process.exit(0)"')
await sleep(1500)
const ok = ada.release(FILE)
T('a passing gate lets the handoff through', ok.ok === true && ok.gated === true)
await sleep(1500)
T('…and Kai can now take it', kai.claim(FILE, 'my turn') === true)
kai.release(FILE)
await sleep(1000)

// Force: abandoning work is legitimate, and it is never silent.
ada.setState('gate:cmd', 'node -e "process.exit(1)"')
await sleep(1200)
T('Ada takes it once more', ada.claim(FILE, 'edit') === true)
await sleep(800)
const f = ada.release(FILE, { force: true, why: 'abandoning this approach' })
T('force releases despite the failing gate', f.ok === true && f.forced === true)
await sleep(1500)
T('…and the force is RECORDED, not silent', (kai.gateVerdicts(FILE).Ada || {}).forced === true)
T('…with the reason attached', /abandoning this approach/.test((kai.gateVerdicts(FILE).Ada || {}).why || ''))
T('…and the file really did become free', kai.claim(FILE, 'taking it') === true)

ada.stop(); kai.stop(); relay.kill()
console.log(`\n=== GATE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
