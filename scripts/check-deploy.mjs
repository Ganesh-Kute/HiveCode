#!/usr/bin/env node
/**
 * CAN THE RELAY ACTUALLY BOOT FROM WHAT IS COMMITTED?
 *
 *   node scripts/check-deploy.mjs
 *
 * This exists because the relay crash-looped in production on 2026-09-05 with
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/usage-meter.js'
 *   imported from /app/server.js
 *
 * `usage-meter.js` was present on the developer's disk and had never been committed, so
 * every local run worked perfectly and the deployed build -- which is a git clone and
 * nothing else -- had no such file. The relay died on its first line before serving a
 * single connection.
 *
 * This is the SAME BUG scripts/check-files.mjs already guards for the npm tarball, in the
 * other direction. There the risk is a shipped file missing from package.json's files[];
 * here it is a needed file missing from git. Both have the identical shape: the tree you
 * test against and the tree that runs are different file sets, and nothing was comparing
 * them. It has now cost a production outage twice, once per artefact.
 *
 * So: walk every relative import reachable from the relay's entry point, transitively, and
 * fail if any of them is untracked. Wired into pretest, so `npm test` refuses a tree that
 * would not boot on a fresh clone.
 */
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

// The files a deploy actually starts. Add an entry here if you add another entry point.
const ENTRIES = ['server.js']

let isGitRepo = false
try {
  const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  if (path.resolve(top).toLowerCase() === path.resolve(ROOT).toLowerCase()) {
    isGitRepo = true
  }
} catch {
  isGitRepo = false
}

if (!isGitRepo) {
  console.log('[check-deploy] skipped: working copy is not its own git repository checkout')
  process.exit(0)
}

const tracked = new Set(
  execSync('git ls-files', { encoding: 'utf8', maxBuffer: 1 << 26 })
    .split(/\r?\n/).filter(Boolean).map((s) => s.split(path.sep).join('/'))
)

// Matches `from './x'`, `require('./x')` and `import('./x')`. Only RELATIVE specifiers --
// a bare specifier is a node_modules dependency, which package.json covers and git does not.
const IMPORT_RE = /(?:import|export)[^'"';]*?from\s*['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)|import\(\s*['"](\.[^'"]+)['"]\s*\)/g

const seen = new Set()
const missing = new Map()
const unresolved = []
const queue = [...ENTRIES]

while (queue.length) {
  const file = queue.shift()
  if (seen.has(file)) continue
  seen.add(file)

  let src
  try { src = fs.readFileSync(file, 'utf8') } catch { continue }
  // Strip comments so a commented-out or documentary import is not chased. check-files.mjs
  // learned this the hard way: it once flagged `./m` out of a comment in lang-js.js, and a
  // guard that cries wolf is a guard somebody deletes.
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  let m
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1] || m[2] || m[3]
    const base = path.posix.dirname(file.split(path.sep).join('/'))
    const rel = path.posix.normalize(path.posix.join(base, spec))
    const hit = [rel, rel + '.js', rel + '.mjs', rel + '.cjs', rel + '/index.js'].find((c) => fs.existsSync(c))
    if (!hit) { unresolved.push(spec + '  (from ' + file + ')'); continue }
    if (!tracked.has(hit)) {
      if (!missing.has(hit)) missing.set(hit, [])
      missing.get(hit).push(file)
    }
    queue.push(hit)
  }
}

console.log('\n  walked ' + seen.size + ' file(s) reachable from ' + ENTRIES.join(', '))

if (unresolved.length) {
  console.log('\n  not found on disk at all:')
  for (const u of unresolved) console.log('    ' + u)
}

if (missing.size) {
  console.error('\n  === THE RELAY WOULD NOT BOOT FROM A FRESH CLONE ===\n')
  for (const [f, by] of missing) console.error('    ' + f + '   <- imported by ' + [...new Set(by)].join(', '))
  console.error('\n  These exist on this machine and are NOT in git. A deploy clones the repo,')
  console.error('  so it gets none of them and dies on the first import.\n')
  console.error('    git add ' + [...missing.keys()].join(' ') + '\n')
  process.exit(1)
}

console.log('  === DEPLOY OK: every file the relay imports is committed ===\n')
