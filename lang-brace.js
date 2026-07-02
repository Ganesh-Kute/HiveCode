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
    // A standalone comment before a declaration belongs to the GAP (kept verbatim by
    // the engine's splice), so skip it without starting a unit.
    if ((src[i] === '/' && (src[i + 1] === '/' || src[i + 1] === '*'))) { const s = at(i); if (s > i) { i = s; continue } }
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
        if (c === '\n' && !sawBrace) break
      }
      i++
    }
    units.push({ start, end: i })
  }
  return units
}

const DECL = /\b(function|func|fn|def|fun|class|interface|struct|enum|trait|impl|type|namespace|module|package|object|record|protocol|actor|extension)\s+([A-Za-z_$][\w$]*)/
const VARD = /\b(const|let|var|val|static|final)\s+([A-Za-z_$][\w$]*)/
const METH = /^(?:@[\w.]+\s+)*(?:public|private|protected|internal|static|async|final|override|open|pub|suspend|inline|virtual|export|default)?\s*(?:function\s+|fn\s+|func\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;{]*\)\s*(?:->[^{]+|:[^={]+)?\{/

function keyOf(text) {
  const head = text.replace(/^\s+/, '')
  let m = head.match(DECL); if (m) return m[1] + ':' + m[2]
  m = head.match(METH); if (m) return 'method:' + m[1]
  m = head.match(VARD); if (m) return 'var:' + m[2]
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

// Approximate parse check: delimiters balanced and no unterminated string/comment,
// ignoring the contents of strings and comments.
function balanced(src, strings) {
  const at = scannerAt(src, strings)
  const stack = []
  let i = 0
  while (i < src.length) {
    const s = at(i)
    if (s > i) { if (s > src.length) return false; i = s; continue }
    const c = src[i]
    if (OPEN[c]) stack.push(c)
    else if (CLOSE[c]) { if (stack.pop() !== CLOSE[c]) return false }
    i++
  }
  return stack.length === 0
}

export function makeBraceLanguage({ id, exts, strings = ['"', "'", '`'] }) {
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
      // re-base inner ranges into `body` coordinates are already correct (topUnits used body)
      return { sig, open: '{', close: src.slice(close), body, units: inner, join: '' }
    },
  }
  return provider
}

// Ready-made providers covering the common C-family languages. One provider can claim
// many extensions; comment/string syntax defaults fit the whole family (edge cases like
// Rust raw strings / lifetimes are tolerated — worst case a unit is merged coarsely).
export const braceLanguages = [
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
