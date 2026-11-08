// Line endings are not content: a Windows peer (CRLF on disk) and a Mac/Linux peer (LF) share
// files without conflict markers, and each disk keeps its own endings.
//
//   node tests/eol-mixed-peers-test.mjs
//
// WHY (8 Nov 2026). Git for Windows ships core.autocrlf=true: the repo stores LF and a Windows
// checkout writes CRLF (measured on the dev PC: sync.js has 4,992 CRs on disk, 0 in git). So two
// founders who clone the same repo and join one room hold the same text with different bytes on
// every line. A CRLF copy written over the room's LF copy of hive-github.js put the WHOLE file in
// conflict markers on every peer, and the two sides were byte-identical. That is the first thing an
// early-access founder on Windows would see.
//
//   E1  same text, different endings, both already on disk at join: no markers anywhere, each disk
//       byte-identical to what it was, the room holds no CR
//   E2  the CRLF peer edits one line: the LF peer gets that line, and stays all-LF
//   E3  the LF peer edits one line: the CRLF peer gets it, and stays all-CRLF (no mixed endings)
//   E4  both edit different lines at once: both edits on both disks, no markers, endings kept
//   E5  the CRLF peer rewrites the whole file with the same text in CRLF (the hive-github.js case):
//       nothing changes for the LF peer, no markers
//   E6  a brand-new file from the CRLF peer reaches the LF peer as LF
//   E7  a lone CR inside a line is content, and survives the round trip byte for byte
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${!c && extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const thrown = []
process.on('uncaughtException', (e) => thrown.push(String(e && e.message || e)))
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
async function until(pred, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await sleep(200) }
  return pred()
}
const read = (p) => { try { return fs.readFileSync(p, 'latin1') } catch { return null } }
const CRLF = (s) => s.replace(/\r?\n/g, '\r\n')
const markers = (s) => /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(s || '')
const allCRLF = (s) => s !== null && !/(^|[^\r])\n/.test(s)
const noCR = (s) => s !== null && !s.includes('\r')
const show = (s) => JSON.stringify(s === null ? null : s.slice(0, 160))

