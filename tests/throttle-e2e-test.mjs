// throttle, end to end: the state block stops repeating, and a change still gets through.
//
//   node tests/throttle-e2e-test.mjs
//
// The unit suite proves the decision function. This proves the WIRING, which is a different
// claim -- HIV-27 was a guard that was correct and never reached, and asserting the predicate
// while assuming the call site is exactly how that happened.
//
// B is the one that matters: a real hive_wait loop against a real relay must stop repeating the
// state block, AND must still deliver it the instant a state value changes. A throttle that only
// does the first half is not a saving, it is a silent staleness bug.

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'

const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + ((process.pid + 13) % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-th-e2e-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'th-e2e-' + crypto.randomBytes(6).toString('hex')
const dir = path.join(tmp, 'claude')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, '.gitignore'), '/*\n!/.gitignore\n!/notes.md\n')
fs.writeFileSync(path.join(dir, 'notes.md'), 'x\n')
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)
const hasState = (t) => /\[GLOBAL PROJECT STATE\]/.test(t)

try {
  const A = await import('../hive-mcp.js?th=a')
  await A._test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir, name: 'Claude', owner: 't' })
  await sleep(1500)

  // ── A. the first one is still delivered ────────────────────────────────────
  console.log('\n# A. nothing is withheld from an agent that has not seen it')
  await A._test.callTool('hive_set_state', { key: 'shift', val: 'RUNNING' })
  await sleep(400)
  const first = textOf(await A._test.callTool('hive_wait', { timeoutSeconds: 1 }))
  T('A1 the first wait after a state is set carries the state block', hasState(first), first.split('\n').find(hasState) || first.slice(0, 60))
  T('A2 and the value itself, not just the header', /RUNNING/.test(first))

  // ── B. THE SAVING, AND THE THING THAT MUST SURVIVE IT ──────────────────────
  console.log('\n# B. it stops repeating -- but a change still gets through')
  let repeats = 0
  for (let i = 0; i < 6; i++) {
    if (hasState(textOf(await A._test.callTool('hive_wait', { timeoutSeconds: 1 })))) repeats++
  }
  T('B1 SIX MORE IDENTICAL WAITS CARRY IT ZERO TIMES', repeats === 0, `${repeats}/6 repeated`)

  // Now the room state actually changes. This must arrive immediately, inside the cooldown,
  // with almost no output spent -- a suppressed state change is a wrong answer, not a saving.
  await A._test.callTool('hive_set_state', { key: 'tests', val: 'RED' })
  await sleep(400)
  const changed = textOf(await A._test.callTool('hive_wait', { timeoutSeconds: 1 }))
  T('B2 A CHANGE IS DELIVERED AT ONCE, INSIDE THE COOLDOWN', hasState(changed), changed.split('\n').find(hasState) || changed.slice(0, 60))
  T('B3 carrying the NEW value', /RED/.test(changed))
  T('B4 and the old keys too, so it stays a complete picture rather than a diff', /RUNNING/.test(changed))

  let after = 0
  for (let i = 0; i < 4; i++) {
    if (hasState(textOf(await A._test.callTool('hive_wait', { timeoutSeconds: 1 })))) after++
  }
  T('B5 then it goes quiet again -- one send per change, not one per wait', after === 0, `${after}/4`)

  // ── C. the rules nudge ─────────────────────────────────────────────────────
  console.log('\n# C. the rules pointer is not spammed at a fresh agent')
  T('C1 an agent that JUST joined is never told to re-read the rules it was just handed',
    !/ROOM RULES/.test(first) && !/ROOM RULES/.test(changed))

  // ── D. measured ────────────────────────────────────────────────────────────
  console.log('\n# D. what it saved, on the real tool')
  // 11 waits happened above; the block should have gone out exactly twice -- once because the
  // agent had never seen it, once because a value changed. Asserted against the counter itself
  // rather than inferred from what did not appear in a tool result: counting absences proves a
  // thing is quiet, not that it is working.
  const st = A._test.throttleStats()
  T('D1 the state block was sent EXACTLY TWICE across 11 waits — once new, once changed',
    st.keys.state.sends === 2, JSON.stringify(st.keys.state))
  T('D2 and the meter saw real traffic, so the bytes gate was live and not stuck at zero',
    st.bytesHandled > 1000, `${st.bytesHandled} bytes through text()`)
} catch (e) {
  T('the suite ran without throwing', false, String((e && e.stack) || e))
} finally {
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== THROTTLE E2E: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
