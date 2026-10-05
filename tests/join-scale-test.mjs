// tests/join-scale-test.mjs — Verify a 900-file room connects and syncs well inside the 8s joinRoom cap
//
// Proof requirement (Finding 3):
// 1. A room holding 900 files must emit provider 'sync' in < 8000ms (the hive_join timeout).
// 2. Joining must not freeze the event loop or cause false "not synced" timeouts.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.HIVE_TEST_PORT) || (24200 + (process.pid % 12000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-join-scale-'))
const room = 'scale-' + crypto.randomBytes(5).toString('hex')
const seedDir = path.join(tmp, 'seed')
fs.mkdirSync(seedDir, { recursive: true })

const NUM_FILES = 900
console.log(`=== JOIN SCALE TEST: 900 files inside the 8s cap ===`)
console.log(`Generating ${NUM_FILES} seed files...`)
for (let i = 0; i < NUM_FILES; i++) {
  const sub = path.join(seedDir, `d_${i % 30}`)
  if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, `f_${String(i).padStart(4, '0')}.js`), `export const v${i} = ${i};\n`)
}

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_FREE_MSG_BURST: '5000', HIVE_FREE_MSGS_PER_SEC: '5000' },
  })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

let seeder, joiner
try {
  seeder = startSync({
    relay: `ws://localhost:${PORT}`,
    room,
    dir: seedDir,
    name: 'Seeder',
    kind: 'ai',
    log: () => {},
  })

  // Wait for seeder to populate room manifest
  for (let i = 0; i < 300; i++) {
    if (seeder.status().roomFiles >= NUM_FILES) break
    await sleep(50)
  }
  await sleep(1000)
  T('1 seeder populated 900 files in room', seeder.status().roomFiles === NUM_FILES, `roomFiles=${seeder.status().roomFiles}`)

  // Now measure a fresh joiner entering the 900-file room
  const joinDir = path.join(tmp, 'joiner')
  fs.mkdirSync(joinDir, { recursive: true })

  const t0 = performance.now()
  let syncTime = 0
  let synced = false

  joiner = startSync({
    relay: `ws://localhost:${PORT}`,
    room,
    dir: joinDir,
    name: 'JoinerAgent',
    kind: 'ai',
    log: () => {},
  })

  await new Promise((resolve) => {
    joiner.provider.on('sync', (s) => {
      if (s) {
        syncTime = performance.now() - t0
        synced = true
        resolve()
      }
    })
    setTimeout(resolve, 8000) // 8s cap
  })

  T('2 provider sync fired within the 8s cap', synced, `syncTime=${syncTime.toFixed(1)} ms`)
  T('3 join sync time is well under 3000ms', syncTime < 3000, `syncTime=${syncTime.toFixed(1)} ms`)

  let finalFiles = 0
  for (let i = 0; i < 60; i++) {
    finalFiles = joiner.status().roomFiles
    if (finalFiles >= NUM_FILES) break
    await sleep(50)
  }
  T('4 joiner recognizes all 900 room files', finalFiles === NUM_FILES, `roomFiles=${finalFiles}`)

  // 5. FEW TURNS, NOT ONE PER 32 FILES. Every turn boundary waits behind whatever else the loop
  // runs, so a join paid that wait ~29 times for 900 files. On one socket a turn now opens 256.
  let opened = 0
  for (let i = 0; i < 200; i++) {
    opened = joiner.status().files
    if (opened >= NUM_FILES) break
    await sleep(50)
  }
  const turns = joiner._openTurns()
  T('5 the joiner opens 900 files in a handful of turns', opened >= NUM_FILES && turns <= 16, `opened=${opened} turns=${turns} transport=${joiner.status().transport}`)

} finally {
  if (seeder) try { seeder.stop() } catch {}
  if (joiner) try { joiner.stop() } catch {}
  if (relay) try { relay.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== JOIN SCALE TEST: ${pass} passed, ${fail} failed ===\n`)
process.exit(fail ? 1 : 0)
