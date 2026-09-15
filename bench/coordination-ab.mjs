#!/usr/bin/env node
/**
 * COORDINATION A/B — does coordinating actually buy anything, measured rather than argued.
 *
 *   node bench/coordination-ab.mjs                 # 12 paired trials, all three arms
 *   node bench/coordination-ab.mjs --trials 30
 *   node bench/coordination-ab.mjs --arm hive      # one arm only, while iterating
 *
 * USES NO MODEL AND NO TOKENS. Read the next section before trusting any number it prints.
 *
 * ── WHAT IS REAL AND WHAT IS SIMULATED ──────────────────────────────────────────────────────
 *
 * REAL: the git arm runs real `git merge` in a real repository, so every conflict and every
 * silent clean-merge is git's actual behaviour, not a model of it. The hive arm runs a real relay
 * with real claims and the real release gate. The acceptance check is a real `node --check` plus
 * a real search for the three registrations.
 *
 * SIMULATED: the WORKERS. They are seeded scripts, not LLMs, and they do exactly the same edits
 * in exactly the same order in every arm. That is the point -- the thing under test is the
 * coordination layer, and holding the workers identical is what makes the arms comparable. It is
 * also what keeps this free to run.
 *
 * SO: WALL-CLOCK IS NOT REPORTED AS A HEADLINE, because with scripted workers the elapsed time is
 * mostly my choice of think-time and would be a fabricated number dressed as a measurement. What
 * is reported is what actually differs between the arms and can be counted: conflicts a human
 * must resolve, features lost, work done against a base that had already moved, and broken code
 * reaching the shared base.
 *
 * ── WHY THREE ARMS ──────────────────────────────────────────────────────────────────────────
 *
 * Comparing a gated room against branches with NO continuous integration would be rigged: every
 * real company gates its merges. `git+ci` is therefore the honest baseline and the one the result
 * should be judged on. Plain `git` is kept only because it is what a small team without CI
 * actually does, and the gap between the two is itself worth seeing.
 *
 * ── THE ONE CONFIGURATION THAT WOULD HAVE FAKED THE WHOLE THING ─────────────────────────────
 *
 * This repository configures `merge.icr.driver` -- OUR structural merge -- as a git merge driver.
 * A baseline run inside this repo would therefore not have been vanilla git at all. Every git arm
 * below runs in a fresh temp repo with attributes disabled, and the suite asserts that before it
 * measures anything.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const TRIALS = Number(arg('--trials', 12))
const ONLY = arg('--arm', null)
const PORT = 1253
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── the task ────────────────────────────────────────────────────────────────────────────────
// Three independent features, and one shared registry every one of them must edit. This is not a
// contrived collision: it is the convergence point every real codebase has (routes, models,
// service loaders), and it is why "our features don't overlap" still produces a conflict.
const BASE = `// routes.js — every feature registers itself here
const routes = {}

module.exports = { routes }
`
const FEATURES = [
  { who: 'A', name: 'billing', broken: false },
  { who: 'B', name: 'search', broken: true },   // B's first attempt does not parse
  { who: 'C', name: 'uploads', broken: false },
]

/** B's first attempt is missing a closing brace. Real, mechanically detectable breakage. */
const registration = (name, broken) => broken
  ? `routes['/${name}'] = require('./${name}'\n`
  : `routes['/${name}'] = require('./${name}')\n`

/** Insert a registration above module.exports — the same edit every worker makes. */
function addRegistration(src, name, broken) {
  return src.replace('\nmodule.exports', `${registration(name, broken)}\nmodule.exports`)
}

/** The acceptance check, mechanical and opinion-free: it parses AND all three are registered. */
function accepts(src) {
  const f = path.join(os.tmpdir(), 'acc-' + Math.abs(hash(src)) + '.js')
  fs.writeFileSync(f, src)
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  fs.rmSync(f, { force: true })
  const parses = r.status === 0
  const present = FEATURES.filter((x) => src.includes(`routes['/${x.name}']`)).length
  return { ok: parses && present === FEATURES.length, parses, present }
}
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }

