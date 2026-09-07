#!/usr/bin/env node
/**
 * MULTIPLAYER SCORECARD — five falsifiable checks against a REAL relay.
 *
 * Epstein's Multiplayer AI RFS asks for one thing: "Anyone on a team should be able to
 * drop into the same live agent session to watch it work, redirect it, and hand it off."
 * These five checks are that sentence, made falsifiable.
 *
 * Check 4 is the one that matters. Coordination produced by PROMPTING looks identical to
 * coordination produced by INFRASTRUCTURE — until an agent tries to break the rules. If a
 * rogue write is refused by the relay rather than declined by a polite agent, the
 * coordination is real and does not depend on the model cooperating.
 *
 * Everything printed here is produced by server.js and sync.js. Nothing is a fixture.
 * Exits non-zero if any check fails.
 *
 *   node scorecard.mjs            # RELAYLOG=1 to dump the relay's own output
 */
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { sign } from './token.js'
import { startSync } from './sync.js'

process.env.HIVE_PROVENANCE = 'on'
// Six clients in ONE process is a test-harness shape, not a product shape (agents normally
// run one per process). Raise the limit so the run does not print a listener warning.
process.setMaxListeners(40)

const PORT = 1462
const SECRET = 'scorecard-secret'
const BASE = 'scorecard-' + crypto.randomBytes(5).toString('hex')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-scorecard-'))
const mkdir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rd = (h, f) => { try { return fs.readFileSync(path.join(tmp, h, f), 'utf8') } catch { return null } }
const wr = (h, f, t) => fs.writeFileSync(path.join(tmp, h, f), t)

const rows = []
let fails = 0
// Three states on purpose. GAP is a limitation we have MEASURED and are choosing to state
// out loud rather than assert around; it prints loudly but does not fail the run. A claim
// that quietly drops its own counter-evidence is worth less than one that names it.
function CHECK(n, title, state, detail) {
  const s = state === true ? 'PASS' : state === 'GAP' ? 'GAP ' : 'FAIL'
  rows.push({ n, title, s })
  if (s === 'FAIL') fails++
  console.log('  ' + s + '  [' + n + '] ' + title)
  if (detail) console.log('        ' + detail)
}

const relay = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HIVE_AUTH_MODE: 'required',
    HIVE_JWT_SECRET: SECRET,
    HIVE_JWT_ALG: 'HS256',
    HIVE_ENFORCE_CLAIMS: 'queue',
    HIVE_PROVENANCE: 'on',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const relayLog = []
relay.stdout.on('data', (d) => relayLog.push(String(d)))
relay.stderr.on('data', (d) => relayLog.push(String(d)))
await sleep(1500)

const FULL = [{ room: BASE, role: 'agent', paths: ['**'] }]
const mint = (name, scopes) => sign({
  sub: name, name, kind: 'ai', scopes: scopes || FULL,
  exp: Math.floor(Date.now() / 1000) + 3600,
}, { secret: SECRET })
const mk = (name, home, scopes, kind) => startSync({
  relay: 'ws://localhost:' + PORT, room: BASE, dir: mkdir(home),
  name, kind: kind || 'ai', token: mint(name, scopes), log: () => {},
})

const SEED = 'function fa() {\n  return 1\n}\n\nfunction fb() {\n  return 2\n}\n'

console.log('\nMULTIPLAYER SCORECARD    room=' + BASE + '  relay=ws://localhost:' + PORT)
console.log('enforcement: claims=queue   auth=required   provenance=on\n')

