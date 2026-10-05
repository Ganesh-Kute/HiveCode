// hive-version.js — one place that knows what build this is.
//
// WHY THIS FILE EXISTS, and it is not tidiness.
//
// VERSION is load-bearing, not cosmetic. hive_join instructs every arriving agent to announce its
// version in chat, because two clients running different builds in one room corrupt each other's
// files with no error on either side — both writes succeed, both are green, and the disagreement
// surfaces only as lost bytes. That announcement is the ONLY channel that makes a mixed build
// visible from inside the room. So a version string is not a label; it is the input to the one
// detector we have.
//
// On 20 Sep 2026 three entry points were found reporting a version package.json does not contain:
// remote-mcp.js said '0.11.5' while live on the hosted relay, hive-mcp-http.js and hive-linear.js
// both said '1.0.0'. hive-mcp.js had already been fixed months earlier, with a comment explaining
// exactly why hardcoding it is dangerous — and that fix was never carried to the other three.
// A detector that lies is strictly worse than no detector, because it is trusted.
//
// HIV-P7 closed that by giving each of the four files its own runtime read. Which produced the
// next defect, and it was measured rather than predicted: with the reader duplicated four times,
// corrupting ONE copy's fallback string to '9.9.9-DRIFTED' left tests/version-truth-test.mjs at
// 16 passed, 0 failed. The property guards the version that gets REPORTED and says nothing about
// the mechanism that produces it, so three of four copies could rot in silence.
//
// This codebase has watched that happen before. The extension's reconcile() and the engine's were
// the same function once; they now share 34 lines and behave differently. Eight lines is not too
// small to drift — it is exactly small enough that nobody feels the need to check.
//
// So the fix is DELETION, not another assertion. One definition, imported by all four. The
// property becomes true by construction instead of by policing, and a fifth entry point written
// next year gets it right by importing rather than by remembering.
//
// TWO DECISIONS WORTH KEEPING:
//
// It READS package.json rather than being told. package.json always ships beside these files —
// in the repo and in the published tarball — so `new URL('./package.json', import.meta.url)`
// resolves in both. Anything else (a constant, a build step, a generated file) can disagree with
// the package the moment `npm version` runs, which is precisely the failure being fixed.
//
// IT NEVER THROWS. A version read is not worth a server that will not boot, and a server that
// refuses to start is a worse outcome than one that says it does not know which build it is. So
// an unreadable or malformed package.json yields '0.0.0-unknown' — a value that is obviously
// wrong to a human, will never match a real release, and cannot be mistaken for a true answer.
// Silence or an empty string could be read as "no mixed build here"; this cannot.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/** Recomputed never: a running process cannot change which build it is. */
export const VERSION = (() => {
  try {
    const v = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
    if (typeof v === 'string' && v) return v
  } catch { /* fall through — see IT NEVER THROWS above */ }
  return '0.0.0-unknown'
})()

/** The sentinel, exported so callers and tests can name it instead of retyping the literal. */
export const UNKNOWN_VERSION = '0.0.0-unknown'

// BUILD: WHICH COMMIT, not just which version (29 Sep 2026).
//
// VERSION alone could not see a mixed build. On 28-29 Sep release-gate HEAD and the published
// tarball both said "0.12.2" while differing by a night of fixes, and the hosted relay's /health
// reported no version at all -- "is the fix deployed?" was answered from its uptime. So a build
// carries its commit when it knows one:
//   RENDER_GIT_COMMIT  set by Render for a deployed relay (its image has no .git)
//   a git checkout     .git beside package.json: a folder, or a worktree's `gitdir:` file
//   otherwise ''       an npm install: VERSION is the whole identity, and it is the true one
// VERSION itself is untouched -- the update notice compares it with the registry's -- so the
// commit travels separately, and VERSION_LABEL is what people and agents are shown.
//
// It never walks UP. hivecode-mcp installed into someone's repo would otherwise report THAT repo's
// commit as its own build, which is the lie this exists to prevent. And like VERSION it never throws.
const HEX = /^[0-9a-f]{7,40}$/
export function buildOf(root, env = process.env) {
  try {
    const rc = String(env.RENDER_GIT_COMMIT || '').trim().toLowerCase()
    if (HEX.test(rc)) return rc.slice(0, 7)
    const dotGit = path.join(root, '.git')
    let gitDir = dotGit
    if (fs.statSync(dotGit).isFile()) { // a worktree: ".git" is a file holding "gitdir: <path>"
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))
      if (!m) return ''
      gitDir = path.resolve(root, m[1])
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7) // detached
    const ref = /^ref:\s*(\S+)$/.exec(head)
    if (!ref) return ''
    let common = gitDir // a worktree keeps its branches in the main repo's .git
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()) } catch { }
    for (const d of [gitDir, common]) {
      try { const h = fs.readFileSync(path.join(d, ref[1]), 'utf8').trim(); if (/^[0-9a-f]{40}$/.test(h)) return h.slice(0, 7) } catch { }
    }
    for (const line of fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n')) {
      const [h, r] = line.trim().split(/\s+/)
      if (r === ref[1] && /^[0-9a-f]{40}$/.test(h)) return h.slice(0, 7)
    }
  } catch { /* no .git, unreadable, malformed: no commit to report -- see IT NEVER THROWS */ }
  return ''
}

/** This build's commit, or '' when it has none to report (an npm install). */
export const BUILD = buildOf(fileURLToPath(new URL('.', import.meta.url)))

/** What people and agents are shown: "0.12.2+fe1d89e" from a checkout, "0.12.2" from npm. */
export const VERSION_LABEL = BUILD ? `${VERSION}+${BUILD}` : VERSION

export default VERSION
