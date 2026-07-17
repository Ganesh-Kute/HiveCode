// COOPERBENCH MERGE-LAYER EXPERIMENT — replay every CooperBench feature pair through
// git / mergiraf / ICR and measure the INTEGRATION layer in isolation.
//
// CooperBench (arXiv:2601.13295) showed two agents cooperating on a shared codebase lose
// ~50% of their success rate, and its gold_conflict_report.json shows why the medium is
// implicated: even with the PROFESSIONALLY-WRITTEN gold implementations of both features,
// git conflicts on 499/652 pairs (76.5%). Those 499 are exactly the cases where an agent
// pair must stop and negotiate — the coordination tax Hivecode's medium claims to remove.
//
// This harness asks the precise question: of the pairs git cannot integrate, how many
// does a structural+intent merge integrate cleanly? For each task (repo@commit) and each
// feature pair (i,j): ours = base + gold_i, theirs = base + gold_j, 3-way merge every
// file BOTH sides touched. Pair verdict per engine = every common file merges clean.
// Receipts: cooper-merge.json (per-pair), console cross-check vs the paper's own report.
//
//   node cooper-merge-bench.mjs [datasetDir] [--lib=<name>]
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { merge } from './packages/icr-merge/index.js'
import { initTreeSitter } from './packages/icr-merge/treesitter.js'

const SCRATCH = 'C:/Users/G1/AppData/Local/Temp/claude/c--Users-G1-Desktop-N/f6ef2bbd-7478-449b-bb39-8c8db7d3ae86/scratchpad'
const DATASET = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : SCRATCH + '/CooperBench/dataset'
const ONLY_LIB = (process.argv.find((a) => a.startsWith('--lib=')) || '').slice(6) || null
const REPOS = SCRATCH + '/cooper-repos'
const MERGIRAF = SCRATCH + '/mergiraf-bin/mergiraf.exe'
const WORK = SCRATCH + '/cooper-work'
fs.mkdirSync(WORK, { recursive: true })

let ORACLE = false
try { const r = await initTreeSitter(); ORACLE = r.upgraded.length > 0 } catch {}
console.log(`COOPERBENCH MERGE-LAYER — oracle ${ORACLE ? 'ON' : 'off'}`)

function run(cmd, args, cwd) {
  try { return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) } }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : -1, out: (e.stdout || '') + '', err: (e.stderr || '') + '' } }
}
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

// --- enumerate tasks ---------------------------------------------------------------
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
const tasks = []
for (const libDir of fs.readdirSync(DATASET)) {
  if (!libDir.endsWith('_task')) continue
  if (ONLY_LIB && !libDir.includes(ONLY_LIB)) continue
  for (const t of fs.readdirSync(path.join(DATASET, libDir))) {
    if (!/^task\d+$/.test(t)) continue
    const dir = path.join(DATASET, libDir, t)
    const { url, commit } = parseSetup(path.join(dir, 'setup.sh'))
    if (!url || !commit) { console.log(`  !! ${libDir}/${t}: cannot parse setup.sh`); continue }
    const features = fs.readdirSync(dir).filter((f) => /^feature\d+$/.test(f) && fs.existsSync(path.join(dir, f, 'feature.patch')))
      .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))
    tasks.push({ lib: libDir, task: t, dir, url, commit, features })
  }
}
console.log(`${tasks.length} tasks, ${tasks.reduce((s, t) => s + t.features.length, 0)} features`)

