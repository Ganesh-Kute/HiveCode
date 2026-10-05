// Every module the published client loads is in the published package.
//
//   node tests/package-closure-test.mjs
//
// package.json lists the client's files one by one, so a new module that sync.js or hive-mcp.js
// imports is not in `npx hivecode-mcp` until somebody adds it there by hand. Forgetting is silent
// in this repo -- every test imports from the working tree, where the file exists -- and fatal for
// every install: the MCP server dies on ERR_MODULE_NOT_FOUND before it can say anything. On
// 3 Oct 2026 hive-secrets.js was one line away from shipping that way.
//
// A module may stay out of the package on purpose (GRM stays private: grm-link.cjs), but only if
// every load of it is optional -- inside a `try` on the same line -- so the client runs without it.
//
//   P1  every module reachable from a bin or main is in package.json `files`, or loaded only optionally
//   P2  the walk is not vacuous: it reaches the modules this repo is known to load
//   P3  ...and it does see the optional load that is known to exist, so P1's exemption is not vacuous

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? `  -- ${detail}` : ''}`) }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const shipped = new Set((pkg.files || []).map((f) => f.replace(/\\/g, '/').replace(/\/$/, '')))
const isShipped = (rel) => shipped.has(rel) || [...shipped].some((f) => rel.startsWith(f + '/'))

const SPEC = [
  /\bimport\s+[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g, // import x from './a.js'
  /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,                    // import './a.js'
  /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,             // await import('./a.js')
  /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,            // require('./a.cjs')
  /\bcreateRequire\([^)]*\)\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
]
const entry = [...new Set([pkg.main, ...Object.values(pkg.bin || {})].filter(Boolean))]
const loads = new Map() // module -> [{ from, optional }]
const missing = []
const visited = new Set()
const walk = (rel) => {
  if (visited.has(rel)) return
  visited.add(rel)
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) { missing.push(`${rel} (does not exist)`); return }
  if (!/\.(?:m?js|cjs)$/.test(rel)) return
  // Comments mention modules too ("see hive-mux.js"), but only a real specifier is a load.
  const src = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
  for (const re of SPEC) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src)) !== null) {
      const dep = path.relative(ROOT, path.resolve(path.dirname(full), m[1])).replace(/\\/g, '/')
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      const optional = /\btry\s*\{/.test(src.slice(lineStart, m.index))
      if (!loads.has(dep)) loads.set(dep, [])
      loads.get(dep).push({ from: rel, optional })
      if (isShipped(dep) || !optional) walk(dep) // an optional, unshipped module's own imports never load
    }
  }
}
for (const e of entry) { if (!loads.has(e)) loads.set(e, [{ from: 'package.json', optional: false }]); walk(e) }

const broken = [...loads].filter(([dep, by]) => !isShipped(dep) && by.some((l) => !l.optional))
  .map(([dep, by]) => `${dep} (loaded by ${[...new Set(by.filter((l) => !l.optional).map((l) => l.from))].join(', ')})`).sort()
T('P1 every module the client loads is in package.json files, or loaded only inside a try', broken.length === 0 && missing.length === 0,
  [...broken.map((b) => `not shipped: ${b}`), ...missing].join(' | '))
T('P2 the walk reaches what the client is known to load', ['hive-mcp.js', 'sync.js', 'hive-privacy.js', 'core.js'].every((f) => loads.has(f)) && loads.size >= 20,
  `reached ${loads.size}`)
const grm = loads.get('grm-link.cjs')
T('P3 it sees the one optional load known to exist (grm-link.cjs, inside a try, not shipped)', !!grm && grm.every((l) => l.optional) && !isShipped('grm-link.cjs'),
  JSON.stringify(grm || null))

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
