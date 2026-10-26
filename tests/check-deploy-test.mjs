// Tests for scripts/check-deploy.mjs
//
//   node tests/check-deploy-test.mjs
//
// Verifies:
//   1. Vacuity guard (empty STATIC map or missing /control entry -> exit 1, "could not read the relay's served files")
//   2. Untracked STATIC file (e.g. hive-time.js via git rm --cached) -> exit 1, "THE RELAY WOULD SERVE WRONG OR BROKEN FILES",
//      "the relay would boot, but /control's import of /hive-time.js would get the relay's 'is up' text: the control room breaks"
//   3. Untracked public STATIC target (e.g. public/control.html) -> exit 1
//   4. Green when all imports and STATIC files are committed -> exit 0, "=== DEPLOY OK ==="
//   5. Untracked imported file -> exit 1, "=== THE RELAY WOULD NOT BOOT FROM A FRESH CLONE ==="
//   6. Non-git directory -> exit 0 with skip message

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deploy-test-'))
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.email "test@hivecode.dev"', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' })

  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true })

  fs.copyFileSync(path.join(ROOT, 'scripts', 'check-deploy.mjs'), path.join(dir, 'scripts', 'check-deploy.mjs'))
  fs.copyFileSync(path.join(ROOT, 'relay-static.js'), path.join(dir, 'relay-static.js'))

  fs.writeFileSync(path.join(dir, 'server.js'), `
import { STATIC, staticFile } from './relay-static.js'
export const s = 1
`)
  fs.writeFileSync(path.join(dir, 'hive-time.js'), `export function ago() { return '1h' }\n`)
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), `<!DOCTYPE html><html><body>index</body></html>\n`)
  fs.writeFileSync(path.join(dir, 'public', 'control.html'), `<!DOCTYPE html><html><body>control</body></html>\n`)
  fs.writeFileSync(path.join(dir, 'public', 'map.html'), `<!DOCTYPE html><html><body>map</body></html>\n`)
  fs.writeFileSync(path.join(dir, 'public', 'recover.html'), `<!DOCTYPE html><html><body>recover</body></html>\n`)
  fs.writeFileSync(path.join(dir, 'public', 'app.js'), `console.log('app')\n`)
  fs.writeFileSync(path.join(dir, 'public', 'hive-crdt.js'), `console.log('crdt')\n`)
  fs.writeFileSync(path.join(dir, 'public', 'favicon.ico'), `ico\n`)
  fs.writeFileSync(path.join(dir, 'public', 'favicon-32.png'), `png\n`)
  fs.writeFileSync(path.join(dir, 'public', 'apple-touch-icon.png'), `png\n`)
  fs.writeFileSync(path.join(dir, 'public', 'mark-64.png'), `png\n`)
  fs.writeFileSync(path.join(dir, 'public', 'mark.jpg'), `jpg\n`)
  fs.writeFileSync(path.join(dir, 'public', 'mark-wide.jpg'), `jpg\n`)
  fs.writeFileSync(path.join(dir, 'public', 'hivecode-logo.png'), `png\n`)
  fs.writeFileSync(path.join(dir, 'public', 'hivecode-icr-demo.mp4'), `mp4\n`)
  fs.writeFileSync(path.join(dir, 'public', 'Hivecode___ICR.mp4'), `mp4\n`)

  return dir
}

function runCheck(dir) {
  const res = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-deploy.mjs')], {
    cwd: dir,
    encoding: 'utf8'
  })
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || ''
  }
}

// 1. Vacuity guard: empty STATIC map
{
  const dir = makeTempRepo()
  fs.writeFileSync(path.join(dir, 'relay-static.js'), `
export const STATIC = {}
export function staticFile(t) { return t }
`)
  const r = runCheck(dir)
  T('vacuity guard: exits 1 when STATIC map is empty', r.code === 1, `exit ${r.code}`)
  T('vacuity guard: message says "could not read the relay\'s served files"', r.stderr.includes("could not read the relay's served files"))
  fs.rmSync(dir, { recursive: true, force: true })
}

// 1b. Vacuity guard: missing /control entry
{
  const dir = makeTempRepo()
  fs.writeFileSync(path.join(dir, 'relay-static.js'), `
export const STATIC = { '/': 'index.html' }
export function staticFile(t) { return t }
`)
  const r = runCheck(dir)
  T('vacuity guard: exits 1 when /control is missing', r.code === 1, `exit ${r.code}`)
  T('vacuity guard: message says "could not read the relay\'s served files"', r.stderr.includes("could not read the relay's served files"))
  fs.rmSync(dir, { recursive: true, force: true })
}

