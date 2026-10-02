// SMP / DCO enforcement — the state machine as an enforcement point, not a notepad.
//
// Every feature under test exists because a rule written in prose was read by four capable agents on
// a live build and broken anyway (JARVIS, 2026-07-29). The point of each one is to move a rule from
// "everyone remembers it" to "the code refuses".
//
//   1. transitions   APPROVED must not silently slide backwards
//   2. requires      a release gate that holds by construction, not by a PM repeating it
//   3. PUBLISH:<n>   a COUNTED lease — "one write per path" made arithmetic
//   4. path:POISONED state attached to the RESOURCE, so a path nobody may write is unwritable
//   5. hive_attest   two folders disagreeing about a file becomes a loud event, not a silent one
//   6. mail banner   mail rides every tool result, because custom MCP notifications are ignorable
//
// Two real agents over stdio JSON-RPC against a local relay, like a real MCP client.
//
//   node tests/hive-smp-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const PORT = 1247
const RELAY = `ws://localhost:${PORT}`
const ROOT = path.resolve('.smp-test')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

fs.rmSync(ROOT, { recursive: true, force: true })
const dirA = path.join(ROOT, 'a'), dirB = path.join(ROOT, 'b')
fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

/** One MCP agent: a child process plus a newline-delimited JSON-RPC client. */
function agent(label, extraEnv = {}) {
  const p = spawn(process.execPath, ['hive-mcp.js'], { env: { ...process.env, HIVE_RELAY: RELAY, HIVE_ATTEST_GRACE_MS: '400', ...extraEnv } })
  p.stderr.on('data', (d) => process.stdout.write(`   [${label}-stderr] ${d}`))
  let buf = ''
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  /** Returns the tool's text output, whatever the outcome — errors surface as text too. */
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} })
    const c = r && r.result && r.result.content
    if (Array.isArray(c) && c[0] && typeof c[0].text === 'string') return c[0].text
    return JSON.stringify(r && (r.error || r.result) || r)
  }
  return { proc: p, rpc, notify, call }
}

const A = agent('A'), B = agent('B', { HIVE_TEST_STUCK_SYNC: 'split.js' })
for (const x of [A, B]) {
  await x.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  x.notify('notifications/initialized')
}

// A hosts; B joins A's room via the invite link A reports. Separate folders on purpose — same-folder
// agents were the original cause of file fusion and are not what this test is about.
const joinA = await A.call('hive_join', { dir: dirA, name: 'Alpha' })
const link = (/invite link: (\S+)/.exec(joinA) || [])[1]
assert('A joined and reported an invite link', !!link)
await B.call('hive_join', { dir: dirB, name: 'Beta', link })
await sleep(1500)

console.log('\n# 1. transitions — a state machine, not a free variable')
await A.call('hive_set_schema', { key: 'lane', rules: { enum: ['PLAN', 'BUILD', 'DONE'], transitions: { PLAN: ['BUILD'], BUILD: ['DONE'], DONE: [] } } })
const initOk = await A.call('hive_set_state', { key: 'lane', val: 'PLAN' })
// The tool returns "Set global state [k] to [v]"; the "STATE TRANSITION: [k] is now [v]" phrasing
// goes to CHAT, not to the caller. Asserting the chat wording here silently tested nothing.
assert('first write to a key initialises (no transition demanded)', /Set global state \[lane\] to \[PLAN\]/.test(initOk))
const skip = await A.call('hive_set_state', { key: 'lane', val: 'DONE' })
assert('PLAN -> DONE refused (not a legal move)', /Transition Error/.test(skip))
const step = await A.call('hive_set_state', { key: 'lane', val: 'BUILD' })
assert('PLAN -> BUILD allowed', /Set global state \[lane\] to \[BUILD\]/.test(step))
const back = await A.call('hive_set_state', { key: 'lane', val: 'PLAN' })
assert('BUILD -> PLAN refused (no going backwards)', /Transition Error/.test(back))
await A.call('hive_set_state', { key: 'lane', val: 'DONE' })
const terminal = await A.call('hive_set_state', { key: 'lane', val: 'BUILD' })
assert('DONE is terminal — nothing may leave it', /Transition Error/.test(terminal))

