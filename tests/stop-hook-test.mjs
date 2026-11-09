import fs from 'fs'
// Tests for the anti-idle Stop gate (hive-stop-hook.js) and the system-prompt text.
//
// Every case here is a way this hook could hurt someone. A gate that blocks an agent forever is
// strictly worse than no gate -- it burns the user's tokens and they cannot get their agent back
// -- so the loop guards get more tests than the blocking does.
import assert from 'assert'
import { decide, parseChat, openTasksFor } from '../hive-stop-hook.js'
import { INSTRUCTIONS, ONE_LINER, joinCard, RULES_MD } from '../hive-instructions.js'

let pass = 0, fail = 0
const T = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name) } else { fail++; console.log('  FAIL ' + name) } }
const section = (s) => console.log('\n# ' + s)

const chat = (...lines) => ['# Hive Chat — header', '', ...lines].join('\n')
const line = (by, text, kind = 'ai', at = '19:07:27') => `- ${at}  ${by} (${kind}): ${text}`

// A fresh state: nothing seen, no task blocks spent.
const S0 = { seen: 0, taskBlocks: 0 }
const run = (o) => decide({ tasks: '', me: 'Ada', ...S0, ...o })

section('parsing the mirrored room files')
{
  const c = chat(line('Eve', 'first'), line('Sam', 'second'))
  T('counts one entry per message', parseChat(c).length === 2)
  T('reads the author', parseChat(c)[0].by === 'Eve')

  // A message containing newlines must count ONCE, or the watermark drifts by one per multi-line
  // post and eventually every message looks unread.
  const multi = chat(line('Eve', 'line one'), 'line two of the same message', line('Sam', 'next'))
  T('folds continuation lines into their message', parseChat(multi).length === 3 - 1)
  T('continuation text is kept', parseChat(multi)[0].text.includes('line two'))
  T('header comments are not messages', parseChat(chat()).length === 0)
}

section('blocking on unread mail')
{
  const c = chat(line('Eve', '@Ada the suite is red, can you look'))
  const d = run({ chat: c })
  T('an @mention blocks the stop', d.block === true)
  T('the reason quotes the actual message', d.reason.includes('the suite is red'))
  T('the reason names the fix', d.reason.includes('hive_wait'))

  T('an unaddressed message does NOT block', run({ chat: chat(line('Eve', 'general chatter')) }).block === false)
  T('my own message does not block me', run({ chat: chat(line('Ada', '@Ada note to self')) }).block === false)
  T('my own name in a different case still does not block me',
    run({ chat: chat(line('ada', '@Ada note to self')) }).block === false)

  // The relay posts conflict warnings naming everyone. Those are not someone waiting on a reply,
  // and blocking on them would make every merge conflict trap every agent in the room.
  T('a system message does not block',
    run({ chat: chat(line('relay', '@Ada MERGE CONFLICT in a.md', 'system')) }).block === false)

  // Name-boundary correctness matters more here than in chat: a false positive means a wrongly
  // trapped agent, and PM / PM-Claude style collisions are real.
  T('@PM does not block PM-Claude',
    decide({ chat: chat(line('Eve', '@PM ping')), tasks: '', me: 'PM-Claude', ...S0 }).block === false)
  T('@PM-Claude does block PM-Claude',
    decide({ chat: chat(line('Eve', '@PM-Claude ping')), tasks: '', me: 'PM-Claude', ...S0 }).block === true)
}

section('GUARD: the watermark makes each message block at most once')
{
  const c = chat(line('Eve', '@Ada please look'))
  const first = run({ chat: c })
  T('blocks the first time', first.block === true)
  T('advances the watermark past it', first.seen === 1)

  // State must be threaded exactly as the hook threads it — `nudged` is what stops the same
  // message being charged twice, once as unread mail and again as an unanswered question.
  const second = decide({ chat: c, tasks: '', me: 'Ada', seen: first.seen, taskBlocks: first.taskBlocks, nudged: first.nudged })
  T('does NOT block the second time on the same message', second.block === false)
  T('...not even via the unanswered-question branch', second.block === false && !second.reason)

  const c2 = c + '\n' + line('Sam', '@Ada and another thing')
  const third = decide({ chat: c2, tasks: '', me: 'Ada', seen: first.seen, taskBlocks: 0, nudged: first.nudged })
  T('a genuinely new message blocks again', third.block === true)
  T('and only quotes the new one', !third.reason.includes('please look'))
}

