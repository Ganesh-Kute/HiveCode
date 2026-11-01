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
import { authorsOf, planCommits, commitMessage } from '../hive-pr.js'

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

  const groups = planCommits([
    { rel: 'b.js', last: { author: 'idB', name: 'AgentB' }, contributors: [{ author: 'idB', name: 'AgentB' }], first: 200 },
    { rel: 'a.js', last: { author: 'idA', name: 'AgentA' }, contributors: [{ author: 'idA', name: 'AgentA' }, { author: 'idB', name: 'AgentB' }], first: 100 },
  ])
  T('one group per agent, oldest first', groups.length === 2 && groups[0].name === 'AgentA')
  T('co-authors carried, self excluded', groups[0].others.length === 1 && groups[0].others[0].name === 'AgentB')
  const msg = commitMessage(groups[0], ROOM)
  T('commit carries the signed author id', msg.includes('Hivecode-Author: idA'))
  T('commit carries a Co-authored-by trailer', /Co-authored-by: AgentB </.test(msg))
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
