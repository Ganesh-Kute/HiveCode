// HIV-P4: A MEMBER NAME THAT CANNOT BE ADDRESSED IS NOT A NAME.
//
//   node tests/name-validation-test.mjs
//
// WHY THIS EXISTS. On 20 Sep 2026 an agent joined room `night` as "antigravity 1". Every message
// sent to it failed to route: mentionedNames splits on /@([\w-]+)/g, so "@antigravity 1" is read
// as "@antigravity", and no such member existed. Its mail, its obligations and its wake-on-mention
// were all silently dead. It only saw anything because it happened to be reading the chat log.
// Nothing errored. The room reported "@antigravity is NOT in the room" — which was true, and
// useless, because the member WAS in the room under a name the parser cannot produce.
//
// THE FIX IS NOT "STRIP SPACES". Two fixes were rejected with reasons, and the reasons are the
// design:
//
//   Resolve @mentions against the live member list -> REJECTED. mentionedNames is a pure function
//   run over historical transcripts. Resolving against who is present NOW means a departed member
//   breaks the past: a fact about history decided by the present. Same defect class as the
//   receipts work in HIV-P2.
//
//   Normalise "antigravity 1" -> "antigravity-1" at join -> REJECTED. If "coder 1" and "coder-1"
//   both normalise to one string, two distinct processes silently become one participant, merging
//   awareness, cursors and mailbox state with nobody told. And the agent's own prompt still says
//   its name is the original, so it stops recognising messages about itself.
//
// WHAT IS LEFT is to refuse at the door, and the argument for it is arithmetic rather than taste:
// the extractor already only recognises [\w-]+. A name outside that charset CANNOT be produced by
// mentionedNames, no matter how carefully the sender writes it. Constraining names to the charset
// the parser already uses makes the two mathematically consistent instead of coincidentally
// agreeing.
//
// SECTION B IS THE POINT OF THIS FILE. Everything else is examples; B is the property. And C
// exists because a "validator" that made every name addressable by making every name match
// EVERYTHING would satisfy a naive round-trip and destroy the room.

import { mentionsName, mentionedNames, mentionsAll } from '../hive-mailbox.js'

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// The function under test does not exist yet. Importing it statically would kill the whole file
// with a module error and section C — which tests code that ALREADY exists and must keep working —
// would never run. A missing implementation must fail the assertions that need it and nothing else.
let validateMemberName = null
try {
  ({ validateMemberName } = await import('../hive-mailbox.js'))
} catch { /* module itself is broken; section A will say so */ }
const HAVE = typeof validateMemberName === 'function'

console.log('\n# A. the validator refuses what cannot be addressed')
if (!HAVE) {
  T('A0 validateMemberName is exported from hive-mailbox.js', false,
    'NOT IMPLEMENTED YET — this is the red target for HIV-P4. Sections A and B cannot run.')
} else {
  const ok = (n) => { const r = validateMemberName(n); return r && r.ok === true }
  const no = (n) => { const r = validateMemberName(n); return r && r.ok === false }

  T('A1 ordinary names are accepted', ['Claude', 'DeepMind-Agent', 'antigravity_1', 'agent-42', 'a'].every(ok))
  T('A2 A NAME WITH A SPACE IS REFUSED — this is the incident', no('antigravity 1'))
  T('A3 leading and trailing whitespace is refused, not trimmed',
    no(' Claude') && no('Claude ') && no('  Claude  '))
  T('A4 tabs and newlines are refused', no('Agent\t1') && no('Agent\n2'))
  T('A5 empty, whitespace-only, null and undefined are refused',
    no('') && no('   ') && no(null) && no(undefined))
  T('A6 characters outside [\\w-] are refused, including @ itself',
    ['agent@domain', 'agent#1', 'agent.test', 'agent:bot', 'a/b', 'a b'].every(no))

  // A refusal nobody can act on gets worked around. The message has to say what to type instead.
  const r = validateMemberName('antigravity 1')
  T('A7 the refusal is ACTIONABLE — it carries a usable replacement, not just a complaint',
    !!(r && r.suggested && /^[\w-]+$/.test(r.suggested)), r && r.suggested)
  T('A8 and it explains WHY, in terms of what breaks, not in terms of a regex',
    !!(r && typeof r.error === 'string' && r.error.length > 40 && /@|mention|address|route|mail/i.test(r.error)),
    r && r.error)

  // A9 EXISTS BECAUSE A RED CHECK FOUND A3, A4 AND A8 TO BE VACUOUS.
  // Disabling the whitespace branch entirely left all 21 assertions green, because /^[\w-]+$/
  // already rejects a space -- the branch changes only the MESSAGE. So "whitespace is refused"
  // was being proved by the charset check, and the specific, more useful diagnosis could have
  // been deleted without a single test noticing. The message IS the feature here: "contains
  // whitespace" tells you what to fix, "contains invalid characters" makes you hunt for which
  // character. This pins the diagnosis, not just the refusal.
  T('A9 a whitespace name is diagnosed AS whitespace, not as a generic bad character',
    /whitespace|space/i.test((r && r.error) || ''), r && r.error)
  const tabbed = validateMemberName('Agent\t1')
  T('A9b and so is a tab, which is the same defect wearing a different character',
    /whitespace|space/i.test((tabbed && tabbed.error) || ''), tabbed && tabbed.error)
}

