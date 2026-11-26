// tests/unshared-batch-notice-test.mjs
// ONE CHAT LINE PER BURST OF UNSHARED FILES, NOT ONE PER FILE (26 Nov 2026).
//
// In a branch room binary sync is off, so every image or video an agent creates gets a chat line
// saying it stays on that agent's machine. An agent that generated a video and four images put five
// near-identical lines in a row into a live room (Antigravity, whatsapp-server/campaign*.png), and
// a new user reads that wall as "something is broken". The warning is right; one line per file is
// the noise. Invariants:
//
//   A  a burst of unclaimed binaries gives ONE chat line that names the count, the first paths,
//      how many more, and the two ways out (commit, .gitignore). status().unshared still lists every
//      file: nothing the room knows is lost, only the chat is shorter.
//   B  a single binary keeps the exact line it had before (other tests and people know that text).
//   C  a burst of CLAIMED binaries also gives one chat line, while the ledger keeps one obligation
//      per file, addressed to the claimer: each one is discharged on its own when its file goes.
//
//   node tests/unshared-batch-notice-test.mjs

process.env.HIVE_NO_BINARY_SYNC = '1' // what a branch-room folder does
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ` (${extra})` : ''}`); c ? pass++ : fail++ }
const until = async (fn, ms = 12000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200) } return fn() }

const PORT = Number(process.env.HIVE_TEST_PORT) || (23000 + (process.pid % 9000))
const relay = await new Promise((res, rej) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  p.on('error', rej)
})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-batch-notice-'))
const dir = path.join(tmp, 'alice')
fs.mkdirSync(dir, { recursive: true })
const alice = startSync({ relay: `ws://localhost:${PORT}`, room: 'batch-' + crypto.randomBytes(4).toString('hex'), dir, name: 'Alice', kind: 'ai', log: () => {} })
await sleep(2000)

const BIN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff])
const chatLines = () => alice.doc.getArray('chat').toArray().map((m) => String(m.text || ''))
const linesNaming = (paths) => chatLines().filter((t) => paths.some((p) => t.includes(p)))
const unsharedPaths = () => new Set(alice.unshared().map((u) => u.path))

console.log('# A. five unclaimed binaries at once -> one chat line')
const burst = ['a0', 'a1', 'a2', 'a3', 'a4'].map((n) => `media/${n}.png`)
fs.mkdirSync(path.join(dir, 'media'), { recursive: true })
for (const r of burst) fs.writeFileSync(path.join(dir, r), BIN)
await until(() => burst.every((r) => unsharedPaths().has(r)))
await sleep(2500) // let any per-file lines arrive, so a count of 1 means 1
const aLines = linesNaming(burst)
T('A every file is still listed by status().unshared', burst.every((r) => unsharedPaths().has(r)))
T('A exactly one chat line names the burst', aLines.length === 1, `${aLines.length} lines`)
const a = aLines[0] || ''
T('A the line gives the count', /\b5 files\b/.test(a), a.slice(0, 160))
T('A the line names the first path and how many more', a.includes('media/a0.png') && a.includes('+2 more'))
T('A the line says how to share them or quiet them', a.includes('commit') && a.includes('.gitignore'))

console.log('# B. one binary on its own keeps its own line')
fs.writeFileSync(path.join(dir, 'solo.bin'), BIN)
await until(() => linesNaming(['solo.bin']).length > 0, 8000)
await sleep(1500)
const bLines = linesNaming(['solo.bin'])
T('B exactly one line names solo.bin', bLines.length === 1, `${bLines.length} lines`)
T('B it is the unchanged single-file text', (bLines[0] || '').includes('solo.bin is binary (contains null bytes)'), (bLines[0] || '').slice(0, 120))

console.log('# C. three claimed binaries at once -> one chat line, three ledger entries')
const claimed = ['c0', 'c1', 'c2'].map((n) => `gen/${n}.bin`)
for (const r of claimed) alice.claim(r, 'generate assets')
await sleep(500)
fs.mkdirSync(path.join(dir, 'gen'), { recursive: true })
for (const r of claimed) fs.writeFileSync(path.join(dir, r), BIN)
await until(() => claimed.every((r) => unsharedPaths().has(r)))
await sleep(2500)
const cLines = linesNaming(claimed)
T('C exactly one chat line names the claimed burst', cLines.length === 1, `${cLines.length} lines`)
T('C the line names who claimed them', (cLines[0] || '').includes('Alice'))
const obs = [...alice.doc.getMap('obligations').values()].filter((o) => o && o.from === 'hivecode' && !o.done)
T('C one open obligation per claimed file', claimed.every((r) => obs.filter((o) => String(o.text).includes(r)).length === 1), `${obs.length} hivecode obligations`)
fs.rmSync(path.join(dir, claimed[0]))
await until(() => !unsharedPaths().has(claimed[0]), 8000)
await sleep(500)
const obs2 = [...alice.doc.getMap('obligations').values()].filter((o) => o && o.from === 'hivecode' && String(o.text).includes(claimed[0]))
const stillOpen = (o) => !o.done
T('C deleting one claimed file discharges only its own obligation', obs2.every((o) => !stillOpen(o)) && claimed.slice(1).every((r) => [...alice.doc.getMap('obligations').values()].some((o) => o && o.from === 'hivecode' && String(o.text).includes(r) && stillOpen(o))))

console.log(`\n${pass} passed, ${fail} failed`)
alice.stop(); relay.kill()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
