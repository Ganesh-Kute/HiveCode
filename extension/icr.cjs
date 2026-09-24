// AUTO-GENERATED from lang-js.js + lang-brace.js + lang-python.js + lang-ruby.js + lang-json.js + lang-yaml.js + lang-toml.js + icr.js
// by scripts/build-icr-cjs.cjs — do not edit by hand.
// CommonJS bundle of the ICR merge engine for the (CommonJS, separately-packaged) extension.
const acorn = require('acorn')

const { javascript } = (function () {
// lang-js.js â€” the JavaScript language provider for ICR.
//
// ICR's merge engine (icr.js) is language-agnostic: it merges a list of keyed "units"
// and asks intent questions ("what names are declared / used / what's a function body").
// Everything that actually knows about a *language* â€” how to parse it, what a top-level
// declaration is, how to find references â€” lives behind a provider like this one.
//
// To add a language (Python, Go, Rustâ€¦), write another module exposing the same shape
// and register it with icr.js's registerLanguage(). This JS provider is just the first
// plugin; it happens to use `acorn` because acorn is a tiny pure-JS parser. A tree-sitter
// provider would implement the identical interface over tree-sitter grammars.


// Parse permissively: try module syntax, fall back to script (so plain snippets and
// ESM both work). Throws only when the code genuinely won't parse either way.
function parseRaw(src) {
  try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }) }
  catch { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' }) }
}

// Tiny parse cache. One structuralMerge re-parses the SAME three texts (and the merged
// result) many times across its tiers — gate, units, declaredNames, scope analysis,
// final validation. Caching by exact text collapses that to one parse per distinct
// version (a 1MB-file merge dropped ~7.6s → ~3s). Small and bounded: 8 entries, LRU.
// String comparison is a cheap memcmp; ASTs are treated as immutable by all callers.
const PARSE_CACHE = new Map() // src -> ast (Map preserves insertion order → LRU)
function parse(src) {
  const hit = PARSE_CACHE.get(src)
  if (hit) { PARSE_CACHE.delete(src); PARSE_CACHE.set(src, hit); return hit } // refresh LRU position
  const ast = parseRaw(src)
  PARSE_CACHE.set(src, ast)
  if (PARSE_CACHE.size > 8) PARSE_CACHE.delete(PARSE_CACHE.keys().next().value)
  return ast
}

function parses(src) { try { parse(src); return true } catch { return false } }

// A stable key per top-level node â€” what lets us recognize "the same declaration"
// across two edits. Names where we have them; position as a last resort.
// Dotted source path of a simple expression target (Axios.prototype.request,
// utils.forEach, this.config) â€” or null when it isn't a plain dotted path.
function exprPath(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'ThisExpression') return 'this'
  if (node.type === 'MemberExpression' && !node.computed) {
    const o = exprPath(node.object)
    return o && node.property && node.property.name ? o + '.' + node.property.name : null
  }
  return null
}

// CONTENT-ANCHORED key for a statement, or null for truly anonymous ones.
// Index keys (stmt:N) are a last resort ONLY: an insertion above an index-keyed
// statement shifts every index, so unrelated statements pair up as fake
// same-unit conflicts â€” and deletions mispair so deleted code can resurrect.
// (Both failure modes were found by the merge census replaying axios/express
// history.) Assignments key by their target, calls by callee path plus a
// leading string literal (`it('name')`, `describe('name')`), directives by text.
function baseKeyOf(node) {
  let n = node
  if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
  if (n.type === 'ExportDefaultDeclaration') return 'export:default'
  if (n.type === 'FunctionDeclaration' && n.id) return 'fn:' + n.id.name
  if (n.type === 'ClassDeclaration' && n.id) return 'class:' + n.id.name
  if (n.type === 'VariableDeclaration' && n.declarations[0] && n.declarations[0].id && n.declarations[0].id.name)
    return 'var:' + n.declarations[0].id.name
  // Key imports by their SOURCE MODULE, so two agents adding imports from DIFFERENT
  // modules never collide, and two touching the SAME module are merged (specifier union).
  if (n.type === 'ImportDeclaration') return 'import:' + (n.source && n.source.value != null ? n.source.value : '?')
  // Specifier-only exports (`export { a, b }`, `export { x } from './m'`, `export * from …`)
  // carry no declaration, so without a stable key they fall to positional stmt:N — and an
  // edit to the export list then mispairs, DUPLICATES the statement, and knocks the whole
  // merge to the line tier (which silently skips the intent/dangling checks). A stable key
  // pairs them so an unedited side is kept and an edited side wins cleanly.
  if (n.type === 'ExportNamedDeclaration') return n.source && n.source.value != null ? 'export-from:' + n.source.value : 'export-names'
  if (n.type === 'ExportAllDeclaration') return 'export-all:' + (n.source && n.source.value != null ? n.source.value : '?')
  if (n.type === 'ExpressionStatement') {
    const e = n.expression
    if (e.type === 'Literal' && typeof e.value === 'string') return 'directive:' + e.value // 'use strict'
    if (e.type === 'AssignmentExpression') { const t = exprPath(e.left); if (t) return 'assign:' + t }
    if (e.type === 'CallExpression') {
      const t = exprPath(e.callee)
      if (t) {
        const a0 = e.arguments && e.arguments[0]
        return 'call:' + t + (a0 && a0.type === 'Literal' && typeof a0.value === 'string' ? ':' + a0.value : '')
      }
    }
  }
  return null
}

// Key an ordered statement list: content-anchored where possible (duplicates get
// #1, #2â€¦ by occurrence), positional stmt:N only for the anonymous remainder.
function keyStatements(nodes) {
  const seen = new Map()
  return nodes.map((n, i) => {
    const k = baseKeyOf(n)
    if (k == null) return 'stmt:' + i
    const c = seen.get(k) || 0
    seen.set(k, c + 1)
    return c ? k + '#' + c : k
  })
}

function keyOf(node, i) { const k = baseKeyOf(node); return k == null ? 'stmt:' + i : k }

// Top-level units: ordered { key, text, start, end } for each declaration/statement.
// start/end are byte offsets in `src` â€” used by the format-preserving splice so unchanged
// regions (and the whitespace/comments between units) survive a merge verbatim.
function units(src) {
  const ast = parse(src)
  const keys = keyStatements(ast.body)
  return ast.body.map((node, i) => ({ key: keys[i], text: src.slice(node.start, node.end), start: node.start, end: node.end }))
}

// Bare declared name (foo, Bar, VERSION) of a node, or null for anonymous statements.
function bareName(node) {
  let n = node
  if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
  if (n.type === 'FunctionDeclaration' && n.id) return n.id.name
  if (n.type === 'ClassDeclaration' && n.id) return n.id.name
  if (n.type === 'VariableDeclaration' && n.declarations[0] && n.declarations[0].id && n.declarations[0].id.name) return n.declarations[0].id.name
  return null
}

function declaredNames(src) {
  const s = new Set()
  for (const node of parse(src).body) {
    let n = node
    if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations) bindingNames(d.id, s)
    } else {
      const nm = bareName(node); if (nm) s.add(nm)
    }
    // Import locals count as declared names too — so if an import is ever dropped and its
    // binding is still used, the dangling-reference check catches it (safety net for the
    // import merge). Keeps the never-emit-broken-code guarantee honest for imports.
    if (node.type === 'ImportDeclaration') for (const sp of node.specifiers) s.add(sp.local.name)
    if (node.type === 'ExportNamedDeclaration' && !node.declaration && node.specifiers) {
      for (const sp of node.specifiers) s.add(sp.exported.name || sp.exported.value || sp.local.name)
    }
  }
  return s
}

// --- import-aware merging -------------------------------------------------------
// Parse a single import statement into its parts, or null if it isn't one.
function parseImport(src) {
  let n
  try { n = parse(src).body[0] } catch { return null }
  if (!n || n.type !== 'ImportDeclaration') return null
  let def = null, ns = null
  const named = []
  for (const sp of n.specifiers) {
    if (sp.type === 'ImportDefaultSpecifier') def = sp.local.name
    else if (sp.type === 'ImportNamespaceSpecifier') ns = sp.local.name
    else named.push({ imported: sp.imported.name != null ? sp.imported.name : sp.imported.value, local: sp.local.name })
  }
  return { source: n.source.value, def, ns, named }
}
function renderImport({ source, def, ns, named }) {
  const parts = []
  if (def) parts.push(def)
  if (ns) parts.push('* as ' + ns)
  if (named.length) parts.push('{ ' + named.map((s) => s.imported === s.local ? s.local : s.imported + ' as ' + s.local).join(', ') + ' }')
  if (!parts.length) return "import '" + source + "'"
  return 'import ' + parts.join(', ') + " from '" + source + "'"
}
// Both sides changed an import from the SAME module â†’ union their specifiers into one
// statement (the common "both agents added an import" case). Returns null â€” meaning
// "let the normal conflict path handle it" â€” for anything we can't safely combine
// (different modules, clashing defaults/namespaces, namespace-mixed-with-named).
function mergeUnit(baseText, aText, bText) {
  const a = parseImport(aText), b = parseImport(bText)
  if (!a || !b || a.source !== b.source) return null
  let def
  if (a.def && b.def) { if (a.def !== b.def) return null; def = a.def } else def = a.def || b.def
  let ns
  if (a.ns && b.ns) { if (a.ns !== b.ns) return null; ns = a.ns } else ns = a.ns || b.ns
  if (ns && (a.named.length || b.named.length)) return null // `* as X` can't share a statement with named imports
  const seen = new Set(), named = []
  for (const s of [...a.named, ...b.named]) { const k = s.imported + '|' + s.local; if (!seen.has(k)) { seen.add(k); named.push(s) } }
  // Canonical specifier order: the union must not depend on which side is `a` â€” the merge
  // has to be SYMMETRIC (merge(a,b) === merge(b,a)) or two live peers never settle on one
  // byte-form. (Found by the property fuzzer: a 1-in-40k NOT-SYMMETRIC violation.)
  named.sort((x, y) => (x.imported + '|' + x.local).localeCompare(y.imported + '|' + y.local))
  return renderImport({ source: a.source, def, ns, named })
}

// The BODY of a top-level declaration, by name, with the name itself excluded â€” so two
// declarations that differ only in their name compare equal (that's how we spot a rename).
function declBody(src, name) {
  for (const node of parse(src).body) {
    if (bareName(node) !== name) continue
    let n = node
    if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.body)
      return src.slice(n.body.start, n.body.end)
    if (n.type === 'VariableDeclaration' && n.declarations[0] && n.declarations[0].init) {
      const init = n.declarations[0].init
      return src.slice(init.start, init.end)
    }
    return null
  }
  return null
}

// Check if top-level declaration `name` is declared `async`
function isAsyncDecl(src, name) {
  try {
    for (const node of parse(src).body) {
      if (bareName(node) !== name) continue
      let n = node
      if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
      if (n.type === 'ExportDefaultDeclaration' && n.declaration) n = n.declaration
      if (n.type === 'FunctionDeclaration') return !!n.async
      if (n.type === 'VariableDeclaration' && n.declarations[0] && n.declarations[0].init) {
        const init = n.declarations[0].init
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          return !!init.async
        }
      }
    }
  } catch {}
  return false
}

// Upgrade free call sites of `fnName` to `await fnName(...)` if they are inside an async parent
// and not already awaited.
function upgradeCallSitesToAwait(src, fnName) {
  try {
    const ast = parse(src)
    const spots = []

    function walkAST(node, parent, isAsyncScope = false) {
      if (!node || typeof node.type !== 'string') return

      let childAsyncScope = isAsyncScope
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        childAsyncScope = !!node.async
      }

      if (node.type === 'CallExpression') {
        let isTarget = false
        if (node.callee.type === 'Identifier' && node.callee.name === fnName) isTarget = true
        if (isTarget && childAsyncScope) {
          const alreadyAwaited = parent && parent.type === 'AwaitExpression'
          if (!alreadyAwaited) {
            spots.push(node.start)
          }
        }
      }

      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue
        const v = node[k]
        if (Array.isArray(v)) {
          for (const c of v) walkAST(c, node, childAsyncScope)
        } else if (v && typeof v.type === 'string') {
          walkAST(v, node, childAsyncScope)
        }
      }
    }

    walkAST(ast, null, false)
    if (!spots.length) return src

    spots.sort((a, b) => b - a)
    let out = src
    for (const pos of spots) {
      out = out.slice(0, pos) + 'await ' + out.slice(pos)
    }
    return out
  } catch {
    return src
  }
}

// Find callers of `fnName` that are synchronous (cannot be auto-awaited without changing the caller's signature)
function syncCallSitesOf(src, fnName) {
  const syncCallers = []
  try {
    const ast = parse(src)
    function walkAST(node, currentFnName = null, isAsyncScope = false) {
      if (!node || typeof node.type !== 'string') return

      let childAsyncScope = isAsyncScope
      let fnNameContext = currentFnName
      if (node.type === 'FunctionDeclaration') {
        childAsyncScope = !!node.async
        fnNameContext = node.id ? node.id.name : '<anonymous>'
      } else if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        childAsyncScope = !!node.async
        if (node.id) fnNameContext = node.id.name
      }

      if (node.type === 'CallExpression') {
        if (node.callee.type === 'Identifier' && node.callee.name === fnName) {
          if (!childAsyncScope) {
            syncCallers.push(fnNameContext || '<top-level>')
          }
        }
      }

      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue
        const v = node[k]
        if (Array.isArray(v)) {
          for (const c of v) walkAST(c, fnNameContext, childAsyncScope)
        } else if (v && typeof v.type === 'string') {
          walkAST(v, fnNameContext, childAsyncScope)
        }
      }
    }
    walkAST(ast, null, false)
  } catch {}
  return syncCallers
}

// Rewrite every reference to `oldName` as `newName` (skipping property/key positions,
// which aren't references to the declaration). Edits back-to-front to keep offsets valid.
function renameRefs(src, oldName, newName) {
  const spots = []
  walk(parse(src), (node, parent, key) => {
    if (node.type !== 'Identifier' || node.name !== oldName) return
    if (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return
    if (parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return
    spots.push([node.start, node.end])
  })
  spots.sort((a, b) => b[0] - a[0])
  let out = src
  for (const [s, e] of spots) out = out.slice(0, s) + newName + out.slice(e)
  return out
}

// Every identifier USED anywhere (skips obj.prop names and non-computed object keys).
// Approximate â€” good enough for the intent check; the real version is scope-aware.
function usedIdentifiers(src) {
  const used = new Set()
  walk(parse(src), (node, parent, key) => {
    if (node.type !== 'Identifier') return
    if (parent && parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return
    if (parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return
    used.add(node.name)
  })
  return used
}

function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent, key)
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
    const v = node[k]
    if (Array.isArray(v)) { for (const c of v) walk(c, visit, node, k) }
    else if (v && typeof v.type === 'string') walk(v, visit, node, k)
  }
}

// --- scope-aware reference analysis ---------------------------------------------
// The names REFERENCED in `src` that resolve to NOTHING in the file's own scopes â€”
// i.e. free/global names, including any use of a top-level declaration. This is the
// scope-aware upgrade of usedIdentifiers: a use of `x` that resolves to a LOCAL binding
// (a param, a `const x` in the same function, a catch var, a loop varâ€¦) is NOT counted,
// because it isn't a reference to a top-level declaration. That lets ICR tell a deleted
// top-level `helper` apart from an unrelated local `helper` that merely shares its name.
//
// Honest scope coverage: functions (declaration/expression/arrow), blocks, catch
// clauses, for/for-in/for-of loop bindings, params with simple destructuring, imports,
// var-hoisting to the function scope, and let/const/class/function block binding.
// Approximations (rare, and they only ever make the dangling check MORE cautious):
// default-value expressions in patterns and `with`/eval are not modeled.
// Walk the AST and call emit(identifierNode) for every reference that resolves to NO
// local binding (free / would resolve to module or global scope). Both the dangling-ref
// check and scope-aware renaming are built on this single traversal.
function walkFreeRefs(src, emit) { resolveScopes(parse(src), null, emit) }

function referencedFreeNames(src) {
  const free = new Set()
  walkFreeRefs(src, (node) => free.add(node.name))
  return free
}

// Rename ONLY the free references to oldName (those that resolve to the top-level/global
// binding) â€” never a local variable that merely shares the name. Edits back-to-front.
function renameFreeRefs(src, oldName, newName) {
  const spots = []
  walkFreeRefs(src, (node) => { if (node.name === oldName) spots.push([node.start, node.end]) })
  spots.sort((a, b) => b[0] - a[0])
  let out = src
  for (const [s, e] of spots) out = out.slice(0, s) + newName + out.slice(e)
  return out
}

const CHILD_SKIP = new Set(['type', 'start', 'end', 'loc', 'range'])
function eachChild(node, fn) {
  for (const k of Object.keys(node)) {
    if (CHILD_SKIP.has(k)) continue
    const v = node[k]
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') fn(c) }
    else if (v && typeof v.type === 'string') fn(v)
  }
}

// Names introduced by a binding target (handles identifiers + simple destructuring).
function bindingNames(node, out) {
  if (!node) return
  switch (node.type) {
    case 'Identifier': out.add(node.name); break
    case 'ObjectPattern': for (const p of node.properties) bindingNames(p.type === 'RestElement' ? p.argument : p.value, out); break
    case 'ArrayPattern': for (const el of node.elements) if (el) bindingNames(el, out); break
    case 'AssignmentPattern': bindingNames(node.left, out); break
    case 'RestElement': bindingNames(node.argument, out); break
  }
}

// A binding target's NAMES are bindings, but its default values (`a = expr`) and computed
// destructuring keys (`{ [k]: v }`) are REFERENCES that must be resolved against the scope.
// Without this, a name used only in a default value would be missed by the dangling check.
function resolveBindingDefaults(node, scope, emit) {
  if (!node) return
  switch (node.type) {
    case 'AssignmentPattern': resolveBindingDefaults(node.left, scope, emit); resolveScopes(node.right, scope, emit); break
    case 'ObjectPattern': for (const p of node.properties) {
      if (p.type === 'RestElement') { resolveBindingDefaults(p.argument, scope, emit); break }
      if (p.computed) resolveScopes(p.key, scope, emit)
      resolveBindingDefaults(p.value, scope, emit)
    } break
    case 'ArrayPattern': for (const el of node.elements) if (el) resolveBindingDefaults(el, scope, emit); break
    case 'RestElement': resolveBindingDefaults(node.argument, scope, emit); break
    // Identifier: a pure binding â€” nothing to resolve.
  }
}

const makeScope = (parent, fnScope) => { const s = { vars: new Set(), parent }; s.fnScope = fnScope || s; return s }
const resolves = (scope, name) => { for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return true; return false }

// Hoist var declarations + function declarations into the function scope (deep, but not
// crossing into nested functions, which own their own var scope).
function hoistFunctionScope(nodes, scope) { for (const n of nodes) collectHoisted(n, scope) }
function collectHoisted(node, scope) {
  if (!node || typeof node.type !== 'string') return
  if (node.type === 'FunctionDeclaration') { if (node.id) scope.fnScope.vars.add(node.id.name); return }
  if (/Function(Expression)?$|ArrowFunctionExpression/.test(node.type)) return // nested function: stop
  if (node.type === 'VariableDeclaration' && node.kind === 'var')
    for (const d of node.declarations) bindingNames(d.id, scope.fnScope.vars)
  eachChild(node, (c) => collectHoisted(c, scope))
}
// Bind let/const/class/function/import names declared directly in a block/program.
function hoistBlock(nodes, scope) {
  for (const n of nodes) {
    if (n.type === 'VariableDeclaration' && (n.kind === 'let' || n.kind === 'const'))
      for (const d of n.declarations) bindingNames(d.id, scope.vars)
    else if (n.type === 'ClassDeclaration' && n.id) scope.vars.add(n.id.name)
    else if (n.type === 'FunctionDeclaration' && n.id) scope.vars.add(n.id.name)
    else if (n.type === 'ImportDeclaration') for (const sp of n.specifiers) scope.vars.add(sp.local.name)
  }
}

function resolveScopes(node, scope, emit) {
  if (!node || typeof node.type !== 'string') return
  switch (node.type) {
    case 'Program': {
      const s = makeScope(null, null)
      hoistFunctionScope(node.body, s); hoistBlock(node.body, s)
      for (const c of node.body) resolveScopes(c, s, emit)
      return
    }
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
      const s = makeScope(scope, null)
      for (const p of node.params) bindingNames(p, s.vars)
      for (const p of node.params) resolveBindingDefaults(p, s, emit) // default values are references
      if (node.id && node.type === 'FunctionExpression') s.vars.add(node.id.name) // named fn expr
      if (node.body.type === 'BlockStatement') {
        hoistFunctionScope(node.body.body, s); hoistBlock(node.body.body, s)
        for (const c of node.body.body) resolveScopes(c, s, emit)
      } else resolveScopes(node.body, s, emit) // arrow with expression body
      return
    }
    case 'BlockStatement': {
      const s = makeScope(scope, scope.fnScope); hoistBlock(node.body, s)
      for (const c of node.body) resolveScopes(c, s, emit)
      return
    }
    case 'CatchClause': {
      const s = makeScope(scope, scope.fnScope)
      if (node.param) bindingNames(node.param, s.vars)
      resolveScopes(node.body, s, emit)
      return
    }
    case 'ForStatement': {
      const s = makeScope(scope, scope.fnScope)
      if (node.init && node.init.type === 'VariableDeclaration') hoistBlock([node.init], s)
      for (const k of ['init', 'test', 'update', 'body']) if (node[k]) resolveScopes(node[k], s, emit)
      return
    }
    case 'ForInStatement': case 'ForOfStatement': {
      const s = makeScope(scope, scope.fnScope)
      if (node.left.type === 'VariableDeclaration') hoistBlock([node.left], s)
      else resolveScopes(node.left, s, emit)
      resolveScopes(node.right, s, emit); resolveScopes(node.body, s, emit)
      return
    }
    case 'VariableDeclarator': { resolveBindingDefaults(node.id, scope, emit); if (node.init) resolveScopes(node.init, scope, emit); return } // id is a binding (defaults are refs)
    case 'Identifier': { if (!resolves(scope, node.name)) emit(node); return }
    case 'MemberExpression': { resolveScopes(node.object, scope, emit); if (node.computed) resolveScopes(node.property, scope, emit); return }
    case 'Property': { if (node.computed) resolveScopes(node.key, scope, emit); resolveScopes(node.value, scope, emit); return }
    case 'PropertyDefinition': case 'MethodDefinition': { if (node.computed) resolveScopes(node.key, scope, emit); if (node.value) resolveScopes(node.value, scope, emit); return }
    case 'LabeledStatement': { resolveScopes(node.body, scope, emit); return }
    case 'BreakStatement': case 'ContinueStatement': return // labels aren't value references
    case 'ExportSpecifier': { resolveScopes(node.local, scope, emit); return }
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': return // binding positions
    default: eachChild(node, (c) => resolveScopes(c, scope, emit))
  }
}

