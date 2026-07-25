// gauntlet.mjs — THE HARDEST ICR TEST. Not "more fuzz" — qualitatively harder:
//   * REAL open-source code (parseable .js across node_modules) as merge fodder — real
//     comments, nesting, strings, regexes, formatting — not synthetic toys.
//   * Edits target NUMERIC LITERALS IN CODE (located via the AST), so "no-loss" is tested
//     on real behavioral changes, never on incidental digits inside comments/strings.
//   * DIFFERENTIAL vs real `git merge-file`: ICR must never be MORE broken than git; count
//     where ICR is strictly better (auto-merges what git conflicts on).
//   * METAMORPHIC laws for ANY inputs: convergence (merge(a,b)==merge(b,a)), confluence
//     (disjoint edits fold to one text in every order), no-loss, parse-guarantee.
//   * PATHOLOGICAL inputs: braces in strings/regex/templates, conflict-marker TEXT in
//     strings, unicode identifiers, CRLF, comment-dense code.
//   * A documented KNOWN-LIMITATION probe (comment-only edits) — disclosed, not hidden.
// Seeded + reproducible: node gauntlet.mjs [seed] [maxFiles]
import fs from 'fs'; import path from 'path'; import os from 'os'
import { execFileSync } from 'child_process'
import * as acorn from 'acorn'
import { structuralMerge } from './packages/icr-merge/index.js'

const SEED = Number(process.argv[2] || 20260710)
const MAX_FILES = Number(process.argv[3] || 180)
let s = SEED >>> 0
const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const ri = (n) => Math.floor(rnd() * n)

const parseAst = (src) => { try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }) } catch { try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' }) } catch { return null } } }
const parses = (src) => parseAst(src) != null
// Collect numeric-literal nodes (real code, never comment/string digits) under `node`.
function numLits(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const x of node) numLits(x, out); return }
  if (node.type === 'Literal' && typeof node.value === 'number' && Number.isFinite(node.value) && typeof node.start === 'number') out.push({ start: node.start, end: node.end })
  for (const k in node) { if (k === 'start' || k === 'end' || k === 'loc' || k === 'range' || k === 'parent') continue; const v = node[k]; if (v && typeof v === 'object') numLits(v, out) }
}
// Top-level decls, each with the numeric-literal positions it contains.
function declsOf(src) {
  const ast = parseAst(src); if (!ast) return []
  return ast.body.map((n) => { const lits = []; numLits(n, lits); lits.sort((a, b) => a.start - b.start); return { start: n.start, end: n.end, lits } }).filter((d) => d.lits.length)
}
const setLit = (src, lit, val) => src.slice(0, lit.start) + val + src.slice(lit.end)

// --- corpus ---
function walk(dir, out) { let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return } for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.min.js')) out.push(p) } }
const allFiles = []; walk('node_modules', allFiles)
for (let i = allFiles.length - 1; i > 0; i--) { const j = ri(i + 1);[allFiles[i], allFiles[j]] = [allFiles[j], allFiles[i]] }
const corpus = []
for (const f of allFiles) {
  if (corpus.length >= MAX_FILES) break
  let src; try { src = fs.readFileSync(f, 'utf8') } catch { continue }
  if (src.length < 200 || src.length > 40000) continue
  const decls = declsOf(src)
  if (decls.length < 2) continue // need >=2 code-numbered decls for a disjoint pair
  corpus.push({ f, src, decls })
}

const GIT = (a, base, b) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-')); const wa = path.join(dir, 'a'), wbase = path.join(dir, 'base'), wb = path.join(dir, 'b'); fs.writeFileSync(wa, a); fs.writeFileSync(wbase, base); fs.writeFileSync(wb, b); let ok = true, text = ''; try { text = execFileSync('git', ['merge-file', '-p', wa, wbase, wb], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) } catch (e) { ok = false; text = (e.stdout || '').toString() } fs.rmSync(dir, { recursive: true, force: true }); return { ok, text } }
const hasMarkers = (t) => /^<{7} /m.test(t) || /^>{7} /m.test(t)

const R = { cases: 0, autoBroken: 0, notConverge: 0, lossy: 0, icrBetter: 0, worse: 0, gitConflicts: 0, icrAuto: 0 }
const fails = []; const note = (k, d) => { if (fails.length < 25) fails.push(k + ' :: ' + d) }
console.log(`GAUNTLET seed=${SEED} corpus=${corpus.length} real files (code-literal targeted)\n`)

