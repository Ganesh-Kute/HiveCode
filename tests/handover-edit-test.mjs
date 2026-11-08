// AN AGENT THAT SAYS WHAT IT EDITED NEVER CONFLICTS WITH A CLEAN HANDOVER, AND NEVER LOSES WORK.
//
//   node tests/handover-edit-test.mjs
//
// The clean handover (A changes a line and releases, B changes that same line) shows conflict
// markers when B writes the file on disk, because from the texts alone "B replaced A's change" and
// "B wrote from a copy older than A's change" can be identical (handover-conflict-test K2, OPEN).
// Four rules that guessed from the texts each deleted work silently (1 Nov 2026).
//
// hive_edit old/new does not guess: `old` is the agent's own statement of the lines it edited, and
// it lands only if those exact whole lines are in the room's copy exactly once. A stale reader's
// `old` no longer matches the lines that changed under it, so it is refused, and nothing is written.
//
//   H1  clean handover through old/new: no markers, B's line in both folders
//   H2  old taken from a copy older than A's change: refused, A's line intact in both folders
//   H3  old is part of a line, even a current one: refused (whole lines only)
//   H4  old appears twice: refused
//   H5  an unsent change on disk: refused and NOTHING sent (no flush), then a retry lands both
//   H6  a key on disk was withheld from the room: refused, the agent's own disk copy is untouched
//   H7  stale old that does not overlap A's change: lands, and A's change stays
//   H8  CRLF file, old/new given with LF: lands, and the file stays CRLF
//   H9  old equal to new is a no-op, not a success; a file not in the room is refused
//   H10 a trailing line break on one side only never joins two lines or leaves a blank one; empty
//       new deletes the lines (antigravity-3, 1 Nov: "b\n" -> "B" used to swallow the next line)
//   H11 someone else holds the file: refused, naming them
//   H12 in the room but not loaded here: "loading, retry", never "use content"; the retry lands
//   H13 not connected: refused
//   H15 an old claiming a blank line that is not there, new "\n", an old ending inside a CRLF
//   H16 the editing agent's own disk is CRLF (a Windows checkout): the edit lands, the disk stays CRLF
//   M1  through the MCP tool: old/new lands and says so; a stale old is an error saying nothing was written
//   M2  a refused old/new does not spend a PUBLISH lease; a landed one does
import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = 1343
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

process.env.HIVE_PROVENANCE = 'on'
process.env.HIVE_FORK_GATE = 'on'

const startRelay = async () => {
  const r = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), HIVE_ENFORCE_CLAIMS: 'queue', HIVE_PERSIST_DIR: '' },
  })
  r.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('relay did not start')), 20000)
    r.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); res() } })
  })
  return r
}
let relay = await startRelay()

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-handedit-'))
const room = 'handedit-' + crypto.randomBytes(6).toString('hex')
const wsUrl = `ws://localhost:${PORT}`
const dA = path.join(tmp, 'a'); fs.mkdirSync(dA)
const dB = path.join(tmp, 'b'); fs.mkdirSync(dB)
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const join = (dir, name) => startSync({ relay: wsUrl, room, dir, name, kind: 'ai', log: () => {} })
const markers = (s) => (s || '').includes('<<<<<<<')
const both = (file) => [read(path.join(dA, file)), read(path.join(dB, file))]
const normLF = (s) => (s || '').replace(/\r\n/g, '\n')
const allCRLF = (s) => s !== null && !/(^|[^\r])\n/.test(s)
const noCR = (s) => s !== null && !s.includes('\r')
const lines = (B, ...a) => (typeof B.editLines === 'function' ? B.editLines(...a) : { error: 'editLines does not exist' })