// A stable key for a class member, so two agents editing DIFFERENT methods of the same
// class merge, while editing the SAME method conflicts.
function memberKey(m, i) {
  const kind = m.type === 'MethodDefinition' ? (m.kind === 'constructor' ? 'ctor' : 'method') : 'field'
  if (m.key && m.key.type === 'Identifier' && !m.computed)
    return kind + ':' + (m.static ? 'static.' : '') + m.key.name
  return 'member:' + i
}

// For finer-grained merging: split a single declaration into its signature text + keyed
// inner units, plus how to reassemble them. Handles FUNCTIONS (body statements, keyed
// like top-level decls) and CLASSES (members, keyed by method/field name). Returns null
// for anything else (the engine then treats the declaration as indivisible). Tolerates
// fragments that don't parse standalone (e.g. a bare `return`).
const MEMBER_WRAP = 'class __ICR__{'
// A class member (method) doesn't parse standalone â€” wrap it in a throwaway class so we
// can recurse INTO a method body that both agents edited. Offsets are mapped back to src.
function splitMember(src) {
  let ast
  try { ast = parse(MEMBER_WRAP + src + '}') } catch { return null }
  const cls = ast.body[0]
  if (!cls || cls.type !== 'ClassDeclaration' || !cls.body.body.length) return null
  const m = cls.body.body[0]
  if (!m || m.type !== 'MethodDefinition' || !m.value || !m.value.body || m.value.body.type !== 'BlockStatement') return null
  const off = MEMBER_WRAP.length, body = m.value.body
  const bo = body.start - off, bc = body.end - 1 - off // brace-open / brace-close in src coords
  const bs = bo + 1
  const ks = keyStatements(body.body)
  const units = body.body.map((s, i) => ({ key: ks[i], text: src.slice(s.start - off, s.end - off), start: (s.start - off) - bs, end: (s.end - off) - bs }))
  return { sig: src.slice(0, bo), open: '{', close: src.slice(bc), body: src.slice(bs, bc), units, join: '\n  ', spliceable: true }
}

function splitUnit(src) {
  let ast
  try { ast = parse(src) } catch { return splitMember(src) } // maybe a class-member fragment
  if (!ast || !ast.body) return splitMember(src) // defensive: a null AST must never reach .body
  let n = ast.body[0]
  if (!n) return null
  // Unwrap export wrappers — but ALWAYS slice signatures from 0, not the inner node's
  // start, or the wrapper text (`export `, `export default `) is silently DROPPED on
  // reassembly. Found in the wild: ICR merging its own source lost `export function`.
  if ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration') && n.declaration) n = n.declaration
  if (n.type === 'FunctionDeclaration' && n.body) {
    const bs = n.body.start + 1, be = n.body.end - 1 // between the braces
    const ks = keyStatements(n.body.body)
    const units = n.body.body.map((s, i) => ({ key: ks[i], text: src.slice(s.start, s.end), start: s.start - bs, end: s.end - bs }))
    return { sig: src.slice(0, n.body.start), open: '{', close: src.slice(be), body: src.slice(bs, be), units, join: '\n  ', spliceable: true }
  }
  if (n.type === 'ClassDeclaration' && n.body) {
    const bs = n.body.start + 1, be = n.body.end - 1
    const units = n.body.body.map((m, i) => ({ key: memberKey(m, i), text: src.slice(m.start, m.end), start: m.start - bs, end: m.end - bs }))
    return { sig: src.slice(0, n.body.start), open: '{', close: src.slice(be), body: src.slice(bs, be), units, join: '\n\n  ', spliceable: true }
  }
  // `const x = { ... }` / `const x = () => { ... }` / `const x = function () { ... }`
  // and the CommonJS twins `module.exports = function () { ... }` / `x.y = { ... }` â€”
  // without descending into assignments, two sides editing DIFFERENT lines of one
  // exported function read as a same-declaration conflict (census overcount on axios).
  let init = null
  if (n.type === 'VariableDeclaration' && n.declarations.length === 1 && n.declarations[0].init) init = n.declarations[0].init
  else if (n.type === 'ExpressionStatement' && n.expression.type === 'AssignmentExpression') init = n.expression.right
  if (init) {
    if (init.type === 'ObjectExpression') {
      const sig = src.slice(0, init.start)
      const units = init.properties.map((p, i) => ({ key: propKey(p, i), text: src.slice(p.start, p.end) }))
      return { sig, units, open: '{\n  ', join: ',\n  ', close: '\n}' }
    }
    if ((init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && init.body && init.body.type === 'BlockStatement') {
      const bs = init.body.start + 1, be = init.body.end - 1
      const ks = keyStatements(init.body.body)
      const units = init.body.body.map((s, i) => ({ key: ks[i], text: src.slice(s.start, s.end), start: s.start - bs, end: s.end - bs }))
      return { sig: src.slice(0, init.body.start), open: '{', close: src.slice(be), body: src.slice(bs, be), units, join: '\n  ', spliceable: true }
    }
  }
  return null
}

// Stable key for an object-literal property, so two agents adding DIFFERENT keys union.
function propKey(p, i) {
  if (p.type === 'SpreadElement') return 'spread:' + i
  if (p.key && p.key.type === 'Identifier' && !p.computed) return 'prop:' + p.key.name
  if (p.key && p.key.type === 'Literal') return 'prop:' + String(p.key.value)
  return 'prop:' + i
}

// Does `src` parse either as top-level code OR as a class member? (The inner-merge result
// for a method is a fragment that's only valid inside a class â€” this lets us validate it.)
function parsesUnit(src) {
  if (parses(src)) return true
  try { parse(MEMBER_WRAP + src + '}'); return true } catch { return false }
}

// TOKEN STREAM: lex `src` into a flat list of { start, end, k } where k is the token's
// source text -- the atom the engine's token-level inner merge diffs on. This is what lets
// ICR merge two edits INSIDE one statement (e.g. `foo(1, 2)` -- one side edits `1`, the
// other `2`) the way a tree-sitter merge does, instead of conflicting on the whole line.
// Lexing (not parsing) so it also works on fragments (`return x`, a class-member body).
// Comments are NOT tokens -- they live in the gaps between tokens and are carried verbatim
// by the base text, so a comment-only edit is a no-op here (the documented comment limit).
// Returns null if the fragment can't be lexed -> the engine treats it as a conflict.
function tokenize(src) {
  const out = []
  try {
    const tz = acorn.tokenizer(src, { ecmaVersion: 'latest' })
    for (;;) {
      const t = tz.getToken()
      if (t.type === acorn.tokTypes.eof) break
      out.push({ start: t.start, end: t.end, k: src.slice(t.start, t.end) })
    }
  } catch { return null }
  return out
}

// The provider contract every ICR language module implements.
const javascript = {
  id: 'javascript',
  exts: ['.js', '.mjs', '.cjs'],
  parses,
  units,
  declaredNames,
  usedIdentifiers,      // approximate (kept for reference)
  referencedFreeNames,  // scope-aware â€” what the engine prefers for the dangling check
  declBody,
  isAsyncDecl,
  upgradeCallSitesToAwait,
  syncCallSitesOf,
  renameRefs,           // rewrites every matching identifier (kept for reference)
  renameFreeRefs,       // scope-aware â€” only rewrites references that resolve to the binding
  splitUnit,            // finer granularity: split a function/class/method into keyed inner units
  parsesUnit,           // validity oracle that also accepts a class-member fragment
  mergeUnit,            // language-specific same-key merge (import specifier union)
  tokenize,             // finest granularity: token stream for the token-level inner merge
}

  return { javascript }
})()

