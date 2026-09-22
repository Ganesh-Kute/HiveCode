// HIV-P5: FALSE MENTIONS, CODE SPANS, AND OBLIGATION NOISE
//
//   node tests/mention-boundary-test.mjs
//
// WHY THIS EXISTS. On 20 Sep 2026, 32% of open obligations in room "night" were
// permanent noise caused by emails, scoped npm packages, and backticked examples.
// Writing about addressing was triggering addressing.
//
// A+C SYNTHESIS:
// Part A: Leading and trailing boundary matching in hive-mailbox.js
// Part C: The Three-State Obligation Lifecycle in hive-obligations.js & hive-mcp.js

import { mentionsName, mentionedNames, mentionsAll } from '../hive-mailbox.js'

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

console.log('\n# A. EMAILS AND INLINE PUNCTUATION MUST NOT EXTRACT AS MENTIONS')
{
  const emailMsg = 'email me at ganesh@gmail.com'
  const emailGot = mentionedNames(emailMsg)
  T('A1 email address does not extract domain as mention',
    emailGot.length === 0, `extracted instead: ${JSON.stringify(emailGot)}`)

  const blameMsg = 'blame line: author@example.org'
  const blameGot = mentionedNames(blameMsg)
  T('A2 git blame author does not extract as mention',
    blameGot.length === 0, `extracted instead: ${JSON.stringify(blameGot)}`)

  const mathMsg = 'cost is 5@$10 each'
  const mathGot = mentionedNames(mathMsg)
  T('A3 math/price notation does not extract as mention',
    mathGot.length === 0, `extracted instead: ${JSON.stringify(mathGot)}`)

  T('A4 email does not satisfy mentionsName for domain',
    !mentionsName(emailMsg, 'gmail'))
}

console.log('\n# B. SCOPED PACKAGES AND PATHS MUST NOT EXTRACT AS MENTIONS')
{
  const pkgMsg = 'npm i @modelcontextprotocol/sdk'
  const pkgGot = mentionedNames(pkgMsg)
  T('B1 scoped npm package does not extract scope name as mention',
    pkgGot.length === 0, `extracted instead: ${JSON.stringify(pkgGot)}`)

  T('B2 scoped package does not satisfy mentionsName for scope',
    !mentionsName(pkgMsg, 'modelcontextprotocol'))

  const pathMsg = 'see file at path/@scope/foo.js'
  const pathGot = mentionedNames(pathMsg)
  T('B3 nested repo path with @ does not extract as mention',
    pathGot.length === 0, `extracted instead: ${JSON.stringify(pathGot)}`)
}

console.log('\n# C. BACKTICK CODE SPANS MUST NOT BROADCAST')
{
  T('C1 @all inside inline code backticks does NOT broadcast',
    !mentionsAll('see `@all` in the docs'))

  T('C2 @all in backticks does not broadcast with surrounding text',
    !mentionsAll('what happens to `@all`?'))

  T('C3 raw @all DOES broadcast to the whole room',
    mentionsAll('hello @all please review'))
}

console.log('\n# D. NATURAL DIALOGUE AND LIST PUNCTUATION MUST EXTRACT AS MENTIONS')
{
  T('D1 start of string mention extracts',
    mentionedNames('@Claude please review').includes('Claude'))

  T('D2 whitespace preceded mention extracts',
    mentionedNames('hey @Claude please review').includes('Claude'))

  T('D3 markdown list item mention extracts',
    mentionedNames('- @Claude do this task').includes('Claude'))

  T('D4 em-dash preceded mention extracts',
    mentionedNames('ready—@Claude take a look').includes('Claude'))

  T('D5 colon preceded mention extracts',
    mentionedNames('Assignee: @Claude').includes('Claude'))

  T('D6 open paren preceded mention extracts',
    mentionedNames('assigned to (@Claude) today').includes('Claude'))

  T('D7 open bracket preceded mention extracts',
    mentionedNames('cc: [@Claude]').includes('Claude'))

  T('D8 dialogue double-quote opening extracts mention',
    mentionedNames('"@Claude, can you look?"').includes('Claude'))

  T('D9 dialogue single-quote opening extracts mention',
    mentionedNames('\'@Claude, can you look?\'').includes('Claude'))
}

console.log('\n# E. INVERSE PROPERTY: NO NAME MATCHES WITHOUT BEING ADDRESSED')
{
  T('E1 @PM does not swallow PM-Claude', !mentionsName('@PM look at this', 'PM-Claude'))
  T('E2 @Hermes does not match Hermes-2', !mentionsName('@Hermes ping', 'Hermes-2'))
  T('E3 @Hermes-2 does not match Hermes', !mentionsName('@Hermes-2 ping', 'Hermes'))
  T('E4 a bare name with no @ addresses nobody', !mentionsName('Claude owns that file', 'Claude'))
}