// --- engines -----------------------------------------------------------------------
function gitMergeFile(ext, b, o, t) {
  const pb = WORK + '/g-b' + ext, po = WORK + '/g-o' + ext, pt = WORK + '/g-t' + ext
  fs.writeFileSync(pb, b); fs.writeFileSync(po, o); fs.writeFileSync(pt, t)
  return run('git', ['merge-file', '-p', po, pb, pt]).code === 0
}
function mergirafClean(ext, b, o, t) {
  const pb = WORK + '/m-b' + ext, po = WORK + '/m-o' + ext, pt = WORK + '/m-t' + ext
  fs.writeFileSync(pb, b); fs.writeFileSync(po, o); fs.writeFileSync(pt, t)
  const r = run(MERGIRAF, ['merge', pb, po, pt, '-p', 'm' + ext])
  return { clean: r.code === 0, crash: r.code !== 0 && r.code !== 1 }
}
function icrClean(file, b, o, t) {
  try { const r = merge(b, o, t, { filename: path.basename(file) }); return { clean: r.clean, method: r.method, crash: false } }
  catch { return { clean: false, crash: true } }
}
// UNION MODE: the multi-agent policy — the medium knows the two edits serve independent
// tasks, so same-point insertions keep BOTH (deterministic order); parse gates still rule.
function icrUnionClean(file, b, o, t) {
  try { const r = merge(b, o, t, { filename: path.basename(file), unionInserts: true }); return { clean: r.clean, method: r.method, crash: false } }
  catch { return { clean: false, crash: true } }
}

// --- per-task replay -----------------------------------------------------------------
const repoDirName = (url) => url.split('/').pop()
const summary = { pairs: 0, gitClean: 0, gitConflict: 0, filesGitConflict: 0 }
const engines = {
  icr: { cleanOnGitConflict: 0, crash: 0, fileCleanOnGitConflict: 0 },
  icrUnion: { cleanOnGitConflict: 0, crash: 0, fileCleanOnGitConflict: 0 },
  mergiraf: { cleanOnGitConflict: 0, crash: 0, fileCleanOnGitConflict: 0 },
}
const receipts = []
const gold = JSON.parse(rd(path.join(DATASET, 'gold_conflict_report.json')) || '{"per_task":{}}')

