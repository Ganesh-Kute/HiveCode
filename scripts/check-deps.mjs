#!/usr/bin/env node
/**
 * scripts/check-deps.mjs — Verify runtime dependencies resolve strictly inside this repository
 * and satisfy package.json's declared semver ranges.
 *
 * Prevents false-green test runs when local node_modules is missing or stale and Node.js
 * walks up the directory tree to resolve incompatible hoisted packages from a parent/home directory.
 */

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(__dirname, '..')

export function parseSemver(v) {
  const m = String(v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
  }
}

export function satisfies(versionStr, rangeStr) {
  const v = parseSemver(versionStr)
  if (!v) return false
  const r = String(rangeStr).trim()
  if (r === '*' || r === '') return true

  // Handle caret ^
  if (r.startsWith('^')) {
    const target = parseSemver(r.slice(1))
    if (!target) return false
    if (target.major > 0) {
      if (v.major !== target.major) return false
      if (v.minor < target.minor) return false
      if (v.minor === target.minor && v.patch < target.patch) return false
      return true
    }
    // 0.X.Y
    if (target.minor > 0) {
      if (v.major !== 0 || v.minor !== target.minor) return false
      return v.patch >= target.patch
    }
    // 0.0.Z
    return v.major === 0 && v.minor === 0 && v.patch === target.patch
  }

  // Handle tilde ~
  if (r.startsWith('~')) {
    const target = parseSemver(r.slice(1))
    if (!target) return false
    if (v.major !== target.major || v.minor !== target.minor) return false
    return v.patch >= target.patch
  }

  // Handle >=
  if (r.startsWith('>=')) {
    const target = parseSemver(r.slice(2))
    if (!target) return false
    if (v.major < target.major) return false
    if (v.major === target.major && v.minor < target.minor) return false
    if (v.major === target.major && v.minor === target.minor && v.patch < target.patch) return false
    return true
  }

  // Exact version
  const target = parseSemver(r)
  if (!target) return false
  return v.major === target.major && v.minor === target.minor && v.patch === target.patch
}

function matchGlob(pattern, str) {
  const pat = pattern.trim().replace(/^\.\//, '')
  const regexStr = '^' + pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*')
    + '$'
  return new RegExp(regexStr).test(str)
}

export function matchesWorkspace(repoRoot) {
  let dir = path.dirname(repoRoot)
  const root = path.parse(dir).root
  while (dir && dir !== root) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        const ws = Array.isArray(pkg.workspaces)
          ? pkg.workspaces
          : (pkg.workspaces && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : null)
        if (ws) {
          const rel = path.relative(dir, repoRoot).replace(/\\/g, '/')
          if (ws.some((glob) => matchGlob(glob, rel))) {
            return { allowed: true, workspaceRoot: dir }
          }
        }
      } catch { }
    }
    const pnpmPath = path.join(dir, 'pnpm-workspace.yaml')
    if (fs.existsSync(pnpmPath)) {
      try {
        const text = fs.readFileSync(pnpmPath, 'utf8')
        const matches = [...text.matchAll(/-\s*['"]?([^'"\n]+)['"]?/g)].map((m) => m[1].trim())
        const rel = path.relative(dir, repoRoot).replace(/\\/g, '/')
        if (matches.some((glob) => matchGlob(glob, rel))) {
          return { allowed: true, workspaceRoot: dir }
        }
      } catch { }
    }
    const next = path.dirname(dir)
    if (next === dir) break
    dir = next
  }
  return { allowed: false }
}

function findPackageRoot(entryPath, depName) {
  const normalized = path.normalize(entryPath)
  const sep = path.sep
  const needle = `${sep}node_modules${sep}${depName}${sep}`
  const idx = normalized.lastIndexOf(needle)
  if (idx !== -1) {
    return normalized.slice(0, idx + needle.length - 1)
  }
  let d = path.dirname(entryPath)
  const root = path.parse(d).root
  while (d && d !== root) {
    const pj = path.join(d, 'package.json')
    if (fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'))
        if (j.name === depName) return d
      } catch { }
    }
    const next = path.dirname(d)
    if (next === d) break
    d = next
  }
  return path.dirname(entryPath)
}

export function checkDeps({ repoRoot = DEFAULT_ROOT, log = console.log, logErr = console.error } = {}) {
  const pkgPath = path.join(repoRoot, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    logErr(`[check-deps] package.json not found in ${repoRoot}`)
    return { ok: false, errors: [`package.json not found in ${repoRoot}`] }
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const deps = pkg.dependencies || {}
  const depNames = Object.keys(deps)
  if (depNames.length === 0) {
    log('[check-deps] No runtime dependencies declared.')
    return { ok: true, resolved: [] }
  }

  const req = createRequire(pkgPath)
  const localNodeModules = path.join(repoRoot, 'node_modules')
  const ws = matchesWorkspace(repoRoot)
  const errors = []
  const resolved = []

  for (const name of depNames) {
    const range = deps[name]
    let entry
    try {
      entry = req.resolve(name)
    } catch (e) {
      if (e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || /exports/i.test(e.message)) {
        try {
          entry = req.resolve(`${name}/package.json`)
        } catch { }
      }
      if (!entry) {
        errors.push(`[check-deps] dependency "${name}" (${range}) could not be resolved: ${e.message}. Run npm ci in this checkout.`)
        continue
      }
    }

    const pkgRoot = findPackageRoot(entry, name)
    const pjPath = path.join(pkgRoot, 'package.json')
    let installedVersion = 'unknown'
    if (fs.existsSync(pjPath)) {
      try {
        installedVersion = JSON.parse(fs.readFileSync(pjPath, 'utf8')).version || 'unknown'
      } catch { }
    }

    // Origin check
    const isInsideLocal = pkgRoot.toLowerCase().startsWith(localNodeModules.toLowerCase())
    let originOk = isInsideLocal
    if (!originOk && ws.allowed) {
      const wsNodeModules = path.join(ws.workspaceRoot, 'node_modules')
      if (pkgRoot.toLowerCase().startsWith(wsNodeModules.toLowerCase())) {
        originOk = true
      }
    }

    if (!originOk) {
      errors.push(
        `[check-deps] dependency "${name}" resolved from outside repository (${pkgRoot}). ` +
        `Expected inside "${localNodeModules}". Run npm ci in this checkout.`
      )
      continue
    }

    // Version range check
    if (!satisfies(installedVersion, range)) {
      errors.push(
        `[check-deps] dependency "${name}" resolved to version ${installedVersion} at "${pkgRoot}", ` +
        `which does not satisfy declared range "${range}". Run npm ci in this checkout.`
      )
      continue
    }

    resolved.push({ name, range, version: installedVersion, path: pkgRoot, entry })
  }

  if (errors.length > 0) {
    for (const err of errors) logErr(err)
    return { ok: false, errors, resolved }
  }

  log(`=== DEPENDENCY ISOLATION OK: ${resolved.length} runtime package(s) verified ===`)
  for (const item of resolved) {
    log(`  ✓ ${item.name}@${item.version} (requires ${item.range}) -> ${item.path}`)
  }

  return { ok: true, resolved }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  const result = checkDeps()
  process.exit(result.ok ? 0 : 1)
}
