// A REAL DIFF3, IN ALL THREE COPIES (27 Sep 2026).
//
// merge3 -- the line floor under every merge in Hivecode (reconcile.cjs, via core.js), under
// icr-merge's structural tier (packages/icr-merge/merge3.js) and in the VS Code extension -- was
// "git-style" in its comments only. It took ONE changed range per side, from the first differing
// line to the last, so two small edits 500 lines apart were one 500-line edit to it, and the other
// side touching anything in between made the whole span a single conflict. Measured on a real
// cherry-pick of sync.js: one conflict block of 2,140 lines where git's diff3 gives one of 5.
// Every agent that then has to resolve that conflict pays to read all of it.
//
// What is pinned here:
//   A. that shape: far-apart edits merge, and only the real overlap conflicts
//   B. the classic diff3 cases, including the conservative ones (touching edits, and an edit whose
//      position inside a run of identical lines is an accident of the diff)
//   C. against `git merge-file` as the oracle: identical whenever both merge cleanly, and never
//      clean where git refuses
//   D. the three copies are one block of code, so the next fix cannot land in only one of them
//
//   node tests/diff3-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const R = createRequire(import.meta.url)(path.join(ROOT, 'reconcile.cjs'))
const PKG = await import(pathToFileURL(path.join(ROOT, 'packages', 'icr-merge', 'merge3.js')).href)
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const blocks = (text) => {
  const out = []
  let open = -1
  text.split('\n').forEach((l, i) => {
    if (l.startsWith('<<<<<<< ')) open = i
    if (l.startsWith('>>>>>>> ') && open >= 0) { out.push(i - open + 1); open = -1 }
  })
  return out
}
// The one-range merge this replaced, kept here only to measure against.
function oldMerge3(base, mine, theirs) {
  const b = base.split('\n')
  const mr = R.changedRange(b, mine.split('\n')), tr = R.changedRange(b, theirs.split('\n'))
  if (mr.endBase <= tr.startBase || tr.endBase <= mr.startBase) return { conflict: false, lines: 0 }
  return { conflict: true, lines: Math.max(mr.endBase, tr.endBase) - Math.min(mr.startBase, tr.startBase) }
}

console.log('\n=== A REAL DIFF3 ===')

console.log('\n# A. far-apart edits merge; only the real overlap conflicts')
{
  const base = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
  const mine = base.slice(), theirs = base.slice()
  mine[100] = 'mine 100'; mine[2500] = 'mine 2500'; mine.splice(2800, 0, 'mine inserted')
  theirs[50] = 'theirs 50'; theirs[1200] = 'theirs 1200'; theirs[1800] = 'theirs 1800'; theirs[2500] = 'theirs 2500'; theirs[2900] = 'theirs 2900'
  const [B, M, TH] = [base, mine, theirs].map((a) => a.join('\n') + '\n')
  const t0 = Date.now()
  const r = R.merge3(B, M, TH)
  const ms = Date.now() - t0
  const bl = blocks(r.text)
  T('one conflict, for the one line both sides changed', r.conflict && bl.length === 1 && bl[0] === 5, `blocks=${JSON.stringify(bl)}`)
  T('every other edit from both sides landed', ['mine 100', 'mine inserted', 'theirs 50', 'theirs 1200', 'theirs 1800', 'theirs 2900'].every((l) => r.text.includes(l + '\n')))
  const old = oldMerge3(B, M, TH)
  T('the one-range merge made it a conflict of the whole span', old.conflict && old.lines > 2800, `${old.lines} lines`)
  T('a 3,000-line merge stays cheap', ms < 500, `${ms} ms`)
}

console.log('\n# B. the classic cases')
{
  const m = (b, x, y) => R.merge3(b, x, y)
  let r = m('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n')
  T('disjoint edits both apply', !r.conflict && r.text === 'A\nb\nc\nd\nE\n')
  r = m('a\nb\nc\n', 'a\nB\nc\n', 'a\nB\nc\n')
  T('the same edit on both sides lands once', !r.conflict && r.text === 'a\nB\nc\n')
  r = m('a\nb\nc\n', 'a\nMINE\nc\n', 'a\nTHEIRS\nc\n')
  T('the same line changed two ways conflicts on that line only', r.conflict && r.text === 'a\n<<<<<<< local (yours)\nMINE\n=======\nTHEIRS\n>>>>>>> incoming (theirs)\nc\n')
  r = m('a\nb\n', 'a\nx\nb\n', 'a\ny\nb\n')
  T('two different insertions at one point conflict (their order is unknowable)', r.conflict)
  r = m('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nC\nd\n')
  T('touching edits conflict, as in git', r.conflict)
  r = m('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n')
  T('deleting a line the other side edited conflicts', r.conflict)
  r = m('x\n}\n}\n}\ny\n', 'x\n}\n}\n}\nnew\ny\n', 'x\n}\ny\n')
  T('an edit whose place in a run of identical lines is ambiguous conflicts, not guesses', r.conflict)
  r = m('a\nb\n', 'a\nb\nc\n', 'z\na\nb\n')
  T('edits at both ends, trailing newline kept', !r.conflict && r.text === 'z\na\nb\nc\n')
  r = m('p\nq\n', 'p\nq\n', 'p\nq\nr\n')
  T('one side unchanged takes the other', !r.conflict && r.text === 'p\nq\nr\n')
}