const { braceLanguages } = (function () {
// Brace-family language provider for ICR — a dependency-free, language-agnostic
// structural splitter for C-style languages (TypeScript, Go, Rust, Java, C/C++,
// C#, Swift, Kotlin, Scala, PHP, Dart, …). It implements the ICR provider contract
// { id, exts, parses, units, declaredNames, splitUnit, parsesUnit } so the SAME
// merge engine in icr.js merges these languages by structure — different top-level
// declarations merge cleanly, the same declaration edited two ways is a named
// conflict, and edits to different members inside one class/function merge via the
// engine's finer-grained inner merge (splitUnit).
//
// It is a heuristic scanner, not a full parser: it tracks strings, line/block
// comments, and bracket depth to find top-level declarations and their byte ranges.
// This gives real structural merge and an approximate parses() (balanced delimiters)
// — honest and useful today; a tree-sitter provider can later replace it behind the
// same interface with zero engine changes.

const LINE = ['//']
const OPEN = { '{': '}', '(': ')', '[': ']' }
const CLOSE = { '}': '{', ')': '(', ']': '[' }

// Walk `src` once. `at(i)` returns the index just past a string or comment starting
// at i, or -1 if none starts there — so callers can skip over them uniformly.
function scannerAt(src, strings) {
  const n = src.length
  return function at(i) {
    if (src[i] === '/' && src[i + 1] === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; return Math.min(n, j + 2) }
    for (const lc of LINE) if (src.startsWith(lc, i)) { let j = i + lc.length; while (j < n && src[j] !== '\n') j++; return j }
    if (strings.includes(src[i])) { const q = src[i]; let j = i + 1; while (j < n) { if (src[j] === '\\') { j += 2; continue } if (src[j] === q) { j++; break } j++ } return j }
    return -1
  }
}

const isWS = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\n'

// Tokens that CONTINUE a declaration onto the next line and can never begin a new top-level
// one. Used by topUnits to avoid cutting a declaration in half at a newline.
const CONT = /^(?:__attribute__|__asm__|__asm|__declspec|noexcept|throw\s*\(|->)/

// Extract top-level units [{start,end}] from src[from..to]. A unit is a maximal
// declaration/statement at bracket depth 0: either a block (signature + balanced
// {…}) or a statement ending at ';' or end-of-line.
function topUnits(src, strings, from = 0, to = src.length) {
  const at = scannerAt(src, strings)
  const units = []
  let i = from
  while (i < to) {
    while (i < to && isWS(src[i])) i++
    if (i >= to) break

    const start = i
    let depth = 0, sawBrace = false
    while (i < to) {
      const s = at(i)
      if (s > i) { i = s; continue } // skip string / comment
      const c = src[i]
      if (OPEN[c]) { if (c === '{') sawBrace = true; depth++; i++; continue }
      if (CLOSE[c]) { depth--; i++; if (depth <= 0 && sawBrace) { while (i < to && (src[i] === ' ' || src[i] === '\t')) i++; if (src[i] === ';') i++; break } continue }
      if (depth === 0) {
        if (c === ';') { i++; break }
        if (c === '\n' && !sawBrace) {
          // K&R / Allman / kernel style: the body's opening brace sits on the NEXT line, so
          // this newline is INSIDE a declaration, not the end of one. Breaking here split
          // every such function into two units — `stmt:<signature>` and `stmt:{` — with
          // POSITIONAL keys, so any insertion elsewhere shifted the indices and re-paired
          // body #N with signature #N+1. That silently produced code whose function bodies
          // belonged to other functions, while braces stayed balanced so the parse gate
          // passed. Measured at ~34% of real C merges before this fix.
          // Look ahead past whitespace and comments: if a block follows, it belongs to us.
          let k = i + 1
          for (;;) {
            while (k < to && isWS(src[k])) k++
            const s2 = at(k)
            if (s2 > k && (src[k] === '/' || src[k] === '#')) { k = s2; continue } // comment
            break
          }
          if (k < to && src[k] === '{') { i++; continue } // keep scanning; the block joins this unit
          // A declaration can also continue onto the next line WITHOUT a brace, e.g.
          //     void addReplyErrorFormat(client *c, const char *fmt, ...)
          //         __attribute__((format(printf, 2, 3)));
          // Splitting there produced an orphan `__attribute__…;` unit whose text is IDENTICAL
          // across many prototypes in a header, so the keys became positional (#2, #3, …) and
          // shifted exactly like the signature/body case — orphaning attributes onto the wrong
          // prototypes. Only tokens that can never BEGIN a new top-level declaration are listed
          // here: `const`/`override`/`final` are deliberately excluded because in TS/Rust they
          // legitimately start the next statement (the C++ uses of those end in `{`, which the
          // brace lookahead above already handles).
          if (k < to && CONT.test(src.slice(k, k + 16))) { i++; continue }
          break
        }
      }
      i++
    }
    units.push({ start, end: i })
  }
  return units
}

const DECL = /\b(function|func|fn|def|fun|class|interface|struct|enum|trait|impl|type|namespace|module|package|object|record|protocol|actor|extension)\s+([A-Za-z_$][\w$]*)/
const VARD = /\b(const|let|var|val|static|final)\s+([A-Za-z_$][\w$]*)/
// Method/function signature, including TYPE-FIRST forms (`int a()`, `public static
// void main(String[] a)`, `std::string name()`): optional decorators + any number of
// modifiers + an optional return-type token, then NAME(args){. The captured name is
// the identifier directly before `(`.
// The return-type group ends with `[\s*&]+` rather than `\s+` so a pointer return type whose
// star is attached to the NAME still parses: `struct sk_buff *alloc_skb(int n)` must key as
// `alloc_skb`, not fall through to DECL and key as the return type `sk_buff`.
// The `Class::` group makes C++ out-of-line member definitions keyable — `int Widget::render(…)`
// keys as `render`. Without it every C++ method definition fell through to an unkeyed `stmt:`.
const METH = /^(?:@[\w.()]+\s+)*(?:(?:public|private|protected|internal|static|async|final|override|open|pub|suspend|inline|virtual|export|default|abstract|sealed|unsafe|extern|synchronized|native|constexpr)\s+)*(?:(?:function|fn|func|fun)\s+)?(?:[A-Za-z_$][\w$<>\[\].,:&*\s]*?[\s*&]+)?(?:[A-Za-z_$][\w$]*\s*::\s*)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;{]*\)(?:\s*(?:const|noexcept|override|final|volatile|mutable|&&?|throw\s*\([^){]*\)))*\s*(?:->[^{]+|:[^={]+)?\s*\{/
// control-flow headers also look like `name (…) {` — never key them as methods
const CTRL = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'try', 'return', 'new', 'throw', 'match', 'select', 'when', 'until', 'lock', 'using', 'foreach', 'with'])

function keyOf(text) {
  const head = text.replace(/^\s+/, '')
  // DECL and METH can both match one declaration, and which is RIGHT depends on whether they
  // agree on the name:
  //   `function a() {`              -> both say "a"        -> keep DECL's richer `function:a`
  //   `struct sk_buff *alloc_skb(`  -> DECL says "sk_buff",
  //                                    METH says "alloc_skb" -> DECL matched the RETURN TYPE,
  //                                    so METH wins and the key names the function.
  // Preferring DECL unconditionally (the original order) meant every pointer-returning C
  // function was keyed by its return type, feeding the rename/dangling logic wrong names.
  const meth = head.match(METH)
  const decl = head.match(DECL)
  if (meth && !CTRL.has(meth[1])) {
    if (decl && decl[2] === meth[1]) return decl[1] + ':' + decl[2]
    return 'method:' + meth[1]
  }
  if (decl) return decl[1] + ':' + decl[2]
  const m = head.match(VARD); if (m) return 'var:' + m[2]
  return 'stmt:' + head.split('\n')[0].trim().replace(/\s+/g, ' ')
}

// De-duplicate keys deterministically (repeated statements / same-named units) so the
// engine's keyed merge never silently drops one. Order is stable → convergent.
function keyedUnits(raw, src) {
  const seen = new Map(), out = []
  for (const u of raw) {
    const text = src.slice(u.start, u.end)
    let k = keyOf(text)
    const c = (seen.get(k) || 0) + 1; seen.set(k, c)
    if (c > 1) k += '#' + c
    out.push({ key: k, text, start: u.start, end: u.end })
  }
  return out
}

// Generic lexer for the token-level inner merge + the intent layer. Tokens are
// identifiers, numbers, whole strings, and single operator chars; comments live in
// the gaps (same contract as the JS provider: a comment-only edit is a no-op here).
// Returns [{start,end,k}] — k is the raw text, so any content change is a token change.
function lexTokens(src, strings) {
  const at = scannerAt(src, strings)
  const out = []
  const n = src.length
  let i = 0
  while (i < n) {
    if (isWS(src[i])) { i++; continue }
    const j = at(i)
    if (j > i) {
      if (src[i] === '/' || src[i] === '#') { i = j; continue }     // comment → gap
      out.push({ start: i, end: j, k: src.slice(i, j) }); i = j; continue // string → one token
    }
    const c = src[i]
    if (/[A-Za-z_$]/.test(c)) { let e = i + 1; while (e < n && /[\w$]/.test(src[e])) e++; out.push({ start: i, end: e, k: src.slice(i, e) }); i = e; continue }
    if (/[0-9]/.test(c)) { let e = i + 1; while (e < n && /[\w.]/.test(src[e])) e++; out.push({ start: i, end: e, k: src.slice(i, e) }); i = e; continue }
    out.push({ start: i, end: i + 1, k: c }); i++
  }
  return out
}

// Is this token a REFERENCE-position identifier (not property access `.name`)?
function isRefToken(src, t) {
  if (!/^[A-Za-z_$][\w$]*$/.test(t.k)) return false
  let p = t.start - 1
  while (p >= 0 && isWS(src[p])) p--
  return !(p >= 0 && src[p] === '.')
}

// Approximate parse check: delimiters balanced and no unterminated string/comment,
// ignoring the contents of strings and comments.
function balanced(src, strings) {
  const at = scannerAt(src, strings)
  const stack = []
  let cpp = 0            // #if/#ifdef/#ifndef nesting depth
  let lineStart = true   // only whitespace seen so far on this line
  let i = 0
  while (i < src.length) {
    const s = at(i)
    if (s > i) { if (s > src.length) return false; i = s; lineStart = false; continue }
    const c = src[i]
    if (OPEN[c]) stack.push(c)
    else if (CLOSE[c]) { if (stack.pop() !== CLOSE[c]) return false }
    // PREPROCESSOR NESTING. Brace balance alone cannot see a dropped `#endif`: the merged
    // text stays perfectly brace-balanced while the conditional structure is broken, so the
    // gate passed and invalid C shipped as clean. Directives are matched only at the start
    // of a line, so `#[derive]`, `#region` and `#` inside strings/comments are unaffected
    // (strings and comments are skipped by the scanner above).
    else if (c === '#' && lineStart) {
      const rest = src.slice(i + 1, i + 12).replace(/^\s+/, '')
      if (/^(ifdef|ifndef|if)\b/.test(rest)) cpp++
      else if (/^endif\b/.test(rest)) { cpp--; if (cpp < 0) return false }
    }
    if (c === '\n') lineStart = true
    else if (c !== ' ' && c !== '\t' && c !== '\r') lineStart = false
    i++
  }
  return stack.length === 0 && cpp === 0
}

function makeBraceLanguage({ id, exts, strings = ['"', "'", '`'] }) {
  const provider = {
    id,
    exts,
    parses: (src) => balanced(String(src == null ? '' : src), strings),
    units: (src) => keyedUnits(topUnits(String(src), strings), String(src)),
    declaredNames: (src) => {
      const names = new Set()
      for (const u of keyedUnits(topUnits(String(src), strings), String(src))) {
        const m = u.key.match(/^(?:[a-z]+):([A-Za-z_$][\w$]*)/)
        if (m && !u.key.startsWith('stmt:')) names.add(m[1])
      }
      return names
    },
    parsesUnit: (src) => balanced(String(src), strings),
    // --- intent layer (heuristic but honest): dangling refs, rename, token merge ---
    // Every identifier used in reference position (skips `.property` access). Approximate
    // and OVER-inclusive — which only ever makes the dangling check MORE cautious: a
    // deleted-but-still-referenced name is surfaced as a conflict, never shipped broken.
    usedIdentifiers: (src) => {
      src = String(src)
      const used = new Set()
      for (const t of lexTokens(src, strings)) if (isRefToken(src, t)) used.add(t.k)
      return used
    },
    // The declaration's text with its own name excluded, so two declarations that differ
    // only in their name compare equal — that's how the engine spots a rename.
    declBody: (src, name) => {
      src = String(src)
      for (const u of keyedUnits(topUnits(src, strings), src)) {
        const m = u.key.match(/^([a-z]+):(.+?)(?:#\d+)?$/)
        if (!m || m[1] === 'stmt' || m[2] !== name) continue
        return u.text.replace(name, '').trimEnd() // trailing whitespace must not defeat the rename match
      }
      return null
    },
    // Rewrite reference-position uses of oldName (never `.oldName` property access).
    // Back-to-front so offsets stay valid. The engine only accepts the rewrite if the
    // result still passes parses(), so a bad rewrite can't ship.
    renameRefs: (src, oldName, newName) => {
      src = String(src)
      const spots = []
      for (const t of lexTokens(src, strings)) if (t.k === oldName && isRefToken(src, t)) spots.push(t)
      let out = src
      for (const t of spots.reverse()) out = out.slice(0, t.start) + newName + out.slice(t.end)
      return out
    },
    // Finest granularity: token stream for the engine's token-level inner merge.
    tokenize: (src) => lexTokens(String(src), strings),
    // Finer granularity: descend one level into a block declaration so two agents
    // editing DIFFERENT members of the same class/function merge instead of clashing.
    splitUnit: (text) => {
      const src = String(text)
      // Only descend into NAMED containers (class/struct/impl/…), whose members are
      // keyed by name — so editing different members merges. A function/method body is
      // just statements (no stable keys); descending there would falsely merge two
      // edits to the same code, so we DON'T — the whole unit becomes a clean conflict.
      if (!/\b(class|interface|struct|enum|trait|impl|namespace|module|object|record|extension|protocol|actor)\b/.test(src.split('{')[0]))
        return null
      const at = scannerAt(src, strings)
      let i = 0, open = -1
      while (i < src.length) { const s = at(i); if (s > i) { i = s; continue } if (src[i] === '{') { open = i; break } i++ }
      if (open < 0) return null
      // find matching close
      let depth = 0, j = open, close = -1
      while (j < src.length) { const s = at(j); if (s > j) { j = s; continue } const c = src[j]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { close = j; break } } j++ }
      if (close < 0) return null
      const sig = src.slice(0, open)
      const body = src.slice(open + 1, close)
      const inner = keyedUnits(topUnits(body, strings), body)
      // inner ranges are already in `body` coordinates (topUnits scanned body). spliceable:
      // the engine rebuilds the body by splicing merged members back into it, so the class's
      // original indentation and any comments between members survive (no brace-glue reflow).
      return { sig, open: '{', close: src.slice(close), body, units: inner, join: '\n', spliceable: true }
    },
  }
  return provider
}

// Ready-made providers covering the common C-family languages. One provider can claim
// many extensions; comment/string syntax defaults fit the whole family (edge cases like
// Rust raw strings / lifetimes are tolerated — worst case a unit is merged coarsely).
const braceLanguages = [
  makeBraceLanguage({ id: 'ts', exts: ['.ts', '.tsx', '.mts', '.cts'] }),
  makeBraceLanguage({ id: 'jsx', exts: ['.jsx'] }),
  makeBraceLanguage({ id: 'go', exts: ['.go'], strings: ['"', '`'] }),
  makeBraceLanguage({ id: 'rust', exts: ['.rs'] }),
  makeBraceLanguage({ id: 'java', exts: ['.java'] }),
  makeBraceLanguage({ id: 'c', exts: ['.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx'] }),
  makeBraceLanguage({ id: 'csharp', exts: ['.cs'] }),
  makeBraceLanguage({ id: 'swift', exts: ['.swift'] }),
  makeBraceLanguage({ id: 'kotlin', exts: ['.kt', '.kts'] }),
  makeBraceLanguage({ id: 'scala', exts: ['.scala'] }),
  makeBraceLanguage({ id: 'php', exts: ['.php'] }),
  makeBraceLanguage({ id: 'dart', exts: ['.dart'] }),
]

  return { braceLanguages }
})()

const { python } = (function () {
// Python language provider for ICR — indentation-based structural splitter.
// Implements the ICR provider contract { id, exts, parses, units, declaredNames,
// splitUnit, parsesUnit } so the shared merge engine merges Python by structure:
// top-level defs/classes/statements are units keyed by name; editing different
// methods of the same class merges via splitUnit. Heuristic (tracks #-comments,
// triple-quoted and normal strings, bracket depth) — not a full parser; parses()
// is an approximate balanced-delimiter check.

function scannerAt(src) {
  const n = src.length
  return function at(i) {
    if (src[i] === '#') { let j = i + 1; while (j < n && src[j] !== '\n') j++; return j }
    for (const q of ['"""', "'''"]) if (src.startsWith(q, i)) { let j = i + 3; while (j < n && !src.startsWith(q, j)) { if (src[j] === '\\') j++; j++ } return Math.min(n, j + 3) }
    if (src[i] === '"' || src[i] === "'") { const q = src[i]; let j = i + 1; while (j < n) { if (src[j] === '\\') { j += 2; continue } if (src[j] === q) { j++; break } if (src[j] === '\n') break; j++ } return j }
    return -1
  }
}

// Line records: { start, end (incl newline), indent, blank, text }
function lines(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    let e = src.indexOf('\n', i); if (e < 0) e = src.length; else e = e + 1
    const raw = src.slice(i, e)
    const trimmed = raw.replace(/\r?\n$/, '')
    let indent = 0; while (indent < trimmed.length && (trimmed[indent] === ' ' || trimmed[indent] === '\t')) indent++
    const blank = trimmed.trim() === '' || trimmed.trim().startsWith('#')
    out.push({ start: i, end: e, indent, blank, text: raw })
    i = e
  }
  return out
}

const HEAD = /^\s*(?:async\s+def|def)\s+([A-Za-z_]\w*)/
const CLS = /^\s*class\s+([A-Za-z_]\w*)/
// Continuation clauses of a COMPOUND statement. They are not independent statements —
// an `else:` only means something relative to its `if`/`for`/`try` — so blocks() must
// attach them to the preceding unit. Keying them separately let two sides' restructured
// if/else halves interleave into adjacent dangling `else:` blocks (ConGra, transformers
// file_utils.py: output had `else:` twice in a row — ast-invalid, heuristics blind).
const COMPOUND_CONT = /^\s*(?:else\b|elif\b|except\b|finally\b)/

function keyOf(text) {
  let m = text.match(HEAD); if (m) return 'def:' + m[1]
  m = text.match(CLS); if (m) return 'class:' + m[1]
  return 'stmt:' + text.split('\n')[0].trim().replace(/\s+/g, ' ')
}

// Split src into units whose heads sit at exactly `base` indentation. A def/class
// head owns the following blank + more-indented lines (its body). A run of leading
// @decorator lines attaches to the head that follows. Everything else is a
// one-logical-line statement (continued while bracket depth > 0).
function blocks(src, base = 0) {
  const L = lines(src)
  const at = scannerAt(src)
  const units = []
  let i = 0
  // find bracket depth over a line range (to keep continued statements together)
  const bracketDelta = (s, e) => {
    let d = 0, k = s
    while (k < e) { const j = at(k); if (j > k) { k = j; continue } const c = src[k]; if (c === '(' || c === '[' || c === '{') d++; else if (c === ')' || c === ']' || c === '}') d--; k++ }
    return d
  }
  while (i < L.length) {
    while (i < L.length && L[i].text.trim() === '') i++ // skip ONLY pure blank lines, NOT comments
    if (i >= L.length) break
    if (L[i].indent !== base) { // stray deeper line (shouldn't happen at top) — treat as its own stmt
      const s = L[i].start; let e = L[i].end; i++
      units.push({ start: s, end: e })
      continue
    }
    const start = L[i].start
    // consume leading decorators
    let isDecorator = /^\s*@/.test(L[i].text)
    while (i < L.length && L[i].indent === base && /^\s*@/.test(L[i].text)) i++
    const headIdx = i
    const head = i < L.length ? L[i] : null
    if (head && (HEAD.test(head.text) || CLS.test(head.text) || isDecorator)) {
      // a block: consume the header line, then its body (blank or deeper-indented lines)
      i++ // header line
      while (i < L.length && (L[i].blank || L[i].indent > base)) i++
      // Trailing PURE-BLANK lines are GAP text, not part of the unit — if the unit owned
      // them, appending a new unit after the last one would mutate the last unit's text
      // and raise a false same-key conflict (found by multilang fuzz). Trailing comments
      // stay attached (comment-attachment convention).
      let last = i - 1
      while (last > headIdx && L[last].text.trim() === '') last--
      units.push({ start, end: L[last].end })
    } else if (head) {
      // simple statement: consume continued lines while bracket depth remains open
      let e = head.end, depth = bracketDelta(head.start, head.end); i++
      while (i < L.length && (depth > 0 || /\\\s*$/.test(L[i - 1].text.replace(/\r?\n$/, '')))) { depth += bracketDelta(L[i].start, L[i].end); e = L[i].end; i++ }
      // COMPOUND statement (if/for/while/try/with/else/…): the logical line ends with ':',
      // so this header OWNS its indented body — one unit, like def/class. Without this the
      // body lines become stray per-line units and the clause structure can't survive a
      // structured merge coherently.
      const logicalEndsColon = (() => {
        const at = scannerAt(src)
        let lastC = '', k = start
        while (k < e) { const j = at(k); if (j > k) { if (src[k] !== '#') lastC = 's'; k = Math.min(e, j); continue } const c = src[k]; if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') lastC = c; k++ }
        return lastC === ':'
      })()
      if (logicalEndsColon) {
        const bodyHead = i - 1
        while (i < L.length && (L[i].blank || L[i].indent > base)) i++
        let last = i - 1
        while (last > bodyHead && L[last].text.trim() === '') last--
        e = L[last].end
      }
      // Continuation clause (else/elif/except/finally): not an independent statement —
      // extend the PREVIOUS unit so the whole compound statement is one mergeable unit.
      if (COMPOUND_CONT.test(head.text) && units.length) units[units.length - 1].end = e
      else units.push({ start, end: e })
    }
  }
  return units
}

function keyed(raw, src) {
  const seen = new Map(), out = []
  for (const u of raw) {
    const text = src.slice(u.start, u.end)
    let k = keyOf(text)
    const c = (seen.get(k) || 0) + 1; seen.set(k, c)
    if (c > 1) k += '#' + c
    out.push({ key: k, text, start: u.start, end: u.end })
  }
  return out
}

function balanced(src) {
  const at = scannerAt(src)
  const stack = []
  const pair = { ')': '(', ']': '[', '}': '{' }
  let i = 0
  while (i < src.length) {
    const j = at(i); if (j > i) { if (j > src.length) return false; i = j; continue }
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') stack.push(c)
    else if (pair[c]) { if (stack.pop() !== pair[c]) return false }
    i++
  }
  return stack.length === 0
}

// INDENTATION validity — the half of Python syntax that delimiter balance cannot see.
// Walks LOGICAL lines (joining bracket continuations, backslash continuations, and
// multi-line strings) and enforces Python's block rules: a line ending with ':' must
// open a deeper-indented block; an indent may only appear after such an opener; every
// dedent must land on an indent level already on the stack. This is what lets parses()
// refuse a merge that spliced statements into the wrong block — balance alone passes it.
// The first line's indent is taken as the baseline so unit fragments validate too.
function indentsOk(src) {
  const at = scannerAt(src)
  const n = src.length
  let stack = null // [indent levels]; seeded from the first logical line
  let i = 0, prevOpened = false
  while (i < n) {
    let indent = 0
    while (i < n && (src[i] === ' ' || src[i] === '\t')) { indent++; i++ }
    if (i >= n) break
    if (src[i] === '\r' || src[i] === '\n') { i++; continue }              // blank line
    if (src[i] === '#') { i = Math.min(n, at(i)); continue }               // comment-only line
    if (stack == null) stack = [indent]                                     // baseline (fragment-friendly)
    if (prevOpened) {
      if (indent <= stack[stack.length - 1]) return false                   // ':' promised a block; none came
      stack.push(indent)
    } else if (indent > stack[stack.length - 1]) {
      return false                                                          // indent without an opener
    } else if (indent < stack[stack.length - 1]) {
      while (stack.length > 1 && stack[stack.length - 1] > indent) stack.pop()
      if (stack[stack.length - 1] !== indent) return false                  // dedent to a level never opened
    }
    // scan to the end of this LOGICAL line (brackets, backslash, strings span physical lines)
    let depth = 0, last = ''
    while (i < n) {
      const j = at(i)
      if (j > i) { if (src[i] !== '#') last = 's'; i = Math.min(n, j); continue } // string counts as content; comment doesn't
      const c = src[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') depth--
      if (c === '\n') {
        if (depth > 0 || last === '\\') { if (last === '\\') last = ''; i++; continue } // continuation
        i++; break
      }
      if (c !== ' ' && c !== '\t' && c !== '\r') last = c
      i++
    }
    prevOpened = last === ':'
  }
  return !prevOpened // must not end still promising a block
}

// Generic lexer for the token-level inner merge + the intent layer. Identifiers,
// numbers, whole strings are tokens; comments live in the gaps (a comment-only edit
// is a no-op at this tier, same contract as the JS provider).
function lexTokens(src) {
  const at = scannerAt(src)
  const out = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue }
    const j = at(i)
    if (j > i) {
      if (c === '#') { i = j; continue }                                    // comment → gap
      out.push({ start: i, end: j, k: src.slice(i, j) }); i = j; continue   // string → one token
    }
    if (/[A-Za-z_]/.test(c)) { let e = i + 1; while (e < n && /\w/.test(src[e])) e++; out.push({ start: i, end: e, k: src.slice(i, e) }); i = e; continue }
    if (/[0-9]/.test(c)) { let e = i + 1; while (e < n && /[\w.]/.test(src[e])) e++; out.push({ start: i, end: e, k: src.slice(i, e) }); i = e; continue }
    out.push({ start: i, end: i + 1, k: c }); i++
  }
  return out
}

// Token stream for the token-level MERGE tier, in an indentation language. Unlike
// lexTokens (used by the intent layer, where whitespace is noise), this emits a NEWLINE
// token for every real line break — a statement boundary. Without it a token splice can
// weld two statements onto one physical line (`x = f(y)if z:`), which balance+indent
// checks read as a single logical line and wrongly accept — a parse-guarantee violation
// found by the ConGra corpus (ast.parse rejects it). With newlines as tokens, any spliced
// run that crosses a line carries its break, so statements can never fuse. Newlines inside
// strings/comments stay inside those tokens; a bare `\n` between brackets is still emitted
// (harmless: it only ever makes the token diff finer, never coarser).
function lexTokensNL(src) {
  const at = scannerAt(src)
  const out = []
  const n = src.length
  let i = 0, depth = 0, contBackslash = false
  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      // Emit a NEWLINE token only at a real statement boundary: not inside brackets, not
      // after a line-continuation backslash. Inside brackets a newline is insignificant
      // (like whitespace) — emitting it there corrupts multi-line-call token interleaving.
      if (depth === 0 && !contBackslash) out.push({ start: i, end: i + 1, k: '\n' })
      contBackslash = false; i++; continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    const j = at(i)
    if (j > i) {
      contBackslash = false
      if (c === '#') { i = j; continue }
      out.push({ start: i, end: j, k: src.slice(i, j) }); i = j; continue
    }
    if (c === '\\') { contBackslash = true; i++; continue }
    contBackslash = false
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (depth > 0) depth-- }
    if (/[A-Za-z_]/.test(c)) { let e = i + 1; while (e < n && /\w/.test(src[e])) e++; out.push({ start: i, end: e, k: src.slice(i, e) }); i = e; continue }
    if (/[0-9]/.test(c)) { let e = i + 1; while (e < n && /[\w.]/.test(src[e])) e++; out.push({ start: i, end: e, k: src.slice(i, e) }); i = e; continue }
    out.push({ start: i, end: i + 1, k: c }); i++
  }
  return out
}

// Reference-position identifier (not attribute access `.name`)?
function isRefToken(src, t) {
  if (!/^[A-Za-z_]\w*$/.test(t.k)) return false
  let p = t.start - 1
  while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--
  return !(p >= 0 && src[p] === '.')
}

// --- scope-aware reference analysis ---------------------------------------------
//
// WHY THIS IS EXACT AND NOT ANOTHER HEURISTIC. Python binds by assignment: a name
// assigned anywhere in a function body is local to that function for the WHOLE body, and
// reading it before the assignment is an UnboundLocalError rather than a global read. So
// a function that assigns `helper` cannot also be referring to a module-level `helper` —
// the language forbids the mixed case. That is what makes subtracting local bindings safe
// here, where a plain "does this name appear anywhere" check has to stay over-cautious.
//
// WHAT IT FIXES. usedIdentifiers reports every name it sees, so deleting a top-level
// `helper` while some unrelated function happens to have a local named `helper` was
// reported as ref:helper — a merge refused that was perfectly safe, falling back to line
// merge with conflict markers. Common names (config, data, result, helper) trip this
// constantly. Reproduced in test/scope-repro.mjs before this existed.
//
// THE DIRECTION THAT MATTERS. Missing a REAL reference would let ICR delete something
// still in use — the one failure this library promises never to have — so every rule
// below fails towards "still referenced":
//   • module scope subtracts nothing, so top-level rebinding never hides a reference;
//   • a nested def is its own scope, never folded into its parent's bindings;
//   • a class body contributes no bindings at all (its names are attributes, invisible
//     to methods), so they stay free;
//   • `global`/`nonlocal` remove a name from the local set;
//   • subscript and attribute targets (`a[i] = `, `a.b = `) bind nothing — `a` must
//     already exist, so it stays a reference;
//   • anything unrecognised is left free.
const PY_KW = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for',
  'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'try', 'while', 'with', 'yield'])

const isName = (k) => /^[A-Za-z_]\w*$/.test(k) && !PY_KW.has(k)
const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])

