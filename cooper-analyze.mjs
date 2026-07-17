// Classify the CooperBench pairs ICR could NOT integrate: how many are judge-resolvable
// semantic conflicts (ICR names the exact conflicting unit and carries base/ours/theirs
// -> resolveMerge territory) vs line-tier conflicts (no structural handle)?
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { merge } from './packages/icr-merge/index.js'
import { initTreeSitter } from './packages/icr-merge/treesitter.js'

const SCRATCH = 'C:/Users/G1/AppData/Local/Temp/claude/c--Users-G1-Desktop-N/f6ef2bbd-7478-449b-bb39-8c8db7d3ae86/scratchpad'
const DATASET = SCRATCH + '/CooperBench/dataset'
const REPOS = SCRATCH + '/cooper-repos'
const WORK = SCRATCH + '/cooper-analyze'
fs.mkdirSync(WORK, { recursive: true })
try { await initTreeSitter() } catch {}

const run = (c, a, cwd) => { try { return { code: 0, out: execFileSync(c, a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6 }) } } catch (e) { return { code: e.status ?? -1, out: ((e.stdout || '') + '') } } }
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

const all = JSON.parse(rd('cooper-merge.json'))
const losses = all.receipts.filter((r) => !r.git && !r.icr)
console.log(`${losses.length} pairs ICR could not integrate — classifying...`)

function parseSetup(sh) {
  const src = rd(sh) || ''
  const commit = (src.match(/BASE_COMMIT="([0-9a-f]{7,40})"/) || [])[1]
  let url = (src.match(/git clone (https:\/\/github\.com\/[^\s"]+)/) || [])[1]
  if (url && url.includes('${')) {
    const owner = (src.match(/REPO_OWNER="([^"]+)"/) || [])[1], name = (src.match(/REPO_NAME="([^"]+)"/) || [])[1]
    if (owner && name) url = `https://github.com/${owner}/${name}`
  }
  return { url: url ? url.replace(/\.git$/, '') : null, commit }
}

// group losses by task to reuse worktrees
const byTask = new Map()
for (const r of losses) { const k = r.lib + '/' + r.task; if (!byTask.has(k)) byTask.set(k, []); byTask.get(k).push(r) }

let judgeable = 0, lineOnly = 0, mixed = 0
let unitCount = 0
const kinds = {}
const rows = []
for (const [key, pairs] of byTask) {
  const [lib, task] = key.split('/')
  const dir = path.join(DATASET, lib, task)
  const meta = parseSetup(path.join(dir, 'setup.sh'))
  const repo = path.join(REPOS, meta.url.split('/').pop())
  run('git', ['config', 'core.autocrlf', 'false'], repo); run('git', ['config', 'core.longpaths', 'true'], repo)
  const wt = path.join(WORK, 'wt')
  run('git', ['worktree', 'remove', '--force', wt], repo)
  if (run('git', ['worktree', 'add', '--detach', wt, meta.commit], repo).code !== 0) continue
  const capture = (feat) => {
    fs.writeFileSync(WORK + '/p.patch', (rd(path.join(dir, feat, 'feature.patch')) || '').replace(/\r\n/g, '\n'))
    if (run('git', ['apply', '--whitespace=nowarn', WORK + '/p.patch'], wt).code !== 0) return null
    const files = [...run('git', ['diff', '--name-only'], wt).out.split('\n'), ...run('git', ['ls-files', '--others', '--exclude-standard'], wt).out.split('\n')].filter(Boolean)
    const m = new Map(); for (const f of files) m.set(f, rd(path.join(wt, f)))
    run('git', ['checkout', '--', '.'], wt); run('git', ['clean', '-fdq'], wt)
    return m
  }
  const cache = new Map()
  const featMap = (f) => { if (!cache.has(f)) cache.set(f, capture(f)); return cache.get(f) }
  for (const r of pairs) {
    const A = featMap(r.pair[0]), B = featMap(r.pair[1])
    if (!A || !B) continue
    let hasResolvable = false, hasLineConf = false
    for (const file of [...A.keys()].filter((f) => B.has(f))) {
      const show = run('git', ['show', `${meta.commit}:${file}`], repo)
      const base = show.code === 0 ? show.out : ''
      const o = A.get(file), t = B.get(file)
      if (o === t || base === o || base === t) continue
      const m = merge(base, o, t, { filename: path.basename(file) })
      if (m.clean) continue
      if (m.resolvable && m.resolvable.length) {
        hasResolvable = true
        unitCount += m.resolvable.length
        for (const u of m.resolvable) { const k = u.key.split(':')[0] + ':'; kinds[k] = (kinds[k] || 0) + 1 }
      } else hasLineConf = true
    }
    if (hasResolvable && !hasLineConf) judgeable++
    else if (hasResolvable) mixed++
    else lineOnly++
    rows.push({ lib: r.lib, task: r.task, pair: r.pair, judgeable: hasResolvable && !hasLineConf, mixed: hasResolvable && hasLineConf })
  }
  run('git', ['worktree', 'remove', '--force', wt], repo)
}
console.log(`\nfully judge-resolvable (every conflict is a named semantic unit): ${judgeable}`)
console.log(`mixed (some semantic units + some line conflicts)               : ${mixed}`)
console.log(`line-tier only (no structural handle)                           : ${lineOnly}`)
console.log(`total conflict units carried: ${unitCount}; kinds: ${JSON.stringify(kinds)}`)
fs.writeFileSync('cooper-analyze.json', JSON.stringify({ judgeable, mixed, lineOnly, unitCount, kinds, rows }, null, 2))
