// HIV-P6: THE ROOM ALREADY KNOWS NOBODY WILL ANSWER, AND RECORDS A DEBT ANYWAY.
//
//   node tests/non-answerable-test.mjs
//
// WHY THIS EXISTS, and it is not an argument — it is a transcript. On 20 Sep 2026 the message that
// DESIGNED this ticket demonstrated it while sending. One hive_say opened four obligations:
//
//   Antigravity1   the only real one
//   Ganesh         a human who does not read this room's chat
//   WakeListener   a listener process that has never authored a message
//   X              extracted from the author QUOTING the string "@X is NOT in the room"
//
// Three of four were junk, from a message whose subject was junk obligations. The fourth is the
// sharpest: @X exists only inside a quotation of the room's own warning about names that do not
// exist. The room printed "⚠ @X — NOT IN THIS ROOM. Nobody by that name is here, so nobody is
// going to answer" and, in the same tool result, printed "YOU ARE OWED AN ANSWER — ob_..._X".
//
// SECTION A IS THE POINT OF THIS FILE, and it needs no new concepts at all. Two code paths in one
// response say opposite things about the same message. Whatever is decided about behavioural
// classification, this is already incoherent on HEAD today:
//
//     IF THE ROOM CAN SAY "NOBODY WILL ANSWER THIS", IT MUST NOT ALSO RECORD THAT SOMEBODY OWES IT.
//
// SECTION D IS THE ADVERSARIAL HALF, and it exists to attack the proposed fix rather than confirm
// it. The builder's design uses a five-minute freshness window: a member who has joined, never
// spoken, and lingered past the window is treated as non-answering. An agent mid-task looks exactly
// like that. hive_busy exists precisely because agents go quiet while working, and the room's own
// rules tell them to. So D asserts the cases where the fix must NOT fire — a busy agent, a fresh
// joiner, and a human who does answer. If the implementation cannot satisfy A and D together, the
// window is the wrong mechanism and the ticket needs a different one.
//
// EVERYTHING RUNS THROUGH THE REAL TOOLS ON A REAL RELAY. hive-obligations.js is pure and already
// has a unit suite; proving the predicate again would prove nothing. The claim here is that an
// AGENT gets the behaviour, which is a different claim — the same distinction obligations-e2e-test
// draws, and the same one HIV-27 was about: a guard that was correct and unwired refused nothing.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import * as OB from '../hive-obligations.js'

const PORT = Number(process.env.HIVE_TEST_PORT) || (28000 + (process.pid % 9000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-p6-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'p6-' + crypto.randomBytes(6).toString('hex')
const mkdir = (n) => {
  const d = path.join(tmp, n)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, '.gitignore'), '/*\n!/.gitignore\n!/notes.md\n')
  fs.writeFileSync(path.join(d, 'notes.md'), 'x\n')
  return d
}
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

/** Open obligations aimed at `who`, read from the live doc the way hive_owed reads it. */
const owedBy = (hive, who) =>
  OB.openList(hive.doc.getMap('obligations'))
    .filter((r) => String(r.to).toLowerCase() === String(who).toLowerCase())

