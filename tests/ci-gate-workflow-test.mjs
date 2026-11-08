// tests/ci-gate-workflow-test.mjs — Verify CI Gate (.github/workflows/test-gate.yml + action.yml)
// installs runtime dependencies (acorn) inside github.action_path before invoking packages/git-clash/cli.mjs,
// including when run as a public GitHub Action from a stranger's repository with no package.json,
// and prevents shell injection by passing base_sha and head_sha safely through environment variables.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { fileURLToPath, pathToFileURL } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const T = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? `  -- ${extra}` : ''}`) }
}
const sec = (s) => console.log(`\n# ${s}`)

sec('1. Reproduce fresh-checkout & stranger-repo execution of action.yml command')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-ci-gate-'))
try {
  const actionDir = path.join(tmp, 'action-path')
  const strangerRepoDir = path.join(tmp, 'stranger-repo-no-pkg')
  fs.mkdirSync(actionDir, { recursive: true })
  fs.mkdirSync(strangerRepoDir, { recursive: true })

  fs.cpSync(path.join(ROOT, 'packages', 'git-clash'), path.join(actionDir, 'packages', 'git-clash'), { recursive: true })
  fs.cpSync(path.join(ROOT, 'packages', 'icr-merge'), path.join(actionDir, 'packages', 'icr-merge'), { recursive: true })

  // Isolate module resolution to `tmp` so any stray `~/node_modules` on a dev machine cannot mask a missing install
  const tmpFileUrlPrefix = pathToFileURL(tmp).href
  const hookPath = path.join(tmp, '_isolate-hook.mjs')
  const regPath = path.join(tmp, '_isolate-reg.mjs')
  fs.writeFileSync(hookPath, [
    `export async function resolve(specifier, context, nextResolve) {`,
    `  const r = await nextResolve(specifier, context);`,
    `  if (r.url.includes('/node_modules/') && !r.url.startsWith(${JSON.stringify(tmpFileUrlPrefix)})) {`,
    `    const err = new Error("Cannot find package '" + specifier + "' imported from " + (context.parentURL || ''));`,
    `    err.code = 'ERR_MODULE_NOT_FOUND';`,
    `    throw err;`,
    `  }`,
    `  return r;`,
    `}`,
  ].join('\n'), 'utf8')
  fs.writeFileSync(regPath, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hookPath).href)});\n`, 'utf8')
  const regUrl = pathToFileURL(regPath).href

  // 1a. Without node_modules in actionDir, running from strangerRepoDir (which has NO package.json):
  const bareRun = spawnSync(
    process.execPath,
    ['--import', regUrl, path.join(actionDir, 'packages', 'git-clash', 'cli.mjs'), '--demo'],
    { cwd: strangerRepoDir, encoding: 'utf8' }
  )
  T('Without actionDir/node_modules, git-clash fails with ERR_MODULE_NOT_FOUND for acorn from packages/icr-merge/lang-js.js',
    bareRun.status !== 0 && /ERR_MODULE_NOT_FOUND/.test(bareRun.stderr) && /acorn/.test(bareRun.stderr),
    `status=${bareRun.status} stderr=${JSON.stringify((bareRun.stderr || '').slice(0, 200))}`)

  // 1b. Populate actionDir/node_modules/acorn (as `npm ci --omit=dev --ignore-scripts` in working-directory: ${{ github.action_path }} does):
  const reqFromRoot = createRequire(path.join(ROOT, 'package.json'))
  const acornDist = reqFromRoot.resolve('acorn')
  const acornDir = path.resolve(path.dirname(acornDist), '..')
  fs.cpSync(acornDir, path.join(actionDir, 'node_modules', 'acorn'), { recursive: true })

  // Read the `run:` command from action.yml's `Run git-clash engine` step and substitute ${{ github.action_path }} -> actionDir
  const actionYmlRaw = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8')
  const runCmdMatch = actionYmlRaw.match(/name:\s*Run git-clash engine[\s\S]*?run:\s*([^\r\n]+)/)
  const rawCmd = runCmdMatch ? runCmdMatch[1].trim() : ''
  const resolvedScriptMatch = rawCmd
    .replace(/\$\{\{\s*github\.action_path\s*\}\}/g, actionDir)
    .match(/^node\s+"?([^"]+cli\.mjs)"?/)
  const cliTarget = resolvedScriptMatch ? resolvedScriptMatch[1] : 'packages/git-clash/cli.mjs'

  T('Stranger repo directory has NO package.json and NO node_modules',
    !fs.existsSync(path.join(strangerRepoDir, 'package.json')) && !fs.existsSync(path.join(strangerRepoDir, 'node_modules')))

  // Run the action.yml CLI target from cwd = strangerRepoDir (with NO package.json!)
  const strangerRun = spawnSync(
    process.execPath,
    ['--import', regUrl, cliTarget, '--demo'],
    { cwd: strangerRepoDir, encoding: 'utf8' }
  )
  T('Running action.yml command from a stranger directory with NO package.json finds acorn in github.action_path and exits 0',
    strangerRun.status === 0 && /Forensic Semantic Drift Analyzer/.test(strangerRun.stdout),
    `cliTarget=${cliTarget} status=${strangerRun.status} stderr=${JSON.stringify((strangerRun.stderr || '').slice(0, 220))}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

sec('2. Verify action.yml installs in working-directory: ${{ github.action_path }} with npm ci --omit=dev --ignore-scripts')

