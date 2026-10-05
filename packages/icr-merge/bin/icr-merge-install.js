#!/usr/bin/env node
// One-shot installer: registers the ICR merge driver with git.
//   npx icr-merge-install            -> current repo (.git/config)
//   npx icr-merge-install --global   -> all repos (~/.gitconfig)
// Then add lines like `*.js merge=icr` to .gitattributes (printed below).
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const scope = process.argv.includes('--global') ? ['--global'] : []
const git = (...args) => execFileSync('git', ['config', ...scope, ...args], { stdio: 'inherit' })
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version

try {
  git('merge.icr.name', 'ICR intent-aware merge')
  // NOTE the --package flag: the bin lives inside the `icr-merge` package, and bare
  // `npx icr-merge-driver` would look for a package NAMED icr-merge-driver (404).
  // PINNED to this installer's version (3 Oct 2026). npx caches by spec and never looks again,
  // so the unpinned `--package icr-merge` kept a July machine on 0.1.1 for every merge after,
  // which merged a cherry-pick of a 3,787-line file into a 3,162-line one with git reporting a
  // clean merge. Pinned, a fix reaches a machine the moment the installer is run again.
  git('merge.icr.driver', `npx --yes --package icr-merge@${VERSION} icr-merge-driver %O %A %B %P`)
} catch {
  console.error('failed to run git config — is git installed' + (scope.length ? '' : ' and are you inside a repo') + '?')
  process.exit(1)
}

console.log(`
ICR merge driver ${VERSION} registered${scope.length ? ' globally' : ' for this repository'}. After you upgrade icr-merge, run this again: the driver stays on the version that registered it.

Now route file types to it — add to .gitattributes:

  *.js   merge=icr
  *.jsx  merge=icr
  *.mjs  merge=icr
  *.cjs  merge=icr
  *.ts   merge=icr
  *.tsx  merge=icr
  *.py   merge=icr
  *.rb   merge=icr
  *.go   merge=icr
  *.rs   merge=icr
  *.java merge=icr
  *.c    merge=icr
  *.h    merge=icr
  *.cpp  merge=icr
  *.cs   merge=icr
  *.swift merge=icr
  *.kt   merge=icr
  *.scala merge=icr
  *.php  merge=icr
  *.dart merge=icr
  *.json merge=icr
  *.yml  merge=icr
  *.yaml merge=icr
  *.toml merge=icr

From then on, \`git merge\` / \`git rebase\` / \`git cherry-pick\` use the
intent-aware merge for those files. Anything ICR can't merge safely falls
back to git-style line merging — never worse than the default.
`)