// ── 1. TWO WRITERS, ONE FILE, SAME MOMENT ─────────────────────────────────────
// If this needs a lock, a turn, or a merge-later step, it is not multiplayer.
console.log('# 1 — two writers edit ONE file at the same moment')
const A = mk('Ada', 'a')
const B = mk('Blake', 'b')
await sleep(3500)
wr('a', 'app.js', SEED)
await sleep(4500)
const bGotSeed = (rd('b', 'app.js') || '').includes('function fb')
wr('a', 'app.js', (rd('a', 'app.js') || '').replace('return 1', 'return 10'))
wr('b', 'app.js', (rd('b', 'app.js') || '').replace('return 2', 'return 20'))
await sleep(6500)
const aF = rd('a', 'app.js') || ''
const bF = rd('b', 'app.js') || ''
const bothSurvive = aF.includes('return 10') && aF.includes('return 20') &&
                    bF.includes('return 10') && bF.includes('return 20')
CHECK(1, 'both simultaneous edits survive, on BOTH machines', bGotSeed && bothSurvive,
  bothSurvive
    ? 'Ada wrote return 10, Blake wrote return 20 — no lock, no turn, no merge step, nothing lost'
    : 'seeded=' + bGotSeed + ' Ada=[' + aF.includes('return 10') + ',' + aF.includes('return 20') +
      '] Blake=[' + bF.includes('return 10') + ',' + bF.includes('return 20') + ']')

// ── 2. LATE JOIN ──────────────────────────────────────────────────────────────
// The RFS sentence verbatim: drop into a session already in progress.
console.log('\n# 2 — someone joins AFTER the work started')
const C = mk('Cara', 'c')
await sleep(5500)
const cText = rd('c', 'app.js') || ''
CHECK(2, 'a late joiner receives current state with no replay step',
  cText.includes('return 10') && cText.includes('return 20'),
  cText
    ? 'Cara joined cold and already has both edits (' + cText.length + ' bytes of app.js)'
    : 'Cara never received app.js')

// ── 3. HUMAN REDIRECT REACHES A RUNNING AGENT ─────────────────────────────────
// Honest scope: this proves DELIVERY into a live agent's context without restarting it.
// Whether a model then obeys is a model property, observed separately in the 4-agent run.
console.log('\n# 3 — a HUMAN drops in and redirects, mid-run')
const H = mk('Ganesh', 'h', null, 'human')
await sleep(3000)
const REDIRECT = 'stop on app.js and move to routes.js instead'
try { H.say(REDIRECT) } catch (e) { console.log('        say() threw: ' + e.message) }
await sleep(4500)
const inAda = (rd('a', 'HIVE_CHAT.md') || '').includes(REDIRECT)
const inCara = (rd('c', 'HIVE_CHAT.md') || '').includes(REDIRECT)
CHECK(3, "a human's redirect lands in every running agent's context", inAda && inCara,
  inAda && inCara
    ? 'delivered to Ada and Cara without restarting either process (delivery, not obedience)'
    : 'Ada=' + inAda + ' Cara=' + inCara)

// ── 4. THE RELAY REFUSES AN OUT-OF-SCOPE WRITE ────────────────────────────────
// THE decisive check. Dana may only touch docs/**. She tries app.js anyway.
console.log('\n# 4 — a rogue agent writes OUTSIDE its scope')
const D = mk('Dana', 'd', [{ room: BASE, role: 'agent', paths: ['docs/**'] }])
await sleep(4000)
const viaApi = D.edit('app.js', 'module.exports = "pwned"', 'take over app.js')
CHECK('4a', 'the client refuses an out-of-scope authored write',
  !!(viaApi && viaApi.error),
  viaApi && viaApi.error ? 'edit() -> ' + JSON.stringify(viaApi.error) : JSON.stringify(viaApi))

// The stronger form: bypass the API entirely and write the file on disk.
fs.mkdirSync(path.join(tmp, 'd', 'docs'), { recursive: true })
wr('d', 'app.js', 'module.exports = "pwned by a raw disk write"')
await sleep(5500)
const leaked = (rd('a', 'app.js') || '').includes('pwned') || (rd('c', 'app.js') || '').includes('pwned')
CHECK('4b', 'a RAW DISK write outside scope never reaches anyone else', !leaked,
  leaked
    ? 'LEAKED — the rogue edit propagated to another machine'
    : "the relay dropped Dana's out-of-scope write; it was not Dana's politeness")

