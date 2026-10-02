// install-pin-test.mjs -- the driver the installer registers is pinned to the installer's own version.
//
// Found 3 Oct 2026 in our own repo. The installer wrote `npx --yes --package icr-merge icr-merge-driver`
// with no version. npx keys its cache on that spec and never looks again, so a machine that first ran
// it in July kept running icr-merge 0.1.1 for every later merge. That build merged a cherry-pick of
// sync.js into a file 625 lines short, with an export gone, and git reported a clean merge. Publishing
// a fixed version changed nothing on that machine.
//
//   node test/install-pin-test.mjs

import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
const INSTALL = path.join(HERE, '..', 'bin', 'icr-merge-install.js')

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${!c && extra ? `\n         ${extra}` : ''}`); c ? pass++ : fail++ }

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'icr-install-'))
execFileSync('git', ['init', '-q'], { cwd: repo })
execFileSync(process.execPath, [INSTALL], { cwd: repo, stdio: 'pipe' })
const driver = execFileSync('git', ['config', '--get', 'merge.icr.driver'], { cwd: repo, encoding: 'utf8' }).trim()

T('the registered driver names this exact version of icr-merge', driver.includes(`--package icr-merge@${PKG.version} `), driver)
T('...and still runs the driver bin with the four placeholders', /icr-merge-driver %O %A %B %P$/.test(driver), driver)

fs.rmSync(repo, { recursive: true, force: true })
console.log(`\n=== INSTALL PIN: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
