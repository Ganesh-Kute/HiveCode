// tests/urgent-gate-test.mjs -- P1-8: "[!] Stand down on test.js" must stop the write it is about.
//
// 9 Nov 2026 mock run: Claude sent "[!] @antigravity-VM Stand down on test.js: VM-ANTI-G-1 already
// wrote and released it. Don't edit it. @VM-ANTI-G-1 thanks, reviewing now." Two seconds later
// antigravity-VM called hive_edit test.js: the file was written, and "[!] URGENT MAIL" arrived in the
// reply to that very write, because mail rode a tool's RESULT, appended after the tool had run. The
// room read it as "delivered to one of two agents". The parser was never the problem (U0 below).
//
//   U0 that exact message addresses BOTH agents and is urgent
//   U1 hive_edit with that urgent mail unread: refused, nothing written, the message is shown
//   U2 hive_claim is held the same way
//   U3 talking, releasing and reading are never held (a stand-down asks for exactly those)
//   U4 hive_check reads it; then hive_edit goes through
//   U5 ordinary (not urgent) mail does not hold a write
//   U6 urgent mail to SOMEONE ELSE does not hold this agent's write
//   U7 "[!] @all ..." holds everyone
// Real dispatcher and request handler, a real Yjs doc, no relay (the mcp-wait-test harness).

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import process from 'process'

const sandbox = mkdtempSync(join(tmpdir(), 'hive-urgent-'))
process.chdir(sandbox)

const Y = (await import('yjs')).default ?? (await import('yjs'))
const { _test } = await import('../hive-mcp.js')
const { mentionedNames, mentionsName, priorityOf } = await import('../hive-mailbox.js')

let pass = 0, fail = 0
const T = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${extra ? `  -- ${extra}` : ''}`) } }
const textOf = (res) => (res && res.content ? res.content.map((c) => c.text).join('\n') : String(res))

const STAND_DOWN = "[!] @antigravity-VM Stand down on test.js: VM-ANTI-G-1 already wrote and released it. Don't edit it. @VM-ANTI-G-1 thanks, reviewing now."

function makeRoom(me) {
  const doc = new Y.Doc()
  const chat = doc.getArray('chat')
  const writes = []
  const hive = {
    doc,
    getState: () => ({}),
    say: (text) => chat.push([{ by: me, kind: 'ai', at: '12:00:00', text: String(text) }]),
    members: () => [],
    stop: () => {},
    whyNotShared: () => '',
    edit: (file, content) => { writes.push({ file, content }); return { ok: true, file } },
  }
  const session = { hive, room: 'room-test', relay: 'wss://test', dir: sandbox, name: me, owner: 'Ganesh', mailbox: null }
  _test.setSession(session)
  _test.mailbox().seek(chat.length)
  return { chat, writes, post: (by, text) => chat.push([{ by, kind: 'ai', at: '12:00:00', text }]) }
}

console.log('\n# U0 the parser')
const names = mentionedNames(STAND_DOWN)
T('U0 the stand-down names both agents', names.includes('antigravity-VM') && names.includes('VM-ANTI-G-1'), JSON.stringify(names))
T('U0 ...each mailbox matches it, and it is urgent', mentionsName(STAND_DOWN, 'antigravity-VM') && mentionsName(STAND_DOWN, 'VM-ANTI-G-1') && priorityOf(STAND_DOWN) === 'stop')

console.log('\n# U1-U4 the stand-down, replayed')
{
  const room = makeRoom('antigravity-VM')
  room.post('Claude', STAND_DOWN)
  const r1 = textOf(await _test.callTool('hive_edit', { file: 'test.js', content: 'mine\n', intent: 'Issue #8' }))
  T('U1 hive_edit is refused while the [!] mail is unread', /REFUSED/.test(r1) && /URGENT/.test(r1), r1.slice(0, 160))
  T('U1 ...nothing was written', room.writes.length === 0, JSON.stringify(room.writes))
  T('U1 ...and the refusal shows the message itself', /Stand down on test\.js/.test(r1))
  const r2 = textOf(await _test.callTool('hive_claim', { region: 'test.js', intent: 'Issue #8' }))
  T('U2 hive_claim is held the same way', /REFUSED/.test(r2) && /URGENT/.test(r2), r2.slice(0, 160))
  const r3 = textOf(await _test.callTool('hive_say', { text: '@Claude standing down on test.js' }))
  T('U3 hive_say is not held', !/REFUSED -- \d+ URGENT/.test(r3), r3.slice(0, 160))
  const r3b = textOf(await _test.callTool('hive_read_chat', {}))
  T('U3 ...nor is reading the chat', !/REFUSED -- \d+ URGENT/.test(r3b), r3b.slice(0, 160))
  const r4 = textOf(await _test.callTool('hive_check', {}))
  T('U4 hive_check delivers the stand-down', /Stand down on test\.js/.test(r4), r4.slice(0, 200))
  const r4b = textOf(await _test.callTool('hive_edit', { file: 'test.js', content: 'mine\n', intent: 'Issue #8' }))
  T('U4 ...after which hive_edit goes through', !/REFUSED -- \d+ URGENT/.test(r4b) && room.writes.length === 1, r4b.slice(0, 160))
}

console.log('\n# U5-U7 what does and does not hold a write')
{
  const room = makeRoom('antigravity-VM')
  room.post('Claude', '@antigravity-VM when you get a moment, look at test.js')
  const r5 = textOf(await _test.callTool('hive_edit', { file: 'a.js', content: 'x\n' }))
  T('U5 ordinary mail does not hold a write', !/REFUSED -- \d+ URGENT/.test(r5) && room.writes.length === 1, r5.slice(0, 160))
}
{
  const room = makeRoom('antigravity-VM')
  room.post('Claude', '[!] @VM-ANTI-G-1 stop editing b.js')
  const r6 = textOf(await _test.callTool('hive_edit', { file: 'a.js', content: 'x\n' }))
  T('U6 urgent mail to someone else does not hold this agent', !/REFUSED -- \d+ URGENT/.test(r6) && room.writes.length === 1, r6.slice(0, 160))
}
{
  const room = makeRoom('antigravity-VM')
  room.post('Claude', '[!] @all stop: main is red, nobody writes until it is fixed')
  const r7 = textOf(await _test.callTool('hive_edit', { file: 'a.js', content: 'x\n' }))
  T('U7 "[!] @all" holds everyone', /REFUSED/.test(r7) && room.writes.length === 0, r7.slice(0, 160))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
