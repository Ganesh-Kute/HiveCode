// CHARACTERISATION TEST: extension/extension.js reconcile()
//
// Pins down the current behavior of the VS Code extension's reconcile()
// implementation before any extraction into a shared module (HIV-8).
//
// KNOWN DIVERGENCES PINNED HERE:
// 1. Extension has NO priorShadow / rejoin-clobber protection (rejoining clients
//    with preexisting files adopt the room copy, clobbering offline edits).
// 2. Extension has NO fusion guard (HIV-26).
// 3. Extension has NO FORK_GATE / provenance DAG stamping.
// 4. Extension DOES have the HIV-20 empty doc adoption guard (docText === '' doesn't zero disk).
// 5. Extension DOES have first-contact adopt and concurrent creation race merge.
//
// Running: node tests/extension-reconcile-characterisation-test.mjs

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import * as Y from 'yjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const extPath = path.join(ROOT, 'extension', 'extension.js')
const extSrc = fs.readFileSync(extPath, 'utf8')

// Extract readText through reconcile from extension.js
const startMarker = '  function readText(full) {'
const endMarker = '  // AUTO-BOARD: a local wholesale rewrite is recorded for everyone'

const startIndex = extSrc.indexOf(startMarker)
const endIndex = extSrc.indexOf(endMarker)

if (startIndex === -1 || endIndex === -1) {
  throw new Error(`Could not find marker boundaries in extension/extension.js (start: ${startIndex}, end: ${endIndex})`)
}

const extractedBlock = extSrc.slice(startIndex, endIndex)

function createExtensionHarness(tmpDir) {
  const root = tmpDir
  const MAX_BYTES = 1_000_000
  const SKIP = new Set(['HIVE_BOARD.md', 'HIVE_CHAT.md', 'HIVE_TASKS.md', 'HIVE_RULES.md', 'HIVE_MEMBERS.md', 'HIVE_FOR_AGENTS.md', '.hive.json'])
  const isIgnored = () => false
  const canOpen = () => true
  const canWrite = () => true
  const me = 'characterisation-tester'

  const fileDocs = new Map()
  const manifest = new Map()
  const bases = new Map()
  const forkBases = new Map()
  const known = new Set()
  const mtimes = new Map()
  const snappedBase = new Set()
  const preexisting = new Set()
  const icrlib = null

  const activityLog = []
  const chatLog = []
  const logActivity = (msg) => activityLog.push(msg)
  const say = (msg) => chatLog.push(msg)
  const markEditing = () => {}
  const noteCoEditing = () => {}
  const noteIfRewrite = () => {}
  const captureSnapshot = () => {}
  let lastLocalEdit = null

  function writeToDisk(r, text) {
    const full = path.join(root, r)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, text)
    try { mtimes.set(r, fs.statSync(full).mtimeMs) } catch {}
  }

  function openFile(r) {
    if (fileDocs.has(r)) return
    const doc = new Y.Doc()
    const text = doc.getText('content')
    fileDocs.set(r, { doc, text, synced: true })
  }

  const env = {
    fs, path, root, MAX_BYTES, SKIP, isIgnored, canOpen, canWrite, me,
    fileDocs, manifest, bases, forkBases, known, mtimes, snappedBase, preexisting,
    icrlib, logActivity, say, markEditing, noteCoEditing, noteIfRewrite,
    captureSnapshot, lastLocalEdit, writeToDisk, openFile
  }

  const factory = new Function(...Object.keys(env), `
    ${extractedBlock}
    return { reconcile, conflicted, icrWarned, bases, forkBases, known, preexisting, fileDocs, manifest }
  `)

  const instance = factory(...Object.values(env))

  return {
    root,
    writeToDisk,
    openFile,
    fileDocs,
    manifest,
    bases,
    forkBases,
    known,
    preexisting,
    conflicted: instance.conflicted,
    reconcile: instance.reconcile,
    activityLog,
    chatLog
  }
}

