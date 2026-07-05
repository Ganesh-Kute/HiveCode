// BIG-PROJECT TORTURE — the multi-file escalation of the fork-gate campaign.
// All prior suites hammered ONE file. Real swarms edit a PROJECT: many files, subdirs,
// a big generated file, edits landing on many files in the same instant. 5 signing
// clients, 12-file project, six waves:
//   W1  mass disjoint: every agent edits its own slot in EVERY file, one synchronous
//       burst = 60 concurrent edits across 12 files
//   W2  multi-file collisions: 3 files take same-line clashes (different agent pairs)
//       while 2 other files take disjoint edits IN THE SAME BURST — the gate must fire
//       per-file with zero cross-file bleed
//   W3  resolution under traffic: one conflict resolved while another file is edited
//   W4  big-file edit (~300KB, under the 1MB cap): converge + sign
//   W5  new-file storm: every agent creates 2 files concurrently
//   W6  global audit: every file byte-identical on every peer, every ledger verifies
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from './sync.js'
import { contentHash } from './substrate.js'

const PORT = 1331, N = 5
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0; const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }
const startRelay = () => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_PROVENANCE: 'strict' } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }
process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'
const opens = (t) => (t.match(/^<<<<<<< /gm) || []).length
const closes = (t) => (t.match(/^>>>>>>> /gm) || []).length
const glued = (t) => /(>>>>>>>[^\n]*<<<<<<<)|(<<<<<<<[^\n]*<<<<<<<)|(>>>>>>>[^\n]*>>>>>>>)/.test(t)

// ---- the project: every file carries one slot line per agent + one shared clash line ----
const slots = Array.from({ length: N }, (_, i) => `let slot${i} = 0`)
const fileBody = (label, filler = '') =>
  `// ${label}\n${slots.join('\n')}\nfunction shared() { return 0 }\n${filler}`
const FILES = [
  'src/app.js', 'src/router.js', 'src/db.js', 'src/auth.js',
  'src/api/users.js', 'src/api/orders.js',
  'lib/util.js', 'lib/math.js', 'lib/format.js',
  'tests/app.test.js', 'README.md',
]
const BIG = 'lib/generated.js'
const bigFiller = Array.from({ length: 3000 }, (_, i) => `function gen_${i}() { return ${i} * 2 } // generated, do not edit by hand`).join('\n') + '\n'

const relay = await startRelay()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-bigproj-'))
const room = 'bigproj-' + crypto.randomBytes(6).toString('hex')
console.log(`BIG-PROJECT TORTURE: ${N} signing clients, ${FILES.length + 1} files, room ${room}\n`)
const dirs = Array.from({ length: N }, (_, i) => { const d = path.join(tmp, 'c' + i); fs.mkdirSync(d, { recursive: true }); return d })
const clients = dirs.map((d, i) => startSync({ relay: `ws://localhost:${PORT}`, room, dir: d, name: 'A' + i, kind: 'ai', log: () => {} }))
await sleep(3000)

const write = (agent, rel, content) => { const full = path.join(dirs[agent], rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content) }
const read = (agent, rel) => { try { return fs.readFileSync(path.join(dirs[agent], rel), 'utf8') } catch { return null } }
const everyPeer = (rel, fn) => dirs.every((_, i) => { const c = read(i, rel); return c != null && fn(c, i) })
const identical = (rel) => { const c0 = read(0, rel); return c0 != null && dirs.every((_, i) => read(i, rel) === c0) }

// ---- SEED ----
console.log('# seeding project from A0...')
for (const f of FILES) write(0, f, fileBody(f))
write(0, BIG, fileBody(BIG, bigFiller))
await sleep(12000)
const ALL = [...FILES, BIG]
T('all peers pulled all ' + ALL.length + ' files', ALL.every((f) => everyPeer(f, (c) => c.length > 0)))
T('seed byte-identical everywhere', ALL.every(identical))

// ---- W1: mass disjoint — every agent edits its slot in EVERY file, one burst ----
console.log(`\n# W1: ${N * FILES.length} concurrent disjoint edits across ${FILES.length} files...`)
{
  const plans = []
  for (let i = 0; i < N; i++) for (const f of FILES) {
    const base = read(i, f)
    plans.push({ i, f, content: base.replace(`let slot${i} = 0`, `let slot${i} = ${100 + i}`) })
  }
  for (const p of plans) write(p.i, p.f, p.content) // synchronous burst = truly concurrent
  await sleep(15000)
  const allTokens = FILES.every((f) => everyPeer(f, (c) => Array.from({ length: N }, (_, i) => c.includes(`let slot${i} = ${100 + i}`)).every(Boolean)))
  T('W1 all ' + N * FILES.length + ' edits present on every peer', allTokens)
  T('W1 zero conflict markers anywhere', ALL.every((f) => everyPeer(f, (c) => opens(c) === 0 && closes(c) === 0)))
  T('W1 all files converged', ALL.every(identical))
}

