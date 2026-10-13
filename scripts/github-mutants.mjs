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
  { t: 'github', id: 'adopt', expect: 'N3', find: '          if (found) {', to: '          if (false) {' },
  { t: 'github', id: 'never-joined', expect: 'G1', find: "if (run.dir && !fs.existsSync(path.join(run.dir, '.hive.json'))) {", to: 'if (false) {' },
  { t: 'github', id: 'ask', expect: 'E4', find: "return key === 'ic' && it.question ? body : ''", to: 'return body' },
  // hive-notify.js
  { t: 'notify', id: 'owner-here', expect: 'NT6', find: 'if (sent.tasks[task.id] || here(owner)) continue', to: 'if (sent.tasks[task.id]) continue' },
  { t: 'notify', id: 'sent-once', expect: 'NT8', find: 'if (sent.tasks[task.id] || here(owner)) continue', to: 'if (here(owner)) continue' },
  { t: 'notify', id: 'agents-only', expect: 'NT12', find: "if (!m || m.kind !== 'ai') continue", to: 'if (!m) continue' },
  { t: 'notify', id: 'hello', expect: 'NT1', find: 'if (!okSent) {', to: 'if (false) {' },
  { t: 'notify', id: 'batch', expect: 'NT10', find: 'if (buffer.length && t - lastFlush >= every * 60000) {', to: 'if (buffer.length) {' },
  { t: 'notify', id: 'whole-name', expect: 'NT12', find: '(?![\\\\w-])', to: '' },
  { t: 'notify', id: 'lost-once', expect: 'NT14', find: 'if (!toldLost && t - lostSince >= LOST_AFTER) {', to: 'if (t - lostSince >= LOST_AFTER) {' },
]

const pick = process.argv.slice(2)
const todo = MUTANTS.filter((m) => !pick.length || pick.includes(m.id) || pick.includes(m.t))
for (const m of todo) {
  const count = SRC[m.t].split(m.find).length - 1
  if (count !== 1) { console.log(`BAD MUTANT ${m.id}: its text occurs ${count} times in ${TARGETS[m.t].file}`); process.exit(2) }
}

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
