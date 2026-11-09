// SAME-LINE RACE (P0-F). Two saves of the same line made at the same moment, before either client has
// seen the other's edit, must never fuse into text neither author wrote ("ship montuesday"). Every
// version from 0.6.0 to 0.14.3 fused them, 3 of 3 runs, with no marker and no chat line
// (docs/rules-rewrite/p0f-design.md). Saves 40 ms apart always got conflict markers.
//
//   R1 same line, different text, 0 ms   -> one conflict block holding both, in every folder; never
//                                           fused on any disk (sampled every 10 ms); one MERGE CONFLICT
//   R2 same line, the same change, 0 ms  -> the change once ("ship monday", never "ship monmonday")
//   R3 adjacent lines, 0 ms              -> both kept, no markers (the fork gate's W1 false positive)
//   R4 40 ms apart                       -> markers, as before
//   R5 lines far apart, 0 ms             -> clean merge
//   R6 three clients, same line, 0 ms    -> every version kept, nothing fused
//   R8 a deleted line beside a changed one, code lines sharing a prefix, 0 ms -> clean merge (Opus-Cloud)
//   R9 two clients on one line, a third elsewhere in the file, 0 ms -> the third edit survives the resolution (Opus-Cloud)
//
//   node tests/same-line-race-test.mjs
import fs from 'fs'
import os from 'os'
import net from 'net'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
delete process.env.HIVE_FORK_GATE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(p, ms) { const e = Date.now() + ms; while (Date.now() < e) { if (await p()) return true; await sleep(30) } return false }
let pass = 0, fail = 0
const T = (n, c, d = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c || !d ? '' : '  -- ' + d}`); c ? pass++ : fail++ }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'same-line-'))
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
const relay = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((r) => relay.stdout.on('data', (d) => { if (/listening on/.test(d)) r() }))
const { startSync } = await import(path.join(ROOT, 'sync.js'))
const room = 'sameline-' + Math.random().toString(36).slice(2, 8)
const clients = []
const join = (n) => { const dir = path.join(TMP, n); fs.mkdirSync(dir, { recursive: true }); const c = startSync({ relay: `ws://localhost:${port}`, room, dir, name: n, kind: 'ai', log: () => {} }); const x = { c, dir, n }; clients.push(x); return x }
const A = join('Alice'), B = join('Bob'), C = join('Carol'); join('Dave')
await until(() => clients.every((x) => x.c.provider.synced), 20000)
await sleep(1500)

const read = (x, f) => { try { return fs.readFileSync(path.join(x.dir, f), 'utf8') } catch { return '' } }
const write = (x, f, t) => fs.writeFileSync(path.join(x.dir, f), t)
const chatAbout = (f, re) => A.c.doc.getArray('chat').toArray().filter((m) => String(m.text || '').includes(f) && re.test(String(m.text || ''))).length
const markers = (t) => /^<<<<<<< /m.test(t) && /^>>>>>>> /m.test(t)

// Watch every folder's copy of f every 10 ms; return what any disk ever held that matches `bad`.
function watchDisks(f, bad) {
  const seen = []
  const iv = setInterval(() => { for (const x of clients) { const t = read(x, f); if (bad.test(t) && seen.length < 3) seen.push(`${x.n}: ${JSON.stringify(t.split('\n')[1])}`) } }, 10)
  return () => { clearInterval(iv); return seen }
}

let k = 0
async function seed(text) {
  const f = `board-${++k}.md`
  write(A, f, text)
  await until(() => clients.every((x) => read(x, f) === text), 15000)
  await sleep(800)
  return f
}
const settled = async (f, ms = 12000) => { await until(() => { const t = clients.map((x) => read(x, f)); return new Set(t).size === 1 }, ms); await sleep(1500) }

