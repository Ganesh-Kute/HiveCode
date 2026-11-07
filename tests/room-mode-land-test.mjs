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

function T(desc, ok) {
  if (ok) {
    console.log(`  ok   ${desc}`)
    pass++
  } else {
    console.log(`  FAIL ${desc}`)
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
  await new Promise((r) => setTimeout(r, 300))

  // Now DevAgent modifies buffer.js (making review stale)
  await agent.edit('buffer.js', 'const buf = Buffer.alloc(2048); // modified\n', 'Resize buffer')
  await new Promise((r) => setTimeout(r, 300))

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
  await new Promise((r) => setTimeout(r, 300))

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
  await new Promise((r) => setTimeout(r, 300))

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
  T('T2.6 PR title formatted with issue title and number',
    Boolean(liSuccess && liSuccess.opts && liSuccess.opts.title === 'Fix memory leak in buffer (#77)'))

} catch (err) {
  console.error('Test error:', err)
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
