// Head-to-head: git merge-file  vs  mergiraf (tree-sitter)  vs  icr-merge
// Same base/ours/theirs triples through all three engines; classify each outcome.
// Dev harness — not part of npm test.
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import * as acorn from 'acorn'
import { merge } from './packages/icr-merge/index.js'

const SCRATCH = 'C:/Users/G1/AppData/Local/Temp/claude/c--Users-G1-Desktop-N/f6ef2bbd-7478-449b-bb39-8c8db7d3ae86/scratchpad'
const MERGIRAF = SCRATCH + '/mergiraf-bin/mergiraf.exe'
const HH = SCRATCH + '/hh'
fs.mkdirSync(HH, { recursive: true })

const A = '30000001' // ours sentinel
const B = '40000002' // theirs sentinel

// ---------- helpers ----------
function parse(src) {
  try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }) }
  catch { try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }) } catch { return null } }
}
const parses = (s) => parse(s) !== null

function numLits(src) {
  const ast = parse(src); if (!ast) return []
  const out = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) walk(n); return }
    if (node.type === 'Literal' && typeof node.value === 'number') out.push({ start: node.start, end: node.end, line: node.loc.start.line })
    for (const k in node) { if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue; const v = node[k]; if (v && typeof v === 'object') walk(v) }
  }
  walk(ast)
  return out
}
function topDecls(src) { const ast = parse(src); if (!ast) return []; return ast.body.map((n) => ({ start: n.start, end: n.end })) }
const declOf = (decls, pos) => decls.findIndex((d) => pos >= d.start && pos < d.end)
const setLit = (src, lit, val) => src.slice(0, lit.start) + val + src.slice(lit.end)

// run an external command, return {code, out} regardless of exit status
function run(cmd, args) {
  try { return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }) } }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : -1, out: (e.stdout ? e.stdout.toString() : '') } }
}
function writeTriple(base, ours, theirs) {
  fs.writeFileSync(HH + '/base.js', base); fs.writeFileSync(HH + '/ours.js', ours); fs.writeFileSync(HH + '/theirs.js', theirs)
}
function gitMerge(base, ours, theirs) {
  writeTriple(base, ours, theirs)
  const r = run('git', ['merge-file', '-p', HH + '/ours.js', HH + '/base.js', HH + '/theirs.js'])
  return { text: r.out, clean: r.code === 0, err: r.code < 0 }
}
function mergirafMerge(base, ours, theirs) {
  writeTriple(base, ours, theirs)
  const r = run(MERGIRAF, ['merge', HH + '/base.js', HH + '/ours.js', HH + '/theirs.js', '-p', 'm.js'])
  return { text: r.out, clean: r.code === 0, err: r.code !== 0 && r.code !== 1 }
}
function icrMerge(base, ours, theirs) {
  try { const r = merge(base, ours, theirs, { filename: 'm.js' }); return { text: r.text, clean: r.clean, method: r.method, renames: r.renames, warning: r.warning, err: false } }
  catch { return { text: '', clean: false, err: true } }
}

// classify a result for a concurrent-edit case
// expect.want = 'auto' (disjoint/adjacent, both edits should survive) | 'conflict' (clash)
function classify(res, expect) {
  if (res.err) return 'error'
  if (!res.clean) return 'conflict'
  if (!parses(res.text)) return 'broken'          // clean but unparseable -> SAFETY FAILURE
  if (expect.want === 'auto') {
    const aIn = res.text.includes(A), bIn = res.text.includes(B)
    if (!aIn || !bIn) return 'lost'               // clean, parses, but an edit vanished -> CORRECTNESS FAILURE
    return 'auto'
  }
  // clash: a clean merge is a silent auto-resolve of a true conflict
  return 'silent'
}

