#!/usr/bin/env node
/**
 * DOES THE PUBLISHED PACKAGE ACTUALLY RUN?
 *
 * This exists because the same bug shipped twice.
 *
 *   grm-link.cjs   sync.js imported it, files[] did not list it. Survived only because the
 *                  import happened to still be uncommitted when 0.11.1 was published.
 *   hive-mailbox.js  hive-mcp.js imported it, files[] did not list it, and this time the
 *                  import WAS committed. hivecode-mcp@0.11.1 went to npm and died on
 *                  startup with ERR_MODULE_NOT_FOUND for every single user. `npm test`
 *                  passed the whole time, because tests run against the repo, where the
 *                  file is present -- the repo and the tarball are different file sets and
 *                  nothing was comparing them.
 *
 * So: walk every relative import of every shipped file, TRANSITIVELY, and fail if any of
 * them is missing from files[]. Wired into pretest and prepublishOnly, so it is impossible
 * to publish this bug again without deleting the check.
 *
 *   node scripts/check-files.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const listed = new Set(pkg.files || [])

// npm always includes these regardless of files[], so an import of one is not a defect.
const ALWAYS = new Set(['package.json', 'README.md', 'LICENSE', 'LICENCE'])
const CODE = /\.(m?js|cjs)$/i

const problems = []

// 1. Anything listed but absent from disk would publish as a silently missing file.
for (const f of listed) {
  if (f.includes('*')) continue                       // globs: npm expands, nothing to verify
  if (!fs.existsSync(path.join(ROOT, f))) problems.push(`files[] lists "${f}" but it does not exist on disk`)
}

// 2. Transitive closure of relative imports from every shipped code file.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.\/[^'"]+|\.\.\/[^'"]+)['"]/g
// A module chosen at run time -- import(sub === 'slack' ? './hive-slack.js' : './hive-notify.js')
// -- is named only as a plain string, so a './x.js' string in shipped code that names a file on
// disk counts as an import too. Missed until 25 Oct 2026: hive-slack.js, loaded that way by
// hive-mcp.js and hive-github.js, was not in files[], and `slack start` and --slack-channel would
// both have died on npm with ERR_MODULE_NOT_FOUND while this said PACKAGE OK.
const LOOSE = /['"](\.\/[\w.-]+\.(?:m?js|cjs))['"]/g
const seen = new Set()
const said = new Set()
const queue = [...listed].filter((f) => CODE.test(f))

while (queue.length) {
  const rel = queue.shift()
  if (seen.has(rel)) continue
  seen.add(rel)
  const abs = path.join(ROOT, rel)
  let src
  try { src = fs.readFileSync(abs, 'utf8') } catch { continue }
  // Comments are not imports. lang-js.js documents JS syntax IN a comment -- "export { x }
  // from './m'" -- and the first version of this check reported it as a missing file. A guard
  // that cries wolf is a guard someone deletes, so block comments go first, and a match with
  // a `//` before it on its own line is skipped.
  src = src.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))

  const found = [...src.matchAll(IMPORT)].map((m) => ({ m, loose: false }))
    .concat([...src.matchAll(LOOSE)].map((m) => ({ m, loose: true })))
  for (const { m, loose } of found) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const before = src.slice(lineStart, m.index)
    if (before.includes('//')) continue
    const spec = m[1]
    // Resolve relative to the importing file, then back to a package-root-relative path,
    // because that is the shape files[] speaks in.
    const target = path.normalize(path.join(path.dirname(rel), spec)).split(path.sep).join('/')
    if (said.has(`${rel}|${target}`)) continue
    said.add(`${rel}|${target}`)
    // A plain string that names no file on disk is not an import: only a real file counts.
    if (loose && !fs.existsSync(path.join(ROOT, target))) continue

    if (target.startsWith('..')) {
      problems.push(`${rel} imports "${spec}", which resolves OUTSIDE the package root — it can never ship`)
      continue
    }
    // A directory import or extensionless specifier is not something files[] can express safely.
    const onDisk = fs.existsSync(path.join(ROOT, target))
    if (!onDisk) {
      problems.push(`${rel} imports "${spec}" but ${target} does not exist on disk`)
      continue
    }
    if (ALWAYS.has(target)) continue
    if (!listed.has(target)) {
      problems.push(`${rel} imports "${spec}" but "${target}" is NOT in package.json files[] — ` +
        'the published package will throw ERR_MODULE_NOT_FOUND on startup')
      continue
    }
    if (CODE.test(target)) queue.push(target)
  }
}

if (problems.length) {
  console.error('\n=== PACKAGE WOULD NOT RUN: ' + problems.length + ' problem(s) ===')
  for (const p of problems) console.error('  ' + p)
  console.error('\nFix package.json files[], then re-run: node scripts/check-files.mjs\n')
  process.exit(1)
}
console.log(`=== PACKAGE OK: ${seen.size} shipped code file(s), every relative import present in files[] ===`)
