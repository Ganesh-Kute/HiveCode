// GENESIS CLAIM: claiming a not-yet-created root file under an allow-list .gitignore (HIV-P3)
//
// Found live on 19 Sep 2026 by DeepMind-Agent.
// At sync.js:1232:
//   const isFile = manifest.has(p) || fileDocs.has(p) || SKIP.has(p) || onDisk || p.includes('/')
//   if (!isFile) return ''      // a label, not a path -- not ours to judge
//
// When claiming a brand new root file ("config.env", "untracked.js", "Makefile", "Dockerfile")
// before creating it:
// - Not in manifest
// - Not in fileDocs
// - Not in SKIP
// - Not on disk (genesis)
// - No directory slash
// All 5 conditions evaluate to false. `whyNotShared` returns '' (shareable) and skips all gates!
// Under an allow-list .gitignore (`/*`), that file is ignored, so the bytes never leave the local folder.
// The agent claims, writes, gates green locally, releases -- and the file was born invisible.
//
// THE DUAL CONSTRAINT:
// If you naively treat every string as a file, bare logical region claims ("auth-refactor", "P3 lane")
// are refused because an allow-list .gitignore ignores everything not explicitly negated.
//
// This test suite proves:
//   P3-A: Root files not yet on disk and NOT in allow-list MUST be refused.
//   P3-B: Root files not yet on disk but EXPLICITLY in allow-list MUST be allowed.
//   P3-C: Bare logical region labels MUST be allowed in the same session.
//   P3-D: Subdirectory files preserve established scoping rules.
//   P3-E: End-to-end MCP `hive_claim` refuses unshared genesis files and grants logical labels.
//
//   node tests/genesis-claim-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-genesis-claim-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'genesis-' + crypto.randomBytes(6).toString('hex')
const dir = path.join(tmp, 'agent'); fs.mkdirSync(dir, { recursive: true })

// Canonical allow-list .gitignore
fs.writeFileSync(path.join(dir, '.gitignore'), [
  '/*', '!/.gitignore', '!/sync.js', '!/notes.md',
  '!/src/', '!/src/**', '',
].join('\n'))

// sync.js exists on disk; notes.md DOES NOT exist on disk yet (genesis in allow-list)
fs.writeFileSync(path.join(dir, 'sync.js'), 'export const a = 1\n')

