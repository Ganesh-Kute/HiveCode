// hive-pr-staleness.js — do not write a file over a branch change you cannot account for.
//
// THE INCIDENT, MEASURED 19 Sep 2026. hive-pr generated a PR that looked perfect: three commits,
// one per agent, each agent as the real git author, signed ids in `Hivecode-Author:` trailers,
// files with no verified receipt refused rather than committed. A reviewer would have had every
// reason to trust it.
//
// Diffed against the branch it was cut from:
//
//     hive-linear.js               -77
//     tests/hive-linear-test.mjs  -114
//     tests/hive-mcp-http-test.mjs -49
//     tests/hive-governor-test.mjs -32
//     sync.js                      -39
//
// It deleted the HIV-27 claim guard, deleted the HIV-14 truncation fix, deleted ~200 lines of
// tests, and restored the 10x dashboard bug -- the one where thirty minutes of runtime displays
// as 3.0. Filed HIV-28.
//
// THE CAUSE IS ONE LINE. hive-pr.js did `fs.copyFileSync(f.abs, dest)` and then `git add`. It
// treats the room as truth and writes it over the branch. Grepping that file for `ahead`,
// `behind`, `stale`, `diverged`, `merge-base` or `rev-list` returned nothing: it never asked
// whether the branch had moved.
//
// This is not an exotic case, it is the NORMAL one. Any commit reaching the branch by another
// route puts it ahead -- a hotfix, a second developer, CI, or a human doing exactly the
// review-then-push workflow this tool exists to serve. In the measured incident the other route
// was me, working in the git checkout instead of my room folder.
//
// WHY "AHEAD/BEHIND" IS THE WRONG QUESTION. There is no merge-base between a Yjs room and a git
// branch; they are not two git histories. `git rev-list --count` cannot answer this, and reaching
// for it would produce a check that looks rigorous and measures nothing.
//
// THE QUESTION THAT IS ANSWERABLE, per file:
//
//               has the room ever SEEN what is currently on the branch?
//
// It can be answered exactly, from state that already exists. Every landed change appends a
// receipt carrying `parent` (the contentHash the author built on) and `contentHash` (the result),
// so a file's ledger IS a hash chain of every state the room has passed through. `provenanceOf()`
// already returns it -- hive-pr reads it for attribution and then ignores it for safety.
//
// If the branch's current bytes hash to something in that chain, the room descends from the
// branch and writing is continuing the line. If they do not, the branch holds a change the room
// has never seen, and writing would delete it. That is the whole check.

import { contentHash } from './substrate.js'

/** Nothing to write: the branch already holds exactly this. */
export const IDENTICAL = 'IDENTICAL'
/** The file is not on the branch at all, so there is nothing to revert. */
export const NEW = 'NEW'
/** The branch's bytes are in the room's chain: the room descends from them. Safe. */
export const DESCENDS = 'DESCENDS'
/** The branch holds bytes the room has never seen. REFUSE. */
export const DIVERGED = 'DIVERGED'
/** The room has no chain for this file, so nothing can be proved either way. REFUSE. */
export const UNPROVEN = 'UNPROVEN'

/** The only two states that may be written. A list, so widening it is a visible edit. */
export const WRITABLE = [NEW, DESCENDS]

/**
 * LINE ENDINGS ARE PRESENTATION, AND ON THIS REPO THEY DIFFER BY DEFAULT.
 *
 * Measured here: `hive-mcp.js` and `sync.js` are CRLF in the working tree and LF in the blob,
 * because `core.autocrlf` is true. So the bytes git stored and the bytes the room holds are not
 * equal for most files in this project, while the file is by any useful definition the same file.
 *
 * A byte comparison would therefore mark nearly everything DIVERGED and refuse every run. That is
 * worse than no check: a guard that fires on the HEALTHY path is the one that gets a `--force`
 * alias in somebody's shell history within a week, and then it is not a guard at all.
 *
 * So both the equality test and the chain lookup are done modulo line endings. Three variants, not
 * a normalisation, because the chain's hashes were computed by substrate.js over whatever text the
 * room actually held at the time -- there is no single canonical form to normalise TO.
 */
const variants = (t) => {
  const lf = String(t).replace(/\r\n/g, '\n')
  return [String(t), lf, lf.replace(/\n/g, '\r\n')]
}

/** Same file, ignoring how the lines end. */
export const sameText = (a, b) =>
  a != null && b != null && String(a).replace(/\r\n/g, '\n') === String(b).replace(/\r\n/g, '\n')

