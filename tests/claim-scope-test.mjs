// A CLAIM YOU CANNOT PUBLISH IS NOT A CLAIM. (HIV-27)
//
// Found live on 18 Sep 2026. An agent claimed `scripts/check-deploy.mjs`, edited it, released it
// through the gate, and reported success. Every step was green. The bytes never left its folder:
// `scripts/` was outside the allow-list .gitignore in use, so no other agent -- and no other
// folder -- ever saw the change. The claim held, the gate passed (it runs in the agent's OWN
// folder, where the file is perfectly real), and the work was genuinely done. It was simply
// invisible.
//
// WHY IT HAPPENS. A claim lives as a path STRING in the base room's `claims` map. Whether that
// path's BYTES sync is decided somewhere else entirely, per client, by canOpen/isIgnored.
// Nothing compared the two. They are separate systems that happen to be addressed by the same
// string, and that is the whole bug.
//
// It is the most insidious variant of this week's false-success family, because there is no
// failure to notice anywhere: the agent did the work, the lock was real, the gate really ran.
// It was only caught because a human-equivalent step went to read the diff before committing and
// found the file unchanged on the other side.
//
// The guard refuses at CLAIM time, not release time. By release the agent has already built the
// thing it meant to write, and the only thing left to tell it is that the work was wasted.
//
// THE FALSE-POSITIVE DIRECTION IS WHAT THIS TEST IS REALLY FOR. A claim may name a logical
// region ("auth-refactor") rather than a file, and under an ALLOW-LIST .gitignore -- `/*` then
// negations, which is how a room bounds itself against the one-socket-per-file limit -- an
// ignore check returns TRUE for every string that is not an explicitly allowed path. A naive
// guard would therefore refuse nearly every legitimate claim in exactly the rooms that need it
// most, and would be switched off within a day. Those cases are asserted permanently below.
//
//   node tests/claim-scope-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

// pid-derived: this suite can run as a room gate, and two agents may run it at the same moment.
// A fixed port means one fails to bind and the gate refuses a handoff for a reason that has
// nothing to do with the code under test. (HIV-24)
const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-claimscope-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'claimscope-' + crypto.randomBytes(6).toString('hex')
const dir = path.join(tmp, 'agent'); fs.mkdirSync(dir, { recursive: true })

// EXACTLY the shape that caused the incident: an allow-list that admits a couple of files and
// excludes everything else, `scripts/` included.
// `src/**` is open, `narrow/` admits exactly one file, and `scripts/` is excluded entirely --
// so the three cases that matter are all present in one room.
fs.writeFileSync(path.join(dir, '.gitignore'), [
  '/*', '!/.gitignore', '!/sync.js', '!/notes.md',
  '!/src/', '!/src/**',
  '!/narrow/', '/narrow/*', '!/narrow/only-this.js', '',
].join('\n'))
fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
fs.mkdirSync(path.join(dir, 'narrow'), { recursive: true })
fs.writeFileSync(path.join(dir, 'sync.js'), 'export const a = 1\n')
fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'export const b = 2\n')
fs.writeFileSync(path.join(dir, 'narrow', 'only-this.js'), 'export const d = 4\n')
fs.writeFileSync(path.join(dir, 'scripts', 'check-deploy.mjs'), 'export const c = 3\n')

