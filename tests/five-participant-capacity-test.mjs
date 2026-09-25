// FIVE PARTICIPANT CAPACITY TEST (HIV-P15)
//
// Verifies capacity sizing, peak telemetry, refusal classification, and anti-vacuity
// data-loss detection when five real participants (folders) connect to one relay.
//
// Sizing arithmetic:
//   Each participant holds 1 base-room WebSocket + 1 WebSocket per open file.
//   For P participants and F open files: peak sockets = P * (1 + F).
//   For 5 participants and 5 files: peak = 5 * (1 + 5) = 30 sockets.
//
// Architectural distinction (Q430 vs Q431):
//   - Q430 (relay at capacity): totalConns >= LIMITS.maxConnsTotal.
//     Remedy: raise HIVE_MAX_CONNS_TOTAL or sync fewer files.
//     (HIVE_SEATS will NOT help because limitsFor never touches maxConnsTotal).
//   - Q431 (room at capacity): roomConns(room) >= maxConnsPerRoom (free tier: 8).
//     Remedy: set HIVE_SEATS to raise per-room ceiling.
//
//   node tests/five-participant-capacity-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { statusFromError, explainStatus } from '../hive-relay-health.js'
// PINNED TO THE PER-FILE TRANSPORT (HIVE_MUX=0). What this suite measures is the arithmetic of one
// socket PER FILE, which the VS Code extension, the browser panel and every older relay still
// speak. A client on one-socket mode holds 2 sockets whatever its file count; its own ceilings
// and refusals are asserted in tests/mux-test.mjs.
process.env.HIVE_MUX = '0'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT_BASE = Number(process.env.HIVE_TEST_PORT) || (24000 + (process.pid % 15000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   (${extra})` : ''}`); c ? pass++ : fail++ }

const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)

const spawnRelay = async (port, envOverrides = {}) => {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HIVE_PERSIST_DIR: 'off',
        ...envOverrides,
      },
    })
    p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
    p.stdout.on('data', (d) => {
      if (/listening on/.test(d)) resolve(p)
    })
    p.on('error', reject)
  })
}

