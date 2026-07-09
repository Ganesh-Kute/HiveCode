// Regression: the inner merge (both sides edit DIFFERENT lines of the SAME declaration)
// must preserve the declaration's prefix — `export`, `export default`. Found in the wild:
// ICR merging its own icr.js dropped `export` from structuralMerge, breaking the module.
import { structuralMerge } from '../icr.js'

let pass = 0, fail = 0
const T = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); c ? pass++ : fail++ }

// export function — both sides edit different statements inside it
{
  const base = `export function build(cfg) {
  const a = 1
  const b = 2
  return a + b
}
`
  const a = base.replace('const a = 1', 'const a = 100')
  const b = base.replace('const b = 2', 'const b = 200')
  const r = structuralMerge(base, a, b, { filename: 'x.js' })
  T('export fn: inner merge is auto', r.status === 'auto')
  T('export fn: both edits kept', r.status === 'auto' && r.text.includes('a = 100') && r.text.includes('b = 200'))
  T('export fn: the `export` keyword SURVIVES', r.status === 'auto' && /^export function build/m.test(r.text))
}

// export class — both sides edit different methods
{
  const base = `export class Engine {
  start() { return 1 }
  stop() { return 2 }
}
`
  const a = base.replace('return 1', 'return 100')
  const b = base.replace('return 2', 'return 200')
  const r = structuralMerge(base, a, b, { filename: 'x.js' })
  T('export class: inner merge is auto', r.status === 'auto')
  T('export class: the `export` keyword SURVIVES', r.status === 'auto' && /^export class Engine/m.test(r.text))
}

// export const arrow function — both sides edit different statements in the body
{
  const base = `export const handler = (req) => {
  const user = req.user
  const id = req.id
  return { user, id }
}
`
  const a = base.replace('req.user', 'req.session.user')
  const b = base.replace('req.id', 'req.params.id')
  const r = structuralMerge(base, a, b, { filename: 'x.js' })
  T('export const arrow: inner merge is auto', r.status === 'auto')
  T('export const arrow: both edits kept', r.status === 'auto' && r.text.includes('req.session.user') && r.text.includes('req.params.id'))
  T('export const arrow: the `export` keyword SURVIVES', r.status === 'auto' && /^export const handler/m.test(r.text))
}

// export default function — same deal
{
  const base = `export default function main() {
  const x = 1
  const y = 2
  return x + y
}
`
  const a = base.replace('const x = 1', 'const x = 10')
  const b = base.replace('const y = 2', 'const y = 20')
  const r = structuralMerge(base, a, b, { filename: 'x.js' })
  T('export default fn: inner merge is auto', r.status === 'auto')
  T('export default fn: the `export default` prefix SURVIVES', r.status === 'auto' && /^export default function main/m.test(r.text))
}

console.log(`\n=== EXPORT-PRESERVE: ${fail === 0 ? 'ALL ' + pass + ' PASS' : fail + ' FAILED'} ===`)
process.exit(fail === 0 ? 0 : 1)
