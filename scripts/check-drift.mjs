#!/usr/bin/env node
// scripts/check-drift.mjs — detect drift between authoritative repo and room workspace
//
//   node scripts/check-drift.mjs [--repo <repoDir>] [--room <roomDir>]
//
// WHY THIS EXISTS:
// An ephemeral room checkout (Yjs sync) can carry degraded or stale copies of files
// (e.g. hive-linear.js losing HIV-14 pagination guards by matching a 2-day-old commit).
// Running tests or promoting files from a degraded room corrupts production code.
//
// This tool compares the authoritative repo against a room checkout:
//   - Byte-identical or sameText -> IDENTICAL (ok)
//   - Room matches an older git commit -> ROOM_STALE_HISTORICAL (stale residue)
//   - Neither matches -> DIVERGED (independent fork)
//
// Exits 0 if all compared files are in sync, 1 if drift/divergence is detected.

import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { sameText } from '../hive-pr-staleness.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const args = process.argv.slice(2)
let repoDir = ROOT
let roomDir = null

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repo' && args[i + 1]) {
    repoDir = path.resolve(args[++i])
  } else if (args[i] === '--room' && args[i + 1]) {
    roomDir = path.resolve(args[++i])
  }
}

if (!roomDir) {
  // Default room candidates
  const candidates = [
    path.join(ROOT, '..', 'night', 'antigravity1'),
    path.join(ROOT, '..', 'night', 'room'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) { roomDir = c; break }
  }
}

if (!roomDir || !fs.existsSync(roomDir)) {
  console.error(`check-drift: no valid room directory found. Specify with --room <path>.`)
  process.exit(2)
}

if (!fs.existsSync(repoDir)) {
  console.error(`check-drift: repo directory "${repoDir}" does not exist.`)
  process.exit(2)
}

const SKIP_PREFIX = ['.git', 'node_modules', '.hive-shadow.json', '.hive-id.json', '.hive-lock.json', '.hive-mcp-session.json']
function shouldSkip(rel) {
  const norm = rel.replace(/\\/g, '/')
  return SKIP_PREFIX.some((p) => norm === p || norm.startsWith(p + '/'))
}

function collectFiles(dir) {
  const results = []
  function walk(curr, rel) {
    let entries
    try { entries = fs.readdirSync(curr, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      if (shouldSkip(childRel)) continue
      const full = path.join(curr, ent.name)
      if (ent.isDirectory()) {
        walk(full, childRel)
      } else if (ent.isFile()) {
        results.push(childRel)
      }
    }
  }
  walk(dir, '')
  return results
}

const isGit = fs.existsSync(path.join(repoDir, '.git'))
function gitCommitMatch(rel, roomText) {
  if (!isGit) return null
  try {
    const log = execFileSync('git', ['log', '-n', '50', '--format=%H', '--', rel], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const commits = log.trim().split(/\s+/).filter(Boolean)
    for (const hash of commits) {
      try {
        const blob = execFileSync('git', ['cat-file', 'blob', `${hash}:${rel}`], {
          cwd: repoDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        if (sameText(blob, roomText)) return hash
      } catch {}
    }
  } catch {}
  return null
}

const repoFiles = collectFiles(repoDir)
const roomFiles = collectFiles(roomDir)
const allFiles = new Set([...repoFiles, ...roomFiles])

const issues = []
let checked = 0

for (const rel of allFiles) {
  const repoPath = path.join(repoDir, rel)
  const roomPath = path.join(roomDir, rel)

  const inRepo = fs.existsSync(repoPath)
  const inRoom = fs.existsSync(roomPath)

  if (inRepo && !inRoom) continue // normal if room is allow-listed subset
  if (!inRepo && inRoom) {
    issues.push({ rel, status: 'ROOM_UNTRACKED_FILE', why: 'exists in room but not in repository' })
    continue
  }

  // Exists in both
  checked++
  let repoText, roomText
  try {
    repoText = fs.readFileSync(repoPath, 'utf8')
    roomText = fs.readFileSync(roomPath, 'utf8')
  } catch {
    continue // binary or read failure
  }

  if (sameText(repoText, roomText)) continue

  // Content differs
  const matchHash = gitCommitMatch(rel, roomText)
  if (matchHash) {
    issues.push({
      rel,
      status: 'ROOM_STALE_HISTORICAL',
      why: `room content is an older git commit (${matchHash.slice(0, 8)}) — repo HEAD has newer work`,
    })
  } else {
    issues.push({
      rel,
      status: 'DIVERGED',
      why: 'room content and repo content have diverged (room matches no git commit in history)',
    })
  }
}

console.log(`[check-drift] Checked ${checked} shared file(s) between:\n  repo: ${repoDir}\n  room: ${roomDir}`)

if (issues.length === 0) {
  console.log(`\n✓ All shared files are in sync.`)
  process.exit(0)
}

console.log(`\n⚠ DRIFT DETECTED in ${issues.length} file(s):`)
for (const iss of issues) {
  console.log(`  - ${iss.rel}: [${iss.status}] ${iss.why}`)
}
process.exit(1)