// A target position binds only a bare name. `a[i] = x` and `a.b = x` require `a` to exist
// already, so they are reads, not bindings.
function bareTargets(toks, from, to, out) {
  for (let i = from; i < to; i++) {
    const t = toks[i]
    if (!isName(t.k)) continue
    const prev = toks[i - 1] && toks[i - 1].k
    const next = toks[i + 1] && toks[i + 1].k
    if (prev === '.' || next === '.' || next === '[' || next === '(') continue
    out.add(t.k)
  }
}

// Names this statement binds in its own scope, and names it explicitly disowns.
function stmtBindings(text) {
  const bind = new Set(), disown = new Set()
  const toks = lexTokens(text).filter((t) => t.k.trim() !== '')
  const kw = toks.length ? toks[0].k : ''

  if (kw === 'global' || kw === 'nonlocal') {
    for (const t of toks.slice(1)) if (isName(t.k)) disown.add(t.k)
    return { bind, disown }
  }

  if (kw === 'import' || kw === 'from') {
    // `import a.b as c` binds c; `import a.b` binds a; `from m import x, y as z`.
    const start = kw === 'from' ? toks.findIndex((t) => t.k === 'import') : 0
    if (start >= 0) {
      for (let i = start + 1; i < toks.length; i++) {
        if (toks[i].k === 'as' && isName((toks[i + 1] || {}).k)) { bind.add(toks[i + 1].k); i++; continue }
        // first segment of a dotted path, and only when not renamed by a later `as`
        if (isName(toks[i].k) && (toks[i - 1] || {}).k !== '.' &&
            (toks[i + 1] || {}).k !== '.' && (toks[i + 1] || {}).k !== 'as') bind.add(toks[i].k)
        else if (isName(toks[i].k) && (toks[i + 1] || {}).k === '.' && kw === 'import') bind.add(toks[i].k)
      }
    }
    return { bind, disown }
  }

  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i].k
    if (OPEN.has(k)) { depth++; continue }
    if (CLOSE.has(k)) { depth--; continue }

    // `for <targets> in` — at any depth, so comprehensions bind too.
    if (k === 'for') {
      let j = i + 1
      while (j < toks.length && toks[j].k !== 'in') j++
      bareTargets(toks, i + 1, j, bind)
      i = j
      continue
    }
    // `with x as name`, `except E as name`
    if (k === 'as' && isName((toks[i + 1] || {}).k)) { bind.add(toks[i + 1].k); i++; continue }

    if (k !== '=') continue
    const prev = (toks[i - 1] || {}).k
    const next = (toks[i + 1] || {}).k
    if (next === '=') { i++; continue }                       // ==
    if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue
    if (depth > 0) {
      // Inside brackets `=` is a keyword argument, except for the walrus `:=`.
      if (prev === ':' && isName((toks[i - 2] || {}).k)) bind.add(toks[i - 2].k)
      continue
    }
    // Statement-level assignment: simple, augmented (`+=`, prev is an operator), or
    // annotated (`x: int = 1`). Everything left of it is the target list.
    bareTargets(toks, 0, i, bind)
    break
  }
  return { bind, disown }
}

function refsIn(text, emit) {
  for (const t of lexTokens(text)) if (isName(t.k) && isRefToken(text, t)) emit(t.k)
}

// Parameter names of a def header — used as bindings of the CHILD scope, and excluded
// from the header's own references so a parameter is never mistaken for a free name.
function defParams(header) {
  const toks = lexTokens(header).filter((t) => t.k.trim() !== '')
  const open = toks.findIndex((t) => t.k === '(')
  if (open < 0) return new Set()
  const params = new Set()
  let depth = 0
  for (let i = open; i < toks.length; i++) {
    const k = toks[i].k
    if (OPEN.has(k)) { depth++; continue }
    if (CLOSE.has(k)) { depth--; if (depth === 0) break; continue }
    if (depth !== 1 || !isName(k)) continue
    const prev = (toks[i - 1] || {}).k
    if (prev === '(' || prev === ',' || prev === '*' || prev === '**') params.add(k)
  }
  return params
}

// Split a def/class unit into the part evaluated in the ENCLOSING scope (decorators and
// the header line — where default values and base classes live) and the body, which is
// its own scope.
function splitDeclUnit(text) {
  const L = lines(text)
  let h = 0
  while (h < L.length && (L[h].blank || /^\s*@/.test(L[h].text))) h++
  if (h >= L.length) return null
  const head = L[h]
  const isDef = HEAD.test(head.text), isCls = CLS.test(head.text)
  if (!isDef && !isCls) return null
  // A signature can span lines while its brackets are open.
  let e = h
  let depth = 0
  do {
    for (const ch of L[e].text) { if (OPEN.has(ch)) depth++; else if (CLOSE.has(ch)) depth-- }
    e++
  } while (e < L.length && depth > 0)
  const header = text.slice(0, L[e - 1].end)
  let b = e
  while (b < L.length && L[b].blank) b++
  const body = b < L.length ? text.slice(L[b].start) : ''
  return { isDef, header, body, bodyIndent: b < L.length ? L[b].indent : 0 }
}

// Walk one scope's statements, descending through compound bodies (same scope) but
// stopping at def/class (new scope).
function scopeParts(code, base, onStmt, onDecl) {
  for (const u of blocks(code, base)) {
    const text = code.slice(u.start, u.end)
    if (splitDeclUnit(text)) { onDecl(text); continue }
    const L = lines(text)
    let b = 1
    while (b < L.length && L[b].blank) b++
    if (b < L.length && L[b].indent > base) {
      onStmt(text.slice(0, L[b].start))                    // the `if ...:` / `for ...:` head
      scopeParts(text.slice(L[b].start), L[b].indent, onStmt, onDecl)
    } else onStmt(text)
  }
}

// `subtract` is false at module scope: a module-level rebinding must never hide a
// reference to the declaration being deleted.
function scopeFree(code, base, enclosing, free, subtract) {
  const stmts = [], decls = []
  scopeParts(code, base, (t) => stmts.push(t), (t) => decls.push(t))

  const local = new Set(), disowned = new Set()
  for (const t of stmts) {
    const { bind, disown } = stmtBindings(t)
    for (const n of bind) local.add(n)
    for (const n of disown) disowned.add(n)
  }
  for (const t of decls) {
    const s = splitDeclUnit(t)
    const m = s && (s.header.match(HEAD) || s.header.match(CLS))
    if (m) local.add(m[1])
  }
  for (const n of disowned) local.delete(n)

  const bound = subtract ? new Set([...enclosing, ...local]) : new Set(enclosing)
  for (const t of stmts) refsIn(t, (n) => { if (!bound.has(n)) free.add(n) })

  for (const t of decls) {
    const s = splitDeclUnit(t)
    if (!s) continue
    const params = s.isDef ? defParams(s.header) : new Set()
    const declName = (s.header.match(HEAD) || s.header.match(CLS) || [])[1]
    // Decorators, annotations and default values run in THIS scope.
    refsIn(s.header, (n) => {
      if (n === declName || params.has(n) || bound.has(n)) return
      free.add(n)
    })
    if (!s.body) continue
    // A class body contributes no bindings to anything nested inside it, so its methods
    // are analysed against the enclosing scope only. `subtract: s.isDef` is the whole of
    // that rule and it is load-bearing: with subtraction left on for a class, `helper = 9`
    // at class level became a binding the methods inherited, and a real `helper()` call
    // inside a method stopped being reported — a merge shipped with a dangling reference,
    // caught by the safety case in test/scope-repro.mjs. Class attributes are reached as
    // `self.helper` or `C.helper`, never as a bare name, so they must never shadow.
    scopeFree(s.body, s.bodyIndent,
              s.isDef ? new Set([...bound, ...params]) : bound, free, s.isDef)
  }
}

// PER-STATEMENT bracket nesting — the soundness backstop the whole-file `balanced()`
// (global) and `indentsOk()` (indentation) both miss. A token merge can splice a result
// that is GLOBALLY balanced yet LOCALLY mis-nested: side A reformats `f(x)` to span lines
// and a concurrent edit detaches the `)`, so `( ... { ... )` lands in one statement and a
// stray `)` balances the count elsewhere. In VALID Python every logical statement is
// independently balanced AND properly nested, so we check exactly that: segment the token
// stream at depth-0 NEWLINE tokens (which lexTokensNL only emits between statements) and
// require each segment's brackets to nest correctly. Sound — it never rejects valid Python
// — and it closes the token-merge corruption class the ConGra corpus exposed via ast.parse.
function stmtBracketsOk(src) {
  const pair = { ')': '(', ']': '[', '}': '{' }
  let stack = []
  for (const t of lexTokensNL(src)) {
    if (t.k === '\n') { if (stack.length) return false; continue } // statement boundary: must be closed
    if (t.k === '(' || t.k === '[' || t.k === '{') stack.push(t.k)
    else if (pair[t.k]) { if (stack.pop() !== pair[t.k]) return false }
  }
  return stack.length === 0
}

const python = {
  id: 'python',
  exts: ['.py', '.pyi'],
  parses: (src) => { const s = String(src == null ? '' : src); return balanced(s) && stmtBracketsOk(s) && indentsOk(s) },
  parsesUnit: (src) => { const s = String(src); return balanced(s) && indentsOk(s) },
  units: (src) => keyed(blocks(String(src), 0), String(src)),
  declaredNames: (src) => {
    const names = new Set()
    for (const u of keyed(blocks(String(src), 0), String(src))) {
      const m = u.key.match(/^(?:def|class):([A-Za-z_]\w*)/)
      if (m) names.add(m[1])
    }
    return names
  },
  // --- intent layer (heuristic but honest): dangling refs, rename, token merge ---
  // Every identifier used in reference position (skips `.attribute` access). Approximate
  // and OVER-inclusive — which only makes the dangling check MORE cautious: a deleted-
  // but-still-referenced def/class is surfaced as a conflict, never shipped broken.
  usedIdentifiers: (src) => {
    src = String(src)
    const used = new Set()
    for (const t of lexTokens(src)) if (isRefToken(src, t)) used.add(t.k)
    return used
  },
  // Scope-aware upgrade of the above — the engine prefers this for the dangling-reference
  // check (icr.js). Names that resolve to a LOCAL binding are not reported, so a deleted
  // top-level `helper` is no longer held hostage by an unrelated local of the same name.
  // Kept alongside usedIdentifiers rather than replacing it: the approximate version is
  // still the honest answer for anything this cannot resolve.
  referencedFreeNames: (src) => {
    const free = new Set()
    scopeFree(String(src), 0, new Set(), free, false)
    return free
  },
  // The def/class text with its own name excluded, so renamed twins compare equal.
  // trimEnd(): a unit owns its trailing blank lines, and splicing can change how many
  // survive — trailing whitespace must not defeat the rename match.
  declBody: (src, name) => {
    src = String(src)
    for (const u of keyed(blocks(src, 0), src)) {
      const m = u.key.match(/^(?:def|class):([A-Za-z_]\w*)/)
      if (!m || m[1] !== name) continue
      return u.text.replace(name, '').trimEnd()
    }
    return null
  },
  // Rewrite reference-position uses of oldName (never `.oldName` attribute access).
  // The engine only accepts the rewrite if the result still passes parses().
  renameRefs: (src, oldName, newName) => {
    src = String(src)
    const spots = []
    for (const t of lexTokens(src)) if (t.k === oldName && isRefToken(src, t)) spots.push(t)
    let out = src
    for (const t of spots.reverse()) out = out.slice(0, t.start) + newName + out.slice(t.end)
    return out
  },
  // Finest granularity: token stream for the token-level inner merge. NEWLINE-aware
  // (lexTokensNL) so a token splice can never weld two statements onto one line — the
  // parse guarantee holds even where the indentation heuristic alone would be fooled.
  tokenize: (src) => lexTokensNL(String(src)),
  // Descend into a class/def body so two agents editing DIFFERENT methods merge.
  splitUnit: (text) => {
    const src = String(text)
    const L = lines(src)
    let h = 0; while (h < L.length && (L[h].blank || /^\s*@/.test(L[h].text))) h++
    if (h >= L.length) return null
    // Only descend into a CLASS (named methods → mergeable). A def body is bare
    // statements with no stable keys; descending would falsely merge two edits to the
    // same function, so we don't — same-def edits become a clean conflict instead.
    if (!CLS.test(L[h].text)) return null
    const headEnd = L[h].end
    // body = everything after the header line; its base indent is the first body line's indent
    let b = h + 1; while (b < L.length && L[b].blank) b++
    if (b >= L.length) return null
    const bodyIndent = L[b].indent
    const sig = src.slice(0, headEnd)
    const body = src.slice(headEnd)
    const inner = keyed(blocks(body, bodyIndent), body)
    // spliceable: inner units carry byte ranges in `body`, so the engine rebuilds the
    // class body by splicing merged methods back in — comments/blank lines between
    // methods survive verbatim instead of being reflowed by a join.
    return { sig, open: '', close: '', body, units: inner, join: '', spliceable: true }
  },
}

  return { python }
})()

