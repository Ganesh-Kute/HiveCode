// tests/icr-await-upgrade-test.mjs -- P0-5 of 0.14.3: a merge never rewrites an author's correct code.
//
// 9 Nov, room 0.14.3 FIX (Claude-cloud): hive-room-mode.js gained a NEW `async function landIssueOn`
// and a caller `return landIssueOn(opts)`. The room's copy came back as `return await await
// landIssueOn(opts)`, credited to the author; the room's server.js already read `return await await
// await admitMux(req, q)`. ICR's async/await synchronization treats a function that is not in the
// base as "became async" and inserts `await` before its calls -- inside the author's own write, with
// nobody told. Two peers making that same insert at the same moment leave both in the shared text,
// hence the stacking. `await await x` runs the same as `await x`, so no test noticed.
//
// The upgrade exists for one real case: a function that was SYNC in the base became async, and a
// caller (often added by the other side) still uses it as sync. That case must keep working.
//
//   U1  a new async function and its author's `return f()` caller: left exactly as written
//   U2  a new async function whose promise the author keeps (`const p = f()`): left as written
//   U3  sync -> async on one side, an existing sync-style caller: upgraded to `await f()` (kept)
//   U4  sync -> async on one side, a caller the OTHER side added concurrently: upgraded (kept)
//   U5  `return f()` after sync -> async: left alone (an async function returning a promise is the same)
//   U6  never two awaits on one call, whatever is merged with what
// Run against both copies of the engine (root and packages/icr-merge), which must agree.

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const line = (t, needle) => (t || '').split('\n').find((l) => l.includes(needle)) || ''

for (const where of ['', 'packages/icr-merge/']) {
  const { structuralMerge } = await import(pathToFileURL(path.join(ROOT, where, 'icr.js')).href)
  const M = (b, o, t) => structuralMerge(b, o, t, { filename: 'a.js' })
  console.log(`\n# ${where || 'root '}icr.js`)

  const base = 'export async function g(opts) {\n  const x = 1\n  return x\n}\n'
  const u1 = 'async function f(opts) { return 1 }\nexport async function g(opts) {\n  if (opts) return f(opts)\n  const x = 1\n  return x\n}\n'
  const r1 = M(base, u1, base)
  T(`U1 ${where}a new async function's \`return f()\` caller is left as written`, r1.status === 'auto' && line(r1.text, 'if (opts)') === '  if (opts) return f(opts)', JSON.stringify(line(r1.text, 'if (opts)')))

  const u2 = 'async function f() { return 1 }\nexport async function g(opts) {\n  const p = f()\n  const x = 1\n  return [x, await p]\n}\n'
  const r2 = M(base, u2, base)
  T(`U2 ${where}a kept promise (\`const p = f()\`) of a new async function is left as written`, r2.status === 'auto' && line(r2.text, 'const p') === '  const p = f()', JSON.stringify(line(r2.text, 'const p')))

  const b3 = 'function f() { return 1 }\nexport async function g() {\n  const r = f()\n  return r\n}\n'
  const o3 = 'async function f() { return 1 }\nexport async function g() {\n  const r = f()\n  return r\n}\n'
  const r3 = M(b3, o3, b3)
  T(`U3 ${where}sync -> async: an existing sync-style caller is upgraded to await (the feature)`, r3.status === 'auto' && line(r3.text, 'const r') === '  const r = await f()', JSON.stringify(line(r3.text, 'const r')))

  const t4 = b3 + 'export async function h() {\n  const y = f()\n  return y + 1\n}\n'
  const o4 = o3.replace('  const r = f()', '  const r = await f()')
  const r4 = M(b3, o4, t4)
  T(`U4 ${where}sync -> async: a caller the other side added at the same time is upgraded`, r4.status === 'auto' && line(r4.text, 'const y') === '  const y = await f()', JSON.stringify({ status: r4.status, y: line(r4.text, 'const y') }))

  const b5 = 'function f() { return 1 }\nexport async function g() {\n  return f()\n}\n'
  const o5 = b5.replace('function f()', 'async function f()')
  const r5 = M(b5, o5, b5)
  T(`U5 ${where}\`return f()\` after sync -> async is left alone`, r5.status === 'auto' && line(r5.text, 'return f') === '  return f()', JSON.stringify(line(r5.text, 'return f')))

  let stacked = 0
  const up = u1.replace('return f(opts)', 'return await f(opts)')
  for (const [b, o, t] of [[base, u1, base], [base, u1, up], [u1, u1, up], [u1, up, u1], [up, u1, up], [base, up, base], [base, up, up], [b3, o3, o3], [b3, o4, t4]]) {
    const r = M(b, o, t)
    if (/await\s+await/.test(r.text || '')) stacked++
  }
  T(`U6 ${where}no merge ever produces \`await await\``, stacked === 0, `stacked in ${stacked} case(s)`)
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
