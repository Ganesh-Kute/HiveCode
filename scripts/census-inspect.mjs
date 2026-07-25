// Inspect ONE census finding by hand: replay the merge for a file and show
// exactly what both sides did to the same unit and what git silently shipped.
//   node census-inspect.mjs <repoPath> <mergeSha> <file>
import fs from 'fs'; import path from 'path'
import { execFileSync } from 'child_process'
import { merge3 } from './packages/icr-merge/merge3.js'
import { structuralMerge } from './packages/icr-merge/icr.js'

const [REPO, SHA, FILE] = process.argv.slice(2)
const git = (...args) => execFileSync('git', args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString()
const parents = git('rev-list', '--parents', '-n', '1', SHA).trim().split(' ').slice(1)
const [p1, p2] = parents
const base = git('merge-base', p1, p2).trim()
const b = git('show', `${base}:${FILE}`), o = git('show', `${p1}:${FILE}`), t = git('show', `${p2}:${FILE}`)
const shipped = git('show', `${SHA}:${FILE}`)

const r = structuralMerge(b, o, t, { filename: FILE })
console.log('semantic verdict:', r.status, JSON.stringify(r.conflicts), r.reason || '')
const lm = merge3(b, o, t)
console.log('line merge      : conflict =', lm.conflict)

// show a unified view of the region both sides touched
const lines = (s) => s.split('\n')
const lb = lines(b), lo = lines(o), lt = lines(t), ls = lines(shipped)
// first differing line between base and each side
const firstDiff = (x, y) => { let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return i }
const iO = firstDiff(lb, lo), iT = firstDiff(lb, lt)
const start = Math.max(0, Math.min(iO, iT) - 3)
const end = Math.min(lb.length, Math.max(iO, iT) + 8)
const slice = (arr, tag) => console.log(`--- ${tag} [lines ${start + 1}-${end}] ---\n` + arr.slice(start, end).map((l, i) => String(start + i + 1).padStart(4) + ' ' + l).join('\n') + '\n')
slice(lb, 'BASE')
slice(lo, 'SIDE 1 (ours)')
slice(lt, 'SIDE 2 (theirs)')
slice(ls, 'WHAT GIT SHIPPED (the merge commit)')
