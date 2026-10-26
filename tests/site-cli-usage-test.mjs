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
import assert from 'node:assert'
import {
  extractValidSubcommands,
  extractUsageFlags,
  extractSlackManifests,
  extractSlackManifest,
  extractCommandsAndFlags,
  stripHtml,
  SUBCOMMAND_FILES,
  resolveSubcommandFile,
  extractSubcommandUsageFlags,
} from '../scripts/site-commands.mjs'

export {
  extractValidSubcommands,
  extractUsageFlags,
  extractSlackManifests,
  extractSlackManifest,
  extractCommandsAndFlags,
  stripHtml,
}

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const PUBLIC = path.join(ROOT, 'public')

let failed = 0
const T = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  -- ${detail}` : ''}`)
  if (!ok) failed++
}

// 1. Derive valid subcommands from hive-mcp.js dispatch lines
const mcpJs = fs.readFileSync(path.join(ROOT, 'hive-mcp.js'), 'utf8')
const VALID_SUBCOMMANDS = extractValidSubcommands(mcpJs)

// Map subcommands to their allowed flags using shared resolution
const USAGE_MAP = new Map()
for (const [subcmd, filename] of Object.entries(SUBCOMMAND_FILES)) {
  const filePath = path.join(ROOT, filename)
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8')
    USAGE_MAP.set(subcmd, extractSubcommandUsageFlags(subcmd, content))
  }
}

export function validateText(text) {
  const { commands, flagsFound } = extractCommandsAndFlags(text)
  const errors = []

  for (const { subcmd, raw } of commands) {
    if (!VALID_SUBCOMMANDS.has(subcmd)) {
      errors.push(`Unknown subcommand "${subcmd}" (not dispatched in hive-mcp.js) in "${raw}"`)
    }
    const claudeAgentMatch = raw.match(/--agent\s+(?:"([^"]*claude[^"]*)"|'([^']*claude[^']*)')/i)
    if (claudeAgentMatch) {
      const agentCmd = claudeAgentMatch[1] || claudeAgentMatch[2] || ''
      if (!agentCmd.includes('--allowedTools') || !agentCmd.includes('mcp__hivecode')) {
        errors.push(`--agent "${agentCmd}" invokes claude without --allowedTools including mcp__hivecode in "${raw}"`)
      }
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

export const validateHtml = validateText

// P0: Guard against false success — validator fails on made-up flag
const fakeFlagHtml = '<pre><code>npx -y hivecode-mcp@latest github start --fake-nonexistent-flag</code></pre>'
const fakeFlagCheck = validateHtml(fakeFlagHtml)
T('P0 validator fails on made-up flag --fake-nonexistent-flag', !fakeFlagCheck.ok && fakeFlagCheck.errors.some(e => e.includes('--fake-nonexistent-flag')))

// P0b: Guard against line continuation evasion — bash trailing \
const fakeContinuationBash = `
\`\`\`bash
npx -y hivecode-mcp@latest slack start \\
  --channel C0123456789 \\
  --fake-continuation-flag
\`\`\`
`
const bashCheck = validateText(fakeContinuationBash)
T('P0b validator catches fake flag on bash continuation line', !bashCheck.ok && bashCheck.errors.some(e => e.includes('--fake-continuation-flag')))

// P0c: Guard against line continuation evasion — PowerShell trailing \`
const fakeContinuationPwsh = `
\`\`\`powershell
npx -y hivecode-mcp@latest slack start \`
  --channel C0123456789 \`
  --fake-pwsh-flag
\`\`\`
`
const pwshCheck = validateText(fakeContinuationPwsh)
T('P0c validator catches fake flag on PowerShell continuation line', !pwshCheck.ok && pwshCheck.errors.some(e => e.includes('--fake-pwsh-flag')))

// P0d: Red proof — made-up flag injected into temporary copy of a guide
const slackGuideContent = fs.readFileSync(path.join(ROOT, 'docs/SLACK_SETUP.md'), 'utf8')
const fakeGuide = slackGuideContent.replace(
  '--channel C0123456789',
  '--channel C0123456789 --made-up-guide-flag'
)
const fakeGuideCheck = validateText(fakeGuide)
T('P0d validator catches made-up flag injected into guide copy', !fakeGuideCheck.ok && fakeGuideCheck.errors.some(e => e.includes('--made-up-guide-flag')))

// P0e: Guard against tool-less claude agent invocation in guides
const fakeClaudeAgent = `
\`\`\`bash
npx -y hivecode-mcp@latest github start --agent "claude -p 'Read the issue and fix'"
\`\`\`
`
const fakeClaudeCheck = validateText(fakeClaudeAgent)
T('P0e validator catches claude --agent without mcp__hivecode and --allowedTools', !fakeClaudeCheck.ok && fakeClaudeCheck.errors.some(e => e.includes('mcp__hivecode')))

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

// P4b: Markdown documentation guides check (docs/QUICKSTART.md, docs/SLACK_SETUP.md, docs/GITHUB_WORKFLOW.md, docs/DEPLOY.md, README.md)
const TARGET_GUIDES = [
  'docs/QUICKSTART.md',
  'docs/SLACK_SETUP.md',
  'docs/GITHUB_WORKFLOW.md',
  'docs/DEPLOY.md',
  'README.md'
]

let guideErrors = []
let totalGuideCommands = 0
let totalGuideFlags = 0

for (const guide of TARGET_GUIDES) {
  const filePath = path.join(ROOT, guide)
  T(`vacuity guard: ${guide} exists on disk`, fs.existsSync(filePath))
  const content = fs.readFileSync(filePath, 'utf8')
  const res = validateText(content)
  totalGuideCommands += res.commands.length
  totalGuideFlags += res.flagsFound.length
  T(`vacuity guard: ${guide} yields >0 commands`, res.commands.length > 0, `found ${res.commands.length} commands, ${res.flagsFound.length} flags`)
  if (!res.ok) {
    guideErrors.push(`${guide}: ${res.errors.join('; ')}`)
  }
}

T(`P4b markdown guides commands & flags match real USAGE (${totalGuideCommands} commands, ${totalGuideFlags} flags checked)`, guideErrors.length === 0, guideErrors.join(' | '))

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

// P6a: Guard against false success — manifest validator catches modified scope
const baseManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'slack-app-manifest.json'), 'utf8'))
const mutatedManifest = JSON.parse(JSON.stringify(baseManifest))
mutatedManifest.oauth_config.scopes.bot.push('files:write')
let caughtMutation = false
try {
  assert.deepStrictEqual(baseManifest, mutatedManifest)
} catch {
  caughtMutation = true
}
T('P6a manifest equality validator catches modified scope', caughtMutation)

