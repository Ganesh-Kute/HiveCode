// COOPERBENCH PHASE 1b — TEST-VALIDATE ICR's clean integrations.
// For every pair where git CONFLICTED but ICR merged cleanly, assemble the ICR-merged
// tree and run BOTH features' own unit-test suites on it (CooperBench's success
// criterion). A "clean" merge that fails either suite is a false integration; a merge
// that passes both is, by the benchmark's own definition, a successful cooperation
// outcome that the git-based pipeline lost.
//
//   node cooper-validate.mjs <lib-filter> [maxPairs]     e.g. dirty_equals | jinja
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { merge } from './packages/icr-merge/index.js'
import { initTreeSitter } from './packages/icr-merge/treesitter.js'

const SCRATCH = 'C:/Users/G1/AppData/Local/Temp/claude/c--Users-G1-Desktop-N/f6ef2bbd-7478-449b-bb39-8c8db7d3ae86/scratchpad'
const DATASET = SCRATCH + '/CooperBench/dataset'
const REPOS = SCRATCH + '/cooper-repos'
const WORK = SCRATCH + '/cooper-validate'
fs.mkdirSync(WORK, { recursive: true })
const LIB = process.argv[2]
const MAX = Number(process.argv[3] || 100)
if (!LIB) { console.error('usage: node cooper-validate.mjs <lib-filter> [maxPairs]'); process.exit(2) }

try { await initTreeSitter() } catch {}

function run(cmd, args, cwd, timeoutMs = 300000) {
  try { return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }) } }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : -1, out: ((e.stdout || '') + '\n' + (e.stderr || '')).trim() } }
}
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

const all = JSON.parse(rd('cooper-merge.json'))
const wins = all.receipts.filter((r) => !r.git && r.icr && r.lib.includes(LIB)).slice(0, MAX)
if (!wins.length) { console.error('no ICR-win pairs for', LIB); process.exit(2) }
console.log(`validating ${wins.length} ICR-clean-on-git-conflict pairs for ${wins[0].lib}`)

