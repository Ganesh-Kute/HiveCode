// Regression test for the HFT-demo rename case that led a demo agent to disable the
// scope-aware rename (renameFreeRefs). Shape: an `export async function` is renamed on
// one side while the other side ADDS new call sites to the OLD name inside another
// exported function. The rename must be detected AND the new call sites rewritten —
// scope-awareness must not skip top-level exported bindings.
import { structuralMerge } from '../icr.js'
import { merge } from '../index.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

const base = `export async function processTradeSocketStream(url) {
  const socket = await connect(url)
  return socket
}

export function LiveMarketDashboard() {
  const stream = processTradeSocketStream('wss://feed')
  return render(stream)
}
`
// side A: rename + update existing call sites (the architect)
const a = base
  .replaceAll('processTradeSocketStream', 'initializeSecureWebSocket')
// side B: add NEW call sites to the OLD name (the feature dev, unaware of the rename)
const b = base.replace(
  'return render(stream)',
  `const retry = processTradeSocketStream('wss://backup')
  return render(stream, retry)`,
)

{
  const r = structuralMerge(base, a, b, { filename: 'frontend.js' })
  T('status auto (rename understood, not a conflict)', r.status === 'auto')
  T('rename recorded', (r.renames || []).includes('processTradeSocketStream->initializeSecureWebSocket'))
  T('B\'s NEW call site rewritten to the new name', r.status === 'auto' && r.text.includes("initializeSecureWebSocket('wss://backup')"))
  T('no reference to the old name survives', r.status === 'auto' && !r.text.includes('processTradeSocketStream'))
  if (r.status !== 'auto' || !r.text.includes("initializeSecureWebSocket('wss://backup')")) {
    console.log('--- got status', r.status, 'conflicts', JSON.stringify(r.conflicts || []), '---')
    if (r.text) console.log(r.text)
  }
}

// same flow through the public merge() door
{
  const r = merge(base, a, b, { filename: 'frontend.js' })
  T('merge(): clean + rename method', r.clean && r.method === 'rename')
}

// scope-safety guard must STILL hold: an unrelated local sharing the old name is untouched
{
  const base2 = `export function helper() { return 1 }

export function main() { return helper() }
`
  const a2 = base2.replaceAll('helper', 'fetchData')
  const b2 = base2.replace(
    'return helper()',
    `const helper = 5
  return helper() + helper`,
  )
  const r = structuralMerge(base2, a2, b2, { filename: 'x.js' })
  // whatever the status, a LOCAL `helper` binding must never be renamed to fetchData
  const localRenamed = r.text && r.text.includes('const fetchData = 5')
  T('unrelated local of the same name is never rewritten', !localRenamed)
}

console.log(`\n=== RENAME-EXPORT: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
