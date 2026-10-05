// A PARTICIPANT COMES BACK AS WHAT IT JOINED AS.
//
//   node tests/session-resume-test.mjs
//
// When the MCP host restarts, hive-mcp rejoins from .hive-mcp-session.json (tryResumeSession).
// Until 4 Oct 2026 that file held dir, name, owner and the read cursor only, so a human who joined
// through MCP came back as an AI, and a passive participant (one that never answers) came back as
// one the room waits on. The Stop hook reads the same file, and could not tell either.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (24200 + (process.pid % 17000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
// chdir BEFORE importing the server: it resolves its session file from cwd at import time.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-resume-'))
process.chdir(sandbox)
const { _test } = await import(`file:///${ROOT.replace(/\\/g, '/')}/hive-mcp.js`)
const SESSION_FILE = path.join(sandbox, '.hive-mcp-session.json')
const room = 'resume-' + crypto.randomBytes(5).toString('hex')
try {
  console.log('# a passive human joins through MCP')
  const dir = path.join(sandbox, 'watch')
  await _test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir, name: 'Watcher', owner: 'G', kind: 'human', passive: true })
  const first = _test.getSession()
  T('it joined as a passive human', !!first && first.passive === true && first.kind === 'human')
  const file = (() => { try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) } catch { return {} } })()
  T('R1 the session file says passive', file.passive === true, JSON.stringify(file))
  T('R2 the session file says human', file.kind === 'human', JSON.stringify(file))

  console.log('# the MCP host restarts: the session in memory is gone, the file is all that is left')
  try { first.hive.stop() } catch { }
  _test.setSession(null)
  await sleep(500)
  await _test.tryResumeSession()
  const back = _test.getSession()
  T('R3 it comes back passive', !!back && back.passive === true, JSON.stringify(back && { passive: back.passive }))
  T('R4 it comes back human, not as an AI', !!back && back.kind === 'human', JSON.stringify(back && { kind: back.kind }))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { const s = _test.getSession(); if (s && s.hive) s.hive.stop() } catch { }
  try { relay.kill() } catch { }
  process.chdir(os.tmpdir())
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch { }
}
console.log(`\n=== SESSION RESUME: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