// task metadata
function parseSetup(sh) {
  const src = rd(sh) || ''
  const commit = (src.match(/BASE_COMMIT="([0-9a-f]{7,40})"/) || [])[1]
  let url = (src.match(/git clone (https:\/\/github\.com\/[^\s"]+)/) || [])[1]
  if (url && url.includes('${')) {
    const owner = (src.match(/REPO_OWNER="([^"]+)"/) || [])[1]
    const name = (src.match(/REPO_NAME="([^"]+)"/) || [])[1]
    if (owner && name) url = `https://github.com/${owner}/${name}`
  }
  return { url: url ? url.replace(/\.git$/, '') : null, commit }
}

const taskMeta = new Map()
for (const w of wins) {
  const key = w.lib + '/' + w.task
  if (taskMeta.has(key)) continue
  const dir = path.join(DATASET, w.lib, w.task)
  taskMeta.set(key, { dir, ...parseSetup(path.join(dir, 'setup.sh')) })
}

// one venv per repo (python -m venv; pip install -e repo at ANY task commit is fine for
// deps — we reinstall -e per worktree anyway, which is cheap for pure-python packages)
const PY = 'python'
function ensureVenv(name) {
  const venv = path.join(WORK, 'venv-' + name)
  const pyExe = path.join(venv, 'Scripts', 'python.exe')
  if (!fs.existsSync(pyExe)) {
    console.log('  creating venv', name)
    const r = run(PY, ['-m', 'venv', venv]); if (r.code !== 0) throw new Error('venv failed: ' + r.out.slice(0, 200))
    run(pyExe, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'])
    run(pyExe, ['-m', 'pip', 'install', '-q', 'pytest', 'pytest-mock'])
  }
  return pyExe
}

const applyPatchText = (wt, patchText) => {
  const p = path.join(WORK, 'v.patch')
  fs.writeFileSync(p, (patchText || '').replace(/\r\n/g, '\n'))
  return run('git', ['apply', '--whitespace=nowarn', p], wt)
}

let pass = 0, failCode = 0, failTest = 0
const rows = []
for (const w of wins) {
  const meta = taskMeta.get(w.lib + '/' + w.task)
  const repo = path.join(REPOS, meta.url.split('/').pop())
  const repoName = meta.url.split('/').pop()
  run('git', ['config', 'core.autocrlf', 'false'], repo)
  run('git', ['config', 'core.longpaths', 'true'], repo)
  const wt = path.join(WORK, 'wt')
  run('git', ['worktree', 'remove', '--force', wt], repo)
  const add = run('git', ['worktree', 'add', '--detach', wt, meta.commit], repo)
  if (add.code !== 0) { console.log('  !! checkout failed', w.task); continue }

  // assemble: apply feature A patch, capture; reset; apply feature B; then write ICR
  // merges for common files and A-exclusive contents on top of B's tree.
  const capture = (feat) => {
    const ap = applyPatchText(wt, rd(path.join(meta.dir, feat, 'feature.patch')))
    if (ap.code !== 0) return null
    const changed = run('git', ['diff', '--name-only'], wt).out.split('\n').filter(Boolean)
    const untracked = run('git', ['ls-files', '--others', '--exclude-standard'], wt).out.split('\n').filter(Boolean)
    const m = new Map()
    for (const f of [...changed, ...untracked]) m.set(f, rd(path.join(wt, f)))
    run('git', ['checkout', '--', '.'], wt); run('git', ['clean', '-fdq'], wt)
    return m
  }
  const A = capture(w.pair[0]), B = capture(w.pair[1])
  if (!A || !B) { console.log('  !! patch apply failed', w.task, w.pair.join('+')); continue }
  let assembled = true
  for (const [f, contentB] of B) { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), contentB) }
  for (const [f, contentA] of A) {
    if (!B.has(f)) { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), contentA); continue }
    const show = run('git', ['show', `${meta.commit}:${f}`], repo)
    const base = show.code === 0 ? show.out : ''
    const m = merge(base, contentA, B.get(f), { filename: path.basename(f) })
    if (!m.clean) { assembled = false; break } // should not happen — receipts said clean
    fs.writeFileSync(path.join(wt, f), m.text)
  }
  if (!assembled) { console.log('  !! re-merge not clean (stale receipt?)', w.task, w.pair.join('+')); continue }

  // install package into the venv from this worktree
  const pyExe = ensureVenv(repoName)
  const inst = run(pyExe, ['-m', 'pip', 'install', '-q', '-e', '.'], wt, 600000)
  if (inst.code !== 0) { console.log('  !! pip install failed', w.task, inst.out.slice(0, 150)); continue }

  // run each feature's tests on the merged tree
  const runFeatureTests = (feat) => {
    const tp = rd(path.join(meta.dir, feat, 'tests.patch'))
    const ap = applyPatchText(wt, tp)
    if (ap.code !== 0) return { ok: false, why: 'tests.patch apply failed' }
    const testFiles = [...new Set((tp.match(/^\+\+\+ b\/(.+)$/gm) || []).map((l) => l.slice(6)))].filter((f) => /test/i.test(f))
    const res = run(pyExe, ['-m', 'pytest', '-x', '-q', ...testFiles], wt, 600000)
    // revert tests
    run('git', ['checkout', '--', '.'], wt); run('git', ['clean', '-fdq', '--', 'tests', '.'], wt)
    // re-write the merged tree (checkout wiped it)
    for (const [f, contentB] of B) fs.writeFileSync(path.join(wt, f), contentB)
    for (const [f, contentA] of A) {
      if (!B.has(f)) { fs.writeFileSync(path.join(wt, f), contentA); continue }
      const show = run('git', ['show', `${meta.commit}:${f}`], repo)
      const m = merge(show.code === 0 ? show.out : '', contentA, B.get(f), { filename: path.basename(f) })
      fs.writeFileSync(path.join(wt, f), m.text)
    }
    return { ok: res.code === 0, why: res.code === 0 ? '' : res.out.split('\n').slice(-6).join(' | ').slice(0, 300) }
  }
  const t1 = runFeatureTests(w.pair[0])
  const t2 = t1.ok ? runFeatureTests(w.pair[1]) : { ok: false, why: 'skipped (first failed)' }
  const ok = t1.ok && t2.ok
  if (ok) pass++
  else if (t1.why.includes('apply failed') || t2.why.includes('apply failed')) failCode++
  else failTest++
  rows.push({ task: w.task, pair: w.pair, pass: ok, t1: t1.ok, t2: t2.ok, why: ok ? '' : (t1.ok ? t2.why : t1.why) })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${w.task} ${w.pair.join('+')}${ok ? '' : '  :: ' + (t1.ok ? t2.why : t1.why).slice(0, 120)}`)
  run('git', ['worktree', 'remove', '--force', wt], repo)
}

console.log(`\n=== VALIDATION (${LIB}): ${pass}/${rows.length} ICR integrations pass BOTH features' test suites ===`)
console.log(`(test failures: ${failTest}, tests-patch apply issues: ${failCode})`)
fs.writeFileSync(`cooper-validate-${LIB}.json`, JSON.stringify(rows, null, 2))
