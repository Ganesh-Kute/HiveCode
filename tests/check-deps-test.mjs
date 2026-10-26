import fs from 'fs'
import path from 'path'
import os from 'os'
import { parseSemver, satisfies, matchesWorkspace, checkDeps } from '../scripts/check-deps.mjs'

let pass = 0
let fail = 0
function T(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok   ${name}`)
    pass++
  } else {
    console.error(`  FAIL ${name}${extra ? `   ${extra}` : ''}`)
    fail++
  }
}

console.log('# semver parsing and satisfier')
T('parseSemver parses standard semver', parseSemver('3.1.0')?.major === 3 && parseSemver('3.1.0')?.minor === 1 && parseSemver('3.1.0')?.patch === 0)
T('parseSemver handles v prefix and prereleases', parseSemver('v1.2.3-alpha.1')?.prerelease === 'alpha.1')

T('satisfies caret for major > 0', satisfies('3.1.0', '^3.1.0') && satisfies('3.2.5', '^3.1.0') && !satisfies('2.1.0', '^3.1.0') && !satisfies('4.0.0', '^3.1.0'))
T('satisfies caret for 0.X (breaking minor)', satisfies('0.2.117', '^0.2.117') && satisfies('0.2.120', '^0.2.117') && !satisfies('0.2.116', '^0.2.117') && !satisfies('0.3.0', '^0.2.117'))
T('satisfies tilde (breaking minor)', satisfies('1.2.3', '~1.2.3') && satisfies('1.2.9', '~1.2.3') && !satisfies('1.3.0', '~1.2.3'))
T('satisfies exact', satisfies('1.0.0', '1.0.0') && !satisfies('1.0.1', '1.0.0'))

console.log('\n# workspace glob matching')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-deps-test-'))
const wsRoot = path.join(tmpDir, 'monorepo')
const pkgA = path.join(wsRoot, 'packages', 'pkg-a')
const pkgB = path.join(wsRoot, 'other', 'pkg-b')
fs.mkdirSync(pkgA, { recursive: true })
fs.mkdirSync(pkgB, { recursive: true })
fs.writeFileSync(path.join(wsRoot, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))

const matchA = matchesWorkspace(pkgA)
T('matchesWorkspace allows folder matching workspaces glob', matchA.allowed === true && path.resolve(matchA.workspaceRoot) === path.resolve(wsRoot))

const matchB = matchesWorkspace(pkgB)
T('matchesWorkspace rejects folder not matching workspaces glob', matchB.allowed === false)

console.log('\n# checkDeps origin and range enforcement')
// Mock checkout with package.json
const mockRepo = path.join(tmpDir, 'mock-repo')
fs.mkdirSync(path.join(mockRepo, 'node_modules', 'dep-ok'), { recursive: true })
fs.mkdirSync(path.join(mockRepo, 'node_modules', 'dep-stale'), { recursive: true })
fs.writeFileSync(path.join(mockRepo, 'node_modules', 'dep-ok', 'package.json'), JSON.stringify({ name: 'dep-ok', version: '1.2.0', main: 'index.js' }))
fs.writeFileSync(path.join(mockRepo, 'node_modules', 'dep-ok', 'index.js'), 'module.exports = {}')
fs.writeFileSync(path.join(mockRepo, 'node_modules', 'dep-stale', 'package.json'), JSON.stringify({ name: 'dep-stale', version: '1.0.0', main: 'index.js' }))
fs.writeFileSync(path.join(mockRepo, 'node_modules', 'dep-stale', 'index.js'), 'module.exports = {}')

fs.writeFileSync(path.join(mockRepo, 'package.json'), JSON.stringify({
  name: 'mock-app',
  dependencies: {
    'dep-ok': '^1.0.0',
    'dep-stale': '^2.0.0', // Stale version mismatch (1.0.0 vs ^2.0.0)
  },
}))

const errs = []
const res = checkDeps({ repoRoot: mockRepo, log: () => {}, logErr: (e) => errs.push(e) })
T('checkDeps fails on version range mismatch', res.ok === false && errs.some((e) => /dep-stale/.test(e) && /version 1.0.0/.test(e)))

// Cleanup mock files
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
