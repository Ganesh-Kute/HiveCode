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
import os from 'os'
import { startSync, parseLink } from '../sync.js'
import { contentHash } from '../substrate.js'

const PORT = 1248
const RELAY = `ws://localhost:${PORT}`
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-attest-test-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (pred, ms = 10000, step = 100) => {
  const end = Date.now() + ms
  let last = null
  while (Date.now() < end) {
    last = await pred()
    if (last) return last
    await sleep(step)
  }
  return last || (await pred())
}
let failed = 0
const assert = (n, c, extra = '') => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' — ' + extra : ''}`)
  if (!c) failed++
}

const dirA = path.join(ROOT, 'a'), dirB = path.join(ROOT, 'b')
fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true })

const relay = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
await new Promise((res) => relay.stdout.on('data', (d) => /listening on/.test(d) && res()))

function agent(label, extraEnv = {}) {
  const p = spawn(process.execPath, ['hive-mcp.js'], { env: { ...process.env, HIVE_RELAY: RELAY, HIVE_ATTEST_GRACE_MS: '400', ...extraEnv } })
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

// Simulate two peers holding different content for the same version
const testerDiv = startSync({ relay: RELAY, room: parseLink(link).room, dir: path.join(ROOT, 'tdiv'), name: 'TesterDiv', passive: true, syncFiles: false, log: () => {} })
await sleep(1000)
testerDiv.doc.getMap('swarm_versions').set('diverge.js', { n: 1, hash: contentHash('Potato 123\n') })
testerDiv.doc.getMap('swarm_attest').set('diverge.js', {
  Alpha: { bytes: 11, lines: 1, hash: contentHash('Potato 123\n'), version: 1, at: new Date().toISOString() }
})
await sleep(600)
fs.writeFileSync(path.join(dirB, 'diverge.js'), 'Potatu 123\n', 'utf8')
const bsDiv = await B.call('hive_attest', { file: 'diverge.js', bytes: 11, lines: 1 })
assert('different content with same bytes raises DIVERGENCE', /DIVERGENCE/.test(bsDiv), bsDiv)
const vs1 = await A.call('hive_verified', { file: 'diverge.js' })
assert('verified reports divergence', /DIVERGED/i.test(vs1), vs1)
testerDiv.stop()


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
// Wait for Beta's attestation to sync to Alpha over the relay (up to 10s)
const vBefore = await until(async () => {
  const v = await A.call('hive_verified', { file: 'foo.js' })
  return /QUORUM/.test(v) ? v : null
}, 10000)
assert('both reach quorum on current foo.js', /QUORUM/.test(vBefore || ''), `${bAttestRes}\n--- verified before:\n${vBefore}`)

// Now simulate an edit that bypasses the bump:
// 1. A edits foo.js to new content 'bypassed content\n'
await A.call('hive_edit', { file: 'foo.js', content: 'bypassed content\n', intent: 'bypass' })
await sleep(1000)

// 2. Connect tester to room doc and reset swarm_versions to version 2 (simulating a client that edited doc without bumping n)
const tester = startSync({ relay: RELAY, room: parseLink(link).room, dir: path.join(ROOT, 't'), name: 'Tester', passive: true, syncFiles: false, log: () => {} })
await until(() => tester.provider && tester.provider.synced, 10000)
tester.doc.getMap('swarm_versions').set('foo.js', { n: 2, hash: contentHash('hello world updated\n') })

// Check verified report without anyone re-attesting: wait until A receives tester's version reset
const vAfter = await until(async () => {
  const v = await A.call('hive_verified', { file: 'foo.js' })
  return (/older version/i.test(v) && !/^QUORUM:/m.test(v)) ? v : null
}, 10000)
assert('bypassed doc edit reports older version, not plain quorum', /older version/i.test(vAfter || '') && !/^QUORUM:/m.test(vAfter || ''), vAfter)
tester.stop()

console.log('\n# 6. Propagation lag prevents false divergence and answers not caught up')
await A.call('hive_edit', { file: 'lag.js', content: 'version 1 initial\n', intent: 'initial' })
await sleep(1000)
await A.call('hive_attest', { file: 'lag.js', bytes: 18, lines: 1 })
await sleep(600)
await B.call('hive_attest', { file: 'lag.js', bytes: 18, lines: 1 })

// Now A edits lag.js to new content
await A.call('hive_edit', { file: 'lag.js', content: 'version 2 updated\n', intent: 'v2' })
await sleep(1000)
// Editor checks its own work first (normal order)
const aV2 = await A.call('hive_attest', { file: 'lag.js', bytes: 18, lines: 1 })
assert('editor attesting v2 succeeds', !/DIVERGENCE/.test(aV2), aV2)

// Simulate B's disk lagging behind: overwrite B's disk file with old content while fileDoc is updated
fs.writeFileSync(path.join(dirB, 'lag.js'), 'version 1 initial\n', 'utf8')
const bLag = await B.call('hive_attest', { file: 'lag.js', bytes: 18, lines: 1 })
assert('lagging folder reports not caught up yet', /your folder has not caught up yet/i.test(bLag), bLag)
assert('lagging peer inside grace does NOT trigger divergence', !/DIVERGENCE/.test(bLag), bLag)
const vLag = await A.call('hive_verified', { file: 'lag.js' })
assert('lagging folder does NOT create divergence in verified', !/\[!\] DIVERGED/.test(vLag), vLag)

// The lagging peer catches up and re-attests -> reaches QUORUM
fs.writeFileSync(path.join(dirB, 'lag.js'), 'version 2 updated\n', 'utf8')
const bCatchup = await B.call('hive_attest', { file: 'lag.js', bytes: 18, lines: 1 })
assert('caught up peer reaches quorum on v2', /QUORUM/.test(bCatchup), bCatchup)
// Wait for Beta's catchup attest to sync to Alpha
const vCatchup = await until(async () => {
  const v = await A.call('hive_verified', { file: 'lag.js' })
  return /QUORUM/.test(v) ? v : null
}, 10000)
assert('verified confirms quorum once caught up', /QUORUM/.test(vCatchup || ''), vCatchup)

console.log('\n# 7. Line count with trailing newline matches wc -l')
fs.writeFileSync(path.join(dirA, 'lines.js'), '1\n2\n3\n4\n5\n', 'utf8')
const aLines = await A.call('hive_attest', { file: 'lines.js', bytes: 10, lines: 5 })
assert('file with trailing newline reports 5 lines, not 6', /5 lines/.test(aLines) && !/6 lines/.test(aLines), aLines)

console.log('\n# 8. Stuck lagging folder ends in DIVERGENCE after grace period')
const S = agent('Stuck', { HIVE_TEST_STUCK_SYNC: 'stuck.js' })
await S.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
S.notify('notifications/initialized')
const dirS = path.join(ROOT, 's')
fs.mkdirSync(dirS, { recursive: true })
await S.call('hive_join', { dir: dirS, name: 'Stuck', link })
await sleep(1000)

// A edits stuck.js in room doc
await A.call('hive_edit', { file: 'stuck.js', content: 'room content updated\n', intent: 'test' })
await sleep(1000)

// Write different content to S's disk (because HIVE_TEST_STUCK_SYNC is set, S's sync never reconciles it)
fs.writeFileSync(path.join(dirS, 'stuck.js'), 'stuck local content\n', 'utf8')
const sFirst = await S.call('hive_attest', { file: 'stuck.js', bytes: 20, lines: 1 })
assert('first attest reports not caught up yet', /your folder has not caught up yet/i.test(sFirst), sFirst)

// Wait for grace period (> 400ms)
await sleep(600)
const sStuck = await S.call('hive_attest', { file: 'stuck.js', bytes: 20, lines: 1 })
assert('re-attesting stuck lagging folder after grace period raises DIVERGENCE', /DIVERGENCE/.test(sStuck), sStuck)
assert('divergence reports not catching up', /not catching up|stuck lagging/i.test(sStuck), sStuck)
const vStuck = await A.call('hive_verified', { file: 'stuck.js' })
assert('verified reports DIVERGED for stuck folder', /\[!\] DIVERGED/.test(vStuck), vStuck)
try { S.proc.kill('SIGKILL') } catch { }

relay.kill('SIGKILL')
A.proc.kill('SIGKILL')
B.proc.kill('SIGKILL')
try { fs.rmSync(ROOT, { recursive: true, force: true }) } catch { }
process.exit(failed ? 1 : 0)
