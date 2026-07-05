#!/usr/bin/env node
// Git merge driver for icr-merge.
//
// Configure once (or run: npx icr-merge-install):
//   git config merge.icr.name "ICR intent-aware merge"
//   git config merge.icr.driver "npx --yes icr-merge-driver %O %A %B %P"
// Then route file types to it in .gitattributes:
//   *.js merge=icr
//   *.py merge=icr
//
// Git calls this with: <ancestor> <ours> <theirs> [<pathname>]
// Contract: write the merged result into <ours>; exit 0 = merged clean,
// exit 1 = conflict (markers left in the file, exactly like git's default).
import fs from 'fs'
import { merge } from '../index.js'

const [base, ours, theirs, pathname] = process.argv.slice(2)
if (!base || !ours || !theirs) {
  console.error('usage: icr-merge-driver <ancestor> <ours> <theirs> [<pathname>]')
  process.exit(2)
}

try {
  const r = merge(
    fs.readFileSync(base, 'utf8'),
    fs.readFileSync(ours, 'utf8'),
    fs.readFileSync(theirs, 'utf8'),
    { filename: pathname || ours },
  )
  fs.writeFileSync(ours, r.text)
  if (r.method !== 'lines') console.error(`icr-merge: ${r.method} merge${r.renames && r.renames.length ? ' (' + r.renames.join(', ') + ')' : ''}`)
  if (r.warning) console.error(`icr-merge: semantic conflict — ${r.warning}`)
  process.exit(r.clean ? 0 : 1)
} catch (e) {
  // Never leave the working tree worse than git would: report and signal conflict.
  console.error('icr-merge-driver error: ' + (e && e.message ? e.message : e))
  process.exit(2)
}
