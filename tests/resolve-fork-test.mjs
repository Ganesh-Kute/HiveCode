// INTENT-AWARE FORK RESOLUTION, live: two agents fork the same line with different
// (signed) intents; a THIRD agent — the judge — reads the fork as a resolvable object
// and reconciles BOTH intents. The medium must:
//   1. surface the fork with both versions AND both verified intents,
//   2. REFUSE a broken resolution (doesn't parse) — broken judge output cannot ship,
//   3. REFUSE a resolution that leaves a dangling reference,
//   4. LAND a valid reconciliation and converge every peer on it.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from './sync.js'

const PORT = 1317
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = (port, env) => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port), ...env } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }

const relay = await startRelay(PORT, { HIVE_PROVENANCE: 'strict' })
process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-resolve-'))
const room = 'resolve-' + crypto.randomBytes(6).toString('hex')
const dA = path.join(tmp, 'a'), dB = path.join(tmp, 'b'), dJ = path.join(tmp, 'j')
for (const d of [dA, dB, dJ]) fs.mkdirSync(d, { recursive: true })
console.log(`RESOLVE-FORK: 2 agents fork the same line, a 3rd agent JUDGES, room ${room}\n`)
const A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dA, name: 'A', kind: 'ai', log: () => {} })
const B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
const J = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dJ, name: 'Judge', kind: 'ai', log: () => {} })
await sleep(3500)

// seed: `report` REFERENCES `limit`, so deleting `limit` later must be a dangling ref
const SEED = 'function limit(user) {\n  return 100\n}\nfunction report(user) {\n  return limit(user) * 2\n}\nmodule.exports = { limit, report }\n'
A.claim('m.js', 'seed'); fs.writeFileSync(path.join(dA, 'm.js'), SEED); await sleep(3000); A.release('m.js')
await sleep(2500)
T('B received the seed', fs.existsSync(path.join(dB, 'm.js')))
T('Judge received the seed', fs.existsSync(path.join(dJ, 'm.js')))

// both edit the SAME line ~simultaneously, each with a DECLARED intent (the WHY).
// A writes THROUGH the medium (the zero-race hive.edit path); B writes to disk and
// is captured by the watcher — the fork must be detected across BOTH write paths.
console.log('# A: 100 -> 250 via hive.edit (zero-race)   |   B: 100 -> 1000 via disk (watcher)')
B.claim('m.js', 'enterprise load test needs 1000/min')
const eA = path.join(dA, 'm.js'), eB = path.join(dB, 'm.js')
const rEdit = A.edit('m.js', fs.readFileSync(eA, 'utf8').replace('return 100', 'return 250'), 'prod traffic grew - 100/min throttles real users, raise to 250')
T('hive.edit landed the authored write', rEdit.ok === true)
fs.writeFileSync(eB, fs.readFileSync(eB, 'utf8').replace('return 100', 'return 1000'))

// wait for the fork to surface on the JUDGE as a resolvable object
let fork = null
for (let t = 0; t < 30 && !fork; t++) { await sleep(1000); fork = J.forkInfo('m.js') }
T('fork surfaced to the judge as a resolvable object', !!fork)
if (!fork) { cleanup(); process.exit(1) }
T('fork carries the common base', !!fork.base && fork.base.includes('return 100'))
T('fork carries BOTH versions', fork.versions.length === 2 && fork.versions.some((v) => v.text && v.text.includes('return 250')) && fork.versions.some((v) => v.text && v.text.includes('return 1000')))
const intents = fork.versions.map((v) => v.intent)
console.log('  signed intents:', JSON.stringify(intents))
T('both signed intents are present (the WHY each side changed it)', intents.some((i) => i.includes('prod traffic')) && intents.some((i) => i.includes('enterprise load test')))

// 1) a BROKEN resolution (doesn't parse) must be REFUSED — nothing changes
const broken = J.resolveFork('m.js', 'function limit(user { return 42 ')
T('broken resolution REFUSED (unparseable)', !broken.ok)
console.log('  refusal reason:', broken.reason)
T('fork still active after the refusal', !!J.forkInfo('m.js'))

// 2) a resolution that DELETES `limit` while `report` still calls it -> dangling ref, REFUSED
const dangling = 'function report(user) {\n  return limit(user) * 2\n}\nmodule.exports = { report }\n'
const dang = J.resolveFork('m.js', dangling)
T('dangling-reference resolution REFUSED', !dang.ok)
console.log('  refusal reason:', dang.reason)
T('fork still active after the dangling refusal', !!J.forkInfo('m.js'))

// 3) the REAL judgment: reconcile BOTH intents (enterprise gets 1000, everyone else 250)
const RECONCILED = 'function limit(user) {\n  return user.tier === "enterprise" ? 1000 : 250\n}\nfunction report(user) {\n  return limit(user) * 2\n}\nmodule.exports = { limit, report }\n'
const good = J.resolveFork('m.js', RECONCILED)
T('intent-reconciling resolution LANDED', good.ok === true)
T('coverage reports BOTH sides\' changes survived (true reconciliation)', Array.isArray(good.coverage) && good.coverage.length === 2 && good.coverage.every((c) => c.covered))

// every peer must converge on the reconciled text, markers gone, fork cleared
let ca, cb, cj, settled = false
for (let t = 0; t < 25 && !settled; t++) {
  await sleep(1000)
  ca = fs.readFileSync(eA, 'utf8'); cb = fs.readFileSync(eB, 'utf8'); cj = fs.readFileSync(path.join(dJ, 'm.js'), 'utf8')
  settled = ca === RECONCILED && cb === RECONCILED && cj === RECONCILED
}
T('ALL THREE peers converged on the reconciled version', settled)
if (!settled) console.log('--- A ---\n' + ca + '--- B ---\n' + cb + '--- J ---\n' + cj)
T('no conflict markers anywhere', ![ca, cb, cj].some((s) => s.includes('<<<<<<<')))
T('fork record cleared on every peer', !A.forkInfo('m.js') && !B.forkInfo('m.js') && !J.forkInfo('m.js'))
const chat = fs.readFileSync(path.join(dJ, 'HIVE_CHAT.md'), 'utf8')
T('fork announcement carried both signed intents', chat.includes('SILENT FORK') && chat.includes('prod traffic') && chat.includes('enterprise load test'))
T('resolution announced in the room', chat.includes('FORK RESOLVED by Judge'))
// provenance: the judge's landed resolution is itself a signed receipt
const audit = J.verifyProvenanceOf('m.js')
T('ledger fully verified after resolution (every receipt signed)', audit.ok && audit.count > 0)

function cleanup() { for (const c of [A, B, J]) { try { c.stop() } catch {} } relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }
cleanup()
console.log(`\n=== RESOLVE-FORK: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
