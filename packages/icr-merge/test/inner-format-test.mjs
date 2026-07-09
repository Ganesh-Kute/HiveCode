// Regression: the inner merge (both sides edit DIFFERENT parts of one declaration) must
// PRESERVE gap content — comments, blank lines, indentation — not reflow it. Join-based
// reassembly dropped inner comments and glued C-family members to the class brace; the
// splice-based inner assembly keeps the base body's formatting verbatim.
import { structuralMerge } from '../icr.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

// JS function: internal comments survive when both sides edit different statements
{
  const base = 'function build(cfg) {\n  // validate the incoming config first\n  const a = cfg.a\n  // then derive the secondary value\n  const b = cfg.b\n  return a + b\n}\n'
  const a = base.replace('cfg.a', 'cfg.alpha')
  const b = base.replace('cfg.b', 'cfg.beta')
  const r = structuralMerge(base, a, b, { filename: 'x.js' })
  T('js fn: auto + both edits', r.status === 'auto' && r.text.includes('cfg.alpha') && r.text.includes('cfg.beta'))
  T('js fn: BOTH inner comments survive', r.status === 'auto' && r.text.includes('// validate the incoming config first') && r.text.includes('// then derive the secondary value'))
  T('js fn: indentation preserved (2-space)', r.status === 'auto' && /\n  const a = cfg\.alpha/.test(r.text))
}

// JS class: comment above a method survives when both sides edit different methods
{
  const base = 'class Svc {\n  // starts the service\n  start() { return 1 }\n\n  // stops it\n  stop() { return 2 }\n}\n'
  const a = base.replace('return 1', 'return 100')
  const b = base.replace('return 2', 'return 200')
  const r = structuralMerge(base, a, b, { filename: 'x.js' })
  T('js class: auto + both edits', r.status === 'auto' && r.text.includes('return 100') && r.text.includes('return 200'))
  T('js class: method comments survive', r.status === 'auto' && r.text.includes('// starts the service') && r.text.includes('// stops it'))
}

// Java class: no brace-glue, indentation intact
{
  const base = 'class App {\n  int alpha() { return 1; }\n  int beta() { return 2; }\n}\n'
  const a = base.replace('return 1;', 'return 111;')
  const b = base.replace('return 2;', 'return 222;')
  const r = structuralMerge(base, a, b, { filename: 'App.java' })
  T('java: auto + both edits', r.status === 'auto' && r.text.includes('return 111;') && r.text.includes('return 222;'))
  T('java: first method NOT glued to class brace', r.status === 'auto' && /class App \{\n/.test(r.text) && !/\{int alpha/.test(r.text))
  T('java: members indented', r.status === 'auto' && /\n  int alpha/.test(r.text) && /\n  int beta/.test(r.text))
  T('java: closing brace on its own line', r.status === 'auto' && /\n\}/.test(r.text))
}

// TypeScript class with a JSDoc-style comment between members
{
  const base = 'class Repo {\n  find(id: number): number { return id }\n\n  /** persists the row */\n  save(row: number): void { log(row) }\n}\n'
  const a = base.replace('return id', 'return id * 2')
  const b = base.replace('log(row)', 'log(row, true)')
  const r = structuralMerge(base, a, b, { filename: 'repo.ts' })
  T('ts class: auto + both edits', r.status === 'auto' && r.text.includes('return id * 2') && r.text.includes('log(row, true)'))
  T('ts class: block comment between members survives', r.status === 'auto' && r.text.includes('/** persists the row */'))
}

console.log(`\n=== INNER-FORMAT: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