// ── B. THE PROPERTY. ─────────────────────────────────────────────────────────
// "Every valid name is addressable" is a claim about ALL names, and four hand-picked examples do
// not test a claim about all names. These are generated, and deliberately clustered at the edges
// of the charset, because that is where a grammar breaks -- not in the middle.
console.log('\n# B. EVERY VALID NAME CAN BE ADDRESSED (the property, not examples)')
{
  const NAMES = [
    'a', 'Z', '7', '_', // single characters, including the two that are not letters
    'bot', 'Bot', 'BOT', // case-only differences, which must stay distinct members
    'bot-1', 'bot_1', 'bot-1-2', // separators, including repeated
    'PM', 'PM-Claude', 'Hermes', 'Hermes-2', // the real pairs the existing suite pins
    'agent-', 'agent_', '-agent', '_agent', // leading and trailing separators
    'a'.repeat(64), // long
    'DeepMind-Agent', 'Antigravity1', 'Claude', 'Ganesh', 'WakeListener', // tonight's actual room
  ]
  // Every two-character combination of the charset, so nothing in the alphabet is untested.
  const CHARSET = 'abzABZ019_-'
  for (const x of CHARSET) for (const y of CHARSET) NAMES.push(x + y)

  const valid = HAVE ? NAMES.filter((n) => validateMemberName(n).ok) : NAMES.filter((n) => /^[\w-]+$/.test(n))
  console.log(`       (${valid.length} generated names under test${HAVE ? '' : ' — validator absent, using the target grammar'})`)

  // Case is the trap here: mentionsName matches case-INSENSITIVELY (hive-mailbox.js:34 uses /i)
  // while mentionedNames returns the string AS TYPED. A round-trip comparing them exactly would
  // fail for a reason that has nothing to do with addressability.
  const notExtracted = valid.filter((n) => {
    const got = mentionedNames(`please look at this @${n} when you can`)
    return !got.some((g) => g.toLowerCase() === n.toLowerCase())
  })
  T('B1 EVERY VALID NAME IS EXTRACTED FROM A MESSAGE THAT ADDRESSES IT',
    notExtracted.length === 0, notExtracted.slice(0, 6).join(', '))

  const notMatched = valid.filter((n) => !mentionsName(`please look at this @${n} when you can`, n))
  T('B2 AND EVERY VALID NAME MATCHES ITSELF',
    notMatched.length === 0, notMatched.slice(0, 6).join(', '))

  // The incident, stated as the property failing.
  T('B3 the name from the incident fails the property, which is why it must be refused at the door',
    !mentionedNames('hello @antigravity 1 please review').includes('antigravity 1'),
    `extracted instead: ${JSON.stringify(mentionedNames('hello @antigravity 1 please review'))}`)
}

