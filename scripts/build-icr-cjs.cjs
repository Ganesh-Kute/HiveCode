// Generates extension/icr.cjs — a CommonJS bundle of the ICR engine (every lang-*.js
// provider + icr.js) for the VS Code extension, which is CommonJS and packaged on its own.
// Each source file is wrapped in its own scope (so internal names like `parses` don't
// collide), ESM import/export is stripped, and acorn is required once at the top.
//
//   node scripts/build-icr-cjs.cjs
//
// Re-run this whenever a lang-*.js or icr.js changes, so the extension stays in sync.

const fs = require('fs')
const path = require('path')
// ROOT is the REPO root, not this script's directory. This file was written when it sat at
// the repo root and used a bare `__dirname`; once it moved into scripts/ that silently
// pointed at scripts/lang-js.js and the build died with ENOENT — which meant the bundle
// simply never got regenerated, and the extension kept shipping a months-old ICR.
const ROOT = path.join(__dirname, '..')

const strip = (src) => src.split('\n')
  .filter((l) => !/^\s*import\s/.test(l))          // drop ESM imports (acorn supplied by wrapper)
  .map((l) => l.replace(/^(\s*)export\s+/, '$1'))  // `export function/const` -> plain declaration
  .join('\n')

// THE PROVIDER LIST IS DERIVED, NOT HAND-WRITTEN. The previous bundler hard-coded
// lang-js.js alone. When icr.js grew `import { braceLanguages } from './lang-brace.js'`
// (and python/ruby/json/yaml/toml after it), the strip step deleted those imports and
// nothing supplied the bindings, so the generated bundle threw
// `ReferenceError: braceLanguages is not defined` the moment the extension required it.
// The extension swallows that in its `try { require('./icr.cjs') } catch {}`, so the only
// symptom is ICR silently never engaging. Reading the imports out of icr.js means adding a
// language can never again produce a bundle that loads but does nothing.
const icrSrc = fs.readFileSync(path.join(ROOT, 'icr.js'), 'utf8')
const providers = []
for (const m of icrSrc.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'\.\/(lang-[\w-]+)\.js'/gm)) {
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean)
  providers.push({ file: m[2] + '.js', names })
}
if (!providers.length) throw new Error('no lang-*.js imports found in icr.js — bundler would emit a broken file')

const scopes = providers.map(({ file, names }) => {
  const src = strip(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  return `const { ${names.join(', ')} } = (function () {
${src}
  return { ${names.join(', ')} }
})()
`
}).join('\n')

const allNames = providers.flatMap((p) => p.names)
const eng = strip(icrSrc)

const out = `// AUTO-GENERATED from ${providers.map((p) => p.file).join(' + ')} + icr.js
// by scripts/build-icr-cjs.cjs — do not edit by hand.
// CommonJS bundle of the ICR merge engine for the (CommonJS, separately-packaged) extension.
const acorn = require('acorn')

${scopes}
const ICR = (function (${allNames.join(', ')}) {
${eng}
  return { structuralMerge, supports, parses, registerLanguage, languageFor }
})(${allNames.join(', ')})

module.exports = ICR
`

// An optional output path, so a TEST can generate into a temp file and compare without mutating
// the repo. The header of this file says "Re-run this whenever a source changes", and that
// sentence is a human instruction, not a mechanism -- it was followed for the last time before
// 28 Aug 2026, and by 19 Sep the shipped bundle was 373 lines behind its own sources, inside a
// published extension. tests/extension-parity-test.mjs now checks it on every run.
const dest = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'extension', 'icr.cjs')
fs.writeFileSync(dest, out)

// FAIL THE BUILD IF THE BUNDLE DOES NOT LOAD. Writing a syntactically broken bundle used to
// be a silent success: the file appeared, `vsce package` shipped it, and the extension's
// optional-require hid the error from every user. Requiring it here is the whole guarantee.
delete require.cache[require.resolve(dest)]
const ICR = require(dest)
for (const fn of ['structuralMerge', 'supports', 'parses', 'languageFor']) {
  if (typeof ICR[fn] !== 'function') throw new Error(`bundle loaded but ${fn} is missing`)
}
if (!ICR.supports('x.js') || !ICR.supports('x.py')) throw new Error('bundle loaded but language registry is empty')

console.log(`wrote extension/icr.cjs (${out.length} bytes, ${providers.length} language providers) — loads OK`)