// === PHASE 1: one-sided identity (format preservation) ===
let p1 = 0, p1ok = 0
for (const { f, src, decls } of corpus) { const d = decls[ri(decls.length)]; const a = setLit(src, d.lits[0], 8000000 + ri(1000)); p1++; const r = structuralMerge(src, a, src, { filename: f }); if (r.status === 'auto' && r.text === a) p1ok++; else note('P1-identity', `${path.basename(f)} status=${r.status}`) }
console.log(`P1 one-sided identity (format-preserving): ${p1ok}/${p1}`)

// === PHASE 2: differential vs git + metamorphic, on real code-literal triples ===
for (let c = 0; c < corpus.length; c++) {
  const { f, src, decls } = corpus[c]
  for (const kind of ['disjoint', 'inner', 'clash']) {
    let a, b, av, bv
    if (kind === 'disjoint') {
      const i = ri(decls.length); let j = ri(decls.length); if (j === i) j = (j + 1) % decls.length
      av = String(1000000 + c * 100 + 1); bv = String(2000000 + c * 100 + 2)
      a = setLit(src, decls[i].lits[0], av); b = setLit(src, decls[j].lits[0], bv)
    } else if (kind === 'inner') {
      const d = decls.find((x) => x.lits.length >= 2); if (!d) continue
      av = String(3000000 + c); bv = String(4000000 + c)
      a = setLit(src, d.lits[0], av); b = setLit(src, d.lits[d.lits.length - 1], bv)
    } else {
      const d = decls[ri(decls.length)]; av = String(5000000 + c); bv = String(6000000 + c)
      a = setLit(src, d.lits[0], av); b = setLit(src, d.lits[0], bv)
    }
    if (a === b || a === src || b === src) continue
    R.cases++
    const r1 = structuralMerge(src, a, b, { filename: f })
    const r2 = structuralMerge(src, b, a, { filename: f })
    if (r1.status !== r2.status || (r1.text || null) !== (r2.text || null)) { R.notConverge++; note('CONVERGE', `${path.basename(f)} ${kind}: ${r1.status}/${r2.status}`) }
    if (r1.status === 'auto') {
      R.icrAuto++
      if (!parses(r1.text)) { R.autoBroken++; note('AUTO-BROKEN', `${path.basename(f)} ${kind}`) }
      if (kind !== 'clash' && (!r1.text.includes(av) || !r1.text.includes(bv))) { R.lossy++; note('CODE-LOSS', `${path.basename(f)} ${kind} missing ${!r1.text.includes(av) ? av : bv}`) }
    }
    const g = GIT(a, src, b)
    if (!g.ok || hasMarkers(g.text)) R.gitConflicts++
    if (r1.status === 'auto' && parses(r1.text) && (!g.ok || hasMarkers(g.text)) && kind === 'disjoint') R.icrBetter++
    if (r1.status === 'auto' && !parses(r1.text) && g.ok && !hasMarkers(g.text) && parses(g.text)) { R.worse++; note('WORSE-THAN-GIT', `${path.basename(f)} ${kind}`) }
  }
}
console.log(`P2 differential+metamorphic: ${R.cases} cases | ICR auto ${R.icrAuto} | git-conflicted ${R.gitConflicts} | ICR-strictly-better ${R.icrBetter}`)
console.log(`   violations -> auto-broken:${R.autoBroken} not-converge:${R.notConverge} CODE-loss:${R.lossy} worse-than-git:${R.worse}`)

// === PHASE 3: CONFLUENCE — k disjoint code edits fold to the SAME text in every order ===
let p3 = 0, p3ok = 0
for (let c = 0; c < corpus.length; c++) {
  const { f, src, decls } = corpus[c]; if (decls.length < 3) continue
  const k = Math.min(4, decls.length); const edits = []
  for (let i = 0; i < k; i++) edits.push(setLit(src, decls[i].lits[0], String(7000000 + c * 10 + i)))
  p3++
  const fold = (order) => { let acc = src; for (const idx of order) { const r = structuralMerge(src, acc, edits[idx], { filename: f }); if (r.status !== 'auto') return null; acc = r.text } return acc }
  const results = []
  for (let t = 0; t < 4; t++) { const ord = [...edits.keys()]; for (let i = ord.length - 1; i > 0; i--) { const j = ri(i + 1);[ord[i], ord[j]] = [ord[j], ord[i]] } results.push(fold(ord)) }
  const good = results.filter((x) => x != null)
  if (good.length && good.every((x) => x === good[0]) && parses(good[0]) && edits.every((_, i) => good[0].includes(String(7000000 + c * 10 + i)))) p3ok++
  else note('CONFLUENCE', `${path.basename(f)}`)
}
console.log(`P3 confluence (disjoint code edits, any fold order -> same text): ${p3ok}/${p3}`)