// ── C. THE INVERSE. ──────────────────────────────────────────────────────────
// A validator could make every name addressable by making every name match everything. That would
// pass section B perfectly and deliver every message to every agent. These assertions are the
// reason B is not sufficient on its own, and they test code that already ships.
console.log('\n# C. AND NO NAME MATCHES A MESSAGE THAT DOES NOT ADDRESS IT')
{
  T('C1 @PM does not swallow PM-Claude', !mentionsName('@PM look at this', 'PM-Claude'))
  T('C2 @Hermes does not match Hermes-2', !mentionsName('@Hermes ping', 'Hermes-2'))
  T('C3 @Hermes-2 does not match Hermes', !mentionsName('@Hermes-2 ping', 'Hermes'))
  T('C4 a bare name with no @ addresses nobody', !mentionsName('Hermes owns that file', 'Hermes'))

  // Generated prefix pairs: for every name N, "@N" must not reach the member called "N-1".
  const BASES = ['bot', 'agent', 'a', 'Claude', 'PM']
  const bleeding = BASES.filter((b) => mentionsName(`@${b} please look`, `${b}-1`))
  T('C5 FOR EVERY GENERATED PAIR, @N DOES NOT REACH N-1',
    bleeding.length === 0, bleeding.join(', '))

  const alsoBleeding = BASES.filter((b) => mentionsName(`@${b}-1 please look`, b))
  T('C6 and @N-1 does not reach N', alsoBleeding.length === 0, alsoBleeding.join(', '))

  T('C7 case does not change who is addressed — @bot reaches BOT',
    mentionsName('@bot ping', 'BOT') && mentionsName('@BOT ping', 'bot'))
}

// ── D. WHAT THIS TICKET DOES NOT FIX. ────────────────────────────────────────
// Asserted rather than written in a comment, because a comment saying "P4 does not close this"
// gets read once and forgotten, and six weeks later somebody reads "names fixed" as "mentions
// fixed". A passing test that documents a known hole is harder to lose than a paragraph.
console.log('\n# D. STILL EXTRACTED AFTER HIV-P5 — and that is now the decision, not the bug')
{
  // UPDATED AFTER HIV-P5 LANDED. These three were written as evidence of an open defect. P5 then
  // shipped, and they still pass -- deliberately, which is why the heading changed rather than the
  // assertions. Quote characters were KEPT as valid mention boundaries on purpose: excluding them
  // would silently drop a real mention that opens a quoted sentence ("@Claude, can you look?"),
  // and a dropped mention is the worse failure, because the sender believes it was delivered.
  //
  // What P5 changed is not whether these are EXTRACTED but whether they cost anything. A quoted
  // name is extracted for the transcript and creates no debt, because obligationTargets gates on
  // membership and hive-obligations expires a never-seen record on its own. The noise these used
  // to produce -- 44 open obligations, 32% of them permanent -- is gone without dropping a single
  // real address.
  //
  // Left as passing assertions because the behaviour is load-bearing and un-obvious. Anyone who
  // "fixes" quoted mentions later will fail these and have to read why first.
  T('D1 a name QUOTED inside a sentence is still extracted as a real address',
    mentionedNames('the parser reads "@antigravity 1" as "@antigravity"').includes('antigravity'))
  T('D2 @all written as an EXAMPLE still broadcasts to the whole room',
    mentionsAll('what happens to a message addressed to @all?'))
  T('D3 names quoted from a test suite are delivered to people who do not exist',
    mentionedNames('the suite pins that @PM does not match @Hermes-2').length === 2)
  console.log('       ^ all three still extract, ON PURPOSE. A quoted mention is shown in the transcript')
  console.log('       and creates no debt: HIV-P5 gates obligations on membership and expires never-seen')
  console.log('       records by themselves. Dropping these would silently lose real quoted mentions.')
}

console.log(`\n=== HIV-P4 NAME VALIDATION: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
