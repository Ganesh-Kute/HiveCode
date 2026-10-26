#!/usr/bin/env node
/**
 * PRE-DEPLOY CHECK: DOES THE PUBLIC SITE DOCUMENT UNPUBLISHED COMMANDS OR FLAGS?
 *
 *   node scripts/check-site-release.mjs
 *   node scripts/check-site-release.mjs --package <tarball.tgz>
 *
 * Prevents a "wrong-but-green" deployment where public/*.html documents features,
 * commands, or flags (such as github start --slack-channel, --slack-allow, or slack start)
 * that have not yet been published to npm in hivecode-mcp@latest.
 *
 * When --package <tarball> is supplied, checks are performed against the local
 * package tarball (from `npm pack`) rather than requiring publication to npm.
 *
 * Exit codes:
 *   0: All documented commands and flags exist in the published package / tarball.
 *   1: Site documents commands, flags, or links missing from npm/tarball ("publish to npm first, then deploy the site").
 *   2: Network failure, timeout, tarball read error, or invalid payload ("could not check", fails closed).
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import {
  extractValidSubcommands,
  extractCommandsAndFlags,
  resolveSubcommandFile,
  extractSubcommandUsageFlags,
} from './site-commands.mjs'

/**
 * Reads a gzipped tarball (.tgz) in memory and returns a Map of filePath -> Buffer.
 * Supports standard ustar tar archives including GNU long name headers ('L').
 * Normalizes filenames by stripping any leading 'package/' or './'.
 */
