// receipts, end to end: two real agents, a real relay, and a message that is genuinely read.
//
//   node tests/receipts-e2e-test.mjs
//
// The unit suite proves the state machine. This proves the EVIDENCE is real -- that a cursor
// published by one process, crossing a relay, converging into another process's Yjs doc, actually
// flips a message from UNREAD to READ when and only when the other agent consumed it.
//
// That distinction is the whole ticket. A receipt system that is correct in a Map and wrong over a
// socket reports confidence it has not earned, which is worse than reporting nothing.
//
// B2 is the assertion that carries it: BEFORE Builder calls hive_wait the message reads UNREAD,
// and AFTER it reads READ. Nothing else in the room changed.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'

const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + ((process.pid + 7) % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-rc-e2e-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'rc-e2e-' + crypto.randomBytes(6).toString('hex')
const mkdir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.gitignore'), '/*\n!/.gitignore\n!/notes.md\n'); fs.writeFileSync(path.join(d, 'notes.md'), 'x\n'); return d }
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

try {
  const A = await import('../hive-mcp.js?rc=a')
  const B = await import('../hive-mcp.js?rc=b')

  await A._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: mkdir('claude'), name: 'Claude', owner: 't' })
  await B._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: mkdir('builder'), name: 'Builder', owner: 't' })
  await sleep(1800)

  // ── A. nothing to confirm yet ──────────────────────────────────────────────
  console.log('\n# A. before anything is addressed')
  const none = textOf(await A._test.callTool('hive_delivered', {}))
  T('A1 it says there is nothing to confirm rather than inventing a number', /nothing to confirm/.test(none), none.split('\n')[0])

  await A._test.callTool('hive_say', { text: 'ambient: starting on governor.js' })
  await A._test.callTool('hive_say', { text: '@all standup in five' })
  await sleep(500)
  const still = textOf(await A._test.callTool('hive_delivered', {}))
  T('A2 an ambient message and an @all create no receipt -- nobody promised to read those',
    /nothing to confirm/.test(still), still.split('\n')[0])

  // ── B. THE REAL THING ──────────────────────────────────────────────────────
  console.log('\n# B. addressed, then actually read')
  await A._test.callTool('hive_say', { text: '@Builder did HIV-13 change the minutes divisor?' })
  await sleep(900)

  const before = textOf(await A._test.callTool('hive_delivered', {}))
  T('B1 before Builder reads, it is UNREAD and honestly reported as 0 confirmed',
    /0\/1 confirmed READ/.test(before) && /Builder=UNREAD/.test(before), before.split('\n')[0])

  // Builder consumes its mail. This is the ONLY thing that changes.
  await B._test.callTool('hive_wait', { timeoutSeconds: 3 })
  await sleep(1200)

  const after = textOf(await A._test.callTool('hive_delivered', {}))
  T('B2 AFTER BUILDER READS IT, THE SENDER SEES READ -- a cursor crossed a real relay',
    /1\/1 confirmed READ/.test(after) && /Builder=READ/.test(after), after.split('\n')[0])
  T('B3 and the message text travels with the receipt', /divisor/.test(after))

  // ── C. UNKNOWN survives the round trip ─────────────────────────────────────
  console.log('\n# C. a recipient that publishes no read position')
  // Tester is not here at all, so this is UNREACHABLE -- the strongest form of "do not wait".
  await A._test.callTool('hive_say', { text: '@Tester please run the suite' })
  await sleep(800)
  const ghost = textOf(await A._test.callTool('hive_delivered', {}))
  T('C1 a message to someone not in the room is UNREACHABLE, never READ',
    /Tester=UNREACHABLE/.test(ghost), (ghost.match(/Tester=\w+/) || [''])[0])
  T('C2 THE HEADLINE DOES NOT COUNT IT AS DELIVERED', /1\/2 confirmed READ/.test(ghost), ghost.split('\n')[0])
  T('C3 and the reason is spelled out under the list', /Tester: .*not in the room/.test(ghost))

  // ── D. the sender's own read does not count ────────────────────────────────
  console.log('\n# D. you cannot confirm your own message')
  await A._test.callTool('hive_wait', { timeoutSeconds: 2 })
  await sleep(800)
  const selfRead = textOf(await A._test.callTool('hive_delivered', {}))
  T('D1 Claude reading the room does not turn Claude\'s own message to Tester into READ',
    /Tester=UNREACHABLE/.test(selfRead) && !/Tester=READ/.test(selfRead))

  // ── E. the cursor is genuinely shared, not local ───────────────────────────
  console.log('\n# E. the evidence lives in the room, not on one disk')
  const membersOfB = textOf(await B._test.callTool('hive_delivered', {}))
  T('E1 Builder can run the same query from its own process', typeof membersOfB === 'string' && membersOfB.length > 0)
  // Builder addressed nobody, so it has no receipts of its own -- which is itself the correct
  // answer and proves the query is per-sender, not a shared global list.
  T('E2 and sees ITS OWN sent messages only, not Claude\'s', /nothing to confirm/.test(membersOfB), membersOfB.split('\n')[0])

  // ── F. THE HEADLINE DEFECT, FOR REAL ───────────────────────────────────────
  console.log('\n# F. the relay dies and hive_say must stop saying "sent"')
  // Asserting this in a unit test only would be exactly the HIV-27 mistake: a predicate that is
  // correct and never reached. The relay is actually killed here.
  relay.kill()
  await sleep(2500)

  const offline = textOf(await A._test.callTool('hive_say', { text: '@Builder are you still there?' }))
  T('F1 WITH THE RELAY DEAD, hive_say REFUSES THE WORD "SENT"', /^NOT SENT/.test(offline), offline.split('\n')[0])
  T('F2 it says the bytes never left this machine', /local copy only/.test(offline))
  T('F3 it warns against hive_join, the "fix" that overwrites local edits', /do NOT call hive_join/.test(offline))
  T('F4 and it still reports the message body, so nothing is lost to the agent',
    /are you still there/.test(offline))

  const offReceipts = textOf(await A._test.callTool('hive_delivered', {}))
  T('F5 while offline NOTHING reads as READ, whatever the cursors say',
    !/=READ/.test(offReceipts) && /0\/\d+ confirmed READ/.test(offReceipts), offReceipts.split('\n')[0])
  T('F6 and the reason given is our own socket, not a claim about the other agent',
    /has not left this machine/.test(offReceipts))
} catch (e) {
  T('the suite ran without throwing', false, String((e && e.stack) || e))
} finally {
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== RECEIPTS E2E: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
