// reconcile.cjs — Single source of truth for the 3-way reconcile & merge engine.
//
// CommonJS on purpose: sync.js is ESM and the VS Code extension is CJS.
// A .cjs file is the one shape both can load synchronously without duplication.
//
// Acceptance criteria (HIV-8), re-checked 21 Sep 2026 -- FOUR OF FIVE MET:
//   1. MET      one module exports reconcile() and its dependencies (11 exports).
//   2. MET      core.js re-exports from here and sync.js imports core.js. One copy.
//   3. NOT MET  extension/extension.js does NOT require this file. It requires
//               ./icr.cjs (the ICR bundle) and keeps its OWN reconcile() at
//               extension/extension.js:1166. The second copy is still there.
//   4. MET      node tests/test.js -- 95 passed, 0 failed.
//   5. MET      node tests/conflict-test.mjs -- ALL 4 PASS.
//
// Criterion 3 read "No second copy anywhere" while a second copy existed, in a file
// that ships in package.json files[]. A comment asserting an invariant it does not
// hold is worse than no comment: the next reader trusts it and stops looking. Corrected
// to what is true rather than deleted, because the gap is the useful part.
//
// WHAT ACTUALLY GUARDS THE DRIFT, since it is not this file:
//   tests/extension-parity-test.mjs                  the ICR bundle vs the engine, 24/24
//   tests/extension-reconcile-characterisation-test.mjs   pins the extension's own copy
// Those two measure that the copies AGREE. They do not make it one copy, and closing
// criterion 3 for real means the extension loading this module.

const fs = require('fs')
const path = require('path')

