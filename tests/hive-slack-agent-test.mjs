// hive-agent end to end: the Slack stop button really stops agents in a real room.
//
//   node tests/hive-slack-agent-test.mjs
//
// The claim under test is the product claim, not a rendering detail: a human who is not at
// their desk presses one button in Slack and every agent in the room stops picking up work.
// That spans a relay, a CRDT, the control map and the gate hive_wait reads -- so the only
// assertion that counts is `AgentA.isPaused()` going true on AGENT A'S OWN CLIENT, which is a
// different process's replica than the one the button wrote to.
//
// Slack itself is faked. Its HTTP is not the risky part and hive-slack-test already covers it.

import fs from 'fs'
import os from 'os'
import http from 'http'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import * as HSA from '../hive-slack-agent.js'
import { slackArgs, slackArgsError } from './fake-slack-args.mjs'
const { makeAgent, planChunks, route, snapshot, taskState, taskTitle, stopAll, preflightSlackAgent } = HSA

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1283, SLACK_PORT = 1284
const ROOM = 'agent-test-' + process.pid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ---- pure: the state join and the router --------------------------------------------------
console.log('\n# state mapping + routing')
{
  T('an accepted task is in progress', taskState({ status: 'accepted' }, false) === 'in_progress')
  T('a denied task is terminal, not pending', taskState({ status: 'denied' }, false) === 'error')
  T('done maps to completed', taskState({ status: 'done' }, false) === 'completed')
  // The panel must never show a spinner next to an agent somebody has halted.
  T('a PAUSED agent stops showing in progress', taskState({ status: 'accepted' }, true) === 'pending')
  T('and the title says why, so it is not confused with approval', /paused/.test(taskTitle({ to: 'A', text: 'x', status: 'accepted' }, true)))
  T('an unknown status degrades to pending, not to a crash', taskState({ status: 'weird' }, false) === 'pending')

  T('"stop" alone means everything', route('stop').intent === 'stop-all')
  T('"stop AgentB" targets one', route('stop AgentB').intent === 'stop' && route('stop AgentB').who === 'agentb')
  T('"stop all" is not read as an agent named all', route('stop all').intent === 'stop-all')
  T('resume is distinct from stop', route('resume all').intent === 'resume-all')
  T('a question is a status read', route('what is running?').intent === 'status')
  T('anything else is handed on, not guessed at', route('rewrite the parser').intent === 'ask')

  const snap = { people: [{ name: 'A', paused: true }, { name: 'B', paused: false }], open: 1, waiting: 1,
    pausedOf: (w) => w === 'A', tasks: [{ id: 't1', to: 'A', text: 'alpha', status: 'accepted', at: 1 }, { id: 't2', to: 'B', text: 'beta', status: 'pending', at: 2 }] }
  const chunks = planChunks(snap)
  T('the frame leads with a live count', /1\/2 running/.test(chunks[0].markdown_text), chunks[0].markdown_text)
  T('one task card per task', chunks.filter((c) => c.type === 'task_update').length === 2)
  T('the paused agent card is not in progress', chunks[1].task.status === 'pending')
}

