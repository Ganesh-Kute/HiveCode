#!/usr/bin/env node
/**
 * CAN THE RELAY ACTUALLY BOOT AND SERVE FROM WHAT IS COMMITTED?
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
 * The same trap applies to files the relay serves through its STATIC map (including
 * ../hive-time.js, which control.html imports). If a STATIC target is untracked in git,
 * the relay boots, but browser clients get the relay's "is up" status text instead of
 * the file, breaking the control room on camera while all CI checks were green.
 *
 * So: walk every relative import reachable from the relay's entry point transitively,
 * and check every STATIC target in relay-static.js. Fail if any of them is untracked.
 * Wired into pretest, so `npm test` refuses a tree that would not boot or serve on a
 * fresh clone.
 */
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { STATIC, staticFile } from '../relay-static.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

// Guard against vacuity: if the map is empty or has no '/control' entry, fail
if (!STATIC || Object.keys(STATIC).length === 0 || !STATIC['/control']) {
  console.error('\n  === COULD NOT READ THE RELAY\'S SERVED FILES ===\n')
  console.error('  could not read the relay\'s served files: relay-static.js STATIC map is empty or has no \'/control\' entry.\n')
  process.exit(1)
}

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

// Matches `from './x'`, `import './x'`, `require('./x')` and `import('./x')`. Only RELATIVE specifiers --
// a bare specifier is a node_modules dependency, which package.json covers and git does not.
const IMPORT_RE = /(?:import|export)[^'"';]*?from\s*['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)|import\(\s*['"](\.[^'"]+)['"]\s*\)/g

const seen = new Set()
const missing = new Map()
const staticMissing = new Map()
const unresolved = []
const queue = [...ENTRIES]

// Check every target in the STATIC map
const targetUrls = new Map()
for (const [url, target] of Object.entries(STATIC)) {
  if (!targetUrls.has(target)) targetUrls.set(target, [])
  targetUrls.get(target).push(url)
}

const staticTargets = [...new Set(Object.values(STATIC))]
for (const target of staticTargets) {
  const full = staticFile(target, ROOT)
  if (!fs.existsSync(full)) {
    unresolved.push(target + '  (STATIC in relay-static.js)')
    continue
  }
  const rel = path.relative(ROOT, full).split(path.sep).join('/')
  if (!tracked.has(rel)) {
    staticMissing.set(rel, target)
  }
  if (/\.(?:js|mjs|cjs)$/.test(rel)) {
    queue.push(rel)
  }
}

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
    const spec = m[1] || m[2] || m[3] || m[4]
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

console.log('\n  walked ' + seen.size + ' file(s) reachable from ' + ENTRIES.join(', ') + ' and checked ' + staticTargets.length + ' STATIC file(s)')

let failed = false

if (unresolved.length) {
  failed = true
  console.log('\n  not found on disk at all:')
  for (const u of unresolved) console.log('    ' + u)
}

if (missing.size) {
  failed = true
  console.error('\n  === THE RELAY WOULD NOT BOOT FROM A FRESH CLONE ===\n')
  for (const [f, by] of missing) console.error('    ' + f + '   <- imported by ' + [...new Set(by)].join(', '))
  console.error('\n  These exist on this machine and are NOT in git. A deploy clones the repo,')
  console.error('  so it gets none of them and dies on the first import.\n')
  console.error('    git add ' + [...missing.keys()].join(' ') + '\n')
}

if (staticMissing.size) {
  failed = true
  console.error('\n  === THE RELAY WOULD SERVE WRONG OR BROKEN FILES ===\n')
  for (const [f, target] of staticMissing) console.error('    ' + f + '   <- STATIC target (' + target + ') in relay-static.js')
  console.error('\n  These exist on this machine and are NOT in git. The relay would boot, but:')
  for (const [f, target] of staticMissing) {
    const urls = targetUrls.get(target) || []
    for (const url of urls) {
      const isControl = url === '/control' || url === '/control.html' || url === '/hive-crdt.js' || url === '/hive-time.js'
      const suffix = isControl ? ': the control room breaks' : ''
      console.error('    ' + url + ' would get the relay\'s \'is up\' text instead of ' + f + suffix)
    }
  }
  console.error('\n    git add ' + [...staticMissing.keys()].join(' ') + '\n')
}

if (failed) {
  process.exit(1)
}

console.log('  === DEPLOY OK: every file the relay imports and serves statically is committed ===\n')