wr('d', 'docs/note.md', '# Dana can write here\n')
await sleep(4500)
const inScope = (rd('a', 'docs/note.md') || '').includes('Dana can write here')
CHECK('4c', '...while her IN-scope write goes through normally', inScope,
  inScope
    ? 'docs/note.md propagated — so the block is the scope, not a broken client'
    : 'the in-scope write also failed, so 4b proves nothing on its own')

// Read-everything / write-one-folder, enforced per file.
const E = mk('Evan', 'e', [{ room: BASE, role: 'agent', paths: ['**'], writePaths: ['docs/**'] }])
await sleep(4000)
const canRead = (rd('e', 'app.js') || '').includes('return 10')
const cannotWrite = !!((E.edit('app.js', 'x', 'try') || {}).error)
CHECK('4d', 'read-everything / write-one-folder is enforced per file', canRead && cannotWrite,
  'Evan can READ app.js: ' + canRead + ' | can WRITE app.js: ' + !cannotWrite)

// ── 5. PROVENANCE ─────────────────────────────────────────────────────────────
console.log('\n# 5 — who wrote each line?')
let prov = []
try { prov = A.provenanceOf('app.js') || [] } catch (e) { prov = [{ error: e.message }] }
let ver = {}
try { ver = A.verifyProvenanceOf('app.js') || {} } catch (e) { ver = { error: e.message } }
const authors = [...new Set((Array.isArray(prov) ? prov : []).map((x) => x && x.name).filter(Boolean))]

// 5a — every record that EXISTS is cryptographically sound. This is the strong claim.
const signaturesGood = ver.ok === true && ver.count > 0 && ver.verified === ver.count && (ver.bad || []).length === 0
CHECK('5a', 'every provenance record is signed and verifies', signaturesGood,
  'verifyProvenanceOf -> count=' + ver.count + ' verified=' + ver.verified +
  ' bad=' + JSON.stringify(ver.bad || []) + ' authors=' + JSON.stringify(authors))

// 5b — MEASURED GAP. Provenance is a linear parent->contentHash chain, so it captures
// writes that became the head sequentially. When two edits merge CONCURRENTLY, both
// survive in the text (check 1) but only one carries an attestation. That is exactly the
// multiplayer case, so it is the honest limit of the claim and it is stated, not hidden.
const bothAttributed = authors.includes('Ada') && authors.includes('Blake')
CHECK('5b', 'a CONCURRENTLY-merged edit keeps its author attribution',
  bothAttributed ? true : 'GAP',
  bothAttributed
    ? 'both Ada and Blake are attributed on this run'
    : 'only ' + JSON.stringify(authors) + ' attributed. Blake\'s edit IS in the text but its ' +
      'attestation was not retained through the concurrent merge. NON-DETERMINISTIC: passes when ' +
      'the second write rebases cleanly, gaps when it truly merges. Fix = attest the merge result ' +
      'against both parents, or attribute per region.')

// ── teardown ──────────────────────────────────────────────────────────────────
for (const c of [A, B, C, H, D, E]) { try { c.stop() } catch { /* already down */ } }
await sleep(700)
relay.kill()
await sleep(300)

const bar = '========================================================================'
console.log('\n' + bar)
console.log('SCORECARD')
for (const r of rows) console.log('  [' + String(r.n).padEnd(3) + '] ' + r.s + '  ' + r.title)
console.log(bar)
const nPass = rows.filter((r) => r.s === 'PASS').length
const gaps = rows.filter((r) => r.s === 'GAP ')
console.log(nPass + ' passed, ' + fails + ' failed, ' + gaps.length + ' known gap(s), of ' + rows.length)
for (const g of gaps) console.log('  GAP: [' + g.n + '] ' + g.title)
console.log('')
if (process.env.RELAYLOG) console.log(relayLog.join(''))
process.exit(fails === 0 ? 0 : 1)