/**
 * Every content state this file has passed through in the room.
 *
 * Both fields go in. `parent` is the state an author BUILT ON -- which may be a state no receipt
 * ever produced, because the first write's parent is the hash of the empty string and a rejoin
 * can land on a state whose own receipt lives on another peer. Taking only `contentHash` would
 * miss exactly those, and each miss reads as DIVERGED: a refusal on a healthy file, which is the
 * failure mode that gets a safety check disabled.
 */
export function chainOf(receipts) {
  const seen = new Set()
  for (const r of receipts || []) {
    if (!r) continue
    if (r.parent) seen.add(r.parent)
    if (r.contentHash) seen.add(r.contentHash)
  }
  return seen
}

/**
 * Decide whether the room's copy may be written over the branch's.
 *
 * `branchText` is null when the path does not exist on the branch. It must be the RAW blob --
 * read with `git cat-file blob`, never `git show` through a working tree, or a checkout with
 * `core.autocrlf` hands back bytes git never stored and every hash misses.
 */
export function accountFor({ rel, branchText, roomText, receipts }) {
  if (branchText == null) return { rel, state: NEW, why: 'not on the branch yet — nothing can be reverted' }
  // Modulo line endings on purpose. A file that differs ONLY in how its lines end must not be
  // rewritten: it would produce a diff of every line in the file, for no change anybody made.
  if (sameText(branchText, roomText)) return { rel, state: IDENTICAL, why: 'the branch already holds this (line endings aside)' }

  const chain = chainOf(receipts)
  if (!chain.size) {
    return {
      rel, state: UNPROVEN,
      why: 'the room has no provenance chain for this file, so there is no way to tell whether its copy is newer than the branch or older',
    }
  }

  const hashes = variants(branchText).map(contentHash)
  if (hashes.some((h) => chain.has(h))) {
    return { rel, state: DESCENDS, why: 'the room has passed through the branch\'s current content, so its copy is a descendant' }
  }
  return {
    rel, state: DIVERGED, branchHash: hashes[0],
    why: 'the branch holds content this room has never seen — writing the room\'s copy would delete it',
  }
}

/** May this decision be written? Never inline `state !== DIVERGED` — that admits UNPROVEN. */
export const writable = (d) => WRITABLE.includes(d.state)

/**
 * The run-level verdict.
 *
 * ALL OR NOTHING, and that is the design. Committing the safe files and skipping the rest produces
 * a PR that looks complete and is not -- the same false success the tool already produced once,
 * one level up. A refusal a human can read beats a branch they have to audit.
 */
export function verdict(decisions) {
  const blocked = decisions.filter((d) => !writable(d) && d.state !== IDENTICAL)
  return {
    ok: blocked.length === 0,
    blocked,
    writable: decisions.filter(writable),
    identical: decisions.filter((d) => d.state === IDENTICAL),
  }
}

/**
 * What the operator reads. `lastTouch` is supplied by the caller (hive-pr runs the git command)
 * so this module stays pure and testable without a repository.
 *
 * It names the commit and the person, because "diverged" alone sends someone to `git log` to work
 * out whether this is their own forgotten hotfix or somebody else's live work -- and that lookup
 * is the moment a tired operator reaches for --force.
 */
export function explain(blocked, lastTouch = () => '') {
  // Q506, the next free code in hive-pr's own Q500-Q505 block. Q443 would have read naturally
  // here -- it is the other "you are being handed an incomplete picture" refusal -- and it is
  // already the Linear truncation code. Two meanings behind one code is the duplicated-wire
  // -contract defect wearing a three-digit hat.
  const lines = ['Q506 REFUSING TO WRITE — the branch has moved under these files:', '']
  for (const d of blocked) {
    const touch = lastTouch(d.rel)
    lines.push(`  ${d.rel}`)
    lines.push(`      ${d.why}`)
    if (touch) lines.push(`      last changed on the branch by: ${touch}`)
  }
  lines.push('')
  lines.push('Nothing was written and no branch was created. Writing the room\'s copy over these')
  lines.push('would silently revert whatever reached the branch another way — a hotfix, a second')
  lines.push('developer, CI, or your own work done outside the room. That has happened once on this')
  lines.push('project and the resulting PR looked perfect.')
  lines.push('')
  lines.push('Fix it one of two ways:')
  lines.push('  - bring the branch\'s version INTO the room (edit it there, or hive_edit it), so the')
  lines.push('    room\'s copy descends from what is on the branch. Then run this again.')
  lines.push('  - --force "<reason>" if you have decided the room\'s copy should win. The reason is')
  lines.push('    recorded in the PR body, because somebody will ask.')
  return lines.join('\n')
}