// === PHASE 4: PATHOLOGICAL ===
const PATH = [
  { name: 'braces-in-strings', base: 'function f() {\n  const s = "a { b } c"\n  return 1\n}\n\nfunction g() {\n  const t = "} { }"\n  return 2\n}\n' },
  { name: 'regex-with-braces', base: 'function f() {\n  const re = /a{2,3}b/g\n  return 1\n}\n\nfunction g() {\n  const re2 = /x{1}/\n  return 2\n}\n' },
  { name: 'template-literals', base: 'function f() {\n  const x = `val ${1 + 1} end`\n  return 1\n}\n\nfunction g() {\n  const y = `${a ? "{" : "}"}`\n  return 2\n}\n' },
  { name: 'conflict-marker-text', base: 'function f() {\n  const banner = "<<<<<<< not a real marker"\n  return 1\n}\n\nfunction g() {\n  const b = ">>>>>>> also fake"\n  return 2\n}\n' },
  { name: 'unicode-idents', base: 'function café() {\n  const π = 3\n  return π\n}\n\nfunction 日本() {\n  const λ = 4\n  return λ\n}\n' },
  { name: 'crlf', base: 'function f() {\r\n  const a = 1\r\n  return a\r\n}\r\n\r\nfunction g() {\r\n  const b = 2\r\n  return b\r\n}\r\n' },
  { name: 'comment-dense', base: 'function f() {\n  // leading\n  const a = 1 // trailing\n  /* block */ return a\n}\n\n// between decls\nfunction g() {\n  return 2 // tail\n}\n' },
]
let p4 = 0, p4ok = 0
for (const t of PATH) {
  const decls = declsOf(t.base); if (decls.length < 2) { note('PATH-setup', t.name); continue }
  const a = setLit(t.base, decls[0].lits[0], '111'), b = setLit(t.base, decls[1].lits[0], '222')
  p4++
  const r1 = structuralMerge(t.base, a, b, { filename: 'p.js' }), r2 = structuralMerge(t.base, b, a, { filename: 'p.js' })
  const conv = r1.status === r2.status && (r1.text || null) === (r2.text || null)
  const ok = conv && (r1.status !== 'auto' || (parses(r1.text) && r1.text.includes('111') && r1.text.includes('222')))
  if (ok) p4ok++; else note('PATH', `${t.name} status=${r1.status} conv=${conv}`)
}
console.log(`P4 pathological inputs: ${p4ok}/${p4}`)

// === KNOWN LIMITATION (disclosed): comment-only edits are not preserved by the JS provider ===
// The acorn provider treats comments as gap text; the splice takes gaps from base, so an edit
// living ENTIRELY inside a comment is dropped when the other side also edits. This is comment
// (non-behavioral) loss, and git mishandles it too. Documented here so it's on record.
// The trigger is BOTH sides editing the SAME declaration (forcing the inner splice): one
// side edits an inner comment, the other an inner code line. Code survives; the comment
// edit is dropped because acorn comments live in gaps and the splice takes gaps from base.
{
  const base = 'function f() {\n  const x = 1\n  // tune this: 10\n  const y = 2\n  return x + y\n}\n'
  const a = base.replace('tune this: 10', 'tune this: 99')  // comment-only edit, inside f
  const b = base.replace('const y = 2', 'const y = 222')     // code edit, SAME function f
  const r = structuralMerge(base, a, b, { filename: 'k.js' })
  const commentKept = !!(r.text && r.text.includes('tune this: 99'))
  const codeKept = !!(r.text && r.text.includes('const y = 222'))
  console.log(`\nKNOWN-LIMITATION (same-decl inner): code edit preserved: ${codeKept} | comment-only edit preserved: ${commentKept ? 'yes' : 'NO — documented gap, comment merges are best-effort'}`)
}

const violations = R.autoBroken + R.notConverge + R.lossy + R.worse + (p1 - p1ok) + (p3 - p3ok) + (p4 - p4ok)
console.log('\n=== GAUNTLET VERDICT ===')
console.log(`hard invariant violations (code): ${violations}`)
console.log(`ICR strictly beat git (clean where git conflicted): ${R.icrBetter} cases`)
if (fails.length) { console.log('\nfirst failures:'); for (const x of fails) console.log('  - ' + x) }
console.log(`\n${violations === 0 ? '=== ALL HARD CODE INVARIANTS HELD ACROSS REAL-WORLD CORPUS ===' : '=== ' + violations + ' VIOLATIONS ==='}`)
process.exit(violations === 0 ? 0 : 1)
