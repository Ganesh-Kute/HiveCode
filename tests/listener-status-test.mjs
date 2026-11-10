// Test: listener status in join card and hive_status (Task C8)
//
//   node tests/listener-status-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import process from 'process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sandbox = mkdtempSync(join(tmpdir(), 'hive-listener-status-'))
process.chdir(sandbox)

const Y = (await import('yjs')).default ?? (await import('yjs'))
const { _test } = await import('../hive-mcp.js')
const { armedFile } = await import('../hive-listen.js')

let pass = 0, fail = 0
const T = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}
const section = (s) => console.log(`\n# ${s}`)

function makeRoom(me, extra = {}) {
  const doc = new Y.Doc()
  const chat = doc.getArray('chat')
  const hive = {
    doc,
    getState: () => ({}),
    say: (text) => chat.push([{ by: me, kind: 'ai', at: '12:00:00', text: String(text) }]),
    members: () => [],
    status: () => ({ connected: true, files: 0, filesSynced: 0 }),
    stop: () => {},
  }
  const session = { hive, room: 'room-test', relay: 'wss://test', dir: sandbox, name: me, owner: 'Ganesh', mailbox: null, ...extra }
  _test.setSession(session)
  _test.mailbox().seek(chat.length)
  return { doc, chat, session }
}

const textOf = (res) => res.content.map((c) => c.text).join('\n')
const jsonOf = (res) => JSON.parse(textOf(res))

section('C8-1: hive_status reports listener status')
{
  // 1. Without armed listener for Claude Code (listenHow returns a command, room has no token)
  await _test.initialize({ protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '2.1.0' } })
  makeRoom('Ada')
  const st1 = jsonOf(await _test.callTool('hive_status', {}))
  T('C8-1a hive_status reports listener: "not running" when not armed', st1.listener === 'not running', `got: ${st1.listener}`)

  // 2. With armed listener
  const af = armedFile('Ada', 'room-test')
  fs.mkdirSync(path.dirname(af), { recursive: true })
  fs.writeFileSync(af, JSON.stringify({ pid: process.pid, at: Date.now(), beat: Date.now(), synced: true }))
  try {
    const st2 = jsonOf(await _test.callTool('hive_status', {}))
    T('C8-1b hive_status reports listener: "running" when armed', st2.listener === 'running', `got: ${st2.listener}`)
  } finally {
    try { fs.unlinkSync(af) } catch { }
  }

  // 3. For an unmeasured client (Cursor) where listenHow returns ''
  await _test.initialize({ protocolVersion: '2024-11-05', clientInfo: { name: 'cursor', version: '1.0' } })
  makeRoom('Ada')
  const st3 = jsonOf(await _test.callTool('hive_status', {}))
  T('C8-1c hive_status reports listener: "not used on this client" for unmeasured client', st3.listener === 'not used on this client', `got: ${st3.listener}`)

  // 4. In a token-checking room (authed)
  await _test.initialize({ protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '2.1.0' } })
  makeRoom('Ada', { authed: true })
  const st4 = jsonOf(await _test.callTool('hive_status', {}))
  T('C8-1d hive_status reports listener: "not used on this client" in token-checking room', st4.listener === 'not used on this client', `got: ${st4.listener}`)
}

section('C8-2: Join card reports listener status')
{
  // 1. Claude Code in open room without listener
  await _test.initialize({ protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '2.1.0' } })
  const card1 = _test.listenerStatusFor({ name: 'Ada', room: 'room-test', useToken: '', passive: false })
  T('C8-2a join card shows "not running" when client can listen but is not armed', card1.card === 'not running', `got: ${card1.card}`)

  // 2. Claude Code in open room WITH armed listener
  const af = armedFile('Ada', 'room-test')
  fs.mkdirSync(path.dirname(af), { recursive: true })
  fs.writeFileSync(af, JSON.stringify({ pid: process.pid, at: Date.now(), beat: Date.now(), synced: true }))
  try {
    const card2 = _test.listenerStatusFor({ name: 'Ada', room: 'room-test', useToken: '', passive: false })
    T('C8-2b join card shows "running" when armed', card2.card === 'running', `got: ${card2.card}`)
  } finally {
    try { fs.unlinkSync(af) } catch { }
  }

  // 3. Cursor (unmeasured app)
  await _test.initialize({ protocolVersion: '2024-11-05', clientInfo: { name: 'cursor', version: '1.0' } })
  const card3 = _test.listenerStatusFor({ name: 'Ada', room: 'room-test', useToken: '', passive: false })
  T('C8-2c join card falls back to "idle with hive_wait" for unmeasured app', card3.card === 'idle with hive_wait', `got: ${card3.card}`)

  // 4. Token-checking room
  await _test.initialize({ protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '2.1.0' } })
  const card4 = _test.listenerStatusFor({ name: 'Ada', room: 'room-test', useToken: 'tok123', passive: false })
  T('C8-2d join card falls back to "idle with hive_wait" for token-checking room', card4.card === 'idle with hive_wait', `got: ${card4.card}`)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