const actionYml = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8')
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const rootLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))

T('Root package.json declares acorn in dependencies',
  Boolean(rootPkg.dependencies && rootPkg.dependencies.acorn),
  `acorn=${rootPkg.dependencies && rootPkg.dependencies.acorn}`)

T('Root package-lock.json includes node_modules/acorn for npm ci',
  Boolean(rootLock.packages && rootLock.packages['node_modules/acorn']),
  'missing node_modules/acorn in package-lock.json')

const actionInstallsIdx = actionYml.indexOf('npm ci --omit=dev --ignore-scripts')
const actionWorkdirIdx = actionYml.indexOf('working-directory: ${{ github.action_path }}')
const actionRunsCliIdx = actionYml.indexOf('${{ github.action_path }}/packages/git-clash/cli.mjs')

T('action.yml runs `npm ci --omit=dev --ignore-scripts` with `working-directory: ${{ github.action_path }}` before invoking cli.mjs',
  actionInstallsIdx !== -1 && actionWorkdirIdx !== -1 && actionRunsCliIdx !== -1 && actionInstallsIdx < actionRunsCliIdx,
  `installIdx=${actionInstallsIdx} workdirIdx=${actionWorkdirIdx} runIdx=${actionRunsCliIdx}`)

sec('3. Shell injection prevention in action.yml')

const stepBlockMatch = actionYml.match(/name:\s*Run git-clash engine[\s\S]*?(?=\n\s*-\s*name:|\n\s*$)/)
const stepBlock = stepBlockMatch ? stepBlockMatch[0] : ''

const hasEnvBase = /env:[\s\S]*?BASE_SHA:\s*(\$\{\{\s*inputs\.base_sha\s*\}\}|['"]\$\{\{\s*inputs\.base_sha\s*\}\}['"])/.test(stepBlock)
const hasEnvHead = /env:[\s\S]*?HEAD_SHA:\s*(\$\{\{\s*inputs\.head_sha\s*\}\}|['"]\$\{\{\s*inputs\.head_sha\s*\}\}['"])/.test(stepBlock)
const usesQuotedEnvBase = /--base="\$BASE_SHA"/.test(stepBlock) && /--head="\$HEAD_SHA"/.test(stepBlock)
const hasRawInterpolation = /--base=\$\{\{\s*inputs\.base_sha\s*\}\}/.test(stepBlock) || /--head=\$\{\{\s*inputs\.head_sha\s*\}\}/.test(stepBlock)

T('action.yml defines env.BASE_SHA from ${{ inputs.base_sha }}', hasEnvBase)
T('action.yml defines env.HEAD_SHA from ${{ inputs.head_sha }}', hasEnvHead)
T('action.yml passes --base="$BASE_SHA" and --head="$HEAD_SHA" (not raw bash interpolation)',
  usesQuotedEnvBase && !hasRawInterpolation,
  `usesQuotedEnv=${usesQuotedEnvBase} hasRaw=${hasRawInterpolation}`)

let bashCmd = 'bash'
if (process.platform === 'win32') {
  const gitBash = 'C:/Program Files/Git/bin/bash.exe'
  if (fs.existsSync(gitBash)) bashCmd = gitBash
}

const pwnedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-pwn-test-'))
try {
  const pwnBase = path.join(pwnedDir, 'PWNED_BASE').replace(/\\/g, '/')
  const pwnHead = path.join(pwnedDir, 'PWNED_HEAD').replace(/\\/g, '/')
  const maliciousBase = `x; touch ${pwnBase} ;`
  const maliciousHead = `x; touch ${pwnHead}`

  // Simulate how GitHub Actions renders composite action steps:
  // 1. env declarations are evaluated and injected into the execution environment:
  const envMap = {}
  const envMatches = stepBlock.matchAll(/([A-Z_]+):\s*(?:['"]?)\$\{\{\s*inputs\.([a-z_]+)\s*\}\}(?:['"]?)/g)
  for (const m of envMatches) {
    const varName = m[1]
    const inputKey = m[2]
    if (inputKey === 'base_sha') envMap[varName] = maliciousBase
    if (inputKey === 'head_sha') envMap[varName] = maliciousHead
  }

  // 2. run script interpolates ${{ inputs... }} and ${{ github.action_path }}:
  const runMatch = stepBlock.match(/\brun:\s*([^\r\n]+)/)
  let renderedScript = runMatch ? runMatch[1].trim() : ''
  renderedScript = renderedScript
    .replace(/\$\{\{\s*github\.action_path\s*\}\}/g, ROOT.replace(/\\/g, '/'))
    .replace(/\$\{\{\s*inputs\.base_sha\s*\}\}/g, maliciousBase)
    .replace(/\$\{\{\s*inputs\.head_sha\s*\}\}/g, maliciousHead)

  spawnSync(bashCmd, ['-c', renderedScript], {
    cwd: pwnedDir,
    env: { ...process.env, ...envMap },
    encoding: 'utf8',
  })

  T('Malicious base_sha input (x; touch PWNED_BASE) does NOT execute shell commands',
    !fs.existsSync(pwnBase),
    `pwnBase file exists: ${fs.existsSync(pwnBase)}`)

  T('Malicious head_sha input (x; touch PWNED_HEAD) does NOT execute shell commands',
    !fs.existsSync(pwnHead),
    `pwnHead file exists: ${fs.existsSync(pwnHead)}`)
} finally {
  fs.rmSync(pwnedDir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
