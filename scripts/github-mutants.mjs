// Each defence in hive-github.js and hive-notify.js, removed one at a time: the module's test has to
// go red where that defence's row is, or the check that claims to cover it covers nothing.
//
//   node scripts/github-mutants.mjs [id ...]
//
// A mutant is a changed COPY beside the real file (<module>.mutant-<id>.js, deleted afterwards), so
// the real module is never edited and a crashed run leaves nothing behind but that copy.
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const TARGETS = {
  github: { file: 'hive-github.js', test: 'tests/github-watcher-test.mjs', env: 'HIVE_GITHUB_MODULE' },
  notify: { file: 'hive-notify.js', test: 'tests/notify-test.mjs', env: 'HIVE_NOTIFY_MODULE' },
  // The same module as `github`, under its fast CLI test: what `github start` refuses, and the dry run.
  cli: { file: 'hive-github.js', test: 'tests/github-cli-test.mjs', env: 'HIVE_GITHUB_MODULE' },
}
const SRC = Object.fromEntries(Object.entries(TARGETS).map(([k, t]) => [k, fs.readFileSync(path.join(ROOT, t.file), 'utf8')]))

const MUTANTS = [
  // hive-github.js
  { t: 'github', id: 'trust', expect: 'E5', find: "const trusted = (item) => !!item && !isBot(item.user) && ASSOC.has(String(item.author_association || '').toUpperCase()) && canPush(item.user.login)", to: 'const trusted = (item) => !!item' },
  { t: 'github', id: 'labeler', expect: 'B1', find: 'if (lab.bot || !canPush(lab.login)) {', to: 'if (false) {' },
  { t: 'github', id: 'failed-read', expect: 'K2', find: 'const issue = gh.issue(n) // a failure here throws: nothing changes on a failed read', to: 'let issue; try { issue = gh.issue(n) } catch { return stop(n, it, `the ${label} label was removed`, \'label\') }' },
  { t: 'github', id: 'same-failure', expect: 'C6', find: 'if (it.sameFailure >= 2) return needsHuman', to: 'if (false) return needsHuman' },
  { t: 'github', id: 'workflows', expect: 'H1', find: 'const workflows = allowWorkflows ? [] : changed.filter', to: 'const workflows = true ? [] : changed.filter' },
  { t: 'github', id: 'flush', expect: 'M1', find: '    await flushFolder(run)\n', to: '\n' },
  { t: 'github', id: 'debounce', expect: 'E1', find: 'if (!it.settle || it.settle.sig !== sig) { it.settle = { sig, at: now() }; return result }\n    if (now() - it.settle.at < quietMs) return result\n', to: '' },
  { t: 'github', id: 'sleep', expect: 'J2', find: 'if (lastTick && t - lastTick > gapLimit) {', to: 'if (false) {' },
  { t: 'github', id: 'merge-first', expect: 'D4', find: "      if (it.pr) {\n        const pr = gh.pull(it.pr)\n        if (pr.merged_at || pr.merged) return finalize(n, it, 'done')\n        if (pr.state === 'closed') return finalize(n, it, 'closed')\n      }\n", to: '' },
  { t: 'github', id: 'merge-kills', expect: 'S2', find: 'function finalize(n, it, outcome) {\n    killRun(n)\n', to: 'function finalize(n, it, outcome) {\n' },
  { t: 'github', id: 'adopt', expect: 'N3', find: '          if (found) {\n', to: '          if (false) {\n' },
  { t: 'github', id: 'never-joined', expect: 'G1', find: "if (run.dir && !fs.existsSync(path.join(run.dir, '.hive.json'))) {", to: 'if (false) {' },
  { t: 'github', id: 'ask', expect: 'E4', find: "return key === 'ic' && it.question ? body : ''", to: 'return body' },
  { t: 'github', id: 'check-first', expect: 'P1', find: "if (role === 'builder' && tester) {", to: 'if (false) {' },
  { t: 'github', id: 'fail-holds', expect: 'P3', find: "if (out.verdict === 'FAIL') {", to: 'if (false) {' },
  { t: 'github', id: 'no-verdict', expect: 'P10', find: "const noVerdict = role === 'tester' && !out.blocked && !out.verdict", to: 'const noVerdict = false' },
  { t: 'github', id: 'restart-fresh', expect: 'R5', find: 'if (before.length && !(it.restart && before[0].watcher === me)) {', to: 'if (before.length) {' },
  { t: 'github', id: 'done-signal', expect: 'R6', find: 'if (it.closedAtDone || readComments(n, it).retry) {', to: 'if (true) {' },
  { t: 'github', id: 'closed-is-no', expect: 'R1', find: 'if (readComments(n, it).retry) { delete state.issues[n]; consider(labeled) }', to: '{ delete state.issues[n]; consider(labeled) }' },
  { t: 'github', id: 'login-once', expect: 'R4', find: "if (e.code === 'Q600' && !loginLost) {", to: "if (e.code === 'Q600') {" },
  { t: 'github', id: 'catch-up', expect: 'Q1', find: 'if (pr.mergeable === false && sha && it.conflictTried !== sha) {', to: 'if (false) {' },
  { t: 'github', id: 'report-first', expect: 'P12', find: "        it.next = 'build'\n        if (it.testerFails >= maxTesterFails)", to: '        if (it.testerFails >= maxTesterFails)' },
  // hive-github.js, under the CLI test
  { t: 'cli', id: 'dry-saves', expect: 'CD4', find: 'const save = () => { if (!dry) saveState(file, state) }', to: 'const save = () => { saveState(file, state) }' },
  { t: 'cli', id: 'dry-runs', expect: 'CD3', find: '    if (dry) {\n      // Said in the order they would start', to: '    if (false) {\n      // Said in the order they would start' },
  // The dry run as first written: a fresh state, so "would start now" whatever the file knew.
  { t: 'cli', id: 'dry-fresh', expect: 'CD5', find: 'const state = loadState(file, log, { peek: dry })', to: 'const state = dry ? freshState() : loadState(file, log)' },
  { t: 'cli', id: 'dry-peek', expect: 'CD11', find: 'const state = loadState(file, log, { peek: dry })', to: 'const state = loadState(file, log)' },
  { t: 'cli', id: 'dry-known', expect: 'CD5', find: '      if (dry) return await dryPlan(labeled, byNum)\n', to: '' },
  { t: 'cli', id: 'dry-claims', expect: 'CD6', find: 'const first = claimsOn(n)[0]', to: 'const first = null' },
  { t: 'cli', id: 'dry-cap', expect: 'CD7', find: 'if (left <= 0) {', to: 'if (false) {' },
  { t: 'cli', id: 'dry-cutoff', expect: 'CD8', find: "if (it.status === 'running' && !live && byNum.has(n)) {", to: 'if (false) {' },
  { t: 'cli', id: 'dry-live', expect: 'CD10', find: 'if (live) log(`A watcher is running on this clone now', to: 'if (false) log(`A watcher is running on this clone now' },
  { t: 'cli', id: 'dry-failed', expect: 'CD12', find: 'if (!res || !res.ok) {', to: 'if (false) {' },
  { t: 'cli', id: 'status-peek', expect: 'CT3', find: 'const s = loadState(file, log, { peek: true })', to: 'const s = loadState(file, log)' },
  { t: 'cli', id: 'q606-said', expect: 'CS9', find: 'const state = loadState(file, log)\n', to: 'const state = loadState(file)\n' },
  // hive-notify.js
  { t: 'notify', id: 'owner-here', expect: 'NT6', find: 'if (sent.tasks[task.id] || here(owner)) continue', to: 'if (sent.tasks[task.id]) continue' },
  { t: 'notify', id: 'sent-once', expect: 'NT8', find: 'if (sent.tasks[task.id] || here(owner)) continue', to: 'if (here(owner)) continue' },
  { t: 'notify', id: 'agents-only', expect: 'NT12', find: "if (!m || m.kind !== 'ai') continue", to: 'if (!m) continue' },
  { t: 'notify', id: 'hello', expect: 'NT1', find: 'if (!okSent) {', to: 'if (false) {' },
  { t: 'notify', id: 'batch', expect: 'NT10', find: 'if (buffer.length && t - lastFlush >= every * 60000) {', to: 'if (buffer.length) {' },
  { t: 'notify', id: 'whole-name', expect: 'NT12', find: '(?![\\\\w-])', to: '' },
  { t: 'notify', id: 'lost-once', expect: 'NT14', find: 'if (!toldLost && t - lostSince >= LOST_AFTER) {', to: 'if (t - lostSince >= LOST_AFTER) {' },
]

