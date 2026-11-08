// ROOM MODE'S WATCHER (hive-room-watcher.js): GitHub issues to the agents already in a room.
//
//   node tests/room-watcher-test.mjs
//
// The state machine, with GitHub faked and the room side passed in, so every rule is exact. The
// room side (postIssue, landIssue, peekRoom) has its own real-relay tests. Each group is a way the
// watcher hurts somebody when it is wrong.
import fs from 'fs'
import os from 'os'
import path from 'path'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const url = (f) => `file:///${ROOT.replace(/\\/g, '/')}/${f}`
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

let W
try { W = await import(url('hive-room-watcher.js')) } catch (e) { console.log(`  FAIL hive-room-watcher.js does not load: ${e.message}`); console.log('\n0 passed, 1 failed'); process.exit(1) }

const ROOM_ID = 'room-SECRETxyzSECRETxyz12'
const LINK = `wss://relay.example|${ROOM_ID}`

function fakeGitHub() {
  const S = { issues: new Map(), events: new Map(), perms: { owner: 'admin', pal: 'write', stranger: 'read' }, comments: [], labels: [], pulls: new Map() }
  const gh = {
    labeledIssues: (label) => [...S.issues.values()].filter((i) => i.state === 'open' && i.labels.includes(label)).map((i) => ({ number: i.number, title: i.title, body: i.body, user: { login: i.author }, labels: i.labels.map((name) => ({ name })) })),
    issueEvents: (n) => S.events.get(n) || [],
    permission: (login) => S.perms[login] || 'none',
    comment: (n, body) => { S.comments.push({ n, body }); return { id: S.comments.length } },
    addLabel: (n, name) => { S.labels.push({ n, name }); const i = S.issues.get(n); if (i) i.labels.push(name) },
    pull: (n) => S.pulls.get(n) || { number: n, state: 'closed' },
    comments: (n) => S.comments.filter((c) => c.n === n),
    removeLabel: (n, name) => { const i = S.issues.get(n); if (i) i.labels = i.labels.filter((l) => l !== name) },
  }
  let cid = 9000
  const say = (n, body, by = 'owner') => S.comments.push({ n, body, id: ++cid, user: { login: by, type: 'User' }, author_association: by === 'stranger' ? 'NONE' : 'OWNER' })
  const file = (n, { by = 'owner', title = `Issue ${n}`, body = 'do it' } = {}) => {
    S.issues.set(n, { number: n, title, body, author: by, state: 'open', labels: ['hivecode'] })
    S.events.set(n, [{ event: 'labeled', label: { name: 'hivecode' }, actor: { login: by, type: 'User' } }])
  }
  return { gh, S, file, say }
}

function harness({ fallbackAgent = '', ackMinutes = 10, maxMinutes = 120, maxRuns = 3, maxRunsPerDay = 20, stateFile } = {}) {
  const { gh, S, file, say } = fakeGitHub()
  const clock = { t: Date.parse('2026-11-05T10:00:00Z') }
  const calls = { post: [], land: [], peek: [], say: [], spawn: [] }
  const behave = {
    post: () => ({ ok: true, taskId: `t${calls.post.length}`, comment: 'Sent to room for branch fix. In the room now: Claude, antigravity-2' }),
    land: () => ({ ok: false, why: 'not ready: task is accepted', reasons: ['task is accepted'] }),
    peek: () => ({ ok: true, agents: ['Claude'], reachable: ['Claude'], engaged: false, lastLines: ['Claude: looking'] }),
  }
  const deps = {
    postIssue: async (a) => { calls.post.push(a); return behave.post(a) },
    landIssue: async (a) => { calls.land.push(a); return behave.land(a) },
    peek: async (a) => { calls.peek.push(a); return behave.peek(a) },
    say: async (text) => { calls.say.push(text); return { ok: true } },
    spawn: (a) => { calls.spawn.push(a); return { pid: 4242 } },
    commands: (a) => W.readCommands({ gh, ...a }),
  }
  const sf = stateFile || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'room-watcher-')), 'room.json')
  const w = W.makeRoomWatcher({ gh, link: LINK, branch: 'fix', stateFile: sf, deps, fallbackAgent, ackMinutes, maxMinutes, maxRuns, maxRunsPerDay, host: 'devbox', now: () => clock.t })
  return { w, gh, S, file, say, calls, behave, clock, sf, deps }
}
const comments = (S, n) => S.comments.filter((c) => c.n === n).map((c) => c.body)

