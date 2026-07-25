// Diagnose the ICR-broken Python outputs from ConGra: is ICR violating its parse
// guarantee, or are the INPUTS themselves non-Python3 (ast.parse can't be held against
// an engine fed unparseable input)? The guarantee only claims: inputs parse -> output parses.
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { merge } from './packages/icr-merge/index.js'
import { initTreeSitter } from './packages/icr-merge/treesitter.js'

if (!process.env.ICR_NO_ORACLE) { try { const r = await initTreeSitter(); console.log('oracle:', r.upgraded.includes('python') ? 'ON' : 'off') } catch { console.log('oracle: off (peers missing)') } }
const ROOT = process.argv[2]
const WORK = 'C:/Users/G1/AppData/Local/Temp/claude/c--Users-G1-Desktop-N/f6ef2bbd-7478-449b-bb39-8c8db7d3ae86/scratchpad/congra-diag'
fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true })
const rd = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const EXT = /\.py$/

function pyParses(text) {
  const f = WORK + '/probe.py'; fs.writeFileSync(f, text)
  try { execFileSync('python', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())', f], { stdio: 'ignore' }); return true }
  catch { return false }
}
function findPairs(root) {
  const pairs = []
  const walk = (d, depth) => {
    if (depth > 6) return
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    const names = new Set(ents.filter((e) => e.isDirectory()).map((e) => e.name))
    if (names.has('base') && names.has('a') && names.has('b') && names.has('resolved')) { pairs.push(d); return }
    for (const e of ents) if (e.isDirectory()) walk(path.join(d, e.name), depth + 1)
  }
  walk(root, 0); return pairs
}
function relFiles(dir) {
  const out = []
  const walk = (d, rel) => { let e; try { e = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const x of e) { const r = rel ? rel + '/' + x.name : x.name; if (x.isDirectory()) walk(path.join(d, x.name), r); else if (EXT.test(x.name)) out.push(r) } }
  walk(dir, ''); return out
}

let icrBrokenRealGuarantee = 0, icrBrokenBadInput = 0, checked = 0
const realViolations = []
for (const pair of findPairs(ROOT)) {
  for (const rel of relFiles(path.join(pair, 'base'))) {
    const b = rd(path.join(pair, 'base', rel)), o = rd(path.join(pair, 'a', rel)), t = rd(path.join(pair, 'b', rel))
    if (b == null || o == null || t == null) continue
    if (b === o || b === t || o === t) continue
    let r; try { r = merge(b, o, t, { filename: path.basename(rel) }) } catch { continue }
    if (!r.clean || !r.text) continue
    if (pyParses(r.text)) continue           // clean AND valid — fine
    checked++
    // ICR shipped clean output that fails ast.parse. Was the input even valid Python3?
    const inputsOk = pyParses(o) && pyParses(t)  // ours & theirs both parse under py3
    if (inputsOk) { icrBrokenRealGuarantee++; realViolations.push({ pair: path.relative(ROOT, pair), file: rel, method: r.method }) }
    else icrBrokenBadInput++
  }
}
console.log(`ICR clean-but-ast-invalid outputs: ${checked}`)
console.log(`  -> inputs (ours+theirs) were NOT both valid Python3 (not ICR's fault): ${icrBrokenBadInput}`)
console.log(`  -> inputs WERE valid Python3 = REAL guarantee violation: ${icrBrokenRealGuarantee}`)
for (const v of realViolations.slice(0, 20)) console.log(`     VIOLATION ${v.method}  ${v.pair}  ${v.file}`)
