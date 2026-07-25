// DEMO — intent-aware autonomous conflict resolution.
// The thing no other merge tool can do: two agents change the same value incompatibly;
// instead of dumping conflict markers on a human, ICR reconciles them BY THEIR INTENT — and
// re-validates the result so a bad reconciliation can never ship.
import { merge, resolveMerge } from './packages/icr-merge/index.js'

const line = (s = '') => console.log(s)
const rule = () => line('─'.repeat(72))

// Two agents edit the SAME value in throttle(), for different reasons → a real conflict.
const base = `function throttle(user) {\n  const limit = 100\n  return { limit, window: 60 }\n}\n`
const ours = `function throttle(user) {\n  const limit = 200\n  return { limit, window: 60 }\n}\n`   // agent A
const theirs = `function throttle(user) {\n  const limit = 500\n  return { limit, window: 60 }\n}\n` // agent B
const intents = {
  ours: 'raise the limit to 200 — production capacity headroom',
  theirs: 'raise the limit to 500 — the new enterprise tier load test needs it',
}

rule(); line('SCENARIO: two agents edit the SAME line of throttle() concurrently')
rule()
line('  Agent A intent: ' + intents.ours)
line('  Agent B intent: ' + intents.theirs)
line()
line('  A wrote:   const limit = 200')
line('  B wrote:   const limit = 500')
line('  (same value, two different numbers — a genuine conflict)')
line()

// 1) What every other tool does: detect a conflict and stop.
const conflict = merge(base, ours, theirs, { filename: 'auth.js', intents })
rule(); line('STEP 1 — merge(): the conflict git / mergiraf / a CRDT hand to a human')
rule()
line('  clean:      ' + conflict.clean)
line('  warning:    ' + conflict.warning)
line('  resolvable: ' + JSON.stringify((conflict.resolvable || []).map((u) => u.key)))
line('  (mergiraf & git STOP HERE — a wall of markers, a human resolves it)')
line()

// 2) What ICR does: a judge (here a stub; in Hivecode a Claude call / the authoring agents)
//    reconciles by INTENT.
const intentJudge = async (u) => {
  line('  judge sees the conflicting declaration + both intents:')
  line('    ours:   const limit = 200   // ' + u.oursIntent)
  line('    theirs: const limit = 500   // ' + u.theirsIntent)
  // A real LLM reads the two intents and reconciles: prod default 200, load-test env → 500.
  return `function throttle(user) {\n  const limit = process.env.LOAD_TEST ? 500 : 200\n  return { limit, window: 60 }\n}`
}
rule(); line('STEP 2 — resolveMerge(): reconcile BY INTENT, then re-validate')
rule()
const resolved = await resolveMerge(base, ours, theirs, { filename: 'auth.js', intents, judge: intentJudge })
line()
line('  resolved:   ' + resolved.resolved)
line('  clean:      ' + resolved.clean + '   (re-validated: parses + no dangling refs)')
line('  method:     ' + resolved.method)
line('  result:')
line(resolved.text.split('\n').map((l) => '      ' + l).join('\n'))
line('  → both intents honored: prod stays 200, load-test gets 500 — in code that PARSES.')
line()

// 3) The guarantee: a judge that hallucinates broken code cannot ship it.
const brokenJudge = async () => 'function throttle(user) { const limit = }}}}'
const rejected = await resolveMerge(base, ours, theirs, { filename: 'auth.js', intents, judge: brokenJudge })
rule(); line('STEP 3 — the guarantee: a BROKEN reconciliation is auto-rejected')
rule()
line('  judge returned:  function throttle(user) { const limit = }}}}   // does not parse')
line('  resolved:        ' + rejected.resolved + '   (rejected)')
line('  clean:           ' + rejected.clean + '   (falls back to a safe conflict — broken code never ships)')
line('  broken text in result? ' + rejected.text.includes('limit = }}}}'))
line()
rule(); line("No other merge tool does this: they merge dead text. ICR reconciles LIVE intent,")
line("and guarantees the judge's answer is still valid code before it lands.")
rule()
