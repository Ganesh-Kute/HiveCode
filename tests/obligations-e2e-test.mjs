// obligations, end to end through the REAL tools against a REAL relay.
//
//   node tests/obligations-e2e-test.mjs
//
// WHY THIS EXISTS SEPARATELY FROM obligations-test.mjs. That suite proves the predicate is right.
// This one proves an AGENT gets the behaviour -- which is a different claim, and assuming it
// follows from the first is precisely the mistake HIV-27 was about: a guard that was correct and
// unwired refused nothing at all.
//
// Two real MCP sessions in two folders on one relay, driven through _test.callTool exactly as an
// agent drives them. Nothing is stubbed.
//
// The end-to-end assertion that matters is E4: Builder calls hive_wait and is TOLD it owes an
// answer, on a call it was going to make anyway. That is the whole mechanism -- the reminder costs
// no turn, because a blocked wait costs nothing and the knock rides it.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'

const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-ob-e2e-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'ob-e2e-' + crypto.randomBytes(6).toString('hex')
const mkdir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.gitignore'), '/*\n!/.gitignore\n!/notes.md\n'); fs.writeFileSync(path.join(d, 'notes.md'), 'x\n'); return d }

const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

try {
  // ONE MCP module holds ONE session, so the second agent runs as its own process-level import.
  // A cache-busting query string is the cheapest way to get a second, independent session in the
  // same test file -- two folders, two names, one relay, which is the shape being tested.
  const A = await import('../hive-mcp.js')
  const B = await import('../hive-mcp.js?agent=b')

  const dirA = mkdir('claude'), dirB = mkdir('builder')
  await A._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: dirA, name: 'Claude', owner: 'test' })
  await B._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: dirB, name: 'Builder', owner: 'test' })
  await sleep(1800)

  // ── A. asking somebody who is not here ─────────────────────────────────────
  console.log('\n# A. the Tester/@Reviewer failure, through the real tool')
  const ghost = textOf(await A._test.callTool('hive_say', {
    text: '@Reviewer did the suite pass?', needsReply: true,
  }))
  T('A1 hive_say reports an obligation was opened', /YOU ARE OWED AN ANSWER/.test(ghost), ghost.split('\n')[0])
  T('A2 IT SAYS AT ONCE THAT NOBODY BY THAT NAME IS HERE -- the six-hour stall, caught in one call',
    /NOT IN THIS ROOM/.test(ghost))
  T('A3 and tells the asker what to do about it', /hive_members/.test(ghost))

  // ── B. asking somebody who IS here ─────────────────────────────────────────
  console.log('\n# B. a real question to a real agent')
  const asked = textOf(await A._test.callTool('hive_say', {
    text: '@Builder did HIV-13 change the minutes divisor?', needsReply: true, replyWithinMinutes: 1,
  }))
  const id = (asked.match(/(ob_[a-z0-9_]+)/) || [])[1]
  T('B1 an obligation id comes back so it can be closed later', !!id, id || asked.split('\n')[0])
  T('B2 the reply makes the author-only rule explicit at the moment of asking',
    /cannot close it/.test(asked) && /a reply does not close it/.test(asked))
  T('B3 asking somebody who IS present does not raise the absent warning',
    !/NOT IN THIS ROOM/.test(asked.split('YOU ARE OWED')[1] || ''))
  await sleep(600)

  // ── C. the debtor cannot close it, through the real tool ───────────────────
  console.log('\n# C. the debtor tries to close its own ticket')
  const selfClose = textOf(await B._test.callTool('hive_answered', { id }))
  T('C1 BUILDER IS REFUSED', /only the asker/.test(selfClose), selfClose.split('\n')[0])

  const owedB = textOf(await B._test.callTool('hive_owed', {}))
  T('C2 and hive_owed still shows Builder owing it', /YOU OWE 1 ANSWER/.test(owedB), owedB.split('\n')[0])

  // A REPLY IS NOT AN ANSWER. Builder says something entirely reasonable; nothing moves.
  await B._test.callTool('hive_say', { text: '@Claude yes I changed it to /60000' })
  await sleep(600)
  T('C3 A REPLY DOES NOT DISCHARGE IT -- the asker still decides',
    /YOU OWE 1 ANSWER/.test(textOf(await B._test.callTool('hive_owed', {}))))

  // ── D. the asker closes it ─────────────────────────────────────────────────
  console.log('\n# D. the asker closes it')
  const closed = textOf(await A._test.callTool('hive_answered', { id }))
  T('D1 Claude CAN close it', /^Closed /.test(closed), closed.split('\n')[0])
  await sleep(600)
  T('D2 Builder no longer owes it',
    !/YOU OWE 1 ANSWER/.test(textOf(await B._test.callTool('hive_owed', {}))))

  // ── E. THE KNOCK RIDES hive_wait ───────────────────────────────────────────
  console.log('\n# E. the reminder arrives on a wait the agent was making anyway')
  // Due in 1.8s, so the knock is already owed by the time Builder waits. In the room this is ten
  // minutes; the mechanism is identical and the test does not have to sit through it. An earlier
  // draft asked for 0.0001 minutes and got 60s, because the handler clamped MINUTES to a floor of
  // 1 and said nothing -- the clamp now lives in milliseconds, so a value above it is honoured.
  await A._test.callTool('hive_say', {
    text: '@Builder second question, this one goes unanswered', needsReply: true, replyWithinMinutes: 0.03,   // 1.8s -- above the 1s floor, so it is honoured as written
  })
  await sleep(2400)

  const waited = textOf(await B._test.callTool('hive_wait', { timeoutSeconds: 2 }))
  T('E1 hive_wait TELLS BUILDER IT OWES AN ANSWER', /YOU OWE 1 ANSWER/.test(waited), waited.split('\n').find((l) => /YOU OWE/.test(l)) || waited.slice(0, 90))
  T('E2 the reminder carries the question, not just a count', /second question/.test(waited))
  T('E3 and restates who can close it, where the agent is actually reading',
    /the asker does that/.test(waited))
  T('E4 THE REMINDER COST NO EXTRA CALL -- it rode a hive_wait the agent had to make regardless',
    /YOU OWE/.test(waited))

  // A delivered knock must push the deadline out, or every wait in the next ten minutes repeats
  // the same nag and the room learns to scroll past it.
  const again = textOf(await B._test.callTool('hive_wait', { timeoutSeconds: 2 }))
  T('E5 the NEXT wait does not repeat it -- a delivered knock backs off',
    !/YOU OWE/.test(again), again.split('\n')[0])

  // ── F. the board ───────────────────────────────────────────────────────────
  console.log('\n# F. the board a human reads')
  const all = textOf(await A._test.callTool('hive_owed', { all: true }))
  T('F1 the room-wide board shows what is still open', /open/.test(all), all.split('\n')[0])
  T('F2 including the question asked of an agent that never existed', /Reviewer/.test(all))
  T('F3 and it does NOT show the one that was closed', !/minutes divisor/.test(all))
} catch (e) {
  T('the suite ran without throwing', false, String((e && e.stack) || e))
} finally {
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== OBLIGATIONS E2E: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
