// A comment one side adds BETWEEN top-level declarations must survive a structural merge.
//
//   node tests/icr-gap-comments-test.mjs
//
// 2 Oct 2026: both of that night's real merges (claude-0124 x ag1-prod) came back 'structural
// merge', no conflict, with the code identical to git's merge, and with comments gone: 3 lines of
// sync.js, a 14-line block and a trailing comment in hive-mcp.js. The top level spliced the merged
// declarations back into BASE, so every byte between declarations came from base, and a side's
// comment there vanished whenever the other side changed anything else in the file. It was green.
// So every case asserts the comment TEXT is in the result, both ways round, through each copy of
// the engine that ships: the product's (icr-merge.js, what sync.js runs on a rejoin), the published
// package's (what the git merge driver runs), and the extension's build.
import { createRequire } from 'module'
import { icrMerge3 } from '../icr-merge.js'
import { merge as pkgMerge } from '../packages/icr-merge/index.js'

const require = createRequire(import.meta.url)
const ext = require('../extension/icr.cjs')

let pass = 0, fail = 0
const T = (n, c, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${!c && extra ? `   ${extra}` : ''}`); c ? pass++ : fail++ }

// Each engine as (base, mine, theirs, file) -> { text, conflict }. The extension's build exports the
// structural engine alone, so a 'fallback' there counts as "kept both" only if the caller would use
// the line merge -- which is what its reconcile does; a result it would SHIP is status 'auto'.
const ENGINES = {
  product: (b, m, t, f) => icrMerge3(b, m, t, f),
  package: (b, m, t, f) => { const r = pkgMerge(b, m, t, { filename: f }); return { text: r.text, conflict: !r.clean } },
  extension: (b, m, t, f) => {
    const r = ext.structuralMerge(b, m, t, { filename: f })
    return r.status === 'auto' ? { text: r.text, conflict: false } : { text: null, conflict: true, deferred: r.status }
  },
}

// `keep` must all be in the text of any clean result. `clean` = the case must merge without a
// conflict in the product (the line merge alone can do it, so a conflict would be a regression).
function check(title, file, base, mine, theirs, keep, { clean = true } = {}) {
  console.log(`# ${title}`)
  for (const [name, run] of Object.entries(ENGINES)) {
    for (const [order, a, b] of [['mine,theirs', mine, theirs], ['theirs,mine', theirs, mine]]) {
      const r = run(base, a, b, file)
      if (r.deferred) { T(`${name} (${order}): no silent result (defers: ${r.deferred})`, true); continue }
      const lost = r.conflict ? [] : keep.filter((k) => !String(r.text).includes(k))
      T(`${name} (${order}): nothing one side added is lost`, lost.length === 0, `missing ${JSON.stringify(lost)}`)
      if (clean && name !== 'extension') T(`${name} (${order}): ...and it merges without a conflict`, !r.conflict)
    }
  }
}

const JS = `import { x } from './x.js'

function a() {
  return 1
}

function b() {
  return 2
}

function c() {
  return 3
}
`
const theirsJS = JS.replace('return 1', 'return 10')

check('JS: a line comment above a function', 'src/m.js',
  JS, JS.replace('function b', '// why b returns 2\nfunction b'), theirsJS, ['// why b returns 2', 'return 10'])
check('JS: a JSDoc block above a function', 'src/m.js',
  JS, JS.replace('function b', '/**\n * why b returns 2\n */\nfunction b'), theirsJS, ['* why b returns 2', 'return 10'])
check('JS: a trailing comment after a top-level statement', 'src/m.js',
  JS, JS.replace("from './x.js'", "from './x.js' // x is the clock"), theirsJS, ['// x is the clock', 'return 10'])
check('JS: a comment at the end of the file', 'src/m.js',
  JS, JS + '\n// end of the module\n', theirsJS, ['// end of the module', 'return 10'])
check('JS: a comment AND a code change on one side, a code change on the other', 'src/m.js',
  JS, JS.replace('function b', '// why b\nfunction b').replace('return 3', 'return 30'), theirsJS, ['// why b', 'return 30', 'return 10'])
check('JS: a new function with its own leading comment', 'src/m.js',
  JS, JS + '\n// d is new\nfunction d() {\n  return 4\n}\n', theirsJS, ['// d is new', 'function d()', 'return 10'])
check('JS: both sides add comments, in different gaps', 'src/m.js',
  JS, JS.replace('function b', '// mine: why b\nfunction b'), theirsJS.replace('function c', '// theirs: why c\nfunction c'),
  ['// mine: why b', '// theirs: why c', 'return 10'])