// --check: only that each mutant's text is in its file exactly once (a second, after an edit, would
// mutate the wrong place). Takes a second, so run it after every change to the modules.
const checkOnly = process.argv.includes('--check')
const pick = process.argv.slice(2).filter((a) => a !== '--check')
const todo = MUTANTS.filter((m) => !pick.length || pick.includes(m.id) || pick.includes(m.t))
let bad = 0
for (const m of todo) {
  const count = SRC[m.t].split(m.find).length - 1
  if (count !== 1) { console.log(`BAD MUTANT ${m.id}: its text occurs ${count} times in ${TARGETS[m.t].file}`); bad++ }
}
if (bad) process.exit(2)
if (checkOnly) { console.log(`all ${todo.length} mutants apply exactly once`); process.exit(0) }

function run(m) {
  const T = TARGETS[m.t]
  const file = `${T.file.replace(/\.js$/, '')}.mutant-${m.id}.js`
  fs.writeFileSync(path.join(ROOT, file), SRC[m.t].replace(m.find, m.to))
  return new Promise((res) => {
    const p = spawn(process.execPath, [T.test], { cwd: ROOT, env: { ...process.env, [T.env]: file } })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.on('close', () => {
      try { fs.unlinkSync(path.join(ROOT, file)) } catch { }
      const red = [...out.matchAll(/^\s+FAIL (\S+)/gm)].map((x) => x[1])
      res({ ...m, red, caught: red.includes(m.expect) })
    })
  })
}

const width = Number(process.env.MUTANT_PARALLEL || 4)
const results = []
for (let i = 0; i < todo.length; i += width) results.push(...await Promise.all(todo.slice(i, i + width).map(run)))
for (const r of results) console.log(`${r.caught ? 'caught ' : 'MISSED '} ${`${r.t}/${r.id}`.padEnd(20)} expected ${r.expect} red; red: ${r.red.join(', ') || 'none'}`)
const missed = results.filter((r) => !r.caught)
console.log(missed.length ? `\n${missed.length} mutant(s) survived` : `\nall ${results.length} mutants caught`)
process.exit(missed.length ? 1 : 0)
