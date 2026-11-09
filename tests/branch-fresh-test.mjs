// tests/branch-fresh-test.mjs -- P1-7: a new branch room is not cut from a stale local main.
//
// `branch fix-x` cut from HEAD, usually a local main last pulled days ago, so the room was seeded
// with old files and landing later met the newer main as a conflict nobody had caused. freshCutPoint
// (hive-branch.js) fetches the source branch's remote copy first. Git only, no relay: local bare
// origins, so nothing leaves this machine.
//
//   F1 local strictly behind: cut from the remote, with a note that names the count
//   F2 local equal: cut from local, no note
//   F3 local ahead: cut from local (the developer's own commits), no note
//   F4 diverged: cut from local, the note says diverged and how to choose the remote
//   F5 the fetch fails: cut from local, the note says it could not fetch
//   F6 a remote ref or a sha is taken exactly as given
//   F7 HIVE_BRANCH_FETCH=0: no fetch, so a remote change nobody fetched is not seen
//   F8 the configured upstream is used, not just origin/<same name>
//   F9 detached HEAD, a repository without a remote, a remote without the branch: as given, no note
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
process.env.HIVE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-fresh-home-'))
const { freshCutPoint } = await import(pathToFileURL(path.join(ROOT, 'hive-branch.js')).href)

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-fresh-'))
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } }
const ident = (d) => { g(d, 'config', 'user.email', 'dev@example.com'); g(d, 'config', 'user.name', 'Dev'); g(d, 'config', 'core.autocrlf', 'false') }
let n = 0
const commit = (d, msg) => { fs.writeFileSync(path.join(d, `f${++n}.txt`), `${msg}\n`); g(d, 'add', '-A'); g(d, 'commit', '-qm', msg); return g(d, 'rev-parse', 'HEAD').out }
const head = (d, ref = 'HEAD') => g(d, 'rev-parse', ref).out

try {
  const origin = path.join(tmp, 'origin.git')
  g(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
  const seed = path.join(tmp, 'seed')
  fs.mkdirSync(seed); g(seed, 'init', '-q', '-b', 'main'); ident(seed); commit(seed, 'init')
  g(seed, 'remote', 'add', 'origin', origin); g(seed, 'push', '-q', 'origin', 'main')
  const A = path.join(tmp, 'a'), B = path.join(tmp, 'b')
  g(tmp, 'clone', '-q', origin, A); g(tmp, 'clone', '-q', origin, B); ident(A); ident(B)

  console.log('\n# F1-F4 local behind, equal, ahead, diverged')
  const pushed = commit(B, 'teammate 1'); g(B, 'push', '-q', 'origin', 'main')
  const before = head(A)
  const r1 = freshCutPoint(A, '')
  T('F1 behind: cut from origin/main', r1.sha === pushed && r1.src === 'origin/main' && r1.behind === 1, JSON.stringify(r1))
  T('F1 ...the note names the count and says nothing is left out', /1 commit\(s\) behind origin\/main/.test(r1.note) && /Nothing of yours is left out/.test(r1.note), r1.note)
  T('F1 ...and the local main is not moved', head(A, 'main') === before)

  g(A, 'merge', '-q', '--ff-only', 'origin/main')
  const r2 = freshCutPoint(A, '')
  T('F2 equal: cut from local, no note', r2.sha === head(A) && r2.note === '', JSON.stringify(r2))

  const mine = commit(A, 'my own work')
  const r3 = freshCutPoint(A, '')
  T('F3 ahead: cut from local (my own commits), no note', r3.sha === mine && r3.note === '', JSON.stringify(r3))

  commit(B, 'teammate 2'); g(B, 'push', '-q', 'origin', 'main')
  const r4 = freshCutPoint(A, 'main')
  T('F4 diverged: cut from my local main', r4.sha === mine && r4.behind === 1 && r4.ahead === 1, JSON.stringify(r4))
  T('F4 ...the note says diverged and how to cut from origin instead', /diverged \(1 behind, 1 ahead\)/.test(r4.note) && /--from origin\/main/.test(r4.note), r4.note)

  console.log('\n# F5 the fetch fails')
  const C = path.join(tmp, 'c'); g(tmp, 'clone', '-q', origin, C); ident(C)
  g(C, 'remote', 'set-url', 'origin', path.join(tmp, 'no-such-origin.git'))
  const r5 = freshCutPoint(C, '')
  T('F5 cut from local, and the note says the fetch failed', r5.sha === head(C) && /could not fetch/.test(r5.note), JSON.stringify(r5))

  console.log('\n# F6 a remote ref or a sha, exactly as given')
  const r6 = freshCutPoint(A, 'origin/main')
  T('F6 origin/main as last fetched, no note', r6.sha === head(A, 'origin/main') && r6.src === 'origin/main' && r6.note === '', JSON.stringify(r6))
  const r6b = freshCutPoint(A, before)
  T('F6 a sha as given', r6b.sha === before && r6b.note === '', JSON.stringify(r6b))

  console.log('\n# F7 HIVE_BRANCH_FETCH=0')
  const D = path.join(tmp, 'd'); g(tmp, 'clone', '-q', origin, D); ident(D)
  const dTip = head(D)
  const later = commit(B, 'teammate 3'); g(B, 'push', '-q', 'origin', 'main')
  process.env.HIVE_BRANCH_FETCH = '0'
  const r7 = freshCutPoint(D, '')
  delete process.env.HIVE_BRANCH_FETCH
  T('F7 no fetch: the unfetched push is not seen, cut from local', r7.sha === dTip && r7.note === '', JSON.stringify(r7))
  const r7b = freshCutPoint(D, '')
  T('F7 ...with the fetch, it is', r7b.sha === later && r7b.behind === 1, JSON.stringify(r7b))

  console.log('\n# F8 the configured upstream')
  const E = path.join(tmp, 'e'); g(tmp, 'clone', '-q', origin, E); ident(E)
  g(E, 'branch', '-q', '--track', 'work', 'origin/main')
  const eTip = head(E, 'work')
  const newest = commit(B, 'teammate 4'); g(B, 'push', '-q', 'origin', 'main')
  const r8 = freshCutPoint(E, 'work')
  T('F8 a local "work" tracking origin/main is compared with origin/main', r8.sha === newest && r8.src === 'origin/main' && eTip !== newest, JSON.stringify(r8))

  console.log('\n# F9 detached HEAD, no remote')
  g(E, 'checkout', '-q', '--detach', eTip)
  const r9 = freshCutPoint(E, '')
  T('F9 detached HEAD: as given, no note', r9.sha === eTip && r9.note === '', JSON.stringify(r9))
  const lone = path.join(tmp, 'lone'); fs.mkdirSync(lone); g(lone, 'init', '-q', '-b', 'main'); ident(lone); const lt = commit(lone, 'alone')
  const r9b = freshCutPoint(lone, '')
  T('F9 no remote: local, no note', r9b.sha === lt && r9b.note === '', JSON.stringify(r9b))
  const bare2 = path.join(tmp, 'empty-origin.git'); g(tmp, 'init', '-q', '--bare', bare2)
  g(lone, 'remote', 'add', 'origin', bare2)
  const r9c = freshCutPoint(lone, '')
  T('F9 a remote that has no such branch (main never pushed): local, no note', r9c.sha === lt && r9c.note === '', JSON.stringify(r9c))
} catch (e) {
  fail++; console.log(`  FAIL the suite ran: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
  try { fs.rmSync(process.env.HIVE_HOME, { recursive: true, force: true }) } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
