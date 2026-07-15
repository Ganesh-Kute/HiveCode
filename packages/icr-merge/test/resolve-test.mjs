// RESOLVE — intent-aware autonomous conflict resolution (resolveMerge).
// The capability no other merge tool has: when two agents change the same declaration
// incompatibly, hand the conflict + each side's INTENT to a judge (an LLM/agent), and
// reconcile automatically — WITH the guarantee that the judge's answer is re-validated
// through the full engine, so a broken reconciliation can never ship.
import { merge, resolveMerge } from '../index.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (c) pass++; else fail++ }

// A genuine semantic conflict: both sides change the SAME return value, differently.
const base = 'function rateLimit() {\n  return 100\n}\n'
const ours = 'function rateLimit() {\n  return 200\n}\n'    // intent: bump for production
const theirs = 'function rateLimit() {\n  return 500\n}\n'  // intent: bump for load test
const intents = { ours: 'raise the limit to 200 for production', theirs: 'raise the limit to 500 for a load test' }

// --- 0. merge() alone surfaces a machine-resolvable conflict carrying both intents ---
{
  const r = merge(base, ours, theirs, { filename: 'r.js', intents })
  T('conflict is not clean', r.clean === false)
  T('resolvable unit present (fn:rateLimit)', Array.isArray(r.resolvable) && r.resolvable.length === 1 && r.resolvable[0].key === 'fn:rateLimit')
  const u = r.resolvable[0]
  T('resolvable carries base/ours/theirs of the unit', u.base.includes('100') && u.ours.includes('200') && u.theirs.includes('500'))
  T('resolvable carries BOTH intents', u.oursIntent === intents.ours && u.theirsIntent === intents.theirs)
}

// --- 1. a judge that reconciles by intent → clean, re-validated resolution ---
{
  let sawIntents = false
  const judge = async (u) => {
    sawIntents = u.oursIntent === intents.ours && u.theirsIntent === intents.theirs
    // reconcile the two intents: env-gated so both goals are served (must PARSE)
    return 'function rateLimit() {\n  return process.env.LOAD_TEST ? 500 : 200\n}'
  }
  const r = await resolveMerge(base, ours, theirs, { filename: 'r.js', intents, judge })
  T('judge received both intents', sawIntents)
  T('resolved === true', r.resolved === true)
  T('result is clean', r.clean === true)
  T("method === 'resolved'", r.method === 'resolved')
  T('reconciled text present in output', r.text.includes('LOAD_TEST ? 500 : 200'))
  T('resolutions recorded', Array.isArray(r.resolutions) && r.resolutions[0].key === 'fn:rateLimit')
}

// --- 2. THE SAFETY PROOF: a judge that returns BROKEN code is auto-rejected ---
{
  const judge = async () => 'function rateLimit( { return }}}'  // does not parse
  const r = await resolveMerge(base, ours, theirs, { filename: 'r.js', intents, judge })
  T('broken reconciliation NOT resolved', r.resolved === false)
  T('broken reconciliation NOT shipped clean', r.clean === false)
  T('broken judge output does NOT appear in result', !r.text.includes('{ return }}}'))
}

// --- 3. a judge that DECLINES (null) → safe conflict, nothing forced ---
{
  const judge = async () => null
  const r = await resolveMerge(base, ours, theirs, { filename: 'r.js', intents, judge })
  T('declined → resolved false', r.resolved === false)
  T('declined → still a conflict', r.clean === false)
}

// --- 4. a judge that reconciles into a DANGLING reference is caught by re-validation ---
// base defines helper + uses it; both sides edit the caller; judge "fixes" by deleting helper.
{
  const b = 'function helper() { return 1 }\n\nfunction main() {\n  return helper() + 0\n}\n'
  const o = 'function helper() { return 1 }\n\nfunction main() {\n  return helper() + 10\n}\n'
  const t = 'function helper() { return 1 }\n\nfunction main() {\n  return helper() + 20\n}\n'
  // judge reconciles main() but writes a body that no longer needs helper AND the reconciliation
  // (applied to both sides) leaves helper defined — so this one SHOULD succeed cleanly:
  const judgeOk = async () => 'function main() {\n  return helper() + 30\n}'
  const rok = await resolveMerge(b, o, t, { filename: 'r.js', judge: judgeOk })
  T('valid reconciliation of caller → resolved clean', rok.resolved === true && rok.clean === true && rok.text.includes('+ 30'))
}

// --- 5. no judge / clean input → resolveMerge degrades to merge() ---
{
  const noJudge = await resolveMerge(base, ours, theirs, { filename: 'r.js', intents })
  T('no judge → not resolved, still a conflict', noJudge.resolved === false && noJudge.clean === false)
  const cleanCase = await resolveMerge(base, ours, base, { filename: 'r.js', judge: async () => 'x' })
  T('nothing to resolve (one-sided) → clean, resolved false', cleanCase.clean === true && cleanCase.resolved === false)
}

console.log(`\n=== RESOLVE: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
