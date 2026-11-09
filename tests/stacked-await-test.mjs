// tests/stacked-await-test.mjs -- P0-5-3: two peers making the SAME sync -> async change at once.
//
// Each peer's write is right on its own: `return f()` -> `return await f()`. Both inserts land at the
// same place in the shared text, which keeps both: the room read `return await await f()` (server.js
// had `return await await await admitMux(req, q)`, 9 Nov). No merge can prevent it, so the engine
// removes the outer await afterwards (sync.js dropStackedAwaits, lang-js stackedAwaits).
//
//   A1-A6 stackedAwaits on its own: what it removes and what it never touches
//   B1    two peers write the identical upgrade in the same tick: the room and both folders end
//         with exactly ONE await (not two, and not zero: the two removals are of the same chars)
//   B2    a comment that quotes "await await" is left alone, in the room and on disk
//   B3    `await (await x)` written on purpose is left alone

import { spawn } from 'child_process'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

console.log('\n# A. stackedAwaits')
for (const where of ['', 'packages/icr-merge/']) {
  const { javascript: L } = await import(pathToFileURL(path.join(ROOT, where, 'lang-js.js')).href)
  const cut = (src) => { let out = src; for (const [a, b] of [...L.stackedAwaits(src)].reverse()) out = out.slice(0, a) + out.slice(b); return out }
  const tag = where ? ' (package copy)' : ''
  T(`A1 \`await await f()\` loses the outer await${tag}`, cut('async function g() { return await await f() }') === 'async function g() { return await f() }')
  T(`A2 three stacked become one${tag}`, cut('async function g() { return await await await f() }') === 'async function g() { return await f() }')
  T(`A3 \`await (await f())\` is left alone${tag}`, L.stackedAwaits('async function g() { return await (await f()) }').length === 0)
  T(`A4 a comment or a string saying "await await" is left alone${tag}`, L.stackedAwaits('// await await f()\nconst s = "await await"\n').length === 0)
  T(`A5 a single await is left alone${tag}`, L.stackedAwaits('async function g() { const x = await f(); return x }').length === 0)
  T(`A6 text that does not parse gives nothing${tag}`, L.stackedAwaits('async function g( { await await').length === 0)
}

// ---- B: the race, with a real relay and two real sync clients -------------------------------------
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const { startSync } = await import(pathToFileURL(path.join(ROOT, 'sync.js')).href)
const port = await freePort()
const relay = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), HIVE_PERSIST_DIR: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('relay start timeout')), 8000)
  relay.stdout.on('data', (d) => { if (/listening on/.test(d)) { clearTimeout(t); resolve() } })
})
const URL_ = `ws://127.0.0.1:${port}`
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `hive-stacked-${tag}-`))
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = fn(); if (v) return v } catch { } await sleep(100) } try { return fn() } catch { return false } }
const live = []
const join = (room, dir, name) => { const h = startSync({ relay: URL_, room, dir, name, kind: 'ai', log: () => { } }); live.push(h); return h }

// f is already async in the base: what the two peers both insert is only the `await ` (as the ICR
// upgrade does on each peer). Both inserting `async ` too would be a different, unparseable union.
const BASE = 'async function f() { return 1 }\n// a note: never write await await by hand\nconst s = "await await"\nexport async function g() {\n  const r = f()\n  return r\n}\n'
const UPGRADED = BASE.replace('  const r = f()', '  const r = await f()')

try {
  console.log('\n# B. two peers, the same upgrade, the same tick')
  const room = 'room-stacked-b', dA = tmp('a'), dB = tmp('b')
  fs.writeFileSync(path.join(dA, 'm.js'), BASE)
  const A = join(room, dA, 'peer-a')
  await until(() => A.provider.synced)
  const B = join(room, dB, 'peer-b')
  await until(() => B.provider.synced)
  T('B0 setup: both folders hold the base', !!(await until(() => readOr(path.join(dB, 'm.js')) === BASE)))
  await sleep(800)
  // Same content, same tick: neither has the other's insert when it makes its own.
  const ra = A.edit('m.js', UPGRADED, 'f is async now')
  const rb = B.edit('m.js', UPGRADED, 'f is async now')
  T('B0 both writes were accepted', ra && ra.ok && rb && rb.ok, JSON.stringify({ ra, rb }))
  const settled = await until(() => {
    const a = readOr(path.join(dA, 'm.js')), b = readOr(path.join(dB, 'm.js'))
    return a === UPGRADED && b === UPGRADED && A._fileText('m.js') === UPGRADED && B._fileText('m.js') === UPGRADED
  }, 20000)
  const a = readOr(path.join(dA, 'm.js')), b = readOr(path.join(dB, 'm.js'))
  T('B1 the room and both folders end with exactly one await on the call', !!settled,
    JSON.stringify({ a: (a || '').split('\n')[4], b: (b || '').split('\n')[4], room: (A._fileText('m.js') || '').split('\n')[4] }))
  T('B1 ...and neither has lost it (two removals of the same characters remove them once)', (a || '').includes('const r = await f()') && (b || '').includes('const r = await f()'))
  T('B2 the comment and the string that say "await await" are untouched', (a || '').includes('// a note: never write await await by hand') && (a || '').includes('const s = "await await"'))

  console.log('\n# B3 written on purpose')
  const ON_PURPOSE = 'export async function h(p) {\n  return await (await p)\n}\n'
  const r3 = A.edit('n.js', ON_PURPOSE, 'on purpose')
  T('B3 setup: written', r3 && r3.ok, JSON.stringify(r3))
  T('B3 `await (await p)` reaches the peer unchanged', !!(await until(() => readOr(path.join(dB, 'n.js')) === ON_PURPOSE)), JSON.stringify(readOr(path.join(dB, 'n.js'))))
} catch (e) {
  fail++; console.log(`  FAIL the suite ran: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`)
} finally {
  for (const h of live) { try { h.stop() } catch { } }
  try { relay.kill('SIGKILL') } catch { }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