const { ruby } = (function () {
// Ruby language provider for ICR — keyword-nesting structural splitter (def/class/
// module … end). Same honest-heuristic contract as the brace/python providers: not a
// full parser, but conservative — anything it can't confidently structure falls back
// to the engine's safe line tier, so output is never MORE broken than the inputs.
//
// Structure model: a line-oriented scan tracking strings, comments (# and =begin/=end),
// bracket depth, and KEYWORD depth (def/class/module/if/while/… open; `end` closes).
// Top-level def/class/module blocks become keyed units; the intent layer (dangling
// refs, rename + call-site rewrite, token merge) rides on a lexer like Python's.

function scannerAt(src) {
  const n = src.length
  return function at(i) {
    if (src[i] === '#') { let j = i + 1; while (j < n && src[j] !== '\n') j++; return j }
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i]; let j = i + 1
      while (j < n) { if (src[j] === '\\') { j += 2; continue } if (src[j] === q) { j++; break } j++ }
      return j
    }
    return -1
  }
}

// Per physical line: the line's CODE text (strings/comments blanked), its bracket
// delta, and byte range. =begin/=end block comments are whole-line constructs.
function codeLines(src) {
  const at = scannerAt(src)
  const out = []
  let i = 0, inBlockComment = false
  const n = src.length
  while (i < n) {
    let e = src.indexOf('\n', i); e = e < 0 ? n : e + 1
    const raw = src.slice(i, e)
    if (inBlockComment) {
      if (/^=end\b/.test(raw)) inBlockComment = false
      out.push({ start: i, end: e, code: '', brackets: 0 })
      i = e; continue
    }
    if (/^=begin\b/.test(raw)) { inBlockComment = true; out.push({ start: i, end: e, code: '', brackets: 0 }); i = e; continue }
    let code = '', k = i, brackets = 0
    while (k < e) {
      const j = at(k)
      if (j > k) { if (src[k] !== '#') code += ' '; k = Math.min(e, j); continue }
      const c = src[k]
      if (c === '(' || c === '[' || c === '{') brackets++
      else if (c === ')' || c === ']' || c === '}') brackets--
      code += c; k++
    }
    out.push({ start: i, end: e, code, brackets })
    i = e
  }
  return out
}

// Keyword depth delta for one line of CODE. Conservative rules for the ambiguous
// keywords (modifier `x if y` does not open; `while … do` opens once, not twice;
// endless `def foo = expr` does not open).
const OPENERS = new Set(['if', 'unless', 'while', 'until', 'case', 'begin', 'for'])
function keywordDelta(code) {
  const words = code.match(/[A-Za-z_]\w*[?!]?/g) || []
  let d = 0
  const trimmed = code.trim()
  const endless = /\bdef\s+[A-Za-z_][\w.?!]*(\([^)]*\))?\s*=(?!=)/.test(code)
  const hasLoop = /\b(while|until|for)\b/.test(code)
  for (let w = 0; w < words.length; w++) {
    const word = words[w]
    if (word === 'def') { if (!endless) d++ }
    else if (word === 'class' || word === 'module') d++
    else if (OPENERS.has(word)) {
      // statement position only: first word of the line, or right after an assignment
      const isFirst = trimmed.startsWith(word)
      const afterAssign = new RegExp('=\\s*' + word + '\\b').test(code)
      if (word === 'while' || word === 'until' || word === 'for') { if (isFirst) d++ }
      else if (isFirst || afterAssign) d++
    }
    else if (word === 'do') { if (!hasLoop) d++ }
    else if (word === 'end') d--
  }
  return d
}

const HEAD = /^\s*(def)\s+(self\.)?([A-Za-z_][\w.?!]*)/
const CONT = /^\s*(class|module)\s+(?:<<\s*self|([A-Z]\w*(?:::[A-Z]\w*)*))/

function keyOf(text) {
  let m = text.match(HEAD); if (m) return 'def:' + (m[2] || '') + m[3]
  m = text.match(CONT); if (m) return m[1] + ':' + (m[2] || 'self')
  return 'stmt:' + text.split('\n')[0].trim().replace(/\s+/g, ' ')
}

// Units over a region: a def/class/module head at keyword-depth 0 owns everything
// until its matching `end`; other depth-0 lines are statements (joined while
// brackets stay open).
function blocks(src) {
  const L = codeLines(src)
  const units = []
  let i = 0
  while (i < L.length) {
    while (i < L.length && L[i].code.trim() === '') i++
    if (i >= L.length) break
    const start = L[i].start
    const head = L[i].code
    if (/^\s*(def|class|module)\b/.test(head)) {
      let depth = 0, brackets = 0
      do {
        depth += keywordDelta(L[i].code)
        brackets += L[i].brackets
        i++
      } while (i < L.length && (depth > 0 || brackets > 0))
      units.push({ start, end: L[i - 1].end })
    } else {
      let brackets = L[i].brackets, depth = keywordDelta(L[i].code)
      i++
      while (i < L.length && (brackets > 0 || depth > 0)) { brackets += L[i].brackets; depth += keywordDelta(L[i].code); i++ }
      units.push({ start, end: L[i - 1].end })
    }
  }
  return units
}

function keyed(raw, src) {
  const seen = new Map(), out = []
  for (const u of raw) {
    const text = src.slice(u.start, u.end)
    let k = keyOf(text)
    const c = (seen.get(k) || 0) + 1; seen.set(k, c)
    if (c > 1) k += '#' + c
    out.push({ key: k, text, start: u.start, end: u.end })
  }
  return out
}

// Approximate parse: brackets balanced AND keyword nesting closes exactly
// (never negative, ends at zero) AND no unterminated block comment.
function wellNested(src) {
  const L = codeLines(src)
  let depth = 0, brackets = 0
  for (const l of L) {
    depth += keywordDelta(l.code)
    brackets += l.brackets
    if (depth < 0 || brackets < 0) return false
  }
  return depth === 0 && brackets === 0
}

// Lexer for the intent layer + token merge (comments in gaps, strings one token).
function lexTokens(src) {
  const at = scannerAt(src)
  const out = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue }
    const j = at(i)
    if (j > i) {
      if (c === '#') { i = j; continue }
      out.push({ start: i, end: j, k: src.slice(i, j) }); i = j; continue
    }
    if (/[A-Za-z_]/.test(c)) { let e = i + 1; while (e < n && /\w/.test(src[e])) e++; if (src[e] === '?' || src[e] === '!') e++; out.push({ start: i, end: e, k: src.slice(i, e) }); i = e; continue }
    if (/[0-9]/.test(c)) { let e = i + 1; while (e < n && /[\w.]/.test(src[e])) e++; out.push({ start: i, end: e, k: src.slice(i, e) }); i = e; continue }
    out.push({ start: i, end: i + 1, k: c }); i++
  }
  return out
}

// Reference position: not `.name` (method call on receiver) — `:name` symbols DO
// count (send(:helper) is a real reference; over-inclusion is the cautious direction).
function isRefToken(src, t) {
  if (!/^[A-Za-z_]\w*[?!]?$/.test(t.k)) return false
  let p = t.start - 1
  while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--
  return !(p >= 0 && src[p] === '.')
}

const ruby = {
  id: 'ruby',
  exts: ['.rb', '.rake'],
  parses: (src) => wellNested(String(src == null ? '' : src)),
  parsesUnit: (src) => wellNested(String(src)),
  units: (src) => keyed(blocks(String(src)), String(src)),
  declaredNames: (src) => {
    const names = new Set()
    for (const u of keyed(blocks(String(src)), String(src))) {
      const m = u.key.match(/^(?:def|class|module):(?:self\.)?([A-Za-z_][\w.?!]*)/)
      if (m) names.add(m[1])
    }
    return names
  },
  usedIdentifiers: (src) => {
    src = String(src)
    const used = new Set()
    for (const t of lexTokens(src)) if (isRefToken(src, t)) used.add(t.k)
    return used
  },
  declBody: (src, name) => {
    src = String(src)
    for (const u of keyed(blocks(src), src)) {
      const m = u.key.match(/^(?:def|class|module):(?:self\.)?([A-Za-z_][\w.?!]*)/)
      if (!m || m[1] !== name) continue
      return u.text.replace(name, '').trimEnd()
    }
    return null
  },
  renameRefs: (src, oldName, newName) => {
    src = String(src)
    const spots = []
    for (const t of lexTokens(src)) if (t.k === oldName && isRefToken(src, t)) spots.push(t)
    let out = src
    for (const t of spots.reverse()) out = out.slice(0, t.start) + newName + out.slice(t.end)
    return out
  },
  tokenize: (src) => lexTokens(String(src)),
  // Descend into a class/module so two agents editing DIFFERENT methods merge.
  splitUnit: (text) => {
    const src = String(text)
    if (!/^\s*(class|module)\b/.test(src)) return null
    const L = codeLines(src)
    if (!L.length) return null
    const sigEnd = L[0].end
    // body = everything between the header line and the final matching `end` line
    let last = L.length - 1
    while (last > 0 && L[last].code.trim() === '') last--
    if (!/^\s*end\b/.test(L[last].code)) return null
    const bodyStart = sigEnd, bodyEnd = L[last].start
    const body = src.slice(bodyStart, bodyEnd)
    const inner = keyed(blocks(body), body)
    return { sig: src.slice(0, sigEnd), open: '', close: src.slice(bodyEnd), body, units: inner, join: '', spliceable: true }
  },
}

  return { ruby }
})()

const { json } = (function () {
// JSON language provider for ICR — the one provider where the guarantee is PERFECT,
// because JSON.parse IS the real parser (no heuristics anywhere).
//
// JSON is the most-merged file type in a repository (package.json, tsconfig, lockfile
// fragments, CI configs), and the classic line-merge failure is two sides editing
// nearby keys — git conflicts or, worse, fuses into invalid JSON. ICR merges JSON as
// DATA: value-wise 3-way merge, keyed by object path, so:
//   • different keys edited on each side        -> clean merge, both kept
//   • the SAME path changed differently         -> semantic conflict naming the path
//     (surfaced as a machine-resolvable unit, so an agent judge can reconcile it)
//   • one side deletes a key the other changed  -> conflict (delete vs change)
//   • arrays: one-sided changes merge; both-sided changes merge when the edited
//     regions are DISJOINT (prefix/suffix diff — appends, prepends, middle inserts);
//     overlapping array edits are an honest conflict
// Output is serialized with the file's own indentation style (detected from the base)
// and preserves the trailing-newline convention, so diffs stay minimal.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y)

// PRECISION SAFETY GATE. The data merge re-serializes the whole document, which means
// every number goes through JS float64 — and that CORRUPTS values nobody touched:
// 9007199254740993 (beyond 2^53) silently loses a digit; 1e999 becomes Infinity and
// then `null`. Shipping a "clean" merge that corrupts untouched data is the cardinal
// sin, so: scan every number literal (string-aware); if ANY cannot survive the
// round-trip value-identically, refuse the data merge entirely — the engine falls back
// to the safe line tier, which never rewrites untouched bytes. (Found by the
// adversarial crucible, not by users — the way it should be.)
function numbersSafe(src) {
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '"') { i++; while (i < n) { if (src[i] === '\\') { i += 2; continue } if (src[i] === '"') { i++; break } i++ } continue }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1
      while (j < n && /[0-9eE+.-]/.test(src[j])) j++
      const tok = src.slice(i, j)
      const v = Number(tok)
      if (!Number.isFinite(v)) return false                                  // 1e999 → Infinity → null
      if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) return false // beyond 2^53
      const digits = tok.replace(/[^0-9]/g, '').replace(/^0+/, '')
      if (digits.length > 15 && !eq(Number(tok), Number(v.toPrecision(15)))) return false // >15 sig digits at risk
      i = j; continue
    }
    i++
  }
  return true
}

// Detect the base file's indent unit ('  ', '    ', '\t', …). Defaults to two spaces.
function detectIndent(src) {
  const m = /\n([ \t]+)\S/.exec(src)
  return m ? m[1] : '  '
}

// 3-way merge of two ARRAYS against base, by disjoint-region splice (the same
// prefix/suffix discipline the engine's token merge uses, on JSON-equal elements).
// Returns the merged array, or null for an overlapping (real) conflict.
function mergeArray(base, a, b) {
  const K = (arr) => arr.map((x) => JSON.stringify(x))
  const diffRange = (B, O) => {
    if (B.length === O.length && B.every((x, i) => x === O[i])) return null
    let p = 0
    const maxp = Math.min(B.length, O.length)
    while (p < maxp && B[p] === O[p]) p++
    let s = 0
    while (s < B.length - p && s < O.length - p && B[B.length - 1 - s] === O[O.length - 1 - s]) s++
    return { bStart: p, bEnd: B.length - s, oStart: p, oEnd: O.length - s }
  }
  const KB = K(base), ra = diffRange(KB, K(a)), rb = diffRange(KB, K(b))
  if (!ra) return b
  if (!rb) return a
  if (ra.bStart < rb.bEnd && rb.bStart < ra.bEnd) return null // overlapping regions
  if (ra.bStart === rb.bStart) return null                    // ambiguous same-point edits
  const edits = [
    { s: ra.bStart, e: ra.bEnd, ins: a.slice(ra.oStart, ra.oEnd) },
    { s: rb.bStart, e: rb.bEnd, ins: b.slice(rb.oStart, rb.oEnd) },
  ].sort((x, y) => y.s - x.s)
  let out = base.slice()
  for (const ed of edits) out.splice(ed.s, ed.e - ed.s, ...ed.ins)
  return out
}

// SYMMETRY. The merged object is re-serialized with JSON.stringify, which emits keys in
// INSERTION order — so the order we walk the key union IS the output byte order. The
// obvious union, `[...keys(base), ...keys(a), ...keys(b)]`, is side-ordered: ours's new
// keys always precede theirs's, so merge(base,a,b) and merge(base,b,a) produce clean
// 'auto' results that differ byte-for-byte. Measured at 43/167 auto merges (26%) by
// test/icr-data-torture-test.js. Semantically identical, but P2 SYMMETRY is asserted
// byte-wise for every other language (icr-torture-test.js), and byte-inequality is
// precisely what a CRDT peer and a git blob hash react to — the two consumers the README
// names. So the union order must not depend on which side is called `a`:
//   • keys present in base keep BASE's order (unchanged behaviour, minimal diffs);
//   • keys added by either side follow, ordered by where their own author put them
//     (min index across the sides that have it), ties broken by key name.
// Both rules are symmetric in a/b, so swapping the sides cannot change the output.
function unionKeys(base, a, b) {
  const rank = new Map()
  for (const obj of [a, b]) {
    const ks = Object.keys(obj)
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i]
      if (k in base) continue
      const prev = rank.get(k)
      if (prev === undefined || i < prev) rank.set(k, i)
    }
  }
  const added = [...rank.keys()].sort((x, y) => (rank.get(x) - rank.get(y)) || (x < y ? -1 : x > y ? 1 : 0))
  return [...Object.keys(base), ...added]
}

// Value-wise 3-way merge. Fills `conflicts` (path strings) and `resolvable`
// ({key, base, ours, theirs} with pretty-printed values) on same-path clashes;
// the merged value keeps BASE at conflicted paths (the engine refuses the whole
// merge when conflicts exist, so nothing partial ever ships).
function mergeVal(base, a, b, path, conflicts, resolvable) {
  if (eq(a, b)) return a
  if (eq(a, base)) return b
  if (eq(b, base)) return a
  if (isObj(base) && isObj(a) && isObj(b)) {
    const out = {}
    for (const k of unionKeys(base, a, b)) {
      const p = path ? path + '.' + k : k
      const inB = k in base, inA = k in a, inBb = k in b
      if (inB && !inA && !inBb) continue                                     // deleted on both sides
      if (inB && !inA) {                                                     // ours deleted it
        if (eq(b[k], base[k])) continue                                      // theirs untouched -> deletion wins
        conflicts.push(p); resolvable.push(resUnit(p, base[k], undefined, b[k])); continue
      }
      if (inB && !inBb) {                                                    // theirs deleted it
        if (eq(a[k], base[k])) continue
        conflicts.push(p); resolvable.push(resUnit(p, base[k], a[k], undefined)); continue
      }
      if (!inB && inA && inBb) {                                             // both added
        if (eq(a[k], b[k])) { out[k] = a[k]; continue }
        if (isObj(a[k]) && isObj(b[k])) { out[k] = mergeVal({}, a[k], b[k], p, conflicts, resolvable); continue }
        conflicts.push(p); resolvable.push(resUnit(p, undefined, a[k], b[k])); continue
      }
      if (!inB) { out[k] = inA ? a[k] : b[k]; continue }                     // one side added
      out[k] = mergeVal(base[k], a[k], b[k], p, conflicts, resolvable)       // present everywhere
    }
    return out
  }
  if (Array.isArray(base) && Array.isArray(a) && Array.isArray(b)) {
    const m = mergeArray(base, a, b)
    if (m) return m
    conflicts.push(path || '(root)'); resolvable.push(resUnit(path || '(root)', base, a, b))
    return base
  }
  conflicts.push(path || '(root)')                                            // scalar/shape clash
  resolvable.push(resUnit(path || '(root)', base, a, b))
  return base
}

const show = (v) => (v === undefined ? '(deleted)' : JSON.stringify(v, null, 2))
const resUnit = (p, base, ours, theirs) => ({ key: 'json:' + p, base: show(base), ours: show(ours), theirs: show(theirs) })

const json = {
  id: 'json',
  exts: ['.json'],
  parses: (src) => { try { JSON.parse(String(src == null ? '' : src)); return true } catch { return false } },
  // The engine's whole-document tier: merge the file as parsed data.
  mergeWhole: (base, a, b) => {
    if (!numbersSafe(base) || !numbersSafe(a) || !numbersSafe(b)) return null // precision hazard → safe fallback, never corrupt
    let B, A, Bb
    try { B = JSON.parse(base); A = JSON.parse(a); Bb = JSON.parse(b) } catch { return null }
    const conflicts = [], resolvable = []
    const merged = mergeVal(B, A, Bb, '', conflicts, resolvable)
    if (conflicts.length) return { conflicts, resolvable }
    const nl = /\n$/.test(base) || /\n$/.test(a) ? '\n' : ''
    return { text: JSON.stringify(merged, null, detectIndent(base)) + nl }
  },
  // Minimal unit view (whole document) so generic engine paths stay well-defined;
  // real merging happens in mergeWhole above.
  units: (src) => [{ key: 'doc', text: String(src), start: 0, end: String(src).length }],
  declaredNames: () => new Set(),
  // INTENT RESOLUTION for data: a conflicted unit's "text" is a rendering of a parsed
  // VALUE, so a judge's reconciliation is applied by setting the value at the unit's
  // path (key 'json:<path>'), not by string replacement. The reconciled string must
  // itself be valid JSON ('(deleted)' removes the key). Returns the re-serialized
  // document, or null when it can't apply — resolveMerge then falls back to the safe
  // conflict, so a malformed judgment never ships.
  applyResolution: (text, unit, reconciled) => {
    if (!unit || typeof unit.key !== 'string' || !unit.key.startsWith('json:')) return null
    if (!numbersSafe(text)) return null // same precision gate: never re-serialize a doc we'd corrupt
    let doc, value
    try { doc = JSON.parse(text) } catch { return null }
    const del = String(reconciled).trim() === '(deleted)'
    if (!del) { try { value = JSON.parse(reconciled) } catch { return null } }
    const path = unit.key.slice(5)
    if (path === '(root)' || path === '') {
      if (del) return null
      doc = value
    } else {
      const parts = path.split('.')
      let cur = doc
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur == null || typeof cur !== 'object') return null
        if (!(parts[i] in cur)) cur[parts[i]] = {}
        cur = cur[parts[i]]
      }
      if (cur == null || typeof cur !== 'object') return null
      const leaf = parts[parts.length - 1]
      if (del) delete cur[leaf]
      else cur[leaf] = value
    }
    const nl = /\n$/.test(text) ? '\n' : ''
    return JSON.stringify(doc, null, detectIndent(text)) + nl
  },
}

  return { json }
})()