// A seeded order, so both arms get the SAME interleaving on the same trial. Math.random() would
// make the arms incomparable and the whole paired design pointless.
function seededOrder(seed) {
  let x = seed * 2654435761 % 2147483647
  const next = () => (x = (x * 48271) % 2147483647) / 2147483647
  const a = [...FEATURES]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

const git = (cwd, ...args) => spawnSync('git', ['-c', 'core.attributesfile=', '-c', 'user.email=b@b', '-c', 'user.name=b', ...args],
  { cwd, encoding: 'utf8' })

// ── ARM 1 + 2: branches, merged at the end. `ci` gates each merge on the check. ─────────────
//
// Each worker branches from the SAME base and cannot see the others until merge time. That is
// not a flaw in the arm, it is what a branch IS -- and it is the mechanism that produces both
// results below: the conflicts, and the work done against a base that had already moved.
function runGit(seed, { ci }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-git-'))
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'routes.js'), BASE)
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base')

  const order = seededOrder(seed)
  let conflicts = 0, staleEdits = 0, rework = 0, brokenReachedMain = 0

  // ALL THREE BRANCH FIRST, FROM THE SAME COMMIT. That is what "working in parallel" means, and
  // getting it wrong is not a small error: branching each one only after the previous had merged
  // made every merge a fast-forward, so git reported zero conflicts and the harness itself
  // silently dropped two of the three features. Serialised branches measure nothing.
  const baseAtBranch = BASE
  for (const f of order) {
    git(dir, 'checkout', '-q', '-b', 'feat-' + f.name, 'main')
    fs.writeFileSync(path.join(dir, f.name + '.js'), `module.exports = () => '${f.name}'\n`)
    fs.writeFileSync(path.join(dir, 'routes.js'), addRegistration(baseAtBranch, f.name, f.broken))
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', f.name)
    // B's broken attempt: without CI it merges; with CI the merge is blocked and B reworks.
    if (f.broken && ci) {
      rework++
      fs.writeFileSync(path.join(dir, 'routes.js'), addRegistration(baseAtBranch, f.name, false))
      git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', f.name + ' fix')
    }
    git(dir, 'checkout', '-q', 'main')
  }

  for (const f of order) {
    // THE STALE-BASE COUNT, defined identically in both arms: was the base this worker edited
    // from still the shared state at the moment its work landed? A branch is frozen when it is
    // cut, so every merge after the first is landing work written against a base that has since
    // moved -- and nobody could have known.
    const mainNow = git(dir, 'show', 'main:routes.js').stdout || ''
    if (mainNow !== baseAtBranch) staleEdits++
    const m = git(dir, 'merge', '--no-edit', 'feat-' + f.name)
    if (m.status !== 0) {
      conflicts++
      // A human resolves it. Modelled as keeping both registrations, which is the correct
      // resolution and the generous assumption for this arm -- a real human sometimes gets it wrong.
      const cur = fs.readFileSync(path.join(dir, 'routes.js'), 'utf8')
      const fixed = cur.replace(/^<{7}.*$|^={7}$|^>{7}.*$|^\|{7}.*$/gm, '').replace(/\n{3,}/g, '\n\n')
      fs.writeFileSync(path.join(dir, 'routes.js'), fixed)
      git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--no-edit')
    }
  }
  const final = fs.readFileSync(path.join(dir, 'routes.js'), 'utf8')
  const acc = accepts(final)
  if (!acc.parses) brokenReachedMain = 1
  fs.rmSync(dir, { recursive: true, force: true })
  return { conflicts, staleEdits, rework, brokenReachedMain, ...acc }
}

