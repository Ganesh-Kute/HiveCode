// INDEPENDENT PROBE of the HIV-P9 first-contact refusal. Not a repo test — Antigravity1 is
// extending tests/rejoin-clobber-test.mjs and I am not going to collide with it. Two independent
// verifications of a safety path are worth more than one, and this one asserts on BYTES rather
// than on the source text of sync.js.
//
// THE CASE: a client joins a room where the path already exists with DIFFERENT content, and the
// client has NO prior shadow for it (genuine first contact — a clone-then-join). Before ab8ca44
// this adopted the room's copy over local disk. ab8ca44 replaced that with an empty-base merge,
// which concatenated both copies into something that did not parse. The refusal must leave BOTH
// sides exactly as they were.

import { spawn, execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'

const PORT = 21000 + (process.pid % 9000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-probe-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', () => {})
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'fc-' + crypto.randomBytes(5).toString('hex')
const dirA = path.join(tmp, 'a'), dirB = path.join(tmp, 'b')
fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })

// Two genuinely different, individually-valid files at the same path.
const ROOM_TEXT = 'export function alpha() {\n  return 1\n}\n'
const DISK_TEXT = 'export function beta() {\n  return 2\n}\nexport const extra = 3\n'

fs.writeFileSync(path.join(dirA, 'shared.js'), ROOM_TEXT)
let A, B
const said = []
try {
  A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirA, name: 'A', kind: 'ai', log: () => {} })
  await sleep(2500)

  // B joins with DIFFERENT content and no ancestor for it — first contact.
  fs.writeFileSync(path.join(dirB, 'shared.js'), DISK_TEXT)
  B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirB, name: 'B', kind: 'ai', log: (m) => said.push(String(m)) })
  await sleep(4000)

  const bDisk = fs.readFileSync(path.join(dirB, 'shared.js'), 'utf8')
  const aDisk = fs.readFileSync(path.join(dirA, 'shared.js'), 'utf8')

  T('1 B\'s local file was NOT overwritten by the room copy', bDisk === DISK_TEXT,
    bDisk === DISK_TEXT ? '' : `got ${bDisk.split('\n').length} lines`)
  T('2 B\'s file was NOT concatenated with the room copy',
    !(bDisk.includes('alpha') && bDisk.includes('beta')),
    bDisk.includes('alpha') && bDisk.includes('beta') ? 'BOTH COPIES PRESENT — the empty-base merge bug' : '')
  T('3 no conflict markers were written into B\'s file', !/<<<<<<</.test(bDisk))
  T('4 B\'s file still parses', (() => {
    const p = path.join(tmp, 'chk.mjs'); fs.writeFileSync(p, bDisk)
    try { execSync(`node --check "${p}"`, { stdio: 'pipe' }); return true } catch { return false }
  })())
  T('5 A (the room side) was NOT corrupted by B joining', aDisk === ROOM_TEXT,
    aDisk === ROOM_TEXT ? '' : `A's disk changed: ${aDisk.split('\n').length} lines`)

  const chat = (A.doc ? A.doc.getArray('chat').toArray() : []).map((m)=>String(m&&m.text||''))
  T('6 the refusal was ANNOUNCED, not silent', [...said, ...chat].some((m) => /NOT adopted|refus/i.test(m)),
    said.filter((m) => /shared\.js/.test(m)).slice(0, 2).join(' | ').slice(0, 160))
} catch (e) {
  T('the probe ran', false, e && e.stack ? e.stack.split('\n').slice(0, 2).join(' | ') : String(e))
} finally {
  try { A && A.stop() } catch {}
  try { B && B.stop() } catch {}
  try { relay.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== FIRST-CONTACT REFUSAL PROBE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
