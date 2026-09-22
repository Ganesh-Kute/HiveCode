// AGENT LIVENESS (HIV-P11): can the room tell a teammate that is thinking from one that stopped?
//
//   node tests/agent-liveness-test.mjs
//
// THE DEFECT.
// A turn-based agent whose turn has ended is still connected. Its socket is open, awareness
// reports it present, and it will take no action for the rest of the night. Until this suite,
// that agent was indistinguishable from one thinking hard mid-task -- so hive_members reported
// a corpse and a colleague identically, hive_wait blocked on the corpse for its full timeout,
// and a human returning in the morning had no record of when anything stopped.
//
// HOW THIS SUITE IS BUILT, AND IT IS THE POINT.
// Everything below drives the REAL MCP dispatch against a REAL relay: clients join, call tools,
// stop calling tools, block inside hive_wait, and die. Nothing hands hive-activity.js a
// constructed { waitingSince, lastAction } and asks whether it classifies correctly -- the
// module was never in doubt. What is in doubt is whether the product DERIVES those fields and
// wires them through, and a unit test of the classifier cannot fail when the stamping is
// deleted. That failure has a name in this repo: learnings/testing-the-consumer-instead-of-the-
// derivation.md, committed hours before this file, after it cost us HIV-P5's middle state.
//
// So every assertion here reads the output of hive_members -- the thing an agent actually sees.
//
// THE ORDERING PROPERTY (section D) IS THE ONE THAT MATTERS MOST.
// A process that dies inside hive_wait leaves `waitingSince` set in the CRDT forever. If state
// were derived from the stored record before presence, that corpse would report WAITING --
// "healthy idle, wakes the moment anything arrives" -- which is the most reassuring answer the
// room can give about the worst situation it can be in. D proves presence wins, and proves it
// by checking that the flag is STILL SET while the state has already flipped.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const PORT = Number(process.env.HIVE_TEST_PORT) || (22000 + (process.pid % 18000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// A short window so PARKED is reachable in a test. parkedAfterMs() reads this at call time, so
// it is honoured by the live tool, not by a value this file passes in -- the threshold travels
// the same path in the test as in production.
// THIS NUMBER MUST EXCEED THE SLOWEST TOOL CALL IN THE SUITE, not merely the floor.
//
// The stamp is written when a call BEGINS, so the record's age includes however long the call
// then ran. At 2500ms, and again at 6000ms, A1 went red with "PARKED: ... silent for 0 min
// (hive_say)" -- parked, zero minutes ago, naming the tool it was inside. Measured: hive_say
// takes 404ms with two clients and seconds with five, so the suite was timing tool latency
// rather than exercising the feature. 20s clears it with margin and is what the floor in
// hive-activity.js (MIN_PARKED_AFTER_MS) exists to stop anyone configuring below.
const PARKED_MS = 20000
process.env.HIVE_PARKED_AFTER_MIN = String(PARKED_MS / 60000)

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-liveness-'))
const room = 'liveness-' + crypto.randomBytes(5).toString('hex')

const mkdir = (n) => {
  const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, '.gitignore'), '/*\n!/.gitignore\n!/notes.md\n')
  fs.writeFileSync(path.join(d, 'notes.md'), 'x\n')
  return d
}
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)
/** The line hive_members printed for one member. Assertions read THIS, never the module. */
const lineFor = (out, who) => (out.split('\n').find((l) => l.trim().startsWith(who)) || '').trim()

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const url = (q) => `file:///${ROOT.replace(/\\/g, '/')}/hive-mcp.js${q}`
const link = `ws://localhost:${PORT}|${room}`

