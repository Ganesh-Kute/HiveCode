// hive-slack end to end, against a FAKE Slack.
//
//   node tests/hive-slack-test.mjs
//
// There is no Slack workspace here and there should not be: the thing worth testing is OUR
// routing -- threading, pacing, the echo guard, what reaches the channel -- not Slack's HTTP.
// So a local server stands in for the Web API and records every call, and the room, relay and
// CRDT underneath are all real.

import fs from 'fs'
import os from 'os'
import http from 'http'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { makeBridge, makeQueue, render, TO_CHANNEL } from '../hive-slack.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1281, SLACK_PORT = 1282
const ROOM = 'slack-test-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- the fake Slack ------------------------------------------------------------------------
const calls = []
let tsSeq = 1000
const slack = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    const j = JSON.parse(body || '{}')
    calls.push({ method: req.url.split('/').pop(), auth: req.headers.authorization, at: Date.now(), ...j })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ts: String(tsSeq++) }))
  })
})
await new Promise((r) => slack.listen(SLACK_PORT, '127.0.0.1', r))
process.env.HIVE_SLACK_API = `http://127.0.0.1:${SLACK_PORT}/api`
const { slackPost } = await import('../hive-slack.js?fresh=1')

// ---- pure: pacing, rendering, routing ------------------------------------------------------
console.log('\n# routing + pacing')
{
  T('only open/done reach the channel', TO_CHANNEL.has('task-open') && !TO_CHANNEL.has('gate-fail'))
  T('a gate failure says where the file stayed', /stays with them/.test(render({ kind: 'gate-fail', by: 'A', file: 'x.js' })))
  T('chat renders as person then text', render({ kind: 'chat', by: 'Rai', text: 'hi' }) === '*Rai*: hi')

  // Slack drops or reorders past ~1 msg/sec per channel, so the queue must SPACE them.
  const stamps = []
  let clock = 0
  const q = makeQueue({
    send: async () => { stamps.push(clock); return { ok: true } },
    minGapMs: 1000,
    now: () => clock,
    timer: (fn, ms) => { clock += ms; fn() },      // virtual time: the test must not take 3s
  })
  await Promise.all([q.push({}), q.push({}), q.push({})])
  T('three bursts are paced ~1s apart', stamps.length === 3 && stamps[1] - stamps[0] >= 1000 && stamps[2] - stamps[1] >= 1000,
    stamps.join(','))
}

// ---- end to end ----------------------------------------------------------------------------
console.log('\n# end to end: room -> fake Slack -> room')
let relay = null
const clients = []
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-slack-t-'))
try {
  relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  relay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })

  const mk = (name) => startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: fs.mkdtempSync(path.join(tmp, name)),
    name, kind: 'ai', syncFiles: false, log: () => {},
  })
  const bridgeHive = mk('SlackBridge'); clients.push(bridgeHive)
  const agent = mk('AgentA'); clients.push(agent)
  await sleep(2000)

  const bridge = makeBridge({
    hive: bridgeHive, channel: 'C-TEST', token: 'xoxb-test', botName: 'SlackBridge',
    post: (m) => slackPost('chat.postMessage', m, 'xoxb-test'),
  })
  const chat = bridgeHive.doc.getArray('chat')
  let at = chat.length
  chat.observe(() => { const all = chat.toArray(); bridge.onChat(all.slice(at)); at = all.length })

  // 1. a task opens -> the CHANNEL, and a thread is born
  const open = await bridge.emit({ kind: 'task-open', task: 'T-1', to: 'AgentA' })
  T('task-open reached Slack', calls.length === 1 && calls[0].channel === 'C-TEST')
  T('it went to the channel, not a thread', !calls[0].thread_ts)
  T('the bot token was sent', calls[0].auth === 'Bearer xoxb-test')
  const ts = open.ts
  T('the thread id is stored in ROOM state', bridge.threads.get('T-1') === ts, `ts=${ts}`)

  // 2. everything else about that task lands INSIDE the thread
  await bridge.emit({ kind: 'gate-fail', task: 'T-1', by: 'AgentA', file: 'alpha.js' })
  T('the gate failure went into the task thread', calls[1].thread_ts === ts, `thread_ts=${calls[1].thread_ts}`)

  // 3. a real room message crosses to Slack
  agent.doc.getArray('chat').push([{ by: 'AgentA', kind: 'say', at: Date.now() * 1000, text: 'claiming alpha.js' }])
  await sleep(2500)
  T('a room message crossed to Slack', calls.some((c) => c.text === '*AgentA*: claiming alpha.js'),
    `${calls.length} call(s)`)

  // 4. a human replies in the thread -> back into the room
  const before = calls.length
  bridge.deliver({ thread_ts: ts, text: '@AgentA use the other helper', user: 'ganesh' })
  await sleep(2500)
  const roomChat = agent.doc.getArray('chat').toArray()
  T('the Slack reply arrived in the room', roomChat.some((m) => m.text === '@AgentA use the other helper' && m.viaSlack))
  T('it was attributed to the task it replied to', roomChat.some((m) => m.viaSlack && m.task === 'T-1'))

  // 5. THE ECHO GUARD: that reply must not be sent straight back out to Slack
  await sleep(1500)
  T('the reply did NOT echo back to Slack', calls.length === before,
    `${calls.length - before} extra call(s)`)
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  try { relay && relay.kill() } catch { /* already gone */ }
  await new Promise((r) => slack.close(r))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
