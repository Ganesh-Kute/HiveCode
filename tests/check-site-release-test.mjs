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

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCheckSiteRelease } from '../scripts/check-site-release.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}

// Server state configuration
let serverMode = 'all-present' // 'all-present' | 'missing-flag' | 'missing-command-file' | 'registry-html'

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

  if (url.includes('/hivecode-mcp@0.13.0/')) {
    const filename = url.split('/hivecode-mcp@0.13.0/')[1]

    if (serverMode === 'missing-command-file' && filename === 'hive-slack.js') {
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

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`

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
  T('Case 3 logs OK status', outText3.includes('OK: all commands and flags on site exist in published'))

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

} finally {
  await new Promise(resolve => server.close(resolve))
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
