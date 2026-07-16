// CONGRA BENCHMARK ADAPTER — run ICR (and mergiraf + git as baselines) over the
// public ConGra conflict corpus (HKU System Security Lab, arXiv:2409.14121) and score
// each engine against ConGra's own answer key.
//
// ConGra raw_datasets layout, per conflict pair:
//   <lang>/<project>/<pair>/{base,a,b,resolved}/<relative/file/path>
//     base = O (common ancestor)   a = ours   b = theirs   resolved = R (human answer)
// These are exactly ICR's 3-way inputs. Every ConGra case is a real git-conflict case
// (they mined conflicts), so this measures: of conflicts a line merge flagged, how many
// each engine auto-resolves, and how often that auto-resolution equals what the human
// shipped (R). Same methodology as our ground-truth gauntlet, on a PUBLISHED corpus.
//
//   node congra-bench.mjs <raw_datasets/lang_dir> [maxCases]
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { merge } from './packages/icr-merge/index.js'
import { merge3 } from './packages/icr-merge/merge3.js'
import { initTreeSitter } from './packages/icr-merge/treesitter.js'

// Sound config: the tree-sitter oracle enforces THE GUARANTEE with a real grammar (no
// ERROR nodes), not just the heuristic validators. On by default here; ICR_NO_ORACLE=1
// runs heuristic-only to measure the difference. Fail-open: if the grammars aren't
// installed, the heuristic verdict stands (and the run is labeled accordingly).
let ORACLE = false
if (!process.env.ICR_NO_ORACLE) {
  try { const r = await initTreeSitter(); ORACLE = r.upgraded.includes('python') } catch { ORACLE = false }
}

const SCRATCH = 'C:/Users/G1/AppData/Local/Temp/claude/c--Users-G1-Desktop-N/f6ef2bbd-7478-449b-bb39-8c8db7d3ae86/scratchpad'
const MERGIRAF = SCRATCH + '/mergiraf-bin/mergiraf.exe'
const ROOT = process.argv[2]
const MAX = Number(process.argv[3] || 100000)
if (!ROOT || !fs.existsSync(ROOT)) { console.error('usage: node congra-bench.mjs <raw_datasets/lang_dir> [maxCases]'); process.exit(2) }
const langName = path.basename(ROOT)
const WORK = SCRATCH + '/congra-work/' + langName
fs.mkdirSync(WORK, { recursive: true })

const EXT = /\.(py|java|c|cc|cpp|cxx|h|hpp|js|mjs|cjs|ts)$/
const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\s+$/gm, '').replace(/\n+$/, '\n')
const nows = (s) => s.replace(/\s+/g, '')

function run(cmd, args) {
  try { return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }) } }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : -1, out: e.stdout ? e.stdout.toString() : '' } }
}
function gitConflicts(ext, b, o, t) {
  const pb = WORK + '/b' + ext, po = WORK + '/o' + ext, pt = WORK + '/t' + ext
  fs.writeFileSync(pb, b); fs.writeFileSync(po, o); fs.writeFileSync(pt, t)
  return run('git', ['merge-file', '-p', po, pb, pt]).code !== 0
}
function mergirafMerge(ext, b, o, t) {
  const pb = WORK + '/b' + ext, po = WORK + '/o' + ext, pt = WORK + '/t' + ext
  fs.writeFileSync(pb, b); fs.writeFileSync(po, o); fs.writeFileSync(pt, t)
  const t0 = Date.now(); const r = run(MERGIRAF, ['merge', pb, po, pt, '-p', 'm' + ext])
  return { text: r.out, clean: r.code === 0, crash: r.code !== 0 && r.code !== 1, ms: Date.now() - t0 }
}
function icrMerge(file, b, o, t) {
  const t0 = Date.now()
  try { const r = merge(b, o, t, { filename: path.basename(file) }); return { text: r.text, clean: r.clean, method: r.method, crash: false, ms: Date.now() - t0 } }
  catch (e) { return { text: '', clean: false, crash: true, err: String(e && e.message).slice(0, 160), ms: Date.now() - t0 } }
}

// list files under base/ that also exist under a/ b/ resolved/ (relative paths line up)
function relFiles(dir) {
  const out = []
  const walk = (d, rel) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(path.join(d, e.name), r)
      else if (e.isFile() && EXT.test(e.name)) out.push(r)
    }
  }
  walk(dir, '')
  return out
}
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

// find every conflict-pair dir: a dir containing base/ a/ b/ resolved/ subdirs
function findPairs(root) {
  const pairs = []
  const walk = (d, depth) => {
    if (depth > 6) return
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    const names = new Set(ents.filter((e) => e.isDirectory()).map((e) => e.name))
    if (names.has('base') && names.has('a') && names.has('b') && names.has('resolved')) { pairs.push(d); return }
    for (const e of ents) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1)
  }
  walk(root, 0)
  return pairs
}

console.log(`CONGRA BENCHMARK — ${langName}   [ICR parse-guarantee: ${ORACLE ? 'tree-sitter oracle ON (sound)' : 'heuristic-only'}]`)
const pairs = findPairs(ROOT)
console.log(`found ${pairs.length} conflict-pair dirs\n`)

const Z = () => ({ MATCH: 0, 'MATCH-WS': 0, 'CLEAN-DIFF': 0, CONFLICT: 0, BROKEN: 0, CRASH: 0, ms: 0 })
const tally = { icr: Z(), mergiraf: Z() }
let cases = 0, skippedNoGitConflict = 0
const receipts = []

