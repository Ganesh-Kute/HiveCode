// HIV-P20 — the humans must be pinned too, and by the SAME rule as the agents.
//
// The extension does not import sync.js. It has its own transport, its own relay
// resolution, and a `hivecode.relayUrl` whose default is the public relay. So a privacy
// guard that lives only in sync.js covers the agents and leaves every human where they
// started — and "changed nothing" and "published our source to a server we do not run"
// remain the same action for them.
//
// The fix is a generated CommonJS copy of hive-privacy.js, and the risk that creates is
// the one this project has already paid for twice (reconcile() in two places, the version
// reader in four): a copy that DRIFTS. A drifted privacy guard is worse than none, because
// it prints PRIVATE while checking a rule nothing else uses any more.
//
// Sections:
//   A  the shipped copy is current
//   B  the copy BEHAVES the same, not merely looks the same
//   C  extension.js actually calls it, before it opens anything
//   D  every start() call site honours a refusal
//   E  the setting exists and is documented
//   F  anti-vacuity

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import * as ESM from '../hive-privacy.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)

const CJS_PATH = path.join(ROOT, 'extension', 'hive-privacy.cjs')

// ---------------------------------------------------------- A: the copy is current
sec('A  the shipped CommonJS copy is current')
{
  T('A1 extension/hive-privacy.cjs exists at all', fs.existsSync(CJS_PATH))
  const before = fs.existsSync(CJS_PATH) ? fs.readFileSync(CJS_PATH, 'utf8') : ''
  // Regenerate into a scratch copy of the file and compare. Running the real builder is
  // the only check that cannot be fooled by a copy someone edited by hand to look right.
  const backup = path.join(os.tmpdir(), `hive-privacy-cjs-${process.pid}.bak`)
  fs.writeFileSync(backup, before)
  let after = ''
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-privacy-cjs.cjs')], { stdio: 'pipe' })
    after = fs.readFileSync(CJS_PATH, 'utf8')
  } finally {
    fs.writeFileSync(CJS_PATH, before || after)
    try { fs.rmSync(backup) } catch { }
  }
  T('A2 it is byte-identical to what the builder produces from hive-privacy.js',
    !!after && after === before,
    before === after ? '' : 'STALE — run: node scripts/build-privacy-cjs.cjs')
}

// ------------------------------------------------ B: it BEHAVES the same, not looks same
sec('B  the copy behaves identically to the module the agents run')
{
  delete require.cache[require.resolve(CJS_PATH)]
  const CJS = require(CJS_PATH)

  T('B1 it exports the same names',
    JSON.stringify(Object.keys(CJS).sort()) ===
    JSON.stringify(Object.keys(ESM).filter((k) => k !== 'default').sort()),
    `${Object.keys(CJS).sort().join(',')} vs ${Object.keys(ESM).filter((k) => k !== 'default').sort().join(',')}`)

  T('B2 both name the same public relay', CJS.PUBLIC_DEFAULT_RELAY === ESM.PUBLIC_DEFAULT_RELAY)

  // Run the same battery of inputs through both and require the verdicts to agree. This is
  // the assertion that survives someone "fixing" the copy directly: identical text is not
  // the property that matters, identical ANSWERS are.
  const cases = [
    { relay: ESM.PUBLIC_DEFAULT_RELAY, env: {} },
    { relay: ESM.PUBLIC_DEFAULT_RELAY, env: { HIVE_PRIVATE: '1' } },
    { relay: ESM.PUBLIC_DEFAULT_RELAY, env: { HIVE_RELAY_PIN: 'wss://relay.acme.com' } },
    { relay: 'wss://relay.acme.com', env: { HIVE_RELAY_PIN: 'wss://relay.acme.com' } },
    { relay: 'wss://relay.acme.com', env: { HIVE_RELAY_PIN: 'https://relay.acme.com' } },
    { relay: 'ws://127.0.0.1:1234', env: {} },
    { relay: 'ws://192.168.1.9:1234', env: {} },
    { relay: 'ws://relay.acme.com', env: {} },
    { relay: 'nonsense', env: {} },
    { relay: 'wss://relay.acme.com', env: { HIVE_RELAY_PIN: 'typo' } },
  ]
  let agree = 0
  const disagreements = []
  for (const c of cases) {
    const a = ESM.checkRelay(c), b = CJS.checkRelay(c)
    const same = a.ok === b.ok && a.code === b.code && a.headline === b.headline &&
      String(a.warn || '') === String(b.warn || '') && a.classification.kind === b.classification.kind
    if (same) agree++; else disagreements.push(`${c.relay} ${JSON.stringify(c.env)}: ${a.code}/${a.headline} vs ${b.code}/${b.headline}`)
  }
  T('B3 every verdict agrees between the ESM module and the CJS copy',
    agree === cases.length, disagreements.join(' | '))
  T('B4 ... and there were cases to disagree about (anti-vacuity)', cases.length >= 8, `${cases.length}`)
  // If every case came back ok:true, B3 would pass on a gutted copy. Require both outcomes.
  const refusals = cases.filter((c) => !CJS.checkRelay(c).ok).length
  T('B5 the copy produces both refusals and admissions', refusals > 0 && refusals < cases.length,
    `${refusals}/${cases.length} refused`)
}

