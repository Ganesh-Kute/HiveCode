// IGNORE MUST STOP THE CONNECTION, not just the write.
//
// Hivecode opens one WebSocket PER FILE. On join, sync.js walked the room's manifest and
// opened a file-room for every path the TOKEN allowed (`canOpen`) -- it never asked whether
// this client had excluded that path. So a participant could not bound its own footprint.
//
// On 18 Sep 2026 that cost the whole run: two agents had their .gitignore narrowed to 35
// paths and kept opening demo/** file rooms anyway, consuming the relay's entire
// 512-connection budget between them and locking everyone else out (38,011 Q430 refusals).
//
// Excluding a file already stopped it being written to disk -- reconcile() checked
// isIgnored(). What it did NOT do was stop it costing a socket, which is the only resource
// that was actually running out. So this test measures CONNECTIONS, not files on disk. A
// test that only checked the disk would have passed before the fix.
//
// Self-calibrating: the same scenario runs twice, once ignoring nothing and once ignoring one
// file, and the assertion is on the DIFFERENCE. That way it does not depend on how many
// housekeeping files the engine happens to open.
//
//   node tests/ignore-opens-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'; import os from 'os'; import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'
// PINNED TO THE PER-FILE TRANSPORT (HIVE_MUX=0). What this suite measures is the arithmetic of one
// socket PER FILE, which the VS Code extension, the browser panel and every older relay still
// speak. A client on one-socket mode holds 2 sockets whatever its file count; its own ceilings
// and refusals are asserted in tests/mux-test.mjs.
process.env.HIVE_MUX = '0'

// pid-derived: this suite runs as a room gate, so two agents may run it at the same
// moment. A fixed port means one fails to bind and the gate refuses a handoff for a
// reason that has nothing to do with the code under test.
const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-ignoreopen-'))
// Persistence matters: the measurement below requires A to be GONE while B joins, so that the
// relay's connection count is B's alone. Without persistence the room would evaporate with its
// last client and B would arrive to an empty manifest, which is not the case under test.
const persist = path.join(tmp, 'persist'); fs.mkdirSync(persist, { recursive: true })

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: persist },
  })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
const wsUrl = `ws://localhost:${PORT}`
const conns = async () => (await (await fetch(`http://localhost:${PORT}/health`)).json()).connections
const FILES = ['keep.js', 'also-keep.js', 'skip.js']

// One scenario: A publishes three files, then B joins with `ignore` in its .gitignore.
// Returns how many connections B's arrival cost, plus what landed on B's disk.
async function scenario(label, ignore) {
  const room = 'ign-' + crypto.randomBytes(6).toString('hex')
  const dA = path.join(tmp, label + '-a'); fs.mkdirSync(dA, { recursive: true })
  const dB = path.join(tmp, label + '-b'); fs.mkdirSync(dB, { recursive: true })
  for (const f of FILES) fs.writeFileSync(path.join(dA, f), `export const n = '${f}'\n`)
  // BOTH scenarios write a .gitignore, even the one that ignores nothing. The file is itself
  // synced, so it costs a socket; giving it to only one side masks exactly the saving this
  // test is measuring. (First version of this test did that and reported no difference.)
  fs.writeFileSync(path.join(dB, '.gitignore'), ignore ? ignore + '\n' : '# nothing ignored\n')

  const A = startSync({ relay: wsUrl, room, dir: dA, name: 'A', kind: 'ai', log: () => {} })
  await sleep(7000) // let A publish all three
  // A LEAVES before B arrives. This is the whole point of the measurement: while A is
  // connected it holds a socket per file itself and reacts to B's .gitignore by closing
  // some of its own, so a global connection count reflects A's behaviour as much as B's.
  // With A gone, every connection that appears is one B opened.
  try { A.stop() } catch { }
  await sleep(4000)

  const before = await conns()
  const B = startSync({ relay: wsUrl, room, dir: dB, name: 'B', kind: 'ai', log: () => {} })
  await sleep(7000)
  const cost = (await conns()) - before

  const onDisk = FILES.filter((f) => fs.existsSync(path.join(dB, f)))
  try { B.stop() } catch { }
  await sleep(1500)
  return { cost, onDisk }
}

const open = await scenario('open', '')          // B excludes nothing
const narrowed = await scenario('narrow', 'skip.js') // B excludes one of the three

console.log(`\n  B cost ${open.cost} connections with nothing ignored, ${narrowed.cost} with skip.js ignored\n`)

// At least one fewer, not exactly one: the .gitignore is itself a synced file, so A receives
// it, honours it, and closes its own socket for that path too. The saving compounds across
// peers, which is the behaviour we want and the reason not to pin an exact number here.
T('A1 ignoring a file costs FEWER connections', narrowed.cost < open.cost)
T('A2 the baseline client really did open the file rooms', open.cost >= 3)
T('B1 the ignored file is not written to disk', !narrowed.onDisk.includes('skip.js'))
T('B2 the files it did NOT ignore still arrive', narrowed.onDisk.includes('keep.js') && narrowed.onDisk.includes('also-keep.js'))
T('B3 without an ignore rule, all three arrive (the rule is what changed it)', open.onDisk.length === 3)

relay.kill()
console.log(`\n=== IGNORE OPENS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
