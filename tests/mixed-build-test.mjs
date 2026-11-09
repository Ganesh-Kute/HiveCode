// MIXED BUILDS, SEEN BY THE ROOM: two engines that merge differently corrupt each other's files with
// every write green, and until now the only detector was each agent remembering to announce its
// version. Presence now carries the build (hv), and the room warns by itself.
//
//   node tests/mixed-build-test.mjs
//
// A different build is simulated by overriding a real client's presence -- exactly what that build
// would publish. Each case is a way the warning could be missing, or be a false alarm.
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { VERSION, VERSION_LABEL } from '../hive-version.js'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PORT = Number(process.env.HIVE_TEST_PORT) || (24200 + (process.pid % 17000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mixed-'))
const room = 'mb-' + crypto.randomBytes(5).toString('hex')
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_SEATS: '32' } })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})
const clients = []
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  const join = (name, kind) => { const c = startSync({ relay: `ws://localhost:${PORT}`, room, dir: path.join(tmp, name), name, kind, log: () => {} }); clients.push(c); return c }
  const pose = (c, patch) => c.provider.awareness.setLocalStateField('user', { ...c.provider.awareness.getLocalState().user, ...patch })
  const mixed = (c) => (c.doc.getArray('chat').toArray() || []).map((m) => String(m.text || '')).filter((t) => /MIXED BUILDS/.test(t))

  const alpha = join('Alpha', 'ai'), beta = join('Beta', 'ai')
  await sleep(3500)
  T('presence carries the build', [...alpha.provider.awareness.getStates().values()].some((s) => s.user && s.user.name === 'Beta' && s.user.hv === VERSION_LABEL))
  T('two clients on the SAME build: no warning', mixed(alpha).length === 0, mixed(alpha).join(' | '))

  console.log('# a different build joins')
  pose(beta, { hv: '0.12.9+deadbee' })
  await sleep(2500)
  let w = mixed(alpha)
  T('the room is warned', w.length >= 1, w.join(' | ') || 'no warning')
  T('...naming both participants and both builds', w.some((t) => t.includes('Beta') && t.includes('0.12.9+deadbee') && t.includes('Alpha') && t.includes(VERSION_LABEL)))
  T('...exactly once, not by both sides', w.length === 1, `count=${w.length}`)
  pose(beta, { editing: { file: 'x.js', at: Date.now() } }) // presence churn, same build
  await sleep(1500)
  T('presence churn does not repeat it', mixed(alpha).length === 1, `count=${mixed(alpha).length}`)

  console.log('# an older engine that reports no build')
  const gamma = join('Gamma', 'ai')
  await sleep(2500)
  pose(gamma, { hv: undefined })
  await sleep(2500)
  w = mixed(alpha).filter((t) => t.includes('Gamma'))
  T('an AI on this protocol with NO build is flagged as older', w.length >= 1 && w.some((t) => /older than build reporting/.test(t)), w.join(' | ') || 'no warning')

  console.log('# humans carry no engine build')
  const human = join('Hana', 'human')
  await sleep(2500)
  pose(human, { hv: undefined })
  await sleep(2500)
  T('a human without a build is NOT flagged', !mixed(alpha).some((t) => t.startsWith('⚠ MIXED BUILDS: Hana runs')), mixed(alpha).filter((t) => t.startsWith('⚠ MIXED BUILDS: Hana')).join(' | '))
  const aboutGamma = mixed(alpha).filter((t) => t.startsWith('⚠ MIXED BUILDS: Gamma runs'))
  T('an old engine is announced ONCE for the room, not by every current client', aboutGamma.length === 1, aboutGamma.map((t) => t.split(',')[1]).join(' | '))
  const same = mixed(alpha).find((t) => t.includes('Beta'))
  T('a different release is not called "the same release"', !/same release/.test(same || ''))
  T('VERSION_LABEL is shown as the local build', !!same && same.includes(`hivecode ${VERSION_LABEL}`))

  console.log('# listeners do not sync files and must not trigger false mixed build alarms')
  const delta = join('Delta', 'ai', { syncFiles: false, listener: true })
  await sleep(1500)
  pose(delta, { hv: '0.12.9+deadbee', listener: true })
  await sleep(2000)
  T('a standalone listener on an older build does NOT trigger mixed builds alarm', !mixed(alpha).some((t) => t.includes('Delta')))

  console.log('# an agent on current build with an associated older listener keeps its current build')
  const kappa = join('Kappa', 'ai')
  await sleep(1500)
  const kappaListener = join('Kappa', 'ai', { syncFiles: false, listener: true })
  await sleep(1000)
  pose(kappaListener, { hv: '0.12.9+deadbee', listener: true })
  await sleep(2000)
  T('an associated listener does NOT trigger mixed builds alarm against Kappa', !mixed(alpha).some((t) => t.includes('Kappa')))
  const kappaMember = alpha.members().find((m) => m.name === 'Kappa')
  T('members() preserves engine build over listener build for Kappa', kappaMember && kappaMember.hv === VERSION_LABEL, `Kappa.hv=${kappaMember?.hv}`)

  console.log('# dual non-listener engines under one name MUST alarm (data loss risk)')
  const echo = join('Echo', 'ai')
  const echoOld = startSync({ relay: `ws://localhost:${PORT}`, room, dir: path.join(tmp, 'Echo-old'), name: 'Echo', kind: 'ai', log: () => {} })
  clients.push(echoOld)
  await sleep(1500)
  pose(echoOld, { hv: '0.12.9+deadbee' })
  await sleep(3000)
  const echoWarn = mixed(alpha).filter((t) => t.includes('Echo'))
  T('dual non-listener engine triggers mixed builds alarm', echoWarn.length >= 1, echoWarn.join(' | ') || 'no warning')
  T('...and warns that an older connection is still open', echoWarn.some((t) => /older connection from Echo is still open/.test(t)), echoWarn.join(' | '))
} catch (e) {
  T('the suite ran', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e))
} finally {
  for (const c of clients) { try { c.stop() } catch { } }
  try { relay.kill() } catch { }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { }
}
console.log(`\n=== MIXED BUILDS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
