// Proves ICR v1 â€” the foundational claim CRDTs can't make:
//   - two agents editing DIFFERENT functions merge cleanly (structure-aware)
//   - two agents editing the SAME function are flagged as a real semantic conflict,
//     not silently fused into garbage
//   - additions from both sides merge; a one-sided deletion is honored
//   - the merged output is ALWAYS valid code, or it refuses (never emits broken syntax)
//
//   node icr-test.js

import { structuralMerge, parses } from '../icr.js'

let failed = 0
const assert = (n, c) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) failed++ }

const base = `function foo() { return 1 }

function bar() { return 2 }
`

console.log('# Two agents edit DIFFERENT functions â†’ clean structural merge')
{
  const a = `function foo() { return 100 }

function bar() { return 2 }
`
  const b = `function foo() { return 1 }

function bar() { return 200 }
`
  const r = structuralMerge(base, a, b)
  assert('status is auto', r.status === 'auto')
  assert("kept agent A's change to foo", /return 100/.test(r.text || ''))
  assert("kept agent B's change to bar", /return 200/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# Two agents edit the SAME function â†’ semantic conflict (not garbage)')
{
  const a = `function foo() { return 100 }

function bar() { return 2 }
`
  const b = `function foo() { return 999 }

function bar() { return 2 }
`
  const r = structuralMerge(base, a, b)
  assert('status is semantic-conflict', r.status === 'semantic-conflict')
  assert('names the conflicting declaration (fn:foo)', r.conflicts.includes('fn:foo'))
  assert('does NOT silently merge (no text returned)', r.text === null)
}

console.log('\n# Both agents ADD a new function â†’ both kept, still valid')
{
  const a = `function foo() { return 1 }

function bar() { return 2 }

function baz() { return 3 }
`
  const b = `function foo() { return 1 }

function bar() { return 2 }

function qux() { return 4 }
`
  const r = structuralMerge(base, a, b)
  assert('status is auto', r.status === 'auto')
  assert("kept A's new baz", /function baz/.test(r.text || ''))
  assert("kept B's new qux", /function qux/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# One side DELETES a function, other leaves it â†’ deletion honored')
{
  const a = `function foo() { return 1 }
` // bar removed
  const b = base // unchanged
  const r = structuralMerge(base, a, b)
  assert('status is auto', r.status === 'auto')
  assert('foo kept', /function foo/.test(r.text || ''))
  assert('bar removed', !/function bar/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# THE GUARANTEE: an auto merge is ALWAYS valid code')
{
  // a heavier, realistic case: A reworks foo into a multi-statement body while B adds
  // a whole new export. A naive character/line merge could easily corrupt this.
  const a = `function foo() {
  const x = 1
  const y = 2
  return x + y
}

function bar() { return 2 }
`
  const b = `function foo() { return 1 }

function bar() { return 2 }

export const VERSION = '1.0.0'
`
  const r = structuralMerge(base, a, b)
  assert('status is auto', r.status === 'auto')
  assert("kept A's reworked foo body", /const x = 1/.test(r.text || ''))
  assert("kept B's new export", /VERSION/.test(r.text || ''))
  assert('CONTRACT: auto result parses', r.status !== 'auto' || parses(r.text))
}

console.log('\n# INTENT: removing a still-used function is flagged (the merge PARSES but is broken)')
{
  const refBase = `function helper() { return 1 }

function foo() { return helper() + 1 }
`
  const a = `function foo() { return helper() + 1 }
` // deleted helper, but foo still calls it
  const b = refBase // unchanged
  const r = structuralMerge(refBase, a, b)
  assert('caught as semantic-conflict (not auto)', r.status === 'semantic-conflict')
  assert('names the dangling reference (ref:helper)', r.conflicts.includes('ref:helper'))
  // prove the danger ICR just prevented: the naive structural result WOULD have parsed
  assert('the broken merge would have parsed (that is why others miss it)', parses(`function foo() { return helper() + 1 }\n`))
}

console.log('\n# INTENT: removing an UNUSED function is fine (clean auto)')
{
  const refBase = `function helper() { return 1 }

function foo() { return 42 }
`
  const a = `function foo() { return 42 }
` // deleted helper; nothing uses it
  const b = refBase
  const r = structuralMerge(refBase, a, b)
  assert('status is auto', r.status === 'auto')
  assert('helper removed', !/function helper/.test(r.text || ''))
  assert('valid code', parses(r.text || ''))
}

console.log('\n# FINER GRANULARITY: both edit the SAME function but DIFFERENT lines inside â†’ merge, not conflict')
{
  const refBase = `function foo() {
  const a = 1
  const b = 2
  return a + b
}

function bar() { return 9 }
`
  // Agent A changes only `const a`
  const a = `function foo() {
  const a = 10
  const b = 2
  return a + b
}

function bar() { return 9 }
`
  // Agent B changes only `const b`
  const b = `function foo() {
  const a = 1
  const b = 20
  return a + b
}

function bar() { return 9 }
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto (descended into foo, no conflict)', r.status === 'auto')
  assert("kept A's edit inside foo (const a = 10)", /const a = 10/.test(r.text || ''))
  assert("kept B's edit inside foo (const b = 20)", /const b = 20/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# FINER GRANULARITY guard: both edit the SAME line inside â†’ still a real conflict')
{
  const refBase = `function foo() {
  const a = 1
  return a
}
`
  const a = `function foo() {
  const a = 10
  return a
}
`
  const b = `function foo() {
  const a = 99
  return a
}
`
  const r = structuralMerge(refBase, a, b)
  assert('status is semantic-conflict (same inner line clashes)', r.status === 'semantic-conflict')
  assert('names the conflicting function (fn:foo)', r.conflicts.includes('fn:foo'))
}

console.log('\n# RENAME: A renames a function, B adds calls to the OLD name â†’ ICR fixes the call sites')
{
  // The showstopper. Nothing else does this.
  const refBase = `function login() { return 1 }

function page() { return login() }
`
  // Agent A renames login -> signIn everywhere it could see.
  const a = `function signIn() { return 1 }

function page() { return signIn() }
`
  // Agent B (working from base) adds a new function that calls the OLD name, login.
  const b = `function login() { return 1 }

function page() { return login() }

function checkout() { return login() + login() }
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto (rename understood, not a conflict)', r.status === 'auto')
  assert('records the rename (login->signIn)', (r.renames || []).includes('login->signIn'))
  assert("B's new function is kept", /function checkout/.test(r.text || ''))
  assert("B's stale calls were rewritten to the new name", /signIn\(\) \+ signIn\(\)/.test(r.text || ''))
  assert('no reference to the old name remains', !/login/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
  // prove the danger ICR just defused: without rename detection this merge would call
  // login() â€” a function that no longer exists. It parses, so git/CRDTs ship it.
  assert('the broken version (calling login) would have parsed', parses(`function signIn(){return 1}\nfunction checkout(){return login()}\n`))
}

console.log('\n# RENAME guard: a DELETE that only looks like a rename is not over-eagerly rewritten')
{
  // helper is removed; foo is added with a DIFFERENT body. Not a rename. foo must not
  // absorb helper's references, and helper being still-used must still be flagged.
  const refBase = `function helper() { return 1 }

function page() { return helper() }
`
  const a = `function page() { return helper() }
` // deleted helper, but page still calls it â€” broken intent, no rename to explain it
  const b = `function helper() { return 1 }

function page() { return helper() }

function foo() { return 999 }
` // foo is genuinely new, unrelated body
  const r = structuralMerge(refBase, a, b)
  assert('not mis-detected as a rename', !(r.renames || []).length)
  assert('still caught as a dangling reference', r.status === 'semantic-conflict' && r.conflicts.includes('ref:helper'))
}

console.log('\n# SCOPE-AWARE: deleting a top-level fn is FINE when the only remaining use is a LOCAL of the same name')
{
  // The win over a naive identifier check: `helper` inside foo is a LOCAL const, not the
  // deleted top-level helper. A name-only check would cry "dangling"; scope analysis knows better.
  const refBase = `function helper() { return 1 }

function foo() { return helper() }
`
  const a = `function foo() {
  const helper = () => 2
  return helper()
}
` // removed top-level helper AND replaced the call with a local helper
  const b = refBase
  const r = structuralMerge(refBase, a, b)
  assert('status is auto (the local helper is not the deleted one)', r.status === 'auto')
  assert('top-level helper is gone', !/function helper/.test(r.text || ''))
  assert('foo keeps its local helper', /const helper = \(\) => 2/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# SCOPE-AWARE: a closure that truly references the deleted top-level name IS still dangling')
{
  const refBase = `function helper() { return 1 }

function foo() { return 0 }
`
  // A deletes helper; B rewrites foo so a nested closure references the (now gone) top-level helper.
  const a = `function foo() { return 0 }
`
  const b = `function helper() { return 1 }

function foo() {
  return (() => helper())()
}
`
  const r = structuralMerge(refBase, a, b)
  assert('still caught as semantic-conflict (free reference resolves to module scope)', r.status === 'semantic-conflict')
  assert('names the dangling reference (ref:helper)', r.conflicts.includes('ref:helper'))
}

console.log('\n# SCOPE-AWARE RENAME: rewriting call sites must NOT touch an unrelated local of the same name')
{
  const refBase = `function login() { return 1 }

function page() { return login() }
`
  // A renames login -> signIn (and updates the call it sees)
  const a = `function signIn() { return 1 }

function page() { return signIn() }
`
  // B adds a function whose LOCAL variable is coincidentally named login â€” unrelated.
  const b = `function login() { return 1 }

function page() { return login() }

function logger() {
  const login = 'audit'
  return login
}
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto', r.status === 'auto')
  assert('records the rename (login->signIn)', (r.renames || []).includes('login->signIn'))
  assert('the unrelated local login is left intact', /const login = 'audit'/.test(r.text || ''))
  assert('and its local use is NOT rewritten to signIn', /return login\n/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# CLASSES: two agents edit DIFFERENT methods of the same class â†’ merge, not conflict')
{
  const refBase = `class Animal {
  speak() { return 'generic' }
  legs() { return 4 }
}
`
  const a = `class Animal {
  speak() { return 'woof' }
  legs() { return 4 }
}
`
  const b = `class Animal {
  speak() { return 'generic' }
  legs() { return 2 }
}
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto (descended into the class)', r.status === 'auto')
  assert("kept A's method edit (woof)", /return 'woof'/.test(r.text || ''))
  assert("kept B's method edit (2 legs)", /return 2/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# CLASSES guard: two agents edit the SAME method â†’ still a real conflict')
{
  const refBase = `class Animal {
  speak() { return 'generic' }
}
`
  const a = `class Animal {
  speak() { return 'woof' }
}
`
  const b = `class Animal {
  speak() { return 'meow' }
}
`
  const r = structuralMerge(refBase, a, b)
  assert('status is semantic-conflict', r.status === 'semantic-conflict')
  assert('names the conflicting class (class:Animal)', r.conflicts.includes('class:Animal'))
}

console.log('\n# PROVENANCE: each merged unit is attributed to the author who changed it')
{
  const refBase = `function foo() { return 1 }

function bar() { return 2 }
`
  const a = `function foo() { return 100 }

function bar() { return 2 }
`
  const b = `function foo() { return 1 }

function bar() { return 200 }
`
  const r = structuralMerge(refBase, a, b, { authors: { a: 'Alice', b: 'Bob', base: '(unchanged)' } })
  assert('status is auto', r.status === 'auto')
  const prov = r.provenance || []
  const foo = prov.find((p) => p.unit === 'fn:foo')
  const bar = prov.find((p) => p.unit === 'fn:bar')
  assert('foo attributed to Alice (she changed it)', foo && foo.author === 'Alice')
  assert('bar attributed to Bob (he changed it)', bar && bar.author === 'Bob')
}

console.log('\n# OBJECT LITERAL: two agents add DIFFERENT keys to the same config object â†’ union')
{
  const refBase = `const config = {
  host: 'localhost',
  port: 8080
}
`
  const a = `const config = {
  host: 'localhost',
  port: 8080,
  retries: 3
}
`
  const b = `const config = {
  host: 'localhost',
  port: 8080,
  timeout: 1000
}
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto (descended into the object)', r.status === 'auto')
  assert("kept A's new key (retries)", /retries: 3/.test(r.text || ''))
  assert("kept B's new key (timeout)", /timeout: 1000/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# CONST ARROW FN: two agents edit DIFFERENT lines in a const arrow function body â†’ merge')
{
  const refBase = `const run = () => {
  const a = 1
  const b = 2
  return a + b
}
`
  const a = `const run = () => {
  const a = 10
  const b = 2
  return a + b
}
`
  const b = `const run = () => {
  const a = 1
  const b = 20
  return a + b
}
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto (recursed into the arrow body)', r.status === 'auto')
  assert("kept A's edit (a = 10)", /const a = 10/.test(r.text || ''))
  assert("kept B's edit (b = 20)", /const b = 20/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# METHOD BODY: two agents edit DIFFERENT lines inside the SAME class method â†’ merge')
{
  const refBase = `class Calc {
  run() {
    const a = 1
    const b = 2
    return a + b
  }
}
`
  const a = `class Calc {
  run() {
    const a = 10
    const b = 2
    return a + b
  }
}
`
  const b = `class Calc {
  run() {
    const a = 1
    const b = 20
    return a + b
  }
}
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto (recursed into the method body)', r.status === 'auto')
  assert("kept A's inner edit (a = 10)", /const a = 10/.test(r.text || ''))
  assert("kept B's inner edit (b = 20)", /const b = 20/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# IMPORTS: two agents add DIFFERENT named imports from the same module â†’ specifiers union')
{
  const refBase = `import { a } from 'x'

const y = a
`
  const a = `import { a, b } from 'x'

const y = a
`
  const b = `import { a, c } from 'x'

const y = a
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto', r.status === 'auto')
  assert('union keeps a', /\ba\b/.test(r.text || ''))
  assert("kept A's added b", /\bb\b/.test(r.text || '') && /import \{[^}]*b[^}]*\}/.test(r.text || ''))
  assert("kept B's added c", /import \{[^}]*c[^}]*\}/.test(r.text || ''))
  assert('still one import statement from x', (r.text.match(/from 'x'/g) || []).length === 1)
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# IMPORTS: imports from DIFFERENT modules never collide')
{
  const refBase = `const y = 1
`
  const a = `import { foo } from 'x'

const y = 1
`
  const b = `import { bar } from 'z'

const y = 1
`
  const r = structuralMerge(refBase, a, b)
  assert('status is auto (different modules, no conflict)', r.status === 'auto')
  assert("kept A's import from x", /from 'x'/.test(r.text || ''))
  assert("kept B's import from z", /from 'z'/.test(r.text || ''))
  assert('merged output is valid code', parses(r.text || ''))
}

console.log('\n# SCOPE: a deleted function used only in a PARAMETER DEFAULT is still caught')
{
  const refBase = `function fallback() { return 0 }

function run(x = fallback()) { return x }
`
  const a = `function run(x = fallback()) { return x }
` // deleted fallback, but it is still used as a param default
  const b = refBase
  const r = structuralMerge(refBase, a, b)
  assert('caught as semantic-conflict (default value is a real reference)', r.status === 'semantic-conflict')
  assert('names the dangling reference (ref:fallback)', r.conflicts.includes('ref:fallback'))
}

console.log('\n# Refuses unparseable input rather than crashing or emitting garbage')
{
  const broken = `function foo() { return 1` // missing brace
  const r = structuralMerge(base, broken, base)
  assert('status is fallback (never crashes, never returns broken)', r.status === 'fallback')
  assert('no text emitted', r.text === null)
}

console.log(`\n=== ${failed === 0 ? 'ALL ICR CHECKS PASSED' : failed + ' FAILED'} ===`)
process.exit(failed === 0 ? 0 : 1)