// ---------- collect real fodder ----------
function collectFiles(limit) {
  const roots = ['node_modules']
  const files = []
  const skip = new Set(['.bin', '.cache'])
  const walk = (dir, depth) => {
    if (files.length >= limit || depth > 6) return
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (files.length >= limit) return
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p, depth + 1) }
      else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) {
        let src; try { src = fs.readFileSync(p, 'utf8') } catch { continue }
        if (src.length > 40000 || src.length < 120) continue
        if (src.split('\n').some((l) => l.length > 400)) continue    // skip minified
        const decls = topDecls(src); const lits = numLits(src)
        if (decls.length >= 2 && lits.length >= 3 && parses(src)) files.push({ p, src })
      }
    }
  }
  for (const r of roots) walk(r, 0)
  return files
}

// ---------- TEST A: concurrent edits on real files ----------
const files = collectFiles(700)
console.log(`TEST A — concurrent edits on ${files.length} real parseable files from node_modules\n`)

const tally = { git: {}, mergiraf: {}, icr: {} }
const bump = (eng, k) => { tally[eng][k] = (tally[eng][k] || 0) + 1 }
let disjoint = 0, adjacent = 0, clash = 0
const CAPS = { disjoint: 150, adjacent: 150, clash: 100 }
const falseConf = { git: 0, mergiraf: 0, icr: 0 }   // conflict on a case that SHOULD auto-merge
const safetyFail = { git: 0, mergiraf: 0, icr: 0 }  // broken or lost on should-auto case
const missedClash = { git: 0, mergiraf: 0, icr: 0 } // silent-resolved a true clash
const wins = []                                     // {kind, file, note}

function runCase(base, ours, theirs, want, kind, file) {
  const engs = { git: gitMerge(base, ours, theirs), mergiraf: mergirafMerge(base, ours, theirs), icr: icrMerge(base, ours, theirs) }
  const cls = {}
  for (const [name, res] of Object.entries(engs)) {
    const c = classify(res, { want })
    cls[name] = c
    bump(name, c)
    if (want === 'auto') {
      if (c === 'conflict') falseConf[name]++
      if (c === 'broken' || c === 'lost') safetyFail[name]++
    } else if (want === 'conflict') {
      if (c === 'silent' || c === 'broken' || c === 'lost') missedClash[name]++
    }
  }
  // record head-to-head deltas ICR vs mergiraf on should-auto cases
  if (want === 'auto') {
    if (cls.icr === 'auto' && cls.mergiraf !== 'auto') wins.push({ w: 'icr>mergiraf', kind, file, note: `mergiraf=${cls.mergiraf}` })
    if (cls.mergiraf === 'auto' && cls.icr !== 'auto') wins.push({ w: 'mergiraf>icr', kind, file, note: `icr=${cls.icr}` })
  }
  return cls
}