console.log('\n# 2. requires — the release gate holds by construction')
await A.call('hive_set_schema', { key: 'sending', rules: { enum: ['BLOCKED', 'LIVE'], requires: { LIVE: { suppression_ui: 'APPROVED' } } } })
await A.call('hive_set_state', { key: 'sending', val: 'BLOCKED' })
const gated = await A.call('hive_set_state', { key: 'sending', val: 'LIVE' })
assert('sending -> LIVE refused while its precondition is unmet', /Guard Error/.test(gated))
assert('the refusal names what is missing and its current value', /suppression_ui=APPROVED \(is unset\)/.test(gated))
await A.call('hive_set_state', { key: 'suppression_ui', val: 'APPROVED' })
const ungated = await A.call('hive_set_state', { key: 'sending', val: 'LIVE' })
assert('sending -> LIVE allowed once the precondition holds', /Set global state \[sending\] to \[LIVE\]/.test(ungated))

console.log('\n# 3. path poisoning — state attached to the RESOURCE, not the actor')
await A.call('hive_set_state', { key: 'Alpha_status', val: 'OPEN' })
await A.call('hive_set_state', { key: 'path:doomed.js', val: 'POISONED' })
await sleep(400)
const poisoned = await A.call('hive_edit', { file: 'doomed.js', content: 'export const x = 1\n', intent: 'test' })
assert('hive_edit refuses a POISONED path', /Path Poisoned/.test(poisoned))
const claimed = await A.call('hive_claim', { region: 'doomed.js', intent: 'edit' })
assert('hive_claim refuses it too — cheaper than failing after the work is built', /Path Poisoned/.test(claimed))
const fine = await A.call('hive_edit', { file: 'allowed.js', content: 'export const y = 2\n', intent: 'test' })
assert('an unpoisoned path still writes normally', /wrote allowed\.js|through the medium/.test(fine))

console.log('\n# 4. PUBLISH:<n> — a counted lease the server spends')
await A.call('hive_set_state', { key: 'Alpha_status', val: 'PUBLISH:2' })
await sleep(300)
const w1 = await A.call('hive_edit', { file: 'lease1.js', content: 'export const a = 1\n', intent: 'first' })
assert('write 1 of 2 allowed', !/DCO Enforced|Lease Spent/.test(w1))
await sleep(300)
const w2 = await A.call('hive_edit', { file: 'lease2.js', content: 'export const b = 2\n', intent: 'second' })
assert('write 2 of 2 allowed', !/DCO Enforced|Lease Spent/.test(w2))
await sleep(500)
const stateNow = await A.call('hive_read_state', {})
assert('the lease auto-closed itself to LOCKED at zero', /"Alpha_status":\s*"LOCKED"/.test(stateNow))
const w3 = await A.call('hive_edit', { file: 'lease3.js', content: 'export const c = 3\n', intent: 'third' })
assert('write 3 refused — the window shut without anyone remembering to shut it', /DCO Enforced|Lease Spent/.test(w3))

console.log('\n# 5. hive_attest — two folders disagreeing becomes LOUD')
fs.writeFileSync(path.join(dirA, 'shared.js'), 'x'.repeat(8012))
await sleep(1500)
const a1 = await A.call('hive_attest', { file: 'shared.js', bytes: 8012, lines: 1 })
assert('a single attestation is explicitly NOT proof', /proves nothing|Only you so far/.test(a1))
await sleep(600)
const b1 = await B.call('hive_attest', { file: 'shared.js', bytes: 8012, lines: 1 })
assert('two peers at the same size reach quorum', /QUORUM/.test(b1))
await sleep(400)
fs.writeFileSync(path.join(dirA, 'split.js'), 'a'.repeat(178))
await sleep(1000)
await A.call('hive_attest', { file: 'split.js', bytes: 178, lines: 1 })

