#!/usr/bin/env node
// Standalone 3-way merge CLI (no git required) — for agents, CI, and pipelines:
//   npx icr-merge <base> <ours> <theirs>            merged text -> stdout
//   npx icr-merge <base> <ours> <theirs> -o <file>  merged text -> file
//   --filename <name>   pick the language by this name (default: ours' name)
//   --json              machine-readable result envelope on stdout instead of raw text
// Exit codes: 0 clean merge, 1 conflicts present (text still written, with markers),
//             2 usage/IO error. Conflicts and warnings go to stderr.
import fs from 'fs'
import { merge } from '../index.js'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null }
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false }
const out = opt('-o') || opt('--output')
const fname = opt('--filename')
const asJson = flag('--json')
const [baseP, oursP, theirsP] = args

if (!baseP || !oursP || !theirsP) {
  console.error('usage: icr-merge <base> <ours> <theirs> [-o out] [--filename name] [--json]')
  process.exit(2)
}

let base, ours, theirs
try {
  base = fs.readFileSync(baseP, 'utf8')
  ours = fs.readFileSync(oursP, 'utf8')
  theirs = fs.readFileSync(theirsP, 'utf8')
} catch (e) { console.error('read failed:', e.message); process.exit(2) }

const r = merge(base, ours, theirs, { filename: fname || oursP })

if (asJson) {
  process.stdout.write(JSON.stringify({ clean: r.clean, method: r.method, renames: r.renames || [], warning: r.warning || null, semantic: r.semantic || null, text: r.text }) + '\n')
} else if (out) {
  fs.writeFileSync(out, r.text)
} else {
  process.stdout.write(r.text)
}
if (out && asJson) fs.writeFileSync(out, r.text)
if (r.warning) console.error('[icr-merge]', r.warning)
if (!r.clean) console.error(/^<{7} |\n<{7} /.test(r.text)
  ? '[icr-merge] conflicts present — output contains <<<<<<< markers'
  : '[icr-merge] NOT clean — a semantic conflict was detected (see warning); review before using the output')
process.exit(r.clean ? 0 : 1)