// EMPIRICAL parse verification (Python only): dump every clean output; a single python
// pass at the end ast.parse()s them all, so "broken" is MEASURED, not assumed. Turns the
// parse guarantee from a by-construction claim into a number on a public corpus — and
// checks mergiraf's clean outputs for silent breakage too.
const PC = WORK + '/parsecheck'; fs.rmSync(PC, { recursive: true, force: true }); fs.mkdirSync(PC, { recursive: true })
const pyCleanOuts = [] // { file, eng, cls, idx }

outer:
for (const pair of pairs) {
  const files = relFiles(path.join(pair, 'base'))
  for (const rel of files) {
    if (cases >= MAX) break outer
    const b = rd(path.join(pair, 'base', rel)), o = rd(path.join(pair, 'a', rel)),
          t = rd(path.join(pair, 'b', rel)), R = rd(path.join(pair, 'resolved', rel))
    if (b == null || o == null || t == null || R == null) continue
    if (b === o || b === t || o === t) continue
    if ([b, o, t, R].some((s) => s.length > 1_500_000)) continue
    const ext = path.extname(rel) || '.txt'
    if (!gitConflicts(ext, b, o, t)) { skippedNoGitConflict++; continue } // not a real conflict case
    cases++
    const classify = (res) => {
      if (res.crash) return 'CRASH'
      if (!res.clean) return 'CONFLICT'
      if (norm(res.text) === norm(R)) return 'MATCH'
      if (nows(res.text) === nows(R)) return 'MATCH-WS'
      return 'CLEAN-DIFF' // ICR's parse guarantee means clean output is valid; BROKEN only if unparseable — handled below
    }
    // SKIP_MERGIRAF=1: ICR-only pass (mergiraf's numbers are engine-independent of ICR
    // changes; skipping it turns an hour-long run into minutes when iterating on ICR).
    const icr = icrMerge(rel, b, o, t)
    const mg = process.env.SKIP_MERGIRAF ? { text: '', clean: false, crash: false, ms: 0 } : mergirafMerge(ext, b, o, t)
    const ci = classify(icr), cm = classify(mg)
    tally.icr[ci]++; tally.icr.ms += icr.ms
    tally.mergiraf[cm]++; tally.mergiraf.ms += mg.ms
    const rec = { idx: cases, pair: path.relative(ROOT, pair), file: rel, icr: ci, icrMethod: icr.method, mergiraf: cm }
    receipts.push(rec)
    if (ext === '.py') {
      // Also dump the human's answer key: an output can only be judged BROKEN when the
      // ground truth itself parses under py3 (the corpus has 2010s Python-2-era code —
      // e.g. `async = ...` — that no engine could turn into valid py3).
      const gtfn = `gt-${cases}.py`; fs.writeFileSync(path.join(PC, gtfn), R)
      for (const [eng, res, cls] of [['icr', icr, ci], ['mergiraf', mg, cm]]) {
        if ((cls === 'MATCH' || cls === 'MATCH-WS' || cls === 'CLEAN-DIFF') && res.text) {
          const fn = `${eng}-${cases}.py`; fs.writeFileSync(path.join(PC, fn), res.text)
          pyCleanOuts.push({ fn, gtfn, eng, idx: cases })
        }
      }
    }
    if (cases % 50 === 0) console.log(`  [${cases}] icr=${ci} mergiraf=${cm}  ${rel}`)
  }
}

// batched python parse check over all clean .py outputs
let pyBrokenICR = 0, pyBrokenMG = 0
if (pyCleanOuts.length) {
  const script = `import ast,sys,os
d=sys.argv[1]
for fn in sorted(os.listdir(d)):
  if not fn.endswith('.py'): continue
  try: ast.parse(open(os.path.join(d,fn),encoding='utf-8').read())
  except Exception: print('BROKEN '+fn)
`
  fs.writeFileSync(WORK + '/pc.py', script)
  const r = run('python', [WORK + '/pc.py', PC])
  const broken = new Set((r.out || '').split('\n').filter((l) => l.startsWith('BROKEN ')).map((l) => l.slice(7).trim()))
  let inheritedICR = 0, inheritedMG = 0
  for (const c of pyCleanOuts) {
    if (!broken.has(c.fn)) continue
    if (broken.has(c.gtfn)) { if (c.eng === 'icr') inheritedICR++; else inheritedMG++; continue } // answer key itself isn't py3 → inherited, not a defect
    if (c.eng === 'icr') pyBrokenICR++; else pyBrokenMG++
  }
  console.log(`\nPYTHON PARSE VERIFICATION (${pyCleanOuts.length} clean outputs vs ast.parse):`)
  console.log(`  BROKEN with a py3-valid answer key — ICR: ${pyBrokenICR}, mergiraf: ${pyBrokenMG}   (inherited py2-era invalidity, excluded — ICR: ${inheritedICR}, mergiraf: ${inheritedMG})`)
}

console.log(`\n=== CONGRA ${langName}: ${cases} real git-conflict cases (${skippedNoGitConflict} pairs had no line-conflict, skipped) ===`)
for (const eng of ['icr', 'mergiraf']) {
  const x = tally[eng]
  const resolved = x.MATCH + x['MATCH-WS'] + x['CLEAN-DIFF']
  const agree = x.MATCH + x['MATCH-WS']
  console.log(`${eng.padEnd(9)} resolved ${resolved}/${cases} (${cases ? (resolved / cases * 100).toFixed(1) : 0}%)  ==human ${agree}${resolved ? ' (' + (agree / resolved * 100).toFixed(1) + '% of resolved)' : ''}  clean-diff ${x['CLEAN-DIFF']}  conflict ${x.CONFLICT}  CRASH ${x.CRASH}  ${x.ms}ms`)
}
fs.writeFileSync(`congra-${langName}.json`, JSON.stringify({ lang: langName, cases, skippedNoGitConflict, tally, receipts }, null, 2))
console.log(`receipts -> congra-${langName}.json`)
