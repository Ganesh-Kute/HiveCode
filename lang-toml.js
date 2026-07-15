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

export const toml = {
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
