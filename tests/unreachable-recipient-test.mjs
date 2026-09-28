// UNREACHABLE RECIPIENT & SENDER WARNINGS (HIV-P11b)
//
//   node tests/unreachable-recipient-test.mjs
//
// THE DEFECT THIS SUITE GUARDS AGAINST.
// P11a taught the room how to answer "what state is that agent in" when someone calls
// hive_members. But a sender addressing an agent does not call hive_members first — they type
// `hive_say` and expect their question to be seen.
//
// If the recipient is PARKED (connected, but not in hive_wait and silent past the threshold),
// their process will NEVER wake up on its own. Every existing signal says they are connected,
// so today hive_say reports success, opens an obligation, and lets the sender wait in silence.
//
// At 23:00 that costs a night: the sender thinks work was handed off, the recipient is asleep,
// and the human returns in the morning to an idle team.
//
// TWO SENDER-SIDE INVARIANTS TESTED HERE:
//
//   1. hive_say must WARN AT SEND TIME when addressing a PARKED or GONE agent. The warning must
//      carry the consequence: "will not wake on its own — needs human prompt".
//   2. hive_owed must distinguish pending debts owed by active/waiting agents from debts owed
//      by PARKED or GONE agents (marking them [UNREACHABLE]). When a debtor wakes up, the tag
//      must disappear dynamically without re-opening or modifying the debt.
//
// All assertions drive REAL MCP tools against a REAL relay.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const PORT = Number(process.env.HIVE_TEST_PORT) || (24000 + (process.pid % 18000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ASK FOR 2.5 s, WAIT FOR WHAT THE ENGINE ACTUALLY USES. parkedAfterMs() clamps to a 5 s floor, so
// this suite used to wait ~4.9 s for a 5 s threshold and passed or failed on machine load: measured
// 29 Sep 2026, the same commit gave "ageMs 4980 -> WORKING" on one run and "5008 -> PARKED" on the
// next. The wait is now derived from the engine's own answer, so the two cannot drift apart again.
process.env.HIVE_PARKED_AFTER_MIN = String(2500 / 60000)
const { parkedAfterMs } = await import('../hive-activity.js')
const PARKED_MS = parkedAfterMs()

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-unreach-'))
const room = 'unreach-' + crypto.randomBytes(5).toString('hex')

const mkdir = (n) => {
  const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, '.gitignore'), '/*\n!/.gitignore\n!/notes.md\n')
  fs.writeFileSync(path.join(d, 'notes.md'), 'x\n')
  return d
}
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const url = (q) => `file:///${ROOT.replace(/\\/g, '/')}/hive-mcp.js${q}`
const link = `ws://localhost:${PORT}|${room}`

