// icr-merge/treesitter — OPTIONAL real-parser validation oracle.
//
// The heuristic providers (brace family, Python, Ruby, YAML, TOML) validate merges
// with balance/indent checks — honest, but weaker than a real parse. This module
// upgrades every heuristic provider's `parses()` to ALSO require a real tree-sitter
// parse with no ERROR nodes, so THE GUARANTEE ("a merge that would not parse is
// refused") is enforced by an actual grammar for ~16 languages.
//
// Design decisions:
//   • OPT-IN and dependency-free by default: web-tree-sitter + tree-sitter-wasms are
//     optional peers (~50MB of grammars) loaded only inside initTreeSitter(). The
//     core package stays acorn-only.
//   • COMPOSED, not replaced: upgraded parses = heuristic && tree-sitter. The
//     heuristics stay because they are sometimes STRICTER than the error-tolerant
//     grammars (e.g. tree-sitter-python accepts dedents real Python rejects).
//   • Whole-file only: `parsesUnit` (fragment oracle for class members) stays
//     heuristic — a valid fragment can be an ERROR out of context, and a false
//     reject there would needlessly degrade clean merges. The whole-file gate is
//     where broken output is stopped, and that is what gets the real parser.
//   • Fail-safe: any tree-sitter failure (missing grammar, parse crash) counts as
//     "cannot validate" for that call → the heuristic verdict stands. A missing
//     optional dependency throws ONLY from initTreeSitter itself, with a clear message.
//
//   import { initTreeSitter } from 'icr-merge/treesitter.js'
//   await initTreeSitter()          // upgrades the registered providers in place
//   // ...then use merge()/resolveMerge() exactly as before (still synchronous).
import path from 'path'
import { createRequire } from 'module'
import { registeredLanguages } from './icr.js'

// provider id -> grammar file stem in tree-sitter-wasms/out/. The C provider covers
// .c/.h/.cpp together, so it validates against the C++ grammar (a superset for the
// overwhelming majority of merge fodder; a false reject only downgrades to the safe
// line tier, never ships broken output). JS/JSON are excluded: they already have
// real parsers (acorn / JSON.parse).
// A value may be a LIST of grammars, in which case the source is accepted if ANY of them
// parses it. The `c` provider claims .c/.h AND .cpp/.hpp/.cc, and those are different
// languages: validating everything against the C++ grammar alone rejected 89% of real,
// shipped C (measured on git/git, redis and Linux — only 44 of 393 maintainer-committed C
// files passed). Trying C and then C++ removes that false-reject cliff while still catching
// genuinely broken output, which fails BOTH grammars.
const GRAMMAR = {
  ts: 'typescript', jsx: 'javascript', go: 'go', rust: 'rust', java: 'java',
  c: ['c', 'cpp'], csharp: 'c_sharp', swift: 'swift', kotlin: 'kotlin', scala: 'scala',
  php: 'php', dart: 'dart', python: 'python', ruby: 'ruby', yaml: 'yaml', toml: 'toml',
}

let initialized = null

export async function initTreeSitter(opts = {}) {
  if (initialized) return initialized
  let TS
  try { TS = await import('web-tree-sitter') }
  catch { throw new Error('icr-merge/treesitter needs its optional peers: npm i web-tree-sitter tree-sitter-wasms') }
  const Parser = TS.default || TS.Parser
  await Parser.init()
  const Language = Parser.Language || TS.Language

  let dir = opts.wasmDir
  if (!dir) {
    const req = createRequire(import.meta.url)
    try { dir = path.join(path.dirname(req.resolve('tree-sitter-wasms/package.json')), 'out') }
    catch { throw new Error('icr-merge/treesitter needs its optional peers: npm i web-tree-sitter tree-sitter-wasms') }
  }

  const upgraded = []
  for (const prov of registeredLanguages()) {
    const stems = GRAMMAR[prov.id]
    if (!stems || prov._treesitter) continue
    const parsers = []
    for (const stem of [].concat(stems)) {
      try {
        const lang = await Language.load(path.join(dir, `tree-sitter-${stem}.wasm`))
        const p = new Parser()
        p.setLanguage(lang)
        parsers.push(p)
      } catch { /* this grammar unavailable — try the next */ }
    }
    if (!parsers.length) continue // no grammar at all -> provider keeps its heuristic oracle
    const heuristic = prov.parses.bind(prov)
    // ANY listed grammar accepting is enough. For a provider spanning dialects (C and C++
    // share one provider) this is the difference between a usable gate and one that rejects
    // most legitimate source; broken output still fails every grammar.
    const realParse = (src) => {
      const s = String(src)
      for (const parser of parsers) {
        try {
          const tree = parser.parse(s)
          const err = typeof tree.rootNode.hasError === 'function' ? tree.rootNode.hasError() : tree.rootNode.hasError
          if (tree.delete) tree.delete()
          if (!err) return true
        } catch { return true } // cannot validate -> defer to the heuristic verdict
      }
      return false
    }
    prov.parses = (src) => heuristic(src) && realParse(src)
    prov._treesitter = true
    upgraded.push(prov.id)
  }
  initialized = { upgraded }
  return initialized
}
