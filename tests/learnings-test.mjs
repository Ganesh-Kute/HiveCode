// learnings: the writeups stay true, or they stop being writeups.
//
//   node tests/learnings-test.mjs
//
// A defect-class document earns its keep by being SPECIFIC -- real files, real numbers, a real
// worked example. Specificity is also what rots: the file gets renamed, the function moves, the
// number goes stale, and the document quietly becomes confident fiction. A learning that cites a
// path which no longer exists is worse than no learning, because it is read with the authority of
// something that was once checked.
//
// So the claims that CAN be checked mechanically are. Three of them:
//
//   1. every relative link in every learning resolves to a file that exists
//   2. every learning carries the sections that make it a class writeup rather than a bug report
//   3. the README index and the directory agree
//
// And one that is not about the documents at all: section D re-verifies the live invariant that
// repair-the-class-not-the-copy.md asserts about hive-mcp.js. That document's whole argument is
// that the class was made COUNTABLE. If the count is only ever stated in prose, it is a promise;
// run here, it is a guard.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIR = path.join(ROOT, 'learnings')

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.md')).sort()
const learnings = files.filter((f) => f !== 'README.md')
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8')

// ── A. the index and the directory agree ──────────────────────────────────────
console.log('\n# A. the index')
{
  const readme = read('README.md')
  const unlisted = learnings.filter((f) => !readme.includes(f))
  T('A1 every learning is listed in the README', unlisted.length === 0, unlisted.join(', '))

  // The other direction: a row for a file that was deleted sends a reader to a 404 and makes the
  // whole index untrustworthy.
  const linked = [...readme.matchAll(/\]\(([a-z0-9-]+\.md)\)/g)].map((m) => m[1])
  const ghosts = linked.filter((l) => !learnings.includes(l))
  T('A2 the README links nothing that is not there', ghosts.length === 0, ghosts.join(', '))
  T('A3 there is at least one learning', learnings.length > 0, `${learnings.length} files`)
}

// ── B. THE ROT CHECK ──────────────────────────────────────────────────────────
console.log('\n# B. every path a learning cites still exists')
{
  let checked = 0
  const broken = []
  for (const f of files) {
    // Markdown links only, and only relative ones -- https targets are somebody else's uptime.
    for (const m of read(f).matchAll(/\]\((\.{0,2}\/?[^)\s#]+)\)/g)) {
      const target = m[1]
      if (/^https?:/.test(target)) continue
      checked++
      const abs = path.resolve(DIR, target)
      if (!fs.existsSync(abs)) broken.push(`${f} -> ${target}`)
    }
  }
  T(`B1 all ${checked} relative links resolve`, broken.length === 0, broken.join('; '))

  // Inline code spans naming a source file are a citation too, and they rot the same way -- they
  // are just not links, so nothing else would ever check them.
  //
  // This pattern used to be /`([a-z0-9-]+\.(?:js|mjs))`/ -- no "/" in the character class, so any
  // citation carrying a directory was invisible to it. Measured 20 Sep 2026: 12 citations guarded,
  // 8 unguarded, and the unguarded ones were `tests/mention-boundary-test.mjs`,
  // `tests/non-answerable-test.mjs` and `tests/learnings-test.mjs` -- the three that carry the
  // argument of testing-the-consumer-instead-of-the-derivation.md. Renaming one of them to a file
  // that does not exist left this suite at 12/12. The check read bare filenames and assumed that
  // was how people cite things; citing a test by its path is the more common habit, not the rarer.
  const namedBroken = []
  let bare = 0, prefixed = 0
  for (const f of learnings) {
    const text = read(f)
    for (const m of text.matchAll(/`((?:[a-z0-9_-]+\/)?[A-Za-z0-9_-]+\.(?:js|mjs))`/g)) {
      // An external citation is legal and must stay legal: learnings borrow defect classes from
      // other repos on purpose. The tell is a markdown link straight to a URL --
      // [`their-file.mjs`](https://github.com/...) -- and its target is somebody else's uptime.
      if (/^\]\(\s*https?:/.test(text.slice(m.index + m[0].length))) continue
      const cited = m[1]
      // A citation that names its directory has already said where the file lives: resolve it
      // there and nowhere else, because landing in the wrong directory IS the rot being looked for.
      // A bare name still gets the search, since it never claimed a location.
      const hit = cited.includes('/')
        ? fs.existsSync(path.join(ROOT, cited))
        : ['', 'tests', 'scripts'].some((d) => fs.existsSync(path.join(ROOT, d, cited)))
      cited.includes('/') ? prefixed++ : bare++
      if (!hit) namedBroken.push(`${f} -> ${cited}`)
    }
  }
  T(`B2 all ${bare + prefixed} source files named in backticks exist where they say they do`,
    namedBroken.length === 0, namedBroken.join('; '))

  // THE NON-VACUITY LINE. A widened pattern that silently matches nothing reports full compliance,
  // which is exactly how the version scanner failed earlier the same day: it swept 81 files, matched
  // 0, and printed a clean bill of health. B2 above cannot distinguish "every path-prefixed citation
  // resolves" from "no path-prefixed citation was looked at". This can.
  T('B3 B2 actually looked at path-prefixed citations, rather than matching none of them',
    prefixed > 0, `${prefixed} path-prefixed, ${bare} bare`)
}

// ── C. it is a class writeup, not a bug report ────────────────────────────────
console.log('\n# C. the shape that makes it worth keeping')
{
  // These two sections are the ones that separate a learning from a changelog entry: the first
  // stops the class recurring under a new name, the second stops the lesson being over-applied by
  // somebody who just read it and is now seeing it everywhere.
  const REQUIRED = [
    ['## Why it survives review', 'why review missed it'],
    ['## Why the obvious fix makes it worse', 'why the obvious fix is wrong'],
    ['## How to catch it before you ship', 'a detection heuristic'],
    ['## What it is not', 'the boundary'],
  ]
  for (const [heading, what] of REQUIRED) {
    const missing = learnings.filter((f) => !read(f).includes(heading))
    T(`C1 every learning says ${what}  ("${heading}")`, missing.length === 0, missing.join(', '))
  }

  const noExample = learnings.filter((f) => !/## Worked example/.test(read(f)))
  T('C2 every learning ends in a WORKED EXAMPLE — without one it reads as generic advice, and generic advice is skipped',
    noExample.length === 0, noExample.join(', '))

  // A class needs evidence it recurs. A document with no digits in it is an opinion.
  const noNumbers = learnings.filter((f) => !/\d{2,}/.test(read(f)))
  T('C3 every learning carries measured numbers, not just argument', noNumbers.length === 0, noNumbers.join(', '))
}

// ── D. the live invariant one of them claims ──────────────────────────────────
console.log('\n# D. re-checking the invariant repair-the-class-not-the-copy.md asserts')
{
  // That document's argument is that the class was made COUNTABLE rather than merely fixed twice.
  // Stated in prose it is a promise; asserted here it is a guard, and a third notification site
  // added without the wrapper fails this line rather than crashing an agent at 3am.
  const mcp = fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8')
  const total = (mcp.match(/server\.notification/g) || []).length
  const guarded = (mcp.match(/Promise\.resolve\(server\.notification/g) || []).length
  T('D1 EVERY server.notification() is wrapped so its rejection cannot kill the agent',
    total > 0 && total === guarded, `${guarded} guarded of ${total}`)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