let A, B, W
try {
  A = await import(url('?asker'))     // Asker: sends messages, checks hive_owed
  B = await import(url('?subject'))   // Subject: works, parks, dies
  W = await import(url('?worker'))    // Worker: active in hive_wait (reachable control)

  await A._test.callTool('hive_join', { link, dir: mkdir('a'), name: 'Asker', owner: 't' })
  await B._test.callTool('hive_join', { link, dir: mkdir('b'), name: 'Subject', owner: 't' })
  await W._test.callTool('hive_join', { link, dir: mkdir('w'), name: 'Worker', owner: 't' })
  await sleep(2500)

  // Subject speaks once so it has provenance, then goes silent to enter PARKED.
  await B._test.callTool('hive_say', { text: 'Subject here, standing by.' })
  await sleep(600)

  // Worker enters blocking hive_wait so it is actively WAITING (reachable).
  // Drain mailbox first so it blocks for the full timeout.
  await W._test.callTool('hive_check', {})
  const workerWait = W._test.callTool('hive_wait', { timeoutSeconds: 25 })
  await sleep(1000)

  // Wait for Subject to exceed PARKED_MS
  await sleep(PARKED_MS + 800)

  // ─── A. hive_say WARNS AT SEND TIME WHEN ADDRESSING A PARKED AGENT ─────────────
  console.log('\n# A. send-time warning for parked recipient (no needsReply)')
  {
    const out = textOf(await A._test.callTool('hive_say', { text: '@Subject please review the draft' }))
    T('A1 hive_say warns that @Subject is PARKED at send time',
      /PARKED/i.test(out) && /Subject/i.test(out), out.slice(0, 140))
    T('A2 the warning states the consequence: will not wake without human prompt',
      /will not wake on its own/i.test(out) && /human/i.test(out), out.slice(0, 160))
    
    // CONTROL: addressing Worker (who is inside hive_wait) emits NO parked warning.
    const workerOut = textOf(await A._test.callTool('hive_say', { text: '@Worker check status' }))
    T('A3 CONTROL: addressing an agent in hive_wait does NOT warn parked',
      !/PARKED/i.test(workerOut), workerOut.slice(0, 120))
  }

  // ─── B. needsReply:true OPENS AN OBLIGATION AND PRESERVES THE WARNING ─────────
  console.log('\n# B. needsReply against parked recipient')
  {
    const out = textOf(await A._test.callTool('hive_say', {
      text: '@Subject can you verify HIV-123?', needsReply: true,
    }))
    const obMap = A._test.getSession().hive.doc.getMap('obligations')
    const subjectDebts = [...obMap.values()].filter((o) => !o.done && String(o.to).toLowerCase() === 'subject')

    T('B1 an obligation IS opened against the parked agent (preserved for when human prompts them)',
      subjectDebts.length >= 1, `${subjectDebts.length} open debts`)
    T('B2 and the response still warns that @Subject is PARKED',
      /PARKED/i.test(out) && /will not wake on its own/i.test(out), out.slice(0, 140))
    T('B3 and announces YOU ARE OWED AN ANSWER',
      /YOU ARE OWED AN ANSWER/i.test(out), out.slice(0, 120))
  }

  // ─── C. hive_owed DISTINGUISHES REACHABLE VS UNREACHABLE DEBTS ────────────────
  console.log('\n# C. hive_owed annotations')
  {
    // Also open an obligation against Worker
    await A._test.callTool('hive_say', { text: '@Worker please answer', needsReply: true })
    await sleep(600)

    const owedOut = textOf(await A._test.callTool('hive_owed', {}))
    const subjectLine = owedOut.split('\n').find((l) => l.includes('Subject owes Asker')) || ''
    const workerLine = owedOut.split('\n').find((l) => l.includes('Worker owes Asker')) || ''

    T('C1 debt owed by PARKED agent is annotated UNREACHABLE',
      /UNREACHABLE/i.test(subjectLine) && /PARKED/i.test(subjectLine), subjectLine)
    T('C2 debt owed by WAITING/WORKING agent is NOT annotated UNREACHABLE',
      !/UNREACHABLE/i.test(workerLine) && workerLine.length > 0, workerLine)

    // Also test hive_owed({ all: true })
    const allOut = textOf(await A._test.callTool('hive_owed', { all: true }))
    const allSubjectLine = allOut.split('\n').find((l) => l.includes('Subject owes Asker')) || ''
    T('C3 hive_owed with all:true also carries UNREACHABLE tag for parked debtor',
      /UNREACHABLE/i.test(allSubjectLine) && /PARKED/i.test(allSubjectLine), allSubjectLine)

    // DYNAMIC WAKE: Subject wakes up by calling a tool.
    await B._test.callTool('hive_say', { text: 'Subject is awake and working!' })
    await sleep(600)

    const recheckOwed = textOf(await A._test.callTool('hive_owed', {}))
    const subjectLineAwake = recheckOwed.split('\n').find((l) => l.includes('Subject owes Asker')) || ''
    T('C4 when debtor wakes up, UNREACHABLE annotation clears dynamically without altering debt',
      !/UNREACHABLE/i.test(subjectLineAwake) && subjectLineAwake.length > 0, subjectLineAwake)
  }

  // ─── D. DEBT OWED BY A DEPARTED (GONE) AGENT ──────────────────────────────────
  console.log('\n# D. debt owed by departed/crashed agent')
  {
    // Stop Subject's hive connection (simulating crash / laptop lid close)
    try { B._test.getSession().hive.stop() } catch { }
    await sleep(2500)

    // Sending to GONE agent warns AWAY / GONE
    const goneSayOut = textOf(await A._test.callTool('hive_say', { text: '@Subject are you still there?' }))
    T('D1 hive_say warns when addressing a departed (GONE/AWAY) teammate',
      /AWAY RIGHT NOW|GONE/i.test(goneSayOut), goneSayOut.slice(0, 140))

    const goneOwedOut = textOf(await A._test.callTool('hive_owed', {}))
    const subjectGoneLine = goneOwedOut.split('\n').find((l) => l.includes('Subject owes Asker')) || ''
    T('D2 hive_owed annotates debt owed by disconnected agent as UNREACHABLE (GONE)',
      /UNREACHABLE/i.test(subjectGoneLine) && /GONE/i.test(subjectGoneLine), subjectGoneLine)
  }

  try { await workerWait } catch { }
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const M of [A, B, W]) { try { M._test.getSession().hive.stop() } catch { } }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== HIV-P11b UNREACHABLE RECIPIENT: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