try {
  const A = await import('../hive-mcp.js')
  const B = await import('../hive-mcp.js?p6b')

  await A._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: mkdir('asker'), name: 'Asker', owner: 'test' })
  await B._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: mkdir('answerer'), name: 'Answerer', owner: 'test' })
  await sleep(2000)

  // Answerer speaks once, so it has authorship history. Everything in section B and D depends on
  // the difference between "has spoken here" and "has not", so it has to be established, not assumed.
  await B._test.callTool('hive_say', { text: 'Answerer is here and talking.' })
  await sleep(1200)

  const hiveA = A._test.getSession().hive

  // ── A. THE INCOHERENCE THAT EXISTS TODAY. ──────────────────────────────────
  // No new state, no new concept, no timer. The room already computes "nobody by that name is
  // here" and prints it. It must not simultaneously record a debt against that name.
  console.log('\n# A. THE ROOM MUST NOT WARN AND RECORD IN THE SAME BREATH')
  {
    const out = textOf(await A._test.callTool('hive_say', {
      text: 'quoting the room at @Nobody7 to see what happens', needsReply: true,
    }))
    await sleep(800)

    const warned = /NOT IN THIS ROOM|is NOT in the room/i.test(out)
    T('A1 the room DOES warn that the name is not present', warned, warned ? '' : out.slice(0, 120))

    const debts = owedBy(hiveA, 'Nobody7')
    T('A2 AND IT OPENS NO OBLIGATION FOR THE NAME IT JUST WARNED ABOUT',
      debts.length === 0, debts.length ? `${debts.length} opened: ${debts[0].id}` : '')

    T('A3 the response does not both warn and announce a debt for the same name',
      !(warned && new RegExp(`YOU ARE OWED[^]*Nobody7`, 'i').test(out)),
      warned ? '' : '(A1 failed, so this is vacuous)')
  }

  // ── B. A NAME QUOTED FROM A WARNING IS NOT AN ADDRESSEE. ───────────────────
  // The exact incident: pasting the room's own error text into a message about that error.
  console.log('\n# B. THE INCIDENT THAT FILED THIS TICKET, REPLAYED')
  {
    await A._test.callTool('hive_say', {
      text: 'design note: the room prints "@X is NOT in the room" and we should handle that', needsReply: true,
    })
    await sleep(800)
    const debts = owedBy(hiveA, 'X')
    T('B1 quoting "@X is NOT in the room" does not open a debt against X',
      debts.length === 0, debts.length ? `opened ${debts.length}` : '')
  }

  // ── C. A MEMBER THAT DECLARES ITSELF PASSIVE. ──────────────────────────────
  // @WakeListener knows what it is. A process that cannot take turns should be able to say so,
  // and the room should believe it. This is the only part of P6 that needs a new field.
  console.log('\n# C. A DECLARED LISTENER IS NOT A DEBTOR')
  {
    const C = await import('../hive-mcp.js?p6c')
    await C._test.callTool('hive_join', {
      link: `ws://localhost:${PORT}|${room}`, dir: mkdir('listener'), name: 'Listener', owner: 'test', passive: true,
    })
    await sleep(1800)

    const out = textOf(await A._test.callTool('hive_say', { text: '@Listener please confirm', needsReply: true }))
    await sleep(800)

    const debts = owedBy(hiveA, 'Listener')
    T('C1 no obligation is opened against a member that joined passive',
      debts.length === 0, debts.length ? `opened ${debts.length}` : '')
    T('C2 and the asker is TOLD why, at send time, not in ten minutes',
      /passive|listener|does not answer|will not answer/i.test(out), out.split('\n').slice(-3).join(' ').slice(0, 140))
  }

  // ── D. THE INVERSE. THIS IS WHERE THE FIX GETS IT WRONG. ───────────────────
  // A check that stops recording debts is only useful if it still records the real ones. Every
  // assertion here is a case where the feature must NOT fire, and D1 is the one that breaks a
  // freshness-window implementation: an agent that joined, called hive_busy, and is working is
  // silent for exactly the same observable reasons a dead listener is.
  console.log('\n# D. AND IT STILL RECORDS EVERY REAL DEBT')
  {
    const D = await import('../hive-mcp.js?p6d')
    await D._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: mkdir('busy'), name: 'Busy', owner: 'test' })
    await D._test.callTool('hive_busy', { what: 'mid-refactor, back shortly' })
    await sleep(1800)

    await A._test.callTool('hive_say', { text: '@Busy can you look at this when you surface', needsReply: true })
    await sleep(800)
    T('D1 A BUSY AGENT THAT HAS NOT SPOKEN YET STILL OWES A REAL ANSWER',
      owedBy(hiveA, 'Busy').length === 1,
      'a mid-task agent is silent for the same reasons a dead one is — this is the false positive that matters')

    await A._test.callTool('hive_say', { text: '@Answerer one question please', needsReply: true })
    await sleep(800)
    T('D2 a member that has spoken here is completely unaffected',
      owedBy(hiveA, 'Answerer').length === 1)

    // The human case. Nothing about P6 may make a participating human a second-class member —
    // the product is five humans each driving an AI, and in that room humans answer constantly.
    const H = await import('../hive-mcp.js?p6h')
    await H._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: mkdir('human'), name: 'Dev', owner: 'test', kind: 'human' })
    await sleep(1500)
    await H._test.callTool('hive_say', { text: 'Dev here, reading.' })
    await sleep(1000)
    await A._test.callTool('hive_say', { text: '@Dev could you review this', needsReply: true })
    await sleep(800)
    T('D3 A HUMAN WHO PARTICIPATES IS TREATED EXACTLY LIKE AN AGENT',
      owedBy(hiveA, 'Dev').length === 1,
      'kind:human must never be the discriminator — that would break the actual product')

    // D4/D5 ADDED AFTER THE FIRST IMPLEMENTATION WENT GREEN AT 13/13, because 13/13 was honest and
    // this suite simply never asked. D1 covers a member that is PRESENT and quiet; D2 one that
    // spoke and STAYED. Neither covers the case HIV-P5 Part C exists for: a member that spoke here
    // and then LEFT.
    //
    // That is not a hypothetical. @DeepMind-Agent was rate-limited for ninety minutes tonight, came
    // back, and answered. A gate that keys on current presence alone cannot tell it apart from a
    // name that never existed — and the debt is not expired, it is never recorded. Measured on
    // 6bc00ef: zero obligations for a teammate that had authored in the room two seconds earlier.
    //
    // PRESENCE ANSWERS "is anyone reading right now". PROVENANCE ANSWERS "is this a real teammate
    // who stepped away". Conflating them is the whole defect, in both directions.
    const G = await import('../hive-mcp.js?p6g')
    await G._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: mkdir('gone'), name: 'Gone', owner: 'test' })
    await sleep(1600)
    await G._test.callTool('hive_say', { text: 'Gone here, picking up a ticket.' })
    await sleep(1200)
    await G._test.callTool('hive_leave', {})
    await sleep(2500)

    const awayOut = textOf(await A._test.callTool('hive_say', { text: '@Gone did that land?', needsReply: true }))
    await sleep(900)
    const awayDebts = owedBy(hiveA, 'Gone')
    T('D4 A MEMBER THAT SPOKE HERE AND THEN LEFT STILL OWES A REAL ANSWER',
      awayDebts.length === 1,
      awayDebts.length === 0 ? 'ZERO recorded — a known teammate is being treated as a name that never existed' : '')
    T('D4b and that debt is not flagged never-seen, because it was seen',
      awayDebts.length === 1 && awayDebts[0].neverSeen === false,
      awayDebts.length ? `neverSeen=${awayDebts[0].neverSeen}` : '(no debt to inspect)')
    T('D5 and the asker is told it is AWAY, not that nobody by that name exists',
      !/Nobody by that name is here/i.test(awayOut),
      'a member who authored a message moments ago is not a name that never existed')
  }

  // ── E. SILENT IS A LABEL, NOT A DELETION. ──────────────────────────────────
  // @Ganesh authored messages here and then stopped reading. His debt is REAL — somebody genuinely
  // owes an answer — and it will never arrive through this channel. Closing it loses information;
  // calling it "overdue" tells the asker to wait, which is the one thing that cannot work.
  console.log('\n# E. A DEBT NOBODY WILL ANSWER IS RE-LABELLED, NEVER DELETED')
  {
    const before = owedBy(hiveA, 'Answerer')
    T('E1 the real debt from D2 is still open and still owed', before.length === 1)
    T('E2 and it is still discharge-able ONLY by the asker',
      (() => {
        const r = OB.discharge(hiveA.doc.getMap('obligations'), { id: before[0] && before[0].id, by: 'Answerer' })
        return r && r.ok === false
      })(),
      'the debtor grading its own homework is the check the whole ledger exists to make')
  }

  // ── F. ANTI-VACUITY. ───────────────────────────────────────────────────────
  // Every assertion above is of the form "this thing did NOT happen", and the cheapest way to
  // satisfy all of them is an implementation that opens no obligations at all. F proves the
  // measurement can see a debt when there is one to see.
  console.log('\n# F. THE MEASUREMENT IS NOT BLIND')
  {
    const all = OB.openList(hiveA.doc.getMap('obligations'))
    T('F1 the ledger is readable and non-empty, so the negative assertions above mean something',
      all.length > 0, `${all.length} open`)
    T('F2 owedBy() discriminates — it finds Answerer and not a name nobody used',
      owedBy(hiveA, 'Answerer').length > 0 && owedBy(hiveA, 'NeverUsedName').length === 0)
  }
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== HIV-P6 NON-ANSWERABLE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