for (const task of tasks) {
  const repo = path.join(REPOS, repoDirName(task.url))
  if (!fs.existsSync(repo)) { console.log(`  !! missing clone: ${repo}`); continue }
  // Windows CRLF poison: autocrlf checks the worktree out with \r\n while `git show`
  // yields \n — every line then "differs" and every merge conflicts. Force LF everywhere.
  run('git', ['config', 'core.autocrlf', 'false'], repo)
  // worktree at the task's base commit
  const wt = path.join(WORK, 'wt-' + task.lib + '-' + task.task)
  run('git', ['worktree', 'remove', '--force', wt], repo)
  const add = run('git', ['worktree', 'add', '--detach', wt, task.commit], repo)
  if (add.code !== 0) { console.log(`  !! ${task.lib}/${task.task}: cannot checkout ${task.commit.slice(0, 10)} (${(add.err || '').split('\n')[0]})`); continue }

  // apply each feature's gold patch; capture changed files' contents
  const featureFiles = new Map() // featureName -> Map(file -> content)
  const baseContent = new Map()  // file -> base content (null = absent in base)
  for (const f of task.features) {
    // The dataset clone may have checked patches out with CRLF while the target worktree
    // is LF — strip \r into a temp copy so context lines match byte-for-byte.
    const rawPatch = rd(path.join(task.dir, f, 'feature.patch')) || ''
    const patch = path.join(WORK, 'cur.patch')
    fs.writeFileSync(patch, rawPatch.replace(/\r\n/g, '\n'))
    const ap = run('git', ['apply', '--whitespace=nowarn', patch], wt)
    if (ap.code !== 0) { featureFiles.set(f, null); run('git', ['checkout', '--', '.'], wt); run('git', ['clean', '-fdq'], wt); continue }
    const changed = run('git', ['diff', '--name-only'], wt).out.split('\n').filter(Boolean)
    const untracked = run('git', ['ls-files', '--others', '--exclude-standard'], wt).out.split('\n').filter(Boolean)
    const m = new Map()
    for (const file of [...changed, ...untracked]) {
      m.set(file, rd(path.join(wt, file)))
      if (!baseContent.has(file)) {
        const show = run('git', ['show', `${task.commit}:${file}`], repo)
        baseContent.set(file, show.code === 0 ? show.out : null)
      }
    }
    featureFiles.set(f, m)
    run('git', ['checkout', '--', '.'], wt); run('git', ['clean', '-fdq'], wt)
  }

  // all pairs
  const names = task.features.filter((f) => featureFiles.get(f))
  let taskPairs = 0, taskGitConf = 0
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const A = featureFiles.get(names[i]), B = featureFiles.get(names[j])
    const common = [...A.keys()].filter((f) => B.has(f))
    summary.pairs++; taskPairs++
    let gitOk = true, icrOk = true, unOk = true, mgOk = true, icrCrash = false, unCrash = false, mgCrash = false
    const fileRows = []
    for (const file of common) {
      const b = baseContent.get(file) ?? ''
      const o = A.get(file) ?? '', t = B.get(file) ?? ''
      if (o === t || b === o || b === t) continue
      const ext = path.extname(file) || '.txt'
      const g = gitMergeFile(ext, b, o, t)
      const ic = icrClean(file, b, o, t)
      const un = icrUnionClean(file, b, o, t)
      const mg = mergirafClean(ext, b, o, t)
      if (!g) {
        gitOk = false
        summary.filesGitConflict++
        if (ic.clean) engines.icr.fileCleanOnGitConflict++
        if (un.clean) engines.icrUnion.fileCleanOnGitConflict++
        if (mg.clean) engines.mergiraf.fileCleanOnGitConflict++
      }
      if (!ic.clean) icrOk = false
      if (ic.crash) icrCrash = true
      if (!un.clean) unOk = false
      if (un.crash) unCrash = true
      if (!mg.clean) mgOk = false
      if (mg.crash) mgCrash = true
      fileRows.push({ file, git: g, icr: ic.clean, icrMethod: ic.method, icrUnion: un.clean, mergiraf: mg.clean })
    }
    if (gitOk) summary.gitClean++
    else {
      summary.gitConflict++; taskGitConf++
      if (icrOk) engines.icr.cleanOnGitConflict++
      if (unOk) engines.icrUnion.cleanOnGitConflict++
      if (mgOk) engines.mergiraf.cleanOnGitConflict++
    }
    if (icrCrash) engines.icr.crash++
    if (unCrash) engines.icrUnion.crash++
    if (mgCrash) engines.mergiraf.crash++
    receipts.push({ lib: task.lib, task: task.task, pair: [names[i], names[j]], git: gitOk, icr: icrOk, icrUnion: unOk, mergiraf: mgOk, files: fileRows })
  }
  const g = gold.per_task[`${task.lib}/${task.task}`]
  console.log(`  ${task.lib}/${task.task}: ${taskPairs} pairs, git-conflicts ${taskGitConf}${g ? ` (paper: ${g.conflicts}/${g.total})` : ''}`)
  run('git', ['worktree', 'remove', '--force', wt], repo)
}

console.log(`\n=== COOPERBENCH MERGE LAYER ===`)
console.log(`pairs replayed        : ${summary.pairs}  (paper: 652)`)
console.log(`git clean             : ${summary.gitClean}  (paper: 153)`)
console.log(`git CONFLICT          : ${summary.gitConflict}  (paper: 499 = 76.5%)`)
for (const [eng, s] of Object.entries(engines)) {
  console.log(`${eng.padEnd(9)} PAIRS integrated cleanly ${s.cleanOnGitConflict}/${summary.gitConflict} of git's conflicts (${summary.gitConflict ? (s.cleanOnGitConflict / summary.gitConflict * 100).toFixed(1) : 0}%)  FILES ${s.fileCleanOnGitConflict}/${summary.filesGitConflict} (${summary.filesGitConflict ? (s.fileCleanOnGitConflict / summary.filesGitConflict * 100).toFixed(1) : 0}%)  crashes ${s.crash}`)
}
fs.writeFileSync('cooper-merge.json', JSON.stringify({ summary, engines, receipts }, null, 2))
console.log('receipts -> cooper-merge.json')
