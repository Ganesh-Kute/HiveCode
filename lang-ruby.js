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

export const ruby = {
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