// ─── A. INTAKE: who may hand work to the room ────────────────────────────────────────────────
console.log('\n# A. only a label from someone who can push starts work')
{
  const h = harness()
  h.file(1, { by: 'stranger' })
  await h.w.tick()
  T('A1 an issue labelled by someone who cannot push is skipped, never posted', h.calls.post.length === 0 && h.w.state.issues[1].status === 'skipped')
  h.file(2, { by: 'pal' })
  await h.w.tick()
  T('A2 one labelled by a writer is posted to the room, as data with its author', h.calls.post.length === 1 && h.calls.post[0].issue.number === 2 && h.calls.post[0].issue.labeller === 'pal')
  T('A3 ...and the issue gets ONE comment saying who is in the room', comments(h.S, 2).length === 1 && /In the room now: Claude/.test(comments(h.S, 2)[0]))
  await h.w.tick(); await h.w.tick()
  T('A4 later ticks do not post it again or comment again', h.calls.post.length === 1 && comments(h.S, 2).length === 1)
}

// ─── B. ONE AT A TIME, ONE OPEN PR ───────────────────────────────────────────────────────────
console.log('\n# B. one issue at a time; the next waits for the PR to be merged or closed')
{
  const h = harness()
  h.file(1); h.file(2)
  await h.w.tick()
  T('B1 with two labelled issues, only the first is posted', h.calls.post.length === 1 && h.calls.post[0].issue.number === 1)
  h.behave.land = () => ({ ok: true, pr: { number: 7, url: 'https://github.com/o/r/pull/7' }, why: 'landed 2 commit(s); tests passed' })
  h.S.pulls.set(7, { number: 7, state: 'open' })
  await h.w.tick()
  T('B2 when it lands, the issue gets the PR, and the room is told', comments(h.S, 1).some((b) => /pull request #7/.test(b)) && h.calls.say.some((s) => /issue #1 landed as PR #7/.test(s)))
  await h.w.tick()
  T('B3 while PR #7 is open, issue #2 waits', h.calls.post.length === 1)
  h.S.pulls.set(7, { number: 7, state: 'closed' })
  await h.w.tick()
  T('B4 once PR #7 is merged or closed, issue #2 is posted', h.calls.post.length === 2 && h.calls.post[1].issue.number === 2)
}

// ─── C. WITHDRAWN MID-RUN ────────────────────────────────────────────────────────────────────
console.log('\n# C. closed or unlabelled while the room works on it: stop, and land nothing')
{
  const h = harness()
  h.file(1)
  await h.w.tick()
  h.S.issues.get(1).labels = []
  const landsBefore = h.calls.land.length
  await h.w.tick()
  T('C1 the room is told to stop work on it', h.calls.say.some((s) => /issue #1 was closed or unlabelled/.test(s) && /stop work/.test(s)))
  T('C2 ...nothing was landed for it, and it is no longer active', h.calls.land.length === landsBefore && !h.w.state.active && h.w.state.issues[1].status === 'withdrawn')
}

// ─── D. FAILING TESTS GO BACK TO THE ROOM, A LIMITED NUMBER OF TIMES ─────────────────────────
console.log('\n# D. failing tests: back to the room, counted, then a person')
{
  const h = harness({ maxRuns: 2 })
  h.file(1)
  await h.w.tick()
  h.behave.land = () => ({ ok: false, code: 'Q576', why: 'tests failed', state: { lastFailedFingerprint: 'fp1' } })
  await h.w.tick()
  T('D1 the issue is told the tests failed and it went back to the room (attempt 1 of 2)', comments(h.S, 1).some((b) => /tests failed/.test(b) && /attempt 1 of 2/.test(b)))
  // landIssue itself skips an unchanged room (same fingerprint): the watcher's part is to pass the
  // fingerprint on, and to neither count nor comment on a skip.
  h.behave.land = () => ({ ok: false, skipped: true, why: 'no changes since last failed landing', state: { lastFailedFingerprint: 'fp1' } })
  const before = comments(h.S, 1).length
  await h.w.tick()
  T('D2 ...and the failure fingerprint is passed to the next landing', h.calls.land[h.calls.land.length - 1].lastFailedFingerprint === 'fp1')
  T('D3 an unchanged room is not re-tested and adds no comment', comments(h.S, 1).length === before && h.w.state.active && h.w.state.active.runs === 1)
  h.behave.land = () => ({ ok: false, code: 'Q576', why: 'tests failed again', state: { lastFailedFingerprint: 'fp2' } })
  await h.w.tick()
  T('D4 the limit reached: hivecode:needs-human, the room told, nothing active', h.S.labels.some((l) => l.n === 1 && l.name === 'hivecode:needs-human') && !h.w.state.active && h.calls.say.some((s) => /handed to a person/.test(s)))
}

// ─── E. NOBODY TAKES IT: THE FALLBACK (opt-in) ───────────────────────────────────────────────
console.log('\n# E. the reachability-gated fallback')
{
  const h = harness({ fallbackAgent: 'claude -p' })
  h.behave.peek = () => ({ ok: true, agents: ['antigravity-2'], reachable: [], engaged: false, lastLines: [] })
  h.file(1)
  await h.w.tick() // posted
  await h.w.tick() // nobody can hear it: at once, no waiting
  T('E1 nobody in the room can hear it: the fallback starts at once', h.calls.spawn.length === 1 && /Builder/.test(h.calls.spawn[0].prompt) && h.calls.spawn[0].prompt.includes(LINK))
  T('E2 ...said in the room and on the issue, naming the command, the machine and the count', h.calls.say.some((s) => /started `claude -p` on devbox/.test(s)) && comments(h.S, 1).some((b) => /fallback agent/.test(b) && /devbox/.test(b) && /1 of 20/.test(b)))
  await h.w.tick()
  T('E3 never a second fallback for the same issue', h.calls.spawn.length === 1)
}
{
  const h = harness({ fallbackAgent: 'claude -p', ackMinutes: 10 })
  h.file(1)
  await h.w.tick()
  h.clock.t += 5 * 60000; await h.w.tick()
  T('E4 someone can hear it: no fallback before --ack-minutes', h.calls.spawn.length === 0)
  h.clock.t += 6 * 60000; await h.w.tick()
  T('E5 reachable but nobody engaged after --ack-minutes: the fallback starts (busy elsewhere does not block it)', h.calls.spawn.length === 1)
}
{
  const h = harness({ fallbackAgent: 'claude -p', ackMinutes: 10 })
  h.behave.peek = () => ({ ok: true, agents: ['Claude'], reachable: ['Claude'], engaged: true, lastLines: [] })
  h.file(1)
  await h.w.tick(); h.clock.t += 30 * 60000; await h.w.tick()
  T('E6 an agent engaged with the issue: never a fallback', h.calls.spawn.length === 0)
}
{
  const h = harness({ fallbackAgent: 'claude -p', maxRunsPerDay: 0 })
  h.behave.peek = () => ({ ok: true, agents: [], reachable: [], engaged: false, lastLines: [] })
  h.file(1)
  await h.w.tick(); await h.w.tick(); await h.w.tick()
  T('E7 the daily cap used up: no spawn, and one comment saying so', h.calls.spawn.length === 0 && comments(h.S, 1).filter((b) => /limit/.test(b)).length === 1)
}
{
  const h = harness({ ackMinutes: 10 })
  h.behave.peek = () => ({ ok: true, agents: ['antigravity-2'], reachable: [], engaged: false, lastLines: [] })
  h.file(1)
  await h.w.tick(); h.clock.t += 11 * 60000; await h.w.tick(); await h.w.tick()
  T('E8 without --fallback-agent: ONE comment that nobody took it and nobody can hear it, never a spawn', h.calls.spawn.length === 0 && comments(h.S, 1).filter((b) => /no agent has taken it/.test(b)).length === 1 && comments(h.S, 1).some((b) => /can hear it/.test(b)))
}

// ─── F. TIME LIMIT ───────────────────────────────────────────────────────────────────────────
console.log('\n# F. a room that never finishes goes to a person, with its last lines')
{
  const h = harness({ maxMinutes: 60 })
  h.file(1)
  await h.w.tick(); h.clock.t += 61 * 60000; await h.w.tick()
  T('F1 past --max-minutes: needs-human, with the last room lines, nothing active', h.S.labels.some((l) => l.name === 'hivecode:needs-human') && comments(h.S, 1).some((b) => /more than 60 minutes/.test(b) && /Claude: looking/.test(b)) && !h.w.state.active)
}

// ─── G. THE RELAY IS DOWN WHEN POSTING ───────────────────────────────────────────────────────
console.log('\n# G. the room cannot be reached: retried, said once, never marked sent')
{
  const h = harness()
  h.behave.post = () => ({ ok: false, code: 'Q656', why: 'relay unreachable' })
  h.file(1)
  await h.w.tick(); await h.w.tick()
  T('G1 two failures: no comment yet, nothing active', comments(h.S, 1).length === 0 && !h.w.state.active)
  await h.w.tick(); await h.w.tick()
  T('G2 the third says it once; the fourth adds nothing', comments(h.S, 1).length === 1 && /could not reach the room/.test(comments(h.S, 1)[0]))
  h.behave.post = () => ({ ok: true, taskId: 'tz', comment: 'Sent to room' })
  await h.w.tick()
  T('G3 when the room answers, it is posted and becomes active', h.w.state.active && h.w.state.active.n === 1 && h.w.state.active.taskId === 'tz')
}

// ─── H. A RESTART ────────────────────────────────────────────────────────────────────────────
console.log('\n# H. the watcher restarts mid-issue: it carries on, never posts twice')
{
  const h = harness()
  h.file(1)
  await h.w.tick()
  const again = W.makeRoomWatcher({ gh: h.gh, link: LINK, branch: 'fix', stateFile: h.sf, deps: h.deps, now: () => h.clock.t })
  await again.tick()
  T('H1 a new watcher on the same state file continues the active issue, with no second post', h.calls.post.length === 1 && again.state.active && again.state.active.n === 1 && h.calls.land.length >= 1)
  fs.writeFileSync(h.sf, '{ not json')
  const third = W.makeRoomWatcher({ gh: h.gh, link: LINK, branch: 'fix', stateFile: h.sf, deps: h.deps, now: () => h.clock.t })
  let threw = false
  try { await third.tick() } catch { threw = true }
  T('H2 an unreadable state file does not crash the watcher', !threw)
}

// ─── J. A LONE AGENT AND THE REVIEW RULE ─────────────────────────────────────────────────────
console.log('\n# J. a lone agent cannot get a second review: it lands, said in words; a FAIL never does')
{
  const h = harness({ ackMinutes: 10 })
  h.behave.peek = () => ({ ok: true, agents: ['Claude'], reachable: ['Claude'], engaged: true, lastLines: [] })
  h.behave.land = (a) => (a.allowUnreviewed ? { ok: true, pr: { number: 9, url: 'u' }, why: 'landed; not reviewed by a second agent: app.js' } : { ok: false, blocked: 'unreviewed', files: ['app.js'], why: 'app.js has not been reviewed' })
  h.file(1)
  await h.w.tick() // posted
  await h.w.tick() // done, blocked only on reviews: the clock starts
  // One agent all along: the solo grace (2 min, group N) applies, not --ack-minutes.
  h.clock.t += 1 * 60000; await h.w.tick()
  T('J1 before the grace runs out the waiver is not used', h.calls.land.every((c) => !c.allowUnreviewed) && h.w.state.active)
  h.clock.t += 6 * 60000; await h.w.tick()
  T('J2 one agent, nobody else to review, past the grace: it lands with the waiver', h.calls.land.some((c) => c.allowUnreviewed) && h.w.state.issues[1].status === 'landed')
}
{
  const h = harness({ ackMinutes: 10 })
  h.behave.peek = () => ({ ok: true, agents: ['Claude', 'antigravity-2'], reachable: ['Claude', 'antigravity-2'], engaged: true, lastLines: [] })
  h.behave.land = () => ({ ok: false, blocked: 'unreviewed', files: ['app.js'], why: 'app.js has not been reviewed' })
  h.file(1)
  await h.w.tick(); await h.w.tick(); h.clock.t += 30 * 60000; await h.w.tick()
  T('J3 a second agent is there to review: the waiver is never used', h.calls.land.every((c) => !c.allowUnreviewed))
}
{
  const h = harness({ ackMinutes: 10 })
  h.behave.peek = () => ({ ok: true, agents: ['Claude'], reachable: ['Claude'], engaged: true, lastLines: [] })
  h.behave.land = () => ({ ok: false, why: 'app.js has an unresolved fail review', reasons: ['app.js has an unresolved fail review'] })
  h.file(1)
  await h.w.tick(); await h.w.tick(); h.clock.t += 30 * 60000; await h.w.tick(); await h.w.tick()
  T('J4 a FAIL review is never waived, however long it waits', h.calls.land.every((c) => !c.allowUnreviewed))
}

// ─── K. REVIEW COMMENTS ON THE PR GO BACK TO THE ROOM (B4) ───────────────────────────────────
console.log('\n# K. review comments on the open PR become a room task; the fix updates the same PR')
{
  const h = harness()
  const fbCalls = []
  let fbAnswer = { ok: true, noop: true, settled: true, items: [], state: { seen: { rc: 0 } } }
  h.deps.prFeedback = async (a) => { fbCalls.push(a); return fbAnswer }
  h.file(1)
  await h.w.tick()
  h.behave.land = () => ({ ok: true, pr: { number: 7, url: 'u7' }, why: 'landed' })
  h.S.pulls.set(7, { number: 7, state: 'open' })
  await h.w.tick() // landed as PR #7
  await h.w.tick()
  T('K1 with the PR open and no review yet, feedback is read but nothing is sent', fbCalls.length === 1 && fbCalls[0].prNumber === 7 && fbCalls[0].issueNumber === 1 && !h.w.state.active)
  fbAnswer = { ok: true, taskId: 'tR', items: [{ id: 1 }, { id: 2 }], state: { seen: { rc: 2 } } }
  await h.w.tick()
  T('K2 a settled review becomes the active task, said once on the PR', h.w.state.active && h.w.state.active.kind === 'review' && h.w.state.active.taskId === 'tR' && h.S.comments.filter((c) => c.n === 7 && /Sent 2 review comment/.test(c.body)).length === 1)
  T('K3 ...and only the feedback state postPrFeedback returned is kept', JSON.stringify(h.w.state.prState) === JSON.stringify({ seen: { rc: 2 } }))
  h.behave.land = () => ({ ok: true, pr: { number: 7, url: 'u7', newCommits: 1, updated: true }, why: 'updated PR #7' })
  await h.w.tick()
  T('K4 the fix lands on the SAME PR: said on PR #7, the next issue still waits for it', h.S.comments.some((c) => c.n === 7 && /fixes for the review are pushed/.test(c.body)) && !h.w.state.active && h.w.state.openPr === 7)
}
{
  const h = harness()
  h.deps.prFeedback = async () => ({ ok: true, taskId: 'tR', items: [{ id: 1 }], state: {} })
  h.file(1)
  await h.w.tick()
  h.behave.land = () => ({ ok: true, pr: { number: 7, url: 'u7' }, why: 'landed' })
  h.S.pulls.set(7, { number: 7, state: 'open' })
  await h.w.tick(); await h.w.tick() // landed, then the review task
  h.S.pulls.set(7, { number: 7, state: 'closed', merged: true })
  const landsBefore = h.calls.land.length
  await h.w.tick()
  T('K5 the PR merged under a review fix: the room is told to stop, nothing more lands', h.calls.say.some((s) => /PR #7 was merged/.test(s)) && h.calls.land.length === landsBefore && !h.w.state.active)
}
{
  const h = harness()
  h.deps.prFeedback = async () => ({ ok: true, noop: true, stop: true, items: [], state: {} })
  h.file(1)
  await h.w.tick()
  h.behave.land = () => ({ ok: true, pr: { number: 7, url: 'u7' }, why: 'landed' })
  h.S.pulls.set(7, { number: 7, state: 'open' })
  await h.w.tick(); await h.w.tick()
  T('K6 /hivecode stop on the PR: the room is told to stop', h.calls.say.some((s) => /hivecode stop on PR #7/.test(s)))
}


// ─── L. A PERSON'S STOP AND RETRY, AT ANY MOMENT ─────────────────────────────────────────────
console.log('\n# L. /hivecode stop works mid-work; /hivecode retry hands it back')
{
  const h = harness()
  h.file(1)
  h.say(1, '/hivecode stop') // said BEFORE this run: history, not an order for it
  await h.w.tick()
  await h.w.tick()
  T('L1 a stop comment from before the run does not stop it', h.w.state.active && h.w.state.active.n === 1)
  h.say(1, '/hivecode stop', 'stranger')
  await h.w.tick()
  T('L2 a stop from someone who cannot push is ignored', h.w.state.active && h.w.state.active.n === 1)
  h.say(1, '/hivecode stop')
  const landsBefore = h.calls.land.length
  await h.w.tick()
  T('L3 a stop mid-work: nothing lands, the room is told, the issue says how to retry', !h.w.state.active && h.w.state.issues[1].status === 'stopped' && h.calls.land.length === landsBefore && h.calls.say.some((s) => /hivecode stop/.test(s)) && h.S.comments.some((c) => c.n === 1 && /Stopped/.test(c.body) && /hivecode retry/.test(c.body)))
  await h.w.tick()
  T('L4 a stopped issue is not posted again on its own', h.calls.post.length === 1)
  h.say(1, '/hivecode retry')
  await h.w.tick()
  T('L5 /hivecode retry: queued again and posted to the room a second time', h.calls.post.length === 2 && h.w.state.active && h.w.state.active.n === 1)
}


// ─── M. THE REVIEW'S OWN FINDINGS (antigravity-2, 5 Nov) ─────────────────────────────────────
console.log('\n# M. a tick that throws still saves; a spawn that fails spends no run')
{
  // Two stopped issues. The retry scan re-queues #1, then reading #2's comments throws (GitHub
  // down): before the fix nothing after intake was saved, and #1's retry vanished.
  const h = harness()
  h.file(1); h.file(2)
  await h.w.tick(); h.say(1, '/hivecode stop'); await h.w.tick() // #1 stopped
  await h.w.tick(); h.say(2, '/hivecode stop'); await h.w.tick() // #2 posted, then stopped
  h.say(1, '/hivecode retry')
  const realComments = h.gh.comments
  h.gh.comments = (n) => { if (n === 2) throw new Error('GitHub is down'); return realComments(n) }
  h.deps.commands = (a) => W.readCommands({ gh: { ...h.gh, comments: (n) => { if (n === 2) throw new Error('GitHub is down'); return realComments(n) } }, ...a })
  // readCommands swallows a failed read; a dep that throws is what an unexpected error looks like.
  const realCommands = h.deps.commands
  h.deps.commands = async (a) => { if (a.issueNumber === 2) throw new Error('GitHub is down'); return realCommands(a) }
  let threw = false
  try { await h.w.tick() } catch { threw = true }
  const saved = JSON.parse(fs.readFileSync(h.sf, 'utf8'))
  T('M1 a tick that throws halfway still saved the retry it had already queued', threw && saved.issues[1].status === 'queued' && saved.queue.includes(1) && saved.issues[1].attempt === 2, JSON.stringify(saved.issues[1]))
  h.gh.comments = realComments
}
{
  const h = harness({ fallbackAgent: 'claude -p' })
  h.behave.peek = () => ({ ok: true, agents: [], reachable: [], engaged: false, lastLines: [] })
  h.deps.spawn = () => { throw new Error('ENOENT') }
  h.file(1)
  await h.w.tick(); await h.w.tick(); await h.w.tick(); await h.w.tick()
  T('M2 a fallback that cannot start spends none of the day\'s runs, and says so after 3 tries', h.w.state.day.runs === 0 && h.S.comments.filter((c) => /did not start/.test(c.body)).length === 1, JSON.stringify(h.w.state.day))
}
{
  const h = harness()
  h.deps.prFeedback = async () => ({ ok: true, taskId: 'tR', items: [{ id: 1 }], state: {} })
  h.file(1)
  await h.w.tick()
  h.behave.land = () => ({ ok: true, pr: { number: 7, url: 'u7' }, why: 'landed' })
  h.S.pulls.set(7, { number: 7, state: 'open' })
  await h.w.tick(); await h.w.tick() // landed, then the review task
  h.say(7, '/hivecode stop')
  h.deps.commands = (a) => W.readCommands({ gh: h.gh, ...a })
  await h.w.tick()
  T('M3 a stopped REVIEW says how it really comes back (a new review comment), not "/hivecode retry"', h.S.comments.some((c) => c.n === 7 && /Stopped/.test(c.body) && /new review comment/.test(c.body) && !/hivecode retry/.test(c.body)))
}


// ─── N. A SOLO FIRST RUN IS NOT TEN SILENT MINUTES (debate #3) ───────────────────────────────
console.log('\n# N. one agent: told at once, lands after 2 min; two agents: the room is asked for a review')
{
  const h = harness({ ackMinutes: 10 })
  h.behave.peek = () => ({ ok: true, agents: ['Claude'], reachable: ['Claude'], engaged: true, lastLines: [] })
  h.behave.land = (a) => (a.allowUnreviewed ? { ok: true, pr: { number: 9, url: 'u' }, why: 'landed; not reviewed by a second agent' } : { ok: false, blocked: 'unreviewed', files: ['app.js'], why: 'app.js has not been reviewed' })
  h.file(1)
  await h.w.tick(); await h.w.tick()
  T('N1 solo and done: the room and the issue are told AT ONCE when it lands and why', h.calls.say.some((s) => /nobody else is in the room to review app\.js/.test(s) && /2 min/.test(s)) && h.S.comments.some((c) => c.n === 1 && /in 2 minutes it lands without an agent review/.test(c.body)))
  h.clock.t += 2 * 60000 + 1; await h.w.tick()
  T('N2 ...and after 2 minutes, not 10, it lands with the waiver', h.calls.land.some((c) => c.allowUnreviewed) && h.w.state.issues[1].status === 'landed')
}
{
  const h = harness({ ackMinutes: 10 })
  let agents = ['Claude', 'Rev']
  h.behave.peek = () => ({ ok: true, agents, reachable: ['Claude'], engaged: true, lastLines: [] })
  h.behave.land = () => ({ ok: false, blocked: 'unreviewed', files: ['app.js'], why: 'app.js has not been reviewed' })
  h.file(1)
  await h.w.tick(); await h.w.tick()
  T('N3 two agents were here: the room is asked, once, for a review by a non-writer', h.calls.say.filter((s) => /waiting for a review of app\.js by someone who did not write them/.test(s)).length === 1)
  agents = ['Claude'] // Rev left
  h.clock.t += 3 * 60000; await h.w.tick()
  T('N4 ...and the solo 2 minutes do NOT apply once a second agent has been in the room', h.calls.land.every((c) => !c.allowUnreviewed))
}

// ─── S. `github status` IN ROOM MODE ─────────────────────────────────────────────────────────
console.log('\n# S. github status answers "why isn\'t it picking up my issue?"')
{
  const h = harness({ fallbackAgent: 'claude -p' })
  h.behave.peek = () => ({ ok: true, agents: [], reachable: [], engaged: false, lastLines: [] })
  h.file(1, { title: 'Add CSV export' }); h.file(2, { title: 'Fix dates' }); h.file(3, { by: 'stranger' })
  await h.w.tick(); await h.w.tick() // #1 active, fallback started; #2 queued; #3 skipped
  const text = W.describeRoomState(JSON.parse(fs.readFileSync(h.sf, 'utf8')), { now: h.clock.t + 5 * 60000 })
  T('S1 it names the active issue, its age, and that NO agent has taken it', /working on #1 "Add CSV export" for 5 min/.test(text) && /NO agent has taken it yet/.test(text), text.split('\n')[1])
  T('S2 ...the fallback that was started, and why', /fallback agent started 5 min ago \(no agent in the room could hear it\)/.test(text))
  T('S3 ...the queue in order, and the skipped issue with its reason', /queued, in order: #2 "Fix dates"/.test(text) && /skipped #3: labelled by stranger, who cannot push/.test(text))
  T('S4 ...the branch, never the room id', /branch fix/.test(text) && !text.includes(ROOM_ID))
}
{
  const h = harness()
  h.file(1)
  await h.w.tick()
  h.behave.land = () => ({ ok: true, pr: { number: 7, url: 'u' }, why: 'landed' })
  h.S.pulls.set(7, { number: 7, state: 'open' })
  h.file(2)
  await h.w.tick(); await h.w.tick()
  const text = W.describeRoomState(JSON.parse(fs.readFileSync(h.sf, 'utf8')), { now: h.clock.t })
  T('S5 waiting on an open PR says so, with the rule', /waiting for PR #7 to be merged or closed before the next issue/.test(text) && /queued, in order: #2/.test(text), text)
}

{
  // Antigravity's review of the status text: yesterday's runs are not today's; the cap is the real one.
  const h = harness({ fallbackAgent: 'claude -p', maxRunsPerDay: 5 })
  h.behave.peek = () => ({ ok: true, agents: [], reachable: [], engaged: false, lastLines: [] })
  h.file(1)
  await h.w.tick(); await h.w.tick() // one fallback run today
  const saved = JSON.parse(fs.readFileSync(h.sf, 'utf8'))
  T('S6 the runs count shows the cap the watcher was started with', /fallback runs today: 1 of 5/.test(W.describeRoomState(saved, { now: h.clock.t })))
  T('S7 ...and the next day it no longer says "today"', !/fallback runs today/.test(W.describeRoomState(saved, { now: h.clock.t + 24 * 3600000 })))
}

// ─── I. THE ROOM ID NEVER REACHES GITHUB ─────────────────────────────────────────────────────
console.log('\n# I. nothing written to GitHub carries the room id or link')
{
  const all = []
  for (const opts of [{}, { fallbackAgent: 'claude -p' }, { maxMinutes: 1 }]) {
    const h = harness(opts)
    h.behave.peek = () => ({ ok: true, agents: [], reachable: [], engaged: false, lastLines: [`GitHub: joined ${ROOM_ID}`] })
    h.file(1); await h.w.tick(); h.clock.t += 2 * 60000; await h.w.tick()
    all.push(...h.S.comments.map((c) => c.body))
  }
  T('I1 no comment contains the room id', all.length > 0 && !all.some((b) => b.includes(ROOM_ID) || b.includes('relay.example')), all.find((b) => b.includes(ROOM_ID)) || '')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
