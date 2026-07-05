#!/usr/bin/env node
// One-shot installer: registers the ICR merge driver with git.
//   npx icr-merge-install            -> current repo (.git/config)
//   npx icr-merge-install --global   -> all repos (~/.gitconfig)
// Then add lines like `*.js merge=icr` to .gitattributes (printed below).
import { execFileSync } from 'child_process'

const scope = process.argv.includes('--global') ? ['--global'] : []
const git = (...args) => execFileSync('git', ['config', ...scope, ...args], { stdio: 'inherit' })

try {
  git('merge.icr.name', 'ICR intent-aware merge')
  // NOTE the --package flag: the bin lives inside the `icr-merge` package, and bare
  // `npx icr-merge-driver` would look for a package NAMED icr-merge-driver (404).
  git('merge.icr.driver', 'npx --yes --package icr-merge icr-merge-driver %O %A %B %P')
} catch {
  console.error('failed to run git config — is git installed' + (scope.length ? '' : ' and are you inside a repo') + '?')
  process.exit(1)
}

console.log(`
ICR merge driver registered${scope.length ? ' globally' : ' for this repository'}.

Now route file types to it — add to .gitattributes:

  *.js   merge=icr
  *.jsx  merge=icr
  *.mjs  merge=icr
  *.cjs  merge=icr
  *.ts   merge=icr
  *.tsx  merge=icr
  *.py   merge=icr
  *.go   merge=icr
  *.rs   merge=icr
  *.java merge=icr
  *.c    merge=icr
  *.h    merge=icr
  *.cpp  merge=icr
  *.cs   merge=icr
  *.swift merge=icr
  *.kt   merge=icr

From then on, \`git merge\` / \`git rebase\` / \`git cherry-pick\` use the
intent-aware merge for those files. Anything ICR can't merge safely falls
back to git-style line merging — never worse than the default.
`)
