// CRLF SWEEP TEST (tests/crlf-sweep-test.mjs)
// Verifies CRLF resilience across hive-branch.js, hive-land.js, and hive-pr.js.
//
//   node tests/crlf-sweep-test.mjs

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { pathToFileURL } from 'url'
import { contentHash } from '../substrate.js'

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-crlf-sweep-'))
const PORT = 32890
const RELAY = `ws://localhost:${PORT}`

let pass = 0, fail = 0
const T = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `   ${extra}` : ''}`)
  ok ? pass++ : fail++
}

function g(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function repo(dir, files) {
  fs.mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.email', 'dev@example.com')
  g(dir, 'config', 'user.name', 'Dev')
  g(dir, 'config', 'core.autocrlf', 'false')
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
  }
  g(dir, 'add', '-A')
  g(dir, 'commit', '-qm', 'init')
}

function startRelay() {
  return new Promise((res) => {
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
    p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  })
}

console.log('\n# CRLF SWEEP: hive-branch.js, hive-land.js, hive-pr.js')

// ─── Test 1: hive-land.js linkDependencies with CRLF lockfile on disk ─────────
const HL = await import(pathToFileURL(path.join(ROOT, 'hive-land.js')).href)
const landDir = path.join(tmp, 'land-repo')
repo(landDir, {
  'package-lock.json': '{\n  "name": "app",\n  "lockfileVersion": 3\n}\n',
  'node_modules/foo/index.js': 'module.exports = 1;\n'
})
const landSha = g(landDir, 'rev-parse', 'HEAD').out
// Windows checkout converts package-lock.json to CRLF
fs.writeFileSync(path.join(landDir, 'package-lock.json'), '{\r\n  "name": "app",\r\n  "lockfileVersion": 3\r\n}\r\n')
const targetDir = path.join(tmp, 'land-target')
fs.mkdirSync(targetDir, { recursive: true })
const resNotes = { notes: [] }
const linked = HL.linkDependencies(landDir, targetDir, landSha, resNotes)
T('1. hive-land linkDependencies links node_modules when lockfile on disk has CRLF',
  linked !== '' && fs.existsSync(path.join(targetDir, 'node_modules', 'foo', 'index.js')),
  `linked="${linked}" notes=${JSON.stringify(resNotes.notes)}`
)

// ─── Test 2: hive-pr.js plan-json hashes normalize CRLF to LF ─────────────────
const prM = await import(pathToFileURL(path.join(ROOT, 'hive-pr.js')).href)
// Create a file with CRLF on disk
const crlfFile = path.join(tmp, 'crlf-sample.txt')
fs.writeFileSync(crlfFile, 'line1\r\nline2\r\n', 'utf8')
const expectedHash = contentHash('line1\nline2\n')
// Check plan hash calculation: should be LF-normalized
const computedHash = prM.hashFile ? prM.hashFile(crlfFile) : null
T('2. hive-pr plan-json contentHash matches LF room hash on CRLF disk file',
  computedHash === expectedHash,
  `computed=${computedHash} expected=${expectedHash}`
)

// ─── Test 3: hive-branch.js seedRoom with CRLF repository ─────────────────────
const relayProc = await startRelay()
try {
  const HB = await import(pathToFileURL(path.join(ROOT, 'hive-branch.js')).href)
  const branchDir = path.join(tmp, 'branch-repo')
  repo(branchDir, {
    'app.js': 'function main() {\r\n  console.log("hello");\r\n}\r\n',
    'README.md': '# Title\r\n\r\nBody text\r\n'
  })

  const out = []
  const t0 = Date.now()
  const code = await HB.main(['branch', 'feat-crlf', '--relay', RELAY], {
    cwd: branchDir,
    log: (s) => out.push(String(s)),
    logErr: (s) => out.push(String(s))
  })
  const elapsed = Date.now() - t0
  const outText = out.join('\n')
  T('3. hive-branch seedRoom succeeds promptly on CRLF repo without Q565/Q566',
    code === 0 && elapsed < 15000 && /Room ready for branch feat-crlf/.test(outText),
    `code=${code} elapsed=${elapsed}ms out=${outText.slice(0, 150).replace(/\n/g, ' ')}`
  )
} finally {
  relayProc.kill()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n=== CRLF SWEEP: ${pass} passed, ${fail} failed ===\n`)
process.exit(fail ? 1 : 0)
