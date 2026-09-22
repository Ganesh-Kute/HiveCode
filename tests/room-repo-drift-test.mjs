// HIV-P9: ROOM/REPO DRIFT DETECTION AND CLOBBER SHIELD
//
//   node tests/room-repo-drift-test.mjs
//
// THE PROBLEM:
// Two workspaces exist: the authoritative Git repository (Desktop/N, branch release-gate)
// and ephemeral CRDT sync checkouts (Desktop/night/...).
//
// On 19 Sep (HIV-28 incident) and 20 Sep (HIV-P9 finding), ephemeral room checkouts carried
// degraded copies of files (hive-linear.js lost 50 lines of HIV-14 pagination guards,
// tests lost ~200 lines, sync.js lost P4 actionable suggestions).
//
// The hazard is twofold:
//   1. False Green Tests: Running tests from inside an ephemeral room folder runs against
//      degraded code, producing answers that do not reflect git HEAD.
//   2. Silent Clobbering: If an agent or sync process copies or adopts room files over the
//      working tree on first contact (or when disconnected without a shadow ancestor),
//      production code on disk is wiped out with zero git conflict markers.
//
// THE LESSON FROM hive-pr-staleness.js:
// "Ahead" vs "behind" is the wrong question because Yjs rooms and git branches have no merge-base,
// line-count heuristics cannot distinguish deletions from regressions, and CRLF transforms byte hashes.
// The only answerable question is:
//     "Has the room ever SEEN what is currently in the repository?"
//
// This suite tests:
//   - Section A: Core provenance accounting via hive-pr-staleness.js
//   - Section B: The 20 Sep hive-linear.js truncation fixture
//   - Section C: Synthetic mutation testing (guarding against vacuous checks)
//   - Section D: Workspace health CLI (scripts/check-drift.mjs)
//   - Section E: First-contact adoption safety (refusing blind disk clobbering)

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { contentHash } from '../substrate.js'
import {
  chainOf, accountFor, writable, verdict, explain,
  IDENTICAL, NEW, DESCENDS, DIVERGED, UNPROVEN, WRITABLE,
  sameText,
} from '../hive-pr-staleness.js'
import { icrMerge3 } from '../icr-merge.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const receipt = (fromText, toText, name = 'Claude') => ({
  author: 'id:' + name, name, parent: contentHash(fromText), contentHash: contentHash(toText), at: 1,
})

// ── A. THE PROVENANCE ACCOUNTING MODEL ──────────────────────────────────────────
console.log('\n# A. provenance accounting model')
{
  T('A1 WRITABLE contains only NEW and DESCENDS',
    WRITABLE.length === 2 && WRITABLE.includes(NEW) && WRITABLE.includes(DESCENDS))
  T('A2 UNPROVEN is not writable', !WRITABLE.includes(UNPROVEN))
  T('A3 DIVERGED is not writable', !WRITABLE.includes(DIVERGED))
  T('A4 IDENTICAL is not writable (nothing to write)', !WRITABLE.includes(IDENTICAL))
}

// ── B. THE HIV-14 HIVE-LINEAR TRUNCATION FIXTURE ───────────────────────────────
console.log('\n# B. the hive-linear.js truncation fixture')
{
  // Real 20 Sep scenario:
  // Repo HEAD contains the 319-line hive-linear.js with Q443 pagination guards.
  // Room contains the 262-line degraded copy missing the pagination logic.
  // The room's receipts record historical room edits, but have never seen the repo's pagination code.
  const roomText = `export async function readIssues() {
  // degraded room copy: missing pagination loop
  return fetchIssues({ page: 1 })
}
`
  const repoText = `export async function readIssues() {
  // authoritative repo copy: full HIV-14 pagination loop
  let page = 1
  let all = []
  while (true) {
    const res = await fetchIssues({ page })
    if (!res || !res.length) break
    all.push(...res)
    if (page >= 10) {
      console.warn('Q443 INCOMPLETE BACKLOG: stopping at page cap')
      break
    }
    page++
  }
  return all
}
`
  // Room receipts: built from initial seed v0 -> roomText
  const v0 = 'export async function readIssues() {}\n'
  const receipts = [receipt('', v0), receipt(v0, roomText)]

  const d = accountFor({ rel: 'hive-linear.js', branchText: repoText, roomText, receipts })
  T('B1 degraded room file with unrecorded repo edits is DIVERGED', d.state === DIVERGED, d.state)
  T('B2 degraded room file is NOT writable', writable(d) === false)
  T('B3 explain() refuses to overwrite repo with degraded room copy', /REFUSING TO WRITE/.test(explain([d])))
  T('B4 explain() explains the repo holds content the room has never seen', /never seen/.test(d.why))
}

// ── C. THE UNPROVEN STATE (PRE-PROVENANCE RESIDUE) ──────────────────────────────
console.log('\n# C. unproven state (pre-provenance residue)')
{
  // When files in the room predate provenance tracking or have empty ledgers:
  const roomText = 'function test() { return 1 }\n'
  const repoText = 'function test() { return 2 }\n'
  const d = accountFor({ rel: 'sync.js', branchText: repoText, roomText, receipts: [] })

  T('C1 empty receipt chain yields UNPROVEN', d.state === UNPROVEN, d.state)
  T('C2 UNPROVEN is not writable', writable(d) === false)
  T('C3 verdict blocks run on UNPROVEN', verdict([d]).ok === false)
}

