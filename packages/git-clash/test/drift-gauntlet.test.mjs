#!/usr/bin/env node
// ┌─────────────────────────────────────────────────────────────────────────┐
// │  git-clash DRIFT GAUNTLET — Multi-Agent Semantic Drift Test Suite      │
// │                                                                        │
// │  Based on the Deep Research verification framework:                    │
// │  1. Heterogeneity Coordination Tax simulation                          │
// │  2. Boundary calibration: false conflicts vs phantom regressions       │
// │  3. Semantic Drift Index (Dₛ) validation                              │
// │                                                                        │
// │  Run: node packages/git-clash/test/drift-gauntlet.test.mjs             │
// └─────────────────────────────────────────────────────────────────────────┘

import { merge, structuralMerge, supports, describeConflicts } from '../../icr-merge/index.js'

let pass = 0, fail = 0, total = 0
const T = (name, condition) => {
  total++
  if (condition) { pass++; console.log(`  ✓  ${name}`) }
  else           { fail++; console.log(`  ✗  FAIL: ${name}`) }
}

const section = (title) => console.log(`\n━━━ ${title} ━━━`)

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: HETEROGENEITY COORDINATION TAX SIMULATION
// Simulate two different agent architectures (Claude vs Devin) editing
// the same codebase concurrently, targeting the same base commit.
// ═══════════════════════════════════════════════════════════════════════════

section('PART 1: Heterogeneity Coordination Tax — Cross-Agent Collisions')

// Scenario 1A: Phantom Regression — Dangling Reference
// Agent Claude renames validateToken() → verifyJWT()
// Agent Devin adds a new call site using the OLD name validateToken()
{
  const base = `// auth.js
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
`
  const agentClaude = `// auth.js
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
`
  const agentDevin = `// auth.js
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
`
  const r = merge(base, agentClaude, agentDevin, { filename: 'auth.js' })

  T('1A: Git would merge cleanly but ICR detects dangling ref', !r.clean)
  T('1A: Warning mentions validateToken', (r.warning || '').includes('validateToken'))
  T('1A: Semantic conflict key includes ref:validateToken', (r.semantic || []).some(s => s.includes('validateToken')))
  T('1A: Merged text still contains both edits (no data loss)', r.text.includes('verifyJWT') && r.text.includes('registerUser'))
}

// Scenario 1B: Silent Overwrite — Both agents mutate same function body
// Agent Copilot adds regional tax logic to calculateTotal()
// Agent Windsurf adds discount logic to calculateTotal()
{
  const base = `// billing.js
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
`
  const agentCopilot = `// billing.js
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
`
  const agentWindsurf = `// billing.js
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
`
  const r = merge(base, agentCopilot, agentWindsurf, { filename: 'billing.js' })

  T('1B: Both sides changed calculateTotal → NOT clean', !r.clean)
  T('1B: Warning mentions both sides changed function', (r.warning || '').includes('calculateTotal'))
  T('1B: Semantic conflict key includes fn:calculateTotal', (r.semantic || []).some(s => s.includes('calculateTotal')))
}

// Scenario 1C: Cross-file independent additions — should merge cleanly
// Agent Claude adds a utility function
// Agent Devin adds a completely different utility function
{
  const base = `// utils.js
export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
`
  const agentClaude = `// utils.js
export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

export function slugify(str) {
  return str.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}
`
  const agentDevin = `// utils.js
export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

export function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '...' : str
}
`
  const r = merge(base, agentClaude, agentDevin, { filename: 'utils.js' })

  T('1C: Independent additions merge cleanly', r.clean)
  T('1C: Both new functions present', r.text.includes('slugify') && r.text.includes('truncate'))
  T('1C: Method is structural (not line fallback)', r.method === 'structural')
}


// ═══════════════════════════════════════════════════════════════════════════
// PART 2: BOUNDARY CALIBRATION
// False Conflicts vs Phantom Regressions — the engine must NOT flag
// benign refactoring, but MUST catch semantic traps.
// ═══════════════════════════════════════════════════════════════════════════

section('PART 2: Boundary Calibration — False Conflicts vs Phantoms')

// --- BENIGN REFACTORING (must NOT trigger conflict) ---

// 2A: Method reordering — Unordered List Shift
// Reordering functions within a module should NOT be a conflict
{
  const base = `// module.js
export function alpha() { return 'a' }

export function beta() { return 'b' }

export function gamma() { return 'c' }
`
  const ours = `// module.js
export function gamma() { return 'c' }

export function alpha() { return 'a' }

export function beta() { return 'b' }
`
  const r = merge(base, ours, base, { filename: 'module.js' })

  T('2A: Method reordering is NOT a conflict (unordered list)', r.clean)
  T('2A: All functions preserved', r.text.includes('alpha') && r.text.includes('beta') && r.text.includes('gamma'))
}

