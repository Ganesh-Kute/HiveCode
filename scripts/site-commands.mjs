// Shared module for extracting commands, flags, and USAGE strings across public website pages and source CLI files.
// Used by both tests/site-cli-usage-test.mjs (local drift check) and scripts/check-site-release.mjs (pre-deploy npm release check).

import fs from 'node:fs'
import path from 'node:path'

// 1. Derive valid subcommands from hive-mcp.js dispatch lines
export function extractValidSubcommands(source) {
  const set = new Set()
  const regex = /process\.argv\[2\]\s*===?\s*['"]([a-zA-Z0-9_-]+)['"]/g
  for (const m of source.matchAll(regex)) {
    if (!m[1].startsWith('-')) {
      set.add(m[1])
    }
  }
  return set
}

// 2. Extract flags from USAGE text
export function extractUsageFlags(usageText) {
  const flags = new Set()
  if (!usageText) return flags
  for (const m of usageText.matchAll(/--([a-z0-9-]+)/g)) {
    flags.add(`--${m[1]}`)
  }
  return flags
}

// 3. Mapping from subcommand name to CLI implementation file
export const SUBCOMMAND_FILES = {
  github: 'hive-github.js',
  branch: 'hive-branch.js',
  pr: 'hive-branch.js',
  notify: 'hive-notify.js',
  setup: 'hive-setup.js',
  slack: 'hive-slack.js',
}

export function resolveSubcommandFile(subcmd) {
  return SUBCOMMAND_FILES[subcmd] || null
}

// 4. Extract flags for a specific subcommand from its source file content
export function extractSubcommandUsageFlags(subcmd, fileContent) {
  if (!fileContent) return new Set()
  if (subcmd === 'github') {
    const m = fileContent.match(/const USAGE = `([\s\S]*?)`/)
    return extractUsageFlags(m ? m[1] : '')
  }
  if (subcmd === 'branch' || subcmd === 'pr') {
    const m = fileContent.match(/USAGE = `([\s\S]*?)`/)
    if (!m) return new Set()
    const lines = m[1].split('\n')
    const filtered = lines.filter(l => l.includes(subcmd)).join('\n')
    return extractUsageFlags(filtered)
  }
  if (subcmd === 'notify') {
    const m = fileContent.match(/USAGE = `([\s\S]*?)`/)
    return extractUsageFlags(m ? m[1] : '')
  }
  if (subcmd === 'setup') {
    const m = fileContent.match(/Usage: npx[^\n]+/)
    return extractUsageFlags(m ? m[0] : '--name --dry-run --help')
  }
  if (subcmd === 'slack') {
    const m = fileContent.match(/USAGE\s*=\s*`([\s\S]*?)`/)
    return extractUsageFlags(m ? m[1] : '')
  }
  if (subcmd === 'invite' || subcmd === 'revoke') {
    return new Set()
  }
  const m = fileContent.match(/USAGE\s*=\s*`([\s\S]*?)`/)
  return extractUsageFlags(m ? m[1] : '')
}

// 5. Strip HTML tags and decode entities
export function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

// 6. Parser for commands and flags from HTML text
export function extractCommandsAndFlags(html) {
  const clean = stripHtml(html)
  const commands = []
  const flagsFound = []

  const cmdRegex = /npx\s+(?:-y\s+)?hivecode-mcp(?:@latest)?\s+([a-z0-9-]+)([^\n]*)/g
  for (const m of clean.matchAll(cmdRegex)) {
    const subcmd = m[1]
    const argsLine = m[2]
    commands.push({ subcmd, raw: m[0].trim() })

    for (const flagMatch of argsLine.matchAll(/--([a-z0-9-]+)/g)) {
      flagsFound.push({ subcmd, flag: `--${flagMatch[1]}` })
    }
  }

  return { commands, flagsFound }
}

// 7. Extract Slack app manifest JSON blocks from docs.html
export function extractSlackManifests(docsHtml) {
  const manifests = []
  const regex = /<pre><code>\s*(\{[\s\S]*?"display_information"[\s\S]*?\})\s*<\/code><\/pre>/g
  for (const match of docsHtml.matchAll(regex)) {
    try {
      manifests.push(JSON.parse(match[1]))
    } catch (err) {
      manifests.push({ error: err.message, raw: match[1] })
    }
  }
  return manifests
}

export function extractSlackManifest(docsHtml) {
  const all = extractSlackManifests(docsHtml)
  return all.length > 0 ? all[0] : null
}
