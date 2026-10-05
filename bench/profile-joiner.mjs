// bench/profile-joiner.mjs — Orchestrate 1,000-file join and profile Joiner B
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { startSync } from '../sync.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.HIVE_TEST_PORT) || (25300 + (process.pid % 5000))
const NUM_FILES = Number(process.env.NUM_FILES) || 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-join-prof-'))
const room = 'prof-' + crypto.randomBytes(5).toString('hex')
const seedDir = path.join(tmp, 'seed')
const joinDir = path.join(tmp, 'joiner')
fs.mkdirSync(seedDir, { recursive: true })
fs.mkdirSync(joinDir, { recursive: true })

console.log(`=== JOINER B CPU PROFILING HARNESS (${NUM_FILES} files) ===`)
console.log(`Tmp dir: ${tmp}`)
console.log(`Room: ${room}, Port: ${PORT}`)

// 1. Generate 1,000 seed files
console.log(`Generating ${NUM_FILES} seed files...`)
for (let i = 0; i < NUM_FILES; i++) {
  const sub = path.join(seedDir, `d_${i % 25}`)
  if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(sub, `f_${String(i).padStart(4, '0')}.js`), `export const v${i} = ${i};\n`)
}

// 2. Start relay
console.log(`Starting local relay on port ${PORT}...`)
const relay = await new Promise((res, rej) => {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HIVE_PERSIST_DIR: 'off',
      HIVE_FREE_MSG_BURST: '10000',
      HIVE_FREE_MSGS_PER_SEC: '10000',
    },
  })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
  p.on('error', rej)
})

let seeder = null

