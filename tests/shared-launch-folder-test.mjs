// TWO AGENTS STARTED FROM ONE FOLDER KEEP THEIR OWN IDENTITY.
//
//   node tests/shared-launch-folder-test.mjs
//
// WHY THIS EXISTS. A branch room's natural setup is two Claude Code sessions in the developer's own
// repo, each told "hive_join with branch ...". Both MCP servers then start in one folder, and until
// 9 Oct 2026 they shared one .hive-mcp-session.json, in which the last writer was the only agent on
// record. Found by walking the founder flow end to end (branch -> two agents -> pr), where the file
// also turned up in the developer's `git status`. What it broke:
//   - the other agent's Stop hook steered it as the wrong agent: that agent's mail, and a listener
//     under that agent's name;
//   - a restart of its MCP server brought it back AS the other agent (refused as a duplicate, and the
//     refusal then deleted the file, the other agent's record included);
//   - one agent leaving took the other off the record.
//
//   S1 both agents are on record, each with its own folder
//   S2 each agent's Stop hook answers as that agent: by conversation id, and by its transcript
//   S3 a Stop hook that cannot tell which agent it guards speaks for neither
//   S4 a restarted server comes back as itself, not as the agent still running beside it
//   S5 one agent leaving keeps the other on record
//   S6 neither of our files shows in the developer's `git status`
//   S7 the Stop hook's own file never syncs into a room
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `   ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms, step = 100) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(step) } return !!(await pred()) }
const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-shared-launch-'))
const D = path.join(TMP, 'repo') // the developer's repo: both agents' apps start here
fs.mkdirSync(D)
spawnSync('git', ['init', '-q', D])
const SESSION = path.join(D, '.hive-mcp-session.json')
const kids = []
process.on('exit', () => { for (const k of kids) { try { k.kill() } catch { } } try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { } })

// An OS-assigned port and a start-up deadline: a port derived from the pid can still be held, and a
// relay that never binds would hang this suite instead of failing it.
const PORT = Number(process.env.HIVE_TEST_PORT) || await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
kids.push(relay)
const up = await new Promise((res) => {
  const giveUp = setTimeout(() => res(false), 20000)
  relay.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(giveUp); res(true) } })
})
if (!up) { console.log(`  FAIL the relay did not start on port ${PORT} within 20 s`); process.exit(1) }
const RELAY = `ws://127.0.0.1:${PORT}`
const LINK = `${RELAY}|shared-${process.pid}-${Date.now().toString(36)}`

const baseEnv = { ...process.env, HIVE_HOME: path.join(TMP, 'home'), HIVE_RELAY: RELAY, HIVE_TOKEN: '' }
delete baseEnv.CLAUDE_CODE_SESSION_ID; delete baseEnv.ANTIGRAVITY_CONVERSATION_ID
function agent(conv) {
  const p = spawn(process.execPath, [path.join(ROOT, 'hive-mcp.js')], { cwd: D, env: conv ? { ...baseEnv, CLAUDE_CODE_SESSION_ID: conv } : baseEnv })
  kids.push(p)
  let buf = '', nextId = 1
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    }
  })
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args || {} }); const c = r && r.result && r.result.content; return Array.isArray(c) && c[0] ? String(c[0].text) : JSON.stringify(r) }
  const init = async () => { await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') }
  return { p, call, init }
}
// Read the file as written, without this change's module: the old code must be able to fail here.
const onRecord = () => { let raw = {}; try { raw = JSON.parse(read(SESSION) || '{}') } catch { } return raw.agents || (raw.name ? { [raw.name]: raw } : {}) }
const hook = (input) => {
  const env = { ...process.env }; delete env.CLAUDE_CODE_SESSION_ID; delete env.ANTIGRAVITY_CONVERSATION_ID
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hive-stop-hook.js')], { input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: false, cwd: D, ...input }), encoding: 'utf8', env, timeout: 30000 })
  return String(r.stdout || '') + String(r.stderr || '')
}

