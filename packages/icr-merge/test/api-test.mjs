// api-test — the package's PUBLIC surface: merge(), the git driver contract,
// and the fallback floor. (The engine itself is covered by the copied suites.)
import fs from 'fs'; import os from 'os'; import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { merge, merge3, structuralMerge, supports, hasConflictMarkers } from '../index.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const HERE = path.dirname(fileURLToPath(import.meta.url))

// --- merge(): structural tier ---
{
  const base = 'function a() { return 1 }\n\nfunction b() { return 2 }\n'
  const ours = 'function a() { return 10 }\n\nfunction b() { return 2 }\n'
  const theirs = 'function a() { return 1 }\n\nfunction b() { return 20 }\n'
  const r = merge(base, ours, theirs, { filename: 'x.js' })
  T('structural: both edits merged clean', r.clean && r.text.includes('return 10') && r.text.includes('return 20'))
  T('structural: method reported', r.method === 'structural')
}
// --- merge(): rename tier ---
{
  const base = 'function helper() { return 1 }\n\nfunction main() { return helper() }\n'
  const ours = 'function fetchData() { return 1 }\n\nfunction main() { return helper() }\n'
  const theirs = base
  const r = merge(base, ours, theirs, { filename: 'x.js' })
  T('rename: call sites rewritten', r.clean && r.text.includes('return fetchData()') && !r.text.includes('helper'))
  T('rename: method + renames reported', r.method === 'rename' && (r.renames || []).includes('helper->fetchData'))
}
// --- merge(): semantic conflict -> line tier + warning ---
{
  const base = 'function a() { return 1 }\n'
  const ours = 'function a() { return 2 }\n'
  const theirs = 'function a() { return 3 }\n'
  const r = merge(base, ours, theirs, { filename: 'x.js' })
  T('semantic clash: falls to lines, both kept', r.text.includes('return 2') && r.text.includes('return 3'))
  T('semantic clash: not clean + warning', !r.clean && /both sides changed function a/.test(r.warning || ''))
}
// --- merge(): unsupported extension -> lines ---
{
  const base = 'alpha\nbeta\ngamma\n'
  const r = merge(base, base.replace('alpha', 'ALPHA'), base.replace('gamma', 'GAMMA'), { filename: 'notes.txt' })
  T('unsupported ext: line tier, disjoint clean', r.method === 'lines' && r.clean && r.text.includes('ALPHA') && r.text.includes('GAMMA'))
}
// --- merge(): python via provider ---
{
  const base = 'def a():\n    return 1\n\ndef b():\n    return 2\n'
  const r = merge(base, base.replace('return 1', 'return 10'), base.replace('return 2', 'return 20'), { filename: 'x.py' })
  T('python: structural merge clean', r.clean && r.text.includes('return 10') && r.text.includes('return 20'))
}
// --- parse guarantee: broken input never breaks the caller ---
{
  const r = merge('function a() {', 'function a() { return', 'function a() { !!', { filename: 'x.js' })
  T('unparseable input: falls back, still returns text', typeof r.text === 'string' && r.method === 'lines')
}
// --- git merge driver contract ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'icrdrv-'))
  const w = (n, c) => { const p = path.join(tmp, n); fs.writeFileSync(p, c); return p }
  const driver = path.join(HERE, '..', 'bin', 'icr-merge-driver.js')
  // clean structural case -> exit 0, merged bytes in %A
  const base = 'function a() { return 1 }\n\nfunction b() { return 2 }\n'
  const O = w('O.js', base), A = w('A.js', base.replace('return 1', 'return 10')), B = w('B.js', base.replace('return 2', 'return 20'))
  let code = 0
  try { execFileSync(process.execPath, [driver, O, A, B, 'src/x.js'], { stdio: 'pipe' }) } catch (e) { code = e.status }
  const out = fs.readFileSync(A, 'utf8')
  T('driver: clean merge exits 0 and writes result', code === 0 && out.includes('return 10') && out.includes('return 20'))
  // conflict case -> exit 1, markers in %A
  const O2 = w('O2.js', 'function a() { return 1 }\n'), A2 = w('A2.js', 'function a() { return 2 }\n'), B2 = w('B2.js', 'function a() { return 3 }\n')
  code = 0
  try { execFileSync(process.execPath, [driver, O2, A2, B2, 'x.js'], { stdio: 'pipe' }) } catch (e) { code = e.status }
  T('driver: conflict exits 1 with markers', code === 1 && hasConflictMarkers(fs.readFileSync(A2, 'utf8')))
  fs.rmSync(tmp, { recursive: true, force: true })
}
// --- re-exports intact ---
T('re-exports: merge3/structuralMerge/supports', typeof merge3 === 'function' && typeof structuralMerge === 'function' && supports('a.ts') === true)

console.log(`\n=== API: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