for (const f of files) {
  if (disjoint >= CAPS.disjoint && adjacent >= CAPS.adjacent && clash >= CAPS.clash) break
  const lits = numLits(f.src), decls = topDecls(f.src)
  if (lits.length < 2) continue

  // DISJOINT: two literals in different top-level decls
  if (disjoint < CAPS.disjoint) {
    let pair = null
    for (let i = 0; i < lits.length && !pair; i++) for (let j = i + 1; j < lits.length; j++) {
      const di = declOf(decls, lits[i].start), dj = declOf(decls, lits[j].start)
      if (di !== -1 && dj !== -1 && di !== dj) { pair = [lits[i], lits[j]]; break }
    }
    if (pair) {
      const ours = setLit(f.src, pair[0], A), theirs = setLit(f.src, pair[1], B)
      if (ours !== f.src && theirs !== f.src && ours !== theirs) { runCase(f.src, ours, theirs, 'auto', 'disjoint', f.p); disjoint++ }
    }
  }
  // ADJACENT: two literals in the SAME decl, same or neighbouring line (max stress for line-merge)
  if (adjacent < CAPS.adjacent) {
    let best = null, bestDist = 1e9
    for (let i = 0; i < lits.length; i++) for (let j = i + 1; j < lits.length; j++) {
      const di = declOf(decls, lits[i].start), dj = declOf(decls, lits[j].start)
      if (di === -1 || di !== dj) continue
      const dist = Math.abs(lits[i].line - lits[j].line)
      if (dist <= 2 && dist < bestDist && lits[i].start !== lits[j].start) { best = [lits[i], lits[j]]; bestDist = dist }
    }
    if (best) {
      const ours = setLit(f.src, best[0], A), theirs = setLit(f.src, best[1], B)
      if (ours !== f.src && theirs !== f.src && ours !== theirs) { runCase(f.src, ours, theirs, 'auto', 'adjacent', f.p); adjacent++ }
    }
  }
  // CLASH: both sides edit the SAME literal differently -> must conflict
  if (clash < CAPS.clash) {
    const lit = lits[0]
    const ours = setLit(f.src, lit, A), theirs = setLit(f.src, lit, B)
    if (ours !== theirs) { runCase(f.src, ours, theirs, 'conflict', 'clash', f.p); clash++ }
  }
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`cases: disjoint=${disjoint}  adjacent=${adjacent}  clash=${clash}  (total ${disjoint + adjacent + clash})\n`)
console.log(pad('engine', 10), pad('auto', 7), pad('conflict', 9), pad('broken', 8), pad('lost', 6), pad('silent', 8), pad('error', 6))
for (const eng of ['git', 'mergiraf', 'icr']) {
  const t = tally[eng]
  console.log(pad(eng, 10), pad(t.auto || 0, 7), pad(t.conflict || 0, 9), pad(t.broken || 0, 8), pad(t.lost || 0, 6), pad(t.silent || 0, 8), pad(t.error || 0, 6))
}
console.log('\nOn cases that SHOULD auto-merge (disjoint+adjacent):')
console.log('  false conflicts (dumped on a human):   ', ['git', 'mergiraf', 'icr'].map((e) => `${e}=${falseConf[e]}`).join('  '))
console.log('  SAFETY failures (broken or lost code): ', ['git', 'mergiraf', 'icr'].map((e) => `${e}=${safetyFail[e]}`).join('  '))
console.log('On true CLASH cases (should conflict):')
console.log('  silently mis-resolved (lost a side):   ', ['git', 'mergiraf', 'icr'].map((e) => `${e}=${missedClash[e]}`).join('  '))
const iw = wins.filter((w) => w.w === 'icr>mergiraf'), mw = wins.filter((w) => w.w === 'mergiraf>icr')
console.log(`\nHead-to-head on should-auto cases:  ICR auto where mergiraf didn't = ${iw.length}   |   mergiraf auto where ICR didn't = ${mw.length}`)
iw.slice(0, 6).forEach((w) => console.log(`  ICR>mgf [${w.kind}] ${w.note}  ${path.basename(w.file)}`))
mw.slice(0, 6).forEach((w) => console.log(`  mgf>ICR [${w.kind}] ${w.note}  ${path.basename(w.file)}`))