// Helpers
const norm = (s) => (s || '').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
function T(name, cond) {
  if (cond) { console.log(`  ok   ${name}`); pass++ }
  else { console.error(`  FAIL ${name}`); fail++ }
}

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-reconcile-char-'))
try {
  console.log('\n# 1. Disjoint 3-way merge')
  {
    const h = createExtensionHarness(tmpBase)
    const baseText = 'function foo() {\n  return 1\n}\nfunction bar() {\n  return 2\n}'
    const localText = 'function foo() {\n  return 10\n}\nfunction bar() {\n  return 2\n}'
    const remoteText = 'function foo() {\n  return 1\n}\nfunction bar() {\n  return 20\n}'

    h.openFile('test.js')
    h.fileDocs.get('test.js').text.insert(0, remoteText)
    h.writeToDisk('test.js', localText)
    h.bases.set('test.js', baseText)
    h.forkBases.set('test.js', baseText)

    h.reconcile('test.js', 'local')

    const disk = norm(fs.readFileSync(path.join(h.root, 'test.js'), 'utf8'))
    const doc = norm(h.fileDocs.get('test.js').text.toString())
    T('disjoint merge updates disk', disk === 'function foo() {\n  return 10\n}\nfunction bar() {\n  return 20\n}')
    T('disjoint merge updates doc to match disk', doc === disk)
    T('no conflict markers in conflicted set', !h.conflicted.has('test.js'))
  }

  console.log('\n# 2. Overlapping conflicting edits')
  {
    const h = createExtensionHarness(tmpBase)
    const baseText = 'function foo() {\n  return 1\n}'
    const localText = 'function foo() {\n  return 2\n}'
    const remoteText = 'function foo() {\n  return 3\n}'

    h.openFile('conflict.js')
    h.fileDocs.get('conflict.js').text.insert(0, remoteText)
    h.writeToDisk('conflict.js', localText)
    h.bases.set('conflict.js', baseText)
    h.forkBases.set('conflict.js', baseText)

    h.reconcile('conflict.js', 'local')

    const disk = norm(fs.readFileSync(path.join(h.root, 'conflict.js'), 'utf8'))
    T('conflict registered in conflicted set', h.conflicted.has('conflict.js'))
    T('conflict markers present on disk', disk.includes('<<<<<<< local (yours)') && disk.includes('>>>>>>> incoming (theirs)'))
  }

  console.log('\n# 3. Conflict resolution')
  {
    const h = createExtensionHarness(tmpBase)
    const markedDoc = 'function foo() {\n<<<<<<< local (yours)\n  return 2\n=======\n  return 3\n>>>>>>> incoming (theirs)\n}'
    const cleanDisk = 'function foo() {\n  return 42\n}'

    h.openFile('resolved.js')
    h.fileDocs.get('resolved.js').text.insert(0, markedDoc)
    h.writeToDisk('resolved.js', cleanDisk)
    h.bases.set('resolved.js', markedDoc)
    h.forkBases.set('resolved.js', markedDoc)
    h.conflicted.add('resolved.js')

    h.reconcile('resolved.js', 'local')

    const disk = norm(fs.readFileSync(path.join(h.root, 'resolved.js'), 'utf8'))
    const doc = norm(h.fileDocs.get('resolved.js').text.toString())
    T('clean resolution adopted on doc', doc === cleanDisk)
    T('conflicted set cleared', !h.conflicted.has('resolved.js'))
  }

  console.log('\n# 4. First-contact adopt (preexisting file on join)')
  {
    const h = createExtensionHarness(tmpBase)
    const localDisk = 'local preexisting file'
    const roomDoc = 'room authoritative version'

    h.preexisting.add('pre.js')
    h.openFile('pre.js')
    h.fileDocs.get('pre.js').text.insert(0, roomDoc)
    h.writeToDisk('pre.js', localDisk)

    h.reconcile('pre.js', 'local')

    const disk = norm(fs.readFileSync(path.join(h.root, 'pre.js'), 'utf8'))
    T('preexisting local file adopted from room', disk === roomDoc)
    T('bases updated to room copy', h.bases.get('pre.js') === roomDoc)
  }

  console.log('\n# 5. Concurrent creation race (non-preexisting file)')
  {
    const h = createExtensionHarness(tmpBase)
    const localDisk = 'console.log("local author")\n'
    const roomDoc = 'console.log("remote author")\n'

    // Not in preexisting
    h.openFile('race.js')
    h.fileDocs.get('race.js').text.insert(0, roomDoc)
    h.writeToDisk('race.js', localDisk)

    h.reconcile('race.js', 'local')

    const disk = norm(fs.readFileSync(path.join(h.root, 'race.js'), 'utf8'))
    T('disjoint creations unioned from empty base', disk.includes('local author') && disk.includes('remote author'))
  }

  console.log('\n# 6. Rejoin clobber behavior (pinning extension.js bug/divergence)')
  {
    const h = createExtensionHarness(tmpBase)
    const offlineWork = 'offline authored edits'
    const staleRoom = 'stale room version'

    // Extension does NOT track priorShadow, so when rejoining a room,
    // preexisting has the file and bases has no entry yet.
    h.preexisting.add('rejoin.js')
    h.openFile('rejoin.js')
    h.fileDocs.get('rejoin.js').text.insert(0, staleRoom)
    h.writeToDisk('rejoin.js', offlineWork)

    h.reconcile('rejoin.js', 'local')

    const disk = norm(fs.readFileSync(path.join(h.root, 'rejoin.js'), 'utf8'))
    // Characterisation test pins that extension.js CURRENTLY clobbers offline edits on rejoin (no priorShadow):
    T('extension.js currently clobbers offline edits on rejoin (no priorShadow)', disk === staleRoom)
  }

  console.log('\n# 7. Empty room doc protection (HIV-20 fix)')
  {
    const h = createExtensionHarness(tmpBase)
    const valuableDisk = 'do not delete this content'

    h.openFile('empty_test.js')
    // room doc is empty
    h.writeToDisk('empty_test.js', valuableDisk)

    h.reconcile('empty_test.js', 'local')

    const disk = norm(fs.readFileSync(path.join(h.root, 'empty_test.js'), 'utf8'))
    const doc = norm(h.fileDocs.get('empty_test.js').text.toString())
    T('valuable disk text is NOT zeroed', disk === valuableDisk)
    T('local disk text published to room doc', doc === valuableDisk)
  }

  console.log('\n# 8. Identical text no-op')
  {
    const h = createExtensionHarness(tmpBase)
    const same = 'const x = 1\n'

    h.openFile('same.js')
    h.fileDocs.get('same.js').text.insert(0, same)
    h.writeToDisk('same.js', same)

    h.reconcile('same.js', 'local')

    T('base set to text', h.bases.get('same.js') === same)
    T('known set includes file', h.known.has('same.js'))
  }

  console.log('\n# 9. Binary / oversize files left untouched')
  {
    const h = createExtensionHarness(tmpBase)
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff])
    const full = path.join(h.root, 'binary.dat')
    fs.writeFileSync(full, binaryData)

    h.openFile('binary.dat')
    h.fileDocs.get('binary.dat').text.insert(0, 'stale text')

    h.reconcile('binary.dat', 'local')

    const disk = fs.readFileSync(full)
    T('binary disk content untouched', disk.equals(binaryData))
    T('doc text untouched', h.fileDocs.get('binary.dat').text.toString() === 'stale text')
  }

} finally {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== EXTENSION RECONCILE: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED of ' + (pass + fail)} ===`)
process.exit(fail === 0 ? 0 : 1)