// ---- W2: multi-file same-line collisions + disjoint traffic in ONE burst ----
console.log('\n# W2: same-line collisions on 3 files (pairs 0/1, 2/3, 4/0) + disjoint edits on 2 others, one burst...')
const CLASH = [
  { f: 'src/app.js', pair: [0, 1] },
  { f: 'lib/util.js', pair: [2, 3] },
  { f: 'src/api/users.js', pair: [4, 0] },
]
const QUIET = [{ f: 'src/db.js', i: 1 }, { f: 'lib/math.js', i: 2 }]
{
  const plans = []
  for (const { f, pair } of CLASH) for (const i of pair) {
    plans.push({ i, f, content: read(i, f).replace('function shared() { return 0 }', `function shared() { return ${1000 + i} }`) })
  }
  for (const { f, i } of QUIET) plans.push({ i, f, content: read(i, f).replace(`let slot${i} = ${100 + i}`, `let slot${i} = ${200 + i}`) })
  for (const p of plans) write(p.i, p.f, p.content)
  await sleep(18000)
  for (const { f, pair } of CLASH) {
    const okBlock = everyPeer(f, (c) => opens(c) === 1 && closes(c) === 1 && !glued(c) && pair.every((i) => c.includes(`return ${1000 + i}`)))
    T(`W2 ${f}: 1 clean conflict block, both versions kept, on every peer`, okBlock)
    T(`W2 ${f}: converged`, identical(f))
  }
  for (const { f, i } of QUIET) T(`W2 ${f}: disjoint edit merged clean (no false fork)`, everyPeer(f, (c) => c.includes(`let slot${i} = ${200 + i}`) && opens(c) === 0))
  const untouched = ALL.filter((f) => !CLASH.some((c) => c.f === f))
  T('W2 cross-file isolation: no markers leaked into the other ' + untouched.length + ' files', untouched.every((f) => everyPeer(f, (c) => opens(c) === 0 && closes(c) === 0)))
}

// ---- W3: resolve one conflict WHILE another file takes a disjoint edit ----
console.log('\n# W3: A1 resolves src/app.js while A3 edits src/router.js concurrently...')
{
  const withBlock = read(1, 'src/app.js')
  const resolved = withBlock.replace(/<<<<<<<[\s\S]*?>>>>>>> [^\n]*\n?/, 'function shared() { return 1001 }\n')
  const routerEdit = read(3, 'src/router.js').replace('let slot3 = 103', 'let slot3 = 303')
  write(1, 'src/app.js', resolved); write(3, 'src/router.js', routerEdit) // same tick
  await sleep(15000)
  T('W3 resolution propagated to all peers, clean', everyPeer('src/app.js', (c) => c.includes('return 1001') && opens(c) === 0 && closes(c) === 0))
  T('W3 resolution converged', identical('src/app.js'))
  T('W3 concurrent router edit landed everywhere', everyPeer('src/router.js', (c) => c.includes('let slot3 = 303') && opens(c) === 0))
}

// ---- W4: big-file edit ----
console.log('\n# W4: A2 edits one line inside the ~300KB file...')
{
  write(2, BIG, read(2, BIG).replace('function gen_1500() { return 1500 * 2 }', 'function gen_1500() { return 424242 }'))
  await sleep(12000)
  T('W4 big-file edit converged on all peers', everyPeer(BIG, (c) => c.includes('return 424242')) && identical(BIG))
  const v = clients[0].verifyProvenanceOf(BIG)
  T('W4 big-file provenance verifies', v.ok)
}

// ---- W5: new-file storm — every agent creates 2 files concurrently ----
console.log(`\n# W5: ${N * 2} new files created concurrently...`)
{
  const created = []
  for (let i = 0; i < N; i++) for (let j = 0; j < 2; j++) {
    const f = `src/new/agent${i}_${j}.js`
    created.push(f)
    write(i, f, `// born in the storm by A${i}\nexport const v = ${i * 10 + j}\n`)
  }
  await sleep(15000)
  T('W5 all ' + created.length + ' new files exist on every peer', created.every((f) => everyPeer(f, (c) => c.length > 0)))
  T('W5 all new files byte-identical', created.every(identical))
}

// ---- W6: global audit ----
console.log('\n# W6: global audit...')
{
  const finals = ALL.filter(identical)
  T(`W6 every project file byte-identical on all ${N} peers (${finals.length}/${ALL.length})`, finals.length === ALL.length)
  let receipts = 0, bad = 0
  for (const f of ALL) { const v = clients[0].verifyProvenanceOf(f); receipts += v.count; if (!v.ok) bad++ }
  console.log(`  ledgers: ${receipts} receipts across ${ALL.length} files, ${bad} files with verification failures`)
  T('W6 every ledger on every file verifies', bad === 0)
  const hashes = ALL.map((f) => contentHash(read(0, f) || '').slice(0, 8)).join(' ')
  console.log('  final hashes: ' + hashes)
}

for (const c of clients) { try { c.stop() } catch {} }
relay.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
console.log(`\n=== BIG-PROJECT: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED (of ' + (pass + fail) + ')'} ===`)
process.exit(fail === 0 ? 0 : 1)