let A, B, mcp
try {
  A = join(dA, 'A'); B = join(dB, 'B')
  await sleep(2500)
  // A creates `file` with `text`, hands it over, and both folders hold it.
  const seed = async (file, text) => {
    A.claim(file, 'seed'); fs.writeFileSync(path.join(dA, file), text); await sleep(3000); A.release(file); await sleep(1500)
  }
  const aChanges = async (file, text) => {
    A.claim(file, 'change'); fs.writeFileSync(path.join(dA, file), text); await sleep(3000); A.release(file); await sleep(2000)
  }

  const V1 = 'export function total(subtotal) {\n  return subtotal\n}\n'
  const A_V = 'export function total(subtotal) {\n  return subtotal * 1.18 // A: tax\n}\n'
  const B_V = 'export function total(subtotal) {\n  return Math.round(subtotal * 1.18) // B: round\n}\n'

  console.log('\n# H1 clean handover, B says which lines it edited')
  await seed('checkout.js', V1)
  await aChanges('checkout.js', A_V)
  T('(control) B has A\'s edit on disk', read(path.join(dB, 'checkout.js')) === A_V)
  B.claim('checkout.js', 'rounding')
  const r1 = lines(B, 'checkout.js', '  return subtotal * 1.18 // A: tax', '  return Math.round(subtotal * 1.18) // B: round', 'rounding')
  await sleep(4000)
  T('H1 accepted', r1 && r1.ok === true && !r1.error, JSON.stringify(r1))
  T('H1 no markers, and B\'s version is in both folders', both('checkout.js').every((t) => t === B_V), JSON.stringify(both('checkout.js')))
  B.release('checkout.js'); await sleep(1500)

  console.log('\n# H2 B read the file before A changed it')
  await seed('stale.js', V1)
  const staleLine = '  return subtotal' // what B's agent read
  await aChanges('stale.js', A_V)
  B.claim('stale.js', 'fee')
  const r2 = lines(B, 'stale.js', staleLine, '  return subtotal + 5 // B: fee', 'fee')
  await sleep(3000)
  T('H2 refused', r2 && r2.ok !== true && !!r2.error, JSON.stringify(r2))
  T('H2 the refusal shows the line as it is now', r2 && /A: tax/.test(r2.error || ''), r2 && r2.error)
  T('H2 A\'s change is intact in both folders, no markers, no fee', both('stale.js').every((t) => t === A_V), JSON.stringify(both('stale.js')))
  B.release('stale.js'); await sleep(1500)

  console.log('\n# H3 part of a line')
  B.claim('checkout.js', 'partial')
  const r3 = lines(B, 'checkout.js', 'Math.round(subtotal * 1.18)', 'Math.ceil(subtotal * 1.18)', 'partial')
  await sleep(2500)
  T('H3 refused: old must be whole lines', r3 && r3.ok !== true && /whole line/i.test(r3.error || ''), JSON.stringify(r3))
  T('H3 nothing changed', both('checkout.js').every((t) => t === B_V))
  B.release('checkout.js'); await sleep(1000)

  console.log('\n# H4 old appears twice')
  const DUP = 'export function a() {\n  return 1\n}\nexport function b() {\n  return 1\n}\n'
  await seed('dup.js', DUP)
  B.claim('dup.js', 'dup')
  const r4 = lines(B, 'dup.js', '  return 1', '  return 2', 'dup')
  await sleep(2500)
  T('H4 refused, and it says how many times', r4 && r4.ok !== true && /2 times/.test(r4.error || ''), JSON.stringify(r4))
  T('H4 nothing changed', both('dup.js').every((t) => t === DUP))
  B.release('dup.js'); await sleep(1000)

  console.log('\n# H5 B has an unsent change on disk')
  const P = 'export const a = 1\nexport const b = 2\n'
  await seed('unsent.js', P)
  B.claim('unsent.js', 'two changes')
  // Written and, at once, edited through old/new: the watcher has not sent the first change yet.
  const first = 'export const a = 1 // B: first\nexport const b = 2\n'
  fs.writeFileSync(path.join(dB, 'unsent.js'), first)
  const r5 = lines(B, 'unsent.js', 'export const b = 2', 'export const b = 3 // B: second', 'second')
  T('H5 refused while the first change is unsent', r5 && r5.ok !== true && /retry/.test(r5.error || ''), JSON.stringify(r5))
  T('H5 ...and the refusal sent nothing: A does not have the first change yet', !(read(path.join(dA, 'unsent.js')) || '').includes('B: first') && read(path.join(dB, 'unsent.js')) === first)
  await sleep(3000)
  const r5b = lines(B, 'unsent.js', 'export const b = 2', 'export const b = 3 // B: second', 'second')
  await sleep(4000)
  T('H5 the retry lands', r5b && r5b.ok === true, JSON.stringify(r5b))
  T('H5 both of B\'s changes are in both folders', both('unsent.js').every((t) => (t || '').includes('B: first') && (t || '').includes('B: second') && !markers(t)), JSON.stringify(both('unsent.js')))
  B.release('unsent.js'); await sleep(1000)

  console.log('\n# H6 a key on B\'s disk was withheld from the room')
  const K = 'export const region = "eu"\nexport const retries = 2\n'
  await seed('keys.js', K)
  B.claim('keys.js', 'config')
  // Built at run time: a literal key in this file would hold the file itself out of the room.
  const withKey = K + `export const awsKey = "${'AKIA' + 'HIVECODETEST0001'}"\n`
  fs.writeFileSync(path.join(dB, 'keys.js'), withKey)
  await sleep(3000)
  T('(control) the key did not reach A', !(read(path.join(dA, 'keys.js')) || '').includes('AKIA'))
  const r6 = lines(B, 'keys.js', 'export const retries = 2', 'export const retries = 5', 'retries')
  await sleep(3000)
  T('H6 refused', r6 && r6.ok !== true && !!r6.error, JSON.stringify(r6))
  T('H6 B\'s own disk copy is untouched', read(path.join(dB, 'keys.js')) === withKey, JSON.stringify(read(path.join(dB, 'keys.js'))))
  fs.writeFileSync(path.join(dB, 'keys.js'), K); await sleep(2500)
  B.release('keys.js'); await sleep(1000)

  console.log('\n# H7 a stale old that does not overlap A\'s change')
  const TWO = 'export function tax(x) {\n  return x\n}\n\nexport function fee(x) {\n  return 0\n}\n'
  await seed('two.js', TWO)
  const staleFee = '  return 0' // B read this before A changed tax()
  await aChanges('two.js', TWO.replace('  return x\n', '  return x * 1.18 // A: tax\n'))
  B.claim('two.js', 'fee')
  const r7 = lines(B, 'two.js', staleFee, '  return 5 // B: fee', 'fee')
  await sleep(4000)
  T('H7 accepted', r7 && r7.ok === true, JSON.stringify(r7))
  T('H7 A\'s and B\'s changes are both in both folders, no markers', both('two.js').every((t) => (t || '').includes('A: tax') && (t || '').includes('B: fee') && !markers(t)), JSON.stringify(both('two.js')))
  B.release('two.js'); await sleep(1000)

  console.log('\n# H8 CRLF')
  const CR = 'line one\r\nline two\r\nline three\r\n'
  await seed('crlf.txt', CR)
  B.claim('crlf.txt', 'crlf')
  // Two lines given with LF on a CRLF file: only normalising old finds them, and only normalising new
  // keeps the file CRLF.
  const r8 = lines(B, 'crlf.txt', 'line one\nline two', 'line 1\nline 2 // B', 'crlf')
  await sleep(3500)
  T('H8 accepted', r8 && r8.ok === true, JSON.stringify(r8))
  const [t8A, t8B] = both('crlf.txt')
  T('H8 file text matches, endings kept per-disk (A all-CRLF, B no CR)', normLF(t8A) === normLF(t8B) && normLF(t8A) === 'line 1\nline 2 // B\nline three\n' && allCRLF(t8A) && noCR(t8B) && !markers(t8A) && !markers(t8B), JSON.stringify([t8A, t8B]))
  B.release('crlf.txt'); await sleep(1000)

  console.log('\n# H9 no-ops and missing files')
  B.claim('checkout.js', 'noop')
  const r9 = lines(B, 'checkout.js', '  return Math.round(subtotal * 1.18) // B: round', '  return Math.round(subtotal * 1.18) // B: round', 'noop')
  T('H9 old equal to new is reported as a no-op', r9 && r9.noop === true, JSON.stringify(r9))
  B.release('checkout.js')
  const r9b = lines(B, 'nope.js', 'a', 'b', 'missing')
  T('H9 a file not in the room is refused', r9b && r9b.ok !== true && !!r9b.error, JSON.stringify(r9b))
  const r9c = lines(B, 'checkout.js', '', 'x', 'empty')
  T('H9 an empty old is refused', r9c && r9c.ok !== true && !!r9c.error, JSON.stringify(r9c))

  console.log('\n# H10 trailing line breaks and deletes')
  await seed('nl.js', 'a\nb\nc\n')
  B.claim('nl.js', 'nl')
  const s10 = []
  s10.push(lines(B, 'nl.js', 'b\n', 'B', 'break on old only')); await sleep(2500)
  T('H10 old "b\\n" + new "B" keeps c on its own line', both('nl.js').every((t) => t === 'a\nB\nc\n'), JSON.stringify(both('nl.js')))
  s10.push(lines(B, 'nl.js', 'B', 'BB\n', 'break on new only')); await sleep(2500)
  T('H10 old "B" + new "BB\\n" adds no blank line', both('nl.js').every((t) => t === 'a\nBB\nc\n'), JSON.stringify(both('nl.js')))
  s10.push(lines(B, 'nl.js', 'BB', '', 'delete')); await sleep(2500)
  T('H10 an empty new deletes the line, leaving no blank line', both('nl.js').every((t) => t === 'a\nc\n'), JSON.stringify(both('nl.js')))
  s10.push(lines(B, 'nl.js', 'c', '', 'delete the last line')); await sleep(2500)
  T('H10 deleting the last line leaves the rest as it was', both('nl.js').every((t) => t === 'a\n'), JSON.stringify(both('nl.js')))
  T('H10 (all four accepted)', s10.every((r) => r && r.ok === true), JSON.stringify(s10))
  B.release('nl.js'); await sleep(1000)

  console.log('\n# H15 line-break edges (antigravity-3, 1 Nov)')
  await seed('eof.js', 'const a = 1\nconst b = 2\n')
  B.claim('eof.js', 'eof')
  const r15a = lines(B, 'eof.js', 'const b = 2\n\n', '', 'old claims a blank line after b that is not there')
  await sleep(2500)
  T('H15 an old ending in a blank line that is not there is refused', r15a && r15a.ok !== true, JSON.stringify(r15a))
  T('H15 ...and the line before keeps its break', both('eof.js').every((t) => t === 'const a = 1\nconst b = 2\n'), JSON.stringify(both('eof.js')))
  const r15b = lines(B, 'eof.js', 'const a = 1\n', '\n', 'blank it')
  await sleep(2500)
  T('H15 new "\\n" leaves a blank line; it does not delete the line', r15b && r15b.ok === true && both('eof.js').every((t) => t === '\nconst b = 2\n'), JSON.stringify([r15b, both('eof.js')]))
  B.release('eof.js'); await sleep(1000)
  await seed('crlf2.js', 'const a = 1\r\nconst b = 2\r\n')
  B.claim('crlf2.js', 'cr')
  const r15c = lines(B, 'crlf2.js', 'const a = 1\r', 'const a = 9', 'old ends inside a CRLF')
  await sleep(2500)
  const [t15A, t15B] = both('crlf2.js')
  T('H15 an old ending between \\r and \\n is refused, and endings stay per-disk (A all-CRLF, B no CR)', r15c && r15c.ok !== true && normLF(t15A) === normLF(t15B) && normLF(t15A) === 'const a = 1\nconst b = 2\n' && allCRLF(t15A) && noCR(t15B), JSON.stringify([r15c, both('crlf2.js')]))
  B.release('crlf2.js'); await sleep(1000)

  // H16: the EDITING agent's own disk is CRLF (any Windows checkout under core.autocrlf=true). The
  // room holds LF, so a raw disk read never equals the room's copy and every old/new edit was refused
  // as "changes the room has not taken yet" (8 Nov, found applying item2 onto 0.14.1).
  console.log('\n# H16 the editor\'s own disk is CRLF')
  B.claim('crlf3.txt', 'crlf on my disk')
  fs.writeFileSync(path.join(dB, 'crlf3.txt'), 'alpha\r\nbeta\r\ngamma\r\n')
  await sleep(3500)
  T('(H16 setup) A has the file, B\'s disk is CRLF', normLF(read(path.join(dA, 'crlf3.txt'))) === 'alpha\nbeta\ngamma\n' && allCRLF(read(path.join(dB, 'crlf3.txt'))))
  const r16 = lines(B, 'crlf3.txt', 'beta', 'BETA // B', 'crlf editor')
  await sleep(3500)
  T('H16 accepted', r16 && r16.ok === true, JSON.stringify(r16))
  const [t16A, t16B] = both('crlf3.txt')
  T('H16 both folders hold the edit, B\'s disk stays CRLF, no markers', normLF(t16A) === 'alpha\nBETA // B\ngamma\n' && normLF(t16B) === normLF(t16A) && allCRLF(t16B) && !markers(t16A) && !markers(t16B), JSON.stringify([t16A, t16B]))
  B.release('crlf3.txt'); await sleep(1000)

  console.log('\n# H11 someone else holds the file')
  A.claim('checkout.js', 'A is working on it'); await sleep(1500)
  const r11 = lines(B, 'checkout.js', '  return Math.round(subtotal * 1.18) // B: round', '  return 0 // B: while A holds it', 'sneak')
  await sleep(2500)
  T('H11 refused, naming the holder', r11 && r11.ok !== true && /\bA holds\b/.test(r11.error || ''), JSON.stringify(r11))
  T('H11 nothing changed', both('checkout.js').every((t) => t === B_V), JSON.stringify(both('checkout.js')))
  A.release('checkout.js'); await sleep(1000)

  console.log('\n# H12 in the room but not loaded here')
  for (let i = 1; i <= 4; i++) await seed(`lazy${i}.js`, 'export const v = 1\n')
  const dC = path.join(tmp, 'c'); fs.mkdirSync(dC)
  process.env.HIVE_MAX_OPEN_FILES = '1'
  const C = join(dC, 'C')
  delete process.env.HIVE_MAX_OPEN_FILES
  await sleep(4000)
  let lazy = null, r12 = null
  for (let i = 1; i <= 4 && !lazy; i++) { const r = lines(C, `lazy${i}.js`, 'export const v = 1', 'export const v = 2 // C', 'lazy'); if (r && r.loading) { lazy = `lazy${i}.js`; r12 = r } }
  T('(setup) C has a room file it has not loaded', !!lazy)
  T('H12 it says loading and retry, and never to write it with content', r12 && r12.ok !== true && /loading/.test(r12.error || '') && !/Create it with content/.test(r12.error || ''), JSON.stringify(r12))
  await sleep(4000)
  const r12b = lazy ? lines(C, lazy, 'export const v = 1', 'export const v = 2 // C', 'lazy') : null
  await sleep(3000)
  T('H12 the retry lands in the room', r12b && r12b.ok === true && (read(path.join(dA, lazy)) || '').includes('// C'), JSON.stringify(r12b))
  try { C.stop() } catch { }

  console.log('\n# H13 not connected')
  relay.kill(); await sleep(2500)
  const r13 = lines(B, 'checkout.js', '  return Math.round(subtotal * 1.18) // B: round', '  return 1 // B: offline', 'offline')
  T('H13 refused while not connected', r13 && r13.ok !== true && /not connected/.test(r13.error || ''), JSON.stringify(r13))
  T('H13 nothing written to B\'s disk', read(path.join(dB, 'checkout.js')) === B_V)
  relay = await startRelay()

  console.log('\n# M1 through the MCP tool')
  for (const c of [A, B]) { try { c.stop() } catch { } }
  A = B = null
  const dM = path.join(tmp, 'm'); fs.mkdirSync(dM)
  mcp = spawn(process.execPath, ['hive-mcp.js'], { env: { ...process.env, HIVE_RELAY: wsUrl } })
  let buf = ''; const pending = new Map(); let nextId = 1
  mcp.stdout.on('data', (d) => {
    buf += d.toString(); let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  const call = async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { text: ((r.result && r.result.content) || [{}])[0].text || JSON.stringify(r.error || r.result), isError: !!(r.result && r.result.isError) } }
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  await call('hive_join', { dir: dM, name: 'M' })
  await sleep(1500)
  await call('hive_claim', { region: 'm.js' })
  await call('hive_edit', { file: 'm.js', content: 'export const x = 1\nexport const y = 2\n', intent: 'seed' })
  await sleep(1500)
  const m1 = await call('hive_edit', { file: 'm.js', old: 'export const y = 2', new: 'export const y = 3', intent: 'bump y' })
  T('M1 old/new through the tool lands', !m1.isError && read(path.join(dM, 'm.js')) === 'export const x = 1\nexport const y = 3\n', JSON.stringify(m1))
  const m2 = await call('hive_edit', { file: 'm.js', old: 'export const y = 2', new: 'export const y = 4', intent: 'stale' })
  T('M1 a stale old is an error that says nothing was written', m2.isError && /nothing was written/i.test(m2.text) && read(path.join(dM, 'm.js')).includes('y = 3'), JSON.stringify(m2))
  // old is valid here, so only the "one mode at a time" rule can refuse it.
  const m3 = await call('hive_edit', { file: 'm.js', content: 'x', old: 'export const x = 1', new: 'export const x = 9' })
  T('M1 content together with old/new is refused, not guessed', m3.isError && read(path.join(dM, 'm.js')) === 'export const x = 1\nexport const y = 3\n', JSON.stringify(m3))

  console.log('\n# M2 a refused old/new keeps the PUBLISH lease')
  await call('hive_set_state', { key: 'M_status', val: 'PUBLISH:1' })
  await sleep(500)
  const m4 = await call('hive_edit', { file: 'm.js', old: 'export const y = 2', new: 'export const y = 5', intent: 'stale, refused' })
  const st1 = (await call('hive_read_state', {})).text
  T('M2 the refused edit did not spend the lease', m4.isError && /M_status\W+PUBLISH:1/.test(st1), JSON.stringify({ m4: m4.text.slice(0, 80), st1: st1.slice(0, 300) }))
  const m5 = await call('hive_edit', { file: 'm.js', old: 'export const y = 3', new: 'export const y = 6', intent: 'lands' })
  const st2 = (await call('hive_read_state', {})).text
  T('M2 a landed edit spends it', !m5.isError && read(path.join(dM, 'm.js')).includes('y = 6') && /M_status\W+LOCKED/.test(st2), JSON.stringify({ m5: m5.text.slice(0, 80), st2: st2.slice(0, 300) }))
} catch (e) {
  console.log('  FAIL (threw) ' + (e && e.stack || e)); fail++
} finally {
  for (const c of [A, B]) { try { c && c.stop() } catch { } }
  try { mcp && mcp.kill() } catch { }
  relay.kill()
  console.log(`\n=== OLD/NEW EDITS: CLEAN HANDOVERS LAND, STALE ONES ARE REFUSED: ${pass} passed, ${fail} failed ===`)
  setTimeout(() => process.exit(fail ? 1 : 0), 300)
}