const { yaml } = (function () {
// YAML language provider for ICR — indent-mapping structural splitter.
// YAML configs (CI pipelines, k8s manifests, docker-compose) are merged constantly
// and line merges garble them. This provider merges by STRUCTURE: every top-level
// `key:` block is a unit keyed by its key name, and splitUnit descends into nested
// mapping levels — so two people editing DIFFERENT jobs/services/sections merge
// cleanly, and the SAME key edited two ways is a named conflict.
//
// Honest heuristic (no parser dependency): tracks #-comments, quoted strings, and
// flow brackets; parses() checks bracket balance + indentation coherence (a dedent
// must land on an indent level that exists — the failure mode of a bad splice).
// Block scalars (|, >) are tolerated: their content is deeper-indented free text.

function scannerAt(src) {
  const n = src.length
  return function at(i) {
    if (src[i] === '#') { let j = i + 1; while (j < n && src[j] !== '\n') j++; return j }
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i]; let j = i + 1
      while (j < n) { if (q === '"' && src[j] === '\\') { j += 2; continue } if (src[j] === q) { j++; break } if (src[j] === '\n') break; j++ }
      return j
    }
    return -1
  }
}

// Line records with indent; comment-only and blank lines are marked.
function lines(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    let e = src.indexOf('\n', i); e = e < 0 ? src.length : e + 1
    const raw = src.slice(i, e)
    const body = raw.replace(/\r?\n$/, '')
    let indent = 0; while (indent < body.length && body[indent] === ' ') indent++
    const trimmed = body.trim()
    out.push({ start: i, end: e, indent, blank: trimmed === '' || trimmed.startsWith('#'), text: body })
    i = e
  }
  return out
}

// KEY SHAPES. A YAML key may be QUOTED, and a quoted key legally contains ':' and '#';
// a plain key may contain '#' too ('#' only opens a comment at line start or after a
// space). The original class excluded both characters from the key body, so any such key
// failed KEY and fell through to `'stmt:' + <whole head line>` — a unit key that contains
// the VALUE. Two sides editing that ONE key then produced two DIFFERENT unit keys, so the
// engine saw unrelated add/deletes, unioned them, and emitted the key TWICE while
// reporting the merge 'auto' and clean. Duplicate mapping keys are invalid YAML and every
// loader keeps the last, so one side's edit was silently discarded — no-silent-loss
// failing exactly as it did for type-first method signatures in lang-brace.js.
// Measured before the fix (both top level and nested): "a:b", 'a:b', foo#bar, "a#b" all
// auto-merged into a duplicated key; plain keys conflicted correctly.
const QKEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(\s|$)/  // "quoted key": / 'quoted key':
const KEY = /^([^:#\s][^:]*?):(\s|$)/     // `key:` or `key: value` (body may contain '#')
const DASH = /^-(\s|$)/                    // list item

// Cut a trailing ` #comment` that is not inside quotes, so it never lands in a key.
function stripComment(line) {
  const at = scannerAt(line)
  let i = 0
  while (i < line.length) {
    if (line[i] === '#' && i > 0 && /\s/.test(line[i - 1])) return line.slice(0, i)
    const j = at(i)
    if (j > i && line[i] !== '#') { i = j; continue }
    i++
  }
  return line
}

// `"a"` and `a` name the SAME key in YAML, so they must key the same — otherwise the
// pair is the very ambiguity this function exists to remove.
const unquote = (k) => (/^"(?:[^"\\]|\\.)*"$/.test(k) || /^'(?:[^']|'')*'$/.test(k)) ? k.slice(1, -1) : k

function keyOf(text) {
  const t = stripComment(text.trim()).trim()
  let m = t.match(QKEY)
  if (m) return 'key:' + unquote(m[1])
  m = t.match(KEY)
  if (m) return 'key:' + unquote(m[1].trim())
  if (t === '---' || t === '...') return 'doc:' + t
  return 'stmt:' + t.replace(/\s+/g, ' ')
}

// Units whose heads sit at exactly `baseIndent`: a `key:`/`- ` head owns all
// following blank or deeper-indented lines (its block).
function blocks(src, baseIndent = 0) {
  const L = lines(src)
  const units = []
  let i = 0
  while (i < L.length) {
    while (i < L.length && L[i].text.trim() === '') i++ // pure blanks are gap text
    if (i >= L.length) break
    const start = L[i].start
    // leading comment lines attach to the unit that follows
    while (i < L.length && L[i].blank && L[i].text.trim().startsWith('#')) i++
    if (i >= L.length) { units.push({ start, end: L[L.length - 1].end }); break }
    if (L[i].indent !== baseIndent) { units.push({ start, end: L[i].end }); i++; continue }
    i++ // the head line
    while (i < L.length && (L[i].blank || L[i].indent > baseIndent)) i++
    let last = i - 1
    while (last >= 0 && L[last].text.trim() === '') last-- // trailing blanks are gap text
    units.push({ start, end: L[last].end })
  }
  return units
}

function keyed(raw, src) {
  const seen = new Map(), out = []
  for (const u of raw) {
    const text = src.slice(u.start, u.end)
    // key by the HEAD line (skipping attached leading comments)
    const head = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) || text
    const baseKey = keyOf(head)
    let k = baseKey
    const c = (seen.get(k) || 0) + 1; seen.set(k, c)
    if (c > 1) k += '#' + c
    out.push({ key: k, baseKey, text, start: u.start, end: u.end })
  }
  return out
}

// Bracket balance (flow style) + unterminated-string detection.
function balanced(src) {
  const at = scannerAt(src)
  const stack = []
  const pair = { ')': '(', ']': '[', '}': '{' }
  let i = 0
  while (i < src.length) {
    const j = at(i); if (j > i) { if (j > src.length) return false; i = j; continue }
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') stack.push(c)
    else if (pair[c]) { if (stack.pop() !== pair[c]) return false }
    i++
  }
  return stack.length === 0
}

// Indentation coherence: an indent INCREASE opens a new level (always legal in YAML —
// nested mapping, list, or block-scalar content); a DECREASE must land on a level
// that is already on the stack. This is exactly what a bad merge splice violates.
function indentsOk(src) {
  const L = lines(src)
  let stack = null
  for (const l of L) {
    if (l.blank) continue
    if (stack == null) { stack = [l.indent]; continue }
    const top = stack[stack.length - 1]
    if (l.indent > top) { stack.push(l.indent); continue }
    if (l.indent < top) {
      while (stack.length > 1 && stack[stack.length - 1] > l.indent) stack.pop()
      if (stack[stack.length - 1] !== l.indent) return false
    }
  }
  return true
}

