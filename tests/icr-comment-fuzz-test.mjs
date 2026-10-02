// tests/icr-comment-fuzz-test.mjs
// Adversarial fuzz test for top-level comment preservation in ICR merges.
//
// Invariants tested:
//   For any 3-way merge where one or both sides insert top-level comments:
//   Every inserted comment MUST be present in the merged output, OR the merge
//   must report conflict: true.
//   Any result where a comment disappears with conflict: false is a SILENT LOSS.
//
// Checks both argument orders (mine=A,theirs=B and mine=B,theirs=A) across
// JS (.js), TS (.ts), and Python (.py).
//
// Usage:
//   node tests/icr-comment-fuzz-test.mjs [numTrials] [seed]

import { icrMerge3 } from '../icr-merge.js'

const NUM_TRIALS = Number(process.argv[2]) || 350
const ROOT_SEED = Number(process.argv[3]) || 1337

// Mulberry32 seeded PRNG
function makePrng(seed) {
  let s = seed >>> 0
  return function () {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rootPrng = makePrng(ROOT_SEED)

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa']
const EXTENSIONS = ['test.js', 'test.ts', 'test.py']

function cap(s) {
  return s[0].toUpperCase() + s.slice(1)
}

function genDecl(name, kind, lang, prng) {
  const randNum = Math.floor(prng() * 900) + 100
  if (lang === 'py') {
    switch (kind) {
      case 'import':
        return `import ${name}`
      case 'const':
        return `${name} = {"key": ${randNum}, "flag": True}`
      case 'class':
        return `class ${cap(name)}:\n    def __init__(self):\n        self.val = ${randNum}\n    def run(self):\n        return self.val * 2`
      case 'fn':
      default:
        return `def ${name}(x):\n    base = ${randNum}\n    return base + x`
    }
  } else {
    // JS or TS
    const isTs = lang === 'ts'
    switch (kind) {
      case 'import':
        return isTs
          ? `import type { ${cap(name)} } from './${name}'`
          : `import { ${name} } from './${name}'`
      case 'const':
        return isTs
          ? `const ${name}: Record<string, number> = { score: ${randNum}, rank: 1 }`
          : `const ${name} = { score: ${randNum}, rank: 1 }`
      case 'class':
        return isTs
          ? `class ${cap(name)} {\n  private val: number = ${randNum}\n  public calc(): number {\n    return this.val * 2\n  }\n}`
          : `class ${cap(name)} {\n  constructor() {\n    this.val = ${randNum}\n  }\n  calc() {\n    return this.val * 2\n  }\n}`
      case 'fn':
      default:
        return isTs
          ? `function ${name}(x: number): number {\n  const base: number = ${randNum}\n  return base + x\n}`
          : `function ${name}(x) {\n  const base = ${randNum}\n  return base + x\n}`
    }
  }
}

function makeComment(id, type, lang) {
  if (lang === 'py') {
    if (type === 'trailing') return `  # ${id} trailing`
    return `# ${id} top-level comment`
  }
  // JS / TS
  if (type === 'trailing') return ` // ${id} trailing`
  if (type === 'block') return `/**\n * ${id} block comment\n */`
  return `// ${id} line comment`
}

function runTrial(trialIndex, trialSeed) {
  const prng = makePrng(trialSeed)
  const relPath = EXTENSIONS[Math.floor(prng() * EXTENSIONS.length)]
  const lang = relPath.endsWith('.py') ? 'py' : relPath.endsWith('.ts') ? 'ts' : 'js'

  // Build base file of 4-8 top-level declarations
  const numDecls = 4 + Math.floor(prng() * 5)
  const availableNames = [...NAMES]
  const decls = []

  for (let i = 0; i < numDecls; i++) {
    const nameIdx = Math.floor(prng() * availableNames.length)
    const name = availableNames.splice(nameIdx, 1)[0] || `item_${i}`
    const kinds = ['import', 'const', 'fn', 'class']
    const kind = kinds[Math.floor(prng() * kinds.length)]
    decls.push({ name, kind, code: genDecl(name, kind, lang, prng) })
  }

  const baseText = decls.map((d) => d.code).join('\n\n') + '\n'

  // Two modes:
  // Mode 1: Side A adds comments, Side B makes code change elsewhere
  // Mode 2: BOTH sides add comments (sometimes in the same gap), Side B also makes code change
  const mode = prng() < 0.5 ? 1 : 2

  // Side A: Insert 1-3 comments
  const aComments = []
  const numAComments = 1 + Math.floor(prng() * 3)
  for (let c = 0; c < numAComments; c++) {
    const commentId = `COMM_A_${trialIndex}_${c}`
    // Location: gap 0..numDecls (0=start, numDecls=EOF) or trailing on decl
    const loc = Math.floor(prng() * (numDecls + 1))
    const isTrailing = prng() < 0.25 && numDecls > 0
    const commentType = isTrailing ? 'trailing' : (lang !== 'py' && prng() < 0.33 ? 'block' : 'line')
    aComments.push({ id: commentId, loc, isTrailing, type: commentType, side: 'A' })
  }

  // Side B comments (in Mode 2)
  const bComments = []
  if (mode === 2) {
    const numBComments = 1 + Math.floor(prng() * 2)
    for (let c = 0; c < numBComments; c++) {
      const commentId = `COMM_B_${trialIndex}_${c}`
      // 50% chance to pick the same gap as an A comment
      let loc
      if (prng() < 0.5 && aComments.length > 0) {
        loc = aComments[Math.floor(prng() * aComments.length)].loc
      } else {
        loc = Math.floor(prng() * (numDecls + 1))
      }
      const isTrailing = prng() < 0.25 && numDecls > 0
      const commentType = isTrailing ? 'trailing' : (lang !== 'py' && prng() < 0.33 ? 'block' : 'line')
      bComments.push({ id: commentId, loc, isTrailing, type: commentType, side: 'B' })
    }
  }

  // Construct Side A text
  let aDecls = decls.map((d) => ({ ...d }))
  // Apply trailing comments
  for (const c of aComments.filter((x) => x.isTrailing)) {
    const targetIdx = Math.min(c.loc, aDecls.length - 1)
    if (targetIdx >= 0) {
      const lines = aDecls[targetIdx].code.split('\n')
      lines[0] += makeComment(c.id, 'trailing', lang)
      aDecls[targetIdx].code = lines.join('\n')
    }
  }
  // Assemble with gaps
  const aGapComments = Array.from({ length: aDecls.length + 1 }, () => [])
  for (const c of aComments.filter((x) => !x.isTrailing)) {
    aGapComments[c.loc].push(makeComment(c.id, c.type, lang))
  }

  let aText = ''
  for (let i = 0; i <= aDecls.length; i++) {
    if (aGapComments[i].length) {
      aText += aGapComments[i].join('\n') + '\n\n'
    }
    if (i < aDecls.length) {
      aText += aDecls[i].code + '\n\n'
    }
  }
  aText = aText.trimEnd() + '\n'

  // Side B Code Change: edit body, add declaration, delete declaration, or rename
  let bDecls = decls.map((d) => ({ ...d }))
  const bChangeType = ['edit_body', 'add_decl', 'delete_decl', 'rename'][Math.floor(prng() * 4)]

  if (bChangeType === 'edit_body' && bDecls.length > 0) {
    const target = bDecls[Math.floor(prng() * bDecls.length)]
    target.code = target.code.replace(/\d+/, (m) => String(Number(m) + 999))
  } else if (bChangeType === 'add_decl') {
    const newName = `extra_${trialIndex}`
    const newCode = genDecl(newName, 'fn', lang, prng)
    bDecls.splice(Math.floor(prng() * (bDecls.length + 1)), 0, { name: newName, kind: 'fn', code: newCode })
  } else if (bChangeType === 'delete_decl' && bDecls.length > 1) {
    bDecls.splice(Math.floor(prng() * bDecls.length), 1)
  } else if (bChangeType === 'rename' && bDecls.length > 0) {
    const target = bDecls[Math.floor(prng() * bDecls.length)]
    const newName = `${target.name}_renamed`
    target.code = target.code.replace(new RegExp(`\\b${target.name}\\b`, 'g'), newName)
    target.name = newName
  }

  // Apply B comments if Mode 2
  for (const c of bComments.filter((x) => x.isTrailing)) {
    const targetIdx = Math.min(c.loc, bDecls.length - 1)
    if (targetIdx >= 0) {
      const lines = bDecls[targetIdx].code.split('\n')
      lines[0] += makeComment(c.id, 'trailing', lang)
      bDecls[targetIdx].code = lines.join('\n')
    }
  }
  const bGapComments = Array.from({ length: bDecls.length + 1 }, () => [])
  for (const c of bComments.filter((x) => !x.isTrailing)) {
    const loc = Math.min(c.loc, bDecls.length)
    bGapComments[loc].push(makeComment(c.id, c.type, lang))
  }

  let bText = ''
  for (let i = 0; i <= bDecls.length; i++) {
    if (bGapComments[i].length) {
      bText += bGapComments[i].join('\n') + '\n\n'
    }
    if (i < bDecls.length) {
      bText += bDecls[i].code + '\n\n'
    }
  }
  bText = bText.trimEnd() + '\n'

  const allComments = [...aComments, ...bComments]

  // Test both argument orders: (base, A, B) and (base, B, A)
  const orders = [
    { name: 'A-then-B', mine: aText, theirs: bText },
    { name: 'B-then-A', mine: bText, theirs: aText },
  ]

  const failures = []

  for (const ord of orders) {
    let res
    try {
      res = icrMerge3(baseText, ord.mine, ord.theirs, relPath)
    } catch (err) {
      failures.push({
        order: ord.name,
        error: `Exception: ${err.message}`,
        relPath,
        trialSeed,
      })
      continue
    }

    // PASS criterion:
    // If conflict: true (or conflict markers present), this is NOT a silent loss.
    // If conflict: false, EVERY inserted comment ID must appear in res.text.
    const isConflict = res.conflict === true || (res.text && res.text.includes('<<<<<<<'))
    if (!isConflict) {
      const missing = allComments.filter((c) => !res.text || !res.text.includes(c.id))
      if (missing.length > 0) {
        failures.push({
          order: ord.name,
          relPath,
          mode,
          change: bChangeType,
          missing: missing.map((m) => `${m.id} (${m.type} @ gap ${m.loc})`),
          icr: res.icr,
          status: res.conflict ? 'conflict' : 'auto/no-conflict',
          trialSeed,
        })
      }
    }
  }

  return {
    trialIndex,
    trialSeed,
    relPath,
    mode,
    change: bChangeType,
    passed: failures.length === 0,
    failures,
  }
}

// Main Runner
console.log(`=== ICR Top-Level Comment Fuzz Test ===`)
console.log(`Running ${NUM_TRIALS} seeded trials across JS, TS, and Python... (Root seed: ${ROOT_SEED})\n`)

let totalFailures = 0
const failedTrials = []
const languageStats = { js: { trials: 0, failed: 0 }, ts: { trials: 0, failed: 0 }, py: { trials: 0, failed: 0 } }

for (let i = 0; i < NUM_TRIALS; i++) {
  const trialSeed = (Math.imul(ROOT_SEED, 10007) + i * 1013 + 17) >>> 0
  const result = runTrial(i, trialSeed)

  const lang = result.relPath.endsWith('.py') ? 'py' : result.relPath.endsWith('.ts') ? 'ts' : 'js'
  languageStats[lang].trials++

  if (!result.passed) {
    totalFailures++
    languageStats[lang].failed++
    failedTrials.push(result)
  }
}

console.log(`--- Summary of Results ---`)
console.log(`Total Trials : ${NUM_TRIALS}`)
console.log(`Failed Trials: ${totalFailures} (silent comment losses on clean merges)`)
console.log(`Passed Trials: ${NUM_TRIALS - totalFailures}`)
console.log(`By Language:`)
console.log(`  JS : ${languageStats.js.failed}/${languageStats.js.trials} failed`)
console.log(`  TS : ${languageStats.ts.failed}/${languageStats.ts.trials} failed`)
console.log(`  Python: ${languageStats.py.failed}/${languageStats.py.trials} failed`)

if (failedTrials.length > 0) {
  console.log(`\n--- Sample Failures (First 5) ---`)
  for (const f of failedTrials.slice(0, 5)) {
    console.log(`Trial #${f.trialIndex} (Seed: ${f.trialSeed}) [${f.relPath}] [Mode ${f.mode}] Change: ${f.change}`)
    for (const fail of f.failures) {
      console.log(`  Order: ${fail.order} -> Missing: ${fail.missing.join(', ')} (Status: ${fail.status}, ICR: ${fail.icr})`)
    }
  }
  console.log(`\nSample failure seeds: ${failedTrials.slice(0, 8).map((f) => f.trialSeed).join(', ')}`)
}

console.log(`\n=== ${totalFailures === 0 ? 'ALL INVARIANTS HELD' : `${totalFailures} FAILURES DETECTED (EXPECTED ON 3fec72f)`} ===`)
process.exit(totalFailures === 0 ? 0 : 1)