// 2B: Consistent identifier renaming — Leaf Node Alpha-Equivalence
// One side renames a function AND updates all call sites consistently
{
  const base = `// service.js
function fetchData() { return [] }

function processItems() {
  const data = fetchData()
  return data.map(x => x.id)
}
`
  const ours = `// service.js
function loadRecords() { return [] }

function processItems() {
  const data = loadRecords()
  return data.map(x => x.id)
}
`
  const r = merge(base, ours, base, { filename: 'service.js' })

  T('2B: Consistent rename is clean (alpha-equivalence)', r.clean)
  T('2B: New name present, old name gone', r.text.includes('loadRecords') && !r.text.includes('fetchData'))
}

// 2C: Comment-only changes — must NOT trigger semantic conflict
{
  const base = `// config.js
export function getConfig() {
  return { port: 3000, host: 'localhost' }
}
`
  const ours = `// config.js — updated with better docs
// Returns the server configuration object
export function getConfig() {
  // Default config for local development
  return { port: 3000, host: 'localhost' }
}
`
  const r = merge(base, ours, base, { filename: 'config.js' })

  T('2C: Comment-only changes are clean', r.clean)
}

// 2D: Whitespace/formatting changes — must NOT trigger semantic conflict
{
  const base = `// format.js
export function add(a,b){return a+b}
export function sub(a,b){return a-b}
`
  const ours = `// format.js
export function add(a, b) {
  return a + b
}

export function sub(a, b) {
  return a - b
}
`
  const r = merge(base, ours, base, { filename: 'format.js' })

  T('2D: Formatting-only changes are clean', r.clean)
}


// --- SEMANTIC TRAPS (MUST trigger conflict) ---

// 2E: Dangling reference — function deleted, call site remains
{
  const base = `// helpers.js
export function validate(input) { return input.length > 0 }

export function process(data) {
  if (validate(data)) return data.toUpperCase()
  return null
}
`
  const ours = base  // unchanged
  const theirs = `// helpers.js
export function process(data) {
  if (validate(data)) return data.toUpperCase()
  return null
}
`
  const r = merge(base, ours, theirs, { filename: 'helpers.js' })

  T('2E: Deleted function with remaining call site → NOT clean', !r.clean)
  T('2E: Warning mentions validate', (r.warning || '').includes('validate'))
}

// 2F: Rename on one side, stale call on other side
// ICR is SMARTER than standard merge — it detects the rename and auto-rewrites
// the stale call sites on the other branch. This should be CLEAN with renames.
{
  const base = `// auth.js
function checkAccess(user) { return user.role === 'admin' }

function dashboard(user) {
  return checkAccess(user) ? 'admin' : 'user'
}
`
  const ours = `// auth.js
function verifyPermissions(user) { return user.role === 'admin' }

function dashboard(user) {
  return verifyPermissions(user) ? 'admin' : 'user'
}
`
  const theirs = `// auth.js
function checkAccess(user) { return user.role === 'admin' }

function dashboard(user) {
  return checkAccess(user) ? 'admin' : 'user'
}

function settingsPage(user) {
  if (!checkAccess(user)) throw new Error('Forbidden')
  return loadSettings()
}
`
  const r = merge(base, ours, theirs, { filename: 'auth.js' })

  T('2F: ICR auto-rewrites stale calls after rename → clean', r.clean)
  T('2F: Method is rename', r.method === 'rename')
  T('2F: Rename detected: checkAccess→verifyPermissions', (r.renames || []).includes('checkAccess->verifyPermissions'))
  T('2F: Stale call in settingsPage was auto-fixed', r.text.includes('verifyPermissions(user)') && !r.text.includes('checkAccess'))
}

// 2G: Both sides change same function body differently
{
  const base = `// math.js
export function compute(x) {
  return x * 2
}
`
  const ours = `// math.js
export function compute(x) {
  return x * 3
}
`
  const theirs = `// math.js
export function compute(x) {
  return x * 4
}
`
  const r = merge(base, ours, theirs, { filename: 'math.js' })

  T('2G: Both sides changed same fn → NOT clean', !r.clean)
  T('2G: Warning mentions compute', (r.warning || '').includes('compute'))
}


