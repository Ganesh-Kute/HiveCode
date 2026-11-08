// tests/revert-agent-test.mjs
// Control Room revertAgent regression test suite.
//
// MEASURED 30 Oct 2026 on team 233fe6f:
// Ganesh clicked Revert on agent Ben and accepted the confirm. The room announced
// "restored checkout.js to <time> (state before Ben's edit)" and "reverted Ben's changes
// across 1 file(s)", but both folders still had Ben's function 15 seconds later.
// Code path: public/control.html revertAgent -> restoreCore (relay side).
//
// Root Cause Analysis:
// 1. On hosted relays running HIVE_ENFORCE_CLAIMS=queue, when an agent holds a claim,
//    writes to that file are queued awaiting claim release.
// 2. Before the 30 Oct fix, restoreCore opened a short-lived connection, transacted the restore,
//    and disconnected immediately while the agent still held the claim. The relay discarded
//    the queued write on disconnect, but control.html announced success regardless.
// 3. The fix committed in control.html:
//    - releaseFrom: holderOf(file) held by the target agent is released first.
//    - landed verification: read back over a new connection before announcing success.
//
// This test validates:
//   Section A (Defect demonstration): If the claim is NOT released first (the 30 Oct state),
//             a restore is held/rejected and cannot land.
//   Section B (revertAgent verification): The full control.html revertAgent path successfully
//             releases Ben's claim, lands the restore in the room doc, and propagates to
//             both Peer A and Peer B disks within 10s with A's v1 lines intact.

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const PORT = Number(process.env.HIVE_TEST_PORT) || (27000 + (process.pid % 15000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-revert-'))
const room = 'revert-' + crypto.randomBytes(5).toString('hex')

console.log(`Starting relay on port ${PORT} (HIVE_ENFORCE_CLAIMS=queue)...`)
const relay = await new Promise((res, rej) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HIVE_PERSIST_DIR: 'off', HIVE_ENFORCE_CLAIMS: 'queue' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  p.stdout.on('data', (d) => {
    out += d.toString()
    if (/listening on/.test(out)) res(p)
  })
  p.stderr.on('data', (d) => {
    out += d.toString()
    if (/listening on/.test(out)) res(p)
  })
  setTimeout(() => rej(new Error('Relay startup timeout: ' + out)), 15000)
})

const dirA = path.join(tmp, 'a'); fs.mkdirSync(dirA, { recursive: true })
fs.writeFileSync(path.join(dirA, '.gitignore'), 'node_modules/\n')
const dirB = path.join(tmp, 'b'); fs.mkdirSync(dirB, { recursive: true })
fs.writeFileSync(path.join(dirB, '.gitignore'), 'node_modules/\n')

let A, B, pdoc, provider
try {
  const { startSync } = await import(`file:///${ROOT.replace(/\\/g, '/')}/sync.js`)
  const { FILE_SEP } = await import(`file:///${ROOT.replace(/\\/g, '/')}/token.js`)

  A = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirA, name: 'Alice', kind: 'human', log: () => {} })
  B = startSync({ relay: `ws://localhost:${PORT}`, room, dir: dirB, name: 'Ben', kind: 'ai', log: () => {} })
  await sleep(2500)

  // ─── Setup Control Room connection polyfill ──────────────────────────────
  pdoc = new Y.Doc()
  provider = new WebsocketProvider(`ws://localhost:${PORT}`, room, pdoc, { WebSocketPolyfill: WebSocket, disableBc: true })
  await new Promise((r) => provider.on('sync', (s) => s && r()))
  await sleep(500)

  const history = pdoc.getMap('history')
  const claims = pdoc.getMap('claims')
  const chat = pdoc.getArray('chat')

  async function openFileDoc(file) {
    const fdoc = new Y.Doc()
    const fp = new WebsocketProvider(`ws://localhost:${PORT}`, room + FILE_SEP + file, fdoc, { WebSocketPolyfill: WebSocket, disableBc: true })
    await new Promise((res) => {
      let d = false
      const f = () => { if (d) return; d = true; res() }
      fp.on('sync', (s) => s && f())
      setTimeout(f, 6000)
    })
    return { fdoc, fp, text: fdoc.getText('content'), snap: fdoc.getMap('snap') }
  }

  // Load restoreCore, revertAgent, and holderOf dynamically from public/control.html
  const controlHtmlPath = path.join(ROOT, 'public', 'control.html')
  const html = fs.readFileSync(controlHtmlPath, 'utf8')
  const hoMatch = html.match(/function holderOf\([\s\S]*?\n\}/)
  const rcMatch = html.match(/async function restoreCore\([\s\S]*?\n\}/)
  const raMatch = html.match(/async function revertAgent\([\s\S]*?\n\}/)

  if (!rcMatch || !raMatch) {
    throw new Error('Could not find restoreCore or revertAgent in ' + controlHtmlPath)
  }

  const fnCode = `
    ${hoMatch ? hoMatch[0] : `function holderOf(file) {
      try {
        const c = window._h.doc.getMap('claims').get(file)
        if (!c || !c.by) return ''
        const ttl = c.ttl || 600000
        return Date.now() - (c.at || 0) < ttl ? c.by : ''
      } catch { return '' }
    }`}
    ${rcMatch[0]}
    ${raMatch[0]}
    return { holderOf, restoreCore, revertAgent }
  `

  const env = {
    window: {
      _h: { doc: pdoc, history, chat, tasks: pdoc.getMap('tasks') },
      _conn: { relay: `ws://localhost:${PORT}`, room }
    },
    doc: pdoc,
    claims,
    history,
    chat,
    openFileDoc,
    me: 'Ganesh',
    meKind: 'human',
    tstr: () => new Date().toTimeString().slice(0, 8),
    confirm: () => true,
    alert: () => {}
  }

  const { holderOf, restoreCore, revertAgent } = new Function(
    'window', 'doc', 'claims', 'history', 'chat', 'openFileDoc', 'me', 'meKind', 'tstr', 'confirm', 'alert',
    fnCode
  )(env.window, env.doc, env.claims, env.history, env.chat, env.openFileDoc, env.me, env.meKind, env.tstr, env.confirm, env.alert)

  // ─── SECTION A: Defect Demonstration (Claim Held Without Release) ────────
  console.log('\n# Section A: Restore attempt while file is claimed by an unreleased holder')
  const FILE = 'checkout.js'
  const v1 = 'export function checkout() {\n  return "v1"\n}\n'
  fs.writeFileSync(path.join(dirA, FILE), v1)
  await sleep(4000)

  // Verify v1 reached B
  const bInitial = fs.readFileSync(path.join(dirB, FILE), 'utf8')
  T('A1. Alice v1 synced to Ben', bInitial === v1, JSON.stringify(bInitial))

  // Ben claims the file and appends benDiscount
  B.claim(FILE, 'add benDiscount')
  await sleep(1000)
  const v2 = v1 + '\nexport function benDiscount() {\n  return 0.5\n}\n'
  fs.writeFileSync(path.join(dirB, FILE), v2)
  await sleep(4000)

  const aAfterBen = fs.readFileSync(path.join(dirA, FILE), 'utf8')
  T('A2. Ben edit synced to Alice', aAfterBen.includes('benDiscount'), JSON.stringify(aAfterBen))
  T('A3. Ben is live claim holder on relay', holderOf(FILE) === 'Ben')

  // Find Ben's earliest snapshot
  let benSnap = null
  for (const m of Object.values(history.toJSON())) {
    if (m.by === 'Ben' && m.file === FILE) {
      if (!benSnap || (m.ts || 0) < (benSnap.ts || 0)) benSnap = m
    }
  }
  T('A4. Snapshot attributed to Ben exists', benSnap !== null, benSnap ? benSnap.id : 'null')

  // If restoreCore is called without releaseFrom (the pre-fix 30 Oct behavior)
  const unreleasedAttempt = await restoreCore(benSnap.id, FILE, { releaseFrom: '' })
  T('A5. Restore without releasing claim fails with error:held',
    unreleasedAttempt && unreleasedAttempt.error === 'held' && unreleasedAttempt.by === 'Ben',
    JSON.stringify(unreleasedAttempt))

  // ─── SECTION B: Control Room revertAgent Verification ────────────────────
  console.log('\n# Section B: revertAgent("Ben") releases claim and restores both disks')
  const chatLenBefore = chat.length
  await revertAgent('Ben')
  const chatMsgs = chat.toArray().slice(chatLenBefore).map(m => m.text || '')
  const announced = chatMsgs.some(t => t.includes("reverted Ben's changes"))
  T('B1. revertAgent announced in room chat', announced, chatMsgs.join('; '))

  console.log('\n# Waiting up to 10s for sync to settle...')
  await sleep(10000)

  const vdoc = await openFileDoc(FILE)
  const roomFinal = vdoc.text.toString()
  vdoc.fp.destroy(); vdoc.fdoc.destroy()
  const diskA = fs.readFileSync(path.join(dirA, FILE), 'utf8')
  const diskB = fs.readFileSync(path.join(dirB, FILE), 'utf8')

  T('B2. Room doc no longer contains benDiscount', !roomFinal.includes('benDiscount'), JSON.stringify(roomFinal))
  T('B3. Peer A disk no longer contains benDiscount', !diskA.includes('benDiscount'), JSON.stringify(diskA))
  T('B4. Peer B disk no longer contains benDiscount', !diskB.includes('benDiscount'), JSON.stringify(diskB))
  T('B5. Peer A v1 lines intact on Disk A', diskA.includes('return "v1"'), JSON.stringify(diskA))
  T('B6. Peer A v1 lines intact on Disk B', diskB.includes('return "v1"'), JSON.stringify(diskB))

  console.log(`\n=== REVERT AGENT TEST SUMMARY: ${pass} passed, ${fail} failed ===`)
  process.exit(fail ? 1 : 0)

} catch (err) {
  console.error('Test execution error:', err)
  process.exit(1)
} finally {
  try { A && A.stop() } catch {}
  try { B && B.stop() } catch {}
  try { provider && provider.destroy() } catch {}
  try { pdoc && pdoc.destroy() } catch {}
  try { relay && relay.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}