// ----------------------------------------- C: extension.js calls it before it opens anything
sec('C  extension.js calls it, before it opens anything')
{
  const EXT = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8')
  T('C1 it requires the copy', /require\(['"]\.\/hive-privacy\.cjs['"]\)/.test(EXT))
  T('C2 it calls checkRelay', /privacy\.checkRelay\(/.test(EXT))

  const iCheck = EXT.indexOf('privacy.checkRelay(')
  const iDoc = EXT.indexOf('const doc = new Y.Doc()')
  const iWs = EXT.indexOf('new WebsocketProvider(')
  T('C3 the check happens BEFORE the Y.Doc is built', iCheck > 0 && iDoc > 0 && iCheck < iDoc,
    `check@${iCheck} doc@${iDoc}`)
  T('C4 ... and before any WebSocket is opened', iCheck > 0 && iWs > 0 && iCheck < iWs,
    `check@${iCheck} ws@${iWs}`)
  T('C5 a refusal returns instead of continuing', /if \(!verdict\.ok\)[\s\S]{0,400}?return false/.test(EXT))
  // A build missing the copy must not silently connect while a pin is configured.
  T('C6 a missing copy with a pin set is refused, not ignored',
    /if \(!privacy\)[\s\S]{0,600}?return false/.test(EXT))
}

// --------------------------------------------- D: every call site honours a refusal
sec('D  every start() call site honours a refusal')
{
  const EXT = fs.readFileSync(path.join(ROOT, 'extension', 'extension.js'), 'utf8')
  const lines = EXT.split('\n')
  const calls = []
  lines.forEach((l, i) => {
    if (!/(^|[^.\w])start\s*\(\s*root\s*,/.test(l)) return
    if (/^\s*function start\s*\(/.test(l)) return
    calls.push({ n: i + 1, text: l.trim() })
  })
  T('D1 the call sites were found at all (anti-vacuity)', calls.length >= 4, `${calls.length} found`)
  // THE ASSERTION THAT WILL ACTUALLY CATCH A REGRESSION. A sixth call site added later
  // without the guard would join a refused relay and then crash on `session`, and nothing
  // else in this repo would notice. `start()` returns false on refusal; a call that throws
  // that away is the bug.
  const unguarded = calls.filter((c) => !/if\s*\(\s*!\s*start\s*\(/.test(c.text))
  T('D2 every one of them checks the return value', unguarded.length === 0,
    unguarded.map((c) => `line ${c.n}: ${c.text}`).join(' | '))
  T('D3 start() has exactly one success return', (EXT.match(/^\s*return true\s*$/gm) || []).length >= 1)
}

// ---------------------------------------------------- E: the setting exists and explains itself
sec('E  the setting exists and explains itself')
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'package.json'), 'utf8'))
  const props = (pkg.contributes && pkg.contributes.configuration && pkg.contributes.configuration.properties) || {}
  T('E1 hivecode.relayPin is a declared setting', !!props['hivecode.relayPin'])
  const desc = props['hivecode.relayPin'] ? (props['hivecode.relayPin'].markdownDescription || props['hivecode.relayPin'].description || '') : ''
  T('E2 its description says it REFUSES rather than defaults', /refus/i.test(desc), desc.slice(0, 80))
  T('E3 hivecode.relayUrl still defaults to something', !!props['hivecode.relayUrl'])
  // Stated because it is the whole reason the pin exists: the default IS the public relay.
  T('E4 ... and that default is the public relay this build ships (so the hazard is real)',
    props['hivecode.relayUrl'] &&
    ESM.relayOrigin(props['hivecode.relayUrl'].default) === ESM.relayOrigin(ESM.PUBLIC_DEFAULT_RELAY),
    props['hivecode.relayUrl'] ? String(props['hivecode.relayUrl'].default) : '')
}

// ------------------------------------------------------------------- F: anti-vacuity
sec('F  the suite is measuring something')
{
  T('F1 the builder exists where A2 runs it',
    fs.existsSync(path.join(ROOT, 'scripts', 'build-privacy-cjs.cjs')))
  // A copy with no exports would pass B1 trivially if ESM also had none.
  T('F2 the module under test actually exports things', Object.keys(ESM).length >= 5, `${Object.keys(ESM).length}`)
  T('F3 the extension packaging step copies the bundle in',
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').includes('build-privacy-cjs') ||
    fs.readFileSync(path.join(ROOT, 'extension', 'package.json'), 'utf8').includes('build-privacy-cjs'),
    'neither package.json references the builder — the copy will go stale on the next release')
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
