// GIT END-TO-END — the exact flow a real developer gets, with real git:
// a repo, branches, `git merge`, the driver wired via .gitattributes.
// Each scenario runs TWICE — vanilla git vs git+ICR — so the delta is proven,
// not assumed:
//   S1 rename + new call sites  (vanilla: broken or conflict; ICR: clean + rewritten)
//   S2 same function, different lines  (vanilla: conflict wall; ICR: clean)
//   S3 delete a still-used helper  (vanilla: merges CLEAN but BROKEN; ICR: surfaces it)
import fs from 'fs'; import os from 'os'; import path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DRIVER = path.join(HERE, '..', 'bin', 'icr-merge-driver.js').replace(/\\/g, '/')
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

function repo(useICR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icr-git-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString()
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T')
  git('config', 'merge.conflictstyle', 'merge')
  if (useICR) {
    git('config', 'merge.icr.name', 'ICR intent-aware merge')
    git('config', 'merge.icr.driver', `node "${DRIVER}" %O %A %B %P`)
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.js merge=icr\n')
    git('add', '.gitattributes'); git('commit', '-qm', 'attrs')
  }
  const write = (f, c) => fs.writeFileSync(path.join(dir, f), c)
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8')
  const merge = (branch) => { try { git('merge', '-q', '--no-edit', branch); return { ok: true } } catch (e) { return { ok: false, out: (e.stdout || '').toString() + (e.stderr || '').toString() } } }
  return { dir, git, write, read, merge }
}
const markers = (t) => /^<{7} /m.test(t)

// ---------- S1: rename + new call sites ----------
function s1(useICR) {
  const r = repo(useICR)
  r.write('app.js', 'function helper() { return 1 }\n\nfunction main() { return helper() }\n')
  r.git('add', '.'); r.git('commit', '-qm', 'base')
  r.git('checkout', '-qb', 'rename')
  r.write('app.js', 'function fetchData() { return 1 }\n\nfunction main() { return fetchData() }\n')
  r.git('commit', '-aqm', 'rename helper->fetchData')
  r.git('checkout', '-q', 'main')
  r.write('app.js', 'function helper() { return 1 }\n\nfunction main() { return helper() }\n\nfunction extra() { return helper() + 1 }\n')
  r.git('commit', '-aqm', 'add extra() calling helper')
  const m = r.merge('rename')
  const out = r.read('app.js')
  return { merged: m.ok, text: out, hasMarkers: markers(out), broken: /helper\(\)/.test(out) && !/function helper/.test(out), rewritten: /extra\(\) ?{ return fetchData\(\) \+ 1 }|return fetchData\(\) \+ 1/.test(out) }
}
{
  const v = s1(false), i = s1(true)
  console.log('\n# S1 rename + new call sites')
  console.log(`  vanilla: merged=${v.merged} markers=${v.hasMarkers} SILENTLY-BROKEN=${v.merged && !v.hasMarkers && v.broken}`)
  T('ICR: git merge succeeds clean', i.merged && !i.hasMarkers)
  T('ICR: new call site REWRITTEN to fetchData', i.rewritten && !/\bhelper\b/.test(i.text))
  T('ICR beats vanilla here', (i.merged && i.rewritten) && !(v.merged && v.rewritten && !v.broken))
}

// ---------- S2: same function, different lines ----------
function s2(useICR) {
  const r = repo(useICR)
  const base = 'function calc() {\n  const a = 1\n  const b = 2\n  const c = 3\n  return a + b + c\n}\n'
  r.write('calc.js', base); r.git('add', '.'); r.git('commit', '-qm', 'base')
  r.git('checkout', '-qb', 'top'); r.write('calc.js', base.replace('const a = 1', 'const a = 100')); r.git('commit', '-aqm', 'top edit')
  r.git('checkout', '-q', 'main'); r.write('calc.js', base.replace('const c = 3', 'const c = 300')); r.git('commit', '-aqm', 'bottom edit')
  const m = r.merge('top')
  const out = r.read('calc.js')
  return { merged: m.ok, hasMarkers: markers(out), both: out.includes('a = 100') && out.includes('c = 300') }
}
{
  const v = s2(false), i = s2(true)
  console.log('\n# S2 same function, different lines (the false-conflict rebase pain)')
  console.log(`  vanilla: merged=${v.merged} markers=${v.hasMarkers} both-kept=${v.both}`)
  T('ICR: merges clean, both edits kept', i.merged && !i.hasMarkers && i.both)
}

// ---------- S3: delete a helper someone still uses ----------
function s3(useICR) {
  const r = repo(useICR)
  const base = 'function unused() { return 9 }\n\nfunction main() { return 1 }\n'
  r.write('lib.js', base); r.git('add', '.'); r.git('commit', '-qm', 'base')
  r.git('checkout', '-qb', 'cleanup'); r.write('lib.js', 'function main() { return 1 }\n'); r.git('commit', '-aqm', 'delete unused')
  r.git('checkout', '-q', 'main'); r.write('lib.js', base + '\nfunction feature() { return unused() * 2 }\n'); r.git('commit', '-aqm', 'use it')
  const m = r.merge('cleanup')
  const out = r.read('lib.js')
  const broken = /unused\(\)/.test(out.replace(/function unused/, '')) && !/function unused/.test(out)
  return { merged: m.ok, hasMarkers: markers(out), broken, out: m.out || '' }
}
{
  const v = s3(false), i = s3(true)
  console.log('\n# S3 delete a still-used helper (the silent bad merge)')
  console.log(`  vanilla: merged=${v.merged} markers=${v.hasMarkers} SHIPS-BROKEN-CODE=${v.merged && !v.hasMarkers && v.broken}`)
  T('vanilla git really does ship the broken merge silently (the pain is real)', v.merged && !v.hasMarkers && v.broken)
  T('ICR: refuses to ship it silently (conflict surfaced)', !i.merged)
  T('ICR: both versions preserved for the human', i.hasMarkers)
}

// ---------- S4: the installer registers a command npx can actually resolve ----------
// (dogfood catch: bare `npx icr-merge-driver` 404s — the bin lives inside `icr-merge`,
// so the registered command MUST carry `--package icr-merge`.)
{
  console.log('\n# S4 installer registers a resolvable driver command')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icr-inst-'))
  execFileSync('git', ['init', '-q', dir], { stdio: 'pipe' })
  execFileSync(process.execPath, [path.join(HERE, '..', 'bin', 'icr-merge-install.js')], { cwd: dir, stdio: 'pipe' })
  const drv = execFileSync('git', ['config', '--get', 'merge.icr.driver'], { cwd: dir }).toString().trim()
  T('registered command uses --package icr-merge', /--package icr-merge\b/.test(drv) && /icr-merge-driver/.test(drv))
}

console.log(`\n=== GIT-E2E: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
