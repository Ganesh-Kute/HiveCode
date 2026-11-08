// A "stop" typed in Slack must not be answered "paused" when the room refused it.
//
// WHY (8 Nov 2026). The relay's governor reverts a write to the room's controls from anyone who
// may not control: every AI, and on a strict room anyone without a human token. The Slack bridge
// wrote the control, then told Slack "*alice* paused *AgentA*" without looking. The relay put the
// control back one round trip later, so the person in Slack was told the agents stopped and they
// kept running. hive-slack-test never saw it: its relay is a bare y-websocket server with no
// governor. This test runs the real server.js.
//
//   C1  refused stop (bridge has no right to control): Slack hears it was refused, not "paused"
//   C2  allowed stop (bridge joins as a human on an open room): Slack hears "paused", agent paused
//   C3  refused "stop all": Slack hears it was refused, names the agent
//   C4  refused resume: Slack hears it was refused, not "resumed"
//   C5  a later legitimate change (a human resumes) is not reported as a refusal
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
const { makeBridge } = await import(pathToFileURL(path.join(ROOT, 'hive-slack.js')).href)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `   ${detail}`}`) }
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const waitFor = async (fn, ms = 8000, step = 50) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step) } return false }

const port = await freePort()
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
let relayOut = ''
relay.stdout.on('data', (d) => { relayOut += d })
relay.stderr.on('data', (d) => { relayOut += d })
if (!(await waitFor(() => /listening on/.test(relayOut), 15000))) { console.log('relay did not start:\n' + relayOut); relay.kill(); process.exit(1) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ctl-'))
const clients = []
const join = (room, name, kind) => {
  const h = startSync({ relay: `ws://127.0.0.1:${port}`, room, dir: fs.mkdtempSync(path.join(tmp, name)), name, kind, syncFiles: false, log: () => {} })
  clients.push(h)
  return h
}
const USERS = { U_ALICE: { id: 'U_ALICE', name: 'alice' } }

async function scene(room, bridgeKind, confirmMs = 1500) {
  const agent = join(room, 'AgentA', 'ai')
  await sleep(600)
  const bridgeHive = join(room, 'SlackBridge', bridgeKind)
  await waitFor(() => (bridgeHive.members ? bridgeHive.members() : []).some((p) => p.name === 'AgentA'))
  const posts = []
  const bridge = makeBridge({
    hive: bridgeHive, channel: 'C-TEST', token: 'xoxb-test', botName: 'SlackBridge', room,
    allow: ["U_ALICE"], minGapMs: 0, controlConfirmMs: confirmMs,
    post: async (m) => { posts.push(m); return { ok: true, ts: String(1700000000 + posts.length) + '.000100' } },
    lookupUser: async (id) => ({ ok: true, user: USERS[id] }),
  })
  const say = async (text) => { const before = posts.length; await bridge.onInboundEvent({ type: 'message', channel: 'C-TEST', ts: '1700000999.000001', thread_ts: '1700000001.000100', user: 'U_ALICE', text }); await waitFor(() => posts.length > before, 4000); return posts.slice(before).map((p) => p.text).join('\n') }
  return { agent, bridgeHive, bridge, posts, say }
}

try {
  // A bridge joined as 'ai' stands in for any bridge the room will not let control: the governor
  // reverts its writes exactly as it reverts a non-human on a strict room.
  {
    const s = await scene('ctl-refused-' + Date.now(), 'ai')
    const reply = await s.say('stop AgentA')
    await sleep(300)
    T('C1 refused stop: Slack is NOT told "paused"', !/paused \*?AgentA/.test(reply), JSON.stringify(reply))
    T('C1 refused stop: Slack is told it was refused', /refused|did not take|not stopped/i.test(reply), JSON.stringify(reply))
    T('C1 refused stop: AgentA really is still running', !s.agent.isPaused(), 'agent paused')

    const replyAll = await s.say('stop all')
    T('C3 refused stop all: Slack is NOT told "paused"', !/paused \*?AgentA/.test(replyAll), JSON.stringify(replyAll))
    T('C3 refused stop all: the refusal names AgentA', /refused|did not take|not stopped/i.test(replyAll) && /AgentA/.test(replyAll), JSON.stringify(replyAll))

    const replyResume = await s.say('resume AgentA')
    T('C4 refused resume: Slack is NOT told "resumed"', !/resumed \*?AgentA/.test(replyResume), JSON.stringify(replyResume))
    T('C4 refused resume: Slack is told it was refused', /refused|did not take|not resumed/i.test(replyResume), JSON.stringify(replyResume))
  }

  {
    const s = await scene('ctl-allowed-' + Date.now(), 'human')
    const reply = await s.say('stop AgentA')
    const paused = await waitFor(() => s.agent.isPaused(), 4000)
    T('C2 allowed stop: Slack is told "paused"', /paused \*?AgentA/.test(reply), JSON.stringify(reply))
    T('C2 allowed stop: AgentA really is paused', paused, 'agent not paused')
    T('C2 allowed stop: no refusal message', !/refused|did not take/i.test(reply), JSON.stringify(reply))

    // A human in the room resumes AgentA a moment later: a new change, not the relay undoing ours.
    const before = s.posts.length
    s.bridgeHive.control('AgentA', 'running', 'Ganesh')
    await sleep(2500)
    const after = s.posts.slice(before).map((p) => p.text).join('\n')
    T('C5 a later legitimate resume is not reported as a refusal', !/refused|did not take|undid/i.test(after), JSON.stringify(after))
  }

  // C6: the revert lands after the bridge already confirmed (a 1 ms settle window stands in for a
  // slow link). Slack must be corrected in the same thread, not left believing "paused".
  {
    const s = await scene('ctl-late-' + Date.now(), 'ai', 1)
    await s.say('stop AgentA')
    // Two honest outcomes, depending on whether the revert beats the 1 ms settle (measured: Linux CI
    // 8 Nov saw the revert first, so the bridge said "refused"; Windows sees "paused" then "undid").
    // What must never happen is a "paused" that Slack is left believing.
    const texts = () => s.posts.map((p) => p.text || '')
    const honest = () => {
      const t = texts()
      const lastPaused = t.map((x) => /paused/i.test(x) && !/refused|undid/i.test(x)).lastIndexOf(true)
      const fixed = t.findIndex((x, i) => i > lastPaused && /AgentA/.test(x) && /undid|refused/i.test(x))
      return fixed !== -1
    }
    const corrected = await waitFor(honest, 5000)
    T('C6 a revert after the confirm is corrected in Slack', corrected, JSON.stringify(texts()))
    T('C6 the correction goes in the same thread', s.posts.filter((p) => /undid/.test(p.text || '')).every((p) => p.thread_ts === '1700000001.000100'), JSON.stringify(s.posts))
    T('C6 AgentA really is running', !s.agent.isPaused(), 'agent paused')
  }
} finally {
  for (const c of clients) { try { c.stop() } catch { } }
  relay.kill()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
