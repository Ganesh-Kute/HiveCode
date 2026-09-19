// pr-staleness: hive-pr must not write over a branch change it cannot account for.
//
//   node tests/pr-staleness-test.mjs
//
// THE INCIDENT, replayed in section A. On 19 Sep 2026 hive-pr produced a PR with three clean
// per-agent commits, real git authorship and signed trailers -- and it deleted the HIV-27 claim
// guard, the HIV-14 truncation fix and ~200 lines of tests, restoring the 10x dashboard bug. It
// looked perfect. The cause was one line with no check in front of it.
//
// THE TWO ASSERTIONS THAT CARRY THE DESIGN, and they pull against each other on purpose:
//
//   B2  a room that HAS seen the branch's content may write        (or the tool is useless)
//   A3  a room that has NOT seen it may not                        (or the tool is dangerous)
//
// A check that only does one of those is easy and worthless. Refusing everything is safe and
// stops anyone shipping a PR; allowing everything is what shipped and cost four tickets. The
// whole value is in the line between them, and the line is drawn by the receipt chain.
//
// Section D is the third one: UNPROVEN is not DIVERGED and not writable either. A file the room
// cannot prove anything about must not be written on the grounds that it is "not diverged" --
// that is absence-rendered-as-a-value, and `writable()` exists as a function so no call site can
// re-derive it as `state !== DIVERGED`.

import { contentHash } from '../substrate.js'
import {
  chainOf, accountFor, writable, verdict, explain,
  IDENTICAL, NEW, DESCENDS, DIVERGED, UNPROVEN, WRITABLE,
  sameText,
} from '../hive-pr-staleness.js'

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

/** A receipt as substrate.js writes one: built ON `parent`, PRODUCING `contentHash`. */
const receipt = (fromText, toText, name = 'Claude') => ({
  author: 'id:' + name, name, parent: contentHash(fromText), contentHash: contentHash(toText), at: 1,
})

// ── A. THE REAL INCIDENT ──────────────────────────────────────────────────────
console.log('\n# A. the 19 Sep PR, replayed')
{
  // The room's copy of hive-linear.js was the version from before HIV-14 landed. Meanwhile the
  // branch had HIV-14 on it, committed from the git checkout rather than through the room. The
  // room has never seen the HIV-14 text: nothing in its chain hashes to it.
  const v0 = 'export function backlog() { return read() }\n'
  const roomText = 'export function backlog() { return read() /* room edit */ }\n'
  const branchText = 'export function backlog() { return readPaged() /* HIV-14 */ }\n'
  const receipts = [receipt('', v0), receipt(v0, roomText)]

  const d = accountFor({ rel: 'hive-linear.js', branchText, roomText, receipts })
  T('A1 the file is reported as DIVERGED, not written', d.state === DIVERGED, d.state)
  T('A2 the reason says the branch holds something the room never saw',
    /never seen/.test(d.why), d.why)
  T('A3 AND IT IS NOT WRITABLE — this is the assertion that would have saved four tickets',
    writable(d) === false)

  const v = verdict([d])
  T('A4 the RUN is refused, not just the file', v.ok === false)
  T('A5 the blocked file is named', v.blocked[0].rel === 'hive-linear.js')
}

// ── B. AND IT STILL HAS TO LET REAL WORK THROUGH ──────────────────────────────
console.log('\n# B. the normal case must not be refused')
{
  const v0 = 'export const a = 1\n'
  const v1 = 'export const a = 2\n'   // landed on the branch by a previous hive-pr run
  const v2 = 'export const a = 3\n'   // the room has since moved on

  // The room's chain passes THROUGH v1, so the room descends from what is on the branch.
  const receipts = [receipt('', v0), receipt(v0, v1), receipt(v1, v2)]
  const d = accountFor({ rel: 'a.js', branchText: v1, roomText: v2, receipts })
  T('B1 a room whose chain contains the branch content is DESCENDS', d.state === DESCENDS, d.state)
  T('B2 AND IT IS WRITABLE — without this the check is just a tool that never works',
    writable(d) === true)
  T('B3 the reason explains the relationship rather than just permitting it',
    /descendant/.test(d.why), d.why)
  T('B4 the run proceeds', verdict([d]).ok === true)
}

