// Does the intent layer confuse a LOCAL variable with a top-level declaration?
//
// lang-js carries a scope-aware pair (referencedFreeNames / renameFreeRefs) and the
// engine prefers them. Every other provider -- Python, Ruby, and the brace family that
// covers TypeScript, Go, Rust, Java, C#, C++ -- ships only the approximate
// usedIdentifiers / renameRefs, which see a name and cannot tell which binding it is.
//
// Two consequences are predicted, and this asserts them rather than assuming:
//
//   CAPTURE  A rename of a top-level `helper` to `assist` is propagated into a function
//            that already has locals named BOTH `helper` and `assist`. Two distinct
//            variables collapse into one. The output still parses, so the parse guarantee
//            cannot catch it -- this is the dangerous direction: valid code, changed
//            meaning, no warning.
//
//   FALSE CONFLICT  A top-level `helper` is deleted while an unrelated function has a
//            local named `helper`. The dangling check sees the name, believes the deleted
//            declaration is still referenced, and declines a merge that was safe.
//            Cautious rather than harmful, but it is a merge the user has to do by hand.
//
// Run: node test/scope-repro.mjs
import { merge } from '../index.js'

let failures = 0
const report = (name, bad, detail) => {
  console.log(`  ${bad ? 'DEFECT ' : 'ok     '} ${name}`)
  if (bad) { failures++; if (detail) console.log(detail.replace(/^/gm, '           ')) }
}

// ---------------------------------------------------------------- capture, Python
{
  const base = [
    'def helper():', '    return 1', '', '',
    'def main():', '    assist = 2', '    helper = 3', '    return assist + helper', '',
  ].join('\n')
  // ours renames the top-level declaration only; the locals in main() are untouched.
  const ours = base.replace('def helper():', 'def assist():')
  // theirs edits something else entirely, so a structural merge is available.
  const theirs = base.replace('    return 1', '    return 42')

  const r = merge(base, ours, theirs, { filename: 'mod.py' })
  const body = r.text.split('def main():')[1] || ''
  // Both locals must survive as two distinct names.
  const captured = !/helper\s*=\s*3/.test(body)
  report('python  local `helper` survives a top-level helper->assist rename',
         captured, captured ? `method=${r.method} renames=${r.renames}\n${r.text}` : null)
}

// ---------------------------------------------------------------- capture, Go (brace)
{
  const base = [
    'func helper() int {', '\treturn 1', '}', '',
    'func main() {', '\tassist := 2', '\thelper := 3', '\t_ = assist + helper', '}', '',
  ].join('\n')
  const ours = base.replace('func helper() int {', 'func assist() int {')
  const theirs = base.replace('\treturn 1', '\treturn 42')

  const r = merge(base, ours, theirs, { filename: 'main.go' })
  const body = r.text.split('func main()')[1] || ''
  const captured = !/helper\s*:=\s*3/.test(body)
  report('go      local `helper` survives a top-level helper->assist rename',
         captured, captured ? `method=${r.method} renames=${r.renames}\n${r.text}` : null)
}

// ---------------------------------------------------------------- false conflict, Python
{
  const base = [
    'def helper():', '    return 1', '', '',
    'def main():', '    helper = compute()', '    return helper', '',
  ].join('\n')
  // ours deletes the top-level helper. Nothing outside main() refers to it, and main()'s
  // `helper` is its own local -- so this merge is safe.
  const ours = base.replace('def helper():\n    return 1\n\n\n', '')
  const theirs = base.replace('    return helper', '    return helper or 0')

  const r = merge(base, ours, theirs, { filename: 'mod2.py' })
  const blocked = !r.clean || (r.semantic || []).some((c) => c === 'ref:helper')
  report('python  deleting top-level `helper` is not blocked by an unrelated local',
         blocked, blocked ? `method=${r.method} clean=${r.clean} semantic=${r.semantic}` : null)
}

