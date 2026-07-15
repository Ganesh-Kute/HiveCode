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

const KEY = /^([^:#\s][^:#]*?):(\s|$)/     // `key:` or `key: value`
const DASH = /^-(\s|$)/                    // list item

function keyOf(text) {
  const t = text.trim()
  const m = t.match(KEY)
  if (m) return 'key:' + m[1].trim()
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
    let k = keyOf(head)
    const c = (seen.get(k) || 0) + 1; seen.set(k, c)
    if (c > 1) k += '#' + c
    out.push({ key: k, text, start: u.start, end: u.end })
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

export const yaml = {
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