// 2. Green initial state
{
  const dir = makeTempRepo()
  execSync('git add . && git commit -m "initial"', { cwd: dir, stdio: 'ignore' })
  const r0 = runCheck(dir)
  T('green when all imports and STATIC files are committed', r0.code === 0 && r0.stdout.includes('=== DEPLOY OK'), `exit ${r0.code}`)

  // 3. RED PROOF: untrack hive-time.js with git rm --cached
  execSync('git rm --cached hive-time.js', { cwd: dir, stdio: 'ignore' })
  const r1 = runCheck(dir)
  T('RED PROOF: exits 1 when hive-time.js is untracked', r1.code === 1, `exit ${r1.code}`)
  T('RED PROOF: output reports missing STATIC target in relay-static.js', r1.stderr.includes('hive-time.js') && r1.stderr.includes('STATIC target'))
  T('RED PROOF: output names broken control room contract', r1.stderr.includes("/hive-time.js would get the relay's 'is up' text instead of hive-time.js: the control room breaks"))
  T('RED PROOF: suggests git add hive-time.js', r1.stderr.includes('git add hive-time.js'))

  // Re-add hive-time.js and verify green again
  execSync('git add hive-time.js', { cwd: dir, stdio: 'ignore' })
  const r2 = runCheck(dir)
  T('returns green after re-adding hive-time.js', r2.code === 0, `exit ${r2.code}`)

  // 4. RED PROOF: untrack public/control.html
  execSync('git rm --cached public/control.html', { cwd: dir, stdio: 'ignore' })
  const r3 = runCheck(dir)
  T('RED PROOF: exits 1 when public/control.html is untracked', r3.code === 1, `exit ${r3.code}`)
  T('RED PROOF: output lists public/control.html', r3.stderr.includes('public/control.html'))
  T('RED PROOF: control.html mentions control room breaks', r3.stderr.includes("/control would get the relay's 'is up' text instead of public/control.html: the control room breaks"))

  // 4b. RED PROOF: untrack public/favicon.ico -> exits 1, does NOT mention control room
  execSync('git add public/control.html', { cwd: dir, stdio: 'ignore' })
  execSync('git rm --cached public/favicon.ico', { cwd: dir, stdio: 'ignore' })
  const rFavicon = runCheck(dir)
  T('RED PROOF: exits 1 when public/favicon.ico is untracked', rFavicon.code === 1, `exit ${rFavicon.code}`)
  T('RED PROOF: favicon output says /favicon.ico would get "is up" text', rFavicon.stderr.includes("/favicon.ico would get the relay's 'is up' text instead of public/favicon.ico"))
  T('RED PROOF: untracked favicon does NOT mention control room', !rFavicon.stderr.includes('control room breaks'))

  fs.rmSync(dir, { recursive: true, force: true })
}

// 5. Untracked relative JS import
{
  const dir = makeTempRepo()
  execSync('git add . && git commit -m "initial"', { cwd: dir, stdio: 'ignore' })
  fs.writeFileSync(path.join(dir, 'untracked-helper.js'), `export const h = 1\n`)
  fs.writeFileSync(path.join(dir, 'server.js'), `
import { STATIC, staticFile } from './relay-static.js'
import './untracked-helper.js'
export const s = 1
`)
  // server.js is modified, untracked-helper is untracked
  const r = runCheck(dir)
  T('exits 1 when imported JS file is untracked', r.code === 1, `exit ${r.code}`)
  T('output says "THE RELAY WOULD NOT BOOT FROM A FRESH CLONE"', r.stderr.includes('THE RELAY WOULD NOT BOOT FROM A FRESH CLONE'))
  T('output names untracked import and importer', r.stderr.includes('untracked-helper.js') && r.stderr.includes('imported by server.js'))

  fs.rmSync(dir, { recursive: true, force: true })
}

// 6. Non-git directory
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deploy-nogit-'))
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts', 'check-deploy.mjs'), path.join(dir, 'scripts', 'check-deploy.mjs'))
  fs.copyFileSync(path.join(ROOT, 'relay-static.js'), path.join(dir, 'relay-static.js'))
  fs.writeFileSync(path.join(dir, 'server.js'), `export const s = 1\n`)

  const r = runCheck(dir)
  T('exits 0 with skip message in non-git directory', r.code === 0, `exit ${r.code}`)
  T('stdout contains skip notice', r.stdout.includes('skipped: working copy is not its own git repository checkout'))

  fs.rmSync(dir, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`)
  process.exit(1)
}

console.log('\nall passed')