console.log('\n# C. against git merge-file')
let corpus = []
{
  let git = true
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { git = false }
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  // A small vocabulary on purpose: repeated lines are where diff alignment is ambiguous.
  const VOCAB = ['a', 'b', 'c', 'd', 'e', '}', '{', 'return x', '', 'x = 1', 'if (x) {', 'end']
  const edit = (lines) => {
    const out = lines.slice()
    for (let e = 0, k = 1 + Math.floor(rnd() * 4); e < k; e++) {
      const at = Math.floor(rnd() * (out.length + 1)), op = rnd()
      if (op < 0.4 && out.length) out[Math.min(at, out.length - 1)] = pick(VOCAB) + ' ' + Math.floor(rnd() * 99)
      else if (op < 0.7) out.splice(at, 0, 'new ' + Math.floor(rnd() * 999))
      else if (out.length > 1) out.splice(Math.min(at, out.length - 1), 1 + Math.floor(rnd() * 2))
    }
    return out
  }
  for (let c = 0; c < 400; c++) {
    const base = Array.from({ length: 10 + Math.floor(rnd() * 40) }, () => pick(VOCAB))
    corpus.push([base, edit(base), edit(base)].map((a) => a.join('\n') + '\n'))
  }
  if (!git) {
    console.log('  (git not found: oracle comparison skipped)')
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-diff3-'))
    const f = (n) => path.join(tmp, n)
    let bothClean = 0, same = 0, weMergedGitRefused = 0, gitMergedWeRefused = 0, oldConflictWhereGitClean = 0, gitClean = 0
    for (const [B, M, TH] of corpus) {
      fs.writeFileSync(f('b'), B); fs.writeFileSync(f('m'), M); fs.writeFileSync(f('t'), TH)
      let gitText, gitConflict = false
      try { gitText = execFileSync('git', ['merge-file', '-p', f('m'), f('b'), f('t')]).toString() }
      catch (e) { gitText = String(e.stdout); gitConflict = true }
      const r = R.merge3(B, M, TH)
      if (!gitConflict) { gitClean++; if (oldMerge3(B, M, TH).conflict) oldConflictWhereGitClean++ }
      if (!r.conflict && !gitConflict) { bothClean++; if (r.text === gitText) same++ }
      else if (!r.conflict && gitConflict) weMergedGitRefused++
      else if (r.conflict && !gitConflict) gitMergedWeRefused++
    }
    fs.rmSync(tmp, { recursive: true, force: true })
    T('identical to git whenever both merge cleanly', bothClean > 150 && same === bothClean, `${same}/${bothClean}`)
    T('never merges what git refuses to', weMergedGitRefused === 0, `${weMergedGitRefused} of ${corpus.length}`)
    T('rarely refuses what git merges (only the ambiguous runs)', gitMergedWeRefused <= corpus.length * 0.03, `${gitMergedWeRefused} of ${corpus.length}`)
    console.log(`  (the one-range merge conflicted on ${oldConflictWhereGitClean} of the ${gitClean} cases git merges cleanly)`)
  }
}

console.log('\n# D. the three copies are one')
{
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
  const blockOf = (src) => {
    const a = src.indexOf('// ── A REAL DIFF3')
    const d = src.indexOf('function diff3Lines(', a)
    if (a < 0 || d < 0) return null
    let i = src.indexOf('{', d), depth = 0
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break }
    return src.slice(a, i + 1).split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
  }
  const rec = blockOf(read('reconcile.cjs')), pkg = blockOf(read('packages/icr-merge/merge3.js')), ext = blockOf(read('extension/extension.js'))
  T('icr-merge carries the same diff3 as the engine', !!rec && pkg === rec)
  T('the extension carries the same diff3 as the engine', !!rec && ext === rec)
  let agree = 0
  for (const [B, M, TH] of corpus) { const a = R.merge3(B, M, TH), b = PKG.merge3(B, M, TH); if (a.text === b.text && a.conflict === b.conflict) agree++ }
  T("icr-merge's merge3 gives the engine's answer on every case", agree === corpus.length, `${agree}/${corpus.length}`)
}

console.log(`\n=== A REAL DIFF3: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
