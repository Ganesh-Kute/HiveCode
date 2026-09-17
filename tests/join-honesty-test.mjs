// JOIN HONESTY — hive_join must never report success for a join that did not happen.
//
// Found live on 18 Sep 2026. A relay at capacity answered 38,011 connection attempts with
// Q430. hive_join waited 8 seconds for a 'sync' event, timed out, resolved anyway, and
// returned its ordinary "joined (link)" banner followed by the full rules text. Three agents
// read that banner, believed they were in a room, and worked for half an hour. Nothing any of
// them wrote reached anybody.
//
// This is worse than a crash. A crash stops the agent; a false success lets it keep going and
// produce work that is invisible and unmergeable. The agent cannot detect the condition
// itself -- every subsequent local call succeeds, because the local CRDT is perfectly happy
// talking to nobody.
//
// Both directions are asserted, because a "fix" that always warns is no fix:
//   A. relay refuses  -> must say NOT JOINED, say why, and withhold the rules
//   B. relay accepts  -> must join normally, with no scary text
//
//   node tests/join-honesty-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'

const PORT = 1337
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

// The relay admits exactly ONE connection in total, so a single squatter fills it.
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), HIVE_MAX_CONNS_TOTAL: '1' },
  })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

// chdir somewhere disposable BEFORE importing the server: it resolves its session file from
// cwd at import time, and we do not want a cursor file landing in the repo.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-joinhonesty-'))
process.chdir(sandbox)
const Y = await import('yjs')
const { WebsocketProvider } = await import('y-websocket')
const { WebSocket } = await import('ws')
const { _test } = await import('../hive-mcp.js')

const room = 'honesty-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`
const dir = path.join(sandbox, 'work'); fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'app.js'), 'export const a = 1\n')

const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)

// ── A. the relay is full ───────────────────────────────────────────────────────────────
const squatter = new WebsocketProvider(wsUrl, 'squatter-room', new Y.Doc(),
  { WebSocketPolyfill: WebSocket, connect: true })
await sleep(2500)

const refused = textOf(await _test.callTool('hive_join', {
  link: `${wsUrl}|${room}`, dir, name: 'Probe', owner: 'test',
}))

T('A1 a refused join does NOT claim to have joined', !/^joined/i.test(refused))
T('A2 it says NOT JOINED, in those words', /NOT JOINED/.test(refused))
T('A3 it tells the agent not to start work', /DO NOT START WORK/.test(refused))
T('A4 it names capacity as a cause, with the Q-code', /Q430/.test(refused))
T('A5 it does NOT hand over the rules, which would read as success', !/FOLLOW THESE RULES/.test(refused))
T('A6 it points at hive_status, which is authoritative', /hive_status/.test(refused))

// ── B. the relay is free again -> a normal join must still work ────────────────────────
try { squatter.destroy() } catch { }
await sleep(6000) // the relay applies a cooloff before the slot frees

const ok = textOf(await _test.callTool('hive_join', {
  link: `${wsUrl}|${room}`, dir, name: 'Probe', owner: 'test',
}))

T('B1 a real join still succeeds', /^joined/i.test(ok))
T('B2 and carries the rules', /FOLLOW THESE RULES/.test(ok))
T('B3 with no false alarm', !/NOT JOINED/.test(ok))

try { await _test.callTool('hive_leave', {}) } catch { }
relay.kill()
console.log(`\n=== JOIN HONESTY: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