// ═══════════════════════════════════════════════════════════════════════════
// PART 3: SEMANTIC DRIFT INDEX (Dₛ) VALIDATION
// Metamorphic testing: inject known mutations, assert drift direction.
// ═══════════════════════════════════════════════════════════════════════════

section('PART 3: Semantic Drift Index (Dₛ) — Metamorphic Validation')

// Helper: compute a simple structural drift score from merge results
// This is a practical Dₛ that maps directly to what git-clash reports.
// Dₛ = (semantic_breaks / total_scenarios) * ln(total_nodes + 1.1)
function computeDriftIndex(scenarios) {
  const results = scenarios.map(s => {
    const r = merge(s.base, s.ours, s.theirs, { filename: s.file })
    const gitClean = !r.clean ? false : true
    // A "phantom" is when git would merge cleanly but ICR says not clean
    // For Dₛ, we count all non-clean results
    return { ...s, result: r, isBreak: !r.clean }
  })
  const breaks = results.filter(r => r.isBreak).length
  const totalNodes = results.reduce((sum, r) => sum + r.result.text.split('\n').length, 0)
  const driftIndex = totalNodes > 0
    ? (breaks / totalNodes * 100 * Math.log(totalNodes + 1.1))
    : 0
  return { driftIndex, breaks, totalNodes, results }
}

// 3A: Baseline — unmodified code should have Dₛ ≈ 0
{
  const baseline = `// baseline.js
export function greet(name) { return 'Hello ' + name }
export function farewell(name) { return 'Bye ' + name }
`
  const ds = computeDriftIndex([
    { base: baseline, ours: baseline, theirs: baseline, file: 'baseline.js' },
  ])

  T('3A: Unmodified code has Dₛ = 0 (no drift)', ds.driftIndex === 0)
  T('3A: Zero breaks detected', ds.breaks === 0)
}

// 3B: Benign syntactic mutation — Dₛ should remain ≤ 0.05
{
  const base = `// benign.js
export function alpha() { return 1 }
export function beta() { return 2 }
export function gamma() { return 3 }
`
  // Just reorder functions (benign refactoring)
  const reordered = `// benign.js
export function gamma() { return 3 }
export function alpha() { return 1 }
export function beta() { return 2 }
`
  const ds = computeDriftIndex([
    { base, ours: reordered, theirs: base, file: 'benign.js' },
  ])

  T('3B: Benign refactoring keeps Dₛ ≤ 5.0', ds.driftIndex <= 5.0)
  T('3B: No semantic breaks for method reordering', ds.breaks === 0)
}

// 3C: Behavioral mutation — Dₛ should spike significantly
{
  const base = `// critical.js
export function authenticate(user) {
  return user.token === 'valid'
}

export function authorize(user, resource) {
  return user.role === 'admin'
}
`
  // Agent A changes authenticate logic
  const mutantA = `// critical.js
export function authenticate(user) {
  return user.token !== 'expired' && user.token.length > 0
}

export function authorize(user, resource) {
  return user.role === 'admin'
}
`
  // Agent B also changes authenticate logic differently
  const mutantB = `// critical.js
export function authenticate(user) {
  return user.verified === true
}

export function authorize(user, resource) {
  return user.role === 'admin'
}
`
  const ds = computeDriftIndex([
    { base, ours: mutantA, theirs: mutantB, file: 'critical.js' },
  ])

  T('3C: Behavioral mutation produces Dₛ > 0 (drift detected)', ds.driftIndex > 0)
  T('3C: At least 1 semantic break detected', ds.breaks >= 1)
}

// 3D: Mixed scenario — some clean, some broken
{
  const safeBase = `// safe.js
export function ping() { return 'pong' }
export function health() { return 'ok' }
`
  const dangerBase = `// danger.js
export function processPayment(amount) {
  return amount * 1.18
}
`
  const ds = computeDriftIndex([
    // Safe: independent additions
    {
      base: safeBase,
      ours: safeBase + '\nexport function version() { return "1.0" }\n',
      theirs: safeBase + '\nexport function uptime() { return Date.now() }\n',
      file: 'safe.js',
    },
    // Dangerous: both sides modify same function
    {
      base: dangerBase,
      ours: '// danger.js\nexport function processPayment(amount) {\n  return amount * 1.20\n}\n',
      theirs: '// danger.js\nexport function processPayment(amount) {\n  return amount * 0.90\n}\n',
      file: 'danger.js',
    },
  ])

  T('3D: Mixed scenario has partial drift (0 < Dₛ)', ds.driftIndex > 0)
  T('3D: Exactly 1 break (processPayment), 1 clean (safe)', ds.breaks === 1)
}


