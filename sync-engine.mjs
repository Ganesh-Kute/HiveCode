// sync-engine.mjs — single-source guard for the ICR engine files.
//
// The ICR engine (icr.js + the language providers) lives in TWO places:
//   - packages/icr-merge/   the published `icr-merge` library — CANONICAL, has the
//                           richest test suite (api, git-e2e, export-preserve, inner-format)
//   - repo root             the copies the live Hivecode product (sync.js) imports
//
// Until the root is refactored to depend on the package directly, these must stay
// byte-identical. This script makes that automatic instead of manual (hand-syncing
// drifted 3 times during development, each a latent bug):
//   node sync-engine.mjs           copy package -> root (canonical wins)
//   node sync-engine.mjs --check   exit 1 if any root copy differs from the package
//                                  (wire into the test run so drift fails loudly)
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.join(ROOT, 'packages', 'icr-merge')
// The files that exist verbatim in both places. (merge3.js is package-only — root uses
// core.js's merge3; index.js/bin are package-only. Only these four are shared copies.)
const FILES = ['icr.js', 'lang-js.js', 'lang-brace.js', 'lang-python.js', 'lang-ruby.js', 'lang-json.js']

const check = process.argv.includes('--check')
const read = (p) => fs.readFileSync(p, 'utf8')
let drift = 0, synced = 0

for (const f of FILES) {
  const src = path.join(PKG, f)      // canonical
  const dst = path.join(ROOT, f)     // live-product copy
  if (!fs.existsSync(src)) { console.error(`MISSING canonical: packages/icr-merge/${f}`); drift++; continue }
  const a = read(src)
  const b = fs.existsSync(dst) ? read(dst) : null
  if (a === b) continue
  if (check) {
    console.error(`DRIFT: root/${f} differs from packages/icr-merge/${f}`)
    drift++
  } else {
    fs.writeFileSync(dst, a)
    console.log(`synced root/${f} <- packages/icr-merge/${f}`)
    synced++
  }
}

if (check) {
  if (drift) { console.error(`\n=== ENGINE DRIFT: ${drift} file(s) out of sync. Run \`node sync-engine.mjs\` to fix. ===`); process.exit(1) }
  console.log(`=== ENGINE IN SYNC: ${FILES.length} files identical (root <-> packages/icr-merge) ===`)
} else {
  console.log(synced ? `=== SYNCED ${synced} file(s) ===` : '=== already in sync ===')
}
