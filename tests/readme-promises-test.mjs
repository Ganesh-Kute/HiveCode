// README PROMISES (HIV-P19): the documentation is an untested API surface.
//
//   node tests/readme-promises-test.mjs
//
// THE CLASS. Five instances in two days, every one ours:
//
//   "Reading or claiming the path fetches it"        no such mechanism existed (HIV-P18)
//   nine test paths in the README                    none of those files existed
//   reconcile.cjs header, "No second copy anywhere"   there was one, and that file SHIPS
//   the sizing prose vs its own table below it        contradicted itself, wrong half first
//   "<relay-http>" printed literally to users         a placeholder, never substituted (HIV-P13)
//
// One shape: A CLAIM WE WROTE DOWN AND THEN BELIEVED, THAT NOTHING CHECKS. Code has a suite.
// Documentation has an author and no gate. And for a team evaluating this, the README is not
// documentation -- it is the front door, the first thing they execute.
//
// A confidently documented feature that does not exist is WORSE than an undocumented one. A
// gap makes someone ask a question. A false remedy makes them do the wrong thing twice and
// conclude the product is broken. That is exactly what happened on 21 Sep 2026: an agent
// followed the written remedy for a missing file, got silence, followed it again, and was
// right to stop and report it.
//
// WHAT THIS CANNOT DO, stated first so nobody reads more into a green run. HIV-P18's sentence
// was PROSE -- "reading or claiming the path fetches it" -- naming no function. No identifier
// checker sees that, and this one would not have caught it. So the suite ships alongside a rule
// that shrinks its own blind spot:
//
//     a README sentence that promises behaviour must NAME the function or tool that does it
//
// Then the promise is an identifier, and identifiers are checkable. The rule is the fix; this
// file is what makes the rule enforceable. Section G exists so that a checker which examined
// nothing cannot print the same green as one that examined forty things.

import fs from 'fs'
import path from 'path'
import * as acorn from 'acorn'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8') } catch { return '' } }

const README = read('README.md')
const MCP = read('hive-mcp.js')
const SYNC = read('sync.js')
const LIMITS = read('limits.js')
const PKG = JSON.parse(read('package.json') || '{}')

// Prose can mention a tool inside a sentence about not using it, so the counts below are of
// DISTINCT names, and every category reports its own count for section G.
const uniq = (re, src = README) => [...new Set([...src.matchAll(re)].map((m) => m[0]))]

// Every shipped source file the README could legitimately be talking about. Built once, up
// front, because sections B, D and E all need it and copies of the list would drift.
//
// THEY DID DRIFT, exactly as predicted, and it took two days. Sections D and E kept their
// own inline copy of this expression; when hive-privacy.js was added and the README started
// documenting Q550, E1 reported "NOT EMITTED: Q550" — a true statement about a list that
// had stopped being the list of shipped sources, and a false statement about the product.
// The checker for prose that names things that do not exist had, itself, named a set of
// files that no longer existed. Derived from package.json now, so the next shipped module
// joins the scan by being shipped.
const SRC_ALL = [...new Set(
  JSON.parse(read('package.json')).files
    .filter((f) => /\.(js|cjs|mjs)$/.test(f))
    .concat(['core.js', 'reconcile.cjs']),
)].map((f) => read(f)).join('\n')