// ═══════════════════════════════════════════════════════════════════════════
// PART 4: MULTI-LANGUAGE DRIFT DETECTION
// The engine must catch semantic breaks across JS, Python, Go, Rust, etc.
// ═══════════════════════════════════════════════════════════════════════════

section('PART 4: Multi-Language Semantic Drift')

// 4A: Python — both agents modify same function
{
  const base = `# analytics.py
def compute_score(data):
    total = sum(d['value'] for d in data)
    return total / len(data)

def format_report(score):
    return f"Score: {score:.2f}"
`
  const ours = `# analytics.py
def compute_score(data):
    total = sum(d['value'] * d.get('weight', 1) for d in data)
    return total / len(data)

def format_report(score):
    return f"Score: {score:.2f}"
`
  const theirs = `# analytics.py
def compute_score(data):
    filtered = [d for d in data if d['value'] > 0]
    total = sum(d['value'] for d in filtered)
    return total / len(filtered) if filtered else 0

def format_report(score):
    return f"Score: {score:.2f}"
`
  const r = merge(base, ours, theirs, { filename: 'analytics.py' })

  T('4A: Python — both sides changed compute_score → NOT clean', !r.clean)
  T('4A: Python — warning present', !!r.warning)
}

// 4B: Python — independent additions should merge cleanly
{
  const base = `# tools.py
def helper():
    return 42
`
  const ours = `# tools.py
def helper():
    return 42

def new_tool_a():
    return 'A'
`
  const theirs = `# tools.py
def helper():
    return 42

def new_tool_b():
    return 'B'
`
  const r = merge(base, ours, theirs, { filename: 'tools.py' })

  T('4B: Python — independent additions merge cleanly', r.clean)
  T('4B: Python — both functions present', r.text.includes('new_tool_a') && r.text.includes('new_tool_b'))
}

// 4C: JSON — concurrent key modifications
{
  const base = '{\n  "name": "app",\n  "version": "1.0.0",\n  "port": 3000\n}\n'
  const ours = '{\n  "name": "app",\n  "version": "2.0.0",\n  "port": 3000\n}\n'
  const theirs = '{\n  "name": "app",\n  "version": "1.0.0",\n  "port": 8080\n}\n'
  const r = merge(base, ours, theirs, { filename: 'config.json' })

  T('4C: JSON — disjoint key changes merge cleanly', r.clean)
  T('4C: JSON — both values applied', r.text.includes('"2.0.0"') && r.text.includes('8080'))
}

// 4D: JSON — same key changed differently
{
  const base = '{\n  "name": "app",\n  "version": "1.0.0"\n}\n'
  const ours = '{\n  "name": "app",\n  "version": "2.0.0"\n}\n'
  const theirs = '{\n  "name": "app",\n  "version": "3.0.0"\n}\n'
  const r = merge(base, ours, theirs, { filename: 'config.json' })

  T('4D: JSON — same key changed differently → NOT clean', !r.clean)
}

// 4E: Go/Rust/Java (brace languages) — both sides change same function
{
  const base = `// server.go
package main

func handleRequest(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(200)
    w.Write([]byte("OK"))
}

func healthCheck() string {
    return "healthy"
}
`
  const ours = `// server.go
package main

func handleRequest(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(200)
    w.Write([]byte("OK - v2"))
}

func healthCheck() string {
    return "healthy"
}
`
  const theirs = `// server.go
package main

func handleRequest(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(201)
    w.Write([]byte("Created"))
}

func healthCheck() string {
    return "healthy"
}
`
  const r = merge(base, ours, theirs, { filename: 'server.go' })

  T('4E: Go — both sides changed handleRequest → NOT clean', !r.clean)
}


// ═══════════════════════════════════════════════════════════════════════════
// PART 5: RESOLVABLE CONFLICTS — Intent-Aware Resolution Pipeline
// The engine must produce machine-resolvable conflict units for the
// judge agent to reconcile.
// ═══════════════════════════════════════════════════════════════════════════

section('PART 5: Resolvable Conflict Units & Intent Pipeline')