// ---- R1 ----
console.log('\n# R1 same line, different text, saved at the same moment')
for (let t = 0; t < 3; t++) {
  const f = await seed('plan\nship friday\nowner: team\n')
  const stop = watchDisks(f, /montues|tuesmon/)
  write(A, f, 'plan\nship monday\nowner: team\n'); write(B, f, 'plan\nship tuesday\nowner: team\n')
  await settled(f)
  await sleep(2500)
  const fusedSeen = stop()
  const texts = clients.map((x) => read(x, f))
  T(`R1.${t} every folder holds the same text`, new Set(texts).size === 1, texts.map((s) => JSON.stringify(s)).join(' | '))
  T(`R1.${t} conflict markers holding both versions`, texts.every((s) => markers(s) && s.includes('ship monday') && s.includes('ship tuesday')), JSON.stringify(texts[0]))
  T(`R1.${t} no disk ever held fused text`, fusedSeen.length === 0, fusedSeen.join('; '))
  T(`R1.${t} one MERGE CONFLICT line`, chatAbout(f, /MERGE CONFLICT/) === 1, `${chatAbout(f, /MERGE CONFLICT/)} lines`)
}

// ---- R2 ----
console.log('\n# R2 same line, the same change, saved at the same moment')
for (let t = 0; t < 2; t++) {
  const f = await seed('plan\nship friday\nowner: team\n')
  const stop = watchDisks(f, /monmon/)
  write(A, f, 'plan\nship monday\nowner: team\n'); write(B, f, 'plan\nship monday\nowner: team\n')
  await settled(f); await sleep(2500)
  const dup = stop()
  const texts = clients.map((x) => read(x, f))
  T(`R2.${t} every folder has the change once`, texts.every((s) => s === 'plan\nship monday\nowner: team\n'), JSON.stringify(texts[0]))
  T(`R2.${t} no disk ever held it twice`, dup.length === 0, dup.join('; '))
}

// ---- R3 ----
console.log('\n# R3 adjacent lines, saved at the same moment')
for (let t = 0; t < 2; t++) {
  const f = await seed('plan\nship friday\nowner: team\n')
  write(A, f, 'plan\nship monday\nowner: team\n'); write(B, f, 'plan\nship friday\nowner: ops\n')
  await settled(f); await sleep(2500)
  const texts = clients.map((x) => read(x, f))
  T(`R3.${t} both changes kept, no markers, everywhere`, texts.every((s) => s === 'plan\nship monday\nowner: ops\n'), JSON.stringify(texts[0]))
}

// ---- R4 ----
console.log('\n# R4 saves 40 ms apart')
{
  const f = await seed('plan\nship friday\nowner: team\n')
  write(A, f, 'plan\nship monday\nowner: team\n'); await sleep(40); write(B, f, 'plan\nship tuesday\nowner: team\n')
  await settled(f); await sleep(2500)
  const texts = clients.map((x) => read(x, f))
  T('R4 markers holding both versions, everywhere', new Set(texts).size === 1 && texts.every((s) => markers(s) && s.includes('ship monday') && s.includes('ship tuesday')), JSON.stringify(texts[0]))
}

// ---- R5 ----
console.log('\n# R5 lines far apart, saved at the same moment')
{
  const body = ['top', ...Array.from({ length: 12 }, (_, i) => `line ${i}`), 'bottom', ''].join('\n')
  const f = await seed(body)
  write(A, f, body.replace('top', 'TOP')); write(B, f, body.replace('bottom', 'BOTTOM'))
  await settled(f); await sleep(2500)
  const texts = clients.map((x) => read(x, f))
  T('R5 clean merge everywhere', texts.every((s) => s === body.replace('top', 'TOP').replace('bottom', 'BOTTOM')), JSON.stringify(texts[0]))
}

