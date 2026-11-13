// tests/room-mode-land-test.mjs -- tests for B3 Done Detection (whenDone) & Landing (landIssue)
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { whenDone, landIssue, computePlanFingerprint } from '../hive-room-mode.js'

let pass = 0
let fail = 0

// The reviewer is another client: its review reaches DevAgent through the relay. A fixed 300 ms
// sleep was not always enough: on the 7 Nov macOS CI run T1.4-T2.6 failed (every check from the
// first one that needs the other client's review), while Linux, Windows and the macOS baseline
// were green. So wait until DevAgent holds every review the reviewer wrote (10 s cap).
async function reviewsArrive(to, from, ms = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (to.doc.getMap('reviews').size >= from.doc.getMap('reviews').size) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

function T(desc, ok, extra = '') {
  if (ok) {
    console.log(`  ok   ${desc}`)
    pass++
  } else {
    console.log(`  FAIL ${desc}${extra ? `   (${extra})` : ''}`)
    fail++
  }
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1550 + (process.pid % 400)
const RELAY = `ws://127.0.0.1:${PORT}`
const ROOM = `test-land-room-${process.pid}`

console.log('# B3: Done Detection (whenDone) & Landing (landIssue)')

let relayProc = null
let agentDir = null
let agent = null

try {
  // 1. Spawn local relay
  relayProc = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    p.stdout.on('data', (d) => {
      if (/listening on/.test(String(d))) resolve(p)
    })
    p.on('error', reject)
    p.on('exit', (code) => reject(new Error(`relay exited with code ${code}`)))
  })

  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-land-agent-${process.pid}-`))
  agent = startSync({
    relay: RELAY,
    room: ROOM,
    dir: agentDir,
    name: 'DevAgent',
    kind: 'ai',
    passive: false,
    syncFiles: false,
    log: () => {},
  })

  await new Promise((res) => {
    const check = () => {
      if (agent.provider && agent.provider.synced) res()
      else setTimeout(check, 100)
    }
    check()
  })

  // Assign issue task
  const taskId = agent.assign('all', 'Issue #77: Fix memory leak in buffer')
  await new Promise((r) => setTimeout(r, 300))

  // Seed file
  await agent.edit('buffer.js', 'const buf = Buffer.alloc(1024);\n', 'Allocate buffer')
  await new Promise((r) => setTimeout(r, 300))

  // Group 1: whenDone readiness checks
  console.log('\n# Group 1: whenDone readiness checks')

  // 1. Task not done yet
  const wd1 = whenDone ? await whenDone({
    link: `${RELAY}|${ROOM}`,
    taskId,
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: async () => ({ ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }),
  }) : null
  T('T1.1 task not done is refused', Boolean(wd1 && wd1.ready === false && /not done/i.test(wd1.why)))

  // Mark task done
  agent.complete(taskId, 'Fixed leak with explicit release')
  await new Promise((r) => setTimeout(r, 300))

  // 2. Active claim held
  agent.claim('buffer.js', 'Still inspecting')
  await new Promise((r) => setTimeout(r, 300))
  const wd2 = whenDone ? await whenDone({
    link: `${RELAY}|${ROOM}`,
    taskId,
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: async () => ({ ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }),
  }) : null
  T('T1.2 active claim held refuses readiness', Boolean(wd2 && wd2.ready === false && /claim/i.test(wd2.why)))

  agent.release('buffer.js')
  await new Promise((r) => setTimeout(r, 300))

  // 3. Unreviewed file
  const wd3 = whenDone ? await whenDone({
    link: `${RELAY}|${ROOM}`,
    taskId,
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: async () => ({ ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }),
  }) : null
  T('T1.3 unreviewed file refuses readiness', Boolean(wd3 && wd3.ready === false && /review/i.test(wd3.why)))

  // 4. Stale review (file changed after review)
  // Reviewer joins and passes
  const reviewerDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-land-rev-${process.pid}-`))
  const reviewer = startSync({
    relay: RELAY,
    room: ROOM,
    dir: reviewerDir,
    name: 'PeerReviewer',
    kind: 'ai',
    passive: false,
    syncFiles: false,
    log: () => {},
  })
  await new Promise((res) => {
    const check = () => {
      if (reviewer.provider && reviewer.provider.synced) res()
      else setTimeout(check, 100)
    }
    check()
  })

  await reviewer.review(['buffer.js'], 'pass', 'LGTM')
  await reviewsArrive(agent, reviewer)

  // Now DevAgent modifies buffer.js (making review stale)
  await agent.edit('buffer.js', 'const buf = Buffer.alloc(2048); // modified\n', 'Resize buffer')
  // Wait for the reviewer to hold the edited text (same content hash), not a fixed 300 ms: on a slow
  // macOS runner the reviewer could otherwise review the OLD text below and the test would pass a
  // stale review.
  for (const t0 = Date.now(); reviewer.reviewStatus('buffer.js').hash !== agent.reviewStatus('buffer.js').hash && Date.now() - t0 < 10000;) {
    await new Promise((r) => setTimeout(r, 50))
  }

  const wd4 = whenDone ? await whenDone({
    link: `${RELAY}|${ROOM}`,
    taskId,
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: async () => ({ ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }),
  }) : null
  T('T1.4 stale review after file modification refuses readiness',
    Boolean(wd4 && wd4.ready === false && /stale|modified after review/i.test(wd4.why)))

  // 5. Unresolved fail review
  await reviewer.review(['buffer.js'], 'fail', 'Too large allocation')
  await reviewsArrive(agent, reviewer)

  const wd5 = whenDone ? await whenDone({
    link: `${RELAY}|${ROOM}`,
    taskId,
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: async () => ({ ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }),
  }) : null
  T('T1.5 unresolved fail review refuses readiness',
    Boolean(wd5 && wd5.ready === false && /fail/i.test(wd5.why)))

  // 6. Valid pass review -> ready
  await reviewer.review(['buffer.js'], 'pass', '2048 is fine per spec')
  await reviewsArrive(agent, reviewer)

  const wd6 = whenDone ? await whenDone({
    link: `${RELAY}|${ROOM}`,
    taskId,
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: async () => ({ ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }),
  }) : null
  T('T1.6 all preconditions hold -> ready: true', Boolean(wd6 && wd6.ready === true))

  // Group 2: landIssue execution and error handling
  console.log('\n# Group 2: landIssue execution and error handling')

  let assignedTasks = []
  agent.doc.getMap('tasks').observe((ev) => {
    ev.changes.keys.forEach((change, key) => {
      if (change.action === 'add') assignedTasks.push(agent.doc.getMap('tasks').get(key))
    })
  })

  // 1. Q576 test failure -> posts task to room
  let landAndOpenCalls = 0
  const mockFailLand = async (opts) => {
    if (opts.dry) {
      return { ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }
    }
    landAndOpenCalls++
    return { ok: false, code: 'Q576', why: 'npm test failed with 1 error on line 42' }
  }

  const liFail = landIssue ? await landIssue({
    link: `${RELAY}|${ROOM}`,
    taskId,
    issue: { number: 77, title: 'Fix memory leak in buffer' },
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: mockFailLand,
  }) : null

  T('T2.1 failing tests (Q576) returns ok: false with code Q576',
    Boolean(liFail && liFail.ok === false && liFail.code === 'Q576'))
  await new Promise((r) => setTimeout(r, 400))
  T('T2.2 failing tests assigns fix task back into the room',
    assignedTasks.some((t) => t && t.text && t.text.includes('Fix failing tests on issue #77')))

  // 2. No retry loop: second call with same fingerprint does NOT re-run landAndOpen
  const liFail2 = landIssue ? await landIssue({
    link: `${RELAY}|${ROOM}`,
    taskId,
    issue: { number: 77, title: 'Fix memory leak in buffer' },
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: mockFailLand,
    state: liFail && liFail.state,
  }) : null
  T('T2.3 no retry loop: identical plan fingerprint skips re-running tests',
    landAndOpenCalls === 1 && Boolean(liFail2 && liFail2.skipped === true))

  // 3. Relay restarted (Q577)
  const mockRestartLand = async (opts) => {
    if (opts.dry) {
      return { ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }
    }
    return { ok: false, code: 'Q577', why: 'Room is empty: relay probably restarted' }
  }
  const liRestart = landIssue ? await landIssue({
    link: `${RELAY}|${ROOM}`,
    taskId,
    issue: { number: 77, title: 'Fix memory leak in buffer' },
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: mockRestartLand,
  }) : null
  T('T2.4 relay restarted returns Q577 refusal without moving branch',
    Boolean(liRestart && liRestart.ok === false && liRestart.code === 'Q577'))

  // 4. Successful landing
  const mockSuccessLand = async (opts) => {
    if (opts.dry) {
      return { ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }
    }
    return {
      ok: true,
      tip: 'c0ffee1234',
      pr: { number: 99, url: 'https://github.com/org/repo/pull/99' },
      plan: [{ agent: 'DevAgent', files: ['buffer.js'] }],
      opts,
    }
  }

  const liSuccess = landIssue ? await landIssue({
    link: `${RELAY}|${ROOM}`,
    taskId,
    issue: { number: 77, title: 'Fix memory leak in buffer' },
    root: ROOT,
    branch: 'main',
    syncRunner: async () => agent,
    landRunner: mockSuccessLand,
  }) : null

  T('T2.5 successful landing returns ok: true and pr info',
    Boolean(liSuccess && liSuccess.ok === true && liSuccess.pr && liSuccess.pr.number === 99))
  // 0.14.3 P1-10: the mock run's PR #7 did not say who reviewed it. The body names the reviewer of
  // each landing file, from the review bound to the content that lands, as a code span (no @-ping).
  const sum = (liSuccess && liSuccess.opts && liSuccess.opts.summary) || ''
  T('T2.7 the PR body names who reviewed each landing file',
    /Reviewed in the room/.test(sum) && /- buffer\.js: `PeerReviewer`/.test(sum))
  T('T2.6 PR title formatted with issue title and number',
    Boolean(liSuccess && liSuccess.opts && liSuccess.opts.title === 'Fix memory leak in buffer (#77)'))

  // Group 3 -- 0.14.3 P0-2
  console.log('\n# Group 3: 0.14.3 P0-2 -- what landIssue tells the room reaches it; a moved branch is a new landing')

  // (b) THE WATCHER'S PATH has no syncRunner: landIssue opens its own connection. On 0.14.2 whenDone
  // stopped that connection before landIssue wrote the Q576 fix task into it, so the room never got it.
  const ownBefore = assignedTasks.length
  const fixFor78 = () => assignedTasks.slice(ownBefore).some((t) => t && t.text && t.text.includes('Fix failing tests on issue #78'))
  // A fresh passive connection does not load file contents (syncFiles:false), so like the REAL dry
  // landing this mock hands whenDone the content hashes; without them the review reads as stale and
  // landIssue never gets past whenDone (antigravity-VM's finding on the first draft of this test).
  const passHashes = (agent.reviews ? agent.reviews('buffer.js') : []).filter((r) => r && r.verdict === 'pass' && r.hash)
  const reviewedHash = passHashes.length ? passHashes[passHashes.length - 1].hash : ''
  const mockFailLandHashed = async (opts) => (opts.dry
    ? { ...(await mockFailLand(opts)), hashes: { 'buffer.js': reviewedHash } }
    : mockFailLand(opts))
  const liOwn = await landIssue({
    link: `${RELAY}|${ROOM}`,
    taskId,
    issue: { number: 78, title: 'Own connection' },
    root: ROOT,
    branch: 'main',
    landRunner: mockFailLandHashed,
    headOf: () => 'h-own',
  })
  for (let i = 0; i < 50 && !fixFor78(); i++) await new Promise((r) => setTimeout(r, 100))
  T('T3.0 the test reached the landing: the reviewed hash was found and whenDone was ready (else T3.1 proves nothing)',
    Boolean(reviewedHash) && Boolean(liOwn && liOwn.code === 'Q576'), liOwn ? liOwn.why : 'null')
  T('T3.1 on its own connection (the watcher\'s path), the Q576 fix task reaches the room',
    Boolean(liOwn && liOwn.code === 'Q576') && fixFor78())

  // A refusal at the DRY run keeps its code (Claude-cloud's review of P0-3): with the dry run now
  // answering what the real one will, Q506 arrives at whenDone's dry pass. Without the code it read
  // as "not ready yet", which the watcher keeps quiet on, and issue #9's silence came back.
  const mockDryRefuse = async (opts) => (opts.dry
    ? { ok: false, code: 'Q506', why: 'Q506 the branch holds content this room has never seen (test.js)' }
    : { ok: false, code: 'Q599', why: 'the real landing must not run after a dry refusal' })
  const liDry = await landIssue({ link: `${RELAY}|${ROOM}`, taskId, issue: { number: 79, title: 'Dry refusal' }, root: ROOT, branch: 'main', syncRunner: async () => agent, landRunner: mockDryRefuse, headOf: () => 'h-dry' })
  T('T3.4 a refusal at the dry run comes back as a refusal with its code (Q506), not as "not ready"',
    Boolean(liDry && liDry.ok === false && liDry.code === 'Q506' && /Q506/.test(liDry.why || '')), liDry ? JSON.stringify({ code: liDry.code, why: liDry.why }) : 'null')
  const wdDry = await whenDone({ link: `${RELAY}|${ROOM}`, taskId, root: ROOT, branch: 'main', syncRunner: async () => agent, landRunner: mockDryRefuse })
  T('T3.5 ...and whenDone itself reports it as refused, code kept', Boolean(wdDry && wdDry.ready === false && wdDry.refused === true && wdDry.code === 'Q506'))

  // The branch head is part of the fingerprint (Claude's review): a Q506 means the branch moved, so
  // a push that fixes the branch must earn a new landing although the room did not change.
  let q506Runs = 0
  const mockRefuse = async (opts) => {
    if (opts.dry) return { ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }
    q506Runs++
    return { ok: false, code: 'Q506', why: 'Q506 the branch holds content this room has never seen' }
  }
  const baseL = { link: `${RELAY}|${ROOM}`, taskId, issue: { number: 77, title: 'Fix memory leak in buffer' }, root: ROOT, branch: 'main', syncRunner: async () => agent, landRunner: mockRefuse }
  const r1 = await landIssue({ ...baseL, headOf: () => 'aaa111' })
  const r2 = await landIssue({ ...baseL, headOf: () => 'aaa111', state: r1 && r1.state })
  const runsAfterR2 = q506Runs
  const r3 = await landIssue({ ...baseL, headOf: () => 'bbb222', state: r2 && r2.state })
  T('T3.2 a refusal is remembered: same room and same branch head -> skipped, not re-run',
    runsAfterR2 === 1 && Boolean(r1 && r1.code === 'Q506' && r1.fingerprint) && Boolean(r2 && r2.skipped === true))
  T('T3.3 ...but a new branch head earns one new landing with the room unchanged',
    q506Runs === 2 && Boolean(r3 && r3.skipped !== true && r3.code === 'Q506'))

  // Group 4 -- a done task that lands nothing is not "landed" (e2e run, 10 Nov 2026)
  // Issue #10 was done and reviewed, but its three files were saved by a client that signs nothing.
  // The dry landing said "0 attributed, 3 files with no verified receipt", whenDone answered ready
  // (no planned file, so nothing to review), the real landing returned ok with pr = null, and the
  // watcher posted "issue #10 landed as PR #undefined" in the room and on the issue. Nothing had
  // been pushed.
  console.log('\n# Group 4: a done task whose landing brings nothing is refused, never reported as landed')
  const base4 = { link: `${RELAY}|${ROOM}`, taskId, issue: { number: 10, title: 'Add Kelvin conversions' }, root: ROOT, branch: 'main', syncRunner: async () => agent }

  // (a) every changed file is unsigned: nothing can land
  let unsignedRealRuns = 0
  const UNSIGNED = ['README.md', 'temp.js', 'test.js']
  const mockUnsigned = async (opts) => {
    if (opts.dry) return { ok: true, plan: [], deletions: [], orphans: UNSIGNED, hashes: {} }
    unsignedRealRuns++
    return { ok: true, pr: null, tip: 'a0b6b02', plan: [], orphans: UNSIGNED, landed: 0, why: 'nothing new to land on main; tests: NOT RUN; pushed' }
  }
  const wdU = await whenDone({ ...base4, landRunner: mockUnsigned })
  T('T4.1 whenDone: the only changes are unsigned -> refused with a code, every file named',
    Boolean(wdU && wdU.ready === false && wdU.refused === true && wdU.code === 'Q588' && UNSIGNED.every((f) => (wdU.why || '').includes(f))), wdU ? JSON.stringify({ ready: wdU.ready, code: wdU.code, why: wdU.why }) : 'null')
  const liU = await landIssue({ ...base4, landRunner: mockUnsigned, headOf: () => 'h-unsigned' })
  T('T4.2 landIssue: not ok, Q588, and the real landing never ran',
    Boolean(liU && liU.ok === false && liU.code === 'Q588' && !liU.pr) && unsignedRealRuns === 0, liU ? JSON.stringify({ ok: liU.ok, code: liU.code, runs: unsignedRealRuns }) : 'null')
  T('T4.3 ...and the reason says what to do: a client that signs', /sign/i.test((liU && liU.why) || '') && /HIVE_PROVENANCE/.test((liU && liU.why) || ''), liU ? liU.why : 'null')

  // (b) nothing changed at all, and the real landing opened no pull request
  let nothingRuns = 0
  const mockNothing = async (opts) => {
    if (opts.dry) return { ok: true, plan: [], deletions: [], orphans: [] }
    nothingRuns++
    return { ok: true, pr: null, tip: 'a0b6b02', plan: [], landed: 0, why: 'nothing new to land on main; tests: NOT RUN; pushed' }
  }
  const liN = await landIssue({ ...base4, landRunner: mockNothing, headOf: () => 'h-nothing' })
  T('T4.4 no pull request came of the landing: not ok, Q589, never "landed"',
    Boolean(liN && liN.ok === false && liN.code === 'Q589' && !liN.pr), liN ? JSON.stringify({ ok: liN.ok, code: liN.code, pr: liN.pr }) : 'null')
  const liN2 = await landIssue({ ...base4, landRunner: mockNothing, headOf: () => 'h-nothing', state: liN && liN.state })
  T('T4.5 ...remembered like any refusal: the same room and branch are not landed again',
    Boolean(liN && liN.fingerprint && liN.state && liN.state.lastFailedFingerprint === liN.fingerprint) && Boolean(liN2 && liN2.skipped === true) && nothingRuns === 1, `runs ${nothingRuns}`)

  // (c) a pull request with no number is no pull request
  const mockNoNumber = async (opts) => (opts.dry
    ? { ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [] }
    : { ok: true, pr: { url: '' }, tip: 'c0ffee', plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], landed: 1 })
  const liX = await landIssue({ ...base4, landRunner: mockNoNumber, headOf: () => 'h-nonumber' })
  T('T4.6 a pull request without a number is not a landing either', Boolean(liX && liX.ok === false && liX.code === 'Q589'), liX ? JSON.stringify({ ok: liX.ok, code: liX.code }) : 'null')

  // (d) a retry that only opens the pull request for commits that already landed still succeeds
  const mockRetryOpens = async (opts) => (opts.dry
    ? { ok: true, plan: [], deletions: [], orphans: [] }
    : { ok: true, pr: { number: 12, url: 'https://github.com/org/repo/pull/12', created: true, newCommits: 0 }, tip: 'c0ffee', plan: [], landed: 0 })
  const liR = await landIssue({ ...base4, landRunner: mockRetryOpens, headOf: () => 'h-retry' })
  T('T4.7 nothing new to commit, but the landing opened PR #12: that is a landing', Boolean(liR && liR.ok === true && liR.pr && liR.pr.number === 12), liR ? JSON.stringify({ ok: liR.ok, code: liR.code }) : 'null')

  // (e) signed and unsigned files together: the signed ones land as before (hive-land.js writes
  // "Not in this PR" into the body itself; tests/land-test.mjs group O)
  const mockPartial = async (opts) => (opts.dry
    ? { ok: true, plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], deletions: [], orphans: ['notes.md'] }
    : { ok: true, pr: { number: 13, url: 'https://github.com/org/repo/pull/13' }, tip: 'c0ffee', plan: [{ agent: 'DevAgent', files: ['buffer.js'] }], landed: 1, opts })
  const wdP = await whenDone({ ...base4, landRunner: mockPartial })
  T('T4.8 whenDone hands on the unsigned files it found', Boolean(wdP && wdP.ready === true && JSON.stringify(wdP.orphans) === JSON.stringify(['notes.md'])), wdP ? JSON.stringify({ ready: wdP.ready, orphans: wdP.orphans, why: wdP.why }) : 'null')
  const liP = await landIssue({ ...base4, landRunner: mockPartial, headOf: () => 'h-partial' })
  T('T4.9 signed files still land when another file is unsigned', Boolean(liP && liP.ok === true && liP.pr && liP.pr.number === 13), liP ? JSON.stringify({ ok: liP.ok, code: liP.code }) : 'null')

} catch (err) {
  // A throw is a FAILURE: 0.14.2 only printed it, so a test file that crashed half way exited 0
  // with every check after the crash silently skipped (0.14.3, Claude's review).
  console.error('Test error:', err)
  fail++
} finally {
  if (agent && typeof agent.stop === 'function') {
    try { agent.stop() } catch {}
  }
  if (relayProc) {
    try { relayProc.kill() } catch {}
  }
  if (agentDir) {
    try { fs.rmSync(agentDir, { recursive: true, force: true }) } catch {}
  }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
