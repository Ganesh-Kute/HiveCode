// tests/room-start-cli-test.mjs -- `github start --branch <name>` one-step room mode start.
//
//   node tests/room-start-cli-test.mjs

import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const HG = await import(`file:///${ROOT.replace(/\\/g, '/')}/hive-github.js`)

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const PORT = await freePort()
const RELAY = `ws://localhost:${PORT}`

let pass = 0
let fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const g = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-roomstart-'))
process.env.GIT_CEILING_DIRECTORIES = tmp

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  g(dir, 'config', 'user.email', 'test@example.com')
  g(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n')
  g(dir, 'add', '-A')
  g(dir, 'commit', '-qm', 'initial')
  g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
  return dir
}

function fakeCall(answers = {}) {
  const calls = []
  const call = (method, apiPath, body) => {
    calls.push({ method, path: apiPath, body })
    const key = `${method} ${apiPath.split('?')[0]}`
    const a = answers[key]
    if (typeof a === 'function') return a(body)
    if (a) return a
    return { status: 404, headers: {}, body: { message: 'Not Found' }, text: '' }
  }
  return { call, calls }
}

const ok = (body, status = 200) => ({ status, headers: {}, body, text: JSON.stringify(body) })
const githubAnswers = {
  'GET user': ok({ login: 'owner' }),
  'GET repos/acme/app': ok({ default_branch: 'main', private: true, permissions: { push: true } }),
  'GET repos/acme/app/labels': ok([]),
  'POST repos/acme/app/labels': (b) => ok(b, 201),
  'GET repos/acme/app/issues': ok([]),
}

async function run(cwd, argv) {
  const out = []
  const code = await HG.main(argv, {
    cwd,
    call: fakeCall(githubAnswers).call,
    log: (s) => out.push(String(s)),
    logErr: (s) => out.push(String(s))
  })
  return { code, out: out.join('\n') }
}

console.log('\n# github start --branch <name>: one-step room mode start')

let relay = null
try {
  relay = await new Promise((res, rej) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
    p.on('error', rej)
    setTimeout(() => rej(new Error('relay timeout')), 5000)
  })

  const repo1 = makeRepo(path.join(tmp, 'r1'))

  // 1. Dry run refused
  {
    const r = await run(repo1, ['start', '--branch', 'fix-1', '--dry-run'])
    T('RS1 --branch with --dry-run refuses with Q602', r.code === 2 && /Q602.*--dry-run does not work with --room/.test(r.out), r.out)
  }

  // 2. Missing branch argument refused with Q602
  {
    const r = await run(repo1, ['start', '--branch'])
    T('RS2 missing branch argument refuses with Q602', r.code === 2 && /Q602 say which branch to watch/.test(r.out), r.out)
  }

  // 3. Invalid branch name refused with Q561
  {
    const r = await run(repo1, ['start', '--branch', 'bad..branch'])
    T('RS3 invalid branch name refused with Q561', r.code === 2 && /Q561/.test(r.out), r.out)
  }

  // 4. Valid branch binds room into git config and runs room mode
  {
    const r = await run(repo1, ['start', '--branch', 'fix-2', '--relay', RELAY, '--once'])
    const binding = g(repo1, 'config', '--get', 'hivecode.fix-2.room').stdout.trim()
    T('RS4 binds branch room into git config', Boolean(binding && binding.startsWith(`${RELAY}|room-`)), binding)
    T('RS5 proceeds to room mode and completes tick with --once', r.code === 0, `exit ${r.code}, out: ${r.out}`)
  }

  // 5. Existing bound branch reuses link
  {
    const prevBinding = g(repo1, 'config', '--get', 'hivecode.fix-2.room').stdout.trim()
    const r = await run(repo1, ['start', '--branch', 'fix-2', '--relay', RELAY, '--once'])
    const nextBinding = g(repo1, 'config', '--get', 'hivecode.fix-2.room').stdout.trim()
    T('RS6 reuses existing branch binding link and completes tick', r.code === 0 && prevBinding === nextBinding, `exit ${r.code}`)
  }

} catch (e) {
  T('test crashed', false, e && e.stack ? e.stack : String(e))
} finally {
  if (relay) { try { relay.kill() } catch { } }
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
