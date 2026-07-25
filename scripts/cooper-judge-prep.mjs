// PHASE 1c PREP — build the judge work manifest for the 344 judge-resolvable pairs.
// For every conflicting unit: base/ours/theirs + BOTH features' intents (feature.md
// title/summary — CooperBench hands us exactly the intent field resolveMerge wants).
// Units are DEDUPED by content hash: the same unit clash recurs across many pairs
// (feature X vs several partners), so judges judge each distinct clash once.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { merge } from './packages/icr-merge/index.js'
import { initTreeSitter } from './packages/icr-merge/treesitter.js'

const SCRATCH = 'C:/Users/G1/AppData/Local/Temp/claude/c--Users-G1-Desktop-N/f6ef2bbd-7478-449b-bb39-8c8db7d3ae86/scratchpad'
const DATASET = SCRATCH + '/CooperBench/dataset'
const REPOS = SCRATCH + '/cooper-repos'
const WORK = SCRATCH + '/cooper-judge'
fs.mkdirSync(WORK, { recursive: true })
try { await initTreeSitter() } catch {}

const run = (c, a, cwd) => { try { return { code: 0, out: execFileSync(c, a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6 }) } } catch (e) { return { code: e.status ?? -1, out: ((e.stdout || '') + '') } } }
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const intentOf = (dir, feat) => {
  const md = rd(path.join(dir, feat, 'feature.md')) || ''
  const title = (md.match(/\*\*Title\*\*:\s*(.+)/) || [])[1] || md.split('\n')[0]
  const desc = (md.match(/\*\*Description\*\*:\s*\n?([\s\S]{0,500})/) || [])[1] || md.slice(0, 400)
  return (title + ' — ' + desc.replace(/\s+/g, ' ')).slice(0, 450)
}
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

const analyze = JSON.parse(rd('cooper-analyze.json'))
const targets = analyze.rows.filter((r) => r.judgeable)
console.log(`${targets.length} judge-resolvable pairs`)

const byTask = new Map()
for (const r of targets) { const k = r.lib + '/' + r.task; if (!byTask.has(k)) byTask.set(k, []); byTask.get(k).push(r) }

const units = new Map() // hash -> { id, filename, key, base, ours, theirs, intents:[..] }
const pairUnits = []    // { lib, task, pair, unitHashes:[...] }
for (const [key, pairs] of byTask) {
  const [lib, task] = key.split('/')
  const dir = path.join(DATASET, lib, task)
  const meta = parseSetup(path.join(dir, 'setup.sh'))
  const repo = path.join(REPOS, meta.url.split('/').pop())
  run('git', ['config', 'core.autocrlf', 'false'], repo); run('git', ['config', 'core.longpaths', 'true'], repo)
  const wt = path.join(WORK, 'wt')
  run('git', ['worktree', 'remove', '--force', wt], repo)
  if (run('git', ['worktree', 'add', '--detach', wt, meta.commit], repo).code !== 0) continue
  const cache = new Map()
  const featMap = (feat) => {
    if (cache.has(feat)) return cache.get(feat)
    fs.writeFileSync(WORK + '/p.patch', (rd(path.join(dir, feat, 'feature.patch')) || '').replace(/\r\n/g, '\n'))
    let m = null
    if (run('git', ['apply', '--whitespace=nowarn', WORK + '/p.patch'], wt).code === 0) {
      const files = [...run('git', ['diff', '--name-only'], wt).out.split('\n'), ...run('git', ['ls-files', '--others', '--exclude-standard'], wt).out.split('\n')].filter(Boolean)
      m = new Map(); for (const f of files) m.set(f, rd(path.join(wt, f)))
    }
    run('git', ['checkout', '--', '.'], wt); run('git', ['clean', '-fdq'], wt)
    cache.set(feat, m); return m
  }
  for (const r of pairs) {
    const A = featMap(r.pair[0]), B = featMap(r.pair[1])
    if (!A || !B) continue
    const iA = intentOf(dir, r.pair[0]), iB = intentOf(dir, r.pair[1])
    const hashes = []
    for (const file of [...A.keys()].filter((f) => B.has(f))) {
      const show = run('git', ['show', `${meta.commit}:${file}`], repo)
      const base = show.code === 0 ? show.out : ''
      const o = A.get(file), t = B.get(file)
      if (o === t || base === o || base === t) continue
      const m = merge(base, o, t, { filename: path.basename(file), intents: { ours: iA, theirs: iB } })
      if (m.clean) continue
      for (const u of m.resolvable || []) {
        const h = crypto.createHash('sha1').update([file, u.key, u.base, u.ours, u.theirs, iA, iB].join('\x00')).digest('hex').slice(0, 16)
        if (!units.has(h)) units.set(h, { id: h, filename: file, key: u.key, base: u.base, ours: u.ours, theirs: u.theirs, oursIntent: iA, theirsIntent: iB })
        hashes.push({ file, key: u.key, h })
      }
    }
    pairUnits.push({ lib, task, pair: r.pair, units: hashes })
  }
  run('git', ['worktree', 'remove', '--force', wt], repo)
}
const list = [...units.values()]
console.log(`distinct conflict units to judge: ${list.length} (from ${pairUnits.length} pairs)`)
const sizes = list.map((u) => (u.base || '').length + (u.ours || '').length + (u.theirs || '').length)
console.log(`unit sizes: median ${sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)]} chars, max ${Math.max(...sizes)}`)
fs.writeFileSync(WORK + '/manifest.json', JSON.stringify({ units: list, pairUnits }, null, 1))
console.log(`manifest -> ${WORK}/manifest.json`)
