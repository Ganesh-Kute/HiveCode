// tests/review-test.mjs -- tests for hive_review and @all completion (tmw3ndbegodxu)
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { contentHash } from '../substrate.js'
import { authorsOf } from '../hive-authors.js'

process.env.HIVE_PROVENANCE = 'on'

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
const PORT = 1450 + (process.pid % 400)
const RELAY = `ws://127.0.0.1:${PORT}`
const ROOM = `test-review-room-${process.pid}`

console.log('# tmw3ndbegodxu: hive_review & @all Task Completion')

let relayProc = null
let writerDir = null
let reviewerDir = null
let reviewer2Dir = null
let driveByDir = null
let writer = null
let reviewer = null
let reviewer2 = null
let driveBy = null

try {
  // 1. Spawn local relay server
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

  // 2. Setup 2 clients: Writer and Reviewer
  writerDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-writer-${process.pid}-`))
  reviewerDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-reviewer-${process.pid}-`))
  reviewer2Dir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-reviewer2-${process.pid}-`))

  writer = startSync({
    relay: RELAY,
    room: ROOM,
    dir: writerDir,
    name: 'Writer',
    kind: 'ai',
    passive: false,
    syncFiles: false,
    log: () => {},
  })

  reviewer = startSync({
    relay: RELAY,
    room: ROOM,
    dir: reviewerDir,
    name: 'Reviewer',
    kind: 'ai',
    passive: false,
    syncFiles: false,
    log: () => {},
  })

  reviewer2 = startSync({
    relay: RELAY,
    room: ROOM,
    dir: reviewer2Dir,
    name: 'Reviewer2',
    kind: 'ai',
    passive: false,
    syncFiles: false,
    log: () => {},
  })

  // Wait for initial sync
  await new Promise((res) => {
    const check = () => {
      if (writer.provider && writer.provider.synced && reviewer.provider && reviewer.provider.synced && reviewer2.provider && reviewer2.provider.synced) res()
      else setTimeout(check, 100)
    }
    check()
  })

  // Group 1: Argument validation
  console.log('\n# Group 1: Argument validation')
  const rEmpty = reviewer.review ? await reviewer.review([], 'pass', 'ok') : null
  T('T1.1 empty files array refused', Boolean(rEmpty && rEmpty.error))

  const rBadVerdict = reviewer.review ? await reviewer.review(['any.js'], 'maybe', 'not sure') : null
  T('T1.2 invalid verdict refused', Boolean(rBadVerdict && rBadVerdict.error))

  const rNonManifest = reviewer.review ? await reviewer.review(['nonexistent.js'], 'pass', 'looks good') : null
  T('T1.3 non-manifest file refused with error (Claude addition i)',
    Boolean(rNonManifest && rNonManifest.error && /manifest/i.test(rNonManifest.error)))

  // Seed a file in the room via writer
  if (writer.edit) {
    await writer.edit('auth.js', 'export function login() { return true }\n', 'Implement login')
  }

  // Allow CRDT propagation
  await new Promise((r) => setTimeout(r, 400))

  // Group 2: Contributor refusal (self-review blocked)
  console.log('\n# Group 2: Self-review and contributor refusal')
  const rSelf = writer.review ? await writer.review(['auth.js'], 'pass', 'I wrote this and approve it') : null
  T('T2.1 contributor to held content is refused from reviewing',
    Boolean(rSelf && rSelf.error && /contributor|contributed/i.test(rSelf.error)))

  const rValid = reviewer.review ? await reviewer.review(['auth.js'], 'pass', 'Clean implementation') : null
  T('T2.2 non-contributor peer review succeeds', Boolean(rValid && rValid.ok === true))

  const initialHash = contentHash('export function login() { return true }\n')
  const forgedReceipt = { author: 'Reviewer', name: 'Reviewer', contentHash: initialHash, at: Date.now() }
  const fakeVerify = (r) => ({ ok: false, reason: 'bad signature' })
  const testAuthors = authorsOf([forgedReceipt], fakeVerify, 'export function login() { return true }\n')
  T('T2.3 invalid receipt from verify ({ ok: false }) does not attribute authorship',
    testAuthors.contributors.length === 0)

  // Group 3: Content hash binding & Stale review detection
  console.log('\n# Group 3: Content hash binding & Stale review detection')
  const reviewsAfterPass = reviewer.reviews ? reviewer.reviews('auth.js') : []
  T('T3.1 review records exact content hash of room content',
    Array.isArray(reviewsAfterPass) && reviewsAfterPass.length > 0 && reviewsAfterPass[0].hash === initialHash)

  // Now Writer modifies auth.js
  const newCode = 'export function login() { return true; /* updated */ }\n'
  if (writer.edit) {
    await writer.edit('auth.js', newCode, 'Add comment')
  }
  await new Promise((r) => setTimeout(r, 400))

  const statusAfterEdit = reviewer.reviewStatus ? reviewer.reviewStatus('auth.js') : null
  T('T3.2 modifying the file makes prior review stale',
    Boolean(statusAfterEdit && statusAfterEdit.verdict === 'unreviewed' && statusAfterEdit.stale === true))

  // Group 4: Y.Map list of reviews & Fail blocking
  console.log('\n# Group 4: Y.Map reviews list & Fail verdict blocking')
  // Reviewer fails the updated auth.js
  const rFail = reviewer.review ? await reviewer.review(['auth.js'], 'fail', 'Needs input validation') : null
  T('T4.1 fail review records successfully', Boolean(rFail && rFail.ok === true))

  const statusAfterFail = reviewer.reviewStatus ? reviewer.reviewStatus('auth.js') : null
  T('T4.2 file with fail review has verdict fail', Boolean(statusAfterFail && statusAfterFail.verdict === 'fail'))

  const allReviews = reviewer.reviews ? reviewer.reviews('auth.js') : []
  T('T4.3 reviews are stored as an append-only list preserving audit history',
    Array.isArray(allReviews) && allReviews.length >= 2 && allReviews.some((r) => r.verdict === 'pass') && allReviews.some((r) => r.verdict === 'fail'))

  // Reviewer passes the exact same hash
  const rPassAgain = reviewer.review ? await reviewer.review(['auth.js'], 'pass', 'Accepted after explanation') : null
  T('T4.4 subsequent pass on same hash succeeds', Boolean(rPassAgain && rPassAgain.ok === true))

  const statusAfterPassAgain = reviewer.reviewStatus ? reviewer.reviewStatus('auth.js') : null
  T('T4.5 newer pass overrides earlier fail on same hash (Claude addition ii)',
    Boolean(statusAfterPassAgain && statusAfterPassAgain.verdict === 'pass'))

  // Concurrent review test (Mutant 2)
  await Promise.all([
    reviewer.review(['auth.js'], 'pass', 'Concurrent review 1'),
    reviewer2.review(['auth.js'], 'pass', 'Concurrent review 2')
  ])
  await new Promise((r) => setTimeout(r, 400))
  const reviewsConcurrent = reviewer.reviews ? reviewer.reviews('auth.js') : []
  const hasR1 = reviewsConcurrent.some((r) => r.by === 'Reviewer' && r.note === 'Concurrent review 1')
  const hasR2 = reviewsConcurrent.some((r) => r.by === 'Reviewer2' && r.note === 'Concurrent review 2')
  T('T4.6 concurrent reviews from two reviewers both survive without clobber (Mutant 2)', hasR1 && hasR2)

  // Group 5: @all task completion rules
  console.log('\n# Group 5: @all Task Completion Rules')
  // Writer assigns @all task
  const allTaskId = writer.assign ? writer.assign('all', 'Review authentication subsystem') : null
  T('T5.1 @all task created with id', Boolean(allTaskId))
  await new Promise((r) => setTimeout(r, 300))

  // Reviewer was in the room when task was created -> can complete it
  const rReviewerDone = reviewer.complete ? reviewer.complete(allTaskId, 'Finished review') : null
  T('T5.2 member present when @all task created can complete it',
    Boolean(rReviewerDone && (rReviewerDone.ok === true || rReviewerDone.already === true)))

  // Assign a second @all task
  const allTask2 = writer.assign ? writer.assign('all', 'Test suite optimization') : null
  await new Promise((r) => setTimeout(r, 300))

  // Now spawn a drive-by client who joins AFTER task creation
  driveByDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-driveby-${process.pid}-`))
  driveBy = startSync({
    relay: RELAY,
    room: ROOM,
    dir: driveByDir,
    name: 'DriveBy',
    kind: 'ai',
    passive: false,
    syncFiles: false,
    log: () => {},
  })
  await new Promise((res) => {
    const check = () => {
      if (driveBy.provider && driveBy.provider.synced) res()
      else setTimeout(check, 100)
    }
    check()
  })

  // DriveBy has no claim and no receipts and was not in room when allTask2 was created
  const rDriveByDone = driveBy.complete ? driveBy.complete(allTask2, 'Drive-by close') : null
  T('T5.3 drive-by member without claims/receipts is refused from completing @all task (Claude addition iii)',
    Boolean(rDriveByDone && rDriveByDone.error && /created|claim|receipt/i.test(rDriveByDone.error)))

  // Single-agent task protection
  const bobTask = writer.assign ? writer.assign('Bob', 'Fix bug') : null
  await new Promise((r) => setTimeout(r, 300))
  const rWrongAgent = reviewer.complete ? reviewer.complete(bobTask, 'Not my task') : null
  T('T5.4 single-agent task cannot be completed by another agent',
    Boolean(rWrongAgent && rWrongAgent.error && /only Bob can complete/i.test(rWrongAgent.error)))

  // Late joiner who claims/works can complete @all task (Mutant 1)
  await driveBy.claimSettled('auth.js', 'late fix')
  const rDriveByWithClaim = driveBy.complete ? driveBy.complete(allTask2, 'Drive-by completed after claim') : null
  T('T5.5 late-joining member with a claim can complete @all task (Mutant 1)',
    Boolean(rDriveByWithClaim && (rDriveByWithClaim.ok === true || rDriveByWithClaim.already === true)))

  // @all normalization test in assign
  const normTaskId = writer.assign ? writer.assign('@all', 'Normalize test task') : null
  await new Promise((r) => setTimeout(r, 200))
  const normTask = writer.doc ? writer.doc.getMap('tasks').get(normTaskId) : null
  T('T5.6 @all is normalized to all in assign without double @',
    Boolean(normTask && normTask.to === 'all'))

  // Group 6: MCP hive_review tool dispatch
  console.log('\n# Group 6: MCP hive_review tool dispatch')
  const { _test } = await import('../hive-mcp.js')
  _test.setSession({ name: 'Reviewer', hive: reviewer })
  const mcpPass = await _test.callTool('hive_review', { files: ['auth.js'], verdict: 'pass', note: 'LGTM via MCP' })
  T('T6.1 live hive_review MCP call passes and formats output',
    Boolean(mcpPass && mcpPass.content && mcpPass.content[0] && mcpPass.content[0].text.includes('Reviewed auth.js: PASS')))

  _test.setSession({ name: 'Writer', hive: writer })
  const mcpSelf = await _test.callTool('hive_review', { files: ['auth.js'], verdict: 'pass', note: 'Self review' })
  T('T6.2 live hive_review MCP call refuses self-review',
    Boolean(mcpSelf && mcpSelf.content && mcpSelf.content[0] && /contributor|contributed/i.test(mcpSelf.content[0].text)))
  _test.setSession(null)

  // Group 7: Unsynced file refusal
  console.log('\n# Group 7: Sync state validation')
  if (writer.edit) {
    await writer.edit('pending.js', 'export const pending = true\n', 'Add pending file')
  }
  await new Promise((r) => setTimeout(r, 400))
  reviewer.reviewStatus?.('pending.js')
  const pendingDoc = reviewer._fileDoc ? reviewer._fileDoc('pending.js') : null
  if (pendingDoc) {
    Object.defineProperty(pendingDoc, 'synced', { get: () => false, configurable: true })
    const rUnsynced = await reviewer.review(['pending.js'], 'pass', 'premature review')
    T('T7.1 review on unsynced file is refused with syncing error',
      Boolean(rUnsynced && rUnsynced.error && /not finished syncing/i.test(rUnsynced.error)))
  }

} catch (err) {
  console.error('Test suite error:', err)
} finally {
  if (writer && typeof writer.stop === 'function') {
    try { writer.stop() } catch {}
  }
  if (reviewer && typeof reviewer.stop === 'function') {
    try { reviewer.stop() } catch {}
  }
  if (reviewer2 && typeof reviewer2.stop === 'function') {
    try { reviewer2.stop() } catch {}
  }
  if (driveBy && typeof driveBy.stop === 'function') {
    try { driveBy.stop() } catch {}
  }
  if (relayProc) {
    try { relayProc.kill() } catch {}
  }
  if (writerDir) {
    try { fs.rmSync(writerDir, { recursive: true, force: true }) } catch {}
  }
  if (reviewerDir) {
    try { fs.rmSync(reviewerDir, { recursive: true, force: true }) } catch {}
  }
  if (reviewer2Dir) {
    try { fs.rmSync(reviewer2Dir, { recursive: true, force: true }) } catch {}
  }
  if (driveByDir) {
    try { fs.rmSync(driveByDir, { recursive: true, force: true }) } catch {}
  }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
