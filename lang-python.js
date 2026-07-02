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
    while (i < L.length && L[i].blank) i++            // skip blank/comment gap lines
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

export const python = {
  id: 'python',
  exts: ['.py', '.pyi'],
  parses: (src) => balanced(String(src == null ? '' : src)),
  parsesUnit: (src) => balanced(String(src)),
  units: (src) => keyed(blocks(String(src), 0), String(src)),
  declaredNames: (src) => {
    const names = new Set()
    for (const u of keyed(blocks(String(src), 0), String(src))) {
      const m = u.key.match(/^(?:def|class):([A-Za-z_]\w*)/)
      if (m) names.add(m[1])
    }
    return names
  },
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
