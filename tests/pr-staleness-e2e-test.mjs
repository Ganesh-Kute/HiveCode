// hive-pr staleness, end to end: a real relay, a real room, a real git repo.
//
//   node tests/pr-staleness-e2e-test.mjs
//
// The unit suite proves the decision. This proves the TOOL refuses -- a different claim, and
// assuming it follows from the first is the HIV-27 mistake, a guard that is correct and unwired.
//
// Section B is the incident itself, reconstructed with the real parts:
//   1. a file is written through the room, so it carries a real signed receipt chain
//   2. a commit lands on the branch by another route, exactly as HIV-14 did
//   3. hive-pr is run
//
// Before this ticket that produced a clean, signed, per-agent PR that deleted the commit. Now it
// must refuse, name the commit and the author, and leave NO branch behind -- because the next
// thing anybody does with a branch that exists is push it.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + ((process.pid + 29) % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-prs-'))
const REPO = path.join(tmp, 'repo')
const ROOMDIR = path.join(tmp, 'room')
const git = (args, cwd = REPO) => spawnSync('git', args, { cwd, encoding: 'utf8' })
// spawnSync returns .stdout, not .out -- reading .out gives undefined, and `undefined.includes`
// throws mid-suite rather than failing an assertion. Three assertions here did exactly that.
const gitOut = (args, cwd = REPO) => (git(args, cwd).stdout || '').trim()

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'prs-' + crypto.randomBytes(6).toString('hex')
let hive
try {
  // ── a real git repo ────────────────────────────────────────────────────────
  fs.mkdirSync(REPO, { recursive: true })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@test.local'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(REPO, 'app.js'), 'export const v = 1\n')
  fs.writeFileSync(path.join(REPO, 'other.js'), 'export const o = 1\n')
  git(['add', '-A']); git(['commit', '-qm', 'base'])

  // ── a real room, with the repo's files in it ───────────────────────────────
  fs.mkdirSync(ROOMDIR, { recursive: true })
  fs.writeFileSync(path.join(ROOMDIR, '.gitignore'), '/*\n!/.gitignore\n!/app.js\n!/other.js\n')
  fs.writeFileSync(path.join(ROOMDIR, 'app.js'), 'export const v = 1\n')
  fs.writeFileSync(path.join(ROOMDIR, 'other.js'), 'export const o = 1\n')
  process.env.HIVE_PROVENANCE = 'on'
  hive = startSync({ relay: `ws://localhost:${PORT}`, room, dir: ROOMDIR, name: 'Builder', kind: 'ai', log: () => { } })
  await sleep(2000)

  // The room edits app.js, producing a REAL signed receipt chain over real content.
  hive.claim('app.js', 'raise v')
  fs.writeFileSync(path.join(ROOMDIR, 'app.js'), 'export const v = 2\n')
  await sleep(3000)
  hive.release('app.js')
  await sleep(1000)

  const chain = hive.provenanceOf('app.js') || []
  T('A1 the room produced a real signed receipt chain', chain.length > 0, `${chain.length} receipt(s)`)

  const run = (extra = []) => spawnSync(process.execPath,
    [path.join(ROOT, 'hive-pr.js'), `ws://localhost:${PORT}|${room}`, 'Builder', '--repo', REPO, ...extra],
    { cwd: ROOT, encoding: 'utf8', timeout: 90000 })

  // ── A. the healthy case must still work ────────────────────────────────────
  console.log('\n# A. the branch has not moved')
  const ok = run(['--branch', 'hv/clean'])
  const okOut = `${ok.stdout || ''}${ok.stderr || ''}`
  T('A2 hive-pr succeeds when the branch is where the room left it', ok.status === 0,
    okOut.split('\n').filter(Boolean).slice(-4).join(' | '))
  T('A3 and it made the branch', git(['rev-parse', '--verify', 'hv/clean']).status === 0)
  T('A4 with the room\'s content on it', gitOut(['show', 'hv/clean:app.js']).includes('v = 2'))
  git(['checkout', '-q', 'main'])

  // ── B. THE INCIDENT ────────────────────────────────────────────────────────
  console.log('\n# B. a commit reaches the branch another way — the 19 Sep case')
  // Exactly HIV-14: work committed from the git checkout, never through the room. The room has
  // never seen these bytes, so writing its copy would delete them.
  fs.writeFileSync(path.join(REPO, 'app.js'), 'export const v = 99 // hotfix, never went through the room\n')
  git(['add', '-A']); git(['commit', '-qm', 'HIV-14 hotfix', '--author', 'Ganesh <g@test.local>'])

  const refused = run(['--branch', 'hv/stale'])
  const out = `${refused.stdout || ''}${refused.stderr || ''}`
  T('B1 HIVE-PR REFUSES — this is the run that previously produced a perfect-looking revert',
    refused.status !== 0, `exit ${refused.status}`)
  T('B2 with the Q-code', /Q506/.test(out), (out.match(/Q506[^\n]*/) || [''])[0])
  T('B3 naming the file', /app\.js/.test(out))
  T('B4 AND NAMING THE COMMIT AND THE PERSON whose work would have been deleted',
    /Ganesh/.test(out) && /HIV-14 hotfix/.test(out), (out.match(/last changed[^\n]*/) || [''])[0])
  T('B5 it says plainly that nothing was written', /Nothing was written/.test(out))

  // The part that matters most operationally: a refusal must leave nothing behind, because the
  // next thing anybody does with a branch that exists is push it.
  T('B6 NO BRANCH WAS CREATED', git(['rev-parse', '--verify', 'hv/stale']).status !== 0)
  T('B7 and the hotfix is still on main, untouched',
    fs.readFileSync(path.join(REPO, 'app.js'), 'utf8').includes('v = 99'))
  T('B8 main is where it was — no stray commit', gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) === 'main')

  // ── C. --force, with a reason, and it is written down ──────────────────────
  console.log('\n# C. forcing is possible, and visible')
  const forced = run(['--branch', 'hv/forced', '--force', 'the room copy is the correct one'])
  const fout = `${forced.stdout || ''}${forced.stderr || ''}`
  T('C1 --force with a reason proceeds', forced.status === 0, (forced.stderr || '').split('\n').slice(-2)[0])
  T('C2 the refusal is STILL printed in full — forcing silences nothing', /Q506/.test(fout))
  T('C3 and the reason is echoed back', /the room copy is the correct one/.test(fout))
  T('C4 the branch now exists', git(['rev-parse', '--verify', 'hv/forced']).status === 0)
  T('C5 carrying the room\'s copy, as asked', gitOut(['show', 'hv/forced:app.js']).includes('v = 2'))

  // A bare --force must not work: a switch gets typed once and never explained.
  git(['checkout', '-q', 'main'])
  const bare = run(['--branch', 'hv/bare', '--force'])
  T('C6 A BARE --force IS NOT ENOUGH — the reason is required, so it ends up written down',
    bare.status !== 0, `exit ${bare.status}`)
  T('C7 and no branch came from it', git(['rev-parse', '--verify', 'hv/bare']).status !== 0)
} catch (e) {
  T('the suite ran without throwing', false, String((e && e.stack) || e))
} finally {
  try { hive && hive.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== PR STALENESS E2E: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
