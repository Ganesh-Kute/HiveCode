// Drives hive-mcp.js over stdio JSON-RPC like a real MCP client would:
// initialize -> list tools -> hive_join -> hive_say -> hive_read_chat.
// Proves an MCP agent can join a room and coordinate via tool calls.
//
//   node hive-mcp-test.js

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const PORT = 1244
const RELAY = `ws://localhost:${PORT}`
const DIR = path.resolve('.mcp-test/agent')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

fs.rmSync(path.resolve('.mcp-test'), { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

// start the MCP server with the local relay
const mcp = spawn(process.execPath, ['hive-mcp.js'], { env: { ...process.env, HIVE_RELAY: RELAY } })
mcp.stderr.on('data', (d) => process.stdout.write(`   [mcp-stderr] ${d}`))

// --- minimal JSON-RPC-over-stdio client (newline-delimited) ---
let buf = ''
const pending = new Map()
mcp.stdout.on('data', (d) => {
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
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const notify = (method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
const callTool = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args || {} })
  return (r.result?.content || []).map((c) => c.text).join('\n')
}

// 1. handshake
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0' } })
assert('server initialized', !!init.result && !!init.result.serverInfo)
notify('notifications/initialized')

// 2. list tools
const tools = (await rpc('tools/list')).result.tools.map((t) => t.name)
console.log('   tools:', tools.join(', '))
assert('exposes hive_join', tools.includes('hive_join'))
assert('exposes hive_say + hive_read_chat + hive_read_board', tools.includes('hive_say') && tools.includes('hive_read_chat') && tools.includes('hive_read_board'))

// 3. join a room (hosts one on the local relay)
const joined = await callTool('hive_join', { dir: DIR, name: 'McpBot' })
console.log('\n   hive_join ->\n' + joined.split('\n').slice(0, 6).map((l) => '      ' + l).join('\n'))
assert('hive_join returns room info', /room: room-/.test(joined))
assert('hive_join returns the rules to follow', joined.includes('HIVE RULES'))

// 4. say something, then read it back
await callTool('hive_say', { text: 'taking parser.js — adding tokenizer' })
await sleep(500)
const chat = await callTool('hive_read_chat', {})
console.log('\n   hive_read_chat ->\n' + chat.split('\n').map((l) => '      ' + l).join('\n'))
// The server used to post "<name> joined and is ready to work." on join. That was replaced
// deliberately: hive_join now returns an instruction telling the agent to announce its own
// ENGINE VERSION instead ("joined on hivecode 0.11.1"), because mixed builds in one room
// cause data loss and a version line in chat is the only way anyone finds out. An automatic
// "joined" message carries no version and crowds out the one that matters.
//
// So what is asserted is that hive_join HANDS OVER that instruction — not that the server
// announces on the agent's behalf.
//
// SUPERSEDED 2 Oct 2026. Since 29 Sep every client reports its build in presence and the room
// flags a mix itself (sync.js checkBuilds, tests/mixed-build-test.mjs), so "this is the only way
// anyone finds out" stopped being true -- and the first thing a stranger read in their agent's
// transcript was "data loss". The reply still names the build; nobody is asked to announce it.
assert('hive_join no longer asks the agent to announce its version, or opens on "data loss"',
  !joined.includes('ANNOUNCE YOUR VERSION') && !/data loss/i.test(joined))
assert('...and still names this build', /\nhivecode: \d+\.\d+\.\d+/.test(joined))
// The onboarding audit: the host put an invite together by hand (install, reload, the sentence,
// the link). setup with a link prints the reload steps and the exact sentence for that person, so
// the host's reply carries one message to forward as is.
assert('a host is handed an invite to forward: setup with the quoted link, and the browser link',
  joined.includes(`forward this as is`) && joined.includes(`npx -y hivecode-mcp@latest setup "${RELAY}|room-`) && /No AI agent\? Open http:\/\/localhost:\d+\/control#/.test(joined))
assert('chat shows the said message', chat.includes('taking parser.js'))

// 5. members
const members = await callTool('hive_members', {})
assert('hive_members lists the agent as ai', members.includes('McpBot') && members.includes('(ai)'))

// 6. second join with DIFFERENT name is refused (Q637) and leaves first session intact
const secondDir = path.resolve('.mcp-test/agent2')
fs.mkdirSync(secondDir, { recursive: true })
const refused = await callTool('hive_join', { dir: secondDir, name: 'DifferentBot' })
assert('second join with different name is refused with Q637', /Q637/.test(refused) && /already in use by 'McpBot'/.test(refused))
assert('refusal does not suggest hive_leave', !/hive_leave/.test(refused))
assert('refusal instructs adding second server entry', refused.includes('hivecode-2'))

// prove first session is still alive and intact
const statusAfter = await callTool('hive_status', {})
assert('first session is still McpBot after refusal', statusAfter.includes('"name": "McpBot"'))
await callTool('hive_say', { text: 'still alive as McpBot' })
const chatAfter = await callTool('hive_read_chat', {})
assert('first session can still post after refusal', chatAfter.includes('still alive as McpBot'))

// 7. second join with SAME name is allowed (rejoin / switch)
const rejoined = await callTool('hive_join', { dir: DIR, name: 'McpBot' })
assert('same name rejoin is allowed', /room: room-/.test(rejoined))

// 8. explicit leave allows a different name
await callTool('hive_leave', {})
const newJoined = await callTool('hive_join', { dir: DIR, name: 'DifferentBot' })
assert('explicit leave allows new name', /room: room-/.test(newJoined))
const statusNew = await callTool('hive_status', {})
assert('session is now DifferentBot', statusNew.includes('"name": "DifferentBot"'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
await callTool('hive_leave', {})
mcp.kill(); relay.kill()
fs.rmSync(path.resolve('.mcp-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