// ---------------------------------------------------------------- the JS control
{
  const base = [
    'function helper() { return 1 }', '',
    'function main() {', '  const assist = 2', '  const helper = 3', '  return assist + helper', '}', '',
  ].join('\n')
  const ours = base.replace('function helper()', 'function assist()')
  const theirs = base.replace('{ return 1 }', '{ return 42 }')

  const r = merge(base, ours, theirs, { filename: 'mod.js' })
  const body = r.text.split('function main()')[1] || ''
  const captured = !/const helper = 3/.test(body)
  report('js      (control) local `helper` survives -- scope-aware path',
         captured, captured ? `method=${r.method} renames=${r.renames}\n${r.text}` : null)
}

// ---------------------------------------------------------------- SAFETY: real refs
// The scope fix must only ever remove FALSE conflicts. If it silences a real one, ICR
// ships a merge that deletes a declaration still in use -- the single failure this
// library promises never to have. These assert the opposite direction of everything
// above, and they matter more than the defect they accompany.
const stillBlocked = (label, base, ours, theirs, file) => {
  const r = merge(base, ours, theirs, { filename: file })
  const blocked = !r.clean || (r.semantic || []).some((c) => c.startsWith('ref:'))
  report(label, !blocked, !blocked
    ? `NOT blocked: method=${r.method} clean=${r.clean} semantic=${r.semantic}\n${r.text}` : null)
}

{
  // A plain call from a function that binds nothing of that name.
  const base = ['def helper():', '    return 1', '', '',
                'def main():', '    return helper()', ''].join('\n')
  stillBlocked('SAFETY python  deleted `helper` still called from main()',
    base, base.replace('def helper():\n    return 1\n\n\n', ''),
    base.replace('    return helper()', '    return helper() + 1'), 'safe1.py')
}
{
  // Bound in ONE function, genuinely referenced from another.
  const base = ['def helper():', '    return 1', '', '',
                'def a():', '    helper = 3', '    return helper', '', '',
                'def b():', '    return helper()', ''].join('\n')
  stillBlocked('SAFETY python  local in a() does not excuse the real call in b()',
    base, base.replace('def helper():\n    return 1\n\n\n', ''),
    base.replace('    return helper', '    return helper + 0'), 'safe2.py')
}
{
  // Referenced at module level, where nothing is ever subtracted.
  const base = ['def helper():', '    return 1', '', '',
                'VALUE = helper()', ''].join('\n')
  stillBlocked('SAFETY python  deleted `helper` still used at module level',
    base, base.replace('def helper():\n    return 1\n\n\n', ''),
    base.replace('VALUE = helper()', 'VALUE = helper() or 0'), 'safe3.py')
}
{
  // A method body is a scope; the class body around it binds nothing for it.
  const base = ['def helper():', '    return 1', '', '',
                'class C:', '    helper = 9', '', '    def run(self):', '        return helper()', ''].join('\n')
  stillBlocked('SAFETY python  class attribute `helper` does not shadow the call in a method',
    base, base.replace('def helper():\n    return 1\n\n\n', ''),
    base.replace('        return helper()', '        return helper() + 1'), 'safe4.py')
}
{
  // Closure: the inner def reads the OUTER function's local, so this is genuinely not a
  // reference to the deleted top-level name -- it must NOT block. The mirror of the
  // tests above, asserting the fix actually fires through nesting.
  const base = ['def helper():', '    return 1', '', '',
                'def outer():', '    helper = 3', '', '    def inner():', '        return helper', '    return inner()', ''].join('\n')
  const ours = base.replace('def helper():\n    return 1\n\n\n', '')
  const theirs = base.replace('    return inner()', '    return inner() or 0')
  const r = merge(base, ours, theirs, { filename: 'closure.py' })
  const blocked = !r.clean || (r.semantic || []).some((c) => c === 'ref:helper')
  report('python  closure over an outer local is not a reference to the deleted name',
         blocked, blocked ? `method=${r.method} semantic=${r.semantic}` : null)
}

console.log(failures ? `\n${failures} defect(s) reproduced` : '\nall clear')
process.exit(failures ? 1 : 0)
