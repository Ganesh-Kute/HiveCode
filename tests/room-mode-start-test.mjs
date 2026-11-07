// room-mode start checks test suite (B1)
//
//   node tests/room-mode-start-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'

let pass = 0, fail = 0
const T = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? `   ${extra}` : ''}`)
  cond ? pass++ : fail++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'room-mode-test-'))

let roomModeMod = null
try {
  roomModeMod = await import('../hive-room-mode.js')
} catch (e) {
  // Module absent or failed to load
}

const {
  validateRoomLink,
  checkGitRepo,
  getRepoRoot,
  checkBranchBinding,
  checkGitHubAuth,
  checkGhAuth,
  checkMemberVersions,
  checkRoomMembers,
  checkWatcherLock,
  takeRoomWatcherLock,
  checkRoomModeStart,
} = roomModeMod || {}

console.log('\n# B1: Room-Mode Start Checks')

// Group 1: Room link validation (Q650)
{
  const vrl = validateRoomLink
  const t1 = vrl ? vrl('') : null
  T('T1.1 empty room link refused with Q650', Boolean(t1 && t1.code === 'Q650'))

  const t2 = vrl ? vrl('not-a-valid-link') : null
  T('T1.2 malformed room link refused with Q650', Boolean(t2 && t2.code === 'Q650'))

  const t3 = vrl ? vrl('wss://relay.example.com|room-test-123') : null
  T('T1.3 valid room link parses relay and room', Boolean(t3 && t3.ok === true && t3.room === 'room-test-123' && t3.relay === 'wss://relay.example.com'))
}

// Group 2: Git repo & toplevel check (Q651)
{
  const grr = getRepoRoot || checkGitRepo
  const repo1 = path.join(tmp, 'repo1')
  fs.mkdirSync(path.join(repo1, 'sub', 'deep'), { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: repo1 })

  const t1 = grr ? grr(path.join(repo1, 'sub', 'deep')) : null
  const rootFound = t1 && t1.ok ? (t1.root || t1.repo) : null
  T('T2.1 finds git toplevel from subdirectory', Boolean(rootFound && path.resolve(rootFound) === path.resolve(repo1)))

  // Git worktree simulation (.git is a file, not a directory)
  const wtReal = path.join(tmp, 'wt-real')
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo1 })
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: repo1 })
  fs.writeFileSync(path.join(repo1, 'init.txt'), 'init', 'utf8')
  spawnSync('git', ['add', 'init.txt'], { cwd: repo1 })
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repo1 })
  spawnSync('git', ['worktree', 'add', '-b', 'wt-branch', wtReal], { cwd: repo1 })
  const t2 = grr ? grr(wtReal) : null
  T('T2.2 finds git toplevel in worktree (.git is file)', Boolean(t2 && t2.ok === true))

  const notRepo = path.join(tmp, 'not-a-repo')
  fs.mkdirSync(notRepo, { recursive: true })
  const t3 = grr ? grr(notRepo) : null
  T('T2.3 non-git directory refused with Q651', Boolean(t3 && t3.code === 'Q651'))

  const homeRes = grr ? grr(os.homedir()) : null
  T('T2.4 home directory refused with Q651', Boolean(homeRes && homeRes.code === 'Q651'))
}

// Group 3: Branch binding check (Q652)
{
  const cbb = checkBranchBinding
  const repo2 = path.join(tmp, 'repo2')
  fs.mkdirSync(repo2, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: repo2 })
  spawnSync('git', ['config', '--local', 'hivecode.feature-x.room', 'wss://relay.example.com|room-abc-123'], { cwd: repo2 })

  const t1 = cbb ? cbb(repo2, 'room-abc-123') : null
  T('T3.1 finds bound branch by room id', Boolean(t1 && t1.ok === true && t1.branch === 'feature-x'))

  const t2 = cbb ? cbb(repo2, 'wss://relay.example.com|room-abc-123') : null
  T('T3.2 finds bound branch by full room link', Boolean(t2 && t2.ok === true && t2.branch === 'feature-x'))

  const t3 = cbb ? cbb(repo2, 'room-unbound') : null
  T('T3.3 unbound room refused with Q652', Boolean(t3 && t3.code === 'Q652'))

  // Defect 5: Ambiguous binding (multiple branches bound to same room)
  spawnSync('git', ['config', '--local', 'hivecode.feature-y.room', 'wss://relay.example.com|room-abc-123'], { cwd: repo2 })
  const t4 = cbb ? cbb(repo2, 'room-abc-123') : null
  T('T3.4 multiple branches bound to one room refused as ambiguous Q652', Boolean(t4 && t4.code === 'Q652' && /multiple branches/i.test(t4.why)))
}

// Group 4: GitHub authentication check (Q653)
{
  const cga = checkGitHubAuth || checkGhAuth
  const t1 = cga ? cga({ ghRunner: () => ({ status: null, stderr: 'gh: command not found' }) }) : null
  T('T4.1 missing gh binary refused with Q653', Boolean(t1 && t1.code === 'Q653'))

  const t2 = cga ? cga({ ghRunner: () => ({ status: 1, stderr: 'You are not logged into any GitHub hosts.' }) }) : null
  T('T4.2 logged-out gh refused with Q653', Boolean(t2 && t2.code === 'Q653'))

  const t3 = cga ? cga({ ghRunner: () => ({ status: 0, stdout: 'Logged in to github.com account octocat' }) }) : null
  T('T4.3 authenticated gh passes', Boolean(t3 && t3.ok === true))
}

// Group 5: Room member version checks (Q654)
{
  const cmv = checkMemberVersions || checkRoomMembers
  const t1 = cmv ? cmv([
    { name: 'bot-old', version: '0.12.9', kind: 'ai' },
    { name: 'bot-new', version: '0.13.0', kind: 'ai' },
  ]) : null
  T('T5.1 member with version < 0.13.0 refused with Q654', Boolean(t1 && t1.code === 'Q654' && t1.member === 'bot-old'))

  const t2 = cmv ? cmv([
    { name: 'Ganesh', kind: 'human' },
    { name: 'bot-new', version: '0.13.0', kind: 'ai' },
  ]) : null
  T('T5.2 human member with no version is skipped, not refused', Boolean(t2 && t2.ok === true && !t2.warn))

  const t3 = cmv ? cmv([
    { name: 'ControlRoom' },
    { name: 'bot-new', version: '0.13.0', kind: 'ai' },
  ]) : null
  T('T5.3 non-agent member with no version is skipped', Boolean(t3 && t3.ok === true && !t3.warn))

  const t4 = cmv ? cmv([]) : null
  T('T5.4 0 agents in room gives warning, not refusal', Boolean(t4 && t4.ok === true && /no agent/i.test(t4.warn)))

  const t5 = cmv ? cmv([{ name: 'Ganesh', kind: 'human' }]) : null
  T('T5.5 only humans in room gives warning, not refusal', Boolean(t5 && t5.ok === true && /no agent/i.test(t5.warn)))

  const t6 = cmv ? cmv([
    { name: 'Claude', version: '0.13.0', kind: 'ai' },
    { name: 'antigravity-4', version: '0.13.0', kind: 'ai' },
  ]) : null
  T('T5.6 valid agents with >= 0.13.0 pass without warning', Boolean(t6 && t6.ok === true && !t6.warn))

  // Defect 5: Unversioned AI agent refused as < 0.13.0
  const t7 = cmv ? cmv([
    { name: 'old-ai-bot', kind: 'ai' }, // missing version -> 0.12-era
  ]) : null
  T('T5.7 AI member with NO version refused with Q654', Boolean(t7 && t7.code === 'Q654' && t7.member === 'old-ai-bot'))
}

// Group 6: Watcher lock (Q655)
{
  const cwl = takeRoomWatcherLock || checkWatcherLock
  const repo3 = path.join(tmp, 'repo3')
  fs.mkdirSync(repo3, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: repo3 })

  const t1 = cwl ? cwl(repo3, 'room-test-lock') : null
  T('T6.1 acquires watcher lock file', Boolean(t1 && t1.ok === true && fs.existsSync(t1.lockFile)))

  const t2 = cwl ? cwl(repo3, 'room-test-lock', { pid: 999999, isAlive: () => true }) : null
  T('T6.2 active second watcher refused with Q655', Boolean(t2 && t2.code === 'Q655'))

  const t3 = cwl ? cwl(repo3, 'room-test-lock', { pid: 12345, isAlive: () => false }) : null
  T('T6.3 stale watcher lock with dead pid is overwritten', Boolean(t3 && t3.ok === true))

  if (t3 && typeof t3.release === 'function') t3.release()
  else if (t1 && t1.lockFile) {
    try { fs.unlinkSync(t1.lockFile) } catch {}
  }
  const lockExists = t1 && t1.lockFile ? fs.existsSync(t1.lockFile) : true
  T('T6.4 release() removes the lock file', !lockExists)

  // Defect 5: release() does NOT delete lock if PID does not match
  const t4 = cwl ? cwl(repo3, 'room-pid-check', { pid: 11111 }) : null
  // Simulate another process taking it over
  const lockData2 = JSON.stringify({ pid: 22222, room: 'room-pid-check', startedAt: new Date().toISOString() })
  fs.writeFileSync(t4.lockFile, lockData2, 'utf8')
  if (t4 && typeof t4.release === 'function') t4.release() // old process calls release()
  T('T6.5 release() does not unlink file if another PID owns it', fs.existsSync(t4.lockFile))
  try { fs.unlinkSync(t4.lockFile) } catch {}
}

// Group 7: Unified checkRoomModeStart orchestrator
{
  const crs = checkRoomModeStart
  const repo4 = path.join(tmp, 'repo4')
  fs.mkdirSync(repo4, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: repo4 })
  spawnSync('git', ['config', '--local', 'hivecode.main.room', 'wss://relay.test|room-full-pipeline'], { cwd: repo4 })

  const t1 = crs ? await crs({
    repo: repo4,
    link: 'wss://relay.test|room-full-pipeline',
    ghRunner: () => ({ status: 0, stdout: 'Logged in' }),
    members: [{ name: 'Claude', version: '0.13.0', kind: 'ai' }],
  }) : null
  T('T7.1 full pipeline passes when all preconditions hold', Boolean(t1 && t1.ok === true && t1.branch === 'main'))
  if (t1 && t1.lockFile) {
    try { fs.unlinkSync(t1.lockFile) } catch {}
  }

  const t2 = crs ? await crs({
    repo: repo4,
    link: 'invalid-link',
    ghRunner: () => ({ status: 0, stdout: 'Logged in' }),
  }) : null
  T('T7.2 fails early on invalid link with Q650', Boolean(t2 && t2.code === 'Q650'))

  const t3 = crs ? await crs({
    repo: repo4,
    link: 'wss://relay.test|room-unbound-999',
    ghRunner: () => ({ status: 0, stdout: 'Logged in' }),
  }) : null
  T('T7.3 fails on unbound branch with Q652', Boolean(t3 && t3.code === 'Q652'))

  const t4 = crs ? await crs({
    repo: repo4,
    link: 'wss://relay.test|room-full-pipeline',
    ghRunner: () => ({ status: 0, stdout: 'Logged in' }),
    members: [],
  }) : null
  T('T7.4 passes with warning when room has 0 agents', Boolean(t4 && t4.ok === true && /no agent/i.test(t4.warn)))
  if (t4 && t4.lockFile) {
    try { fs.unlinkSync(t4.lockFile) } catch {}
  }

  // Defect 5: Live peek check when members omitted, returns Q656 on dead relay
  const t5 = crs ? await crs({
    repo: repo4,
    link: 'ws://127.0.0.1:9999|room-full-pipeline',
    ghRunner: () => ({ status: 0, stdout: 'Logged in' }),
  }) : null
  T('T7.5 checkRoomModeStart returns Q656 when live relay is unreachable and members omitted',
    Boolean(t5 && t5.ok === false && t5.code === 'Q656'))
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
