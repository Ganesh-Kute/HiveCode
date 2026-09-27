// bench/bench-join.mjs — Measure join latency (startSync to provider 'sync' event)
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = 25100 + Math.floor(Math.random() * 500)

// Start local relay
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_FREE_MSG_BURST: '5000', HIVE_FREE_MSGS_PER_SEC: '5000' },
  })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

async function populateRoom(room, numFiles) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-pop-${numFiles}-`))
  for (let i = 0; i < numFiles; i++) {
    const sub = path.join(tmpDir, `d_${i % 20}`)
    if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, `f_${i}.js`), `export const v${i} = ${i};\n`)
  }
  const seeder = startSync({
    relay: `ws://localhost:${PORT}`,
    room,
    dir: tmpDir,
    name: 'Seeder',
    kind: 'ai',
    log: () => {},
  })
  // Wait until seeder manifests all files
  for (let i = 0; i < 300; i++) {
    if (seeder.status().roomFiles >= numFiles) break
    await new Promise((r) => setTimeout(r, 50))
  }
  await new Promise((r) => setTimeout(r, 500))
  return { seeder, tmpDir }
}

async function measureJoin(room, numFiles) {
  const joinDir = fs.mkdtempSync(path.join(os.tmpdir(), `hive-join-${numFiles}-`))
  const t0 = performance.now()
  let syncTime = 0

  const client = startSync({
    relay: `ws://localhost:${PORT}`,
    room,
    dir: joinDir,
    name: 'Joiner',
    kind: 'ai',
    log: () => {},
  })

  await new Promise((resolve) => {
    client.provider.on('sync', (s) => {
      if (s) {
        syncTime = performance.now() - t0
        resolve()
      }
    })
    setTimeout(resolve, 15000)
  })

  client.stop()
  try { fs.rmSync(joinDir, { recursive: true, force: true }) } catch {}
  return syncTime
}

console.log('=== JOIN LATENCY BENCHMARK (startSync -> provider "sync") ===\n')

for (const n of [0, 150, 900]) {
  const room = `room-${n}-${crypto.randomBytes(3).toString('hex')}`
  let seed = null
  if (n > 0) {
    seed = await populateRoom(room, n)
  }
  const ms = await measureJoin(room, n)
  console.log(`- Room with ${String(n).padStart(3)} files: join time = ${ms.toFixed(1)} ms`)
  if (seed) {
    seed.seeder.stop()
    try { fs.rmSync(seed.tmpDir, { recursive: true, force: true }) } catch {}
  }
}

relay.kill()
process.exit(0)