const yaml = {
  id: 'yaml',
  exts: ['.yml', '.yaml'],
  parses: (src) => { const s = String(src == null ? '' : src); return balanced(s) && indentsOk(s) },
  parsesUnit: (src) => { const s = String(src); return balanced(s) && indentsOk(s) },
  units: (src) => keyed(blocks(String(src), 0), String(src)),
  declaredNames: () => new Set(), // keys are structure, not code declarations
  // Descend one mapping level: `jobs:` -> each job merges independently.
  splitUnit: (text) => {
    const src = String(text)
    const L = lines(src)
    let h = 0; while (h < L.length && L[h].blank) h++
    if (h >= L.length) return null
    const head = L[h]
    if (!KEY.test(head.text.trim())) return null
    if (head.text.trim().match(/:\s*[|>][+-]?\s*(#.*)?$/)) return null // block scalar: free text, do not descend
    if (!/:\s*(#.*)?$/.test(head.text)) return null                    // inline value (`key: v`): nothing beneath
    let b = h + 1; while (b < L.length && L[b].blank) b++
    if (b >= L.length || L[b].indent <= head.indent) return null       // empty block
    const bodyIndent = L[b].indent
    const sig = src.slice(0, L[h].end)
    const body = src.slice(L[h].end)
    const inner = keyed(blocks(body, bodyIndent), body)
    if (inner.some((u) => u.key.startsWith('stmt:-') || DASH.test(u.text.trim()))) return null // list items: order matters, stay whole
    return { sig, open: '', close: '', body, units: inner, join: '', spliceable: true }
  },
}

  return { yaml }
})()

const { toml } = (function () {
// TOML language provider for ICR — section/key structural splitter.
// Cargo.toml / pyproject.toml are constantly edited concurrently (two people add
// dependencies). This provider merges by STRUCTURE: every `[section]` (and
// `[[array-of-tables]]`) is a unit keyed by its name; keys in the top-level
// preamble are units of their own; splitUnit descends into a section so two
// edits to DIFFERENT keys of the same table merge cleanly.
//
// Honest heuristic: tracks #-comments and single/double/triple-quoted strings;
// parses() = balanced delimiters + well-formed section headers.

function scannerAt(src) {
  const n = src.length
  return function at(i) {
    if (src[i] === '#') { let j = i + 1; while (j < n && src[j] !== '\n') j++; return j }
    for (const q of ['"""', "'''"]) if (src.startsWith(q, i)) { let j = i + 3; while (j < n && !src.startsWith(q, j)) { if (src[j] === '\\') j++; j++ } return Math.min(n, j + 3) }
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i]; let j = i + 1
      while (j < n) { if (q === '"' && src[j] === '\\') { j += 2; continue } if (src[j] === q) { j++; break } if (src[j] === '\n') break; j++ }
      return j
    }
    return -1
  }
}

function lines(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    let e = src.indexOf('\n', i); e = e < 0 ? src.length : e + 1
    const body = src.slice(i, e).replace(/\r?\n$/, '')
    const trimmed = body.trim()
    out.push({ start: i, end: e, blank: trimmed === '' || trimmed.startsWith('#'), text: body })
    i = e
  }
  return out
}

const SECTION = /^\s*(\[\[?)([^\]]+)\]\]?\s*(#.*)?$/
const KEYLINE = /^\s*([A-Za-z0-9_."'-]+)\s*=/

// Bracket delta for one line, string/comment aware (multi-line arrays continue a key).
function bracketDelta(src, at, s, e) {
  let d = 0, k = s
  while (k < e) {
    const j = at(k); if (j > k) { k = Math.min(e, j); continue }
    const c = src[k]
    if (c === '[' || c === '{') d++
    else if (c === ']' || c === '}') d--
    k++
  }
  return d
}

// Top-level units: a [section] header owns everything until the next header;
// preamble `key = value` lines are individual units (multi-line values included).
function blocks(src) {
  const at = scannerAt(src)
  const L = lines(src)
  const units = []
  let i = 0
  while (i < L.length) {
    while (i < L.length && L[i].text.trim() === '') i++
    if (i >= L.length) break
    const start = L[i].start
    while (i < L.length && L[i].blank && L[i].text.trim().startsWith('#')) i++ // leading comments attach
    if (i >= L.length) { units.push({ start, end: L[L.length - 1].end }); break }
    if (SECTION.test(L[i].text)) {
      i++ // header
      while (i < L.length && !SECTION.test(L[i].text)) i++
      let last = i - 1
      while (last >= 0 && L[last].text.trim() === '') last--
      units.push({ start, end: L[last].end })
    } else {
      // one key (or stray statement); consume continuation lines while brackets open
      let depth = bracketDelta(src, at, L[i].start, L[i].end)
      let e = L[i].end; i++
      while (i < L.length && depth > 0) { depth += bracketDelta(src, at, L[i].start, L[i].end); e = L[i].end; i++ }
      units.push({ start, end: e })
    }
  }
  return units
}

function keyOf(text) {
  const head = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) || text
  let m = head.match(SECTION); if (m) return (m[1] === '[[' ? 'tables:' : 'table:') + m[2].trim()
  m = head.match(KEYLINE); if (m) return 'key:' + m[1].replace(/["']/g, '')
  return 'stmt:' + head.trim().replace(/\s+/g, ' ')
}

function keyed(raw, src) {
  const seen = new Map(), out = []
  for (const u of raw) {
    const text = src.slice(u.start, u.end)
    let k = keyOf(text)
    const c = (seen.get(k) || 0) + 1; seen.set(k, c)
    if (c > 1) k += '#' + c
    out.push({ key: k, text, start: u.start, end: u.end })
  }
  return out
}

function balanced(src) {
  const at = scannerAt(src)
  const stack = []
  const pair = { ']': '[', '}': '{' }
  let i = 0
  while (i < src.length) {
    const j = at(i); if (j > i) { if (j > src.length) return false; i = j; continue }
    const c = src[i]
    if (c === '[' || c === '{') stack.push(c)
    else if (pair[c]) { if (stack.pop() !== pair[c]) return false }
    i++
  }
  return stack.length === 0
}

const toml = {
  id: 'toml',
  exts: ['.toml'],
  parses: (src) => balanced(String(src == null ? '' : src)),
  parsesUnit: (src) => balanced(String(src)),
  units: (src) => keyed(blocks(String(src)), String(src)),
  declaredNames: () => new Set(),
  // Descend into a section: each `key = value` inside merges independently.
  splitUnit: (text) => {
    const src = String(text)
    const L = lines(src)
    let h = 0; while (h < L.length && L[h].blank) h++
    if (h >= L.length || !SECTION.test(L[h].text)) return null
    const sig = src.slice(0, L[h].end)
    const body = src.slice(L[h].end)
    const inner = keyed(blocks(body), body)
    return { sig, open: '', close: '', body, units: inner, join: '', spliceable: true }
  },
}

  return { toml }
})()

const ICR = (function (javascript, braceLanguages, python, ruby, json, yaml, toml) {
// ICR — Intent-aware Code Replication (v1 proof-of-concept).
//
// The first real step from Hivecode-the-tool toward a FOUNDATIONAL primitive:
// merge code by STRUCTURE and INTENT, not characters, with a hard guarantee — never
// emit code more broken than its inputs.
//
// Why this matters: CRDTs (Yjs) merge characters. They will happily fuse two edits
// into syntactically-valid garbage, because they have no idea what code MEANS. ICR
// parses the code, merges at the level of declarations (functions / classes / vars),
// descends INTO a declaration both sides touched (so disjoint edits inside one function
// still merge), detects when two authors changed the SAME thing (a real conflict), and
// validates that the merged result still parses — falling back safely if it wouldn't.
//
// On top of structure it adds an INTENT layer:
//   • RENAME DETECTION — a declaration gone from base whose identical-bodied twin appears
//     under a new name is recognized as a rename; stale call sites are rewritten so the
//     other agent's fresh calls keep working. Nothing else does this.
//   • DANGLING REFERENCE — a declaration removed/renamed but still referenced is flagged
//     as a semantic conflict even though the code parses. CRDTs/git/plain merge miss it.
//
// LANGUAGE-AGNOSTIC BY DESIGN: this file is the engine. Everything that knows about a
// specific language (how to parse, what a declaration is, how to find references) lives
// behind a provider (see lang-js.js). Adding Python/Go/Rust = writing another provider
// and registerLanguage()-ing it; the merge logic below never changes. JavaScript via
// `acorn` is simply the first provider. The production path swaps in tree-sitter
// providers for every language behind this same interface.


// --- language registry ----------------------------------------------------------
// JavaScript (acorn, full intent layer) first; then structural providers for the
// C-family (TypeScript, Go, Rust, Java, C/C++, C#, Swift, Kotlin, …), Python, and
// Ruby; data languages: JSON merges as parsed DATA (real parser, value-wise 3-way,
// perfect guarantee), YAML/TOML merge by keyed structure (sections/keys).
// These cover disjoint extensions, so order only matters on clashes (none today).
const LANGUAGES = [javascript, ...braceLanguages, python, ruby, json, yaml, toml]

// Register an additional language provider. Must expose the provider contract:
// { id, exts:[...], parses, units, declaredNames, usedIdentifiers, declBody,
//   renameRefs, fnParts }. Newest wins on extension clashes.
function registerLanguage(provider) { LANGUAGES.unshift(provider) }

// The live provider list (the actual registered objects, not copies) — used by the
// optional tree-sitter oracle to upgrade providers' parse checks in place.
function registeredLanguages() { return LANGUAGES }

function extname(p) { const m = /\.[^.\/\\]+$/.exec(p || ''); return m ? m[0].toLowerCase() : '' }

// The provider for a filename, or null if no registered language claims its extension.
function languageFor(filename) {
  const e = extname(filename)
  return LANGUAGES.find((l) => l.exts.includes(e)) || null
}

// Can ICR merge this file structurally? (Callers gate on this before trying.)
function supports(filename) { return languageFor(filename) != null }

// --- generic merge primitives (language-independent: operate on {key,text}) -----
const mapOf = (us) => new Map(us.map((u) => [u.key, u.text]))
function dedupeOrder(keys) { const seen = new Set(), out = []; for (const k of keys) if (!seen.has(k)) { seen.add(k); out.push(k) } return out }

// For a given unit, choose which version survives: whoever CHANGED it wins; if neither
// changed it, keep the base.
function pick(k, B, A, Bb) {
  const base = B.has(k) ? B.get(k) : null
  const a = A.has(k) ? A.get(k) : null
  const b = Bb.has(k) ? Bb.get(k) : null
  if (a != null && a !== base) return a
  if (b != null && b !== base) return b
  return base != null ? base : (a != null ? a : b)
}

// SIMILARITY RE-PAIRING (the matcher): a unit that "disappeared" on one side while a
// near-identical unit "appeared" on the SAME side is the same unit rewritten — e.g.
// `app.use(...)` becoming `app1.use(...)` when a variable is renamed changes the unit's
// content-derived key, and key matching alone would call that a delete + an add. Ground-
// truth replay of real repos showed this is the #1 source of false delete-vs-edit
// conflicts. Pair them back so the engine sees ONE unit changed on that side and the
// normal same-key tiers (inner merge → token splice) get their shot.
// Safety: same key KIND only (call: with call:, fn: with fn:), a high similarity bar,
// and the best match must be UNIQUE (with margin) and MUTUAL — any ambiguity means no
// pairing. Side-local and deterministic, so merge(a,b) === merge(b,a) is preserved.
const keyKind = (k) => k.slice(0, k.indexOf(':') + 1)
function shingleSet(t) {
  const s = t.replace(/\s+/g, ' ').trim()
  const out = new Set()
  for (let i = 0; i + 4 <= s.length; i++) out.add(s.slice(i, i + 4))
  return out
}
function shingleSim(sa, sb) {
  if (!sa.size || !sb.size) return 0
  let inter = 0
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa]
  for (const g of small) if (big.has(g)) inter++
  return (2 * inter) / (sa.size + sb.size)
}
const SIM_FLOOR = 0.75, SIM_MARGIN = 0.04
function repairSide(baseU, sideU, otherKeys) {
  const baseKeys = new Set(baseU.map((u) => u.key))
  const sideKeys = new Set(sideU.map((u) => u.key))
  const deleted = baseU.filter((u) => !sideKeys.has(u.key))
  // An added key that ALSO appears on the other side is a genuine concurrent addition
  // (both sides wrote it) — pairing it away would fabricate a duplicate and silently
  // absorb a same-key add/add clash the engine must surface. Never pair those.
  const added = sideU.filter((u) => !baseKeys.has(u.key) && !otherKeys.has(u.key))
  if (!deleted.length || !added.length || deleted.length * added.length > 900) return sideU
  const shD = deleted.map((u) => shingleSet(u.text)), shA = added.map((u) => shingleSet(u.text))
  const bestFor = (sh, kind, pool, shPool) => {
    let best = -1, bestS = 0, second = 0
    for (let j = 0; j < pool.length; j++) {
      if (keyKind(pool[j].key) !== kind) continue
      const s = shingleSim(sh, shPool[j])
      if (s > bestS) { second = bestS; bestS = s; best = j } else if (s > second) second = s
    }
    return { best, bestS, second }
  }
  const rekey = new Map(), claimed = new Set()
  for (let i = 0; i < deleted.length; i++) {
    const kind = keyKind(deleted[i].key)
    const f = bestFor(shD[i], kind, added, shA)
    // Short units are mostly boilerplate (`def f(): return N`), so shingle similarity
    // runs hot on them — demand near-identity before calling two short units "the same".
    const floor = Math.min(shD[i].size, f.best >= 0 ? shA[f.best].size : Infinity) < 24 ? 0.9 : SIM_FLOOR
    if (f.best < 0 || f.bestS < floor || f.bestS - f.second < SIM_MARGIN) continue
    const back = bestFor(shA[f.best], keyKind(added[f.best].key), deleted, shD)
    if (back.best !== i || back.bestS - back.second < SIM_MARGIN) continue
    if (claimed.has(added[f.best].key)) continue
    claimed.add(added[f.best].key)
    rekey.set(added[f.best].key, deleted[i].key)
  }
  if (!rekey.size) return sideU
  return sideU.map((u) => (rekey.has(u.key) ? { ...u, key: rekey.get(u.key) } : u))
}

// Core 3-way merge over a KEYED list of units (works at file level AND, recursively,
// inside a single declaration). Returns { conflicts:[...], parts:[...text] }.
// When both sides change the SAME key into different things, it first tries to descend
// INTO that unit (finer granularity) — only a clash it can't resolve becomes a conflict.
function mergeKeyed(lang, baseU, aU, bU, mopts = {}) {
  const aKeys = new Set(aU.map((u) => u.key)), bKeys = new Set(bU.map((u) => u.key))
  aU = repairSide(baseU, aU, bKeys)
  bU = repairSide(baseU, bU, aKeys)
  const B = mapOf(baseU), A = mapOf(aU), Bb = mapOf(bU)
  const keys = dedupeOrder([...baseU.map((u) => u.key), ...aU.map((u) => u.key), ...bU.map((u) => u.key)])

  const conflicts = [], conflictUnits = [], resolved = new Map()
  for (const k of keys) {
    const bs = B.has(k) ? B.get(k) : null
    const as_ = A.has(k) ? A.get(k) : null
    const bbs = Bb.has(k) ? Bb.get(k) : null
    const changedA = as_ !== bs, changedB = bbs !== bs
    if (changedA && changedB && as_ !== bbs) {
      // Both touched the same unit, differently. Try finer-grained inner merge first.
      if (bs != null && as_ != null && bbs != null) {
        const inner = tryInnerMerge(lang, bs, as_, bbs, mopts)
        if (inner != null) { resolved.set(k, inner); continue }
      }
      conflicts.push(k)
      // Carry the three exact versions of the conflicting unit, so a conflict is a
      // MACHINE-RESOLVABLE object (base/ours/theirs of just this declaration) — not a wall
      // of text markers. This is what an intent-aware resolver (a judge agent) reconciles.
      conflictUnits.push({ key: k, base: bs, ours: as_, theirs: bbs })
    }
  }
  if (conflicts.length) return { conflicts, conflictUnits, parts: [] }

  // No unresolved clashes → decide which keys survive, honoring one-sided deletions.
  const survives = new Set()
  for (const k of keys) {
    const inBase = B.has(k), inA = A.has(k), inB2 = Bb.has(k)
    if (inBase && (!inA || !inB2)) {
      const deletedByA = !inA, deletedByB = !inB2
      const otherUnchangedFromBase =
        (deletedByA && (!inB2 || Bb.get(k) === B.get(k))) ||
        (deletedByB && (!inA || A.get(k) === B.get(k)))
      if (otherUnchangedFromBase) continue // accept the deletion
    }
    survives.add(k)
  }

  // CONVERGENCE + TOPOLOGY: new units are inserted where their author put them — anchored
  // to the base unit that immediately preceded them on the side that added them — while
  // staying SYMMETRIC: merge(a,b) must equal merge(b,a) byte-for-byte or two live peers
  // never settle. Symmetry rules: (1) a unit added by BOTH sides at different anchors gets
  // the anchor earlier in base order (side-independent); (2) when both sides insert runs at
  // the SAME anchor, each side's run keeps its own internal order, and the two runs are
  // ordered by comparing their joined keys (content, not side).
  const baseOrder = dedupeOrder(baseU.map((u) => u.key))
  const baseSet = new Set(baseOrder)
  const basePos = new Map(baseOrder.map((k, i) => [k, i]))

  const anchorsFor = (units) => { // newKey -> base key it followed (null = top of file)
    const m = new Map()
    let lastBase = null
    for (const u of units) {
      if (baseSet.has(u.key)) lastBase = u.key
      else if (survives.has(u.key) && !m.has(u.key)) m.set(u.key, lastBase)
    }
    return m
  }
  const aAnch = anchorsFor(aU), bAnch = anchorsFor(bU)
  const anchorOf = (k) => {
    const inA2 = aAnch.has(k), inB3 = bAnch.has(k)
    if (inA2 && inB3) {
      const x = aAnch.get(k), y = bAnch.get(k)
      if (x === y) return x
      const px = x == null ? -1 : basePos.get(x), py = y == null ? -1 : basePos.get(y)
      return px <= py ? x : y
    }
    return inA2 ? aAnch.get(k) : bAnch.get(k)
  }
  const runsA = new Map(), runsB = new Map() // anchor -> that side's new keys, in its order
  for (const k of aAnch.keys()) { const an = anchorOf(k); if (!runsA.has(an)) runsA.set(an, []); runsA.get(an).push(k) }
  for (const k of bAnch.keys()) { const an = anchorOf(k); if (!runsB.has(an)) runsB.set(an, []); runsB.get(an).push(k) }
  const newAt = (anchor) => {
    const ra = runsA.get(anchor) || [], rb = runsB.get(anchor) || []
    const [first, second] = ra.join('') <= rb.join('') ? [ra, rb] : [rb, ra]
    const firstSet = new Set(first)
    return [...first, ...second.filter((k) => !firstSet.has(k))]
  }

  const final = []
  final.push(...newAt(null))
  for (const k of baseOrder) {
    if (survives.has(k)) final.push(k)
    final.push(...newAt(k))
  }

  // Assemble, recording PROVENANCE per surviving unit: who authored the version we kept
  // ('a' / 'b' changed it, 'both' if we merged inside it, 'base' if unchanged).
  const parts = [], provenance = [], order = [], textByKey = new Map()
  for (const k of final) {
    let text, from
    if (resolved.has(k)) { text = resolved.get(k); from = 'both' }
    else {
      text = pick(k, B, A, Bb)
      const bs = B.has(k) ? B.get(k) : null, as_ = A.has(k) ? A.get(k) : null, bbs = Bb.has(k) ? Bb.get(k) : null
      from = (as_ != null && as_ !== bs) ? 'a' : (bbs != null && bbs !== bs) ? 'b' : 'base'
    }
    if (text != null) { parts.push(text); provenance.push({ key: k, from }); order.push(k); textByKey.set(k, text) }
  }
  return { conflicts: [], parts, provenance, order, textByKey }
}

// FINER GRANULARITY: both sides edited the same function OR class. If the signature
// matches and they edited DIFFERENT inner units (statements / class members), merge those
// recursively rather than declaring the whole declaration a conflict. Returns merged
// text, or null meaning "couldn't safely merge inside — treat as a real conflict."
function tryInnerMerge(lang, baseText, aText, bText, mopts = {}) {
  // Language-specific same-key merges first (e.g. unioning import specifiers).
  if (lang.mergeUnit) {
    const t = lang.mergeUnit(baseText, aText, bText)
    if (t != null && lang.parses(t)) return t
  }
  // Structural inner merge (declaration → statements, class → members): format-preserving
  // and well-tested, so it goes first. Returns null when it can't safely resolve.
  const structural = tryStructuralInner(lang, baseText, aText, bText, mopts)
  if (structural != null) return structural
  // Unit-level oracle: providers with a fragment validator (parsesUnit) get every finer-
  // grained result checked HERE, so an invalid inner merge becomes an honest per-unit
  // conflict (judge-resolvable) instead of poisoning the whole file into fallback.
  // Providers without one (JS: a bare `return …` fragment is valid only in context) keep
  // deferring to the whole-file gate, as before.
  const unitOk = lang.parsesUnit ? (t) => t != null && lang.parsesUnit(t) : (t) => t != null
  // LINE-LEVEL diff3: whole lines as atoms, so indentation travels with its line — the
  // safe multi-hunk tier, and the workhorse for "both sides edited different lines of the
  // same declaration" (the most common same-unit case in real repos).
  const lm = lineMerge3(baseText, aText, bText, mopts)
  if (unitOk(lm)) return lm
  // FINEST GRANULARITY: a single line/statement both sides edited — token-level 3-way, so
  // two edits INSIDE one line (`foo(1, 2)` → one side edits each argument) merge the way a
  // tree-sitter merge does, instead of conflicting on the whole statement. For providers
  // without parsesUnit, validity is enforced where the result lands (whole-file re-parse).
  const tm = tokenMerge(lang, baseText, aText, bText, mopts)
  if (tm != null && lang.parsesUnit && !lang.parsesUnit(tm)) return null
  return tm
}

function tryStructuralInner(lang, baseText, aText, bText, mopts = {}) {
  if (!lang.splitUnit) return null
  const pb = lang.splitUnit(baseText), pa = lang.splitUnit(aText), pbb = lang.splitUnit(bText)
  if (!pb || !pa || !pbb) return null
  if (pa.sig.trim() !== pbb.sig.trim()) return null
  const m = mergeKeyed(lang, pb.units, pa.units, pbb.units, mopts)
  if (m.conflicts.length) return null
  // FORMAT-PRESERVING inner assembly: when the provider exposes the body text + byte-ranged
  // units (spliceable), rebuild the body by splicing merged units back into the BASE body,
  // so everything BETWEEN statements — comments, blank lines, indentation — survives verbatim.
  // (Join-based reassembly with a fixed separator silently drops inner comments and reflows
  // whitespace; found in the wild merging ICR's own source, and the C-family class-brace glue.)
  // Objects and any non-spliceable provider fall back to the separator join.
  let text
  const spliceable = pb.spliceable && typeof pb.body === 'string' && pb.units.every((u) => typeof u.start === 'number' && typeof u.end === 'number')
  if (spliceable) {
    // COMMENT-EDIT PRESERVATION: gaps (comments/blank lines between statements) come from
    // the splice BASIS. Splicing from base loses a side's comment-only edit. So: if exactly
    // ONE side changed only gaps (its units are byte-identical to base's), splice into THAT
    // side's body — its comment edit survives and the other side's code edits land on top.
    // If BOTH sides changed only gaps, refuse (null) so the unit surfaces as a conflict
    // instead of silently dropping either side's comment.
    const sameUnits = (u1, u2) => u1.length === u2.length && u1.every((u, i) => u.key === u2[i].key && u.text === u2[i].text)
    const aGapOnly = pa.body !== pb.body && sameUnits(pa.units, pb.units)
    const bGapOnly = pbb.body !== pb.body && sameUnits(pbb.units, pb.units)
    if (aGapOnly && bGapOnly) return null
    const [basisBody, basisUnits] = aGapOnly ? [pa.body, pa.units] : bGapOnly ? [pbb.body, pbb.units] : [pb.body, pb.units]
    const body = spliceUnits(basisBody, basisUnits, m.order, m.textByKey, { trimLeadingBlank: false })
    text = pa.sig + pa.open + body + pa.close
  } else {
    text = pa.sig + pa.open + m.parts.join(pa.join) + pa.close
  }
  const valid = lang.parsesUnit || lang.parses // accept class-member fragments when supported
  return valid(text) ? text : null
}

// TOKEN-LEVEL 3-way merge of one unit. base/a/b are the unit texts, both differing from base
// (the caller only asks when both sides changed the same unit). Diff each side against base at
// TOKEN granularity — one changed span via common prefix + common suffix — map each span to a
// base CHARACTER range, and, if the two base spans are DISJOINT, splice both sides' replacement
// text into base. Everything OUTSIDE the two edits comes from base verbatim (whitespace,
// comments); inside, each side's exact bytes. Overlapping or ambiguously-adjacent edits → null
// (a real conflict). Symmetric by construction: the result is base with two position-disjoint
// substring replacements, independent of which side is a or b — so live peers converge.
function tokenDiffRange(base, other) {
  const n = base.length, m = other.length
  let eq = n === m
  if (eq) { for (let i = 0; i < n; i++) if (base[i] !== other[i]) { eq = false; break } }
  if (eq) return null
  let p = 0
  const maxp = Math.min(n, m)
  while (p < maxp && base[p] === other[p]) p++
  let s = 0
  while (s < n - p && s < m - p && base[n - 1 - s] === other[m - 1 - s]) s++
  return { bStart: p, bEnd: n - s, oStart: p, oEnd: m - s }
}

function tokenMerge(lang, baseText, aText, bText, mopts = {}) {
  if (!lang.tokenize) return null
  const B = lang.tokenize(baseText), A = lang.tokenize(aText), Bb = lang.tokenize(bText)
  if (!B || !A || !Bb) return null
  const ra = tokenDiffRange(B.map((t) => t.k), A.map((t) => t.k))
  const rb = tokenDiffRange(B.map((t) => t.k), Bb.map((t) => t.k))
  if (!ra && !rb) return null // both sides changed only whitespace/comments → can't rank them
  // REFORMAT vs CONTENT: one side changed only whitespace/comments (token stream identical
  // to base), the other changed tokens. Apply the content side's token edit ONTO the
  // reformatting side's text — its token stream matches base's, so token indices map its
  // own byte ranges exactly. Both intents survive: the reformat/comment edit AND the code
  // change. (Ground-truth replay: this was a top false-conflict source on real repos.)
  // Symmetric because the roles are decided by CONTENT (which side has the token diff).
  if (!ra || !rb) {
    const [wsToks, wsText, r, toks, text] = !ra ? [A, aText, rb, Bb, bText] : [Bb, bText, ra, A, aText]
    const cStart = r.bStart < wsToks.length ? wsToks[r.bStart].start : wsText.length
    const cEnd = r.bEnd > r.bStart ? wsToks[r.bEnd - 1].end : cStart
    const ins = r.oEnd > r.oStart ? text.slice(toks[r.oStart].start, toks[r.oEnd - 1].end) : ''
    return wsText.slice(0, cStart) + ins + wsText.slice(cEnd)
  }
  const charRange = (r) => {
    const cStart = r.bStart < B.length ? B[r.bStart].start : baseText.length
    const cEnd = r.bEnd > r.bStart ? B[r.bEnd - 1].end : cStart
    return [cStart, cEnd]
  }
  const repl = (toks, text, r) => (r.oEnd > r.oStart ? text.slice(toks[r.oStart].start, toks[r.oEnd - 1].end) : '')
  const [aS, aE] = charRange(ra), [bS, bE] = charRange(rb)
  // Single contiguous spans that don't collide: splice both (the cheap common case).
  if (!(aS < bE && bS < aE) && aS !== bS) {
    const edits = [{ s: aS, e: aE, t: repl(A, aText, ra) }, { s: bS, e: bE, t: repl(Bb, bText, rb) }].sort((x, y) => y.s - x.s)
    let out = baseText
    for (const ed of edits) out = out.slice(0, ed.s) + ed.t + out.slice(ed.e)
    return out
  }
  // The prefix/suffix spans collide — but each is the BOUNDING BOX of that side's edits,
  // and boxes overlap whenever a side edited in two places (a wrapper rewrite touches both
  // ends, so its box swallows the whole unit). Re-diff each side at REAL multi-hunk
  // granularity (Myers) and do token-level diff3: disjoint hunks interleave, identical
  // hunks dedupe, truly overlapping hunks are the only conflict. Ground-truth replay:
  // "one side rewrote the wrapper, the other edited inside" is a real-repo staple.
  return tokenMerge3(baseText, aText, bText, B, A, Bb, mopts)
}

// Myers O(ND) diff on token-key arrays → edit hunks {bs,be,os,oe} (base/other token ranges).
function tokenHunks(bk, ok, maxD) {
  const N = bk.length, M = ok.length
  const MAX = Math.min(N + M, maxD)
  const V = new Map([[1, 0]])
  const trace = []
  let D = -1
  outer: for (let d = 0; d <= MAX; d++) {
    trace.push(new Map(V))
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (V.get(k - 1) ?? 0) < (V.get(k + 1) ?? 0))) ? (V.get(k + 1) ?? 0) : (V.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < N && y < M && bk[x] === ok[y]) { x++; y++ }
      V.set(k, x)
      if (x >= N && y >= M) { D = d; break outer }
    }
  }
  if (D < 0) return null // too different for the budget → caller falls back
  // backtrack into hunks
  const ops = [] // 1 = del base token, 2 = ins other token, stored back-to-front
  let x = N, y = M
  for (let d = D; d > 0; d--) {
    const Vp = trace[d]
    const k = x - y
    const down = k === -d || (k !== d && (Vp.get(k - 1) ?? 0) < (Vp.get(k + 1) ?? 0))
    const pk = down ? k + 1 : k - 1
    const px = Vp.get(pk) ?? 0
    const py = px - pk
    while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) { x--; y-- } // snake
    if (down) { y--; ops.push([2, x, y]) } else { x--; ops.push([1, x, y]) }
  }
  ops.reverse()
  const hunks = []
  for (const [op, bx, oy] of ops) {
    const last = hunks[hunks.length - 1]
    if (op === 1) {
      if (last && last.be === bx && last.oe === oy) last.be = bx + 1
      else hunks.push({ bs: bx, be: bx + 1, os: oy, oe: oy })
    } else {
      if (last && last.be === bx && last.oe === oy) last.oe = oy + 1
      else hunks.push({ bs: bx, be: bx, os: oy, oe: oy + 1 })
    }
  }
  return hunks
}

