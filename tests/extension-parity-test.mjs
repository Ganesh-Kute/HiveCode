// extension parity: every hand-maintained link between the engine and the extension, made loud.
//
//   node tests/extension-parity-test.mjs
//
// THE EXTENSION IS A SHIPPED SURFACE -- `hivecode` v0.9.3 on the VS Code marketplace -- and it is
// CommonJS, packaged separately, so it cannot import the ESM engine. Two links bridge that gap and
// BOTH were maintained by hand:
//
//   1. extension/icr.cjs is GENERATED from icr.js + lang-*.js by scripts/build-icr-cjs.cjs, whose
//      header says "Re-run this whenever a source changes". That sentence is an instruction to a
//      person, not a mechanism.
//   2. extension/extension.js carries its own reconcile(), written by hand beside the one in
//      sync.js.
//
// MEASURED 19 Sep 2026, and both links were broken:
//
//   - the committed bundle was 132,461 bytes; regenerating produced 152,558. 373 insertions of
//     engine work had never reached the extension, and v0.9.3 shipped with it.
//   - the two reconcile() functions share 34 lines. sync.js has 182 code lines, the extension 105,
//     and 126 exist only in sync.js. They are not two copies of one function; they are two
//     functions with the same name, and one of them is missing a bug fix the other has.
//
// This file does not merge them. It makes the next divergence FAIL A TEST instead of shipping.
// That is the distinction learnings/repair-the-class-not-the-copy.md turns on: the point is not to
// hand-repair both copies, it is to leave behind something that fails when a new one appears.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** The body of a named function, by brace balance from its declaration. */
function bodyOf(file, declRe) {
  const lines = read(file).split('\n')
  const start = lines.findIndex((l) => declRe.test(l))
  if (start === -1) return null
  let depth = 0, on = false, out = []
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i])
    for (const c of lines[i]) { if (c === '{') { depth++; on = true } else if (c === '}') depth-- }
    if (on && depth === 0) break
  }
  return out.join('\n')
}

// ── A. THE GENERATED BUNDLE IS CURRENT ────────────────────────────────────────
console.log('\n# A. extension/icr.cjs vs the sources it is generated from')
{
  // Generated into a temp file, never over the real one -- a test that rewrites the repo to make
  // itself pass is not a test.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hive-parity-')), 'icr.cjs')
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-icr-cjs.cjs'), tmp],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
  T('A1 the generator runs', r.status === 0, (r.stderr || '').split('\n')[0])

  if (r.status === 0) {
    const fresh = fs.readFileSync(tmp, 'utf8').replace(/\r\n/g, '\n')
    const shipped = read('extension/icr.cjs')
    // THE ASSERTION THIS SECTION EXISTS FOR. A stale bundle means the extension's merge engine is
    // older than the relay's, silently, for everyone who installed it -- and nothing anywhere
    // reported that, because the bundle loads fine and merges fine. It is just behind.
    T('A2 THE SHIPPED BUNDLE IS CURRENT — regenerate with `node scripts/build-icr-cjs.cjs` if this fails',
      fresh === shipped, fresh === shipped ? '' : `${shipped.length} shipped vs ${fresh.length} fresh — ${Math.abs(fresh.length - shipped.length)} bytes behind`)
    T('A3 and it carries the banner that says not to edit it by hand',
      /AUTO-GENERATED/.test(shipped))
  }
  try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }) } catch { }
}

