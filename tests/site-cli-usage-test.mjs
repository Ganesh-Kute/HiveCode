// Verifies that every CLI command and --flag shown on public website pages exists in real CLI USAGE.
//
//   node tests/site-cli-usage-test.mjs
//
// MEASURED 25 Oct 2026: Website documentation drift ("wrong but green") occurs when docs
// show plausible-looking commands or flags that do not actually exist in the CLI implementation.
// This test guards against drift by parsing commands and flags from public/*.html and
// asserting every one is present in the respective tool's USAGE text.
//
// Claude's review requirements:
// 1. VALID_SUBCOMMANDS derived directly from hive-mcp.js dispatch lines.
// 2. All subcommands validated against their own USAGE text; unknown commands or flags fail loudly.
// 3. HTML tags stripped and entities decoded before matching so flags after <span> are caught.
// 4. P0/P1/P3 tests proving the checks fail on fake inputs.
// 5. P5 asserts no public page links to the private repository (github.com/Ganesh-Kute).

import fs from 'fs'
import path from 'path'

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PUBLIC = path.join(ROOT, 'public')

let failed = 0
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}

// 1. Derive valid subcommands from hive-mcp.js dispatch lines
const mcpJs = fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8')
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
const VALID_SUBCOMMANDS = extractValidSubcommands(mcpJs)

// 2. Extract flags from USAGE text
export function extractUsageFlags(usageText) {
  const flags = new Set()
  for (const m of usageText.matchAll(/--([a-z0-9-]+)/g)) {
    flags.add(`--${m[1]}`)
  }
  return flags
}

// Map subcommands to their allowed flags
const USAGE_MAP = new Map()

// github
const githubJs = fs.readFileSync(path.join(ROOT, 'hive-github.js'), 'utf8')
const githubUsageMatch = githubJs.match(/const USAGE = `([\s\S]*?)`/)
USAGE_MAP.set('github', extractUsageFlags(githubUsageMatch ? githubUsageMatch[1] : ''))

// branch & pr
const branchJs = fs.readFileSync(path.join(ROOT, 'hive-branch.js'), 'utf8')
const branchUsageMatch = branchJs.match(/USAGE = `([\s\S]*?)`/)
if (branchUsageMatch) {
  const branchLines = branchUsageMatch[1].split('\n')
  const branchText = branchLines.filter(l => l.includes('branch')).join('\n')
  const prText = branchLines.filter(l => l.includes('pr')).join('\n')
  USAGE_MAP.set('branch', extractUsageFlags(branchText))
  USAGE_MAP.set('pr', extractUsageFlags(prText))
}

// notify
const notifyJs = fs.readFileSync(path.join(ROOT, 'hive-notify.js'), 'utf8')
const notifyUsageMatch = notifyJs.match(/USAGE = `([\s\S]*?)`/)
USAGE_MAP.set('notify', extractUsageFlags(notifyUsageMatch ? notifyUsageMatch[1] : ''))

// setup
const setupJs = fs.readFileSync(path.join(ROOT, 'hive-setup.js'), 'utf8')
const setupUsageMatch = setupJs.match(/Usage: npx[^\n]+/)
USAGE_MAP.set('setup', extractUsageFlags(setupUsageMatch ? setupUsageMatch[0] : '--name --dry-run --help'))

// slack (from hive-slack.js)
const slackPath = path.join(ROOT, 'hive-slack.js')
if (fs.existsSync(slackPath)) {
  const slackJs = fs.readFileSync(slackPath, 'utf8')
  const slackMatch = slackJs.match(/USAGE\s*=\s*`([\s\S]*?)`/)
  if (slackMatch) {
    USAGE_MAP.set('slack', extractUsageFlags(slackMatch[1]))
  }
}

// invite & revoke take no flags
USAGE_MAP.set('invite', new Set())
USAGE_MAP.set('revoke', new Set())

// 3. Strip HTML tags and decode entities
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

// 4. Parser for commands and flags in stripped text
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

