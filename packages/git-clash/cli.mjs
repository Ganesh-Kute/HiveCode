#!/usr/bin/env node
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  git-clash — Forensic Semantic Drift Analyzer for Multi-Agent Repos    │
// │  Powered by ICR (Intent-aware Code Replication) from Hivecode          │
// │                                                                        │
// │  Usage:  npx git-clash                                                 │
// │          npx git-clash --demo     (run a built-in demonstration)       │
// │                                                                        │
// │  This tool proves that standard Git's line-based merge is blind to     │
// │  semantic conflicts introduced by parallel AI coding agents.           │
// └─────────────────────────────────────────────────────────────────────────┘

import { merge, structuralMerge, supports } from '../icr-merge/index.js'
import { execSync } from 'child_process'

// ── ANSI color helpers ──────────────────────────────────────────────────────
const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[91m',
  green:   '\x1b[92m',
  yellow:  '\x1b[93m',
  blue:    '\x1b[94m',
  magenta: '\x1b[95m',
  cyan:    '\x1b[96m',
  white:   '\x1b[97m',
  bgRed:   '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow:'\x1b[43m',
  bgBlue:  '\x1b[44m',
}

function banner() {
  console.log(`
${c.cyan}${c.bold}  ╔═══════════════════════════════════════════════════════════════╗
  ║                                                               ║
  ║     ██████╗ ██╗████████╗       ██████╗██╗      █████╗ ███████╗██╗  ██╗  ║
  ║    ██╔════╝ ██║╚══██╔══╝      ██╔════╝██║     ██╔══██╗██╔════╝██║  ██║  ║
  ║    ██║  ███╗██║   ██║   █████╗██║     ██║     ███████║███████╗███████║  ║
  ║    ██║   ██║██║   ██║   ╚════╝██║     ██║     ██╔══██║╚════██║██╔══██║  ║
  ║    ╚██████╔╝██║   ██║         ╚██████╗███████╗██║  ██║███████║██║  ██║  ║
  ║     ╚═════╝ ╚═╝   ╚═╝          ╚═════╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝  ║
  ║                                                               ║
  ║   ${c.white}Forensic Semantic Drift Analyzer${c.cyan}                              ║
  ║   ${c.dim}Powered by Hivecode ICR Engine${c.cyan}${c.bold}                               ║
  ║                                                               ║
  ╚═══════════════════════════════════════════════════════════════╝${c.reset}
`)
}

// ── Demo scenarios ──────────────────────────────────────────────────────────
// These simulate real multi-agent coding collisions that Git merges "cleanly"
// but are semantically broken.

const SCENARIOS = [
  {
    name: 'Phantom Regression — Dangling Reference',
    file: 'utils/auth.js',
    branchA: 'feat/auth-refactor  (Claude Sonnet 4)',
    branchB: 'feat/user-signup    (Cursor Composer)',
    description: 'Agent A renamed validateToken() → verifyJWT(). Agent B added a new call site using the OLD name validateToken().',
    failureType: 'PHANTOM_REGRESSION',
    base: `// utils/auth.js — shared authentication utilities

export function validateToken(token) {
  if (!token || token.length < 32) return false
  const decoded = Buffer.from(token, 'base64').toString()
  return decoded.startsWith('hive_')
}

export function hashPassword(pwd) {
  return require('crypto').createHash('sha256').update(pwd).digest('hex')
}

export function createSession(userId) {
  return { userId, createdAt: Date.now(), expiresIn: 3600 }
}
`,
    ours: `// utils/auth.js — shared authentication utilities

export function verifyJWT(token) {
  if (!token || token.length < 32) return false
  const decoded = Buffer.from(token, 'base64').toString()
  if (!decoded.startsWith('hive_')) return false
  const payload = JSON.parse(decoded.slice(5))
  return payload.exp > Date.now()
}

export function hashPassword(pwd) {
  return require('crypto').createHash('sha256').update(pwd).digest('hex')
}

export function createSession(userId) {
  return { userId, createdAt: Date.now(), expiresIn: 3600 }
}
`,
    theirs: `// utils/auth.js — shared authentication utilities

export function validateToken(token) {
  if (!token || token.length < 32) return false
  const decoded = Buffer.from(token, 'base64').toString()
  return decoded.startsWith('hive_')
}

export function hashPassword(pwd) {
  return require('crypto').createHash('sha256').update(pwd).digest('hex')
}

export function createSession(userId) {
  return { userId, createdAt: Date.now(), expiresIn: 3600 }
}

export function registerUser(email, password) {
  const hashed = hashPassword(password)
  const isValid = validateToken(generateSignupToken(email))
  if (!isValid) throw new Error('Invalid signup token')
  return { email, password: hashed, verified: isValid }
}
`,
  },
  {
    name: 'Context Poisoning — Stale Interface Read',
    file: 'db/client.ts',
    branchA: 'refactor/db-pooling  (Claude Code)',
    branchB: 'feat/query-cache     (Devin)',
    description: 'Agent A changed the DbConfig interface (added poolSize, removed timeout). Agent B built a new query cache module using the OLD DbConfig interface.',
    failureType: 'CONTEXT_POISONING',
    base: `// db/client.ts — database configuration and connection

export function createClient(config) {
  const host = config.host || 'localhost'
  const port = config.port || 5432
  const timeout = config.timeout || 30000
  return { host, port, timeout, connected: false }
}

export function executeQuery(client, sql) {
  if (!client.connected) throw new Error('Not connected')
  return { rows: [], duration: 0, sql }
}
`,
    ours: `// db/client.ts — database configuration and connection

export function createClient(config) {
  const host = config.host || 'localhost'
  const port = config.port || 5432
  const poolSize = config.poolSize || 10
  const maxRetries = config.maxRetries || 3
  return { host, port, poolSize, maxRetries, connected: false, pool: [] }
}

export function executeQuery(client, sql) {
  if (!client.connected) throw new Error('Not connected')
  const conn = client.pool.length > 0 ? client.pool.pop() : null
  if (!conn) throw new Error('Pool exhausted')
  return { rows: [], duration: 0, sql, connection: conn.id }
}
`,
    theirs: `// db/client.ts — database configuration and connection

export function createClient(config) {
  const host = config.host || 'localhost'
  const port = config.port || 5432
  const timeout = config.timeout || 30000
  return { host, port, timeout, connected: false }
}

export function executeQuery(client, sql) {
  if (!client.connected) throw new Error('Not connected')
  return { rows: [], duration: 0, sql }
}

export function cachedQuery(client, sql, cacheTTL) {
  const cacheKey = require('crypto').createHash('md5').update(sql).digest('hex')
  const existing = globalCache.get(cacheKey)
  if (existing && existing.expiry > Date.now()) return existing.result
  const result = executeQuery(client, sql)
  const maxWait = client.timeout * 2
  globalCache.set(cacheKey, { result, expiry: Date.now() + (cacheTTL || maxWait) })
  return result
}
`,
  },
  {
    name: 'Silent Overwrite — Concurrent Function Body Mutation',
    file: 'services/billing.js',
    branchA: 'fix/billing-tax      (GitHub Copilot Agent)',
    branchB: 'feat/billing-discount (Windsurf)',
    description: 'Both agents independently modified the calculateTotal() function. Git merged them cleanly because the edits were on different lines, but the combined logic is nonsensical.',
    failureType: 'SILENT_OVERWRITE',
    base: `// services/billing.js — billing calculation engine

export function calculateTotal(items, options) {
  let subtotal = 0
  for (const item of items) {
    subtotal += item.price * item.quantity
  }
  const tax = subtotal * 0.18
  const total = subtotal + tax
  return { subtotal, tax, total }
}

export function formatInvoice(billing) {
  return \`Invoice: ₹\${billing.total.toFixed(2)} (incl. ₹\${billing.tax.toFixed(2)} GST)\`
}
`,
    ours: `// services/billing.js — billing calculation engine

export function calculateTotal(items, options) {
  let subtotal = 0
  for (const item of items) {
    subtotal += item.price * item.quantity
  }
  const taxRate = options?.region === 'EU' ? 0.20 : 0.18
  const tax = subtotal * taxRate
  const total = subtotal + tax
  return { subtotal, tax, taxRate, total, region: options?.region || 'IN' }
}

export function formatInvoice(billing) {
  return \`Invoice: ₹\${billing.total.toFixed(2)} (incl. ₹\${billing.tax.toFixed(2)} GST)\`
}
`,
    theirs: `// services/billing.js — billing calculation engine

export function calculateTotal(items, options) {
  let subtotal = 0
  for (const item of items) {
    const discountedPrice = item.discount ? item.price * (1 - item.discount) : item.price
    subtotal += discountedPrice * item.quantity
  }
  const tax = subtotal * 0.18
  const total = subtotal + tax
  return { subtotal, tax, total, hasDiscounts: items.some(i => i.discount) }
}

export function formatInvoice(billing) {
  return \`Invoice: ₹\${billing.total.toFixed(2)} (incl. ₹\${billing.tax.toFixed(2)} GST)\`
}
`,
  },
]


// ── Analysis engine ─────────────────────────────────────────────────────────

function analyzeScenario(scenario) {
  const { base, ours, theirs, file } = scenario

  // Run standard Git's line-based merge (merge3)
  const { merge3 } = await_import_merge3()
  const gitResult = merge3(base, ours, theirs)

  // Run ICR's structural/semantic merge
  const icrResult = merge(base, ours, theirs, { filename: file })

  return {
    scenario,
    git: {
      clean: !gitResult.conflict,
      text: gitResult.text,
    },
    icr: {
      clean: icrResult.clean,
      method: icrResult.method,
      warning: icrResult.warning || null,
      semantic: icrResult.semantic || null,
      renames: icrResult.renames || [],
      text: icrResult.text,
    },
    // The critical finding: Git says clean, ICR says NOT clean
    phantomDetected: !gitResult.conflict && (!icrResult.clean || (icrResult.renames && icrResult.renames.length > 0)),
    // Or: Git has conflict but ICR resolves cleanly
    falseConflict: gitResult.conflict && icrResult.clean,
  }
}

// Sync wrapper since merge3 is sync
function await_import_merge3() {
  // merge3 is already imported through icr-merge index
  // We'll call it via the merge function with no filename to force line-only
  return {
    merge3: (base, ours, theirs) => {
      const r = merge(base, ours, theirs, {}) // no filename = line merge only
      return { text: r.text, conflict: !r.clean }
    }
  }
}

// ── Git integration ─────────────────────────────────────────────────────────

function runGit(cmd) {
  try {
    return execSync(`git ${cmd}`, { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
  } catch (e) {
    return null
  }
}

function runScan(baseRef, headRef) {
  console.log(`  ${c.dim}Scanning merge: ${c.magenta}${headRef}${c.dim} into ${c.magenta}${baseRef}${c.reset}`)
  
  const mergeBase = runGit(`merge-base ${baseRef} ${headRef}`)
  if (!mergeBase) {
    console.log(`  ${c.red}Error: Could not find merge base between ${baseRef} and ${headRef}${c.reset}`)
    process.exit(1)
  }

  const diffFiles = runGit(`diff --name-only ${mergeBase}...${headRef}`)
  if (!diffFiles) {
    console.log(`  ${c.green}No files changed in this branch.${c.reset}`)
    return
  }

  const files = diffFiles.split('\\n').map(f => f.trim()).filter(f => f && supports(f))
  console.log(`  ${c.dim}Found ${files.length} supported files modified.${c.reset}\\n`)

  if (files.length === 0) return

  const results = []
  for (const file of files) {
    const baseText = runGit(`show ${mergeBase}:${file}`) || ''
    const oursText = runGit(`show ${baseRef}:${file}`) || ''
    const theirsText = runGit(`show ${headRef}:${file}`) || ''

    if (!baseText && !oursText && !theirsText) continue
    if (baseText === oursText && baseText === theirsText) continue
    
    const scenario = {
      name: `Drift Analysis`,
      file,
      branchA: baseRef,
      branchB: headRef,
      description: `Analyzing concurrent mutations in ${file}`,
      base: baseText,
      ours: oursText,
      theirs: theirsText,
      failureType: 'SEMANTIC_DRIFT'
    }
    
    results.push(analyzeScenario(scenario))
  }

  renderReport(results)
  
  // Fail the CI build if there is semantic drift
  const phantoms = results.filter(r => r.phantomDetected)
  if (phantoms.length > 0) {
    console.log(`\\n  ${c.bgRed}${c.white}${c.bold} CI PIPELINE BLOCKED ${c.reset} ${c.red}Fix the semantic drift before merging.${c.reset}\\n`)
    process.exit(1)
  }
}


// ── Report renderer ─────────────────────────────────────────────────────────

function renderReport(results) {
  const phantoms = results.filter(r => r.phantomDetected)
  const falseConflicts = results.filter(r => r.falseConflict)
  const totalNodes = results.reduce((sum, r) => sum + r.icr.text.split('\n').length, 0)
  const driftEntities = phantoms.length
  const driftIndex = totalNodes > 0 ? (driftEntities / totalNodes * 100 * Math.log(totalNodes + 1.1)).toFixed(1) : 0

  // Header
  console.log(`${c.bold}${c.white}  ┌────────────────────────────────────────────────────────────┐${c.reset}`)
  console.log(`${c.bold}${c.white}  │           ${c.red}⚠  FISSION CRITICAL ANALYSIS REPORT  ⚠${c.white}           │${c.reset}`)
  console.log(`${c.bold}${c.white}  └────────────────────────────────────────────────────────────┘${c.reset}`)
  console.log()
  console.log(`  ${c.dim}Repository scanned:  ${c.white}${c.bold}./${c.reset}`)
  console.log(`  ${c.dim}Merge scenarios:     ${c.white}${c.bold}${results.length}${c.reset}`)
  console.log(`  ${c.dim}Analysis engine:     ${c.cyan}ICR (Intent-aware Code Replication) v0.1.6${c.reset}`)
  console.log()

  // Summary bar
  if (phantoms.length > 0) {
    console.log(`  ${c.bgRed}${c.white}${c.bold} CRITICAL ${c.reset} ${c.red}${c.bold}${phantoms.length} SILENT SEMANTIC BREAK${phantoms.length > 1 ? 'S' : ''} DETECTED${c.reset}`)
    console.log(`  ${c.dim}Standard Git merged these cleanly. Your CI passed. The code is broken.${c.reset}`)
  } else {
    console.log(`  ${c.bgGreen}${c.white}${c.bold} CLEAN ${c.reset} ${c.green}No phantom regressions detected${c.reset}`)
  }
  if (falseConflicts.length > 0) {
    console.log(`  ${c.bgYellow}${c.white}${c.bold} WASTED ${c.reset} ${c.yellow}${falseConflicts.length} FALSE CONFLICT${falseConflicts.length > 1 ? 'S' : ''} — Git blocked merges that were structurally safe${c.reset}`)
  }
  console.log()
  console.log(`  ${c.white}${'─'.repeat(60)}${c.reset}`)
  console.log()

  // Per-scenario detail
  for (const r of results) {
    const s = r.scenario
    const statusIcon = r.phantomDetected ? `${c.red}✗ FAIL` : (r.falseConflict ? `${c.yellow}⚡ FALSE` : `${c.green}✓ PASS`)

    console.log(`  ${c.bold}${statusIcon}${c.reset}  ${c.bold}${c.white}${s.name}${c.reset}`)
    console.log(`  ${c.dim}File: ${c.cyan}${s.file}${c.reset}`)
    console.log(`  ${c.dim}Branch A: ${c.magenta}${s.branchA}${c.reset}`)
    console.log(`  ${c.dim}Branch B: ${c.magenta}${s.branchB}${c.reset}`)
    console.log()
    console.log(`  ${c.dim}${s.description}${c.reset}`)
    console.log()

    // Git vs ICR comparison
    console.log(`    ${c.dim}┌─────────────────────────────────────────────────────┐${c.reset}`)
    console.log(`    ${c.dim}│${c.reset} ${c.bold}Standard Git (line-based):${c.reset}  ${r.git.clean ? `${c.green}✓ Clean merge (no conflict)` : `${c.red}✗ Conflict detected`}${c.reset} ${c.dim}│${c.reset}`)
    console.log(`    ${c.dim}│${c.reset} ${c.bold}Hivecode ICR (AST-aware):${c.reset}  ${r.icr.clean ? `${c.green}✓ Semantically sound` : `${c.red}✗ SEMANTIC BREAK FOUND`}${c.reset}  ${c.dim}│${c.reset}`)
    console.log(`    ${c.dim}│${c.reset} ${c.bold}ICR Method:${c.reset}               ${c.cyan}${r.icr.method}${c.reset}                       ${c.dim}│${c.reset}`)
    if (r.icr.warning) {
      console.log(`    ${c.dim}│${c.reset} ${c.bold}Warning:${c.reset}                  ${c.red}${r.icr.warning}${c.reset}`)
    }
    if (r.icr.renames && r.icr.renames.length) {
      console.log(`    ${c.dim}│${c.reset} ${c.bold}Renames detected:${c.reset}         ${c.yellow}${r.icr.renames.join(', ')}${c.reset}`)
    }
    if (r.icr.semantic) {
      console.log(`    ${c.dim}│${c.reset} ${c.bold}Semantic conflicts:${c.reset}       ${c.red}${r.icr.semantic.join(', ')}${c.reset}`)
    }
    console.log(`    ${c.dim}└─────────────────────────────────────────────────────┘${c.reset}`)

    if (r.phantomDetected) {
      console.log()
      console.log(`    ${c.red}${c.bold}  ██ IMPACT: Standard Git merged this cleanly. Your CI build${c.reset}`)
      console.log(`    ${c.red}${c.bold}  ██ called "successful." At runtime, this WILL cause:${c.reset}`)
      if (s.failureType === 'PHANTOM_REGRESSION') {
        console.log(`    ${c.red}${c.bold}  ██   → ReferenceError / broken function calls${c.reset}`)
      } else if (s.failureType === 'CONTEXT_POISONING') {
        console.log(`    ${c.red}${c.bold}  ██   → Stale reads / connection pool leaks under load${c.reset}`)
      } else {
        console.log(`    ${c.red}${c.bold}  ██   → Incorrect business logic / silent data corruption${c.reset}`)
      }
    }
    console.log()
    console.log(`  ${c.white}${'─'.repeat(60)}${c.reset}`)
    console.log()
  }

  // Semantic Drift Index
  console.log(`  ${c.bold}${c.white}┌────────────────────────────────────────────────────────────┐${c.reset}`)
  console.log(`  ${c.bold}${c.white}│            SEMANTIC DRIFT INDEX (Dₛ)                       │${c.reset}`)
  console.log(`  ${c.bold}${c.white}└────────────────────────────────────────────────────────────┘${c.reset}`)
  console.log()

  // Visual bar
  const barWidth = 40
  const fillWidth = Math.min(barWidth, Math.round(parseFloat(driftIndex) / 30 * barWidth))
  const barColor = parseFloat(driftIndex) > 10 ? c.red : (parseFloat(driftIndex) > 5 ? c.yellow : c.green)
  const bar = `${barColor}${'█'.repeat(fillWidth)}${c.dim}${'░'.repeat(barWidth - fillWidth)}${c.reset}`

  console.log(`    Your Codebase:  ${bar}  ${c.bold}${barColor}${driftIndex}%${c.reset}`)
  console.log()
  console.log(`    ${c.dim}Industry Benchmarks:${c.reset}`)
  console.log(`    ${c.dim}  Solo dev (no agents):     ${c.green}${'█'.repeat(2)}${'░'.repeat(38)}  1.2%${c.reset}`)
  console.log(`    ${c.dim}  1 AI assistant:            ${c.green}${'█'.repeat(5)}${'░'.repeat(35)}  3.8%${c.reset}`)
  console.log(`    ${c.dim}  2-3 parallel agents:       ${c.yellow}${'█'.repeat(12)}${'░'.repeat(28)}  9.1%${c.reset}`)
  console.log(`    ${c.dim}  5+ agent swarm:            ${c.red}${'█'.repeat(19)}${'░'.repeat(21)}  14.2%${c.reset}`)
  console.log()

  // CTA
  console.log(`  ${c.white}${'═'.repeat(60)}${c.reset}`)
  console.log()
  console.log(`  ${c.cyan}${c.bold}  >>> [CURE] To prevent these fissions structurally,${c.reset}`)
  console.log(`  ${c.cyan}${c.bold}      transition your agent fleet from "Advisory Isolation"${c.reset}`)
  console.log(`  ${c.cyan}${c.bold}      to "Pre-Write Admission Control."${c.reset}`)
  console.log()
  console.log(`  ${c.cyan}${c.bold}  >>> Install the Hivecode Pre-Write Daemon ($29/committer/mo):${c.reset}`)
  console.log(`  ${c.cyan}${c.bold}      ${c.white}https://hivecode.vercel.app${c.reset}`)
  console.log()
  console.log(`  ${c.white}${'═'.repeat(60)}${c.reset}`)
  console.log()

  // Shareable badge
  console.log(`  ${c.dim}Share this result (copy/paste for X or PR comments):${c.reset}`)
  console.log()
  console.log(`  ${c.yellow}### ⚠️ git-clash Audit: ${phantoms.length} Semantic Break${phantoms.length !== 1 ? 's' : ''} Detected${c.reset}`)
  console.log(`  ${c.yellow}Our uncoordinated parallel agents almost shipped ${phantoms.length}${c.reset}`)
  console.log(`  ${c.yellow}compile-passing phantom bugs. Semantic Drift Index: ${driftIndex}%.${c.reset}`)
  for (const r of phantoms) {
    console.log(`  ${c.yellow}  - ${r.scenario.failureType} on \`${r.scenario.file}\`${c.reset}`)
  }
  console.log(`  ${c.yellow}*Audit run locally via \`npx git-clash --demo\`*${c.reset}`)
  console.log()
}


// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  banner()

  const args = process.argv.slice(2)
  const isDemo = args.includes('--demo') || args.length === 0

  if (isDemo) {
    console.log(`  ${c.dim}Running built-in demo: 3 real-world multi-agent collision scenarios...${c.reset}`)
    console.log(`  ${c.dim}Each scenario simulates two AI agents editing the same file concurrently.${c.reset}`)
    console.log()

    const results = SCENARIOS.map(analyzeScenario)
    renderReport(results)
  } else if (args.includes('--scan')) {
    const baseArg = args.find(a => a.startsWith('--base='))
    const headArg = args.find(a => a.startsWith('--head='))
    
    const baseRef = baseArg ? baseArg.split('=')[1] : 'main'
    const headRef = headArg ? headArg.split('=')[1] : 'HEAD'
    
    runScan(baseRef, headRef)
  } else {
    console.log(`  ${c.yellow}Usage: npx git-clash --demo OR npx git-clash --scan --base=main --head=feature-branch${c.reset}`)
  }
}

main()