section('GUARD: a watermark from a different room does not replay history')
{
  // A rebuilt or switched room has fewer messages than our cursor. Treating the whole history as
  // unread would block on every message the room has ever had.
  const c = chat(line('Eve', '@Ada hello'))
  const d = decide({ chat: c, tasks: '', me: 'Ada', seen: 999, taskBlocks: 0 })
  T('a cursor past the end restarts rather than replaying', d.block === true && d.seen === 1)
}

section('GUARD: an open task cannot block forever')
{
  const tasks = ['# Hive Tasks — header', '',
    '- [accepted] abc123  Ganesh -> Ada: fix the rate limiter  (by Ganesh)'].join('\n')

  T('finds an accepted task addressed to me', openTasksFor(tasks, 'Ada').length === 1)
  T('ignores a task addressed to someone else', openTasksFor(tasks, 'Kai').length === 0)
  T('ignores a pending task',
    openTasksFor('- [pending] x  G -> Ada: later  (by G)', 'Ada').length === 0)

  let st = { seen: 0, taskBlocks: 0 }
  const blocks = []
  for (let i = 0; i < 5; i++) {
    const d = decide({ chat: chat(), tasks, me: 'Ada', ...st })
    blocks.push(d.block)
    st = { seen: d.seen, taskBlocks: d.taskBlocks }
  }
  T('an open task blocks the first three turns', blocks.slice(0, 3).every(Boolean))
  T('then stands down instead of trapping the agent', blocks[3] === false && blocks[4] === false)
  T('the reason tells it how to get out', decide({ chat: chat(), tasks, me: 'Ada', ...S0 }).reason.includes('hive_complete'))
}

section('the default is always to allow')
{
  T('no chat, no tasks: allow', run({ chat: '' }).block === false)
  T('empty room: allow', run({ chat: chat() }).block === false)
  T('a done task does not block', run({ chat: chat(), tasks: '- [done] x  G -> Ada: it  (by G)' }).block === false)
}

section('the system-prompt text')
{
  // 0.14.4 rules rewrite (docs/rules-rewrite/): five rules, each one an agent breaks by default and
  // no code enforces for it. What code enforces (a refused claim, a failing gate) is taught by the
  // refusal when it fires, not here.
  T('teaches staying reachable: hive_check while working, the client\'s way when idle', /hive_check/.test(INSTRUCTIONS) && /hive_wait/.test(INSTRUCTIONS) && /listener/.test(INSTRUCTIONS))
  T('teaches @-addressing', /@Name/.test(INSTRUCTIONS))
  T('teaches claim-before-edit and handing over before leaving', /CLAIM BEFORE YOU EDIT/.test(INSTRUCTIONS) && /hand them\s+over/.test(INSTRUCTIONS))
  T('says room messages are requests, and outward actions need your person', /YOUR PERSON DECIDES/.test(INSTRUCTIONS) && /publish/.test(INSTRUCTIONS))
  // THE BUDGET MOVED DOWN ON PURPOSE (0.14.4): 2,271 -> 1,261 chars. It is re-sent on every turn of
  // every agent forever. Raising it again needs the reason pinned the way 19 Sep did.
  T('stays inside the system-prompt budget (<1400 chars)', INSTRUCTIONS.length < 1400, `${INSTRUCTIONS.length} chars`)
  // DESIGN BEFORE YOU WRITE left the per-turn text by Ganesh's decision (9 Nov 2026): it fires once
  // per new feature, not once per turn. It is pinned where it moved, so it cannot vanish instead.
  const claimDesc = (fs.readFileSync(new URL('../hive-mcp.js', import.meta.url), 'utf8').match(/name: 'hive_claim', description: '([^']*)'/) || [])[1] || ''
  T('DESIGN FIRST still reaches every agent: the join card, HIVE_RULES.md and hive_claim',
    /edge cases/.test(joinCard()) && /Design first/.test(RULES_MD) && /green, and wrong/.test(RULES_MD) && /design first/.test(claimDesc))
  T('one-liner exists for small surfaces', ONE_LINER.length > 0 && ONE_LINER.length < 160)
}