fs.writeFileSync(path.join(dirB, 'split.js'), 'b'.repeat(22312))
await B.call('hive_attest', { file: 'split.js', bytes: 22312, lines: 1 })
await sleep(600)
await B.call('hive_attest', { file: 'split.js', bytes: 22312, lines: 1 })
await sleep(400)
const a2 = await A.call('hive_attest', { file: 'split.js', bytes: 178, lines: 1 })
assert('peers reporting DIFFERENT bytes raises divergence', /DIVERGENCE/.test(a2))
assert('divergence names both peers and both sizes', /Alpha/.test(a2) && /Beta/.test(a2) && /22312/.test(a2))
const v = await A.call('hive_verified', { file: 'split.js' })
assert('hive_verified reports the split rather than picking a winner', /DIVERGED/.test(v))
const vq = await A.call('hive_verified', { file: 'shared.js' })
assert('hive_verified confirms the agreed file', /QUORUM/.test(vq))
const vn = await A.call('hive_verified', { file: 'never-measured.js' })
assert('an unattested path reports as unverified rather than fine', /NOT attested/.test(vn))

console.log('\n# 6. mail banner — mail rides a tool result, which cannot be ignored')
await B.call('hive_say', { text: '@Alpha the parser is yours, I am off it' })
await sleep(900)
const members = await A.call('hive_members', {})
assert('an UNRELATED tool call carries the unread-mail notice', /UNREAD MAIL/.test(members))
assert('the banner names the sender', /Beta/.test(members))
assert('the banner says it consumed nothing', /consumed nothing/.test(members))
await B.call('hive_say', { text: '@Alpha stop — the build is broken', urgent: true })
await sleep(900)
const urgent = await A.call('hive_status', {})
assert('an urgent mention is marked urgent in the banner', /URGENT MAIL/.test(urgent))
const waitOut = await A.call('hive_check', {})
assert('hive_check still delivers the messages themselves', /parser is yours|build is broken/.test(waitOut))
assert('and does NOT double-report via a banner', !/UNREAD MAIL:/.test(waitOut))

console.log('\n# 7. the banner must not spam, and must retire itself — a context is append-only')
await B.call('hive_say', { text: '@Alpha one more thing about the parser' })
await sleep(900)
const first = await A.call('hive_members', {})
assert('a NEW message produces a notice', /UNREAD MAIL/.test(first))
const n1 = Number((/MAIL NOTICE #(\d+)/.exec(first) || [])[1])
assert('the notice is numbered so the newest is authoritative', Number.isFinite(n1))
assert('and says it supersedes earlier notices', /supersedes every earlier MAIL NOTICE/.test(first))
const repeat1 = await A.call('hive_members', {})
const repeat2 = await A.call('hive_status', {})
assert('the SAME pending mail is not re-announced on later calls', !/MAIL NOTICE/.test(repeat1) && !/MAIL NOTICE/.test(repeat2))
// Read it, then check the next unrelated call retires the stale banner rather than leaving
// "you have unread mail" as the newest thing in the transcript.
await A.call('hive_check', {})
await sleep(300)
const cleared = await A.call('hive_members', {})
assert('once read, ONE all-clear notice is emitted', /MAIL CLEARED/.test(cleared))
assert('the all-clear explicitly marks earlier notices stale', /STALE/.test(cleared))
const n2 = Number((/MAIL NOTICE #(\d+)/.exec(cleared) || [])[1])
assert('the all-clear outranks the unread notice it cancels', n2 > n1)
const quiet = await A.call('hive_members', {})
assert('and the all-clear is not repeated either', !/MAIL NOTICE/.test(quiet))

console.log(`\n=== ${failed ? `${failed} FAILED` : 'ALL PASSED'} ===`)
for (const x of [A, B]) { try { x.proc.kill() } catch { } }
try { relay.kill() } catch { }
await sleep(300)
process.exit(failed ? 1 : 0)
