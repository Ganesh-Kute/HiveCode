// tests/adaptive-scan-test.mjs — Verify adaptive scan backoff and missed-event snapback
//
// Proof requirement:
// 1. Initial scan starts at 2000ms.
// 2. Quiet scans double the interval: 2000 -> 4000 -> 8000 -> 16000ms.
// 3. When an edit occurs without fs.watch (silenced watcher simulating atomic save / network mount),
//    the safety net scan catches the change within the 16s cap and SNAPS BACK to 2000ms immediately.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (23500 + (process.pid % 15000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-adaptive-scan-'))
const room = 'adaptive-' + crypto.randomBytes(5).toString('hex')
const clientDir = path.join(tmp, 'client')
fs.mkdirSync(clientDir, { recursive: true })
fs.writeFileSync(path.join(clientDir, 'file1.txt'), 'initial content\n')

console.log('=== ADAPTIVE SCAN: backoff and unobserved-edit snapback ===')

const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off' },
  })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

let client
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  client = startSync({
    relay: `ws://localhost:${PORT}`,
    room,
    dir: clientDir,
    name: 'AdaptiveAgent',
    kind: 'ai',
    log: () => {},
  })

  // Wait for initial sync
  await sleep(1500)
  const st0 = client.status()
  T('1 initial scan interval is 2000ms', st0.scanInterval === 2000, `interval=${st0.scanInterval}`)

  // Wait for two quiet scan ticks: 2s -> 4s -> 8s
  console.log('Waiting for adaptive backoff...')
  // At t=2s: scan() runs, 0 changes -> interval becomes 4000ms.
  // At t=6s: scan() runs, 0 changes -> interval becomes 8000ms.
  await sleep(7000)
  const st1 = client.status()
  T('2 scan interval backs off after quiet scans', st1.scanInterval >= 4000, `interval=${st1.scanInterval}`)

  // Now simulate a change that fs.watch NEVER sees (e.g. atomic editor replacement or network drive)
  // Silence the local watcher handle:
  const watcherHandle = client._watcher && client._watcher()
  if (watcherHandle) {
    try { watcherHandle.close() } catch {}
  }

  // Write an unobserved file to disk
  const stealthFile = 'stealth.txt'
  const stealthContent = 'created without fs.watch notification\n'
  fs.writeFileSync(path.join(clientDir, stealthFile), stealthContent)

  // Verify that watcher did NOT immediately pick it up (because handle is closed)
  T('3 unobserved file is not immediately registered by watcher', !client.doc.getMap('manifest').has(stealthFile))

  // Wait for the scheduled scan to fire and catch the unobserved change within the 16s cap
  console.log('Waiting for periodic scan to catch unobserved file...')
  let caught = false
  for (let i = 0; i < 35; i++) {
    await sleep(500)
    if (client.doc.getMap('manifest').has(stealthFile)) {
      caught = true
      break
    }
  }

  T('4 periodic scan caught the unobserved file within the cap', caught)
  const stAfterCatch = client.status()
  T('5 scan interval immediately snapped back to 2000ms upon finding unobserved edit', stAfterCatch.scanInterval === 2000, `interval=${stAfterCatch.scanInterval}`)

} finally {
  if (client) try { client.stop() } catch {}
  if (relay) try { relay.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== ADAPTIVE SCAN: ${pass} passed, ${fail} failed ===\n`)
process.exit(fail ? 1 : 0)
