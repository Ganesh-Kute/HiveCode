// HIV-P7: AN ENTRY POINT THAT LIES ABOUT ITS VERSION BREAKS THE ONLY MIXED-BUILD DETECTOR WE HAVE.
//
//   node tests/version-truth-test.mjs
//
// WHY THIS EXISTS. On 20 Sep 2026, verifying the 0.11.6 publish, three separate entry points were
// found reporting a hivecode version that package.json does not contain:
//
//   remote-mcp.js:387      version: '0.11.5'   <- LIVE. server.js:22 imports it; this is the
//                                                 hosted /mcp endpoint on the Render relay, so
//                                                 every cloud agent is told 0.11.5 forever.
//   hive-mcp-http.js:175   version: '1.0.0'    <- the Slack transport
//   hive-linear.js:64      version: '1.0.0'    <- how we identify ourselves to Linear's MCP
//
// hive-mcp.js ALREADY HAD THE FIX, and its comment at hive-mcp.js:582 states the stakes better
// than this header can:
//
//   "Hardcoding it meant that the moment package.json was bumped the two disagreed silently --
//    so the one mechanism for detecting a mixed build was itself reporting the wrong build."
//
// That fix landed in one file and was never ported to the other three. This suite exists so that
// cannot happen a fourth time.
//
// WHAT A MIXED BUILD COSTS, so the severity is not taken on faith. hive_join instructs every
// arriving agent to announce its version in chat, because two clients running different builds in
// one room corrupt each other's files with no error on either side -- both succeed, both are
// green, and the disagreement surfaces only as lost bytes. The announcement is the ONLY channel
// that makes a mix visible. An entry point that reports a literal turns that channel into a
// confident, wrong, unfalsifiable answer. A detector that lies is strictly worse than no detector,
// because it is trusted.
//
// SECTION B IS THE POINT OF THIS FILE. Fixing three lines is not a ticket; three patches would
// leave the fourth entry point -- the one nobody has written yet -- free to repeat this. B is a
// property over every entry point that exists, including future ones, and it is the reason this
// is a suite rather than a diff.
//
// SECTION D EXISTS BECAUSE A STATIC SCAN IS THE EASIEST TEST IN THE WORLD TO MAKE VACUOUS. A
// scanner whose pattern matches nothing passes forever and reports total compliance. Its output
// is identical to a codebase with zero violations. So D plants a known violation in a synthetic
// source and asserts the scanner catches it, and asserts the scan actually reached files at all.
// Without D, section B proves nothing whatsoever -- which is the same false-success shape as every
// other defect on this project.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// ── A. THE TRUTH. ────────────────────────────────────────────────────────────
// One value, read from the file that ships in the tarball beside every entry point. Everything
// below is measured against this and nothing else.
console.log('\n# A. what the package actually is')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const TRUTH = PKG.version
T('A1 package.json carries a semver version', /^\d+\.\d+\.\d+/.test(String(TRUTH)), TRUTH)

