#!/usr/bin/env node
/**
 * PRE-DEPLOY CHECK: DOES THE PUBLIC SITE DOCUMENT UNPUBLISHED COMMANDS OR FLAGS?
 *
 *   node scripts/check-site-release.mjs
 *
 * Prevents a "wrong-but-green" deployment where public/*.html documents features,
 * commands, or flags (such as github start --slack-channel, --slack-allow, or slack start)
 * that have not yet been published to npm in hivecode-mcp@latest.
 *
 * Exit codes:
 *   0: All documented commands and flags exist in the published package.
 *   1: Site documents commands or flags missing from npm ("publish to npm first, then deploy the site").
 *   2: Network failure, timeout, 5xx, or invalid response ("could not check", fails closed).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractValidSubcommands,
  extractCommandsAndFlags,
  resolveSubcommandFile,
  extractSubcommandUsageFlags,
} from './site-commands.mjs'

export async function runCheckSiteRelease(options = {}) {
  const registryUrl = (options.registryUrl || process.env.HIVE_NPM_REGISTRY_URL || 'https://registry.npmjs.org').replace(/\/$/, '')
  const unpkgUrl = (options.unpkgUrl || process.env.HIVE_UNPKG_URL || 'https://unpkg.com').replace(/\/$/, '')
  const timeoutMs = Number(options.timeoutMs || process.env.HIVE_CHECK_TIMEOUT_MS || 10000)
  const rootDir = options.rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const publicDir = path.join(rootDir, 'public')
  const log = options.log || console.log
  const errorLog = options.errorLog || console.error

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

  // 2. Fetch latest published version from npm registry
  let version = ''
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
  let publishedMcpJs = ''
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

  const publishedValidSubcommands = extractValidSubcommands(publishedMcpJs)
  const missing = []

  // 4. Verify each documented subcommand and its flags
  for (const [subcmd] of documentedCommands) {
    if (!publishedValidSubcommands.has(subcmd)) {
      missing.push(`command "${subcmd}": not dispatched in published hive-mcp.js (version ${version})`)
      continue
    }

    const relFile = resolveSubcommandFile(subcmd)
    if (!relFile) {
      // Command takes no file (e.g. invite/revoke)
      continue
    }

    // Fetch published command file
    let fileContent = ''
    try {
      const fileRes = await fetch(`${unpkgUrl}/hivecode-mcp@${version}/${relFile}`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (fileRes.status === 404) {
        // A 404 for a command's file on unpkg is exit 1, not 2
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

    const publishedFlags = extractSubcommandUsageFlags(subcmd, fileContent)
    const siteFlags = documentedFlags.get(subcmd) || new Set()
    for (const flag of siteFlags) {
      if (!publishedFlags.has(flag)) {
        missing.push(`${subcmd} ${flag}: flag not found in published hivecode-mcp@${version} (${relFile})`)
      }
    }
  }

  // 4b. Verify unpkg links against published release
  for (const [rawUrl, pages] of unpkgLinks) {
    const pathPart = rawUrl.replace(/^https?:\/\/(?:www\.)?unpkg\.com\//, '')
    // Strip leading browse/ to hit raw asset endpoint directly, avoiding the unpkg SPA redirect trap
    const rawPath = pathPart.replace(/^browse\//, '')
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
    errorLog(`\n[check-site-release] FAILED: site documents commands, flags, or links missing from published hivecode-mcp@${version}:`)
    for (const item of missing) {
      errorLog(`  - ${item}`)
    }
    errorLog('\npublish to npm first, then deploy the site\n')
    return 1
  }

  log(`[check-site-release] OK: all commands, flags, and links on site exist in published hivecode-mcp@${version}`)
  return 0
}

// Direct CLI invocation
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCheckSiteRelease().then(code => {
    process.exit(code)
  }).catch(err => {
    console.error(`[check-site-release] ERROR: could not check (${err.message})`)
    process.exit(2)
  })
}
