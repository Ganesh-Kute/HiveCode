// ARG VALIDATION — a tool call with a missing required argument must be REFUSED, and must
// not report success for something it did not do.
//
// Both of these happened for real on 18 Sep 2026, minutes apart, to an agent that simply
// misremembered a parameter name:
//
//   hive_say({ message: '...' })       -> posted an EMPTY chat message, answered "sent: "
//   hive_set_state({ key, value })     -> answered "Set global state [gate:cmd] to [undefined]"
//
// The second one is the dangerous shape. `gate:cmd` is the command the room runs before it
// will accept a handoff; overwriting it with the string "undefined" would make every
// hive_release fail for every agent, from a call that reported success.
//
// Nothing was enforcing `inputSchema.required` — the MCP SDK does not, and each handler read
// its arguments straight off the object. The guard now sits in one place, before dispatch.
//
// The negative direction is asserted too: a tool with no required arguments, and a required
// argument legitimately set to an empty string, must both still work. A validator that
// rejects '' would break clearing a flag.
//
//   node tests/arg-validation-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'

// pid-derived: this suite runs as a room gate, so two agents may run it at the same
// moment. A fixed port means one fails to bind and the gate refuses a handoff for a
// reason that has nothing to do with the code under test.
const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-argval-'))
process.chdir(sandbox)
const { _test } = await import('../hive-mcp.js')

const room = 'argval-' + crypto.randomBytes(6).toString('hex')
const dir = path.join(sandbox, 'work'); fs.mkdirSync(dir, { recursive: true })
const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

await _test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir, name: 'Probe', owner: 'test' })
await sleep(1500)

// ── the exact two calls that went wrong ────────────────────────────────────────────────
const saidWrong = textOf(await _test.callTool('hive_say', { message: 'this should not post' }))
T('A1 hive_say with `message` is refused, not "sent"', /REFUSED/.test(saidWrong) && !/^sent/i.test(saidWrong))
T('A2 the refusal names the argument it needed (`text`)', /`text`/.test(saidWrong))
T('A3 and names the wrong one that was supplied (`message`)', /`message`/.test(saidWrong))
T('A4 and says plainly that nothing happened', /did NOT happen/.test(saidWrong))

const chat = textOf(await _test.callTool('hive_read_chat', {}))
T('A5 no empty message reached the room', !/this should not post/.test(chat))

const setWrong = textOf(await _test.callTool('hive_set_state', { key: 'gate:cmd', value: 'npm test' }))
T('B1 hive_set_state with `value` is refused', /REFUSED/.test(setWrong))
T('B2 it does NOT report a successful set', !/Set global state/.test(setWrong))
T('B3 and never writes the literal string "undefined"', !/\[undefined\]/.test(setWrong))

const state = textOf(await _test.callTool('hive_read_state', {}))
T('B4 the gate command was not corrupted', !/undefined/.test(state))

// ── the correct calls must still work ──────────────────────────────────────────────────
const saidRight = textOf(await _test.callTool('hive_say', { text: 'taking parser.js' }))
T('C1 hive_say with `text` still posts', /sent/i.test(saidRight) && !/REFUSED/.test(saidRight))

const setRight = textOf(await _test.callTool('hive_set_state', { key: 'lane', val: 'BUILD' }))
T('C2 hive_set_state with `val` still sets', /Set global state \[lane\] to \[BUILD\]/.test(setRight))

const members = textOf(await _test.callTool('hive_members', {}))
T('C3 a tool with no required args is unaffected', !/REFUSED/.test(members) && /Probe/.test(members))

// '' is a value someone may genuinely mean; only undefined/null count as missing.
const setEmpty = textOf(await _test.callTool('hive_set_state', { key: 'lane2', val: '' }))
T('C4 an empty string is a value, not a missing argument', !/REFUSED/.test(setEmpty))

try { await _test.callTool('hive_leave', {}) } catch { }
relay.kill()
console.log(`\n=== ARG VALIDATION: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
