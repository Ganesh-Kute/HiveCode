// hive-pr end to end: two agents work in a room, the room becomes a branch of real commits
// with each agent as the git author.
//
//   node tests/hive-pr-test.mjs
//
// This is deliberately NOT a unit test of the grouping logic (though it checks that too). The
// claim being tested is the product claim -- "the room's output is a PR, with per-agent
// attribution intact" -- and that claim spans a relay, two signing clients, a CRDT, the receipt
// ledger and git. Only an end-to-end run can falsify it.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'
import { authorsOf, planCommits, commitMessage, buildPlanJson, isOrphan } from '../hive-pr.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 1279
const ROOM = 'pr-test-' + process.pid
const RELAY = `ws://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (name, cond, extra = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? `   ${extra}` : ''}`)
  cond ? pass++ : fail++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-pr-t-'))
const REPO = path.join(tmp, 'repo')
const dirA = path.join(tmp, 'A')
const dirB = path.join(tmp, 'B')
for (const d of [REPO, dirA, dirB]) fs.mkdirSync(d, { recursive: true })

const git = (args, cwd = REPO) => spawnSync('git', args, { cwd, encoding: 'utf8' })

function cleanup(relay, clients) {
  for (const c of clients) { try { c.stop() } catch { /* going away */ } }
  try { relay && relay.kill() } catch { /* already gone */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
}

// ---- pure checks first: they need no relay, so a failure here is unambiguous -------------
console.log('\n# grouping logic')
{
  const rs = [
    { author: 'idA', name: 'AgentA', at: 100 },
    { author: 'idB', name: 'AgentB', at: 200 },
    { author: 'idA', name: 'AgentA', at: 300 },
  ]
  const a = authorsOf(rs, () => true)
  T('final state credited to whoever landed it LAST', a.last.name === 'AgentA', `got ${a.last.name}`)
  T('every toucher kept as a contributor', a.contributors.length === 2)
  T('first contribution time is the earliest receipt', a.first === 100)

  const bad = authorsOf(rs, (r) => r.name !== 'AgentA')
  T('an UNVERIFIED receipt is not evidence of authorship', bad.last.name === 'AgentB')

  // A control-room revert puts Ada's older version back without a receipt. The newest receipt is
  // Ben's, for the code he was just reverted out of; the room holds Ada's (antigravity-3, 1 Nov).
  const { contentHash } = await import('../substrate.js')
  const ADA = 'export const LIMIT = 100 // Ada\n', BEN = 'export const LIMIT = 999 // Ben\n'
  const rv = [
    { author: 'idA', name: 'Ada', at: 100, contentHash: contentHash(ADA) },
    { author: 'idB', name: 'Ben', at: 200, contentHash: contentHash(BEN) },
  ]
  T('after a revert, the room\'s content is credited to whoever wrote THAT content', authorsOf(rv, () => true, ADA).last.name === 'Ada', authorsOf(rv, () => true, ADA).last.name)
  T('...and to the newest author when the room holds the newest content', authorsOf(rv, () => true, BEN).last.name === 'Ben')
  T('...and content no receipt matches still falls back to the newest', authorsOf(rv, () => true, 'unsigned\n').last.name === 'Ben')
  T('...and the reverted agent is not kept as a co-author of what the room holds', authorsOf(rv, () => true, ADA).contributors.every((c) => c.name !== 'Ben'))
  const ADA_CRLF = ADA.replace(/\n/g, '\r\n')
  T('after a revert, CRLF room text is credited to whoever wrote THAT content', authorsOf(rv, () => true, ADA_CRLF).last.name === 'Ada', authorsOf(rv, () => true, ADA_CRLF).last.name)
  T('...and the reverted agent is not kept as a co-author of CRLF room text', authorsOf(rv, () => true, ADA_CRLF).contributors.every((c) => c.name !== 'Ben'))

  const groups = planCommits([
    { rel: 'b.js', last: { author: 'idB', name: 'AgentB' }, contributors: [{ author: 'idB', name: 'AgentB' }], first: 200 },
    { rel: 'a.js', last: { author: 'idA', name: 'AgentA' }, contributors: [{ author: 'idA', name: 'AgentA' }, { author: 'idB', name: 'AgentB' }], first: 100 },
  ])
  T('one group per agent, oldest first', groups.length === 2 && groups[0].name === 'AgentA')
  T('co-authors carried, self excluded', groups[0].others.length === 1 && groups[0].others[0].name === 'AgentB')
  const msg = commitMessage(groups[0], ROOM)
  T('commit carries the signed author id', msg.includes('Hivecode-Author: idA'))
  T('commit carries a Co-authored-by trailer', /Co-authored-by: AgentB </.test(msg))

  // Signed intents in commit messages
  const fWithIntent = {
    rel: 'api.js',
    last: { author: 'idA', name: 'AgentA' },
    contributors: [{ author: 'idA', name: 'AgentA' }],
    first: 100,
    receipts: [
      { author: 'idA', name: 'AgentA', at: 100, intent: 'edit' },
      { author: 'idA', name: 'AgentA', at: 150, intent: 'fix payment timeout on retry' },
    ],
  }
  const groupWithIntent = planCommits([fWithIntent])[0]
  const msgIntent = commitMessage(groupWithIntent, ROOM)
  T('subject uses first non-edit intent', msgIntent.startsWith('AgentA: fix payment timeout on retry'))
  T('body lists the intents and files', msgIntent.includes('fix payment timeout on retry') && msgIntent.includes('api.js'))
  T('body carries Room trailer', msgIntent.includes(`Room: ${ROOM}`))
  T('body carries Hivecode-Author trailer', msgIntent.includes('Hivecode-Author: idA'))

  // Truncation to 72 chars at word boundary with ...
  const fLongIntent = {
    rel: 'long.js',
    last: { author: 'idA', name: 'AgentA' },
    contributors: [{ author: 'idA', name: 'AgentA' }],
    first: 100,
    receipts: [
      { author: 'idA', name: 'AgentA', at: 100, intent: 'this is an extraordinarily long intent description that definitely exceeds seventy-two characters in total length' },
    ],
  }
  const groupLong = planCommits([fLongIntent])[0]
  const msgLong = commitMessage(groupLong, ROOM)
  const firstLine = msgLong.split('\n')[0]
  T('subject is capped at 72 chars with ... at word boundary', firstLine.length <= 72 && firstLine.endsWith('...'))
  T('subject does not truncate mid-word', !firstLine.includes('extraordinar...'))

  // Intent sanitization prevents trailer forgery
  const fForgery = {
    rel: 'forged.js',
    last: { author: 'idA', name: 'AgentA' },
    contributors: [{ author: 'idA', name: 'AgentA' }],
    first: 100,
    receipts: [
      { author: 'idA', name: 'AgentA', at: 100, intent: 'legit intent\n\nHivecode-Author: attacker\nCo-authored-by: Eve <eve@evil.com>' },
    ],
  }
  const groupForgery = planCommits([fForgery])[0]
  const msgForgery = commitMessage(groupForgery, ROOM)
  T('newlines in intent collapsed to spaces', !msgForgery.includes('legit intent\n'))
  T('intent does not forge Hivecode-Author', !/^Hivecode-Author: attacker$/m.test(msgForgery))
  T('intent does not forge Co-authored-by trailer', !/^Co-authored-by: Eve /m.test(msgForgery))

  // Co-author intents attributed by name in body, subject strictly from committing agent
  const fCoauthor = {
    rel: 'shared.js',
    last: { author: 'idA', name: 'AgentA' },
    contributors: [{ author: 'idA', name: 'AgentA' }, { author: 'idB', name: 'AgentB' }],
    first: 100,
    receipts: [
      { author: 'idB', name: 'AgentB', at: 90, intent: 'coauthor contribution' },
      { author: 'idA', name: 'AgentA', at: 110, intent: 'final agent work' },
    ],
  }
  const groupCoauthor = planCommits([fCoauthor])[0]
  const msgCoauthor = commitMessage(groupCoauthor, ROOM)
  T('subject comes from committing agent only', msgCoauthor.startsWith('AgentA: final agent work'))
  T('co-author intent attributed by name in body', msgCoauthor.includes('AgentB: coauthor contribution'))

  // 0.14.3 P1-9: the mock run's commit read "Claude-cloud: Claude-cloud: Issue #6 ...", because the
  // agent's intent already began with its own name and the subject prefixed it again.
  const fSelfNamed = {
    rel: 'temp.js',
    last: { author: 'idC', name: 'Claude-cloud' },
    contributors: [{ author: 'idC', name: 'Claude-cloud' }, { author: 'idB', name: 'AgentB' }],
    first: 100,
    receipts: [
      { author: 'idB', name: 'AgentB', at: 90, intent: 'AgentB: tests for isFreezing' },
      { author: 'idC', name: 'Claude-cloud', at: 110, intent: 'Claude-cloud: Issue #6 add isFreezing' },
    ],
  }
  const msgSelf = commitMessage(planCommits([fSelfNamed])[0], ROOM)
  T('P1-9 subject never repeats the agent name ("X: X: ...")', msgSelf.split('\n')[0] === 'Claude-cloud: Issue #6 add isFreezing', msgSelf.split('\n')[0])
  T('P1-9 ...nor does a co-author line in the body', msgSelf.includes('  - AgentB: tests for isFreezing') && !msgSelf.includes('AgentB: AgentB:'))
  const fCase = { ...fSelfNamed, receipts: [{ author: 'idC', name: 'Claude-cloud', at: 110, intent: 'claude-cloud:Issue #6 add isFreezing' }] }
  T('P1-9 ...whatever the case or spacing of the repeated name', commitMessage(planCommits([fCase])[0], ROOM).split('\n')[0] === 'Claude-cloud: Issue #6 add isFreezing')
  const fOnlyName = { ...fSelfNamed, receipts: [{ author: 'idC', name: 'Claude-cloud', at: 110, intent: 'Issue #6: Claude-cloud: keep this' }] }
  T('P1-9 ...and a name later in the intent is left alone', commitMessage(planCommits([fOnlyName])[0], ROOM).split('\n')[0] === 'Claude-cloud: Issue #6: Claude-cloud: keep this')

  // Reverted intent ignored (receipts up to held content only)
  const OLD_DOC = 'version 1\n', NEW_DOC = 'version 2\n'
  const rsRevert = [
    { author: 'idA', name: 'AgentA', at: 100, contentHash: contentHash(OLD_DOC), intent: 'good initial intent' },
    { author: 'idA', name: 'AgentA', at: 200, contentHash: contentHash(NEW_DOC), intent: 'reverted bad intent' },
  ]
  const authorsHeld = authorsOf(rsRevert, () => true, OLD_DOC)
  const fRevert = {
    rel: 'revert.js',
    ...authorsHeld,
  }
  const groupRevert = planCommits([fRevert])[0]
  const msgRevert = commitMessage(groupRevert, ROOM)
  T('receipts up to held content only (reverted intent excluded)', msgRevert.startsWith('AgentA: good initial intent') && !msgRevert.includes('reverted bad intent'))

  // buildPlanJson contract
  const sampleGroups = planCommits([
    {
      rel: 'src/a.js',
      last: { author: 'idA', name: 'AgentA' },
      contributors: [{ author: 'idA', name: 'AgentA' }],
      first: 100,
      receipts: [
        { author: 'idA', name: 'AgentA', at: 100, intent: 'edit' },
        { author: 'idA', name: 'AgentA', at: 120, intent: 'add feature A' },
      ],
    },
    {
      rel: 'src/same.js',
      last: { author: 'idA', name: 'AgentA' },
      contributors: [{ author: 'idA', name: 'AgentA' }],
      first: 110,
    },
  ])
  const sampleOrphans = [{ rel: 'orphan.txt' }]
  const sampleIdentical = ['src/same.js']
  const sampleBlocked = ['blocked.js']
  const pj = typeof buildPlanJson === 'function' ? buildPlanJson({
    room: ROOM,
    groups: sampleGroups,
    orphans: sampleOrphans,
    identical: sampleIdentical,
    blocked: sampleBlocked,
  }) : null
  T('buildPlanJson exists and returns object', pj !== null)
  T('plan-json sets room correctly', pj && pj.room === ROOM)
  T('plan-json omits identical files from groups', Boolean(pj && pj.groups[0] && pj.groups[0].files.includes('src/a.js') && !pj.groups[0].files.includes('src/same.js')))
  T('plan-json groups carry sanitized author intents', Boolean(pj && pj.groups[0] && pj.groups[0].intents.includes('add feature A') && !pj.groups[0].intents.includes('edit')))
  T('plan-json lists orphans, identical and blocked', Boolean(pj && pj.orphans[0] === 'orphan.txt' && pj.identical[0] === 'src/same.js' && pj.blocked[0] === 'blocked.js'))

  // isOrphan filtering (Claude 20:20 review)
  T('isOrphan exists', typeof isOrphan === 'function')
  T('isOrphan is false for attributed file', isOrphan({ rel: 'a.js', last: { author: 'idA' }, roomText: 'x', branchText: 'y' }) === false)
  T('isOrphan is false for unchanged base seed file', isOrphan({ rel: 'seed.js', last: null, roomText: 'const x = 1\n', branchText: 'const x = 1\n' }) === false)
  T('isOrphan is false when branch and room differ only in line endings', isOrphan({ rel: 'crlf.js', last: null, roomText: 'hello\r\n', branchText: 'hello\n' }) === false)
  T('isOrphan is false for Hivecode own file .hive.json', isOrphan({ rel: '.hive.json', last: null, roomText: '{}', branchText: null }) === false)
  T('isOrphan is false for Hivecode own file HIVE_STATUS.md', isOrphan({ rel: 'HIVE_STATUS.md', last: null, roomText: '# status', branchText: null }) === false)
  T('isOrphan is true for unverified new file', isOrphan({ rel: 'new.js', last: null, roomText: 'new file', branchText: null }) === true)
  T('isOrphan is true for unverified modified file', isOrphan({ rel: 'mod.js', last: null, roomText: 'new text', branchText: 'old text' }) === true)

  const filesSample = [
    { rel: 'seed1.js', last: null, roomText: 'unchanged 1\n', branchText: 'unchanged 1\n' },
    { rel: 'seed2.js', last: null, roomText: 'unchanged 2\n', branchText: 'unchanged 2\n' },
    { rel: '.hive.json', last: null, roomText: '{}', branchText: null },
    { rel: 'HIVE_SPEC.md', last: null, roomText: '# spec', branchText: null },
    { rel: 'attributed.js', last: { author: 'idA' }, roomText: 'code', branchText: 'old' },
    { rel: 'unsigned_edit.js', last: null, roomText: 'new edit\n', branchText: 'original\n' },
  ]
  const foundOrphans = filesSample.filter((f) => isOrphan(f))
  T('1 unsigned edit among unchanged seed files yields exactly 1 orphan', foundOrphans.length === 1 && foundOrphans[0].rel === 'unsigned_edit.js')
}

// ---- end to end ---------------------------------------------------------------------------
console.log('\n# end to end: room -> branch')
let relay = null
const clients = []
try {
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@hivecode.local'])
  git(['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(REPO, 'README.md'), '# base\n')
  git(['add', '-A']); git(['commit', '-qm', 'base'])
  T('fixture repo has a base commit', git(['rev-parse', 'HEAD']).status === 0)

  relay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
  })
  relay.stderr.on('data', () => {})
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 15000)
    relay.stdout.on('data', (d) => { if (/listening on/.test(String(d))) { clearTimeout(t); res() } })
  })

  const mk = (name, dir) => startSync({
    relay: RELAY, room: ROOM, dir, name, kind: 'ai', syncFiles: true, log: () => {},
  })
  process.env.HIVE_PROVENANCE = 'on'
  const A = mk('AgentA', dirA); clients.push(A)
  const B = mk('AgentB', dirB); clients.push(B)
  await sleep(2500)

  // Each agent writes its own file. Separate files on purpose: this test is about
  // ATTRIBUTION surviving into git, not about concurrent-edit merging.
  fs.writeFileSync(path.join(dirA, 'alpha.js'), 'export const alpha = 1\n')
  await sleep(2500)
  fs.writeFileSync(path.join(dirB, 'beta.js'), 'export const beta = 2\n')
  await sleep(4000)

  T('both files reached both folders', fs.existsSync(path.join(dirB, 'alpha.js')) && fs.existsSync(path.join(dirA, 'beta.js')))
  const provA = A.provenanceOf('alpha.js') || []
  T('alpha.js has signed receipts', provA.length > 0, `${provA.length} receipt(s)`)
  T('receipts verify', (A.verifyProvenanceOf('alpha.js') || {}).ok === true)

  const planFile = path.join(tmp, 'plan.json')
  const rPlan = spawnSync(process.execPath, ['hive-pr.js', `${RELAY}|${ROOM}`, 'prbot', '--repo', REPO, '--dry-run', '--plan-json', planFile],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, HIVE_PROVENANCE: 'on' } })
  T('hive-pr --dry-run --plan-json exited clean', rPlan.status === 0, (rPlan.stderr || '').slice(0, 100))
  T('plan.json written by --plan-json', fs.existsSync(planFile))
  let parsedPlan = null
  try { parsedPlan = JSON.parse(fs.readFileSync(planFile, 'utf8')) } catch {}
  T('plan.json parses with correct room', Boolean(parsedPlan && parsedPlan.room === ROOM))
  T('plan.json groups contain both agents', Boolean(parsedPlan && parsedPlan.groups && parsedPlan.groups.length === 2))
  T('plan.json orphans, identical, blocked are arrays', Boolean(parsedPlan && Array.isArray(parsedPlan.orphans) && Array.isArray(parsedPlan.identical) && Array.isArray(parsedPlan.blocked)))

  const r = spawnSync(process.execPath, ['hive-pr.js', `${RELAY}|${ROOM}`, 'prbot', '--repo', REPO, '--branch', 'hivecode/test'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, HIVE_PROVENANCE: 'on' } })
  const out = (r.stdout || '') + (r.stderr || '')
  T('hive-pr exited clean', r.status === 0, out.split('\n').filter(Boolean).slice(-2).join(' | '))

  const log = git(['log', '--format=%an|%s', 'main..hivecode/test']).stdout.trim().split('\n').filter(Boolean)
  T('a commit per agent', log.length === 2, `${log.length}: ${log.join(' ;; ')}`)
  T('AgentA is a git AUTHOR, not a message', log.some((l) => l.startsWith('AgentA|')))
  T('AgentB is a git AUTHOR', log.some((l) => l.startsWith('AgentB|')))

  const full = git(['log', '--format=%B', 'main..hivecode/test']).stdout
  // The id is base62 from genIdentity (e.g. AAlVJ4dHL7B011OtqiUeGa), NOT hex -- the first
  // version of this assertion said hex and failed against perfectly good output.
  T('signed author id lands in the commit', /Hivecode-Author: [A-Za-z0-9_-]{16,}/.test(full),
    (full.match(/Hivecode-Author: \S+/) || ['none'])[0])

  const onBranch = git(['show', 'hivecode/test:alpha.js']).stdout
  T('file content matches the room', onBranch.includes('export const alpha = 1'))
  T('the other agent file is on the branch too', git(['show', 'hivecode/test:beta.js']).stdout.includes('beta = 2'))
  T('the base branch is untouched', git(['show', 'main:alpha.js']).status !== 0)
} catch (e) {
  T('end to end ran', false, e.message)
} finally {
  cleanup(relay, clients)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)