// ── C. the cheap cases ────────────────────────────────────────────────────────
console.log('\n# C. nothing to decide')
{
  const t = 'export const a = 1\n'
  const same = accountFor({ rel: 'a.js', branchText: t, roomText: t, receipts: [receipt('', t)] })
  T('C1 identical content is IDENTICAL, not DESCENDS — there is nothing to write',
    same.state === IDENTICAL, same.state)
  T('C2 and it does not block the run', verdict([same]).ok === true)
  T('C3 nor is it counted as something to write', verdict([same]).writable.length === 0)

  const fresh = accountFor({ rel: 'new.js', branchText: null, roomText: t, receipts: [receipt('', t)] })
  T('C4 a file not on the branch is NEW and writable — nothing can be reverted', fresh.state === NEW && writable(fresh))
}

// ── D. UNPROVEN IS NOT "FINE" ─────────────────────────────────────────────────
console.log('\n# D. no chain means no proof, and no proof means no write')
{
  const d = accountFor({ rel: 'x.js', branchText: 'a\n', roomText: 'b\n', receipts: [] })
  T('D1 a file with no provenance chain is UNPROVEN', d.state === UNPROVEN, d.state)
  T('D2 IT IS NOT WRITABLE — "not diverged" is not the same as "safe"', writable(d) === false)
  T('D3 and it blocks the run', verdict([d]).ok === false)
  T('D4 the reason says what cannot be determined, rather than asserting a fault',
    /no way to tell/.test(d.why), d.why)

  // writable() is a function precisely so this cannot be re-derived at a call site as
  // `state !== DIVERGED`, which would admit UNPROVEN and is the exact shape of
  // learnings/absence-rendered-as-a-value.md.
  T('D5 the writable set is exactly NEW and DESCENDS — widening it is a visible edit',
    WRITABLE.length === 2 && WRITABLE.includes(NEW) && WRITABLE.includes(DESCENDS))
  T('D6 UNPROVEN is not in it', !WRITABLE.includes(UNPROVEN))
}

// ── E. the chain ──────────────────────────────────────────────────────────────
console.log('\n# E. what counts as "the room has seen this"')
{
  const v0 = 'a\n', v1 = 'b\n', v2 = 'c\n'
  const chain = chainOf([receipt(v0, v1), receipt(v1, v2)])
  T('E1 both ends of every receipt are in the chain', chain.has(contentHash(v0)) && chain.has(contentHash(v2)))
  T('E2 including the intermediate state', chain.has(contentHash(v1)))
  T('E3 and nothing else', !chain.has(contentHash('never written\n')))

  // PARENTS MATTER ON THEIR OWN. A first write's parent is the hash of the empty string, and a
  // rejoin can land on a state whose own receipt lives on another peer. Indexing only
  // contentHash would miss those, and every miss reads as DIVERGED — a refusal on a healthy
  // file, which is how a safety check earns a --force alias and stops being run.
  const first = chainOf([receipt('', 'a\n')])
  T('E4 the empty-string parent of a first write is in the chain', first.has(contentHash('')))
  T('E5 so a room that started from an empty branch file is not falsely refused',
    accountFor({ rel: 'a.js', branchText: '', roomText: 'a\n', receipts: [receipt('', 'a\n')] }).state === DESCENDS)

  T('E6 a malformed receipt does not crash the chain', chainOf([null, {}, receipt('a\n', 'b\n')]).size === 2)
  T('E7 and no receipts at all is an empty chain, not a throw', chainOf(undefined).size === 0)
}