// Minimal text diff: replace only the changed middle, preserving the common
// prefix/suffix. Applied to a Y.Text so edits stay small (good for CRDT churn).
function applyDiff(ytext, next) {
  const cur = ytext.toString()
  if (cur === next) return false
  let p = 0
  while (p < cur.length && p < next.length && cur[p] === next[p]) p++
  let s = 0
  while (s < cur.length - p && s < next.length - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++
  if (cur.length - p - s > 0) ytext.delete(p, cur.length - p - s)
  const ins = next.slice(p, next.length - s)
  if (ins) ytext.insert(p, ins)
  return true
}

// Detect REAL git-style conflict markers in a file. Line-anchored on purpose.
function hasConflictMarkers(text) {
  return /^<<<<<<< /m.test(text || '') && /^>>>>>>> /m.test(text || '')
}

// Strip and de-nest conflict markers to prevent exponential 2^N code ballooning
function stripConflictMarkers(text, prefer = 'local') {
  if (!text || !hasConflictMarkers(text)) return text || ''
  const lines = text.split('\n')
  const out = []
  let inConflict = false
  let inTheirs = false
  const localBlock = []
  const theirsBlock = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^<<<<<<< /.test(line)) {
      inConflict = true
      inTheirs = false
      localBlock.length = 0
      theirsBlock.length = 0
      continue
    }
    if (/^=======$/.test(line) && inConflict) {
      inTheirs = true
      continue
    }
    if (/^>>>>>>> /.test(line) && inConflict) {
      inConflict = false
      out.push(...(prefer === 'theirs' ? theirsBlock : localBlock))
      continue
    }
    if (inConflict) {
      if (inTheirs) theirsBlock.push(line)
      else localBlock.push(line)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

// Which base line-range an edit replaced, and the replacement lines.
function changedRange(base, other) {
  let p = 0
  while (p < base.length && p < other.length && base[p] === other[p]) p++
  let s = 0
  while (s < base.length - p && s < other.length - p && base[base.length - 1 - s] === other[other.length - 1 - s]) s++
  return { startBase: p, endBase: base.length - s, newLines: other.slice(p, other.length - s) }
}

// Best-effort "what was defined here" across common languages — for the board.
function symbolsIn(text) {
  const names = new Set()
  const add = (re) => { let m; while ((m = re.exec(text)) && names.size < 8) names.add(m[1]) }
  add(/\bfunction\s+(\w+)/g)
  add(/\bclass\s+(\w+)/g)
  add(/\bdef\s+(\w+)/g)
  add(/\b(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g)
  return [...names].slice(0, 8)
}

// Classify a change as a small PATCH vs wholesale REWRITE.
function summarizeChange(base, next) {
  const b = (base || '').split('\n')
  const n = (next || '').split('\n')
  if (!base) return { isRewrite: false, changedLines: n.length, totalLines: n.length, symbols: symbolsIn(next || '') }
  const r = changedRange(b, n)
  const churn = Math.max(r.endBase - r.startBase, r.newLines.length)
  const total = Math.max(b.length, n.length)
  const isRewrite = total > 0 && churn >= 4 && churn / total >= 0.5
  return { isRewrite, changedLines: churn, totalLines: total, symbols: symbolsIn(r.newLines.join('\n')) }
}

// 3-way merge for the sync layer (disk <-> shared doc)
function merge3(base, mine, theirs) {
  if (mine === theirs) return { text: mine, conflict: false }
  if (base === theirs) return { text: mine, conflict: false }
  if (base === mine) return { text: theirs, conflict: false }

  const cleanBase = hasConflictMarkers(base) ? stripConflictMarkers(base, 'local') : (base || '')
  const cleanMine = hasConflictMarkers(mine) ? stripConflictMarkers(mine, 'local') : (mine || '')
  const cleanTheirs = hasConflictMarkers(theirs) ? stripConflictMarkers(theirs, 'theirs') : (theirs || '')

  if (cleanMine === cleanTheirs) return { text: cleanMine, conflict: false }
  if (cleanBase === cleanTheirs) return { text: cleanMine, conflict: false }
  if (cleanBase === cleanMine) return { text: cleanTheirs, conflict: false }

  const b = cleanBase.split('\n')
  const mr = changedRange(b, cleanMine.split('\n'))
  const tr = changedRange(b, cleanTheirs.split('\n'))
  if (mr.endBase <= tr.startBase || tr.endBase <= mr.startBase) {
    const out = b.slice()
    for (const e of [mr, tr].sort((x, y) => y.startBase - x.startBase)) {
      out.splice(e.startBase, e.endBase - e.startBase, ...e.newLines)
    }
    return { text: out.join('\n'), conflict: false }
  }
  const start = Math.min(mr.startBase, tr.startBase)
  const end = Math.max(mr.endBase, tr.endBase)
  const mineBlock = [...b.slice(start, mr.startBase), ...mr.newLines, ...b.slice(mr.endBase, end)]
  const theirsBlock = [...b.slice(start, tr.startBase), ...tr.newLines, ...b.slice(tr.endBase, end)]
  const out = [
    ...b.slice(0, start),
    '<<<<<<< local (yours)',
    ...mineBlock,
    '=======',
    ...theirsBlock,
    '>>>>>>> incoming (theirs)',
    ...b.slice(end),
  ]
  return { text: out.join('\n'), conflict: true }
}

function describeConflicts(cs) {
  return (cs || []).map((c) =>
    c.startsWith('ref:') ? `'${c.slice(4)}' was removed or renamed but is still used`
      : c.startsWith('fn:') ? `both sides changed function ${c.slice(3)}`
        : c.startsWith('class:') ? `both sides changed class ${c.slice(6)}`
          : `both sides changed ${c.replace(/^\w+:/, '')}`).join('; ')
}

function icrMerge3(base, mine, theirs, relPath, icrlib) {
  const lm = merge3(base, mine, theirs)
  if (!icrlib || !icrlib.supports || !icrlib.supports(relPath)) return lm
  let r
  try { r = icrlib.structuralMerge(base, mine, theirs, { filename: relPath }) } catch (e) { return lm }
  if (r.status === 'auto') {
    const renamed = r.renames && r.renames.length
    return { text: r.text, conflict: false, icr: renamed ? 'rename' : 'structural', icrWarning: renamed ? `auto-applied rename ${r.renames.join(', ')}` : undefined }
  }
  if (r.status === 'semantic-conflict') return Object.assign({}, lm, { icrWarning: describeConflicts(r.conflicts) })
  return lm
}

// createReconciler: binds to a session's maps, state, and callbacks, returning
// a reconcile(relPath, origin = 'local') function.
function createReconciler(ctx) {
  const {
    root,
    name = 'anon',
    SKIP = new Set(['HIVE_BOARD.md', 'HIVE_CHAT.md', 'HIVE_TASKS.md', 'HIVE_RULES.md', 'HIVE_MEMBERS.md', 'HIVE_FOR_AGENTS.md', '.hive.json']),
    isIgnored = () => false,
    canOpen = () => true,
    canWrite = () => true,
    readText = (full) => {
      try {
        const buf = fs.readFileSync(full)
        if (buf.length > 1_000_000 || buf.includes(0)) return null
        return buf.toString('utf8')
      } catch { return null }
    },
    writeToDisk,
    openFile,
    touchFile,
    fileDocs,
    manifest,
    bases,
    forkBases,
    known,
    mtimes,
    conflicted = new Set(),
    icrWarned = new Map(),
    snappedBase = new Set(),
    preexisting = new Set(),
    priorShadow,
    shadow,
    say = () => {},
    log = () => {},
    markEditing = () => {},
    noteCoEditing = () => {},
    noteIfRewrite = () => {},
    captureSnapshot = () => {},
    lastLocalEdit,
    // Fork-gate & provenance
    FORK_GATE = false,
    captureLocal,
    forkRecord,
    forkBlock,
    detectFork,
    renderConflict,
    adoptResolved,
    stampProvenance,
    attestHead,
    fusionReason,
    supports,
    languageFor,
    icrlib
  } = ctx

  return function reconcile(relPath, origin = 'local') {
    if (SKIP.has(relPath) || isIgnored(relPath)) return
    if (!canOpen(relPath)) return
    const full = path.join(root, relPath)
    const exists = fs.existsSync(full)
    const disk = exists ? readText(full) : null
    if (exists && disk === null) return

    if (origin === 'local' && !canWrite(relPath)) {
      const fe2 = fileDocs.get(relPath)
      if (fe2 && fe2.synced) {
        const dt = fe2.text.toString()
        if (dt && dt !== disk) writeToDisk(relPath, dt)
      }
      return
    }

    let fe = fileDocs.get(relPath)
    if (!fe) { if (disk === null) return; openFile(relPath); return }
    if (!fe.synced) return
    if (touchFile) touchFile(relPath)

    if (FORK_GATE && captureLocal) captureLocal(relPath)

    if (FORK_GATE && fe.conflict && forkRecord) {
      const rec = forkRecord(fe)
      if (rec) {
        const block = forkBlock(fe, rec)
        if (origin === 'local') {
          if (disk === block) return
          const fork0 = forkBases.get(relPath)
          const sawMarkers = fork0 === block || hasConflictMarkers(fork0 || '')
          if (sawMarkers && disk !== null && !hasConflictMarkers(disk)) {
            fe.doc.transact(() => {
              applyDiff(fe.text, disk)
              for (const v of rec.versions) fe.forkmark.set(v.hash, 1)
              for (const key of [...fe.conflict.keys()]) fe.conflict.delete(key)
            })
            if (stampProvenance) stampProvenance(relPath, block || '', disk)
            conflicted.delete(relPath)
            known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk)
            try { say(`✓ conflict in ${relPath} resolved by ${name}.`) } catch { }
            return
          }
          if (!sawMarkers && disk !== null && disk !== fork0) {
            if (detectFork) detectFork(relPath)
            return
          }
          if (renderConflict) renderConflict(relPath)
          return
        }
        if (renderConflict) renderConflict(relPath)
        return
      }
      if (disk !== null && hasConflictMarkers(disk) && !hasConflictMarkers(fe.text.toString())) {
        if (adoptResolved) { adoptResolved(relPath); return }
      }
    }

    const docText = fe.text.toString()
    const noHistory = !bases.has(relPath) && !(priorShadow && priorShadow.has(relPath))
    if (docText === '' && (!manifest.has(relPath) || (disk && noHistory))) {
      if (disk === null) return
      fe.doc.transact(() => applyDiff(fe.text, disk))
      if (stampProvenance) stampProvenance(relPath, '', disk)
      manifest.set(relPath, 1)
      known.add(relPath); bases.set(relPath, disk); forkBases.set(relPath, disk)
      if (shadow) shadow.set(relPath, disk)
      try { mtimes.set(relPath, fs.statSync(full).mtimeMs) } catch { }
      captureSnapshot(relPath, disk, name, { force: true, kind: 'base', label: 'created' })
      snappedBase.add(relPath)
      return
    }

    const yt = fe.text
    if (disk === null) {
      writeToDisk(relPath, docText)
      bases.set(relPath, docText); forkBases.set(relPath, docText)
      return
    }

    if (disk === docText) {
      if (origin === 'local' && !known.has(relPath) && disk) markEditing(relPath)
      known.add(relPath); bases.set(relPath, disk)
      if (shadow) shadow.set(relPath, disk)
      if (!forkBases.has(relPath) || origin === 'local') forkBases.set(relPath, disk)
      if (!snappedBase.has(relPath) && disk) {
        captureSnapshot(relPath, disk, name, { force: true, kind: 'base', label: 'baseline' })
        snappedBase.add(relPath)
      }
      return
    }

    // FIRST-CONTACT ADOPT
    if (!bases.has(relPath) && docText !== '' && disk !== docText) {
      if (!preexisting.has(relPath)) {
        const nl = (s) => (s === '' || s.endsWith('\n') ? s : s + '\n')
        const r0 = icrMerge3('', nl(disk), nl(docText), relPath, icrlib)
        if (r0.text !== docText) fe.doc.transact(() => applyDiff(yt, r0.text))
        if (r0.text !== disk) writeToDisk(relPath, r0.text)
        if (r0.conflict) conflicted.add(relPath)
        bases.set(relPath, r0.text); forkBases.set(relPath, r0.text)
        if (shadow) shadow.set(relPath, r0.text)
        if (!manifest.has(relPath)) manifest.set(relPath, 1)
        try { say(`⚠ ${relPath} was created by two participants at once — both versions were merged${r0.conflict ? ', and CONFLICT markers need resolving' : ''}.`) } catch { }
        return
      }
      const anc = priorShadow ? priorShadow.get(relPath) : undefined
      if (anc !== undefined && disk !== null) {
        if (disk === anc) {
          writeToDisk(relPath, docText)
          bases.set(relPath, docText); forkBases.set(relPath, docText)
          if (!snappedBase.has(relPath)) {
            captureSnapshot(relPath, docText, name, { force: true, kind: 'base', label: 'room copy adopted on rejoin (local was unchanged)' })
            snappedBase.add(relPath)
          }
          return
        }
        captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy before rejoin merge' })
        const rj = icrMerge3(anc, disk, docText, relPath, icrlib)
        if (rj.text !== docText) fe.doc.transact(() => applyDiff(yt, rj.text))
        if (rj.text !== disk) writeToDisk(relPath, rj.text)
        if (rj.conflict) conflicted.add(relPath)
        bases.set(relPath, rj.text); forkBases.set(relPath, rj.text)
        if (shadow) shadow.set(relPath, rj.text)
        if (!manifest.has(relPath)) manifest.set(relPath, 1)
        try { say(`⚠ ${relPath} changed locally while ${name} was disconnected — the local edit and the room copy were merged${rj.conflict ? ', and CONFLICT markers need resolving' : ''}. Pre-merge local copy is in the file's history.`) } catch { }
        return
      }
      captureSnapshot(relPath, disk, name, { force: true, kind: 'manual', label: 'local copy at join (room copy adopted)' })
      writeToDisk(relPath, docText)
      bases.set(relPath, docText); forkBases.set(relPath, docText)
      if (!snappedBase.has(relPath)) {
        captureSnapshot(relPath, docText, name, { force: true, kind: 'base', label: 'adopted from room at join' })
        snappedBase.add(relPath)
      }
      try { say(`↓ ${relPath} already existed in this room — ${name} adopted the room's copy. The local version before joining is saved in the file's history.`) } catch { }
      return
    }

    const base = bases.has(relPath) ? bases.get(relPath) : disk
    const fork = forkBases.has(relPath) ? forkBases.get(relPath) : base
    if (origin === 'local') { noteCoEditing(relPath); markEditing(relPath) }

    let res, reAdded = false
    if (origin === 'local' && hasConflictMarkers(docText) && !hasConflictMarkers(disk)) {
      res = { text: disk, conflict: false }
    } else if (origin === 'local') {
      noteIfRewrite(relPath, fork, disk)
      const sc = summarizeChange(fork, disk)
      const isCleanRewrite = sc.isRewrite && supports && supports(relPath) && languageFor && languageFor(relPath).parses(disk)
      const theirsNew = changedRange(fork.split('\n'), docText.split('\n')).newLines.filter((l) => l.length)
      const mineLines = new Set(disk.split('\n'))
      const integrated = theirsNew.every((l) => mineLines.has(l))
      if (integrated || (isCleanRewrite && !hasConflictMarkers(docText))) {
        res = { text: disk, conflict: false }
      } else {
        res = icrMerge3(fork, disk, docText, relPath, icrlib)
        reAdded = !res.conflict && res.text !== disk
      }
    } else {
      res = icrMerge3(base, disk, docText, relPath, icrlib)
    }

    if (res && !res.conflict && fusionReason) {
      const why = fusionReason(res.text, disk, docText, (supports && supports(relPath)) ? languageFor(relPath) : null)
      if (why) {
        conflicted.add(relPath)
        if (icrWarned.get(relPath) !== why) {
          icrWarned.set(relPath, why)
          log(`[${name}] !! REFUSED a fused merge of ${relPath}: ${why}`)
          try {
            say(`[!] @all ${relPath}: a merge was REFUSED because it fused rather than merged — ${why}. Nothing was written: the room's copy and ${name}'s local copy are both intact and unchanged. Someone must reconcile them deliberately; a plain file write will merge against the other version again, hive_edit replaces it outright.`)
          } catch { }
        }
        return
      }
    }

    if (origin === 'local' && res.text !== docText) {
      const sc = summarizeChange(docText, res.text)
      captureSnapshot(relPath, docText, name, { force: sc.isRewrite, churn: `${sc.changedLines}/${sc.totalLines} lines` })
      if (typeof lastLocalEdit === 'function') lastLocalEdit(relPath)
    }
    fe.doc.transact(() => applyDiff(yt, res.text))
    if (origin === 'local') {
      if (FORK_GATE) { if (res.text !== docText && attestHead) attestHead(relPath, res.text, docText) }
      else if (res.text !== docText && stampProvenance) stampProvenance(relPath, docText, res.text)
    }
    if (res.text !== disk) writeToDisk(relPath, res.text)
    known.add(relPath); bases.set(relPath, res.text)
    if (origin === 'local') forkBases.set(relPath, res.text)
    else if (!forkBases.get(relPath)) forkBases.set(relPath, res.text)

    const hasMarkers = res.conflict || hasConflictMarkers(res.text)
    if (hasMarkers && !conflicted.has(relPath)) {
      conflicted.add(relPath)
      log(`[${name}] ⚠ merge conflict in ${relPath} — kept BOTH versions with <<<<<<< markers`)
      try { say(`⚠ MERGE CONFLICT in ${relPath} — it has <<<<<<< markers. Whoever owns it: resolve before continuing.`) } catch { }
    } else if (!hasMarkers && conflicted.has(relPath)) {
      conflicted.delete(relPath)
      try { say(`✓ conflict in ${relPath} resolved.`) } catch { }
    } else if (reAdded) {
      log(`[${name}] protected ${relPath}: your edit was based on an older version — re-added changes that arrived since (nobody's work lost)`)
      try { say(`↺ ${relPath}: ${name}'s edit was based on an older copy — kept the changes that landed in between (nothing lost).`) } catch { }
    } else if (!hasMarkers && res.icr === 'rename') {
      log(`[${name}] ICR merged ${relPath} (detected a rename and updated the call sites)`)
    } else if (!hasMarkers && res.icr === 'structural') {
      log(`[${name}] ICR merged ${relPath} structurally (both edits kept, syntax guaranteed)`)
    } else if (!hasMarkers) {
      log(`[${name}] merged ${relPath} (both edits kept)`)
    }

    if (res.icrWarning && icrWarned.get(relPath) !== res.icrWarning) {
      icrWarned.set(relPath, res.icrWarning)
      log(`[${name}] ⚠ ICR flag in ${relPath} — ${res.icrWarning}`)
      try { say(`⚠ ICR flag in ${relPath}: ${res.icrWarning}. It merged, but review — this is a break a plain merge can't see.`) } catch { }
    } else if (!res.icrWarning && icrWarned.has(relPath)) {
      icrWarned.delete(relPath)
    }

    if (detectFork) detectFork(relPath)
  }
}

// reconcile direct call
function reconcile(ctx, relPath, origin = 'local') {
  return createReconciler(ctx)(relPath, origin)
}

module.exports = {
  reconcile,
  createReconciler,
  applyDiff,
  hasConflictMarkers,
  stripConflictMarkers,
  changedRange,
  symbolsIn,
  summarizeChange,
  merge3,
  describeConflicts,
  icrMerge3
}