const LINES = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i}`)
const LF_TEXT = LINES.join('\n') + '\n'
const CRLF_TEXT = CRLF(LF_TEXT)

const PORT = await freePort()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-eol-'))
const room = 'eol-' + crypto.randomBytes(5).toString('hex')
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
const dirMac = path.join(tmp, 'mac'), dirWin = path.join(tmp, 'win')
for (const d of [dirMac, dirWin]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules/\n') }
// Both founders cloned the same repo: same text, git gave the Windows one CRLF.
fs.writeFileSync(path.join(dirMac, 'app.js'), LF_TEXT)
fs.writeFileSync(path.join(dirWin, 'app.js'), CRLF_TEXT)
const LONE = 'const sep = "a\rb"\nconst x = 1\n' // a real CR inside a string literal
fs.writeFileSync(path.join(dirMac, 'lone.js'), LONE)

let mac, win
const roomText = (who, rel) => { try { const fe = who.doc && who.fileText ? who.fileText(rel) : null; return fe } catch { return null } }
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  mac = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirMac, name: 'Mac', kind: 'ai', log: () => {} })
  await sleep(2500)
  win = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirWin, name: 'Win', kind: 'ai', log: () => {} })
  await sleep(5000)

  const pMac = path.join(dirMac, 'app.js'), pWin = path.join(dirWin, 'app.js')
  // E1
  T('E1 no conflict markers on the LF disk', !markers(read(pMac)), show(read(pMac)))
  T('E1 no conflict markers on the CRLF disk', !markers(read(pWin)), show(read(pWin)))
  T('E1 the LF disk is byte-identical to before', read(pMac) === LF_TEXT, show(read(pMac)))
  T('E1 the CRLF disk is byte-identical to before', read(pWin) === CRLF_TEXT, show(read(pWin)))

  // E2: the Windows founder edits line 3 (their editor keeps CRLF)
  const winEdit = CRLF(LF_TEXT.replace('v3 = 3', 'v3 = 33'))
  fs.writeFileSync(pWin, winEdit)
  const e2 = await until(() => (read(pMac) || '').includes('v3 = 33'), 15000)
  T('E2 the CRLF edit reaches the LF peer', e2, show(read(pMac)))
  T('E2 the LF peer stays all-LF', noCR(read(pMac)), show(read(pMac)))
  T('E2 no markers anywhere', !markers(read(pMac)) && !markers(read(pWin)))
  T('E2 the CRLF disk still holds exactly what its author wrote', read(pWin) === winEdit, show(read(pWin)))

  // E3: the Mac founder edits line 8
  await sleep(1500)
  const macNow = read(pMac)
  fs.writeFileSync(pMac, macNow.replace('v8 = 8', 'v8 = 88'))
  const e3 = await until(() => (read(pWin) || '').includes('v8 = 88'), 15000)
  T('E3 the LF edit reaches the CRLF peer', e3, show(read(pWin)))
  T('E3 the CRLF peer stays all-CRLF (no mixed endings)', allCRLF(read(pWin)), show(read(pWin)))
  T('E3 no markers anywhere', !markers(read(pMac)) && !markers(read(pWin)))

  // E4: both at once, different lines
  await sleep(1500)
  fs.writeFileSync(pMac, read(pMac).replace('v0 = 0', 'v0 = 100'))
  fs.writeFileSync(pWin, read(pWin).replace('v11 = 11', 'v11 = 111'))
  const e4 = await until(() => ['v0 = 100', 'v11 = 111'].every((s) => (read(pMac) || '').includes(s) && (read(pWin) || '').includes(s)), 20000)
  T('E4 both concurrent edits land on both disks', e4, `mac=${show(read(pMac))} win=${show(read(pWin))}`)
  T('E4 no markers anywhere', !markers(read(pMac)) && !markers(read(pWin)))
  T('E4 endings kept (LF peer no CR, CRLF peer all CRLF)', noCR(read(pMac)) && allCRLF(read(pWin)))

  // E5: the Windows side rewrites the whole file, same text, CRLF (what a cp of a git checkout does)
  await sleep(1500)
  const macBefore = read(pMac)
  fs.writeFileSync(pWin, CRLF(macBefore))
  await sleep(4000)
  T('E5 a CRLF rewrite of the same text changes nothing on the LF disk', read(pMac) === macBefore, show(read(pMac)))
  T('E5 no markers anywhere', !markers(read(pMac)) && !markers(read(pWin)))

  // E6: a new file from the Windows side
  fs.writeFileSync(path.join(dirWin, 'new.js'), CRLF('const a = 1\nconst b = 2\n'))
  const e6 = await until(() => read(path.join(dirMac, 'new.js')) !== null, 15000)
  T('E6 a new CRLF file reaches the LF peer', e6)
  T('E6 ... as LF', read(path.join(dirMac, 'new.js')) === 'const a = 1\nconst b = 2\n', show(read(path.join(dirMac, 'new.js'))))

  // E8: today's hive-github.js case. At the same moment, the Windows side rewrites the file with the
  // same text in CRLF, and the Mac side changes one line. Before the fix the CRLF side changed EVERY
  // line against the base and the Mac side changed one: overlapping edits, whole-file markers.
  await sleep(2000)
  const base8 = read(pMac)
  fs.writeFileSync(pWin, CRLF(base8))
  fs.writeFileSync(pMac, base8.replace('v6 = 6', 'v6 = 66'))
  const e8 = await until(() => (read(pWin) || '').includes('v6 = 66') && (read(pMac) || '').includes('v6 = 66'), 20000)
  await sleep(2000)
  T('E8 the one-line edit lands on both disks', e8, `mac=${show(read(pMac))} win=${show(read(pWin))}`)
  T('E8 no conflict markers on either disk (the hive-github.js case)', !markers(read(pMac)) && !markers(read(pWin)), `mac=${show(read(pMac))}`)

  // E7: the lone CR
  const e7 = await until(() => read(path.join(dirWin, 'lone.js')) !== null, 15000)
  T('E7 a file with a lone CR reaches the other peer', e7)
  const winLone = read(path.join(dirWin, 'lone.js'))
  T('E7 the lone CR survives, and the line ends are the receiving disk\'s', winLone !== null && winLone.includes('"a\rb"'), show(winLone))
  T('no client threw', thrown.length === 0, thrown.slice(0, 2).join(' | '))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { mac && mac.stop() } catch { }
  try { win && win.stop() } catch { }
  try { relay.kill() } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