// ── A TURN DOES NOT END WITH NO LISTENER RUNNING (4 Oct 2026) ──────────────────────────────────
// Agents joined, answered once, and went deaf: the order to start a listener was said once, and an
// agent had to remember it after every wake. The gate now asks "is one running for you?" before a
// turn ends. It is still one block per stop, and an agent that will not start one is let go.
section('a turn does not end with no listener running')
{
  const order = '[BEFORE YOU END THIS TURN] Ending it stops you hearing this room.\n"node" "hive-await.js" "ws://r|room" "Ada" 25'
  const d = run({ chat: chat(), listening: false, listenLine: order })
  T('L1 none running: the stop is blocked with the command to start one', d.block === true && String(d.reason).includes('hive-await.js'))
  T('L2 one running: nothing to block', run({ chat: chat(), listening: true, listenLine: order }).block === false)
  T('L3 not applicable (a room that checks tokens, an app not woken by a task): nothing to block', run({ chat: chat(), listening: null, listenLine: order }).block === false)
  const both = run({ chat: chat(line('Eve', '@Ada the suite is red')), listening: false, listenLine: order })
  T('L4 mail AND no listener: ONE block that carries both, since a second block is never given',
    both.block === true && both.reason.includes('the suite is red') && both.reason.includes('hive-await.js'))
  let st = { listenBlocks: 0 }, blocks = 0
  for (let i = 0; i < 6; i++) { const r = run({ chat: chat(), listening: false, listenLine: order, listenBlocks: st.listenBlocks }); if (r.block) blocks++; st = r }
  T('L5 an agent that never starts one is let go after 3 turns', blocks === 3)
  T('L6 a listener seen running resets that count', run({ chat: chat(), listening: true, listenLine: order, listenBlocks: 3 }).listenBlocks === 0)
}