try {
  console.log('# two agents, both started in the same repo')
  const alice = agent('conv-alice'), bob = agent('conv-bob')
  await alice.init(); await bob.init()
  const joinedA = await alice.call('hive_join', { link: LINK, name: 'Alice-AI' })
  await bob.call('hive_join', { link: LINK, name: 'Bob-AI' })
  const rec = onRecord()
  const dirA = rec['Alice-AI'] && rec['Alice-AI'].dir, dirB = rec['Bob-AI'] && rec['Bob-AI'].dir
  T('S1 both agents are on record, each with its own folder', !!dirA && !!dirB && dirA !== dirB, `on record: ${Object.keys(rec).join(', ') || 'nobody'}`)

  await alice.call('hive_say', { text: '@Bob-AI note-for-bob' })
  await bob.call('hive_say', { text: '@Alice-AI note-for-alice' })
  const chatOf = (who) => read(path.join((rec[who] && rec[who].dir) || path.join(TMP, 'home', LINK.split('|')[1], who), 'HIVE_CHAT.md'))
  await until(() => ['Alice-AI', 'Bob-AI'].every((w) => /note-for-bob/.test(chatOf(w)) && /note-for-alice/.test(chatOf(w))), 15000)

  console.log("\n# each agent's Stop hook, run in the shared folder")
  const asBob = hook({ session_id: 'conv-bob' })
  T("S2a by conversation id: Bob's hook holds Bob's mail, not Alice's", /note-for-bob/.test(asBob) && !/note-for-alice/.test(asBob), asBob.replace(/\s+/g, ' ').slice(0, 140))
  const transcript = path.join(TMP, 'alice-transcript.jsonl')
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_join', name: 'mcp__hivecode__hive_join', input: { link: LINK, name: 'Alice-AI' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_join', content: [{ type: 'text', text: joinedA }] }] } }),
  ].join('\n') + '\n')
  const asAlice = hook({ session_id: 'a-conversation-no-server-recorded', transcript_path: transcript })
  T("S2b by transcript: Alice's hook holds Alice's mail, not Bob's", /note-for-alice/.test(asAlice) && !/note-for-bob/.test(asAlice), asAlice.replace(/\s+/g, ' ').slice(0, 140))
  const unknown = hook({ session_id: 'a-conversation-no-server-recorded' })
  // Neither agent's mail AND neither agent's name: a listener ordered under the wrong name is the
  // same impersonation as quoting the wrong mail, only quieter.
  T('S3 a hook that cannot tell which agent it guards speaks for neither', !/note-for-alice|note-for-bob|Alice-AI|Bob-AI/.test(unknown), unknown.replace(/\s+/g, ' ').slice(0, 140))

  console.log("\n# Bob's MCP server restarts (an app with no conversation id), while Alice's runs on")
  await alice.call('hive_check', {}) // Alice reads her mail: hers is now the latest write to the file
  bob.p.kill()
  await until(() => bob.p.exitCode !== null || bob.p.signalCode !== null, 10000)
  await sleep(1500)
  const bob2 = agent('')
  await bob2.init()
  const status = await bob2.call('hive_status', {}) // any tool but join/leave resumes from the file
  const back = onRecord()
  T('S4 the restarted server comes back as Bob, not as Alice', !!back['Bob-AI'] && back['Bob-AI'].pid === bob2.p.pid && !!back['Alice-AI'] && back['Alice-AI'].pid === alice.p.pid && !/Q581/.test(status),
    `on record: ${Object.entries(back).map(([n, s]) => `${n}@${s.pid}`).join(', ') || 'nobody'}; status: ${status.split('\n')[0].slice(0, 80)}`)

  console.log('\n# Alice leaves')
  await alice.call('hive_leave', {})
  const after = onRecord()
  T('S5 Alice leaving keeps Bob on record, and only Bob', !!after['Bob-AI'] && !after['Alice-AI'], `on record: ${Object.keys(after).join(', ') || 'nobody'}`)

  console.log("\n# the developer's repo")
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: D, encoding: 'utf8' }).stdout.trim()
  T("S6 neither of our files shows in the developer's git status", st === '', JSON.stringify(st))
  const { ALWAYS_IGNORE } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  T("S7 the Stop hook's own file never syncs into a room", Array.isArray(ALWAYS_IGNORE) && ALWAYS_IGNORE.includes('.hive-stop-hook.json'))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
}
console.log(`\n=== SHARED LAUNCH FOLDER: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