// ── D. WORKSPACE HEALTH CHECK CLI (scripts/check-drift.mjs) ────────────────────
console.log('\n# D. workspace drift check CLI (scripts/check-drift.mjs)')
{
  const cliPath = path.join(ROOT, 'scripts', 'check-drift.mjs')
  const cliExists = fs.existsSync(cliPath)
  T('D1 scripts/check-drift.mjs exists', cliExists)

  if (cliExists) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'))
    const mockRepo = path.join(tmp, 'repo'); fs.mkdirSync(mockRepo)
    const mockRoom = path.join(tmp, 'room'); fs.mkdirSync(mockRoom)

    // Sub-case D-identical:
    fs.writeFileSync(path.join(mockRepo, 'clean.js'), 'const x = 1\n')
    fs.writeFileSync(path.join(mockRoom, 'clean.js'), 'const x = 1\n')

    const rIdentical = spawnSync(process.execPath, [cliPath, '--repo', mockRepo, '--room', mockRoom], {
      encoding: 'utf8',
    })
    T('D2 check-drift exits 0 when workspaces are identical', rIdentical.status === 0, `status: ${rIdentical.status}`)

    // Sub-case D-diverged:
    fs.writeFileSync(path.join(mockRepo, 'app.js'), 'const app = 2\n')
    fs.writeFileSync(path.join(mockRoom, 'app.js'), 'const app = 1\n')

    const rDiverged = spawnSync(process.execPath, [cliPath, '--repo', mockRepo, '--room', mockRoom], {
      encoding: 'utf8',
    })
    T('D3 check-drift exits non-zero when workspace is diverged/unproven', rDiverged.status !== 0, `status: ${rDiverged.status}`)
    T('D4 check-drift output flags the offending file', /app\.js/.test(rDiverged.stdout || rDiverged.stderr))

    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  } else {
    T('D2 check-drift exits 0 when workspaces are identical', false, 'CLI missing')
    T('D3 check-drift exits non-zero when workspace is diverged/unproven', false, 'CLI missing')
    T('D4 check-drift output flags the offending file', false, 'CLI missing')
  }
}

// ── E. FIRST-CONTACT ADOPTION SAFETY IN sync.js ────────────────────────────────
console.log('\n# E. first-contact adoption safety in sync.js')
{
  // Property E1: sync.js imports accountFor from hive-pr-staleness
  const syncSrc = fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8')
  const importsStaleness = /import\s*\{[^}]*accountFor[^}]*\}\s*from\s*['"]\.\/hive-pr-staleness\.js['"]/.test(syncSrc)
  T('E1 sync.js imports accountFor from hive-pr-staleness.js', importsStaleness)

  // Property E2: Proves the empty-base merge flaw that Claude measured:
  // Merging two disjoint files with an empty base causes concatenation and duplicate imports.
  const fileA = 'import fs from "fs"\nexport function start() { return 1 }\n'
  const fileB = 'import fs from "fs"\nexport function start() { return 2 }\n'
  const emptyBaseResult = icrMerge3('', fileA, fileB, 'app.js')
  T('E2 empty-base merge concatenates and duplicates declarations (why blind merge is fatal)',
    (emptyBaseResult.text.match(/import fs/g) || []).length === 2)

  // Property E3: sync.js first-contact adopt block must NOT execute icrMerge3
  const adoptBlockMatch = syncSrc.match(/accountFor\(\{[\s\S]*?return\s*\n\s*\}/)
  const adoptBlock = adoptBlockMatch ? adoptBlockMatch[0] : ''
  T('E3 first-contact adopt branch does NOT attempt empty-base concatenation',
    !adoptBlock.includes('icrMerge3'))

  // Property E4: First-contact adopt branch refuses room adoption on DIVERGED/UNPROVEN
  const hasRefusalGuard = /captureSnapshot.*room copy refused/s.test(syncSrc) || /room copy was NOT adopted/s.test(syncSrc)
  T('E4 first-contact adopt branch preserves local disk and refuses room copy on divergence',
    hasRefusalGuard)
}

// ── F. SYNTHETIC MUTATION TESTS ────────────────────────────────────────────────
console.log('\n# F. synthetic mutation tests')
{
  // Prove that a trivial comparator saying "shorter file is always fine" fails
  const naiveAllowAll = (d) => true
  const naiveDiverged = { state: DIVERGED, why: 'never seen' }
  T('F1 naive allow-all would permit DIVERGED (caught by writable)',
    naiveAllowAll(naiveDiverged) !== writable(naiveDiverged))

  const naiveUnproven = { state: UNPROVEN, why: 'no chain' }
  T('F2 naive allow-all would permit UNPROVEN (caught by writable)',
    naiveAllowAll(naiveUnproven) !== writable(naiveUnproven))
}

console.log(`\n=== HIV-P9 ROOM/REPO DRIFT: ${pass} passed, ${fail} failed ===\n`)
process.exit(fail ? 1 : 0)