// ---- R6 ----
console.log('\n# R6 three clients, same line, saved at the same moment')
{
  const f = await seed('plan\nship friday\nowner: team\n')
  const stop = watchDisks(f, /(mon|tues|wednes)(mon|tues|wednes)/)
  write(A, f, 'plan\nship monday\nowner: team\n'); write(B, f, 'plan\nship tuesday\nowner: team\n'); write(C, f, 'plan\nship wednesday\nowner: team\n')
  await settled(f, 15000); await sleep(3000)
  const fusedSeen = stop()
  const texts = clients.map((x) => read(x, f))
  T('R6 every folder holds the same text', new Set(texts).size === 1, texts.map((s) => JSON.stringify(s)).join(' | '))
  T('R6 all three versions kept, with markers', texts.every((s) => markers(s) && ['ship monday', 'ship tuesday', 'ship wednesday'].every((v) => s.includes(v))), JSON.stringify(texts[0]))
  T('R6 no disk ever held fused text', fusedSeen.length === 0, fusedSeen.join('; '))
}

// ---- R7 (Opus-Cloud's review F1) ----
// A save that edits lines 1 and 5 sends ONE character span from line 1 to line 5, so B's line 3 inside it
// was lost under a per-hunk rule: no line both changed, yet the CRDT damaged it. Both must land, clean.
console.log('\n# R7 one save edits lines 1 and 5, another edits line 3, at the same moment')
for (let t = 0; t < 2; t++) {
  const body = ['l0', 'const v1 = 7', 'l2', 'const v3 = 21', 'l4', 'const v5 = 35', 'l6', ''].join('\n')
  const f = await seed(body)
  const a = body.replace('const v1 = 7', 'const v1 = 8').replace('const v5 = 35', 'const v5 = 36')
  const b = body.replace('const v3 = 21', 'const v3 = 22')
  write(A, f, a); write(B, f, b)
  await settled(f); await sleep(2500)
  const want = a.replace('const v3 = 21', 'const v3 = 22')
  const texts = clients.map((x) => read(x, f))
  T(`R7.${t} all three changes kept, no markers, everywhere`, texts.every((s) => s === want), JSON.stringify(texts[0]))
}

// ---- R8 ---- a deleted line slides along the prefix its neighbour shares: "const valpha()".
console.log('\n# R8 a deleted line beside a changed line, at the same moment')
{
  const body = ['const v0 = 0', 'const v1 = 7', 'const v2 = 14', 'const v3 = 21', 'const v4 = 28', 'const v5 = 35', ''].join('\n')
  const want = body.replace('const v3 = 21\n', '').replace('const v4 = 28', 'alpha()')
  const f = await seed(body)
  const stop = watchDisks(f, /const valpha|alpha\(\)4/)
  write(A, f, body.replace('const v3 = 21\n', '')); write(B, f, body.replace('const v4 = 28', 'alpha()'))
  await settled(f); await sleep(2500)
  const bad = stop(), texts = clients.map((x) => read(x, f))
  T('R8 every folder holds both edits, merged cleanly', texts.every((s) => s === want), JSON.stringify(texts[0]))
  T('R8 no disk ever held fused text', bad.length === 0, bad.join('; '))
}

// ---- R9 ---- the resolution is built from every save made from that text, not only the clashing ones.
console.log('\n# R9 two clients on one line and a third elsewhere, at the same moment')
{
  const body = 'plan\nship friday\nowner: team\nnotes\n'
  const f = await seed(body)
  const stop = watchDisks(f, /montues|tuesmon/)
  write(A, f, body.replace('friday', 'monday')); write(B, f, body.replace('friday', 'tuesday')); write(C, f, body.replace('notes', 'notes by Carol'))
  await settled(f); await sleep(2500)
  const bad = stop(), texts = clients.map((x) => read(x, f))
  T('R9 every folder holds one block with both versions', new Set(texts).size === 1 && texts.every((s) => markers(s) && s.includes('ship monday') && s.includes('ship tuesday')), JSON.stringify(texts[0]))
  T("R9 ...and Carol's edit elsewhere is still there", texts.every((s) => s.includes('notes by Carol')), JSON.stringify(texts[0]))
  T('R9 no disk ever held fused text', bad.length === 0, bad.join('; '))
}

console.log(`\n=== SAME-LINE RACE: ${pass} passed, ${fail} failed ===`)
for (const x of clients) try { x.c.stop() } catch { }
relay.kill(); fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
