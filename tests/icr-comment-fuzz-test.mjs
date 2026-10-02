// tests/icr-comment-fuzz-test.mjs
// Adversarial fuzz test for top-level comment preservation in ICR merges.
//
// Invariants tested:
//   For any 3-way merge where one or both sides insert top-level comments:
//   Every inserted comment MUST be present in the merged output, OR the merge
//   must report conflict: true.
//   Any result where a comment disappears with conflict: false is a SILENT LOSS.
//
// Checks both argument orders across:
//   - JavaScript (.js)
//   - TypeScript (.ts)
//   - Python (.py)
//   - Ruby (.rb)
//   - Go (.go)
//   - YAML (.yaml)
//
// Usage:
//   node tests/icr-comment-fuzz-test.mjs [numTrials] [seed]

import { icrMerge3 } from '../icr-merge.js'

const NUM_TRIALS = Number(process.argv[2]) || 600
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

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa']
const EXTENSIONS = ['test.js', 'test.ts', 'test.py', 'test.rb', 'test.go', 'test.yaml']

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
  } else if (lang === 'rb') {
    switch (kind) {
      case 'import':
        return `require '${name}'`
      case 'const':
        return `${name.toUpperCase()} = { key: ${randNum} }`
      case 'class':
        return `class ${cap(name)}\n  def calc\n    ${randNum}\n  end\nend`
      case 'fn':
      default:
        return `def ${name}(x)\n  base = ${randNum}\n  base + x\nend`
    }
  } else if (lang === 'go') {
    switch (kind) {
      case 'import':
        return `// import placeholder\nconst ${cap(name)}Tag = "${name}"`
      case 'const':
        return `const ${cap(name)}Val = ${randNum}`
      case 'class':
        return `type ${cap(name)} struct {\n  Val int\n}`
      case 'fn':
      default:
        return `func ${cap(name)}(x int) int {\n  base := ${randNum}\n  return base + x\n}`
    }
  } else if (lang === 'yaml') {
    return `${name}:\n  port: ${randNum}\n  active: true\n  workers: 4`
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
  if (lang === 'py' || lang === 'rb' || lang === 'yaml') {
    if (type === 'trailing') return `  # ${id} trailing`
    return `# ${id} top-level comment`
  }
  // JS / TS / Go
  if (type === 'trailing') return ` // ${id} trailing`
  if (type === 'block') return `/**\n * ${id} block comment\n */`
  return `// ${id} line comment`
}

function getLang(relPath) {
  if (relPath.endsWith('.py')) return 'py'
  if (relPath.endsWith('.ts')) return 'ts'
  if (relPath.endsWith('.rb')) return 'rb'
  if (relPath.endsWith('.go')) return 'go'
  if (relPath.endsWith('.yaml')) return 'yaml'
  return 'js'
}

