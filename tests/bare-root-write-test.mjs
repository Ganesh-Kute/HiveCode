// BARE ROOT WRITE-TIME ENFORCEMENT (HIV-P8)
//
// THE DEFECT THIS TEST PROVES.
// HIV-P3 prevented uncreated root files with extensions (`config.env`) from bypassing
// reservation gates, but bare root strings (`config`, `hosts`, `staging`) were deliberately
// classified as logical labels so as not to break multi-word or non-file claims.
//
// Once claimed, an agent writes `./config` to disk. Under an allow-list .gitignore (`/*`),
// `./config` is ignored. Because `walk()` skipped ignored files, `scan()` never saw it:
// it never reached `reconcile()`, was never tracked in `fileDocs` or `manifest`, and
// no other agent could ever see it. The claim held, the file existed locally, and the
// work was born completely invisible.
//
// THE TWO-TIER SPECIFICATION:
//   Tier 1 (CLAIMED + ignored + on disk): Opens an obligation against the claimer naming
//     the path ("claimed config and wrote it, but it's ignored by .gitignore -- widen .gitignore or remove file").
//   Tier 2 (UNCLAIMED + ignored + created this session): One ambient line in chat, no obligation.
//   Preexisting ignored files: Nothing, ever.
//   Scans: Deduped to exactly 1 obligation across multiple scan ticks.
//   File deleted: Obligation cleared/discharged.
//   P8-G: The file was never tracked in room doc (born invisible).
//   P8-H: Preexisting claimed+ignored file present before join seeds into `preexisting`
//     (union of syncable + ignored) and opens zero obligations on join.
//
//   node tests/bare-root-write-test.mjs

import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { startSync } from '../sync.js'
import { openList } from '../hive-obligations.js'

const PORT = Number(process.env.HIVE_TEST_PORT) || (20000 + (process.pid % 20000))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-bareroot-'))
const relay = await new Promise((res) => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT) } })
  p.stderr.on('data', (d) => { if (process.env.HIVE_DEBUG) process.stderr.write(d) })
  p.stdout.on('data', (d) => { if (/listening on/.test(d)) res(p) })
})

const room = 'bareroot-' + crypto.randomBytes(6).toString('hex')
const dir = path.join(tmp, 'agent'); fs.mkdirSync(dir, { recursive: true })

// Seed a prior claim for 'hosts' into the room doc before Alice joins
const setupDir = path.join(tmp, 'setup'); fs.mkdirSync(setupDir, { recursive: true })
const setupHive = startSync({
  relay: `ws://localhost:${PORT}`,
  room,
  dir: setupDir,
  name: 'Setup',
  kind: 'ai',
  log: () => {},
})
await sleep(1000)
setupHive.claim('hosts', 'manage hosts')
await sleep(500)
try { setupHive.stop() } catch {}
await sleep(500)

// Agent Alice's setup
// Allow-list: ignores everything except .gitignore and notes.md
fs.writeFileSync(path.join(dir, '.gitignore'), [
  '/*',
  '!/.gitignore',
  '!/notes.md',
  '',
].join('\n'))

// Preexisting ignored files on disk BEFORE Alice's sync starts:
// 1. preexisting.tmp (unclaimed) -> tested in P8-E
// 2. hosts (already claimed in room) -> tested in P8-H
fs.writeFileSync(path.join(dir, 'preexisting.tmp'), 'preexisting old file\n')
fs.writeFileSync(path.join(dir, 'hosts'), '127.0.0.1 localhost\n')

