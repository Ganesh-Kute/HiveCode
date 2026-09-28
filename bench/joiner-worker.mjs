// bench/joiner-worker.mjs — Child process running Joiner B with CPU profiling
import fs from 'fs'
import path from 'path'
import inspector from 'node:inspector'
import { startSync } from '../sync.js'

const [,, portStr, room, joinDir, targetFilesStr] = process.argv
const port = Number(portStr) || 24200
const targetFiles = Number(targetFilesStr) || 1000

console.log(`[joiner-worker] Initializing in ${joinDir}, connecting to ws://localhost:${port}, room: ${room}, targetFiles: ${targetFiles}`)

const session = new inspector.Session()
session.connect()

function startProfiling() {
  return new Promise((resolve, reject) => {
    session.post('Profiler.enable', (err) => {
      if (err) return reject(err)
      session.post('Profiler.start', (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  })
}

function stopProfiling() {
  return new Promise((resolve, reject) => {
    session.post('Profiler.stop', (err, { profile }) => {
      if (err) return reject(err)
      resolve(profile)
    })
  })
}

// Start CPU profiling right as join starts
await startProfiling()
const t0 = performance.now()
let tManifest = 0

const joiner = startSync({
  relay: `ws://localhost:${port}`,
  room,
  dir: joinDir,
  name: 'JoinerB',
  kind: 'ai',
  log: () => {},
})

// Wait for manifest sync
await new Promise((resolve) => {
  joiner.provider.on('sync', (synced) => {
    if (synced && !tManifest) {
      tManifest = performance.now()
      console.log(`[joiner-worker] Provider manifest synced in ${(tManifest - t0).toFixed(1)} ms`)
      resolve()
    }
  })
})

// Fast directory file counter to avoid freezing the event loop with status() O(N) existsSync scans
function countFiles(dir) {
  let count = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory()) count += countFiles(path.join(dir, e.name))
      else if (e.isFile() && e.name.endsWith('.js')) count++
    }
  } catch {}
  return count
}

// Poll until all targetFiles are written to disk
let tDiskFill = 0

for (let i = 0; i < 300; i++) {
  const held = countFiles(joinDir)
  if (held >= targetFiles) {
    tDiskFill = performance.now()
    break
  }
  await new Promise((r) => setTimeout(r, 200))
}

if (!tDiskFill) {
  tDiskFill = performance.now()
  console.log(`[joiner-worker] Timeout reached, filesHeld = ${joiner.status().filesHeld}/${targetFiles}`)
}

// Stop CPU profiling
const profile = await stopProfiling()
session.disconnect()

const totalMs = tDiskFill - t0
const manifestMs = tManifest - t0
const diskFillMs = tDiskFill - tManifest

console.log(`[joiner-worker] Disk fill complete in ${diskFillMs.toFixed(1)} ms (total join: ${totalMs.toFixed(1)} ms)`)
console.log(`[joiner-worker] Final files held: ${joiner.status().filesHeld}/${targetFiles}`)

// Save CPU profile to joinDir/joiner.cpuprofile
const profPath = path.join(joinDir, 'joiner.cpuprofile')
fs.writeFileSync(profPath, JSON.stringify(profile))
console.log(`[joiner-worker] Saved CPU profile to ${profPath} (${(fs.statSync(profPath).size / 1024 / 1024).toFixed(2)} MB)`)

// Clean stop
joiner.stop()
process.exit(0)