export function extractTarballFiles(tarballPathOrBuffer) {
  const buf = typeof tarballPathOrBuffer === 'string'
    ? fs.readFileSync(tarballPathOrBuffer)
    : tarballPathOrBuffer
  const tarBuf = zlib.gunzipSync(buf)
  const files = new Map()
  let offset = 0
  let nextLongName = null

  while (offset + 512 <= tarBuf.length) {
    const h = tarBuf.subarray(offset, offset + 512)
    let isZero = true
    for (let i = 0; i < 512; i++) {
      if (h[i] !== 0) {
        isZero = false
        break
      }
    }
    if (isZero) break

    let name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeStr = h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const typeflag = String.fromCharCode(h[156])
    const magic = h.subarray(257, 263).toString('ascii')

    if (magic.startsWith('ustar')) {
      const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
      if (prefix) name = prefix + '/' + name
    }

    offset += 512

    if (typeflag === 'L') {
      nextLongName = tarBuf.subarray(offset, offset + size).toString('utf8').replace(/\0.*$/, '')
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      const fileName = nextLongName || name
      nextLongName = null
      const content = tarBuf.subarray(offset, offset + size)
      const normalized = fileName.replace(/^[./]*package\//, '').replace(/^\.\//, '')
      files.set(normalized, content)
    } else {
      nextLongName = null
    }

    offset += Math.ceil(size / 512) * 512
  }

  return files
}

export async function runCheckSiteRelease(options = {}) {
  const packageTarball = options.package || options.packageTarball || null
  const registryUrl = (options.registryUrl || process.env.HIVE_NPM_REGISTRY_URL || 'https://registry.npmjs.org').replace(/\/$/, '')
  const unpkgUrl = (options.unpkgUrl || process.env.HIVE_UNPKG_URL || 'https://unpkg.com').replace(/\/$/, '')
  const timeoutMs = Number(options.timeoutMs || process.env.HIVE_CHECK_TIMEOUT_MS || 10000)
  const rootDir = options.rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const publicDir = path.join(rootDir, 'public')
  const log = options.log || console.log
  const errorLog = options.errorLog || console.error

  let tarFiles = null
  let version = ''
  let publishedMcpJs = ''

  if (packageTarball) {
    if (!fs.existsSync(packageTarball)) {
      errorLog(`[check-site-release] ERROR: could not check: package tarball not found: ${packageTarball}`)
      return 2
    }
    try {
      tarFiles = extractTarballFiles(packageTarball)
    } catch (err) {
      errorLog(`[check-site-release] ERROR: could not check: failed to extract package tarball (${err.message})`)
      return 2
    }

    if (!tarFiles.has('package.json')) {
      errorLog('[check-site-release] ERROR: could not check: package.json not found in package tarball')
      return 2
    }

    let pkgData
    try {
      pkgData = JSON.parse(tarFiles.get('package.json').toString('utf8'))
    } catch {
      errorLog('[check-site-release] ERROR: could not check: package.json in tarball is not valid JSON')
      return 2
    }

    if (!pkgData || typeof pkgData.version !== 'string') {
      errorLog('[check-site-release] ERROR: could not check: package.json in tarball missing version')
      return 2
    }
    version = pkgData.version

    if (!tarFiles.has('hive-mcp.js')) {
      errorLog('[check-site-release] ERROR: could not check: hive-mcp.js not found in package tarball')
      return 2
    }
    publishedMcpJs = tarFiles.get('hive-mcp.js').toString('utf8')
  }

  // 1. Extract commands, flags, and unpkg/npm links from public site pages
  const allHtmlPages = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'))
  if (allHtmlPages.length === 0) {
    errorLog('[check-site-release] ERROR: could not check: no public/*.html pages found')
    return 2
  }

  const documentedCommands = new Map() // subcmd -> Set of raw command strings
  const documentedFlags = new Map()    // subcmd -> Set of flags
  const unpkgLinks = new Map()         // rawUrl -> Set of pages
  const npmLinks = new Map()           // rawUrl -> Set of pages

  const targetDocPages = ['index.html', 'docs.html'].filter(f => fs.existsSync(path.join(publicDir, f)))
  for (const page of targetDocPages) {
    const html = fs.readFileSync(path.join(publicDir, page), 'utf8')
    const { commands, flagsFound } = extractCommandsAndFlags(html)
    for (const { subcmd, raw } of commands) {
      if (!documentedCommands.has(subcmd)) documentedCommands.set(subcmd, new Set())
      documentedCommands.get(subcmd).add(raw)
    }
    for (const { subcmd, flag } of flagsFound) {
      if (!documentedFlags.has(subcmd)) documentedFlags.set(subcmd, new Set())
      documentedFlags.get(subcmd).add(flag)
    }
  }

  for (const page of allHtmlPages) {
    const html = fs.readFileSync(path.join(publicDir, page), 'utf8')
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?unpkg\.com\/[^\s"'<>]+/g)) {
      const url = m[0]
      if (!unpkgLinks.has(url)) unpkgLinks.set(url, new Set())
      unpkgLinks.get(url).add(page)
    }
    for (const m of html.matchAll(/https?:\/\/(?:www\.)?npmjs\.com\/package\/[^\s"'<>]+/g)) {
      const url = m[0]
      if (!npmLinks.has(url)) npmLinks.set(url, new Set())
      npmLinks.get(url).add(page)
    }
  }

  // 2. Fetch latest published version from npm registry (if not checking tarball)
  if (!tarFiles) {
    try {
      const regRes = await fetch(`${registryUrl}/hivecode-mcp/latest`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Accept': 'application/json' },
      })
      if (!regRes.ok) {
        errorLog(`[check-site-release] ERROR: could not check: npm registry returned HTTP ${regRes.status}`)
        return 2
      }
      const contentType = regRes.headers.get('content-type') || ''
      const text = await regRes.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        errorLog(`[check-site-release] ERROR: could not check: registry response not valid JSON (${contentType})`)
        return 2
      }
      if (!data || typeof data.version !== 'string') {
        errorLog('[check-site-release] ERROR: could not check: registry payload missing version')
        return 2
      }
      version = data.version
    } catch (err) {
      errorLog(`[check-site-release] ERROR: could not check: registry unreachable or timed out (${err.message})`)
      return 2
    }

    // 3. Fetch published hive-mcp.js from unpkg to verify dispatched subcommands
    try {
      const mcpRes = await fetch(`${unpkgUrl}/hivecode-mcp@${version}/hive-mcp.js`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (mcpRes.status >= 500) {
        errorLog(`[check-site-release] ERROR: could not check: unpkg returned HTTP ${mcpRes.status}`)
        return 2
      }
      if (mcpRes.status === 404) {
        errorLog(`[check-site-release] ERROR: could not check: published hive-mcp.js not found in hivecode-mcp@${version}`)
        return 2
      }
      if (!mcpRes.ok) {
        errorLog(`[check-site-release] ERROR: could not check: unpkg returned HTTP ${mcpRes.status}`)
        return 2
      }
      publishedMcpJs = await mcpRes.text()
    } catch (err) {
      errorLog(`[check-site-release] ERROR: could not check: unpkg unreachable or timed out (${err.message})`)
      return 2
    }
  }

  const publishedValidSubcommands = extractValidSubcommands(publishedMcpJs)
  const missing = []

  // 4. Verify each documented subcommand and its flags
  for (const [subcmd] of documentedCommands) {
    if (!publishedValidSubcommands.has(subcmd)) {
      missing.push(`command "${subcmd}": not dispatched in ${tarFiles ? 'tarball' : 'published'} hive-mcp.js (version ${version})`)
      continue
    }

    const relFile = resolveSubcommandFile(subcmd)
    if (!relFile) {
      // Command takes no file (e.g. invite/revoke)
      continue
    }

    // Fetch published command file from tarball or unpkg
    let fileContent = ''
    if (tarFiles) {
      if (!tarFiles.has(relFile)) {
        missing.push(`${subcmd} start: ${relFile} not in hivecode-mcp@${version} (tarball)`)
        continue
      }
      fileContent = tarFiles.get(relFile).toString('utf8')
    } else {
      try {
        const fileRes = await fetch(`${unpkgUrl}/hivecode-mcp@${version}/${relFile}`, {
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (fileRes.status === 404) {
          missing.push(`${subcmd} start: ${relFile} not in hivecode-mcp@${version} (published)`)
          continue
        }
        if (fileRes.status >= 500 || !fileRes.ok) {
          errorLog(`[check-site-release] ERROR: could not check: unpkg returned HTTP ${fileRes.status} for ${relFile}`)
          return 2
        }
        fileContent = await fileRes.text()
      } catch (err) {
        errorLog(`[check-site-release] ERROR: could not check: failed fetching ${relFile} (${err.message})`)
        return 2
      }
    }

    const publishedFlags = extractSubcommandUsageFlags(subcmd, fileContent)
    const siteFlags = documentedFlags.get(subcmd) || new Set()
    for (const flag of siteFlags) {
      if (!publishedFlags.has(flag)) {
        missing.push(`${subcmd} ${flag}: flag not found in ${tarFiles ? 'tarball' : 'published'} hivecode-mcp@${version} (${relFile})`)
      }
    }
  }

  // 4b. Verify unpkg links against published release or tarball
  for (const [rawUrl, pages] of unpkgLinks) {
    const pathPart = rawUrl.replace(/^https?:\/\/(?:www\.)?unpkg\.com\//, '')
    // Strip leading browse/ to hit raw asset endpoint directly, avoiding the unpkg SPA redirect trap
    const rawPath = pathPart.replace(/^browse\//, '')
    const mcpMatch = rawPath.match(/^hivecode-mcp(?:@[^/]+)?\/(.+)$/)

    if (tarFiles && mcpMatch) {
      const filePathInTarball = mcpMatch[1]
      if (tarFiles.has(filePathInTarball)) {
        log(`[check-site-release] will resolve after publish: ${filePathInTarball} is in the tarball (version ${version})`)
        continue
      } else {
        const pagesList = Array.from(pages).join(', ')
        missing.push(`link "${rawUrl}" (in ${pagesList}): ${filePathInTarball} not in package tarball`)
        continue
      }
    }

    // Resolve @latest to published version
    const resolvedPath = rawPath.replace(/hivecode-mcp@latest\b/, `hivecode-mcp@${version}`)
    const probeUrl = `${unpkgUrl}/${resolvedPath}`

    try {
      let res = await fetch(probeUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status === 405) {
        res = await fetch(probeUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
        })
      }
      if (res.status === 404) {
        const pagesList = Array.from(pages).join(', ')
        missing.push(`link "${rawUrl}" (in ${pagesList}): 404 on unpkg (version ${version})`)
        continue
      }
      if (res.status >= 500 || !res.ok) {
        errorLog(`[check-site-release] ERROR: could not check: unpkg returned HTTP ${res.status} for ${probeUrl}`)
        return 2
      }
    } catch (err) {
      errorLog(`[check-site-release] ERROR: could not check: unpkg unreachable or timed out probing ${probeUrl} (${err.message})`)
      return 2
    }
  }

  // 4c. Verify npm package links
  for (const [rawUrl, pages] of npmLinks) {
    const pkgMatch = rawUrl.match(/npmjs\.com\/package\/([^\s"'<>\/#]+)/)
    if (!pkgMatch) continue
    const pkgName = pkgMatch[1]

    if (tarFiles && pkgName === 'hivecode-mcp') {
      log(`[check-site-release] package link "${rawUrl}" will resolve after publish (package.json in tarball)`)
      continue
    }

    const probeUrl = `${registryUrl}/${pkgName}`

    try {
      const res = await fetch(probeUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Accept': 'application/json' },
      })
      if (res.status === 404) {
        const pagesList = Array.from(pages).join(', ')
        missing.push(`link "${rawUrl}" (in ${pagesList}): package not found on npm`)
        continue
      }
      if (res.status >= 500 || !res.ok) {
        errorLog(`[check-site-release] ERROR: could not check: npm registry returned HTTP ${res.status} for ${pkgName}`)
        return 2
      }
    } catch (err) {
      errorLog(`[check-site-release] ERROR: could not check: npm registry unreachable or timed out probing ${pkgName} (${err.message})`)
      return 2
    }
  }

  // 5. Determine result
  if (missing.length > 0) {
    const targetSource = tarFiles ? `hivecode-mcp@${version} (tarball)` : `published hivecode-mcp@${version}`
    errorLog(`\n[check-site-release] FAILED: site documents commands, flags, or links missing from ${targetSource}:`)
    for (const item of missing) {
      errorLog(`  - ${item}`)
    }
    errorLog('\npublish to npm first, then deploy the site\n')
    return 1
  }

  const okTarget = tarFiles ? `package tarball (version ${version})` : `published hivecode-mcp@${version}`
  log(`[check-site-release] OK: all commands, flags, and links on site exist in ${okTarget}`)
  return 0
}

// Direct CLI invocation
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let packageTarball = null
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--package' && process.argv[i + 1]) {
      packageTarball = process.argv[i + 1]
      i++
    } else if (process.argv[i].startsWith('--package=')) {
      packageTarball = process.argv[i].slice('--package='.length)
    }
  }

  runCheckSiteRelease({ packageTarball }).then(code => {
    process.exit(code)
  }).catch(err => {
    console.error(`[check-site-release] ERROR: could not check (${err.message})`)
    process.exit(2)
  })
}