// diff3 over two hunk lists: identical hunks dedupe; disjoint hunks both apply; overlap
// → conflict (null). Two INSERTIONS at the same base point are ambiguous (order
// unknowable) → conflict. `ak`/`bbk` are each side's atom arrays (token keys or lines),
// used to compare replacement content for the dedupe check. Returns [{h, side}] in base
// order, or null. Symmetric: ordering decisions are content/position-based, never
// side-identity-based, so merge(a,b) === merge(b,a) is preserved by construction.
function diff3Interleave(ha, hb, ak, bbk, opts = {}) {
  const sameHunk = (x, y) => x.bs === y.bs && x.be === y.be && (x.oe - x.os) === (y.oe - y.os) &&
    ak.slice(x.os, x.oe).every((k, i) => k === bbk[y.os + i])
  const edits = []
  let i = 0, j = 0
  while (i < ha.length || j < hb.length) {
    const x = ha[i], y = hb[j]
    if (x && y) {
      const overlap = x.bs < y.be && y.bs < x.be
      const samePointInsert = x.bs === y.bs && x.be === x.bs && y.be === y.bs
      if (overlap || samePointInsert) {
        if (sameHunk(x, y)) { edits.push({ h: x, side: 'a' }); i++; j++; continue }
        // UNION MODE (opt-in, for independent-intent merges — the multi-agent case where
        // the medium KNOWS the two edits serve different tasks): two pure INSERTIONS at
        // the same base point both survive, in content order (side-independent, so peers
        // converge). Everything else (true overlaps, edit-vs-edit) still conflicts, and
        // the parse gates downstream still refuse any union that breaks the code.
        if (samePointInsert && opts.unionInserts) {
          const ka = ak.slice(x.os, x.oe).join('\n'), kb = bbk.slice(y.os, y.oe).join('\n')
          const [first, second] = ka <= kb ? [{ h: x, side: 'a' }, { h: y, side: 'b' }] : [{ h: y, side: 'b' }, { h: x, side: 'a' }]
          edits.push(first, second); i++; j++; continue
        }
        return null
      }
      if (x.bs < y.bs || (x.bs === y.bs && x.be <= y.bs && x.be < y.be)) { edits.push({ h: x, side: 'a' }); i++ }
      else { edits.push({ h: y, side: 'b' }); j++ }
    } else if (x) { edits.push({ h: x, side: 'a' }); i++ }
    else { edits.push({ h: y, side: 'b' }); j++ }
  }
  return edits
}

const TOKEN3_MAX_TOKENS = 20000, TOKEN3_MAX_D = 4000
function tokenMerge3(baseText, aText, bText, B, A, Bb, mopts = {}) {
  if (B.length > TOKEN3_MAX_TOKENS || A.length > TOKEN3_MAX_TOKENS || Bb.length > TOKEN3_MAX_TOKENS) return null
  const bk = B.map((t) => t.k)
  const ha = tokenHunks(bk, A.map((t) => t.k), TOKEN3_MAX_D)
  const hb = tokenHunks(bk, Bb.map((t) => t.k), TOKEN3_MAX_D)
  if (!ha || !hb) return null
  const edits = diff3Interleave(ha, hb, A.map((t) => t.k), Bb.map((t) => t.k), mopts)
  if (!edits) return null
  // splice back-to-front, mapping token hunks to base char ranges; replacement bytes come
  // from the editing side's exact text between its tokens. A guard space prevents two word
  // tokens fusing at a splice boundary (parse validation downstream still has final say).
  const wordish = (c) => c && /[A-Za-z0-9_$]/.test(c)
  let out = baseText
  for (let e = edits.length - 1; e >= 0; e--) {
    const { h, side } = edits[e]
    const [toks, text] = side === 'a' ? [A, aText] : [Bb, bText]
    const cS = h.bs < B.length ? B[h.bs].start : baseText.length
    const cE = h.be > h.bs ? B[h.be - 1].end : cS
    let ins = h.oe > h.os ? text.slice(toks[h.os].start, toks[h.oe - 1].end) : ''
    if (ins && wordish(out[cS - 1]) && wordish(ins[0])) ins = ' ' + ins
    if (ins && wordish(out[cE]) && wordish(ins[ins.length - 1])) ins = ins + ' '
    out = out.slice(0, cS) + ins + out.slice(cE)
  }
  return out
}

// LINE-LEVEL 3-way merge of one unit: the same Myers + diff3 interleave with WHOLE LINES
// as atoms. Every replacement carries complete lines verbatim — indentation can never be
// stranded or doubled, which is what makes it the safe multi-hunk tier for indentation
// languages (the ConGra corpus showed token-splice arithmetic mangling Python indent when
// hunks straddle newline tokens: `conn = None` landing at column 0, a doubled 16-space
// indent). Token-level still runs after this for same-line micro-edits; this tier catches
// the far more common "both sides edited different LINES of the same unit" cleanly.
function splitLinesKeepEnds(text) {
  const out = []
  let i = 0
  while (i < text.length) { let e = text.indexOf('\n', i); e = e < 0 ? text.length : e + 1; out.push(text.slice(i, e)); i = e }
  return out
}
function lineMerge3(baseText, aText, bText, mopts = {}) {
  const L = splitLinesKeepEnds(baseText), La = splitLinesKeepEnds(aText), Lb = splitLinesKeepEnds(bText)
  if (L.length > TOKEN3_MAX_TOKENS) return null
  const ha = tokenHunks(L, La, TOKEN3_MAX_D)
  const hb = tokenHunks(L, Lb, TOKEN3_MAX_D)
  if (!ha || !hb) return null
  const edits = diff3Interleave(ha, hb, La, Lb, mopts)
  if (!edits) return null
  const out = L.slice()
  for (let e = edits.length - 1; e >= 0; e--) {
    const { h, side } = edits[e]
    const src = side === 'a' ? La : Lb
    out.splice(h.bs, h.be - h.bs, ...src.slice(h.os, h.oe))
  }
  return out.join('')
}

// FORMAT-PRESERVING assembly: rebuild the merged file by splicing the merged units back
// into the BASE text at their original byte ranges. Unchanged units — and all the
// whitespace/comments BETWEEN units — survive verbatim; only changed units carry the
// editing side's bytes, and genuinely new units are appended. This is what stops ICR from
// reformatting code it merges. Deterministic and symmetric, so peers converge.
function spliceUnits(baseText, baseUnits, order, textByKey, opts = {}) {
  const baseKeySet = new Set(baseUnits.map((u) => u.key))
  const baseByKey = new Map(baseUnits.map((u) => [u.key, u]))
  const orderSet = new Set(order)
  const deleted = baseUnits.filter((u) => !orderSet.has(u.key))
  let out = '', pos = 0

  function emitGap(from, to) {
    let cursor = from
    for (const d of deleted) {
      if (d.start >= cursor && d.end <= to) {
        out += baseText.slice(cursor, d.start)
        cursor = d.end
      }
    }
    out += baseText.slice(cursor, to)
  }

  // A KEY REPEATED IN `order` USED TO EMIT ITS UNIT AGAIN. `order` is assembled from both
  // sides' unit lists, so any key present in both can appear twice, and each appearance
  // wrote the declaration out. On a whole-file rewrite that is every declaration in the
  // file, which is how a merge silently doubled a source file instead of merging it.
  // Emit each unit exactly once, at its first ordered position.
  const seenKeys = new Set()
  for (const k of order) {
    if (seenKeys.has(k)) continue
    seenKeys.add(k)
    if (baseKeySet.has(k)) {
      const u = baseByKey.get(k)
      if (u.start >= pos) {
        emitGap(pos, u.start)
        pos = u.end
      }
      // A missing key used to concatenate the string "undefined" into the source.
      const val = textByKey.get(k)
      if (val != null) out += val
    } else {
      // New unit: insert it exactly where the merge order dictated
      const val = textByKey.get(k)
      if (val != null) {
        out += (out.endsWith('\n') ? '' : '\n') + val + '\n'
      }
    }
  }
  if (pos < baseText.length) {
    emitGap(pos, baseText.length)
  }
  // Top-level: drop orphan leading blank lines a deleted first decl leaves behind. Inner
  // splice (trimLeadingBlank:false): keep the body's own leading `\n  ` so indentation holds.
  return opts.trimLeadingBlank === false ? out : out.replace(/^\n+/, '')
}

// --- HyperAST Caching -----------------------------------------------------------
// A memory cache to bypass redundant AST parsing. This gives O(1) lookups for
// unchanged structures during interleaved diff3 merges, dropping engine execution
// time drastically on large files.
const providerCache = new WeakMap();

function withHyperAST(lang) {
  if (providerCache.has(lang)) return providerCache.get(lang);

  const cache = new Map();
  const get = (op, text, fn) => {
    if (typeof text !== 'string' || text.length > 500000) return fn(); // Bypass for massive strings
    const key = op + ':' + text;
    let res = cache.get(key);
    if (res !== undefined) return res;
    res = fn();
    if (cache.size > 10000) cache.clear();
    cache.set(key, res);
    return res;
  };

  const wrapped = Object.create(lang);
  if (lang.parses) wrapped.parses = (src) => get('parses', src, () => lang.parses(src));
  if (lang.units) wrapped.units = (src) => get('units', src, () => lang.units(src));
  if (lang.tokenize) wrapped.tokenize = (src) => get('tokenize', src, () => lang.tokenize(src));
  if (lang.splitUnit) wrapped.splitUnit = (src) => get('splitUnit', src, () => lang.splitUnit(src));
  if (lang.declaredNames) wrapped.declaredNames = (src) => get('declaredNames', src, () => lang.declaredNames(src));
  
  providerCache.set(lang, wrapped);
  return wrapped;
}

// --- public API -----------------------------------------------------------------

// Does this source parse under the given (or default JS) language?
function parses(src, lang = javascript) { return withHyperAST(lang).parses(src) }

// 3-way STRUCTURAL + INTENT merge of `a` and `b` against common ancestor `base`.
// opts: { lang } a provider, or { filename } to pick one by extension (defaults to JS).
// Returns { status, text, conflicts, renames? }:
//   'auto'              — clean merge; `text` is valid, parseable code.
//   'semantic-conflict' — same declaration changed both sides, or a dangling reference;
//                         `conflicts` names them (e.g. ['fn:login'] or ['ref:helper']).
//   'fallback'          — couldn't merge safely (unparseable input, or the merge wouldn't
//                         parse, or unsupported language); caller keeps both. Never broken.
function structuralMerge(base, a, b, opts = {}) {
  let lang = opts.lang || (opts.filename ? languageFor(opts.filename) : javascript) || javascript
  lang = withHyperAST(lang)

  if (!lang.parses(base) || !lang.parses(a) || !lang.parses(b))
    return { status: 'fallback', text: null, conflicts: [], reason: 'unparseable input' }

  // FIXED-POINT fast path: once two peers agree on a text T, re-merging must return T
  // unchanged. This is what makes the live sync settle. Both agree ⇒ nothing to check.
  if (a === b) return { status: 'auto', text: a, conflicts: [], renames: [], provenance: [] }

  const authors = opts.authors || {}
  const attribute = (prov) => (prov || []).map((p) => ({ unit: p.key, author: authors[p.from] || p.from }))

  // Determine the structurally-merged text + provenance. A one-sided change takes that
  // side verbatim (format perfectly preserved); otherwise do the keyed 3-way merge and
  // splice it back into base. Either way the INTENT layer below still runs, so a deletion
  // that leaves a dangling reference is caught even when only one side changed.
  let text, provenance
  if (a === base) { text = b; provenance = [] }
  else if (b === base) { text = a; provenance = [] }
  else if (lang.mergeWhole) {
    // WHOLE-DOCUMENT MERGE: a provider that understands the entire document as DATA
    // (e.g. JSON) merges it directly — real-parser accuracy, value-wise 3-way semantics,
    // conflicts named by path. Returns { text } on success, { conflicts, resolvable? } on
    // a same-value clash, or null when it can't (engine falls back safely).
    const w = lang.mergeWhole(base, a, b)
    if (!w) return { status: 'fallback', text: null, conflicts: [], reason: 'whole-document merge failed' }
    if (w.conflicts && w.conflicts.length) return { status: 'semantic-conflict', text: null, conflicts: w.conflicts, resolvable: w.resolvable || [] }
    text = w.text; provenance = w.provenance || []
  }
  else {
    const baseUnits = lang.units(base)
    const merge = mergeKeyed(lang, baseUnits, lang.units(a), lang.units(b), { unionInserts: !!opts.unionInserts })
    if (merge.conflicts.length) return { status: 'semantic-conflict', text: null, conflicts: merge.conflicts, resolvable: merge.conflictUnits }
    // Prefer the format-preserving splice (units carry byte ranges); fall back to a plain
    // join for languages whose units don't expose ranges.
    const canSplice = baseUnits.every((u) => typeof u.start === 'number')
    text = canSplice ? spliceUnits(base, baseUnits, merge.order, merge.textByKey) : merge.parts.join('\n\n') + '\n'
    provenance = merge.provenance
  }

  // THE GUARANTEE: the merged result must parse, or we refuse it.
  // THE GUARANTEE stands: a merge that would not parse is REFUSED — text stays null so no
  // caller can ever mistake broken output for a merge. (Debugging wants the bytes? That is
  // what `debugText` is for; it is deliberately not `text`.)
  if (!lang.parses(text)) return { status: 'fallback', text: null, debugText: text, conflicts: [], reason: 'merge would not parse' }

  // RENAME DETECTION (intent): a declaration gone from base whose identical-bodied twin
  // appears under a new name is a rename — rewrite stale call sites to the new name.
  let merged = text
  const baseNames = lang.declaredNames(base)
  let mergedNames = lang.declaredNames(merged)
  let removed = [...baseNames].filter((n) => !mergedNames.has(n))
  const renames = []
  const rename = lang.renameFreeRefs || lang.renameRefs // prefer scope-aware rewriting
  
  if (removed.length && lang.declBody && rename) {
    const added = [...mergedNames].filter((n) => !baseNames.has(n))
    const claimed = new Set()
    for (const oldName of removed) {
      const oldBody = lang.declBody(base, oldName)
      if (oldBody == null) continue
      const match = added.find((n) => !claimed.has(n) && lang.declBody(merged, n) === oldBody)
      if (match) { renames.push([oldName, match]); claimed.add(match) }
    }
    let rewritten = merged
    // Rewrite only references that resolve to the renamed binding (scope-aware) — a local
    // variable that merely shares the old name is left untouched.
    for (const [oldName, newName] of renames) rewritten = rename(rewritten, oldName, newName)
    // only accept the rewrite if it still parses — never trade a parse error for intent.
    if (renames.length && lang.parses(rewritten)) { merged = rewritten; mergedNames = lang.declaredNames(merged) }
  }

  // ASYNC/AWAIT SYNCHRONIZATION (intent):
  // When a declaration was synchronous in base and became ASYNC in the merged result,
  // upgrade call sites inside async callers with `await` so the contract holds.
  const asyncUpgrades = []
  if (lang.isAsyncDecl && lang.upgradeCallSitesToAwait) {
    for (const name of mergedNames) {
      const wasAsyncInBase = baseNames.has(name) ? lang.isAsyncDecl(base, name) : false
      const isAsyncInMerged = lang.isAsyncDecl(merged, name)
      if (!wasAsyncInBase && isAsyncInMerged) {
        const upgraded = lang.upgradeCallSitesToAwait(merged, name)
        if (upgraded !== merged && lang.parses(upgraded)) {
          merged = upgraded
          asyncUpgrades.push(name)
        }
      }
    }
  }

  // DANGLING REFERENCE (intent): a declaration removed (and NOT explained by a rename)
  // but still referenced is a semantic conflict even though the code parses cleanly.
  // Uses the SCOPE-AWARE reference set when the language provides one (so a local binding
  // that merely shares the deleted name is correctly NOT treated as a reference to it),
  // falling back to the approximate identifier set otherwise.
  removed = [...baseNames].filter((n) => !mergedNames.has(n))
  const refs = lang.referencedFreeNames ? lang.referencedFreeNames(merged)
    : lang.usedIdentifiers ? lang.usedIdentifiers(merged) : null
  if (process.env.ICR_DEBUG_MERGED) console.error('--- ICR merged intermediate ---\n' + merged + '\n--- refs: ' + [...(refs || [])].join(',') + ' ---')
  if (removed.length && refs) {
    const dangling = removed.filter((n) => refs.has(n))
    if (dangling.length)
      return { status: 'semantic-conflict', text: null, conflicts: dangling.map((n) => 'ref:' + n), reason: 'dangling reference: a declaration was removed/renamed but is still used' }
  }
  // PROVENANCE: attribute each surviving unit to the author whose version we kept. With
  // opts.authors = { a, b, base } the labels are real names; otherwise they're 'a'/'b'/etc.
  return {
    status: 'auto', text: merged, conflicts: [],
    renames: renames.map(([o, n]) => o + '->' + n),
    asyncUpgrades,
    provenance: attribute(provenance),
  }
}

// Internal handles for diagnostic harnesses (not part of the public API).
const _internals = { tokenMerge, tokenMerge3, tokenHunks, tryInnerMerge, lineMerge3 }

  return { structuralMerge, supports, parses, registerLanguage, languageFor }
})(javascript, braceLanguages, python, ruby, json, yaml, toml)

module.exports = ICR