let A, B, C, D, H
try {
  // Four separate module instances = four independent agents, each with its own session and its
  // own folder. Two agents in one folder is fake multiplayer and would not exercise this at all.
  A = await import(url('?a'))   // the observer: asks hive_members
  B = await import(url('?b'))   // the subject: works, waits, parks, dies
  C = await import(url('?c'))   // a declared passive listener
  D = await import(url('?d'))   // paused by a human
  H = await import(url('?h'))   // the human, who is the only one allowed to press stop

  await A._test.callTool('hive_join', { link, dir: mkdir('a'), name: 'Observer', owner: 't' })
  await B._test.callTool('hive_join', { link, dir: mkdir('b'), name: 'Subject', owner: 't' })
  await C._test.callTool('hive_join', { link, dir: mkdir('c'), name: 'Listener', owner: 't', passive: true })
  await D._test.callTool('hive_join', { link, dir: mkdir('d'), name: 'Stopped', owner: 't' })
  await H._test.callTool('hive_join', { link, dir: mkdir('h'), name: 'Ganesh', owner: 'Ganesh', kind: 'human' })
  await sleep(2500)

  // ─── A. an agent that just acted is WORKING ────────────────────────────────────────────────
  console.log('\n# A. acting')
  await B._test.callTool('hive_say', { text: 'Subject here, taking HIV-99.' })
  await sleep(600)
  let out = textOf(await A._test.callTool('hive_members', {}))
  let sub = lineFor(out, 'Subject')
  T('A1 an agent that just called a tool reads WORKING', /WORKING/.test(sub), sub.slice(0, 110))
  T('A2 and the line carries the evidence, not just the verdict (which tool, how long ago)',
    /last action/i.test(sub) && /hive_say/.test(sub), sub.slice(0, 110))

  // ─── B. inside a blocking wait: the state that needs no threshold ──────────────────────────
  console.log('\n# B. blocked in hive_wait')
  // DRAIN FIRST, and the reason is a finding in itself. hive_wait "returns instantly if any of
  // those is ALREADY true", so an agent with unread mail is never suspended at all -- it is
  // handed its backlog and comes straight back out. The first version of this section asserted
  // WAITING against a call that had already returned, and read WORKING. That is the tool behaving
  // correctly and the test being wrong: to observe the waiting state you must first make the
  // agent have nothing to do, which is exactly the situation the state is about.
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now()
    await B._test.callTool('hive_wait', { timeoutSeconds: 2 })
    if (Date.now() - t0 > 1500) break   // it blocked for the full timeout: the mailbox is empty
  }
  await sleep(300)

  // Deliberately NOT awaited: the point is to observe the room while B is suspended inside the
  // call. This is the healthy idle state and the only one that is exactly knowable.
  // Longer than PARKED_MS, deliberately: B3 sleeps past the parked window while B is still
  // suspended, so a 12s timeout made the wait RETURN first and B3 read WORKING -- the test
  // measuring its own timeout instead of the property.
  const pending = B._test.callTool('hive_wait', { timeoutSeconds: 45 })
  await sleep(1200)
  out = textOf(await A._test.callTool('hive_members', {}))
  sub = lineFor(out, 'Subject')
  T('B1 an agent suspended inside hive_wait reads WAITING', /WAITING/.test(sub), sub.slice(0, 110))
  // "Reachable" ALONE IS NOT ENOUGH HERE, and the mutation check is what proved it: WORKING lines
  // also end in "Reachable", so when WAITING collapsed into WORKING this assertion kept passing
  // and reported the state as still covered. It has to name the thing that is true of a waiting
  // agent and of nothing else — that it wakes on arrival rather than on being prompted.
  T('B2 and the line states WHY it is reachable — it wakes on arrival, not on being prompted',
    /Reachable/i.test(sub) && /wakes the moment anything arrives/i.test(sub), sub.slice(0, 110))

  // Now let it sit past the parked window WITHOUT leaving the wait. A waiting agent must never
  // decay into PARKED -- it is doing exactly what the loop asks of it, and telling the room to
  // go prod it would punish the only correct idle behaviour there is.
  await sleep(PARKED_MS + 900)
  out = textOf(await A._test.callTool('hive_members', {}))
  sub = lineFor(out, 'Subject')
  T('B3 STILL WAITING past the parked window — a correct idler never decays into PARKED',
    /WAITING/.test(sub) && !/PARKED/.test(sub), sub.slice(0, 110))

  await pending   // let the wait finish; the finally must clear waitingSince
  // The clear is a CRDT update and the observer is a different client, so it has to travel.
  // Asserting on A's view before it lands tests the network, not the feature — the first run of
  // this section read WAITING here purely because the delete had not arrived yet.
  await sleep(1500)

  // ─── C. the whole feature: the turn ended and nobody will ever be told ─────────────────────
  console.log('\n# C. the turn ended')
  out = textOf(await A._test.callTool('hive_members', {}))
  sub = lineFor(out, 'Subject')
  const cleared = A._test.getSession().hive.doc.getMap('activity').get('subject')
  T('C0 leaving the wait CLEARS waitingSince — the flag means "inside the call NOW", not "waited once"',
    !!(cleared && !cleared.waitingSince),
    cleared ? `waitingSince=${cleared.waitingSince ? 'STILL SET' : 'cleared'}` : '(no record)')
  T('C1 immediately after the wait returns it is WORKING again, not PARKED',
    /WORKING/.test(sub), sub.slice(0, 110))

  await sleep(PARKED_MS + 900)   // B calls nothing. This is a turn that ended.
  out = textOf(await A._test.callTool('hive_members', {}))
  sub = lineFor(out, 'Subject')
  T('C2 AN AGENT THAT STOPPED CALLING TOOLS READS PARKED', /PARKED/.test(sub), sub.slice(0, 130))
  T('C3 and the line states the CONSEQUENCE, so a reader does not file it under "idle"',
    /will not wake on its own/i.test(sub), sub.slice(0, 160))
  T('C4 it is connected — PARKED is not a synonym for disconnected',
    /connected/i.test(sub) && !/GONE/.test(sub), sub.slice(0, 130))

  // ─── D. THE ORDERING PROPERTY: a corpse must not report the healthiest state ───────────────
  console.log('\n# D. died inside a wait')
  const pending2 = B._test.callTool('hive_wait', { timeoutSeconds: 25 })
  await sleep(1200)
  out = textOf(await A._test.callTool('hive_members', {}))
  T('D1 setup: Subject is WAITING again', /WAITING/.test(lineFor(out, 'Subject')))

  // Kill the transport while the process is still suspended inside the call, so no finally can
  // run and waitingSince stays set. This is what an OOM, a rate limit or a closed laptop does.
  try { B._test.getSession().hive.stop() } catch { }
  await sleep(3000)

  out = textOf(await A._test.callTool('hive_members', {}))
  const goneLine = lineFor(out, 'Subject')
  T('D2 A PROCESS THAT DIED INSIDE hive_wait READS GONE, NOT WAITING',
    /GONE/.test(goneLine) && !/WAITING/.test(goneLine), goneLine.slice(0, 130) || '(no line at all)')

  // The discriminating half. If waitingSince had been cleared, D2 would pass for the wrong
  // reason -- the flag would be gone rather than outranked -- and the ordering would be untested.
  const rec = A._test.getSession().hive.doc.getMap('activity').get('subject')
  T('D3 and it flipped because PRESENCE OUTRANKS THE RECORD — waitingSince is still set',
    !!(rec && rec.waitingSince), rec ? `waitingSince=${rec.waitingSince ? 'set' : 'CLEARED'}` : '(no record)')
  T('D4 a departed agent still carries what it was last doing, so the morning has a trail',
    /last action/i.test(goneLine) || /hive_wait/.test(goneLine), goneLine.slice(0, 130))

  try { await pending2 } catch { }

  // ─── E. the two exclusions: silence that is correct ────────────────────────────────────────
  console.log('\n# E. silence that is not a fault')
  // PRESSED BY THE HUMAN, not by this test reaching into A's document. The relay reverts an AI
  // that writes to `controls` -- mission control is the human's map and an agent unpausing itself
  // was a real hole once. The first version of this section had the AI Observer set the flag, the
  // relay correctly threw it away, and the paused agent read PARKED. The test was wrong and the
  // enforcement was right, which is the good way round.
  const ctl = H._test.getSession().hive.doc.getMap('controls')
  ctl.set('Stopped', { state: 'paused', by: 'Ganesh' })
  await sleep(1500)
  out = textOf(await A._test.callTool('hive_members', {}))
  const listener = lineFor(out, 'Listener')
  const stopped = lineFor(out, 'Stopped')

  T('E1 a declared PASSIVE listener is never PARKED — it does not take turns by design',
    /PASSIVE/.test(listener) && !/PARKED/.test(listener), listener.slice(0, 110))
  T('E2 an agent a human PAUSED is never PARKED — it is obeying, not stalled',
    /PAUSED/.test(stopped) && !/PARKED/.test(stopped), stopped.slice(0, 110))
  T('E3 and the paused line warns against reassigning its work',
    /do not reassign/i.test(stopped), stopped.slice(0, 130))

  // HIV-P11c. Seen live in room `night` an hour after P11 shipped:
  //   Ganesh (human) — PARKED: ... anything you send it now will sit unread until a human
  //   prompts it
  // Said about the human. Antigravity1 called this in the design review and it was not
  // implemented. The whole taxonomy asks whether an AGENT will act again unprompted, which is
  // not a question about a person -- and a state that says something absurd about one member
  // teaches a reader to discount it for all of them.
  const ganesh = lineFor(out, 'Ganesh')
  T('E4 A HUMAN IS NEVER PARKED — the taxonomy is about agents, not people',
    !/PARKED/.test(ganesh) && /PRESENT/.test(ganesh), ganesh.slice(0, 120))
  T('E5 and it does not tell you a human needs a human to prompt it',
    !/until a human prompts it/i.test(ganesh), ganesh.slice(0, 120))

  // ─── F. anti-vacuity: could any of this have failed? ───────────────────────────────────────
  console.log('\n# F. the suite can fail')
  T('F1 hive_members actually named every participant (a silent empty output would pass C and E)',
    ['Observer', 'Subject', 'Listener', 'Stopped'].every((n) => out.includes(n)),
    out.split('\n').length + ' lines')
  T('F2 the four states are genuinely distinguished in one readout, not one label for everything',
    new Set(['WORKING', 'WAITING', 'PARKED', 'GONE', 'PAUSED', 'PASSIVE'].filter((s) => out.includes(s))).size >= 3,
    ['WORKING', 'WAITING', 'PARKED', 'GONE', 'PAUSED', 'PASSIVE'].filter((s) => out.includes(s)).join(','))
  T('F3 the Observer — which has been calling tools throughout — is WORKING, so WORKING is reachable',
    /WORKING/.test(lineFor(out, 'Observer')), lineFor(out, 'Observer').slice(0, 110))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const M of [A, B, C, D, H]) { try { M._test.getSession().hive.stop() } catch { } }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== HIV-P11 AGENT LIVENESS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