// ── THE SCANNER. ─────────────────────────────────────────────────────────────
// Finds an object literal that claims to BE hivecode and pins its version to a string literal.
//
// The `name` filter is what makes this precise rather than noisy. A test client saying
// `clientInfo: { name: 'test-client', version: '1' }` is telling the truth -- it really is a test
// client at version 1, and refusing that would be a false positive that gets the scan deleted.
// The lie is specifically: claiming the name hivecode, and then supplying a version that is not
// hivecode's. So the rule is not "no literal versions"; it is "if you say you are hivecode, your
// version must come from package.json".
//
// Whitespace is collapsed first so a multi-line object literal reads the same as a one-line one --
// remote-mcp.js:385 spans five lines and a line-oriented pattern misses it entirely.
// THE BACKREFERENCES ARE WRITTEN OUT IN FULL, ONCE PER PATTERN, AND THAT IS NOT STYLE.
// The first draft built these by concatenating a NAME fragment and a VER fragment, each carrying
// its own \1 and \2. Concatenation RENUMBERS capture groups, so VER's \2 -- meant to close the
// quote it opened -- silently began pointing at NAME's captured name instead. The pattern then
// matched nothing at all, and B1 and B2 went GREEN reporting total compliance over 81 files while
// three known violations sat in the tree. Section D caught it on the first run. That is precisely
// the false success this suite is about, produced by the suite about it.
//
// `(?<![\w.])` keeps `protocolVersion` out: that is a wire-protocol date, not our build.
const PATTERNS = [
  // name first — hive-mcp-http.js, hive-linear.js.   1=quote 2=name 3=quote 4=version
  /name\s*:\s*(['"`])(hivecode[\w.-]*)\1\s*,\s*(?<![\w.])version\s*:\s*(['"`])([^'"`]+)\3/g,
  // version first.                                   1=quote 2=version 3=quote 4=name
  /(?<![\w.])version\s*:\s*(['"`])([^'"`]+)\1\s*,\s*name\s*:\s*(['"`])(hivecode[\w.-]*)\3/g,
]

function violationsIn(src) {
  const flat = String(src).replace(/\s+/g, ' ')
  const out = []
  for (const re of PATTERNS) {
    re.lastIndex = 0
    for (const m of flat.matchAll(re)) {
      // Group order differs between the two patterns; the version is the one that is not a name.
      const a = m[2], b = m[4]
      const version = /^hivecode/.test(a) ? b : a
      const name = /^hivecode/.test(a) ? a : b
      out.push({ name, version })
    }
  }
  return out
}

// Which files are entry points. Root-level source only: tests/ legitimately impersonates clients,
// node_modules is not ours, and demo/ scripts do not serve anybody.
const ENTRY_FILES = fs.readdirSync(ROOT)
  .filter((f) => /\.(js|mjs|cjs)$/.test(f))
  .filter((f) => !/-test\.|\.test\./.test(f))
  .sort()

// ── B. THE PROPERTY. ─────────────────────────────────────────────────────────
console.log('\n# B. NO ENTRY POINT REPORTS A VERSION package.json DOES NOT CONTAIN')
{
  T(`B0 the scan reached the source tree (${ENTRY_FILES.length} root entry files)`,
    ENTRY_FILES.length >= 10, ENTRY_FILES.length < 10 ? 'SCAN FOUND ALMOST NOTHING — B1 below is vacuous' : '')

  const bad = []
  for (const f of ENTRY_FILES) {
    let src = ''
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    for (const v of violationsIn(src)) {
      if (v.version !== TRUTH) bad.push(`${f}: ${v.name}@${v.version}`)
    }
  }
  T('B1 EVERY ENTRY POINT CLAIMING THE NAME hivecode REPORTS package.json\'s VERSION',
    bad.length === 0, bad.join('  |  '))

  // A hardcoded literal that HAPPENS to equal package.json today is still the defect: it is
  // correct until the next `npm version patch`, and then it is silently wrong with nothing to
  // catch it. B1 cannot see that, so B2 forbids the literal itself, not just a stale one.
  const literal = []
  for (const f of ENTRY_FILES) {
    let src = ''
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    for (const v of violationsIn(src)) literal.push(`${f}: ${v.name}@${v.version}`)
  }
  T('B2 AND NONE OF THEM PINS IT AS A STRING LITERAL — a literal that is right today is wrong at the next bump',
    literal.length === 0, literal.join('  |  '))
}

// ── C. THE CORRECT PATTERN, PROVEN TO WORK. ──────────────────────────────────
// B says nothing about whether reading package.json at runtime actually produces the right answer.
// A codebase could satisfy B by deleting every version field. C boots the one entry point that
// already does it properly and checks the value that comes out of the wire.
console.log('\n# C. the entry point that does it right reports the right thing')
{
  const mod = await import('../hive-mcp.js')
  T('C1 hive-mcp.js exports a VERSION derived at runtime', typeof mod.VERSION === 'string', mod.VERSION)
  T('C2 and it equals package.json', mod.VERSION === TRUTH, `${mod.VERSION} vs ${TRUTH}`)
  T('C3 and it is not the fallback, which would mean package.json was unreadable beside it',
    mod.VERSION !== '0.0.0-unknown', mod.VERSION)
}

// ── D. THE SCANNER CAN ACTUALLY FIND A VIOLATION. ────────────────────────────
// Everything above is worthless if violationsIn() never matches anything. These are run against
// synthetic sources, so they hold no matter what the real tree contains.
console.log('\n# D. THE SCAN IS NOT VACUOUS — it is shown catching each real shape')
{
  const oneLine = `serverInfo: { name: 'hivecode', version: '1.0.0' },`
  T('D1 catches the one-line form (hive-mcp-http.js:175)',
    violationsIn(oneLine).some((v) => v.version === '1.0.0'))

  const multiLine = `
            serverInfo: {
              name: 'hivecode-mcp',
              version: '0.11.5',
            },`
  T('D2 catches the MULTI-LINE form (remote-mcp.js:385) — a line-oriented scan misses this one',
    violationsIn(multiLine).some((v) => v.version === '0.11.5'))

  const clientSide = `rpc('initialize', { clientInfo: { name: 'hivecode', version: '1.0.0' } })`
  T('D3 catches clientInfo too, not only serverInfo (hive-linear.js:64)',
    violationsIn(clientSide).some((v) => v.version === '1.0.0'))

  const reversed = `{ version: '9.9.9', name: 'hivecode' }`
  T('D4 catches version-before-name ordering', violationsIn(reversed).some((v) => v.version === '9.9.9'))

  const doubleQuoted = `{ name: "hivecode", version: "2.0.0" }`
  T('D5 catches double quotes as well as single', violationsIn(doubleQuoted).some((v) => v.version === '2.0.0'))

  // The false-positive direction. A scan that flags everything gets deleted, and then the property
  // is gone -- which is a worse outcome than the hole it was guarding.
  T('D6 does NOT flag a runtime-derived version — this is the shape we WANT',
    violationsIn(`serverInfo: { name: 'hivecode', version: VERSION }`).length === 0)
  T('D7 does NOT flag a test client honestly reporting its own version',
    violationsIn(`clientInfo: { name: 'test-client', version: '1' }`).length === 0)
  T('D8 does NOT flag an unrelated package that happens to be nearby',
    violationsIn(`{ name: 'ws', version: '8.18.0' }`).length === 0)
  T('D9 does NOT flag protocolVersion, which is a wire protocol date and nothing to do with us',
    violationsIn(`{ protocolVersion: '2024-11-05', name: 'hivecode' }`).length === 0)
}

// ── E. SINGLE SOURCE OF TRUTH (HIV-P7b). ─────────────────────────────────────
// Having four separate copies of the package.json reader means they can drift independently
// (measured: a mutation to remote-mcp.js's fallback passed 16/16 green).
// The solution is extraction: exactly ONE module (hive-version.js) defines the reader,
// and all four entry points import it.
console.log('\n# E. SINGLE SOURCE OF TRUTH (HIV-P7b: hive-version.js)')

function hasVersionReader(src) {
  const flat = String(src).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ' ')
  return /package\.json['"`][\s\S]{0,120}\.version|\.version[\s\S]{0,120}package\.json['"`]/i.test(flat)
}

const readers = []
for (const f of ENTRY_FILES) {
  let src = ''
  try { src = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
  if (hasVersionReader(src)) readers.push(f)
}

T('E1 exactly one module in the source tree extracts package.json version',
  readers.length === 1 && readers[0] === 'hive-version.js',
  `found ${readers.length}: ${readers.join(', ')}`)

const hvPath = path.join(ROOT, 'hive-version.js')
const hvExists = fs.existsSync(hvPath)
T('E2 hive-version.js exists on disk', hvExists)

if (hvExists) {
  try {
    const hvMod = await import('../hive-version.js')
    T('E3 hive-version.js exports VERSION matching package.json',
      hvMod.VERSION === TRUTH, `${hvMod.VERSION} vs ${TRUTH}`)
    T('E4 hive-version.js VERSION is not the fallback',
      hvMod.VERSION !== '0.0.0-unknown', hvMod.VERSION)
  } catch (e) {
    T('E3 hive-version.js exports VERSION matching package.json', false, String(e))
    T('E4 hive-version.js VERSION is not the fallback', false)
  }
} else {
  T('E3 hive-version.js exports VERSION matching package.json', false, 'file does not exist')
  T('E4 hive-version.js VERSION is not the fallback', false)
}

// All 4 entry points must import from ./hive-version.js
const targets = ['hive-mcp.js', 'remote-mcp.js', 'hive-mcp-http.js', 'hive-linear.js']
for (const t of targets) {
  let src = ''
  try { src = fs.readFileSync(path.join(ROOT, t), 'utf8') } catch {}
  const importsFromHiveVersion = /from\s*['"]\.\/hive-version(?:\.js)?['"]/.test(src)
  T(`E5 ${t} imports VERSION from ./hive-version.js`, importsFromHiveVersion)
}

// package.json files[] packaging invariant
const listed = new Set(PKG.files || [])
T('E6 package.json files[] includes "hive-version.js"', listed.has('hive-version.js'))

import { spawnSync } from 'child_process'
const checkRes = spawnSync(process.execPath, ['scripts/check-files.mjs'], { cwd: ROOT, encoding: 'utf8' })
T('E7 scripts/check-files.mjs passes (no broken imports in tarball)',
  checkRes.status === 0, (checkRes.stderr || checkRes.stdout || '').trim())

// ── F. NON-VACUOUS SINGLE-READER SCANNER (synthetic test cases) ─────────────
console.log('\n# F. NON-VACUOUS SINGLE-READER SCANNER')
{
  T('F1 catches duplicate inline reader',
    hasVersionReader('const v = JSON.parse(fs.readFileSync("./package.json")).version') === true)
  T('F2 catches multi-line package.json URL reader',
    hasVersionReader('const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))\nconst v = pkg.version') === true)
  T('F3 does NOT flag import of hive-version',
    hasVersionReader("import { VERSION } from './hive-version.js'") === false)
  T('F4 does NOT flag non-version package.json read (like reading files[])',
    hasVersionReader("const pkg = JSON.parse(fs.readFileSync('./package.json')); const f = pkg.files;") === false)
}

// ── G. THE HOMEPAGE STATES THE SHIPPED VERSION AND TOOL COUNT ───────────────
// 8 Oct 2026, before the first founder outreach: the homepage said "0.11.5 on npm" and "25 tools over
// MCP" (in the strip and in the link-preview description) while package.json was 0.13.0 and
// hive-mcp.js listed 29 tools. It is the page a founder checks first, and a stale number there reads
// as an abandoned project.
console.log('\n# G. THE HOMEPAGE STATES THE SHIPPED VERSION AND TOOL COUNT')
{
  const home = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
  const shownVersion = (home.match(/<b>(\d+\.\d+\.\d+)<\/b><span>on npm/) || [])[1]
  T('G1 the homepage shows the package.json version', shownVersion === TRUTH,
    `page says ${shownVersion || 'nothing'}, package.json says ${TRUTH}`)
  const tools = new Set(fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8').match(/name: 'hive_[a-z_]+'/g) || [])
  const shownCounts = [...home.matchAll(/(\d+)(?:<\/b><span>|\s)tools over MCP/g)].map((m) => Number(m[1]))
  T('G2 every tool count on the homepage matches hive-mcp.js',
    tools.size > 20 && shownCounts.length >= 2 && shownCounts.every((n) => n === tools.size),
    `page says ${shownCounts.join(', ') || 'nothing'}, hive-mcp.js lists ${tools.size}`)
}

console.log(`\n=== HIV-P7/P7b VERSION TRUTH: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