// ---- end to end ---------------------------------------------------------------------------
console.log('\n# end to end: Slack stop button -> real agents paused')
let relay = null
const clients = []
const calls = []
let tsSeq = 3000
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-agent-t-'))
const slack = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    // Arguments as REAL Slack reads them (0.14.3 P0-4): a JSON body on a read method is not read.
    const method = req.url.split('/').pop().split('?')[0]
    const args = slackArgs(method, req.headers['content-type'], body, req.url)
    calls.push({ method, ...args })
    const argErr = slackArgsError(method, args)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(argErr || { ok: true, ts: String(tsSeq++) }))
  })
})
await new Promise((r) => slack.listen(SLACK_PORT, '127.0.0.1', r))
const post = async (m) => {
  const r = await fetch(`http://127.0.0.1:${SLACK_PORT}/api/${m.method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m),
  })
  return r.json()
}

try {
  const { WebSocketServer } = await import('ws')
  const { setupWSConnection } = await import('../vendor/y-websocket/utils.cjs')
  relay = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
  const wss = new WebSocketServer({ server: relay })
  wss.on('connection', (ws, req) => {
    const docName = (req.url || '/').slice(1).split('?')[0]
    setupWSConnection(ws, req, { docName })
  })
  await new Promise((r) => relay.listen(PORT, '127.0.0.1', r))

  const mk = (name, kind) => startSync({
    relay: `ws://127.0.0.1:${PORT}`, room: ROOM, dir: fs.mkdtempSync(path.join(tmp, name)),
    name, kind, syncFiles: false, log: () => {},
  })
  const panel = mk('Hivecode', 'human'); clients.push(panel)   // the Slack side
  const A = mk('AgentA', 'ai'); clients.push(A)
  const B = mk('AgentB', 'ai'); clients.push(B)
  await sleep(2500)

  T('the panel can see both agents', snapshot(panel).people.filter((p) => p.kind === 'ai').length === 2,
    snapshot(panel).people.map((p) => `${p.name}:${p.kind}`).join(' '))

  const agent = makeAgent({
    hive: panel, channel: 'D-TEST', token: 'xoxb-test', post,
    setStatus: (b) => post({ method: 'agents.sessions.setStatus', ...b }),
    // Who may act is decided by hive-slack.js's makeSlackActorCheck, the same rules as `slack start`.
    teamId: 'T1', allow: ['ganesh'], botUserId: 'U_BOT',
    lookupUser: async (id) => {
      if (id === 'outage') throw new Error('users.info is down')
      return { user: { id, name: id, team_id: id === 'ext' ? 'T_OTHER' : 'T1', is_restricted: id === 'guest', is_ultra_restricted: false } }
    },
  })

  // A real task, assigned by a real client, so the plan is built from the CRDT and not a fixture.
  panel.assign('AgentA', 'refactor the parser')
  await sleep(1500)
  await agent.onPrompt({ text: 'status', thread_ts: '1.1', user: 'ganesh' })
  const started = calls.find((c) => c.method === 'chat.startStream')
  T('the panel streams rather than posting a wall of text', !!started)
  T('it asks Slack for the plan layout', started && started.task_display_mode === 'plan')
  const appended = calls.find((c) => c.method === 'chat.appendStream')
  T('the real task reached the panel', !!appended && appended.chunks.some((c) => /refactor the parser/.test(c.task && c.task.title)),
    appended ? JSON.stringify(appended.chunks[0] && appended.chunks[0].task) : 'no append')
  T('the loading state was cleared, not left spinning for an hour',
    calls.filter((c) => c.method === 'agents.sessions.setStatus').some((c) => c.status === 'active'))

  // THE ONE THAT MATTERS. Press the native stop button.
  T('nobody is paused before the button', A.isPaused() === false && B.isPaused() === false)
  const stopped = await agent.onSessionStopped({ thread_ts: '1.1', user: 'ganesh' })
  await sleep(1500)
  T('the button reports which agents it stopped', stopped.length === 2, stopped.join(','))
  T('AgentA is paused ON ITS OWN CLIENT', A.isPaused() === true)
  T('AgentB is paused ON ITS OWN CLIENT', B.isPaused() === true)

  // Typed control, and the panel must tell the truth afterwards.
  await agent.onPrompt({ text: 'resume AgentA', thread_ts: '1.1', user: 'ganesh' })
  await sleep(1500)
  T('one agent resumed', A.isPaused() === false)
  T('the other stayed stopped', B.isPaused() === true)
  const frame = calls.filter((c) => c.method === 'chat.startStream').pop()
  T('the panel now reports 2/3 running, not 3/3', /2\/3 running/.test(frame.chunks[0].markdown_text),
    frame.chunks[0].markdown_text)

  // A panel that reports a stop it did not perform is worse than one that refuses.
  const ghost = await agent.onPrompt({ text: 'stop Nobody', thread_ts: '1.1', user: 'ganesh' })
  T('stopping someone who is not here is refused, not faked', ghost.ok === false)
  T('and no phantom control entry was written', !panel.doc.getMap('controls').get('nobody'))

  // A human is never paused: the control map is read by hive_wait, which only agents call.
  const ctl = panel.doc.getMap('controls')
  T('the human was not paused', !ctl.get('Hivecode') || ctl.get('Hivecode').state !== 'paused')

  // ---- where events may come from, and who may act on them -----------------------------------
  // The app's manifest subscribes message.channels and message.groups, so the agent hears every
  // channel the bot is in. And it used to act for anybody: no guest refusal, no --allow.
  console.log('\n# which channel, and who: the same rules as `slack start`')
  if (typeof agent.onEvent !== 'function') {
    T('the agent has one event entry point (agent.onEvent) that checks channel and actor', false, 'missing: main() dispatched raw events with no channel or actor check')
  } else {
    const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100) } return !!fn() }
    const msg = (user, text, extra = {}) => ({ type: 'message', channel: 'D-TEST', channel_type: 'im', ts: String(Math.random()), user, text, ...extra })
    const posted = (re) => calls.filter((c) => c.method === 'chat.postMessage' && re.test(c.text || ''))
    await agent.onEvent(msg('ganesh', 'resume all'))
    await until(() => !A.isPaused() && !B.isPaused())
    T('baseline: an allowed user resumed everyone', !A.isPaused() && !B.isPaused())

    // 1. another channel the bot happens to be in
    const nCalls = calls.length
    await agent.onEvent(msg('alice', 'stop all', { channel: 'C-OTHER', channel_type: 'channel' }))
    await sleep(1200)
    T('"stop all" typed in ANOTHER channel stops nothing and posts nothing there',
      !A.isPaused() && !B.isPaused() && !calls.slice(nCalls).some((c) => c.channel === 'C-OTHER'),
      JSON.stringify(calls.slice(nCalls).map((c) => c.method + '@' + c.channel)))

    // 2. a guest and an outside workspace are refused, for everything, even stop
    await agent.onEvent(msg('guest', 'stop all'))
    await agent.onEvent(msg('ext', 'stop all'))
    await sleep(1200)
    T('a guest and a Slack Connect user from another workspace cannot stop agents', !A.isPaused() && !B.isPaused())
    T('and they are told why, in the thread', posted(/guests and external Slack Connect users cannot/).length >= 2, `${posted(/guests and external/).length} refusal(s)`)
    T('a refused user is not shown the room\'s tasks (no plan frame was streamed for them)',
      !calls.slice(nCalls).some((c) => c.method === 'chat.startStream'))

    // 2b. guests and outside workspace are also refused for "status" (never streamed task plan)
    const nStatus = calls.length
    await agent.onEvent(msg('guest', 'status'))
    await agent.onEvent(msg('ext', 'status'))
    await sleep(1200)
    const statusRefusals = calls.slice(nStatus).filter((c) => c.method === 'chat.postMessage' && /guests and external Slack Connect users cannot/.test(c.text || ''))
    const statusStreams = calls.slice(nStatus).filter((c) => c.method === 'chat.startStream')
    T('a guest and an outside user typing status get refusal replies in thread',
      statusRefusals.length === 2, `${statusRefusals.length} refusal(s)`)
    T('a guest and an outside user typing status are never streamed task plans (no chat.startStream)',
      statusStreams.length === 0, `${statusStreams.length} stream(s)`)

    // 3. any full member may stop; it is attributed as slack:<handle>
    await agent.onEvent(msg('alice', 'stop all'))
    await until(() => A.isPaused() && B.isPaused())
    T('any full workspace member may stop every agent (paused ON THEIR OWN CLIENTS)', A.isPaused() && B.isPaused())
    const by = (panel.doc.getMap('controls').get('AgentA') || {}).by
    T('and the pause is attributed as slack:alice, not a bare name', by === 'slack:alice', String(by))

    // 4. resume needs --allow
    await agent.onEvent(msg('alice', 'resume all'))
    await sleep(1200)
    T('a full member who is not in --allow cannot resume (agents stay paused) and is told so',
      A.isPaused() && B.isPaused() && posted(/only Slack user IDs listed in --allow/).length >= 1)
    await agent.onEvent(msg('ganesh', 'resume all'))
    await until(() => !A.isPaused() && !B.isPaused())
    T('a user in --allow can resume', !A.isPaused() && !B.isPaused())

    // 5. each user has their own assistant DM: a DM that is not the configured one is a valid place
    const n2 = calls.length
    await agent.onEvent(msg('alice', 'status', { channel: 'D-ALICE' }))
    const fr = calls.slice(n2).find((c) => c.method === 'chat.startStream')
    T('a member\'s own assistant DM (any D… channel, channel_type im) is answered IN that DM',
      Boolean(fr) && fr.channel === 'D-ALICE', fr ? fr.channel : 'no frame')

    // 5b. DM robustness: channel starting with D is recognized as a DM even if channel_type is omitted
    const nDm = calls.length
    await agent.onEvent({ type: 'message', channel: 'D-BOB', ts: '10.1', user: 'alice', text: 'status' })
    const frBob = calls.slice(nDm).find((c) => c.method === 'chat.startStream')
    T('a DM event without channel_type: im (channel D…) is recognized as a DM',
      Boolean(frBob) && frBob.channel === 'D-BOB', frBob ? frBob.channel : 'no frame')

    // 6. Slack cannot say who it is (outage): stop goes through with the note, resume stays refused
    await agent.onEvent(msg('outage', 'stop all'))
    await until(() => A.isPaused() && B.isPaused())
    // The note rides in the frame's closing line (chat.stopStream), not in a separate message.
    const closings = () => calls.filter((c) => c.method === 'chat.stopStream').map((c) => (c.chunks && c.chunks[0] && c.chunks[0].markdown_text) || '')
    T('when users.info is down, stop still works ("I could not confirm who you are")',
      A.isPaused() && B.isPaused() && closings().some((t) => /could not confirm who you are/.test(t)),
      JSON.stringify(closings().slice(-2)))
    await agent.onEvent(msg('outage', 'resume all'))
    await sleep(1200)
    T('and resume stays refused', A.isPaused() && B.isPaused())
    await agent.onEvent(msg('ganesh', 'resume all'))
    await until(() => !A.isPaused() && !B.isPaused())

    // 7. the native stop button goes through the same check (and channel filter)
    const rForeign = await agent.onEvent({ type: 'agent_session_stopped', channel: 'C-OTHER', thread_ts: '9.0', user: 'alice' })
    await sleep(600)
    T('agent_session_stopped in ANOTHER channel is ignored and stops nothing',
      rForeign && rForeign.ignored === 'wrong_channel' && !A.isPaused() && !B.isPaused())
    await agent.onEvent({ type: 'agent_session_stopped', channel: 'D-TEST', thread_ts: '9.1', user: 'guest' })
    await sleep(1200)
    T('a guest pressing the native stop button stops nothing', !A.isPaused() && !B.isPaused())
    await agent.onEvent({ type: 'agent_session_stopped', channel: 'D-TEST', thread_ts: '9.2', user: 'alice' })
    await until(() => A.isPaused() && B.isPaused())
    T('a full member pressing the native stop button stops every agent', A.isPaused() && B.isPaused())
    await agent.onEvent(msg('ganesh', 'resume all'))
    await until(() => !A.isPaused() && !B.isPaused())

    // 8. the bot's own messages never act
    await agent.onEvent({ type: 'message', channel: 'D-TEST', channel_type: 'im', ts: '9.9', user: 'U_BOT', text: 'stop all' })
    await sleep(600)
    T('the bot\'s own message never acts', !A.isPaused() && !B.isPaused())
  }

  // ---- preflightSlackAgent scope check (Q634 + slack-app-manifest-agent.json) ----------------
  console.log('\n# preflightSlackAgent scope check')
  if (typeof preflightSlackAgent !== 'function') {
    T('preflightSlackAgent is exported from hive-slack-agent.js', false, 'missing export')
    T('preflightSlackAgent refuses with Q634 naming missing scopes and slack-app-manifest-agent.json', false, 'missing export')
    T('preflightSlackAgent succeeds when token has assistant:write, im:history, users:read, chat:write', false, 'missing export')
  } else {
    T('preflightSlackAgent is exported from hive-slack-agent.js', true)
    const badRes = await preflightSlackAgent({
      token: 'xoxb-outbound-only',
      appToken: 'xapp-ok',
      channel: 'D-TEST',
      fetchImpl: async (url) => ({
        status: 200,
        headers: new Map([['x-oauth-scopes', 'chat:write,channels:read,groups:read,users:read']]),
        json: async () => String(url).endsWith('/auth.test')
          ? { ok: true, user: 'hivecode', user_id: 'U_BOT', team_id: 'T1' }
          : { ok: true, url: 'ws://127.0.0.1:9999' },
      }),
    })
    T('preflightSlackAgent refuses with Q634 naming missing scopes and slack-app-manifest-agent.json',
      !badRes.ok &&
      badRes.code === 'Q634' &&
      /assistant:write/.test(badRes.error || '') &&
      /im:history/.test(badRes.error || '') &&
      /slack-app-manifest-agent\.json/.test(badRes.error || ''),
      badRes.error || 'succeeded unexpectedly')

    const okRes = await preflightSlackAgent({
      token: 'xoxb-agent-ok',
      appToken: 'xapp-ok',
      channel: 'D-TEST',
      fetchImpl: async (url) => ({
        status: 200,
        headers: new Map([['x-oauth-scopes', 'chat:write,assistant:write,im:history,im:read,im:write,users:read']]),
        json: async () => String(url).endsWith('/auth.test')
          ? { ok: true, user: 'hivecode', user_id: 'U_BOT', team_id: 'T1' }
          : { ok: true, url: 'ws://127.0.0.1:9999' },
      }),
    })
    T('preflightSlackAgent succeeds when token has assistant:write, im:history, users:read, chat:write',
      okRes.ok === true && okRes.url === 'ws://127.0.0.1:9999',
      okRes.error || '')

    const noTeam = await preflightSlackAgent({
      token: 'xoxb-agent-ok',
      appToken: 'xapp-ok',
      channel: 'D-TEST',
      fetchImpl: async (url) => ({
        status: 200,
        headers: new Map([['x-oauth-scopes', 'chat:write,assistant:write,im:history,im:read,im:write,users:read']]),
        json: async () => String(url).endsWith('/auth.test')
          ? { ok: true, user: 'hivecode', user_id: 'U_BOT' }
          : { ok: true, url: 'ws://127.0.0.1:9999' },
      }),
    })
    T('preflightSlackAgent refuses (Q634) when auth.test gives no team_id: outsiders could not be told apart',
      !noTeam.ok && noTeam.code === 'Q634' && /team_id/.test(noTeam.error || ''),
      noTeam.error || 'succeeded unexpectedly')

    const deadRes = await preflightSlackAgent({
      token: 'xoxb-agent-ok',
      appToken: 'xapp-ok',
      channel: 'D-TEST',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    })
    T('preflightSlackAgent returns Q636 and transient: true when Slack is unreachable',
      !deadRes.ok && deadRes.transient === true && deadRes.code === 'Q636' && /Q636 could not reach Slack/.test(deadRes.error || ''),
      deadRes.error || '')

    // ---- CLI main spawned checks (Q630 / Q634 missing tokens) ----------------
    console.log('\n# CLI main missing token checks')
    const agentScript = path.join(ROOT, 'hive-slack-agent.js')

    const runNoTokens = spawnSync(process.execPath, [agentScript, 'wss://relay|room-test', '--channel', 'D-TEST'], {
      env: { ...process.env, SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' },
      encoding: 'utf8',
    })
    T('slack agent with no tokens prints Q630 and usage and exits 2',
      runNoTokens.status === 2 &&
      /Q630.*SLACK_BOT_TOKEN is missing/.test(runNoTokens.stderr) &&
      /usage:/.test(runNoTokens.stderr),
      `code=${runNoTokens.status} err=${runNoTokens.stderr}`)

    const runNoAppToken = spawnSync(process.execPath, [agentScript, 'wss://relay|room-test', '--channel', 'D-TEST'], {
      env: { ...process.env, SLACK_BOT_TOKEN: 'xoxb-dummy', SLACK_APP_TOKEN: '' },
      encoding: 'utf8',
    })
    T('slack agent with no app token prints Q634 and usage and exits 2',
      runNoAppToken.status === 2 &&
      /Q634.*SLACK_APP_TOKEN is missing/.test(runNoAppToken.stderr) &&
      /usage:/.test(runNoAppToken.stderr),
      `code=${runNoAppToken.status} err=${runNoAppToken.stderr}`)
  }
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  if (relay) await new Promise((r) => relay.close(r))
  await new Promise((r) => slack.close(r))
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