function runTrial(trialIndex, trialSeed) {
  const prng = makePrng(trialSeed)
  const relPath = EXTENSIONS[Math.floor(prng() * EXTENSIONS.length)]
  const lang = getLang(relPath)

  // Build base file of 4-8 top-level declarations
  const numDecls = 4 + Math.floor(prng() * 5)
  const availableNames = [...NAMES]
  const decls = []

  // In Go, include package declaration as first item
  if (lang === 'go') {
    decls.push({ name: 'package', kind: 'pkg', code: 'package main' })
  }

  for (let i = 0; i < numDecls; i++) {
    const nameIdx = Math.floor(prng() * availableNames.length)
    const name = availableNames.splice(nameIdx, 1)[0] || `item_${i}`
    const kinds = lang === 'yaml' ? ['yaml'] : ['import', 'const', 'fn', 'class']
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
    const loc = Math.floor(prng() * (decls.length + 1))
    const isTrailing = prng() < 0.25 && decls.length > 0
    const commentType = isTrailing ? 'trailing' : (['js', 'ts', 'go'].includes(lang) && prng() < 0.33 ? 'block' : 'line')
    aComments.push({ id: commentId, loc, isTrailing, type: commentType, side: 'A' })
  }

  // Side B comments (in Mode 2)
  const bComments = []
  if (mode === 2) {
    const numBComments = 1 + Math.floor(prng() * 2)
    for (let c = 0; c < numBComments; c++) {
      const commentId = `COMM_B_${trialIndex}_${c}`
      let loc
      if (prng() < 0.5 && aComments.length > 0) {
        loc = aComments[Math.floor(prng() * aComments.length)].loc
      } else {
        loc = Math.floor(prng() * (decls.length + 1))
      }
      const isTrailing = prng() < 0.25 && decls.length > 0
      const commentType = isTrailing ? 'trailing' : (['js', 'ts', 'go'].includes(lang) && prng() < 0.33 ? 'block' : 'line')
      bComments.push({ id: commentId, loc, isTrailing, type: commentType, side: 'B' })
    }
  }

  // Construct Side A text
  let aDecls = decls.map((d) => ({ ...d }))
  for (const c of aComments.filter((x) => x.isTrailing)) {
    const targetIdx = Math.min(c.loc, aDecls.length - 1)
    if (targetIdx >= 0) {
      const lines = aDecls[targetIdx].code.split('\n')
      lines[0] += makeComment(c.id, 'trailing', lang)
      aDecls[targetIdx].code = lines.join('\n')
    }
  }
  const aGapComments = Array.from({ length: aDecls.length + 1 }, () => [])
  for (const c of aComments.filter((x) => !x.isTrailing)) {
    const loc = Math.min(c.loc, aDecls.length)
    aGapComments[loc].push(makeComment(c.id, c.type, lang))
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

  // Offset index for Go to keep `package main` untouched
  const startIdx = lang === 'go' ? 1 : 0

  if (bChangeType === 'edit_body' && bDecls.length > startIdx) {
    const targetIdx = startIdx + Math.floor(prng() * (bDecls.length - startIdx))
    const target = bDecls[targetIdx]
    if (target) {
      target.code = target.code.replace(/\d+/, (m) => String(Number(m) + 999))
    }
  } else if (bChangeType === 'add_decl') {
    const newName = `extra_${trialIndex}`
    const newCode = genDecl(newName, lang === 'yaml' ? 'yaml' : 'fn', lang, prng)
    bDecls.splice(startIdx + Math.floor(prng() * (bDecls.length - startIdx + 1)), 0, { name: newName, kind: 'fn', code: newCode })
  } else if (bChangeType === 'delete_decl' && bDecls.length > (startIdx + 1)) {
    const delIdx = startIdx + Math.floor(prng() * (bDecls.length - startIdx))
    bDecls.splice(delIdx, 1)
  } else if (bChangeType === 'rename' && bDecls.length > startIdx) {
    const targetIdx = startIdx + Math.floor(prng() * (bDecls.length - startIdx))
    const target = bDecls[targetIdx]
    if (target && target.name !== 'package') {
      const newName = `${target.name}_renamed`
      target.code = target.code.replace(new RegExp(`\\b${target.name}\\b`, 'g'), newName)
      target.name = newName
    }
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
console.log(`=== ICR Multi-Language Comment Fuzz Test ===`)
console.log(`Running ${NUM_TRIALS} seeded trials across JS, TS, Python, Ruby, Go, and YAML... (Root seed: ${ROOT_SEED})\n`)

let totalFailures = 0
const failedTrials = []
const languageStats = {
  js: { trials: 0, failed: 0 },
  ts: { trials: 0, failed: 0 },
  py: { trials: 0, failed: 0 },
  rb: { trials: 0, failed: 0 },
  go: { trials: 0, failed: 0 },
  yaml: { trials: 0, failed: 0 },
}

for (let i = 0; i < NUM_TRIALS; i++) {
  const trialSeed = (Math.imul(ROOT_SEED, 10007) + i * 1013 + 17) >>> 0
  const result = runTrial(i, trialSeed)

  const lang = getLang(result.relPath)
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
console.log(`\nBy Language:`)
for (const [lang, stats] of Object.entries(languageStats)) {
  const pct = stats.trials ? ((stats.failed / stats.trials) * 100).toFixed(1) : '0'
  console.log(`  ${lang.padEnd(6)}: ${String(stats.failed).padStart(3)} / ${String(stats.trials).padStart(3)} failed (${pct}%)`)
}

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
