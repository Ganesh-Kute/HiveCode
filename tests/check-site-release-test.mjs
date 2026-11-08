// Tests for scripts/check-site-release.mjs using a local HTTP server
//
//   node tests/check-site-release-test.mjs
//
// Verifies all required exit codes and behaviors:
//   Case 1: Missing flag -> exit 1, lists missing flag, ends with "publish to npm first, then deploy the site"
//   Case 2: Missing whole command file (404 on unpkg) -> exit 1, names command, ends with "publish to npm first..."
//   Case 3: All present -> exit 0
//   Case 4: Server down -> exit 2 ("could not check")
//   Case 5: /latest returns HTML / invalid JSON -> exit 2 ("could not check")
//   Case 6: Missing unpkg link -> exit 1
//   Case 7: Unpkg SPA browse trap proof
//   Case 8: Missing npm package link -> exit 1
//   Case 9: --package with space and drive letter paths -> exit 0
//   Case 10: --package missing command in tarball -> exit 1 (Red test)
//   Case 11: --package missing unpkg file in tarball -> exit 1 (Red test)
//   Case 12: --package missing flag in tarball -> exit 1 (Red test)
//   Case 13: --package tarball does not exist -> exit 2

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFile, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runCheckSiteRelease } from '../scripts/check-site-release.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}

function createTarGz(files) {
  const chunks = []
  for (const [relPath, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const header = Buffer.alloc(512)
    const name = 'package/' + relPath
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'ascii')
    header.write('00000000000 ', 136, 12, 'ascii')
    header.fill(32, 148, 156)
    header.write('0', 156, 1, 'ascii')
    header.write('ustar  \0', 257, 8, 'ascii')
    let chk = 0
    for (let i = 0; i < 512; i++) chk += header[i]
    header.write(chk.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
    chunks.push(header)
    chunks.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad > 0) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(chunks))
}

// Server state configuration
let serverMode = 'all-present' // 'all-present' | 'missing-flag' | 'missing-command-file' | 'registry-html' | 'missing-link' | 'missing-package'

