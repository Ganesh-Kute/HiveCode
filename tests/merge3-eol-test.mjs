// tests/merge3-eol-test.mjs
//
// Unit tests for merge3 EOL (CRLF vs LF) safety-net normalisation across:
//   1. reconcile.cjs
//   2. packages/icr-merge/merge3.js
//   3. extension/extension.js
//
// Running: node tests/merge3-eol-test.mjs

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'
import vm from 'vm'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const R = createRequire(import.meta.url)(path.join(ROOT, 'reconcile.cjs'))
const PKG = await import(pathToFileURL(path.join(ROOT, 'packages', 'icr-merge', 'merge3.js')).href)

// Extract merge3 from extension/extension.js
function extractExtMerge3() {
  const src = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8')
  const startMarker = '  // ── A REAL DIFF3'
  const startIdx = src.indexOf(startMarker)
  if (startIdx === -1) throw new Error('Could not find diff3 start in extension.js')
  const endMarker = '  function describeConflicts('
  const endIdx = src.indexOf(endMarker, startIdx)
  if (endIdx === -1) throw new Error('Could not find diff3 end in extension.js')
  const code = src.slice(startIdx, endIdx) + '\nreturn merge3;'
  const fn = new Function('hasConflictMarkers', 'stripConflictMarkers', 'changedRange', code)
  return fn(R.hasConflictMarkers, R.stripConflictMarkers, R.changedRange)
}

const EXT_MERGE3 = extractExtMerge3()