let hive
try {
  hive = startSync({ relay: `ws://localhost:${PORT}`, room, dir, name: 'Tester', kind: 'ai', log: () => {} })
  await sleep(1200)

  // ---- P3-A. Genesis Root Files OUTSIDE allow-list MUST be refused -------------------------
  // These files do NOT exist on disk, are not in manifest, and have no slash.
  // Because they are not negated in .gitignore, anything written to them stays local forever.
  const whyEnv = hive.whyNotShared('config.env')
  T('P3-A1 not-yet-created root config.env is refused', whyEnv !== '', whyEnv)

  const whyJs = hive.whyNotShared('untracked.js')
  T('P3-A2 not-yet-created root untracked.js is refused', whyJs !== '', whyJs)

  const whyMakefile = hive.whyNotShared('Makefile')
  T('P3-A3 not-yet-created root Makefile (no extension) is refused', whyMakefile !== '', whyMakefile)

  const whyDockerfile = hive.whyNotShared('Dockerfile')
  T('P3-A4 not-yet-created root Dockerfile (no extension) is refused', whyDockerfile !== '', whyDockerfile)

  const whyDot = hive.whyNotShared('.env.secret')
  T('P3-A5 not-yet-created root .env.secret (dotfile) is refused', whyDot !== '', whyDot)

  T('P3-A6 refusal reason cites .gitignore exclusion', /ignored by a \.gitignore/i.test(whyEnv), whyEnv)

  // ---- P3-B. Genesis Root Files INSIDE allow-list MUST be shareable -----------------------
  // notes.md is negated by '!/notes.md' in .gitignore, but has not been created yet on disk.
  // An agent claiming before creating MUST be allowed.
  const whyNotes = hive.whyNotShared('notes.md')
  T('P3-B1 not-yet-created root notes.md inside allow-list is shareable', whyNotes === '', whyNotes)

  const whySync = hive.whyNotShared('sync.js')
  T('P3-B2 existing allowed sync.js is shareable', whySync === '', whySync)

  // ---- P3-C. Bare Logical Labels MUST NOT be refused ---------------------------------------
  // Under an allow-list, isIgnored() returns true for these strings. A naive guard would break them.
  T('P3-C1 bare logical label "auth-refactor" is allowed', hive.whyNotShared('auth-refactor') === '')
  T('P3-C2 multi-word label "the parser rewrite" is allowed', hive.whyNotShared('the parser rewrite') === '')
  T('P3-C3 ticket label "P3 lane" is allowed', hive.whyNotShared('P3 lane') === '')
  T('P3-C4 version-style label "v1.2" is allowed', hive.whyNotShared('v1.2') === '')
  T('P3-C5 dotted release label "release-0.11.6" is allowed', hive.whyNotShared('release-0.11.6') === '')
  T('P3-C6 dotted ticket label "HIV-P3.5" is allowed', hive.whyNotShared('HIV-P3.5') === '')

  // ---- P3-D. Subdirectory Genesis Scoping Invariants Preserved ----------------------------
  T('P3-D1 not-yet-created file in allowed subdir "src/brand-new.js" is shareable',
    hive.whyNotShared('src/brand-new.js') === '')
  T('P3-D2 not-yet-created file in unallowed subdir "scripts/brand-new.mjs" is refused',
    hive.whyNotShared('scripts/brand-new.mjs') !== '')

  // ---- P3-E. End-to-End MCP hive_claim Verification ---------------------------------------
  const { _test } = await import('../hive-mcp.js')
  const dir2 = path.join(tmp, 'mcp')
  fs.mkdirSync(dir2, { recursive: true })
  fs.writeFileSync(path.join(dir2, '.gitignore'), [
    '/*', '!/.gitignore', '!/sync.js', '!/notes.md', ''
  ].join('\n'))
  fs.writeFileSync(path.join(dir2, 'sync.js'), 'export const a = 1\n')

  const textOf = (r) => (r && r.content && r.content[0] && r.content[0].text) || String(r)
  await _test.callTool('hive_join', { link: `ws://localhost:${PORT}|${room}`, dir: dir2, name: 'Probe', owner: 'test' })
  await sleep(1500)

  // E1 & E2: claiming unallowed genesis root file must fail
  const claimGenesis = textOf(await _test.callTool('hive_claim', { region: 'config.env', intent: 'genesis test' }))
  T('P3-E1 MCP hive_claim REFUSES unallowed genesis root file', /refusing to claim/.test(claimGenesis), claimGenesis.split('\n')[0])
  T('P3-E2 MCP hive_claim never reports unallowed genesis file as claimed', !/it's yours/.test(claimGenesis))

  // E3: claiming bare logical label in same MCP session must succeed
  const claimLabel = textOf(await _test.callTool('hive_claim', { region: 'auth-refactor', intent: 'lane claim' }))
  T('P3-E3 MCP hive_claim GRANTS bare logical label', /it's yours/.test(claimLabel), claimLabel.split('\n')[0])

  // E4: claiming allowed genesis root file must succeed
  const claimAllowedGenesis = textOf(await _test.callTool('hive_claim', { region: 'notes.md', intent: 'create notes' }))
  T('P3-E4 MCP hive_claim GRANTS allowed genesis root file', /it's yours/.test(claimAllowedGenesis), claimAllowedGenesis.split('\n')[0])

} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { hive && hive.stop() } catch {}
  try { relay.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== HIV-P3 GENESIS CLAIM TEST: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
