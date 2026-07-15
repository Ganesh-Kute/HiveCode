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
      units.push({ start, end: L[i - 1].end })
    } else if (head) {
      // simple statement: consume continued lines while bracket depth remains open
      let e = head.end, depth = bracketDelta(head.start, head.end); i++
      while (i < L.length && (depth > 0 || /\\\s*$/.test(L[i - 1].text.replace(/\r?\n$/, '')))) { depth += bracketDelta(L[i].start, L[i].end); e = L[i].end; i++ }
      units.push({ start, end: e })
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

// Reference-position identifier (not attribute access `.name`)?
function isRefToken(src, t) {
  if (!/^[A-Za-z_]\w*$/.test(t.k)) return false
  let p = t.start - 1
  while (p >= 0 && (src[p] === ' ' || src[p] === '\t')) p--
  return !(p >= 0 && src[p] === '.')
}

export const python = {
  id: 'python',
  exts: ['.py', '.pyi'],
  parses: (src) => { const s = String(src == null ? '' : src); return balanced(s) && indentsOk(s) },
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
  // Finest granularity: token stream for the token-level inner merge. SAFE for Python
  // only because parses() now checks indentation — a splice that lands a statement in
  // the wrong block is refused at the whole-file gate, not shipped.
  tokenize: (src) => lexTokens(String(src)),
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
    return { sig, open: '', close: '', body, units: inner, join: '' }
  },
}
