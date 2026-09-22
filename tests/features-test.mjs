// features: every promise in features.js is proved by an assertion that ACTUALLY RAN AND PASSED.
//
//   node tests/features-test.mjs            check everything (runs the suites; ~3 min)
//   node tests/features-test.mjs --shape    validate the manifest only, no suites (instant)
//
// WHY THIS IS NOT JUST A LINT ON A YAML FILE. On 18 Sep 2026 six tickets shipped green and two
// were wrong. HIV-13 changed a divisor and made the operator's dashboard under-report runtime by
// 10x; its own test PRINTED `{"minutes":0,...}` while passing, because the assertion was
// `used?.writes > 0`. The suite ran. The suite was green. The suite asserted something other than
// the behaviour that mattered.
//
// A list of features cannot catch that. What catches it is naming, per promise, the assertion that
// proves it -- and then checking THAT THE NAMED ASSERTION IS STILL THERE AND STILL PASSING. So
// this file runs the real suites and reads their real output. Three distinct failures are caught,
// and they are different from each other:
//
//   1. the assertion FAILED           -> the behaviour regressed
//   2. the assertion IS NOT THERE     -> somebody renamed or deleted the thing that proved it,
//                                        which is how a promise silently stops being checked
//   3. the feature names no assertion -> the promise is unproven, and it is reported as such
//                                        rather than quietly counted as fine
//
// (2) is the one that only exists because the manifest exists. A suite can go green after a
// rename, forever, and nothing else in this repo would notice.
//
// THE GAP LIST IS THE DELIVERABLE. `proves: []` is not a TODO. It is a declaration that a promise
// is currently unproven, printed every run, in the same breath as what it costs. A manifest that
// only listed the passing half would be the false-success shape one level up.

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { FEATURES, TIERS, CRITICALITY, suites, unproven, byCriticality } from '../features.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SHAPE_ONLY = process.argv.includes('--shape')

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ── A. the manifest itself has to be worth trusting ───────────────────────────
console.log('\n# A. the manifest')
{
  const ids = FEATURES.map((f) => f.id)
  T('A1 every feature has a unique id', new Set(ids).size === ids.length,
    ids.filter((x, i) => ids.indexOf(x) !== i).join(', ') || '')
  T('A2 every criticality is one of the declared three',
    FEATURES.every((f) => CRITICALITY.includes(f.criticality)),
    FEATURES.filter((f) => !CRITICALITY.includes(f.criticality)).map((f) => f.id).join(', '))
  T('A3 every tier is a declared tier',
    FEATURES.every((f) => TIERS[f.tier]),
    FEATURES.filter((f) => !TIERS[f.tier]).map((f) => f.id).join(', '))

  // `breaks` is the whole reason a non-author can triage a red line at 3am. A one-word entry
  // would pass a "field exists" check and be useless, so the bar is a sentence.
  const thin = FEATURES.filter((f) => !f.breaks || f.breaks.length < 40)
  T('A4 every feature says what BREAKS without it, in a sentence rather than a label',
    thin.length === 0, thin.map((f) => f.id).join(', '))
  T('A5 and it is written for a reader, not as a restatement of the name',
    FEATURES.every((f) => f.breaks.toLowerCase() !== f.name.toLowerCase()))
}

// ── B. every named suite exists ───────────────────────────────────────────────
console.log('\n# B. the suites it points at')
{
  const missing = suites().filter((s) => !fs.existsSync(path.join(ROOT, s)))
  T('B1 every suite named in the manifest exists on disk', missing.length === 0, missing.join(', '))
  console.log(`       (${suites().length} suites referenced by ${FEATURES.filter((f) => f.proves.length).length} proved features)`)
}

// ── C. THE GAP LIST ───────────────────────────────────────────────────────────
console.log('\n# C. promises with no proof — reported, never hidden')
{
  const { automatable, manualOnly } = unproven()
  for (const f of automatable) console.log(`  GAP  [${f.criticality}/tier ${f.tier}] ${f.id} — ${f.breaks}`)
  for (const f of manualOnly) console.log(`  MANUAL  [tier 6] ${f.id} — ${f.breaks}`)

  // This deliberately does NOT fail the run. A gap that fails the build gets closed by writing a
  // fake test, which is worse than the gap. It fails only if the list grows silently -- the count
  // is pinned, so adding an unproven feature without deciding to is a red line.
  T(`C1 the unproven-but-automatable count is still ${automatable.length} — raise this deliberately, never by accident`,
    automatable.length === 1, `${automatable.length}: ${automatable.map((f) => f.id).join(', ')}`)
  T('C2 tier-6 promises are counted separately, because they are unprovable here and not neglected',
    manualOnly.length === 2 && manualOnly.every((f) => f.tier === 6))
}

if (SHAPE_ONLY) {
  console.log(`\n(--shape: suites not run)\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
}

// ── D. every named assertion ran, and passed ──────────────────────────────────
console.log('\n# D. running the suites and reading what they actually asserted')
const output = new Map()
for (const s of suites()) {
  process.stdout.write(`       ${s} ... `)
  const r = spawnSync(process.execPath, [path.join(ROOT, s)], { cwd: ROOT, encoding: 'utf8', timeout: 240000 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  output.set(s, out)
  console.log(r.status === 0 ? 'green' : `EXIT ${r.status}`)
}
console.log('')

for (const f of FEATURES) {
  for (const p of f.proves) {
    const out = output.get(p.suite) || ''
    const lines = out.split('\n')
    // Matched on the LINE, not on the whole output, so a string that appears in a header comment
    // or in a failure's detail column cannot stand in for a passing assertion.
    const ok = lines.some((l) => /^\s*ok\b/.test(l) && l.includes(p.assertion))
    const failed = lines.some((l) => /^\s*FAIL\b/.test(l) && l.includes(p.assertion))
    const present = ok || failed
    if (!present) {
      // The failure only this file can catch: the assertion that proved a promise is GONE, and
      // its suite is green, so nothing else in the repo has any way to notice.
      T(`${f.id} — "${p.assertion}"`, false,
        `NOT FOUND in ${p.suite}. The assertion that proved this promise was renamed or deleted, and its suite is still green.`)
    } else {
      T(`${f.id} — "${p.assertion}"`, ok, ok ? '' : `FAILED in ${p.suite} — the behaviour regressed`)
    }
  }
}

// ── E. the report a human reads ───────────────────────────────────────────────
console.log('\n# E. coverage')
{
  const g = byCriticality()
  for (const c of CRITICALITY) {
    const proved = g[c].filter((f) => f.proves.length).length
    console.log(`  ${c.padEnd(9)} ${proved}/${g[c].length} proved`)
  }
  const crit = g.critical.filter((f) => !f.proves.length)
  // Stated rather than asserted: three CRITICAL promises are unproven today and pretending
  // otherwise is the thing this file exists to stop. It is pinned in C1, not hidden here.
  if (crit.length) console.log(`\n  ${crit.length} CRITICAL promises are unproven: ${crit.map((f) => f.id).join(', ')}`)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
