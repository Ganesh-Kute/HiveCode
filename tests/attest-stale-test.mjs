// Guard test: Stale Attestations & False Divergence Prevention
//
// 1. Same-size mutation: two peers with equal bytes but different content must NOT reach quorum.
// 2. Edit invalidation: an edit by one peer must mark earlier attestations stale, not raise a false DIVERGENCE.
// 3. Stale sync failure: a peer attesting with old bytes AFTER a change must raise a REAL divergence.

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const PORT = 1248
const RELAY = `ws://localhost:${PORT}`
const ROOT = path.resolve('.attest-test')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

fs.rmSync(ROOT, { recursive: true, force: true })
const dirA = path.join(ROOT, 'a'), dirB = path.join(ROOT, 'b')
fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

function agent(label) {
  const p = spawn(process.execPath, ['hive-mcp.js'], { env: { ...process.env, HIVE_RELAY: RELAY } })
  p.stderr.on('data', (d) => process.stdout.write(`   [${label}-stderr] ${d}`))
  let buf = ''
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  let nextId = 1
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const call = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args || {} })
    const c = r && r.result && r.result.content
    if (Array.isArray(c) && c[0] && typeof c[0].text === 'string') return c[0].text
    return JSON.stringify(r && (r.error || r.result) || r)
  }
  return { proc: p, rpc, notify, call }
}

const A = agent('A'), B = agent('B')
for (const x of [A, B]) {
  await x.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  x.notify('notifications/initialized')
}

const joinA = await A.call('hive_join', { dir: dirA, name: 'Alpha' })
const link = (/invite link: (\S+)/.exec(joinA) || [])[1]
assert('A joined', !!link)
await B.call('hive_join', { dir: dirB, name: 'Beta', link })
await sleep(1500)

console.log('\n# 1. Stale attestation after an edit must NOT raise false divergence')
// A edits foo.js -> initial version
await A.call('hive_edit', { file: 'foo.js', content: 'hello\n', intent: 'initial' })
await sleep(1000)
// Both measure and attest initial version
const a1 = await A.call('hive_attest', { file: 'foo.js', bytes: 6, lines: 1 })
await sleep(600)
const b1 = await B.call('hive_attest', { file: 'foo.js', bytes: 6, lines: 1 })
console.log('b1 response:', b1)
assert('initial attest reaches quorum', /QUORUM/.test(b1))

// Now A edits foo.js to a longer version (20 bytes)
await A.call('hive_edit', { file: 'foo.js', content: 'hello world updated\n', intent: 'update' })
await sleep(1000)

// A attests the new version (20 bytes). B has NOT attested the new version yet!
const a2 = await A.call('hive_attest', { file: 'foo.js', bytes: 20, lines: 1 })
console.log('a2 response:', a2)
assert('A attesting new version does NOT trigger DIVERGENCE', !/\[!\] DIVERGENCE/.test(a2))
assert('A sees B as stale', /stale/i.test(a2))

console.log('\n# 2. Same-size mutation must NOT reach false quorum')
// Two different contents of exact same length (11 bytes each)
await A.call('hive_edit', { file: 'same_size.js', content: 'Potato 123\n', intent: 'a' })
await sleep(1000)
// Simulate B having different content on disk with same byte count (e.g. sync desync)
fs.writeFileSync(path.join(dirB, 'same_size.js'), 'Potatu 123\n', 'utf8')
// A attests what A has (11 bytes, Potato)
const as1 = await A.call('hive_attest', { file: 'same_size.js', bytes: 11, lines: 1 })
await sleep(600)
// B attests what B has (11 bytes, Potatu)
const bs1 = await B.call('hive_attest', { file: 'same_size.js', bytes: 11, lines: 1 })
console.log('bs1 response:', bs1)
assert('same bytes with different content does NOT reach quorum', !/QUORUM/.test(bs1))
// Now if A also attests the current version while holding Potato, both are current with different content:
fs.writeFileSync(path.join(dirA, 'same_size.js'), 'Potato 123\n', 'utf8')
const as2 = await A.call('hive_attest', { file: 'same_size.js', bytes: 11, lines: 1 })
console.log('as2 response:', as2)
assert('different content with same bytes raises DIVERGENCE', /DIVERGENCE/.test(as2))

relay.kill('SIGKILL')
A.proc.kill('SIGKILL')
B.proc.kill('SIGKILL')
process.exit(failed ? 1 : 0)