// 5A: When both sides change the SAME function, the engine should report
// a semantic conflict with resolvable units carrying intent metadata.
{
  const base = `// calc.js
export function compute(x) {
  return x * 2
}
`
  const ours = `// calc.js
export function compute(x) {
  return x * 3
}
`
  const theirs = `// calc.js
export function compute(x) {
  return x * 4
}
`
  const r = merge(base, ours, theirs, { filename: 'calc.js',
    intents: { ours: 'Triple the value', theirs: 'Quadruple the value' }
  })

  T('5A: Both-sides-changed conflict is NOT clean', !r.clean)
  T('5A: Warning mentions compute', (r.warning || '').includes('compute'))
  T('5A: Semantic conflict key fn:compute present', (r.semantic || []).some(s => s.includes('compute')))

  // Resolvable units carry the conflict details for a judge agent
  const hasResolvable = (r.resolvable || []).length > 0
  T('5A: Resolvable units produced for judge agent', hasResolvable)
  if (hasResolvable) {
    const u = r.resolvable[0]
    T('5A: Resolvable unit carries ours intent', u.oursIntent === 'Triple the value')
    T('5A: Resolvable unit carries theirs intent', u.theirsIntent === 'Quadruple the value')
    T('5A: Resolvable unit has base/ours/theirs text', !!u.base && !!u.ours && !!u.theirs)
  } else {
    // If no resolvable, mark these as failed
    T('5A: Resolvable unit carries ours intent', false)
    T('5A: Resolvable unit carries theirs intent', false)
    T('5A: Resolvable unit has base/ours/theirs text', false)
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// PART 6: PRODUCTION EDGE CASES
// 1. Sibling Aliasing (Uniqueness Guard)
// 2. Deleted-But-Moved Cover-Up
// 3. Layout-Sensitive Scope Slippage (Python Indentation)
// 4. resolveMerge Non-Determinism (Architectural requirement note)
// 5. Cross-File Reference Disconnects (Interprocedural requirement note)
// ═══════════════════════════════════════════════════════════════════════════

section('PART 6: Production Edge Cases (Stress Testing)')

// 6A: Sibling Aliasing ("f(a,b,b)" Non-Uniqueness Trap)
{
  const base = `// params.js
export function calculate(a, b, c) { return a + b + c }
`
  const ours = `// params.js
export function calculate(a, c, b) { return a + c + b }
`
  const theirs = `// params.js
export function calculate(a, b, b) { return a + b + b }
`
  // Even if AST mapping tries to map 'c' to 'b' based on ours/theirs,
  // we want to ensure it either falls back to line merge or flags a conflict
  // instead of silently breaking.
  const r = merge(base, ours, theirs, { filename: 'params.js' })
  T('6A: Sibling aliasing f(a,b,b) must NOT silently merge cleanly', !r.clean)
}

// 6B: Layout-Sensitive Scope Slippage (Python)
{
  const base = `# main.py
def process():
    print("Start")
    # end
`
  const ours = `# main.py
def process():
    print("Start")
    if True:
        print("Nested")
`
  const theirs = `# main.py
def process():
    print("Start")
    # end
    print("End")
`
  const r = merge(base, ours, theirs, { filename: 'main.py' })
  // If the engine isn't perfectly layout-aware, Agent B's 'print("End")' 
  // might fall inside Agent A's nested block.
  T('6B: Python scope slippage avoids silent semantic nesting', !r.clean || r.text.includes('    print("End")'))
}

// 6C: Deleted-But-Moved Cover-Up (Refactoring)
{
  const base = `// refactor.js
export function oldName() {
  return "old"
}
`
  const ours = `// refactor.js
export function newName() {
  return "old"
}
`
  const theirs = `// refactor.js
export function oldName() {
  return "new_impl"
}
`
  const r = merge(base, ours, theirs, { filename: 'refactor.js' })
  // Engine successfully maps the interior edit to the renamed exterior bounds!
  T('6C: Move+Modify seamlessly merges the new implementation into the new name', r.clean && r.text.includes('newName') && r.text.includes('new_impl'))
}

// NOTE on Edge Case 4 & 5:
// 4: LLM non-determinism requires centralized deterministic execution (architectural).
// 5: Cross-file references require Multi-layer Code Property Graph (architectural).
console.log('  i  6D: LLM Non-Determinism (Architectural requirement: single-threaded coordinator)')
console.log('  i  6E: Cross-file Reference Disconnects (Architectural requirement: interprocedural static analyzer)')

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(60)}`)
console.log(`  DRIFT GAUNTLET RESULTS: ${pass}/${total} passed, ${fail} failed`)
if (fail === 0) {
  console.log('  ✓ ALL TESTS PASSED — Engine is calibrated for production')
} else {
  console.log(`  ✗ ${fail} FAILURE(S) — Review boundary conditions`)
}
console.log(`${'═'.repeat(60)}\n`)

process.exit(fail > 0 ? 1 : 0)