// P6: Guard against drift between docs.html Slack manifests and repo manifest files
const docsHtmlForManifest = fs.readFileSync(path.join(PUBLIC, 'docs.html'), 'utf8')
const docsManifests = extractSlackManifests(docsHtmlForManifest)

// Outbound manifest
const rootOutboundManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'slack-app-manifest.json'), 'utf8'))
const docsOutbound = docsManifests.find(m => m && m.settings && m.settings.socket_mode_enabled === false)

let outboundMatches = false
let outboundDiff = ''
if (docsOutbound) {
  try {
    assert.deepStrictEqual(docsOutbound, rootOutboundManifest)
    outboundMatches = true
  } catch (err) {
    outboundDiff = err.message
  }
} else {
  outboundDiff = 'outbound manifest (socket_mode_enabled: false) not found in docs.html'
}
T('P6 Slack outbound manifest in docs.html matches slack-app-manifest.json', outboundMatches, outboundDiff)

// Inbound manifest
const rootInboundPath = path.join(ROOT, 'slack-app-manifest-inbound.json')
const docsInbound = docsManifests.find(m => m && m.settings && m.settings.socket_mode_enabled === true)

let inboundMatches = false
let inboundDiff = ''
if (!fs.existsSync(rootInboundPath)) {
  inboundDiff = 'slack-app-manifest-inbound.json does not exist'
} else if (docsInbound) {
  const rootInboundManifest = JSON.parse(fs.readFileSync(rootInboundPath, 'utf8'))
  try {
    assert.deepStrictEqual(docsInbound, rootInboundManifest)
    inboundMatches = true
  } catch (err) {
    inboundDiff = err.message
  }
} else {
  inboundDiff = 'inbound manifest (socket_mode_enabled: true) not found in docs.html'
}
T('P6b Slack inbound manifest in docs.html matches slack-app-manifest-inbound.json', inboundMatches, inboundDiff)

// P7: Guard against drift of quoted Q-codes in docs/QUICKSTART.md
// Asserts that every `Q\d{3} ...` line quoted in docs/QUICKSTART.md has its fixed text
// somewhere in the shipped source files (package.json files[]).
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const shippedCorpus = pkgJson.files
  .filter(f => f.endsWith('.js') || f.endsWith('.cjs'))
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n')

const quickstartLines = fs.readFileSync(path.join(ROOT, 'docs', 'QUICKSTART.md'), 'utf8').split('\n')
const qLines = []
for (let i = 0; i < quickstartLines.length; i++) {
  const line = quickstartLines[i]
  const m = line.match(/`\s*(Q\d{3}\b[^`]+)`/)
  if (m) {
    qLines.push({ lineNum: i + 1, text: m[1].trim() })
  }
}

let qDriftErrors = []
for (const { lineNum, text } of qLines) {
  const segments = text.split(/<[^>]+>/)
    .map(s => s.replace(/^Q\d{3}\s*/, '').replace(/^[-(`\s]+|[-)`\s]+$/g, '').trim())
    .filter(s => s.length > 5)
  for (const seg of segments) {
    if (!shippedCorpus.includes(seg)) {
      qDriftErrors.push(`line ${lineNum}: "${seg}" not found in shipped source`)
    }
  }
}
T('P7 Quoted Q-code error messages in docs/QUICKSTART.md match shipped source', qDriftErrors.length === 0, qDriftErrors.join('; '))

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