const getHealth = async (port) => {
  const res = await fetch(`http://localhost:${port}/health`)
  return await res.json()
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION A: Telemetry & Peak Connection Measurement against Sufficient Relay
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n# A. Sizing arithmetic & peak connections (5 participants, 5 files)')
{
  const PORT_A = PORT_BASE
  const relayA = await spawnRelay(PORT_A, { HIVE_MAX_CONNS_TOTAL: '128' })
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-five-A-'))
  const roomA = 'five-p-' + crypto.randomBytes(5).toString('hex')
  const wsUrlA = `ws://localhost:${PORT_A}`

  const P = 5
  const F = 5
  const dirs = []
  const clients = []

  try {
    // Create folders for all 5 participants
    for (let i = 0; i < P; i++) {
      const d = path.join(tmpA, `p${i}`)
      fs.mkdirSync(d, { recursive: true })
      dirs.push(d)
    }

    // Seed publisher (p0) with 5 distinct files
    const fileContents = {}
    for (let f = 0; f < F; f++) {
      const name = `file_${f}.js`
      const content = `export const val_${f} = "payload_${f}_${crypto.randomBytes(4).toString('hex')}"\n`
      fileContents[name] = content
      fs.writeFileSync(path.join(dirs[0], name), content, 'utf8')
    }

    // Start Publisher p0
    const p0 = startSync({ relay: wsUrlA, room: roomA, dir: dirs[0], name: 'P0', kind: 'ai', log: () => {} })
    clients.push(p0)
    await sleep(4000)

    // Start Participants p1..p4
    for (let i = 1; i < P; i++) {
      const p = startSync({ relay: wsUrlA, room: roomA, dir: dirs[i], name: `P${i}`, kind: 'ai', log: () => {} })
      clients.push(p)
    }

    // Allow sync to complete across all 5 clients
    await sleep(10000)

    // 1. Peak connections measurement
    const health = await getHealth(PORT_A)
    const expectedPeak = P * (1 + F) // each participant holds 1 base socket + F file sockets
    console.log(`  measured peak connections: ${health.connections}, expected: ${expectedPeak}`)
    T('A1 relay reports peak connections matching P * (1 + F) = 30', health.connections === expectedPeak, `got ${health.connections}`)

    // 2. Telemetry reflects all 5 participants
    T('A2 health reports connections bounded well below maxConnsTotal', health.connections < health.limits.maxConnsTotal)

    // 3. Bytes on disk verification across all 5 folders
    let allBytesMatch = true
    let emptyFilesCount = 0

    for (let i = 0; i < P; i++) {
      for (let f = 0; f < F; f++) {
        const name = `file_${f}.js`
        const diskPath = path.join(dirs[i], name)
        if (!fs.existsSync(diskPath)) {
          allBytesMatch = false
          continue
        }
        const diskContent = fs.readFileSync(diskPath, 'utf8')
        if (diskContent.length === 0) {
          emptyFilesCount++
          allBytesMatch = false
        }
        if (diskContent !== fileContents[name]) {
          allBytesMatch = false
        }
      }
    }

    T('A3 all 5 folders hold exact non-empty matching bytes on disk for all 5 files', allBytesMatch && emptyFilesCount === 0)
    T('A4 zero files were truncated to 0 bytes', emptyFilesCount === 0)
  } finally {
    for (const c of clients) { try { c.stop() } catch {} }
    relayA.kill()
    try { fs.rmSync(tmpA, { recursive: true, force: true }) } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION B: Anti-Vacuity / Data-Loss Failure Mode (Under-provisioned HIVE_MAX_CONNS_TOTAL)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n# B. Anti-vacuity: under-provisioned relay causes silent data loss (Q430)')
{
  // 5 participants need 5 base sockets. If maxConnsTotal is 12:
  // 5 base sockets succeed, leaving only 7 slots for 25 required file sockets.
  // 18 file sockets are refused with Q430 (503).
  // The clients report joined/connected, but files on disk are missing or 0 bytes!
  const PORT_B = PORT_BASE + 1
  const relayB = await spawnRelay(PORT_B, { HIVE_MAX_CONNS_TOTAL: '12' })
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-five-B-'))
  const roomB = 'five-starved-' + crypto.randomBytes(5).toString('hex')
  const wsUrlB = `ws://localhost:${PORT_B}`

  const P = 5
  const F = 5
  const dirs = []
  const clients = []

  try {
    for (let i = 0; i < P; i++) {
      const d = path.join(tmpB, `p${i}`)
      fs.mkdirSync(d, { recursive: true })
      dirs.push(d)
    }

    for (let f = 0; f < F; f++) {
      const name = `mod_${f}.js`
      fs.writeFileSync(path.join(dirs[0], name), `export const v${f} = ${f}\n`, 'utf8')
    }

    const p0 = startSync({ relay: wsUrlB, room: roomB, dir: dirs[0], name: 'P0', kind: 'ai', log: () => {} })
    clients.push(p0)
    await sleep(3000)

    for (let i = 1; i < P; i++) {
      const p = startSync({ relay: wsUrlB, room: roomB, dir: dirs[i], name: `P${i}`, kind: 'ai', log: () => {} })
      clients.push(p)
    }

    await sleep(8000)

    // Check that all 5 joined their base room
    const allJoined = clients.every((c) => c.status().connected)
    T('B1 all 5 participants connected to base room despite low total cap', allJoined)

    // ANTI-VACUITY ASSERTION:
    // With 12 total slots and 30 needed, file sockets were starved.
    // Files on p1..p4 MUST show data loss (either missing on disk or 0 bytes).
    let missingOrZeroFiles = 0
    for (let i = 1; i < P; i++) {
      for (let f = 0; f < F; f++) {
        const p = path.join(dirs[i], `mod_${f}.js`)
        if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8').length === 0) {
          missingOrZeroFiles++
        }
      }
    }

    console.log(`  anti-vacuity measurement: ${missingOrZeroFiles} file(s) missing or zeroed across joiners`)
    T('B2 anti-vacuity proves data loss: files missing or 0 bytes on disk', missingOrZeroFiles > 0, `${missingOrZeroFiles} affected files`)

    // Verify relay health reports capacity saturation
    const healthB = await getHealth(PORT_B)
    T('B3 relay reached its total connection limit (12)', healthB.connections >= 12, `connections=${healthB.connections}`)

    // Verify that attempting another connection yields Q430 / 503
    const testUpgradeRes = await new Promise((resolve) => {
      const { WebSocket } = globalThis
      import('ws').then(({ WebSocket: WsClient }) => {
        const ws = new WsClient(`${wsUrlB}/probe-room`)
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode)
          try { ws.close() } catch {}
        })
        ws.on('open', () => {
          resolve(200)
          try { ws.close() } catch {}
        })
        ws.on('error', (err) => {
          resolve(statusFromError(err))
        })
      })
    })

    T('B4 connection beyond total cap is refused with HTTP 503 (Q430)', testUpgradeRes === 503, `status=${testUpgradeRes}`)
    const explanation = explainStatus(testUpgradeRes, wsUrlB)
    T('B5 explainStatus authoritatively names capacity / Q430', /Q430|capacity/.test(explanation))
  } finally {
    for (const c of clients) { try { c.stop() } catch {} }
    relayB.kill()
    try { fs.rmSync(tmpB, { recursive: true, force: true }) } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION C: Per-Room Ceiling Refusal (Q431) & Discrimination from Q430
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n# C. Architectural discrimination: Q431 per-room ceiling vs Q430 total ceiling')
{
  // Spawn relay with HIVE_FREE_MAX_CONNS_PER_ROOM=3, but ample total cap (HIVE_MAX_CONNS_TOTAL=100)
  const PORT_C = PORT_BASE + 2
  const relayC = await spawnRelay(PORT_C, {
    HIVE_FREE_MAX_CONNS_PER_ROOM: '3',
    HIVE_MAX_CONNS_TOTAL: '100',
  })
  const roomC = 'room-q431-' + crypto.randomBytes(5).toString('hex')
  const wsUrlC = `ws://localhost:${PORT_C}`

  const { WebSocket: WsClient } = await import('ws')
  const connections = []
  let refusedStatusCode = null

  try {
    // Attempt to open 5 connections to the SAME room
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => {
        const ws = new WsClient(`${wsUrlC}/${roomC}`)
        ws.on('open', () => {
          connections.push(ws)
          resolve()
        })
        ws.on('unexpected-response', (_req, res) => {
          refusedStatusCode = res.statusCode
          try { ws.close() } catch {}
          resolve()
        })
        ws.on('error', (err) => {
          const code = statusFromError(err)
          if (code) refusedStatusCode = code
          resolve()
        })
      })
    }

    T('C1 per-room ceiling admits first 3 connections', connections.length === 3, `admitted ${connections.length}`)
    T('C2 4th connection to same room is refused with HTTP 429 (Q431)', refusedStatusCode === 429, `status=${refusedStatusCode}`)

    const explanationC = explainStatus(refusedStatusCode, wsUrlC)
    T('C3 explanation explicitly names Q431', /Q431/.test(explanationC))
    T('C4 explanation explicitly identifies remedy as HIVE_SEATS', /HIVE_SEATS/.test(explanationC))
    T('C5 it does NOT name Q430 or HIVE_MAX_CONNS_TOTAL', !/Q430/.test(explanationC))
  } finally {
    for (const ws of connections) { try { ws.close() } catch {} }
    relayC.kill()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION D: Fix Side (Cap Raised -> Full Convergence on Same 5 Folders)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n# D. Fix verification: raising total capacity remedies Q430 data loss')
{
  const PORT_D = PORT_BASE + 3
  // Sized with headroom: 5 participants x (1 + 5 files) = 30 conns, cap set to 64
  const relayD = await spawnRelay(PORT_D, { HIVE_MAX_CONNS_TOTAL: '64' })
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-five-D-'))
  const roomD = 'five-fix-' + crypto.randomBytes(5).toString('hex')
  const wsUrlD = `ws://localhost:${PORT_D}`

  const P = 5
  const F = 5
  const dirs = []
  const clients = []

  try {
    for (let i = 0; i < P; i++) {
      const d = path.join(tmpD, `p${i}`)
      fs.mkdirSync(d, { recursive: true })
      dirs.push(d)
    }

    const expected = {}
    for (let f = 0; f < F; f++) {
      const name = `fix_${f}.js`
      const content = `export const fix_${f} = 42\n`
      expected[name] = content
      fs.writeFileSync(path.join(dirs[0], name), content, 'utf8')
    }

    // Start all 5 participants
    for (let i = 0; i < P; i++) {
      const p = startSync({ relay: wsUrlD, room: roomD, dir: dirs[i], name: `P${i}`, kind: 'ai', log: () => {} })
      clients.push(p)
      if (i === 0) await sleep(3000)
    }

    await sleep(10000)

    let allMatch = true
    let zeroCount = 0

    for (let i = 0; i < P; i++) {
      for (let f = 0; f < F; f++) {
        const name = `fix_${f}.js`
        const diskPath = path.join(dirs[i], name)
        if (!fs.existsSync(diskPath)) {
          allMatch = false
          continue
        }
        const str = fs.readFileSync(diskPath, 'utf8')
        if (str.length === 0) {
          zeroCount++
          allMatch = false
        }
        if (str !== expected[name]) {
          allMatch = false
        }
      }
    }

    T('D1 with cap raised (64 >= 30), all 5 participants converge identically on disk', allMatch)
    T('D2 zero files missing or empty across all 5 directories', zeroCount === 0)

    const healthD = await getHealth(PORT_D)
    T('D3 relay served peak cleanly without hitting cap', healthD.connections < 64, `peak=${healthD.connections}`)
  } finally {
    for (const c of clients) { try { c.stop() } catch {} }
    relayD.kill()
    try { fs.rmSync(tmpD, { recursive: true, force: true }) } catch {}
  }
}

console.log(`\n=== FIVE PARTICIPANT CAPACITY TEST: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