// ── B. THE RECONCILE DIVERGENCE IS PINNED ─────────────────────────────────────
console.log('\n# B. the two reconcile() implementations')
{
  const sync = bodyOf('sync.js', /^\s*function reconcile\(relPath/)
  const ext = bodyOf('extension/extension.js', /^\s*function reconcile\(r,/)
  T('B1 both implementations are still findable', !!sync && !!ext,
    `sync=${sync ? sync.split('\n').length : 0} lines, ext=${ext ? ext.split('\n').length : 0} lines`)

  // A capability is a distinctive marker in the function body. Word presence is a PROXY for
  // behaviour, not a proof of it -- but it is an exact proxy for "this concept appears here at
  // all", which is the thing that silently differs. Each entry is pinned to what is true TODAY,
  // so the failure this catches is a CHANGE, not an absolute.
  const CAPABILITIES = [
    { id: 'rejoin-ancestor', re: /shadow/i, sync: true, ext: false,
      note: 'the .hive-shadow.json ancestor that makes a rejoin a 3-way merge instead of an overwrite. sync.js has it and 17 assertions cover it (tests/rejoin-clobber-test.mjs). The extension has ZERO mentions of shadow in 109 KB, so a VS Code user who reconnects after editing offline loses those edits — the exact bug fixed on the engine side, still live on the shipped surface.' },
    { id: 'provenance', re: /provenance/i, sync: true, ext: false,
      note: 'signed receipts per landed change. Without it the extension contributes no attribution, so hive-pr cannot credit work done through the extension and its staleness guard cannot account for it either.' },
    { id: 'attestation', re: /attest/i, sync: true, ext: false,
      note: 'head attestation — the room agreeing on what a file currently holds.' },
    { id: 'icr-merge', re: /icrMerge|ICR/i, sync: true, ext: true,
      note: 'structural merge. Present on both, which is what section A is protecting.' },
    { id: 'fork-surfacing', re: /fork/i, sync: true, ext: true,
      note: 'silent-fork detection. Present on both, but sync.js mentions it 36 times to the extension\'s 12 — present is not equivalent.' },
    { id: 'conflict-markers', re: /hasConflict/i, sync: true, ext: true,
      note: 'refusing to merge over unresolved markers.' },
    { id: 'empty-doc-guard', re: /docText === ''|=== ''/, sync: true, ext: true,
      note: 'HIV-20 — an unsynced doc reads as empty and must not zero the disk.' },
  ]

  for (const c of CAPABILITIES) {
    const inSync = c.re.test(sync || ''), inExt = c.re.test(ext || '')
    const asPinned = inSync === c.sync && inExt === c.ext
    T(`B2 ${c.id}: sync=${inSync} ext=${inExt}`, asPinned,
      asPinned ? '' : `PINNED sync=${c.sync} ext=${c.ext} — the divergence between these two copies just CHANGED. If you added a capability to sync.js, the extension does not have it: decide deliberately, then update this pin.`)
  }

  const gaps = CAPABILITIES.filter((c) => c.sync && !c.ext)
  console.log('')
  for (const g of gaps) console.log(`  DIVERGENCE  ${g.id} — ${g.note}`)

  // Pinned as a COUNT as well as individually: adding a new sync-only capability without adding a
  // pin for it would otherwise pass silently.
  T(`B3 there are still ${gaps.length} known sync-only capabilities — raise this deliberately, never by accident`,
    gaps.length === 3, `${gaps.length}: ${gaps.map((g) => g.id).join(', ')}`)
}

// ── C. the characterisation suite is the safety net for any extraction ────────
console.log('\n# C. the net that has to exist before these are merged')
{
  const p = 'tests/extension-reconcile-characterisation-test.mjs'
  T('C1 the characterisation suite exists', fs.existsSync(path.join(ROOT, p)))

  // It was committed on 18 Sep containing ITSELF TWICE -- the whole file, appended to the whole
  // file -- so `import fs` was declared twice and it had never executed once. The ticket said
  // "step 1 landed". A file existing is not a file running, and nothing checked.
  const src = read(p)
  const headers = (src.match(/^\/\/ CHARACTERISATION TEST/gm) || []).length
  T('C2 IT IS NOT DUPLICATED — it shipped containing itself twice and had never run',
    headers === 1, `${headers} copies of the header`)

  const r = spawnSync(process.execPath, [path.join(ROOT, p)], { cwd: ROOT, encoding: 'utf8', timeout: 120000 })
  T('C3 AND IT ACTUALLY RUNS', r.status === 0, (r.stdout || '').trim().split('\n').pop())
  T('C4 it pins the rejoin divergence as CURRENT behaviour, which is what a characterisation test is for',
    /clobbers offline edits on rejoin/.test(r.stdout || ''))
}

// ── D. BEHAVIOURAL parity, not textual ────────────────────────────────────────
console.log('\n# D. the bundle and the engine answer the same')
{
  // Section A proves the bundle was generated from current sources. This proves the generated
  // thing BEHAVES like the thing it was generated from -- a different claim, and the one that
  // matters, because the generator strips ESM syntax and re-wraps every file in its own scope.
  // A bundle that is byte-current and silently broken would pass A and fail here.
  const esm = await import('../icr.js')
  const { createRequire } = await import('module')
  const cjs = createRequire(import.meta.url)(path.join(ROOT, 'extension', 'icr.cjs'))

  const CASES = [
    { n: 'disjoint js functions', f: 'x.js',
      b: 'function a() { return 1 }\n\nfunction b() { return 2 }\n',
      o: 'function a() { return 10 }\n\nfunction b() { return 2 }\n',
      t: 'function a() { return 1 }\n\nfunction b() { return 20 }\n' },
    { n: 'same-function clash', f: 'x.js',
      b: 'function a() { return 1 }\n', o: 'function a() { return 2 }\n', t: 'function a() { return 3 }\n' },
    { n: 'python disjoint', f: 'x.py',
      b: 'def a():\n    return 1\n\ndef b():\n    return 2\n',
      o: 'def a():\n    return 10\n\ndef b():\n    return 2\n',
      t: 'def a():\n    return 1\n\ndef b():\n    return 20\n' },
    { n: 'a rename with call sites', f: 'x.js',
      b: 'function helper() { return 1 }\n\nfunction main() { return helper() }\n',
      o: 'function fetchData() { return 1 }\n\nfunction main() { return fetchData() }\n',
      t: 'function helper() { return 1 }\n\nfunction main() { return helper() }\n' },
    { n: 'unparseable input', f: 'x.js',
      b: 'function a() {', o: 'function a() { return', t: 'function a() { !!' },
    { n: 'json', f: 'x.json', b: '{"a":1,"b":2}\n', o: '{"a":9,"b":2}\n', t: '{"a":1,"b":8}\n' },
  ]

  let same = 0
  for (const c of CASES) {
    const opt = { filename: c.f }
    const a = (() => { try { return JSON.stringify(esm.structuralMerge(c.b, c.o, c.t, opt)) } catch (e) { return 'THREW ' + e.message } })()
    const b = (() => { try { return JSON.stringify(cjs.structuralMerge(c.b, c.o, c.t, opt)) } catch (e) { return 'THREW ' + e.message } })()
    const eq = a === b
    if (eq) same++
    T(`D1 ${c.n}`, eq, eq ? '' : `ESM and CJS DISAGREE\n        esm: ${String(a).slice(0, 160)}\n        cjs: ${String(b).slice(0, 160)}`)
  }
  T('D2 EVERY case answers identically — the bundle is the engine, not a copy of it',
    same === CASES.length, `${same}/${CASES.length}`)

  T('D3 and the language registry matches',
    ['x.js', 'x.py', 'x.json', 'x.yaml', 'x.toml', 'x.rb', 'x.txt'].every((f) => esm.supports(f) === cjs.supports(f)))
}

console.log(`\n=== EXTENSION PARITY: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
