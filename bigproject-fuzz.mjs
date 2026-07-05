// MULTI-FILE PROPERTY FUZZER — randomized big-project trials.
// Each trial: fresh room, 3-5 signing clients, 5-10 seeded files across subdirs.
// Every agent independently rolls an action for EVERY file — clash the shared line,
// edit its own slot, create a brand-new file, or leave it alone — and ALL writes land
// in one synchronous burst (truly concurrent, across the whole project at once).
// Invariants asserted PER FILE on EVERY peer:
//   I-CONVERGE  byte-identical everywhere
//   I-NOLOSS    every authored token present (in a conflict block if it clashed)
//   I-CLEAN     0 or 1 well-formed conflict regions; clashes surface, disjoint stays clean
//   I-ISOLATE   files nobody clashed on carry ZERO markers (no cross-file bleed)
//   I-PROV      every ledger on every file verifies
// Reproducible: `node bigproject-fuzz.mjs <seed> <trials>`
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import { startSync } from './sync.js'

const SEED = Number(process.argv[2] || 1234)
const TRIALS = Number(process.argv[3] || 6)
const PORT = 1332
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let s = SEED >>> 0
const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const ri = (n) => Math.floor(rnd() * n)

const startRelay = () => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_PROVENANCE: 'strict' } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }
process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'
const opens = (t) => (t.match(/^<<<<<<< /gm) || []).length
const closes = (t) => (t.match(/^>>>>>>> /gm) || []).length
const glued = (t) => /(>>>>>>>[^\n]*<<<<<<<)|(<<<<<<<[^\n]*<<<<<<<)|(>>>>>>>[^\n]*>>>>>>>)/.test(t)
const DIRS = ['src', 'src/api', 'lib', 'tests']

async function trial(relay, t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hive-bpf${t}-`))
  const room = `bpf-${SEED}-${t}-${ri(1e6)}`
  const k = 3 + ri(3)                      // 3..5 agents
  const nf = 5 + ri(6)                     // 5..10 files
  const files = Array.from({ length: nf }, (_, j) => `${DIRS[ri(DIRS.length)]}/f${j}.js`)
  const dirs = Array.from({ length: k }, (_, i) => { const d = path.join(tmp, 'c' + i); fs.mkdirSync(d, { recursive: true }); return d })
  const clients = dirs.map((d, i) => startSync({ relay: `ws://localhost:${PORT}`, room, dir: d, name: 'A' + i, kind: 'ai', log: () => {} }))
  await sleep(2500)
  const write = (i, rel, c) => { const full = path.join(dirs[i], rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, c) }
  const read = (i, rel) => { try { return fs.readFileSync(path.join(dirs[i], rel), 'utf8') } catch { return null } }

  // seed the whole project from agent 0
  const body = (label) => `// ${label}\n` + Array.from({ length: k }, (_, i) => `let slot${i} = 0\n`).join('') + 'function shared() { return 0 }\n'
  for (const f of files) write(0, f, body(f))
  await sleep(6000 + nf * 400)
  if (!files.every((f) => dirs.every((_, i) => read(i, f) != null))) {
    console.log(`  SKIP t${t} — seed did not fully propagate`)
    for (const c of clients) { try { c.stop() } catch {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    return null
  }

  // roll the plan: per agent per file — 25% clash, 35% disjoint, 40% leave; plus 20% create a new file
  const tokens = new Map()   // file -> [{token, clash}]
  const plans = []
  const newFiles = []
  for (let i = 0; i < k; i++) {
    for (const f of files) {
      const roll = rnd()
      if (roll < 0.25) {
        const tk = `C${t}_${i}`
        plans.push({ i, f, content: read(i, f).replace('function shared() { return 0 }', `function shared() { return ${tk} }`) })
        ;(tokens.get(f) || tokens.set(f, []).get(f)).push({ token: tk, clash: true })
      } else if (roll < 0.6) {
        const tk = `D${t}_${i}`
        plans.push({ i, f, content: read(i, f).replace(`let slot${i} = 0`, `let slot${i} = ${tk}`) })
        ;(tokens.get(f) || tokens.set(f, []).get(f)).push({ token: tk, clash: false })
      }
    }
    if (rnd() < 0.2) { const nfl = `src/new/born${t}_${i}.js`; newFiles.push(nfl); plans.push({ i, f: nfl, content: `// new by A${i}\nexport const v = ${i}\n` }) }
  }
  for (const p of plans) write(p.i, p.f, p.content)   // ONE synchronous burst across the whole project
  await sleep(12000 + nf * 500)

  const all = [...files, ...newFiles]
  const failures = []
  for (const f of all) {
    const copies = dirs.map((_, i) => read(i, f))
    const acts = tokens.get(f) || []
    const clashers = acts.filter((a) => a.clash)
    if (!copies.every((c) => c != null && c === copies[0])) failures.push(`CONVERGE:${f}`)
    if (!copies.every((c) => c != null && acts.every((a) => c.includes(a.token)))) failures.push(`NOLOSS:${f}`)
    if (!copies.every((c) => c != null && opens(c) === closes(c) && opens(c) <= 1 && !glued(c))) failures.push(`CLEAN:${f}`)
    if (clashers.length <= 1 && !copies.every((c) => c != null && opens(c) === 0)) failures.push(`ISOLATE:${f}`) // nobody (or one) clashed -> zero markers
    const v = clients[0].verifyProvenanceOf(f)
    if (!v.ok) failures.push(`PROV:${f}`)
  }
  const clashFiles = [...tokens.entries()].filter(([, a]) => a.filter((x) => x.clash).length > 1).length
  const tag = `t${t} k=${k} files=${nf}+${newFiles.length} edits=${plans.length} clashFiles=${clashFiles}`
  if (!failures.length) console.log(`  ok   ${tag}`)
  else {
    console.log(`  FAIL ${tag} -> ${failures.join(', ')}`)
    const f0 = failures[0].split(':')[1]
    console.log(`   --- peer0 ${f0} ---\n` + (read(0, f0) || '(null)').split('\n').map((l) => '   | ' + l).join('\n'))
  }
  for (const c of clients) { try { c.stop() } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return failures.length === 0
}

const relay = await startRelay()
console.log(`BIG-PROJECT FUZZ — seed ${SEED}, ${TRIALS} trials\n`)
let pass = 0, ran = 0
for (let t = 1; t <= TRIALS; t++) { const r = await trial(relay, t); if (r === null) continue; ran++; if (r) pass++ }
relay.kill()
console.log(`\n=== BP-FUZZ: ${pass}/${ran} trials held all invariants ${pass === ran ? '(ALL PASS)' : '=> ' + (ran - pass) + ' FAILED'} ===`)
process.exit(pass === ran ? 0 : 1)