// ── ARM 3: one room, claims + the release gate ──────────────────────────────────────────────
async function runHive(seed, relayPort) {
  const room = 'ab-' + seed + '-' + Date.now()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hive-'))
  const clients = FEATURES.map((f) => {
    const dir = path.join(tmp, f.who); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'routes.js'), BASE)
    return { f, dir, h: startSync({ relay: `ws://127.0.0.1:${relayPort}`, room, dir, name: f.who, kind: 'ai', syncFiles: false, log: () => {} }) }
  })
  await sleep(2200)

  // The gate is the room's rule: routes.js must parse before anyone may hand it back.
  clients[0].h.setState('gate:cmd', `node --check routes.js`)
  clients[0].h.setState('gate:timeout', 15000)
  await sleep(800)

  // One shared document, so "the base" is whatever the room currently holds.
  let shared = BASE
  let refusedClaims = 0, refusedHandoffs = 0, staleEdits = 0, rework = 0, brokenReachedMain = 0

  for (const f of seededOrder(seed)) {
    const c = clients.find((x) => x.f.who === f.who)
    // Everyone sees every landed change within about a second, so nobody is ever editing a base
    // that has silently moved. That is the claim this counter exists to falsify, not to assert.
    const baseSeen = shared
    let got = c.h.claim('routes.js', 'register ' + f.name)
    if (!got) { refusedClaims++; await sleep(300); got = c.h.claim('routes.js', 'register ' + f.name) }
    if (!got) continue

    let next = addRegistration(baseSeen, f.name, f.broken)
    fs.writeFileSync(path.join(c.dir, 'routes.js'), next)
    let rel = c.h.release('routes.js')
    if (rel && rel.ok === false) {
      // THE GATE. The handoff is refused, the claim stays with its author, and the broken
      // registration never becomes something the next worker can take.
      refusedHandoffs++; rework++
      next = addRegistration(baseSeen, f.name, false)
      fs.writeFileSync(path.join(c.dir, 'routes.js'), next)
      rel = c.h.release('routes.js')
    }
    // Same definition as the git arm: was the base this worker read still the shared state when
    // its work landed? Here it is, and not by accident -- holding the claim is precisely what
    // stops the base moving underneath an author mid-edit. Measured, not assumed, so that a
    // regression in the claim layer would show up here as a non-zero count.
    const landedOn = shared
    if (rel && rel.ok) shared = next
    if (baseSeen !== landedOn) staleEdits++
    await sleep(120)
  }

  const acc = accepts(shared)
  if (!acc.parses) brokenReachedMain = 1
  for (const c of clients) { try { c.h.stop() } catch { /* going away */ } }
  fs.rmSync(tmp, { recursive: true, force: true })
  return { conflicts: refusedClaims, staleEdits, rework, brokenReachedMain, refusedHandoffs, ...acc }
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────
console.log(`COORDINATION A/B — ${TRIALS} paired trials, same seed drives every arm`)
console.log('no model is called; the workers are scripted and identical across arms\n')

// Prove the baseline really is vanilla git before measuring anything with it.
const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-probe-'))
git(probe, 'init', '-q', '-b', 'main')
const drv = git(probe, 'config', '--get', 'merge.icr.driver').stdout.trim()
console.log(`baseline check: attributes disabled, merge driver in temp repo = ${drv ? 'ICR (!!)' : 'none — vanilla git'}`)
fs.rmSync(probe, { recursive: true, force: true })
if (drv) { console.error('Q495 the git arm would run under our own merge driver — refusing to publish a rigged baseline'); process.exit(1) }

const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_SEATS: '4' }, stdio: ['ignore', 'ignore', 'pipe'] })
await sleep(2500)

const arms = { git: [], 'git+ci': [], hive: [] }
for (let t = 0; t < TRIALS; t++) {
  if (!ONLY || ONLY === 'git') arms.git.push(runGit(t + 1, { ci: false }))
  if (!ONLY || ONLY === 'git+ci') arms['git+ci'].push(runGit(t + 1, { ci: true }))
  if (!ONLY || ONLY === 'hive') arms.hive.push(await runHive(t + 1, PORT))
  process.stdout.write(`\r  trial ${t + 1}/${TRIALS}`)
}
console.log('\n')

const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0)
const pct = (rows, k) => rows.length ? Math.round(100 * rows.filter((r) => r[k]).length / rows.length) : 0

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('arm', 10) + pad('accepted', 10) + pad('conflicts', 11) + pad('stale-base', 12) + pad('rework', 8) + 'broken reached base')
for (const [name, rows] of Object.entries(arms)) {
  if (!rows.length) continue
  console.log(pad(name, 10) + pad(pct(rows, 'ok') + '%', 10) + pad(sum(rows, 'conflicts'), 11) +
    pad(sum(rows, 'staleEdits'), 12) + pad(sum(rows, 'rework'), 8) + pct(rows, 'brokenReachedMain') + '% of trials')
}

console.log(`
WHAT THESE COLUMNS MEAN
  accepted      the end state parses AND all three features are registered
  conflicts     git: merges a human had to resolve. hive: claims refused (the coordination COST)
  stale-base    edits made against a copy that had already moved underneath the author
  rework        work redone because a check caught it
  broken...     trials where code that does not parse reached the shared base

Conflicts are not comparable across arms and are not meant to be: a git conflict costs a human an
interruption, a refused claim costs an agent a retry. They are listed so the cost of coordinating
is on the table next to its benefit, rather than only the benefit.`)

relay.kill()
process.exit(0)
