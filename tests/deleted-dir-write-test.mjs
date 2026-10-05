// A peer's file must land on disk even after its folder was deleted here.
//
//   node tests/deleted-dir-write-test.mjs
//
// writeToDisk remembers which folders it already made (ensuredDirs) so a big join skips thousands
// of mkdir calls. The cache must never cost a write: if someone deletes or renames a folder after
// the engine made it, the next file a peer sends into that folder has to arrive anyway. Without
// the retry, writeFileSync throws ENOENT and the file silently never reaches this folder.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (24200 + (process.pid % 17000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const thrown = []
process.on('uncaughtException', (e) => thrown.push(String(e && e.message || e)))

async function until(pred, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await sleep(250) }
  return pred()
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-deldir-'))
const room = 'dd-' + crypto.randomBytes(5).toString('hex')
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
const dirA = path.join(tmp, 'a'), dirB = path.join(tmp, 'b')
for (const d of [dirA, dirB]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules/\n') }

let A, B
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirA, name: 'A', kind: 'ai', log: () => {} })
  B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirB, name: 'B', kind: 'ai', log: () => {} })
  await sleep(4000)

  const ONE = 'export const one = 1\n', TWO = 'export const two = 2\n'
  fs.mkdirSync(path.join(dirA, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dirA, 'lib', 'one.js'), ONE)
  T('1 a file in a new folder reaches the peer', await until(() => read(path.join(dirB, 'lib', 'one.js')) === ONE, 20000))

  fs.rmSync(path.join(dirB, 'lib'), { recursive: true, force: true }) // the peer reorganises: the whole folder goes
  await until(() => read(path.join(dirA, 'lib', 'one.js')) === null, 15000)

  fs.writeFileSync(path.join(dirA, 'lib', 'two.js'), TWO)
  T('2 a later file in the SAME folder still reaches the peer', await until(() => read(path.join(dirB, 'lib', 'two.js')) === TWO, 20000),
    `on disk: ${JSON.stringify(read(path.join(dirB, 'lib', 'two.js')))}`)
  T('3 no client threw', thrown.length === 0, thrown.slice(0, 2).join(' | '))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  try { A && A.stop() } catch { }
  try { B && B.stop() } catch { }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}

console.log(`\n=== DELETED-FOLDER WRITE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
