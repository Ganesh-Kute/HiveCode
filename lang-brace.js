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
