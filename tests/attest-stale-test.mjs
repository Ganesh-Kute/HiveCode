// Guard test: Stale Attestations & False Divergence Prevention
//
// 1. Same-size mutation: two peers with equal bytes but different content must NOT reach quorum.
// 2. Edit invalidation: an edit by one peer must mark earlier attestations stale, not raise a false DIVERGENCE.
// 3. Stale sync failure: a peer attesting with old bytes AFTER a change must raise a REAL divergence.
// 4. Missing file: two peers attesting a path neither holds must NOT reach quorum.
// 5. Stated vs Measured: stating a byte count different from what is on disk must be reported.
// 6. Direct doc edit (bypassing bump): editing file doc turns confirmed quorum into "older version".

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { startSync, parseLink } from '../sync.js'
import { contentHash } from '../substrate.js'

const PORT = 1248
const RELAY = `ws://localhost:${PORT}`
const ROOT = path.resolve('.attest-test')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const assert = (n, c, extra = '') => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' — ' + extra : ''}`)
  if (!c) failed++
}

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
assert('initial attest reaches quorum', /QUORUM/.test(b1))

// Now A edits foo.js to a longer version (20 bytes)
await A.call('hive_edit', { file: 'foo.js', content: 'hello world updated\n', intent: 'update' })
await sleep(1000)

// A attests the new version (20 bytes). B has NOT attested the new version yet!
const a2 = await A.call('hive_attest', { file: 'foo.js', bytes: 20, lines: 1 })
assert('A attesting new version does NOT trigger DIVERGENCE', !/\[!\] DIVERGENCE/.test(a2))
assert('A sees B as stale', /stale/i.test(a2))

console.log('\n# 2. Same-size mutation must NOT reach false quorum')
await A.call('hive_edit', { file: 'same_size.js', content: 'Potato 123\n', intent: 'a' })
await sleep(1000)
fs.writeFileSync(path.join(dirB, 'same_size.js'), 'Potatu 123\n', 'utf8')
const as1 = await A.call('hive_attest', { file: 'same_size.js', bytes: 11, lines: 1 })
await sleep(600)
const bs1 = await B.call('hive_attest', { file: 'same_size.js', bytes: 11, lines: 1 })
assert('same bytes with different content does NOT reach quorum', !/QUORUM/.test(bs1))
fs.writeFileSync(path.join(dirA, 'same_size.js'), 'Potato 123\n', 'utf8')
const as2 = await A.call('hive_attest', { file: 'same_size.js', bytes: 11, lines: 1 })
console.log('--- as2:', as2)
assert('different content with same bytes raises DIVERGENCE', /DIVERGENCE/.test(as2), as2)

console.log('\n# 3. Two peers attesting a missing file gives NO quorum')
const am1 = await A.call('hive_attest', { file: 'nonexistent.js', bytes: 50, lines: 2 })
await sleep(600)
const bm1 = await B.call('hive_attest', { file: 'nonexistent.js', bytes: 50, lines: 2 })
assert('two peers attesting missing file gives NO quorum', !/QUORUM: 2\+ peers agree/.test(bm1), bm1)
assert('missing file is reported absent', /absent/i.test(bm1), bm1)

console.log('\n# 4. Stated bytes different from measured are reported')
// foo.js on A is 20 bytes. A states 999 bytes.
const asm = await A.call('hive_attest', { file: 'foo.js', bytes: 999, lines: 1 })
assert('stated bytes different from measured is reported', /stated 999|you stated/i.test(asm), asm)

console.log('\n# 5. Direct doc edit bypassing bump turns QUORUM into "older version"')
// Both B and A attest foo.js to reach QUORUM on 20 bytes
const bAttestRes = await B.call('hive_attest', { file: 'foo.js', bytes: 20, lines: 1 })
await sleep(1500)
const vBefore = await A.call('hive_verified', { file: 'foo.js' })
assert('both reach quorum on current foo.js', /QUORUM/.test(vBefore), `${bAttestRes}\n--- verified before:\n${vBefore}`)

// Now simulate an edit that bypasses the bump:
// 1. A edits foo.js to new content 'bypassed content\n'
await A.call('hive_edit', { file: 'foo.js', content: 'bypassed content\n', intent: 'bypass' })
await sleep(1000)

// 2. Connect tester to room doc and reset swarm_versions to version 2 (simulating a client that edited doc without bumping n)
const tester = startSync({ relay: RELAY, room: parseLink(link).room, dir: path.join(ROOT, 't'), name: 'Tester', passive: true, syncFiles: false, log: () => {} })
await sleep(1000)
tester.doc.getMap('swarm_versions').set('foo.js', { n: 2, hash: contentHash('hello world updated\n') })
await sleep(800)

// Check verified report without anyone re-attesting
const vAfter = await A.call('hive_verified', { file: 'foo.js' })
assert('bypassed doc edit reports older version, not plain quorum', /older version/i.test(vAfter) && !/^QUORUM:/m.test(vAfter), vAfter)
tester.stop()

relay.kill('SIGKILL')
A.proc.kill('SIGKILL')
B.proc.kill('SIGKILL')
process.exit(failed ? 1 : 0)