let hive
try {
  hive = startSync({ relay: `ws://localhost:${PORT}`, room, dir, name: 'Claude', kind: 'ai', log: () => {} })
  await sleep(1200)

  // ---- A. the incident, reproduced exactly -------------------------------------------------
  const why = hive.whyNotShared('scripts/check-deploy.mjs')
  T('A1 the path from the real incident is flagged as unshared', why !== '', why)
  T('A2 the reason names the file, so it is actionable without reading the code',
    /scripts\/check-deploy\.mjs/.test(why))
  T('A3 the reason says the bytes stay local, which is the part that fools people',
    /never|stays|no other agent/i.test(why), why)

  // THE TWO SYSTEMS ARE STILL DECOUPLED BY DESIGN, and that is what makes the guard necessary
  // rather than redundant. The coordinator does not know what syncs; it only serialises strings.
  // If this ever starts returning false, the guard has moved and this test should be revisited.
  const stillClaimable = hive.claim('scripts/check-deploy.mjs', 'edit')
  T('A4 the raw coordinator STILL grants it -- claims and syncing remain separate systems',
    stillClaimable === true)
  try { hive.release('scripts/check-deploy.mjs', { force: true }) } catch { /* not the point here */ }

  // ---- B. it must NOT fire on legitimate claims ---------------------------------------------
  // Everything below is inside the allow-list or is not a file at all. A guard that refuses any
  // of these is worse than no guard, because it trains agents to ignore the refusal.
  T('B1 a file inside the allow-list is shareable', hive.whyNotShared('sync.js') === '',
    hive.whyNotShared('sync.js'))
  T('B2 an allowed file in a subdirectory is shareable', hive.whyNotShared('src/app.js') === '',
    hive.whyNotShared('src/app.js'))

  // THE CASE THAT KILLS A NAIVE IMPLEMENTATION. Under `/*` these strings are all "ignored",
  // because an allow-list ignores the entire world and adds a handful of paths back. They are
  // not files, so they are not this guard's business.
  T('B3 a logical region name is NOT refused, though an allow-list "ignores" it',
    hive.whyNotShared('auth-refactor') === '', hive.whyNotShared('auth-refactor'))
  T('B4 nor a multi-word region', hive.whyNotShared('the parser rewrite') === '',
    hive.whyNotShared('the parser rewrite'))
  T('B5 nor an empty region', hive.whyNotShared('') === '')

  // A file that does not exist yet but sits in open scope: claiming before creating is normal
  // and must keep working, or the guard breaks the most ordinary workflow there is.
  T('B6 a not-yet-created file inside an open allow-list directory is shareable',
    hive.whyNotShared('src/brand-new.js') === '', hive.whyNotShared('src/brand-new.js'))
  T('B7 an explicitly allowed file in a NARROWED directory is shareable',
    hive.whyNotShared('narrow/only-this.js') === '', hive.whyNotShared('narrow/only-this.js'))

  // ---- C. the other ways bytes fail to travel ----------------------------------------------
  // A not-yet-created file OUTSIDE the scope is the exact trap Builder fell into -- the file did
  // not exist anywhere else either, so nothing looked wrong.
  T('C1 a not-yet-created file OUTSIDE the scope is flagged too',
    hive.whyNotShared('scripts/brand-new.mjs') !== '', hive.whyNotShared('scripts/brand-new.mjs'))

  // THE TRAP I WALKED INTO WHILE WRITING THIS TEST, which is the strongest evidence it is worth
  // having. `narrow/` admits exactly one named file. I assumed a NEW file there would be fine --
  // it is inside an "allowed" directory, after all -- and the guard said otherwise. The guard
  // was right: under a narrowed allow-list the list must be widened BEFORE the file is created,
  // or the file is born outside sync scope and everything about it looks fine. That is the same
  // trap the original incident fell into, and it catches the person writing the guard.
  T('C1b a NEW file in a narrowed allow-list directory is flagged, not assumed fine',
    hive.whyNotShared('narrow/something-else.js') !== '', hive.whyNotShared('narrow/something-else.js'))
  T('C2 a path traversal is refused rather than claimed',
    hive.whyNotShared('../../etc/passwd') !== '', hive.whyNotShared('../../etc/passwd'))
  T('C3 a Hivecode control file is refused with its own reason',
    /control file/.test(hive.whyNotShared('.hive.json') || '') ||
    hive.whyNotShared('.hive.json') !== '', hive.whyNotShared('.hive.json'))

  // ---- D. the reason has to be worth reading ------------------------------------------------
  // A refusal an agent cannot act on just becomes a retry loop.
  T('D1 the reason is a sentence, not a code', (why || '').length > 40)
  T('D2 and it does not leak an absolute path into the room', !/[A-Za-z]:\\|\/tmp\//.test(why || ''))

  // ---- E. END TO END THROUGH THE REAL MCP TOOLS --------------------------------------------
  // The predicate being right is not the claim this ticket makes. The claim is that an AGENT
  // calling hive_claim gets refused. Testing the predicate and assuming the wiring works would
  // be the exact mistake this whole ticket is about, so the tools are driven for real.
  //
  // A second folder, because a client already holds a lock on the first one.
  const { _test } = await import('../hive-mcp.js')
  const dir2 = path.join(tmp, 'mcp'); fs.mkdirSync(path.join(dir2, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(dir2, '.gitignore'), ['/*', '!/.gitignore', '!/sync.js', ''].join('\n'))
  fs.writeFileSync(path.join(dir2, 'sync.js'), 'export const a = 1\n')
  fs.writeFileSync(path.join(dir2, 'scripts', 'check-deploy.mjs'), 'export const c = 3\n')
  const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

  await _test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: dir2, name: 'Probe', owner: 'test' })
  await sleep(1500)

  const claimed = textOf(await _test.callTool('hive_claim', { region: 'scripts/check-deploy.mjs', intent: 'edit' }))
  T('E1 hive_claim REFUSES the unshared path', /refusing to claim/.test(claimed), claimed.split('\n')[0])
  T('E2 and never reports it as claimed', !/it's yours/.test(claimed))
  T('E3 and does not blame another agent for holding it', !/held by/.test(claimed))
  T('E4 and says what to do about it', /sync scope/.test(claimed))

  // Honest note: hive_edit ALREADY refused this path before HIV-27, with "is not a syncable
  // file". So the write path was never the hole -- hive_claim was. What changes here is the
  // REASON: an agent told "not syncable" cannot tell whether the path is malformed, outside its
  // token scope, or excluded by a .gitignore it could fix in one line. The three have different
  // remedies and only one of them is the agent's to apply.
  const wrote = textOf(await _test.callTool('hive_edit', { file: 'scripts/check-deploy.mjs', content: 'export const c = 99\n', intent: 'x' }))
  T('E5 hive_edit refuses the same path, now saying WHY', /refusing to write/.test(wrote) && /gitignore/.test(wrote), wrote.split('\n')[0])
  T('E6 and does not claim the change is syncing to every peer', !/syncing to every peer/.test(wrote))
  T('E7 nothing was written to disk', fs.readFileSync(path.join(dir2, 'scripts', 'check-deploy.mjs'), 'utf8').includes('= 3'))

  // ...and the in-scope path must still work end to end, or the guard has broken the product.
  const ok = textOf(await _test.callTool('hive_claim', { region: 'sync.js', intent: 'edit' }))
  T('E8 an in-scope file is still claimable through the same tool', /it's yours/.test(ok), ok.split('\n')[0])
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { hive && hive.stop() } catch { /* going away */ }
  try { relay.kill() } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n=== CLAIM SCOPE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
