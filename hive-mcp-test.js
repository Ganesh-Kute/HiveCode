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
assert('chat shows the join announce', chat.includes('McpBot joined'))
assert('chat shows the said message', chat.includes('taking parser.js'))

// 5. members
const members = await callTool('hive_members', {})
assert('hive_members lists the agent as ai', members.includes('McpBot') && members.includes('(ai)'))

console.log(`\n=== ${failed === 0 ? 'ALL LIVE CHECKS PASSED' : failed + ' FAILED'} ===`)
await callTool('hive_leave', {})
mcp.kill(); relay.kill()
fs.rmSync(path.resolve('.mcp-test'), { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