// ── E2. LINE ENDINGS ──────────────────────────────────────────────────────────
console.log('\n# E2. CRLF on disk, LF in the blob — the default on this repo')
{
  // MEASURED on this repository: hive-mcp.js and sync.js are CRLF in the working tree and LF in
  // the blob, because core.autocrlf is true. A byte comparison would mark nearly every file
  // DIVERGED and refuse every run -- a guard that fires on the healthy path, which is how a
  // safety check earns a --force alias and stops being a guard.
  const lf = 'export const a = 1\nexport const b = 2\n'
  const crlf = lf.replace(/\n/g, '\r\n')

  T('E2a the same file in two line-ending styles is IDENTICAL, not DIVERGED',
    accountFor({ rel: 'a.js', branchText: lf, roomText: crlf, receipts: [receipt('', crlf)] }).state === IDENTICAL)
  T('E2b and therefore is not rewritten — that diff would be every line in the file, for no change',
    verdict([accountFor({ rel: 'a.js', branchText: lf, roomText: crlf, receipts: [receipt('', crlf)] })]).writable.length === 0)

  // The chain's hashes were computed over whatever text the room actually held. A room working in
  // CRLF produces CRLF hashes, and the branch blob is LF, so the lookup must try both.
  const crlf2 = crlf.replace('= 2', '= 3')
  const chainCRLF = [receipt('', crlf), receipt(crlf, crlf2)]
  T('E2c A CRLF ROOM DESCENDING FROM AN LF BLOB IS RECOGNISED — without this the tool refuses everything on this repo',
    accountFor({ rel: 'a.js', branchText: lf, roomText: crlf2, receipts: chainCRLF }).state === DESCENDS)

  // And the mirror: an LF room whose chain is LF, against a CRLF blob.
  const lf2 = lf.replace('= 2', '= 3')
  T('E2d and the mirror case too', accountFor({ rel: 'a.js', branchText: crlf, roomText: lf2, receipts: [receipt('', lf), receipt(lf, lf2)] }).state === DESCENDS)

  // The check must not become blind while being tolerant: a REAL change is still caught, whatever
  // the line endings are.
  T('E2e A REAL CHANGE IS STILL DIVERGED — tolerance of line endings is not tolerance of content',
    accountFor({ rel: 'a.js', branchText: 'export const a = 99\r\n', roomText: lf2, receipts: [receipt('', lf), receipt(lf, lf2)] }).state === DIVERGED)
  T('E2f sameText compares content, not bytes', sameText(lf, crlf) === true && sameText(lf, lf.replace('1', '9')) === false)
}

// ── F. the refusal has to be readable ─────────────────────────────────────────
console.log('\n# F. what the operator reads')
{
  const d = accountFor({
    rel: 'hive-linear.js', branchText: 'new\n', roomText: 'old\n',
    receipts: [receipt('', 'old\n')],
  })
  const msg = explain([d], () => 'a1b2c3d Ganesh 2026-09-19 HIV-14 paginate the backlog')
  T('F1 it carries a Q-code', /^Q506 /.test(msg), msg.split('\n')[0])
  T('F2 it names the file', /hive-linear\.js/.test(msg))
  T('F3 IT NAMES THE COMMIT AND THE PERSON — without this the operator opens git log, and that is the moment they reach for --force',
    /a1b2c3d Ganesh/.test(msg))
  T('F4 it states plainly that nothing was written', /Nothing was written/.test(msg))
  T('F5 it gives the fix that keeps the work, before the one that discards it',
    msg.indexOf('bring the branch') < msg.indexOf('--force'))
  T('F6 --force requires a reason and says where it is recorded', /--force "<reason>"/.test(msg) && /recorded in the PR body/.test(msg))

  // A refusal with no Q-code and no commit is a refusal that gets retried, then forced.
  T('F7 the message is worth reading rather than a code', msg.length > 400)
}

// ── G. a realistic mixed run ──────────────────────────────────────────────────
console.log('\n# G. one bad file stops the run')
{
  const t = 'x\n'
  const ds = [
    accountFor({ rel: 'ok1.js', branchText: null, roomText: t, receipts: [receipt('', t)] }),
    accountFor({ rel: 'ok2.js', branchText: 'a\n', roomText: 'b\n', receipts: [receipt('a\n', 'b\n')] }),
    accountFor({ rel: 'same.js', branchText: t, roomText: t, receipts: [receipt('', t)] }),
    accountFor({ rel: 'bad.js', branchText: 'theirs\n', roomText: 'mine\n', receipts: [receipt('', 'mine\n')] }),
  ]
  const v = verdict(ds)
  T('G1 three files are fine', v.writable.length === 2 && v.identical.length === 1)
  T('G2 ONE BAD FILE REFUSES THE WHOLE RUN — a partial PR looks complete and is not',
    v.ok === false && v.blocked.length === 1 && v.blocked[0].rel === 'bad.js')
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