console.log('\n# A. every hive_* tool the README names is a tool that exists')
const toolsDeclared = new Set([...MCP.matchAll(/\{\s*name:\s*'(hive_[a-z_]+)'/g)].map((m) => m[1]))
const toolsNamed = uniq(/\bhive_[a-z_]+/g)
const toolsMissing = toolsNamed.filter((t) => !toolsDeclared.has(t))
T(`A1 all ${toolsNamed.length} named tools are declared in hive-mcp.js`, toolsMissing.length === 0,
  toolsMissing.length ? `MISSING: ${toolsMissing.join(' ')}` : `${toolsDeclared.size} declared`)

console.log('\n# B. every startSync API the README names exists on the returned object')
// Parsed out of the source rather than by starting a client: this suite must stay offline and
// instant, so it can run on every commit rather than only when someone remembers.
//
// PARSED, NOT PATTERN-MATCHED. The first version of this used a regex on the text after the
// last `return {` in sync.js. It matched an inline `return { relay: null, ... }` from a helper
// and produced ZERO API names -- so B1 and B2 both "failed" for a reason that had nothing to do
// with the README. G2 caught it on the first run, which is the entire point of section G: I
// would otherwise have gone looking for a missing export that was right there. acorn is already
// a dependency and answers exactly, so there is no reason to guess.
const AST = acorn.parse(SYNC, { ecmaVersion: 'latest', sourceType: 'module' })
const walk = (n, cb) => {
  if (!n || typeof n !== 'object') return
  cb(n)
  for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach((x) => walk(x, cb)); else if (v && typeof v === 'object' && v.type) walk(v, cb) }
}
let startSyncFn = null
walk(AST, (n) => { if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'startSync') startSyncFn = n })
let retObj = null
if (startSyncFn) for (const st of startSyncFn.body.body) if (st.type === 'ReturnStatement' && st.argument && st.argument.type === 'ObjectExpression') retObj = st.argument
const retProps = retObj ? retObj.properties.filter((pr) => pr.key) : []
const apiNames = new Set(retProps.map((pr) => pr.key.name || pr.key.value))
// Only names the README presents as callable -- `fetch(path)`, `listHistory()`. A bare word in
// prose is not a claim about the API.
const apiClaimed = uniq(/`([a-zA-Z_][a-zA-Z0-9_]*)\(/g).map((s) => s.replace(/`|\($/g, ''))
  .filter((n) => !['npm', 'node', 'curl', 'git', 'function', 'if', 'for'].includes(n))
// NOT EVERY CALLABLE THE README NAMES IS PART OF THE API, and the first version of B1 assumed
// it was. It flagged `limitsFor()` -- which the README cites while explaining why HIVE_SEATS
// cannot fix Q430. That is a TRUE statement about a real function in limits.js, just not one on
// the startSync surface, and flagging it would have pushed the next person to delete an accurate
// sentence. So B1 asks the weaker, correct question -- does this function exist at all -- and B2
// does the surface-level pinning for the one name where the surface IS the claim.
const declaredAnywhere = (n) =>
  new RegExp('\\bfunction\\s+' + n + '\\b|\\b(?:const|let)\\s+' + n + '\\s*=\\s*(?:async\\s*)?(?:\\(|function)').test(SRC_ALL)
const apiKnown = apiClaimed.filter((n) => apiNames.has(n) || toolsDeclared.has(n) || declaredAnywhere(n))
const apiUnknown = apiClaimed.filter((n) => !apiKnown.includes(n) && !/^[A-Z]/.test(n))
T('B1 every callable the README names exists somewhere in the product', apiUnknown.length === 0,
  apiUnknown.length ? `NOT FOUND: ${apiUnknown.join(' ')}` : `${apiKnown.length} of ${apiClaimed.length}: ${apiClaimed.join(' ')}`)
// THE ONE THAT WOULD HAVE CAUGHT HIV-P18 AT THE NAME LEVEL. `fetch` was documented as the
// remedy only AFTER it existed; before that the README promised it in prose and there was no
// such function. Pinning it by name means removing the function breaks the docs test too.
T('B2 fetch() — the HIV-P18 remedy — is a real export, not prose',
  apiNames.has('fetch'), apiNames.has('fetch') ? '' : 'sync.js does not export fetch')