check('JS: both sides add different comments in the SAME gap (a conflict is fine; a silent pick is not)', 'src/m.js',
  JS, JS.replace('function b', '// mine: why b\nfunction b'), theirsJS.replace('function b', '// theirs: why b\nfunction b'),
  ['// mine: why b', '// theirs: why b'], { clean: false })
check('JS: CRLF file, comment above a function', 'src/m.js',
  JS.replace(/\n/g, '\r\n'), JS.replace('function b', '// why b (crlf)\nfunction b').replace(/\n/g, '\r\n'), theirsJS.replace(/\n/g, '\r\n'),
  ['// why b (crlf)', 'return 10'])

// The same loss one level down: both sides edit ONE function, so its body is merged statement by
// statement, and that inner splice took its gaps from base unless a side had changed nothing but
// gaps. One side adding a comment AND editing a statement lost the comment.
const FN = 'function f() {\n  const x = 1\n  const y = 2\n  return x + y\n}\n\nfunction g() {\n  return 0\n}\n'
check('JS: both sides edit one function, one side also adds a comment inside it', 'src/m.js',
  FN, FN.replace('  const y = 2', '  // y is the floor\n  const y = 3'), FN.replace('const x = 1', 'const x = 10'),
  ['// y is the floor', 'const y = 3', 'const x = 10'])
check('JS: both sides edit one function and both add comments inside it', 'src/m.js',
  FN, FN.replace('  const y = 2', '  // mine: y\n  const y = 3'), FN.replace('  const x = 1', '  // theirs: x\n  const x = 10'),
  ['// mine: y', '// theirs: x', 'const y = 3', 'const x = 10'])

const TS = `import { x } from './x'

export function a(): number {
  return 1
}

export function b(): number {
  return 2
}
`
check('TS: a line comment above a function', 'src/m.ts',
  TS, TS.replace('export function b', '// why b\nexport function b'), TS.replace('return 1', 'return 10'), ['// why b', 'return 10'])

const PY = 'import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return 2\n'
check('Python (control: already kept): a comment above a def', 'src/m.py',
  PY, PY.replace('def b', '# why b\ndef b'), PY.replace('return 1', 'return 10'), ['# why b', 'return 10'])

// Python keeps a top-level comment that follows a def INSIDE that def's unit (its tail), and the
// merge took a declaration's tail from whichever side was passed first. Found by Antigravity1's
// independent fuzz (tests/icr-comment-fuzz-test.mjs, trial 303) after the cases above passed.
const PYT = 'def eta(x):\n    base = 393\n    return base + x\n\ndelta = {"key": 134}\n\nepsilon = {"key": 760}\n'
check('Python (control: kept before and after): a comment after a def on one side, a code change on the other', 'src/m.py',
  PYT, PYT.replace('\ndelta', '\n# why delta\n\ndelta'), PYT.replace('134', '1133'), ['# why delta', '1133'])
check('Python: both sides add a comment after the same def (a conflict is fine; a silent pick is not)', 'src/m.py',
  PYT, PYT.replace('\ndelta', '\n# mine: why delta\n\ndelta'), PYT.replace('\ndelta', '\n# theirs: why delta\n\ndelta').replace('134', '1133'),
  ['# mine: why delta', '# theirs: why delta', '1133'], { clean: false })

// THE STRUCTURAL WIN MUST SURVIVE THE FIX. A rename on one side, a new caller of the old name on
// the other: the line merge leaves a dangling call, the structural merge rewrites it. With a
// comment added on the renaming side, falling back to the line merge would quietly lose that.
console.log('# the rename fix still applies when the renaming side also added a comment')
{
  const base = 'function login() { return 1 }\n\nfunction page() { return login() }\n'
  const mine = 'function signIn() { return 1 }\n\n// page is the landing view\nfunction page() { return signIn() }\n'
  const theirs = base + '\nfunction checkout() { return login() }\n'
  for (const [order, a, b] of [['mine,theirs', mine, theirs], ['theirs,mine', theirs, mine]]) {
    const r = icrMerge3(base, a, b, 'src/auth.js')
    T(`(${order}) merged as a rename`, r.icr === 'rename', JSON.stringify({ icr: r.icr, conflict: r.conflict }))
    T(`(${order}) the new caller uses the new name`, /checkout\(\) \{ return signIn\(\) \}/.test(r.text || ''))
    T(`(${order}) and the comment is still there`, String(r.text).includes('// page is the landing view'))
  }
}

console.log(`\n=== ICR GAP COMMENTS: ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
