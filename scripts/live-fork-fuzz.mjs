// PROPERTY FUZZER for the silent-fork gate (local-render model).
// Each trial: 2-5 real signing clients in a fresh room make a RANDOM mix of same-line
// clashes and disjoint edits, ~simultaneously. After it settles we assert the invariants
// that must ALWAYS hold, no matter the timing:
//   I-CONVERGE  every peer ends on byte-identical content
//   I-NOLOSS    every value any agent authored is present on every peer (in a conflict
//               block if it clashed, merged in if it was disjoint) — nothing silently dropped
//   I-CLEAN     any conflict is one well-formed region: balanced markers, none glued/nested
//   I-PROV      every provenance receipt on every peer verifies
// Seeded PRNG so a failing run is reproducible: `node live-fork-fuzz.mjs <seed> <trials>`.
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import { startSync } from './sync.js'

const SEED = Number(process.argv[2] || 1234)
const TRIALS = Number(process.argv[3] || 12)
const PORT = 1310
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// mulberry32 — deterministic PRNG
let s = SEED >>> 0
const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const ri = (n) => Math.floor(rnd() * n)

const startRelay = () => { const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), HIVE_PROVENANCE: 'strict' } }); p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) }); return new Promise((res) => p.stdout.on('data', (d) => /listening on/.test(d) && res(p))) }
process.env.HIVE_PROVENANCE = 'on' // CLIENTS must sign too
process.env.HIVE_FORK_GATE = 'on'  // turn on the experimental silent-fork gate
const opens = (t) => (t.match(/^<<<<<<< /gm) || []).length
const closes = (t) => (t.match(/^>>>>>>> /gm) || []).length
const glued = (t) => /(>>>>>>>[^\n]*<<<<<<<)|(<<<<<<<[^\n]*<<<<<<<)|(>>>>>>>[^\n]*>>>>>>>)/.test(t)

async function trial(relay, t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hive-fz${t}-`))
  const room = `fuzz-${SEED}-${t}-${ri(1e6)}`
  const k = 2 + ri(4) // 2..5 agents
  const dirs = Array.from({ length: k }, (_, i) => { const d = path.join(tmp, 'c' + i); fs.mkdirSync(d, { recursive: true }); return d })
  const clients = dirs.map((d, i) => startSync({ relay: `ws://localhost:${PORT}`, room, dir: d, name: 'A' + i, kind: 'ai', log: () => {} }))
  await sleep(2500)
  // seed: one shared `return 0` line (the clash target) + one distinct `let ai = 0` line
  // per agent (a disjoint target that lands on its OWN line — truly disjoint, like real work).
  const base = 'function foo() {\n' + dirs.map((_, i) => `  let a${i} = 0\n`).join('') + '  return 0\n}\n'
  clients[0].claim('m.js', 'seed'); fs.writeFileSync(path.join(dirs[0], 'm.js'), base); await sleep(2500); clients[0].release('m.js')
  await sleep(2000)
  // Compose each agent's new content from the SAME captured base so every token is genuinely
  // authored (no replace()-on-stale no-ops), then write ALL files synchronously in one tick —
  // no await between writes — so the edits are truly concurrent. That is what makes it a fork.
  const tokens = []
  let clashers = 0
  const plan = dirs.map((d, i) => {
    const token = `Z${t}_${i}`
    tokens.push(token)
    const clash = rnd() < 0.6
    if (clash) clashers++
    const content = clash ? base.replace('return 0', `return ${token}`) : base.replace(`let a${i} = 0`, `let a${i} = ${token}`)
    return { d, i, token, clash, content }
  })
  for (const p of plan) fs.writeFileSync(path.join(p.d, 'm.js'), p.content) // synchronous burst = concurrent
  await sleep(9000) // settle + fork detection + render
  const copies = dirs.map((d) => { try { return fs.readFileSync(path.join(d, 'm.js'), 'utf8') } catch { return null } })

  const results = []
  // I-CONVERGE
  const converged = copies.every((c) => c != null && c === copies[0])
  results.push(['CONVERGE', converged])
  // I-NOLOSS — every token present on every peer (a clasher's token lives in the conflict block)
  const noloss = copies.every((c) => c != null && tokens.every((tk) => c.includes(tk)))
  results.push(['NOLOSS', noloss])
  // I-CLEAN — balanced markers, at most one region, none glued
  const clean = copies.every((c) => c != null && opens(c) === closes(c) && opens(c) <= 1 && !glued(c))
  results.push(['CLEAN', clean])
  // I-PROV — every receipt verifies on every client
  const prov = clients.every((cl) => { const v = cl.verifyProvenanceOf('m.js'); return v.ok })
  results.push(['PROV', prov])

  const ok = results.every(([, v]) => v)
  const tag = `t${t} k=${k} clash=${clashers}`
  if (ok) console.log(`  ok   ${tag}`)
  else {
    console.log(`  FAIL ${tag} -> ${results.filter(([, v]) => !v).map(([n]) => n).join(',')}`)
    console.log('   --- peer0 ---\n' + (copies[0] || '(null)').split('\n').map((l) => '   | ' + l).join('\n'))
    if (!converged) { const diff = copies.findIndex((c) => c !== copies[0]); console.log(`   --- peer${diff} (differs) ---\n` + (copies[diff] || '(null)').split('\n').map((l) => '   | ' + l).join('\n')) }
  }
  for (const c of clients) { try { c.stop() } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return ok
}

const relay = await startRelay()
console.log(`LIVE FORK FUZZ — seed ${SEED}, ${TRIALS} trials\n`)
let pass = 0
for (let t = 1; t <= TRIALS; t++) { if (await trial(relay, t)) pass++ }
relay.kill()
console.log(`\n=== FUZZ: ${pass}/${TRIALS} trials held all invariants ${pass === TRIALS ? '(ALL PASS)' : '=> ' + (TRIALS - pass) + ' FAILED'} ===`)
process.exit(pass === TRIALS ? 0 : 1)