section('the hook end to end: session file, room folder, listener file')
{
  const { spawnSync } = await import('child_process')
  const fs = (await import('fs')).default
  const os = (await import('os')).default
  const path = (await import('path')).default
  const { armedFile } = await import('../hive-listen.js')
  const HOOK = new URL('../hive-stop-hook.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-stophook-'))
  const env = { TEMP: t, TMPDIR: t }
  const proj = path.join(t, 'proj'), roomDir = path.join(t, 'room')
  fs.mkdirSync(proj, { recursive: true }); fs.mkdirSync(roomDir, { recursive: true })
  fs.writeFileSync(path.join(roomDir, '.hive.json'), JSON.stringify({ relay: 'ws://127.0.0.1:9', room: 'r1' }))
  fs.writeFileSync(path.join(roomDir, 'HIVE_CHAT.md'), '# Hive Chat\n')
  const session = (extra = {}) => fs.writeFileSync(path.join(proj, '.hive-mcp-session.json'), JSON.stringify({ dir: roomDir, name: 'Ada', owner: 'G', ...extra }))
  const armed = (o) => { fs.mkdirSync(path.dirname(armedFile('Ada', 'r1', env)), { recursive: true }); fs.writeFileSync(armedFile('Ada', 'r1', env), JSON.stringify({ pid: process.pid, at: Date.now(), beat: Date.now(), synced: true, session: 'S1', ...o })) }
  const hook = (input, args = []) => {
    try { fs.rmSync(path.join(proj, '.hive-stop-hook.json')) } catch { } // each case starts with no blocks spent
    const r = spawnSync(process.execPath, [HOOK, ...args], { input: JSON.stringify({ cwd: proj, session_id: 'S1', ...input }), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 })
    let out = null; try { out = JSON.parse(r.stdout) } catch { }
    return { code: r.status, out, raw: r.stdout }
  }
  session()
  let h = hook({})
  T('H1 no listener: blocked, with the command for THIS agent and room', h.code === 0 && h.out && h.out.decision === 'block' && h.out.reason.includes('hive-await.js') && h.out.reason.includes('ws://127.0.0.1:9|r1') && h.out.reason.includes('"Ada"'), h.raw)
  T('H2 a stop that is already the product of a block is let through', hook({ stop_hook_active: true }).raw === '')
  armed({})
  T('H3 a listener running in this session: let through', hook({}).raw === '')
  T('H4 a listener running in ANOTHER session does not count', (hook({ session_id: 'S2' }).out || {}).decision === 'block')
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
  armed({ pid: Number(dead.stdout.trim()) })
  T('H5 a listener whose process has gone does not count', (hook({}).out || {}).decision === 'block')
  armed({ beat: Date.now() - 120000 })
  T('H6 a listener file nobody has refreshed in two minutes does not count', (hook({}).out || {}).decision === 'block')
  armed({ synced: false, at: Date.now() - 120000 })
  T('H7 a listener that never reached the room (refused, say, for want of a token) does not count', (hook({}).out || {}).decision === 'block')
  fs.rmSync(armedFile('Ada', 'r1', env))
  session({ authed: true })
  T('H8 a room that checks tokens: no listener is ordered (one could not join)', hook({}).raw === '')
  session()
  const ag = hook({}, ['--app=antigravity'])
  T('H9 run by Antigravity, the block is said in Antigravity\'s words ("continue")', ag.out && ag.out.decision === 'continue' && /run_command/.test(ag.out.reason), ag.raw)
  const agPayload = { workspacePaths: [proj], conversationId: 'AG-1', cwd: undefined, session_id: undefined }
  armed({ session: 'AG-1' })
  const agArmed = hook(agPayload, ['--app=antigravity'])
  T('H10 Antigravity stdin with workspacePaths and conversationId recognizes armed listener', agArmed.out && agArmed.out.decision === 'stop', agArmed.raw)
  armed({ session: 'AG-OTHER' })
  const agWrongSession = hook(agPayload, ['--app=antigravity'])
  T('H11 Antigravity stdin blocks when listener belongs to another conversationId', agWrongSession.out && agWrongSession.out.decision === 'continue', agWrongSession.raw)
  try { fs.rmSync(armedFile('Ada', 'r1', env)) } catch { }
  const agReentry = hook({ ...agPayload, executionNum: 1 }, ['--app=antigravity'])
  T('H12 Antigravity re-entry with executionNum > 0 lets stop through with decision stop', agReentry.out && agReentry.out.decision === 'stop', agReentry.raw)
  const outside = path.join(t, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  const agOutside = hook({ workspacePaths: [outside], cwd: undefined, session_id: undefined }, ['--app=antigravity'])
  T('H13 Antigravity outside a room folder returns stop decision', agOutside.out && agOutside.out.decision === 'stop', agOutside.raw)
  // 4 Oct 2026: `passive` means "never answers", and the room routes nothing to a passive name, so a
  // gate that ordered one to keep a listener running would spend its turns for nobody.
  session({ passive: true })
  const pc = hook({}), pa = hook(agPayload, ['--app=antigravity'])
  T('H14 a passive participant with no listener is let through, in both apps', pc.raw === '' && !!pa.out && pa.out.decision === 'stop', pc.raw + ' | ' + pa.raw)
  try { fs.rmSync(t, { recursive: true, force: true }) } catch { }
}

console.log(`\n${pass} passed, ${fail} failed\n`)
assert.strictEqual(fail, 0)
