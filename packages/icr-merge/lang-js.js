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

import * as acorn from 'acorn'

// Parse permissively: try module syntax, fall back to script (so plain snippets and
// ESM both work). Throws only when the code genuinely won't parse either way.
function parse(src) {
  try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }) }
  catch { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' }) }
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
    const nm = bareName(node); if (nm) s.add(nm)
    // Import locals count as declared names too â€” so if an import is ever dropped and its
    // binding is still used, the dangling-reference check catches it (safety net for the
    // import merge). Keeps the never-emit-broken-code guarantee honest for imports.
    if (node.type === 'ImportDeclaration') for (const sp of node.specifiers) s.add(sp.local.name)
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
  const sig = src.slice(0, body.start - off)
  const ks = keyStatements(body.body)
  const units = body.body.map((s, i) => ({ key: ks[i], text: src.slice(s.start - off, s.end - off) }))
  return { sig, units, open: '{\n  ', join: '\n  ', close: '\n}' }
}

function splitUnit(src) {
  let ast
  try { ast = parse(src) } catch { return splitMember(src) } // maybe a class-member fragment
  if (!ast || !ast.body) return splitMember(src) // defensive: a null AST must never reach .body
  let n = ast.body[0]
  if (!n) return null
  if (n.type === 'ExportNamedDeclaration' && n.declaration) n = n.declaration
  if (n.type === 'FunctionDeclaration' && n.body) {
    const sig = src.slice(n.start, n.body.start)
    const ks = keyStatements(n.body.body)
    const units = n.body.body.map((s, i) => ({ key: ks[i], text: src.slice(s.start, s.end) }))
    return { sig, units, open: '{\n  ', join: '\n  ', close: '\n}' }
  }
  if (n.type === 'ClassDeclaration' && n.body) {
    const sig = src.slice(n.start, n.body.start)
    const units = n.body.body.map((m, i) => ({ key: memberKey(m, i), text: src.slice(m.start, m.end) }))
    return { sig, units, open: '{\n  ', join: '\n\n  ', close: '\n}' }
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
      const sig = src.slice(n.start, init.start)
      const units = init.properties.map((p, i) => ({ key: propKey(p, i), text: src.slice(p.start, p.end) }))
      return { sig, units, open: '{\n  ', join: ',\n  ', close: '\n}' }
    }
    if ((init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') && init.body && init.body.type === 'BlockStatement') {
      const sig = src.slice(n.start, init.body.start)
      const ks = keyStatements(init.body.body)
      const units = init.body.body.map((s, i) => ({ key: ks[i], text: src.slice(s.start, s.end) }))
      return { sig, units, open: '{\n  ', join: '\n  ', close: '\n}' }
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

// The provider contract every ICR language module implements.
export const javascript = {
  id: 'javascript',
  exts: ['.js', '.mjs', '.cjs'],
  parses,
  units,
  declaredNames,
  usedIdentifiers,      // approximate (kept for reference)
  referencedFreeNames,  // scope-aware â€” what the engine prefers for the dangling check
  declBody,
  renameRefs,           // rewrites every matching identifier (kept for reference)
  renameFreeRefs,       // scope-aware â€” only rewrites references that resolve to the binding
  splitUnit,            // finer granularity: split a function/class/method into keyed inner units
  parsesUnit,           // validity oracle that also accepts a class-member fragment
  mergeUnit,            // language-specific same-key merge (import specifier union)
}
