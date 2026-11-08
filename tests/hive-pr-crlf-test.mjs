// Adversarial test: hive_pr against repositories with deliberate CRLF files or .gitattributes
// Checks:
// 1. Repo committing CRLF (*.bat -text): pr must not turn CRLF into LF or report false changes on untouched lines
// 2. Repo with eol=crlf in .gitattributes: pr must not write LF into files kept as CRLF on disk
// 3. Untouched CRLF files must remain identical and untouched
// 4. CRLF working tree over an LF blob (core.autocrlf=false): pr must not convert LF blob to CRLF or report false diffs
// 5. Mixed-endings file in repo: pr must not rewrite line endings of untouched lines

import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
function T(name, ok, extra) {
  if (ok) {
    pass++
    console.log(`  ok   ${name}${extra !== undefined ? `   ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra !== undefined ? `   ${extra}` : ''}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-crlf-repo-'))
const REPO = path.join(tmp, 'repo')
fs.mkdirSync(REPO)

const git = (args, cwd = REPO) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const PORT = 41000 + Math.floor(Math.random() * 8000)
const RELAY = `ws://127.0.0.1:${PORT}`
const ROOM = 'pr-crlf-' + process.pid + '-' + Date.now()

let relay = null
let syncA = null

try {
  // 1. Initialize fixture repo with CRLF requirements
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@hivecode.local'])
  git(['config', 'user.name', 'Test'])
  git(['config', 'core.autocrlf', 'false'])

  fs.writeFileSync(path.join(REPO, '.gitattributes'), '*.cmd text eol=crlf\n*.bat -text\n', 'utf8')
  fs.writeFileSync(path.join(REPO, 'build.bat'), '@echo off\r\necho step 1\r\necho step 2\r\n', 'utf8')
  fs.writeFileSync(path.join(REPO, 'tool.cmd'), '@echo off\r\necho tool a\r\necho tool b\r\n', 'utf8')
  fs.writeFileSync(path.join(REPO, 'seed.bat'), '@echo off\r\necho unchanged\r\n', 'utf8')
  fs.writeFileSync(path.join(REPO, 'lf-blob.js'), 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')
  fs.writeFileSync(path.join(REPO, 'mixed.txt'), 'line 1\r\nline 2\nline 3\r\n', 'utf8')

  git(['add', '.'])
  git(['commit', '-qm', 'initial crlf repo'])
  T('fixture repo initialized with CRLF and mixed files', git(['rev-parse', 'HEAD']).status === 0)

  // Verify initial git blobs
  const buildSha = git(['rev-parse', 'HEAD:build.bat']).stdout.trim()
  const buildRaw = spawnSync('git', ['cat-file', 'blob', buildSha], { cwd: REPO }).stdout
  T('initial build.bat git blob has CRLF', buildRaw.includes('\r\n'))

  const lfSha = git(['rev-parse', 'HEAD:lf-blob.js']).stdout.trim()
  const lfRaw = spawnSync('git', ['cat-file', 'blob', lfSha], { cwd: REPO }).stdout
  T('initial lf-blob.js git blob is pure LF', !lfRaw.includes('\r\n'))

  // Now simulate Windows working tree having CRLF in lf-blob.js (editor save or checkout)
  fs.writeFileSync(path.join(REPO, 'lf-blob.js'), 'const a = 1\r\nconst b = 2\r\nconst c = 3\r\n', 'utf8')

  // 2. Start relay
  relay = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay timeout')), 15000)
    relay.stdout.on('data', d => { if (String(d).includes('listening on')) { clearTimeout(t); res() } })
  })
  T('relay started', Boolean(relay))

  // 3. Start agent sync folder
  process.env.HIVE_PROVENANCE = 'on'
  const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
  const dirA = path.join(tmp, 'agentA')
  fs.mkdirSync(dirA)

  // Seed agentA with repo files
  for (const f of ['build.bat', 'tool.cmd', 'seed.bat', 'lf-blob.js', 'mixed.txt']) {
    fs.copyFileSync(path.join(REPO, f), path.join(dirA, f))
  }

  syncA = startSync({
    relay: RELAY,
    room: ROOM,
    dir: dirA,
    name: 'AgentA',
    kind: 'ai',
    syncFiles: true
  })

  await new Promise(r => setTimeout(r, 2000))

  // 4. AgentA modifies:
  // - build.bat (line 2 only)
  // - tool.cmd (line 2 only)
  // - lf-blob.js (line 2 only: b = 20)
  // - mixed.txt (line 1 only: line 1 MODIFIED)
  // seed.bat is left untouched
  fs.writeFileSync(path.join(dirA, 'build.bat'), '@echo off\r\necho step 1 MODIFIED\r\necho step 2\r\n', 'utf8')
  fs.writeFileSync(path.join(dirA, 'tool.cmd'), '@echo off\r\necho tool a MODIFIED\r\necho tool b\r\n', 'utf8')
  fs.writeFileSync(path.join(dirA, 'lf-blob.js'), 'const a = 1\nconst b = 20\nconst c = 3\n', 'utf8')
  fs.writeFileSync(path.join(dirA, 'mixed.txt'), 'line 1 MODIFIED\r\nline 2\nline 3\r\n', 'utf8')

  await new Promise(r => setTimeout(r, 3000))
  T('receipts recorded for modified files', (syncA.provenanceOf('build.bat') || []).length > 0)

  // 5. Run hive-pr.js
  const prProc = spawnSync(process.execPath, [
    path.join(ROOT, 'hive-pr.js'),
    `${RELAY}|${ROOM}`,
    'PRAgent',
    '--repo', REPO,
    '--branch', 'hivecode/crlf-branch'
  ], { encoding: 'utf8' })

  T('hive-pr exited cleanly', prProc.status === 0, prProc.status !== 0 ? prProc.stderr : '')

  // 6. Check results on the created branch
  // Check A: seed.bat (untouched CRLF file)
  const diffSeed = git(['diff', 'main..hivecode/crlf-branch', '--', 'seed.bat']).stdout
  T('untouched CRLF file seed.bat produces zero diff', diffSeed.trim() === '')

  // Check B: build.bat (repo commits CRLF via -text)
  const branchBuildSha = git(['rev-parse', 'hivecode/crlf-branch:build.bat']).stdout.trim()
  const branchBuildRaw = spawnSync('git', ['cat-file', 'blob', branchBuildSha], { cwd: REPO }).stdout
  T('build.bat on branch still commits CRLF blob', branchBuildRaw.includes('\r\n'), `hasCRLF=${branchBuildRaw.includes('\r\n')}`)

  const diffBuild = git(['diff', 'main..hivecode/crlf-branch', '--', 'build.bat']).stdout
  const hasFalseChange = diffBuild.includes('-@echo off') || diffBuild.includes('-echo step 2')
  T('build.bat diff touches only line 2 (no false whole-file diff on untouched lines)', !hasFalseChange, diffBuild.trim())

  const diskBuild = fs.readFileSync(path.join(REPO, 'build.bat'), 'utf8')
  T('build.bat working tree file has CRLF', diskBuild.includes('\r\n'))

  // Check C: tool.cmd (repo requires eol=crlf on disk)
  const diskTool = fs.readFileSync(path.join(REPO, 'tool.cmd'), 'utf8')
  T('tool.cmd working tree file preserves CRLF on disk (*.cmd eol=crlf)', diskTool.includes('\r\n'))

  // Check D: lf-blob.js (CRLF in working tree over LF git blob on base)
  const branchLfSha = git(['rev-parse', 'hivecode/crlf-branch:lf-blob.js']).stdout.trim()
  const branchLfRaw = spawnSync('git', ['cat-file', 'blob', branchLfSha], { cwd: REPO }).stdout
  T('lf-blob.js on branch remains an LF blob despite CRLF working tree', !branchLfRaw.includes('\r\n'), `hasCRLF=${branchLfRaw.includes('\r\n')}`)

  const diffLf = git(['diff', 'main..hivecode/crlf-branch', '--', 'lf-blob.js']).stdout
  const lfFalseDiff = diffLf.includes('-const a = 1') || diffLf.includes('-const c = 3')
  T('lf-blob.js diff touches only line 2 (no false diff on untouched lines 1 & 3)', !lfFalseDiff, diffLf.trim())

  // Check E: mixed.txt (mixed endings in base)
  const diffMixed = git(['diff', 'main..hivecode/crlf-branch', '--', 'mixed.txt']).stdout
  const mixedFalseDiff = diffMixed.includes('-line 2') || diffMixed.includes('-line 3')
  T('mixed.txt diff touches only line 1 (no false diff on untouched line 2)', !mixedFalseDiff, diffMixed.trim())

} catch (err) {
  T('test completed without throwing', false, err.message)
} finally {
  if (syncA) syncA.stop()
  if (relay) relay.kill()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