// ---------- TEST B: rename + new caller (the intent axis) ----------
console.log('\n\nTEST B — rename a function on one side, other side adds a NEW call to the old name')
const renScenarios = [
  {
    name: 'free function',
    base: `function helper(x) { return x * 2 }\nfunction main() { return helper(21) }\nexport { main }\n`,
    ours: `function compute(x) { return x * 2 }\nfunction main() { return compute(21) }\nexport { main }\n`,
    theirs: `function helper(x) { return x * 2 }\nfunction main() { return helper(21) }\nfunction extra() { return helper(100) }\nexport { main, extra }\n`,
    old: 'helper', neo: 'compute',
  },
  {
    name: 'const arrow',
    base: `const load = (u) => fetch(u)\nasync function run() { return load('/a') }\nexport { run }\n`,
    ours: `const fetchData = (u) => fetch(u)\nasync function run() { return fetchData('/a') }\nexport { run }\n`,
    theirs: `const load = (u) => fetch(u)\nasync function run() { return load('/a') }\nasync function run2() { return load('/b') }\nexport { run, run2 }\n`,
    old: 'load', neo: 'fetchData',
  },
  {
    name: 'exported fn',
    base: `export function parse(s) { return JSON.parse(s) }\nfunction wrap(s) { return parse(s) }\n`,
    ours: `export function parseJson(s) { return JSON.parse(s) }\nfunction wrap(s) { return parseJson(s) }\n`,
    theirs: `export function parse(s) { return JSON.parse(s) }\nfunction wrap(s) { return parse(s) }\nfunction wrap2(s) { return parse(s + '!') }\n`,
    old: 'parse', neo: 'parseJson',
  },
]
// A call to the bare name — but NOT a member call like `JSON.parse(` (the leading dot means
// it's a different binding, e.g. the built-in, which must NOT be counted as a dangling ref).
const rx = (name) => new RegExp('(?<![\\w.])' + name + '\\s*\\(')
function reportRename(s) {
  const engs = { git: gitMerge(s.base, s.ours, s.theirs), mergiraf: mergirafMerge(s.base, s.ours, s.theirs), icr: icrMerge(s.base, s.ours, s.theirs) }
  console.log(`\n  scenario: ${s.name}  (rename ${s.old} -> ${s.neo}; other side adds a new ${s.old}() caller)`)
  for (const [name, r] of Object.entries(engs)) {
    let verdict
    if (r.err) verdict = 'ERROR'
    else if (!r.clean) verdict = 'CONFLICT (safe, manual)'
    else if (!parses(r.text)) verdict = 'BROKEN (unparseable, shipped clean)'
    else {
      const definesNeo = r.text.includes(s.neo)
      const stillCallsOld = rx(s.old).test(r.text)
      if (definesNeo && stillCallsOld) verdict = 'DANGLING (defines ' + s.neo + ' but still calls ' + s.old + '()) — broken, shipped clean'
      else if (definesNeo && !stillCallsOld) verdict = 'CORRECT (rename fully applied, incl. new caller)'
      else verdict = 'clean (other)'
    }
    const extra = name === 'icr' && r.renames && r.renames.length ? `  renames=${JSON.stringify(r.renames)}` : ''
    console.log(`    ${pad(name, 9)} ${verdict}${extra}`)
  }
}
renScenarios.forEach(reportRename)

// ---------- TEST C: delete a declaration the other side still calls ----------
console.log('\n\nTEST C — one side deletes a function the other side still calls (dangling-reference)')
const delScenarios = [
  {
    name: 'delete used helper',
    base: `function helper(x){ return x+1 }\nfunction main(){ return helper(5) }\nexport { main }\n`,
    ours: `function main(){ return helper(5) }\nexport { main }\n`,                                   // deleted helper
    theirs: `function helper(x){ return x+1 }\nfunction main(){ return helper(5) }\nfunction other(){ return helper(9) }\nexport { main, other }\n`, // added another caller
    gone: 'helper',
  },
]
function reportDelete(s) {
  const engs = { git: gitMerge(s.base, s.ours, s.theirs), mergiraf: mergirafMerge(s.base, s.ours, s.theirs), icr: icrMerge(s.base, s.ours, s.theirs) }
  console.log(`\n  scenario: ${s.name}  (ours deletes ${s.gone}; theirs adds a new ${s.gone}() caller)`)
  for (const [name, r] of Object.entries(engs)) {
    let verdict
    if (r.err) verdict = 'ERROR'
    else if (!r.clean) verdict = 'CONFLICT / flagged'
    else {
      const defines = new RegExp('function\\s+' + s.gone + '\\b').test(r.text) || new RegExp('\\b' + s.gone + '\\s*=').test(r.text)
      const calls = rx(s.gone).test(r.text)
      if (!defines && calls) verdict = 'DANGLING (calls ' + s.gone + '() with no definition) — broken, shipped clean'
      else verdict = 'clean (kept a definition)'
    }
    const w = name === 'icr' && r.warning ? `  warning="${r.warning}"` : ''
    console.log(`    ${pad(name, 9)} ${verdict}${w}`)
  }
}
delScenarios.forEach(reportDelete)
console.log('\ndone.')