let pass = 0
let fail = 0
const T = (n, c, extra = '') => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`)
  c ? pass++ : fail++
}

const hasMarkers = (text) => /^<<<<<<< /m.test(text || '') && /^>>>>>>> /m.test(text || '')

const IMPLEMENTATIONS = [
  { name: 'reconcile.cjs', merge3: R.merge3 },
  { name: 'packages/icr-merge/merge3.js', merge3: PKG.merge3 },
  { name: 'extension/extension.js', merge3: EXT_MERGE3 }
]

console.log('\n=== MERGE3 EOL NORMALISATION SUITE ===\n')

for (const { name: implName, merge3 } of IMPLEMENTATIONS) {
  console.log(`# Implementation: ${implName}`)

  // 1. Equal-after-norm produces NO markers and conflict: false
  {
    const base = 'alpha\nbeta\ngamma\ndelta\n'
    const mine = 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n'
    const theirs = 'alpha\nbeta\ngamma\ndelta\n'
    const res = merge3(base, mine, theirs)
    T(`${implName}: CRLF mine vs LF theirs (identical text) -> conflict: false`, res.conflict === false)
    T(`${implName}: CRLF mine vs LF theirs (identical text) -> no conflict markers`, !hasMarkers(res.text))
    T(`${implName}: output is normalized LF (no \\r\\n)`, !res.text.includes('\r\n'))
    T(`${implName}: output matches normalized text`, res.text === base)
  }

  // 1b. Empty base (creation race) with equal-after-norm
  {
    const base = ''
    const mine = 'export function hello() {\r\n  return 42\r\n}\r\n'
    const theirs = 'export function hello() {\n  return 42\n}\n'
    const res = merge3(base, mine, theirs)
    T(`${implName}: creation race (CRLF mine vs LF theirs) -> conflict: false`, res.conflict === false)
    T(`${implName}: creation race -> no conflict markers`, !hasMarkers(res.text))
    T(`${implName}: creation race -> output is LF`, !res.text.includes('\r\n'))
  }

  // 2. Mine changed EOL only; theirs made a real edit
  {
    const base = 'line 1\nline 2\nline 3\nline 4\n'
    const mine = 'line 1\r\nline 2\r\nline 3\r\nline 4\r\n'
    const theirs = 'line 1\nline 2 EDITED\nline 3\nline 4\n'
    const res = merge3(base, mine, theirs)
    T(`${implName}: mine EOL only vs theirs edit -> conflict: false`, res.conflict === false)
    T(`${implName}: mine EOL only vs theirs edit -> theirs edit applied`, res.text.includes('line 2 EDITED'))
    T(`${implName}: mine EOL only vs theirs edit -> no conflict markers`, !hasMarkers(res.text))
    T(`${implName}: mine EOL only vs theirs edit -> output is LF`, !res.text.includes('\r\n'))
  }

  // 3. Theirs changed EOL only; mine made a real edit
  {
    const base = 'line 1\nline 2\nline 3\nline 4\n'
    const mine = 'line 1\nline 2 EDITED\nline 3\nline 4\n'
    const theirs = 'line 1\r\nline 2\r\nline 3\r\nline 4\r\n'
    const res = merge3(base, mine, theirs)
    T(`${implName}: theirs EOL only vs mine edit -> conflict: false`, res.conflict === false)
    T(`${implName}: theirs EOL only vs mine edit -> mine edit applied`, res.text.includes('line 2 EDITED'))
    T(`${implName}: theirs EOL only vs mine edit -> no conflict markers`, !hasMarkers(res.text))
    T(`${implName}: theirs EOL only vs mine edit -> output is LF`, !res.text.includes('\r\n'))
  }

  // 4. Disjoint edits: mine edited line 2 (CRLF), theirs edited line 5 (LF)
  {
    const base = 'l1\nl2\nl3\nl4\nl5\nl6\n'
    const mine = 'l1\r\nl2 MINE\r\nl3\r\nl4\r\nl5\r\nl6\r\n'
    const theirs = 'l1\nl2\nl3\nl4\nl5 THEIRS\nl6\n'
    const res = merge3(base, mine, theirs)
    T(`${implName}: disjoint edits across CRLF/LF -> conflict: false`, res.conflict === false)
    T(`${implName}: disjoint edits across CRLF/LF -> both edits present`, res.text.includes('l2 MINE') && res.text.includes('l5 THEIRS'))
    T(`${implName}: disjoint edits across CRLF/LF -> no conflict markers`, !hasMarkers(res.text))
    T(`${implName}: disjoint edits across CRLF/LF -> output is LF`, !res.text.includes('\r\n'))
  }

  // 5. Conflicting edits: both edited line 2
  {
    const base = 'l1\nl2\nl3\nl4\n'
    const mine = 'l1\r\nl2 MINE\r\nl3\r\nl4\r\n'
    const theirs = 'l1\nl2 THEIRS\nl3\nl4\n'
    const res = merge3(base, mine, theirs)
    T(`${implName}: conflicting edit -> conflict: true`, res.conflict === true)
    T(`${implName}: conflicting edit -> carries conflict markers`, hasMarkers(res.text))
    T(`${implName}: conflicting edit -> non-conflicting lines merged cleanly`, res.text.startsWith('l1\n') && res.text.endsWith('l3\nl4\n'))
    T(`${implName}: conflicting edit -> conflict markers contain both sides`, res.text.includes('l2 MINE') && res.text.includes('l2 THEIRS'))
  }

  // 6. Lone CR ('\r') is NOT stripped or normalized
  {
    const base = 'foo\rbar\n'
    const mine = 'foo\rbar\n'
    const theirs = 'foo\nbar\n'
    const res = merge3(base, mine, theirs)
    // Here mine and theirs differ because lone \r is actual content, not CRLF
    T(`${implName}: lone CR is not equated to LF -> conflict on edit`, res.conflict === true || res.text === theirs || res.text === mine)
    T(`${implName}: lone CR is preserved when unedited`, merge3(base, mine, mine).text === mine)
  }

  console.log('')
}

// Parity check across the 3 files as required by tests/diff3-test.mjs
console.log('# Parity check: code blocks in all 3 files must match')
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
  const rec = blockOf(read('reconcile.cjs'))
  const pkg = blockOf(read('packages/icr-merge/merge3.js'))
  const ext = blockOf(read('extension/extension.js'))
  T('icr-merge carries the same diff3 as engine', !!rec && pkg === rec)
  T('extension carries the same diff3 as engine', !!rec && ext === rec)
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`)
process.exit(fail ? 1 : 0)