try {
  // 3. Seed files into room
  console.log(`Seeding files via Seeder A...`)
  seeder = startSync({
    relay: `ws://localhost:${PORT}`,
    room,
    dir: seedDir,
    name: 'SeederA',
    kind: 'ai',
    log: () => {},
  })

  for (let i = 0; i < 400; i++) {
    if (seeder.status().roomFiles >= NUM_FILES) break
    await sleep(50)
  }
  await sleep(1500)
  console.log(`Seeder status: roomFiles=${seeder.status().roomFiles}, files=${seeder.status().files}`)

  // 4. Spawn Joiner B as child process with CPU profiler
  console.log(`Launching Joiner B child process...`)
  const joinerProc = spawn(process.execPath, [
    path.join(ROOT, 'bench', 'joiner-worker.mjs'),
    String(PORT),
    room,
    joinDir,
    String(NUM_FILES),
  ], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  })

  await new Promise((res, rej) => {
    joinerProc.on('exit', (code) => {
      if (code === 0) res()
      else rej(new Error(`Joiner exited with code ${code}`))
    })
    joinerProc.on('error', rej)
  })

  // 5. Read and analyze the generated CPU profile
  const profFile = path.join(joinDir, 'joiner.cpuprofile')
  if (!fs.existsSync(profFile)) {
    throw new Error(`Profile file not found at ${profFile}`)
  }

  console.log(`Reading CPU profile from ${profFile}...`)
  const profRaw = fs.readFileSync(profFile, 'utf8')
  const profile = JSON.parse(profRaw)

  analyzeCpuProfile(profile)

} finally {
  if (seeder) try { seeder.stop() } catch {}
  if (relay) try { relay.kill() } catch {}
  // Keep tmp if needed, or clean up
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

function analyzeCpuProfile(profile) {
  const nodeMap = new Map()
  const parentMap = new Map() // childId -> parentId

  for (const n of profile.nodes) {
    nodeMap.set(n.id, n)
    if (n.children) {
      for (const c of n.children) {
        parentMap.set(c, n.id)
      }
    }
  }

  // Calculate self-time per sample
  const nodeSelfMicros = new Map()
  let totalMicros = 0

  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const nodeId = profile.samples[i]
      const delta = profile.timeDeltas[i] || 0
      totalMicros += delta
      nodeSelfMicros.set(nodeId, (nodeSelfMicros.get(nodeId) || 0) + delta)
    }
  } else {
    for (const n of profile.nodes) {
      const c = n.hitCount || 0
      totalMicros += c
      nodeSelfMicros.set(n.id, c)
    }
  }

  // Helper to extract clean function key & file path
  const fnKey = (node) => {
    const f = node.callFrame
    let fnName = f.functionName || '(anonymous)'
    let file = f.url ? f.url.replace(/^file:\/\/\/?/, '') : '(native)'
    if (file.includes('node_modules')) {
      const parts = file.split('node_modules')
      file = parts[parts.length - 1]
    } else {
      file = path.basename(file)
    }
    const line = (f.lineNumber || 0) + 1 // 1-indexed for readability
    const id = `${fnName} @ ${file}:${line}`
    return { id, fnName, file, line, rawUrl: f.url }
  }

  // Aggregate self-time by function identity
  const fnSelfTime = new Map()
  const fnMeta = new Map()
  const fnNodes = new Map()

  for (const [nodeId, selfTime] of nodeSelfMicros) {
    if (!selfTime) continue
    const node = nodeMap.get(nodeId)
    if (!node) continue
    const meta = fnKey(node)
    fnSelfTime.set(meta.id, (fnSelfTime.get(meta.id) || 0) + selfTime)
    if (!fnNodes.has(meta.id)) fnNodes.set(meta.id, [])
    fnNodes.get(meta.id).push(nodeId)
    fnMeta.set(meta.id, meta)
  }

  // Calculate callers for each function
  // For each sample where nodeId is top, its immediate caller is parentMap.get(nodeId)
  const fnCallers = new Map() // fnId -> Map<callerId, micros>

  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const nodeId = profile.samples[i]
      const delta = profile.timeDeltas[i] || 0
      const node = nodeMap.get(nodeId)
      if (!node) continue
      const meta = fnKey(node)
      
      const parentId = parentMap.get(nodeId)
      let callerKey = '(root / event loop)'
      let userlandCaller = null

      if (parentId) {
        const parentNode = nodeMap.get(parentId)
        if (parentNode) {
          callerKey = fnKey(parentNode).id
        }

        // Trace up to find userland application caller (e.g. sync.js)
        let curr = parentId
        while (curr) {
          const pNode = nodeMap.get(curr)
          if (!pNode) break
          const pMeta = fnKey(pNode)
          if (pMeta.file.includes('sync.js') || pMeta.file.includes('joiner-worker.mjs')) {
            userlandCaller = pMeta.id
            break
          }
          curr = parentMap.get(curr)
        }
      }

      if (!fnCallers.has(meta.id)) fnCallers.set(meta.id, { immediate: new Map(), userland: new Map() })
      const m = fnCallers.get(meta.id)
      m.immediate.set(callerKey, (m.immediate.get(callerKey) || 0) + delta)
      if (userlandCaller) {
        m.userland.set(userlandCaller, (m.userland.get(userlandCaller) || 0) + delta)
      }
    }
  }

  const sortedFns = [...fnSelfTime.entries()]
    .map(([key, selfTime]) => ({
      key,
      selfTime,
      selfMs: selfTime / 1000,
      pct: totalMicros > 0 ? (selfTime / totalMicros) * 100 : 0,
      meta: fnMeta.get(key),
    }))
    .sort((a, b) => b.selfTime - a.selfTime)

  console.log(`\n======================================================`)
  console.log(`             JOINER B V8 CPU PROFILE RESULTS          `)
  console.log(`======================================================`)
  console.log(`Total CPU Time Sampled: ${(totalMicros / 1000).toFixed(2)} ms`)
  console.log(`Total Samples: ${profile.samples ? profile.samples.length : 'N/A'}`)
  console.log(`------------------------------------------------------\n`)

  console.log(`TOP 15 FUNCTIONS BY SELF-TIME (EXCLUSIVE TIME):`)
  sortedFns.slice(0, 15).forEach((fn, idx) => {
    console.log(`${String(idx + 1).padStart(2)}. [${fn.pct.toFixed(2)}%] ${fn.selfMs.toFixed(2)} ms — ${fn.key}`)
  })

  console.log(`\n------------------------------------------------------`)
  console.log(`DETAILED TOP 5 SELF-TIME FUNCTIONS & THEIR CALLERS:`)
  console.log(`------------------------------------------------------`)

  sortedFns.slice(0, 5).forEach((fn, idx) => {
    console.log(`\n#${idx + 1}: ${fn.key}`)
    console.log(`    Self-Time: ${fn.selfMs.toFixed(2)} ms (${fn.pct.toFixed(2)}% of total sampled CPU)`)
    
    const callerData = fnCallers.get(fn.key)
    if (callerData && callerData.immediate.size > 0) {
      const sortedImmediate = [...callerData.immediate.entries()]
        .map(([caller, micros]) => ({
          caller,
          ms: micros / 1000,
          pct: (micros / fn.selfTime) * 100,
        }))
        .sort((a, b) => b.ms - a.ms)

      console.log(`    Immediate Callers:`)
      sortedImmediate.slice(0, 5).forEach((c) => {
        console.log(`      -> [${c.pct.toFixed(1)}% of this fn, ${c.ms.toFixed(2)} ms] ${c.caller}`)
      })

      if (callerData.userland.size > 0) {
        const sortedUserland = [...callerData.userland.entries()]
          .map(([caller, micros]) => ({
            caller,
            ms: micros / 1000,
            pct: (micros / fn.selfTime) * 100,
          }))
          .sort((a, b) => b.ms - a.ms)

        console.log(`    Userland / sync.js Origin:`)
        sortedUserland.slice(0, 5).forEach((u) => {
          console.log(`      -> [${u.pct.toFixed(1)}% of this fn, ${u.ms.toFixed(2)} ms] ${u.caller}`)
        })
      }
    } else {
      console.log(`    Immediate Callers: (none / root)`)
    }
  })
  console.log(`\n======================================================\n`)
}