export function validateHtml(html) {
  const { commands, flagsFound } = extractCommandsAndFlags(html)
  const errors = []

  for (const { subcmd, raw } of commands) {
    if (!VALID_SUBCOMMANDS.has(subcmd)) {
      errors.push(`Unknown subcommand "${subcmd}" (not dispatched in hive-mcp.js) in "${raw}"`)
    }
  }

  for (const { subcmd, flag } of flagsFound) {
    if (!USAGE_MAP.has(subcmd)) {
      errors.push(`No usage known for subcommand "${subcmd}"`)
    } else {
      const allowed = USAGE_MAP.get(subcmd)
      if (!allowed.has(flag)) {
        errors.push(`Unknown flag "${flag}" for subcommand "${subcmd}"`)
      }
    }
  }

  return { ok: errors.length === 0, errors, commands, flagsFound }
}

// P0: Guard against false success — validator fails on made-up flag
const fakeFlagHtml = '<pre><code>npx -y hivecode-mcp@latest github start --fake-nonexistent-flag</code></pre>'
const fakeFlagCheck = validateHtml(fakeFlagHtml)
T('P0 validator fails on made-up flag --fake-nonexistent-flag', !fakeFlagCheck.ok && fakeFlagCheck.errors.some(e => e.includes('--fake-nonexistent-flag')))

// P1: Guard against false success — validator fails on unknown subcommand
const fakeSubcmdHtml = '<pre><code>npx -y hivecode-mcp@latest fake-cmd --dry-run</code></pre>'
const fakeSubcmdCheck = validateHtml(fakeSubcmdHtml)
T('P1 validator fails on unknown subcommand fake-cmd', !fakeSubcmdCheck.ok && fakeSubcmdCheck.errors.some(e => e.includes('fake-cmd')))

// P1b: Guard against premature documentation — an undispatched subcommand must fail
const undispatchedHtml = '<pre><code>npx -y hivecode-mcp@latest discord start</code></pre>'
const undispatchedCheck = validateHtml(undispatchedHtml)
T('P1b validator fails on undispatched subcommand discord', !undispatchedCheck.ok && undispatchedCheck.errors.some(e => e.includes('discord')))

// P1c: When a subcommand is dispatched (like slack), its flags are strictly checked against USAGE
const fakeSlackFlagHtml = '<pre><code>npx -y hivecode-mcp@latest slack start --fake-slack-flag</code></pre>'
const fakeSlackFlagCheck = validateHtml(fakeSlackFlagHtml)
T('P1c validator catches fake flag on dispatched slack subcommand', !fakeSlackFlagCheck.ok && fakeSlackFlagCheck.errors.some(e => e.includes('--fake-slack-flag')))

// P3: Guard against syntax highlighting evasion — flag placed inside or after <span> must be caught
const spanWrappedFakeHtml = '<pre class="cmd"><span class="prompt">$ </span>npx -y hivecode-mcp@latest github start <span class="flag">--fake-span-flag</span></pre>'
const spanCheck = validateHtml(spanWrappedFakeHtml)
T('P3 validator catches flag inside/after <span> tags', !spanCheck.ok && spanCheck.errors.some(e => e.includes('--fake-span-flag')))

// P4: Public site pages check
const targetPages = ['index.html', 'docs.html'].filter(f => fs.existsSync(path.join(PUBLIC, f)))
let totalCommands = 0
let totalFlags = 0
const siteErrors = []

for (const page of targetPages) {
  const content = fs.readFileSync(path.join(PUBLIC, page), 'utf8')
  const res = validateHtml(content)
  totalCommands += res.commands.length
  totalFlags += res.flagsFound.length
  if (!res.ok) {
    siteErrors.push(`${page}: ${res.errors.join('; ')}`)
  }
}

T(`P4 public site commands & flags match real USAGE (${totalCommands} commands, ${totalFlags} flags checked)`, siteErrors.length === 0, siteErrors.join(' | '))

// P5: Guard against dead links to private repository
const REPO_LINKS = [/github\.com\/Ganesh-Kute/gi]
const badRepoLinks = []
for (const page of targetPages) {
  const content = fs.readFileSync(path.join(PUBLIC, page), 'utf8')
  for (const re of REPO_LINKS) {
    re.lastIndex = 0
    for (const m of content.matchAll(re)) {
      badRepoLinks.push(`${page}: ${m[0]}`)
    }
  }
}
T('P5 no public page links to private repository (github.com/Ganesh-Kute)', badRepoLinks.length === 0, badRepoLinks.join(' | '))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