const server = http.createServer((req, res) => {
  const url = req.url || ''

  if (serverMode === 'registry-html' && url.includes('/latest')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!DOCTYPE html><html><body>Not JSON</body></html>')
    return
  }

  if (url.endsWith('/hivecode-mcp/latest')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ version: '0.13.0' }))
    return
  }

  // Handle npm registry package lookups: /hivecode-mcp, /icr-merge, /git-clash
  if (url === '/hivecode-mcp' || url === '/icr-merge' || url === '/git-clash') {
    if (serverMode === 'missing-package' && url === '/git-clash') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ name: url.slice(1) }))
    return
  }

  // unpkg SPA browse trap: /browse/ returns 200 HTML for missing files too
  if (url.startsWith('/browse/')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<!DOCTYPE html><html><body>unpkg SPA browse page always 200</body></html>')
    return
  }

  if (url.includes('/hivecode-mcp@0.13.0/')) {
    const filename = url.split('/hivecode-mcp@0.13.0/')[1]

    if (serverMode === 'missing-command-file' && filename === 'hive-slack.js') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('File not found')
      return
    }

    if (serverMode === 'missing-link' && filename === 'docs/QUICKSTART.md') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('File not found')
      return
    }

    const localPath = path.join(ROOT, filename)
    if (!fs.existsSync(localPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('File not found')
      return
    }

    let content = fs.readFileSync(localPath, 'utf8')

    if (serverMode === 'missing-flag' && filename === 'hive-github.js') {
      // Strip --slack-allow from USAGE
      content = content.replace(/--slack-allow/g, '--deprecated-old-flag')
    }

    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    res.end(content)
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

// Build the tarball once BEFORE the server starts, into a clean isolated tmp dir
const packTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-pack-'))
execSync(`npm pack --pack-destination "${packTmpDir}"`, { cwd: ROOT, stdio: 'ignore' })
const packFiles = fs.readdirSync(packTmpDir).filter(f => f.endsWith('.tgz'))
if (packFiles.length === 0) throw new Error(`npm pack failed to create tarball in ${packTmpDir}`)
const builtTarballPath = path.join(packTmpDir, packFiles[0])

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`

let tmpSpaceDir = null

try {
  // --- Test Case 1: Missing flag (Exit 1) ---
  serverMode = 'missing-flag'
  const errLog1 = []
  const outLog1 = []
  const code1 = await runCheckSiteRelease({
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: msg => outLog1.push(msg),
    errorLog: msg => errLog1.push(msg),
  })
  const errText1 = errLog1.join('\n')
  T('Case 1 missing flag returns exit 1', code1 === 1)
  T('Case 1 identifies missing --slack-allow flag', errText1.includes('--slack-allow'))
  T('Case 1 concludes with "publish to npm first, then deploy the site"', errText1.includes('publish to npm first, then deploy the site'))

  // --- Test Case 2: Missing whole command file (Exit 1) ---
  serverMode = 'missing-command-file'
  const errLog2 = []
  const outLog2 = []
  const code2 = await runCheckSiteRelease({
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: msg => outLog2.push(msg),
    errorLog: msg => errLog2.push(msg),
  })
  const errText2 = errLog2.join('\n')
  T('Case 2 missing whole command file returns exit 1', code2 === 1)
  T('Case 2 reports command file missing from published package', errText2.includes('hive-slack.js not in hivecode-mcp@0.13.0'))
  T('Case 2 concludes with "publish to npm first, then deploy the site"', errText2.includes('publish to npm first, then deploy the site'))

  // --- Test Case 3: All present (Exit 0) ---
  serverMode = 'all-present'
  const errLog3 = []
  const outLog3 = []
  const code3 = await runCheckSiteRelease({
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: msg => outLog3.push(msg),
    errorLog: msg => errLog3.push(msg),
  })
  const outText3 = outLog3.join('\n')
  T('Case 3 all present returns exit 0', code3 === 0)
  T('Case 3 logs OK status', outText3.includes('OK: all commands, flags, and links on site exist in published'))

  // --- Test Case 4: Server down (Exit 2) ---
  // Point to a closed port
  const errLog4 = []
  const code4 = await runCheckSiteRelease({
    registryUrl: 'http://127.0.0.1:1', // Closed port
    unpkgUrl: 'http://127.0.0.1:1',
    rootDir: ROOT,
    timeoutMs: 1000,
    errorLog: msg => errLog4.push(msg),
  })
  const errText4 = errLog4.join('\n')
  T('Case 4 server down returns exit 2', code4 === 2)
  T('Case 4 reports "could not check"', errText4.includes('could not check'))

  // --- Test Case 5: /latest returns HTML / invalid JSON (Exit 2) ---
  serverMode = 'registry-html'
  const errLog5 = []
  const code5 = await runCheckSiteRelease({
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    errorLog: msg => errLog5.push(msg),
  })
  const errText5 = errLog5.join('\n')
  T('Case 5 registry HTML returns exit 2', code5 === 2)
  T('Case 5 reports invalid JSON error', errText5.includes('not valid JSON'))

  // --- Test Case 6: Missing unpkg link (Exit 1) ---
  serverMode = 'missing-link'
  const errLog6 = []
  const outLog6 = []
  const code6 = await runCheckSiteRelease({
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: msg => outLog6.push(msg),
    errorLog: msg => errLog6.push(msg),
  })
  const errText6 = errLog6.join('\n')
  T('Case 6 missing unpkg link returns exit 1', code6 === 1)
  T('Case 6 identifies dead link to docs/QUICKSTART.md', errText6.includes('docs/QUICKSTART.md'))
  T('Case 6 identifies 404 on unpkg', errText6.includes('404 on unpkg'))
  T('Case 6 concludes with "publish to npm first, then deploy the site"', errText6.includes('publish to npm first, then deploy the site'))

  // --- Test Case 7: Unpkg SPA browse trap proof ---
  // Verify that the server's /browse endpoint returns HTTP 200 (simulating unpkg's SPA trap),
  // proving that if check-site-release didn't strip /browse/, the check would falsely pass.
  const browseRes = await fetch(`${baseUrl}/browse/hivecode-mcp@0.13.0/docs/QUICKSTART.md`)
  T('Case 7 unpkg /browse returns 200 HTML (simulating unpkg SPA trap)', browseRes.status === 200)

  // --- Test Case 8: Missing npm package link (Exit 1) ---
  serverMode = 'missing-package'
  const errLog8 = []
  const outLog8 = []
  const code8 = await runCheckSiteRelease({
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: msg => outLog8.push(msg),
    errorLog: msg => errLog8.push(msg),
  })
  const errText8 = errLog8.join('\n')
  T('Case 8 missing npm package returns exit 1', code8 === 1)
  T('Case 8 identifies missing package link', errText8.includes('package not found on npm') && errText8.includes('git-clash'))
  T('Case 8 concludes with "publish to npm first, then deploy the site"', errText8.includes('publish to npm first, then deploy the site'))

  // --- Test Case 9: --package with space and Windows drive letter (Exit 0) ---
  tmpSpaceDir = path.join(os.tmpdir(), `hive space test ${Date.now()}`)
  fs.mkdirSync(tmpSpaceDir, { recursive: true })
  const spaceTarballPath = path.join(tmpSpaceDir, 'package with space.tgz')
  fs.copyFileSync(builtTarballPath, spaceTarballPath)

  serverMode = 'all-present'
  const outLog9 = []
  const errLog9 = []
  const code9 = await runCheckSiteRelease({
    package: spaceTarballPath,
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: msg => outLog9.push(msg),
    errorLog: msg => errLog9.push(msg),
  })
  const errText9 = errLog9.join('\n')
  const outText9 = outLog9.join('\n')
  T('Case 9 --package with space and drive letter returns exit 0', code9 === 0, errText9 ? `exit ${code9}: ${errText9}` : '')
  T('Case 9 reports QUICKSTART.md will resolve after publish', outText9.includes('will resolve after publish: docs/QUICKSTART.md is in the tarball'), errText9)
  T('Case 9 reports MCP.md will resolve after publish', outText9.includes('will resolve after publish: docs/MCP.md is in the tarball'), errText9)
  T('Case 9 reports package link will resolve after publish', outText9.includes('package link') && outText9.includes('will resolve after publish'), errText9)
  T('Case 9 logs OK for package tarball', outText9.includes('OK: all commands, flags, and links on site exist in package tarball'), errText9)

  // CLI execution verification with spaces and quotes (async so test server can respond)
  const cliOut = await new Promise((resolve, reject) => {
    execFile(process.execPath, [
      path.join(ROOT, 'scripts', 'check-site-release.mjs'),
      '--package',
      spaceTarballPath,
    ], {
      env: { ...process.env, HIVE_NPM_REGISTRY_URL: baseUrl, HIVE_UNPKG_URL: baseUrl },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`))
      else resolve(stdout)
    })
  })
  T('Case 9b CLI invocation with --package succeeds', cliOut.includes('OK: all commands, flags, and links on site exist in package tarball'))

  // --- Test Case 10: --package missing command in tarball (Red test: Exit 1) ---
  const mockPkg10 = path.join(tmpSpaceDir, 'missing-cmd.tgz')
  fs.writeFileSync(mockPkg10, createTarGz({
    'package.json': JSON.stringify({ name: 'hivecode-mcp', version: '0.13.0' }),
    'hive-mcp.js': `
      const sub = process.argv[2]
      if (sub === 'version') { /* only version dispatched */ }
    `,
    'docs/QUICKSTART.md': '# Quickstart',
    'docs/MCP.md': '# MCP',
  }))
  const errLog10 = []
  const code10 = await runCheckSiteRelease({
    package: mockPkg10,
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: () => {},
    errorLog: msg => errLog10.push(msg),
  })
  const errText10 = errLog10.join('\n')
  T('Case 10 --package missing command returns exit 1', code10 === 1)
  T('Case 10 reports command not dispatched in tarball', errText10.includes('command "slack": not dispatched in tarball hive-mcp.js'))
  T('Case 10 concludes with "publish to npm first, then deploy the site"', errText10.includes('publish to npm first, then deploy the site'))

  // --- Test Case 11: --package missing unpkg file in tarball (Red test: Exit 1) ---
  const files11 = {}
  files11['package.json'] = JSON.stringify({ name: 'hivecode-mcp', version: '0.13.0' })
  files11['hive-mcp.js'] = fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8')
  for (const f of fs.readdirSync(ROOT)) {
    if (f.startsWith('hive-') && f.endsWith('.js')) {
      files11[f] = fs.readFileSync(path.join(ROOT, f), 'utf8')
    }
  }
  files11['docs/MCP.md'] = '# MCP'
  // Note: docs/QUICKSTART.md is missing from tarball!
  const mockPkg11 = path.join(tmpSpaceDir, 'missing-unpkg.tgz')
  fs.writeFileSync(mockPkg11, createTarGz(files11))
  const errLog11 = []
  const code11 = await runCheckSiteRelease({
    package: mockPkg11,
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: () => {},
    errorLog: msg => errLog11.push(msg),
  })
  const errText11 = errLog11.join('\n')
  T('Case 11 --package missing unpkg file returns exit 1', code11 === 1)
  T('Case 11 reports file not in package tarball', errText11.includes('docs/QUICKSTART.md not in package tarball'))
  T('Case 11 concludes with "publish to npm first, then deploy the site"', errText11.includes('publish to npm first, then deploy the site'))

  // --- Test Case 12: --package missing flag in tarball (Red test: Exit 1) ---
  const files12 = { ...files11 }
  files12['docs/QUICKSTART.md'] = '# Quickstart'
  files12['hive-github.js'] = files12['hive-github.js'].replace(/--slack-allow/g, '--deprecated-flag')
  const mockPkg12 = path.join(tmpSpaceDir, 'missing-flag.tgz')
  fs.writeFileSync(mockPkg12, createTarGz(files12))
  const errLog12 = []
  const code12 = await runCheckSiteRelease({
    package: mockPkg12,
    registryUrl: baseUrl,
    unpkgUrl: baseUrl,
    rootDir: ROOT,
    log: () => {},
    errorLog: msg => errLog12.push(msg),
  })
  const errText12 = errLog12.join('\n')
  T('Case 12 --package missing flag returns exit 1', code12 === 1)
  T('Case 12 reports missing flag in tarball', errText12.includes('--slack-allow') && errText12.includes('tarball'))
  T('Case 12 concludes with "publish to npm first, then deploy the site"', errText12.includes('publish to npm first, then deploy the site'))

  // --- Test Case 13: --package file does not exist (Exit 2) ---
  const errLog13 = []
  const code13 = await runCheckSiteRelease({
    package: 'C:\\nonexistent_dir_12345\\missing_pkg.tgz',
    rootDir: ROOT,
    log: () => {},
    errorLog: msg => errLog13.push(msg),
  })
  const errText13 = errLog13.join('\n')
  T('Case 13 --package missing tarball file returns exit 2', code13 === 2)
  T('Case 13 reports tarball not found', errText13.includes('could not check: package tarball not found'))

} finally {
  await new Promise(resolve => server.close(resolve))
  if (tmpSpaceDir && fs.existsSync(tmpSpaceDir)) {
    try {
      fs.rmSync(tmpSpaceDir, { recursive: true, force: true })
    } catch {
      // ignore tmp cleanup error
    }
  }
  if (packTmpDir && fs.existsSync(packTmpDir)) {
    try {
      fs.rmSync(packTmpDir, { recursive: true, force: true })
    } catch {
      // ignore tmp cleanup error
    }
  }
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
