// THE SILENT MERGE CENSUS — replay a repo's merge history and find the merges
// that line-merged "cleanly" (git raised NO conflict) yet shipped a semantic
// break a structural merge would have caught. Every finding is verifiable:
// base/ours/theirs come from git itself; anyone can re-run the replay.
//
//   node merge-census.mjs <repoPath> [maxMerges]
//
// Method, per merge commit M (parents P1 P2, base = merge-base P1 P2):
//   1. files changed on BOTH sides (same file, concurrent edits) with a
//      supported extension
//   2. line-merge3(base, ours, theirs):
//        conflict?  -> git flagged it, a human looked -> NOT silent, skip
//        clean?     -> this is exactly what git shipped without asking anyone
//   3. ICR structural/semantic judge on the same triple:
//        semantic-conflict (e.g. deleted decl still referenced) -> FINDING
//   4. confirm against `git show M:file` (did the shipped bytes contain the
//      break the same way our replayed line merge does?)
// Output: console report + census-findings.json (machine-readable receipts).
import fs from 'fs'; import path from 'path'
import { execFileSync } from 'child_process'
import { merge3 } from './packages/icr-merge/merge3.js'
import { structuralMerge, supports, languageFor } from './packages/icr-merge/icr.js'

// Dangling-reference judge run on a TEXT (not on ICR's own merge): names declared
// in `base` that are gone from `text` yet still free-referenced in `text`.
// This judges what git actually SHIPPED — the earlier version judged ICR's own
// structural merge and indicted itself (express 318fd4b543 false positive).
function danglingIn(lang, baseText, text) {
  try {
    if (!lang || !lang.referencedFreeNames || !lang.declaredNames) return []
    if (!lang.parses(text)) return []
    const baseNames = lang.declaredNames(baseText)
    const nowNames = lang.declaredNames(text)
    const refs = lang.referencedFreeNames(text)
    return [...baseNames].filter((n) => !nowNames.has(n) && refs.has(n))
  } catch { return [] }
}

const REPO = process.argv[2]
const MAX_MERGES = Number(process.argv[3] || 400)
if (!REPO || !fs.existsSync(path.join(REPO, '.git'))) { console.error('usage: node merge-census.mjs <repoPath> [maxMerges]'); process.exit(2) }

const git = (...args) => execFileSync('git', args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString()
const tryGit = (...args) => { try { return git(...args) } catch { return null } }
const show = (rev, file) => tryGit('show', `${rev}:${file}`)

const repoName = path.basename(path.resolve(REPO))
console.log(`SILENT MERGE CENSUS — ${repoName}`)

const merges = git('rev-list', '--merges', '--first-parent', `--max-count=${MAX_MERGES}`, 'HEAD').trim().split('\n').filter(Boolean)
console.log(`replaying ${merges.length} merge commits...\n`)

let replayed = 0, cleanLineMerges = 0, textualConflicts = 0, findings = []
let filesChecked = 0, weakOnly = 0

for (const m of merges) {
  const parents = git('rev-list', '--parents', '-n', '1', m).trim().split(' ').slice(1)
  if (parents.length !== 2) continue
  const [p1, p2] = parents
  const base = (tryGit('merge-base', p1, p2) || '').trim()
  if (!base) continue

  // files changed on BOTH sides — the only ones where a merge decision existed
  const side1 = new Set((tryGit('diff', '--name-only', `${base}..${p1}`) || '').split('\n'))
  const side2 = (tryGit('diff', '--name-only', `${base}..${p2}`) || '').split('\n')
  const both = side2.filter((f) => f && side1.has(f) && supports(f))
  if (!both.length) continue
  replayed++

  for (const file of both) {
    const b = show(base, file), o = show(p1, file), t = show(p2, file)
    if (b == null || o == null || t == null) continue // add/delete/rename cases — v0 skips
    if (b === o || b === t || o === t) continue       // one-sided in content — no real merge decision
    filesChecked++
    const lm = merge3(b, o, t)
    if (lm.conflict) { textualConflicts++; continue } // git flagged it -> a human saw it -> not silent
    cleanLineMerges++
    const date = (tryGit('show', '-s', '--format=%cs', m) || '').trim()

    // BREAK class — judged on what git ACTUALLY SHIPPED, and only when the
    // damage is MERGE-CREATED (each side is clean alone; only the combination
    // dangles). Judged on the SHIPPED bytes when available, else the replay.
    const lang = languageFor(file)
    const shipped = show(m, file)
    const judgedText = shipped != null ? shipped : lm.text
    const dangShipped = danglingIn(lang, b, judgedText)
    if (dangShipped.length) {
      const dangO = new Set(danglingIn(lang, b, o))
      const dangT = new Set(danglingIn(lang, b, t))
      const created = dangShipped.filter((n) => !dangO.has(n) && !dangT.has(n))
      if (created.length) {
        findings.push({
          repo: repoName, merge: m.slice(0, 12), date, file, grade: 'BREAK',
          dangling: created,
          shippedMatchesReplay: shipped != null && shipped.replace(/\s+/g, '') === lm.text.replace(/\s+/g, ''),
        })
        console.log(`  BREAK   ${m.slice(0, 10)} (${date}) ${file}`)
        console.log(`     shipped text references ${JSON.stringify(created)} — declared in base, gone after merge, clean on EACH SIDE ALONE`)
        continue
      }
    }

    // FUSION class (secondary) — both sides changed the same NAMED declaration
    // and git fused it silently. Structural judge, name-keyed conflicts only.
    let r = null
    try { r = structuralMerge(b, o, t, { filename: file }) } catch { continue }
    if (r && r.status === 'semantic-conflict') {
      const strong = r.conflicts.filter((c) => /^(fn|class|def|var|assign|method):/.test(c))
      if (!strong.length) { weakOnly++; continue }
      findings.push({ repo: repoName, merge: m.slice(0, 12), date, file, grade: 'SAME-DECL FUSION', conflicts: strong })
      console.log(`  FUSION  ${m.slice(0, 10)} (${date}) ${file}  ${JSON.stringify(strong)}`)
    }
  }
}

console.log(`\n=== CENSUS: ${repoName} ===`)
console.log(`merge commits replayed          : ${replayed} (of ${merges.length} scanned)`)
console.log(`files with real merge decisions : ${filesChecked}`)
console.log(`  -> textual conflicts (git flagged, human saw): ${textualConflicts}`)
console.log(`  -> clean line merges (shipped silently)      : ${cleanLineMerges}`)
console.log(`  -> evidence-grade findings (name-keyed)      : ${findings.length}  [BREAK: ${findings.filter((f) => f.grade === 'BREAK').length}, SAME-DECL FUSION: ${findings.filter((f) => f.grade !== 'BREAK').length}]`)
console.log(`  -> quarantined (index-keyed stmt:N, unreliable until keying fix): ${weakOnly}`)
if (cleanLineMerges) console.log(`evidence-grade rate among clean merges: ${(findings.length / cleanLineMerges * 100).toFixed(2)}%`)

const outFile = `census-${repoName}.json`
fs.writeFileSync(outFile, JSON.stringify({ repo: repoName, scannedMerges: merges.length, replayed, filesChecked, textualConflicts, cleanLineMerges, findings }, null, 2))
console.log(`receipts -> ${outFile}`)