T('B3 and the README actually documents it, so the two cannot drift apart silently',
  /`fetch\(/.test(README))

console.log('\n# C. every status() field the README names is a field status() returns')
// status() is built in one place; read the literal rather than running a client.
// Same discipline: find the `status` property on the returned object and read the source span of
// whatever it evaluates to. `function status(` does not appear in sync.js at all -- the first
// version of this searched for it, found nothing, and reported three real fields as missing.
const statusBody = (() => {
  const pr = retProps.find((x) => (x.key.name || x.key.value) === 'status')
  if (!pr) return ''
  // The property may be an arrow, a function expression, or a reference to a declaration
  // elsewhere; cover the reference case by falling back to that function's own source.
  if (pr.value.type === 'Identifier') {
    let decl = null
    walk(AST, (n) => { if (n.type === 'FunctionDeclaration' && n.id && n.id.name === pr.value.name) decl = n })
    return decl ? SYNC.slice(decl.start, decl.end) : ''
  }
  return SYNC.slice(pr.value.start, pr.value.end)
})()
const statusClaimed = ['filesHeld', 'roomFiles', 'filesMissing', 'connected', 'filesSynced']
  .filter((f) => new RegExp('`' + f + '`|\\b' + f + '\\b').test(README))
const statusMissing = statusClaimed.filter((f) => !new RegExp('\\b' + f + '\\b').test(statusBody))
T(`C1 all ${statusClaimed.length} named status fields are produced by status()`, statusMissing.length === 0,
  statusMissing.length ? `MISSING: ${statusMissing.join(' ')}` : statusClaimed.join(' '))

console.log('\n# D. every HIVE_* env var the README tells you to set is one the code reads')
const SRC = SRC_ALL // the one list, derived from package.json files[] -- see the note above
const envNamed = uniq(/\bHIVE_[A-Z0-9_]+/g)
const envUnread = envNamed.filter((v) => !SRC.includes(v))
T(`D1 all ${envNamed.length} documented env vars are read somewhere in the source`, envUnread.length === 0,
  envUnread.length ? `NOTHING READS: ${envUnread.join(' ')}` : envNamed.join(' '))
// HIV-P15 corrected the README here: HIVE_SEATS cannot fix Q430, because limitsFor() returns no
// maxConnsTotal at all and the refusal reads the module-level LIMITS. Both knobs must stay real
// AND stay distinct, or the advice collapses back into one wrong remedy.
T('D2 the two capacity knobs are genuinely different settings, not aliases',
  /HIVE_MAX_CONNS_TOTAL/.test(LIMITS) && /HIVE_SEATS|maxConnsPerRoom/.test(LIMITS) &&
  !/maxConnsTotal/.test(LIMITS.slice(LIMITS.indexOf('function limitsFor'), LIMITS.indexOf('export { TIERS }'))),
  'limitsFor() must not carry maxConnsTotal — that is what makes HIVE_SEATS the wrong fix for Q430')

console.log('\n# E. every Q-code the README explains is a code the source emits')
const qNamed = uniq(/\bQ\d{3}\b/g)
const qMissing = qNamed.filter((q) => !SRC.includes(q))
T(`E1 all ${qNamed.length} documented Q-codes exist in the source`, qMissing.length === 0,
  qMissing.length ? `NOT EMITTED: ${qMissing.join(' ')}` : qNamed.join(' '))
// HIV-P13: the diagnostic printed the literal string "<relay-http>" to users for three weeks
// while holding the relay URL in scope four lines away. A placeholder that escapes into a
// user-facing string is the same defect as a placeholder in the docs.
T('E2 no unsubstituted placeholder survives in the README', !/<relay-http>|<your-relay>|TODO|FIXME|XXX/.test(README))

console.log('\n# F. paths and scripts — one producer, folded in from the ad-hoc checks')
const links = [...new Set([...README.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]))]
  .filter((u) => !/^https?:|^#|^mailto:/.test(u))
const deadLinks = links.filter((l) => !fs.existsSync(path.join(ROOT, l.split('#')[0])))
T(`F1 all ${links.length} relative links resolve`, deadLinks.length === 0, deadLinks.join(' '))
const filePaths = [...new Set([...README.matchAll(/(?:tests|scripts|demo|docs|packages)\/[A-Za-z0-9._/-]+\.(?:mjs|js|cjs|md)/g)].map((m) => m[0]))]
const deadPaths = filePaths.filter((p) => !fs.existsSync(path.join(ROOT, p)))
T(`F2 all ${filePaths.length} cited file paths exist`, deadPaths.length === 0, deadPaths.join(' '))
const scriptsNamed = [...new Set([...README.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]))]
const deadScripts = scriptsNamed.filter((s) => !(PKG.scripts || {})[s])
T(`F3 all ${scriptsNamed.length} npm scripts named exist in package.json`, deadScripts.length === 0, deadScripts.join(' '))
// The battery is the command an evaluator is told to run. Every suite it chains must exist, or
// the one instruction we give a new team dies partway through with a module-not-found.
const battery = String((PKG.scripts || {})['test:hardening'] || '')
const batterySuites = [...battery.matchAll(/tests\/[A-Za-z0-9._-]+/g)].map((m) => m[0])
const batteryMissing = batterySuites.filter((f) => !fs.existsSync(path.join(ROOT, f)))
T(`F4 all ${batterySuites.length} suites in test:hardening exist`, batteryMissing.length === 0, batteryMissing.join(' '))

console.log('\n# G. the checker is not vacuous')
// Every section above can pass by matching nothing. These are the counts that make a green run
// mean something, and they are the assertions that fail first if the README is gutted or a
// regex stops matching. learnings/green-but-not-testing-it.md is this exact class.
const counts = { tools: toolsNamed.length, callables: apiClaimed.length, status: statusClaimed.length,
  env: envNamed.length, qcodes: qNamed.length, links: links.length, paths: filePaths.length,
  scripts: scriptsNamed.length, battery: batterySuites.length }
const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([k]) => k)
T('G1 every category actually examined something', empty.length === 0,
  empty.length ? `EXAMINED NOTHING: ${empty.join(' ')}` : JSON.stringify(counts))
T('G2 the API name set was PARSED, not silently empty — this caught its own first version',
  apiNames.size > 20, `${apiNames.size} exported names`)
T('G4 and the status() body was located, so section C examined real source',
  statusBody.length > 100, `${statusBody.length} chars`)
T('G3 the MCP tool set was parsed, not silently empty', toolsDeclared.size > 20, `${toolsDeclared.size} tools`)

console.log('\n# H. every install instruction names a version npx will actually fetch')
// MEASURED 23 Sep 2026, the day 0.12.0 was published to move everyone off a dead relay: on a
// machine that had used Hivecode before, `npx -y hivecode-mcp` -- the form in every config and
// every doc -- ran 0.1.0, a months-old copy sitting in npx's cache, and never asked the
// registry. `npx -y hivecode-mcp@latest` on the same machine ran 0.12.0. So the documented
// install line silently pinned returning users to whatever they had first, which here meant a
// client whose built-in relay no longer exists. The documentation was the defect, again.
{
  const DOCS = ['README.md', 'docs/SELF_HOSTING.md', 'docs/MCP.md', 'docs/JOIN_WITH_AGENT.md',
    'docs/AGENT_MANUAL.md', 'docs/AI_AGENT_MANUAL.md', 'docs/HIVE_FOR_AGENTS.md', 'docs/WORKFLOW.md',
    'public/index.html', 'public/start.html', 'sync.js']
  const unversioned = /npx +(?:-y +)?hivecode-mcp(?![@\w-])|"-y", *"hivecode-mcp"(?![@\w-])/g
  const versioned = /npx +(?:-y +)?hivecode-mcp@|"-y", *"hivecode-mcp@/g
  const bad = [], seen = []
  for (const f of DOCS) {
    const src = read(f)
    for (const m of src.matchAll(unversioned)) bad.push(`${f}: ${m[0]}`)
    for (const m of src.matchAll(versioned)) seen.push(f)
  }
  T('H1 no install instruction leaves the version to npx\'s cache', bad.length === 0, bad.join(' | '))
  // A scan of files that no longer mention the install at all would pass H1 on nothing.
  T('H2 ... and the versioned instructions were actually found (anti-vacuity)', seen.length >= 10,
    `${seen.length} versioned instructions across ${new Set(seen).size} files`)
}

console.log(`\n=== HIV-P19 README PROMISES: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