// ── F. THE THREE-STATE OBLIGATION LIFECYCLE (PART C) ─────────────────────────
//
// 1. NEVER-SEEN NAME (e.g. @Reviewer):
//    - Recorded at send-time (warning fires, sender told they are owed an answer).
//    - Auto-expires when now >= due (clears noise from the ledger automatically).
//    - Anyone can discharge before expiry (no debtor honesty to defend).
//    - Does NOT resurrect if a participant by that name later joins.
//
// 2. KNOWN, AWAY NOW (e.g. @DeepMind-Agent stepped out / rate-limited):
//    - Recorded at send-time.
//    - Does NOT auto-expire when now >= due — it persists and becomes overdue/stale.
//    - Strictly author-only discharge — debtor cannot close its own homework.
//
// 3. PRESENT MEMBER:
//    - Unchanged: author-only, persistent, backs off on knocks.

console.log('\n# F. THE THREE-STATE OBLIGATION LIFECYCLE (PART C)')
{
  const mkClock = (t0 = 1_700_000_000_000) => { let t = t0; return { now: () => t, advance: (ms) => (t += ms) } }
  const seq = () => { let i = 0; return () => ((i = (i + 0.137) % 1), i) }

  let OB = null
  try {
    OB = await import('../hive-obligations.js')
  } catch {}
  const HAVE_OB = !!OB

  if (!HAVE_OB) {
    T('F0 hive-obligations.js is available', false,
      'hive-obligations.js not present or allow-listed in lane yet')
  } else {
    const store = new Map()
    const clock = mkClock()
    const r = seq()

    // 1. NEVER-SEEN: Tester asks Reviewer (who has never been in the room)
    const obGhost = OB.open(store, {
      from: 'Tester',
      to: 'Reviewer',
      text: 'can you review?',
      dueMs: 60000,
      absent: true,
      neverSeen: true,
    }, clock.now, r)

    T('F1 never-seen debt is recorded at open time',
      OB.openList(store, clock.now).some((o) => o.id === obGhost.id))

    // Anyone can discharge an un-expired never-seen debt (no debtor honesty to protect)
    const testStore = new Map()
    const obDismissable = OB.open(testStore, {
      from: 'Tester',
      to: 'ghost-agent',
      text: 'status?',
      dueMs: 60000,
      absent: true,
      neverSeen: true,
    }, clock.now, r)
    const disResult = OB.discharge(testStore, { id: obDismissable.id, by: 'Claude' }, clock.now)
    T('F2 anyone can discharge a never-seen debt before expiry',
      disResult.ok === true && disResult.rec.done === true, disResult.reason)

    // 2. KNOWN, AWAY NOW: Claude asks DeepMind-Agent (who is a known member, but currently offline)
    const obTeammate = OB.open(store, {
      from: 'Claude',
      to: 'DeepMind-Agent',
      text: 'did test pass?',
      dueMs: 60000,
      absent: true,
      neverSeen: false, // KNOWN member, stepped away!
    }, clock.now, r)

    // Debtor (DeepMind-Agent) cannot close its own homework
    const selfDis = OB.discharge(store, { id: obTeammate.id, by: 'DeepMind-Agent' }, clock.now)
    T('F3 debtor cannot discharge known teammate debt',
      selfDis.ok === false)

    // Third party cannot close known teammate debt
    const thirdDis = OB.discharge(store, { id: obTeammate.id, by: 'Tester' }, clock.now)
    T('F4 third party cannot discharge known teammate debt (author-only holds)',
      thirdDis.ok === false)

    // Advance clock past dueMs (60s + 1ms)
    clock.advance(60001)

    // 3. AUTO-EXPIRATION ASSERTIONS:
    const active = OB.openList(store, clock.now)

    T('F5 never-seen debt AUTO-EXPIRED past dueMs',
      !active.some((o) => o.id === obGhost.id))

    T('F6 known teammate debt PERSISTS past dueMs (did not expire)',
      active.some((o) => o.id === obTeammate.id))

    T('F7 open list has EXACTLY 1 active debt (Claude -> DeepMind-Agent)',
      active.length === 1 && active[0].to === 'DeepMind-Agent')

    // 4. NO RESURRECTION: Reviewer later joins the room — expired debt stays done
    const lateJoinerDebt = store.get(obGhost.id)
    T('F8 an expired never-seen debt does NOT resurrect when member appears',
      lateJoinerDebt.done === true)
  }
}

console.log(`\n=== HIV-P5 MENTION BOUNDARY: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