let hive
try {
  hive = startSync({
    relay: `ws://localhost:${PORT}`,
    room,
    dir,
    name: 'Alice',
    kind: 'ai',
    log: () => {},
  })
  await sleep(1500)

  // -----------------------------------------------------------------------------------------
  // P8-H: Preexisting claimed+ignored file present before join -> ZERO obligations on join
  //       Pins that `preexisting` was seeded from the UNION of syncable + ignored files.
  // -----------------------------------------------------------------------------------------
  const obsJoin = openList(hive.doc.getMap('obligations'))
  const hostsOb = obsJoin.find((o) => o.text && o.text.includes('hosts'))
  T('P8-H preexisting claimed+ignored file opens no obligation on join (preexisting seeds union)', !hostsOb)

  // -----------------------------------------------------------------------------------------
  // P8-E: Preexisting unclaimed ignored file present before join -> nothing, ever
  // -----------------------------------------------------------------------------------------
  const preOb = obsJoin.find((o) => o.text && o.text.includes('preexisting.tmp'))
  T('P8-E1 no obligation opened for preexisting ignored file', !preOb)

  const chatPre = hive.doc.getArray('chat').toArray()
  const preChat = chatPre.find((m) => m && m.text && m.text.includes('preexisting.tmp'))
  T('P8-E2 no chat warning emitted for preexisting ignored file', !preChat)

  // -----------------------------------------------------------------------------------------
  // P8-B: Claim "notes.md" (negated in allow-list), then write it -> NOTHING opens
  // -----------------------------------------------------------------------------------------
  const claimNotes = hive.claim('notes.md', 'edit')
  T('P8-B0 claim notes.md granted', claimNotes === true)
  fs.writeFileSync(path.join(dir, 'notes.md'), 'meeting notes\n')
  await sleep(1500)

  const obsNotes = openList(hive.doc.getMap('obligations'))
  const notesOb = obsNotes.find((o) => o.text && o.text.includes('notes.md'))
  T('P8-B1 no obligation opened for negated allow-listed file notes.md', !notesOb)

  const chatNotes = hive.doc.getArray('chat').toArray()
  const notesChat = chatNotes.find((m) => m && m.text && m.text.includes('notes.md') && /ignored/i.test(m.text))
  T('P8-B2 no chat warning for negated allow-listed file notes.md', !notesChat)

  // -----------------------------------------------------------------------------------------
  // P8-C: Write ./scratch.tmp with NO claim -> no obligation; ambient chat line only
  // -----------------------------------------------------------------------------------------
  fs.writeFileSync(path.join(dir, 'scratch.tmp'), 'temporary scratch notes\n')
  await sleep(1500)

  const obsScratch = openList(hive.doc.getMap('obligations'))
  const scratchOb = obsScratch.find((o) => o.text && o.text.includes('scratch.tmp'))
  T('P8-C1 no obligation for unclaimed ignored file scratch.tmp', !scratchOb)

  const chatScratch = hive.doc.getArray('chat').toArray()
  const scratchChat = chatScratch.find((m) => m && m.text && m.text.includes('scratch.tmp') && /ignored/i.test(m.text))
  T('P8-C2 ambient chat warning emitted for unclaimed ignored file scratch.tmp', !!scratchChat)

  // -----------------------------------------------------------------------------------------
  // P8-A: Claim "config" (allowed by P3), then write ./config which allow-list does not negate
  // -----------------------------------------------------------------------------------------
  const claimConfig = hive.claim('config', 'edit')
  T('P8-A0 bare root string config can be claimed under P3', claimConfig === true)

  fs.writeFileSync(path.join(dir, 'config'), 'DATABASE_URL=postgres://localhost:5432/db\n')
  await sleep(1500)

  const obsA = openList(hive.doc.getMap('obligations'))
  const configOb = obsA.find((o) => o.text && o.text.includes('config'))
  T('P8-A1 obligation opens for claimed ignored file written on disk', !!configOb)
  T('P8-A2 obligation is owed by the claimer (Alice)', configOb && configOb.to.toLowerCase() === 'alice')
  T('P8-A3 obligation text names path and mentions gitignore/ignored',
    Boolean(configOb && /config/.test(configOb.text) && /gitignore|ignored/i.test(configOb.text)))
  T('P8-A4 obligation is currently open (not done)', Boolean(configOb && !configOb.done))

  // -----------------------------------------------------------------------------------------
  // P8-D: Next scan tick -> still exactly ONE obligation (deduped)
  // -----------------------------------------------------------------------------------------
  await sleep(2000)
  const obsD = openList(hive.doc.getMap('obligations')).filter((o) => o.text && o.text.includes('config'))
  T('P8-D exactly one obligation for config across multiple scan ticks (deduped)', obsD.length === 1)

  // -----------------------------------------------------------------------------------------
  // P8-F: Delete the file after the warning -> the obligation does not outlive it
  // -----------------------------------------------------------------------------------------
  fs.unlinkSync(path.join(dir, 'config'))
  await sleep(2000)

  const obsF = openList(hive.doc.getMap('obligations')).filter((o) => o.text && o.text.includes('config'))
  const storedRec = configOb ? hive.doc.getMap('obligations').get(configOb.id) : null
  T('P8-F obligation was opened previously and is now cleared/discharged on file deletion',
    Boolean(configOb && obsF.length === 0 && (storedRec ? storedRec.done === true : true)))

  // -----------------------------------------------------------------------------------------
  // P8-G: The file was NEVER tracked in the room doc (born invisible)
  // -----------------------------------------------------------------------------------------
  const inManifest = hive.doc.getMap('manifest').has('config')
  T('P8-G config was never tracked in room manifest (born invisible)', !inManifest)

} finally {
  try { hive && hive.stop() } catch {}
  try { relay && relay.kill() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== BARE ROOT WRITE: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
